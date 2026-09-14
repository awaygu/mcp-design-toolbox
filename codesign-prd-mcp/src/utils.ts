/**
 * 通用小工具
 */
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';

/** 工具 handler 收到的 extra 参数类型（与 SDK registerTool 回调签名一致） */
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * 把请求 _meta 里的 progressToken 包装成进度上报函数。
 * 宿主没带 token（未请求进度）时是 no-op；单条通知失败只吞掉——进度上报绝不能打断主流程。
 * Inspector 等宿主每收到一条 progress 通知就会重置请求计时器，
 * 因此长工具只要持续上报，就能绕过宿主默认 60s 的请求超时。
 */
export function createProgressNotifier(extra?: ToolExtra): (message: string) => void {
  const progressToken = extra?._meta?.progressToken;
  let step = 0;
  return (message: string): void => {
    if (progressToken === undefined) return;
    void extra!
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: step++, message },
      })
      .catch(() => undefined);
  };
}

/**
 * 给「内部没有事件回调的长 await」包一层心跳：VLM 单次调用实测可达 100s+，
 * 期间没有任何通知的话，宿主默认 60s 请求超时照样掐断，进度通知也救不回来。
 * 心跳保证任意 60s 窗口内至少有一条通知（15s 间隔），同时给用户可见的「还活着」反馈。
 */
export function withHeartbeat<T>(
  report: (message: string) => void,
  task: () => Promise<T>,
  opts: { stage?: string; intervalMs?: number } = {}
): Promise<T> {
  const stage = opts.stage ? `${opts.stage}：` : '';
  const intervalMs = opts.intervalMs ?? 15_000;
  let seconds = 0;
  const timer = setInterval(() => {
    seconds += Math.round(intervalMs / 1000);
    report(`${stage}已进行 ${seconds}s，仍在执行…`);
  }, intervalMs);
  return task().finally(() => clearInterval(timer));
}

/**
 * 统一取出错误信息。strict 模式下 catch 变量是 unknown，
 * 直接用 err.message 会编译失败，这里做一次收口。
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * 从当前模块位置向上逐级找 package.json。
 * tsx 直接跑源码（src/）与 tsc 编译产物（dist/src/）相对包根的深度不同，
 * 逐级上溯可以避免写死相对路径。
 */
function findPackageJson(fromUrl: string): string | null {
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 读取本包 package.json，失败返回空对象 */
export function readPackageJson(fromUrl: string): Record<string, unknown> {
  const file = findPackageJson(fromUrl);
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 包名版本，取不到时回落到兜底值 */
export function packageVersion(fromUrl: string, fallback = '0.0.0'): string {
  const version = readPackageJson(fromUrl).version;
  return typeof version === 'string' && version ? version : fallback;
}

/** 等待固定毫秒 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把任意文本收敛成安全文件名（保留中英文、数字、下划线、短横线） */
export function safeName(name: string): string {
  return name.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
}

/** 字节数格式化 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
