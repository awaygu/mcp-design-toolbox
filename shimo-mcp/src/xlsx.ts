// xlsx.ts — 从导出 ZIP 中提取 xlsx 并解析 sheet 清单/单元格
// xlsx 是 ZIP+XML，只解析 sharedStrings 与 sheet 名/单元格值，不引第三方依赖。
// 范围：读「工作表名清单」与「整表单元格」两个需求；公式单元格读缓存值；日期按原始文本。

import { inflateRawSync } from 'node:zlib';

/** 解压 ZIP 第一个 .xlsx 条目（石墨导出的 ZIP 固定只含一个 xlsx） */
export function extractXlsxFromZip(zipBuf: Buffer): Buffer {
  // 手写最小 ZIP 解析：定位 End of Central Directory → 遍历 central directory → 按本地头提取
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= 0 && i > zipBuf.length - 66000; i--) {
    if (zipBuf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('导出文件不是合法 ZIP');
  const entryCount = zipBuf.readUInt16LE(eocd + 10);
  let ptr = zipBuf.readUInt32LE(eocd + 16);

  const entries: Array<{ name: string; offset: number; compSize: number; method: number }> = [];
  for (let i = 0; i < entryCount; i++) {
    if (zipBuf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(ptr + 10);
    const compSize = zipBuf.readUInt32LE(ptr + 20);
    const nameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localOff = zipBuf.readUInt32LE(ptr + 42);
    const name = zipBuf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    entries.push({ name, offset: localOff, compSize, method });
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  const xlsxEntry = entries.find((e) => /\.xlsx$/i.test(e.name))
    || entries.find((e) => !e.name.endsWith('/'));
  if (!xlsxEntry) throw new Error(`导出 ZIP 中没有文件：${entries.map((e) => e.name).join(', ')}`);

  // 本地文件头：跳过 name + extra 取数据
  const off = xlsxEntry.offset;
  const nameLen = zipBuf.readUInt16LE(off + 26);
  const extraLen = zipBuf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const raw = zipBuf.slice(dataStart, dataStart + xlsxEntry.compSize);
  if (xlsxEntry.method === 0) return Buffer.from(raw);
  if (xlsxEntry.method === 8) return inflateRawSync(raw);
  throw new Error(`不支持的 ZIP 压缩方法：${xlsxEntry.method}`);
}

// ─── 最小 xlsx（OOXML）解析 ─────────────────────────────────────

function xmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : '';
}

/** 解析 sharedStrings.xml 的 <t> 文本数组 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    // 一个 si 可能含多个 <t>（富文本 run），全部拼接
    const ts = m[1].match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || [];
    out.push(ts.map((t) => t.replace(/<[^>]+>/g, '')).join(''));
  }
  return out;
}

/** 列字母 → 0-based 序号（A→0, Z→25, AA→26） */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64);
    else if (ch >= 'a' && ch <= 'z') n = n * 26 + (ch.charCodeAt(0) - 96);
    else break;
  }
  return n - 1;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export interface XlsxBook {
  sheetNames: string[];
  /** sheetName → 二维数组（值；空单元格为 ''） */
  sheets: Record<string, string[][]>;
}

/**
 * 解析 xlsx：sheet 名清单 + 各 sheet 的单元格文本。
 * 只读 worksheet 的 <c> 单元格与 inline/shared 字符串、数字；不支持样式/合并信息（翻译数据不需要）。
 */
export function parseXlsx(buf: Buffer): XlsxBook {
  // xlsx 内部再是一层 ZIP——复用同一套最小解析
  const inner = zipEntries(buf);
  const readEntry = (name: string): Buffer | null => inner.files[name] ? inner.data(name) : null;

  // workbook.xml → sheet 名 + rId；workbook.xml.rels → rId → sheets/sheetN.xml 路径
  const wbXml = readEntry('xl/workbook.xml')?.toString('utf8') || '';
  const relsXml = readEntry('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  if (!wbXml) throw new Error('xlsx 缺少 xl/workbook.xml');

  const shared: string[] = [];
  const ssBuf = readEntry('xl/sharedStrings.xml');
  if (ssBuf) shared.push(...parseSharedStrings(ssBuf.toString('utf8')));

  const rels = new Map<string, string>();
  const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(relsXml))) rels.set(rm[1], rm[2].replace(/^\//, '').replace(/^xl\//, ''));

  const sheetNames: string[] = [];
  const sheets: Record<string, string[][]> = {};
  const sheetRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g;
  let sm: RegExpExecArray | null;
  while ((sm = sheetRe.exec(wbXml))) {
    const name = unescapeXml(sm[1]);
    sheetNames.push(name);
    const target = rels.get(sm[2]) || `worksheets/sheet${sheetNames.length}.xml`;
    const wsBuf = readEntry(target.startsWith('xl/') ? target : `xl/${target}`);
    sheets[name] = wsBuf ? parseWorksheet(wsBuf.toString('utf8'), shared) : [];
  }
  return { sheetNames, sheets };
}

/** 解析一个 worksheet XML 为二维文本数组 */
function parseWorksheet(xml: string, shared: string[]): string[][] {
  const grid: string[][] = [];
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowM: RegExpExecArray | null;
  while ((rowM = rowRe.exec(xml))) {
    const rowIdx = Number(rowM[1]) - 1;
    const cells: string[] = [];
    const cellRe = /<c([^>]*)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g;
    let cellM: RegExpExecArray | null;
    while ((cellM = cellRe.exec(rowM[2]))) {
      const attrs = cellM[1] || cellM[2] || '';
      const inner = cellM[3] || '';
      const refM = /r="([A-Z]+)\d+"/.exec(attrs);
      const col = refM ? colIndex(refM[1]) : cells.length;
      const typeM = /t="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : 'n';
      let value = '';
      if (type === 's') {
        const v = xmlText(inner, 'v');
        value = shared[Number(v)] ?? '';
      } else if (type === 'inlineStr') {
        value = inner.replace(/<[^>]+>/g, '');
      } else if (type === 'str') {
        value = xmlText(inner, 'v');
      } else {
        value = xmlText(inner, 'v');
      }
      cells[col] = unescapeXml(value);
    }
    grid[rowIdx] = cells;
  }
  // 稀疏数组补洞
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
  return grid;
}

// ─── 最小 ZIP 读取（内层 xlsx 用） ───────────────────────────────

interface ZipDir {
  files: Record<string, number>; // name → central dir offset
  data: (name: string) => Buffer;
}

function zipEntries(buf: Buffer): ZipDir {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx 不是合法 ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const files: Record<string, number> = {};
  const metas: Record<string, { compSize: number; method: number; offset: number }> = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    files[name] = localOff;
    metas[name] = { compSize, method, offset: localOff };
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return {
    files,
    data(name: string): Buffer {
      const m = metas[name];
      if (!m) throw new Error(`ZIP 内无 ${name}`);
      const off = m.offset;
      const nameLen = buf.readUInt16LE(off + 26);
      const extraLen = buf.readUInt16LE(off + 28);
      const start = off + 30 + nameLen + extraLen;
      const raw = buf.slice(start, start + m.compSize);
      return m.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    },
  };
}

// ─── xlsx 生成（零依赖，ZIP store + inline string） ───────────────
// 只为「单 sheet 落盘」服务：单元格一律写 t="inlineStr"，不搞 sharedStrings/样式/公式。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 生成一个仅 store（不压缩）的 ZIP——xlsx 条目小，store 足够且实现最小 */
function zipStore(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

function xmlEscape(s: string): string {
  // 剔除 XML 非法控制字符（保留 \t \n \r），再转义实体
  return s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** sheet 名合法化：Excel 禁止 : \ / ? * [ ]，最长 31 字符 */
export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, '_').trim();
  return (cleaned || 'sheet').slice(0, 31);
}

function worksheetXml(rows: string[][]): Buffer {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  rows.forEach((cells, ri) => {
    if (!cells || !cells.length) return;
    const parts: string[] = [`<row r="${ri + 1}">`];
    cells.forEach((v, ci) => {
      const text = v == null ? '' : String(v);
      if (!text) return; // 空单元格直接不写
      parts.push(`<c r="${colLetters(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`);
    });
    parts.push('</row>');
    lines.push(parts.join(''));
  });
  lines.push('</sheetData></worksheet>');
  return Buffer.from(lines.join(''), 'utf8');
}

/** 列号 → 字母（0→A，25→Z，26→AA），写单元格 ref 用 */
function colLetters(index0: number): string {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * 生成 xlsx 文件（支持一个或多个 sheet）。
 * rows 是二维文本数组（不含表头概念，第 1 行就是第 1 行）。
 */
export function buildXlsx(sheets: Array<{ name: string; rows: string[][] }>): Buffer {
  if (!sheets.length) throw new Error('buildXlsx 需要至少一个 sheet');
  const names = sheets.map((s) => sanitizeSheetName(s.name));
  const sheetTags = names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const relTags = names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const overrides = names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');

  const files: Array<{ name: string; data: Buffer }> = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          overrides +
          '</Types>',
        'utf8'
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
        'utf8'
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets>${sheetTags}</sheets></workbook>`,
        'utf8'
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          relTags +
          '</Relationships>',
        'utf8'
      ),
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: worksheetXml(s.rows) })),
  ];
  return zipStore(files);
}
