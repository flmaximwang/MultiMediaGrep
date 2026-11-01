// test/backend/document.test.js —— 文档后端：probe / overview / zoom / locate
//
// 用 fixtures/generated 里的 PDF / PNG 合成素材和 ground-truth 行文本做断言。
// 依赖 PDF 工具链 / ffmpeg 的用例在缺少二进制时整组跳过（skip 原因写清楚）。

import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDocumentBackend } from '../../src/backend/document/index.js';
import {
  createPdfSupport,
  normalizePageText,
  pageLabelFromQpdf,
  parseMutoolInfo,
  parsePdfinfo,
  parseQpdfOutlineJson,
  romanNumeral,
  toContiguousRuns,
} from '../../src/backend/document/pdf.js';
import {
  MAX_IMAGE_PIXELS,
  cropRect,
  fitSize,
  planGrid,
} from '../../src/backend/document/render.js';
import { assertFfmpegAvailable } from '../../src/media/ffmpeg.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = path.join(ROOT, 'fixtures', 'generated');
const GROUND_TRUTH = path.join(ROOT, 'fixtures', 'ground-truth');

const TEXT_PDF = path.join(GENERATED, 'sample-text.pdf');
const SCANNED_PDF = path.join(GENERATED, 'sample-scanned.pdf');
const IMAGE = path.join(GENERATED, 'sample-image.png');

async function hasFfmpeg() {
  try {
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
}

async function fixturesReady() {
  try {
    await Promise.all([TEXT_PDF, SCANNED_PDF, IMAGE].map((file) => access(file)));
    return true;
  } catch {
    return false;
  }
}

const ffmpegReady = await hasFfmpeg();
const fixtures = await fixturesReady();
const TEXT_GT = fixtures
  ? JSON.parse(await readFile(path.join(GROUND_TRUTH, 'sample-text-pdf.json'), 'utf8'))
  : null;
const SCAN_GT = fixtures
  ? JSON.parse(await readFile(path.join(GROUND_TRUTH, 'sample-scanned-pdf.json'), 'utf8'))
  : null;

const pdfTools = await createPdfSupport().resolveTools();
const hasPdfInfo = pdfTools.info !== null;
const hasPdfSize = pdfTools.info === 'pdfinfo' || pdfTools.info === 'mutool';
const hasPdfRender = pdfTools.rasterizer !== null;
const hasPdfText = pdfTools.textExtractor !== null;

const skipPdfProbe = !fixtures || !hasPdfSize || !hasPdfText
  ? 'PDF metadata + text extraction tools are not installed (poppler-utils / mupdf-tools)'
  : false;
const skipPdfRender = !fixtures || !ffmpegReady || !hasPdfInfo || !hasPdfRender
  ? 'ffmpeg + PDF metadata + a PDF rasterizer are required'
  : false;
const skipPdfTextOverview = !fixtures || !ffmpegReady || !hasPdfSize || !hasPdfText || !hasPdfRender
  ? 'ffmpeg + poppler/mupdf text + rasterizer are required'
  : false;
const skipLocateText = !fixtures || !hasPdfSize || !hasPdfText
  ? 'PDF metadata + text extraction tools are required'
  : false;
const skipLocateFrame = !fixtures || !ffmpegReady || !hasPdfSize || !hasPdfText || !hasPdfRender
  ? 'ffmpeg + PDF metadata + text + rasterizer are required'
  : false;
const skipImage = !fixtures || !ffmpegReady ? 'ffmpeg/ffprobe are required' : false;

async function withCache(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-document-'));
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

function groundTruthLines(gt, page) {
  return (gt.pages.find((entry) => entry.page === page)?.lines ?? []).map((line) => line.text);
}

function scanText(page) {
  return groundTruthLines(SCAN_GT, page).join('\n');
}

function assertPng(buffer) {
  assert.ok(Buffer.isBuffer(buffer), 'image must be a Buffer');
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'image must be a real PNG',
  );
}

/** 读 PNG IHDR 宽高（ffmpeg 输出的 PNG 一定是标准 IHDR 布局）。 */
function pngSize(buffer) {
  assertPng(buffer);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function assertImagesWithinBudget(images, { cells, images: maxImages, maxEdge }) {
  assert.ok(Array.isArray(images));
  assert.ok(images.length >= 1, 'expected at least one image');
  assert.ok(images.length <= maxImages, `at most ${maxImages} images`);
  let totalCells = 0;
  for (const image of images) {
    assert.ok(Number.isInteger(image.cells) && image.cells >= 1);
    assert.ok(image.cells <= cells, `at most ${cells} cells per image`);
    assert.equal(image.mimeType, 'image/png');
    assert.ok(Number.isInteger(image.width) && Number.isInteger(image.height));
    assert.ok(Math.max(image.width, image.height) <= maxEdge, `longest edge <= ${maxEdge}`);
    assert.ok(image.width * image.height <= MAX_IMAGE_PIXELS, 'per-image pixel budget');
    const actual = pngSize(image.buffer);
    assert.deepEqual(actual, { width: image.width, height: image.height }, 'metadata must match the PNG');
    totalCells += image.cells;
  }
  assert.ok(totalCells <= cells * maxImages, 'total cells within the call budget');
}

function stubDocProvider({ fail = null, texts = () => '', id = 'stub', roles = null } = {}) {
  const calls = [];
  const provider = {
    id,
    ...(roles ? { roles } : {}),
    describe: () => ({ id, model: 'stub-v1', baseUrl: null }),
    async parse(input) {
      calls.push(input);
      if (fail) throw fail;
      const requested = input.pages?.list
        ?? (input.pages?.from
          ? Array.from({ length: input.pages.to - input.pages.from + 1 }, (_, i) => input.pages.from + i)
          : []);
      return {
        provider: id,
        model: 'stub-v1',
        pages: requested.map((page) => {
          const text = texts(page);
          const textOrigin = input.ocrMode === 'force'
            ? 'ocr'
            : (input.role === 'typeset' ? 'textlayer' : 'ocr');
          return {
            page,
            textOrigin,
            blocks: text ? [{ type: 'paragraph', text }] : [],
            text,
          };
        }),
      };
    },
  };
  return { provider, calls };
}

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

test('渲染规划：planGrid / fitSize / cropRect 守住 maxEdge 与 2,000,000 px', () => {
  for (const [cells, maxEdge] of [[6, 1280], [16, 1600], [4, 900], [1, 256]]) {
    const cols = cells <= 1 ? 1 : cells <= 2 ? 2 : cells <= 4 ? 2 : cells <= 6 ? 3 : cells <= 9 ? 3 : 4;
    const rows = Math.ceil(cells / cols);
    const grid = planGrid({ pageAspect: 595 / 842, cols, rows, maxEdge });
    assert.ok(Math.max(grid.width, grid.height) <= maxEdge);
    assert.ok(grid.width * grid.height <= MAX_IMAGE_PIXELS);
    assert.ok(grid.cellWidth >= 1 && grid.cellHeight >= 1);
  }

  const tall = fitSize(4000, 3000, 1600);
  assert.ok(Math.max(tall.width, tall.height) <= 1600);
  assert.ok(tall.width * tall.height <= MAX_IMAGE_PIXELS);

  const square = fitSize(2000, 2000, 1600);
  assert.ok(square.width * square.height <= MAX_IMAGE_PIXELS);
  assert.ok(Math.max(square.width, square.height) <= 1600);

  assert.deepEqual(cropRect(100, 200, null), { x: 0, y: 0, width: 100, height: 200 });
  assert.deepEqual(cropRect(100, 200, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }), {
    x: 50,
    y: 100,
    width: 50,
    height: 100,
  });
  const clamped = cropRect(100, 100, { x: 0.99, y: 0.99, width: 1, height: 1 });
  assert.ok(clamped.width >= 1 && clamped.height >= 1);
  assert.ok(clamped.x + clamped.width <= 100 && clamped.y + clamped.height <= 100);
});

test('PDF 输出解析：pdfinfo / mutool / 页文本整理 / 连续区间', () => {
  const info = parsePdfinfo('Pages:           6\nPage size:       595 x 842 pts (A4)\nPage rot:        90\n');
  assert.equal(info.pageCount, 6);
  assert.equal(info.width, 842);
  assert.equal(info.height, 595);

  const rotated = parsePdfinfo('Pages:           2\nPage size:       612 x 792 pts (letter)\nPage rot:        0\n');
  assert.deepEqual(rotated, { pageCount: 2, width: 612, height: 792 });

  const mutool = parseMutoolInfo('Pages: 6\nMediaboxes (1):\n\t1\t(6 0 R):\t[ 0 0 595 842 ]\n');
  assert.deepEqual(mutool, { pageCount: 6, width: 595, height: 842 });

  assert.equal(normalizePageText('A  \r\nB\r\n\r\n\r\nC'), 'A\nB\n\nC');
  assert.deepEqual(toContiguousRuns([1, 2, 3, 5, 6, 8]), [[1, 2, 3], [5, 6], [8]]);
});

test('PDF 书签解析：qpdf 的 destpageposfrom1 + /PageLabels 字典 → 物理页与打印标签', () => {
  // qpdf 给的是 /PageLabels 字典（/St 已按页递增），不是算好的字符串。
  assert.equal(pageLabelFromQpdf({ '/S': '/r', '/St': 1 }), 'i');
  assert.equal(pageLabelFromQpdf({ '/S': '/r', '/St': 4 }), 'iv');
  assert.equal(pageLabelFromQpdf({ '/S': '/R', '/St': 14 }), 'XIV');
  assert.equal(pageLabelFromQpdf({ '/S': '/D', '/St': 37 }), '37');
  assert.equal(pageLabelFromQpdf({ '/S': '/D', '/P': 'A-', '/St': 7 }), 'A-7');
  assert.equal(pageLabelFromQpdf({ '/S': '/a', '/St': 27 }), 'aa');
  assert.equal(pageLabelFromQpdf(null), null);
  assert.equal(romanNumeral(1990), 'mcmxc');

  const parsed = parseQpdfOutlineJson({
    pages: [
      { pageposfrom1: 1, label: { '/S': '/r', '/St': 1 } },
      { pageposfrom1: 2, label: { '/S': '/r', '/St': 2 } },
      { pageposfrom1: 3, label: { '/S': '/D', '/St': 1 } },
    ],
    outlines: [
      {
        title: 'Chapter One\r',
        destpageposfrom1: 1,
        kids: [{ title: 'Section 1.1', destpageposfrom1: 2, kids: [] }],
      },
      { title: 'Chapter Two', destpageposfrom1: 3, kids: [] },
    ],
  });
  assert.deepEqual(parsed, [
    { level: 1, title: 'Chapter One', page: 1, label: 'i' },
    { level: 2, title: 'Section 1.1', page: 2, label: 'ii' },
    { level: 1, title: 'Chapter Two', page: 3, label: '1' },
  ]);
});

/* ------------------------------------------------------------------ *
 * probe
 * ------------------------------------------------------------------ */

test('probe：文本 PDF 的契约字段、文字层与 OCR 能力', { skip: skipPdfProbe, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const probe = await backend.probe({ path: TEXT_PDF });

    assert.equal(probe.mediaType, 'document');
    assert.equal(probe.path, TEXT_PDF);
    assert.equal(probe.pageCount, TEXT_GT.pageCount);
    assert.equal(probe.width, TEXT_GT.pageWidthPt);
    assert.equal(probe.height, TEXT_GT.pageHeightPt);
    assert.equal(probe.hasTextLayer, true);
    assert.equal(probe.container, 'pdf');
    assert.equal(probe.durationMs, null);
    assert.equal(probe.durationSec, null);
    assert.equal(probe.fps, null);
    assert.equal(probe.rotation, null);
    assert.equal(probe.aspect, null);
    assert.equal(probe.videoCodec, null);
    assert.equal(probe.hasAudio, false);
    assert.equal(probe.audioCodec, null);
    assert.equal(probe.audioChannels, null);
    assert.equal(probe.sampleRateHz, null);
    assert.equal(probe.audioHealth, null);
    assert.deepEqual(probe.subtitleTracks, []);
    assert.equal(probe.capabilities.asr.available, false);
    assert.equal(probe.capabilities.asr.provider, null);
    assert.equal(probe.capabilities.ocr.available, false);
    assert.equal(probe.capabilities.ocr.provider, null);
    assert.match(probe.capabilities.ocr.reason, /No OCR provider is configured/);
    assert.equal(probe.capabilities.typeset.available, false);
    assert.equal(probe.capabilities.transcriptSource, 'text');
    assert.equal(probe.capabilities.transcriptOrigin, 'textlayer');
    assert.equal(probe.capabilities.transcriptPath, null);
    assert.equal(probe.recommended.mode, 'single');
    assert.ok(probe.recommended.note);
  });
});

test('probe：扫描 PDF 没有文字层', { skip: skipPdfRender, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const probe = await backend.probe({ path: SCANNED_PDF });
    assert.equal(probe.pageCount, SCAN_GT.pageCount);
    assert.equal(probe.width, SCAN_GT.pageWidthPt);
    assert.equal(probe.height, SCAN_GT.pageHeightPt);
    assert.equal(probe.hasTextLayer, false);
    assert.equal(probe.capabilities.transcriptSource, 'none');
    assert.equal(probe.capabilities.transcriptOrigin, 'none');
    assert.equal(probe.capabilities.ocr.available, false);
  });
});

test('probe：图片是一页、无文字层、宽高为像素', { skip: skipImage, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const probe = await backend.probe({ path: IMAGE });
    assert.equal(probe.mediaType, 'document');
    assert.equal(probe.pageCount, 1);
    assert.equal(probe.width, 1240);
    assert.equal(probe.height, 1754);
    assert.equal(probe.hasTextLayer, false);
    assert.equal(probe.container, 'png');
    assert.equal(probe.capabilities.ocr.available, false);
    assert.equal(probe.capabilities.transcriptSource, 'none');
    assert.equal(probe.durationSec, null);
  });
});

test('probe：txt / md 是一页有文字层，没有像素尺寸', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-doc-text-'));
  try {
    const md = path.join(dir, 'notes.md');
    await writeFile(md, '# Notes\n\nAlpha Bravo Charlie.\n');
    const backend = createDocumentBackend({ config: {} });
    const probe = await backend.probe({ path: md });
    assert.equal(probe.pageCount, 1);
    assert.equal(probe.hasTextLayer, true);
    assert.equal(probe.width, null);
    assert.equal(probe.height, null);
    assert.equal(probe.container, 'markdown');
    assert.equal(probe.capabilities.transcriptSource, 'text');
    assert.equal(probe.capabilities.ocr.available, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * overview
 * ------------------------------------------------------------------ */

test('overview：页子集、格数 / 图数 / maxEdge 与每页文字严格对齐', {
  skip: skipPdfTextOverview,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const result = await backend.overview({
      path: TEXT_PDF,
      pages: [2, 3],
      cells: 2,
      images: 1,
      maxEdge: 800,
    });

    assertImagesWithinBudget(result.images, { cells: 2, images: 1, maxEdge: 800 });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].cells, 2);

    assert.deepEqual(result.segments.map((segment) => segment.page), [2, 3]);
    for (const segment of result.segments) {
      assert.equal(segment.startMs, null);
      assert.equal(segment.endMs, null);
      assert.equal(segment.source, 'text');
      assert.equal(segment.origin, 'textlayer');
      for (const line of groundTruthLines(TEXT_GT, segment.page)) {
        assert.ok(segment.text.includes(line), `page ${segment.page} must contain "${line}"`);
      }
    }
    assert.ok(result.segments[0].text.includes('PAGE TWO HEADING'));
    assert.ok(result.segments[1].text.includes('PAGE THREE HEADING'));
    assert.ok(!result.segments[0].text.includes('PAGE 1 OF 6'));
    assert.ok(!result.segments[1].text.includes('PAGE TWO HEADING'));
    assert.equal(result.transcript.source, 'text');
    assert.equal(result.transcript.origin, 'textlayer');
    assert.equal(result.transcript.provider, null);
    assert.deepEqual(result.warnings, []);
  });
});

test('overview：images: 0 是零像素纯文本模式——不出页图，只回页文字', {
  skip: skipPdfProbe,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const result = await backend.overview({
      path: TEXT_PDF,
      pages: [2, 3],
      cells: 2,
      images: 0,
      maxEdge: 800,
    });

    assert.deepEqual(result.images, [], '零像素模式不得渲染页图');
    assert.deepEqual(result.segments.map((segment) => segment.page), [2, 3]);
    for (const segment of result.segments) {
      assert.equal(segment.startMs, null);
      assert.equal(segment.endMs, null);
      assert.equal(segment.source, 'text');
      assert.equal(segment.origin, 'textlayer');
      for (const line of groundTruthLines(TEXT_GT, segment.page)) {
        assert.ok(segment.text.includes(line), `page ${segment.page} must contain "${line}"`);
      }
    }
    assert.ok(result.segments[0].text.includes('PAGE TWO HEADING'));
    assert.ok(result.segments[1].text.includes('PAGE THREE HEADING'));
    // 没出图就不该有「图片预算只覆盖了 N 页」的告警
    assert.ok(!result.warnings.some((warning) => /image budget covers/.test(warning)));
    assert.equal(result.transcript.source, 'text');
  });
});

test('overview：请求页超过图片预算时均匀抽样，但文字覆盖全部请求页', {
  skip: skipPdfTextOverview,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const result = await backend.overview({
      path: TEXT_PDF,
      pages: null,
      cells: 2,
      images: 1,
      maxEdge: 600,
    });

    assertImagesWithinBudget(result.images, { cells: 2, images: 1, maxEdge: 600 });
    assert.equal(result.images[0].cells, 2);
    assert.equal(result.segments.length, TEXT_GT.pageCount);
    assert.deepEqual(
      result.segments.map((segment) => segment.page),
      Array.from({ length: TEXT_GT.pageCount }, (_, i) => i + 1),
    );
    for (const segment of result.segments) {
      const heading = groundTruthLines(TEXT_GT, segment.page)[0];
      assert.ok(segment.text.includes(heading));
    }
    assert.ok(result.warnings.some((warning) => /image budget covers 2 of 6 requested pages/.test(warning)));
  });
});

test('overview：扫描 PDF 无 provider → 页面图 + 空文字 + 明确原因', {
  skip: skipPdfRender,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const result = await backend.overview({
      path: SCANNED_PDF,
      pages: [1],
      cells: 2,
      images: 1,
      maxEdge: 600,
    });

    assertImagesWithinBudget(result.images, { cells: 2, images: 1, maxEdge: 600 });
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].page, 1);
    assert.equal(result.segments[0].text, '');
    assert.equal(result.transcript.source, 'none');
    assert.equal(result.transcript.origin, 'none');
    assert.match(result.transcript.reason, /no text layer and no OCR provider is configured/);
    assert.ok(result.warnings.some((warning) => /no page text is available/.test(warning)));
  });
});

test('overview：stub provider OCR 段落映射；provider 失败时降级不报错', {
  skip: skipPdfRender,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const stub = stubDocProvider({ texts: scanText });
    const backend = createDocumentBackend({ ocrProvider: stub.provider, config: {} });
    const result = await backend.overview({
      path: SCANNED_PDF,
      pages: [1, 2],
      cells: 2,
      images: 1,
      maxEdge: 600,
    });

    assertImagesWithinBudget(result.images, { cells: 2, images: 1, maxEdge: 600 });
    assert.deepEqual(result.segments.map((segment) => segment.page), [1, 2]);
    assert.equal(result.segments[0].text, scanText(1));
    assert.equal(result.segments[1].text, scanText(2));
    assert.equal(result.transcript.source, 'ocr');
    assert.equal(result.transcript.origin, 'ocr');
    assert.equal(result.transcript.provider, 'stub');
    assert.equal(result.transcript.model, 'stub-v1');
    assert.deepEqual(stub.calls[0].pages, { from: 1, to: 2 });
    assert.equal(stub.calls[0].role, 'ocr');
    assert.equal(stub.calls[0].ocrMode, 'auto');
    for (const segment of result.segments) {
      assert.equal(segment.source, 'ocr');
      assert.equal(segment.origin, 'ocr');
      assert.equal(segment.textOrigin, 'ocr');
      assert.ok(segment.blocks.length > 0);
    }

    const failing = stubDocProvider({
      fail: new Error('stub OCR unavailable (Authorization: Bearer sk-supersecret123456789)'),
    });
    const degradedBackend = createDocumentBackend({ ocrProvider: failing.provider, config: {} });
    const degraded = await degradedBackend.overview({
      path: SCANNED_PDF,
      pages: [1],
      cells: 1,
      images: 1,
      maxEdge: 500,
    });

    assertImagesWithinBudget(degraded.images, { cells: 1, images: 1, maxEdge: 500 });
    assert.equal(degraded.segments[0].text, '');
    assert.equal(degraded.transcript.source, 'none');
    assert.ok(degraded.warnings.some((warning) => /OCR provider "stub" failed/.test(warning)));
    assert.ok(degraded.warnings.some((warning) => /Pages without a text layer are returned as page images only/.test(warning)));
    assert.ok(degraded.warnings.every((warning) => !warning.includes('sk-supersecret123456789')));
    assert.ok(degraded.warnings.some((warning) => warning.includes('Bearer ***')));

    await assert.rejects(
      () => degradedBackend.locate({ path: SCANNED_PDF, query: 'SCANNED PAGE ONE' }),
      (error) => error.code === 'PROVIDER_FAILED'
        && /stub OCR unavailable/.test(error.message)
        && !error.message.includes('sk-supersecret123456789'),
    );
  });
});

test('overview：图片文档出一张页面图；纯文本不出图但给整页文字', {
  skip: skipImage,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const image = await backend.overview({
      path: IMAGE,
      pages: [1],
      cells: 4,
      images: 1,
      maxEdge: 800,
    });
    assertImagesWithinBudget(image.images, { cells: 4, images: 1, maxEdge: 800 });
    assert.equal(image.images.length, 1);
    assert.equal(image.images[0].cells, 1);
    assert.equal(image.segments[0].page, 1);
    assert.equal(image.segments[0].text, '');
    assert.ok(image.warnings.some((warning) => /no page text is available/.test(warning)));
  });
});

test('overview：纯文本没有页面图，文字放在第 1 页 segment', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-doc-text-overview-'));
  try {
    const md = path.join(dir, 'notes.md');
    await writeFile(md, '# Notes\n\nAlpha Bravo Charlie.\n\nSecond section.\n');
    const backend = createDocumentBackend({ config: {} });
    const result = await backend.overview({
      path: md,
      pages: [1],
      cells: 6,
      images: 2,
      maxEdge: 1280,
    });
    assert.equal(result.images.length, 0);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].page, 1);
    assert.equal(result.segments[0].source, 'text');
    assert.equal(result.segments[0].origin, 'file');
    assert.match(result.segments[0].text, /Alpha Bravo Charlie/);
    assert.equal(result.transcript.source, 'text');
    assert.equal(result.transcript.origin, 'file');
    assert.ok(result.warnings.some((warning) => /no page images/.test(warning)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * zoom
 * ------------------------------------------------------------------ */

test('zoom：PDF 单页裁切 → 恰好一张 PNG，尺寸与 target 正确', {
  skip: skipPdfRender,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const result = await backend.zoom({
      path: TEXT_PDF,
      page: 3,
      crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      maxEdge: 800,
    });

    assert.equal(result.images.length, 1);
    assertImagesWithinBudget(result.images, { cells: 1, images: 1, maxEdge: 800 });
    const [image] = result.images;
    assert.equal(image.cells, 1);
    assert.ok(Math.max(image.width, image.height) > 0);
    const actual = pngSize(image.buffer);
    assert.deepEqual(actual, { width: image.width, height: image.height });
    assert.ok(Math.abs(image.width / image.height - 595 / 842) < 0.02, 'crop keeps the page aspect');
    assert.deepEqual(result.target, {
      kind: 'page',
      page: 3,
      atMs: null,
      atSec: null,
      crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    });
  });
});

test('zoom：图片文档也支持比例裁切', { skip: skipImage, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const result = await backend.zoom({
      path: IMAGE,
      page: 1,
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
      maxEdge: 500,
    });
    assert.equal(result.images.length, 1);
    assertImagesWithinBudget(result.images, { cells: 1, images: 1, maxEdge: 500 });
    const [image] = result.images;
    assert.deepEqual(pngSize(image.buffer), { width: image.width, height: image.height });
    assert.ok(Math.max(image.width, image.height) <= 500);
    assert.ok(Math.abs(image.width / image.height - 620 / 877) < 0.02);
  });
});

/* ------------------------------------------------------------------ *
 * locate
 * ------------------------------------------------------------------ */

test('locate：文本 PDF 页码匹配 + includeFrame 返回最佳匹配页', {
  skip: skipLocateFrame,
  timeout: 120000,
}, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    const result = await backend.locate({
      path: TEXT_PDF,
      query: 'SIX SEVEN EIGHT NINE TEN',
      includeFrame: true,
    });

    assert.ok(result.matches.length >= 1);
    assert.equal(result.totalSegments, TEXT_GT.pageCount);
    const best = result.matches[0];
    assert.equal(best.rank, 1);
    assert.equal(best.page, 3);
    assert.equal(best.score, 1);
    assert.equal(best.source, 'text');
    assert.equal(best.origin, 'textlayer');
    assert.equal(best.startMs, null);
    assert.equal(best.endMs, null);
    assert.equal(best.startSec, null);
    assert.equal(best.endSec, null);
    assert.match(best.text, /SIX SEVEN EIGHT NINE TEN/);
    assert.equal(result.transcript.source, 'text');
    assert.equal(result.transcript.origin, 'textlayer');

    assert.ok(result.frame, 'includeFrame must return a frame');
    assert.equal(result.frame.page, 3);
    assertPng(result.frame.buffer);
    const frameActual = pngSize(result.frame.buffer);
    assert.deepEqual(frameActual, { width: result.frame.width, height: result.frame.height });
    assert.ok(Math.max(result.frame.width, result.frame.height) <= 1280);
    assert.ok(result.frame.width * result.frame.height <= MAX_IMAGE_PIXELS);
  });
});

test('locate：无文字层且无 provider → NO_TRANSCRIPT', { skip: skipLocateText, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createDocumentBackend({ config: {} });
    await assert.rejects(
      () => backend.locate({ path: SCANNED_PDF, query: 'SCANNED PAGE ONE' }),
      (error) => error.code === 'NO_TRANSCRIPT'
        && /no text layer and no OCR provider is configured/.test(error.message),
    );
  });
});

test('locate：纯文本可搜，includeFrame 降级为 warning', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-doc-text-locate-'));
  try {
    const md = path.join(dir, 'notes.md');
    await writeFile(md, '# Notes\n\nAlpha Bravo Charlie.\n');
    const backend = createDocumentBackend({ config: {} });
    const result = await backend.locate({
      path: md,
      query: 'Bravo Charlie',
      includeFrame: true,
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].page, 1);
    assert.equal(result.matches[0].source, 'text');
    assert.equal(result.matches[0].origin, 'file');
    assert.equal(result.totalSegments, 1);
    assert.equal(result.frame, null);
    assert.ok(result.warnings.some((warning) => /no page image/.test(warning)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 不支持的类型
 * ------------------------------------------------------------------ */

test('Office 文档 → UNSUPPORTED_MEDIA_TYPE，hint 指向 LibreOffice 转 PDF', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-doc-office-'));
  try {
    const docx = path.join(dir, 'report.docx');
    await writeFile(docx, 'PK\u0003\u0004fake docx payload');
    const backend = createDocumentBackend({ config: {} });
    await assert.rejects(
      () => backend.probe({ path: docx }),
      (error) => error.code === 'UNSUPPORTED_MEDIA_TYPE'
        && /Office document format "\.docx" is not supported yet/.test(error.message)
        && /Office support is deferred/.test(error.hint)
        && /LibreOffice/.test(error.hint)
        && /convert-to pdf/.test(error.hint),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
