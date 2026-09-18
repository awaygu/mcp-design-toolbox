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
  { name: 'shimo-mcp', version: '0.2.0' },
  {
    instructions: [
      '石墨表格结构化读取与 i18n 导出工作流：',
      '1. shimo_check_auth 探活 cookie（401/空数据时先调它区分「cookie 过期」与「无权限」）。',
      '2. shimo_list_sheets 列出全部工作表名（走 xlsx 导出通道，同时返回每个表的行列数与表头预览）。',
      '3. shimo_read_sheet 读单个工作表：默认返回前 200 行；文档更新后只看改动时传 rows:[行号]（行号=石墨 UI 行号，表头恒在第 1 行），或 columns:[列] 只要某几列。',
      '4. shimo_read_column 读单列：返回 [{_row, value}] 行号→值列表；只要「某行在某列」的值时传 column+rows:[行号] 直接命中，不必拉整表。',
      '5. shimo_export_i18n 生成各语言 key→文案 JSON：列→语言的映射支持 columnMap 参数或 .mcp-local/shimo-column-map.json 配置表（exact/regex/fuzzy 三种匹配），适配任意列名；key 规则(keyColumn)、缺值兜底(fallbackLanguage)、分组行(groupRows) 均可配置。',
      '6. shimo_export_xlsx 把整个文档导出为 xlsx 落盘（本地解析出 sheet 清单；产物可直接给 Excel 用户）。',
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
      '读石墨表格单个工作表（sheet）的结构化数据：表头 + 数据行（每行带 _row=石墨 UI 行号）。' +
      '支持增量场景：rows 传行号列表只取指定行（如只看上次缺失的行）；columns 传表头名或第几列只取指定列（如 ["英文", 3]）——文档更新后不必全量重拉。' +
      '默认最多 200 行，truncated=true 表示还有更多，用 rows 传后续行号（如 [201,202,…]）继续取。工作表名是石墨底部标签页名称。',
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
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const data = await readSheet(guid, args.sheet, credentials(args), {
      ...(args.rows?.length ? { rows: args.rows } : {}),
      ...(args.columns?.length ? { columns: args.columns } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
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
      '读工作表的单列数据，返回 [{_row, value}] 行号→值列表（_row=石墨 UI 行号，与网页所见一致）。' +
      '要「某一行在某列的值」（如第 30 行的英文文案）时最直接：column + rows:[30] 一次命中，不必拉整表；' +
      '只传 column 则返回整列，空值保留为空串（哪些行缺翻译一目了然）。' +
      'column 支持表头名（忽略大小写全等）或第几列（1-based）；无匹配时报错并列出该表全部可用列。' +
      '默认最多 500 行，truncated=true 表示还有更多，用 rows 传后续行号继续取。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL'),
      sheet: z.string().describe('工作表名（底部标签页名称，来自 shimo_list_sheets 或用户指定）'),
      column: z
        .union([z.string().min(1).describe('表头原名（忽略大小写）'), z.number().describe('第几列，从 1 起')])
        .describe('要读的列：表头名或列序'),
      rows: z.array(z.number()).optional().describe('只取这些行（石墨 UI 行号，1-based）。如 [30] 即第 30 行在该列的值'),
      limit: z.number().optional().describe('最多返回多少行，默认 500；0=不限'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const data = await readColumn(guid, args.sheet, credentials(args), args.column, {
      ...(args.rows?.length ? { rows: args.rows } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    const body = {
      ...data,
      hint: data.truncated ? `还有更多行：用 rows 传后续行号（当前已到第 ${data.values[data.values.length - 1]?._row} 行）继续取` : undefined,
    };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }
);

// ─── 工具4：工作表清单（xlsx 通道，仅内存解析，不落盘） ───────────

async function exportAndParse(guid: string, creds: Credentials): Promise<ReturnType<typeof parseXlsx>> {
  const handle = await exportWorkbook(guid, creds.cookie);
  const zip = await downloadExportZip(handle);
  return parseXlsx(extractXlsxFromZip(zip));
}

server.registerTool(
  'shimo_list_sheets',
  {
    description:
      '列出石墨表格的全部工作表名（底部标签页）。石墨没有 sheet 清单 API，本工具走一次 xlsx 导出通道并本地解析（约 5~20 秒），' +
      '返回每个工作表的行列数与表头预览；不落盘，需要文件用 shimo_export_xlsx。结果较稳定可少量复用；仅需要数据时直接用 shimo_read_sheet。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const meta = await getFileMeta(guid, credentials(args).cookie).catch(() => null);
    const book = await exportAndParse(guid, credentials(args));
    const sheets = book.sheetNames.map((name) => {
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
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            document: meta?.name || guid,
            sheetCount: sheets.length,
            sheets,
          }),
        },
      ],
    };
  }
);

// ─── 工具5：导出 xlsx 落盘 ───────────────────────────────────────

server.registerTool(
  'shimo_export_xlsx',
  {
    description:
      '把石墨表格导出为 xlsx 文件落盘（本地目录，供开发/交付使用），返回文件路径与工作表清单。' +
      '导出走石墨「批量下载」通道（整文档一个 xlsx，约 5~20 秒）；传 sheet 参数则从整文档 xlsx 中抽取该单个工作表另存为独立 xlsx 文件（零依赖本地重写）。' +
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
    const handle = await exportWorkbook(guid, creds.cookie);
    const zip = await downloadExportZip(handle);
    const xlsx = extractXlsxFromZip(zip);
    const book = parseXlsx(xlsx);
    const dir = path.resolve(args.outputPath || path.join(process.cwd(), '.mcp-local'));
    mkdirSync(dir, { recursive: true });

    if (args.sheet) {
      // 单 sheet 模式：从整文档 xlsx 抽取该表，重写为独立 xlsx
      const grid = book.sheets[args.sheet] ?? book.sheets[args.sheet.trim()];
      if (!grid) {
        const avail = book.sheetNames.slice(0, 15).join('、');
        throw new Error(`未找到工作表「${args.sheet}」。可用工作表（共 ${book.sheetNames.length} 个，前 15 个）：${avail}…`);
      }
      const nonEmpty = grid.filter((r) => r.some((c) => String(c ?? '').trim()));
      const safe = (args.fileName || args.sheet).replace(/[/\\:*?"<>|]/g, '_');
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
              rows: nonEmpty.length,
              cols: grid.reduce((m, r) => Math.max(m, r.length), 0),
              taskId: handle.taskId,
              sourceSheets: book.sheetNames.length,
            }),
          },
        ],
      };
    }

    const safe = (args.fileName || handle.fileName || guid).replace(/[/\\:*?"<>|]/g, '_');
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
      'key 默认按每行从左到右第一个有值单元格生成（txt_ + 首字符编码 + 石墨行号直接拼接），传 keyColumn 则改用指定列的值作为 key。' +
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
