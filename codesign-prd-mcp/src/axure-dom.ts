/**
 * Axure 原型结构化 DOM 提取
 *
 * 这一整个函数是「在浏览器 iframe 上下文里执行」的：Playwright 通过 fn.toString()
 * 把它序列化后注入页面，因此**函数体必须完全自包含**——不能引用模块作用域的
 * 任何变量、常量或工具函数（连打包后的外部名也拿不到）。
 *
 * ⚠️ 关键约束：内部所有 helper 必须写成 `function` 声明，不能写成
 * `const foo = () => {}`。esbuild/tsx 在 keepNames 模式下会给箭头函数赋值
 * 套一层 `__name(foo, "foo")` 来保留函数名，而 `__name` 定义在模块作用域、
 * 不会随函数体一起序列化，注入页面后会直接抛 `__name is not defined`。
 * 函数声明自带 name，不需要这层包装，因此能安全序列化。
 *
 * 相比旧的 container.innerText（把表头/单元格/按钮文案压成一维文本流），
 * 这里利用 Axure 导出 HTML 自带的确定性语义：
 *   ① 控件前导注释 `<!-- 名称 (类型) -->`        → 控件类型（矩形/圆形/连接/图片…）
 *   ② `.table_cell` + 内联 svg 的 viewbox 坐标    → 无需布局即可重建表格网格
 *   ③ `.text > <p>`                              → 文本行结构
 *   ④ `.text` 带 display:none                     → 空占位，跳过而非输出空行
 *   ⑤ 连接线 `_segN` 线段几何                     → 确定性还原流程图拓扑
 */
import type { DomTable, PageImage, PageSection } from './types.js';

/** 一个带语义的文本/图形控件 */
export interface AxureBlock {
  /** 文档顺序序号（1-based） */
  i: number;
  /** 控件类型，取自前导注释，如 矩形 / 圆形 / 连接 / 图片 / 形状 / 占位符 */
  type: string;
  /** 控件名，Axure 未命名时为 '' */
  name: string;
  /** 文本行（已归一化空白），无文本时为空数组 */
  lines: string[];
  /** 控件内嵌图数量 */
  imgs: number;
  /** 控件矩形；无坐标信息时为 null */
  rect: { x: number; y: number; w: number; h: number } | null;
  /** 画布空间归属：≥0 = 第 N 个界面区块（y/x 阅读序，对应 sections 下标）；-1 = 画布散落文字（不邻近任何界面截图）。未做空间切分的页面缺省 */
  sec?: number;
}

/** 流程图节点（由带文本的控件充当） */
export interface AxureFlowNode {
  id: string;
  text: string;
  /** 控件类型，可用于推断 start/end/decision 等语义 */
  type: string;
}

/** 流程图连线（由连接线几何推导，非视觉模型猜测） */
export interface AxureFlowEdge {
  from: string;
  to: string;
  /** 连线上的文字（多数为空） */
  label: string;
}

/** 从连接线几何还原出的流程图；页面不是流程图时为 null */
export interface AxureFlow {
  nodes: AxureFlowNode[];
  edges: AxureFlowEdge[];
  /** 还原方式说明，写入文档供人工判断可信度 */
  source: 'dom-connector';
}

/** 结构化提取结果 */
export interface AxureExtract {
  /** 兼容旧字段：所有文本块按行拼接（比 innerText 干净，仍可用于类型判定/缓存键） */
  text: string;
  tables: DomTable[];
  images: PageImage[];
  /** 画布型页面的空间切分区块 */
  sections?: PageSection[];
  /** 按文档顺序排列的控件块 */
  blocks: AxureBlock[];
  /** 连接线几何还原的流程图，非流程图页为 null */
  flow: AxureFlow | null;
}

/**
 * 生成可注入页面的表达式字符串。
 *
 * 为什么不直接 `frame.evaluate(axureExtract)`：
 * esbuild / tsx 在 keepNames 模式下会给每个具名函数补一条 `__name(fn, "fn")` 语句，
 * 而 `__name` 定义在**模块作用域**、不会随 fn.toString() 一起序列化，注入页面后会抛
 * `__name is not defined`（dist 打包默认不开 keepNames 所以没事，tsx 直跑 TS 源码必炸）。
 * 这里在闭包里补一个 no-op `__name` 兜住，让同一份代码在任何打包/转译方式下都能注入。
 */
export function axureExtractExpression(): string {
  return `(function(){function __name(f){return f;}return (${axureExtract.toString()})();})()`;
}

/**
 * 在页面上下文中执行的结构化提取。
 * 注意：必须保持自包含、且内部只用 function 声明（见文件头说明）。
 */
export function axureExtract(): AxureExtract {
  interface Rect { x: number; y: number; w: number; h: number }

  const container = document.getElementById('base') || document.body;
  if (!container) {
    return { text: '', tables: [], images: [], blocks: [], flow: null };
  }

  // ─── helpers（全部用 function 声明，避免 __name 包装）────────

  /** 空白归一化：Axure 里大量全角空格/换行会污染输出 */
  function norm(s: string | null | undefined): string {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function isHidden(el: Element): boolean {
    const s = (el.getAttribute('style') || '') + ' ' + (el.getAttribute('class') || '');
    return /display:\s*none/.test(s) || /visibility:\s*hidden/.test(s);
  }

  /** 读取控件前导注释 `<!-- 名称 (类型) -->` */
  function metaOf(el: Element): { name: string; type: string } | null {
    let n = el.previousSibling;
    while (n) {
      if (n.nodeType === 8) {
        const m = (n.textContent || '').match(/^(.*?)\s*\((.*?)\)\s*$/);
        if (m) return { name: norm(m[1]), type: norm(m[2]) };
      }
      if (n.nodeType === 1) break;
      n = n.previousSibling;
    }
    return null;
  }

  /** .text 内的 <p> 行；保留行结构（innerText 会把它们揉成一段） */
  function textLines(el: Element): string[] | null {
    const t = el.querySelector('.text');
    if (!t || isHidden(t)) return null;
    const ps = Array.from(t.querySelectorAll('p'));
    const src = ps.length ? ps : [t];
    const kept = src.map((p) => norm(p.textContent)).filter((l) => l.length > 0);
    return kept.length ? kept : null;
  }

  /**
   * 控件矩形：优先 getBoundingClientRect——CoDesign 查看器的画布位置由运行时 JS
   * 注入内联样式，渲染后即为真实文档坐标（提取发生在截图滚屏之前，无滚动偏移）。
   * svg viewBox 只是控件局部坐标（原点在控件自身左上，y 只有 0~150 的小偏移），
   * 不能反映画布位置，仅作布局未就绪（gBCR 退化）时的兜底。
   */
  function rectOf(el: Element): Rect | null {
    const r = el.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) {
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    const svg = el.querySelector('svg[viewbox], svg[viewBox]');
    if (svg) {
      const raw = svg.getAttribute('viewbox') || svg.getAttribute('viewBox') || '';
      const vb = raw.trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb.every((n) => Number.isFinite(n))) {
        return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
      }
    }
    return null;
  }

  // ─── 1. 内嵌原型图 ─────────────────────────────────────────

  const images: PageImage[] = [];
  const imgRects: Rect[] = [];
  container.querySelectorAll('img').forEach((img, i) => {
    const r = img.getBoundingClientRect();
    const width = Math.round(r.width);
    const height = Math.round(r.height);
    if (width < 40 || height < 40) return;
    const src = (img.currentSrc || img.src || '').slice(0, 200);
    // Axure 的连接线由 *_segN.svg 逐段拼出，不是内容图；
    // 图标级小图（<120px）通常是装饰，都不值得单独送视觉模型解析
    const isSegment = /_seg\d+\.svg(\?|$)/i.test(src);
    images.push({
      src,
      alt: img.alt?.trim() || '',
      width,
      height,
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      imgIndex: i,
      isContent: !isSegment && width >= 120 && height >= 120,
    });
    imgRects.push({ x: r.left, y: r.top, w: width, h: height });
  });

  const allWidgets = Array.from(container.querySelectorAll('.ax_default'));

  // ─── 2. 表格：.table_cell + viewbox 坐标 → 确定性网格 ──────

  const tables: DomTable[] = [];

  function nearestKey(keys: number[], v: number): number {
    let best = 0;
    let bestD = Infinity;
    keys.forEach((k, i) => {
      const d = Math.abs(v - k);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  allWidgets.forEach((widget) => {
    const cells = Array.from(widget.querySelectorAll(':scope > .table_cell'));
    if (cells.length < 4) return;

    const items = cells.map((c) => ({
      r: rectOf(c) || { x: 0, y: 0, w: 0, h: 0 },
      text: (textLines(c) || ['']).join('<br>'),
    }));

    // 行：top 相差 ≤2px 聚为一行；列：left 相差 ≤3px 聚为一列（Axure 网格坐标精确）
    const rowKeys: number[] = [];
    [...items].sort((a, b) => a.r.y - b.r.y).forEach((it) => {
      if (!rowKeys.length || it.r.y - rowKeys[rowKeys.length - 1] > 2) rowKeys.push(it.r.y);
    });
    const colKeys: number[] = [];
    [...items].sort((a, b) => a.r.x - b.r.x).forEach((it) => {
      if (!colKeys.length || it.r.x - colKeys[colKeys.length - 1] > 3) colKeys.push(it.r.x);
    });

    const grid: string[][] = Array.from({ length: rowKeys.length }, () =>
      Array.from({ length: colKeys.length }, () => ''));
    items.forEach((it) => {
      grid[nearestKey(rowKeys, it.r.y)][nearestKey(colKeys, it.r.x)] = it.text;
    });

    const filled = grid.flat().filter((c) => c !== '').length;
    const cellsTotal = rowKeys.length * colKeys.length;
    if (rowKeys.length >= 2 && colKeys.length >= 2 && filled / cellsTotal >= 0.3) {
      // 边界矩形：供标题推断（找表格旁边的标注文本块）与空间定位
      const x0 = Math.min(...items.map((it) => it.r.x));
      const y0 = Math.min(...items.map((it) => it.r.y));
      tables.push({
        headers: grid[0],
        rows: grid.slice(1),
        rect: {
          x: x0,
          y: y0,
          w: Math.max(...items.map((it) => it.r.x + it.r.w)) - x0,
          h: Math.max(...items.map((it) => it.r.y + it.r.h)) - y0,
        },
      });
    }
  });

  // 兼容：真 <table>（Axure 极少导出，保底）
  container.querySelectorAll('table').forEach((table) => {
    const headers: string[] = [];
    const rows: string[][] = [];
    table.querySelectorAll('tr').forEach((row, idx) => {
      const cells = Array.from(row.querySelectorAll('th, td')).map((c) => norm(c.textContent));
      if (idx === 0) headers.push(...cells); else rows.push(cells);
    });
    if (headers.length || rows.length) tables.push({ headers, rows });
  });

  // ─── 3. 控件块：按文档顺序，带类型/名称/行结构 ─────────────

  const blocks: AxureBlock[] = [];
  let idx = 0;
  allWidgets.forEach((el) => {
    if (el.classList.contains('table_cell')) return;          // 单元格已进表格
    if (el.querySelector(':scope > .table_cell')) return;      // 表格容器本身
    if (el.closest('.table_cell')) return;

    const meta = metaOf(el);
    const lines = textLines(el);
    const imgs = el.querySelectorAll('img, svg.generatedImage').length;
    if (!lines && imgs === 0) return;

    idx += 1;
    blocks.push({
      i: idx,
      type: meta?.type || el.className.match(/_([^\s]+)/)?.[1] || '?',
      name: meta && meta.name && meta.name !== 'Unnamed' ? meta.name : '',
      lines: lines || [],
      imgs,
      rect: rectOf(el),
    });
  });

  // ─── 4. 画布型页面空间切分（大内嵌图为锚点聚类） ───────────

  /** 点到矩形的距离（点在矩形内为 0） */
  function distRectToRect(bk: Rect, a: Rect): number {
    const cx = bk.x + bk.w / 2;
    const cy = bk.y + bk.h / 2;
    const dx = Math.max(a.x - cx, 0, cx - (a.x + a.w));
    const dy = Math.max(a.y - cy, 0, cy - (a.y + a.h));
    return Math.hypot(dx, dy);
  }

  function buildSections(): PageSection[] {
    // 不再按「有表格就跳过」豁免：表格 + 界面截图混排的画布页恰恰需要切分，
    // 把 mockup 示例文案归到所属界面；纯表格页通常没有 ≥250×200 的内嵌大图，锚点为空自然不切
    const bigImgs = images.filter((im) => im.width >= 250 && im.height >= 200).length;
    const withRect = blocks.filter((b) => b.rect && (b.lines.length || b.imgs));
    if (!withRect.length) return [];
    const totalChars = withRect.reduce((m, b) => m + b.lines.join('').length, 0);
    if (bigImgs < 3 && totalChars < 3000) return []; // 短文档无需切分

    // 以大内嵌图（手机屏截图）为锚点，文字块按就近原则聚类成界面区块。
    // 不用 XY-cut 空白切分：画布上屏幕之间常有跨屏宽块（箭头/连线）连通，零覆盖缝隙不可靠。
    const anchors = imgRects.filter((p) => p.w >= 250 && p.h >= 200);
    if (!anchors.length) return [];

    const clusters: AxureBlock[][] = anchors.map(() => []);
    const scattered: AxureBlock[] = [];
    withRect.forEach((b) => {
      let best = 0;
      let bestD = Infinity;
      anchors.forEach((a, i) => {
        const d = distRectToRect(b.rect as Rect, a);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (bestD <= 400) clusters[best].push(b); else scattered.push(b);
    });

    const out: PageSection[] = [];
    const anchorSec = new Map<number, number>();
    anchors
      .map((a, i) => ({ a, i }))
      .sort((p, q) => p.a.y - q.a.y || p.a.x - q.a.x)
      .forEach((entry) => {
        const a = entry.a;
        const list = clusters[entry.i].sort((p, q) => {
          const pr = p.rect as Rect;
          const qr = q.rect as Rect;
          return pr.y - qr.y || pr.x - qr.x;
        });
        if (!list.length) return;
        anchorSec.set(entry.i, out.length);
        out.push({
          x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.w), h: Math.round(a.h),
          text: list.map((b) => b.lines.join('\n')).filter(Boolean).join('\n'),
          images: 0,
        });
      });

    // 区块归属回写到控件块：文档生成据此按界面分组，而不是页面级平铺
    clusters.forEach((list, rawIdx) => {
      const s = anchorSec.get(rawIdx);
      if (s === undefined) return;
      list.forEach((b) => { b.sec = s; });
    });

    if (scattered.length) {
      scattered.forEach((b) => { b.sec = -1; });
      const first = scattered[0].rect as Rect;
      out.push({
        x: Math.round(first.x), y: Math.round(first.y), w: 0, h: 0,
        text: '【画布散落文字，未邻近任何界面截图】\n' +
          scattered.map((b) => b.lines.join('\n')).filter(Boolean).join('\n'),
        images: 0,
      });
    }
    return out;
  }

  // ─── 5. 流程图拓扑：连接线 _segN 几何 → 节点/连线 ──────────

  /** 线段两端点：竖线取上/下中，横线取左/右中 */
  function endpoints(r: Rect): { x: number; y: number }[] {
    if (r.h >= r.w) {
      return [{ x: r.x + r.w / 2, y: r.y }, { x: r.x + r.w / 2, y: r.y + r.h }];
    }
    return [{ x: r.x, y: r.y + r.h / 2 }, { x: r.x + r.w, y: r.y + r.h / 2 }];
  }

  function ptDist(p: { x: number; y: number }, r: Rect): number {
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
    return Math.hypot(dx, dy);
  }

  function buildFlow(nodeRects: Map<string, Rect>): AxureFlow | null {
    function nearestNode(p: { x: number; y: number }): { id: string; d: number } | null {
      let best: { id: string; d: number } | null = null;
      nodeRects.forEach((r, id) => {
        const d = ptDist(p, r);
        if (!best || d < best.d) best = { id, d };
      });
      return best;
    }

    const TOL = 60; // 连接线端点与节点的吸附容差（px）
    const edges: AxureFlowEdge[] = [];
    const seen = new Set<string>();

    allWidgets.forEach((el) => {
      const meta = metaOf(el);
      if (!meta || meta.type !== '连接') return;
      const segs = Array.from(el.querySelectorAll('img'))
        .filter((im) => /_seg\d+$/.test(im.id))
        .sort((a, b) => {
          const na = Number(a.id.match(/_seg(\d+)$/)?.[1] || 0);
          const nb = Number(b.id.match(/_seg(\d+)$/)?.[1] || 0);
          return na - nb;
        });
      if (!segs.length) return;

      const r0 = segs[0].getBoundingClientRect();
      const rN = segs[segs.length - 1].getBoundingClientRect();
      if (r0.width < 1 || rN.width < 1) return;
      const box0: Rect = { x: r0.left, y: r0.top, w: r0.width, h: r0.height };
      const boxN: Rect = { x: rN.left, y: rN.top, w: rN.width, h: rN.height };

      const starts = endpoints(box0).map((p) => nearestNode(p));
      const ends = endpoints(boxN).map((p) => nearestNode(p));

      let bestFrom = '';
      let bestTo = '';
      let bestCost = Infinity;
      starts.forEach((s) => {
        if (!s || s.d > TOL) return;
        ends.forEach((e) => {
          if (!e || e.d > TOL || e.id === s.id) return;
          const cost = s.d + e.d;
          if (cost < bestCost) { bestCost = cost; bestFrom = s.id; bestTo = e.id; }
        });
      });
      if (!bestFrom) return;

      const key = `${bestFrom}->${bestTo}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from: bestFrom, to: bestTo, label: (textLines(el) || []).join(' ') });
    });

    if (edges.length < 2) return null;
    return { nodes: [], edges, source: 'dom-connector' };
  }

  // 组装 flow（节点列表在边确定后再过滤，避免孤立文案混入图里）
  const sections = buildSections();
  const nodeRects = new Map<string, Rect>();
  const nodes: AxureFlowNode[] = [];
  blocks.forEach((b) => {
    if (!b.rect || !b.lines.length || b.type === '连接') return;
    const id = `n${b.i}`;
    nodeRects.set(id, b.rect);
    nodes.push({ id, text: b.lines.join(' / '), type: b.type });
  });

  let flow: AxureFlow | null = null;
  if (nodes.length >= 3) {
    const partial = buildFlow(nodeRects);
    if (partial && partial.edges.length >= 2) {
      const linked = new Set<string>();
      partial.edges.forEach((e) => { linked.add(e.from); linked.add(e.to); });
      flow = {
        nodes: nodes.filter((n) => linked.has(n.id)),
        edges: partial.edges,
        source: 'dom-connector',
      };
    }
  }

  const text = blocks
    .map((b) => b.lines.join(' '))
    .filter(Boolean)
    .join('\n');

  return { text, tables, images, sections, blocks, flow };
}
