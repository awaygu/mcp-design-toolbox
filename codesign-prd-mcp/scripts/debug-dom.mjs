/**
 * 调试脚本：对比「当前 innerText 清洗」与「结构化块提取」的输出差异。
 *
 * 用法：
 *   node scripts/debug-dom.mjs                  # 分析 document/ 下的本地 Axure HTML
 *   node scripts/debug-dom.mjs --url=<分享链接>  # 打开线上原型，逐页抓取并对比
 *
 * 产物：.debug-out/<页面名>-current.txt（现有清洗结果）
 *       .debug-out/<页面名>-structured.txt（结构化结果）
 */
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const arg = (k) => {
  const m = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return m ? m.slice(k.length + 3) : undefined;
};
const OUT_DIR = path.join(process.cwd(), '.debug-out');
const OUTLINE_LIMIT = Number(arg('pages') || 99);

/**
 * 结构化提取：只用 Axure 导出的语义标记，不依赖布局/CSS。
 * 语义来源：① 控件前导注释 `<!-- 名称 (类型) -->`  ② .table_cell + svg viewbox 坐标
 *          ③ .text 内的 <p> 行结构  ④ display:none 的隐藏文本  ⑤ img/svg 数量
 */
function structuredExtract() {
  const base = document.getElementById('base') || document.body;

  const metaOf = (el) => {
    let n = el.previousSibling;
    while (n) {
      if (n.nodeType === 8) {
        const m = (n.textContent || '').match(/^(.*?)\s*\((.*?)\)\s*$/);
        if (m) return { name: m[1].trim(), type: m[2].trim() };
      }
      if (n.nodeType === 1) break;
      n = n.previousSibling;
    }
    return null;
  };

  const isHidden = (el) => {
    const s = (el.getAttribute('style') || '') + ' ' + (el.getAttribute('class') || '');
    return /display:\s*none/.test(s) || /visibility:\s*hidden/.test(s);
  };

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /** .text 内的 <p> 行（保留行结构，而不是 innerText 揉成一坨） */
  const textLines = (el) => {
    const t = el.querySelector('.text');
    if (!t || isHidden(t)) return null;
    const ps = Array.from(t.querySelectorAll('p'));
    const lines = (ps.length ? ps : [t]).map((p) => norm(p.textContent));
    const kept = lines.filter((l) => l.length > 0);
    return kept.length ? kept : null;
  };

  /** viewbox="x y w h"：Axure 把控件坐标写进内联 svg，无需布局即可取到 */
  const rectOf = (el) => {
    const svg = el.querySelector('svg[viewbox], svg[viewBox]');
    if (!svg) return null;
    const vb = (svg.getAttribute('viewbox') || svg.getAttribute('viewBox') || '')
      .trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb.every((n) => Number.isFinite(n))) {
      return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
    }
    return null;
  };

  // ── 1. 表格：.table_cell + viewbox 坐标 → 确定性网格 ──
  const tables = [];
  for (const container of base.querySelectorAll('.ax_default')) {
    const cells = Array.from(container.querySelectorAll(':scope > .table_cell'));
    if (cells.length < 4) continue;
    const items = cells.map((c) => ({
      r: rectOf(c) || { x: 0, y: 0, w: 0, h: 0 },
      text: (textLines(c) || ['']).join('<br>'),
    }));
    const rowKeys = [];
    for (const it of [...items].sort((a, b) => a.r.y - b.r.y)) {
      if (!rowKeys.length || it.r.y - rowKeys[rowKeys.length - 1] > 2) rowKeys.push(it.r.y);
    }
    const colKeys = [];
    for (const it of [...items].sort((a, b) => a.r.x - b.r.x)) {
      if (!colKeys.length || it.r.x - colKeys[colKeys.length - 1] > 3) colKeys.push(it.r.x);
    }
    const near = (keys, v) => {
      let best = 0, bd = Infinity;
      keys.forEach((k, i) => { const d = Math.abs(v - k); if (d < bd) { bd = d; best = i; } });
      return best;
    };
    const grid = Array.from({ length: rowKeys.length }, () => Array.from({ length: colKeys.length }, () => ''));
    for (const it of items) grid[near(rowKeys, it.r.y)][near(colKeys, it.r.x)] = it.text;
    const filled = grid.flat().filter((c) => c !== '').length;
    if (rowKeys.length >= 2 && colKeys.length >= 2 && filled / (rowKeys.length * colKeys.length) >= 0.3) {
      tables.push({ headers: grid[0], rows: grid.slice(1) });
    }
  }

  // ── 2. 文本块：按文档顺序，带控件类型 ──
  const blocks = [];
  let idx = 0;
  for (const el of base.querySelectorAll('.ax_default')) {
    if (el.classList.contains('table_cell')) continue;
    if (el.querySelector(':scope > .table_cell')) continue;
    if (el.closest('.table_cell')) continue;
    const meta = metaOf(el);
    const lines = textLines(el);
    const imgs = el.querySelectorAll('img, svg.generatedImage').length;
    if (!lines && imgs === 0) continue;
    blocks.push({
      i: ++idx,
      type: meta?.type || el.className.match(/_([^\s]+)/)?.[1] || '?',
      name: meta?.name && meta.name !== 'Unnamed' ? meta.name : '',
      lines: lines || [],
      imgs,
    });
  }

  return { tables, blocks };
}

function render(s) {
  const out = [];
  if (s.tables.length) {
    out.push(`【表格 × ${s.tables.length}】`, '');
    s.tables.forEach((t) => {
      out.push('| ' + t.headers.join(' | ') + ' |');
      out.push('| ' + t.headers.map(() => '---').join(' |') + ' |');
      t.rows.forEach((r) => out.push('| ' + r.join(' | ') + ' |'));
      out.push('');
    });
  }
  out.push(`【文本块 × ${s.blocks.length}（按文档顺序）】`, '');
  s.blocks.forEach((b) => {
    const tag = b.name ? `${b.type}:${b.name}` : b.type;
    out.push(b.lines.length ? `#${b.i} [${tag}] ${b.lines.join(' / ')}` : `#${b.i} [${tag}] <${b.imgs} 张图>`);
  });
  return out.join('\n');
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
fs.mkdirSync(OUT_DIR, { recursive: true });

const url = arg('url');

if (url) {
  // ── 线上模式：打开链接 → 读目录 → 逐页导航并对比两种提取 ──
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.t-tree', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const items = await page.evaluate(() => {
    const tree = document.querySelector('.t-tree');
    if (!tree) return [];
    const out = [];
    tree.querySelectorAll('.t-tree__item').forEach((item, domIndex) => {
      const label = item.querySelector(':scope > .t-tree__label .label-text');
      const name = label?.textContent?.trim();
      if (!name) return;
      const isGroup = !!item.querySelector(':scope > .t-tree__label .total-text');
      const m = (item.getAttribute('style') || '').match(/--level:\s*(\d+)/);
      out.push({ name, isGroup, level: m ? +m[1] : 0, domIndex });
    });
    return out;
  });
  console.log('目录树：', items.map((i) => `${i.isGroup ? '[组]' : ''}${i.name}`).join(' / '));

  const axureFrame = async () => {
    const el = await page.$('.axure-container iframe');
    return el ? await el.contentFrame() : null;
  };

  let n = 0;
  for (const it of items) {
    if (it.isGroup || n >= OUTLINE_LIMIT) continue;
    n++;
    const oldFrame = await axureFrame();
    const oldUrl = oldFrame?.url() || '';
    await page.evaluate((i) => {
      const tree = document.querySelector('.t-tree');
      tree?.querySelectorAll('.t-tree__item')[i]
        ?.querySelector(':scope > .t-tree__label')?.click();
    }, it.domIndex);

    let changed = false;
    for (let k = 0; k < 24; k++) {
      await page.waitForTimeout(250);
      const f = await axureFrame();
      if (f && (f !== oldFrame || f.url() !== oldUrl)) { changed = true; break; }
    }
    if (!changed) { console.log(`  ${it.name}: 未检测到 iframe 切换，跳过`); continue; }
    await page.waitForTimeout(1200);

    const frame = await axureFrame();
    if (!frame) { console.log(`  ${it.name}: 无 iframe`); continue; }
    const current = await frame.evaluate(() => document.body.innerText);
    const structured = await frame.evaluate(structuredExtract);
    const safe = it.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
    fs.writeFileSync(path.join(OUT_DIR, `${safe}-current.txt`), current);
    fs.writeFileSync(path.join(OUT_DIR, `${safe}-structured.txt`), render(structured));
    console.log(
      `  ${it.name}: 现有 ${current.length} 字符（${current.split('\n').filter(Boolean).length} 行）` +
      ` | 结构化 表格${structured.tables.length} 块${structured.blocks.length}`
    );
  }
  console.log(`\n产物已写入 ${OUT_DIR}`);
} else {
  // ── 本地模式：分析 document/ 下导出的 Axure HTML ──
  const dir = path.join(process.cwd(), 'document');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    await page.goto('file:///' + path.join(dir, f).replace(/\\/g, '/'), { waitUntil: 'load' });
    const current = await page.evaluate(() => document.body.innerText);
    const structured = await page.evaluate(structuredExtract);
    const base = path.basename(f, '.html');
    fs.writeFileSync(path.join(OUT_DIR, `${base}-current.txt`), current);
    fs.writeFileSync(path.join(OUT_DIR, `${base}-structured.txt`), render(structured));
    console.log(
      `${base}: 现有 ${current.length} 字符 | 结构化 表格${structured.tables.length} 块${structured.blocks.length}`
    );
  }
}

await browser.close();
