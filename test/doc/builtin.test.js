// test/doc/builtin.test.js —— 内置 typeset provider（契约 v2）
//
// builtin 是本地实现：只搬运调用方抽好的文字层文本，绝不重新识别字符。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blocksToText,
  createBuiltinTypesetProvider,
  normalizeBlocks,
  normalizeTextLayers,
  splitParagraphs,
  textToBlocks,
} from '../../src/providers/doc/builtin.js';

test('splitParagraphs / textToBlocks：空行分段，段内保留单换行', () => {
  const text = 'Heading\nline two\n\nSecond paragraph\n\n\nThird paragraph\n';
  assert.deepEqual(splitParagraphs(text), [
    'Heading\nline two',
    'Second paragraph',
    'Third paragraph',
  ]);
  assert.deepEqual(textToBlocks(text), [
    { type: 'paragraph', text: 'Heading\nline two' },
    { type: 'paragraph', text: 'Second paragraph' },
    { type: 'paragraph', text: 'Third paragraph' },
  ]);
  assert.equal(blocksToText(textToBlocks(text)), 'Heading\nline two\n\nSecond paragraph\n\nThird paragraph');
});

test('normalizeBlocks：丢掉空文本与未知类型，heading 保留正整数 level', () => {
  assert.deepEqual(
    normalizeBlocks([
      { type: 'heading', level: 2, text: '  Title  ' },
      { type: 'paragraph', text: '' },
      { type: 'weird', text: 'body' },
      { type: 'paragraph', text: '   ' },
      { type: 'list', level: 'x', text: 'item' },
    ]),
    [
      { type: 'heading', level: 2, text: 'Title' },
      { type: 'paragraph', text: 'body' },
      { type: 'list', text: 'item' },
    ],
  );
});

test('normalizeTextLayers：接受 Map / 数组 / 普通对象，页码必须是正整数', () => {
  assert.deepEqual([...normalizeTextLayers(new Map([[1, 'a'], [2, 'b']]))], [[1, 'a'], [2, 'b']]);
  assert.deepEqual([...normalizeTextLayers([{ page: 1, text: 'a' }, { page: 2, text: 'b' }])], [[1, 'a'], [2, 'b']]);
  assert.deepEqual([...normalizeTextLayers({ 1: 'a', 2: 'b' })], [[1, 'a'], [2, 'b']]);
  assert.deepEqual([...normalizeTextLayers([{ page: 0, text: 'x' }, { page: '1', text: 'a' }])], [[1, 'a']]);
});

test('parse：文字层 → paragraph blocks + textOrigin textlayer；只返回请求页', async () => {
  const provider = createBuiltinTypesetProvider();
  assert.deepEqual(provider.roles, ['typeset']);
  assert.equal(provider.id, 'builtin');

  const result = await provider.parse({
    role: 'typeset',
    pages: { from: 1, to: 2 },
    textLayers: {
      1: 'Page one heading\nPage one body',
      2: 'Page two\n\nSecond paragraph',
      3: 'not requested',
    },
  });

  assert.equal(result.provider, 'builtin');
  assert.deepEqual(result.pages.map((page) => page.page), [1, 2]);
  for (const page of result.pages) assert.equal(page.textOrigin, 'textlayer');
  assert.deepEqual(result.pages[0].blocks, [
    { type: 'paragraph', text: 'Page one heading\nPage one body' },
  ]);
  assert.deepEqual(result.pages[1].blocks, [
    { type: 'paragraph', text: 'Page two' },
    { type: 'paragraph', text: 'Second paragraph' },
  ]);
  assert.equal(result.pages[1].text, 'Page two\n\nSecond paragraph');
});

test('parse：空文字层 → 空 blocks / 空 text，但页面仍在结果里', async () => {
  const provider = createBuiltinTypesetProvider();
  const result = await provider.parse({ role: 'typeset', pages: [1], textLayers: { 1: '' } });
  assert.equal(result.pages.length, 1);
  assert.deepEqual(result.pages[0].blocks, []);
  assert.equal(result.pages[0].text, '');
  assert.equal(result.pages[0].textOrigin, 'textlayer');
});

test('parse：只支持 typeset 角色；要求它 OCR 时明确报错', async () => {
  const provider = createBuiltinTypesetProvider();
  await assert.rejects(
    () => provider.parse({ role: 'ocr', textLayers: { 1: 'x' } }),
    /only supports role "typeset"/,
  );
  await assert.rejects(
    () => provider.parse({ role: 'both', textLayers: { 1: 'x' } }),
    /never re-recognizes characters/,
  );
  // 默认 role 是 typeset（工厂创建时已知角色）。
  const result = await provider.parse({ textLayers: { 1: 'x' } });
  assert.equal(result.pages[0].textOrigin, 'textlayer');
});
