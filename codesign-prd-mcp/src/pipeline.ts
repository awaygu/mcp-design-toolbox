/**
 * 解析流水线编排模块
 * 把 crawler 产出的页面数据，经「类型判定 → 缓存查询 → VLM 解析 → 合并」变成结构化结果。
 * MCP 入口与命令行脚本共用同一份实现，避免两处逻辑漂移。
 */
import {
  isVLMConfigured,
  detectPageType,
  getVlmVersion,
  hasParseFailure,
  analyzeSegmentsParallel,
  analyzeSegmentsGlobal,
} from './vlm.js';
import { mergePageResult } from './merger.js';
import { getCache, setCache } from './cache.js';
import type {
  CacheKeyParams,
  CrawledPage,
  ImageAnalysis,
  MergedPage,
  PageType,
  ProcessOptions,
  SegmentTask,
  VlmResult,
} from './types.js';

function pageCacheKey(pageData: CrawledPage, url: string, type: PageType): CacheKeyParams {
  return {
    url,
    pageName: pageData.pageName,
    imagePaths: pageData.segments || [],
    type,
    vlmVersion: getVlmVersion(),
  };
}

// 把内嵌原型图元数据拼进 VLM 参考文字，让模型感知页面中的设计图/插画
function pageTextWithImages(pageData: CrawledPage): string {
  const imgs = pageData.images || [];
  if (!imgs.length) return pageData.text;
  const lines = imgs
    .map((im) => `- ${im.width}x${im.height}${im.alt ? ` alt:${im.alt}` : ''}`)
    .join('\n');
  return `${pageData.text || ''}\n\n[该页面包含 ${imgs.length} 张内嵌原型图]\n${lines}`;
}

function failedResult(pageData: CrawledPage, type: PageType, reason: string): MergedPage {
  return {
    pageName: pageData.pageName,
    type,
    domText: '',
    tables: [],
    images: pageData.images || [],
    vlmResult: {},
    warnings: [reason],
    _segmentCount: 0,
    _hasVLM: false,
  };
}

/**
 * DOM 是否已充分提取（决定该页是否需要整页分段 VLM）。
 * 表格（.table_cell 网格）、规则文字（控件块）、流程拓扑（连接线几何）都是
 * 确定性结果，已在文档中作为真源优先渲染；对这类页面再送整页分段，
 * VLM 产出只会在合并时被判重丢弃或成为噪音（实测 16 段解析产出 9 张
 * 截断/重复表格），因此跳过。判「不充分」的方向是安全的：多花几次 VLM，
 * 而不是丢内容。
 */
function domIsRich(page: CrawledPage): boolean {
  return (
    !!page.blocks?.length ||
    !!page.tables?.length ||
    (page.text || '').trim().length >= 50
  );
}

/**
 * 该页是否需要整页分段 VLM。内嵌图解析不受此判定影响，始终独立排队。
 * 流程图页 DOM 拓扑还原失败（flow 为空）时，截图是节点/连线的唯一来源，仍需分段。
 */
function needsSegmentVlm(page: CrawledPage, type: PageType): boolean {
  return !domIsRich(page) || (type === 'flowchart' && !page.flow);
}

function finalize(
  pageData: CrawledPage,
  type: PageType,
  vlmSegments: VlmResult[],
  imageResults: VlmResult[] = []
): MergedPage {
  const imageAnalysis = imageResults.length
    ? toImageAnalysis(pageData, imageResults)
    : undefined;
  return mergePageResult({
    pageName: pageData.pageName,
    domText: pageData.text || '',
    domTables: pageData.tables || [],
    images: pageData.images || [],
    imageAnalysis,
    sections: pageData.sections,
    blocks: pageData.blocks,
    flow: pageData.flow ?? null,
    vlmSegments,
    type,
    screenshotCount: pageData.segmentCount || 0,
  });
}

/**
 * 内嵌图解析任务：每个内容图一个任务，type='image'（专用 prompt，只提取图内文字）。
 * 与整页分段分开排队，结果也单独收集——不能混进 vlmSegments，否则会被当成页面结构处理。
 * （段级缓存改造后由调用方内联构造任务；此说明保留以记录两类任务不混排的设计约束。）
 */

/** 把图片解析结果归并成结构化产物；全占位且无文字的图不输出，避免噪音 */
function toImageAnalysis(pageData: CrawledPage, results: VlmResult[]): ImageAnalysis[] {
  const shots = (pageData.imageShots || []).filter((im) => im.localPath);
  return shots
    .map((im, i) => {
      const r = results[i] || {};
      return {
        src: im.src,
        localPath: im.localPath as string,
        summary: r.summary || '',
        texts: r.texts || [],
        isPlaceholder: r.is_placeholder === true,
        note: r.note || '',
        // _parseError 是布尔标记，必须显式转成文案：否则该图会变成
        // 「summary/texts/error 全空」被下面的 filter 静默丢掉，
        // 文档看上去已覆盖全部内嵌图，实际漏掉的可能正是关键规则图
        error: r._error || (r._parseError ? 'VLM 返回内容无法解析为结构化结果' : undefined),
      };
    })
    .filter((a) => a.texts.length > 0 || a.summary || a.error);
}

/**
 * 段级缓存解析：命中的段直接复用，只把缺失的段提交 VLM。
 * 每段完成立即落盘（onTaskDone）——长分组跑一半超时/中断后，
 * 重跑只需补缺失的段，而不是整页/整组从头再来。
 * @returns 与 paths 等长、按原顺序对齐的解析结果
 */
async function analyzeSegmentsResumable(
  url: string,
  pageName: string,
  paths: string[],
  type: PageType,
  opts: {
    pageText?: string;
    context?: string;
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<VlmResult[]> {
  const segKey = (p: string): CacheKeyParams => ({
    url,
    pageName,
    imagePaths: [p],
    type,
    vlmVersion: getVlmVersion(),
  });
  const filled: (VlmResult | null)[] = paths.map((p) => {
    const c = getCache(segKey(p));
    return c && c.length === 1 && !hasParseFailure(c) ? c[0] : null;
  });
  const missingIdx = paths.map((_p, i) => i).filter((i) => filled[i] === null);
  if (!missingIdx.length) return filled as VlmResult[];

  const results = await analyzeSegmentsParallel(
    missingIdx.map((i) => paths[i]),
    type,
    {
      pageText: opts.pageText,
      context: opts.context,
      onProgress: opts.onProgress,
      onTaskDone: (idx, r) => {
        const origIdx = missingIdx[idx];
        filled[origIdx] = r;
        // 失败的段不落盘（重试才有机会变好），与整页缓存的写入纪律一致
        if (!hasParseFailure([r])) setCache(segKey(paths[origIdx]), [r]);
      },
    }
  );
  // onTaskDone 已填成功的段；这里兜底填失败段（含 _error），保证返回数组无空洞
  missingIdx.forEach((origIdx, j) => {
    if (filled[origIdx] === null) filled[origIdx] = results[j];
  });
  return filled as VlmResult[];
}

/**
 * 处理单个页面
 * @param pageData - crawler 产出的页面数据
 * @param url - 分享链接
 * @param options - { vlmEnabled, onProgress }
 */
export async function processPage(
  pageData: CrawledPage,
  url: string,
  {
    vlmEnabled = true,
    context,
    onProgress,
  }: {
    vlmEnabled?: boolean;
    context?: string;
    /** VLM 解析进度（分段/内嵌图两个粒度），MCP 层转发为 progress 通知 */
    onProgress?: (message: string) => void;
  } = {}
): Promise<MergedPage> {
  if (pageData.error) return failedResult(pageData, 'page', pageData.error);

  const type = detectPageType(pageData.pageName, pageData.text);
  let vlmSegments: VlmResult[] = [];
  let imageResults: VlmResult[] = [];

  if (vlmEnabled && isVLMConfigured()) {
    if (needsSegmentVlm(pageData, type) && pageData.segments?.length > 0) {
      const key = pageCacheKey(pageData, url, type);
      const cached = getCache(key);
      if (cached) {
        vlmSegments = cached;
      } else {
        vlmSegments = await analyzeSegmentsResumable(url, pageData.pageName, pageData.segments, type, {
          pageText: pageData.text,
          context,
          onProgress: (done, total) => onProgress?.(`解析分段 ${done}/${total}`),
        });
        if (!hasParseFailure(vlmSegments)) setCache(key, vlmSegments);
      }
    }
    // 内嵌图定向解析：只对内容图排队，与整页分段互不干扰。
    // 同样独立缓存——与页面分段命中与否无关，否则重复调用会反复烧 VLM 额度
    const imgPaths = (pageData.imageShots || [])
      .map((im) => im.localPath)
      .filter((p): p is string => !!p);
    const imageKey: CacheKeyParams | undefined = imgPaths.length
      ? { url, pageName: pageData.pageName, imagePaths: imgPaths, type: 'image', vlmVersion: getVlmVersion() }
      : undefined;
    const imageCached = imageKey ? getCache(imageKey) : null;
    if (imageCached) {
      imageResults = imageCached;
    } else if (imgPaths.length) {
      imageResults = await analyzeSegmentsResumable(url, pageData.pageName, imgPaths, 'image', {
        context,
        onProgress: (done, total) => onProgress?.(`解析内嵌图 ${done}/${total}`),
      });
      if (!hasParseFailure(imageResults) && imageKey) setCache(imageKey, imageResults);
    }
  }

  return finalize(pageData, type, vlmSegments, imageResults);
}

/** 批量处理时的中间态：记录每页的类型、缓存键与分段在全局队列中的区间 */
interface PreparedPage {
  pageData: CrawledPage;
  type: PageType;
  context?: string;
  key?: CacheKeyParams;
  cached?: VlmResult[] | null;
  failed?: boolean;
  /** 跳过 VLM（未启用/未配置）：必须显式标记，否则下面摊平任务时会把它当成待解析页 */
  skipVlm?: boolean;
  /** 策略性跳过整页分段（DOM 已充分，非失败），供 onPageDone 标注 */
  segSkipped?: boolean;
  vlmSegments: VlmResult[] | null;
  taskStart?: number;
  taskEnd?: number;
  /** 段级缓存：与 pageData.segments 对齐；命中的段预填，待解析段为 null */
  segFilled?: (VlmResult | null)[];
  /** 待解析段在 pageData.segments 中的下标（全局队列只排这些） */
  queuedSegIdx?: number[];
  /** 内嵌图任务在全局队列中的区间（与页面分段分开记录，结果不混用） */
  imageTaskStart?: number;
  imageTaskEnd?: number;
  imageResults?: VlmResult[];
  /** 内嵌图段级缓存：与 imageShots（有 localPath 的）对齐 */
  imgFilled?: (VlmResult | null)[];
  queuedImgIdx?: number[];
  /** 内嵌图独立缓存键（与页面分段缓存分开，见下方 processPages 说明） */
  imageKey?: CacheKeyParams;
}

/** 段级缓存查询：单段命中且未失败时返回结果，否则 null */
function segCacheHit(url: string, pageName: string, path: string, type: PageType): VlmResult | null {
  const c = getCache({ url, pageName, imagePaths: [path], type, vlmVersion: getVlmVersion() });
  return c && c.length === 1 && !hasParseFailure(c) ? c[0] : null;
}

/**
 * 批量处理分组下的所有页面
 *
 * 先统一查缓存，再把所有未命中的分段摊平成一个全局队列并发提交，
 * 避免「页内并发、页间串行」在每页末尾浪费并发度。
 */
export async function processPages(
  pagesData: CrawledPage[],
  url: string,
  options: ProcessOptions = {}
): Promise<MergedPage[]> {
  const { vlmEnabled = true, concurrency, onPageDone, onProgress, contextFor } = options;

  const prepared: PreparedPage[] = pagesData.map((pageData) => {
    if (pageData.error) return { pageData, type: 'page', failed: true, vlmSegments: [] };

    const type = detectPageType(pageData.pageName, pageData.text);
    if (!vlmEnabled || !isVLMConfigured()) {
      return { pageData, type, vlmSegments: [], skipVlm: true };
    }

    // DOM 已充分提取的页跳过整页分段（内嵌图不受影响，依旧排队）。
    // 跳过分段是策略而非失败——文档走 DOM 确定性内容，附录标注「VLM 策略跳过」
    const runSegments = needsSegmentVlm(pageData, type);

    // 内嵌图与页面分段是两套独立缓存：页面缓存只存 vlmSegments，
    // 若让「页面缓存命中」连带跳过内嵌图任务，第二次跑就会静默丢掉「内嵌图文字」
    // （实测：首次跑有 20 张图与 3 条数值冲突，缓存命中后再跑全部消失）。
    const imgPaths = (pageData.imageShots || [])
      .map((im) => im.localPath)
      .filter((p): p is string => !!p);
    const imageKey: CacheKeyParams | undefined = imgPaths.length
      ? { url, pageName: pageData.pageName, imagePaths: imgPaths, type: 'image', vlmVersion: getVlmVersion() }
      : undefined;
    const imageCached = imageKey ? getCache(imageKey) : null;

    // 分段缓存只在真的要跑分段时才查；auto 跳过的页 vlmSegments 留空，文档走纯 DOM 内容
    const key =
      runSegments && pageData.segments?.length ? pageCacheKey(pageData, url, type) : undefined;
    const cached = key ? getCache(key) : null;

    // 段级缓存：整页未命中时按段查，全局队列只排缺失的段——
    // 长分组超时中断后，已完成段落盘过，重跑只补缺口
    let vlmSegments = cached || null;
    let segFilled: (VlmResult | null)[] | undefined;
    let queuedSegIdx: number[] | undefined;
    let allSegsCached = false;
    if (key && !cached) {
      segFilled = pageData.segments.map((p) => segCacheHit(url, pageData.pageName, p, type));
      queuedSegIdx = pageData.segments.map((_p, i) => i).filter((i) => segFilled![i] === null);
      if (!queuedSegIdx.length) {
        vlmSegments = segFilled as VlmResult[];
        allSegsCached = true;
      }
    }

    // 内嵌图同理按张查缓存
    let imgFilled: (VlmResult | null)[] | undefined;
    let queuedImgIdx: number[] | undefined;
    let imageResults = imageCached || undefined;
    if (imageKey && !imageCached) {
      imgFilled = imgPaths.map((p) => segCacheHit(url, pageData.pageName, p, 'image'));
      queuedImgIdx = imgPaths.map((_p, i) => i).filter((i) => imgFilled![i] === null);
      if (!queuedImgIdx.length) imageResults = imgFilled as VlmResult[];
    }

    return {
      pageData,
      type,
      context: contextFor?.(pageData),
      key,
      cached: cached || (allSegsCached ? vlmSegments : null),
      vlmSegments,
      segSkipped: !runSegments,
      segFilled,
      queuedSegIdx,
      imageKey,
      imageResults,
      imgFilled,
      queuedImgIdx,
    };
  });

  const tasks: SegmentTask[] = [];
  /** 与 tasks 对齐：onTaskDone 用它定位「哪个页的哪张图」并即时落盘 */
  const taskMeta: Array<{ item: PreparedPage; kind: 'seg' | 'img'; path: string }> = [];
  prepared.forEach((item) => {
    if (item.skipVlm || item.failed) return;

    // 内嵌图单独排队：即使该页没有分段截图（如表格页），内容图依然值得解析。
    // 是否排队只取决于图自己的缓存，与页面分段缓存无关。
    if (item.queuedImgIdx?.length) {
      const shots = (item.pageData.imageShots || []).filter((im) => im.localPath);
      item.imageTaskStart = tasks.length;
      item.queuedImgIdx.forEach((origIdx) => {
        const p = shots[origIdx].localPath as string;
        taskMeta.push({ item, kind: 'img', path: p });
        tasks.push({
          imagePath: p,
          type: 'image',
          segmentIndex: origIdx + 1,
          totalSegments: shots.length,
          context: item.context,
        });
      });
      item.imageTaskEnd = tasks.length;
    }

    if (item.cached) return; // 整页缓存或全段缓存命中，不再排段
    if (item.queuedSegIdx?.length) {
      const segments = item.pageData.segments!;
      item.taskStart = tasks.length;
      item.queuedSegIdx.forEach((origIdx) => {
        const p = segments[origIdx];
        taskMeta.push({ item, kind: 'seg', path: p });
        tasks.push({
          imagePath: p,
          type: item.type,
          segmentIndex: origIdx + 1,
          totalSegments: segments.length,
          pageText: pageTextWithImages(item.pageData),
          context: item.context,
        });
      });
      item.taskEnd = tasks.length;
    }
  });

  if (tasks.length > 0) {
    const results = await analyzeSegmentsGlobal(tasks, {
      concurrency,
      onProgress: (done, total) => onProgress?.(`VLM 解析分段 ${done}/${total}`),
      // 每段完成立即落盘：客户端超时放弃后，server 继续跑完的部分也不会白费
      onTaskDone: (idx, r) => {
        const meta = taskMeta[idx];
        if (!meta || hasParseFailure([r])) return;
        setCache(
          {
            url,
            pageName: meta.item.pageData.pageName,
            imagePaths: [meta.path],
            type: meta.kind === 'img' ? 'image' : meta.item.type,
            vlmVersion: getVlmVersion(),
          },
          [r]
        );
      },
    });
    prepared.forEach((item) => {
      if (item.taskStart !== undefined && item.taskEnd !== undefined) {
        const queuedResults = results.slice(item.taskStart, item.taskEnd);
        item.queuedSegIdx!.forEach((origIdx, j) => {
          item.segFilled![origIdx] = queuedResults[j];
        });
        item.vlmSegments = item.segFilled as VlmResult[];
        // 失败的段落不写缓存，否则一次网络抖动会被固化，后续重试永远拿不到正确结果
        if (!hasParseFailure(item.vlmSegments) && item.key) setCache(item.key, item.vlmSegments);
      }
      if (item.imageTaskStart !== undefined && item.imageTaskEnd !== undefined) {
        const queuedResults = results.slice(item.imageTaskStart, item.imageTaskEnd);
        item.queuedImgIdx!.forEach((origIdx, j) => {
          item.imgFilled![origIdx] = queuedResults[j];
        });
        item.imageResults = item.imgFilled as VlmResult[];
        // 失败的图不写缓存，否则一次网络抖动会被固化，后续重试永远拿不到正确结果
        if (!hasParseFailure(item.imageResults) && item.imageKey) {
          setCache(item.imageKey, item.imageResults);
        }
      }
    });
  }

  return prepared.map((item) => {
    const result = item.failed
      ? failedResult(item.pageData, item.type, item.pageData.error ?? '页面爬取失败')
      : finalize(item.pageData, item.type, item.vlmSegments || [], item.imageResults || []);

    onPageDone?.(item.pageData.pageName, {
      cached: !!item.cached,
      segments: result._segmentCount || 0,
      vlmSkipped: item.skipVlm === true || !!item.segSkipped,
      result,
    });
    return result;
  });
}
