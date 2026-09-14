#!/usr/bin/env node
/**
 * lanhu-login.mjs — 交互式登录蓝湖，导出 cookie 串到本地文件（供 MCP 的 LANHU_COOKIE_FILE 读取）。
 * 用法：node lanhu-login.mjs
 *   → 弹出浏览器手动登录蓝湖，回终端按 Enter，把当前 context 的 cookie 拼成串写入 OUT（默认 .mcp-local/lanhu.cookie，已 gitignore）。
 *   → 写入后 MCP 进程下次调用会自动读到新 cookie，无需重启 shell。
 * 需 playwright：npm i playwright && npx playwright install chromium
 *
 * OUT 可用环境变量 LANHU_COOKIE_OUT 覆盖；默认相对当前工作目录（建议在仓库根运行，写到 ./.mcp-local/lanhu.cookie）。
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGIN_URL = process.env.LANHU_LOGIN_URL || 'https://lanhuapp.com/';
// 默认写到仓库根的 .mcp-local/lanhu.cookie（与 .mcp.json 的 LANHU_COOKIE_FILE 对齐）。
// 基于脚本自身位置定位（本脚本在 <仓库根>/mcp/lanhu-design-mcp/ 下，往上两级即仓库根），
// 不依赖 CWD——无论从哪个目录运行（README 的 npm run login / 直接 node），都写对位置。
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.LANHU_COOKIE_OUT || join(SCRIPT_DIR, '..', '..', '.mcp-local', 'lanhu.cookie');

async function main() {
  // 用 playwright 自带 chromium（lanhu-login.bat 已装，幂等秒过）；不依赖系统 Chrome，
  // 未装 Chrome 的小白机器也能跑（channel:'chrome' 会因找不到系统 Chrome 直接报错）
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  console.log(`请在打开的浏览器中登录蓝湖：${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  console.log('登录完成后，回到此终端按 Enter 导出 cookie…');
  await new Promise((r) => process.stdin.once('data', r));

  // 取当前 context 全部 cookie，拼成 "name=value; name=value" 串
  const cookies = await context.cookies();
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  await browser.close();

  if (!cookieStr) {
    throw new Error('未取到任何 cookie，请确认浏览器已完成登录');
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, cookieStr, 'utf8');
  console.log(`✅ 已导出 ${cookies.length} 条 cookie 到 ${OUT}（已被 .gitignore 忽略，请勿提交）`);
  console.log('   MCP 进程下次调用会自动读取该文件，无需重启。');
}

main().catch((e) => {
  console.error('登录失败：', e?.message || e);
  console.error('请确认已安装 playwright：npm i playwright && npx playwright install chromium');
  process.exit(1);
});
