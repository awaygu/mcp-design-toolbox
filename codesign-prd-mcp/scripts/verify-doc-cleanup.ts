/**
 * 文档输出清理回归验证：说明与规则去重 / 相邻同表头表格合并 / 页面文字去重去噪。
 * 用合成页面复现画布型大页的三类冗余，断言清理后输出。运行：npx tsx scripts/verify-doc-cleanup.ts
 */
import { generateSinglePageDoc, generateRequirementDoc } from '../src/doc-generator.js';
import type { MergedPage } from '../src/types.js';

const CONGRATS = '恭喜【用户昵称】获得【活动奖励】';

const page: MergedPage = {
  pageName: '原型',
  type: 'page',
  domText: [
    CONGRATS, // 被控件块覆盖 → 剔除
    '<', // 纯符号 → 剔除
    '?', // 纯符号 → 剔除
    '余额：💎16255', // 独有 → 保留
    '余额：💎16255', // 重复 → 剔除
    '玩法流程：使用活动道具参与对应场次的活动 玩法入口：1.观众可见所有页面；', // 整段被控件块覆盖 → 剔除
    '—', // 纯符号 → 剔除
    '第三步', // 独有 → 保留
    '第三步', // 重复 → 剔除
    '胜', // 1 字行不做包含判定 → 保留
  ].join('\n'),
  tables: [
    { headers: ['序号', '页面', '返回情况'], rows: [['1', 'A', 'x'], ['2', 'B', 'y']] },
    { headers: ['序号', '页面', '返回情况'], rows: [['3', 'C', 'z']] }, // 同表头相邻 → 合并
    { headers: ['名称', '值'], rows: [['k', 'v']] },
  ],
  images: [],
  blocks: [
    { i: 1, type: '矩形', name: '', lines: [CONGRATS], imgs: 0, rect: null },
    { i: 2, type: '矩形', name: '', lines: [CONGRATS], imgs: 0, rect: null },
    { i: 3, type: '矩形', name: '', lines: [CONGRATS], imgs: 0, rect: null },
    {
      i: 4,
      type: '矩形',
      name: '',
      lines: ['玩法流程：使用活动道具参与对应场次的活动', '玩法入口：1.观众可见所有页面；'],
      imgs: 0,
      rect: null,
    },
    { i: 5, type: '矩形', name: '', lines: ['奖励1名称', '积分'], imgs: 0, rect: null },
    { i: 6, type: '矩形', name: '', lines: ['奖励1名称', '积分'], imgs: 0, rect: null },
    { i: 7, type: '矩形', name: '', lines: ['斗一把'], imgs: 0, rect: null },
  ],
  vlmResult: {},
  warnings: [],
  _segmentCount: 2,
  _hasVLM: false,
};

const doc = generateSinglePageDoc(page, 'standard');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : ` → ${detail}`}`);
  if (!ok) failed += 1;
}

const tableSection = doc.slice(doc.indexOf('**表格'), doc.indexOf('**说明与规则'));
check('同表头相邻表格已合并：3 行数据在同一张表', /\| 1 \| A \| x \|/.test(tableSection) && /\| 3 \| C \| z \|/.test(tableSection));
check('表格编号合并后重排（共 2 张）', doc.includes('**表格 2**') && !doc.includes('**表格 3**'));

check('规则去重计数 ×3', doc.includes(`- ${CONGRATS} ×3`));
check('规则去重头部说明（6 条→3 条）', doc.includes('**说明与规则**（3 条，3 条重复已合并，DOM 确定性提取）'));
check('多行规则块去重 ×2', doc.includes('- 奖励1名称 ×2'));

check('页面文字剔除被覆盖的飘屏文案', !(doc.split('**页面文字**')[1] || '').includes(CONGRATS));
const fallback = doc.split('**页面文字**')[1] || '';
check('页面文字保留独有行（余额/第三步/胜）', ['余额：💎16255', '第三步', '胜'].every((s) => fallback.includes(s)));
check('页面文字剔除纯符号行与重复行', !fallback.split('\n').some((l) => ['<', '?', '—'].includes(l.trim())) && fallback.includes('已剔除 7 行'));

// ── 空间分组：带 sec 归属的画布页，文案按界面区块分组而非页面级平铺 ──
const spatialPage: MergedPage = {
  pageName: '原型',
  type: 'page',
  domText: '',
  tables: [],
  images: [],
  sections: [
    { x: 0, y: 100, w: 375, h: 813, text: '', images: 1 },
    { x: 500, y: 100, w: 375, h: 813, text: '', images: 1 },
  ],
  blocks: [
    { i: 1, type: '矩形', name: '', lines: ['斗一把'], imgs: 0, rect: { x: 10, y: 120, w: 80, h: 30 }, sec: 0 },
    { i: 2, type: '矩形', name: '', lines: [CONGRATS], imgs: 0, rect: { x: 10, y: 200, w: 300, h: 24 }, sec: 0 },
    { i: 3, type: '矩形', name: '', lines: [CONGRATS], imgs: 0, rect: { x: 10, y: 240, w: 300, h: 24 }, sec: 0 },
    { i: 4, type: '矩形', name: '', lines: ['匹配中'], imgs: 0, rect: { x: 510, y: 120, w: 90, h: 30 }, sec: 1 },
    { i: 5, type: '矩形', name: '', lines: ['全局规则一', '细节行'], imgs: 0, rect: { x: 1000, y: 120, w: 400, h: 60 }, sec: -1 },
    { i: 6, type: '矩形', name: '', lines: ['页面标题'], imgs: 0, rect: { x: 1000, y: 20, w: 200, h: 30 }, sec: -1 },
  ],
  vlmResult: {},
  warnings: [],
  _segmentCount: 2,
  _hasVLM: false,
};

const sdoc = generateSinglePageDoc(spatialPage, 'standard');
const sec1 = sdoc.split('##### 区块 1')[1]?.split('##### 区块 2')[0] || '';
const sec2 = sdoc.split('##### 区块 2')[1]?.split('**画布级')[0] || '';
const canvasSec = sdoc.split('**画布级')[1] || '';

check('空间分组：区块 1 内联文案含归属标签', sec1.includes('界面文案：斗一把'));
check('空间分组：区块 1 示例文案去重 ×2 且归属区块', sec1.includes(`- ${CONGRATS} ×2`) && !sec2.includes(CONGRATS));
check('空间分组：区块 2 只含自己的文案', sec2.includes('匹配中') && !sec2.includes('斗一把'));
check('空间分组：画布级单独成节（全局规则）', canvasSec.includes('全局规则一') && canvasSec.includes('页面标题'));
check('空间分组：不再出现页面级平铺标题', !sdoc.includes('**界面文案清单**') && !sdoc.includes('**说明与规则**'));

// ── 表格标题推断：表格旁的标注文本块 → table.title ──
import { inferTableTitles } from '../src/merger.js';
import type { MergedTable } from '../src/types.js';

const TITLE = '奖励明细列表(活动结束时部分奖励手动发放、其他奖励自动发放）';
const mkBlock = (i: number, lines: string[], x: number, y: number, w = 300, h = 24) =>
  ({ i, type: '矩形', name: '', lines, imgs: 0, rect: { x, y, w, h } });

const tA: MergedTable = { headers: ['排名'], rows: [['1']], rect: { x: 100, y: 500, w: 500, h: 300 } };
const tB: MergedTable = { headers: ['名称'], rows: [['k']], rect: { x: 100, y: 1500, w: 500, h: 200 } };
const titleBlocks = [
  mkBlock(1, [TITLE], 120, 440),            // tA 正上方 → 命中
  mkBlock(2, ['下方注释'], 120, 830),        // tA 正下方 30px（也更近），但正上方优先级内 tA 已有上方块；对 tB 距离 670 超限 → 不命中
  mkBlock(3, ['tB的标题'], 120, 1440),      // tB 正上方 → 命中
  mkBlock(4, ['远处的无关文本'], 2000, 100), // 水平无重叠 → 不命中
  mkBlock(5, ['与表格纵向重叠的内容'], 120, 600), // 纵向重叠 → 不作标题
];
inferTableTitles([tA, tB], titleBlocks as any);
check('表格标题推断：正上方标注块成为标题', tA.title === TITLE);
check('表格标题推断：第二张表各自命中', tB.title === 'tB的标题');
check('表格标题推断：无重叠/纵向重叠/超距块不命中', !titleBlocks.some((b) => b.lines[0] === '远处的无关文本' && tB.title === b.lines[0]) && tA.title !== '下方注释');

const titledDoc = generateSinglePageDoc(
  { ...spatialPage, tables: [{ headers: ['h'], rows: [['v']], title: TITLE }] } as MergedPage,
  'standard'
);
check('表格标题渲染：编号 + 语义标题', titledDoc.includes(`**表格 1 · ${TITLE}**`));

// ─── 章节编号连续性 ───────────────────────────────────────────
// 三个正文章节都是条件渲染的，编号写死过 → 没有流程图页时会直接从标题跳到
// 「二、页面详情」，读起来像断章。编号必须动态递增。
const plainPage = { ...page, type: 'page' as const, tables: [], images: [], imageAnalysis: [] } as MergedPage;
const docNoFlow = generateRequirementDoc({
  groupName: 'G',
  sourceUrl: 'u',
  pages: [plainPage],
  detailLevel: 'standard',
});
const headings = docNoFlow.match(/^## .+$/gm) || [];
check(
  '章节编号连续（无流程图页时页面详情为「一」）',
  headings[0] === '## 一、页面详情' && headings[1] === '## 二、附录',
  headings.join(' / ')
);
check('附录子编号跟随章节号', docNoFlow.includes('### 2.1 解析来源与置信度') && docNoFlow.includes('### 2.2 待确认项'));

// ─── 内嵌图解析失败可见性 ──────────────────────────────────────
// 失败图曾被静默丢弃：文档看上去「内嵌图已全覆盖」，实际漏掉的可能是关键规则图
const docImgFail = generateSinglePageDoc(
  {
    ...page,
    tables: [],
    images: [],
    imageAnalysis: [
      { src: 'img14.png', localPath: 'shots/activity_imgs/img14.png', texts: [], error: 'VLM 返回内容无法解析为结构化结果' },
      { src: 'img16.png', localPath: 'shots/activity_imgs/img16.png', texts: ['入门场'], summary: '场次门槛图', isPlaceholder: false },
    ],
  } as MergedPage,
  'standard'
);
check('内嵌图解析失败被点名而非静默丢弃', docImgFail.includes('**内嵌图解析失败**（1 张') && docImgFail.includes('img14.png'));
check('正常图仍照常渲染', docImgFail.includes('**场次门槛图**') && docImgFail.includes('入门场'));

process.exit(failed ? 1 : 0);
