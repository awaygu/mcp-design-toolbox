/**
 * 缓存模块
 * 避免重复调用 VLM，基于截图文件内容哈希做缓存
 *
 * 缓存键：url + pageName + 截图文件 md5 + VLM 版本指纹
 * 缓存值：VLM 解析结果 JSON
 * 存储位置：.codesign-mcp/cache/{hash}.json
 *
 * vlmVersion 取自 vlm.js 的 getVlmVersion()（Prompt 版本 + 模型名），
 * 保证改动 Prompt 或更换模型后旧缓存自动失效。
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { CacheKeyParams, CacheStats, VlmResult } from './types.js';

const CACHE_DIR = path.join(process.cwd(), '.codesign-mcp', 'cache');

/**
 * 确保缓存目录存在
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * 计算文件的 md5 哈希
 */
function fileHash(filePath: string): string {
  try {
    const data = fs.readFileSync(filePath);
    return createHash('md5').update(data).digest('hex');
  } catch {
    return '';
  }
}

/**
 * 生成缓存键
 */
function generateCacheKey({
  url,
  pageName,
  imagePaths = [],
  type,
  vlmVersion = '',
}: CacheKeyParams): string {
  const hashes = imagePaths.map((p) => fileHash(p)).filter(Boolean);
  const raw = `${url}::${pageName}::${type}::${vlmVersion}::${hashes.join(',')}`;
  return createHash('md5').update(raw).digest('hex');
}

/**
 * 获取缓存，未命中返回 null
 */
export function getCache(params: CacheKeyParams): VlmResult[] | null {
  ensureCacheDir();
  const key = generateCacheKey(params);
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);

  try {
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as VlmResult[];
      return data;
    }
  } catch (err) {
    console.warn('读取缓存失败:', (err as Error).message);
  }
  return null;
}

/**
 * 写入缓存
 */
export function setCache(params: CacheKeyParams, value: VlmResult[]): void {
  ensureCacheDir();
  const key = generateCacheKey(params);
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);

  try {
    fs.writeFileSync(cacheFile, JSON.stringify(value, null, 2), 'utf-8');
  } catch (err) {
    console.warn('写入缓存失败:', (err as Error).message);
  }
}

/**
 * 检查缓存是否命中
 */
export function hasCache(params: CacheKeyParams): boolean {
  return getCache(params) !== null;
}

/**
 * 清空缓存
 * @returns 被清掉的缓存条数与字节数；删除失败时 failed 为 true
 */
export function clearCache(): CacheStats {
  const before = cacheStats();
  try {
    if (fs.existsSync(CACHE_DIR)) {
      fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('清空缓存失败:', (err as Error).message);
    return { ...before, failed: true };
  }
  return before;
}

/**
 * 获取缓存统计
 */
export function cacheStats(): CacheStats {
  ensureCacheDir();
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
    let totalSize = 0;
    files.forEach((f) => {
      const stat = fs.statSync(path.join(CACHE_DIR, f));
      totalSize += stat.size;
    });
    return { total: files.length, size: totalSize };
  } catch {
    return { total: 0, size: 0 };
  }
}

/**
 * 缓存目录绝对路径，便于在提示信息中展示
 */
export function cacheDir(): string {
  return CACHE_DIR;
}
