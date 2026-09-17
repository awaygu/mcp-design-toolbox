/**
 * CoDesign 产品原型爬取模块
 * 负责：打开分享链接、输入密码、遍历目录、提取页面内容、分段截图
 *
 * CoDesign 原型页面结构：
 * - 密码页: .prototype-password (一个隐藏 input + 4个视觉方块)
 * - 左侧目录: .content__menu .t-tree (TDesign tree 组件)
 *   - 节点: .t-tree__item
 *   - 标签: .t-tree__label (可点击)
 *   - 文字: .label-text
 *   - 数量: .total-text (需过滤)
 *   - 分组图标: .t-folder-icon
 * - 右侧内容: .axure-container (Axure 原型渲染区)
 */
import { createHash } from 'crypto';
import type { Frame, Page } from 'playwright';
import { launchBrowser, getPage, waitForNetworkIdle } from './browser.js';
import { capturePageSegments, captureContentImageShots } from './screenshot.js';
import { axureExtractExpression } from './axure-dom.js';
import type {
  CrawledPage,
  ExtractedContent,
  NavigationResult,
  OutlineNode,
  PageImage,
  ScreenshotResult,
  TreeMatchResult,
  TreeNode,
} from './types.js';

/** 目录节点点击结果：ok=false 表示目录树已刷新，索引失效 */
type ClickOutcome = { ok: true } | { ok: false; reason: 'stale_outline' };

/**
 * 打开 CoDesign 分享链接并输入密码
 */
export async function openShareLink(url: string, password?: string): Promise<void> {
  const page = await launchBrowser({ headless: true });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForNetworkIdle(8000);

  // 检测是否需要密码
  let needPassword = false;
  try {
    needPassword = (await page.$('.prototype-password')) !== null;
  } catch {
    needPassword = false;
  }

  if (needPassword && password) {
    await inputPassword(page, password);

    // 点击确定按钮（点击后页面会导航，需要特殊处理）
    try {
      const submitBtn = await page.$('.prototype-password__submit');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
    } catch {
      // 点击可能因导航而报错，忽略
    }

    // 等待目录树出现：用 waitForSelector 而非固定次数轮询——
    // 条件满足立刻返回（不再白等到 20 次），且导航导致执行上下文重建时会自动重试。
    try {
      await page.waitForSelector('.t-tree', { timeout: 20000, state: 'attached' });
    } catch {
      throw new Error('密码验证后未能加载原型页面（未找到目录树）');
    }
    await page.waitForTimeout(1000);
  }
}

/**
 * 输入密码（CoDesign 密码页：一个隐藏 input + 4个视觉方块）
 */
async function inputPassword(page: Page, password: string): Promise<void> {
  const input = await page.$('.prototype-password__input input, input.t-input__inner');
  if (input) {
    await input.click();
    await input.fill(password);
    await page.waitForTimeout(300);
  } else {
    await page.click('.prototype-password__input');
    await page.keyboard.type(password, { delay: 100 });
  }
}

/**
 * 收集目录树扁平节点（含 DOM 索引）。TDesign 树为扁平渲染，DOM 顺序即大纲顺序，
 * 后续点击按索引定位，天然规避同名节点歧义。
 */
async function collectTreeItems(): Promise<TreeNode[] | null> {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动，请先调用 openShareLink');

  return page.evaluate(() => {
    const tree = document.querySelector('.t-tree');
    if (!tree) return null;

    const items: { name: string; level: number; isGroup: boolean; domIndex: number }[] = [];
    tree.querySelectorAll('.t-tree__item').forEach((item, domIndex) => {
      const labelText = item.querySelector(':scope > .t-tree__label .label-text');
      const name = labelText?.textContent?.trim();
      if (!name) return;

      // 判断是否是分组：有 total-text（子项数量标记）的就是分组
      const totalText = item.querySelector(':scope > .t-tree__label .total-text');
      const isGroup = !!totalText;

      // 读取 level（从 style 的 --level 变量）
      const style = item.getAttribute('style') || '';
      const levelMatch = style.match(/--level:\s*(\d+)/);
      const level = levelMatch ? parseInt(levelMatch[1], 10) : 0;

      items.push({ name, level, isGroup, domIndex });
    });
    return items;
  });
}

/**
 * 按层级栈为扁平节点推导完整路径（祖先分组名 + 自身，用 / 连接）。
 * 同名页面靠路径成为唯一地址，如「活动/流程图」。
 */
export function buildTreePaths<T extends TreeNode>(items: T[]): (T & { path: string })[] {
  const stack: { level: number; name: string }[] = [];
  return items.map((item) => {
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    stack.push({ level: item.level, name: item.name });
    return { ...item, path: stack.map((s) => s.name).join('/') };
  });
}

/**
 * 获取原型页面大纲（左侧目录树，节点带完整路径）
 */
export async function getPageOutline(): Promise<OutlineNode[]> {
  const items = (await collectTreeItems()) || [];
  const tree = buildTreePaths(items);

  // 给非分组项分配 pageIndex
  let pageIndex = 0;
  return tree.map((item) => {
    if (!item.isGroup) {
      return { ...item, pageIndex: pageIndex++ };
    }
    return item;
  });
}

/**
 * 获取 Axure 原型的 iframe（内容实际在 blob URL 的 iframe 中）
 */
export async function getAxureFrame(): Promise<Frame | null> {
  const page = getPage();
  if (!page) return null;

  const iframeEl = await page.$('.axure-container iframe');
  if (iframeEl) {
    const frame = await iframeEl.contentFrame();
    if (frame) return frame;
  }

  const frames = page.frames();
  const blobFrame = frames.find((f) => f.url().startsWith('blob:'));
  return blobFrame || null;
}

/**
 * 声明式等待 Axure iframe 内出现正文（替代固定次数轮询）。
 * blob iframe 被替换时 waitForFunction 会抛，调用方必须 catch 后兜底。
 */
async function waitForFrameContent(_page: Page, timeout: number): Promise<boolean> {
  const frame = await getAxureFrame();
  if (!frame) return false;
  await frame.waitForFunction(
    () => {
      const b = document.body;
      if (!b) return false;
      return (b.innerText || b.textContent || '').trim().length > 5;
    },
    undefined,
    { timeout, polling: 250 }
  );
  return true;
}

/**
 * 导航到指定页面（按目录树 DOM 索引点击）
 * @param domIndex - 目标节点在大纲数组中的索引
 * @param opts.quick - 快速模式：仅探测 iframe 是否切换（1.5s），用于判断分组节点是否有自身页面
 * @returns frameChanged=false 表示点击后 iframe 未切换（纯展开类分组节点，无自身内容）
 */
export async function navigateToPageByIndex(
  domIndex: number,
  { quick = false }: { quick?: boolean } = {}
): Promise<NavigationResult> {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动');

  const outcome = await page.evaluate((index): ClickOutcome => {
    const tree = document.querySelector('.t-tree');
    if (!tree) return { ok: false, reason: 'stale_outline' };

    const items = Array.from(tree.querySelectorAll('.t-tree__item'));
    const label = items[index]?.querySelector<HTMLElement>(':scope > .t-tree__label');
    if (!label) return { ok: false, reason: 'stale_outline' };

    label.click();
    return { ok: true };
  }, domIndex);

  if (!outcome.ok) return outcome;

  // 等待 iframe 切换到新页面（URL 变化或元素被替换）。
  // 用 waitForFunction 声明式等待替代固定次数轮询：条件满足立刻返回，
  // 且 blob iframe 被替换导致执行上下文销毁时 Playwright 会自动重试。
  // 轮询兜底保留：waitForFunction 在 frame 彻底 detach 时会抛，不能丢。
  const oldFrame = await getAxureFrame();
  const oldFrameUrl = oldFrame?.url() || '';
  const quickTimeout = 1500;
  const fullTimeout = 6000;
  let frameChanged = await page
    .waitForFunction(
      (prevUrl) => {
        const el = document.querySelector('.axure-container iframe');
        if (!el) return false;
        const cur = (el as HTMLIFrameElement).src || (el as HTMLIFrameElement).getAttribute('src') || '';
        // src 变化即视为切换；blob: src 不变的极端情况交给下面的兜底轮询
        return cur !== prevUrl;
      },
      oldFrameUrl,
      { timeout: quick ? quickTimeout : fullTimeout, polling: 250 }
    )
    .then(() => true)
    .catch(() => false);

  if (!frameChanged) {
    // 兜底：src 未变但 iframe 元素可能被替换（同 URL 重渲染）
    const probes = quick ? 6 : 24;
    for (let i = 0; i < probes; i++) {
      await page.waitForTimeout(250);
      const frame = await getAxureFrame();
      if (!frame) continue;
      if (frame !== oldFrame || frame.url() !== oldFrameUrl) {
        frameChanged = true;
        break;
      }
    }
  }

  // 快速模式且未切换：纯展开类分组，跳过完整等待（否则每组白等 10s+）
  if (quick && !frameChanged) return { ok: true, frameChanged: false };

  await waitForNetworkIdle(5000);

  // 等待 iframe 中有内容：声明式等待正文就绪，失败再退回轮询（frame 可能重建）
  const contentReady = await waitForFrameContent(page, 5000).catch(() => false);
  if (!contentReady) {
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(250);
      if (await waitForFrameContent(page, 200).catch(() => false)) break;
    }
  }

  return { ok: true, frameChanged };
}

/**
 * 纯函数：在大纲中匹配目标（分组或页面）。
 * 支持：叶子名（唯一时）、完整路径、路径尾部（最后 N 段）。
 * 多种命中时返回候选路径清单，让调用方拿到可行动的提示。
 */
export function matchTreeTarget<T extends { name: string; path: string }>(
  outline: T[],
  name: string,
  kind: 'any' | 'group' = 'any'
): TreeMatchResult<T> {
  const groupsOnly = kind === 'group';
  const pool = groupsOnly
    ? outline.filter((i) => (i as unknown as { isGroup?: boolean }).isGroup)
    : outline;
  if (!pool.length) {
    return { ok: false, reason: `目录中没有任何${groupsOnly ? '分组' : '节点'}` };
  }

  // 1) 精确路径匹配（唯一地址，直接命中）
  const exactPaths = pool.filter((i) => i.path === name);
  if (exactPaths.length === 1) return { ok: true, target: exactPaths[0] };

  // 2) 精确叶子名匹配（唯一时可用；同名靠路径消歧）
  const exactNames = pool.filter((i) => i.name === name);
  if (exactNames.length === 1) return { ok: true, target: exactNames[0] };

  // 3) 路径尾部匹配（含部分段，如「流程图」命中「活动/流程图」）
  const pathSuffix = pool.filter((i) => i.path.endsWith(name));
  if (pathSuffix.length === 1) return { ok: true, target: pathSuffix[0] };

  const candidates = [...new Set([...exactPaths, ...exactNames, ...pathSuffix])];
  if (candidates.length > 0) {
    if (candidates.length > 1) {
      return {
        ok: false,
        reason: `「${name}」匹配到 ${candidates.length} 个节点：${candidates
          .map((i) => i.path)
          .join('、')}。请使用完整路径（父分组/页面名）区分`,
      };
    }
    return {
      ok: false,
      reason: `「${name}」匹配到同名节点（路径：${candidates[0].path}），无法区分`,
    };
  }
  return {
    ok: false,
    reason: `目录中未找到「${name}」。可用路径：${pool.map((i) => i.path).join('、')}`,
  };
}

function describeNavigationFailure(nav: { ok: false; reason: string }): string {
  if (nav.reason === 'stale_outline') {
    return '目录树已刷新导致定位失效，请重新调用获取大纲后再试';
  }
  return nav.reason;
}

/**
 * 提取当前页面的结构化内容（在 Axure iframe 中执行）
 *
 * 用结构化提取替代旧的 container.innerText：保留表格二维结构、控件类型与
 * 文本行结构，并尝试从连接线几何还原流程图拓扑（详见 axure-dom.ts）。
 */
export async function extractPageText(): Promise<ExtractedContent> {
  const frame = await getAxureFrame();
  if (!frame) {
    return { text: '', tables: [], images: [], blocks: [], flow: null };
  }
  // 走字符串表达式注入（而非直接传函数）：兼容 esbuild/tsx 的 keepNames 包装，见 axure-dom.ts
  return (await frame.evaluate(axureExtractExpression())) as ExtractedContent;
}

/**
 * 采集当前页面「内容图」的定向截图（内嵌原型图/设计稿），供视觉模型单独解析。
 * 已过滤连接线段与图标级小图（判定见 axure-dom 的 isContent）。
 * 截图失败不抛错——它只是增强项，不该阻断主流程。
 */
export async function capturePageContentImages(
  pageName: string,
  images: PageImage[]
): Promise<PageImage[]> {
  try {
    const frame = await getAxureFrame();
    return await captureContentImageShots(frame, pageName, images);
  } catch {
    return [];
  }
}

/**
 * 截取当前页面（分段截图，超长页面自动分段）
 * @param filename - 文件名（不含扩展名）
 * @param pageCacheKey - 页面级缓存键（url+页面名+文字哈希），命中时跳过截图
 */
export async function screenshotPage(
  filename: string,
  pageCacheKey?: string | null
): Promise<ScreenshotResult> {
  const page = getPage();
  if (!page) throw new Error('浏览器未启动');

  const frame = await getAxureFrame();
  return await capturePageSegments(filename, frame, pageCacheKey ?? undefined);
}

/**
 * 页面级缓存键：分享链接 + 页面名 + DOM 文字哈希 + 截图方案版本。
 * Axure 为静态导出，文字不变即可认为页面未变，可复用已有截图；
 * 截图分段逻辑变化时递增 CAPTURE_SCHEME_VERSION，旧缓存（旧分段清单）自动失效。
 */
const CAPTURE_SCHEME_VERSION = 'v2';

function pageCacheKeyOf(
  url: string | undefined,
  pageName: string,
  text: string
): string | null {
  if (!url) return null;
  return createHash('md5')
    .update(`${url}::${pageName}::${text}::${CAPTURE_SCHEME_VERSION}`)
    .digest('hex');
}

/**
 * 在目录树中定位分组：叶子名唯一时可用，歧义时返回候选路径清单。
 */
function resolveGroup(
  outline: OutlineNode[],
  name: string
): TreeMatchResult<OutlineNode> {
  return matchTreeTarget(outline, name, 'group');
}

/**
 * 获取指定分组下所有页面的完整内容（含分组节点自身的内容页）
 *
 * CoDesign 分组节点点击后右侧可能显示自身页面（如挂在分组上的说明页），
 * 也可能只是展开/收起目录。策略：先快速点击分组节点探测 iframe 是否切换，
 * 切换且非空白才把分组自身页计入结果，再遍历子页面。
 *
 * @param groupName - 分组名称（如"活动/流程图"或叶子名）
 * @param url - 分享链接，用于页面级缓存键
 * @param opts.pageNames - 只处理指定页面（叶子名或完整路径），未命中的名字返回合成错误页
 * @param opts.onProgress - 逐页进度回调（MCP 层转发为 progress 通知）
 */
export async function getGroupPages(
  groupName: string,
  url?: string,
  opts?: { pageNames?: string[]; onProgress?: (message: string) => void }
): Promise<CrawledPage[]> {
  const outline = await getPageOutline();
  const located = resolveGroup(outline, groupName);
  if (!located.ok) throw new Error(located.reason);
  const { target } = located;

  const results: CrawledPage[] = [];

  // 1) 分组节点自身内容探测
  if (target.isGroup) {
    opts?.onProgress?.('探测分组自身内容页');
    const before = await extractPageText();
    const selfNav = await navigateToPageByIndex(target.domIndex, { quick: true });
    if (selfNav.ok) {
      const { text, tables, images, sections, blocks, flow } = await extractPageText();
      // URL 未切换但文字变化也算切换（防同 URL 重渲染），空白页（无文字无图）不计入
      const switched = selfNav.frameChanged || text !== before.text;
      if (switched && (text.trim() || images.length > 0)) {
        const screenshotResult = await screenshotPage(
          `${groupName}_分组页`,
          pageCacheKeyOf(url, target.path, text)
        );
        const imageShots = await capturePageContentImages(target.name, images);
        results.push({
          pageName: target.name,
          text,
          tables,
          images,
          imageShots,
          sections,
          blocks,
          flow,
          segments: screenshotResult.segments,
          segmentCount: screenshotResult.segmentCount,
          isSegmented: screenshotResult.isSegmented,
          totalHeight: screenshotResult.totalHeight,
        });
      }
    }
  }

  // 2) 遍历分组下的子页面
  let pages: { name: string; path: string; domIndex: number }[];
  if (!target.isGroup) {
    // 传入的其实是页面名，按单页处理
    pages = [{ name: target.name, path: target.path, domIndex: target.domIndex }];
  } else {
    // domIndex 是原始 DOM 序号（可能含无文字节点），遍历须用大纲数组下标，两者不可混用
    const targetIndex = outline.indexOf(target);
    const groupLevel = target.level;
    pages = [];
    for (let i = targetIndex + 1; i < outline.length; i++) {
      const item = outline[i];
      if (item.level <= groupLevel) break;
      if (!item.isGroup) pages.push({ name: item.name, path: item.path, domIndex: item.domIndex });
    }
  }

  // pageNames 过滤（叶子名或完整路径均可匹配）；未命中的名字收集起来，最后生成合成错误页
  let unmatchedNames: string[] = [];
  let availableNames: string[] = [];
  if (opts?.pageNames?.length) {
    availableNames = pages.map((p) => p.name);
    const wanted = [...new Set(opts.pageNames.map((n) => n.trim()).filter(Boolean))];
    const matchedWanted = new Set<string>();
    pages = pages.filter((p) => {
      const hit = wanted.find((w) => w === p.name || w === p.path);
      if (hit) matchedWanted.add(hit);
      return hit !== undefined;
    });
    unmatchedNames = wanted.filter((w) => !matchedWanted.has(w));
  }

  opts?.onProgress?.(`开始抓取 ${pages.length} 个页面`);
  let done = 0;
  for (const pageInfo of pages) {
    done++;
    opts?.onProgress?.(`抓取页面 ${done}/${pages.length}：${pageInfo.name}`);
    const nav = await navigateToPageByIndex(pageInfo.domIndex);
    if (!nav.ok) {
      results.push({
        pageName: pageInfo.name,
        text: '',
        tables: [],
        images: [],
        segments: [],
        segmentCount: 0,
        isSegmented: false,
        totalHeight: 0,
        error: describeNavigationFailure(nav),
      });
      continue;
    }

    const { text, tables, images, sections, blocks, flow } = await extractPageText();
    const screenshotResult = await screenshotPage(
      `${groupName}_${pageInfo.name}`,
      pageCacheKeyOf(url, pageInfo.name, text)
    );

    const imageShots = await capturePageContentImages(pageInfo.name, images);
    results.push({
      pageName: pageInfo.name,
      text,
      tables,
      images,
      imageShots,
      sections,
      blocks,
      flow,
      segments: screenshotResult.segments,
      segmentCount: screenshotResult.segmentCount,
      isSegmented: screenshotResult.isSegmented,
      totalHeight: screenshotResult.totalHeight,
    });
  }

  // pageNames 里未命中的名字合成错误页返回（附可用页面清单），Agent 据此纠正后重调
  for (const w of unmatchedNames) {
    results.push({
      pageName: w,
      text: '',
      tables: [],
      images: [],
      segments: [],
      segmentCount: 0,
      isSegmented: false,
      totalHeight: 0,
      error: `分组「${groupName}」下未找到页面「${w}」，可用页面：${availableNames.join('、') || '（该分组下没有独立页面）'}`,
    });
  }

  return results;
}

/**
 * 获取单个页面的完整内容
 * @param pageName - 页面叶子名或完整路径（父分组/页面名，用于同名页面消歧）
 * @param url - 分享链接，用于页面级缓存键
 */
export async function getSinglePage(pageName: string, url?: string): Promise<CrawledPage> {
  const outline = await getPageOutline();
  const located = matchTreeTarget(outline, pageName, 'any');
  if (!located.ok) throw new Error(located.reason);

  const nav = await navigateToPageByIndex(located.target.domIndex);
  if (!nav.ok) throw new Error(describeNavigationFailure(nav));

  const { text, tables, images, sections, blocks, flow } = await extractPageText();
  const screenshotResult = await screenshotPage(
    pageName,
    pageCacheKeyOf(url, located.target.path, text)
  );

  const imageShots = await capturePageContentImages(pageName, images);
  return {
    pageName,
    text,
    tables,
    images,
    imageShots,
    sections,
    blocks,
    flow,
    segments: screenshotResult.segments,
    segmentCount: screenshotResult.segmentCount,
    isSegmented: screenshotResult.isSegmented,
    totalHeight: screenshotResult.totalHeight,
  };
}
