#!/usr/bin/env node
// compress-images.mjs — 存量切图目录批量压到 2x（in-place 覆盖）
// 背景：lanhu-design-mcp 的 lanhu_download_slices 现已下载即压 2x；本脚本用于处理
// 之前下载的 4x 存量图（蓝湖 CDN 固定返回 4x，pixel = 设计尺寸 × 4）。
// ⚠️ 已经被压缩过的 2x 目录不要再跑（会变 1x）。
//
// 用法：node scripts/compress-images.mjs <目录> [--factor 0.5] [--dry-run]
//   --factor  尺寸缩放系数，默认 0.5（4x→2x）
//   --dry-run 只统计不落盘
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const factorIdx = args.indexOf('--factor');
const factor = factorIdx >= 0 ? Number(args[factorIdx + 1]) || 0.5 : 0.5;
const dryRun = args.includes('--dry-run');

if (!dir) {
  console.error('用法：node scripts/compress-images.mjs <目录> [--factor 0.5] [--dry-run]');
  process.exit(1);
}

const fmt = (n) => (n / 1024).toFixed(1) + 'KB';
const pngSize = (b) => (b[0] === 0x89 ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : '?');
const files = readdirSync(dir).filter((f) => /\.png$/i.test(extname(f)));
let totalBefore = 0, totalAfter = 0, changed = 0;

for (const f of files) {
  const file = join(dir, f);
  const buf = readFileSync(file);
  const before = buf.length;
  const meta = await sharp(buf).metadata().catch(() => null);
  if (!meta || !meta.width || !meta.height) { console.error(`  跳过 ${f}: 无法读取尺寸`); continue; }
  const target = await sharp(buf)
    .resize(Math.round(meta.width * factor), Math.round(meta.height * factor), { fit: 'fill' })
    .png({ palette: true, compressionLevel: 9, quality: 90 })
    .toBuffer();
  if (target.length < before) {
    changed++;
    totalBefore += before;
    totalAfter += target.length;
    if (!dryRun) writeFileSync(file, target);
    console.log(`  ${f}: ${pngSize(buf)} ${fmt(before)} → ${pngSize(target)} ${fmt(target.length)}`);
  } else {
    console.log(`  ${f}: 压缩无收益（${fmt(before)}），保留原图`);
  }
}

if (totalBefore) {
  console.log(`\n共 ${files.length} 张 PNG，压缩 ${changed} 张${dryRun ? '（dry-run 未落盘）' : ''}，合计 ${fmt(totalBefore)} → ${fmt(totalAfter)}（省 ${Math.round((1 - totalAfter / totalBefore) * 100)}%）`);
} else {
  console.log(`\n共 ${files.length} 张 PNG，无需要压缩的图`);
}
