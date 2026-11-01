// test/doc/textlayer-probe.test.js —— 文字层探测：采样多页 + 逐页结果
//
// 背景（MultiMediaGrep-9z5.27）：只看第 1 页会把「图片封面 + 数字正文」这种
// 最常见的 PDF 形态误判成没有文字层，于是 agent 以为这份文档只能靠 OCR。
//
// 覆盖：
//   - 采样页的纯函数口径：{1, ceil(n/2), n}（按序去重）
//   - fixture sample-mixed.pdf：第 1 页是图片封面、第 2 页起有文字层 → 有文字层
//   - 逐页结果：page1=false、page2+=true
//   - 全篇扫描件 sample-scanned.pdf 仍然报「没有文字层」
//   - 本机没装文字抽取器时报原因，**不**误报成「没有文字层」
//
// 依赖 PDF 工具链（pdftotext / mutool）的用例在缺少二进制时整组跳过。

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDocumentBackend } from '../../src/backend/document/index.js';
import {
  NO_TEXT_EXTRACTOR_REASON,
  createPdfSupport,
  sampleTextLayerPages,
} from '../../src/backend/document/pdf.js';
import { countPages, extractContentStreams, extractTextOps } from '../../fixtures/lib/pdf.mjs';
import { ToolError } from '../../src/media/interface.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = path.join(ROOT, 'fixtures', 'generated');

const MIXED_PDF = path.join(GENERATED, 'sample-mixed.pdf');
const SCANNED_PDF = path.join(GENERATED, 'sample-scanned.pdf');
const TEXT_PDF = path.join(GENERATED, 'sample-text.pdf');

async function fixturesReady() {
  try {
    await Promise.all([MIXED_PDF, SCANNED_PDF, TEXT_PDF].map((file) => access(file)));
    return true;
  } catch {
    return false;
  }
}

const pdfSupport = await createPdfSupport().resolveTools();
const fixtures = await fixturesReady();
const hasPdfText = pdfSupport.textExtractor !== null;
const hasPdfInfo = pdfSupport.info !== null;

const skipPdfProbe = !fixtures || !hasPdfInfo || !hasPdfText
  ? 'PDF metadata + text extraction tools are not installed (poppler-utils / mupdf-tools)'
  : false;

async function withCache(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-textlayer-'));
  const previous = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 一个假的命令执行器：missing 里的二进制一律报 TOOL_NOT_FOUND。
 * 用来在**任何机器**上模拟「本机没装某个 PDF 工具」。
 */
function fakeRunner({ missing = [], pdfinfoOut = 'Pages:           4\nPage size:       595 x 842 pts (A4)\n' } = {}) {
  const missingSet = new Set(missing);
  const calls = [];
  const runner = async (bin, args) => {
    calls.push({ bin, args });
    if (missingSet.has(bin)) {
      throw new ToolError('TOOL_NOT_FOUND', `${bin} is not installed or not on PATH.`);
    }
    if (bin === 'pdfinfo') return { code: 0, stdout: pdfinfoOut, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  runner.calls = calls;
  return runner;
}

/* ------------------------------------------------------------------ *
 * 纯函数：采样页口径
 * ------------------------------------------------------------------ */

test('采样页：{1, ceil(n/2), n} 去重且保持顺序', () => {
  assert.deepEqual(sampleTextLayerPages(1), [1]);
  assert.deepEqual(sampleTextLayerPages(2), [1, 2]);
  assert.deepEqual(sampleTextLayerPages(3), [1, 2, 3]);
  assert.deepEqual(sampleTextLayerPages(4), [1, 2, 4]);
  assert.deepEqual(sampleTextLayerPages(5), [1, 3, 5]);
  assert.deepEqual(sampleTextLayerPages(28), [1, 14, 28]);
  assert.deepEqual(sampleTextLayerPages(29), [1, 15, 29]);
  // 页数读不到时退回只看第 1 页。
  assert.deepEqual(sampleTextLayerPages(null), [1]);
  assert.deepEqual(sampleTextLayerPages(0), [1]);
  assert.deepEqual(sampleTextLayerPages(-3), [1]);
});

/* ------------------------------------------------------------------ *
 * fixture：图片封面 + 数字正文
 * ------------------------------------------------------------------ */

test('sample-mixed.pdf 素材本身：第 1 页无文字操作，第 2 页起有', async () => {
  if (!fixtures) return; // 素材没生成：下面的用例整组跳过，这里安静返回
  const bytes = await readFile(MIXED_PDF);
  assert.equal(countPages(bytes), 4, 'page count');

  const streams = extractContentStreams(bytes);
  const textStreams = streams.filter((stream) => stream.includes(' Tm '));
  assert.equal(textStreams.length, 3, 'three pages carry a text layer');
  assert.equal(extractTextOps(textStreams[0]).length > 0, true);
  assert.match(textStreams[0], /BODY PAGE ONE/);
  assert.match(textStreams[1], /BODY PAGE TWO/);
  assert.match(textStreams[2], /BODY PAGE THREE/);
});

test('sample-mixed.pdf：第 1 页是图片封面、第 2 页起有文字层 → 探针报「有文字层」', {
  skip: skipPdfProbe,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const probe = await backend.probe({ path: MIXED_PDF });

    assert.equal(probe.mediaType, 'document');
    assert.equal(probe.pageCount, 4);
    // 关键回归：第 1 页没字 ≠ 整份文档没文字层。
    assert.equal(probe.hasTextLayer, true);

    const textLayer = probe.capabilities.textLayer;
    assert.equal(textLayer.checked, true);
    assert.equal(textLayer.reason, null);
    assert.deepEqual(textLayer.sampledPages, [1, 2, 4]);
    // 第 1 页空 → 继续看第 2 页 → 命中 → 提前返回（不必读完第 4 页）。
    assert.deepEqual(textLayer.checkedPages, [1, 2]);
    assert.equal(textLayer.textPage, 2);
  });
});

test('sample-mixed.pdf：逐页结果 page1=false、page2 起=true', {
  skip: skipPdfProbe,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const support = createPdfSupport();
    const { pages, textExtractor, reason } = await support.extractTextLayers(MIXED_PDF, [1, 2, 3, 4]);
    assert.ok(textExtractor, 'a text extractor should be available');
    assert.equal(reason, null);
    assert.equal(pages.size, 4);
    assert.equal(pages.get(1).hasTextLayer, false, 'the cover page is an image');
    assert.equal(pages.get(1).text.trim(), '');
    for (const page of [2, 3, 4]) {
      assert.equal(pages.get(page).hasTextLayer, true, `page ${page} has a text layer`);
      assert.ok(pages.get(page).text.trim().length > 0, `page ${page} carries text`);
    }

    // 文档后端也暴露同一份逐页结果（9z5.28 的逐页路由从这里拿）。
    const backend = createDocumentBackend({ config: {} });
    const routed = await backend.pageTextLayers({ path: MIXED_PDF });
    assert.equal(routed.pages.size, 4);
    assert.equal(routed.pages.get(1).hasTextLayer, false);
    assert.equal(routed.pages.get(2).hasTextLayer, true);
    assert.equal(routed.pages.get(4).hasTextLayer, true);
  });
});

test('sample-scanned.pdf：全篇无文字层仍然报「没有文字层」', {
  skip: skipPdfProbe,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const probe = await backend.probe({ path: SCANNED_PDF });
    assert.equal(probe.hasTextLayer, false);

    const textLayer = probe.capabilities.textLayer;
    assert.equal(textLayer.checked, true);
    assert.equal(textLayer.reason, null);
    assert.deepEqual(textLayer.sampledPages, [1, 2, 3]);
    assert.deepEqual(textLayer.checkedPages, [1, 2, 3]);
    assert.equal(textLayer.textPage, null);
  });
});

test('sample-text.pdf：第 1 页就有文字层 → 命中并提前返回', {
  skip: skipPdfProbe,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const probe = await backend.probe({ path: TEXT_PDF });
    assert.equal(probe.hasTextLayer, true);
    assert.deepEqual(probe.capabilities.textLayer.sampledPages, [1, 3, 6]);
    assert.deepEqual(probe.capabilities.textLayer.checkedPages, [1]);
    assert.equal(probe.capabilities.textLayer.textPage, 1);
  });
});

/* ------------------------------------------------------------------ *
 * 本机没有文字抽取器：报原因，不误报「没有文字层」
 * ------------------------------------------------------------------ */

test('没有文字抽取器时：sampleHasText 报原因，不说成「没有文字层」', async () => {
  const runner = fakeRunner({ missing: ['pdftotext', 'mutool'] });
  const support = createPdfSupport({ runCommand: runner });

  const sampled = await support.sampleHasText(MIXED_PDF, { pageCount: 4 });
  assert.equal(sampled.hasText, false);
  assert.equal(sampled.textExtractor, null);
  assert.equal(sampled.reason, NO_TEXT_EXTRACTOR_REASON);
  assert.match(sampled.reason, /text extractor/i);
  assert.deepEqual(sampled.sampledPages, []);
  assert.deepEqual(sampled.checkedPages, []);
  assert.equal(sampled.textPage, null);

  // 逐页结果同样要说清「判不出来」，而不是断言「这一页没字」。
  const layers = await support.extractTextLayers(MIXED_PDF, [1, 2]);
  assert.equal(layers.textExtractor, null);
  assert.equal(layers.reason, NO_TEXT_EXTRACTOR_REASON);
  assert.equal(layers.pages.get(1).hasTextLayer, false);
  assert.equal(layers.pages.get(2).hasTextLayer, false);
});

test('没有文字抽取器时：探针的 hasTextLayer 是 null（未知），并给出原因', async () => {
  const runner = fakeRunner({ missing: ['pdftotext', 'mutool'] });
  const support = createPdfSupport({ runCommand: runner });

  await withCache(async () => {
    const backend = createDocumentBackend({ config: {}, pdfSupport: support });
    const probe = await backend.probe({ path: MIXED_PDF });

    // 「判不出来」不能写成「没有文字层」——否则 agent 会以为只能靠 OCR。
    assert.equal(probe.hasTextLayer, null);
    const textLayer = probe.capabilities.textLayer;
    assert.equal(textLayer.checked, false);
    assert.equal(textLayer.reason, NO_TEXT_EXTRACTOR_REASON);
    assert.deepEqual(textLayer.sampledPages, []);
    assert.equal(textLayer.textPage, null);
  });
});

test('抽取器缺失与「这页没字」是两件事：前者报原因，后者才有 hasTextLayer=false', async () => {
  const support = createPdfSupport();
  const { textExtractor } = await support.resolveTools();
  if (!textExtractor) return; // 本机没有抽取器：下面的断言无从谈起

  const sampled = await support.sampleHasText(SCANNED_PDF, { pageCount: 3 });
  assert.equal(sampled.reason, null, 'a missing extractor must not be reported as a text-layer verdict');
  assert.equal(sampled.hasText, false);
  assert.deepEqual(sampled.sampledPages, [1, 2, 3]);
});
