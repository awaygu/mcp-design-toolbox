// sheet.ts — 表格数据整形：表头识别、行/列/行号过滤，输出结构化数据（纯结构层，不做业务加工）
import { readSheetRaw, type Credentials } from './shimo-client.js';
import type { SheetData } from './types.js';

/** 单元格 → 文本（数字/公式结果转字符串；null/undefined → ''） */
function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    // 石墨 values API 偶发返回对象形态（富文本/链接），尽力取文本字段
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.value === 'string') return o.value;
    return JSON.stringify(v);
  }
  return String(v);
}

export interface ReadSheetOptions {
  /** 只保留这些行（石墨 UI 行号，1-based，含表头行 1；传行号时表头始终带出） */
  rows?: number[];
  /** 只保留这些列（表头原名，忽略大小写；或第几列，1-based，如 ["英文", 3]）。默认全部列 */
  columns?: Array<string | number>;
  /** 数据行最多返回多少条（默认 200；0 = 不限）。超出时 truncated=true，用 rows 参数按行号取余下数据 */
  limit?: number;
  /** 额外读取列数（默认 26 = A:Z） */
  maxCol?: number;
}

/**
 * 读一个工作表并整形。
 * 表头 = 第 1 行非空单元格；数据行 = 其后所有非空行（完全空白的行跳过）。
 */
export async function readSheet(guid: string, sheet: string, creds: Credentials, opts: ReadSheetOptions = {}): Promise<SheetData> {
  const { rows: rawRows, truncated: paginated } = await readSheetRaw(guid, sheet, creds.cookie, opts.maxCol ?? 26);
  if (!rawRows.length) {
    return { sheet, headers: [], rows: [], totalRows: 0, truncated: false };
  }

  const headerRow = rawRows[0] || [];
  const headers = headerRow.map(cellText);
  // 表头全空：退化为 Col1/Col2… 合成表头
  const hasHeader = headers.some((h) => h.trim());
  const finalHeaders = hasHeader ? headers : headers.map((_, i) => `Col${i + 1}`);

  // 列过滤：表头原名（忽略大小写）或第几列（1-based）
  let keepCols: number[] | null = null;
  if (opts.columns?.length) {
    keepCols = [];
    for (const c of opts.columns) {
      if (typeof c === 'number') {
        const idx = c - 1;
        if (idx >= 0 && idx < finalHeaders.length && !keepCols.includes(idx)) keepCols.push(idx);
        continue;
      }
      const wanted = String(c).trim().toLowerCase();
      finalHeaders.forEach((h, i) => {
        if (h.trim().toLowerCase() === wanted && !keepCols!.includes(i)) keepCols!.push(i);
      });
    }
    if (!keepCols.length) {
      throw new Error(
        `列过滤无匹配列：${opts.columns.join('/')}。该表可用列（第几列:表头）：${finalHeaders
          .map((h, i) => `${i + 1}.${h.trim() || `Col${i + 1}`}`)
          .join('、')}`,
      );
    }
  }

  const wantedRows = opts.rows?.length ? new Set(opts.rows) : null;
  const limit = opts.limit === undefined ? 200 : opts.limit;
  const dataRows: SheetData['rows'] = [];
  let total = 0;
  let truncated = paginated;

  for (let i = 1; i < rawRows.length; i++) {
    const cells = (rawRows[i] || []).map(cellText);
    if (!cells.some((c) => c.trim())) continue; // 整行空白跳过
    total++;
    const rowNo = i + 1; // 石墨 UI 行号（1-based）
    // 行号过滤：表头行恒为 1，数据行按传入行号集合过滤
    if (wantedRows && !wantedRows.has(rowNo)) continue;
    const row: SheetData['rows'][number] = { _row: rowNo };
    finalHeaders.forEach((h, ci) => {
      if (keepCols && !keepCols.includes(ci)) return;
      const key = h.trim() || `Col${ci + 1}`;
      const v = cells[ci] ?? '';
      if (v) row[key] = v;
    });
    dataRows.push(row);
    if (limit > 0 && dataRows.length >= limit) {
      truncated = true;
      break;
    }
  }

  return {
    sheet,
    headers: keepCols ? keepCols.map((i) => finalHeaders[i].trim() || `Col${i + 1}`) : finalHeaders.filter((h, i) => h.trim() || !!rawRows.some((r) => r[i])),
    headersSynthesized: !hasHeader || undefined,
    rows: dataRows,
    totalRows: total,
    truncated,
  };
}
