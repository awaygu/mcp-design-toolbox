// shimo-client.ts — 石墨公开版 API 客户端（Cookie 直调，无需浏览器）
//
// 已验证的端点（2026-09 实测）：
//   GET  /api/sas/files/{guid}/sheets/values?range={sheet}!A1:Z{end}   行列数据（≤5000 单元格/次）
//   GET  /lizard-api/files/{guid}?encryptedContentUrl=true             文件元数据（名称/权限）
//   POST /panda-api/drive/batch_downloads {guids:[guid]}               创建导出任务（整文件 xlsx 打包 ZIP）
//   GET  /panda-api/drive/tasks/{taskId}                               轮询任务进度，完成后 detail.url 为下载地址
//
// 注意：sheet（工作表）清单没有 REST 接口，清单从导出的 xlsx 读（exportWorkbook 返回 sheetNames），
// 或由用户直接给工作表名。

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
  };
}

async function requestJson<T>(url: string, cookie: string, init?: RequestInit): Promise<T> {
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
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ShimoHttpError(res.status, `石墨 API 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 150)}`);
  }
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
  const j = await requestJson<any>(`${BASE}/lizard-api/files/${guid}?encryptedContentUrl=true`, cookie);
  return {
    guid: j.guid,
    name: j.name,
    role: j.role,
    type: j.type,
    updatedAt: j.updatedAt,
    views: j.views,
  };
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

/** 读一个工作表的矩形区域（1-based 行号闭区间），返回原始二维数组 */
async function readRange(guid: string, sheet: string, startRow: number, endRow: number, maxCol: number, cookie: string): Promise<unknown[][]> {
  const range = `${sheet}!A${startRow}:${colLetter(maxCol - 1)}${endRow}`;
  const url = `${BASE}/api/sas/files/${guid}/sheets/values?range=${encodeURIComponent(range)}`;
  const j = await requestJson<{ values?: unknown[][]; lag?: number }>(url, cookie);
  return j.values || [];
}

/**
 * 读单个工作表全量（分页）。
 * @param maxCol 读取列数，默认 26（A:Z）
 */
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
      // 空行也占位（保持石墨行号对齐：数组下标 + 1 = 石墨行号）
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
