// test/doc/outline.test.js —— 内置目录（9z5.33）：PDF 书签 / 页标签 / 视频章节
//
// 真 fixture + 真后端（pdftotext / qpdf / ffprobe）。测试的是验收标准：
//   - 带书签的 PDF：probe 列出书签、物理页与打印标签；>60 条写 "+N more"；
//   - 带章节的 mp4：probe 列出章节时间戳；
//   - view:auto：短范围给全文；超预算先出目录再出文本预览；
//   - view:outline：无内置目录的文档从 heading 生成目录并标注；
//     视频无章节时给明确的「无章节」说明，且不生成任何目录；
//   - 任何 view 下 text 长度 ≤ maxInlineChars；manifest.json 带完整目录。
//
// 缺 PDF 工具 / qpdf / ffmpeg / fixture 的用例整组跳过（skip 原因写清楚）。
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
import { createVideoBackend } from '../../src/backend/video/index.js';
import { assertFfmpegAvailable } from '../../src/media/ffmpeg.js';
import { createPlaceholderBackend } from '../../src/server/backends.js';
import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = path.join(ROOT, 'fixtures', 'generated');
const GROUND_TRUTH = path.join(ROOT, 'fixtures', 'ground-truth');
const OUTLINE_PDF = path.join(GENERATED, 'sample-outline.pdf');
const HEADINGS_PDF = path.join(GENERATED, 'sample-headings.pdf');
const CHAPTERS_MP4 = path.join(GENERATED, 'sample-chapters.mp4');
const SCENE_MP4 = path.join(GENERATED, 'sample-scene.mp4');
const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasFfmpeg() {
  try {
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
}

const pdfTools = await createPdfSupport().resolveTools();
const ffmpegReady = await hasFfmpeg();
const pdfReady = (await exists(OUTLINE_PDF)) && (await exists(HEADINGS_PDF))
  && pdfTools.info !== null && pdfTools.textExtractor !== null;
const outlineReady = pdfReady && pdfTools.outlineReader === 'qpdf';
const chaptersReady = (await exists(CHAPTERS_MP4)) && (await exists(SCENE_MP4)) && ffmpegReady;
const skipPdf = pdfReady ? false : 'sample-outline.pdf / sample-headings.pdf + a PDF metadata/text extractor are required';
const skipOutline = outlineReady ? false : 'qpdf is required to read PDF bookmarks';
const skipChapters = chaptersReady ? false : 'ffprobe/ffmpeg + sample-chapters.mp4 are required';

const OUTLINE_GT = pdfReady
  ? JSON.parse(await readFile(path.join(GROUND_TRUTH, 'sample-outline-pdf.json'), 'utf8'))
  : null;
const HEADINGS_GT = pdfReady
  ? JSON.parse(await readFile(path.join(GROUND_TRUTH, 'sample-headings-pdf.json'), 'utf8'))
  : null;
const CHAPTERS_GT = chaptersReady
  ? JSON.parse(await readFile(path.join(GROUND_TRUTH, 'sample-chapters.json'), 'utf8'))
  : null;

async function withServer(limit, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-outline-'));
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
    backends: {
      document: createDocumentBackend({ config }),
      video: createVideoBackend({ config }),
      audio: createPlaceholderBackend('audio'),
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'outline-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client, exportDir);
  } finally {
    await client.close();
    if (previousCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
}

const probe = (client, file) => client.callTool({ name: 'media_probe', arguments: { path: file } });
const overview = (client, file, args = {}) => client.callTool({
  name: 'media_overview',
  arguments: { path: file, images: 0, ...args },
});

/* ------------------------------------------------------------------ *
 * 1. PDF 书签：物理页 + 打印标签
 * ------------------------------------------------------------------ */

test('带书签的 PDF：probe 列出书签、物理页与打印页标签', { skip: skipOutline, timeout: 120000 }, async () => {
  await withServer(24000, async (client) => {
    const result = await probe(client, OUTLINE_PDF);
    assert.notEqual(result.isError, true);
    const text = result.content[0].text;
    const data = result.structuredContent;

    assert.equal(data.outline.available, true);
    assert.equal(data.outline.source, 'pdf-bookmarks');
    assert.equal(data.outline.total, OUTLINE_GT.outline.total);
    assert.equal(data.outline.entries.length, OUTLINE_GT.outline.total);

    const introduction = data.outline.entries.find((entry) => entry.title === '1. Introduction');
    assert.deepEqual(introduction, { level: 1, title: '1. Introduction', page: 1, label: 'i' });
    const methods = data.outline.entries.find((entry) => entry.title === '3. Methods');
    assert.equal(methods.page, 5);
    assert.equal(methods.label, '3');
    const deepDive = data.outline.entries.find((entry) => entry.title === '3.5.1 Deep dive');
    assert.equal(deepDive.level, 3);
    assert.equal(deepDive.page, 5);
    assert.equal(deepDive.label, '3');

    assert.match(text, /^outline: 68 PDF bookmarks — use the outline to pick a range$/m);
    assert.match(text, /^- 1\. Introduction  — page 1 \(label "i"\)$/m);
    assert.match(text, /^- 3\. Methods  — page 5 \(label "3"\)$/m);
    assert.match(text, /^How to read: use the outline to pick a range, e\.g\. media_overview\(\{ path, pages: "1-5" \}\)\.$/m);
  });
});

test('书签超过 60 条：probe 只展示 60 条、2 层，其余写 "+N more"', { skip: skipOutline, timeout: 120000 }, async () => {
  await withServer(24000, async (client) => {
    const result = await probe(client, OUTLINE_PDF);
    const text = result.content[0].text;
    const total = result.structuredContent.outline.total;

    assert.ok(total > 60);
    assert.match(text, new RegExp(`^  \\+${total - 60} more \\(full outline in structuredContent\\.outline\\)$`, 'm'));
    // 第 3 层条目不在 probe 文本里，但完整目录在 structuredContent
    assert.doesNotMatch(text, /Deep dive/);
    assert.ok(result.structuredContent.outline.entries.some((entry) => entry.title === '3.5.1 Deep dive'));
  });
});

test('没有书签的 PDF：probe 明说 none（不是静默省略）', { skip: skipPdf, timeout: 120000 }, async () => {
  await withServer(24000, async (client) => {
    const result = await probe(client, HEADINGS_PDF);
    const text = result.content[0].text;
    assert.equal(result.structuredContent.outline.available, false);
    assert.match(text, /^outline: none — this PDF has no bookmarks \(no outline\)\.$/m);
  });
});

/* ------------------------------------------------------------------ *
 * 2. media_overview 的 view 规则
 * ------------------------------------------------------------------ */

test('view:auto 短范围：请求范围放得下就给全文，不插目录', { skip: skipOutline, timeout: 120000 }, async () => {
  await withServer(24000, async (client) => {
    const result = await overview(client, OUTLINE_PDF, { pages: '1' });
    const text = result.content[0].text;
    const data = result.structuredContent;

    assert.equal(data.preview.mode, 'whole');
    assert.match(text, /^note: complete text of page 1 \(nothing omitted\)\.$/m);
    assert.doesNotMatch(text, /^outline: 68 PDF bookmarks/m);
    // 目录仍然在 structuredContent（文件元数据），只是没有占正文预算
    assert.equal(data.outline.total, OUTLINE_GT.outline.total);
    assert.equal(data.preview.outlineInlined, 0);
  });
});

test('view:auto 超预算：带书签的文档先出目录，再给文本预览', { skip: skipOutline, timeout: 180000 }, async () => {
  await withServer(24000, async (client, exportDir) => {
    const result = await overview(client, OUTLINE_PDF, { pages: '1-12' });
    const text = result.content[0].text;
    const data = result.structuredContent;

    assert.ok(text.length <= 24000, `text is ${text.length} chars`);
    assert.match(text, /^outline: 68 PDF bookmarks — full outline in structuredContent\.outline and manifest\.json$/m);
    assert.ok(['skim', 'sampled'].includes(data.preview.mode));
    assert.equal(data.preview.outlineSource, 'pdf-bookmarks');
    assert.ok(data.preview.outlineInlined > 0);
    assert.equal(data.outline.total, OUTLINE_GT.outline.total);
    assert.ok(
      text.indexOf('outline: 68 PDF bookmarks') < text.indexOf('preview: '),
      'the outline must come before the text preview',
    );

    // 完整目录也落进 manifest.json（下游蒸馏器可直接读）
    const manifest = JSON.parse(await readFile(path.join(exportDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.outline.source, 'pdf-bookmarks');
    assert.equal(manifest.outline.total, OUTLINE_GT.outline.total);
    assert.equal(manifest.outline.entries.length, OUTLINE_GT.outline.total);
    assert.deepEqual(
      manifest.outline.entries.find((entry) => entry.title === '1. Introduction'),
      { level: 1, title: '1. Introduction', page: 1, label: 'i' },
    );
  });
});

test('view:text 超预算：忽略目录，仍走 skim/抽样文本管线', { skip: skipOutline, timeout: 180000 }, async () => {
  await withServer(24000, async (client) => {
    const result = await overview(client, OUTLINE_PDF, { pages: '1-12', view: 'text' });
    const text = result.content[0].text;
    const data = result.structuredContent;

    assert.ok(text.length <= 24000, `text is ${text.length} chars`);
    assert.doesNotMatch(text, /^outline: 68 PDF bookmarks/m);
    assert.ok(['skim', 'sampled'].includes(data.preview.mode));
    assert.equal(data.preview.mode, 'skim');
    assert.match(text, /^preview: skim/m);
    assert.equal(data.preview.outlineInlined, 0);
  });
});

test('view:outline 无内置目录、>= 5 个 heading：返回 heading 生成的目录并标注来源', { skip: skipPdf, timeout: 120000 }, async () => {
  await withServer(24000, async (client, exportDir) => {
    const result = await overview(client, HEADINGS_PDF, { view: 'outline' });
    const text = result.content[0].text;
    const data = result.structuredContent;

    assert.equal(data.outline.available, true);
    assert.equal(data.outline.source, 'headings');
    assert.equal(data.outline.generated, true);
    assert.equal(data.outline.total, HEADINGS_GT.headings.length);
    assert.match(text, new RegExp(`^outline: generated from headings — ${HEADINGS_GT.headings.length} entries `, 'm'));
    assert.match(text, /^\s+- 1\.1 Scope  — page 1$/m);
    assert.match(text, /^- 3\. Results  — page 3$/m);
    assert.equal(data.preview.mode, 'outline');
    assert.equal(data.preview.outlineSource, 'headings');
    assert.equal(data.preview.outlineInlined, HEADINGS_GT.headings.length);
    assert.equal(data.segments.length, 0, 'view:outline must not inline text segments');
    assert.doesNotMatch(text, /^preview: (skim|sampled)/m);
    assert.match(text, /note: view="outline" — only the outline is inlined/);

    const manifest = JSON.parse(await readFile(path.join(exportDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.outline.source, 'headings');
    assert.equal(manifest.outline.generated, true);
    assert.equal(manifest.outline.total, HEADINGS_GT.headings.length);
  });
});

test('view:outline 的文本长度在所有 token 预算下都不超过 maxInlineChars', { skip: skipOutline, timeout: 180000 }, async () => {
  for (const limit of [400, 900, 2000, 6000]) {
    await withServer(limit, async (client) => {
      for (const view of ['auto', 'outline', 'text']) {
        const result = await overview(client, OUTLINE_PDF, { pages: '1-12', view });
        assert.notEqual(result.isError, true, `limit ${limit} view ${view}`);
        const text = result.content[0].text;
        assert.ok(text.length <= limit, `limit ${limit} view ${view}: text is ${text.length} chars`);
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * 3. 视频章节
 * ------------------------------------------------------------------ */

test('带章节的 mp4：probe 列出章节标题与时间戳', { skip: skipChapters, timeout: 120000 }, async () => {
  await withServer(24000, async (client) => {
    const result = await probe(client, CHAPTERS_MP4);
    assert.notEqual(result.isError, true);
    const text = result.content[0].text;
    const data = result.structuredContent;

    assert.equal(data.outline.available, true);
    assert.equal(data.outline.source, 'chapters');
    assert.equal(data.outline.total, CHAPTERS_GT.chapters.length);
    assert.deepEqual(
      data.outline.entries.map((entry) => ({ title: entry.title, startMs: entry.startMs, endMs: entry.endMs })),
      CHAPTERS_GT.chapters,
    );
    assert.match(text, /^outline: 4 chapters — use the outline to pick a range$/m);
    for (const chapter of CHAPTERS_GT.chapters) {
      assert.match(text, new RegExp(`^- ${chapter.title}  \\d{2}:\\d{2}\\.\\d{3}-\\d{2}:\\d{2}\\.\\d{3}$`, 'm'));
    }
    assert.match(text, /^How to read: use the outline to pick a range, e\.g\. media_overview\(\{ path, start: 0, end: 2 \}\)\.$/m);
  });
});

test('视频无章节 + view:outline：明确说「无章节」，不生成任何目录内容', { skip: skipChapters, timeout: 120000 }, async () => {
  await withServer(24000, async (client) => {
    const result = await overview(client, SCENE_MP4, { view: 'outline' });
    const text = result.content[0].text;
    const data = result.structuredContent;

    assert.equal(data.outline.available, false);
    assert.equal(data.outline.entries.length, 0);
    assert.equal(data.outline.total, 0);
    assert.equal(data.preview.mode, 'outline');
    assert.equal(data.preview.outlineInlined, 0);
    assert.equal(data.preview.outlineTotal, 0);
    assert.equal(data.segments.length, 0);
    assert.match(text, /^outline: none — no chapters: this file has no chapters/m);
    assert.match(text, /does not call an LLM/);
    assert.doesNotMatch(text, /^- .*00:0\d\./m);
  });
});
