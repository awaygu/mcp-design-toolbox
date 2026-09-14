// 验证 normalize 对真实蓝湖数据的圆角/描边解析
import { readFileSync } from 'node:fs';
import { normalizeSketch } from '../src/normalize.js';

const json = JSON.parse(readFileSync(new URL('./.mcp-local-raw-design.json', import.meta.url), 'utf8'));
const { layers, meta } = normalizeSketch(json);
console.log(`total=${meta.totalLayerCount} dropped=${meta.droppedLayerCount} bytes=${meta.payloadBytes}`);
for (const name of ['Rectangle 9942', 'Rectangle 9943', 'Rectangle 9944', 'Rectangle 83']) {
  const hits = layers.filter((l) => l.name === name);
  for (const h of hits.slice(0, 2)) {
    console.log(name, JSON.stringify({ x: h.x, y: h.y, w: h.w, h: h.h, fill: h.fill, gradient: h.gradient ? 'yes' : undefined, radius: h.radius, borderRadius: h.borderRadius, border: h.border }));
  }
}
// 带描边图层的总数与样例
const withBorder = layers.filter((l) => l.border);
console.log(`带描边图层: ${withBorder.length}`);
for (const l of withBorder.slice(0, 4)) console.log('  -', l.name, JSON.stringify(l.border));
// 带逐角圆角的总数
const withBR = layers.filter((l) => l.borderRadius);
console.log(`带逐角圆角图层: ${withBR.length}`, withBR.slice(0, 3).map((l) => l.name));
