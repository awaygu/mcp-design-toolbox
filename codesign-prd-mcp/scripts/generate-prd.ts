#!/usr/bin/env node
/**
 * 命令行工具：爬取指定需求分组，生成纯文本结构化需求文档
 *
 * 用法:
 *   npm run generate -- --url=<分享链接> --group=<分组名> [--password=<访问密码>]
 * 或通过环境变量提供（便于 CI 与本地 .env）:
 *   CODESIGN_URL / CODESIGN_GROUP / CODESIGN_PASSWORD
 *
 * 流程：打开链接 → 遍历页面 → 分段截图 → VLM解析 → 合并 → 生成文档
 */
import * as fs from 'fs';
import * as path from 'path';
import { openShareLink, getPageOutline, getGroupPages } from '../src/crawler.js';
import { closeBrowser } from '../src/browser.js';
import { isVLMConfigured } from '../src/vlm.js';
import { processPages } from '../src/pipeline.js';
import { generateRequirementDoc } from '../src/doc-generator.js';
import { errorMessage, safeName } from '../src/utils.js';
import type { PageType } from '../src/types.js';

const OUTPUT_DIR = path.join(process.cwd(), 'output');

/** 页面类型 → 中文名 */
const TYPE_LABELS: Record<PageType, string> = {
  flowchart: '流程图',
  table: '配置表',
  page: '普通页面',
  image: '内嵌图',
};

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
    '  npm run generate -- --url=<分享链接> --group=<分组名> [--password=<访问密码>]'
  );
  console.error('也可通过环境变量提供：CODESIGN_URL / CODESIGN_GROUP / CODESIGN_PASSWORD');
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('=== 生成需求文档（分段截图 + VLM 解析版）===\n');

  const vlmOn = isVLMConfigured();
  console.log(`VLM 状态: ${vlmOn ? '已启用' : '未配置（仅 DOM 提取）'}\n`);

  // 1. 打开链接
  console.log('[1/5] 打开 CoDesign 链接...');
  await openShareLink(SHARE_URL, PASSWORD);

  // 2. 获取大纲
  console.log('[2/5] 获取页面大纲...');
  const outline = await getPageOutline();
  const groupItem = outline.find((i) => i.name.includes(GROUP_NAME));
  console.log(`      目标分组: ${groupItem?.name}`);

  // 3. 爬取分组页面（含分段截图）
  console.log('[3/5] 爬取分组页面（分段截图）...');
  const pagesData = await getGroupPages(GROUP_NAME, SHARE_URL);
  console.log(`      共 ${pagesData.length} 个页面`);
  pagesData.forEach((p) => {
    const segInfo = p.isSegmented ? `, ${p.segmentCount}段截图` : ', 单张截图';
    console.log(`      - ${p.pageName}: ${(p.text || '').length}字符${segInfo}`);
  });

  // 4. VLM 解析 + 合并（跨页全局并发）
  console.log('[4/5] VLM 解析 + 结果合并...');
  const mergedPages = await processPages(pagesData, SHARE_URL, {
    onPageDone: (pageName, { cached, segments, vlmSkipped }) => {
      const tag = vlmSkipped ? '[跳过VLM·仅DOM]' : cached ? '[缓存命中]' : '[VLM解析]';
      console.log(`      ${tag} ${pageName} (${segments}段)`);
    },
  });

  // 5. 生成文档
  console.log('[5/5] 生成纯文本结构化需求文档...');
  const doc = generateRequirementDoc({
    groupName: GROUP_NAME,
    sourceUrl: SHARE_URL,
    pages: mergedPages,
    detailLevel: 'standard',
  });

  // 保存
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const baseName = safeName(GROUP_NAME);
  const outputPath = path.join(OUTPUT_DIR, `${baseName}_需求文档_v2.md`);
  fs.writeFileSync(outputPath, doc);

  // 保存合并后的结构化数据
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${baseName}_merged_v2.json`),
    JSON.stringify(mergedPages, null, 2)
  );

  console.log(`\n✅ 需求文档已生成: ${outputPath}`);
  console.log(`✅ 结构化数据: ${path.join(OUTPUT_DIR, `${baseName}_merged_v2.json`)}`);

  // 打印摘要
  console.log(`\n=== 内容摘要 ===`);
  mergedPages.forEach((p) => {
    const vlmInfo = p._hasVLM ? 'VLM解析' : '仅DOM';
    const warnInfo = p.warnings?.length ? `, ${p.warnings.length}个警告` : '';
    console.log(`- ${p.pageName} [${TYPE_LABELS[p.type] ?? p.type}] (${vlmInfo}${warnInfo})`);
  });

  await closeBrowser();
}

main().catch(async (err: unknown) => {
  console.error('❌ 生成失败:', errorMessage(err));
  await closeBrowser();
  process.exit(1);
});
