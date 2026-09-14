/**
 * 端到端验证：真实链接 → 爬取 → 结构化提取 → 新文档格式。
 * 用法：npx tsx scripts/verify-pipeline.ts [--vlm]
 */
import * as fs from 'fs';
import * as path from 'path';
import { openShareLink, getPageOutline, getGroupPages } from '../src/crawler.js';
import { closeBrowser } from '../src/browser.js';
import { processPages } from '../src/pipeline.js';
import { generateRequirementDoc } from '../src/doc-generator.js';
import { errorMessage, safeName } from '../src/utils.js';

const URL = process.env.CODESIGN_URL || 'https://codesign.qq.com/app/s/718937414344666';
const GROUP = process.env.CODESIGN_GROUP || '示例活动';
const USE_VLM = process.argv.includes('--vlm');

async function main(): Promise<void> {
  console.log(`目标：${GROUP} @ ${URL}  VLM=${USE_VLM ? 'on' : 'off'}\n`);

  const t0 = Date.now();
  await openShareLink(URL);
  const outline = await getPageOutline();
  console.log(`[1] 大纲 ${outline.length} 节点，耗时 ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const pages = await getGroupPages(GROUP, URL, {
    onProgress: (m) => console.log(`    · ${m}`),
  });
  console.log(`[2] 爬取 ${pages.length} 页，耗时 ${Date.now() - t1}ms`);
  pages.forEach((p) => {
    console.log(
      `    - ${p.pageName}: 文本 ${p.text.length} 字 / 表格 ${p.tables.length} / 控件块 ${p.blocks?.length ?? 0} / 拓扑 ${p.flow ? `${p.flow.nodes.length}节点 ${p.flow.edges.length}边` : '无'} / 截图 ${p.segmentCount} 段${p.error ? ` / 错误 ${p.error}` : ''}`
    );
  });

  const t2 = Date.now();
  const merged = await processPages(pages, URL, {
    vlmEnabled: USE_VLM,
    onProgress: (m) => console.log(`    · ${m}`),
    contextFor: (p) => `需求分组：${GROUP}；页面：${p.pageName}`,
  });
  console.log(`[3] 解析合并完成，耗时 ${Date.now() - t2}ms`);

  const doc = generateRequirementDoc({
    groupName: GROUP,
    sourceUrl: URL,
    pages: merged,
    detailLevel: 'standard',
  });

  const outDir = path.join(process.cwd(), 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const base = safeName(GROUP);
  const mdPath = path.join(outDir, `${base}_需求文档.md`);
  const jsonPath = path.join(outDir, `${base}_结构化数据.json`);
  fs.writeFileSync(mdPath, doc, 'utf-8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      merged.map((p) => ({
        pageName: p.pageName,
        type: p.type,
        _hasVLM: p._hasVLM || false,
        _segmentCount: p._segmentCount || 0,
        tables: p.tables,
        blocks: p.blocks || [],
        flow: p.flow || null,
        vlm: p.vlmResult,
        warnings: p.warnings,
      })),
      null,
      2
    ),
    'utf-8'
  );

  console.log(`\n[4] 文档 ${doc.length} 字 → ${mdPath}`);
  console.log(`    结构化数据 → ${jsonPath}`);
  await closeBrowser();
}

main().catch(async (err: unknown) => {
  console.error('❌ 失败:', errorMessage(err));
  await closeBrowser();
  process.exit(1);
});
