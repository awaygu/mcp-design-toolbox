// types.ts — 共享类型定义

/** 一行表格数据：列名（表头）→ 单元格文本 */
export type Row = Record<string, string | number>;

/** 表格数据：表头行 + 数据行 */
export interface SheetData {
  sheet: string;
  headers: string[];
  /** 表头行整行为空时自动合成 Col1..ColN 假表头（这些列不视为正式数据列） */
  headersSynthesized?: boolean;
  /** 数据行（不含表头），每行是 列名→文本 映射；行号从 2 起（对应石墨 UI 行号） */
  rows: Array<Row & { _row: number }>;
  /** 传 columns 过滤时返回：每个返回表头对应的原始列序（0-based），与 headers 一一对应 */
  columnIndexes?: number[];
  totalRows: number;
  truncated: boolean;
}

/** 单列读取结果：values 按行号升序，空值保留为 ''（缺行/缺翻译可见） */
export interface ColumnData {
  sheet: string;
  /** 命中的表头原文（表头行全空时为合成的 ColN） */
  column: string;
  /** 原始列序（1-based，与石墨 UI 列号一致） */
  columnIndex: number;
  headersSynthesized?: boolean;
  values: Array<{ _row: number; value: string }>;
  /** values 中非空值的条数 */
  nonEmpty: number;
  totalRows: number;
  truncated: boolean;
}

/** 语言列识别结果 */
export interface LanguageColumn {
  /** 表头原文，如「印尼语」 */
  header: string;
  /** 识别出的语言码，如 in / ms / pt / es / hi / vi / tr / ar / zh / zh-TW / en */
  lang: string;
  /** 列序（0-based，指数据列中的位置） */
  index: number;
}

/** 列出的工作表 */
export interface SheetEntry {
  name: string;
}

/** 导出结果 */
export interface ExportResult {
  taskId: string;
  file: string;
  bytes: number;
  sheetCount?: number;
  sheets?: string[];
}

/** 单元格坐标 */
export interface CellRef {
  row: number;
  col: number;
}
