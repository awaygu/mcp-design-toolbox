// langmap.ts — 表头语言识别与 Android values 目录映射
// 覆盖本翻译表实际用到的语言（中文/UI/繁体/英/印尼/马来/葡/西/印地/越南/土耳其/阿拉伯），
// 并多带一些常见语言码，识别失败时列原样保留（调用方可按表头名手工取列）

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
  { pattern: /key|键|文案名|name|标识/i, lang: '_key' },
  { pattern: /ui|界面|固定用词/i, lang: '_ui' },
];

/**
 * 从表头识别语言列。返回有序列表（index 为列序）。
 * 无法识别的表头不出现在结果里（调用方仍可用原表头名取列）。
 */
export function detectLanguageColumns(headers: string[]): Array<{ header: string; lang: string; index: number }> {
  const out: Array<{ header: string; lang: string; index: number }> = [];
  headers.forEach((h, i) => {
    const name = (h || '').trim();
    if (!name) return;
    for (const rule of HEADER_RULES) {
      if (rule.pattern.test(name)) {
        out.push({ header: name, lang: rule.lang, index: i });
        break;
      }
    }
  });
  return out;
}

/** 语言码 → Android values 目录后缀（翻译表→工程目录的通用映射，导出 Android 格式时用） */
export const ANDROID_VALUES_DIR: Record<string, string> = {
  en: 'values', // Android 默认语言=英文（本项目基准）
  'zh-TW': 'values-zh-rTW',
  'zh-CN': 'values-zh-rCN',
  in: 'values-in',
  ms: 'values-ms',
  pt: 'values-pt',
  es: 'values-es',
  hi: 'values-hi',
  vi: 'values-vi',
  tr: 'values-tr',
  ar: 'values-ar',
  th: 'values-th',
  ja: 'values-ja',
  ko: 'values-ko',
  ru: 'values-ru',
  de: 'values-de',
  fr: 'values-fr',
};
