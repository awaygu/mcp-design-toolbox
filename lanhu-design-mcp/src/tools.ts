// tools.ts — 注册所有 MCP 工具（用官方 SDK + zod）
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fetchDesignViaApi, fetchDesignByIds, readSector, listDirectory, listUserTeams, downloadSlices, checkAuth } from './lanhu-client.js';
import { verifyDesignSpec } from './verify-spec.js';
import { callVision, designAnalyzePrompt, isAutoAnalyzeEnabled, isVisionConfigured } from './vision.js';
import { shrinkForVision } from './image.js';
import type { Credentials, DesignResult } from './types.js';

const MOCK_DESIGN: DesignResult = {
  source: 'mock',
  viewport: { width: 390, height: 844 },
  layers: [
    { id: 'bg', type: 'rect', x: 0, y: 0, w: 390, h: 844, fill: '#0E0B1A' },
    { id: 'title', type: 'text', x: 24, y: 64, w: 342, h: 32, text: 'Masked Ball', fontSize: 24, fontWeight: 700, color: '#F5F1FF', fontFamily: 'Inter' },
    { id: 'cta', type: 'rect', x: 24, y: 720, w: 342, h: 48, fill: '#7C5CFF', radius: 12 },
    { id: 'card', type: 'rect', x: 24, y: 120, w: 342, h: 200, fill: '#1A1530', radius: 16 },
    { id: 'badge', type: 'rect', x: 24, y: 340, w: 61, h: 16, fill: '#771E00', borderRadius: { topLeft: 8, topRight: 12, bottomLeft: 0, bottomRight: 12 }, border: { color: 'rgba(239,216,185,1)', width: 1, alignment: 'inside' } },
  ],
  meta: { rawLayerCount: 4, totalLayerCount: 4 },
};

function jsonContent(obj: unknown) {
  // 紧凑输出：pretty-print 缩进白费约 1/3 token，Agent 不需要可读排版
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

// LANHU_COOKIE_FILE 文件内容即完整 cookie 串；读不到返回 undefined，由 resolveCookie 报错
function readCookieFile(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const cookie = raw.trim();
    return cookie || undefined;
  } catch {
    return undefined;
  }
}

function credentials(args: { cookie?: string }): Credentials {
  return {
    // cookie 优先级：入参 > LANHU_COOKIE > LANHU_COOKIE_FILE 文件
    cookie: args.cookie || process.env.LANHU_COOKIE || readCookieFile(process.env.LANHU_COOKIE_FILE),
  };
}

// 入参图先压小再发模型省体积；压不动就原样透传，让模型自己报错
async function shrinkB64(b64: string): Promise<string> {
  try {
    const small = await shrinkForVision(Buffer.from(b64, 'base64'));
    return `data:image/jpeg;base64,${small.toString('base64')}`;
  } catch {
    return b64;
  }
}

// 视觉入参统一入口：文件路径优先（Agent 不用把截图转成 base64 扛进上下文），base64 兜底。
// 两种方式都在内存压缩，server 不落任何盘
async function loadImageInput(opts: { b64?: string; path?: string; what: string }): Promise<string> {
  if (opts.path) {
    try {
      const small = await shrinkForVision(await readFile(opts.path));
      return `data:image/jpeg;base64,${small.toString('base64')}`;
    } catch (e) {
      throw new Error(`读取图片失败（${opts.path}）：${(e as Error).message}`);
    }
  }
  if (opts.b64) return shrinkB64(opts.b64);
  throw new Error(`${opts.what}：请传 imagePath（本地截图文件路径，推荐）或 imageBase64 之一`);
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    'lanhu_fetch_design',
    {
      description:
        '读取蓝湖设计稿的结构化图层树（精确 x/y/宽高/色值/字号/圆角/描边/文本）。mode：api=官方Cookie接口(默认,无需浏览器) / mock=内置示例。analyze=true 时用配置的视觉模型理解设计稿封面图。' +
        'analyze 默认值：已配置视觉模型（VLM_MODEL + VLM_API_KEY）时默认 true，未配置则默认 false；显式传 true/false 始终优先。' +
        '使用纪律：一次只读当前要实现的那 1 张稿；不要为「了解全貌」批量读稿——分组稿目录用 lanhu_read_sector，它足够定位；返回的 layers 含精确数值，色值/字号从数据取，禁止靠视觉模型 OCR 小字。',
      inputSchema: {
        mode: z.enum(['api', 'mock']).default('api').describe('抽取后端'),
        url: z.string().optional().describe('蓝湖设计稿链接，如 https://lanhuapp.com/web/#/item/project/detailDetach?pid=xxx&image_id=yyy'),
        imageId: z.string().optional().describe('设计稿 id（来自 lanhu_read_sector），与 projectId 搭配；url 与 imageId 二选一，免拼 URL'),
        projectId: z.string().optional().describe('项目 UUID（imageId 模式必填；url 模式不需要）'),
        cookie: z.string().optional().describe('登录 cookie 串（也可用 LANHU_COOKIE / LANHU_COOKIE_FILE）'),
        analyze: z.boolean().optional().describe('用视觉模型理解封面图，返回 visionAnalysis；不传时按是否配置了视觉模型自动决定（配了就 true）'),
        analyzeFocus: z.string().optional().describe('注入视觉模型的额外关注点/业务背景（如「重点分析签到奖励领取规则」「关注按钮的禁用态」），让分析更贴合当前任务；不影响返回 JSON 结构，仅 analyze 执行时生效'),
      },
    },
    async (args) => {
      if (process.env.LANHU_MOCK === '1' || args.mode === 'mock') {
        return jsonContent(MOCK_DESIGN);
      }

      // mode === 'api'（默认）：url 与 imageId+projectId 二选一
      if (!args.url && !args.imageId) throw new Error('api 模式需要 url 或 imageId+projectId');
      if (args.imageId && !args.projectId && !args.url) throw new Error('imageId 模式需要同时传 projectId');
      // 未传 analyze 时，配了视觉模型就默认开
      const analyze = args.analyze ?? isAutoAnalyzeEnabled();
      if (args.analyze === undefined && analyze) {
        console.error(`[fetch_design] analyze 未指定且视觉模型已配置 → 自动开启（${process.env.VLM_MODEL || '默认模型'}）`);
      }

      const fetchOpts = { ...credentials(args), needCover: analyze };
      const r = args.url
        ? await fetchDesignViaApi(args.url, fetchOpts)
        : await fetchDesignByIds(args.imageId!, args.projectId!, fetchOpts);
      // 切图 CDN URL 对 Agent 是死重：下载走 lanhu_download_slices（支持 sliceNames 按名过滤），按需重取
      if (r.slices) r.slices = r.slices.map(({ imageUrl: _url, ...s }) => s);
      if (!analyze) return jsonContent(r);

      const { coverImageBase64, ...rest } = r;
      // 视觉分析失败降级为 visionError，不该带走图层树
      if (!coverImageBase64) {
        return jsonContent({ ...rest, visionError: '设计稿无封面图（coverImageBase64 为空），已跳过视觉分析' });
      }
      try {
        // 封面已在 client 压成 1x JPEG，补 mime 前缀喂模型
        // 设计稿名 + 调用方关注点注入 prompt 作背景上下文（见 designAnalyzePrompt 内的防锚定声明）
        const analysis = await callVision({ images: [`data:image/jpeg;base64,${coverImageBase64}`], text: designAnalyzePrompt(rest.meta?.docName ?? rest.name, args.analyzeFocus), detail: 'high' });
        return jsonContent({ ...rest, visionAnalysis: analysis });
      } catch (e) {
        console.error(`[fetch_design] 视觉分析失败，降级返回图层树：${(e as Error)?.message}`);
        // 未配置视觉模型时补一句可操作提示
        const hint = isVisionConfigured() ? '' : '未检测到视觉模型配置：需同时设置 VLM_MODEL 与 VLM_API_KEY。';
        return jsonContent({ ...rest, visionError: `${(e as Error)?.message || String(e)}${hint}` });
      }
    }
  );

  server.registerTool(
    'lanhu_verify_render',
    {
      description: '把渲染页截图（可选：设计稿截图）调视觉模型做语义对比，返回 matchScore / verdict / diffs。截图传 imagePath（本地文件路径，推荐）或 imageBase64 兜底。传 context 可声明已知刻意差异，模型将跳过这些区域。结论仅是视觉线索，与 lanhu_verify_spec 数据比对冲突时以数据比对为准。',
      inputSchema: {
        actualImagePath: z.string().optional().describe('渲染页截图的本地文件路径（推荐，避免 base64 进上下文）'),
        actualImageBase64: z.string().optional().describe('渲染页截图 base64（兜底；与 actualImagePath 二选一）'),
        designImagePath: z.string().optional().describe('设计稿截图本地文件路径（可选，双图对比用）'),
        designImageBase64: z.string().optional().describe('设计稿截图 base64（兜底）'),
        context: z.string().optional().describe('已知刻意差异说明，模型将跳过这些区域的报错。如「顶部44px是系统状态栏，页面由原生渲染」「底部按钮刻意加高到56px」'),
        detail: z.enum(['auto', 'low', 'high']).optional(),
      },
    },
    async (args) => {
      const hasDesign = !!(args.designImagePath || args.designImageBase64);
      // 单图/双图 prompt 分支：单图时模型没有对比对象，硬按双图 prompt 会胡编
      const text = hasDesign
        ? 'You are a senior frontend reviewer. Compare the RENDERED screenshot (first image) ' +
          'against the DESIGN reference (second image). Output a JSON: ' +
          '{"matchScore":<0-100>,"verdict":"pass|need_fix|fail",' +
          '"diffs":[{"location":"","issue":"","severity":"minor|major|critical"}],' +
          '"suggestions":["..."]}. ' +
          'Ignore: JPEG compression noise, font anti-aliasing differences, resolution differences ' +
          'between the two images (compare by relative proportions, do not misreport size due to pixel density). ' +
          'Counter-rule: structural problems (misalignment/truncation/color deviation/missing elements) ' +
          'MUST be reported even if the image looks blurry. ' +
          `Known intentional differences (do NOT report these): ${args.context || 'none'}. ` +
          'Arbitration: your verdict is a visual hint only; if it conflicts with the lanhu_verify_spec ' +
          'data comparison, the data comparison wins. ' +
          'Output discipline: at most 15 diffs, most important first. Only output JSON.'
        : 'You are a senior frontend reviewer. No design reference provided — inspect this ' +
          'rendered screenshot for internal consistency only: layout sanity, alignment, ' +
          'contrast, truncation, overlap. Output JSON: ' +
          '{"matchScore":<0-100>,"verdict":"pass|need_fix|fail",' +
          '"diffs":[{"location":"","issue":"","severity":"minor|major|critical"}],' +
          '"suggestions":["..."]}. ' +
          `Known intentional differences (do NOT report these): ${args.context || 'none'}. ` +
          'Output discipline: at most 15 diffs, most important first. Only output JSON.';
      const images = [await loadImageInput({ b64: args.actualImageBase64, path: args.actualImagePath, what: '渲染页截图' })];
      if (hasDesign) images.push(await loadImageInput({ b64: args.designImageBase64, path: args.designImagePath, what: '设计稿截图' }));
      return jsonContent(await callVision({ images, text, detail: args.detail || 'high' }));
    }
  );

  server.registerTool(
    'vision_defect_check',
    {
      description: '整页/局部 UI 缺陷检测：重叠、溢出、缺图、对比度、错位、截断、破图、占位残留等 12 类。截图传 imagePath（本地文件路径，推荐）或 imageBase64 兜底。返回 defects 数组与 pass。传 context 可声明已知刻意差异，模型将跳过这些区域。',
      inputSchema: {
        imagePath: z.string().optional().describe('截屏本地文件路径（推荐，避免 base64 进上下文）'),
        imageBase64: z.string().optional().describe('截屏 base64（兜底；与 imagePath 二选一）'),
        context: z.string().optional().describe('已知刻意差异说明，模型将跳过这些区域的报错。如「顶部44px是系统状态栏，页面由原生渲染」'),
        language: z.string().optional().describe('语言，默认 zh-CN'),
        detail: z.enum(['auto', 'low', 'high']).optional(),
      },
    },
    async (args) => {
      const lang = args.language || 'zh-CN';
      const text =
        `Inspect this UI screenshot for visual defects; write all descriptions in ${lang}. Output JSON: ` +
        '{"defects":[{"type":"overlap|overflow|missing_asset|contrast|misalign|truncation|broken_image|placeholder|stale_state|typo|alignment|other",' +
        '"severity":"minor|major|critical","location":"","description":""}' +
        '],"summary":"","pass":<true|false>}. ' +
        'type guide: overlap / overflow / missing_asset / contrast(insufficient) / misalign / truncation / ' +
        'broken_image / placeholder(unreplaced, e.g. lorem or test images) / stale_state(e.g. loading never dismissed) / ' +
        'typo / alignment / other. ' +
        // severity 定性标准，不写死数字，模型硬套数字公式反而降信息量
        'severity (qualitative): critical = unreadable content / non-clickable element / blocked interaction; ' +
        'major = clearly visible, hurts consistency; minor = nitpick level. ' +
        'For contrast defects, always include the estimated ratio in description as "ratio:x.x". ' +
        `Known intentional differences (do NOT report these): ${args.context || 'none'}. ` +
        'Output discipline: at most 15 defects, most severe first. Only output JSON.';
      return jsonContent(await callVision({
        images: [await loadImageInput({ b64: args.imageBase64, path: args.imagePath, what: '截屏' })],
        text,
        detail: args.detail || 'auto',
      }));
    }
  );

  server.registerTool(
    'vision_e2e_triage',
    {
      description: 'E2E 测试失败时，分析截图+DOM 快照+错误文本，给出根因、类别、置信度与下一步动作建议。截图传 screenshotPath（本地文件路径，推荐）或 screenshotBase64 兜底。强烈建议传 expectedBehavior（测试预期行为）——归因质量取决于「预期 vs 实际」的差异分析，只给失败现场模型只能猜。',
      inputSchema: {
        expectedBehavior: z.string().optional().describe('测试的预期行为，如「点击提交按钮后 2s 内出现支付成功弹窗」——归因的基准线，强烈建议传入'),
        testSteps: z.string().optional().describe('失败前的操作步骤序列，如「打开页面 → 填写表单 → 点击提交」'),
        screenshotPath: z.string().optional().describe('失败截屏本地文件路径（推荐，避免 base64 进上下文）'),
        screenshotBase64: z.string().optional().describe('失败截屏 base64（兜底；与 screenshotPath 二选一）'),
        domSnapshot: z.string().optional().describe('失败时的 DOM 快照文本'),
        errorText: z.string().optional().describe('错误消息/栈'),
      },
    },
    async (args) => {
      // 期望-实际差异分析：有 expectedBehavior 归因才有基准线，否则退化为现象描述
      const text =
        'You are an E2E test triage assistant. You are given: the EXPECTED behavior, ' +
        '(optional) steps taken before failure, and failure artifacts (screenshot/DOM/error). ' +
        'Judge the root cause by comparing expected vs actual. Output JSON: ' +
        '{"rootCause":"<=30 words",' +
        '"evidence":"cite concrete evidence: DOM snippet / error text / screenshot phenomenon, <=60 words",' +
        '"category":"selector_not_found|selector_changed|timing|layout_css|data|auth|environment|other",' +
        '"confidence":<0-1>,' +
        '"next_action":"wait_and_retry|check_selector|refresh|fix_data|report_bug",' +
        '"fixSuggestion":"<=30 words"}. ' +
        'category guide: selector_not_found = target element never rendered; selector_changed = DOM structure ' +
        'changed but function still exists; timing = sequencing / dynamic rendering not finished; layout_css = ' +
        'style-caused anomaly; data = missing or wrong data; auth = auth/login-state problem; environment = ' +
        'network/timeout/proxy issues. ' +
        'confidence must be backed by evidence; confidence without evidence is meaningless. ' +
        `Expected behavior: ${args.expectedBehavior || '(not provided, base your analysis on the failure artifacts only)'}` +
        (args.testSteps ? `\nSteps before failure: ${args.testSteps}` : '');
      const images = args.screenshotPath || args.screenshotBase64
        ? [await loadImageInput({ b64: args.screenshotBase64, path: args.screenshotPath, what: '失败截屏' })]
        : [];
      const full = images.length ? text : 'No screenshot provided. Base your analysis on DOM + error text only.\n' + text;
      const dom = args.domSnapshot ? `\n\nDOM snapshot:\n${args.domSnapshot}` : '';
      const err = args.errorText ? `\n\nError text:\n${args.errorText}` : '';
      return jsonContent(await callVision({ images, text: full + dom + err, detail: 'auto' }));
    }
  );

  // cookie 探活：区分「cookie 过期」与「无权访问该资源」
  server.registerTool(
    'lanhu_check_auth',
    {
      description:
        '探活当前蓝湖 cookie 是否有效。调一次 user_teams 接口：返回 { ok:true, teamCount, teams } 表示 cookie 有效；返回 { ok:false, reason, hint } 表示失效（reason=cookie_expired/http_xxx/network_error）。用法：①任何蓝湖工具报 401 或返回空数据时，先调本工具确认是否 cookie 过期；②ok=true 但某次调用仍 401 → 是那个具体资源无权访问，重新登录无效，需联系设计者开权限；③ok=false(reason=cookie_expired) 或首次使用无 cookie → 真过期/未配置，提示用户二选一续期：方式1 浏览器 F12 → Network → 复制 Cookie 头写入 .mcp-local/lanhu.cookie；方式2 双击 lanhu-login.bat 或跑 npm run login 自动写入。完成后重试。',
      inputSchema: {
        cookie: z.string().optional(),
      },
    },
    async (args) => jsonContent(await checkAuth(credentials(args)))
  );

  server.registerTool(
    'lanhu_list_teams',
    {
      description:
        '列出当前账号加入的全部蓝湖团队（teamId/名称/角色/是否所有者/成员数）。多团队场景先用它发现团队，拿到 teamId 传给 lanhu_list_directory。不传任何参数即可；返回精简字段，省略敏感项。',
      inputSchema: {
        cookie: z.string().optional(),
      },
    },
    async (args) => jsonContent(await listUserTeams(credentials(args)))
  );

  server.registerTool(
    'lanhu_list_directory',
    {
      description:
        '一次拉团队目录（项目 → 分组层）。用于「想找某活动有几个设计稿」——AI 在这份目录里按分组名匹配，拿到 projectId 后传给 lanhu_read_sector。只到分组层（含 designCount），不展开设计稿名。团队定位优先级：有蓝湖链接传 url（从 tid 提取，最准）；无链接传 teamId（来自 lanhu_list_teams）；两者都没有则报错（无默认团队回退）。并行拉取约 2 秒，约 1.6k tokens。',
      inputSchema: {
        url: z.string().optional().describe('蓝湖链接（任意稿链接即可，从中提取 tid 定位团队）；比 teamId 更准'),
        teamId: z.string().optional().describe('团队 id（来自 lanhu_list_teams）；无 url 时用'),
        cookie: z.string().optional(),
      },
    },
    async (args) => jsonContent(await listDirectory({ ...credentials(args), ...(args.url ? { url: args.url } : {}), ...(args.teamId ? { teamId: args.teamId } : {}) }))
  );

  server.registerTool(
    'lanhu_read_sector',
    {
      description:
        '列出蓝湖项目下某个分组（需求）的所有设计稿目录：稿名/尺寸/层数，不含图层树（全量 layers 会撑爆上下文，故意不返回）。' +
        '用途：先用 lanhu_list_directory 定位分组，再用本工具看分组里有哪几张稿，按稿名挑出要实现的目标，最后用 lanhu_fetch_design 逐张读图层树实现。',
      inputSchema: {
        url: z.string().describe('蓝湖设计稿链接 或 项目 UUID（来自 lanhu_list_directory 的 projectId）'),
        sector: z.string().describe('分组名或分组 id（从 lanhu_list_directory 看到）'),
        cookie: z.string().optional(),
      },
    },
    async (args) => jsonContent(await readSector(args.url, args.sector, credentials(args)))
  );

  server.registerTool(
    'lanhu_download_slices',
    {
      description:
        '下载蓝湖设计稿切图到本地目录。范围二选一：传 url 下单稿切图；传 sector + url（项目 UUID 或该分组任一稿链接）下整个分组的切图（跨稿公共 icon 只下一次）。' +
        '去重：URL 去重（同图只下一次，默认开）、skipExisting（本地已存在则跳过，默认开）、sliceNames（只下指定名字的切图）。' +
        '倍率与格式由蓝湖 OSS 在线出图：scale 默认 2x（设计尺寸×2），可选 1x/3x/original（CDN 存储原图，实测 4x）；format 默认 png，可选 webp（体积更小，保透明）。' +
        '每个文件下载后做字节级验真（HTML 伪装/格式/实际像素），验真不过不落盘并记入 failed.reason；下载经 host 白名单与重定向逐跳校验。' +
        'withScaleUrls=true 时返回每个切图的全平台倍率 URL（1x/2x/3x/iOS/Android）。返回下载明细（真实格式/像素/sha256）、跳过统计、失败列表。',
      inputSchema: {
        url: z.string().describe('设计稿 URL（含 image_id）或纯 image_id；分组模式传项目 UUID 或该分组任一稿链接'),
        outputPath: z.string().describe('本地输出目录，如 src/assets/activity-xxx/'),
        projectId: z.string().optional().describe('项目 UUID（传纯 image_id 时必填；传 URL 自动提取）'),
        sector: z.string().optional().describe('分组名或分组 id：传了就下载该分组所有稿的切图（跨稿合并去重）'),
        sliceNames: z.array(z.string()).optional().describe('只下载指定名字的切图（同名不同 URL 都下，因为它们是不同的图）'),
        skipExisting: z.boolean().optional().describe('本地已存在同名文件则跳过，默认 true（避免重下公共 icon）'),
        scale: z.enum(['1x', '2x', '3x', 'original']).optional().describe('落盘倍率，默认 2x（设计尺寸×2，OSS 在线出图）。original=CDN 存储原图（实测 4x，供 iOS @3x/高清素材场景）'),
        format: z.enum(['png', 'webp']).optional().describe('输出格式，默认 png；webp 由 OSS 在线转换（体积更小，支持透明，iOS 14+/Android 与所有现代浏览器可用）'),
        withScaleUrls: z.boolean().optional().describe('结果附带每个切图的全平台倍率下载 URL（1x/2x/3x/iOS/Android 密度，与 format 同格式），需要其它倍率时不必重新调用'),
        cookie: z.string().optional(),
      },
    },
    async (args) => jsonContent(
      await downloadSlices(args.url, args.outputPath, {
        ...credentials(args),
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.sector ? { sector: args.sector } : {}),
        ...(args.sliceNames ? { sliceNames: args.sliceNames } : {}),
        ...(args.skipExisting !== undefined ? { skipExisting: args.skipExisting } : {}),
        ...(args.scale ? { scale: args.scale } : {}),
        ...(args.withScaleUrls !== undefined ? { withScaleUrls: args.withScaleUrls } : {}),
      })
    )
  );

  server.registerTool(
    'lanhu_verify_spec',
    {
      description:
        '设计稿验收（L3 数据比对）：取设计稿图层树的精确数值作为期望值，用 Playwright 打开页面采 getComputedStyle 作为实际值，逐字段 diff，输出尺寸/位置/色值/字号四类偏差清单（含 delta 与 minor/major/critical 分级）。' +
        '不含主观判断，结论可回归、可复现，是替代人工走查的主手段；lanhu_verify_render 的视觉语义比对只能当补充线索。' +
        '元素匹配：文案精确相等 > 几何 IoU（与语言无关）。' +
        '「样式清单比对」安全网：只比设计稿与页面的文字样式集合（fontSize/字重/色值），零标注、不比文案，永远在线——跨语言或跨迭代文案差异都不会让它失盲（见返回 inventory 字段）。' +
        '当前为最小可用版本：只跑默认态、单一视口（按设计稿 viewport 尺寸）、不评分。',
      inputSchema: {
        designUrl: z.string().describe('蓝湖设计稿 URL（期望值来源）'),
        pageUrl: z.string().describe('已实现页面 URL（实际值来源），需可访问'),
        waitFor: z.string().optional().describe('页面加载后等待出现的选择器（如 .task-list），用于等待接口数据渲染'),
        maxDiffs: z.number().optional().describe('返回偏差分组数上限，默认 50（按严重度排序，critical 组在前）'),
        cookie: z.string().optional(),
      },
    },
    async (args) => jsonContent(
      await verifyDesignSpec({
        designUrl: args.designUrl,
        pageUrl: args.pageUrl,
        credentials: credentials(args),
        ...(args.waitFor ? { waitFor: args.waitFor } : {}),
        ...(args.maxDiffs !== undefined ? { maxDiffs: args.maxDiffs } : {}),
      })
    )
  );
}
