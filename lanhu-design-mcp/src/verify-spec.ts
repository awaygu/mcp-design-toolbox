// verify-spec.ts — 设计稿图层树 ↔ 页面计算样式 逐字段比对（L3 数据比对）
import type { Credentials, DesignLayer } from './types.js';
import { fetchDesignViaApi } from './lanhu-client.js';
import { isVisionConfigured, callVision } from './vision.js';

export interface DomSample {
  selector: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  backgroundColor: string;
  // 最近的「非透明」祖先背景色：设计稿的纯色矩形常由父容器 CSS 背景实现，叶子节点透明，需回退比对
  bgAncestor: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number | null;
}

export type DiffField = 'x' | 'y' | 'width' | 'height' | 'color' | 'fill' | 'fontSize' | 'fontWeight' | 'lineHeight' | 'text';

/** 单字段偏差（分组后的形态：layer/path/selector 等公共定位字段上移到组，避免每条重复） */
export interface SpecDiff {
  field: DiffField;
  expected: string | number;
  actual: string | number;
  delta: number;
  severity: 'minor' | 'major' | 'critical';
  // 文案差异的语义等价分类（仅 field=text 且经视觉模型判定时存在）
  equivalenceClass?: 'translation' | 'synonym' | 'abbreviation' | 'dynamic_value_format' | 'different_meaning';
  // 文案判定的理由（同上，仅视觉模型判定时存在）
  textReason?: string;
}

/** 同一图层/选择器的偏差组：一个元素的多处偏差合并在一个对象里 */
export interface SpecDiffGroup {
  layer: string;
  path: string;
  selector: string;
  matchBy: 'text' | 'position';
  diffs: SpecDiff[];
}

/** 分组前的内部形态：带定位字段的扁平偏差 */
type FlatDiff = SpecDiff & { layer: string; path: string; selector: string; matchBy: 'text' | 'position' };

interface MatchPair {
  layer: DesignLayer;
  sample: DomSample;
  matchBy: SpecDiffGroup['matchBy'];
}

interface Offset {
  dx: number;
  dy: number;
}

export interface VerifySpecResult {
  design: { name: string; viewport: { width: number; height: number }; layerCount: number };
  page: { url: string; viewport: { width: number; height: number }; sampled: number };
  matched: number;
  // 页面相对设计稿的整体偏移，由锚点 RANSAC 估算；比对位置字段时已按此校正
  offset: { dx: number; dy: number; anchors: number; rejected: number };
  // 比对前剔除的无效/状态栏图层，及其剔因分布
  denoised: { skipped: number; reasons: Record<string, number> };
  // 偏差按「组」输出（同图层/选择器一组），组按最重严重度排前；默认最多 50 组
  diffs: SpecDiffGroup[];
  diffCount: number;       // 字段偏差总条数（分组前）
  diffGroupCount: number;  // 偏差组总数
  diffsTruncated: boolean; // 是否因 maxDiffs 截断
  unmatchedLayers: string[];
  notes: string[];
  // 文案差异是否经视觉模型做了语义等价判定（key 未配时为 false，纯数据模式只报 warning）
  textCheckedByVision: boolean;
  // 样式清单比对：不做元素配对，只比「设计稿文字样式集合」vs「页面文字样式集合」。
  // 零标注、不比文案 → 跨语言 / 跨迭代文案差异都不会让它失盲，是永远在线的安全网。
  inventory: StyleInventory;
}

export interface StyleInventory {
  designStyleCount: number;
  pageStyleCount: number;
  // 设计稿有、页面没有 → 元素缺失 或 样式被覆盖（真缺陷嫌疑）；最多展示 20 条
  missingOnPage: StyleInventoryItem[];
  // 页面有、设计稿没有 → 样式漂移 / 硬编码（真缺陷嫌疑）；最多展示 20 条
  notInDesign: StyleInventoryItem[];
  missingOnPageTotal: number;
  notInDesignTotal: number;
}

export interface StyleInventoryItem {
  fontSize: number;
  fontWeight: number;
  color: string;
  count: number;
  designLayers: string[];
  samples: string[];
  selectors: string[];
}

// 只采「叶子节点」和「带直接文本」的元素，容器层没有独立视觉表现，采了全是噪音
function collectFn(): DomSample[] {
  const path = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      let s = cur.tagName.toLowerCase();
      const id = cur.getAttribute('id');
      if (id) s += `#${id}`;
      else {
        const cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
        if (cls) s += `.${cls}`;
      }
      parts.unshift(s);
      cur = cur.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  };

  const out: any[] = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // SVG 不产生文字样式，采了是噪音
    if (el.tagName === 'SVG') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const directText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent || '').trim())
      .join(' ')
      .trim();
    // 容器型元素无直接文本时其视觉由子元素表达，采了是重复噪音，跳过
    if (el.children.length > 0 && !directText) continue;
    const lh = parseFloat(cs.lineHeight);
    // 向上找最近的非透明祖先背景色，用于「设计稿纯色矩形由父容器背景实现」的回退比对
    let bgAncestor = '';
    let ap = el.parentElement;
    for (let i = 0; i < 3 && ap; i++) {
      const pb = getComputedStyle(ap).backgroundColor;
      if (pb && pb !== 'rgba(0, 0, 0, 0)' && pb !== 'transparent') {
        bgAncestor = pb;
        break;
      }
      ap = ap.parentElement;
    }
    out.push({
      selector: path(el),
      text: directText,
      x: Math.round((r.x + window.scrollX) * 100) / 100,
      y: Math.round((r.y + window.scrollY) * 100) / 100,
      width: Math.round(r.width * 100) / 100,
      height: Math.round(r.height * 100) / 100,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      bgAncestor,
      fontSize: parseFloat(cs.fontSize) || 0,
      fontWeight: Number(cs.fontWeight) || 0,
      lineHeight: Number.isFinite(lh) ? Math.round(lh * 100) / 100 : null,
    });
  }
  return out;
}

function parseColor(v: unknown): { r: number; g: number; b: number; a: number } | null {
  const s = String(v || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r: h[0], g: h[1], b: h[2], a: 1 };
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
      a: 1,
    };
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(',').map((t) => parseFloat(t));
    if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}

// 三档阈值：[可容忍, minor 上限, major 上限]，超 major 上限即 critical
function numericSeverity(delta: number, tol: [number, number, number]): 'minor' | 'major' | 'critical' | null {
  if (delta <= tol[0]) return null;
  if (delta <= tol[1]) return 'minor';
  if (delta <= tol[2]) return 'major';
  return 'critical';
}

const TOL = {
  geometry: [1, 3, 8] as [number, number, number],
  fontSize: [0.5, 1, 2] as [number, number, number],
  lineHeight: [1, 2, 4] as [number, number, number],
};

// 位置按全局偏移校正后比对：设计稿常带状态栏占位而页面用原生安全区，整体偏移不是缺陷
function diffPair(layer: DesignLayer, s: DomSample, matchBy: 'text' | 'position', off: { dx: number; dy: number }): FlatDiff[] {
  const out: FlatDiff[] = [];
  // 图层名在蓝湖里大量重名（矩形/蒙版/编组），带上 parentPath 才能定位到具体是哪个
  const base = { layer: layer.name || '(未命名图层)', path: layer.parentPath || '', selector: s.selector, matchBy };
  // 文本层宽度随语言（中/英/繁）字长变化，不是严格几何，宽度差异只报 warning
  const isText = layer.type === 'text';
  const num = (field: DiffField, exp: number, act: number, tol: [number, number, number]) => {
    const delta = Math.abs(exp - act);
    const severity = numericSeverity(delta, tol);
    if (severity) out.push({ ...base, field, expected: exp, actual: act, delta: Math.round(delta * 100) / 100, severity });
  };
  const color = (field: DiffField, exp: string, act: string) => {
    const a = parseColor(exp);
    const b = parseColor(act);
    if (!a || !b) return;
    // 两端都近乎全透明时色相无意义（蓝湖导出常见 alpha=0.0001），比了只会刷屏误报
    if (a.a < 0.01 && b.a < 0.01) return;
    const delta = Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
    const alphaDelta = Math.abs(a.a - b.a);
    if (delta <= 2 && alphaDelta <= 0.02) return;
    // 透明度偏差单独从严：肉眼对半透明层级变化比色相更敏感
    let severity: 'minor' | 'major' | 'critical' = alphaDelta > 0.02 || delta > 30 ? 'critical' : delta > 10 ? 'major' : 'minor';
    // 实测元素完全透明时，颜色大概率在父级背景或切图里实现，降一级避免刷屏
    if (b.a < 0.01 && severity === 'critical') severity = 'major';
    out.push({ ... base, field, expected: exp, actual: act, delta: Math.round(delta * 100) / 100, severity });
  };

  num('x', layer.x + off.dx, s.x, TOL.geometry);
  // 文本层宽度随语言字长浮动，降级为 minor；矩形/切图等非文本层宽度严格比对
  if (isText) {
    const wDelta = Math.abs(layer.w - s.width);
    if (wDelta > TOL.geometry[0])
      out.push({ ...base, field: 'width', expected: layer.w, actual: s.width, delta: Math.round(wDelta * 100) / 100, severity: 'minor' });
  } else {
    num('width', layer.w, s.width, TOL.geometry);
  }
  // y/height 宽松：webview 状态栏占位导致整体竖直偏移、且内容动态渲染高度可超设计稿，均属预期
  const yDelta = Math.abs(layer.y + off.dy - s.y);
  if (yDelta > TOL.geometry[0])
    out.push({ ...base, field: 'y', expected: Math.round((layer.y + off.dy) * 100) / 100, actual: s.y, delta: Math.round(yDelta * 100) / 100, severity: 'minor' });
  const hDelta = Math.abs(layer.h - s.height);
  if (hDelta > TOL.geometry[0])
    out.push({ ...base, field: 'height', expected: layer.h, actual: s.height, delta: Math.round(hDelta * 100) / 100, severity: 'minor' });

  if (layer.color) color('color', layer.color, s.color);
  if (layer.fill) {
    // 叶子节点背景透明、但最近祖先背景色与设计填充接近 → 颜色在父容器实现，属正常，跳过
    const exp = parseColor(layer.fill);
    if (s.backgroundColor === 'rgba(0, 0, 0, 0)' && s.bgAncestor && exp) {
      const pa = parseColor(s.bgAncestor);
      if (pa && Math.max(Math.abs(pa.r - exp.r), Math.abs(pa.g - exp.g), Math.abs(pa.b - exp.b)) <= 30 && Math.abs(pa.a - exp.a) <= 0.02) {
        // 颜色在父级背景上，正常实现，不报
      } else {
        color('fill', layer.fill, s.backgroundColor);
      }
    } else {
      color('fill', layer.fill, s.backgroundColor);
    }
  }
  if (layer.fontSize) num('fontSize', layer.fontSize, s.fontSize, TOL.fontSize);
  if (layer.fontWeight && s.fontWeight && layer.fontWeight !== s.fontWeight) {
    // 移动端字体多无 600+ 重字重，浏览器回退到 700 属合理实现差异，只记 minor
    const isFallback = layer.fontWeight >= 600 && s.fontWeight === 700;
    out.push({
      ...base,
      field: 'fontWeight',
      expected: layer.fontWeight,
      actual: s.fontWeight,
      delta: Math.abs(layer.fontWeight - s.fontWeight),
      severity: isFallback ? 'minor' : 'major',
    });
  }
  if (typeof layer.lineHeight === 'number' && s.lineHeight != null) {
    num('lineHeight', layer.lineHeight, s.lineHeight, TOL.lineHeight);
  }
  // 文案差异：设计稿与实际允许语义接近，纯数据模式只报 warning（minor），视觉模型可用时再升级判定
  if (layer.text && layer.text.trim() && s.text && s.text.trim() && layer.text.trim() !== s.text.trim()) {
    out.push({ ...base, field: 'text', expected: layer.text.trim(), actual: s.text.trim(), delta: 0, severity: 'minor' });
  }
  return out;
}

// 交并比：比中心点距离更抗干扰，尺寸差得多的元素不会误配
function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; width: number; height: number }): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.width);
  const y2 = Math.min(a.y + a.h, b.y + b.height);
  const iw = x2 - x1;
  const ih = y2 - y1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const union = a.w * a.h + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

// 蓝湖图层重名严重（矩形/蒙版/编组），用中位数估计整体偏移需先剔除错配锚点
function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 设计稿无效图层：状态栏/蒙版/标注/备份组/占位/切图导出件等，比对前剔除，否则刷屏误报
const NOISE_RE =
  /(状态栏|status\s*bar|system\s*bar|safe\s*area|刘海|notch|蒙版|mask|guide|标注|备份|backup|副本|copy|_old|占位|placeholder|草稿|draft|切图|slice|导出|export|temp|tmp|ref\b)/i;

// 前置去噪：webview 不画状态栏、装饰/标注/备份层不产生 DOM，留着只会污染匹配与未匹配统计
function denoiseLayers(layers: DesignLayer[], viewportWidth: number): { kept: DesignLayer[]; skipped: number; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  const bump = (r: string) => {
    reasons[r] = (reasons[r] || 0) + 1;
  };
  const kept: DesignLayer[] = [];
  for (const l of layers) {
    if (l.opacity === 0) {
      bump('opacity0');
      continue;
    }
    if (l.w <= 0 || l.h <= 0) {
      bump('zeroSize');
      continue;
    }
    const name = l.name || '';
    if (NOISE_RE.test(name)) {
      bump('noiseName');
      continue;
    }
    // 顶部整条、贴边、高度落在状态栏区间 → 视为状态栏占位（设计稿画了，webview 由系统画）
    if (l.y <= 1 && l.x <= 1 && l.w >= viewportWidth * 0.9 && l.h >= 18 && l.h <= 80) {
      bump('statusBar(geom)');
      continue;
    }
    kept.push(l);
  }
  return { kept, skipped: layers.length - kept.length, reasons };
}

// 无歧义锚点：文案在设计稿与页面各只出现一次时配对唯一，用它先定粗偏移
function unambiguousAnchors(layers: DesignLayer[], samples: DomSample[]): MatchPair[] {
  const group = (arr: Array<{ text: string }>) => {
    const m = new Map<string, number[]>();
    arr.forEach((it, i) => {
      const t = it.text?.trim();
      if (!t) return;
      if (!m.has(t)) m.set(t, []);
      m.get(t)!.push(i);
    });
    return m;
  };
  const dm = group(layers as unknown as Array<{ text: string }>);
  const sm = group(samples);
  const out: MatchPair[] = [];
  for (const [t, li] of dm) {
    const si = sm.get(t);
    if (!si || li.length !== 1 || si.length !== 1) continue;
    out.push({ layer: layers[li[0]], sample: samples[si[0]], matchBy: 'text' });
  }
  return out;
}

// 锚点轮：只认文案，全局贪心分配（顺序贪心在重复 key 下会先到先得、整队错位）
function matchAnchors(layers: DesignLayer[], samples: DomSample[], off: Offset) {
  const cands: Array<{ li: number; si: number; score: number; matchBy: 'text' | 'position' }> = [];
  layers.forEach((l, li) => {
    const text = l.text?.trim() || '';
    const shifted = { x: l.x + off.dx, y: l.y + off.dy, w: l.w, h: l.h };
    samples.forEach((s, si) => {
      if (text && s.text === text) {
        // *30D/x5/Lv.5 这类重复短串靠裸 IoU 分不出实例，改用「与整体偏移的残差」排序
        const resid = Math.hypot(s.x - shifted.x, s.y - shifted.y);
        cands.push({ li, si, score: 10 - resid / 1000 + iou(shifted, s), matchBy: 'text' });
      }
    });
  });
  cands.sort((a, b) => b.score - a.score);

  const usedLayer = new Set<number>();
  const usedSample = new Set<number>();
  const pairs: MatchPair[] = [];
  for (const c of cands) {
    if (usedLayer.has(c.li) || usedSample.has(c.si)) continue;
    usedLayer.add(c.li);
    usedSample.add(c.si);
    pairs.push({ layer: layers[c.li], sample: samples[c.si], matchBy: c.matchBy });
  }
  return { pairs, rest: layers.filter((_, i) => !usedLayer.has(i)), usedSample };
}

// RANSAC 估偏移：重复短串（*30D/x5/Lv.5）会大量错配，取中位数会被带偏，改为找「最多锚点认同」的那个偏移
function estimateOffset(pairs: MatchPair[]): { off: Offset; inliers: MatchPair[]; outliers: MatchPair[] } {
  if (pairs.length < 3) return { off: { dx: 0, dy: 0 }, inliers: pairs, outliers: [] };
  const vecs = pairs.map((p) => ({ dx: p.sample.x - p.layer.x, dy: p.sample.y - p.layer.y, pair: p }));
  let best: typeof vecs = [];
  let bestDist = Infinity;
  for (const seed of vecs) {
    const inliers = vecs.filter((v) => Math.abs(v.dx - seed.dx) <= 3 && Math.abs(v.dy - seed.dy) <= 3);
    const dist = Math.hypot(seed.dx, seed.dy);
    // 同票时取位移更小的解：真实整体偏移通常远小于误配产生的位移
    if (inliers.length > best.length || (best.length > 0 && inliers.length === best.length && dist < bestDist)) {
      best = inliers;
      bestDist = dist;
    }
  }
  const off = { dx: median(best.map((v) => v.dx)), dy: median(best.map((v) => v.dy)) };
  const keep = new Set(best.map((v) => v.pair));
  return { off, inliers: [...keep], outliers: pairs.filter((p) => !keep.has(p)) };
}

// 几何轮：先按锚点估算的整体偏移平移设计稿坐标再配 IoU——不平移的话整体偏移会让所有 IoU 归零
function matchByGeometry(layers: DesignLayer[], samples: DomSample[], usedSample: Set<number>, off: Offset) {
  const cands: Array<{ li: number; si: number; v: number }> = [];
  layers.forEach((l, li) => {
    const shifted = { x: l.x + off.dx, y: l.y + off.dy, w: l.w, h: l.h };
    samples.forEach((s, si) => {
      if (usedSample.has(si)) return;
      const v = iou(shifted, s);
      if (v >= 0.5) cands.push({ li, si, v });
    });
  });
  cands.sort((a, b) => b.v - a.v);

  const usedLayer = new Set<number>();
  const pairs: MatchPair[] = [];
  for (const c of cands) {
    if (usedLayer.has(c.li) || usedSample.has(c.si)) continue;
    usedLayer.add(c.li);
    usedSample.add(c.si);
    pairs.push({ layer: layers[c.li], sample: samples[c.si], matchBy: 'position' });
  }
  return { pairs, unmatched: layers.filter((_, i) => !usedLayer.has(i)) };
}

// 视觉模型对文案差异做语义等价判定；key 未配或调用失败时默认「语义接近、放行」，不误报
// 样例驱动 + 动态值豁免是砍假阳性的关键：动态值/翻译/缩写不该被验收卡住
type EquivalenceClass = 'translation' | 'synonym' | 'abbreviation' | 'dynamic_value_format' | 'different_meaning';

const TEXT_EQUIV_PROMPT = [
  'You are a design acceptance assistant. For each pair of "design copy" vs "actual page copy", judge whether they are semantically equivalent.',
  '',
  'Rules (by priority):',
  '1. Dynamic-value exemption: both sides are pure numbers/points/dates/counters (e.g. *30D, Lv.5, ¥29.9, 08:30), same unit and magnitude difference <2x → same=true',
  '2. Cross-language translation equivalence → same=true',
  '3. Synonymous paraphrase / abbreviation → same=true',
  '4. Otherwise → same=false',
  '',
  'Samples (8 pairs; copy strings stay in their original languages):',
  '✅ 立即抢购 | Buy Now (translation)',
  '✅ *30D | *30天 (dynamic_value_format)',
  '✅ ¥29.90 | 29.9元 (dynamic_value_format)',
  '✅ Lv.5 | 等级5 (dynamic_value_format)',
  '✅ 确认 | OK (abbreviation)',
  '❌ 支付 | 立即购买 (different_meaning)',
  '❌ 已结束 | 进行中 (different_meaning)',
  '❌ 免费 | ¥9.9 (different_meaning)',
  '',
  'Output JSON only: {"result":[{"same":true,"equivalence_class":"translation|synonym|abbreviation|dynamic_value_format|different_meaning","reason":"<=15 words, cite the rule number"}]}, strictly valid json for program parsing.',
].join('\n');

async function semanticCheckTexts(pairs: Array<{ expected: string; actual: string }>): Promise<Array<{ same: boolean; cls: EquivalenceClass | ''; reason: string }>> {
  if (!pairs.length) return [];
  if (!isVisionConfigured()) return pairs.map(() => ({ same: true, cls: '', reason: 'vision 未配置，按语义接近默认放行' }));
  const list = pairs.map((p, i) => `[${i}] 设计:${p.expected} | 页面:${p.actual}`).join('\n');
  const VALID_CLS = new Set(['translation', 'synonym', 'abbreviation', 'dynamic_value_format', 'different_meaning']);
  try {
    const res = await callVision({ text: TEXT_EQUIV_PROMPT + '\n' + list });
    const arr = Array.isArray(res?.result) ? res.result : [];
    return pairs.map((_, i) => {
      const it = arr[i];
      if (!it || typeof it.same !== 'boolean') return { same: true, cls: '', reason: 'vision 解析失败，按语义接近默认放行' };
      const cls = VALID_CLS.has(it.equivalence_class) ? (it.equivalence_class as EquivalenceClass) : '';
      return { same: it.same, cls, reason: String(it.reason || '') };
    });
  } catch {
    return pairs.map(() => ({ same: true, cls: '', reason: 'vision 调用失败，按语义接近默认放行' }));
  }
}

// 样式清单比对：不做元素配对，只比「设计稿文字样式集合」vs「页面文字样式集合」。
// 元组 = fontSize / fontWeight / color（rgb）。零标注、不比文案，
// 因此跨语言、跨迭代文案差异都不会让它失盲——它是永远在线的安全网。
function styleTuple(f: number, w: number, color: string): { key: string; fontSize: number; fontWeight: number; color: string } | null {
  const f2 = Math.round(f * 2) / 2;
  if (f2 <= 0) return null;
  const w2 = (Number(w) || 0) >= 900 ? 700 : Number(w) || 0; // 移动端字体常无 900，浏览器回落 700
  const c = parseColor(color);
  if (!c) return null;
  return { key: `${f2}|${w2}|rgb(${c.r},${c.g},${c.b})`, fontSize: f2, fontWeight: w2, color: `rgb(${c.r},${c.g},${c.b})` };
}

function compareStyleInventory(layers: DesignLayer[], samples: DomSample[]): StyleInventory {
  const make = (): StyleInventoryItem => ({ fontSize: 0, fontWeight: 0, color: '', count: 0, designLayers: [], samples: [], selectors: [] });
  const norm = (m: Map<string, StyleInventoryItem>, t: { key: string; fontSize: number; fontWeight: number; color: string }, push: (it: StyleInventoryItem) => void) => {
    let it = m.get(t.key);
    if (!it) { it = make(); it.fontSize = t.fontSize; it.fontWeight = t.fontWeight; it.color = t.color; m.set(t.key, it); }
    it.count++;
    push(it);
  };
  const designMap = new Map<string, StyleInventoryItem>();
  for (const l of layers) {
    if (l.type !== 'text' || !l.fontSize) continue;
    if ((l.y ?? 0) < 44) continue; // webview 不画状态栏，其文案不参与验收（属预期偏移来源）
    const t = styleTuple(l.fontSize, l.fontWeight || 0, l.color || '');
    if (!t) continue;
    norm(designMap, t, (it) => {
      if (it.designLayers.length < 4 && l.name) it.designLayers.push(l.name);
      if (it.samples.length < 3 && l.text) it.samples.push(String(l.text).slice(0, 18));
    });
  }
  const pageMap = new Map<string, StyleInventoryItem>();
  for (const s of samples) {
    if (!s.text || !s.fontSize) continue;
    const t = styleTuple(s.fontSize, s.fontWeight || 0, s.color);
    if (!t) continue;
    norm(pageMap, t, (it) => {
      if (it.selectors.length < 4 && s.selector) it.selectors.push(s.selector);
      if (it.samples.length < 3 && s.text) it.samples.push(s.text.slice(0, 18));
    });
  }
  const missingOnPage = [...designMap.entries()].filter(([k]) => !pageMap.has(k)).map(([, v]) => v).sort((a, b) => b.count - a.count);
  const notInDesign = [...pageMap.entries()].filter(([k]) => !designMap.has(k)).map(([, v]) => v).sort((a, b) => b.count - a.count);
  return {
    designStyleCount: designMap.size,
    pageStyleCount: pageMap.size,
    missingOnPage,
    notInDesign,
    missingOnPageTotal: missingOnPage.length,
    notInDesignTotal: notInDesign.length,
  };
}

export async function verifyDesignSpec(opts: {
  designUrl: string;
  pageUrl: string;
  waitFor?: string;
  maxDiffs?: number;
  credentials: Credentials;
}): Promise<VerifySpecResult> {
  const design = await fetchDesignViaApi(opts.designUrl, { ...opts.credentials, needCover: false });

  let pw: any;
  try {
    pw = await import('playwright');
  } catch {
    throw new Error('缺少 playwright：请在 mcp/lanhu-design-mcp 下执行 npm i playwright && npx playwright install chromium');
  }

  const browser = await pw.chromium.launch({ headless: true });
  try {
    const viewport = { width: design.viewport.width || 375, height: design.viewport.height || 812 };
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    await page.goto(opts.pageUrl, { waitUntil: 'load', timeout: 30_000 });
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 10_000 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    const samples = (await page.evaluate(collectFn)) as DomSample[];

    // 比对前剔除状态栏/蒙版/备份等无效图层，避免污染匹配与未匹配统计
    const den = denoiseLayers(design.layers, viewport.width);
    const layers = den.kept;

    // 先用配对唯一的文案锚点定粗偏移，再用它指导重复短串的实例分配
    const unamb = unambiguousAnchors(layers, samples);
    const rough: Offset | null =
      unamb.length >= 3
        ? { dx: median(unamb.map((p) => p.sample.x - p.layer.x)), dy: median(unamb.map((p) => p.sample.y - p.layer.y)) }
        : null;

    // 首轮用 rough（无歧义文案锚点）或 0 匹配，拿到「真实位置匹配」对（IoU 成立，与语言无关）
    const initOff = rough ?? { dx: 0, dy: 0 };
    const anchors = matchAnchors(layers, samples, initOff);
    const goodAnchors = anchors.pairs.filter(
      (p) => Math.abs(p.sample.x - p.layer.x - initOff.dx) <= 8 && Math.abs(p.sample.y - p.layer.y - initOff.dy) <= 8
    );
    const rejectedLayers = anchors.pairs.filter((p) => !goodAnchors.includes(p)).map((p) => p.layer);
    const usedSampleIdx0 = new Set(goodAnchors.map((p) => samples.indexOf(p.sample)));
    const geo0 = matchByGeometry([...anchors.rest, ...rejectedLayers], samples, usedSampleIdx0, initOff);
    // 用真实匹配对反推整体偏移（RANSAC），不依赖文案，语言不同也能估准；再不够才退回 rough
    const est = estimateOffset([...goodAnchors, ...geo0.pairs]);
    const off: Offset = est.inliers.length >= 3 ? est.off : rough ?? { dx: 0, dy: 0 };
    // 用校正后的偏移重跑几何轮，补齐首轮因偏移偏差漏配的元素
    const usedSampleIdx = new Set(goodAnchors.map((p) => samples.indexOf(p.sample)));
    const geo = matchByGeometry([...anchors.rest, ...rejectedLayers], samples, usedSampleIdx, off);
    const pairs = [...goodAnchors, ...geo.pairs];

    const diffs: FlatDiff[] = [];
    const textIdx: number[] = [];
    for (const { layer, sample, matchBy } of pairs) {
      for (const d of diffPair(layer, sample, matchBy, off)) {
        if (d.field === 'text') textIdx.push(diffs.length);
        diffs.push(d);
      }
    }
    // 文案差异经视觉模型做语义等价判定，仅当其确为不同含义时才升级为 major
    let textCheckedByVision = false;
    if (textIdx.length && isVisionConfigured()) {
      textCheckedByVision = true;
      const verdicts = await semanticCheckTexts(textIdx.map((i) => ({ expected: String(diffs[i].expected), actual: String(diffs[i].actual) })));
      verdicts.forEach((v, k) => {
        const d = diffs[textIdx[k]];
        if (v.cls) d.equivalenceClass = v.cls;
        if (v.reason) d.textReason = v.reason;
        if (!v.same) d.severity = 'major';
      });
    }
    const max = opts.maxDiffs ?? 50;

    const notes: string[] = [];
    if (den.skipped) {
      const r = Object.entries(den.reasons)
        .map(([k, v]) => `${k}×${v}`)
        .join('，');
      notes.push(`比对前剔除 ${den.skipped} 个无效/状态栏图层（${r}）；这些层在 webview 中不渲染，不参与验收`);
    }
    if (Math.abs(off.dx) >= 2 || Math.abs(off.dy) >= 2) {
      notes.push(
        `检测到页面整体偏移 (dx=${Math.round(off.dx)}, dy=${Math.round(off.dy)})，位置字段已按此校正后比对；` +
          '常见原因是设计稿含状态栏占位而页面用原生安全区'
      );
    }
    if (rejectedLayers.length) {
      notes.push(
        `${rejectedLayers.length} 个文案锚点与整体偏移不一致（多为 *30D/x5/Lv.5 这类重复短串串位），已剔除并退回几何重配`
      );
    }
    const missedText = geo.unmatched.filter((l) => l.text).length;
    if (geo.unmatched.length) {
      notes.push(
        `${geo.unmatched.length} 个图层未匹配到页面元素（其中 ${missedText} 个含文案）；` +
          '装饰层用 CSS/背景实现不产生 DOM 元素属正常，但含文案的未匹配需人工确认是否漏做'
      );
    }
    if (diffs.length > 0) {
      notes.push(
        `字段偏差共 ${diffs.length} 条（按图层分组见 diffs，critical 组在前）；文案差异默认 minor，经视觉模型判为不同含义才升 major`
      );
    }

    // 分组输出：同图层/选择器的偏差合成一组，公共定位字段只出现一次；组按最重严重度排前
    const sevRank: Record<SpecDiff['severity'], number> = { critical: 0, major: 1, minor: 2 };
    const groupMap = new Map<string, SpecDiffGroup>();
    for (const d of diffs) {
      const key = `${d.layer}\u0000${d.path}\u0000${d.selector}\u0000${d.matchBy}`;
      let g = groupMap.get(key);
      if (!g) {
        g = { layer: d.layer, path: d.path, selector: d.selector, matchBy: d.matchBy, diffs: [] };
        groupMap.set(key, g);
      }
      const { layer: _l, path: _p, selector: _s, matchBy: _m, ...field } = d;
      g.diffs.push(field);
    }
    const allGroups = [...groupMap.values()]
      .map((g) => ({ ...g, diffs: [...g.diffs].sort((a, b) => sevRank[a.severity] - sevRank[b.severity]) }))
      .sort((a, b) => {
        const wa = Math.min(...a.diffs.map((d) => sevRank[d.severity]));
        const wb = Math.min(...b.diffs.map((d) => sevRank[d.severity]));
        return wa - wb || b.diffs.length - a.diffs.length;
      });
    const diffGroups = allGroups.slice(0, max);
    if (allGroups.length > max) {
      notes.push(`偏差共 ${allGroups.length} 组 / ${diffs.length} 条字段偏差，已达上限 ${max} 组，建议先修 critical 再复检`);
    }

    // 样式清单比对：永远在线、零标注依赖的安全网；只报「某样式漂移了 + 示例」，不做逐元素配对
    const inventory = compareStyleInventory(layers, samples);
    if (inventory.missingOnPage.length || inventory.notInDesign.length) {
      notes.push(
        `样式清单比对（零标注、不比文案）：设计稿 ${inventory.designStyleCount} 种 / 页面 ${inventory.pageStyleCount} 种文字样式；` +
          `设计有页面无 ${inventory.missingOnPage.length} 种、页面有设计无 ${inventory.notInDesign.length} 种 → 见 inventory 字段`
      );
    }

    return {
      design: { name: design.name || '(未命名设计稿)', viewport: design.viewport, layerCount: design.layers.length },
      page: { url: opts.pageUrl, viewport, sampled: samples.length },
      matched: pairs.length,
      offset: {
        dx: Math.round(off.dx * 100) / 100,
        dy: Math.round(off.dy * 100) / 100,
        anchors: goodAnchors.length,
        rejected: rejectedLayers.length,
      },
      denoised: den,
      diffs: diffGroups,
      diffCount: diffs.length,
      diffGroupCount: allGroups.length,
      diffsTruncated: allGroups.length > max,
      unmatchedLayers: geo.unmatched.slice(0, 50).map((l) => l.name || '(未命名图层)'),
      notes,
      textCheckedByVision,
      inventory: {
        ...inventory,
        missingOnPage: inventory.missingOnPage.slice(0, 20),
        notInDesign: inventory.notInDesign.slice(0, 20),
        missingOnPageTotal: inventory.missingOnPage.length,
        notInDesignTotal: inventory.notInDesign.length,
      },
    };
  } finally {
    await browser.close();
  }
}
