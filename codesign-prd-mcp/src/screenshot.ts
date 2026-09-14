/**
 * 分段截图模块
 * 负责对超大页面进行网格分段滚动截图（垂直 × 水平），避免单张截图截不全
 *
 * 策略：
 * - 页面完全在视口内（高宽均不超出）：单张截图
 * - 否则按轴拆分滚动位置序列，网格组合逐段截图，段间重叠 100px
 * - 每轴最后一个位置强制贴边，避免最后一段被 clamp 与前段重复
 * - 截图前收集叶子元素矩形，空白网格直接跳过（省段数，也消除空白画面重复）
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { Frame } from 'playwright';
import { getPage } from './browser.js';
import { safeName, sleep } from './utils.js';
import type { PageImage, ScreenshotResult } from './types.js';

const SCREENSHOT_DIR = path.join(process.cwd(), '.codesign-mcp', 'screenshots');
const PAGE_CACHE_DIR = path.join(process.cwd(), '.codesign-mcp', 'pagecache');

// 分段截图参数
const VIEWPORT_HEIGHT = 1080;
const OVERLAP = 100; // 段间重叠像素
const RENDER_WAIT = 500; // 滚动后等待渲染时间 ms
const MAX_SEGMENTS = 60; // 网格分段总数上限（宽流程图可达 7行×4列=28 段）

/** 滚动容器的元信息 */
interface ScrollInfo {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  scrollWidth: number;
  scrollLeft: number;
  clientWidth: number;
}

/** iframe 内叶子元素的矩形（视口坐标） */
interface ContentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 网格规划入参 */
interface GridPlan {
  yPoints: number[];
  xPoints: number[];
  viewW: number;
  viewH: number;
  contentW: number;
  contentH: number;
}

/**
 * 确保截图目录存在
 */
function ensureScreenshotDir(): void {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

/**
 * 检测 iframe 内的滚动容器
 * @returns 滚动容器的 selector（用于 evaluate），'window' 表示整页滚动
 */
async function detectScrollContainer(frame: Frame): Promise<string> {
  return await frame.evaluate(() => {
    // 优先检测 body 是否可滚动
    const bodyScrollable = document.body.scrollHeight > window.innerHeight + 50;
    if (bodyScrollable) {
      return 'window';
    }
    // 检测内部可滚动 div
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      const style = window.getComputedStyle(div);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        div.scrollHeight > div.clientHeight + 50
      ) {
        // 找到第一个可滚动的 div，用 class 或 id 标识
        const identifier = div.id
          ? `#${div.id}`
          : div.className
            ? `.${div.className.split(' ')[0]}`
            : null;
        if (identifier) return identifier;
      }
    }
    return 'window'; // 默认 window
  });
}

/**
 * 获取滚动容器的总尺寸和当前滚动位置
 */
async function getScrollInfo(
  frame: Frame,
  containerSelector: string
): Promise<ScrollInfo> {
  return await frame.evaluate((selector) => {
    if (selector === 'window') {
      return {
        scrollHeight: Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        ),
        scrollTop: window.scrollY || window.pageYOffset || 0,
        clientHeight: window.innerHeight,
        scrollWidth: Math.max(
          document.body.scrollWidth,
          document.documentElement.scrollWidth
        ),
        scrollLeft: window.scrollX || window.pageXOffset || 0,
        clientWidth: window.innerWidth,
      };
    }
    const el = document.querySelector(selector);
    if (!el) {
      return {
        scrollHeight: 0,
        scrollTop: 0,
        clientHeight: 0,
        scrollWidth: 0,
        scrollLeft: 0,
        clientWidth: 0,
      };
    }
    return {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
    };
  }, containerSelector);
}

/**
 * 滚动到指定位置
 */
async function scrollTo(
  frame: Frame,
  containerSelector: string,
  pos: { x: number; y: number }
): Promise<void> {
  await frame.evaluate(
    ({ selector, x, y }) => {
      if (selector === 'window') {
        window.scrollTo(x, y);
      } else {
        const el = document.querySelector(selector);
        if (el) {
          el.scrollTop = y;
          el.scrollLeft = x;
        }
      }
    },
    { selector: containerSelector, x: pos.x, y: pos.y }
  );
}

/**
 * 截取 iframe 当前可见区域
 * @returns 是否成功
 */
async function captureIframeVisible(filepath: string): Promise<boolean> {
  const page = getPage();
  if (!page) return false;

  const iframeEl = await page.$('.axure-container iframe');
  if (!iframeEl) return false;

  const box = await iframeEl.boundingBox();
  if (!box || box.width < 10 || box.height < 10) return false;

  try {
    await page.screenshot({
      path: filepath,
      clip: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      animations: 'disabled',
    });
    return true;
  } catch (err) {
    console.error('分段截图失败:', (err as Error).message);
    return false;
  }
}

/**
 * 读取页面级缓存（跳过重复截图）
 * 键 = md5(url + 页面名 + DOM 文字哈希)，值 = 分段截图结果
 */
function readPageCache(key: string): ScreenshotResult | null {
  try {
    const file = path.join(PAGE_CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as ScreenshotResult;
    // 截图文件可能被手动清理，缺任何一个都视为失效
    if (!data.segments?.length || !data.segments.every((p) => fs.existsSync(p))) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function writePageCache(key: string, result: ScreenshotResult): void {
  try {
    if (!fs.existsSync(PAGE_CACHE_DIR)) {
      fs.mkdirSync(PAGE_CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(
      path.join(PAGE_CACHE_DIR, `${key}.json`),
      JSON.stringify(result),
      'utf-8'
    );
  } catch (err) {
    console.warn('写入页面缓存失败:', (err as Error).message);
  }
}

/**
 * 分段截取当前页面（Axure iframe 内容）
 * @param filename - 基础文件名（不含扩展名）
 * @param frame - Axure iframe
 * @param pageCacheKey - 页面级缓存键，命中且截图文件齐全时直接复用
 */
export async function capturePageSegments(
  filename: string,
  frame: Frame | null,
  pageCacheKey?: string
): Promise<ScreenshotResult> {
  if (pageCacheKey) {
    const cached = readPageCache(pageCacheKey);
    if (cached) return cached;
  }

  ensureScreenshotDir();
  const finish = (result: ScreenshotResult): ScreenshotResult => {
    if (pageCacheKey && result.segments.length) writePageCache(pageCacheKey, result);
    return result;
  };

  // 文件名加当前页面 URL 哈希前缀：避免不同分享链接的同名页面覆盖彼此的截图
  const pageUrl = getPage()?.url() || '';
  const urlKey = pageUrl
    ? createHash('md5').update(pageUrl).digest('hex').slice(0, 8)
    : 'nolink';
  const baseName = `${urlKey}_${safeName(filename)}`;

  if (!frame) {
    // 没有 iframe，降级为单张全页截图
    const page = getPage();
    const filepath = path.join(SCREENSHOT_DIR, `${baseName}.png`);
    if (page) {
      await page.screenshot({ path: filepath, fullPage: true, animations: 'disabled' });
    }
    return finish({ segments: [filepath], totalHeight: 0, segmentCount: 1, isSegmented: false });
  }

  // 检测滚动容器
  const containerSelector = await detectScrollContainer(frame);

  // 获取滚动信息
  const scrollInfo = await getScrollInfo(frame, containerSelector);
  const { scrollHeight, clientHeight, scrollWidth, clientWidth } = scrollInfo;

  // 内容完全在视口内才单张截图；否则任何一轴超出都会截不全
  if (scrollHeight <= clientHeight && scrollWidth <= clientWidth) {
    const filepath = path.join(SCREENSHOT_DIR, `${baseName}.png`);
    // 滚动到顶部
    await scrollTo(frame, containerSelector, { x: 0, y: 0 });
    await sleep(RENDER_WAIT);
    const ok = await captureIframeVisible(filepath);
    if (!ok) {
      // 降级：全页截图
      const page = getPage();
      if (page) {
        await page.screenshot({ path: filepath, fullPage: true, animations: 'disabled' });
      }
    }
    return finish({
      segments: [filepath],
      totalHeight: scrollHeight,
      segmentCount: 1,
      isSegmented: false,
    });
  }

  // 网格分段：每轴生成滚动位置序列（步进+末点贴边），双轴组合逐段截图
  const segmentHeight = clientHeight > 0 ? clientHeight : VIEWPORT_HEIGHT;
  const segmentWidth = clientWidth > 0 ? clientWidth : VIEWPORT_HEIGHT;
  const yPoints = scrollPoints(scrollHeight, segmentHeight);
  const xPoints = scrollPoints(scrollWidth, segmentWidth);

  // 回到原点后收集叶子元素矩形（视口坐标即内容坐标），用于跳过空白网格
  await scrollTo(frame, containerSelector, { x: 0, y: 0 });
  await sleep(RENDER_WAIT);
  const contentRects = await collectContentRects(frame);
  const neededCells = planNeededCells(contentRects, {
    yPoints,
    xPoints,
    viewW: segmentWidth,
    viewH: segmentHeight,
    contentW: scrollWidth,
    contentH: scrollHeight,
  });

  const segments: string[] = [];
  let segmentIndex = 0;
  let truncated = false;

  for (let yi = 0; yi < yPoints.length; yi++) {
    for (let xi = 0; xi < xPoints.length; xi++) {
      if (segmentIndex >= MAX_SEGMENTS) {
        truncated = true;
        break;
      }
      // 空白格跳过：既减少段数，也消除「空白画面重复」的段
      if (neededCells && !neededCells.has(yi * xPoints.length + xi)) continue;
      await scrollTo(frame, containerSelector, { x: xPoints[xi], y: yPoints[yi] });
      await sleep(RENDER_WAIT);

      const segFilepath = path.join(
        SCREENSHOT_DIR,
        `${baseName}_part${String(segmentIndex + 1).padStart(2, '0')}.png`
      );
      const ok = await captureIframeVisible(segFilepath);
      if (ok) {
        segments.push(segFilepath);
      } else {
        console.warn(`分段 ${segmentIndex + 1} 截图失败，跳过`);
      }
      segmentIndex++;
    }
    if (truncated) break;
  }

  if (truncated) {
    console.warn(
      `页面 ${baseName} 过大（${scrollWidth}x${scrollHeight}），达到 ${MAX_SEGMENTS} 段上限，仅截取部分区域`
    );
  }

  // 滚动回顶部
  await scrollTo(frame, containerSelector, { x: 0, y: 0 });

  return finish({
    segments,
    totalHeight: scrollHeight,
    segmentCount: segments.length,
    isSegmented: segments.length > 1,
  });
}

/**
 * 单轴滚动位置序列：0 开始按步长推进，末点强制贴边。
 * 末点贴边可避免最后一段被浏览器 clamp 到同一位置、截出重复画面。
 * @param contentSize - 内容总尺寸（scrollHeight/scrollWidth）
 * @param viewSize - 视口尺寸（clientHeight/clientWidth）
 */
function scrollPoints(contentSize: number, viewSize: number): number[] {
  const maxScroll = Math.max(contentSize - viewSize, 0);
  const step = Math.max(viewSize - OVERLAP, 100);
  const points: number[] = [];
  for (let p = 0; p < maxScroll; p += step) points.push(p);
  points.push(maxScroll);
  return points;
}

/**
 * 收集 iframe 内叶子元素的矩形（需先滚动到原点，视口坐标即内容坐标）。
 * 只统计叶子节点：容器盒子（如 #base）会铺满整页，会把所有格子判成非空。
 */
async function collectContentRects(frame: Frame): Promise<ContentRect[]> {
  try {
    return await frame.evaluate(() => {
      const rects: { x: number; y: number; w: number; h: number }[] = [];
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length > 0) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
        if (rects.length >= 5000) break;
      }
      return rects;
    });
  } catch {
    return [];
  }
}

/**
 * 计算需要截取的网格单元集合（key = 行下标*列数+列下标）。
 * 叶子矩形与格子相交即保留；无矩形信息时返回 null（全量截取，宁多勿缺）。
 */
function planNeededCells(rects: ContentRect[], plan: GridPlan): Set<number> | null {
  const { yPoints, xPoints, viewW, viewH, contentW, contentH } = plan;
  if (!rects.length) return null;
  const needed = new Set<number>();
  for (const r of rects) {
    const rx0 = r.x;
    const ry0 = r.y;
    const rx1 = r.x + r.w;
    const ry1 = r.y + r.h;
    for (let yi = 0; yi < yPoints.length; yi++) {
      const cy0 = yPoints[yi];
      const cy1 = Math.min(cy0 + viewH, contentH);
      if (ry1 <= cy0 || ry0 >= cy1) continue;
      for (let xi = 0; xi < xPoints.length; xi++) {
        const cx0 = xPoints[xi];
        const cx1 = Math.min(cx0 + viewW, contentW);
        if (rx1 <= cx0 || rx0 >= cx1) continue;
        needed.add(yi * xPoints.length + xi);
      }
    }
  }
  return needed;
}

/**
 * 单张截图（兼容旧接口，内部调用分段截图）
 * @returns 第一张截图的路径
 */
export async function captureSinglePage(filename: string, frame?: Frame): Promise<string> {
  const result = await capturePageSegments(filename, frame ?? null);
  return result.segments[0] || '';
}

/** 单页内嵌图定向截图上限：画布型页面可能有几十张，全截会拖慢并重复烧 token */
const MAX_CONTENT_IMAGES = 20;

/**
 * 对页面内的「内容图」逐个定向截图。
 *
 * 与整页分段截图的区别：
 * - 画面只含这一张图 → 识别更准，且同一张图不会在多个分段里被重复解析
 * - 已过滤连接线段（*_segN.svg）与图标级小图（见 axure-dom 的 isContent 判定）
 * 截图失败（元素被遮挡/不可见）的图直接跳过，不影响主流程。
 *
 * @returns 填充了 localPath 的图列表
 */
export async function captureContentImageShots(
  frame: Frame | null,
  pageName: string,
  images: PageImage[]
): Promise<PageImage[]> {
  if (!frame) return [];
  const targets = images.filter((im) => im.isContent && im.imgIndex !== undefined);
  if (!targets.length) return [];

  const dir = path.join(SCREENSHOT_DIR, `${safeName(pageName)}_imgs`);
  fs.mkdirSync(dir, { recursive: true });

  const out: PageImage[] = [];
  for (const [i, im] of targets.entries()) {
    if (out.length >= MAX_CONTENT_IMAGES) break;
    const file = path.join(dir, `img${i + 1}.png`);
    try {
      await frame
        .locator('img')
        .nth(im.imgIndex as number)
        .screenshot({ path: file, animations: 'disabled', timeout: 15000 });
      out.push({ ...im, localPath: file });
    } catch {
      // 元素不可见/被遮挡/索引失效时跳过单张，不影响其余
    }
  }
  return out;
}
