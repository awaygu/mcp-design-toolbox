// i18n.ts — i18n 导出转换：列映射（可配置）、key 生成、缺值兜底
import { detectLanguageColumns, type ColumnMapRule } from './langmap.js';
import type { SheetData } from './types.js';

export interface ToLanguageMapOptions {
  /** 显式指定 key 列（表头名）。传入时用该列的值作为 key；不传时使用内置 txt_ 规则生成 */
  keyColumn?: string;
  /** 缺值兜底语言码（默认 en）；传 none/空串关闭兜底，空值保持缺失 */
  fallbackLang?: string;
  /** 仅基准语言列有值、其他语言列全空的行视为分组行跳过（默认 true）；设 false 按漏填导出并记入 missing */
  groupRows?: boolean;
  /** 列映射配置表：表头 → 语言码（exact/regex/fuzzy），优先于内置识别规则 */
  columnMap?: ColumnMapRule[];
  /** 只导出这些列（表头原名或语言码）。默认全部识别到的语言列 */
  columns?: Array<string | number>;
}

export interface LanguageMapResult {
  translations: Record<string, Record<string, string>>;
  /** 影响使用的提示，如未找到中文列、各语言 key 集合不一致 */
  warnings: string[];
  /** 分组行跳过的行数 */
  skippedGroups: number;
  /** 缺填语言列的行（空列已按兜底语言补，兜底也缺的 key 对应语言缺失）。用于反查漏填 */
  missing: Array<{ row: number; key: string; langs: string[] }>;
}

/**
 * key 生成：默认以「从左到右第一个有表头且有数据的列」为基准列（整表确定一次；无表头的列不能作为基准列，
 * 整表无表头时全部 key 退化 txt_row_行号），key = txt_ + 该行基准单元格首字符 charCode + 行号直接拼接，
 * 基准单元格缺数据 → txt_row_行号 并计入 missing；多行文案按行拆 key_0、key_1…；传 keyColumn 用该列值作 key。
 * 缺值：非基准语言（zh）列空时用 fallbackLang（默认 en）兜底，同时记入 missing；'none' 关闭兜底。
 * groupRows（默认 true）：仅基准语言列有值、其余语言列全空的行视为分组行跳过。
 * 列映射：columnMap 配置表（exact/regex/fuzzy）优先于内置表头识别。
 */
export function toLanguageMap(data: SheetData, opts: ToLanguageMapOptions = {}): LanguageMapResult {
  let keyCol: string | undefined;
  if (opts.keyColumn) {
    keyCol = data.headers.find((h) => h === opts.keyColumn || h.trim() === opts.keyColumn!.trim());
    if (!keyCol) {
      throw new Error(`keyColumn「${opts.keyColumn}」不在表头中。可用表头：${data.headers.filter(Boolean).join('、')}`);
    }
  }
  // 基准语言列（zh / zh-CN，繁体不算）：仅用于 groupRows 分组行判定
  const zhCol = data.headers.find((h) => /^zh(-CN)?$/.test(detectLanguageColumns([h], opts.columnMap ?? [])[0]?.lang || ''));

  // 内置 txt_ 规则的基准列：从左到右第一个「有表头且有数据」的列；无表头的列不能作为基准列
  let baseHeader: string | undefined;
  if (!data.headersSynthesized) {
    for (const h of data.headers) {
      if (!h.trim()) continue;
      if (data.rows.some((row) => String(row[h] ?? '').trim())) {
        baseHeader = h;
        break;
      }
    }
  }
  const baseLang = baseHeader ? detectLanguageColumns([baseHeader], opts.columnMap ?? [])[0]?.lang : undefined;

  // 语言列：同语言码取第一个出现的列；key 列排除；未命中任何识别规则的列天然不导出
  // columns 过滤：表头原名（忽略大小写）、语言码或第几列（1-based）
  const wanted = opts.columns?.length
    ? new Set(opts.columns.map((c) => (typeof c === 'number' ? c : String(c).trim().toLowerCase())))
    : null;
  const langHeaders: Array<{ lang: string; header: string }> = [];
  const seen = new Set<string>();
  for (const [ci, h] of data.headers.entries()) {
    if (h === keyCol) continue;
    const d = detectLanguageColumns([h], opts.columnMap ?? [])[0];
    if (!d || seen.has(d.lang)) continue;
    if (wanted && !wanted.has(ci + 1) && !wanted.has(d.lang.toLowerCase()) && !wanted.has(h.trim().toLowerCase())) continue;
    seen.add(d.lang);
    langHeaders.push({ lang: d.lang, header: h });
  }

  const translations: Record<string, Record<string, string>> = {};
  for (const { lang } of langHeaders) translations[lang] = {};

  const isZhLang = (lang: string) => /^zh(-CN)?$/.test(lang);
  const fallbackLang = (opts.fallbackLang ?? 'en').trim().toLowerCase();
  const fallbackOff = !fallbackLang || fallbackLang === 'none';
  const groupRows = opts.groupRows !== false;
  let skippedGroups = 0;
  const missing: LanguageMapResult['missing'] = [];

  // 内置 txt_ 规则取值：固定读基准列；基准单元格缺数据 = 缺失，key 退化 txt_row_行号
  const firstTextOf = (row: SheetData['rows'][number]): string =>
    baseHeader ? String(row[baseHeader] ?? '').trim() : '';

  for (const row of data.rows) {
    const vals = langHeaders.map(({ lang, header }) => ({ lang, text: String(row[header] ?? '').trim() }));
    const zhVal = zhCol ? String(row[zhCol] ?? '').trim() : '';
    const fallbackText = fallbackOff ? '' : vals.find((v) => v.lang === fallbackLang)?.text || '';

    // 分组行：仅基准语言列有值、其余语言列全空 → 跳过
    if (groupRows && zhVal && vals.every((v) => isZhLang(v.lang) || !v.text)) {
      skippedGroups++;
      continue;
    }

    const baseText = keyCol ? '' : firstTextOf(row);
    const key = keyCol
      ? String(row[keyCol] ?? '').trim() || `txt_row_${row._row}`
      : baseText
        ? `txt_${baseText.charCodeAt(0)}${row._row}`
        : `txt_row_${row._row}`;

    // 缺填检测：基准列缺数据，或非基准语言列空即记录（兜底是补救，漏填是事实）
    if (!keyCol && baseHeader && !baseText) {
      missing.push({ row: row._row, key: `txt_row_${row._row}`, langs: [baseLang || baseHeader] });
    } else {
      const missed = vals.filter((v) => !isZhLang(v.lang) && !v.text).map((v) => v.lang);
      if (missed.length) {
        missing.push({
          row: row._row,
          key: keyCol ? key : baseText || fallbackText || key,
          langs: missed,
        });
      }
    }

    for (const { lang, text } of vals) {
      // 兜底语言自身与基准语言缺值不补
      const finalText = !text && !isZhLang(lang) && lang !== fallbackLang ? fallbackText : text;
      assignValue(translations[lang], key, finalText);
    }
  }

  const warnings: string[] = [];
  if (!keyCol && !baseHeader && data.rows.length) {
    warnings.push('未找到可作为基准列的表头（表头为空或整表无表头行），全部 key 退化为 txt_row_行号。');
  }
  const counts = Object.entries(translations).map(([lang, kv]) => `${lang}:${Object.keys(kv).length}`);
  if (new Set(counts.map((c) => c.split(':')[1])).size > 1) {
    warnings.push(`各语言 key 数量不一致（${counts.join('、')}），多为个别语言缺翻译或多行行数不同，建议核对原文。`);
  }
  if (missing.length) {
    const detail = missing.slice(0, 10).map((m) => `第${m.row}行(${m.key})缺 ${m.langs.join('、')}`).join('；');
    warnings.push(
      `检测到 ${missing.length} 行存在漏填的语言列，空列已用兜底语言补齐（兜底也空的列对应 key 缺失），请核对填写：${detail}${missing.length > 10 ? ` …等共 ${missing.length} 行（完整清单见 missing 字段）` : ''}`
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
