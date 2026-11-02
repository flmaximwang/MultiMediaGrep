// test/server/overview-skim.test.js —— 文档预览的 tier 2 skim（9z5.32）
//
// 硬性质（验收标准）：
//   1. 带标题结构的 blocks 超出内联上限时，文档走 skim：全部 heading + 每个段落
//      第一个完整句；每页带 `[page N · skim: X of Y sentences]` 标注；
//   2. skim 仍超预算时 heading 全部保留，句子等距抽样，text 仍 <= maxInlineChars；
//      只有连 heading 都放不下时才对 heading 本身抽样；
//   3. 没有 blocks 的旧路径、以及视频/录音，行为与 .20 一致（mode sampled，无 skim）；
//   4. caption / footnote / equation 不进 skim；table 只留 [table: <caption>]。
//
// 用 stub 后端 + 真实 MCP 协议（InMemoryTransport）跑，不依赖 ffmpeg / poppler。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-skim-'));
  const pdf = path.join(dir, 'structured.pdf');
  const mp4 = path.join(dir, 'talk.mp4');
  await writeFile(pdf, PDF);
  await writeFile(mp4, MP4);
  const config = loadConfig({
    MMGREP_CACHE_DIR: path.join(dir, 'cache'),
    MMGREP_MAX_TEXT_INLINE_CHARS: String(maxInlineChars),
    MMGREP_MAX_IMAGE_TOKENS: '4000',
    MMGREP_OCR_PROVIDER: 'none',
  });
  const exportDir = path.join(dir, 'export');
  await mkdir(exportDir, { recursive: true });
  const cache = {
    async contentKeyForFile() {
      return { sha256: 'd'.repeat(64), key: `sha256:${'d'.repeat(64)}` };
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

/** 一段两句话的正文；只有第一句允许进 skim */
function paragraphFor(page, index) {
  const first = `Paragraph ${index} on page ${page} states the opening claim in plain words.`;
  const second = `Second sentence ${index} on page ${page} carries the supporting detail that must stay out of skim.`;
  return `${first} ${second}`;
}

/** 构造一页的契约 v2 blocks（headed paragraphs + table + 三种 apparatus） */
function structuredBlocks(page, { paragraphs = 10, apparatus = true, headingLength = 0 } = {}) {
  const heading = headingLength > 0
    ? `${page}. ${'Very long heading '.repeat(Math.ceil(headingLength / 17)).slice(0, headingLength).trim()}`
    : `${page}. Section ${page} heading`;
  const blocks = [{ type: 'heading', level: 2, text: heading }];
  for (let i = 1; i <= paragraphs; i += 1) {
    blocks.push({ type: 'paragraph', text: paragraphFor(page, i) });
  }
  blocks.push({ type: 'table', text: `Table ${page} | Results for page ${page}\nA | B\n1 | 2` });
  if (apparatus) {
    blocks.push({ type: 'caption', text: `Fig. ${page} | Caption text that must stay out of skim.` });
    blocks.push({ type: 'footnote', text: `1 Footnote on page ${page} must stay out of skim.` });
    blocks.push({ type: 'equation', text: `E = mc^2 (page ${page})` });
  }
  return blocks;
}

/** 线路 stub：block 结构由闭包提供；typesetProvider=stub 表示外部结构（非 best-effort） */
function documentBackend({ pageCount = 6, blocksFor = null, withoutBlocks = false }) {
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
      const requested = Array.isArray(input.pages) && input.pages.length > 0
        ? input.pages
        : Array.from({ length: pageCount }, (_, i) => i + 1);
      return {
        segments: requested.map((page) => {
          if (withoutBlocks) {
            return {
              page,
              text: Array.from({ length: 40 }, (_, i) => `Page ${page} sentence ${i + 1} carries filler words.`).join(' '),
              startMs: null,
              endMs: null,
              source: 'text',
              origin: 'textlayer',
              textOrigin: 'textlayer',
            };
          }
          const blocks = blocksFor(page);
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
        transcript: {
          source: 'text',
          origin: 'textlayer',
          language: 'en',
          typesetProvider: 'stub',
        },
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
  const client = new Client({ name: 'skim-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// 9z5.33：view:"auto" 在文档有 >= 5 个 heading 时会先出目录；本文件测的是
// .32 的 skim 层本身，所以显式用 view:"text" 走文本管线。
const overview = (client, workspace, args = {}) => client.callTool({
  name: 'media_overview',
  arguments: { path: workspace.pdf, images: 0, view: 'text', ...args },
});

/* ------------------------------------------------------------------ *
 * 1. skim 放得下：heading + 段首句 + 每页标注；apparatus 不进 skim
 * ------------------------------------------------------------------ */

test('带标题结构的 blocks 超预算：返回全部 heading + 段首句，每页有 skim 标注', async () => {
  const workspace = await makeWorkspace(8000);
  try {
    const backend = documentBackend({ blocksFor: (page) => structuredBlocks(page) });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await overview(client, workspace);
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.equal(data.preview.mode, 'skim');
      assert.ok(text.length <= 8000, `text is ${text.length} chars`);
      assert.match(text, /^preview: skim — \d+ of \d+ sentences inlined across pages 1-6; all 6 headings kept;/m);
      assert.match(text, /every requested page is represented/);
      assert.doesNotMatch(text, /heuristic blocks/, 'structural provider blocks are not best-effort');

      // 全部 heading + 每页标注
      for (let page = 1; page <= 6; page += 1) {
        assert.match(text, new RegExp(`^\\[page ${page} · skim: \\d+ of \\d+ sentences\\] \\(text\\)\\s+## ${page}\\. Section ${page} heading`, 'm'));
      }
      // 每个段落的第一句在，第二句不在
      for (let page = 1; page <= 6; page += 1) {
        assert.match(text, new RegExp(`Paragraph 1 on page ${page} states the opening claim`));
        assert.doesNotMatch(text, new RegExp(`Second sentence 1 on page ${page}`));
      }
      // table → 占位符；caption / footnote / equation 不进 skim
      assert.match(text, /\[table: Table 1 \| Results for page 1\]/);
      assert.doesNotMatch(text, /Caption text that must stay out of skim/);
      assert.doesNotMatch(text, /Footnote on page 1 must stay out/);
      assert.doesNotMatch(text, /E = mc\^2/);

      // structuredContent.preview 信息完整
      assert.ok(data.preview.units > data.preview.headingsTotal);
      assert.equal(data.preview.skimUnits, data.preview.units, 'full skim inlines every skim unit');
      assert.equal(data.preview.headingsInlined, 6);
      assert.equal(data.preview.headingsTotal, 6);
      assert.equal(data.preview.sampled, false);
      assert.equal(data.preview.headingsSampled, false);
      assert.ok(data.preview.totalUnits > data.preview.units);
      assert.deepEqual(data.preview.notRepresented, []);

      // 全文落盘仍然是完整页文字（第二句必须能在 content.md 里找到）
      const contentMd = await readFile(data.fullText.contentMd, 'utf8');
      assert.match(contentMd, /Second sentence 10 on page 6 carries the supporting detail/);
      assert.match(contentMd, /Caption text that must stay out of skim/);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 2. skim 仍超预算：heading 全保留，句子等距抽样，长度 <= 上限
 * ------------------------------------------------------------------ */

test('skim 仍超预算：heading 全部保留，段首句等距抽样，text 不超上限', async () => {
  const workspace = await makeWorkspace(3500);
  try {
    const backend = documentBackend({ blocksFor: (page) => structuredBlocks(page) });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await overview(client, workspace);
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.equal(data.preview.mode, 'skim');
      assert.equal(data.preview.sampled, true);
      assert.equal(data.preview.headingsSampled, false);
      assert.equal(data.preview.headingsInlined, data.preview.headingsTotal);
      assert.ok(data.preview.units > data.preview.headingsTotal, 'some sentences must be kept');
      assert.ok(data.preview.units < data.preview.skimUnits, 'some sentences must be sampled out');
      assert.ok(text.length <= 3500, `text is ${text.length} chars`);
      assert.match(text, /^preview: skim \(sampled\) — \d+ of \d+ sentences inlined across pages 1-6; all 6 headings kept;/m);
      assert.match(text, /sampled \d+ of \d+ paragraph first sentences/);

      // 每页 heading 必须在；被抽掉的段落第一句不在
      for (let page = 1; page <= 6; page += 1) {
        assert.match(text, new RegExp(`## ${page}\\. Section ${page} heading`));
        assert.match(text, new RegExp(`^\\[page ${page} · skim: \\d+ of \\d+ sentences\\]`, 'm'));
      }
      const keptParagraphs = [...text.matchAll(/Paragraph (\d+) on page/g)].map((match) => Number(match[1]));
      assert.ok(keptParagraphs.length > 0);
      assert.ok(keptParagraphs.length < 60, 'sampling must drop some paragraph first sentences');
      assert.match(text, /…/, 'gaps between sampled units are marked');
      assert.doesNotMatch(text, /Second sentence \d+ on page/);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 3. 连 heading 都放不下：对 heading 本身等距抽样
 * ------------------------------------------------------------------ */

test('连 heading 都放不下：heading 被等距抽样，仍然 <= maxInlineChars', async () => {
  const workspace = await makeWorkspace(900);
  try {
    const backend = documentBackend({
      blocksFor: (page) => structuredBlocks(page, { paragraphs: 2, headingLength: 150 }),
    });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await overview(client, workspace, { pages: '1-6' });
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.equal(data.preview.mode, 'skim');
      assert.equal(data.preview.headingsSampled, true);
      assert.ok(data.preview.headingsInlined < data.preview.headingsTotal);
      assert.match(text, /even the headings did not fit/);
      assert.ok(text.length <= 900, `text is ${text.length} chars`);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 4. 没有 blocks 的旧路径：与 .20 完全一致（tier 3 抽样，无 skim）
 * ------------------------------------------------------------------ */

test('没有 blocks：旧路径仍是 tier 3 抽样，不出现 skim', async () => {
  const workspace = await makeWorkspace(2400);
  try {
    const backend = documentBackend({ pageCount: 3, withoutBlocks: true });
    await withClient(workspace, { document: backend }, async (client) => {
      const result = await overview(client, workspace, { pages: '1-3' });
      const text = result.content[0].text;
      const data = result.structuredContent;

      assert.equal(data.preview.mode, 'sampled');
      assert.equal(data.preview.skimUnits, undefined);
      assert.equal(data.preview.headingsTotal, undefined);
      assert.match(text, /preview: sampled \d+ of \d+ sentences/);
      assert.doesNotMatch(text, /preview: skim/);
      assert.doesNotMatch(text, /Skim =/);
      assert.ok(text.length <= 2400);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 5. 视频/录音：即使 segment 带 blocks 也不做 skim（与 .20 一致）
 * ------------------------------------------------------------------ */

test('视频预览不做 skim：即使 segments 上带了 blocks', async () => {
  const workspace = await makeWorkspace(1500);
  try {
    const segments = Array.from({ length: 200 }, (_, i) => ({
      startMs: i * 3000,
      endMs: (i + 1) * 3000,
      text: `Segment ${i + 1} of the talk mentions the topic again.`,
      source: 'subtitle',
      origin: 'file',
      blocks: [{ type: 'paragraph', text: `Segment ${i + 1} of the talk.` }],
    }));
    await withClient(workspace, { video: videoBackend(segments) }, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.mp4, images: 0 },
      });
      const text = result.content[0].text;
      const data = result.structuredContent;
      assert.equal(data.preview.mode, 'sampled');
      assert.equal(data.preview.totalUnits, 200);
      assert.match(text, /preview: sampled \d+ of 200 segments/);
      assert.doesNotMatch(text, /preview: skim/);
      assert.doesNotMatch(text, /· skim:/);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 6. 硬性质：有 blocks 时任何上限下长度都不超，且绝不静默整页消失
 * ------------------------------------------------------------------ */

test('有 blocks 的任何 maxInlineChars 下 text 都不超过上限（文档）', async () => {
  const limits = [500, 900, 1500, 2500, 4000, 8000];
  for (const limit of limits) {
    const workspace = await makeWorkspace(limit);
    try {
      const backend = documentBackend({ blocksFor: (page) => structuredBlocks(page) });
      await withClient(workspace, { document: backend }, async (client) => {
        const result = await overview(client, workspace);
        assert.notEqual(result.isError, true, `limit ${limit}`);
        const text = result.content[0].text;
        assert.ok(text.length <= limit, `limit ${limit}: text is ${text.length} chars`);
        assert.ok(['skim', 'whole'].includes(result.structuredContent.preview.mode));
        if (result.structuredContent.preview.mode === 'skim') {
          assert.ok(result.structuredContent.preview.units > 0, `limit ${limit} must inline something`);
        }
      });
    } finally {
      await workspace.cleanup();
    }
  }
});
