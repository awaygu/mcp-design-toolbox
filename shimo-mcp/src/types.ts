// types.ts — 共享类型定义

/** 一行翻译数据：列名（表头）→ 单元格文本 */
export type Row = Record<string, string | number>;

/** 表格数据：表头行 + 数据行 */
export interface SheetData {
  sheet: string;
  headers: string[];
  /** 数据行（不含表头），每行是 列名→文本 映射；行号从 2 起（对应石墨 UI 行号） */
  rows: Array<Row & { _row: number }>;
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
