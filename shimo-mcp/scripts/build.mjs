// esbuild 打包构建：单文件 + minify。本 server 纯 Node 内置 fetch，无 native 依赖
import { rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  legalComments: 'eof',
  logLevel: 'info',
});
console.log('✅ dist/index.js 构建完成（单文件 + minify）');
