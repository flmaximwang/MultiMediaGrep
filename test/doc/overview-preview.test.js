// test/doc/overview-preview.test.js —— 用合成 PDF fixture 跑文档预览（9z5.20）
//
// fixture：fixtures/generated/sample-longpage.pdf（fixtures/generate.mjs 生成）
//   page 4 正文 > 24k 字符（内联上限），page 6 是一个无标点的超长单元。
// 这里故意走**真实文档后端**（pdftotext 文字层），验证的是「页面正文超过内联上限
// 也不会整页消失」这条端到端行为；缺 PDF 工具或 fixture 时整组跳过。
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createDocumentBackend } from '../../src/backend/document/index.js';
import { createPdfSupport } from '../../src/backend/document/pdf.js';
import { createPlaceholderBackend } from '../../src/server/backends.js';
import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = path.join(ROOT, 'fixtures', 'generated');
const GROUND_TRUTH = path.join(ROOT, 'fixtures', 'ground-truth');
const LONG_PAGE_PDF = path.join(GENERATED, 'sample-longpage.pdf');

const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const tools = await createPdfSupport().resolveTools();
const ready = await exists(LONG_PAGE_PDF);
const skip = !ready || tools.info === null || tools.textExtractor === null
  ? 'sample-longpage.pdf + a PDF metadata/text extractor (poppler-utils) are required'
  : false;

const GT = ready ? JSON.parse(await readFile(path.join(GROUND_TRUTH, 'sample-longpage-pdf.json'), 'utf8')) : null;

/** 起一个真 server：文档后端是真的，缓存落盘与工作目录都在临时目录里 */
async function withServer(limit, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-longpage-'));
  const previousCache = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  const config = loadConfig({
    MMGREP_CACHE_DIR: path.join(dir, 'cache'),
    MMGREP_MAX_TEXT_INLINE_CHARS: String(limit),
    MMGREP_MAX_IMAGE_TOKENS: '4000',
    MMGREP_OCR_PROVIDER: 'none',
  });
  const exportDir = path.join(dir, 'export');
  await mkdir(exportDir, { recursive: true });
  const cache = {
    async contentKeyForFile() {
      return { sha256: 'f'.repeat(64), key: `sha256:${'f'.repeat(64)}` };
    },
    async prepareDir() {
      return exportDir;
    },
    async register() {
      return { path: exportDir, type: 'dir', size: 0 };
    },
  };
  const document = createDocumentBackend({ config });
  const server = createServer({
    config,
    logger: SILENT_LOGGER,
    cache,
    backends: {
      document,
      video: createPlaceholderBackend('video'),
      audio: createPlaceholderBackend('audio'),
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'longpage-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    if (previousCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
}

const overview = (client, args) => client.callTool({
  name: 'media_overview',
  arguments: { path: LONG_PAGE_PDF, images: 0, ...args },
});

test('fixture 自检：page 4 正文确实大于内联上限（24k），page 6 无句末标点', { skip }, () => {
  assert.equal(GT.pageCount, 6);
  assert.equal(GT.longPage, 4);
  assert.equal(GT.unpunctuatedPage, 6);
  assert.ok(GT.charsByPage['4'] > 24000, `page 4 has ${GT.charsByPage['4']} chars`);
  assert.ok(GT.charsByPage['6'] > 4000);
  const page6 = GT.pages.find((page) => page.page === 6).lines.map((line) => line.text).join(' ');
  assert.doesNotMatch(page6, /[.!?;]/);
});

test('pages:"4"：单页正文 > 24k 字符时返回非空摘录 + 抽样说明', { skip, timeout: 120000 }, async () => {
  await withServer(24000, async (client) => {
    const result = await overview(client, { pages: '4' });
    assert.notEqual(result.isError, true);
    const text = result.content[0].text;
    const data = result.structuredContent;

    assert.ok(text.length <= 24000, `text is ${text.length} chars`);
    assert.match(text, /^\[page 4\s*\] \(text\)/m, 'page 4 must not vanish');
    assert.match(text, /preview: sampled \d+ of \d+ sentences across page 4/);
    assert.match(text, /every requested page is represented/);
    assert.equal(data.preview.mode, 'sampled');
    assert.ok(data.preview.units > 0);
    assert.ok(data.preview.totalUnits > data.preview.units);
    assert.doesNotMatch(text, /every requested page\./);
    assert.doesNotMatch(text, /list below is the text/);

    // 全文落盘仍是请求范围内的完整页文字
    assert.match(text, /^full text: \/.*content\.md /m);
    const contentMd = await readFile(data.fullText.contentMd, 'utf8');
    const page4 = GT.pages.find((page) => page.page === 4).lines.map((line) => line.text);
    for (const line of [page4[0], page4[Math.floor(page4.length / 2)], page4.at(-1)]) {
      assert.ok(contentMd.includes(line), 'content.md must carry the complete page 4');
    }
  });
});

test('pages:"4-6"：长页被抽样时 4/5/6 三页都出现，超长单元带 …[+N chars]', { skip, timeout: 120000 }, async () => {
  await withServer(24000, async (client) => {
    const result = await overview(client, { pages: '4-6' });
    const text = result.content[0].text;
    const data = result.structuredContent;

    assert.ok(text.length <= 24000, `text is ${text.length} chars`);
    assert.match(text, /^\[page 4\s*\] \(text\)/m);
    assert.match(text, /^\[page 5\s*\] \(text\)/m);
    assert.match(text, /^\[page 6\s*\] \(text\)/m);
    assert.match(text, /…\[\+\d+ chars\]/, 'page 6 is one unpunctuated unit and must be hard-truncated');
    assert.ok(data.preview.notRepresented.length === 0);
    assert.equal(data.preview.mode, 'sampled');
    assert.doesNotMatch(text, /every requested page\./);
  });
});

test('不传 pages：28k+ 字符的整份文档仍在 24k 内，且不再宣称「每一页」', { skip, timeout: 120000 }, async () => {
  await withServer(24000, async (client) => {
    const result = await overview(client, {});
    const text = result.content[0].text;
    const data = result.structuredContent;

    assert.ok(text.length <= 24000, `text is ${text.length} chars`);
    assert.equal(data.window.pages.length, 6);
    assert.match(text, /^preview: sampled \d+ of \d+ sentences across pages 1-6/m);
    assert.doesNotMatch(text, /the list below is the text of every requested page/);
    assert.doesNotMatch(text, /every requested page\./);
    if (data.preview.notRepresented.length > 0) {
      assert.match(text, /not represented: /);
    }
    // 每页至少一个单元：文字里应当出现全部有文字的页
    for (const page of [1, 2, 3, 4, 5, 6]) {
      assert.match(text, new RegExp(`^\\[page ${page}\\s*\\]`, 'm'), `page ${page} must be represented`);
    }
  });
});
