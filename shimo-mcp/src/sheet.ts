// sheet.ts — 表格数据整形：表头识别、行/列/行号过滤，输出结构化数据（纯结构层，不做业务加工）
import { colLetter, readRange, readSheetRaw, translateSheetReadError, type Credentials } from './shimo-client.js';
import type { ColumnData, SheetData } from './types.js';

/** 单元格 → 文本（数字/公式结果转字符串；null/undefined → ''） */
function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    // 石墨 values API 偶发返回对象（富文本/链接），尽力取文本字段
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
  let rawRows: unknown[][];
  let paginated: boolean;
  try {
    ({ rows: rawRows, truncated: paginated } = await readSheetRaw(guid, sheet, creds.cookie, opts.maxCol ?? 26));
  } catch (e) {
    throw await translateSheetReadError(e, guid, sheet, creds.cookie);
  }
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
    ...(keepCols ? { columnIndexes: keepCols } : {}),
    rows: dataRows,
    totalRows: total,
    truncated,
  };
}

// 1 列 × 4900 行 < 5000 单元格/次；8 块 ≈ 3.9 万行
const COLUMN_CHUNK_ROWS = 4900;
const COLUMN_MAX_CHUNKS = 8;
const EMPTY_TAIL_ROWS = 50; // 连续空单元格数视为列数据结束

/**
 * 读单列：column 为表头名（忽略大小写）或第几列（1-based）。
 * 先读表头行解析列号，再按列分块直读；空值保留 ''，_row 与石墨行号一致。
 */
export async function readColumn(
  guid: string,
  sheet: string,
  creds: Credentials,
  column: string | number,
  opts: { rows?: number[]; limit?: number; maxCol?: number } = {}
): Promise<ColumnData> {
  const maxCol = opts.maxCol ?? 26;
  const wantedRows = opts.rows?.length ? opts.rows : null;
  const limit = opts.limit === undefined ? 500 : opts.limit;

  // 解析目标列（数字列号也读表头，用于返回列名）
  let headerRow: unknown[] | undefined;
  try {
    [headerRow] = await readRange(guid, sheet, 1, 1, maxCol, creds.cookie);
  } catch (e) {
    throw await translateSheetReadError(e, guid, sheet, creds.cookie);
  }
  const headerCells = (headerRow || []).map(cellText);
  const headerEmpty = !headerCells.some((h) => h.trim());

  let colIdx: number;
  if (typeof column === 'number') {
    if (column < 1 || column > maxCol) {
      throw new Error(`列号需在 1~${maxCol}（A:${colLetter(maxCol - 1)}）范围内，收到 ${column}。可用 maxCol 参数扩大读取列数`);
    }
    colIdx = column - 1;
  } else {
    const wanted = String(column).trim().toLowerCase();
    colIdx = headerCells.findIndex((h) => h.trim().toLowerCase() === wanted);
    if (colIdx === -1) {
      const avail = headerEmpty
        ? Array.from({ length: maxCol }, (_, i) => `Col${i + 1}`).join('、')
        : headerCells.map((h, i) => (h.trim() ? `${i + 1}.${h.trim()}` : '')).filter(Boolean).join('、');
      throw new Error(`列「${column}」不存在。该表可用列（第几列:表头）：${avail}`);
    }
  }
  const header = headerEmpty || !headerCells[colIdx]?.trim() ? `Col${colIdx + 1}` : headerCells[colIdx].trim();

  // 只读该列：rows 指定时一段 range 覆盖再筛；否则从第 2 行分块扫描
  const values: ColumnData['values'] = [];
  let nonEmpty = 0;
  let truncated = false;

  const pushCell = (rowNo: number, v: unknown): boolean => {
    const text = cellText(v);
    values.push({ _row: rowNo, value: text });
    return Boolean(text.trim());
  };

  if (wantedRows) {
    const sorted = [...new Set(wantedRows)].filter((r) => r >= 2).sort((a, b) => a - b);
    if (sorted.length) {
      const start = sorted[0];
      const end = sorted[sorted.length - 1];
      let cells: unknown[][];
      try {
        cells = await readRange(guid, sheet, start, end, colIdx + 1, creds.cookie, colIdx);
      } catch (e) {
        throw await translateSheetReadError(e, guid, sheet, creds.cookie);
      }
      const want = new Set(sorted);
      for (let r = start; r <= end; r++) {
        if (want.has(r) && pushCell(r, (cells[r - start] || [])[0])) nonEmpty++;
      }
    }
  } else {
    let start = 2;
    let consecutiveEmpty = 0;
    for (let chunk = 1; chunk <= COLUMN_MAX_CHUNKS; chunk++) {
      const end = start + COLUMN_CHUNK_ROWS - 1;
      let cells: unknown[][];
      try {
        cells = await readRange(guid, sheet, start, end, colIdx + 1, creds.cookie, colIdx);
      } catch (e) {
        // 首块失败是真错误；后续块失败多为越界，视为结束
        if (chunk === 1) throw await translateSheetReadError(e, guid, sheet, creds.cookie);
        break;
      }
      if (!cells.length) break;
      let stop = false;
      for (let i = 0; i < cells.length; i++) {
        const rowNo = start + i;
        if (pushCell(rowNo, (cells[i] || [])[0])) {
          nonEmpty++;
          consecutiveEmpty = 0;
          if (limit > 0 && nonEmpty >= limit) {
            truncated = true;
            stop = true;
            break;
          }
        } else if (++consecutiveEmpty >= EMPTY_TAIL_ROWS) {
          stop = true;
          break;
        }
      }
      if (stop) break;
      if (cells.length < COLUMN_CHUNK_ROWS) break;
      start += COLUMN_CHUNK_ROWS;
      if (chunk === COLUMN_MAX_CHUNKS) truncated = true;
    }
  }

  return {
    sheet,
    column: header,
    columnIndex: colIdx + 1,
    ...(headerEmpty ? { headersSynthesized: true } : {}),
    values,
    nonEmpty,
    totalRows: values.length,
    truncated,
  };
}
