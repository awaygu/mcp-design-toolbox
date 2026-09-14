// lanhu-client.ts — 蓝湖官方 API 客户端（Cookie 直调，无需浏览器）
// 端点：/api/project/image(稿详情+json_url) · /api/project/project_sectors+images(分组) · /api/account/user_teams(团队) · /workbench abstractfile/list(目录)

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeSketch, toLegacySketchJson } from './normalize.js';
import { coverTo1xJpeg } from './image.js';
import { AssetGuardError, buildScaleUrls, fetchAssetBytes, inspectAsset } from './asset-guard.js';
import type { AssetMeta } from './asset-guard.js';
import type { Credentials, DesignLayer, DesignMeta, DesignResult, SectorInfo, SliceInfo } from './types.js';

const LANHU_API_BASE = 'https://lanhuapp.com';

// 所有 cookie 过期/缺失提示统一引用这段（方式1 F12 复制，方式2 跑登录脚本）
const RELOGIN_HINT =
  '方式1：浏览器登录蓝湖后按 F12 → Network → 点任意请求 → 复制 Cookie 头整串，写入 .mcp-local/lanhu.cookie（或设 LANHU_COOKIE 环境变量）；' +
  '方式2：双击 lanhu-login.bat（或运行 npm run login），浏览器登录后按 Enter 自动写入 cookie。完成后让 AI 重试。';

// 都缺则报错：tenantId=0 会返回空目录，不能兜底
function resolveTeamId(opts: { teamId?: string; url?: string }): string {
  if (opts.teamId) return opts.teamId;
  if (opts.url) {
    const { teamId } = parseLanhuUrl(opts.url);
    if (teamId && teamId !== '0') return teamId;
  }
  throw new Error('无法定位团队：请传 teamId（来自 lanhu_list_teams）或 url（蓝湖链接提 tid）；纯 cookie 不带 teamId/url 时无法列目录');
}

// 不做鉴权判断，只返 { status, teams }，上层各自决定怎么处理错误
async function fetchUserTeams(cookie: string): Promise<{ status: number; teams: any[] }> {
  const res = await fetch(`${LANHU_API_BASE}/api/account/user_teams?need_open_related=true`, {
    headers: apiHeaders(cookie),
  });
  if (!res.ok) return { status: res.status, teams: [] };
  const json: any = await res.json();
  return { status: res.status, teams: json?.result || json?.data || [] };
}

// 只返回选 teamId 需要的字段，省略敏感项
export async function listUserTeams(
  opts: Credentials
): Promise<{
  teamCount: number;
  teams: Array<{ teamId: string; name: string; role: string; isOwner: boolean; memberNum: number }>;
}> {
  const cookie = resolveCookie(opts);
  const { status, teams } = await fetchUserTeams(cookie);
  // 401 不静默为空，否则调用方会误以为账号无团队
  assertStatusOk(status, 'auth', '团队列表');
  return {
    teamCount: teams.length,
    teams: teams.map((t) => ({
      teamId: t.id,
      name: t.name,
      role: t.role?.display || t.role?.name || '',
      isOwner: !!t.is_team_owner,
      memberNum: Number(t.member_num) || 0,
    })),
  };
}

function parseLanhuUrl(url: string): { projectId: string | null; imageId: string | null; teamId: string } {
  const pick = (name: string): string | null => {
    const m = new RegExp(`[?&]${name}=([a-f0-9-]+)`, 'i').exec(url);
    return m ? m[1] : null;
  };
  return {
    projectId: pick('project_id') || pick('pid'),
    imageId: pick('image_id'),
    teamId: pick('tid') || '0',
  };
}

function resolveCookie(opts: Credentials): string {
  if (!opts.cookie) throw new Error(`需要蓝湖登录凭证（二选一）：${RELOGIN_HINT}`);
  return opts.cookie;
}

// 接受蓝湖 URL 或项目 UUID，统一返回 project_id
function resolveProjectId(urlOrId: string): string {
  if (!urlOrId) throw new Error('需要蓝湖 URL 或项目 UUID');
  if (/[/?]/.test(urlOrId)) {
    const { projectId } = parseLanhuUrl(urlOrId);
    if (projectId) return projectId;
  }
  // 蓝湖 pid 是 8-4-4-4-12 的 UUID
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(urlOrId)) {
    return urlOrId;
  }
  throw new Error(`无法识别的项目标识：${urlOrId}（应为蓝湖 URL 或项目 UUID）`);
}

function apiHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://lanhuapp.com/web/',
  };
}

// 仅 lanhuapp.com 带 Cookie；CDN/OSS（标注数据、封面、切图）一律不带，免凭据外泄到第三方主机
function headersFor(url: string, cookie: string): Record<string, string> {
  const host = new URL(url).hostname;
  const isLanhu = host === 'lanhuapp.com' || host.endsWith('.lanhuapp.com');
  return isLanhu ? apiHeaders(cookie) : { Referer: 'https://lanhuapp.com/' };
}

// 401 分场景：auth=cookie 过期（重新登录有效）；resource=无该资源权限（重新登录无效）
class LanhuHttpError extends Error {
  constructor(public status: number, public scope: 'auth' | 'resource', public hint: string) {
    super(hint);
    this.name = 'LanhuHttpError';
  }
}

function assertStatusOk(status: number, scope: 'auth' | 'resource', what: string): void {
  if (status >= 200 && status < 300) return;
  if (status === 401) {
    if (scope === 'auth') {
      throw new LanhuHttpError(401, 'auth',
        `蓝湖鉴权失败（HTTP 401）：cookie 已过期或缺失关键字段。${RELOGIN_HINT}`);
    }
    throw new LanhuHttpError(401, 'resource',
      `无权访问${what}（HTTP 401）：cookie 仍可能有效，但该资源未对你分享。重新登录无效，请联系设计者开通权限，或换一个有权限的${what}。`);
  }
  throw new Error(`请求${what}失败：HTTP ${status}`);
}

// Response 版薄包装：给直接持有 Response 的 fetch 端点用
function assertOk(res: Response, scope: 'auth' | 'resource', what: string): void {
  assertStatusOk(res.status, scope, what);
}

// 探活不抛错：AI 需要结构化结果而非捕获异常
export async function checkAuth(opts: Credentials): Promise<
  | { ok: true; teamCount: number; teams: Array<{ teamId: string; name: string }> }
  | { ok: false; status: number; reason: string; hint: string }
> {
  // 无 cookie 时也返回结构化结果，与工具描述的首次使用分支一致
  if (!opts.cookie) {
    return { ok: false, status: 0, reason: 'no_cookie', hint: `未配置蓝湖 cookie。${RELOGIN_HINT}` };
  }
  try {
    const { status, teams } = await fetchUserTeams(opts.cookie!);
    if (status >= 200 && status < 300) {
      return { ok: true, teamCount: teams.length, teams: teams.map((t) => ({ teamId: t.id, name: t.name })) };
    }
    return {
      ok: false,
      status,
      reason: status === 401 ? 'cookie_expired' : `http_${status}`,
      hint: status === 401 ? `cookie 已过期或无效。${RELOGIN_HINT}` : `蓝湖返回 HTTP ${status}，稍后重试或检查网络。`,
    };
  } catch (e: any) {
    return { ok: false, status: 0, reason: 'network_error', hint: `网络请求失败：${e?.message || e}` };
  }
}

// 蓝湖标注 JSON 实测有 GBK 编码响应（响应头缺 charset 或声明不实），res.json() 会按 latin1 解出乱码。
// 策略：按响应头 charset 解码；无声明时先试 utf-8，解析出 latin1 高区特征字符（ç/å/é 或 Í¨ÐÐÖ¤ 形态）
// 则回退 gbk 重解码。utf-8 严格校验（fatal）失败也回退 gbk。
function decodeJsonBody(buf: ArrayBuffer, contentType: string): any {
  const m = /charset=([\w-]+)/i.exec(contentType || '');
  const declared = m?.[1]?.toLowerCase();
  const tryParse = (label: string): any | null => {
    try {
      const text = new TextDecoder(label, { fatal: true }).decode(buf);
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  if (declared && declared !== 'iso-8859-1') {
    const json = tryParse(declared);
    if (json != null) return json;
  }
  const utf8 = tryParse('utf-8');
  if (utf8 != null) return utf8;
  // latin1 无 fatal 错误（任何字节都合法），只能靠乱码特征识别：非 ASCII 字符落在 latin1 高区且无 CJK
  const text = new TextDecoder('iso-8859-1').decode(buf);
  if (/[-ÿ]/.test(text) && !/[一-鿿]/.test(text)) {
    const gbk = tryParse('gbk');
    if (gbk != null) return gbk;
  }
  // 都失败：容忍非严格 utf-8（含个别坏字节），至少拿到可用的 JSON
  return JSON.parse(text);
}

// 读单个设计稿（按 imageId）
async function fetchDesignByImageId(
  imageId: string,
  projectId: string,
  cookie: string,
  opts: { needCover?: boolean }
): Promise<DesignResult> {
  const headers = apiHeaders(cookie);

  // 1) 拿详情（封面图 url + json_url）
  const detailRes = await fetch(`${LANHU_API_BASE}/api/project/image?pid=${projectId}&image_id=${imageId}`, { headers });
  assertOk(detailRes, 'resource', '设计稿');
  const detailJson = await detailRes.json();
  const detail = detailJson?.result || detailJson?.data || {};
  const versions: any[] = detail.versions || [];
  const jsonUrl = versions[0]?.json_url;

  // 2) 拿标注数据解析图层树
  let layers: DesignLayer[] = [];
  let meta: DesignMeta = { rawLayerCount: 0, totalLayerCount: 0 };
  let canvasWidth: number = detail.width || 0;
  let canvasHeight: number = detail.height || 0;
  let slices: SliceInfo[] = [];
  if (jsonUrl) {
    const jsonRes = await fetch(jsonUrl, { headers: headersFor(jsonUrl, cookie) });
    // CDN 403/404 常见于标注数据过期，需明确报状态码，别让 SyntaxError 刷屏
    if (!jsonRes.ok) throw new Error(`下载设计稿标注数据失败：HTTP ${jsonRes.status}（${jsonUrl}）`);
    const json = decodeJsonBody(await jsonRes.arrayBuffer(), jsonRes.headers.get('content-type') || '');
    // 新版插件格式（sketchPlugin 扁平 info[]）先转旧版树：normalize 与 artboard/切图提取都按旧结构走
    const legacy = toLegacySketchJson(json);
    const norm = normalizeSketch(legacy);
    layers = norm.layers;
    meta = norm.meta;
    // 画布尺寸取 artboard.frame（图层坐标基准）；detail.width 是缩放后的显示尺寸
    const ab = legacy?.artboard;
    if (ab?.frame) {
      canvasWidth = Math.round(Number(ab.frame.width || 0)) || canvasWidth;
      canvasHeight = Math.round(Number(ab.frame.height || 0)) || canvasHeight;
    }
    slices = collectSlices(ab);
  }

  // 3) 拿封面图（仅 needCover 时下载）；4x 单张可达 1.6MB，压到 1x JPEG 再返回
  let coverImageBase64: string | undefined;
  if (opts.needCover) {
    const coverUrl = detail.url || versions[0]?.url;
    if (coverUrl) {
      const imgRes = await fetch(coverUrl, { headers: headersFor(coverUrl, cookie) });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const small = await coverTo1xJpeg(buf, canvasWidth, canvasHeight);
        coverImageBase64 = small.toString('base64');
      }
    }
  }

  return {
    source: 'api',
    name: detail.name,
    viewport: { width: canvasWidth, height: canvasHeight },
    layers,
    meta: { ...meta, docName: detail.name ?? meta.docName },
    ...(slices.length ? { slices } : {}),
    ...(coverImageBase64 ? { coverImageBase64 } : {}),
  };
}

// 递归收集切图：遍历 artboard 树，收集 hasExportImage 且带 image.imageUrl 的图层
function collectSlices(node: any): SliceInfo[] {
  const out: SliceInfo[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n.hasExportImage && n.image?.imageUrl) {
      const f = n.frame || {};
      out.push({
        name: String(n.name || 'slice'),
        imageUrl: n.image.imageUrl,
        // 蓝湖原始 frame 用 left/top 表坐标（无 x/y 字段），必须兜底，否则恒为 0,0
        x: Math.round(Number(f.x ?? f.left ?? 0)),
        y: Math.round(Number(f.y ?? f.top ?? 0)),
        w: Math.round(Number(f.width ?? 0)),
        h: Math.round(Number(f.height ?? 0)),
      });
    }
    for (const child of n.layers || []) walk(child);
  };
  walk(node);
  return out;
}

// URL → 短 hash（前 8 位 md5），用作切图文件名防重名
function shortHash(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 8);
}

// 读单个设计稿（从 URL）
export async function fetchDesignViaApi(
  url: string,
  opts: Credentials & { needCover?: boolean }
): Promise<DesignResult> {
  const { projectId, imageId } = parseLanhuUrl(url);
  if (!projectId) throw new Error('无法从 URL 提取 project_id/pid');
  if (!imageId) throw new Error('无法从 URL 提取 image_id');
  const cookie = resolveCookie(opts);
  const r = await fetchDesignByImageId(imageId, projectId, cookie, opts);
  return { ...r, url };
}

// 读单个设计稿（imageId+projectId 直达，免拼 URL——read_sector 拿到的就是 image_id）
export async function fetchDesignByIds(
  imageId: string,
  projectId: string,
  opts: Credentials & { needCover?: boolean }
): Promise<DesignResult> {
  const cookie = resolveCookie(opts);
  const r = await fetchDesignByImageId(imageId, projectId, cookie, opts);
  return { ...r, name: r.name || imageId };
}

// parentId=0 列根 → folder 下钻项目 → 并列各项目分组；不展开设计稿名
export async function listDirectory(
  opts: Credentials & { teamId?: string; url?: string }
): Promise<{
  teamId: string;
  projectCount: number;
  sectorCount: number;
  directory: Array<{ project: string; projectId: string; sectors: Array<{ name: string; designCount: number }> }>;
}> {
  const cookie = resolveCookie(opts);
  const headers = { ...apiHeaders(cookie), 'Content-Type': 'application/json' };
  const teamId = resolveTeamId(opts);

  // 1) 列根目录（folder/project）
  const rootRes = await fetch(`${LANHU_API_BASE}/workbench/api/workbench/abstractfile/list`, {
    method: 'POST', headers, body: JSON.stringify({ tenantId: teamId, parentId: 0 }),
  });
  assertOk(rootRes, 'auth', '团队目录');
  const rootJson = await rootRes.json();
  const rootItems: any[] = Array.isArray(rootJson.data) ? rootJson.data : [];

  // 2) 并行下钻所有 folder，根目录的 project 直接收
  const folders = rootItems.filter((p) => p.sourceType === 'folder');
  const rootProjects = rootItems.filter((p) => p.sourceType !== 'folder');
  // 单个 folder 下钻失败只记进 folderErrors，不整体抛错
  const folderErrors: string[] = [];
  const underFolders = await Promise.all(
    folders.map(async (f) => {
      try {
        const r = await fetch(`${LANHU_API_BASE}/workbench/api/workbench/abstractfile/list`, {
          method: 'POST', headers, body: JSON.stringify({ tenantId: teamId, parentId: f.id }),
        });
        if (!r.ok) {
          folderErrors.push(String(f.name || f.id));
          return [];
        }
        const j = await r.json();
        return Array.isArray(j.data) ? j.data : [];
      } catch {
        folderErrors.push(String(f.name || f.id));
        return [];
      }
    })
  );
  const allProjects = [...rootProjects, ...underFolders.flat()];

  // 3) 并行列各项目分组；单个项目无权限只记录，不影响其余——目录列举就是「能看到什么列什么」
  const failedProjects: Array<{ project: string; projectId: string; error: string }> = [];
  const perProject = (
    await Promise.all(
      allProjects.map((p) =>
        listSectorsByProject(p.sourceId, opts)
          .then((r) => ({
            ok: true as const,
            value: {
              project: p.sourceName,
              projectId: p.sourceId,
              sectors: r.sectors.map((s) => ({ name: s.name, designCount: s.designCount })),
            },
          }))
          .catch((e: any) => {
            failedProjects.push({ project: p.sourceName, projectId: p.sourceId, error: e?.message || String(e) });
            return { ok: false as const };
          })
      )
    )
  ).filter((r) => r.ok).map((r) => (r as { ok: true; value: any }).value);

  const sectorCount = perProject.reduce((a, p) => a + p.sectors.length, 0);
  return {
    teamId,
    projectCount: perProject.length,
    sectorCount,
    directory: perProject,
    ...(failedProjects.length ? { failedProjects } : {}),
    ...(folderErrors.length ? { failedFolders: folderErrors } : {}),
  };
}

// 列项目下所有分组（核心：按 projectId，不依赖 URL）
export async function listSectorsByProject(
  projectId: string,
  opts: Credentials
): Promise<{ projectId: string; sectorCount: number; sectors: SectorInfo[] }> {
  const cookie = resolveCookie(opts);
  const headers = apiHeaders(cookie);
  // 按 project 查时 team_id 用 0 兜底
  const teamId = '0';

  const sRes = await fetch(`${LANHU_API_BASE}/api/project/project_sectors?project_id=${projectId}`, { headers });
  assertOk(sRes, 'resource', '项目分组');
  const sJson = await sRes.json();
  const sectors: any[] = sJson?.data?.sectors || sJson?.result?.sectors || [];

  const dRes = await fetch(`${LANHU_API_BASE}/api/project/images?project_id=${projectId}&team_id=${teamId}&dds_status=1`, { headers });
  assertOk(dRes, 'resource', '项目设计稿列表');
  const dJson = await dRes.json();
  const images: any[] = dJson?.data?.images || dJson?.data?.list || dJson?.data || [];
  const nameMap = new Map<string, string>();
  for (const im of images) {
    const id = im.image_id || im.id;
    if (id) nameMap.set(id, im.name || im.image_name || id);
  }

  return {
    projectId,
    sectorCount: sectors.length,
    sectors: sectors.map((s) => ({
      id: s.id,
      name: s.name,
      designCount: (s.images || []).length,
      designs: (s.images || []).map((iid: string) => ({ image_id: iid, name: nameMap.get(iid) || iid })),
    })),
  };
}

// 只给目录不给图层树：26 稿全量 layers 实测 395KB 会撑爆 Agent 上下文
export async function readSector(
  url: string,
  sectorName: string,
  opts: Credentials
): Promise<{
  sector: string;
  designCount: number;
  designs: Array<{ image_id: string; name: string; viewport: { width: number; height: number }; layerCount: number }>;
}> {
  const projectId = resolveProjectId(url);
  const list = await listSectorsByProject(projectId, opts);
  const sector = list.sectors.find((s) => s.name === sectorName || s.id === sectorName);
  if (!sector) {
    throw new Error(`未找到分组「${sectorName}」，可用分组：${list.sectors.map((s) => s.name).join('、')}`);
  }
  const cookie = resolveCookie(opts);

  // 并行抓各稿拿 viewport + 层数；单稿失败记入 failed，不整体挂
  const failed: Array<{ image_id: string; name: string; error: string }> = [];
  const okDesigns = (
    await Promise.all(
      sector.designs.map((d) =>
        fetchDesignByImageId(d.image_id, projectId, cookie, {})
          .then((r) => ({
            ok: true as const,
            value: { image_id: d.image_id, name: d.name, viewport: r.viewport, layerCount: r.layers.length },
          }))
          .catch((e: any) => {
            failed.push({ image_id: d.image_id, name: d.name, error: e?.message || String(e) });
            return { ok: false as const };
          })
      )
    )
  ).filter((r) => r.ok).map((r) => (r as { ok: true; value: any }).value);

  return {
    sector: sector.name,
    designCount: okDesigns.length,
    designs: okDesigns,
    ...(failed.length ? { failed } : {}),
  };
}

// 单稿传 urlOrImageId；分组传 sector + urlOrImageId。三层去重：URL / skipExisting / sliceNames
export async function downloadSlices(
  urlOrImageId: string,
  outputPath: string,
  opts: Credentials & {
    projectId?: string;
    sector?: string;
    sliceNames?: string[];
    skipExisting?: boolean;
    scale?: '1x' | '2x' | '3x' | 'original';   // 落盘倍率，默认 2x
    format?: 'png' | 'webp';                    // 输出格式，默认 png（OSS 在线转换）
    withScaleUrls?: boolean;                    // 结果附带全平台倍率 URL（1x/2x/3x/iOS/Android）
  }
): Promise<{
  scope: string;          // 单稿=稿名，分组=分组名
  outputDir: string;
  downloaded: number;
  skipped: { dup: number; exist: number };
  failed: Array<{ name: string; url: string; status: number; reason?: string }>;
  slices: Array<{
    name: string; file: string; bytes: number; w: number; h: number; x: number; y: number;
    scale: string;          // 落盘倍率
    format: string;         // 字节级验证出的真实格式
    pixelW: number; pixelH: number;  // 落盘文件实际像素（验真实测）
    sha256: string;         // 落盘内容哈希（缓存对账用）
    scaleUrls?: Record<string, string>;
  }>;
  designErrors?: string[]; // 分组模式下读取失败的稿（尽力而为：其余稿照常下载）
}> {
  const skipExist = opts.skipExisting !== false; // 默认 true
  const nameFilter = opts.sliceNames?.length ? new Set(opts.sliceNames) : null;

  let scope: string;
  let rawSlices: SliceInfo[];
  let designErrors: string[] | undefined;

  if (opts.sector) {
    // 分组模式
    const projectId = resolveProjectId(urlOrImageId);
    const cookie = resolveCookie(opts);
    const secList = await listSectorsByProject(projectId, opts);
    const sector = secList.sectors.find((s) => s.name === opts.sector || s.id === opts.sector);
    if (!sector) {
      throw new Error(`未找到分组「${opts.sector}」，可用分组：${secList.sectors.map((s) => s.name).join('、')}`);
    }
    rawSlices = [];
    const secErrors: string[] = [];
    // 并行抓各稿切图清单；单稿失败只记 designErrors，已抓到的照常下载
    await Promise.all(
      sector.designs.map((d) =>
        fetchDesignByImageId(d.image_id, projectId, cookie, {})
          .then((r) => rawSlices.push(...(r.slices || [])))
          .catch((e: any) => secErrors.push(`${d.name}: ${e?.message || e}`))
      )
    );
    if (secErrors.length) designErrors = secErrors;
    scope = sector.name;
  } else {
    // 单稿模式
    let imageId: string | null = null;
    let projectId = opts.projectId || '';
    if (/[/?]/.test(urlOrImageId)) {
      const parsed = parseLanhuUrl(urlOrImageId);
      imageId = parsed.imageId;
      projectId = parsed.projectId || projectId;
    } else {
      imageId = urlOrImageId;
    }
    if (!imageId) throw new Error('无法从输入解析 image_id，请传设计稿 URL 或 image_id');
    if (!projectId) throw new Error('下载切图需要 projectId：传 URL 自动提取，或显式传 projectId');
    const cookie = resolveCookie(opts);
    const design = await fetchDesignByImageId(imageId, projectId, cookie, {});
    rawSlices = design.slices || [];
    scope = design.name || imageId;
  }

  if (!rawSlices.length) {
    return { scope, outputDir: path.resolve(outputPath), downloaded: 0, skipped: { dup: 0, exist: 0 }, failed: [], slices: [] };
  }

  const dir = path.resolve(outputPath);
  mkdirSync(dir, { recursive: true });

  const seenUrl = new Set<string>();      // URL 去重
  // 循环内已过滤无 imageUrl 的条目，pending 里必有 URL
  const pending: Array<SliceInfo & { imageUrl: string }> = [];
  let dupCount = 0;
  for (const s of rawSlices) {
    const src = s.imageUrl;
    if (!src) continue;
    if (nameFilter && !nameFilter.has(s.name)) continue;   // sliceNames 过滤
    if (seenUrl.has(src)) { dupCount++; continue; }
    seenUrl.add(src);
    pending.push({ ...s, imageUrl: src });
  }

  const out: Array<{ name: string; file: string; bytes: number; w: number; h: number; x: number; y: number; scale: string; format: string; pixelW: number; pixelH: number; sha256: string; sourceScale?: number; scaleUrls?: Record<string, string> }> = [];
  const failed: Array<{ name: string; url: string; status: number; reason?: string }> = [];
  let existCount = 0;

  const scale = opts.scale || '2x';
  const scaleNum = scale === 'original' ? 0 : Number(scale.replace('x', '')); // 1|2|3

  // 并发池（默认 6）：串行每张图 RTT 叠加太严重，分组内切图多时会慢到不可用
  const concurrency = Number(process.env.LANHU_SLICE_CONCURRENCY) || 6;
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const idx = cursor++;
      const s = pending[idx];
      const src = s.imageUrl;
      const cleanName = String(s.name).replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_');
      const hash = shortHash(src);
      // 全平台倍率 URL：original/2x 走原图直出；1x/3x 拼 OSS resize 参数在线出图，省 4x 全量下载的流量
      const format = opts.format || 'png';
      const scaleUrls = buildScaleUrls(src, s.w, s.h, 4, format);
      // 下载即最终字节：倍率与格式都交给 OSS 在线处理（original 的 png 直取原图），本地不做二次处理
      const downloadUrl = scaleUrls[scale] || src;
      const suffix = scale === '2x' ? '' : `@${scale}`;
      // 落盘目标像素：2x/1x/3x 按倍率构造；original 以验真实测为准
      const expectW = scaleNum ? Math.round(s.w * scaleNum) : 0;
      const expectH = scaleNum ? Math.round(s.h * scaleNum) : 0;

      // 预测落盘文件名：2x/1x/3x 的格式由 OSS format 参数确定（png/webp），
      // 存在性检查可先于下载；original 的真实格式要验真后才知道，检查挪到验真之后
      const predictedPath = scale === 'original' ? null : path.join(dir, `${cleanName}_${hash}${suffix}.${format}`);
      if (predictedPath && skipExist && existsSync(predictedPath)) {
        existCount++;
        out[idx] = { name: s.name, file: predictedPath, bytes: 0, w: s.w, h: s.h, x: s.x, y: s.y, scale, format, pixelW: expectW, pixelH: expectH, sha256: '' };
        continue;
      }

      // 下载（host 白名单/重定向逐跳校验/大小上限/瞬态重试）+ 字节级验真
      let buf: Buffer;
      let meta: AssetMeta;
      try {
        const res = await fetchAssetBytes(downloadUrl, { cookie: opts.cookie });
        meta = await inspectAsset(res.bytes);
        buf = res.bytes;
      } catch (e) {
        const code = e instanceof AssetGuardError ? e.code : 'download_failed';
        const m = /^http_(\d+)$/.exec(code);
        failed.push({ name: s.name, url: src, status: m ? Number(m[1]) : 0, reason: code });
        continue;
      }

      const finalExt = meta.format === 'jpeg' ? 'jpg' : meta.format;
      const filePath = predictedPath ? predictedPath : path.join(dir, `${cleanName}_${hash}${suffix}.${finalExt}`);
      // 验真后扩展名与预测不一致（original 且非 png）→ 用真实名字重查存在性
      if (filePath !== predictedPath && skipExist && existsSync(filePath)) {
        existCount++;
        out[idx] = { name: s.name, file: filePath, bytes: 0, w: s.w, h: s.h, x: s.x, y: s.y, scale, format: meta.format, pixelW: meta.width || 0, pixelH: meta.height || 0, sha256: meta.sha256 };
        continue;
      }

      // 下载到的字节就是最终文件，原样落盘（不重编码、不缩放）
      writeFileSync(filePath, buf);
      out[idx] = {
        name: s.name, file: filePath, bytes: buf.length, w: s.w, h: s.h, x: s.x, y: s.y,
        scale,
        format: meta.format,
        pixelW: meta.width || 0,
        pixelH: meta.height || 0,
        sha256: meta.sha256,
        ...(opts.withScaleUrls ? { scaleUrls } : {}),
      };
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, pending.length || 1) },
    () => worker()
  );
  await Promise.all(workers);

  return {
    scope,
    outputDir: dir,
    downloaded: out.filter((s) => s && s.bytes > 0).length,
    skipped: { dup: dupCount, exist: existCount },
    failed,
    slices: out.filter(Boolean),
    ...(designErrors ? { designErrors } : {}),
  };
}
