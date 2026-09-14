/**
 * 全局共享类型定义
 *
 * 数据流向：crawler（DOM/截图） → vlm（视觉解析） → merger（合并校验）
 *          → doc-generator（Markdown） → index（MCP 工具）
 * 这里集中声明各阶段之间传递的结构，避免各模块自定义「鸭子类型」。
 */

// ─── 基础枚举 ─────────────────────────────────────────────────

/** 页面解析类型：流程图 / 配置表 / 普通页面 */
export type PageType = 'flowchart' | 'table' | 'page' | 'image';

/** 文档详细程度 */
export type DetailLevel = 'summary' | 'standard' | 'full';

// ─── crawler：目录树 ──────────────────────────────────────────

/**
 * 目录树扁平节点。TDesign 树为扁平渲染，DOM 顺序即大纲顺序。
 * domIndex 为原始 DOM 序号（可能含无文字节点），与大纲数组下标不可混用。
 */
export interface TreeNode {
  name: string;
  /** 层级，取自 style 的 --level */
  level: number;
  /** 有 .total-text（子项数量标记）的节点为分组 */
  isGroup: boolean;
  /** 在 .t-tree__item 集合中的下标，用于点击定位 */
  domIndex: number;
}

/** 带完整路径的目录节点：path = 祖先分组名 + 自身，用 / 连接 */
export interface OutlineNode extends TreeNode {
  path: string;
  /** 非分组节点的序号（0-based），分组为 undefined */
  pageIndex?: number;
}

/** 目录树匹配结果（matchTreeTarget） */
export type TreeMatchResult<T> =
  | { ok: true; target: T }
  | { ok: false; reason: string };

/** 导航结果：frameChanged=false 表示点击后 iframe 未切换（纯展开类分组节点） */
export type NavigationResult =
  | { ok: true; frameChanged: boolean }
  | { ok: false; reason: 'stale_outline' };

// ─── crawler：页面内容 ────────────────────────────────────────

/** 页面内嵌原型图元数据（设计稿/插画类大图，DOM 文字提取不到） */
export interface PageImage {
  src: string;
  alt: string;
  width: number;
  height: number;
  /** 文档坐标（含滚动偏移），用于定向裁剪与空间定位 */
  x?: number;
  y?: number;
  /** 在所有 <img> 中的原始序号，供 Node 侧按序号定位元素做定向截图 */
  imgIndex?: number;
  /**
   * 是否为内容图：已排除 Axure 连接线段（*_segN.svg）与微小装饰图标。
   * 只有内容图才值得单独送视觉模型解析。
   */
  isContent?: boolean;
  /** 定向截图落盘路径（captureContentImageShots 填充） */
  localPath?: string;
}

/** 结构化视觉状态：{元素, 状态, 触发条件} */
export interface VisualState {
  element: string;
  state: string;
  condition?: string;
}

/** DOM 提取的表格 */
export interface DomTable {
  headers: string[];
  rows: string[][];
  /** 表格边界矩形（.table_cell 的 viewbox 画布坐标聚合），用于标题推断与空间定位；真 <table> 兜底提取时缺省 */
  rect?: { x: number; y: number; w: number; h: number } | null;
}

import type { AxureBlock, AxureFlow } from './axure-dom.js';

/** 从 Axure iframe 中提取的纯文本内容 */
export interface ExtractedContent {
  text: string;
  tables: DomTable[];
  images: PageImage[];
  /** 画布型页面的空间切分区块（XY-cut 按空白带切分），无则缺省 */
  sections?: PageSection[];
  /** 按文档顺序排列的控件块（带控件类型与行结构） */
  blocks?: AxureBlock[];
  /** 连接线几何还原的流程图拓扑，非流程图页为 null */
  flow?: AxureFlow | null;
}

/** 画布空间切分出的区块（通常对应一个界面/弹窗） */
export interface PageSection {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** 区块内嵌的大图数量（如手机屏截图） */
  images?: number;
}

// ─── screenshot ───────────────────────────────────────────────

/** 分段截图结果 */
export interface ScreenshotResult {
  /** 分段截图文件的绝对路径（按顺序） */
  segments: string[];
  totalHeight: number;
  segmentCount: number;
  isSegmented: boolean;
}

// ─── crawler → pipeline 的页面原始数据 ────────────────────────

/** crawler 产出的页面数据，是 pipeline 的输入 */
export interface CrawledPage extends ScreenshotResult {
  pageName: string;
  text: string;
  tables: DomTable[];
  images: PageImage[];
  sections?: PageSection[];
  /** 按文档顺序排列的控件块（带控件类型与行结构） */
  blocks?: AxureBlock[];
  /** 连接线几何还原的流程图拓扑 */
  flow?: AxureFlow | null;
  /** 内容图定向截图（已过滤连接线段与图标），供内嵌图单独解析 */
  imageShots?: PageImage[];
  /** 导航失败等原因写入，pipeline 会据此直接产出失败结果 */
  error?: string;
}

// ─── vlm 解析结果 ─────────────────────────────────────────────

export type FlowNodeType =
  | 'start'
  | 'end'
  | 'process'
  | 'decision'
  | 'subflow'
  | 'io';

export interface FlowNode {
  id: string;
  text: string;
  type: FlowNodeType | string;
}

export interface FlowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface FlowBranch {
  node: string;
  conditions: string[];
  targets: string[];
}

/** flowchart 类解析结果 */
export interface VlmFlowchart {
  summary?: string;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  main_flow?: string[];
  branches?: FlowBranch[];
  exception_flows?: string[];
}

export interface VlmTableData {
  title?: string;
  headers?: string[];
  rows?: string[][];
  notes?: string;
}

/** table 类解析结果 */
export interface VlmTableResult {
  tables?: VlmTableData[];
  other_data?: string[];
}

export interface VlmComponent {
  name?: string;
  type?: string;
  position?: string;
  description?: string;
}

/** page 类解析结果 */
export interface VlmPageStructure {
  page_type?: string;
  layout?: string;
  components?: VlmComponent[];
  interactions?: string[];
  states?: string[];
  visual_hierarchy?: string;
  key_info?: string[];
  /** 结构化状态 {元素,状态,触发条件}：存在时优先于 states 渲染，states 保留兼容旧输出 */
  states_detail?: VisualState[];
}

/**
 * VLM 输出的内部标记字段。
 * 下划线前缀代表「非模型产出」，由解析/合并流程附加，用于失败判定与交叉验证。
 */
export interface VlmMeta {
  /** 分段序号（1-based），多段合并时用于排序 */
  _segmentIndex?: number;
  _imagePath?: string;
  _type?: PageType;
  /** 请求/网络层错误 */
  _error?: string;
  /** 返回内容不是合法 JSON */
  _parseError?: boolean;
  /** 非法 JSON 的原始返回，便于排查 */
  _raw?: string;
  /** 以下为 merger 交叉验证产出的待复核项 */
  _unverifiedNodes?: string[];
  _unverifiedCells?: string[];
  _unverifiedComponents?: string[];
  /** 合并告警（如所有分段解析失败） */
  _mergeWarning?: string;
  _segmentCount?: number;
  _nodeCount?: number;
  _edgeCount?: number;
}

/**
 * VLM 单段解析结果。三类 Prompt 产出的字段做成了联合——
 * 具体字段是否存在取决于 type，使用处按类型分支访问。
 */
/** 内嵌图定向解析结果（type='image'）：只提取 DOM 拿不到的图内文字 */
export interface VlmImageContent {
  /** 这张图是什么（如「App 界面截图」「活动规则海报」） */
  summary?: string;
  /** 图内可见文字，按阅读序 */
  texts?: string[];
  /** 是否主要是占位/示例数据（人气值、余额、时间戳等） */
  is_placeholder?: boolean;
  /** 是否有值得开发关注的真实需求信息 */
  note?: string;
}

export type VlmResult = VlmFlowchart &
  VlmTableResult &
  VlmPageStructure &
  VlmImageContent &
  VlmMeta;

/** 单张内嵌图的解析产物（图 + 提取到的文字） */
export interface ImageAnalysis {
  src: string;
  localPath: string;
  summary?: string;
  texts: string[];
  isPlaceholder?: boolean;
  note?: string;
  error?: string;
}

/** 提交给全局并发队列的单段解析任务 */
export interface SegmentTask {
  imagePath: string;
  type: PageType;
  segmentIndex: number;
  totalSegments: number;
  pageText?: string;
  /** 背景上下文（需求分组/页面名），注入 VLM prompt 作业务语义参考 */
  context?: string;
}

/** 单张图片解析的选项 */
export interface AnalyzeOptions {
  segmentIndex?: number;
  totalSegments?: number;
  pageText?: string;
  context?: string;
}

// ─── merger 合并结果 ──────────────────────────────────────────

/** 合并后的表格；_source=vlm 表示由视觉模型从图片识别，需人工复核 */
export interface MergedTable extends DomTable {
  title?: string;
  notes?: string;
  _source?: 'vlm';
}

/** 合并后的完整页面数据，doc-generator 与 MCP 工具直接消费它 */
export interface MergedPage {
  pageName: string;
  type: PageType;
  domText: string;
  tables: MergedTable[];
  images: PageImage[];
  /** 画布型页面的空间切分区块（经管线透传） */
  sections?: PageSection[];
  /** 结构化控件块（DOM 确定性提取） */
  blocks?: AxureBlock[];
  /** 连接线几何还原的流程图（DOM 确定性提取） */
  flow?: AxureFlow | null;
  /** 内嵌图定向解析结果（图内文字，DOM 提取不到） */
  imageAnalysis?: ImageAnalysis[];
  vlmResult: VlmResult;
  warnings: string[];
  _segmentCount: number;
  _hasVLM: boolean;
}

/** mergePageResult 的入参 */
export interface MergePageInput {
  pageName: string;
  domText: string;
  domTables?: DomTable[];
  images?: PageImage[];
  sections?: PageSection[];
  blocks?: AxureBlock[];
  flow?: AxureFlow | null;
  /** 内嵌图定向解析结果（图内文字） */
  imageAnalysis?: ImageAnalysis[];
  vlmSegments?: VlmResult[];
  type: PageType;
  screenshotCount?: number;
}

// ─── 缓存 ─────────────────────────────────────────────────────

/** VLM 结果缓存键的构成要素 */
export interface CacheKeyParams {
  url: string;
  pageName: string;
  imagePaths?: string[];
  type: PageType;
  vlmVersion?: string;
}

export interface CacheStats {
  total: number;
  size: number;
  failed?: boolean;
}

// ─── pipeline ─────────────────────────────────────────────────

export interface ProcessOptions {
  vlmEnabled?: boolean;
  concurrency?: number;
  /** 每页处理完成的回调，CLI 用它打印进度 */
  onPageDone?: (
    pageName: string,
    info: { cached: boolean; segments: number; vlmSkipped: boolean; result: MergedPage }
  ) => void;
  /** VLM 分段解析进度（done/total 为分段粒度），MCP 层转发为 progress 通知 */
  onProgress?: (message: string) => void;
  /** 按页生成背景上下文（需求分组/页面名），注入该页所有分段的 VLM prompt */
  contextFor?: (page: CrawledPage) => string;
}
