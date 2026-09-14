#!/usr/bin/env node
/**
 * 测试脚本：直接调用 crawler 模块，验证 CoDesign 原型爬取
 *
 * 用法:
 *   npm run test:crawl -- --url=<分享链接> --group=<分组名> [--password=<访问密码>]
 * 或通过环境变量提供：CODESIGN_URL / CODESIGN_GROUP / CODESIGN_PASSWORD
 */
import { openShareLink, getPageOutline, getGroupPages } from '../src/crawler.js';
import { closeBrowser } from '../src/browser.js';
import { errorMessage, safeName } from '../src/utils.js';
import type { CrawledPage, OutlineNode } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';

const OUTPUT_DIR = path.join(process.cwd(), 'output');

/** 解析 --key=value 形式的命令行参数 */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const arg of argv.slice(2)) {
    const matched = arg.match(/^--(url|group|password)=(.+)$/);
    if (matched) args[matched[1]] = matched[2];
  }
  return args;
}

const args = parseArgs(process.argv);
const SHARE_URL = args.url || process.env.CODESIGN_URL || '';
const PASSWORD = args.password || process.env.CODESIGN_PASSWORD || '';
const GROUP_NAME = args.group || process.env.CODESIGN_GROUP || '';

// 分享链接与访问密码属于凭据，不入库，只从命令行或环境变量读取
if (!SHARE_URL || !GROUP_NAME) {
  console.error('缺少必填参数。用法：');
  console.error(
    '  npm run test:crawl -- --url=<分享链接> --group=<分组名> [--password=<访问密码>]'
  );
  console.error('也可通过环境变量提供：CODESIGN_URL / CODESIGN_GROUP / CODESIGN_PASSWORD');
  process.exit(1);
}

/** 把爬取结果写成 Markdown 汇总 */
function buildSummary(groupName: string, pages: CrawledPage[]): string {
  let summary = `# ${groupName} - 爬取结果汇总\n\n`;
  summary += `页面数: ${pages.length}\n\n`;
  summary += `---\n\n`;

  pages.forEach((page) => {
    summary += `## ${page.pageName}\n\n`;
    if (page.error) {
      summary += `**错误**: ${page.error}\n\n`;
    } else {
      if (page.text) {
        summary += `### 文字内容\n\n\`\`\`\n${page.text}\n\`\`\`\n\n`;
      }
      if (page.tables?.length) {
        summary += `### 表格 (${page.tables.length}个)\n\n`;
        page.tables.forEach((t, i) => {
          summary += `**表${i + 1}**: ${t.headers?.join(' | ') || ''}\n\n`;
        });
      }
      const segCount = (page.segments || []).length;
      summary += segCount ? `截图: ${segCount} 段\n\n` : `截图: 无\n\n`;
    }
    summary += `---\n\n`;
  });

  return summary;
}

/** 打印目录树 */
function printOutline(outline: OutlineNode[]): void {
  outline.forEach((item) => {
    const indent = '  '.repeat(item.level);
    const icon = item.isGroup ? '📁' : '📄';
    console.log(`      ${indent}${icon} ${item.name}`);
  });
}

async function main(): Promise<void> {
  console.log('=== CoDesign 原型爬取测试 ===\n');

  // 1. 打开链接 + 输入密码
  console.log('[1/5] 打开分享链接...');
  await openShareLink(SHARE_URL, PASSWORD);
  console.log('      链接已打开，密码已输入\n');

  // 2. 获取页面大纲
  console.log('[2/5] 获取页面大纲...');
  const outline = await getPageOutline();
  console.log(`      共 ${outline.length} 个目录项`);
  printOutline(outline);
  console.log('');

  // 3. 找到目标分组
  console.log(`[3/5] 定位分组 "${GROUP_NAME}"...`);
  const groupItem = outline.find((item) => item.name.includes(GROUP_NAME));
  if (!groupItem) {
    console.log('      ❌ 未找到目标分组');
    await closeBrowser();
    process.exit(1);
  }
  console.log(`      ✅ 找到分组，层级: ${groupItem.level}\n`);

  // 4. 获取分组下所有页面
  console.log('[4/5] 爬取分组下所有页面...');
  const pages = await getGroupPages(GROUP_NAME, SHARE_URL);
  console.log(`      共获取 ${pages.length} 个页面\n`);

  // 5. 输出结果
  console.log('[5/5] 保存结果...');
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 保存大纲
  fs.writeFileSync(path.join(OUTPUT_DIR, 'outline.json'), JSON.stringify(outline, null, 2));

  // 保存每个页面的内容
  pages.forEach((page, i) => {
    const pageDir = path.join(OUTPUT_DIR, `page_${i + 1}_${safeName(page.pageName)}`);
    fs.mkdirSync(pageDir, { recursive: true });

    fs.writeFileSync(path.join(pageDir, 'text.txt'), page.text || '');
    fs.writeFileSync(path.join(pageDir, 'tables.json'), JSON.stringify(page.tables || [], null, 2));

    // 复制分段截图到输出目录（crawler 返回的是 segments 数组，不再有单张 screenshot）
    const segments = page.segments || [];
    segments.forEach((src, si) => {
      if (fs.existsSync(src)) {
        const dest = path.join(pageDir, `segment_${String(si + 1).padStart(2, '0')}.png`);
        fs.copyFileSync(src, dest);
      }
    });

    console.log(`      ✅ 页面 ${i + 1}: ${page.pageName}`);
    console.log(`         文字长度: ${(page.text || '').length} 字符`);
    console.log(`         表格数: ${(page.tables || []).length}`);
    console.log(`         截图: ${segments.length ? `${segments.length} 段` : '无'}`);
    if (page.error) console.log(`         错误: ${page.error}`);
  });

  // 生成汇总 Markdown
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'summary.md'),
    buildSummary(GROUP_NAME, pages)
  );
  console.log(`\n✅ 全部完成！结果保存在: ${OUTPUT_DIR}`);

  await closeBrowser();
}

main().catch(async (err: unknown) => {
  console.error('❌ 测试失败:', errorMessage(err));
  await closeBrowser();
  process.exit(1);
});
