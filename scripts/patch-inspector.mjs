#!/usr/bin/env node
/**
 * patch-inspector.mjs — 给 MCP Inspector v2 的超时短板打补丁
 *
 * 背景一（web 后端）：web 模式下浏览器 → 后端 /api/mcp/send 会等 MCP 响应到达才返回，
 * 这个等待在 clients/web/build/index.js 里硬编码 60s（waitForRequestResponse 的默认参数 6e4），
 * 没有 UI 设置、环境变量或 config 字段能改它，progress 通知也重置不了它。
 * 超过 60s 的工具调用会报「MCP request N timed out after 60000ms」。
 * 补丁：默认值改为读环境变量 MCP_SEND_WAIT_TIMEOUT_MS（默认 600000 = 10 分钟）。
 *
 * 背景二（CLI）：CLI 构造 InspectorClient 时漏传 timeout——config 文件的 requestTimeout
 * 被解析进 settings 却没有任何消费点（TUI/web 都正确接线了，唯独 CLI 漏了），SDK 永远走
 * 默认 60s，报「Request timed out」。CLI 又固定 progress:false，进度重置机制也救不了。
 * 补丁：在构造选项里注入 timeout = 环境变量 MCP_REQUEST_TIMEOUT_MS（>0 时生效）。
 *
 * 对 npx 缓存与本地 node_modules 里的所有 inspector 副本幂等生效。
 * 用法：node scripts/patch-inspector.mjs
 * 注意：npx 缓存被清理或 inspector 升级后需重跑本脚本。
 */
import { readdirSync, readFileSync, existsSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

/** web 后端：/api/mcp/send 的响应等待 60s 硬编码 → 可配置（默认 1800s = 30 分钟） */
const WEB_PATCH = {
  name: 'web 后端 send 等待超时',
  file: 'clients/web/build/index.js',
  // 兼容两种现状：原始硬编码 60s；旧版补丁的 600s 默认（升级到 1800s）
  originals: [
    'waitForRequestResponse(requestId, timeoutMs = 6e4)',
    'waitForRequestResponse(requestId, timeoutMs = Number(process.env.MCP_SEND_WAIT_TIMEOUT_MS) || 6e5)',
  ],
  patched: 'waitForRequestResponse(requestId, timeoutMs = Number(process.env.MCP_SEND_WAIT_TIMEOUT_MS) || 18e5)',
};

/** CLI：InspectorClient 构造漏传 timeout（config 的 requestTimeout 无人消费）→ 注入环境变量 */
const CLI_PATCH = {
  name: 'CLI 客户端 requestTimeout 接线',
  file: 'clients/cli/build/index.js',
  original: 'progress: false,\n    sample: false,\n    elicit: false,',
  patched:
    'progress: false,\n    sample: false,\n    elicit: false,\n' +
    '    ...(Number(process.env.MCP_REQUEST_TIMEOUT_MS) > 0 && { timeout: Number(process.env.MCP_REQUEST_TIMEOUT_MS) }),',
};

const PATCHES = [WEB_PATCH, CLI_PATCH];

function findFiles(relFile) {
  const files = [];
  const npxDirs = [
    join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx'),
    join(homedir(), '.npm', '_npx'),
  ];
  for (const dir of npxDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry, 'node_modules', '@modelcontextprotocol', 'inspector', relFile);
      if (existsSync(file)) files.push(file);
    }
  }
  const local = join(process.cwd(), 'node_modules', '@modelcontextprotocol', 'inspector', relFile);
  if (existsSync(local)) files.push(local);
  return files;
}

function syntaxOk(file, content) {
  const tmp = file + '.patch-check.mjs';
  try {
    writeFileSync(tmp, content, 'utf8');
    const check = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    return check.status === 0 ? true : check.stderr.slice(0, 200);
  } finally {
    rmSync(tmp, { force: true });
  }
}

let patched = 0;
for (const p of PATCHES) {
  for (const file of findFiles(p.file)) {
    const src = readFileSync(file, 'utf8');
    if (src.includes(p.patched)) {
      console.log(`✅ [${p.name}] 已补丁过，跳过：${file}`);
      continue;
    }
    const originals = p.originals ?? [p.original];
    const hit = originals.find((o) => src.split(o).length - 1 === 1);
    if (!hit) {
      console.log(`⚠️ [${p.name}] 未找到唯一目标代码（0 或多个匹配，可能已升级改版），跳过：${file}`);
      continue;
    }
    const out = src.replace(hit, p.patched);
    const check = syntaxOk(file, out);
    if (check !== true) {
      console.log(`❌ [${p.name}] 补丁后语法校验失败，已放弃写入 ${file}：${check}`);
      continue;
    }
    writeFileSync(file, out, 'utf8');
    console.log(`🔧 [${p.name}] 已补丁：${file} [${statSync(file).size} bytes]`);
    patched++;
  }
}
console.log(patched ? `\n完成：${patched} 处已补丁。重启 inspector 生效。` : '\n没有新补丁需要应用。');
