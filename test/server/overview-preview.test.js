// test/server/overview-preview.test.js —— 内联预览管线（9z5.20）
//
// 目标不是「输出好看」，而是四条硬性质：
//   1. text 长度永远 <= MMGREP_MAX_TEXT_INLINE_CHARS（含 header / notes / full text 行）；
//   2. 单个超长页面不会被整页丢掉：至少给一段摘录 + 明确的抽样说明；
//   3. 非 tier 1（抽样）绝不再宣称「包含每一页」；
//   4. 有页码预算时每页至少一个单元；预算不够时等距选页并列出未覆盖页。
//
// 用 stub 后端 + 真实 MCP 协议（InMemoryTransport）跑，不依赖 ffmpeg / poppler。
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
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);

async function makeWorkspace(maxInlineChars) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-preview-'));
  const pdf = path.join(dir, 'a.pdf');
  const mp4 = path.join(dir, 'a.mp4');
  await writeFile(pdf, PDF);
  await writeFile(mp4, MP4);
  const config = loadConfig({
    MMGREP_CACHE_DIR: path.join(dir, 'cache'),
    MMGREP_MAX_TEXT_INLINE_CHARS: String(maxInlineChars),
    MMGREP_MAX_IMAGE_TOKENS: '4000',
  });
  const exportDir = path.join(dir, 'export');
  await mkdir(exportDir, { recursive: true });
  const cache = {
    async contentKeyForFile() {
      return { sha256: 'e'.repeat(64), key: `sha256:${'e'.repeat(64)}` };
    },
    async prepareDir() {
      return exportDir;
    },
    async register() {
      return { path: exportDir, type: 'dir', size: 0 };
    },
  };
  return { dir, pdf, mp4, config, cache, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function documentBackend({ pageCount, pageTextFor }) {
  return {
    async probe() {
      return {
        mediaType: 'document',
        pageCount,
        hasTextLayer: true,
        hasAudio: false,
        container: 'pdf',
        subtitleTracks: [],
        audioTracks: [],
      };
    },
    async overview(input) {
      const pages = Array.isArray(input.pages) && input.pages.length > 0
        ? input.pages
        : Array.from({ length: pageCount }, (_, i) => i + 1);
      return {
        segments: pages.map((page) => ({
          page,
          text: pageTextFor(page),
          startMs: null,
          endMs: null,
          source: 'ocr',
          origin: 'ocr',
        })),
        images: [],
        transcript: { source: 'ocr', origin: 'ocr', language: 'en', provider: 'stub', model: 'stub' },
        warnings: [],
      };
    },
  };
}

function videoBackend(segments) {
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
      };
    },
    async overview() {
      return {
        segments,
        images: [],
        transcript: { source: 'subtitle', origin: 'file', language: 'en', provider: null, model: null },
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
  const client = new Client({ name: 'preview-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** 一页 N 句，每句约 70 字符 */
function sentencesForPage(page, count = 12) {
  return Array.from({ length: count }, (_, i) => (
    `Page ${page} sentence ${i + 1} carries ${'filler '.repeat(8)}words.`
  )).join(' ');
}

/* ------------------------------------------------------------------ *
 * 1. 硬性质：任何上限下 text 长度都不超
 * ------------------------------------------------------------------ */

test('任何 maxInlineChars 下 text 长度都不超过上限（文档，1-12 页）', async () => {
  const limits = [300, 800, 1200, 2400, 4800, 12000, 24000];
  for (const limit of limits) {
    const workspace = await makeWorkspace(limit);
    try {
      const backend = documentBackend({
        pageCount: 12,
        pageTextFor: (page) => sentencesForPage(page, 20),
      });
      await withClient(workspace, { document: backend }, async (client) => {
        const result = await client.callTool({
          name: 'media_overview',
          arguments: { path: workspace.pdf, pages: '1-12', images: 0 },
        });
        assert.notEqual(result.isError, true, `limit ${limit}`);
        const text = result.content[0].text;
        assert.ok(text.length <= limit, `limit ${limit}: text is ${text.length} chars`);
        assert.ok(text.length > 0);
        if (limit >= 1200) {
          assert.match(text, /full text: \/.*content\.md /, `limit ${limit} must still carry the path`);
        }
        assert.equal(typeof result.structuredContent.preview.mode, 'string');
      });
    } finally {
      await workspace.cleanup();
    }
  }
});

test('任何 maxInlineChars 下 text 长度都不超过上限（视频，200 段）', async () => {
  const limits = [600, 1200, 2400, 6000];
  for (const limit of limits) {
    const workspace = await makeWorkspace(limit);
    try {
      const segments = Array.from({ length: 200 }, (_, i) => ({
        startMs: i * 3000,
        endMs: (i + 1) * 3000,
        text: `Segment ${i + 1} of the talk mentions ${'topic '.repeat(6)}again.`,
        source: 'subtitle',
        origin: 'file',
      }));
      await withClient(workspace, { video: videoBackend(segments) }, async (client) => {
        const result = await client.callTool({
          name: 'media_overview',
          arguments: { path: workspace.mp4, images: 0 },
        });
        assert.notEqual(result.isError, true, `limit ${limit}`);
        const text = result.content[0].text;
        assert.ok(text.length <= limit, `limit ${limit}: text is ${text.length} chars`);
        assert.equal(result.structuredContent.preview.totalUnits, 200);
      });
    } finally {
      await workspace.cleanup();
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. 单页 > 内联上限：不许整页消失
 * ------------------------------------------------------------------ */

test('单页正文 > maxInlineChars：返回非空摘录 + 抽样说明（不再整页丢弃）', async () => {
  const workspace = await makeWorkspace(2400);
  try {
    const backend = documentBackend({
      pageCount: 1,
      pageTextFor: () => sentencesForPage(1, 400), // ~30k 字符
    });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.pdf, pages: '1', images: 0 },
      });
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.match(text, /^\[page 1\s*\] \(ocr\)\s+「Page 1 sentence 1 /m, 'must still show the page');
      assert.match(text, /preview: sampled \d+ of \d+ sentences across page 1/);
      assert.match(text, /every requested page is represented/);
      assert.ok(text.length <= 2400);
      assert.equal(data.preview.mode, 'sampled');
      assert.ok(data.preview.units > 0);
      assert.ok(data.preview.totalUnits > data.preview.units);
      // 结构化 segments 只放实际内联的单元
      assert.equal(data.segments.length, data.preview.units);
      assert.ok(data.segments.every((segment) => segment.page === 1));
      // 不再出现旧的无条件保证
      assert.doesNotMatch(text, /every requested page\./);
      assert.doesNotMatch(text, /the list below is the text of every requested page/);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 3. pages "4-6"：三页都要出现（即使 4 超长）
 * ------------------------------------------------------------------ */

test('pages "4-6"：长页被抽样时 4/5/6 三页仍都出现在文本里', async () => {
  const workspace = await makeWorkspace(2400);
  try {
    const backend = documentBackend({
      pageCount: 6,
      pageTextFor: (page) => (page === 4 ? sentencesForPage(4, 400) : sentencesForPage(page, 4)),
    });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.pdf, pages: '4-6', images: 0 },
      });
      const text = result.content[0].text;
      assert.match(text, /\[page 4\s*\] \(ocr\)/);
      assert.match(text, /\[page 5\s*\] \(ocr\)/);
      assert.match(text, /\[page 6\s*\] \(ocr\)/);
      assert.ok(text.length <= 2400);
      assert.equal(result.structuredContent.preview.mode, 'sampled');
      assert.deepEqual(result.structuredContent.preview.notRepresented, []);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 4. 页多于预算：等距选页 + not represented
 * ------------------------------------------------------------------ */

test('页数多于正文预算：等距选页，note 列出未覆盖页（区间压缩）', async () => {
  const workspace = await makeWorkspace(1500);
  try {
    const backend = documentBackend({
      pageCount: 40,
      pageTextFor: (page) => sentencesForPage(page, 6),
    });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.pdf, images: 0 },
      });
      const text = result.content[0].text;
      const { preview } = result.structuredContent;
      assert.equal(preview.mode, 'sampled');
      assert.ok(preview.totalUnits > preview.units);
      assert.ok(preview.notRepresented.length > 0, 'small budget must leave pages unrepresented');
      assert.match(text, /preview: sampled \d+ of \d+ sentences across pages 1-40; not represented: /);
      assert.match(text, /not represented: (?:\d+(?:-\d+)?(?:, )?)+\d/);
      assert.ok(text.length <= 1500);
      assert.doesNotMatch(text, /every requested page is represented/);
      // 出现在正文里的页一定是被选中的页
      const shownPages = [...text.matchAll(/^\[page (\d+)\s*\]/gm)].map((match) => Number(match[1]));
      assert.ok(shownPages.length > 0);
      assert.ok(shownPages.length <= 40 - preview.notRepresented.length);
      assert.ok(shownPages.includes(1), 'first requested page should be represented');
      assert.ok(shownPages.includes(40), 'last requested page should be represented');
    });
  } finally {
    await workspace.cleanup();
  }
});

test('未覆盖页太多时区间串压缩成 "+ N more ranges"', async () => {
  const workspace = await makeWorkspace(2400);
  try {
    const backend = documentBackend({
      pageCount: 200,
      pageTextFor: (page) => `Page ${page} has one short sentence about the fixture.`,
    });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.pdf, images: 0 },
      });
      const text = result.content[0].text;
      assert.ok(result.structuredContent.preview.notRepresented.length > 10);
      assert.match(text, /not represented: .*\+ \d+ more ranges/);
      assert.ok(text.length <= 2400);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 5. 无标点超长单元：硬截断 …[+N chars]
 * ------------------------------------------------------------------ */

test('无标点超长单元：硬截断并标注 …[+N chars]，note 说明截断阈值', async () => {
  const workspace = await makeWorkspace(2400);
  try {
    const blob = Array.from({ length: 1600 }, (_, i) => `word${i}`).join(' '); // 无句末标点，约 10k 字符
    const backend = documentBackend({ pageCount: 1, pageTextFor: () => blob });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.pdf, pages: '1', images: 0 },
      });
      const text = result.content[0].text;
      assert.match(text, /…\[\+\d+ chars\]/, 'long unit must end with the truncation marker');
      assert.match(text, /units longer than \d+ chars end with …\[\+N chars\]/);
      assert.ok(text.length <= 2400);

      const firstUnit = result.structuredContent.segments[0];
      assert.match(firstUnit.text, /…\[\+\d+ chars\]$/);
      assert.ok(firstUnit.text.length > 10);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 6. 视频/录音：抽样覆盖窗口首尾，按时间顺序
 * ------------------------------------------------------------------ */

test('视频长窗口抽样：首段与末段都在，顺序不变', async () => {
  const workspace = await makeWorkspace(1500);
  try {
    const segments = Array.from({ length: 300 }, (_, i) => ({
      startMs: i * 2000,
      endMs: (i + 1) * 2000,
      text: `Segment ${i + 1} of the recording.`,
      source: 'subtitle',
      origin: 'file',
    }));
    await withClient(workspace, { video: videoBackend(segments) }, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.mp4, images: 0 },
      });
      const text = result.content[0].text;
      const { preview, segments: inlined } = result.structuredContent;
      assert.equal(preview.mode, 'sampled');
      assert.ok(preview.units < preview.totalUnits);
      assert.match(text, /preview: sampled \d+ of 300 segments across 0\.00-600\.00 s; first and last are included/);
      assert.match(text, /Segment 1 of the recording\./);
      assert.match(text, /Segment 300 of the recording\./);
      // 时间顺序：startMs 单调递增
      const starts = inlined.map((segment) => segment.startMs);
      assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
      assert.equal(inlined[0].startMs, 0);
      assert.equal(inlined.at(-1).startMs, 299 * 2000);
      assert.ok(text.length <= 1500);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 7. tier 1 whole：可以宣称完整；且不再有旧的无条件保证
 * ------------------------------------------------------------------ */

test('范围放得下时走 tier 1：原文完整 + 说明「nothing omitted」', async () => {
  const workspace = await makeWorkspace(24000);
  try {
    const backend = documentBackend({
      pageCount: 3,
      pageTextFor: (page) => sentencesForPage(page, 3),
    });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.pdf, pages: '1-3', images: 0 },
      });
      const text = result.content[0].text;
      const data = result.structuredContent;
      assert.equal(data.preview.mode, 'whole');
      assert.equal(data.truncated, false);
      assert.equal(data.preview.units, data.preview.totalUnits);
      assert.match(text, /note: complete text of pages 1-3 \(nothing omitted\)\./);
      assert.doesNotMatch(text, /preview: sampled/);
      assert.doesNotMatch(text, /every requested page/);
      assert.equal(data.segments.length, data.preview.totalUnits);
      // 每句都在
      for (let i = 1; i <= 3; i += 1) assert.match(text, new RegExp(`Page 1 sentence ${i} `));
    });
  } finally {
    await workspace.cleanup();
  }
});

test('旧文案 "the list below is the text of every requested page" 已移除', async () => {
  const workspace = await makeWorkspace(24000);
  try {
    const backend = documentBackend({ pageCount: 2, pageTextFor: (page) => sentencesForPage(page, 2) });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.pdf, pages: '1-2', images: 0 },
      });
      const text = result.content[0].text;
      assert.match(text, /text-only mode \(images: 0\)/);
      assert.doesNotMatch(text, /every requested page/);
      assert.doesNotMatch(text, /list below is the text/);
    });
  } finally {
    await workspace.cleanup();
  }
});
