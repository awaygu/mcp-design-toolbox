// shimo-client.test.ts — parseSheetTokens 单元测试（fixture 为 2026-09-22 公网实抓样本改编）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetTokens } from './shimo-client.js';

// 覆盖实测出现的全部 token 排布：B,C / 压缩产生的同段双 B 共享一个 C*、
// 杂散双 B（"用户反馈"/"xxx" 二选一真实，宁可都列出）；G: token 已刻意不解析
const RAW = [
  '1h6f2:bk6!bjn@T1k$19:3!1#5!2# 03!8#5!5#', // 压缩串前缀，无可匹配 token
  '["j","B:邀请活动","G:abc12","C*0",',       // G: 混在流里，应被忽略
  '"B:新手主播","C*1",',
  '"B:宰牲节活动","C*2",',
  '"B:1 V 1斗兽","G:eCSlJ","B:工作表75","C*74",',
  '"j","B:用户反馈","B:xxx","G:5p5cs","C*76",',
  '"G:yiX0Q","B:工作表77","C*77"]',
].join('');

test('解析全部排布形态，名字与序号一一对应', () => {
  const sheets = parseSheetTokens(RAW);
  assert.deepEqual(
    sheets.map((s) => [s.name, s.index]),
    [
      ['邀请活动', 0],
      ['新手主播', 1],
      ['宰牲节活动', 2],
      ['1 V 1斗兽', 74],
      ['工作表75', 74],
      ['用户反馈', 76],
      ['xxx', 76],
      ['工作表77', 77],
    ]
  );
});

test('G: token 被忽略，不影响名字与序号解析', () => {
  const sheets = parseSheetTokens(RAW);
  assert.equal(sheets.length, 8);
  assert.ok(sheets.every((s) => !('guid' in s)));
});

test('结果按 index 排序且名字去重', () => {
  const sheets = parseSheetTokens(RAW);
  const indexes = sheets.map((s) => s.index);
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  assert.equal(new Set(sheets.map((s) => s.name)).size, sheets.length);
});

test('压缩串前缀 / 空串 / 无 token 文本返回空数组', () => {
  assert.deepEqual(parseSheetTokens('1h6f2:bk6!bjn@T1k$19:3!1#5!2#'), []);
  assert.deepEqual(parseSheetTokens(''), []);
  assert.deepEqual(parseSheetTokens('普通文档正文，没有 token'), []);
});

test('重复名字只保留首个', () => {
  const raw = '["B:表A","C*0","B:表A","G:zz","C*1"]';
  const sheets = parseSheetTokens(raw);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0]?.name, '表A');
  assert.equal(sheets[0]?.index, 0);
});
