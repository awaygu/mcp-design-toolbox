// langmap.ts — 表头语言识别（内置规则 + 可配置映射表）与匹配逻辑
// 内置规则覆盖常见语言关键词，识别失败时列原样保留（调用方可按表头名手工取列）；
// 列名与内置不同的表格用 columnMap 配置表扩展/覆盖（支持 exact/regex/fuzzy 三种匹配）

/** 列映射配置表的一条规则 */
export interface ColumnMapRule {
  /** 匹配串：exact=表头全等；regex=正则（忽略大小写）；fuzzy=归一化后双向包含（默认） */
  match: string;
  /** 映射到的语言码 */
  lang: string;
  /** 匹配方式，默认 fuzzy */
  type?: 'exact' | 'regex' | 'fuzzy';
}

/** 表头关键词 → 语言码。匹配按序执行（先长词后短词，避免「中文」吃掉「繁体中文」） */
const HEADER_RULES: Array<{ pattern: RegExp; lang: string }> = [
  { pattern: /繁体|傳統|traditional/i, lang: 'zh-TW' },
  { pattern: /简体|简中|simplified/i, lang: 'zh-CN' },
  { pattern: /中文|汉语|chinese/i, lang: 'zh' },
  { pattern: /英语|英文|english/i, lang: 'en' },
  { pattern: /印尼|indonesia|bahasa.*indo/i, lang: 'in' },
  { pattern: /马来|malay/i, lang: 'ms' },
  { pattern: /葡萄|portugu/i, lang: 'pt' },
  { pattern: /西班牙|espa|spanish/i, lang: 'es' },
  { pattern: /印地|hindi/i, lang: 'hi' },
  { pattern: /越南|việt|vietnamese/i, lang: 'vi' },
  { pattern: /土耳其|türk|turkish/i, lang: 'tr' },
  { pattern: /阿拉伯|عرب|arabic/i, lang: 'ar' },
  { pattern: /泰语|泰文|thai|ไทย/i, lang: 'th' },
  { pattern: /日语|日文|日本|japanese/i, lang: 'ja' },
  { pattern: /韩语|韩文|朝鲜|korean/i, lang: 'ko' },
  { pattern: /俄语|俄文|russian/i, lang: 'ru' },
  { pattern: /德语|德文|german|deutsch/i, lang: 'de' },
  { pattern: /法语|法文|french|français/i, lang: 'fr' },
];

/**
 * 从表头识别语言列。返回有序列表（index 为列序）。
 * 先按 columnMap 配置表匹配（参数列出的规则优先），再回落内置规则；
 * 都未命中的表头不出现在结果里（调用方仍可用原表头名取列）。
 */
export function detectLanguageColumns(headers: string[], columnMap: ColumnMapRule[] = []): Array<{ header: string; lang: string; index: number }> {
  const extra = compileRules(columnMap);
  const out: Array<{ header: string; lang: string; index: number }> = [];
  headers.forEach((h, i) => {
    const name = (h || '').trim();
    if (!name) return;
    for (const rule of extra) {
      if (headerMatches(name, rule)) {
        out.push({ header: name, lang: rule.lang, index: i });
        return;
      }
    }
    for (const rule of HEADER_RULES) {
      if (rule.pattern.test(name)) {
        out.push({ header: name, lang: rule.lang, index: i });
        break;
      }
    }
  });
  return out;
}

// ─── 列映射配置表（exact / regex / fuzzy） ────────────────────────

interface CompiledRule {
  lang: string;
  match: string;
  type: 'exact' | 'regex' | 'fuzzy';
  re?: RegExp;
  norm: string;
}

/** 归一化：小写、剔除空白与标点（保留中日韩文字与字母数字），供模糊包含比较 */
function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^\w\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+/g, '');
}

/** 校验并整理配置表；格式错误抛出可读错误（含第 N 条定位） */
export function parseColumnMap(raw: unknown): ColumnMapRule[] {
  if (!Array.isArray(raw)) throw new Error('列映射配置须为数组：[{ match, lang, type? }]');
  return raw.map((r, i) => {
    const at = `第 ${i + 1} 条`;
    if (!r || typeof r !== 'object') throw new Error(`列映射配置 ${at} 不是对象：${JSON.stringify(r)}`);
    const { match, lang, type } = r as Record<string, unknown>;
    if (typeof match !== 'string' || !match.trim()) throw new Error(`列映射配置 ${at} 缺少有效 match 字段`);
    if (typeof lang !== 'string' || !lang.trim()) throw new Error(`列映射配置 ${at} 缺少有效 lang 字段`);
    if (type !== undefined && !['exact', 'regex', 'fuzzy'].includes(String(type))) {
      throw new Error(`列映射配置 ${at} 的 type 只支持 exact/regex/fuzzy，收到：${String(type)}`);
    }
    return { match, lang, type: type as ColumnMapRule['type'] };
  });
}

function compileRules(rules: ColumnMapRule[]): CompiledRule[] {
  return rules.map((r) => {
    const type = r.type ?? 'fuzzy';
    const compiled: CompiledRule = { lang: r.lang, match: r.match, type, norm: normalizeHeader(r.match) };
    if (type === 'regex') {
      try {
        compiled.re = new RegExp(r.match, 'i');
      } catch {
        throw new Error(`列映射规则正则无效：${r.match}`);
      }
    }
    return compiled;
  });
}

function headerMatches(header: string, r: CompiledRule): boolean {
  if (r.type === 'exact') return header.trim().toLowerCase() === r.match.trim().toLowerCase();
  if (r.type === 'regex') return r.re ? r.re.test(header) : false;
  const norm = normalizeHeader(header);
  return !!r.norm && (norm.includes(r.norm) || r.norm.includes(norm));
}
