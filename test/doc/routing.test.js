// test/doc/routing.test.js —— 契约 v2 的逐页路由（9z5.28）
//
// 全程离线：PDF 能力用注入的 pdfSupport stub，provider 用计数 stub；
// 只有「图片文档一律走 OCR」那条用真实 fixture（缺 ffmpeg 时跳过）。
//
// 覆盖：
//   - 有文字层的页只发给 typeset，无文字层的页只发给 OCR；
//   - 两个角色是同一 provider 时只发一次 parse（role: 'both'），按 textOrigin 分配；
//   - 默认配置（OCR=none, TYPESET=builtin）下每页都有 blocks + textOrigin；
//   - 图片文档一律走 OCR 角色。

import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDocumentBackend } from '../../src/backend/document/index.js';
import { assertFfmpegAvailable } from '../../src/media/ffmpeg.js';
import { createDocProvider } from '../../src/providers/doc/index.js';
import { loadConfig } from '../../src/server/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE = path.join(ROOT, 'fixtures', 'generated', 'sample-image.png');

const PDF_BYTES = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

/** 注入的 PDF 能力：前 textPages 页有文字层，其余页没有。 */
function fakePdfSupport({ pageCount = 4, textPages = [1, 2] } = {}) {
  const textSet = new Set(textPages);
  return {
    async readMetadata() {
      return { pageCount, width: 595, height: 842 };
    },
    async sampleHasText() {
      return {
        hasText: textPages.length > 0,
        textExtractor: 'pdftotext',
        sampledPages: [1],
        checkedPages: [1],
        textPage: textPages[0] ?? null,
        reason: null,
      };
    },
    async extractTextLayers(_filePath, pages) {
      const map = new Map();
      for (const page of pages) {
        const hasTextLayer = textSet.has(page);
        map.set(page, {
          text: hasTextLayer ? `page ${page} text layer` : '',
          hasTextLayer,
        });
      }
      return { textExtractor: 'pdftotext', pages: map, reason: null };
    },
    async resolveTools() {
      return { textExtractor: 'pdftotext', info: 'pdfinfo', rasterizer: 'pdftoppm' };
    },
    async extractText() {
      throw new Error('extractText should not be called: the routing uses extractTextLayers');
    },
    async renderPage() {
      throw new Error('renderPage should not be called with images: 0');
    },
  };
}

function pageList(spec) {
  if (!spec) return [];
  if (spec.list) return [...spec.list];
  if (spec.from) return Array.from({ length: spec.to - spec.from + 1 }, (_, i) => spec.from + i);
  return [];
}

/** 计数 provider stub；textOriginForPage 控制逐页 textOrigin。 */
function makeStubProvider({ id, roles = ['ocr', 'typeset'], textOriginForPage = null, fail = null } = {}) {
  const calls = [];
  const provider = {
    id,
    roles,
    describe: () => ({ id, model: null, baseUrl: null }),
    async parse(input) {
      calls.push(input);
      if (fail) throw fail;
      return {
        provider: id,
        model: null,
        pages: pageList(input.pages).map((page) => {
          const text = `page ${page} text from ${id}`;
          const textOrigin = textOriginForPage
            ? textOriginForPage(page, input)
            : (input.role === 'typeset' ? 'textlayer' : 'ocr');
          return { page, textOrigin, blocks: [{ type: 'paragraph', text }], text };
        }),
      };
    },
  };
  return { provider, calls };
}

async function withPdf(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-routing-'));
  const file = path.join(dir, 'doc.pdf');
  await writeFile(file, PDF_BYTES);
  const previous = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  try {
    return await fn({ dir, file });
  } finally {
    if (previous === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('逐页路由：有文字层 → typeset，无文字层 → OCR（两个 provider 各一次）', async () => {
  await withPdf(async ({ file }) => {
    const ocr = makeStubProvider({ id: 'ocr-stub' });
    const typeset = makeStubProvider({ id: 'typeset-stub' });
    const backend = createDocumentBackend({
      // 9z5.24 的 skip-simple 默认会把单栏页留在本地；这条用例只测逐页路由。
      config: { ocr: { provider: 'ocr-stub' }, typeset: { provider: 'typeset-stub', skipSimple: false } },
      ocrProvider: ocr.provider,
      typesetProvider: typeset.provider,
      pdfSupport: fakePdfSupport({ textPages: [1, 2] }),
    });

    const result = await backend.overview({ path: file, images: 0 });

    assert.equal(typeset.calls.length, 1, 'typeset 只应被调用一次');
    assert.deepEqual(typeset.calls[0].pages, { from: 1, to: 2 });
    assert.equal(typeset.calls[0].role, 'typeset');
    assert.equal(typeset.calls[0].ocrMode, 'auto');
    assert.deepEqual(typeset.calls[0].textLayers, { 1: 'page 1 text layer', 2: 'page 2 text layer' });

    assert.equal(ocr.calls.length, 1, 'OCR 只应被调用一次');
    assert.deepEqual(ocr.calls[0].pages, { from: 3, to: 4 });
    assert.equal(ocr.calls[0].role, 'ocr');
    assert.equal(ocr.calls[0].ocrMode, 'auto');

    const byPage = new Map(result.segments.map((segment) => [segment.page, segment]));
    for (const page of [1, 2]) {
      assert.equal(byPage.get(page).text, `page ${page} text from typeset-stub`);
      assert.equal(byPage.get(page).textOrigin, 'textlayer');
    }
    for (const page of [3, 4]) {
      assert.equal(byPage.get(page).text, `page ${page} text from ocr-stub`);
      assert.equal(byPage.get(page).textOrigin, 'ocr');
    }
    assert.equal(result.transcript.provider, 'typeset-stub');
  });
});

test('同一 provider 担两个角色 → 只发一次 parse（role: both），按 textOrigin 分配', async () => {
  await withPdf(async ({ file }) => {
    const both = makeStubProvider({
      id: 'both-stub',
      textOriginForPage: (page) => (page <= 2 ? 'textlayer' : 'ocr'),
    });
    const backend = createDocumentBackend({
      config: { ocr: { provider: 'both-stub' }, typeset: { provider: 'both-stub', skipSimple: false } },
      ocrProvider: both.provider,
      typesetProvider: both.provider,
      pdfSupport: fakePdfSupport({ textPages: [1, 2] }),
    });

    const result = await backend.overview({ path: file, images: 0 });

    assert.equal(both.calls.length, 1, '同一 provider 只允许一次 parse / fetch');
    assert.equal(both.calls[0].role, 'both');
    assert.deepEqual(both.calls[0].pages, { from: 1, to: 4 });
    assert.equal(both.calls[0].ocrMode, 'auto');

    const byPage = new Map(result.segments.map((segment) => [segment.page, segment]));
    assert.equal(byPage.get(1).textOrigin, 'textlayer');
    assert.equal(byPage.get(2).textOrigin, 'textlayer');
    assert.equal(byPage.get(3).textOrigin, 'ocr');
    assert.equal(byPage.get(4).textOrigin, 'ocr');
    assert.equal(result.warnings.some((warning) => /re-recognized/.test(warning)), false);
  });
});

test('默认配置（OCR=none, TYPESET=builtin）：每页都有 blocks + textOrigin', async () => {
  await withPdf(async ({ dir, file }) => {
    const config = loadConfig({ MMGREP_CACHE_DIR: path.join(dir, 'cache') });
    assert.equal(config.ocr.provider, 'none');
    assert.equal(config.typeset.provider, 'builtin');

    const ocrProvider = createDocProvider('ocr', {}, { provider: config.ocr.provider });
    const typesetProvider = createDocProvider('typeset', {}, { provider: config.typeset.provider });
    assert.equal(ocrProvider, null);
    assert.equal(typesetProvider.id, 'builtin');

    const backend = createDocumentBackend({
      config,
      ocrProvider,
      typesetProvider,
      pdfSupport: fakePdfSupport({ textPages: [1, 2] }),
    });

    const result = await backend.overview({ path: file, images: 0 });
    assert.equal(result.segments.length, 4);
    for (const segment of result.segments) {
      assert.ok(Array.isArray(segment.blocks), `page ${segment.page} must have blocks`);
      assert.ok(['textlayer', 'ocr', 'unknown'].includes(segment.textOrigin));
    }

    // 有文字层的页由 builtin typeset 产出 paragraph blocks。
    for (const page of [1, 2]) {
      const segment = result.segments.find((entry) => entry.page === page);
      assert.equal(segment.textOrigin, 'textlayer');
      assert.deepEqual(segment.blocks, [{ type: 'paragraph', text: `page ${page} text layer` }]);
      assert.equal(segment.text, `page ${page} text layer`);
    }
    // 没有文字层且 OCR=none：空文本，但仍有 blocks / textOrigin（页图兜底）。
    for (const page of [3, 4]) {
      const segment = result.segments.find((entry) => entry.page === page);
      assert.equal(segment.textOrigin, 'unknown');
      assert.deepEqual(segment.blocks, []);
      assert.equal(segment.text, '');
    }
  });
});

test('图片文档一律走 OCR 角色', { skip: !(await (async () => {
  try {
    await access(IMAGE);
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
})()) ? 'sample-image.png + ffmpeg are required' : false }, async () => {
  const ocr = makeStubProvider({ id: 'ocr-stub', roles: ['ocr'] });
  const backend = createDocumentBackend({
    config: { ocr: { provider: 'ocr-stub' }, typeset: { provider: 'none' } },
    ocrProvider: ocr.provider,
    typesetProvider: null,
  });
  const result = await backend.overview({ path: IMAGE, images: 0 });
  assert.equal(ocr.calls.length, 1);
  assert.equal(ocr.calls[0].role, 'ocr');
  assert.equal(result.segments[0].textOrigin, 'ocr');
  assert.equal(result.segments[0].text, 'page 1 text from ocr-stub');
});
