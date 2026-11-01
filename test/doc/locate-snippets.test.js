// test/doc/locate-snippets.test.js —— 文档 media_locate：页码 + hits + 片段，不回吐整页
//
// 背景（ticket 9z5.23）：文档后端的 segment 粒度就是「一整页」，命中即整页倾倒，
// 一次调用能吐 12 KB+。修复后：文档侧报 hits + 命中附近的片段，没有 score，
// 总输出有 ~3 KB 预算。视频 / 录音的 locate 行为不变（见 test/server/tools.test.js）。
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';

const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });

/** 造一页正文：开头是页首噪声，命中在中间 */
function pageText({ page, hits = 1, marker = 'NEEDLE', filler = 900 }) {
  const head = `page ${page} head ${'lorem ipsum dolor sit amet '.repeat(Math.ceil(filler / 27))}`;
  const body = Array.from({ length: hits }, (_, i) => `and ${marker} appears ${i + 1}`).join('. ');
  return `${head}. ${body}. ${'tail text '.repeat(20)}`;
}

/** 只实现 document 后端所需的三个方法 */
function makeDocumentBackend(pages) {
  const calls = [];
  const pageCount = pages.reduce((n, p) => Math.max(n, p.page), 0);
  return {
    calls,
    async probe() {
      calls.push({ method: 'probe' });
      return {
        mediaType: 'document',
        pageCount,
        hasTextLayer: true,
        hasAudio: false,
        container: 'pdf',
        subtitleTracks: [],
        audioTracks: [],
        capabilities: {
          asr: { available: false, provider: null, reason: 'asr is not applicable to this media type.' },
          ocr: { available: true, provider: 'stub', reason: null },
          transcriptSource: 'ocr',
          transcriptOrigin: 'ocr',
          transcriptPath: null,
        },
      };
    },
    async overview() {
      return { segments: [], images: [], transcript: { source: 'ocr', origin: 'ocr' }, warnings: [] };
    },
    async locate(input) {
      calls.push({ method: 'locate', input });
      return {
        matches: pages.map((p, i) => ({
          rank: i + 1,
          score: 1,
          startMs: null,
          endMs: null,
          startSec: null,
          endSec: null,
          text: p.text,
          source: 'ocr',
          origin: 'ocr',
          page: p.page,
        })),
        totalSegments: pageCount,
        transcript: { source: 'ocr', origin: 'ocr' },
        frame: null,
        warnings: [],
      };
    },
  };
}

async function withClient(backend, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-doc-locate-'));
  const file = path.join(dir, 'paper.pdf');
  await writeFile(file, PDF);
  const config = loadConfig({ MMGREP_CACHE_DIR: path.join(dir, 'cache') });
  const cache = {
    async contentKeyForFile() {
      return { sha256: 'c'.repeat(64), key: `sha256:${'c'.repeat(64)}` };
    },
    async prepareDir() {
      return path.join(dir, 'export');
    },
    async register() {
      return { path: path.join(dir, 'export'), type: 'dir', size: 0 };
    },
  };
  const server = createServer({
    config,
    backends: { document: backend },
    cache,
    logger: SILENT_LOGGER,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client, file);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('文档 locate：返回页码 + hits + 片段，不回吐整页，也没有 score', async () => {
  const pages = [
    { page: 3, text: pageText({ page: 3, hits: 2 }) },
    { page: 7, text: pageText({ page: 7, hits: 1 }) },
  ];
  const backend = makeDocumentBackend(pages);
  await withClient(backend, async (client, file) => {
    const result = await client.callTool({
      name: 'media_locate',
      arguments: { path: file, query: 'needle' },
    });
    assert.notEqual(result.isError, true);

    const matches = result.structuredContent.matches;
    assert.equal(matches.length, 2);
    // 命中多的页排前面
    assert.equal(matches[0].page, 3);
    assert.equal(matches[0].hits, 2);
    assert.equal(matches[0].fuzzy, false);
    assert.equal(matches[1].page, 7);
    assert.equal(matches[1].hits, 1);

    // 文档侧没有 score，也没有整页原文
    for (const match of matches) {
      assert.equal('score' in match, false, '文档 matches 没有 score 字段');
      assert.equal('text' in match, false, '文档 matches 不回吐整页原文');
      assert.equal(typeof match.snippet, 'string');
      assert.ok(match.snippet.length > 0);
    }

    const text = result.content[0].text;
    assert.match(text, /^matches for "needle" \(2 of 7 pages\):/);
    assert.match(text, /  page 3 {2}hits=2 \(ocr\) {2}「/);
    assert.match(text, /  page 7 {2}hits=1 \(ocr\) {2}「/);
    // 片段里有命中，不是页首
    assert.ok(text.includes('NEEDLE'));
    assert.ok(!text.includes('page 3 head'), '片段不是页首');
    assert.ok(!text.includes('page 7 head'), '片段不是页首');
  });
});

test('文档 locate：片段给的是命中附近的上下文，不是页首', async () => {
  const pages = [{ page: 2, text: pageText({ page: 2, hits: 1, marker: 'deimmunization' }) }];
  const backend = makeDocumentBackend(pages);
  await withClient(backend, async (client, file) => {
    const result = await client.callTool({
      name: 'media_locate',
      arguments: { path: file, query: 'deimmunization' },
    });
    const snippet = result.structuredContent.matches[0].snippet;
    assert.ok(snippet.includes('deimmunization'), '片段里有命中');
    assert.ok(!snippet.startsWith('page 2 head'), '片段不是页首');
    assert.ok(snippet.length < pages[0].text.length, '片段比整页短');
    // 片段不换行：排版空白被折叠
    assert.equal(snippet.includes('\n'), false);
  });
});

test('文档 locate：多页按 hits 降序、同分按页码升序', async () => {
  const pages = [
    { page: 9, text: pageText({ page: 9, hits: 1 }) },
    { page: 2, text: pageText({ page: 2, hits: 3 }) },
    { page: 5, text: pageText({ page: 5, hits: 3 }) },
    { page: 1, text: pageText({ page: 1, hits: 2 }) },
  ];
  const backend = makeDocumentBackend(pages);
  await withClient(backend, async (client, file) => {
    const result = await client.callTool({
      name: 'media_locate',
      arguments: { path: file, query: 'needle' },
    });
    const order = result.structuredContent.matches.map((m) => [m.page, m.hits]);
    assert.deepEqual(order, [[2, 3], [5, 3], [1, 2], [9, 1]]);
    const text = result.content[0].text;
    assert.ok(text.indexOf('page 2') < text.indexOf('page 5'), '文本顺序与结构化顺序一致');
    assert.ok(text.indexOf('page 5') < text.indexOf('page 1'));
    assert.ok(text.indexOf('page 1') < text.indexOf('page 9'));
  });
});

test('文档 locate：总输出有 ~3 KB 预算，超了少展示几页并列出剩下的页码', async () => {
  const pages = Array.from({ length: 20 }, (_, i) => ({
    page: i + 1,
    text: pageText({ page: i + 1, hits: 3 }),
  }));
  const backend = makeDocumentBackend(pages);
  await withClient(backend, async (client, file) => {
    const result = await client.callTool({
      name: 'media_locate',
      arguments: { path: file, query: 'needle', max: 20 },
    });
    const text = result.content[0].text;
    assert.ok(Buffer.byteLength(text, 'utf8') < 3072, `text content 超出预算：${Buffer.byteLength(text, 'utf8')} 字节`);
    assert.match(text, /more pages match: /);
    assert.ok(result.structuredContent.matches.length < 20, '展示的页数被裁短');
    assert.ok(result.structuredContent.matches.length > 0, '至少展示一页');
    // 折叠行里的页码是升序的
    const note = text.split('\n').find((line) => line.includes('more pages match:'));
    const listed = note.split('more pages match: ')[1].split(', ').map(Number);
    assert.deepEqual(listed, [...listed].sort((a, b) => a - b));
    assert.equal(listed.length + result.structuredContent.matches.length, 20);
  });
});

test('文档 locate：max 之外命中的页折叠成一行，不静默丢掉', async () => {
  const pages = Array.from({ length: 6 }, (_, i) => ({
    page: i + 1,
    text: pageText({ page: i + 1, hits: 1 }),
  }));
  const backend = makeDocumentBackend(pages);
  await withClient(backend, async (client, file) => {
    const result = await client.callTool({
      name: 'media_locate',
      arguments: { path: file, query: 'needle', max: 2 },
    });
    assert.equal(result.structuredContent.matches.length, 2);
    const text = result.content[0].text;
    assert.match(text, /4 more pages match: /);
  });
});

test('文档 locate：精确命中排在 token 覆盖（fuzzy）之前', async () => {
  // 「PAGE」在每页都出现，只有第 2 页有整句
  const pages = [
    { page: 1, text: 'PAGE 1 OF 3. some filler text.' },
    { page: 2, text: 'PAGE TWO HEADING. SECOND PAGE OF THE FIXTURE.' },
    { page: 3, text: 'PAGE THREE HEADING. PAGE THREE ENDS HERE.' },
  ];
  const backend = makeDocumentBackend(pages);
  await withClient(backend, async (client, file) => {
    const result = await client.callTool({
      name: 'media_locate',
      arguments: { path: file, query: 'second page' },
    });
    const matches = result.structuredContent.matches;
    assert.equal(matches[0].page, 2, '整句命中的页排第一');
    assert.equal(matches[0].fuzzy, false);
    assert.equal(matches[0].hits, 1);
    for (const match of matches.slice(1)) {
      assert.equal(match.fuzzy, true, '只命中通用词的页标 fuzzy');
    }
    assert.match(result.content[0].text, /hits=1 \(fuzzy, ocr\)/);
  });
});

test('文档 locate：没有命中不是错误', async () => {
  const backend = makeDocumentBackend([{ page: 1, text: 'nothing to see here' }]);
  await withClient(backend, async (client, file) => {
    const result = await client.callTool({
      name: 'media_locate',
      arguments: { path: file, query: 'kubernetes' },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent.matches, []);
    assert.match(result.content[0].text, /^no line matched "kubernetes" among 1 page texts\./);
  });
});
