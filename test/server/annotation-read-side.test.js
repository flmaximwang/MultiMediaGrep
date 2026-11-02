// test/server/annotation-read-side.test.js —— 读取侧的批注（ticket 9z5.38.4）
//
// media_probe / media_overview / media_locate 必须展示文件的批注：
//   - probe：报**条数**与 sidecar 路径（不倒每一条 note）
//   - overview：把**请求范围**里的批注挂在该范围旁边（`n3 (p.12): note` /
//     `n3 (00:12:34–00:12:39): note`，与 media_annotate 的结果同形）
//   - locate：也搜批注的 note 文本，命中标 kind:"annotation" + id，单独成段，
//     并且**不计入**媒体内容的命中数
//
// 来源优先级：sidecar → 文件自带的批注（PDF 的 probe.annotationOutline）。
// 没有 sidecar 时派生的 id 必须与 media_annotate 首次导入完全一致（复用 derive.js）。
// 损坏的 sidecar 不阻断读取：回退到文件自带的批注并说明原因。
//
// 三个读取工具**绝不**在源文件旁边创建任何文件（本文件里有断言）。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  deriveAnnotationsFromOutline,
  serializeAnnotationSidecar,
} from '../../src/media/annotation/index.js';
import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';

/* ------------------------------------------------------------------ *
 * 测试夹具
 * ------------------------------------------------------------------ */

const PDF = Buffer.from('%PDF-1.7\n% annotation read side test\n');
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-annotation-read-'));
  const files = {
    pdf: path.join(dir, 'report.pdf'),
    video: path.join(dir, 'talk.mp4'),
  };
  await writeFile(files.pdf, PDF);
  await writeFile(files.video, MP4);
  return {
    dir,
    files,
    config: loadConfig({
      MMGREP_CACHE_DIR: path.join(dir, 'cache'),
      MMGREP_MAX_IMAGE_TOKENS: '4000',
      MMGREP_MAX_TEXT_INLINE_CHARS: '24000',
    }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** document 后端 stub：probe 给 PDF 自带批注，locate 给整页命中，overview 给页文本 */
function documentBackend({
  container = 'pdf',
  pageCount = 8,
  annotationEntries = [],
  pageTexts = {},
  withAnnotationOutline = true,
} = {}) {
  const textOf = (page) => pageTexts[page] ?? `Page ${page} explains the revenue numbers in detail.`;
  return {
    async probe() {
      const probeResult = {
        mediaType: 'document',
        pageCount,
        container,
        hasTextLayer: container === 'pdf',
        hasAudio: false,
        subtitleTracks: [],
        audioTracks: [],
        durationSec: null,
        outline: {
          available: false,
          source: null,
          total: 0,
          entries: [],
          reason: 'this PDF has no bookmarks (no outline).',
        },
      };
      if (withAnnotationOutline) {
        // 9z5.38.2 接的数据源：文件自带的批注。entries 的形状是 {type?, note, author?, page?, rect?}。
        probeResult.annotationOutline = {
          available: container === 'pdf' && annotationEntries.length > 0,
          source: container === 'pdf' ? 'pdf-annotations' : null,
          total: annotationEntries.length,
          entries: annotationEntries,
          reason: container === 'pdf' ? null : 'not a PDF',
        };
      }
      return probeResult;
    },
    async locate(input) {
      const pages = Array.isArray(input.pages) && input.pages.length > 0
        ? input.pages
        : Array.from({ length: pageCount }, (_, i) => i + 1);
      const matches = pages.map((page) => ({
        page,
        text: textOf(page),
        source: 'text',
        origin: 'textlayer',
        textOrigin: 'textlayer',
      }));
      return {
        matches,
        totalSegments: pageCount,
        transcript: { source: 'text', origin: 'textlayer' },
        frame: null,
        warnings: [],
      };
    },
    async overview(input) {
      const requested = Array.isArray(input.pages) && input.pages.length > 0 ? input.pages : [1];
      return {
        segments: requested.map((page) => ({
          page,
          text: textOf(page),
          blocks: [],
          startMs: null,
          endMs: null,
          source: 'text',
          origin: 'textlayer',
          textOrigin: 'textlayer',
        })),
        images: [],
        transcript: { source: 'text', origin: 'textlayer', language: 'en', typesetProvider: 'stub' },
        warnings: [],
      };
    },
  };
}

/** video 后端 stub：probe / locate / overview 都是固定内容 */
function videoBackend({ durationSec = 600, segments = null } = {}) {
  const list = segments ?? Array.from({ length: 200 }, (_, i) => ({
    startMs: i * 3000,
    endMs: (i + 1) * 3000,
    text: `Segment ${i + 1} of the talk mentions the topic again and again.`,
    source: 'subtitle',
    origin: 'file',
  }));
  return {
    async probe() {
      return {
        mediaType: 'video',
        durationMs: durationSec * 1000,
        durationSec,
        width: 1920,
        height: 1080,
        fps: 25,
        container: 'mov,mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        audioChannels: 2,
        sampleRateHz: 44100,
        hasAudio: true,
        subtitleTracks: [],
        audioTracks: [],
        outline: {
          available: false,
          source: null,
          total: 0,
          entries: [],
          reason: 'this file has no chapters (no chapter metadata in the container).',
        },
      };
    },
    async locate(input) {
      const startMs = input.startMs ?? 0;
      const endMs = input.endMs ?? durationSec * 1000;
      const matches = list
        .filter((segment) => segment.endMs > startMs && segment.startMs < endMs)
        .slice(0, input.max ?? 5)
        .map((segment, index) => ({
          rank: index + 1,
          score: 0.85,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          source: segment.source,
          origin: segment.origin,
        }));
      return {
        matches,
        totalSegments: list.length,
        transcript: { source: 'subtitle', origin: 'file' },
        frame: null,
        warnings: [],
      };
    },
    async overview() {
      return {
        segments: list,
        images: [],
        transcript: { source: 'subtitle', origin: 'file', language: 'en', provider: null, model: null },
        warnings: [],
      };
    },
  };
}

async function withClient(workspace, backends, fn, { annotationEmbedders } = {}) {
  const server = createServer({
    config: workspace.config,
    logger: SILENT_LOGGER,
    cache: null,
    backends: {
      document: backends.document ?? documentBackend(),
      video: backends.video ?? videoBackend(),
      audio: backends.audio ?? videoBackend(),
    },
    annotationEmbedders,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'annotation-read-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const probe = (client, file) => client.callTool({ name: 'media_probe', arguments: { path: file } });
const overview = (client, file, args = {}) => client.callTool({
  name: 'media_overview',
  arguments: { path: file, images: 0, ...args },
});
const locate = (client, file, query, args = {}) => client.callTool({
  name: 'media_locate',
  arguments: { path: file, query, ...args },
});

const sidecarFile = (file) => `${file}.mmgrep.annotation.json`;
const listDir = async (dir) => (await readdir(dir)).sort();
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function seedSidecar(filePath, media, entries) {
  const target = sidecarFile(filePath);
  await writeFile(target, serializeAnnotationSidecar(media, entries));
  return target;
}

/** 假 PDF 批注嵌入器：只记录入参，绝不写真实 PDF */
function fakePdfEmbedder() {
  const calls = [];
  return {
    media: 'pdf',
    calls,
    async embed(input) {
      calls.push(input);
      return {
        target: input.filePath,
        checks: [{ name: 'fake-pdf-annotations', ok: true, detail: `${input.entries.length} entries` }],
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * media_probe：条数 + sidecar 路径（不倒 note）
 * ------------------------------------------------------------------ */

test('probe：报批注条数与 sidecar 路径，不倒每一条 note，也不写任何文件', async () => {
  const workspace = await makeWorkspace();
  try {
    const sidecarPath = await seedSidecar(workspace.files.pdf, 'pdf', [
      { id: 'n1', type: 'text', note: 'first sticky note', author: 'alice', page: 1 },
      {
        id: 'n2',
        type: 'square',
        note: 'highlight this box',
        author: 'bob',
        page: 5,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      },
    ]);
    const before = await listDir(workspace.dir);

    await withClient(workspace, { document: documentBackend() }, async (client) => {
      const result = await probe(client, workspace.files.pdf);
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.match(text, /^annotations: 2 \(sidecar\)$/m);
      assert.match(text, new RegExp(`^annotation sidecar: ${escapeRegExp(sidecarPath)}$`, 'm'));
      // probe 不倒 note：条目文本里不该出现任何一条批注的内容
      assert.doesNotMatch(text, /first sticky note/);
      assert.doesNotMatch(text, /highlight this box/);

      assert.equal(data.annotations.available, true);
      assert.equal(data.annotations.source, 'sidecar');
      assert.equal(data.annotations.total, 2);
      assert.equal(data.annotations.sidecarPath, sidecarPath);
      assert.equal(data.annotations.sidecarError, null);
      // probe 的结构化结果只有摘要（没有条目数组）
      assert.equal(data.annotations.entries, undefined);
    });

    assert.deepEqual(await listDir(workspace.dir), before, 'read-only tools must not create a sidecar');
  } finally {
    await workspace.cleanup();
  }
});

test('probe：没有批注时报 0（none），有文件自带批注时报它的条数', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, { document: documentBackend() }, async (client) => {
      const none = await probe(client, workspace.files.pdf);
      assert.match(none.content[0].text, /^annotations: 0 \(none\)$/m);
      assert.equal(none.structuredContent.annotations.total, 0);
      assert.equal(none.structuredContent.annotations.sidecarPath, null);
    });

    await withClient(
      workspace,
      {
        document: documentBackend({
          annotationEntries: [
            { type: 'text', note: 'page five note', author: 'carol', page: 5 },
            { type: 'text', note: 'page one note', author: 'carol', page: 1 },
          ],
        }),
      },
      async (client) => {
        const own = await probe(client, workspace.files.pdf);
        assert.match(own.content[0].text, /^annotations: 2 \(the file's own annotations\)$/m);
        assert.equal(own.structuredContent.annotations.source, 'file');
        assert.equal(own.structuredContent.annotations.total, 2);
        assert.equal(own.structuredContent.annotations.sidecarPath, null);
      },
    );
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * media_overview：批注挂在请求范围旁边
 * ------------------------------------------------------------------ */

test('overview：PDF 批注挂在请求的页范围旁边，行格式与 media_annotate 一致', async () => {
  const workspace = await makeWorkspace();
  try {
    const sidecarPath = await seedSidecar(workspace.files.pdf, 'pdf', [
      { id: 'n1', type: 'text', note: 'first sticky note', author: 'alice', page: 1 },
      { id: 'n2', type: 'text', note: 'fifth sticky note', author: 'alice', page: 5 },
    ]);
    const before = await listDir(workspace.dir);

    await withClient(workspace, { document: documentBackend() }, async (client) => {
      const result = await overview(client, workspace.files.pdf, { pages: '1-3' });
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      const data = result.structuredContent;

      // 范围：请求的页；只有范围内的批注。
      assert.match(text, /^annotations \(1 of 2 in pages 1-3, sidecar\):$/m);
      assert.match(text, /^n1 \(p\.1\): first sticky note$/m);
      assert.doesNotMatch(text, /fifth sticky note/);
      // 作者只在结构化结果里，文本里是纯 note。
      assert.doesNotMatch(text, /alice/);
      assert.equal(data.annotations.totalInRange, 1);
      assert.equal(data.annotations.entries.length, 1);
      assert.equal(data.annotations.entries[0].id, 'n1');
      assert.equal(data.annotations.entries[0].author, 'alice');
      assert.equal(data.annotations.total, 2);
      // sidecar 路径给全文
      assert.match(text, new RegExp(`^full detail: ${escapeRegExp(sidecarPath)}$`, 'm'));
    });

    assert.deepEqual(await listDir(workspace.dir), before, 'read-only tools must not create a sidecar');
  } finally {
    await workspace.cleanup();
  }
});

test('overview：视频批注用时间格式，且只显示时间窗里的批注', async () => {
  const workspace = await makeWorkspace();
  try {
    await seedSidecar(workspace.files.video, 'video', [
      { id: 'n1', note: 'opening remark', author: 'alice', start: 10, end: 15 },
      { id: 'n2', note: 'later remark', author: 'alice', start: 100, end: 110 },
    ]);

    await withClient(workspace, { video: videoBackend() }, async (client) => {
      const result = await overview(client, workspace.files.video, { start: 0, end: 60 });
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.match(text, /^annotations \(1 of 2 in 00:00:00–00:01:00, sidecar\):$/m);
      assert.match(text, /^n1 \(00:00:10–00:00:15\): opening remark$/m);
      assert.doesNotMatch(text, /later remark/);
      assert.equal(data.annotations.totalInRange, 1);
      assert.equal(data.annotations.entries[0].id, 'n1');
    });
  } finally {
    await workspace.cleanup();
  }
});

test('overview：范围内没有批注时明说「none」，不假装有', async () => {
  const workspace = await makeWorkspace();
  try {
    await seedSidecar(workspace.files.pdf, 'pdf', [
      { id: 'n1', type: 'text', note: 'fifth sticky note', author: 'alice', page: 5 },
    ]);

    await withClient(workspace, { document: documentBackend() }, async (client) => {
      const result = await overview(client, workspace.files.pdf, { pages: '1-2' });
      const text = result.content[0].text;
      assert.match(text, /^annotations: none in pages 1-2 \(1 in the file, sidecar\)\.$/m);
      assert.equal(result.structuredContent.annotations.totalInRange, 0);
      assert.equal(result.structuredContent.annotations.entries.length, 0);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * media_locate：也搜批注的 note 文本
 * ------------------------------------------------------------------ */

test('locate：批注里的词能被搜到，命中标 kind/id，并明说它们不是媒体内容', async () => {
  const workspace = await makeWorkspace();
  try {
    await seedSidecar(workspace.files.pdf, 'pdf', [
      { id: 'n1', type: 'text', note: 'ask about the refund policy', author: 'alice', page: 3 },
    ]);

    await withClient(workspace, { document: documentBackend() }, async (client) => {
      const result = await locate(client, workspace.files.pdf, 'refund');
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      const data = result.structuredContent;

      // 媒体内容一个都没命中（页正文里没有 "refund"）。
      assert.match(text, /^no line matched "refund" among 8 page texts\./m);
      assert.equal(data.matches.length, 0);

      // 批注命中单独成段。
      assert.match(text, /^annotation matches for "refund" \(1\):$/m);
      assert.match(text, /^ {2}n1 \(p\.3\): ask about the refund policy$/m);
      assert.match(text, /the lines above are ANNOTATIONS/);
      assert.match(text, /not media content/);

      // 命中带 kind 与 id；不混进媒体命中里。
      assert.equal(data.annotationMatches.length, 1);
      assert.equal(data.annotationMatches[0].kind, 'annotation');
      assert.equal(data.annotationMatches[0].id, 'n1');
      assert.equal(data.annotationMatches[0].page, 3);
      assert.equal(data.annotationMatches[0].author, 'alice');
      assert.equal(data.matches.length, 0);
      assert.equal(data.totalSegments, 8);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('locate：媒体命中与批注命中分开计数，互不污染', async () => {
  const workspace = await makeWorkspace();
  try {
    await seedSidecar(workspace.files.pdf, 'pdf', [
      { id: 'n1', type: 'text', note: 'ask about the refund policy', author: 'alice', page: 3 },
    ]);

    await withClient(workspace, { document: documentBackend() }, async (client) => {
      // 媒体正文里的词：只有媒体命中（文档侧按 max 截断，默认 5 页）。
      const media = await locate(client, workspace.files.pdf, 'revenue');
      const mediaText = media.content[0].text;
      assert.match(mediaText, /^matches for "revenue" \(5 of 8 pages\):$/m);
      assert.equal(media.structuredContent.matches.length, 5);
      assert.equal(media.structuredContent.annotationMatches.length, 0);
      assert.doesNotMatch(mediaText, /annotation matches for/);

      // 批注里的词：只有批注命中，媒体命中数仍是 0。
      const annotation = await locate(client, workspace.files.pdf, 'refund');
      const annotationText = annotation.content[0].text;
      assert.equal(annotation.structuredContent.matches.length, 0);
      assert.equal(annotation.structuredContent.annotationMatches.length, 1);
      assert.doesNotMatch(annotationText, /^matches for "refund"/m);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('locate：视频批注命中带时间位置', async () => {
  const workspace = await makeWorkspace();
  try {
    await seedSidecar(workspace.files.video, 'video', [
      { id: 'n1', note: 'the refund mention', author: 'alice', start: 10, end: 15 },
    ]);

    await withClient(workspace, { video: videoBackend() }, async (client) => {
      const result = await locate(client, workspace.files.video, 'refund');
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.match(text, /^annotation matches for "refund" \(1\):$/m);
      assert.match(text, /^ {2}n1 \(00:00:10–00:00:15\): the refund mention$/m);
      assert.equal(data.annotationMatches[0].kind, 'annotation');
      assert.equal(data.annotationMatches[0].id, 'n1');
      assert.equal(data.annotationMatches[0].startSec, 10);
      assert.equal(data.annotationMatches[0].endSec, 15);
      assert.equal(data.annotationMatches[0].startMs, 10000);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 来源优先级：sidecar → 文件自带的批注
 * ------------------------------------------------------------------ */

test('没有 sidecar：读侧派生的 id 与 media_annotate 首次导入完全一致', async () => {
  const workspace = await makeWorkspace();
  try {
    // 故意乱序：派生必须按「页 → rect.y → rect.x」排。
    const native = [
      { type: 'text', note: 'page five note', author: 'carol', page: 5 },
      { type: 'text', note: 'page one lower', author: 'carol', page: 1, rect: { x: 0.1, y: 0.6, width: 0.2, height: 0.1 } },
      { type: 'text', note: 'page one upper', author: 'carol', page: 1, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
    ];
    const embedder = fakePdfEmbedder();

    await withClient(
      workspace,
      { document: documentBackend({ annotationEntries: native }) },
      async (client) => {
        const read = await overview(client, workspace.files.pdf);
        const derived = read.structuredContent.annotations.entries;
        assert.deepEqual(derived.map((entry) => entry.id), ['n1', 'n2', 'n3']);
        assert.match(read.content[0].text, /^annotations \(3 of 3 in pages 1-8, the file's own annotations\):$/m);
        assert.match(read.content[0].text, /^n1 \(p\.1\): page one upper$/m);
        assert.match(read.content[0].text, /^n3 \(p\.5\): page five note$/m);

        // 与 derive.js 的输出逐字相同（读侧不复制派生逻辑）。
        const expected = deriveAnnotationsFromOutline('pdf', { available: true, entries: native }, { idPrefix: 'n' });
        assert.deepEqual(derived, expected);

        // 首次写入导入的 id 与读取侧派生的完全相同。
        const written = await client.callTool({
          name: 'media_annotate',
          arguments: { path: workspace.files.pdf, add: [{ type: 'text', note: 'brand new', page: 2 }] },
        });
        assert.notEqual(written.isError, true);
        assert.equal(written.structuredContent.created, true);
        assert.equal(written.structuredContent.imported, native.length);
        // 导入的三条与读取侧派生的完全一致（id 与内容）。
        // 注意：写入时最终列表按「页 → rect.y → rect.x → id」排序，新加的 page 2
        // 会排在 page 1 与 page 5 之间，所以列表顺序不是 id 升序。
        const writtenEntries = written.structuredContent.annotations.entries;
        const importedEntries = writtenEntries.filter((entry) => entry.note !== 'brand new');
        assert.deepEqual(importedEntries.map((entry) => entry.id), derived.map((entry) => entry.id));
        assert.deepEqual(importedEntries.map((entry) => entry.note), derived.map((entry) => entry.note));
        assert.equal(writtenEntries.length, native.length + 1);
        // 新加的那条拿到下一个 id（导入后最大 id + 1）。
        assert.equal(writtenEntries.find((entry) => entry.note === 'brand new').id, 'n4');
        assert.equal(embedder.calls.length, 1);
      },
      { annotationEmbedders: { pdf: embedder } },
    );
  } finally {
    await workspace.cleanup();
  }
});

test('sidecar 优先于文件自带的批注', async () => {
  const workspace = await makeWorkspace();
  try {
    await seedSidecar(workspace.files.pdf, 'pdf', [
      { id: 'n1', type: 'text', note: 'from the sidecar', author: 'alice', page: 1 },
    ]);

    await withClient(
      workspace,
      {
        document: documentBackend({
          annotationEntries: [{ type: 'text', note: 'from the file itself', author: 'carol', page: 2 }],
        }),
      },
      async (client) => {
        const result = await overview(client, workspace.files.pdf);
        const text = result.content[0].text;
        assert.match(text, /^annotations \(1 of 1 in pages 1-8, sidecar\):$/m);
        assert.match(text, /^n1 \(p\.1\): from the sidecar$/m);
        assert.doesNotMatch(text, /from the file itself/);
      },
    );
  } finally {
    await workspace.cleanup();
  }
});

test('损坏的 sidecar：回退到文件自带的批注并说明原因，不抛错、不改文件', async () => {
  const workspace = await makeWorkspace();
  try {
    const sidecarPath = sidecarFile(workspace.files.pdf);
    await writeFile(sidecarPath, '{ "version": 1, "media": "pdf", "entries": [\n');
    const before = await listDir(workspace.dir);
    const bytesBefore = await readFile(sidecarPath, 'utf8');

    await withClient(
      workspace,
      {
        document: documentBackend({
          annotationEntries: [{ type: 'text', note: 'from the file itself', author: 'carol', page: 2 }],
        }),
      },
      async (client) => {
        const result = await probe(client, workspace.files.pdf);
        assert.notEqual(result.isError, true, 'a corrupted sidecar must never fail a read-only call');
        const text = result.content[0].text;
        const data = result.structuredContent;

        assert.equal(data.annotations.source, 'file');
        assert.equal(data.annotations.total, 1);
        assert.equal(data.annotations.sidecarPath, sidecarPath);
        assert.match(data.annotations.sidecarError, /could not be read/);
        assert.ok(data.annotations.sidecarError.includes(sidecarPath));
        assert.match(text, /^annotations: 1 \(the file's own annotations\)$/m);
        assert.match(text, /^note: the annotation sidecar .* could not be read.* — showing the file's own annotations instead\.$/m);
        // 读不了的 sidecar 不给 "full detail"（指过去只会误导）。
        assert.doesNotMatch(text, /^annotation sidecar:/m);

        const overviewResult = await overview(client, workspace.files.pdf);
        assert.match(overviewResult.content[0].text, /could not be read/);
        assert.equal(overviewResult.structuredContent.annotations.source, 'file');

        const locateResult = await locate(client, workspace.files.pdf, 'file');
        assert.notEqual(locateResult.isError, true);
        assert.equal(locateResult.structuredContent.annotations.source, 'file');
      },
    );

    assert.deepEqual(await listDir(workspace.dir), before);
    assert.equal(await readFile(sidecarPath, 'utf8'), bytesBefore);
  } finally {
    await workspace.cleanup();
  }
});

test('损坏的 sidecar 且文件没有自带批注：仍能读，明说 sidecar 读不了', async () => {
  const workspace = await makeWorkspace();
  try {
    const sidecarPath = sidecarFile(workspace.files.pdf);
    await writeFile(sidecarPath, 'not json at all');

    await withClient(workspace, { document: documentBackend() }, async (client) => {
      const result = await probe(client, workspace.files.pdf);
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.equal(data.annotations.available, false);
      assert.equal(data.annotations.total, 0);
      assert.match(data.annotations.sidecarError, /could not be read/);
      assert.match(text, /^annotations: 0 \(none\)$/m);
      assert.match(text, /^note: the annotation sidecar .* could not be read.*\.$/m);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 边界情况
 * ------------------------------------------------------------------ */

test('空的 sidecar：说明 sidecar 里没有批注，且不回退到文件自带的批注', async () => {
  const workspace = await makeWorkspace();
  try {
    const sidecarPath = await seedSidecar(workspace.files.pdf, 'pdf', []);

    await withClient(
      workspace,
      {
        document: documentBackend({
          annotationEntries: [{ type: 'text', note: 'from the file itself', author: 'carol', page: 2 }],
        }),
      },
      async (client) => {
        const result = await probe(client, workspace.files.pdf);
        const text = result.content[0].text;
        const data = result.structuredContent;

        assert.equal(data.annotations.total, 0);
        assert.equal(data.annotations.source, 'sidecar');
        assert.match(text, /^annotations: 0 \(none\)$/m);
        assert.match(text, new RegExp(`^annotation sidecar: ${escapeRegExp(sidecarPath)}$`, 'm'));
        assert.match(text, /^note: the annotation sidecar exists but has no entries$/m);
        // 空 sidecar = 用户删光了批注：不回退到文件自带的批注。
        assert.doesNotMatch(text, /from the file itself/);
      },
    );
  } finally {
    await workspace.cleanup();
  }
});

test('9z5.38.2 落地之前：后端还没有 annotationOutline 时，读侧明说「读不到文件自带的批注」', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(
      workspace,
      { document: documentBackend({ withAnnotationOutline: false }) },
      async (client) => {
        const result = await probe(client, workspace.files.pdf);
        assert.notEqual(result.isError, true);
        const text = result.content[0].text;
        const data = result.structuredContent;

        assert.equal(data.annotations.total, 0);
        assert.equal(data.annotations.available, false);
        assert.match(text, /^annotations: 0 \(none\)$/m);
        // 0 ≠ 文件没有批注：必须说清楚「读不到」，而不是假装没有。
        assert.match(text, /^note: this PDF's own annotations cannot be read yet \(no annotation reader in the probe\)$/m);
        assert.match(data.annotations.reason, /cannot be read yet/);

        // overview / locate 同样不炸，只是没有批注可展示。
        const overviewResult = await overview(client, workspace.files.pdf, { pages: '1-2' });
        assert.notEqual(overviewResult.isError, true);
        assert.equal(overviewResult.structuredContent.annotations.total, 0);
        // overview 也要说清楚「读不到」，不能沉默。
        assert.match(
          overviewResult.content[0].text,
          /^note: this PDF's own annotations cannot be read yet \(no annotation reader in the probe\)$/m,
        );

        const locateResult = await locate(client, workspace.files.pdf, 'refund');
        assert.notEqual(locateResult.isError, true);
        assert.equal(locateResult.structuredContent.annotationMatches.length, 0);
      },
    );
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 只读：三个工具都不在源文件旁边创建任何文件
 * ------------------------------------------------------------------ */
test('只读：probe / overview / locate 之后目录与文件字节都没变', async () => {
  const workspace = await makeWorkspace();
  try {
    const before = await listDir(workspace.dir);
    const pdfBefore = await readFile(workspace.files.pdf);

    await withClient(
      workspace,
      {
        document: documentBackend({
          annotationEntries: [{ type: 'text', note: 'from the file itself', author: 'carol', page: 2 }],
        }),
      },
      async (client) => {
        await probe(client, workspace.files.pdf);
        await overview(client, workspace.files.pdf, { pages: '1-2' });
        await locate(client, workspace.files.pdf, 'file');
      },
    );

    assert.deepEqual(await listDir(workspace.dir), before, 'read-only tools must not create a sidecar');
    assert.deepEqual(await readFile(workspace.files.pdf), pdfBefore, 'the source file must not change');
    assert.equal(
      (await listDir(workspace.dir)).some((name) => name.includes('.mmgrep')),
      false,
      'no sidecar may appear next to the source',
    );
  } finally {
    await workspace.cleanup();
  }
});
