// test/doc/source-mapping.test.js —— 文档的逐页来源映射（ticket 9z5.21）
//
// 背景：文档的转录来源曾被硬编码成 ocr。对任何带文字层的 PDF，probe 会同时说
// 「ocr: unavailable」和「transcript source: ocr」，overview 每页也标 (ocr)，
// 而实际文字来自 pdftotext 抽的 PDF 原生文字层（字符精确、可直接引用）。
//
// 这个文件锁住 9z5.21 的五条验收：
//   a) MMGREP_OCR_PROVIDER=none + 文字层 PDF：probe 不自相矛盾；overview 每页 (text)，
//      header 没有 text= 且给出 typesetProvider；
//   b) 图片封面 + 数字正文：封面无文本（或 ocr），正文 (text)，header source="mixed"；
//   c) 扫描件 + 无 OCR provider：source none，不谎报有文本；
//   d) 文档 overview 不再无条件出现 "OCR of the rendered pages"；
//   e) 导出的 segments.jsonl / document.json 里 source 与页文字一致。
//
// 全程走真实 PDF 文字层（pdftotext）；缺 PDF 工具时整组跳过。

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createDocumentBackend } from '../../src/backend/document/index.js';
import { createPdfSupport } from '../../src/backend/document/pdf.js';
import { createDocProvider } from '../../src/providers/doc/index.js';
import { createPlaceholderBackend } from '../../src/server/backends.js';
import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = path.join(ROOT, 'fixtures', 'generated');
const TEXT_PDF = path.join(GENERATED, 'sample-text.pdf');
const MIXED_PDF = path.join(GENERATED, 'sample-mixed.pdf');
const SCANNED_PDF = path.join(GENERATED, 'sample-scanned.pdf');

const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });

async function fixturesReady() {
  try {
    await Promise.all([TEXT_PDF, MIXED_PDF, SCANNED_PDF].map((file) => access(file)));
    return true;
  } catch {
    return false;
  }
}

const pdfTools = await createPdfSupport().resolveTools();
const skip = !(await fixturesReady()) || pdfTools.info === null || pdfTools.textExtractor === null
  ? 'sample PDF fixtures + PDF metadata/text extraction tools (poppler-utils / mupdf-tools) are required'
  : false;

const PDF_BYTES = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

/** 计数用的 OCR provider stub：只回答被路由到 OCR 的页。 */
function stubOcrProvider({ id = 'mineru', textForPage = (page) => `OCR TEXT FOR PAGE ${page}` } = {}) {
  const calls = [];
  const provider = {
    id,
    roles: ['ocr'],
    describe: () => ({ id, model: 'stub-v1', baseUrl: null }),
    async parse(input) {
      calls.push(input);
      const pages = input.pages?.list
        ?? (input.pages?.from
          ? Array.from({ length: input.pages.to - input.pages.from + 1 }, (_, i) => input.pages.from + i)
          : []);
      return {
        provider: id,
        model: 'stub-v1',
        pages: pages.map((page) => {
          const text = textForPage(page);
          return { page, textOrigin: 'ocr', blocks: [{ type: 'paragraph', text }], text };
        }),
      };
    },
  };
  return { provider, calls };
}

/**
 * 起一个真 server：文档后端是真的（真实 PDF 文字层），provider 按配置注入，
 * 缓存落盘与工作目录都在临时目录里。
 */
async function withServer({
  env = {},
  ocrProvider = undefined,
  typesetProvider = undefined,
  documentBackend = null,
} = {}, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-source-'));
  const previousCache = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  const config = loadConfig({
    MMGREP_CACHE_DIR: path.join(dir, 'cache'),
    MMGREP_OCR_PROVIDER: 'none',
    MMGREP_TYPESET_PROVIDER: 'builtin',
    ...env,
  });
  const exportDir = path.join(dir, 'export');
  await mkdir(exportDir, { recursive: true });
  const cache = {
    async contentKeyForFile() {
      return { sha256: 'a'.repeat(64), key: `sha256:${'a'.repeat(64)}` };
    },
    async prepareDir() {
      return exportDir;
    },
    async register() {
      return { path: exportDir, type: 'dir', size: 0 };
    },
  };
  const backend = documentBackend ?? createDocumentBackend({ config });
  const server = createServer({
    config,
    logger: SILENT_LOGGER,
    cache,
    ocrProvider: ocrProvider !== undefined
      ? ocrProvider
      : createDocProvider('ocr', {}, { provider: config.ocr.provider }),
    typesetProvider: typesetProvider !== undefined
      ? typesetProvider
      : createDocProvider('typeset', {}, { provider: config.typeset.provider }),
    backends: {
      document: backend,
      video: createPlaceholderBackend('video'),
      audio: createPlaceholderBackend('audio'),
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'source-mapping-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn({ client, backend, config, dir });
  } finally {
    await client.close();
    if (previousCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
}

const call = (client, name, args) => client.callTool({ name, arguments: args });

/** 第一行 header；测试里反复要断言「header 里没有 text=」。 */
function headerOf(text) {
  return text.split('\n')[0];
}

test('文字层 PDF + OCR=none：probe 不再自相矛盾，overview 每页 (text)', { skip, timeout: 120000 }, async () => {
  await withServer({}, async ({ client }) => {
    const probe = await call(client, 'media_probe', { path: TEXT_PDF });
    assert.notEqual(probe.isError, true);
    const probeText = probe.content[0].text;
    // 旧的矛盾两行必须消失
    assert.doesNotMatch(probeText, /^ocr: (unavailable|available)/m);
    assert.doesNotMatch(probeText, /transcript source: ocr/);
    assert.match(probeText, /\btextLayer="yes"/);
    assert.match(probeText, /^text layer: yes \(sampled pages \d+; first text on page \d+\)\.$/m);
    assert.match(probeText, /^ocr provider: none — /m);
    assert.match(probeText, /^typeset provider: builtin\.$/m);
    assert.match(probeText, /^transcript source: text$/m);
    assert.equal(probe.structuredContent.capabilities.transcriptSource, 'text');
    assert.equal(probe.structuredContent.capabilities.transcriptOrigin, 'textlayer');

    const overview = await call(client, 'media_overview', {
      path: TEXT_PDF, pages: '1-2', images: 0,
    });
    assert.notEqual(overview.isError, true);
    const text = overview.content[0].text;
    const header = headerOf(text);
    assert.match(header, /^<overview /);
    assert.match(header, /source="text"/);
    assert.match(header, /typesetProvider="builtin"/);
    assert.doesNotMatch(header, /\btext="/, 'overview header must not carry the old text="<provider>" attribute');
    assert.match(text, /^\[page 1\s*\] \(text\)\s+「/m);
    assert.match(text, /^\[page 2\s*\] \(text\)\s+「/m);
    assert.doesNotMatch(text, /\(ocr\)/);

    const data = overview.structuredContent;
    assert.equal(data.transcript.source, 'text');
    assert.equal(data.transcript.origin, 'textlayer');
    assert.equal(data.transcript.typesetProvider, 'builtin');
    for (const segment of data.segments) {
      assert.equal(segment.source, 'text');
      assert.equal(segment.origin, 'textlayer');
      assert.equal(segment.textOrigin, 'textlayer');
    }
    // (d) 没有 OCR 页 → 不得出现 OCR 提示
    assert.doesNotMatch(text, /OCR of the rendered pages/);
    assert.doesNotMatch(text, /some page text comes from OCR/);
    assert.match(text, /native text layer/);
  });
});

test('图片封面 + 数字正文：封面 (ocr)、正文 (text)，header source="mixed"', { skip, timeout: 120000 }, async () => {
  const ocr = stubOcrProvider({ id: 'mineru', textForPage: () => 'OCR COVER PAGE TEXT' });
  await withServer({
    env: { MMGREP_OCR_PROVIDER: 'mineru', MMGREP_MINERU_API_KEY: 'test-key' },
    ocrProvider: ocr.provider,
  }, async ({ client }) => {
    // probe：文字层 + OCR 都可用 → 逐页路由可能混合，如实报 mixed。
    const probe = await call(client, 'media_probe', { path: MIXED_PDF });
    assert.match(probe.content[0].text, /^text layer: yes /m);
    assert.match(probe.content[0].text, /^ocr provider: mineru\.$/m);
    assert.match(probe.content[0].text, /^transcript source: mixed$/m);
    assert.equal(probe.structuredContent.capabilities.transcriptSource, 'mixed');

    const overview = await call(client, 'media_overview', {
      path: MIXED_PDF, pages: '1-4', images: 0,
    });
    assert.notEqual(overview.isError, true);
    const text = overview.content[0].text;
    const header = headerOf(text);
    assert.match(header, /source="mixed"/);
    assert.doesNotMatch(header, /\btext="/);
    assert.match(header, /ocrProvider="mineru"/);
    assert.match(header, /typesetProvider="builtin"/);
    assert.match(text, /^\[page 1\s*\] \(ocr\)\s+「OCR COVER PAGE TEXT」/m);
    assert.match(text, /^\[page 2\s*\] \(text\)\s+「/m);

    // (d) 真的有 OCR 页时才提示核对名称数字，并保留 media_zoom 交叉核对提示。
    assert.match(text, /some page text comes from OCR/);
    assert.match(text, /media_zoom\(\{ path, page \}\)/);

    const data = overview.structuredContent;
    assert.equal(data.transcript.source, 'mixed');
    assert.equal(data.transcript.typesetProvider, 'builtin');
    assert.equal(data.transcript.ocrProvider, 'mineru');

    // 逐页：第 1 页 ocr，正文 text（structuredContent.segments 是实际内联的单元）。
    const byPage = new Map();
    for (const segment of data.segments) {
      if (!byPage.has(segment.page)) byPage.set(segment.page, segment);
    }
    assert.equal(byPage.get(1).source, 'ocr');
    assert.equal(byPage.get(1).origin, 'ocr');
    assert.equal(byPage.get(1).textOrigin, 'ocr');
    for (const page of [2, 3, 4]) {
      assert.equal(byPage.get(page).source, 'text');
      assert.equal(byPage.get(page).origin, 'textlayer');
      assert.equal(byPage.get(page).textOrigin, 'textlayer');
    }
    assert.equal(ocr.calls.length, 1, 'only the cover page is routed to OCR');
    assert.deepEqual(ocr.calls[0].pages, { from: 1, to: 1 });
  });
});

test('扫描件 + 无 OCR provider：source none，不谎报有文本', { skip, timeout: 120000 }, async () => {
  await withServer({}, async ({ client, backend }) => {
    const probe = await call(client, 'media_probe', { path: SCANNED_PDF });
    const probeText = probe.content[0].text;
    assert.match(probeText, /\btextLayer="no"/);
    assert.match(probeText, /^text layer: no \(checked pages 1, 2, 3\)\.$/m);
    assert.match(probeText, /^ocr provider: none — /m);
    assert.match(probeText, /^transcript source: none$/m);
    assert.doesNotMatch(probeText, /transcript source: ocr/);

    const overview = await call(client, 'media_overview', {
      path: SCANNED_PDF, pages: '1-2', images: 0,
    });
    const text = overview.content[0].text;
    assert.match(headerOf(text), /source="none"/);
    assert.doesNotMatch(text, /\(text\)/);
    assert.doesNotMatch(text, /\(ocr\)/);
    assert.doesNotMatch(text, /native text layer/);
    assert.equal(overview.structuredContent.transcript.source, 'none');

    // 逐页：空文本 → source/origin none（不是 ocr）。
    const result = await backend.overview({ path: SCANNED_PDF, pages: [1, 2], images: 0 });
    assert.equal(result.segments.length, 2);
    for (const segment of result.segments) {
      assert.equal(segment.text, '');
      assert.equal(segment.source, 'none');
      assert.equal(segment.origin, 'none');
    }
    assert.equal(result.transcript.source, 'none');
    assert.equal(result.transcript.origin, 'none');
  });
});

test('probe：判不出文字层时渲染 unknown，不渲染成 no', { skip, timeout: 120000 }, async () => {
  const stub = {
    async probe() {
      return {
        mediaType: 'document',
        pageCount: 3,
        hasTextLayer: null,
        hasAudio: false,
        container: 'pdf',
        subtitleTracks: [],
        audioTracks: [],
        capabilities: {
          textLayer: {
            checked: false,
            reason: 'no PDF text extractor is installed (pdftotext / mutool).',
            sampledPages: [1, 2, 3],
            checkedPages: [],
            textPage: null,
          },
        },
      };
    },
  };
  await withServer({ documentBackend: stub }, async ({ client }) => {
    const probe = await call(client, 'media_probe', { path: TEXT_PDF });
    assert.notEqual(probe.isError, true);
    const text = probe.content[0].text;
    assert.match(text, /\btextLayer="unknown"/);
    assert.match(text, /^text layer: unknown — no PDF text extractor is installed \(pdftotext \/ mutool\)\.$/m);
    assert.match(text, /^transcript source: none$/m);
  });
});

test('export：segments.jsonl / document.json 的 source 与页文字一致', { skip, timeout: 120000 }, async () => {
  await withServer({}, async ({ client }) => {
    const overview = await call(client, 'media_overview', {
      path: TEXT_PDF, pages: '1-2', images: 0,
    });
    assert.notEqual(overview.isError, true);
    const data = overview.structuredContent;
    assert.ok(data.fullText?.segmentsJsonl, 'full text export must be written');

    const lines = (await readFile(data.fullText.segmentsJsonl, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const segment = JSON.parse(line);
      assert.equal(segment.source, 'text');
      assert.equal(segment.origin, 'textlayer');
      assert.ok([1, 2].includes(segment.page));
      assert.ok(segment.text.length > 0);
    }

    const documentJson = JSON.parse(await readFile(
      path.join(path.dirname(data.fullText.segmentsJsonl), 'document.json'),
      'utf8',
    ));
    assert.equal(documentJson.media_type, 'pdf');
    assert.equal(documentJson.elements.length, 2);
    for (const element of documentJson.elements) {
      assert.equal(element.source, 'text');
      assert.ok([1, 2].includes(element.page));
      assert.equal(element.type, 'paragraph');
    }

    const manifest = JSON.parse(await readFile(data.fullText.manifestJson, 'utf8'));
    assert.equal(manifest.transcript.source, 'text');

    const contentMd = await readFile(data.fullText.contentMd, 'utf8');
    assert.match(contentMd, /^- transcript: text \(builtin\)$/m);
    assert.match(contentMd, /^## Page 1$/m);
    assert.match(contentMd, /PAGE TWO HEADING/);
  });
});

test('locate：文档 matches 暴露逐页 source / textOrigin，文本行标 (text)', { skip, timeout: 120000 }, async () => {
  await withServer({}, async ({ client }) => {
    const result = await call(client, 'media_locate', { path: TEXT_PDF, query: 'PAGE TWO' });
    assert.notEqual(result.isError, true);
    const data = result.structuredContent;
    assert.equal(data.transcriptSource, 'text');
    assert.equal(data.transcriptOrigin, 'textlayer');
    assert.ok(data.matches.length >= 1);
    for (const match of data.matches) {
      assert.equal(match.source, 'text');
      assert.equal(match.origin, 'textlayer');
      assert.equal(match.textOrigin, 'textlayer');
    }
    assert.match(result.content[0].text, /\(text\) {2}「/);
  });
});

test('locate：扫描件无 provider → NO_TRANSCRIPT（不谎报可搜文本）', { skip, timeout: 120000 }, async () => {
  await withServer({}, async ({ client }) => {
    const result = await call(client, 'media_locate', { path: SCANNED_PDF, query: 'SCANNED PAGE ONE' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'NO_TRANSCRIPT');
    assert.match(result.structuredContent.error.message, /no text layer and no OCR provider is configured/);
  });
});

test('export：空扫描件的 segments.jsonl 为空而不是伪造 ocr 段落', { skip, timeout: 120000 }, async () => {
  // 用一个小 PDF 字面量即可：后端不会真的解析它（stub 后端返回空页）。
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-source-empty-'));
  try {
    const pdf = path.join(dir, 'scan.pdf');
    await writeFile(pdf, PDF_BYTES);
    const backend = {
      async probe() {
        return {
          mediaType: 'document', pageCount: 1, hasTextLayer: false,
          hasAudio: false, container: 'pdf', subtitleTracks: [], audioTracks: [],
        };
      },
      async overview() {
        return {
          segments: [{
            page: 1, text: '', startMs: null, endMs: null, source: 'none', origin: 'none', textOrigin: 'unknown',
          }],
          images: [],
          transcript: { source: 'none', origin: 'none', reason: 'no text layer and no OCR provider is configured.' },
          warnings: [],
        };
      },
    };
    await withServer({ documentBackend: backend }, async ({ client }) => {
      const overview = await call(client, 'media_overview', { path: pdf, images: 0 });
      assert.equal(overview.structuredContent.transcript.source, 'none');
      const segmentsPath = overview.structuredContent.fullText.segmentsJsonl;
      const lines = (await readFile(segmentsPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 1);
      const segment = JSON.parse(lines[0]);
      assert.equal(segment.source, 'none');
      assert.equal(segment.origin, 'none');
      const documentJson = JSON.parse(await readFile(
        path.join(path.dirname(segmentsPath), 'document.json'),
        'utf8',
      ));
      assert.equal(documentJson.elements[0].source, 'none');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
