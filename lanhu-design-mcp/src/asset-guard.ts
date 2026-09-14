// asset-guard.ts — 切图资源下载安全层（移植自 lanhu-mcp(Python) 的三件套）：
//   ① buildScaleUrls：蓝湖只存一份原图（存储尺寸 = 设计尺寸 × 4），其余倍率拼
//      x-oss-process 参数让阿里云 OSS 在线出图，零存储成本拿 1x/2x/3x/iOS/Android
//   ② inspectAsset：下载后字节级验真——HTML 伪装检测、SVG 主动内容扫描、真实格式/尺寸
//   ③ fetchAssetBytes：host 白名单 + 手动重定向逐跳校验 + 流式大小上限 + 瞬态重试
import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';

const MAX_ASSET_BYTES = 64 * 1024 * 1024; // 单文件 64MiB 硬上限
const MAX_REDIRECTS = 5;
const FETCH_ATTEMPTS = 3;                 // 瞬态错误（网络/429/5xx）最大尝试次数

// 资源主机白名单：蓝湖主站及子域 + 阿里云 OSS（蓝湖切图/标注数据的实际存储方）。
// 需要私有 CDN 时用 LANHU_ALLOWED_ASSET_HOSTS="a.com,b.com" 追加，不放宽默认。
const ASSET_HOST_SUFFIXES = ['lanhuapp.com', 'aliyuncs.com'];

// sharp 能解码且可作为切图落盘的位图格式
const RASTER_FORMATS = new Set(['png', 'jpeg', 'jpg', 'webp', 'gif', 'avif', 'tiff', 'ico']);

/** 带错误码的资源异常：调用方据此决定重试/记失败/报错 */
export class AssetGuardError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AssetGuardError';
  }
}

/** host 是否在资源白名单内（含 LANHU_ALLOWED_ASSET_HOSTS 扩展） */
export function isAllowedAssetHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const extras = (process.env.LANHU_ALLOWED_ASSET_HOSTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const suffix of [...ASSET_HOST_SUFFIXES, ...extras]) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

// 仅 lanhuapp.com 携带 Cookie（凭据不出蓝湖域）；OSS/CDN 只带 Referer
function headersFor(url: string, cookie?: string): Record<string, string> {
  const isLanhu = new URL(url).hostname.endsWith('lanhuapp.com');
  const headers: Record<string, string> = {
    Referer: 'https://lanhuapp.com/',
    'User-Agent': 'lanhu-design-mcp/1',
  };
  if (isLanhu && cookie) headers.Cookie = cookie;
  return headers;
}

export interface FetchAssetResult {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;      // 跟踪重定向后的最终地址（诊断用）
}

/**
 * 受控下载：白名单校验 → 手动重定向（逐跳重新校验）→ 流式读取带大小上限。
 * 瞬态错误（网络异常/429/5xx）自动重试，安全类错误（白名单/https/超限）立即抛出。
 */
export async function fetchAssetBytes(url: string, opts: { cookie?: string } = {}): Promise<FetchAssetResult> {
  let lastError: AssetGuardError | undefined;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchAssetOnce(url, opts);
    } catch (err) {
      const e = err instanceof AssetGuardError ? err : new AssetGuardError('download_failed', String(err));
      // 仅瞬态错误重试；安全/协议类错误重试没有意义
      const retryable = e.code === 'network_error' || e.code === 'http_429' || /^http_5/.test(e.code);
      lastError = e;
      if (!retryable || attempt >= FETCH_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
  throw lastError!;
}

async function fetchAssetOnce(url: string, opts: { cookie?: string }): Promise<FetchAssetResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current);
    // 手动重定向的意义：每一跳都重新过白名单，防 OSS 302 把请求带去任意域名
    if (parsed.protocol !== 'https:') {
      throw new AssetGuardError('insecure_url', `切图资源必须走 https：${current}`);
    }
    if (parsed.username || parsed.password) {
      throw new AssetGuardError('credentials_in_url', `资源 URL 携带凭据，已拒绝：${parsed.hostname}`);
    }
    if (!isAllowedAssetHost(parsed.hostname)) {
      throw new AssetGuardError('host_not_allowed', `资源主机不在白名单内：${parsed.hostname}`);
    }

    let res: Response;
    try {
      res = await fetch(current, { headers: headersFor(current, opts.cookie), redirect: 'manual' });
    } catch (e: any) {
      throw new AssetGuardError('network_error', `请求失败：${e?.message || e}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new AssetGuardError('redirect_no_location', `重定向缺少 Location（HTTP ${res.status}）`);
      current = new URL(location, current).toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new AssetGuardError('access_denied', `资源被拒绝（HTTP ${res.status}）：登录态或项目权限不足`);
    }
    if (res.status === 429 || res.status >= 500) {
      throw new AssetGuardError(`http_${res.status}`, `资源端暂不可用（HTTP ${res.status}）`);
    }
    if (!res.ok) {
      throw new AssetGuardError(`http_${res.status}`, `资源请求失败（HTTP ${res.status}）`);
    }

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_ASSET_BYTES) {
      throw new AssetGuardError('too_large', `资源超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MiB 上限`);
    }
    // 流式读取并强制上限：content-length 缺失（chunked）时这是唯一的拦截点
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new AssetGuardError('network_error', '响应无可读正文');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel();
        throw new AssetGuardError('too_large', `资源超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MiB 上限`);
      }
      chunks.push(Buffer.from(value));
    }
    return { bytes: Buffer.concat(chunks), contentType: res.headers.get('content-type') || '', finalUrl: current };
  }
  throw new AssetGuardError('too_many_redirects', `重定向超过 ${MAX_REDIRECTS} 次`);
}

// ─── 字节级验真 ─────────────────────────────────────────────────

export interface AssetMeta {
  format: string;          // 验证出的真实格式（png/jpeg/svg/…）
  width?: number;          // 实际像素尺寸（SVG 为解析出的内在尺寸）
  height?: number;
  isVector: boolean;
  sha256: string;
  bytes: number;
}

/**
 * 下载字节的验真入口：来源声明（URL/响应头）只是声明，只有解码才算数。
 * 抛 AssetGuardError 的资源不允许落盘。
 */
export async function inspectAsset(data: Buffer): Promise<AssetMeta> {
  if (!data || data.length === 0) throw new AssetGuardError('empty_asset', '切图内容为空');
  if (data.length > MAX_ASSET_BYTES) throw new AssetGuardError('too_large', `切图超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)}MiB 上限`);

  // HTML 伪装：网关/失效链接常返回 200 + 网页，必须拦在写盘之前
  const head = data.subarray(0, 1024).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    throw new AssetGuardError('html_response', '服务器返回了网页而非图片');
  }

  const sha256 = createHash('sha256').update(data).digest('hex');
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--') || head.charCodeAt(0) === 0xfeff) {
    return { ...inspectSvg(data), sha256, bytes: data.length };
  }
  return { ...await inspectRaster(data), sha256, bytes: data.length };
}

async function inspectRaster(data: Buffer): Promise<{ format: string; width?: number; height?: number; isVector: false; hasAlpha?: boolean }> {
  // sharp 已在依赖内，用它解码：拿真实格式与像素尺寸，坏图/截断图在此暴露
  let meta: Metadata;
  try {
    meta = await sharp(data).metadata();
  } catch {
    throw new AssetGuardError('invalid_image', '内容不是完整的受支持图片');
  }
  const format = String(meta.format || '').toLowerCase();
  if (!RASTER_FORMATS.has(format)) {
    throw new AssetGuardError('unsupported_format', `解码出的格式不支持落盘：${format || '未知'}`);
  }
  return { format: format === 'jpg' ? 'jpeg' : format, width: meta.width, height: meta.height, isVector: false, hasAlpha: meta.hasAlpha };
}

// 纯正则扫描（零依赖）：导出 SVG 会被浏览器消费，主动内容/外链必须拦下。
// 相比 XML 解析器是弱校验，但对已知的 SVG 攻击面（DTD 实体、脚本、事件属性、外链）足够。
function inspectSvg(data: Buffer): { format: 'svg'; width?: number; height?: number; isVector: true } {
  const text = data.toString('utf8');
  if (/<!\s*(?:DOCTYPE|ENTITY)|<\?xml-stylesheet/i.test(text)) {
    throw new AssetGuardError('unsafe_svg', 'SVG 含 DTD/ENTITY/外部样式表，已拒绝');
  }
  const rootMatch = /<svg[\s>]/i.exec(text);
  if (!rootMatch) throw new AssetGuardError('invalid_image', '内容不是 SVG 图片');

  // 危险元素：脚本/ForeignObject/多媒体/SMIL 动画
  if (/<\s*(script|foreignObject|iframe|object|embed|audio|video|animate|animateMotion|animateTransform|set)\b/i.test(text)) {
    throw new AssetGuardError('unsafe_svg', 'SVG 含脚本或主动内容元素，已拒绝');
  }
  // 事件属性（on*）与外部引用
  if (/\son[a-z]+\s*=/i.test(text)) {
    throw new AssetGuardError('unsafe_svg', 'SVG 含事件属性，已拒绝');
  }
  const externalRef = /(?:xlink:)?href\s*=\s*["'](?!#)([^"']*)/ig;
  for (const m of text.matchAll(externalRef)) {
    const v = m[1].trim();
    if (!v.startsWith('#')) throw new AssetGuardError('unsafe_svg', `SVG 含外部引用：${v.slice(0, 80)}`);
  }
  if (/@import|expression\s*\(|javascript\s*:/i.test(text)) {
    throw new AssetGuardError('unsafe_svg', 'SVG 含主动样式，已拒绝');
  }
  for (const m of text.matchAll(/url\s*\(\s*['"]?([^)'"]+)/gi)) {
    const v = m[1].trim();
    if (!v.startsWith('#')) throw new AssetGuardError('unsafe_svg', `SVG 含外部 paint 引用：${v.slice(0, 80)}`);
  }

  const { width, height } = svgIntrinsicSize(text);
  return { format: 'svg', width, height, isVector: true };
}

function svgIntrinsicSize(text: string): { width?: number; height?: number } {
  const attr = (name: string): number | undefined => {
    const m = new RegExp(`<svg[^>]*\\b${name}=["']\\s*(\\d+(?:\\.\\d+)?)px?["']`, 'i').exec(text);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  let width = attr('width');
  let height = attr('height');
  if (!width || !height) {
    const vb = /viewBox=["']\s*[\d.eE+-]+[\s,]+[\d.eE+-]+[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)["']/i.exec(text);
    if (vb) {
      width = width || Number(vb[1]);
      height = height || Number(vb[2]);
    }
  }
  return { width, height };
}

// ─── 多倍图 URL ─────────────────────────────────────────────────

/**
 * 生成多倍图下载 URL（移植 _build_scale_urls，按蓝湖 CDN 实测适配）。
 *
 * 蓝湖 CDN 切图只存一份原图（存储尺寸 = 设计逻辑尺寸 × storedScale，实测固定 4x）。
 * 其它倍率拼 x-oss-process=image/resize 参数由阿里云 OSS 在线出图；
 * 请求尺寸恰为存储尺寸时直接返回原 URL，不加参数。
 *
 * @param imageUrl    CDN 原图 URL
 * @param logicalW/H  设计逻辑尺寸（1x，即图层 frame 的 w/h）
 * @param storedScale 存储倍率（蓝湖实测 4x，默认 4）
 * @param format      输出格式（png/webp）；png 且恰为存储尺寸时 URL 保持原样，
 *                    webp 等其它格式即使 original 也需要拼转换参数
 */
export function buildScaleUrls(
  imageUrl: string,
  logicalW: number,
  logicalH: number,
  storedScale = 4,
  format: 'png' | 'webp' = 'png'
): Record<string, string> {
  if (!imageUrl || !logicalW || !logicalH) return {};
  const lw = Math.max(1, Math.round(logicalW));
  const lh = Math.max(1, Math.round(logicalH));
  const sw = lw * storedScale;
  const sh = lh * storedScale;

  const makeUrl = (w: number, h: number): string => {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const resize = w === sw && h === sh ? '' : `resize,w_${w},h_${h}/`;
    const convert = format === 'png' ? 'format,png' : `format,${format}`;
    return `${imageUrl}?x-oss-process=image/${resize}${convert}`;
  };
  // 模拟 JS Math.round 的 .5 向上取整（对齐蓝湖前端行为）
  const jsRound = (v: number): number => Math.floor(v + 0.5);

  const iosBase = sw / 4; // iOS 基准按存储/4（蓝湖前端硬编码）
  return {
    // original：png 保持存储原字节；webp 等其它格式拼纯转换参数（无 resize）
    original: format === 'png' ? imageUrl : `${imageUrl}?x-oss-process=image/format,${format}`,
    '1x': makeUrl(lw * 1, lh * 1),
    '2x': makeUrl(lw * 2, lh * 2),
    '3x': makeUrl(lw * 3, lh * 3),
    ios_1x: makeUrl(jsRound(iosBase * 1), jsRound((sh / 4) * 1)),
    ios_2x: makeUrl(jsRound(iosBase * 2), jsRound((sh / 4) * 2)),
    ios_3x: makeUrl(jsRound(iosBase * 3), jsRound((sh / 4) * 3)),
    android_mdpi: makeUrl(jsRound((sw / 4) * 1), jsRound((sh / 4) * 1)),
    android_hdpi: makeUrl(jsRound((sw / 4) * 1.5), jsRound((sh / 4) * 1.5)),
    android_xhdpi: makeUrl(jsRound((sw / 4) * 2), jsRound((sh / 4) * 2)),
    android_xxhdpi: makeUrl(jsRound((sw / 4) * 3), jsRound((sh / 4) * 3)),
    android_xxxhdpi: makeUrl(sw, sh),          // = 原图尺寸
  };
}
