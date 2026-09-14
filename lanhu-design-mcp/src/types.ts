// 蓝湖设计稿结构化数据类型定义

export type LayerKind = 'text' | 'image' | 'rect';

export interface DesignLayer {
  id?: string;                    // 仅 mock 示例使用；api 模式清洗后不输出（Agent 用 name+坐标定位）
  type: LayerKind;
  x: number;
  y: number;
  w: number;
  h: number;
  name?: string;
  parentPath?: string;            // 父容器名链（'/'分隔），还原被过滤容器层的分组语义
  // text 图层
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  fontFamily?: string;
  lineHeight?: number | string;   // 'auto' 或 px 值
  letterSpacing?: number;         // px
  align?: string;                 // 水平对齐，仅非默认 left 时输出（center|right|justify）
  verticalAlign?: string;         // 垂直对齐，仅非默认 top 时输出（center|bottom）
  italic?: boolean;
  underline?: boolean;
  linethrough?: boolean;
  // 非 text 图层
  fill?: string;
  gradient?: { stops: Array<{ color: string; position: number }> };
  radius?: number;                // 四角统一圆角（逐角不一致时取最大角并标 borderRadius）
  borderRadius?: {                // 逐角圆角（蓝湖按角定义，还原设计必须用逐角值）
    topLeft: number;
    topRight: number;
    bottomLeft: number;
    bottomRight: number;
  };
  border?: {                      // 描边
    color: string;                // rgba
    width: number;                // px
    alignment: 'inside' | 'outside' | 'center';  // 描边位置，CSS 需换算（inside 无需，outside 视觉上比 CSS border 宽 2×width）
  };
  shadow?: {                      // 外阴影（text 层 → CSS text-shadow，其余 → box-shadow；取整 px）
    color: string;
    x: number;
    y: number;
    blur: number;
    spread: number;
  };
  innerShadow?: {                 // 内阴影（CSS box-shadow inset）
    color: string;
    x: number;
    y: number;
    blur: number;
    spread: number;
  };
  // 图层透明度（仅无 fill/gradient/color 的图层导出，如 image 切图——有颜色的图层透明度已烘进 rgba
  // alpha，再叠此字段会双重叠加；image 图层 Agent 需自行写 CSS opacity）
  opacity?: number;
  // 切图（hasExportImage 的图层）：开发时下载引用
  imageUrl?: string;
  hasExportImage?: boolean;
}

export interface DesignMeta {
  rawLayerCount: number;          // 全树遍历的图层数（含被清洗的容器层）
  totalLayerCount: number;
  droppedLayerCount?: number;     // 清洗过滤掉的无样式容器层数
  dedupedLayerCount?: number;     // 二次清洗：逐字段一致的堆叠副本层数（保留顶层）
  outsideCanvasLayerCount?: number; // 二次清洗：完全在画布外、不可见的层数
  occludedLayerCount?: number;    // 二次清洗：被上方不透明纯色层完全遮挡的层数
  sliverLayerCount?: number;      // 二次清洗：可见面积占比过低（默认 <25%，LANHU_MIN_VISIBLE_FRACTION 可调）只露窄条的层数
  fragmentLayerCount?: number;    // 二次清洗：碎片装饰带（同容器一排首尾相接的微小矢量段，LANHU_PRUNE_FRAGMENTS=0 可关）剔除的层数
  backupLayerCount?: number;      // 「备份/backup」命名的备用层剔除数（含子树）
  booleanOperandLayerCount?: number; // 布尔运算（Subtract/Union 等）操作数子层的折叠数（不独立渲染）
  payloadBytes?: number;          // 清洗后 layers JSON 字节数（Agent 感知数据大小）
  docName?: string;
  capturedFrom?: string;
  fallback?: string;
  note?: string;
}

export interface DesignResult {
  source: 'api' | 'mock';
  url?: string;
  name?: string;
  viewport: { width: number; height: number };
  layers: DesignLayer[];
  meta: DesignMeta;
  visionAnalysis?: unknown;
  coverImageBase64?: string;
  // 切图清单（hasExportImage 的图层，开发时下载引用）
  slices?: SliceInfo[];
}

export interface SectorDesign {
  image_id: string;
  name: string;
}

export interface SectorInfo {
  id: string;
  name: string;
  designCount: number;
  designs: SectorDesign[];
}

// 切图信息（一个设计稿的导出图层）
export interface SliceInfo {
  name: string;
  imageUrl?: string;    // PNG。collectSlices 内部收集时必有；fetch_design 输出前剥除（下载走 download_slices 按 sliceNames 重取）
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Credentials {
  cookie?: string;
}
