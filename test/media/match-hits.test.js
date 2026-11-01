// test/media/match-hits.test.js —— 文档定位的命中计数与片段（ticket 9z5.23）
//
// 纯函数，不触网、不读文件。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DOC_SNIPPET_RADIUS, buildSnippet, countHits } from '../../src/media/match.js';

const PAGE = [
  'Neonatal antibodies against the mouse A1BG antigen were removed by',
  'deimmunization. The workflow for artificial intelligence-directed',
  'deimmunization relies on a chimeric scaffold. A second deimmunization',
  'round confirmed the result.',
].join('\n');

test('countHits：精确短语数出命中次数，fuzzy=false', () => {
  const result = countHits(PAGE, 'deimmunization');
  assert.equal(result.hits, 3);
  assert.equal(result.fuzzy, false);
  assert.ok(result.index > 0, '给出首个命中在原文里的下标');
  assert.equal(PAGE.slice(result.index).startsWith('deimmunization'), true);
});

test('countHits：忽略大小写、标点与空白', () => {
  assert.equal(countHits(PAGE, 'Deimmunization').hits, 3);
  assert.equal(countHits(PAGE, 'DEIMMUNIZATION').hits, 3);
  assert.equal(countHits(PAGE, 'deimmunization.').hits, 3);
  assert.equal(countHits(PAGE, '  deimmunization  ').hits, 3);
  assert.equal(countHits(PAGE, 'artificial intelligence-directed').hits, 1);
});

test('countHits：没有精确命中时退回 token 覆盖并标 fuzzy', () => {
  // 词序颠倒：紧凑串对不上，只能靠 token 覆盖
  const result = countHits(PAGE, 'scaffold chimeric');
  assert.equal(result.fuzzy, true);
  assert.ok(result.hits >= 1, 'token 覆盖仍有命中数');
  assert.ok(result.index >= 0, '给出首个命中位置');

  const missing = countHits(PAGE, 'kubernetes');
  assert.equal(missing.hits, 0);
  assert.equal(missing.fuzzy, true);
  assert.equal(missing.index, -1);
});

test('countHits：空查询不算命中', () => {
  assert.deepEqual(countHits(PAGE, ''), { hits: 0, fuzzy: false, index: -1 });
  assert.deepEqual(countHits(PAGE, '   '), { hits: 0, fuzzy: false, index: -1 });
});

test('countHits：token 覆盖不被更长的命中词重复放大', () => {
  // 「柏氏矢量」会被切成整串 + 二元组，短 token 不重复计数
  const zh = '柏氏矢量很重要，柏氏矢量的应用';
  const result = countHits(zh, '柏氏矢量');
  assert.equal(result.fuzzy, false);
  assert.equal(result.hits, 2);
});

test('buildSnippet：取命中附近的片段，不是页首', () => {
  const long = `PAGEHEAD${' padding'.repeat(80)}NEEDLE${' tail'.repeat(80)}`;
  const snippet = buildSnippet(long, 'needle');
  assert.ok(snippet.includes('NEEDLE'), '片段里有命中');
  assert.ok(!snippet.includes('PAGEHEAD'), '片段不是页首');
  assert.ok(snippet.length < long.length / 2, '片段比整页短');
});

test('buildSnippet：对齐词边界、折叠换行与排版空白', () => {
  const snippet = buildSnippet(PAGE, 'chimeric');
  assert.ok(snippet.includes('chimeric scaffold'), '词没有被切一半');
  assert.ok(!snippet.includes('\n'), '换行被折叠');
  assert.ok(!/ {2,}/.test(snippet), '连续空白被折叠');
});

test('buildSnippet：截断处加省略号', () => {
  const long = `${'padding '.repeat(80)}NEEDLE${' tail'.repeat(80)}`;
  const snippet = buildSnippet(long, 'needle');
  assert.ok(snippet.startsWith('…'), '前面被截断');
  assert.ok(snippet.endsWith('…'), '后面被截断');
});

test('buildSnippet：命中就在页首/页尾时不加省略号', () => {
  const snippet = buildSnippet('NEEDLE at the very beginning of the page', 'needle');
  assert.ok(!snippet.startsWith('…'));
  assert.ok(snippet.includes('NEEDLE'));
});

test('buildSnippet：空页返回空串', () => {
  assert.equal(buildSnippet('', 'needle'), '');
  assert.equal(buildSnippet('   \n  ', 'needle'), '');
});

test('buildSnippet：radius 可调，默认 150 字符', () => {
  const long = `${'x'.repeat(500)}NEEDLE${'y'.repeat(500)}`;
  const wide = buildSnippet(long, 'needle', { radius: 400 });
  const narrow = buildSnippet(long, 'needle', { radius: 20 });
  assert.ok(wide.length > narrow.length);
  assert.ok(narrow.length <= DOC_SNIPPET_RADIUS * 2 + 64);
});
