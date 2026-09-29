#!/usr/bin/env node
// index.ts — shimo-mcp 入口（官方 SDK + stdio 传输）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  checkAuth,
  exportWorkbook,
  downloadExportZip,
  extractFileId,
  getFileMeta,
  listSheets,
  readSheetRaw,
  translateSheetReadError,
  type Credentials,
} from './shimo-client.js';
import { readSheet, readColumn } from './sheet.js';
import { toLanguageMap } from './i18n.js';
import { extractXlsxFromZip, parseXlsx, buildXlsx } from './xlsx.js';
import { parseColumnMap, type ColumnMapRule } from './langmap.js';

// ─── 凭据：入参 > SHIMO_COOKIE > SHIMO_COOKIE_FILE ───────────────

function readCookieFile(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  try {
    return readFileSync(filePath, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function credentials(args: { cookie?: string }): Credentials {
  const cookie = args.cookie || process.env.SHIMO_COOKIE || readCookieFile(process.env.SHIMO_COOKIE_FILE);
  if (!cookie) {
    throw new Error(
      '缺少石墨登录 cookie（三选一）：① 工具入参 cookie；② 环境变量 SHIMO_COOKIE；③ SHIMO_COOKIE_FILE 指向的文件（内容为完整 cookie 串）。' +
        '获取：浏览器登录 shimo.im → F12 → Network → 点任意请求 → 复制 Cookie 头整串。'
    );
  }
  return { cookie };
}

/** 解析 url/id 入参：入参 > SHIMO_URL（默认文档链接），最终必须能提取 guid */
function requireGuid(url?: string): string {
  const resolved = url || process.env.SHIMO_URL;
  if (!resolved) {
    throw new Error('缺少 url 参数（石墨文档链接，如 https://shimo.im/sheets/xxx/yyy），且未设置环境变量 SHIMO_URL');
  }
  return extractFileId(resolved);
}

/** 文件名安全化：替换文件系统保留字符 */
function sanitizeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_');
}

/** 解析落盘目标：以 .json 结尾视为完整文件路径，否则视为目录（文件用 defaultFileName）；目录不存在时自动创建 */
function resolveOutputFile(outputPath: string, defaultFileName: string): string {
  const resolved = path.resolve(outputPath);
  if (/\.json$/i.test(resolved)) {
    // 显式文件路径也对文件名做安全化（目录部分保持原样），避免 Windows 非法字符导致写盘报 ENOENT
    const dir = path.dirname(resolved);
    mkdirSync(dir, { recursive: true });
    return path.join(dir, sanitizeFileName(path.basename(resolved)));
  }
  mkdirSync(resolved, { recursive: true });
  return path.join(resolved, defaultFileName);
}

/** 列映射配置表：工具入参 columnMap 优先，其次配置文件（SHIMO_COLUMN_MAP_FILE，默认 .mcp-local/shimo-column-map.json） */
function resolveColumnMap(args: { columnMap?: ColumnMapRule[] }): ColumnMapRule[] {
  const file = process.env.SHIMO_COLUMN_MAP_FILE || path.join(process.cwd(), '.mcp-local', 'shimo-column-map.json');
  let fileRules: ColumnMapRule[] = [];
  if (existsSync(file)) {
    try {
      fileRules = parseColumnMap(JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
      throw new Error(`列映射配置文件解析失败（${file}）：${(e as Error).message}`);
    }
  }
  return [...(args.columnMap ?? []), ...fileRules];
}

const columnMapSchema = z
  .array(
    z.object({
      match: z.string().describe('表头匹配串'),
      lang: z.string().describe('映射到的语言码'),
      type: z.enum(['exact', 'regex', 'fuzzy']).optional().describe('匹配方式：exact=全等，regex=正则（忽略大小写），fuzzy=归一化双向包含（默认）'),
    })
  )
  .optional()
  .describe('列映射配置表：把表头映射到语言码，优先于内置语言识别；也可写入 .mcp-local/shimo-column-map.json 长期复用');

// ─── Server ─────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'shimo-mcp', version: '0.4.1' },
  {
    instructions: [
      '石墨表格结构化读取与 i18n 导出工作流：',
      '1. shimo_check_auth 探活 cookie（401/空数据时先调它区分「cookie 过期」与「无权限」）。',
      '2. shimo_list_sheets 列出全部工作表名。',
      '3. shimo_read_sheet 读单个工作表：默认返回前 200 行；文档更新后只看改动时传 rows:[行号]（行号=石墨 UI 行号，表头恒在第 1 行），或 columns:[列] 只要某几列。大表可传 outputPath 落盘为 JSON 文件（只返回路径+摘要；read_column 同样支持）。',
      '4. shimo_read_column 读单列：返回 [{_row, value}] 行号→值列表；只要「某行在某列」的值时传 column+rows:[行号] 直接命中，不必拉整表。',
      '5. shimo_export_i18n 生成各语言 key→文案 JSON：列→语言的映射支持 columnMap 参数或 .mcp-local/shimo-column-map.json 配置表（exact/regex/fuzzy 三种匹配），适配任意列名；key 规则(keyColumn)、缺值兜底(fallbackLanguage)、分组行(groupRows) 均可配置。',
      '6. shimo_export_xlsx 导出 xlsx 落盘：传 sheet 只导该工作表（纯数据）；不传 sheet 导出整文档（保留样式/公式，较慢）。',
      '7. url 可用环境变量 SHIMO_URL 预置默认文档链接，配置后调用无需重复传 url。',
    ].join('\n'),
  }
);

// ─── 工具1：cookie 探活 ──────────────────────────────────────────

server.registerTool(
  'shimo_check_auth',
  {
    description:
      '探活石墨 cookie 是否有效。返回 { ok:true, user, file? } 或 { ok:false, reason, hint }。' +
      '任何 shimo 工具报 401/403 或空数据时先调本工具：ok=true 但仍 403 → 是该文档无权限（找文档所有者开通）；' +
      'reason=cookie_expired → 真过期，提示用户重新登录 shimo.im 复制 Cookie 更新配置。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL（都没有则只探活 cookie，不返回文档信息）'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const docUrl = args.url || process.env.SHIMO_URL;
    const guid = docUrl ? extractFileId(docUrl) : undefined;
    const result = await checkAuth(credentials(args), guid);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

// ─── 工具2：读单个工作表 ─────────────────────────────────────────

server.registerTool(
  'shimo_read_sheet',
  {
    description:
      '读石墨表格单个工作表的结构化数据：表头 + 数据行（每行带 _row=石墨 UI 行号）。' +
      '增量场景：rows 传行号列表只取指定行；columns 传表头名或第几列只取指定列——文档更新后不必全量重拉。' +
      '默认最多 200 行，truncated=true 表示还有更多，用 rows 传后续行号继续取。' +
      '大表可传 outputPath 落盘为 JSON 文件：只返回文件路径+摘要，不撑爆上下文（落盘时 limit 默认放开为不限）。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL'),
      sheet: z.string().describe('工作表名（底部标签页名称，来自 shimo_list_sheets 或用户指定）'),
      rows: z.array(z.number()).optional().describe('只取这些行（石墨 UI 行号，1-based；表头恒在第 1 行自动带出）。增量/补拉场景用'),
      columns: z
        .array(
          z.union([
            z.string().min(1).describe('表头原名'),
            z.number().describe('第几列，从 1 起'),
          ])
        )
        .optional()
        .describe('只取这些列。默认全部列'),
      limit: z.number().optional().describe('数据行上限，默认 200；0=不限（慎用，大表会撑爆上下文）'),
      outputPath: z
        .string()
        .optional()
        .describe('落盘为 JSON 文件：传目录路径写入 <工作表名>.json；传 .json 结尾的路径则作为完整文件路径。落盘时只返回文件路径+摘要'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const data = await readSheet(guid, args.sheet, credentials(args), {
      ...(args.rows?.length ? { rows: args.rows } : {}),
      ...(args.columns?.length ? { columns: args.columns } : {}),
      // 落盘时不占上下文，limit 默认放开为不限；显式传 limit 仍按传入值
      ...(args.limit !== undefined ? { limit: args.limit } : args.outputPath ? { limit: 0 } : {}),
    });
    if (args.outputPath) {
      const file = resolveOutputFile(args.outputPath, `${sanitizeFileName(args.sheet)}.json`);
      const json = JSON.stringify(data, null, 2);
      writeFileSync(file, json, 'utf8');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              file,
              bytes: Buffer.byteLength(json),
              sheet: data.sheet,
              headers: data.headers,
              rows: data.rows.length,
              totalRows: data.totalRows,
              truncated: data.truncated,
              ...(data.truncated
                ? { hint: `仍有未落盘的行：用 rows 传后续行号（当前已到第 ${data.rows[data.rows.length - 1]?._row} 行）再落盘一次` }
                : { hint: '全量数据已写入文件；需要在上下文中查看时用不带 outputPath 的调用' }),
            }),
          },
        ],
      };
    }
    const body = {
      ...data,
      hint: data.truncated ? `还有更多行：用 rows 传后续行号（当前已到第 ${data.rows[data.rows.length - 1]?._row} 行）继续取` : undefined,
    };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }
);

// ─── 工具3：读单列（行号→值列表） ────────────────────────────────

server.registerTool(
  'shimo_read_column',
  {
    description:
      '读工作表的单列数据，返回 [{_row, value}] 行号→值列表。' +
      '要「某一行在某列的值」（如第 30 行的英文文案）最直接：column + rows:[30] 一次命中；只传 column 则返回整列，空值保留为空串（缺翻译一目了然）。' +
      'column 支持表头名（忽略大小写）或第几列（1-based）。默认最多 500 行，truncated=true 表示还有更多，用 rows 传后续行号继续取。' +
      '大列可传 outputPath 落盘为 JSON 文件：只返回文件路径+摘要，不撑爆上下文（落盘时 limit 默认放开为不限）。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL'),
      sheet: z.string().describe('工作表名（底部标签页名称，来自 shimo_list_sheets 或用户指定）'),
      column: z
        .union([z.string().min(1).describe('表头原名（忽略大小写）'), z.number().describe('第几列，从 1 起')])
        .describe('要读的列：表头名或列序'),
      rows: z.array(z.number()).optional().describe('只取这些行（石墨 UI 行号，1-based）。如 [30] 即第 30 行在该列的值'),
      limit: z.number().optional().describe('最多返回多少行，默认 500；0=不限'),
      outputPath: z
        .string()
        .optional()
        .describe('落盘为 JSON 文件：传目录路径写入 <工作表名>.<列名>.json；传 .json 结尾的路径则作为完整文件路径。落盘时只返回文件路径+摘要'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const data = await readColumn(guid, args.sheet, credentials(args), args.column, {
      ...(args.rows?.length ? { rows: args.rows } : {}),
      // 落盘时不占上下文，limit 默认放开为不限；显式传 limit 仍按传入值
      ...(args.limit !== undefined ? { limit: args.limit } : args.outputPath ? { limit: 0 } : {}),
    });
    if (args.outputPath) {
      const colTag = typeof args.column === 'number' ? `col${args.column}` : args.column;
      const file = resolveOutputFile(args.outputPath, `${sanitizeFileName(args.sheet)}.${sanitizeFileName(colTag)}.json`);
      const json = JSON.stringify(data, null, 2);
      writeFileSync(file, json, 'utf8');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              file,
              bytes: Buffer.byteLength(json),
              sheet: data.sheet,
              column: data.column,
              columnIndex: data.columnIndex,
              nonEmpty: data.nonEmpty,
              totalRows: data.totalRows,
              truncated: data.truncated,
            }),
          },
        ],
      };
    }
    const body = {
      ...data,
      hint: data.truncated ? `还有更多行：用 rows 传后续行号（当前已到第 ${data.values[data.values.length - 1]?._row} 行）继续取` : undefined,
    };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }
);

// ─── 工具4：工作表清单（content API 直连，xlsx 通道兜底） ─────────

async function exportAndParse(guid: string, creds: Credentials): Promise<ReturnType<typeof parseXlsx>> {
  const handle = await exportWorkbook(guid, creds.cookie);
  const zip = await downloadExportZip(handle);
  return parseXlsx(extractXlsxFromZip(zip));
}

server.registerTool(
  'shimo_list_sheets',
  {
    description:
      '列出石墨表格的全部工作表名（底部标签页）。仅需要单元格数据时直接用 shimo_read_sheet。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const creds = credentials(args);
    // meta 与 content 并行；content 失败时落 fallbackReason
    let listError: unknown;
    const metaP = getFileMeta(guid, creds.cookie).catch(() => null);
    const sheetsP = listSheets(guid, creds.cookie).catch((e) => {
      listError = e;
      return null;
    });
    const meta = await metaP;
    // 非表格类型提前失败：content 和 xlsx 导出对文档类都会失败
    const SHEET_TYPES = new Set(['mosheet', 'sheet']);
    if (meta && !SHEET_TYPES.has(meta.type)) {
      throw new Error(`该文档类型为 ${meta.type}（文档类），不是表格，没有工作表可列。表格文档的链接形如 https://shimo.im/sheets/<id>`);
    }
    let body: Record<string, unknown>;
    const sheets = await sheetsP;
    if (sheets?.length) {
      body = { document: meta?.name || guid, sheetCount: sheets.length, source: 'content-api', sheets };
    } else {
      const book = await exportAndParse(guid, creds);
      const fallbackSheets = book.sheetNames.map((name) => {
        const grid = book.sheets[name] || [];
        const headers = (grid[0] || []).filter(Boolean);
        const nonEmptyRows = grid.slice(1).filter((r) => r.some((c) => String(c).trim())).length;
        return {
          name,
          rows: nonEmptyRows,
          cols: headers.length,
          headers: headers.slice(0, 12),
        };
      });
      body = {
        document: meta?.name || guid,
        sheetCount: fallbackSheets.length,
        source: 'xlsx-export',
        ...(listError instanceof Error ? { fallbackReason: listError.message } : { fallbackReason: 'content 中未解析出任何工作表 token' }),
        sheets: fallbackSheets,
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }
);

// ─── 工具5：导出 xlsx 落盘 ───────────────────────────────────────

server.registerTool(
  'shimo_export_xlsx',
  {
    description:
      '把石墨表格导出为 xlsx 文件落盘（供开发/交付使用）。' +
      '传 sheet 只导出该工作表（纯数据，不含样式/公式）；不传 sheet 导出整文档（保留样式/公式，较慢）。' +
      '需要按语言拆分 JSON 时用 shimo_read_sheet 的数据自行组装。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL'),
      sheet: z.string().optional().describe('只导出这一个工作表（名称需精确匹配，来自 shimo_list_sheets）。不传=导出整文档全部工作表'),
      outputPath: z.string().optional().describe('输出目录，默认 ./.mcp-local'),
      fileName: z.string().optional().describe('输出文件名（不含 .xlsx 也可），默认：整文档用文档名；单 sheet 用工作表名'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const creds = credentials(args);
    const dir = path.resolve(args.outputPath || path.join(process.cwd(), '.mcp-local'));
    mkdirSync(dir, { recursive: true });

    if (args.sheet) {
      // 单 sheet：直读该表 + 本地生成
      let rows: unknown[][];
      let truncated: boolean;
      try {
        ({ rows, truncated } = await readSheetRaw(guid, args.sheet, creds.cookie));
      } catch (e) {
        throw await translateSheetReadError(e, guid, args.sheet, creds.cookie);
      }
      const grid = rows.map((r) => (r || []).map((c) => (c == null ? '' : String(c))));
      const nonEmpty = grid.filter((r) => r.some((c) => c.trim())).length;
      const safe = sanitizeFileName(args.fileName || args.sheet);
      const file = path.join(dir, `${safe.endsWith('.xlsx') ? safe : safe + '.xlsx'}`);
      const single = buildXlsx([{ name: args.sheet, rows: grid }]);
      writeFileSync(file, single);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              file,
              bytes: single.length,
              sheet: args.sheet,
              rows: nonEmpty,
              cols: grid.reduce((m, r) => Math.max(m, r.length), 0),
              truncated,
              source: 'values-api',
            }),
          },
        ],
      };
    }

    // 整文档：石墨原生导出（含样式/公式）
    const handle = await exportWorkbook(guid, creds.cookie);
    const zip = await downloadExportZip(handle);
    const xlsx = extractXlsxFromZip(zip);
    const book = parseXlsx(xlsx);
    const safe = sanitizeFileName(args.fileName || handle.fileName || guid);
    const file = path.join(dir, `${safe.endsWith('.xlsx') ? safe : safe + '.xlsx'}`);
    writeFileSync(file, xlsx);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            file,
            bytes: xlsx.length,
            taskId: handle.taskId,
            sheetCount: book.sheetNames.length,
            sheets: book.sheetNames,
          }),
        },
      ],
    };
  }
);

// ─── 工具6：语言映射导出（i18n JSON，映射关系可配置） ─────────────

server.registerTool(
  'shimo_export_i18n',
  {
    description:
      '读取指定工作表并生成各语言的 key→文案 映射 JSON（落盘或直接返回）。' +
      '列→语言的映射默认走内置识别，可用 columnMap 参数或 .mcp-local/shimo-column-map.json 配置表扩展/覆盖（支持 exact/regex/fuzzy 匹配），适配任意列名。' +
      'key 默认按每行从左到右第一个有值单元格生成，传 keyColumn 则改用指定列的值作为 key。' +
      '其他语言列缺值按 fallbackLanguage（默认 en）兜底，漏填事实记录在 missing 字段并附 warning；groupRows 控制分组行跳过。' +
      '含换行的文案自动按行拆成 key_0/key_1…。语言列按表头自动识别；columns 可只导出指定列（表头原名或语言码）。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL'),
      sheet: z.string().describe('工作表名'),
      columns: z.array(z.string()).optional().describe('只导出这些列（表头原名或语言码）。默认全部识别到的语言列'),
      keyColumn: z.string().optional().describe('显式指定作为 key 的列名。不传时默认生成 txt_中文首字编码+行号 形式的 key'),
      fallbackLanguage: z.string().optional().describe('缺值兜底语言码，默认 en；传 none 关闭兜底'),
      groupRows: z.boolean().optional().describe('仅基准语言列（中文）有值、其他语言全空的行视为分组行跳过，默认 true；设 false 按漏填导出并记入 missing'),
      columnMap: columnMapSchema,
      rows: z.array(z.number()).optional().describe('只取这些行（石墨 UI 行号）'),
      outputPath: z.string().optional().describe('传了就把每个语言写成 <lang>.json 落盘，返回路径；不传则直接返回 JSON 内容'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const creds = credentials(args);
    const rules = resolveColumnMap(args);
    const data = await readSheet(guid, args.sheet, creds, {
      ...(args.rows?.length ? { rows: args.rows } : {}),
      limit: 0,
    });
    const { translations, warnings, skippedGroups, missing } = toLanguageMap(data, {
      ...(args.keyColumn ? { keyColumn: args.keyColumn } : {}),
      ...(args.fallbackLanguage !== undefined ? { fallbackLang: args.fallbackLanguage } : {}),
      ...(args.groupRows !== undefined ? { groupRows: args.groupRows } : {}),
      columnMap: rules,
      ...(args.columns?.length ? { columns: args.columns } : {}),
    });

    if (args.outputPath) {
      const dir = path.resolve(args.outputPath);
      mkdirSync(dir, { recursive: true });
      const files: Array<{ lang: string; file: string; keys: number }> = [];
      for (const [lang, kv] of Object.entries(translations)) {
        const f = path.join(dir, `${lang}.json`);
        writeFileSync(f, JSON.stringify(kv, null, 2), 'utf8');
        files.push({ lang, file: f, keys: Object.keys(kv).length });
      }
      return { content: [{ type: 'text', text: JSON.stringify({ sheet: data.sheet, files, totalRows: data.totalRows, skippedGroups, ...(missing.length ? { missing } : {}), ...(warnings.length ? { warnings } : {}) }) }] };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ sheet: data.sheet, totalRows: data.totalRows, skippedGroups, ...(missing.length ? { missing } : {}), truncated: data.truncated, translations, ...(warnings.length ? { warnings } : {}) }) }],
    };
  }
);

// ─── 启动 ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on('SIGINT', async () => {
    process.exit(0);
  });
  console.error('shimo-mcp 已启动，等待连接…');
}

main().catch((err) => {
  console.error('启动失败:', err?.message || err);
  process.exit(1);
});
