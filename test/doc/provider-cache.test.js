// test/doc/provider-cache.test.js —— 文档 provider 逐页结果缓存（9z5.30）
//
// 全程离线：
//   - 需要真实 provider 流程的用例用 MinerU adapter + 注入的计数 fetchImpl
//     （申请上传地址 → PUT → 轮询 → 下载 zip，zip 在测试里现造）；
//   - 路由 / 部分缓存 / LRU 用例用计数 provider stub，便于精确断言「发了哪些页」。
//
// 覆盖验收标准：
//   (a) 同一文件同一页范围第二次 overview 不发任何 provider 请求；
//   (b) locate 复用 overview 的缓存；
//   (c) 先 1-12 再 1-24，第二次只请求 13-24；
//   (d) model / ocrMode 变化会重新请求（force 不覆盖 auto）；
//   (e) 缓存仍受 LRU / MMGREP_CACHE_MAX_BYTES 约束；
//   (f) 部分缓存 + 逐页路由：只把缺失页发给 provider；
//   另外覆盖：损坏的缓存页被忽略并重取、缓存写失败不影响调用。

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { createDocumentBackend } from '../../src/backend/document/index.js';
import { createCache } from '../../src/cache/index.js';
import { createMineruDocProvider } from '../../src/providers/doc/mineru.js';

const PDF_BYTES = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
const MINERU_BASE = 'https://mineru.test/api/v4';
const TEST_API_KEY = 'test-key';
const DEFAULT_MAX_BYTES = 10 * 1024 ** 3;

/* ------------------------------------------------------------------ *
 * 最小 zip 构造器（与 test/doc/mineru.test.js 同款，避免真实网络）
 * ------------------------------------------------------------------ */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = crc32(data);
    const compressed = deflateRawSync(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/** 造 MinerU 的 content_list.json 结果包：每页一条 paragraph。 */
function contentListZip(pageCount) {
  const items = Array.from({ length: pageCount }, (_, index) => ({
    type: 'text',
    text: `page ${index + 1} ocr text`,
    page_idx: index,
  }));
  return makeZip([{ name: 'content_list.json', data: JSON.stringify(items) }]);
}

/* ------------------------------------------------------------------ *
 * 计数 fetchImpl：模拟 MinerU 的四步流程，不发任何真实网络请求
 * ------------------------------------------------------------------ */

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * @param {{ pageCount: number }} spec
 * @returns {{ fetchImpl: Function, calls: object[], parseRequests: () => object[] }}
 */
function makeMineruFetch({ pageCount }) {
  const calls = [];
  let batchCounter = 0;

  async function fetchImpl(url, options = {}) {
    const method = String(options.method ?? 'GET').toUpperCase();
    const parsed = new URL(String(url));
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    calls.push({ method, url: String(url), path: parsed.pathname, body });

    if (method === 'POST' && parsed.pathname.endsWith('/file-urls/batch')) {
      batchCounter += 1;
      const batchId = `batch-${batchCounter}`;
      return jsonResponse({
        code: 0,
        data: { batch_id: batchId, file_urls: [`https://upload.test/${batchId}`] },
      });
    }
    if (method === 'PUT' && parsed.hostname === 'upload.test') {
      return new Response(null, { status: 200 });
    }
    if (method === 'GET' && parsed.pathname.includes('/extract-results/batch/')) {
      const batchId = parsed.pathname.split('/').pop();
      return jsonResponse({
        code: 0,
        data: {
          extract_result: [{
            file_name: 'doc.pdf',
            state: 'done',
            full_zip_url: `https://zip.test/${batchId}`,
          }],
        },
      });
    }
    if (method === 'GET' && parsed.hostname === 'zip.test') {
      return new Response(contentListZip(pageCount), { status: 200 });
    }
    throw new Error(`unexpected fake request: ${method} ${url}`);
  }

  return {
    fetchImpl,
    calls,
    parseRequests: () => calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/file-urls/batch'),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * 文档后端 / provider stub
 * ------------------------------------------------------------------ */

/** 注入的 PDF 能力：textPages 里的页有文字层，其余页没有。 */
function fakePdfSupport({ pageCount = 4, textPages = [] } = {}) {
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
      throw new Error('extractText should not be called: routing uses extractTextLayers');
    },
    async renderPage() {
      throw new Error('renderPage should not be called with images: 0');
    },
  };
}

function pageRange(from, to) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function pageList(spec) {
  if (!spec) return [];
  if (spec.list) return [...spec.list];
  if (spec.from) return Array.from({ length: spec.to - spec.from + 1 }, (_, i) => spec.from + i);
  return [];
}

/** 计数 provider stub；可控制逐页 textOrigin。 */
function makeStubProvider({ id, roles = ['ocr', 'typeset'], textOriginForPage = null } = {}) {
  const calls = [];
  const provider = {
    id,
    roles,
    describe: () => ({ id, model: null, baseUrl: null }),
    async parse(input) {
      calls.push(input);
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

function makeBackend({ pdf, cache, ocrProvider, typesetProvider = null, pageCount = 4, textPages = [] }) {
  return createDocumentBackend({
    config: {
      ocr: ocrProvider
        ? { provider: ocrProvider.id, apiKey: TEST_API_KEY, baseUrl: 'http://127.0.0.1:9/api/v4' }
        : { provider: 'none' },
      typeset: typesetProvider ? { provider: typesetProvider.id } : { provider: 'none' },
    },
    ocrProvider,
    typesetProvider,
    pdfSupport: fakePdfSupport({ pageCount, textPages }),
    cache,
  });
}

/**
 * 每个用例独立的临时目录：
 *   <dir>/doc.pdf / doc-b.pdf   源文件
 *   <dir>/cache                 缓存根目录（MMGREP_CACHE_DIR）
 */
async function withDocCache(fn, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-provider-cache-'));
  const cacheDir = path.join(dir, 'cache');
  const pdf = path.join(dir, 'doc.pdf');
  const pdfB = path.join(dir, 'doc-b.pdf');
  await writeFile(pdf, PDF_BYTES);
  await writeFile(pdfB, Buffer.concat([PDF_BYTES, Buffer.from('\n% b\n')]));
  const previousCache = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = cacheDir;
  const cache = createCache({ dir: cacheDir, maxBytes, fsync: false });
  try {
    return await fn({ dir, pdf, pdfB, cache, cacheDir });
  } finally {
    if (previousCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
}

/** 递归列出目录里的文件（找缓存的 page-*.json 用）。 */
async function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * (a) 第二次 overview 零 provider 请求
 * ------------------------------------------------------------------ */

test('(a) 同一文件同一页范围第二次 overview：provider 零请求', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const mock = makeMineruFetch({ pageCount: 4 });
    const provider = createMineruDocProvider({
      apiKey: TEST_API_KEY,
      baseUrl: MINERU_BASE,
      model: 'm1',
      fetchImpl: mock.fetchImpl,
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });
    const backend = makeBackend({ pdf, cache, ocrProvider: provider });

    const first = await backend.overview({ path: pdf, images: 0 });
    assert.equal(mock.parseRequests().length, 1, 'first overview must call the provider once');
    assert.equal(first.segments.length, 4);
    assert.equal(first.segments[0].text, 'page 1 ocr text');
    await assertCacheLivesUnder(cache, cache.dir);

    const second = await backend.overview({ path: pdf, images: 0 });
    assert.equal(mock.parseRequests().length, 1, 'second overview must not call the provider');
    assert.deepEqual(second.segments.map((segment) => segment.text), first.segments.map((segment) => segment.text));
    assert.equal(second.transcript.provider, 'mineru', 'cached pages still report the provider');

    // 换一个后端实例（模拟新进程 / 新请求）仍应命中的是磁盘缓存，而不是进程内状态。
    const restarted = makeBackend({ pdf, cache, ocrProvider: provider });
    await restarted.overview({ path: pdf, images: 0 });
    assert.equal(mock.parseRequests().length, 1, 'the page cache survives a fresh backend instance');
  });
});

/* ------------------------------------------------------------------ *
 * (b) locate 复用 overview 的缓存
 * ------------------------------------------------------------------ */

test('(b) locate 在 overview 之后复用同一份页缓存', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const mock = makeMineruFetch({ pageCount: 4 });
    const provider = createMineruDocProvider({
      apiKey: TEST_API_KEY,
      baseUrl: MINERU_BASE,
      fetchImpl: mock.fetchImpl,
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });
    const backend = makeBackend({ pdf, cache, ocrProvider: provider });

    await backend.overview({ path: pdf, images: 0 });
    assert.equal(mock.parseRequests().length, 1);

    const located = await backend.locate({ path: pdf, query: 'page 3 ocr text', max: 3 });
    assert.equal(mock.parseRequests().length, 1, 'locate must reuse overview pages');
    assert.ok(located.matches.length >= 1);
    assert.equal(located.matches[0].page, 3);
  });
});

/* ------------------------------------------------------------------ *
 * (c) 1-12 → 1-24 只补 13-24
 * ------------------------------------------------------------------ */

test('(c) 先请求 1-12 再请求 1-24：第二次只向 provider 请求 13-24', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const mock = makeMineruFetch({ pageCount: 24 });
    const provider = createMineruDocProvider({
      apiKey: TEST_API_KEY,
      baseUrl: MINERU_BASE,
      fetchImpl: mock.fetchImpl,
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });
    const backend = makeBackend({ pdf, cache, ocrProvider: provider, pageCount: 24 });

    const first = await backend.overview({ path: pdf, pages: pageRange(1, 12), images: 0 });
    assert.equal(first.segments.length, 12);
    const requests = mock.parseRequests();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.files[0].page_ranges, '1-12');

    const second = await backend.overview({ path: pdf, pages: pageRange(1, 24), images: 0 });
    assert.equal(second.segments.length, 24);
    assert.deepEqual(second.segments.map((segment) => segment.page), Array.from({ length: 24 }, (_, i) => i + 1));

    const after = mock.parseRequests();
    assert.equal(after.length, 2, 'second overview must call the provider exactly once (for the missing pages)');
    assert.equal(after[1].body.files[0].page_ranges, '13-24', 'only pages 13-24 are missing');
    // 页面形状仍对齐：1-12 来自缓存，13-24 来自新结果。
    assert.equal(second.segments[0].text, 'page 1 ocr text');
    assert.equal(second.segments[23].text, 'page 24 ocr text');
  });
});

/* ------------------------------------------------------------------ *
 * (d) model / ocrMode 变化 → 新 key，重新请求
 * ------------------------------------------------------------------ */

test('(d1) 改变 model 后使用新的 namespace，重新请求 provider', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const mockA = makeMineruFetch({ pageCount: 4 });
    const providerA = createMineruDocProvider({
      apiKey: TEST_API_KEY,
      baseUrl: MINERU_BASE,
      model: 'm1',
      fetchImpl: mockA.fetchImpl,
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });
    const backendA = makeBackend({ pdf, cache, ocrProvider: providerA });
    await backendA.overview({ path: pdf, images: 0 });
    assert.equal(mockA.parseRequests().length, 1);

    const mockB = makeMineruFetch({ pageCount: 4 });
    const providerB = createMineruDocProvider({
      apiKey: TEST_API_KEY,
      baseUrl: MINERU_BASE,
      model: 'm2',
      fetchImpl: mockB.fetchImpl,
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });
    const backendB = makeBackend({ pdf, cache, ocrProvider: providerB });
    await backendB.overview({ path: pdf, images: 0 });
    assert.equal(mockB.parseRequests().length, 1, 'different model → different cache key → refetch');

    await backendB.overview({ path: pdf, images: 0 });
    assert.equal(mockB.parseRequests().length, 1, 'same model again → cache hit');
  });
});

test('(d2) ocrMode=force 单独成键：重新请求，且不覆盖 auto 的缓存', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const mock = makeMineruFetch({ pageCount: 4 });
    const provider = createMineruDocProvider({
      apiKey: TEST_API_KEY,
      baseUrl: MINERU_BASE,
      model: 'm1',
      fetchImpl: mock.fetchImpl,
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });
    const backend = makeBackend({ pdf, cache, ocrProvider: provider });

    await backend.overview({ path: pdf, images: 0 });
    assert.equal(mock.parseRequests().length, 1);
    assert.equal(mock.parseRequests()[0].body.files[0].is_ocr, undefined, 'auto must not force OCR');

    const forced = await backend.overview({ path: pdf, images: 0, ocrMode: 'force' });
    assert.equal(mock.parseRequests().length, 2, 'force must not hit the auto cache');
    assert.equal(mock.parseRequests()[1].body.files[0].is_ocr, true);
    assert.equal(forced.segments[0].textOrigin, 'ocr');
    assert.equal(forced.segments[0].text, 'page 1 ocr text');

    // force 的结果不能覆盖 auto：再跑一次 auto 仍然命中原来的 namespace。
    await backend.overview({ path: pdf, images: 0 });
    assert.equal(mock.parseRequests().length, 2, 'auto cache must survive a force run');
  });
});

/* ------------------------------------------------------------------ *
 * (e) LRU / maxBytes
 * ------------------------------------------------------------------ */

test('(e) provider 页缓存参与同一套 LRU / maxBytes 淘汰', async () => {
  await withDocCache(async ({ pdf, pdfB, cache }) => {
    const { provider, calls } = makeStubProvider({ id: 'lr-stub' });
    const backend = makeBackend({ pdf, cache, ocrProvider: provider, pageCount: 2 });

    await backend.overview({ path: pdf, images: 0 });
    assert.equal(calls.length, 1);

    await backend.overview({ path: pdfB, images: 0 });
    assert.equal(calls.length, 2);

    // 两个 namespace 的载荷都远大于 120 字节 → 第一份被 LRU 淘汰，回到 A 必须重取。
    await backend.overview({ path: pdf, images: 0 });
    assert.equal(calls.length, 3, 'the first file was evicted by maxBytes → refetched');

    const stats = await cache.stats();
    assert.equal(stats.entries, 1, 'LRU keeps only the newest namespace under the budget');
  }, { maxBytes: 120 });
});

/* ------------------------------------------------------------------ *
 * (f) 部分缓存 + 逐页路由
 * ------------------------------------------------------------------ */

test('(f1) 两个 provider：typeset 命中缓存，OCR 只补缺失页', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const ocr = makeStubProvider({ id: 'ocr-stub', roles: ['ocr'] });
    const typeset = makeStubProvider({ id: 'typeset-stub', roles: ['typeset'] });
    const backend = makeBackend({
      pdf,
      cache,
      ocrProvider: ocr.provider,
      typesetProvider: typeset.provider,
      pageCount: 4,
      textPages: [1, 2],
    });

    // 第一次只请求有文字层的 1-2：只有 typeset 被调用。
    await backend.overview({ path: pdf, pages: pageRange(1, 2), images: 0 });
    assert.equal(typeset.calls.length, 1);
    assert.deepEqual(typeset.calls[0].pages, { from: 1, to: 2 });
    assert.equal(ocr.calls.length, 0);

    // 扩到 1-4：typeset 1-2 命中缓存，OCR 只请求 3-4。
    const result = await backend.overview({ path: pdf, pages: pageRange(1, 4), images: 0 });
    assert.equal(typeset.calls.length, 1, 'typeset pages 1-2 must come from the cache');
    assert.equal(ocr.calls.length, 1);
    assert.deepEqual(ocr.calls[0].pages, { from: 3, to: 4 }, 'only the missing OCR pages are requested');

    const byPage = new Map(result.segments.map((segment) => [segment.page, segment]));
    assert.equal(byPage.get(1).text, 'page 1 text from typeset-stub');
    assert.equal(byPage.get(3).text, 'page 3 text from ocr-stub');

    // 再请求一次完整范围：两边都命中，不再发请求。
    await backend.overview({ path: pdf, pages: pageRange(1, 4), images: 0 });
    assert.equal(typeset.calls.length, 1);
    assert.equal(ocr.calls.length, 1);
  });
});

test('(f2) 同一 provider 双角色 + 部分缓存：仍只发一次 role:both，且只含缺失页', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const both = makeStubProvider({
      id: 'both-stub',
      textOriginForPage: (page, input) => {
        if (input.role === 'both') return page <= 2 ? 'textlayer' : 'ocr';
        return input.role === 'typeset' ? 'textlayer' : 'ocr';
      },
    });
    const backend = makeBackend({
      pdf,
      cache,
      ocrProvider: both.provider,
      typesetProvider: both.provider,
      pageCount: 4,
      textPages: [1, 2],
    });

    // 第一次只请求 3-4（都无文字层）→ OCR 角色，缓存 OCR 页。
    await backend.overview({ path: pdf, pages: pageRange(3, 4), images: 0 });
    assert.equal(both.calls.length, 1);
    assert.equal(both.calls[0].role, 'ocr');
    assert.deepEqual(both.calls[0].pages, { from: 3, to: 4 });

    // 扩到 1-4：3-4 命中 OCR 缓存，1-2 缺失；同 provider 双角色只发一次 role:both。
    const result = await backend.overview({ path: pdf, pages: pageRange(1, 4), images: 0 });
    assert.equal(both.calls.length, 2, 'one request total for the missing pages');
    assert.equal(both.calls[1].role, 'both');
    assert.deepEqual(both.calls[1].pages, { from: 1, to: 2 }, 'cached OCR pages 3-4 must not be re-requested');
    assert.deepEqual(both.calls[1].textLayers, {
      1: 'page 1 text layer',
      2: 'page 2 text layer',
    });

    const byPage = new Map(result.segments.map((segment) => [segment.page, segment]));
    for (const page of [1, 2]) {
      assert.equal(byPage.get(page).textOrigin, 'textlayer');
      assert.equal(byPage.get(page).text, `page ${page} text from both-stub`);
    }
    for (const page of [3, 4]) {
      assert.equal(byPage.get(page).textOrigin, 'ocr');
      assert.equal(byPage.get(page).text, `page ${page} text from both-stub`);
    }

    // 第三次完整范围：两边都命中，零 provider 请求。
    await backend.overview({ path: pdf, pages: pageRange(1, 4), images: 0 });
    assert.equal(both.calls.length, 2);
  });
});

test('(f3) 同一 provider 双角色：typeset 已缓存、OCR 缺失时也只发一次 role:both', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const both = makeStubProvider({
      id: 'both-stub',
      textOriginForPage: (page, input) => {
        if (input.role === 'typeset') return 'textlayer';
        return page <= 2 ? 'textlayer' : 'ocr';
      },
    });
    const backend = makeBackend({
      pdf,
      cache,
      ocrProvider: both.provider,
      typesetProvider: both.provider,
      pageCount: 4,
      textPages: [1, 2],
    });

    // 第一次只请求有文字层的 1-2 → typeset 角色（此时还没有 OCR 页）。
    await backend.overview({ path: pdf, pages: pageRange(1, 2), images: 0 });
    assert.equal(both.calls.length, 1);
    assert.equal(both.calls[0].role, 'typeset');

    // 扩到 1-4：typeset 1-2 命中缓存，只缺 OCR 3-4，仍然只发一次 role:both。
    const result = await backend.overview({ path: pdf, pages: pageRange(1, 4), images: 0 });
    assert.equal(both.calls.length, 2);
    assert.equal(both.calls[1].role, 'both');
    assert.deepEqual(both.calls[1].pages, { from: 3, to: 4 });
    assert.equal(both.calls[1].textLayers, undefined, 'cached typeset pages are not sent again');

    const byPage = new Map(result.segments.map((segment) => [segment.page, segment]));
    assert.equal(byPage.get(1).textOrigin, 'textlayer');
    assert.equal(byPage.get(3).textOrigin, 'ocr');
  });
});

test('缓存页保留契约 v2 的完整 page 对象（含 tables）', async () => {
  await withDocCache(async ({ pdf, cache, cacheDir }) => {
    const calls = [];
    const provider = {
      id: 'table-stub',
      roles: ['ocr'],
      describe: () => ({ id: 'table-stub', model: null }),
      async parse(input) {
        calls.push(input.pages);
        return {
          provider: 'table-stub',
          model: null,
          pages: pageList(input.pages).map((page) => ({
            page,
            textOrigin: 'ocr',
            blocks: [{ type: 'table', text: 'A | B' }],
            text: 'A | B',
            tables: [{ rows: [['A', 'B']] }],
          })),
        };
      },
    };
    const backend = makeBackend({ pdf, cache, ocrProvider: provider, pageCount: 1 });

    await backend.overview({ path: pdf, images: 0 });
    assert.equal(calls.length, 1);
    const pageFiles = (await listFiles(cacheDir)).filter((file) => path.basename(file) === 'page-0001.json');
    assert.equal(pageFiles.length, 1);
    const stored = JSON.parse(await readFile(pageFiles[0], 'utf8'));
    assert.equal(stored.version, 1);
    assert.deepEqual(stored.page, {
      page: 1,
      textOrigin: 'ocr',
      blocks: [{ type: 'table', text: 'A | B' }],
      text: 'A | B',
      tables: [{ rows: [['A', 'B']] }],
    });

    await backend.overview({ path: pdf, images: 0 });
    assert.equal(calls.length, 1, 'the cached page must be reused');
  });
});

/* ------------------------------------------------------------------ *
 * 容错：坏缓存 / 写失败
 * ------------------------------------------------------------------ */

test('损坏的缓存页被忽略，只重取坏掉的那一页', async () => {
  await withDocCache(async ({ pdf, cache, cacheDir }) => {
    const { provider, calls } = makeStubProvider({ id: 'corrupt-stub' });
    const backend = makeBackend({ pdf, cache, ocrProvider: provider, pageCount: 4 });
    await backend.overview({ path: pdf, images: 0 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].pages, { from: 1, to: 4 });

    const pageFiles = (await listFiles(cacheDir)).filter((file) => path.basename(file) === 'page-0002.json');
    assert.equal(pageFiles.length, 1, 'expected one cached file for page 2');
    await writeFile(pageFiles[0], '{ definitely not json', 'utf8');

    const result = await backend.overview({ path: pdf, images: 0 });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].pages, { from: 2, to: 2 }, 'only the unreadable page is refetched');
    assert.equal(result.segments.length, 4);
    assert.equal(result.segments[1].text, 'page 2 text from corrupt-stub');
  });
});

test('缓存写失败不影响调用：结果照常返回', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const { provider, calls } = makeStubProvider({ id: 'write-fail-stub' });
    const failingCache = {
      contentKeyForFile: (...args) => cache.contentKeyForFile(...args),
      getPath: (...args) => cache.getPath(...args),
      touch: (...args) => cache.touch(...args),
      async prepareDir() {
        throw new Error('cache directory is read-only');
      },
      async register() {
        throw new Error('cache directory is read-only');
      },
    };
    const backend = makeBackend({ pdf, cache: failingCache, ocrProvider: provider, pageCount: 2 });

    const result = await backend.overview({ path: pdf, images: 0 });
    assert.equal(calls.length, 1);
    assert.deepEqual(
      result.segments.map((segment) => segment.text),
      ['page 1 text from write-fail-stub', 'page 2 text from write-fail-stub'],
    );
    assert.equal((await cache.stats()).entries, 0, 'nothing was registered');
  });
});

/** 断言缓存条目都在 MMGREP_CACHE_DIR 下（内容哈希分片布局）。 */
async function assertCacheLivesUnder(cache, cacheDir) {
  const stats = await cache.stats();
  assert.ok(stats.entries > 0, 'expected at least one cache entry');
  const files = await listFiles(cacheDir);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.ok(file.startsWith(cacheDir + path.sep), `${file} must live under MMGREP_CACHE_DIR`);
  }
}

