/**
 * 结果合并模块
 * 负责将多段 VLM 解析结果 + DOM 文字提取结果，合并成完整的页面结构化数据
 *
 * 合并策略：
 * - 流程图：节点去重、连线补全、分支合并
 * - 表格：表格匹配、行去重、截断行补全
 * - 普通页面：组件去重、交互合并、布局拼接
 */
import type { AxureBlock } from './axure-dom.js';
import type {
  FlowBranch,
  FlowEdge,
  FlowNode,
  MergedPage,
  MergedTable,
  MergePageInput,
  PageType,
  VlmFlowchart,
  VlmMeta,
  VlmPageStructure,
  VlmResult,
  VlmTableData,
} from './types.js';

/** 合并后的流程图（含合并过程附加的统计字段） */
type MergedFlowchart = VlmFlowchart & {
  _mergeWarning?: string;
  _segmentCount?: number;
  _nodeCount?: number;
  _edgeCount?: number;
};

/** 表格合并期间用于行去重的内部类型，_rowKeys 会在返回前剥离 */
type TableWithRowKeys = VlmTableData & { _rowKeys?: Set<string> };

// ─── 工具函数 ─────────────────────────────────────────────────

/**
 * DOM 表格标题推断：Axure 画布上的表格没有语义标题，但正上方通常会紧贴一个
 * 标注文本块（如「奖励明细列表(活动结束后手动发放…）」）。
 * 只认正上方、垂直间距 ≤120px、水平方向有重叠、文本 2~80 字的块——实测下方/
 * 远处的文本多属于相邻界面（mockup 标签、下一屏的说明），作标题必错；
 * 超过 80 字的是规则正文不是标题。只填没有 title 的表（VLM 表格自带标题不覆盖）。
 */
export function inferTableTitles(tables: MergedTable[], blocks?: AxureBlock[]): void {
  const candidates = (blocks || []).filter(
    (b) => !!b.rect && b.lines.length > 0
  ) as Array<AxureBlock & { rect: NonNullable<AxureBlock['rect']> }>;
  if (!candidates.length) return;

  const withRect = tables
    .filter((t): t is MergedTable & { rect: NonNullable<MergedTable['rect']> } => !!t.rect && !t.title)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x); // 画布阅读序：靠上的表格优先占用标题块

  for (const table of withRect) {
    const r = table.rect;
    let best: { block: AxureBlock; gap: number } | null = null;
    for (const b of candidates) {
      const br = b.rect;
      const text = b.lines.join(' ').trim();
      if (text.length < 2 || text.length > 80) continue;

      const overlap = Math.min(br.x + br.w, r.x + r.w) - Math.max(br.x, r.x);
      if (overlap < Math.min(r.w * 0.2, 80)) continue; // 水平无明显重叠 → 不像这张表的标注

      if (br.y + br.h > r.y + 30) continue; // 只认正上方（允许 30px 轻微搭界）
      const gap = r.y - (br.y + br.h);
      if (gap > 120) continue;

      if (!best || gap < best.gap) best = { block: b, gap };
    }
    if (best) table.title = best.block.lines.join(' ').trim();
  }
}

/**
 * 计算两个字符串的相似度（0-1）
 * 基于字符级别的 Jaccard 相似度
 */
function stringSimilarity(a: unknown, b: unknown): number {
  if (!a || !b) return 0;
  const s1 = String(a).toLowerCase().trim();
  const s2 = String(b).toLowerCase().trim();
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;

  const set1 = new Set(s1.split(''));
  const set2 = new Set(s2.split(''));
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

/**
 * 文本归一化（用于去重比较）
 */
function normalize(text: unknown): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？\n\r\t]/g, '')
    .trim();
}

/** 过滤掉失败或为空的分段 */
function validSegments(segments: VlmResult[]): VlmResult[] {
  return segments.filter((s) => s && !s._error && !s._parseError);
}

// ─── 流程图合并 ───────────────────────────────────────────────

/**
 * 合并多段流程图解析结果
 */
export function mergeFlowcharts(segments: VlmResult[]): MergedFlowchart {
  const valid = validSegments(segments);
  if (valid.length === 0) {
    return {
      summary: '',
      nodes: [],
      edges: [],
      main_flow: [],
      branches: [],
      exception_flows: [],
      _mergeWarning: segments.length > 0 ? '所有分段解析失败' : '无解析结果',
    };
  }

  if (valid.length === 1) {
    return valid[0];
  }

  // 按段序号排序
  valid.sort((a, b) => (a._segmentIndex || 0) - (b._segmentIndex || 0));

  const mergedNodes: FlowNode[] = [];
  const nodeIdMap: Record<string, string> = {}; // 旧ID -> 新ID
  const nodeTextMap: Record<string, string> = {}; // 归一化文字 -> 新ID

  // 1. 合并节点（去重）
  let nodeCounter = 0;
  for (const seg of valid) {
    for (const node of seg.nodes || []) {
      const normText = normalize(node.text);
      if (nodeTextMap[normText]) {
        // 重复节点，记录 ID 映射
        nodeIdMap[node.id] = nodeTextMap[normText];
      } else {
        const newId = `n${++nodeCounter}`;
        nodeIdMap[node.id] = newId;
        nodeTextMap[normText] = newId;
        mergedNodes.push({ ...node, id: newId });
      }
    }
  }

  // 2. 合并连线（去重 + ID 映射）
  const mergedEdges: FlowEdge[] = [];
  const edgeKeySet = new Set<string>();
  for (const seg of valid) {
    for (const edge of seg.edges || []) {
      const from = nodeIdMap[edge.from] || edge.from;
      const to = nodeIdMap[edge.to] || edge.to;
      const condition = edge.condition || '';
      const key = `${from}->${to}:${normalize(condition)}`;
      if (!edgeKeySet.has(key)) {
        edgeKeySet.add(key);
        mergedEdges.push({ from, to, condition });
      }
    }
  }

  // 3. 段间连线补全（前一段最后一个节点 -> 后一段第一个节点）
  for (let i = 0; i < valid.length - 1; i++) {
    const segA = valid[i];
    const segB = valid[i + 1];
    const nodesA = segA.nodes;
    const nodesB = segB.nodes;
    const lastNodeA = nodesA?.[nodesA.length - 1];
    const firstNodeB = nodesB?.[0];
    if (lastNodeA && firstNodeB) {
      const from = nodeIdMap[lastNodeA.id];
      const to = nodeIdMap[firstNodeB.id];
      if (from && to && from !== to) {
        const key = `${from}->${to}:`;
        if (!edgeKeySet.has(key)) {
          // 检查是否已有从 from 出发的连线，如果有则不补
          const hasFromEdge = mergedEdges.some((e) => e.from === from);
          if (!hasFromEdge) {
            edgeKeySet.add(key);
            mergedEdges.push({ from, to, condition: '' });
          }
        }
      }
    }
  }

  // 4. 合并主流程
  const mergedMainFlow: string[] = [];
  for (const seg of valid) {
    for (const nodeId of seg.main_flow || []) {
      const mappedId = nodeIdMap[nodeId] || nodeId;
      if (!mergedMainFlow.includes(mappedId)) {
        mergedMainFlow.push(mappedId);
      }
    }
  }

  // 5. 合并分支
  const mergedBranches: FlowBranch[] = [];
  const branchNodeMap: Record<string, FlowBranch> = {};
  for (const seg of valid) {
    for (const branch of seg.branches || []) {
      const nodeId = nodeIdMap[branch.node] || branch.node;
      if (!branchNodeMap[nodeId]) {
        branchNodeMap[nodeId] = { node: nodeId, conditions: [], targets: [] };
        mergedBranches.push(branchNodeMap[nodeId]);
      }
      const existing = branchNodeMap[nodeId];
      (branch.conditions || []).forEach((c, i) => {
        const target = branch.targets?.[i];
        const mappedTarget = target ? nodeIdMap[target] || target : '';
        const condKey = normalize(c);
        if (!existing.conditions.some((ec) => normalize(ec) === condKey)) {
          existing.conditions.push(c);
          existing.targets.push(mappedTarget);
        }
      });
    }
  }

  // 6. 合并异常流
  const mergedExceptions: string[] = [];
  for (const seg of valid) {
    for (const exc of seg.exception_flows || []) {
      const norm = normalize(exc);
      if (!mergedExceptions.some((e) => normalize(e) === norm)) {
        mergedExceptions.push(exc);
      }
    }
  }

  // 7. 合并概述
  const summaries = valid
    .map((s) => s.summary)
    .filter(Boolean)
    .join(' ');

  return {
    summary: summaries || '',
    nodes: mergedNodes,
    edges: mergedEdges,
    main_flow: mergedMainFlow,
    branches: mergedBranches,
    exception_flows: mergedExceptions,
    _segmentCount: valid.length,
    _nodeCount: mergedNodes.length,
    _edgeCount: mergedEdges.length,
  };
}

// ─── 表格合并 ─────────────────────────────────────────────────

/**
 * 合并多段表格解析结果
 */
export function mergeTables(segments: VlmResult[]): VlmTableData[] {
  const valid = validSegments(segments);
  if (valid.length === 0) return [];

  const allTables: VlmTableData[] = [];
  for (const seg of valid) {
    for (const table of seg.tables || []) {
      allTables.push({ ...table, _segmentIndex: seg._segmentIndex } as VlmTableData);
    }
  }

  if (allTables.length === 0) return [];
  if (allTables.length === 1) return [allTables[0]];

  // 表格匹配：标题相同或 headers 相似度 > 0.7
  const mergedTables: TableWithRowKeys[] = [];
  for (const table of allTables) {
    let matched: TableWithRowKeys | null = null;
    for (const existing of mergedTables) {
      // 标题匹配
      if (table.title && existing.title && normalize(table.title) === normalize(existing.title)) {
        matched = existing;
        break;
      }
      // headers 相似度匹配
      const headersSim = calcHeadersSimilarity(table.headers, existing.headers);
      if (headersSim > 0.7) {
        matched = existing;
        break;
      }
    }

    if (matched) {
      // 合并行（去重）
      matched._rowKeys ??= new Set<string>();
      for (const row of table.rows || []) {
        const rowKey = normalize(row.join('|'));
        if (!matched._rowKeys.has(rowKey)) {
          matched._rowKeys.add(rowKey);
          matched.rows = [...(matched.rows || []), row];
        }
      }
      // 合并 notes
      if (table.notes && !matched.notes) {
        matched.notes = table.notes;
      } else if (table.notes && matched.notes && !matched.notes.includes(table.notes)) {
        matched.notes += '; ' + table.notes;
      }
    } else {
      mergedTables.push({
        ...table,
        _rowKeys: new Set((table.rows || []).map((r) => normalize(r.join('|')))),
      });
    }
  }

  // 清理内部字段
  return mergedTables.map(({ _rowKeys: _ignored, ...rest }) => rest);
}

/**
 * 计算两个 headers 数组的相似度
 */
function calcHeadersSimilarity(h1?: string[], h2?: string[]): number {
  if (!h1 || !h2 || h1.length === 0 || h2.length === 0) return 0;
  if (h1.length !== h2.length) return 0.3;
  let matchCount = 0;
  for (let i = 0; i < h1.length; i++) {
    if (stringSimilarity(h1[i], h2[i]) > 0.6) matchCount++;
  }
  return matchCount / h1.length;
}

// ─── 普通页面合并 ─────────────────────────────────────────────

/**
 * 合并多段普通页面解析结果
 */
// ─── 播放器工具 UI 过滤 ────────────────────────────────────────

/**
 * 判定文本是否属于原型播放器自带的工具界面（而非产品需求内容）。
 *
 * 实测一份 714 行输出里「3/6」页码出现 33 次、「默认比例」19 次，全部来自
 * Axure 播放器。这类噪音不仅无用，Agent 还可能照着生成页码组件。
 * 只匹配设计工具专有名词，避免误伤产品自身的「顶部栏」「导航栏」等内容。
 */
function isToolUiText(text: unknown): boolean {
  const t = String(text || '');
  if (!t) return false;
  if (/axure|figma|墨刀|mockplus|axshare|sketch/i.test(t)) return true;
  if (/原型(播放器|查看器|工具|分页|文档)|设计工具|文档工具/.test(t)) return true;
  if (/(默认|显示|缩放)比例|缩放(下拉|选项)/.test(t)) return true;
  if (/翻页|上翻|下翻/.test(t)) return true;
  if (/缩略图|画板总览/.test(t)) return true;
  if (/查看器|播放器|分页控件|文档工具栏|设计工具(栏|条)|原型工具(栏|条)/.test(t)) return true;
  // 页码（3/6）：仅在文本较短（组件名/类型）或明确含「页」时判定，避免误伤日期
  if (/\d+\s*\/\s*\d+/.test(t) && (t.length <= 12 || /页/.test(t))) return true;
  return false;
}

/** 过滤字符串数组中的工具 UI 条目 */
function filterToolUiList(list: string[] | undefined): string[] {
  return (list || []).filter((s) => !isToolUiText(s));
}

/** 过滤页面结构中的播放器工具 UI（组件 / 交互 / 状态 / 关键信息） */
export function filterToolUi<T extends VlmPageStructure>(structure: T): T {
  return {
    ...structure,
    components: (structure.components || []).filter(
      (c) => !isToolUiText(c.name) && !isToolUiText(c.type) && !isToolUiText(c.description)
    ),
    interactions: filterToolUiList(structure.interactions),
    states: filterToolUiList(structure.states),
    states_detail: (structure.states_detail || []).filter((s) => !isToolUiText(s.element)),
    key_info: filterToolUiList(structure.key_info),
  };
}

export function mergePageStructures(segments: VlmResult[]): VlmPageStructure & VlmMeta {
  const valid = validSegments(segments);
  if (valid.length === 0) {
    return {
      page_type: '',
      layout: '',
      components: [],
      interactions: [],
      states: [],
      visual_hierarchy: '',
      key_info: [],
    };
  }

  if (valid.length === 1) return filterToolUi(valid[0]);

  valid.sort((a, b) => (a._segmentIndex || 0) - (b._segmentIndex || 0));

  // 合并组件（名称+类型去重）
  const mergedComponents: VlmPageStructure['components'] = [];
  const compKeySet = new Set<string>();
  for (const seg of valid) {
    for (const comp of seg.components || []) {
      const key = normalize(comp.name + '|' + comp.type);
      if (!compKeySet.has(key)) {
        compKeySet.add(key);
        mergedComponents.push(comp);
      }
    }
  }

  // 合并交互（去重）
  const mergedInteractions: string[] = [];
  for (const seg of valid) {
    for (const inter of seg.interactions || []) {
      const norm = normalize(inter);
      if (!mergedInteractions.some((i) => normalize(i) === norm)) {
        mergedInteractions.push(inter);
      }
    }
  }

  // 合并状态（去重）
  const mergedStates: string[] = [];
  for (const seg of valid) {
    for (const state of seg.states || []) {
      const norm = normalize(state);
      if (!mergedStates.some((s) => normalize(s) === norm)) {
        mergedStates.push(state);
      }
    }
  }

  // 合并关键信息（去重）
  const mergedKeyInfo: string[] = [];
  for (const seg of valid) {
    for (const info of seg.key_info || []) {
      const norm = normalize(info);
      if (!mergedKeyInfo.some((i) => normalize(i) === norm)) {
        mergedKeyInfo.push(info);
      }
    }
  }

  // 布局描述拼接
  const layouts = valid
    .map((s, i) => {
      const prefix = valid.length > 1 ? `[第${i + 1}段] ` : '';
      return prefix + (s.layout || '');
    })
    .filter(Boolean);

  // 页面类型：取第一个非空
  const pageType = valid.find((s) => s.page_type)?.page_type || '';

  // 视觉层级拼接
  const visualHierarchy = valid
    .map((s) => s.visual_hierarchy)
    .filter(Boolean)
    .join(' ');

  return filterToolUi({
    page_type: pageType,
    layout: layouts.join('\n'),
    components: mergedComponents,
    interactions: mergedInteractions,
    states: mergedStates,
    visual_hierarchy: visualHierarchy,
    key_info: mergedKeyInfo,
    _segmentCount: valid.length,
  });
}

// ─── DOM 与 VLM 交叉验证 ──────────────────────────────────────

/**
 * DOM 文字与 VLM 结果交叉验证
 */
export function crossValidate(
  domText: string,
  vlmResult: VlmResult,
  type: PageType,
  /** 页面是否已有来自 DOM 的确定性结构化数据（表格/控件块/流程图），用于避免误报「依赖 VLM」 */
  hasDomStructure = false
): { verified: VlmResult; warnings: string[] } {
  const warnings: string[] = [];
  const verified: VlmResult = { ...vlmResult };

  const hasVLM =
    !!vlmResult.nodes?.length ||
    !!vlmResult.tables?.length ||
    !!vlmResult.components?.length ||
    !!vlmResult.interactions?.length ||
    !!vlmResult.states?.length ||
    !!vlmResult.key_info?.length ||
    !!vlmResult.main_flow?.length;

  if (!domText || domText.length < 10) {
    // 有 DOM 结构化数据时不报警：表格/控件块/流程图已来自确定性提取
    if (hasVLM) {
      warnings.push('DOM 文字流较短，VLM 结果无法用 DOM 文字逐项核对，建议人工复核');
    } else if (!hasDomStructure) {
      warnings.push('DOM 文字提取为空，且无 VLM 识别，页面可能无结构化文字内容');
    }
    return { verified, warnings };
  }

  const normDom = normalize(domText);

  if (type === 'flowchart') {
    // 验证节点文字是否在 DOM 中出现
    const unverifiedNodes = verified._unverifiedNodes || [];
    for (const node of vlmResult.nodes || []) {
      const nodeText = normalize(node.text);
      if (nodeText.length > 2 && !normDom.includes(nodeText.slice(0, 4))) {
        // 节点文字不在 DOM 中，可能是 VLM 误识别或 DOM 提取不全
        // 不删除，只标注
        unverifiedNodes.push(node.text);
      }
    }
    if (unverifiedNodes.length > 0) verified._unverifiedNodes = unverifiedNodes;
  }

  if (type === 'table') {
    // 验证表格数据
    const unverifiedCells = verified._unverifiedCells || [];
    for (const table of vlmResult.tables || []) {
      for (const row of table.rows || []) {
        for (const cell of row) {
          const cellNorm = normalize(cell);
          if (cellNorm.length > 3 && !normDom.includes(cellNorm.slice(0, 4))) {
            unverifiedCells.push(cell);
          }
        }
      }
    }
    if (unverifiedCells.length > 0) {
      verified._unverifiedCells = unverifiedCells;
      warnings.push(
        `表格中有 ${unverifiedCells.length} 个单元格内容未在 DOM 文字中找到，可能为图片识别，建议人工复核`
      );
    }
  }

  if (type === 'page') {
    // 验证组件名称
    const unverifiedComponents = verified._unverifiedComponents || [];
    for (const comp of vlmResult.components || []) {
      const compName = normalize(comp.name);
      if (compName.length > 2 && !normDom.includes(compName.slice(0, 3))) {
        unverifiedComponents.push(comp.name ?? '');
      }
    }
    if (unverifiedComponents.length > 0) verified._unverifiedComponents = unverifiedComponents;
  }

  return { verified, warnings };
}

// ─── 数值冲突检测 ─────────────────────────────────────────────

/** 「中文前缀 + 数字 + 单位」三元组，如「初级场20积分开启」→ 初级场 / 20 / 积分 */
interface NumFact {
  key: string;
  value: string;
  unit: string;
}

// 前缀须允许含数字：真实文案常写成「初级场获胜1场 +2积分」，纯中文前缀匹配不到后半段
const NUM_UNIT_SOURCE =
  '([\\u4e00-\\u9fa5A-Za-z0-9]{2,8})\\s*[:：+]?\\s*(\\d+(?:\\.\\d+)?)\\s*(积分|分|钻石|蓝宝石|元|天|个|场|级|%|K|W|M|D)';

function extractNumFacts(text: string, dedupe = true): NumFact[] {
  const re = new RegExp(NUM_UNIT_SOURCE, 'g');
  const out: NumFact[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [, key, value, unit] = m;
    const id = `${key}|${unit}`;
    // dedupe：同一 key+unit 只取首次出现（VLM 多段重复时避免自相打架）
    if (dedupe && seen.has(id)) continue;
    seen.add(id);
    out.push({ key, value, unit });
  }
  return out;
}

/**
 * 检测 DOM 与 VLM 的数值冲突：同一「前缀+单位」在两边取值不同。
 *
 * DOM 表格是确定性提取，为真源；VLM 数值仅用于校验。实测出现过
 * 「初级场 +3 积分（DOM）vs +2 积分（VLM）」这类矛盾被静默采信的情况——
 * 现有 crossValidate 只校验「VLM 文字是否出现在 DOM 中」，查不出数值打架。
 *
 * 冲突不自动修正，只进「待确认项」交由人工判断（宁可多报，不可静默出错）。
 */
export function detectNumericConflicts(domText: string, vlmTexts: string[], max = 8): string[] {
  if (!domText) return [];
  // DOM 侧不去重：同一 key 常有多个不同语义的合法数值（如「初级场」既有 20 积分
  // 开启门槛、又有获胜 +3 积分），只取首次会把不同含义的数字混为一谈
  const domFacts = extractNumFacts(domText, false);
  if (!domFacts.length) return [];

  const domValues = new Map<string, Set<string>>();
  for (const f of domFacts) {
    const id = `${f.key}|${f.unit}`;
    let set = domValues.get(id);
    if (!set) domValues.set(id, (set = new Set()));
    set.add(f.value);
  }

  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const text of vlmTexts) {
    for (const f of extractNumFacts(text)) {
      const id = `${f.key}|${f.unit}`;
      const set = domValues.get(id);
      // VLM 的值在 DOM 中出现过 → 视为一致，不报
      if (!set || set.has(f.value) || seen.has(id)) continue;
      seen.add(id);
      const recorded = [...set].slice(0, 3).join('、');
      conflicts.push(
        `「${f.key}」VLM 识别为 ${f.value}${f.unit}，DOM 中未出现该值（DOM 记录：${recorded}${f.unit}）——以 DOM 为准，请复核`
      );
      if (conflicts.length >= max) return conflicts;
    }
  }
  return conflicts;
}

// ─── 统一合并入口 ─────────────────────────────────────────────

/**
 * 合并一个页面的所有解析结果
 */
export function mergePageResult({
  pageName,
  domText,
  domTables = [],
  images = [],
  imageAnalysis,
  sections,
  blocks,
  flow = null,
  vlmSegments = [],
  type,
  screenshotCount = 0,
}: MergePageInput): MergedPage {
  const warnings: string[] = [];

  // VLM 全段解析失败：显式告警，避免静默降级为纯 DOM/空输出
  if (vlmSegments.length > 0 && vlmSegments.every((s) => !s || s._error || s._parseError)) {
    warnings.push(
      '该页面所有分段 VLM 解析失败，已降级为纯 DOM 输出，建议检查 VLM_API_KEY / 网络后重试'
    );
  }

  // 1. 合并 VLM 多段结果
  let vlmMerged: VlmResult;
  switch (type) {
    case 'flowchart':
      vlmMerged = mergeFlowcharts(vlmSegments);
      break;
    case 'table':
      vlmMerged = { tables: mergeTables(vlmSegments) };
      break;
    case 'page':
    default:
      vlmMerged = mergePageStructures(vlmSegments);
      break;
  }

  // 2. 交叉验证
  const hasDomStructure =
    domTables.length > 0 || (blocks?.length ?? 0) > 0 || !!flow;
  const { verified, warnings: validateWarnings } = crossValidate(
    domText,
    vlmMerged,
    type,
    hasDomStructure
  );
  warnings.push(...validateWarnings);

  // 2.5 数值冲突检测：DOM 为唯一真源，VLM 数值仅用于校验（不覆盖、不自动修正）
  const vlmNumericTexts: string[] = [
    ...(verified.key_info || []),
    ...(verified.interactions || []),
    ...(verified.states || []),
    ...(verified.components || []).flatMap((c) => [c.name ?? '', c.description ?? '']),
    ...(verified.nodes || []).map((n) => n.text ?? ''),
    ...(verified.tables || []).flatMap((t) => (t.rows || []).map((r) => r.join(' '))),
    // 图内文字（P1 新增数据源）：同样会携带与 DOM 冲突的数值，
    // 实测「积分规则图」写着 +1/+2/+3/+5，而 DOM 表格是 1/3/5/15——必须纳入比对
    ...(imageAnalysis || []).flatMap((a) => [a.summary ?? '', ...(a.texts || [])]),
  ].filter(Boolean);
  warnings.push(...detectNumericConflicts(domText, vlmNumericTexts));

  // 内嵌图解析失败必须显式告警：图内文字是数值冲突检测的输入之一，
  // 静默丢图会连带让本该报出的冲突消失（实测「积分规则图」+2/+3/+5 vs DOM 1/3/5/15）
  const failedImageCount = (imageAnalysis || []).filter((a) => a.error).length;
  if (failedImageCount > 0) {
    warnings.push(
      `内嵌图解析失败 ${failedImageCount} 张，未产出图内文字，该部分数值未经校验，建议重跑或人工查看截图`
    );
  }

  // 3. 合并 DOM 表格与 VLM 表格
  // DOM 表格来自 .table_cell 语义网格，是确定性的，排在前面；
  // VLM 表格作为补充（DOM 提取不到时才真正有价值），标记 _source 供人工复核。
  const finalTables: MergedTable[] = [...domTables];
  const vlmTables = verified.tables || [];
  if (vlmTables.length) {
    for (const vTable of vlmTables) {
      // 检查是否与 DOM 表格重复
      const isDuplicate = finalTables.some(
        (dt) => calcHeadersSimilarity(dt.headers, vTable.headers) > 0.8
      );
      if (!isDuplicate) {
        finalTables.push({
          headers: vTable.headers || [],
          rows: vTable.rows || [],
          title: vTable.title,
          notes: vTable.notes,
          _source: 'vlm', // 标记来源
        });
      }
    }
  }

  // DOM 表格标题推断：用表格旁边的标注文本块补全语义标题（VLM 表格已带 title，不覆盖）
  inferTableTitles(finalTables, blocks);

  return {
    pageName,
    type,
    domText,
    tables: finalTables,
    images,
    sections,
    blocks,
    flow,
    imageAnalysis,
    vlmResult: verified,
    warnings,
    _segmentCount: screenshotCount || vlmSegments.length,
    _hasVLM: vlmSegments.length > 0 && !vlmSegments.every((s) => s._error),
  };
}
