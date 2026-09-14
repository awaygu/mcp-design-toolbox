#!/usr/bin/env node
// index.ts — shimo-mcp 入口（官方 SDK + stdio 传输）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  checkAuth,
  exportWorkbook,
  downloadExportZip,
  extractFileId,
  getFileMeta,
  type Credentials,
} from './shimo-client.js';
import { readSheet, toLanguageMap } from './i18n.js';
import { extractXlsxFromZip, parseXlsx, buildXlsx } from './xlsx.js';
import { detectLanguageColumns } from './langmap.js';

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

// ─── Server ─────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'shimo-mcp', version: '0.1.0' },
  {
    instructions: [
      '石墨文档多语言翻译表读取工作流：',
      '1. shimo_check_auth 探活 cookie（401/空数据时先调它区分「cookie 过期」与「无权限」）。',
      '2. shimo_list_sheets 列出全部工作表名（走 xlsx 导出通道，同时返回每个表的行列数与语言列）。',
      '3. shimo_read_sheet 读单个工作表：默认返回前 200 行；文档更新后只看改动时传 rows:[行号]（行号=石墨 UI 行号，表头恒在第 1 行），或 languages:[语言码] 只要某几列。',
      '4. shimo_export_xlsx 把整个文档导出为 xlsx 落盘（本地解析出 sheet 清单；产物可直接给 Excel 用户）。',
      '5. 色值/文案一律以结构化数据为准，不要用截图 OCR。',
      '6. url 可用环境变量 SHIMO_URL 预置默认文档链接，配置后调用无需重复传 url。',
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
      '支持增量场景：rows 传行号列表只取指定行（如只看上次缺失的行）；languages 传语言码/表头名只取指定列（如 ["en","ja"]）——文档更新后不必全量重拉。' +
      '默认最多 200 行，truncated=true 表示还有更多，用 rows 传后续行号（如 [201,202,…]）继续取。工作表名是石墨底部标签页名称。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL'),
      sheet: z.string().describe('工作表名（底部标签页名称，来自 shimo_list_sheets 或用户指定）'),
      rows: z.array(z.number()).optional().describe('只取这些行（石墨 UI 行号，1-based；表头恒在第 1 行自动带出）。增量/补拉场景用'),
      languages: z.array(z.string()).optional().describe('只取这些语言列（语言码 en/in/ms/pt/es/hi/vi/tr/ar/zh-TW… 或表头原文「英文/印尼语」）。默认全部列'),
      limit: z.number().optional().describe('数据行上限，默认 200；0=不限（慎用，大表会撑爆上下文）'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const data = await readSheet(guid, args.sheet, credentials(args), {
      ...(args.rows?.length ? { rows: args.rows } : {}),
      ...(args.languages?.length ? { languages: args.languages } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    const langCols = detectLanguageColumns(data.headers);
    const body = {
      ...data,
      detectedLanguages: langCols.map((c) => ({ lang: c.lang, column: c.header })),
      hint: data.truncated ? `还有更多行：用 rows 传后续行号（当前已到第 ${data.rows[data.rows.length - 1]?._row} 行）继续取` : undefined,
    };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }
);

// ─── 工具3：工作表清单（xlsx 通道） ───────────────────────────────

async function exportAndParse(guid: string, creds: Credentials): Promise<{ book: ReturnType<typeof parseXlsx>; file: string; bytes: number }> {
  const handle = await exportWorkbook(guid, creds.cookie);
  const zip = await downloadExportZip(handle);
  const xlsx = extractXlsxFromZip(zip);
  const book = parseXlsx(xlsx);
  // 产物落盘（.mcp-local 下），后续 export 工具可直接复用
  const dir = process.env.SHIMO_EXPORT_DIR || path.join(process.cwd(), '.mcp-local');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${book.sheetNames.length ? handle.fileName || guid : guid}.xlsx`);
  writeFileSync(file, xlsx);
  return { book, file, bytes: xlsx.length };
}

server.registerTool(
  'shimo_list_sheets',
  {
    description:
      '列出石墨表格的全部工作表名（底部标签页）。石墨没有 sheet 清单 API，本工具走一次 xlsx 导出通道并本地解析（约 5~20 秒），' +
      '顺带返回每个工作表的行列数、表头语言列与落盘的 xlsx 路径。结果较稳定可少量复用；仅需要数据时直接用 shimo_read_sheet。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const meta = await getFileMeta(guid, credentials(args).cookie).catch(() => null);
    const { book, file, bytes } = await exportAndParse(guid, credentials(args));
    const sheets = book.sheetNames.map((name) => {
      const grid = book.sheets[name] || [];
      const headers = (grid[0] || []).filter(Boolean);
      const langCols = detectLanguageColumns(headers);
      const nonEmptyRows = grid.slice(1).filter((r) => r.some((c) => String(c).trim())).length;
      return {
        name,
        rows: nonEmptyRows,
        cols: headers.length,
        languages: langCols.length ? langCols.map((c) => c.lang) : undefined,
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
            exported: { file, bytes },
            sheets,
          }),
        },
      ],
    };
  }
);

// ─── 工具4：导出 xlsx 落盘 ───────────────────────────────────────

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
    const dir = path.resolve(args.outputPath || process.env.SHIMO_EXPORT_DIR || path.join(process.cwd(), '.mcp-local'));
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

// ─── 工具5：语言映射导出（i18n JSON） ─────────────────────────────

server.registerTool(
  'shimo_export_i18n',
  {
    description:
      '读取指定工作表并生成各语言的 key→文案 映射 JSON（落盘或直接返回）。' +
      'key 默认按「txt_中文首字编码+石墨行号」生成（中文缺失退化为 txt_row_行号），与 multilingual-excel-converter 脚本一致；传 keyColumn 则改用指定列的值作为 key。' +
      '行语义：只有中文有值的行视为分组行不导出（返回 skippedGroups 计数）；其他语言列缺值时用英文兜底，但漏填事实会记录在 missing 字段（行号/中文原文/缺的语言）并附 warning，提醒操作人员补填。' +
      '含换行的文案自动按行拆成 key_0/key_1…。语言列按表头自动识别；languages 可只导出指定语言。适合直接喂给前端 i18n 框架。',
    inputSchema: {
      url: z.string().optional().describe('石墨文档链接；不传时使用环境变量 SHIMO_URL'),
      sheet: z.string().describe('工作表名'),
      languages: z.array(z.string()).optional().describe('只要这些语言（语言码或表头名）。默认全部识别到的语言'),
      keyColumn: z.string().optional().describe('显式指定作为 key 的列名。不传时默认生成 txt_中文首字编码+行号 形式的 key'),
      rows: z.array(z.number()).optional().describe('只取这些行（石墨 UI 行号）'),
      outputPath: z.string().optional().describe('传了就把每个语言写成 <lang>.json 落盘，返回路径；不传则直接返回 JSON 内容'),
      cookie: z.string().optional(),
    },
  },
  async (args) => {
    const guid = requireGuid(args.url);
    const creds = credentials(args);
    const data = await readSheet(guid, args.sheet, creds, {
      ...(args.rows?.length ? { rows: args.rows } : {}),
      ...(args.languages?.length ? { languages: args.languages } : {}),
      limit: 0,
    });
    const { translations, warnings, skippedGroups, missing } = toLanguageMap(data, { ...(args.keyColumn ? { keyColumn: args.keyColumn } : {}) });

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
