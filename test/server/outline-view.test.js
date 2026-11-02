// test/server/outline-view.test.js —— media_overview 的 view 规则（9z5.33）
//
// 用 stub 后端 + 真 MCP 协议测「不依赖 poppler / ffmpeg」的部分，重点是把
// 视频/录音的章节目录、生成目录的标注、预算与正文长度的硬性质固定下来：
//   - 视频有章节 + 放不下：目录先出，余量给抽样文本；
//   - 视频无章节：auto 不生成目录，view:"outline" 只给「无章节」说明；
//   - 放得下：即使有章节也给全文（tier 1），不插目录；
//   - 文档 heading >= 5 生成的目录标注 "generated from headings"，auto 时
//     剩余预算走 .20 抽样（不再重复列 heading）；
//   - 任何 view / 任何 maxInlineChars 下 text 长度都不超过上限。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { deriveEntriesFromProbe } from '../../src/media/bookmark/index.js';
import { createPlaceholderBackend } from '../../src/server/backends.js';
import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';

const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

async function makeWorkspace(maxInlineChars) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-outline-view-'));
  const mp4 = path.join(dir, 'talk.mp4');
  const pdf = path.join(dir, 'structured.pdf');
  await writeFile(mp4, MP4);
  await writeFile(pdf, PDF);
  const config = loadConfig({
    MMGREP_CACHE_DIR: path.join(dir, 'cache'),
    MMGREP_MAX_TEXT_INLINE_CHARS: String(maxInlineChars),
    MMGREP_MAX_IMAGE_TOKENS: '4000',
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
  return { dir, mp4, pdf, config, cache, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const CHAPTERS = [
  { title: 'Opening', startMs: 0, endMs: 120000, startSec: 0, endSec: 120 },
  { title: 'Middle', startMs: 120000, endMs: 300000, startSec: 120, endSec: 300 },
  { title: 'Wrap Up', startMs: 300000, endMs: 600000, startSec: 300, endSec: 600 },
];

function chaptersOutline() {
  return { available: true, source: 'chapters', total: CHAPTERS.length, entries: CHAPTERS, reason: null };
}

function noChaptersOutline() {
  return {
    available: false,
    source: null,
    total: 0,
    entries: [],
    reason: 'this file has no chapters (no chapter metadata in the container).',
  };
}

function videoBackend({ chapters = false, segments = null } = {}) {
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
        durationMs: 600000,
        durationSec: 600,
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
        outline: chapters ? chaptersOutline() : noChaptersOutline(),
      };
    },
    async locate() {
      return {
        matches: [],
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

/** PDF bookmarks copied into the probe outline (physical page + level + label) */
const PDF_NATIVE = [
  { title: 'Chapter One', level: 1, page: 1, label: '1' },
  { title: 'Section 1.1', level: 2, page: 2, label: '2' },
  { title: 'Subsection 1.1.1', level: 3, page: 3, label: '3' },
  { title: 'Chapter Two', level: 1, page: 5, label: '5' },
  { title: 'Section 2.1', level: 2, page: 6, label: '6' },
];

/** document stub：默认没有书签，可注入 PDF 书签；overview 给 blocks，locate 给空结果 */
function documentBackend({ headingCount = 6, outlineEntries = [] } = {}) {
  const headings = Array.from({ length: headingCount }, (_, i) => ({
    type: 'heading',
    level: 1,
    text: `${i + 1}. Section ${i + 1}`,
  }));
  return {
    async probe() {
      return {
        mediaType: 'document',
        pageCount: 6,
        hasTextLayer: true,
        hasAudio: false,
        container: 'pdf',
        subtitleTracks: [],
        audioTracks: [],
        outline: outlineEntries.length > 0
          ? {
            available: true,
            source: 'pdf-bookmarks',
            total: outlineEntries.length,
            entries: outlineEntries,
            reason: null,
          }
          : {
            available: false,
            source: null,
            total: 0,
            entries: [],
            reason: 'this PDF has no bookmarks (no outline).',
          },
      };
    },
    async locate() {
      return {
        matches: [],
        totalSegments: 0,
        transcript: { source: 'text', origin: 'textlayer' },
        frame: null,
        warnings: [],
      };
    },
    async overview(input) {
      const requested = Array.isArray(input.pages) && input.pages.length > 0
        ? input.pages
        : [1];
      return {
        segments: requested.map((page) => {
          const blocks = [];
          for (let i = 0; i < 10; i += 1) {
            // 只把 heading 放在第 1 页：请求多页时不重复计数。
            if (page === 1 && i < headingCount) blocks.push(headings[i]);
            blocks.push({
              type: 'paragraph',
              text: `Page ${page} paragraph ${i} states a claim in one complete sentence. Another sentence carries supporting detail that is not needed for the outline.`,
            });
          }
          return {
            page,
            text: blocks.map((block) => block.text).join('\n\n'),
            blocks,
            startMs: null,
            endMs: null,
            source: 'text',
            origin: 'textlayer',
            textOrigin: 'textlayer',
          };
        }),
        images: [],
        transcript: { source: 'text', origin: 'textlayer', language: 'en', typesetProvider: 'stub' },
        warnings: [],
      };
    },
  };
}

async function withClient(workspace, backends, fn, { bookmarkEmbedders } = {}) {
  const server = createServer({
    config: workspace.config,
    logger: SILENT_LOGGER,
    cache: workspace.cache,
    bookmarkEmbedders,
    backends: {
      document: backends.document ?? createPlaceholderBackend('document'),
      video: backends.video ?? createPlaceholderBackend('video'),
      audio: createPlaceholderBackend('audio'),
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'outline-view-test', version: '0.0.0' });
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

const sidecarFile = (file) => `${file}.mmgrep.bookmark.json`;
const listDir = async (dir) => (await readdir(dir)).sort();

/** 假 PDF 嵌入器：绝不写真实 PDF，只记录最终条目（与 9z5.37.1 的注入点一致） */
function fakePdfEmbedder() {
  const calls = [];
  return {
    media: 'pdf',
    calls,
    async embed(input) {
      calls.push(input);
      return {
        target: input.filePath,
        checks: [{ name: 'fake-pdf-outline', ok: true, detail: `${input.entries.length} entries` }],
      };
    },
  };
}

test('视频有章节 + 放不下：目录先出，余量给抽样文本', async () => {
  const workspace = await makeWorkspace(1800);
  try {
    await withClient(workspace, { video: videoBackend({ chapters: true }) }, async (client) => {
      const result = await overview(client, workspace.mp4);
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.ok(text.length <= 1800, `text is ${text.length} chars`);
      assert.match(text, /^outline: container chapters — 3 chapters — full outline in structuredContent\.outline and manifest\.json$/m);
      assert.match(text, /^b1  00:00  Opening$/m);
      assert.match(text, /^b2  02:00  Middle$/m);
      assert.match(text, /^hint: pick a range with start\/end, e\.g\. media_overview\(\{ path, start: 0, end: 120 \}\)\.$/m);
      assert.equal(data.preview.mode, 'sampled');
      assert.equal(data.preview.outlineSource, 'chapters');
      assert.equal(data.preview.outlineInlined, 3);
      assert.equal(data.preview.outlineTotal, 3);
      assert.ok(data.preview.units > 0);
      assert.ok(text.indexOf('outline: container chapters') < text.indexOf('preview: sampled'));
    });
  } finally {
    await workspace.cleanup();
  }
});

test('视频有章节但放得下：给全文（tier 1），不插目录', async () => {
  const workspace = await makeWorkspace(24000);
  try {
    const short = Array.from({ length: 4 }, (_, i) => ({
      startMs: i * 3000,
      endMs: (i + 1) * 3000,
      text: `Short segment ${i + 1}.`,
      source: 'subtitle',
      origin: 'file',
    }));
    await withClient(workspace, { video: videoBackend({ chapters: true, segments: short }) }, async (client) => {
      const result = await overview(client, workspace.mp4);
      const text = result.content[0].text;
      const data = result.structuredContent;
      assert.equal(data.preview.mode, 'whole');
      assert.doesNotMatch(text, /^outline: container chapters/m);
      assert.match(text, /note: complete text of this window \(nothing omitted\)/);
      assert.equal(data.outline.source, 'chapters');
      assert.equal(data.preview.outlineInlined, 0);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('视频无章节：auto 不生成目录，仍走抽样', async () => {
  const workspace = await makeWorkspace(1800);
  try {
    await withClient(workspace, { video: videoBackend({ chapters: false }) }, async (client) => {
      const result = await overview(client, workspace.mp4);
      const text = result.content[0].text;
      const data = result.structuredContent;
      assert.equal(data.preview.mode, 'sampled');
      assert.equal(data.outline.available, false);
      assert.doesNotMatch(text, /^outline:/m);
      assert.match(text, /^preview: sampled/m);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('视频无章节 + view:outline：只给「无章节」说明，不生成正文', async () => {
  const workspace = await makeWorkspace(24000);
  try {
    await withClient(workspace, { video: videoBackend({ chapters: false }) }, async (client) => {
      const result = await overview(client, workspace.mp4, { view: 'outline' });
      const text = result.content[0].text;
      const data = result.structuredContent;
      assert.equal(data.preview.mode, 'outline');
      assert.equal(data.segments.length, 0);
      assert.match(text, /^outline: none — no chapters: this file has no chapters/m);
      assert.match(text, /does not call an LLM/);
      assert.doesNotMatch(text, /^preview: (skim|sampled)/m);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('文档 heading >= 5 + 放不下：auto 生成目录并标注，余量走抽样（不重复 skim heading）', async () => {
  const workspace = await makeWorkspace(2200);
  try {
    await withClient(workspace, { document: documentBackend() }, async (client) => {
      const result = await overview(client, workspace.pdf);
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.ok(text.length <= 2200, `text is ${text.length} chars`);
      assert.match(text, /^outline: generated from headings — 6 entries \(best-effort: built from block structure;/m);
      assert.equal(data.outline.source, 'headings');
      assert.equal(data.outline.generated, true);
      assert.equal(data.preview.mode, 'sampled');
      assert.equal(data.preview.outlineSource, 'headings');
      assert.equal(data.preview.outlineInlined, 6);
      assert.match(text, /^preview: sampled/m);
      assert.doesNotMatch(text, /^preview: skim/m);
      // 目录里已经有 heading，正文预览不再重复
      assert.doesNotMatch(text, /^# 1\. Section 1$/m);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('文档 heading < 5 + view:outline：明说没有目录，不生成内容', async () => {
  const workspace = await makeWorkspace(24000);
  try {
    await withClient(workspace, { document: documentBackend({ headingCount: 3 }) }, async (client) => {
      const result = await overview(client, workspace.pdf, { view: 'outline' });
      const text = result.content[0].text;
      const data = result.structuredContent;
      assert.equal(data.outline.available, false);
      assert.equal(data.preview.mode, 'outline');
      assert.equal(data.segments.length, 0);
      assert.match(text, /^outline: none — this document has no PDF bookmarks/m);
      assert.match(text, /fewer than 5 headings/);
      assert.doesNotMatch(text, /^b\d+  p\.\d+  \d+\. Section/m);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('任何 view / 任何 maxInlineChars 下 video 文本都不超过上限', async () => {
  for (const limit of [400, 800, 1500, 4000]) {
    const workspace = await makeWorkspace(limit);
    try {
      await withClient(workspace, { video: videoBackend({ chapters: true }) }, async (client) => {
        for (const view of ['auto', 'outline', 'text']) {
          const result = await overview(client, workspace.mp4, { view });
          assert.notEqual(result.isError, true, `limit ${limit} view ${view}`);
          const text = result.content[0].text;
          assert.ok(text.length <= limit, `limit ${limit} view ${view}: text is ${text.length} chars`);
        }
      });
    } finally {
      await workspace.cleanup();
    }
  }
});

/* ------------------------------------------------------------------ *
 * 4. 读取侧统一目录（9z5.37.6）：sidecar → 文件自带目录 → heading 生成
 * ------------------------------------------------------------------ */

test('无 sidecar：probe 用文件自带 PDF 目录，派生 id 与 derive 一致，且不创建 sidecar', async () => {
  const workspace = await makeWorkspace(24000);
  try {
    await withClient(workspace, { document: documentBackend({ outlineEntries: PDF_NATIVE }) }, async (client) => {
      const before = await listDir(workspace.dir);
      const result = await probe(client, workspace.pdf);
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.equal(data.outline.available, true);
      assert.equal(data.outline.source, 'pdf-bookmarks');
      assert.equal(data.outline.generated, false);
      assert.equal(data.outline.total, PDF_NATIVE.length);
      assert.equal(data.outline.sidecarPath, null);

      // 不复制 derive 逻辑：读侧的 id 必须与 media_bookmark 首次导入完全相同。
      assert.deepEqual(
        data.outline.entries.map(({ id, title, page, level }) => ({ id, title, page, level })),
        deriveEntriesFromProbe('pdf', { available: true, entries: PDF_NATIVE }),
      );

      // 统一行格式：bN + 物理页；PDF level 用缩进表达。
      assert.match(text, /^outline: PDF outline — 5 entries — use the outline to pick a range$/m);
      assert.match(text, /^b1  p\.1  Chapter One$/m);
      assert.match(text, /^ {2}b2  p\.2  Section 1\.1$/m);
      // probe 文本最多 2 层：level 3 只在 structuredContent
      assert.doesNotMatch(text, /Subsection 1\.1\.1/);
      assert.ok(data.outline.entries.some((entry) => entry.id === 'b3' && entry.level === 3));

      // overview view:outline 展示全部层级（level 3 → 4 个空格）。
      const outlineOnly = await overview(client, workspace.pdf, { view: 'outline' });
      const outlineText = outlineOnly.content[0].text;
      assert.match(
        outlineText,
        /^outline: PDF outline — 5 entries — full outline in structuredContent\.outline and manifest\.json$/m,
      );
      assert.match(outlineText, /^ {4}b3  p\.3  Subsection 1\.1\.1$/m);
      assert.match(outlineText, /^ {2}b5  p\.6  Section 2\.1$/m);

      // locate 展示同一份目录（不做第二份 / 不合并）。
      const located = await client.callTool({
        name: 'media_locate',
        arguments: { path: workspace.pdf, query: 'claim' },
      });
      assert.notEqual(located.isError, true);
      assert.equal(located.structuredContent.outline.source, 'pdf-bookmarks');
      assert.deepEqual(located.structuredContent.outline.entries.map((entry) => entry.id), [
        'b1', 'b2', 'b3', 'b4', 'b5',
      ]);

      assert.deepEqual(await listDir(workspace.dir), before, 'read-only tools must not create a sidecar');
    });
  } finally {
    await workspace.cleanup();
  }
});

test('有 sidecar：三个工具展示同一份 sidecar 目录，首行来源、末行 full detail，且不写文件', async () => {
  const workspace = await makeWorkspace(24000);
  try {
    const sidecarPath = sidecarFile(workspace.mp4);
    const sidecar = {
      version: 1,
      media: 'video',
      entries: [
        { id: 'b1', title: 'Intro', start: 0, end: 60 },
        { id: 'b2', title: 'Deep dive', start: 754, end: 1400 },
      ],
    };
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    const before = await listDir(workspace.dir);
    const sidecarBefore = await readFile(sidecarPath, 'utf8');

    await withClient(workspace, { video: videoBackend({ chapters: true }) }, async (client) => {
      const probeResult = await probe(client, workspace.mp4);
      assert.notEqual(probeResult.isError, true);
      const probeText = probeResult.content[0].text;
      const probeData = probeResult.structuredContent;

      // sidecar 优先于文件自带的章节
      assert.equal(probeData.outline.available, true);
      assert.equal(probeData.outline.source, 'sidecar');
      assert.equal(probeData.outline.total, 2);
      assert.equal(probeData.outline.sidecarPath, sidecarPath);
      assert.deepEqual(probeData.outline.entries.map(({ id, title }) => ({ id, title })), [
        { id: 'b1', title: 'Intro' },
        { id: 'b2', title: 'Deep dive' },
      ]);
      assert.match(probeText, /^outline: sidecar — 2 entries — use the outline to pick a range$/m);
      assert.match(probeText, /^b1  00:00  Intro$/m);
      assert.match(probeText, /^b2  12:34  Deep dive$/m);
      assert.doesNotMatch(probeText, /Opening|Middle|Wrap Up/);
      // 末行 full detail：在条目之后、How to read 之前。
      assert.match(probeText, new RegExp(`^full detail: ${sidecarPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      assert.ok(probeText.indexOf('full detail: ') > probeText.indexOf('b2  12:34'));
      assert.ok(probeText.indexOf('full detail: ') < probeText.indexOf('How to read:'));

      const overviewResult = await overview(client, workspace.mp4, { view: 'outline' });
      const overviewText = overviewResult.content[0].text;
      const overviewData = overviewResult.structuredContent;
      assert.equal(overviewData.outline.source, 'sidecar');
      assert.deepEqual(overviewData.outline.entries.map((entry) => entry.id), ['b1', 'b2']);
      assert.match(overviewText, /^outline: sidecar — 2 entries — full outline in structuredContent\.outline and manifest\.json$/m);
      assert.ok(overviewText.indexOf('full detail: ') > overviewText.indexOf('b2  12:34'));
      assert.ok(overviewText.indexOf('full detail: ') < overviewText.indexOf('note: view="outline"'));

      const locateResult = await client.callTool({
        name: 'media_locate',
        arguments: { path: workspace.mp4, query: 'topic' },
      });
      assert.notEqual(locateResult.isError, true);
      assert.equal(locateResult.structuredContent.outline.source, 'sidecar');
      assert.equal(locateResult.structuredContent.outline.sidecarPath, sidecarPath);
      assert.deepEqual(locateResult.structuredContent.outline.entries.map((entry) => entry.id), ['b1', 'b2']);
    });

    // 只读工具没有创建/修改任何文件（包括临时文件）
    assert.deepEqual(await listDir(workspace.dir), before);
    assert.equal(await readFile(sidecarPath, 'utf8'), sidecarBefore);
  } finally {
    await workspace.cleanup();
  }
});

test('无 sidecar：读侧派生 id 与 media_bookmark 首次导入一致', async () => {
  const workspace = await makeWorkspace(24000);
  try {
    const embedder = fakePdfEmbedder();
    await withClient(
      workspace,
      { document: documentBackend({ outlineEntries: PDF_NATIVE }) },
      async (client) => {
        const before = await probe(client, workspace.pdf);
        const derived = before.structuredContent.outline.entries;
        assert.deepEqual(derived.map((entry) => entry.id), ['b1', 'b2', 'b3', 'b4', 'b5']);

        // 首次写入 = 导入文件自带目录 + add；导入的 id 必须与上面完全一致。
        const written = await client.callTool({
          name: 'media_bookmark',
          arguments: { path: workspace.pdf, add: [{ title: 'Appendix', page: 6, level: 1 }] },
        });
        assert.notEqual(written.isError, true);
        const writtenData = written.structuredContent;
        assert.equal(writtenData.created, true);
        assert.equal(writtenData.imported, PDF_NATIVE.length);
        assert.deepEqual(writtenData.outline.entries.map((entry) => entry.id), [
          'b1', 'b2', 'b3', 'b4', 'b5', 'b6',
        ]);
        assert.deepEqual(
          writtenData.outline.entries.slice(0, PDF_NATIVE.length),
          derived.map(({ id, title, page, level }) => ({ id, title, page, level })),
        );
        assert.equal(embedder.calls.length, 1);

        // 写入后再读：source=sidecar，条目与写入结果完全一致（同一份目录）。
        const after = await probe(client, workspace.pdf);
        const afterData = after.structuredContent;
        assert.equal(afterData.outline.source, 'sidecar');
        assert.equal(afterData.outline.sidecarPath, sidecarFile(workspace.pdf));
        assert.deepEqual(
          afterData.outline.entries.map(({ id, title, page, level }) => ({ id, title, page, level })),
          writtenData.outline.entries,
        );
        assert.match(after.content[0].text, /^outline: sidecar — 6 entries — use the outline to pick a range$/m);
        assert.match(after.content[0].text, /^b6  p\.6  Appendix$/m);
      },
      { bookmarkEmbedders: { pdf: embedder } },
    );
  } finally {
    await workspace.cleanup();
  }
});

test('损坏的 sidecar：回退到文件自带目录并说明原因，不抛错、不改文件', async () => {
  const workspace = await makeWorkspace(24000);
  try {
    const sidecarPath = sidecarFile(workspace.mp4);
    const broken = '{ "version": 1, "media": "video", "entries": [\n';
    await writeFile(sidecarPath, broken);
    const before = await listDir(workspace.dir);
    const bytesBefore = await readFile(sidecarPath, 'utf8');

    await withClient(workspace, { video: videoBackend({ chapters: true }) }, async (client) => {
      const probeResult = await probe(client, workspace.mp4);
      assert.notEqual(probeResult.isError, true, 'a corrupted sidecar must never fail a read-only call');
      const text = probeResult.content[0].text;
      const data = probeResult.structuredContent;

      assert.equal(data.outline.available, true);
      assert.equal(data.outline.source, 'chapters');
      assert.equal(data.outline.total, 3);
      assert.equal(data.outline.sidecarPath, sidecarPath);
      assert.match(data.outline.sidecarError, /could not be read/);
      assert.ok(data.outline.sidecarError.includes(sidecarPath));
      assert.match(text, /^outline: container chapters — 3 chapters — use the outline to pick a range$/m);
      assert.match(text, /^b1  00:00  Opening$/m, 'ids still come from the file outline');
      assert.match(text, /^note: the bookmark sidecar .* could not be read.* — showing container chapters instead\.$/m);
      assert.doesNotMatch(text, /^full detail:/m);

      const overviewResult = await overview(client, workspace.mp4, { view: 'outline' });
      assert.equal(overviewResult.structuredContent.outline.source, 'chapters');
      assert.match(overviewResult.content[0].text, /could not be read/);

      const locateResult = await client.callTool({
        name: 'media_locate',
        arguments: { path: workspace.mp4, query: 'topic' },
      });
      assert.notEqual(locateResult.isError, true);
      assert.equal(locateResult.structuredContent.outline.source, 'chapters');
      assert.ok(locateResult.structuredContent.outline.sidecarError.includes(sidecarPath));
    });

    assert.deepEqual(await listDir(workspace.dir), before);
    assert.equal(await readFile(sidecarPath, 'utf8'), bytesBefore);
  } finally {
    await workspace.cleanup();
  }
});
