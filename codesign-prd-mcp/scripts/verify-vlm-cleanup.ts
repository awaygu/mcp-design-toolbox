/**
 * VLM 输出清洗回归：播放器工具 UI 过滤 + DOM/VLM 数值冲突检测
 * 用例取自真实输出（原型.md），离线运行：npx tsx scripts/verify-vlm-cleanup.ts
 */
import { filterToolUi, detectNumericConflicts, mergePageResult } from '../src/merger.js';

let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
}

// ─── 1. 工具 UI 过滤（样本为原型.md 中真实出现的条目） ─────────
const sample = {
  page_type: '产品原型/流程图页',
  layout: '',
  components: [
    { name: '画布分页控件', type: '工具栏', description: '原型工具的视图控件：3/6页、默认比例，非产品功能元素' },
    { name: 'Figma导航条', type: '工具栏', description: "页码'3/6'、翻页箭头、'默认比例'缩放选项" },
    { name: 'Axure原型工具条', type: '工具栏', description: "页面指示'3/6'、左右翻页箭头、'默认比例'缩放选项" },
    { name: '原型查看器分页控件', type: '按钮/分页器', description: '包含画板缩略图按钮、左右翻页箭头、当前页码3/6' },
    { name: '返回按钮', type: '按钮', description: "圆形'<'返回按钮" },
    { name: '随机匹配按钮', type: '主操作按钮', description: "'随机匹配'宽按钮，发起匹配的主操作" },
    { name: '页面顶部栏', type: '导航栏', description: '用户头像、用户名称、人气值98.3K' },
  ],
  interactions: [
    'Axure工具条左右箭头可在原型页面间翻页（当前3/6）',
    '「默认比例」下拉框：切换画布缩放比例',
    '点击返回按钮返回上一级',
    '点击【随机匹配】发起匹配',
  ],
  states: ['文档查看态：第3/6页、默认比例显示', '匹配中状态（按钮文案变化，等待匹配）'],
  states_detail: [
    { element: '原型查看器分页控件', state: '常驻', condition: '' },
    { element: '场次卡片-高级场', state: '置灰/禁用', condition: '积分<50' },
    { element: '随机匹配按钮', state: '置灰', condition: '未选场次和战兽' },
  ],
  key_info: ['原型文档页码：3/6', '积分规则：入门场获胜1场+1积分', '活动时间：2026.01.01 - 2026.01.10'],
  visual_hierarchy: '',
};

const f = filterToolUi(sample);
console.log('\n【工具 UI 过滤】');
check('组件 7 → 3（滤除 4 个工具 UI）', f.components.length === 3, `实际 ${f.components.length}`);
check('保留「返回按钮」', f.components.some((c) => c.name === '返回按钮'));
check('保留「随机匹配按钮」', f.components.some((c) => c.name === '随机匹配按钮'));
check('保留「页面顶部栏」（不误伤产品导航栏）', f.components.some((c) => c.name === '页面顶部栏'));
check('交互 4 → 2', f.interactions.length === 2, `实际 ${f.interactions.length}`);
check('状态 2 → 1', f.states.length === 1, `实际 ${f.states.length}`);
check('关键信息 3 → 2', f.key_info.length === 2, `实际 ${f.key_info.length}`);
check('不误伤日期 2026.01.01（点号分隔）', f.key_info.some((k) => k.includes('2026.01.01')));
check('结构化状态 3 → 2（滤除工具 UI 元素）', (f.states_detail || []).length === 2, `实际 ${(f.states_detail || []).length}`);
check(
  '保留「场次卡片-高级场」状态三元组',
  (f.states_detail || []).some((s) => s.element === '场次卡片-高级场' && s.condition === '积分<50')
);

// ─── 2. 数值冲突检测（原型.md 中真实存在的矛盾） ───────────────
console.log('\n【数值冲突检测】');
const domText = `
  初级场：20积分开启 高级场：50积分开启 顶级场：100积分开启
  场次开启门槛：入门场获胜1场+1积分、初级场+3积分、高级场+5积分、顶级场+15积分
`;
const vlmTexts = [
  '积分规则：入门场获胜1场+1积分、初级场+2积分、高级场+3积分、顶级场+5积分',
  '积分榜单说明：入门场获胜1场+1积分、初级场+2积分',
];
const conflicts = detectNumericConflicts(domText, vlmTexts);
console.log(conflicts.map((c) => `   · ${c}`).join('\n'));
check('检出冲突（期望 ≥1 条）', conflicts.length >= 1, `实际 ${conflicts.length} 条`);
check(
  '命中初级场 20 vs 2 或 3 vs 2',
  conflicts.some((c) => c.includes('初级场')),
  conflicts.find((c) => c.includes('初级场')) || ''
);
check(
  '未对一致项误报（入门场均为 1）',
  !conflicts.some((c) => c.includes('入门场'))
);

// 无冲突场景不应误报
const noConflict = detectNumericConflicts(domText, ['入门场获胜1场+1积分']);
check('数值一致时不报冲突', noConflict.length === 0, `实际 ${noConflict.length} 条`);

// VLM 命中 DOM 中已有的合法值（初级场获胜 +3 积分在 DOM 中存在）→ 不报
const hitDomValue = detectNumericConflicts(domText, ['初级场获胜1场+3积分']);
check('VLM 值命中 DOM 记录时不报冲突', hitDomValue.length === 0, `实际 ${hitDomValue.length} 条`);

// ─── 3. 端到端：图内文字必须进入冲突检测（P1 修复点） ───────────
// 真实事故：错值 +2/+3/+5 来自「积分规则图」，而 DOM 表格是 1/3/5/15。
// 修复前 imageAnalysis 未喂给 detectNumericConflicts，待确认项为空。
console.log('\n【端到端：内嵌图文字参与冲突检测】');
const merged = mergePageResult({
  pageName: '原型',
  type: 'page',
  domText,
  vlmSegments: [],
  imageAnalysis: [
    { src: 'u12.png', localPath: 'u12.png', summary: '积分规则说明图', texts: ['初级场+2积分', '高级场+3积分', '顶级场+5积分'] },
  ],
});
const imgConflicts = merged.warnings.filter((w) => w.includes('以 DOM 为准'));
console.log(imgConflicts.map((c) => `   · ${c}`).join('\n'));
check(
  '内嵌图错值被检出（修复前为 0 条）',
  imgConflicts.length >= 1,
  `实际 ${imgConflicts.length} 条`
);
check(
  '图内冲突指明初级场 2 分',
  imgConflicts.some((c) => c.includes('初级场') && c.includes('2积分'))
);

// 图片与 DOM 一致时不应产生噪音
const mergedClean = mergePageResult({
  pageName: '原型',
  type: 'page',
  domText,
  vlmSegments: [],
  imageAnalysis: [
    { src: 'u12.png', localPath: 'u12.png', summary: '积分规则说明图', texts: ['初级场+3积分'] },
  ],
});
check(
  '图内文字与 DOM 一致时不产生冲突噪音',
  mergedClean.warnings.filter((w) => w.includes('以 DOM 为准')).length === 0
);

// 内嵌图解析失败必须进入告警：静默丢图会连带让本该报出的数值冲突消失
const mergedImgFail = mergePageResult({
  pageName: '原型',
  type: 'page',
  domText,
  vlmSegments: [],
  imageAnalysis: [
    { src: 'img14.png', localPath: 'a/img14.png', texts: [], error: 'VLM 返回内容无法解析为结构化结果' },
  ],
});
check(
  '内嵌图解析失败会进入告警（提示数值未经校验）',
  mergedImgFail.warnings.some((w) => w.includes('内嵌图解析失败 1 张'))
);
check(
  '无失败图时不产生多余告警',
  !mergedClean.warnings.some((w) => w.includes('内嵌图解析失败'))
);

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
