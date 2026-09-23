// shimo-client.ts — 石墨公开版 API 客户端（Cookie 直调）。只读客户端：
// 石墨存在建表/删表写端点（POST、DELETE .../sheets），刻意不封装。
// lizard-api 的 content 接口必须带 X-Requested-With: XMLHttpRequest，否则 403。

const BASE = (process.env.SHIMO_BASE_URL || 'https://shimo.im').replace(/\/+$/, '');

export class ShimoHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ShimoHttpError';
  }
}

export interface Credentials {
  cookie: string;
}

function headers(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Accept: 'application/json, text/plain, */*',
    Referer: `${BASE}/`,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

async function requestRaw(url: string, cookie: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, { ...init, headers: headers(cookie), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new ShimoHttpError(res.status,
        `石墨鉴权失败（HTTP ${res.status}）：cookie 缺失/过期，或对该文档无权限。` +
        `请重新登录 shimo.im → F12 → Network → 复制任意请求的 Cookie 头，更新 SHIMO_COOKIE 或 cookie 文件。`);
    }
    if (res.status === 404) {
      throw new ShimoHttpError(404, `资源不存在（HTTP 404）：${url.slice(0, 120)}。请检查文档链接/工作表名。`);
    }
    throw new ShimoHttpError(res.status, `石墨 API HTTP ${res.status}：${text.slice(0, 200)}`);
  }
  return text;
}

async function requestJson<T>(url: string, cookie: string, init?: RequestInit): Promise<T> {
  const text = await requestRaw(url, cookie, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ShimoHttpError(200, `石墨 API 返回非 JSON：${text.slice(0, 150)}`);
  }
}

/** content 等端点返回纯文本（私有序列化格式），不能走 JSON 通道 */
async function requestText(url: string, cookie: string): Promise<string> {
  return requestRaw(url, cookie);
}

// ─── URL/ID 解析 ───────────────────────────────────────────────

/** 从链接或纯 id 提取石墨文件 guid（/sheets/、/docs/、/docx/ 均可） */
export function extractFileId(input: string): string {
  if (!input) throw new Error('需要石墨文档链接或文件 id');
  const m = input.match(/\/(?:sheets|docs|docx|file)\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9]{10,}$/.test(input.trim())) return input.trim();
  throw new Error(`无法从输入提取石墨文件 id：${input.slice(0, 100)}`);
}

// ─── 元数据 / 探活 ─────────────────────────────────────────────

export interface FileMeta {
  guid: string;
  name: string;
  role: string;
  type: string;
  updatedAt: string;
  views?: number;
}

export async function getFileMeta(guid: string, cookie: string): Promise<FileMeta> {
  const cached = metaCache.get(guid);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.meta;
  const j = await requestJson<any>(`${BASE}/lizard-api/files/${guid}?encryptedContentUrl=true`, cookie);
  const meta: FileMeta = {
    guid: j.guid,
    name: j.name,
    role: j.role,
    type: j.type,
    updatedAt: j.updatedAt,
    views: j.views,
  };
  metaCache.set(guid, { at: Date.now(), meta });
  return meta;
}

/** cookie 探活：区分「cookie 过期」与「单文档无权限」。不抛错，返回结构化结果。 */
export async function checkAuth(opts: Credentials, guid?: string): Promise<
  | { ok: true; user: string; file?: FileMeta }
  | { ok: false; reason: string; hint: string }
> {
  if (!opts.cookie) {
    return { ok: false, reason: 'no_cookie', hint: '未配置石墨 cookie。浏览器登录 shimo.im → F12 → Network → 复制任意请求的 Cookie 头。' };
  }
  try {
    const me = await requestJson<any>(`${BASE}/lizard-api/users/me`, opts.cookie);
    const user = me?.name || me?.email || String(me?.id ?? 'unknown');
    if (guid) {
      const file = await getFileMeta(guid, opts.cookie);
      return { ok: true, user, file };
    }
    return { ok: true, user };
  } catch (e) {
    const err = e as ShimoHttpError;
    if (err instanceof ShimoHttpError && err.status === 401) {
      return { ok: false, reason: 'cookie_expired', hint: err.message };
    }
    return { ok: false, reason: err.message.includes('403') ? 'forbidden' : 'error', hint: err.message };
  }
}

// ─── 工作表清单（content API 解析，只读） ────────────────────────

export interface SheetInfo {
  name: string;
  /** sheet 在文档内的序号（来自 "C*nn" token，作排序用；个别 token 缺失时可能多个名字共享同一序号） */
  index: number;
}

// TTL 缓存：server 常驻，同一文档短时间会反复取；key 仅用 guid（单账号场景）
const CACHE_TTL_MS = 60_000;
const sheetListCache = new Map<string, { at: number; sheets: SheetInfo[] }>();
const metaCache = new Map<string, { at: number; meta: FileMeta }>();

/**
 * 解析 content 文本里的 sheet 清单："B:名字" 与 "C*序号" token 以 C* 为界配对；
 * 每个分段里的每个 B 都产出一条记录——宁可多列（杂散 B）也不漏列真实 sheet。
 */
export function parseSheetTokens(raw: string): SheetInfo[] {
  const tokens = [...raw.matchAll(/"(B:[^"]+|C\*\d+)"/g)].map((m) => m[1]);
  const sheets: SheetInfo[] = [];
  let names: string[] = [];
  const flush = (index: number): void => {
    for (const name of names) sheets.push({ name, index });
    names = [];
  };
  for (const t of tokens) {
    if (t.startsWith('B:')) names.push(t.slice(2));
    else flush(Number.parseInt(t.slice(2), 10));
  }
  const seen = new Set<string>();
  const unique: SheetInfo[] = [];
  for (const s of sheets) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      unique.push(s);
    }
  }
  return unique.sort((a, b) => a.index - b.index);
}

/** 列出工作表（60s 进程内缓存） */
export async function listSheets(guid: string, cookie: string): Promise<SheetInfo[]> {
  const cached = sheetListCache.get(guid);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.sheets;
  const raw = await requestText(`${BASE}/lizard-api/files/${guid}/content`, cookie);
  const sheets = parseSheetTokens(raw);
  sheetListCache.set(guid, { at: Date.now(), sheets });
  return sheets;
}

// ─── 行列数据（values API，分页） ────────────────────────────────

const BLOCK_ROWS = 180;          // 180 行 × 26 列 = 4680 < 5000 单元格/次限制
const EMPTY_TAIL_THRESHOLD = 50; // 连续空行超此数视为数据结束
const MAX_BLOCKS = 200;          // 安全上限 ~36000 行

/** A1 记法列号 → 列字母（0 → A） */
export function colLetter(index0: number): string {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 读矩形区域：行 1-based 闭区间；列 0-based [startCol0, maxCol-1]，默认从 A 列起 */
export async function readRange(guid: string, sheet: string, startRow: number, endRow: number, maxCol: number, cookie: string, startCol0 = 0): Promise<unknown[][]> {
  const range = `${sheet}!${colLetter(startCol0)}${startRow}:${colLetter(maxCol - 1)}${endRow}`;
  const url = `${BASE}/api/sas/files/${guid}/sheets/values?range=${encodeURIComponent(range)}`;
  const j = await requestJson<{ values?: unknown[][]; lag?: number }>(url, cookie);
  return j.values || [];
}

/** 石墨对不存在的工作表名返回 500 而非 404：借清单核对，翻译成可行动的报错。 */
export async function translateSheetReadError(err: unknown, guid: string, sheet: string, cookie: string): Promise<Error> {
  if (!(err instanceof ShimoHttpError) || err.status !== 500) return err as Error;
  let names: string[] | null = null;
  try {
    names = (await listSheets(guid, cookie)).map((s) => s.name);
  } catch {
    // 清单接口也失败（权限/网络）时退回通用提示
  }
  if (names?.includes(sheet)) {
    return new Error(`读取工作表「${sheet}」失败：石墨服务端错误（HTTP 500）。该表确实存在，可能服务临时故障，请稍后重试。`);
  }
  const preview = names
    ? `该文档共有 ${names.length} 个工作表${names.length > 20 ? '（前 20 个）' : ''}：${names.slice(0, 20).join('、')}${names.length > 20 ? '…' : ''}。完整清单可用 shimo_list_sheets 查看`
    : '可用 shimo_list_sheets 查看该文档的工作表清单';
  return new Error(`工作表「${sheet}」不存在（石墨对不存在的表名返回 HTTP 500）。${preview}`);
}

/** 读单表全量（分块分页，空尾启发式停止） */
export async function readSheetRaw(guid: string, sheet: string, cookie: string, maxCol = 26): Promise<{ rows: unknown[][]; truncated: boolean }> {
  const all: unknown[][] = [];
  let startRow = 1;
  let consecutiveEmpty = 0;
  let truncated = false;

  for (let block = 1; block <= MAX_BLOCKS; block++) {
    const endRow = startRow + BLOCK_ROWS - 1;
    let rows: unknown[][];
    try {
      rows = await readRange(guid, sheet, startRow, endRow, maxCol, cookie);
    } catch (e) {
      // 首块失败是真错误；后续块失败多为越界，视为结束
      if (block === 1) throw e;
      break;
    }
    if (!rows.length) break;

    for (const row of rows) {
      const isEmpty = !row || row.every((c) => c == null || String(c).trim() === '');
      if (isEmpty) {
        consecutiveEmpty++;
        if (all.length > 0 && consecutiveEmpty >= EMPTY_TAIL_THRESHOLD) {
          return { rows: all, truncated };
        }
      } else {
        consecutiveEmpty = 0;
      }
      // 空行也占位，保持行号对齐：数组下标+1=石墨行号
      all.push(row || []);
    }

    if (rows.length < BLOCK_ROWS) break;
    startRow += BLOCK_ROWS;
    if (block === MAX_BLOCKS) truncated = true;
  }
  return { rows: all, truncated };
}

// ─── xlsx 导出（batch_downloads 任务） ──────────────────────────

export interface ExportHandle {
  taskId: string;
  downloadUrl: string;
  fileName: string;
}

/** 创建导出任务并轮询到完成，返回下载地址 */
export async function exportWorkbook(guid: string, cookie: string, timeoutMs = 120000): Promise<ExportHandle> {
  const created = await requestJson<any>(`${BASE}/panda-api/drive/batch_downloads`, cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guids: [guid] }),
  });
  const taskId: string = created?.data?.id;
  if (!taskId) throw new Error(`创建导出任务失败：${JSON.stringify(created).slice(0, 200)}`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1600));
    const t = await requestJson<any>(`${BASE}/panda-api/drive/tasks/${taskId}`, cookie);
    const d = t?.data || {};
    if (d.completed) {
      const url: string | undefined = d.detail?.url;
      if (!url) throw new Error(`导出任务完成但无下载地址：${JSON.stringify(d).slice(0, 200)}`);
      return { taskId, downloadUrl: url, fileName: d.name || guid };
    }
    if (d.progress === 0 && d.totalFiles === 0 && Date.now() - new Date(d.createdAt).getTime() > 30000) {
      throw new Error('导出任务 30 秒无进度，可能文档过大或服务端繁忙，请稍后重试');
    }
  }
  throw new Error(`导出任务超时（${timeoutMs}ms），taskId=${taskId}。可稍后用 export 工具重试。`);
}

/** 下载导出产物（ZIP，内含一个 xlsx），返回 Buffer */
export async function downloadExportZip(handle: ExportHandle): Promise<Buffer> {
  const res = await fetch(handle.downloadUrl, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new ShimoHttpError(res.status, `下载导出文件失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
