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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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

/** 6 headings, each followed by one paragraph (contract-v2 blocks) */
function documentBackend({ headingCount = 6 } = {}) {
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
        outline: {
          available: false,
          source: null,
          total: 0,
          entries: [],
          reason: 'this PDF has no bookmarks (no outline).',
        },
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

async function withClient(workspace, backends, fn) {
  const server = createServer({
    config: workspace.config,
    logger: SILENT_LOGGER,
    cache: workspace.cache,
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

const overview = (client, file, args = {}) => client.callTool({
  name: 'media_overview',
  arguments: { path: file, images: 0, ...args },
});

test('视频有章节 + 放不下：目录先出，余量给抽样文本', async () => {
  const workspace = await makeWorkspace(1800);
  try {
    await withClient(workspace, { video: videoBackend({ chapters: true }) }, async (client) => {
      const result = await overview(client, workspace.mp4);
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.ok(text.length <= 1800, `text is ${text.length} chars`);
      assert.match(text, /^outline: 3 chapters — full outline in structuredContent\.outline and manifest\.json$/m);
      assert.match(text, /^- Opening  00:00\.000-02:00\.000$/m);
      assert.match(text, /^hint: pick a range with start\/end, e\.g\. media_overview\(\{ path, start: 0, end: 120 \}\)\.$/m);
      assert.equal(data.preview.mode, 'sampled');
      assert.equal(data.preview.outlineSource, 'chapters');
      assert.equal(data.preview.outlineInlined, 3);
      assert.equal(data.preview.outlineTotal, 3);
      assert.ok(data.preview.units > 0);
      assert.ok(text.indexOf('outline: 3 chapters') < text.indexOf('preview: sampled'));
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
      assert.doesNotMatch(text, /^outline: 3 chapters/m);
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
      assert.doesNotMatch(text, /^- \d+\. Section/m);
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
