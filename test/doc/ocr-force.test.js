// test/doc/ocr-force.test.js —— agent 强制重新 OCR + probe 可疑文字层（ticket 9z5.31）
//
// 覆盖验收标准：
//   (a) ocr: "force" 时，有文字层的页也发给 OCR provider，页标签变成 (ocr)；
//       ocr: "auto"（默认）不这么做；
//   (b) 没有 OCR provider 时 force → PROVIDER_NOT_CONFIGURED，hint 指向
//       MMGREP_OCR_PROVIDER / x-mmgrep-ocr-provider 头；
//   (c) 乱码文字层 fixture → probe 出现 `text layer: looks unreliable (...) — consider
//       media_overview({ path, ocr: "force" })`；正常论文 / 正常 fixture 不出现；
//   (d) force 结果走 9z5.30 的独立缓存 namespace（不覆盖 auto 结果）；
//   (e) 工具 schema / 适用性：media_overview / media_locate 才有 ocr，video/audio 传它
//       必须报 INVALID_ARGUMENT。
//
// 全程离线：OCR provider 用注入的计数 stub；PDF 元信息 / 文字层用 fake pdfSupport
// （fixture 用例除外——它们走真实 pdftotext，缺工具时跳过）。

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createDocumentBackend } from '../../src/backend/document/index.js';
import {
  FORCE_OCR_HINT,
  assessTextLayerQuality,
} from '../../src/backend/document/text-quality.js';
import { createCache } from '../../src/cache/index.js';
import { ToolError } from '../../src/media/interface.js';
import { createPlaceholderBackend } from '../../src/server/backends.js';
import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';
import {
  LOCATE_DESCRIPTION,
  OVERVIEW_DESCRIPTION,
  TOOL_SHAPES,
  checkApplicability,
} from '../../src/server/tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = path.join(ROOT, 'fixtures', 'generated');
const GARBLED_PDF = path.join(GENERATED, 'sample-garbled-text.pdf');
const TEXT_PDF = path.join(GENERATED, 'sample-text.pdf');
const REAL_PDF = path.join(GENERATED, 'real-nbt-ago2.pdf');
const PDF_BYTES = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数：可疑文字层启发式
 * ------------------------------------------------------------------ */

const NORMAL_PAPER = [
  'Tools for manipulating RNA that rely on nonhuman proteins, such as Cas-based scaffolds,',
  'can lead to unintended effects on human cells. Here we demonstrate that human Argonaute 2',
  '(AGO2) can be repurposed as a modular RNA targeting domain. Using guide RNAs that remodel',
  'target RNA structure for selective editing and reduced nuclease activity, we show that the',
  'editing efficiency is 1.9-fold higher in HEK293T cells compared with the controls.',
].join(' ');

test('启发式：正常论文文本不报不可靠', () => {
  const result = assessTextLayerQuality(NORMAL_PAPER);
  assert.equal(result.reliable, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.warning, null);
  assert.equal(result.metrics.tokens > 20, true);
});

test('启发式：U+FFFD 替换字符 → 不可靠', () => {
  const text = `${NORMAL_PAPER} ${'\uFFFD'.repeat(4)}`;
  const result = assessTextLayerQuality(text);
  assert.equal(result.reliable, false);
  assert.match(result.reasons.join(' '), /4 U\+FFFD replacement character/);
  assert.match(result.warning, /looks unreliable .*— consider media_overview\(\{ path, ocr: "force" \}\)/);
  assert.equal(result.warning.includes(FORCE_OCR_HINT), true);
});

test('启发式：私用区字符 → 不可靠', () => {
  const text = `${NORMAL_PAPER} ${'\uE000\uE001\uF8FF\uF8FE\uE123'}${'\uE200'.repeat(5)}`;
  const result = assessTextLayerQuality(text);
  assert.equal(result.reliable, false);
  assert.match(result.reasons.join(' '), /private-use character/);
});

test('启发式：大量孤立单字母 token → 不可靠', () => {
  const letters = 'q z x k j v b n m w r t p s d f g h l c a e i o u y'
    .split(' ').join(' ');
  const result = assessTextLayerQuality(`${letters} ${letters} NORMAL TITLE`);
  assert.equal(result.reliable, false);
  assert.match(result.reasons.join(' '), /isolated single letters/);
});

test('启发式：非词 token 占比高 → 不可靠', () => {
  const noise = '### @@ ^^^ &&& *** ((( ))) [[[ ]]] ~~~ ||| ??? !!! ... ,,, ;;; ::: ///';
  const result = assessTextLayerQuality(`${noise} ${noise} ${noise} HELLO WORLD`);
  assert.equal(result.reliable, false);
  assert.match(result.reasons.join(' '), /contain no letter or digit/);
});

test('启发式：没有样本可判时 reliable=null（不是「可靠」）', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const result = assessTextLayerQuality(empty);
    assert.equal(result.reliable, null);
    assert.equal(result.warning, null);
  }
});

test('启发式：样本太小时不按比例判定（避免一两个 token 就误报）', () => {
  const result = assessTextLayerQuality('# a');
  assert.equal(result.reliable, true);
});

/* ------------------------------------------------------------------ *
 * 工具 schema / 适用性
 * ------------------------------------------------------------------ */

test('schema：只有 media_overview / media_locate 有 ocr 参数', () => {
  assert.ok(TOOL_SHAPES.media_overview.ocr, 'media_overview must expose ocr');
  assert.ok(TOOL_SHAPES.media_locate.ocr, 'media_locate must expose ocr');
  assert.equal(TOOL_SHAPES.media_probe.ocr, undefined);
  assert.equal(TOOL_SHAPES.media_zoom.ocr, undefined);

  // zod enum：auto / force 之外的值不合法。
  assert.equal(TOOL_SHAPES.media_overview.ocr.safeParse('auto').success, true);
  assert.equal(TOOL_SHAPES.media_overview.ocr.safeParse('force').success, true);
  assert.equal(TOOL_SHAPES.media_overview.ocr.safeParse('yes').success, false);

  const overviewDoc = TOOL_SHAPES.media_overview.ocr.description;
  assert.match(overviewDoc, /document/i);
  assert.match(overviewDoc, /force/);
  assert.match(overviewDoc, /重新 OCR/);
  assert.match(LOCATE_DESCRIPTION, /ocr: "force"/);
  assert.match(OVERVIEW_DESCRIPTION, /ocr: "force"/);
  assert.match(OVERVIEW_DESCRIPTION, /重新 OCR/);
  assert.match(LOCATE_DESCRIPTION, /重新 OCR/);
});

test('适用性：video / audio 传 ocr → INVALID_ARGUMENT，document 放行', () => {
  for (const mediaType of ['video', 'audio']) {
    assert.throws(
      () => checkApplicability({ ocr: 'force' }, mediaType),
      (error) => {
        assert.equal(error instanceof ToolError, true);
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.match(error.message, new RegExp(`ocr is not applicable to ${mediaType} media`));
        assert.match(error.message, /Only documents have a page text layer/);
        return true;
      },
    );
  }
  assert.doesNotThrow(() => checkApplicability({ ocr: 'force' }, 'document'));
  // 不传 ocr 时不做任何检查（默认值不触发适用性规则）。
  assert.doesNotThrow(() => checkApplicability({ pages: '1-2' }, 'document'));
});

/* ------------------------------------------------------------------ *
 * 计数 OCR provider / fake PDF support
 * ------------------------------------------------------------------ */

function pageList(spec) {
  if (!spec) return [];
  if (spec.list) return [...spec.list];
  if (spec.from) return Array.from({ length: spec.to - spec.from + 1 }, (_, i) => spec.from + i);
  return [];
}

function stubOcrProvider({ id = 'mineru', textForPage = (page) => `OCR TEXT FOR PAGE ${page}` } = {}) {
  const calls = [];
  const provider = {
    id,
    roles: ['ocr'],
    describe: () => ({ id, model: 'stub-v1', baseUrl: null }),
    async parse(input) {
      calls.push(input);
      return {
        provider: id,
        model: 'stub-v1',
        pages: pageList(input.pages).map((page) => {
          const text = textForPage(page);
          return { page, textOrigin: 'ocr', blocks: [{ type: 'paragraph', text }], text };
        }),
      };
    },
  };
  return { provider, calls };
}

function fakePdfSupport({ pageCount = 4, textPages = [], sampleText = 'NORMAL SAMPLE TEXT LAYER' } = {}) {
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
        sampleText: textPages.length > 0 ? sampleText : '',
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

/**
 * 每个用例独立的临时目录：源 PDF + 缓存根目录（MMGREP_CACHE_DIR）。
 */
async function withDocCache(fn, { textPages = [1, 2], pageCount = 4 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-ocr-force-'));
  const pdf = path.join(dir, 'doc.pdf');
  const txt = path.join(dir, 'doc.txt');
  await writeFile(pdf, PDF_BYTES);
  await writeFile(txt, 'plain text document\n');
  const cacheDir = path.join(dir, 'cache');
  const previousCache = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = cacheDir;
  const cache = createCache({ dir: cacheDir, fsync: false });
  try {
    return await fn({ dir, pdf, txt, cache, cacheDir, textPages, pageCount });
  } finally {
    if (previousCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
}

function forceBackend({ pdfSupport, ocrProvider = null, typesetProvider = null, cache, pageCount = 4 }) {
  return createDocumentBackend({
    config: {
      ocr: ocrProvider
        ? { provider: ocrProvider.id, apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9/api/v4' }
        : { provider: 'none' },
      typeset: typesetProvider
        ? { provider: typesetProvider.id, skipSimple: false }
        : { provider: 'none' },
    },
    ocrProvider,
    typesetProvider,
    pdfSupport,
    cache,
  });
}

/** 递归找 provider 缓存 namespace.json。 */
async function listNamespaceMetas(dir) {
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
    if (entry.isDirectory()) out.push(...(await listNamespaceMetas(full)));
    else if (entry.name === 'namespace.json') {
      out.push(JSON.parse(await readFile(full, 'utf8')));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * (a) force：有文字层的页也发给 OCR；(d) force 缓存独立
 * ------------------------------------------------------------------ */

test('force：文字层页也发 OCR、页标签 (ocr)，且与 auto 各用各的缓存', async () => {
  await withDocCache(async ({ pdf, cache, cacheDir }) => {
    const ocr = stubOcrProvider();
    const backend = forceBackend({
      pdfSupport: fakePdfSupport({ pageCount: 4, textPages: [1, 2] }),
      ocrProvider: ocr.provider,
      cache,
    });

    // --- auto（默认）：页 1-2 用文字层，只有 3-4 发给 OCR ---
    const auto = await backend.overview({ path: pdf, pages: [1, 2, 3, 4], images: 0 });
    assert.equal(ocr.calls.length, 1, 'auto sends only the pages without a text layer');
    assert.equal(ocr.calls[0].role, 'ocr');
    assert.equal(ocr.calls[0].ocrMode, 'auto');
    assert.deepEqual(ocr.calls[0].pages, { from: 3, to: 4 });
    const autoByPage = new Map(auto.segments.map((segment) => [segment.page, segment]));
    for (const page of [1, 2]) {
      assert.equal(autoByPage.get(page).source, 'text');
      assert.equal(autoByPage.get(page).textOrigin, 'textlayer');
      assert.equal(autoByPage.get(page).text, `page ${page} text layer`);
    }
    for (const page of [3, 4]) {
      assert.equal(autoByPage.get(page).source, 'ocr');
      assert.equal(autoByPage.get(page).textOrigin, 'ocr');
      assert.equal(autoByPage.get(page).text, `OCR TEXT FOR PAGE ${page}`);
    }
    assert.equal(auto.transcript.source, 'mixed');
    assert.equal(auto.transcript.ocrProvider, 'mineru');
    assert.equal(auto.transcript.typesetProvider, undefined);

    // --- force：所有请求页都发 OCR，即使 1-2 本来有文字层 ---
    const forced = await backend.overview({
      path: pdf, pages: [1, 2, 3, 4], images: 0, ocrMode: 'force',
    });
    assert.equal(ocr.calls.length, 2, 'force must not reuse the auto namespace');
    assert.equal(ocr.calls[1].role, 'ocr');
    assert.equal(ocr.calls[1].ocrMode, 'force', 'the backend must pass ocrMode=force to the provider');
    assert.deepEqual(ocr.calls[1].pages, { from: 1, to: 4 }, 'text-layer pages are re-recognized too');
    for (const segment of forced.segments) {
      assert.equal(segment.source, 'ocr', `page ${segment.page} must be tagged ocr`);
      assert.equal(segment.origin, 'ocr');
      assert.equal(segment.textOrigin, 'ocr');
      assert.equal(segment.text, `OCR TEXT FOR PAGE ${segment.page}`);
    }
    assert.equal(forced.transcript.source, 'ocr');
    assert.equal(forced.transcript.ocrProvider, 'mineru');

    // 缓存 namespace：auto / force 各一份，互不覆盖。
    const metas = await listNamespaceMetas(cacheDir);
    const ocrModes = metas
      .filter((meta) => meta.role === 'ocr')
      .map((meta) => meta.ocrMode)
      .sort();
    assert.deepEqual(ocrModes, ['auto', 'force'], 'force results live in their own cache namespace');

    // 第二次 force：全部命中 force 缓存，provider 零请求。
    const forcedAgain = await backend.overview({
      path: pdf, pages: [1, 2, 3, 4], images: 0, ocrMode: 'force',
    });
    assert.equal(ocr.calls.length, 2, 'second force overview must not call the provider');
    assert.deepEqual(
      forcedAgain.segments.map((segment) => segment.text),
      forced.segments.map((segment) => segment.text),
    );

    // auto 再跑一次：命中 auto 缓存，也不会拿 force 的结果冒充文字层。
    const autoAgain = await backend.overview({ path: pdf, pages: [1, 2, 3, 4], images: 0 });
    assert.equal(ocr.calls.length, 2, 'auto must reuse its own cached pages');
    const autoAgainByPage = new Map(autoAgain.segments.map((segment) => [segment.page, segment]));
    assert.equal(autoAgainByPage.get(1).source, 'text');
    assert.equal(autoAgainByPage.get(1).text, 'page 1 text layer');
  });
});

/* ------------------------------------------------------------------ *
 * locate：force 同样生效，并复用 overview 的 force 缓存
 * ------------------------------------------------------------------ */

test('locate：ocr:"force" 走 OCR 结果，并复用 overview 的 force 缓存', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const ocr = stubOcrProvider();
    const backend = forceBackend({
      pdfSupport: fakePdfSupport({ pageCount: 4, textPages: [1, 2] }),
      ocrProvider: ocr.provider,
      cache,
    });

    await backend.overview({ path: pdf, pages: [1, 2, 3, 4], images: 0, ocrMode: 'force' });
    assert.equal(ocr.calls.length, 1);
    assert.equal(ocr.calls[0].ocrMode, 'force');

    const located = await backend.locate({
      path: pdf, query: 'OCR TEXT FOR PAGE 2', pages: [1, 2, 3, 4], ocrMode: 'force',
    });
    assert.equal(ocr.calls.length, 1, 'locate must reuse the force cache from overview');
    const best = located.matches.find((match) => match.page === 2);
    assert.ok(best, 'the re-recognized page must be searchable');
    assert.equal(best.source, 'ocr');
    assert.equal(best.textOrigin, 'ocr');

    // auto 的 locate 不会命中 force 结果：文字层页仍然按文字层搜。
    const autoLocated = await backend.locate({
      path: pdf, query: 'page 1 text layer', pages: [1, 2], max: 2,
    });
    const autoBest = autoLocated.matches.find((match) => match.page === 1);
    assert.equal(autoBest.source, 'text');
  });
});

/* ------------------------------------------------------------------ *
 * (b) force + 未配置 OCR provider → PROVIDER_NOT_CONFIGURED
 * ------------------------------------------------------------------ */

test('force + 未配置 OCR provider：PROVIDER_NOT_CONFIGURED，hint 指向 MMGREP_OCR_PROVIDER / 请求头', async () => {
  await withDocCache(async ({ pdf, cache }) => {
    const backend = forceBackend({
      pdfSupport: fakePdfSupport({ pageCount: 4, textPages: [1, 2] }),
      cache,
    });

    await assert.rejects(
      () => backend.overview({ path: pdf, pages: [1, 2], images: 0, ocrMode: 'force' }),
      (error) => {
        assert.equal(error instanceof ToolError, true);
        assert.equal(error.code, 'PROVIDER_NOT_CONFIGURED');
        assert.match(error.message, /ocr: "force" was requested, but no OCR provider is available/);
        assert.match(error.hint, /MMGREP_OCR_PROVIDER/);
        assert.match(error.hint, /x-mmgrep-ocr-provider/);
        return true;
      },
    );

    // auto 不受影响：仍然返回原生文字层。
    const auto = await backend.overview({ path: pdf, pages: [1, 2], images: 0 });
    assert.equal(auto.segments.every((segment) => segment.source === 'text'), true);

    // 纯文本没有页图可重识别 → INVALID_ARGUMENT（不是静默忽略 force）。
    await assert.rejects(
      () => backend.overview({ path: path.join(path.dirname(pdf), 'doc.txt'), images: 0, ocrMode: 'force' }),
      (error) => {
        assert.equal(error instanceof ToolError, true);
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.match(error.message, /plain-text documents/);
        return true;
      },
    );
  });
});

/* ------------------------------------------------------------------ *
 * 工具层：转发 ocrMode / 错误对模型可见
 * ------------------------------------------------------------------ */

function stubDocumentBackend({ calls, hasTextLayer = true } = {}) {
  return {
    async probe() {
      return {
        mediaType: 'document',
        pageCount: 2,
        hasTextLayer,
        hasAudio: false,
        container: 'pdf',
        subtitleTracks: [],
        audioTracks: [],
        capabilities: {
          ocr: { available: true, provider: 'mineru', reason: null },
          typeset: { available: true, provider: 'builtin', reason: null },
          transcriptSource: 'mixed',
          transcriptOrigin: 'textlayer',
          textLayer: {
            checked: true,
            reason: null,
            sampledPages: [1, 2],
            checkedPages: [1],
            textPage: 1,
          },
        },
      };
    },
    async overview(input) {
      calls?.push({ method: 'overview', input });
      return {
        segments: [{
          page: 1,
          text: 'page one text',
          source: 'ocr',
          origin: 'ocr',
          textOrigin: 'ocr',
        }],
        images: [],
        transcript: {
          source: 'ocr', origin: 'ocr', provider: 'mineru', ocrProvider: 'mineru',
        },
        warnings: [],
      };
    },
    async locate(input) {
      calls?.push({ method: 'locate', input });
      return {
        matches: [{
          rank: 1, page: 1, text: 'page one text', source: 'ocr', origin: 'ocr', textOrigin: 'ocr',
        }],
        totalSegments: 2,
        transcript: { source: 'ocr', origin: 'ocr', provider: 'mineru', ocrProvider: 'mineru' },
        warnings: [],
      };
    },
  };
}

/**
 * 起一个真 MCP server：文档后端由调用方给（stub 或真后端），快照缓存落临时目录。
 */
async function withServer({
  documentBackend,
  ocrProvider = null,
  typesetProvider = null,
  env = {},
} = {}, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-ocr-force-server-'));
  const previousCache = process.env.MMGREP_CACHE_DIR;
  const cacheDir = path.join(dir, 'cache');
  process.env.MMGREP_CACHE_DIR = cacheDir;
  const pdf = path.join(dir, 'doc.pdf');
  const video = path.join(dir, 'movie.mp4');
  const audio = path.join(dir, 'sound.mp3');
  await writeFile(pdf, PDF_BYTES);
  await writeFile(video, Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]));
  await writeFile(audio, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]));
  const config = loadConfig({
    MMGREP_CACHE_DIR: cacheDir,
    MMGREP_OCR_PROVIDER: 'none',
    MMGREP_TYPESET_PROVIDER: 'none',
    ...env,
  });
  const exportDir = path.join(dir, 'export');
  await mkdir(exportDir, { recursive: true });
  const cache = {
    async contentKeyForFile() {
      return { sha256: 'c'.repeat(64), key: `sha256:${'c'.repeat(64)}` };
    },
    async prepareDir() {
      return exportDir;
    },
    async register() {
      return { path: exportDir, type: 'dir', size: 0 };
    },
  };
  const server = createServer({
    config,
    logger: SILENT_LOGGER,
    cache,
    ocrProvider,
    typesetProvider,
    backends: {
      document: documentBackend,
      video: createPlaceholderBackend('video'),
      audio: createPlaceholderBackend('audio'),
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ocr-force-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn({ client, pdf, video, audio, dir });
  } finally {
    await client.close();
    if (previousCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
}

test('工具层：ocr 原样转发为文档后端的 ocrMode（overview / locate），缺省是 auto', async () => {
  const calls = [];
  await withServer({ documentBackend: stubDocumentBackend({ calls }) }, async ({ client, pdf }) => {
    const forcedOverview = await client.callTool({
      name: 'media_overview', arguments: { path: pdf, pages: '1-2', images: 0, ocr: 'force' },
    });
    assert.notEqual(forcedOverview.isError, true);
    assert.equal(calls.at(-1).method, 'overview');
    assert.equal(calls.at(-1).input.ocrMode, 'force');

    const defaultOverview = await client.callTool({
      name: 'media_overview', arguments: { path: pdf, pages: '1-2', images: 0 },
    });
    assert.notEqual(defaultOverview.isError, true);
    assert.equal(calls.at(-1).input.ocrMode, 'auto', 'default must be auto');

    const forcedLocate = await client.callTool({
      name: 'media_locate', arguments: { path: pdf, query: 'page one', pages: '1-2', ocr: 'force' },
    });
    assert.notEqual(forcedLocate.isError, true);
    assert.equal(calls.at(-1).method, 'locate');
    assert.equal(calls.at(-1).input.ocrMode, 'force');

    const defaultLocate = await client.callTool({
      name: 'media_locate', arguments: { path: pdf, query: 'page one', pages: '1-2' },
    });
    assert.notEqual(defaultLocate.isError, true);
    assert.equal(calls.at(-1).input.ocrMode, 'auto');
  });
});

test('工具层：video / audio 传 ocr → INVALID_ARGUMENT（可见的错误结果，不是 schema 静默丢弃）', async () => {
  await withServer({ documentBackend: stubDocumentBackend({}) }, async ({ client, video, audio }) => {
    for (const [file, mediaType] of [[video, 'video'], [audio, 'audio']]) {
      for (const tool of ['media_overview', 'media_locate']) {
        const args = tool === 'media_locate'
          ? { path: file, query: 'x', ocr: 'force' }
          : { path: file, ocr: 'force' };
        const result = await client.callTool({ name: tool, arguments: args });
        assert.equal(result.isError, true, `${tool} + ${mediaType} must fail`);
        assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT');
        assert.match(
          result.structuredContent.error.message,
          new RegExp(`ocr is not applicable to ${mediaType} media`),
        );
      }
    }
  });
});

test('工具层：force + 无 OCR provider → 模型能看到 PROVIDER_NOT_CONFIGURED 与 hint', async () => {
  const pdfSupport = fakePdfSupport({ pageCount: 4, textPages: [1, 2] });
  await withServer({
    documentBackend: createDocumentBackend({
      config: { ocr: { provider: 'none' }, typeset: { provider: 'none' } },
      pdfSupport,
    }),
  }, async ({ client, pdf }) => {
    for (const tool of ['media_overview', 'media_locate']) {
      const args = tool === 'media_locate'
        ? { path: pdf, query: 'page', pages: '1-2', ocr: 'force' }
        : { path: pdf, pages: '1-2', images: 0, ocr: 'force' };
      const result = await client.callTool({ name: tool, arguments: args });
      assert.equal(result.isError, true, `${tool} must fail without an OCR provider`);
      assert.equal(result.structuredContent.error.code, 'PROVIDER_NOT_CONFIGURED');
      assert.match(result.structuredContent.error.message, /no OCR provider is available/);
      assert.match(result.structuredContent.error.hint, /MMGREP_OCR_PROVIDER/);
      assert.match(result.structuredContent.error.hint, /x-mmgrep-ocr-provider/);
      // 错误必须出现在 text content 里：只给 structuredContent 的宿主照样看得到。
      assert.match(result.content[0].text, /PROVIDER_NOT_CONFIGURED/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * (c) probe 可疑文字层：fixture 回归
 * ------------------------------------------------------------------ */

test('probe：乱码文字层 fixture 报 unreliable，正常 fixture / 真实论文不报', {
  skip: !(await exists(GARBLED_PDF)) ? 'fixtures/generated/sample-garbled-text.pdf is missing (run npm run fixtures)' : false,
  timeout: 120000,
}, async () => {
  const backend = createDocumentBackend({ config: {} });

  const garbled = await backend.probe({ path: GARBLED_PDF });
  assert.equal(garbled.hasTextLayer, true, 'the garbled fixture does have a text layer');
  const layer = garbled.capabilities.textLayer;
  assert.equal(layer.checked, true);
  assert.equal(layer.reliable, false);
  assert.equal(layer.textPage, 1);
  assert.ok(layer.reasons.length >= 1, 'at least one heuristic reason must be recorded');
  assert.match(layer.reasons.join(' '), /isolated single letters/);
  assert.match(layer.reasons.join(' '), /no letter or digit/);
  assert.match(
    layer.warning,
    /^looks unreliable \(.+\) — consider media_overview\(\{ path, ocr: "force" \}\)$/,
  );

  // 正常 fixture：同一条启发式不能误报。
  const normal = await backend.probe({ path: TEXT_PDF });
  assert.equal(normal.hasTextLayer, true);
  assert.equal(normal.capabilities.textLayer.reliable, true);
  assert.equal(normal.capabilities.textLayer.warning, null);

  // 真实论文（fixtures/generated/real-nbt-ago2.pdf，可选）：更重要的误报回归。
  if (await exists(REAL_PDF)) {
    const paper = await backend.probe({ path: REAL_PDF });
    assert.equal(paper.capabilities.textLayer.reliable, true, 'a normal paper must not look unreliable');
    assert.equal(paper.capabilities.textLayer.warning, null);
  }
});

test('工具层 probe 文本：unreliable 行带强制重新 OCR 的下一步', {
  skip: !(await exists(GARBLED_PDF)) ? 'fixtures/generated/sample-garbled-text.pdf is missing (run npm run fixtures)' : false,
  timeout: 120000,
}, async () => {
  const backend = createDocumentBackend({ config: {} });
  await withServer({ documentBackend: backend }, async ({ client }) => {
    const garbled = await client.callTool({ name: 'media_probe', arguments: { path: GARBLED_PDF } });
    assert.notEqual(garbled.isError, true);
    const text = garbled.content[0].text;
    assert.match(
      text,
      /^text layer: looks unreliable \(.+\) — consider media_overview\(\{ path, ocr: "force" \}\)$/m,
    );
    assert.equal(garbled.structuredContent.capabilities.textLayer.reliable, false);
    assert.match(garbled.structuredContent.capabilities.textLayer.warning, /ocr: "force"/);

    const normal = await client.callTool({ name: 'media_probe', arguments: { path: TEXT_PDF } });
    assert.notEqual(normal.isError, true);
    assert.doesNotMatch(normal.content[0].text, /looks unreliable/);
    assert.match(normal.content[0].text, /^text layer: yes \(sampled pages .+\)\.$/m);
    assert.equal(normal.structuredContent.capabilities.textLayer.reliable, true);
  });
});

test('工具层：对真实文字层 PDF force + mock OCR provider → 每页 (ocr)，auto 不重识别', {
  skip: !(await exists(TEXT_PDF)) ? 'fixtures/generated/sample-text.pdf is missing (run npm run fixtures)' : false,
  timeout: 120000,
}, async () => {
  const ocr = stubOcrProvider({ textForPage: (page) => `RERECOGNIZED PAGE ${page}` });
  const config = loadConfig({
    MMGREP_OCR_PROVIDER: 'mineru',
    MMGREP_MINERU_API_KEY: 'test-key',
    MMGREP_TYPESET_PROVIDER: 'builtin',
  });
  const backend = createDocumentBackend({
    config,
    ocrProvider: ocr.provider,
    typesetProvider: null,
  });
  await withServer({
    documentBackend: backend,
    ocrProvider: ocr.provider,
    env: { MMGREP_OCR_PROVIDER: 'mineru', MMGREP_MINERU_API_KEY: 'test-key' },
  }, async ({ client }) => {
    const auto = await client.callTool({
      name: 'media_overview', arguments: { path: TEXT_PDF, pages: '1-2', images: 0 },
    });
    assert.notEqual(auto.isError, true);
    assert.equal(ocr.calls.length, 0, 'auto must not OCR pages that already have a text layer');
    assert.match(auto.content[0].text, /\(text\)/);

    const forced = await client.callTool({
      name: 'media_overview', arguments: { path: TEXT_PDF, pages: '1-2', images: 0, ocr: 'force' },
    });
    assert.notEqual(forced.isError, true);
    assert.equal(ocr.calls.length, 1, 'force must send the requested pages to OCR');
    assert.equal(ocr.calls[0].ocrMode, 'force');
    assert.match(forced.content[0].text, /\[page 1\s*\] \(ocr\)\s+「RERECOGNIZED PAGE 1」/);
    assert.match(forced.content[0].text, /\[page 2\s*\] \(ocr\)\s+「RERECOGNIZED PAGE 2」/);
    assert.doesNotMatch(forced.content[0].text, /\(text\)/);
    assert.equal(forced.structuredContent.transcript.source, 'ocr');
    assert.equal(forced.structuredContent.transcript.ocrProvider, 'mineru');
    for (const segment of forced.structuredContent.segments) {
      assert.equal(segment.source, 'ocr');
      assert.equal(segment.textOrigin, 'ocr');
    }
  });
});
