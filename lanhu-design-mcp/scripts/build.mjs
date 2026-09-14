// esbuild 打包构建：单文件 + minify。sharp/playwright 是 native/动态依赖，保持外部引用
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
  external: ['sharp', 'playwright'],
  legalComments: 'eof',
  logLevel: 'info',
});
console.log('✅ dist/index.js 构建完成（单文件 + minify）');
