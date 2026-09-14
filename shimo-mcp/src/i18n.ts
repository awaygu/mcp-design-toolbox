// i18n.ts — 表格数据整形：表头识别、行/语言/行号过滤，输出对 Agent 友好的结构
import { readSheetRaw, type Credentials } from './shimo-client.js';
import { detectLanguageColumns } from './langmap.js';
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
  /** 只保留这些语言列（语言码或表头名，如 ["en","ja"] 或 ["英文","日语"]）。默认全部列 */
  languages?: string[];
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

  const langCols = detectLanguageColumns(finalHeaders);

  // 语言过滤：入参可传语言码（en/in/…）或表头原文（英文/印尼语/…）
  let keepCols: number[] | null = null;
  if (opts.languages?.length) {
    const wanted = new Set(opts.languages.map((s) => s.trim().toLowerCase()));
    keepCols = [];
    finalHeaders.forEach((h, i) => {
      const detected = langCols.find((c) => c.index === i);
      if (wanted.has(h.trim().toLowerCase()) || (detected && wanted.has(detected.lang.toLowerCase()))) {
        keepCols!.push(i);
      }
    });
    if (!keepCols.length) {
      throw new Error(
        `语言过滤无匹配列：${opts.languages.join('/')}。该表可用列：${finalHeaders
          .map((h, i) => (h.trim() ? h : `Col${i + 1}`))
          .filter(Boolean)
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
    rows: dataRows,
    totalRows: total,
    truncated,
  };
}

export interface ToLanguageMapOptions {
  /** 显式指定 key 列（表头名）。传入时用该列的值作为 key；不传时使用内置 txt_ 规则生成 */
  keyColumn?: string;
}

export interface LanguageMapResult {
  translations: Record<string, Record<string, string>>;
  /** 影响使用的提示，如未找到中文列、各语言 key 集合不一致 */
  warnings: string[];
  /** 仅中文有值被判定为分组行而跳过的行数 */
  skippedGroups: number;
  /** 存在缺填语言列的行（空列已用英文兜底；英文也空的列其 key 在对应语言缺失）。用于反查漏填。
   *  key 为中文原文（人读语义，便于定位补填）；无中文时退化用英文原文，再无则用生成 key。传 keyColumn 时用该列的值。 */
  missing: Array<{ row: number; key: string; langs: string[] }>;
}

/**
 * key 生成规则（与 multilingual-excel-converter skill 的 convert.js 一致）：
 *   txt_ + 中文首字符 charCode + 石墨行号（如「登录」在第 5 行 → txt_30331_5）；
 *   中文缺失/为空时退化为 txt_row_行号。
 * 多行文案（含换行）按行拆成 key_0、key_1…（空行剔除，各语言独立拆分）。
 * 传 keyColumn 时用该列的值作为 key（多行仍拆分）。
 *
 * 业务行语义（按翻译表实际用法约定）：
 *   - 只有中文有值、其余语言列全空 → 该行是分组行（小节标题），不导出；
 *   - 其他语言列有值缺失（中文/繁体/英文在、印尼语等空）→ 空列用英文值兜底。
 */
export function toLanguageMap(data: SheetData, opts: ToLanguageMapOptions = {}): LanguageMapResult {
  let keyCol: string | undefined;
  if (opts.keyColumn) {
    keyCol = data.headers.find((h) => h === opts.keyColumn || h.trim() === opts.keyColumn!.trim());
    if (!keyCol) {
      throw new Error(`keyColumn「${opts.keyColumn}」不在表头中。可用表头：${data.headers.filter(Boolean).join('、')}`);
    }
  }
  // 中文取值列：zh / zh-CN（繁体 zh-TW 不算）
  const zhCol = data.headers.find((h) => /^zh(-CN)?$/.test(detectLanguageColumns([h])[0]?.lang || ''));

  // 语言列：同语言码取第一个出现的列；key 列与 UI 列排除
  const langHeaders: Array<{ lang: string; header: string }> = [];
  const seen = new Set<string>();
  for (const h of data.headers) {
    if (h === keyCol || h === 'UI') continue;
    const d = detectLanguageColumns([h])[0];
    if (!d || d.lang === '_key' || d.lang === '_ui' || seen.has(d.lang)) continue;
    seen.add(d.lang);
    langHeaders.push({ lang: d.lang, header: h });
  }

  const translations: Record<string, Record<string, string>> = {};
  for (const { lang } of langHeaders) translations[lang] = {};

  const isZhLang = (lang: string) => /^zh(-CN)?$/.test(lang);
  let skippedGroups = 0;
  const missing: LanguageMapResult['missing'] = [];

  for (const row of data.rows) {
    const vals = langHeaders.map(({ lang, header }) => ({ lang, text: String(row[header] ?? '').trim() }));
    const zhVal = zhCol ? String(row[zhCol] ?? '').trim() : '';
    const enText = vals.find((v) => v.lang === 'en')?.text || '';

    // 分组行：中文有值且英文与其他语言列全空 → 小节标题，不导出
    if (zhVal && !enText && !vals.some((v) => !isZhLang(v.lang) && v.text)) {
      skippedGroups++;
      continue;
    }

    const key = keyCol
      ? String(row[keyCol] ?? '').trim() || `txt_row_${row._row}`
      : zhVal
        ? `txt_${zhVal.charCodeAt(0)}${row._row}`
        : `txt_row_${row._row}`;

    // 缺填检测：非中文语言列有空的即记录（不论英文能否兜底——兜底是补救，漏填是事实）。
    // key 用中文原文（人读语义）；keyColumn 模式下该列值本身即语义标识，原样使用
    const missed = vals.filter((v) => !isZhLang(v.lang) && !v.text).map((v) => v.lang);
    if (missed.length) {
      missing.push({
        row: row._row,
        key: keyCol ? key : zhVal || enText || key,
        langs: missed,
      });
    }

    for (const { lang, text } of vals) {
      // 规则：除中文/英文外的语言列缺值时用英文兜底（中文缺就是缺，不兜底）
      const finalText = !text && !isZhLang(lang) && lang !== 'en' ? enText : text;
      assignValue(translations[lang], key, finalText);
    }
  }

  const warnings: string[] = [];
  if (!keyCol && !zhCol && data.rows.length) {
    warnings.push('未找到中文列（表头需含「中文」），全部 key 退化为 txt_row_行号。可用 keyColumn 显式指定 key 列。');
  }
  const counts = Object.entries(translations).map(([lang, kv]) => `${lang}:${Object.keys(kv).length}`);
  if (new Set(counts.map((c) => c.split(':')[1])).size > 1) {
    warnings.push(`各语言 key 数量不一致（${counts.join('、')}），多为个别语言缺翻译或多行行数不同，建议核对原文。`);
  }
  if (missing.length) {
    const detail = missing.slice(0, 10).map((m) => `第${m.row}行(${m.key})缺 ${m.langs.join('、')}`).join('；');
    warnings.push(
      `检测到 ${missing.length} 行存在漏填的语言列，空列已用英文兜底（英文也空的列对应 key 缺失），请核对填写：${detail}${missing.length > 10 ? ` …等共 ${missing.length} 行（完整清单见 missing 字段）` : ''}`
    );
  }
  return { translations, warnings, skippedGroups, missing };
}

/** 单值写入：含换行的文案拆成 key_0、key_1…（空行剔除）；空值跳过不产生 key */
function assignValue(target: Record<string, string>, key: string, raw: string): void {
  const text = raw.trim();
  if (!text) return;
  if (!text.includes('\n')) {
    target[key] = text;
    return;
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    target[`${key}_${i}`] = line;
  });
}
