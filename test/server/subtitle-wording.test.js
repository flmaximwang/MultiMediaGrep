// test/server/subtitle-wording.test.js —— 字幕来源的措辞与滚动字幕警告（9z5.26）
//
// 契约 §2.5 的硬约束：字幕**不保证**是作者原创，更不保证「可安全引用」。
// 这里从 MCP 协议这一层验证：
//   1. 工具描述 / server instructions / overview 文本里都不出现 "safe to quote" 之类绝对表述；
//   2. overview 的 note 用中性措辞说明字幕来源；
//   3. 滚动字幕的警告同时出现在 overview 的 note 与 locate 的 warnings 里。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ROLLING_SUBTITLE_WARNING } from '../../src/media/subtitles.js';
import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';
import { SERVER_INSTRUCTIONS } from '../../src/server/server-instructions.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });

/** 绝对承诺的措辞一律不许出现 */
const ABSOLUTE_PHRASES = [/safe to quote/i, /author'?s own words/i, /可安全引用/, /可以当原话引用/];

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-subtitle-wording-'));
  const files = {
    video: path.join(dir, 'a.mp4'),
    audio: path.join(dir, 'a.mp3'),
    document: path.join(dir, 'a.pdf'),
  };
  await writeFile(files.video, MP4);
  await writeFile(files.audio, MP3);
  await writeFile(files.document, PDF);
  const config = loadConfig({ MMGREP_CACHE_DIR: path.join(dir, 'cache'), MMGREP_MAX_IMAGE_TOKENS: '4000' });
  const cache = {
    async contentKeyForFile() {
      return { sha256: 'c'.repeat(64), key: `sha256:${'c'.repeat(64)}` };
    },
    async prepareDir() {
      const outDir = path.join(dir, 'export');
      await mkdir(outDir, { recursive: true });
      return outDir;
    },
    async register() {
      return { path: path.join(dir, 'export'), type: 'dir', size: 0 };
    },
  };
  return { dir, files, config, cache, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** stub 后端：字幕来源 + 可选的滚动字幕警告 */
function stubBackends({ warnings = [], source = 'subtitle' } = {}) {
  const makeBackend = (kind) => ({
    async probe() {
      if (kind === 'document') {
        return {
          mediaType: 'document',
          pageCount: 4,
          hasTextLayer: true,
          hasAudio: false,
          container: 'pdf',
          subtitleTracks: [],
          audioTracks: [],
        };
      }
      return {
        mediaType: kind === 'audio' ? 'audio' : 'video',
        durationMs: 600000,
        durationSec: 600,
        width: kind === 'video' ? 1920 : null,
        height: kind === 'video' ? 1080 : null,
        fps: kind === 'video' ? 25 : null,
        container: kind === 'video' ? 'mov,mp4' : 'mp3',
        hasAudio: true,
        subtitleTracks: [{ index: 2, language: 'zh', codec: 'subrip', default: true }],
        audioTracks: [{ index: 1, language: 'eng', codec: 'aac' }],
      };
    },
    async overview() {
      return {
        segments: [
          { startMs: 0, endMs: 30000, text: '第一句', source, origin: 'file' },
          { startMs: 30000, endMs: 60000, text: '第二句', source, origin: 'file' },
        ],
        images: [],
        transcript: { source, origin: source === 'asr' ? 'asr' : 'file', language: 'zh', provider: null, model: null },
        warnings: [...warnings],
      };
    },
    async zoom() {
      return { images: [], target: { kind: 'frame', atMs: 0, atSec: 0, selection: 'exact' }, warnings: [] };
    },
    async locate() {
      return {
        matches: [
          { rank: 1, score: 0.9, startMs: 0, endMs: 30000, text: '第一句', source, origin: 'file' },
        ],
        totalSegments: 2,
        transcript: { source, origin: source === 'asr' ? 'asr' : 'file' },
        frame: null,
        warnings: [...warnings],
      };
    },
  });
  return { video: makeBackend('video'), audio: makeBackend('audio'), document: makeBackend('document') };
}

async function withClient(workspace, fn, { backends = stubBackends() } = {}) {
  const server = createServer({
    config: workspace.config,
    backends,
    cache: workspace.cache,
    logger: SILENT_LOGGER,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('工具描述与 server instructions：字幕用中性措辞，没有「可安全引用」的绝对表述', async () => {
  for (const phrase of ABSOLUTE_PHRASES) {
    assert.ok(!phrase.test(SERVER_INSTRUCTIONS), `server instructions 不该出现 ${phrase}`);
  }
  assert.match(
    SERVER_INSTRUCTIONS,
    /"subtitle" comes from a subtitle file\/track; usually the\s+author's words, but may be auto-generated/,
  );

  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        for (const phrase of ABSOLUTE_PHRASES) {
          assert.ok(!phrase.test(tool.description), `${tool.name} 的描述不该出现 ${phrase}`);
        }
      }
      const overview = listed.tools.find((tool) => tool.name === 'media_overview');
      assert.match(
        overview.description,
        /subtitle = from a subtitle file\/track; usually the\s+author's words, but may be auto-generated/,
      );
    });
  } finally {
    await workspace.cleanup();
  }
});

test('media_overview：字幕来源用中性措辞的 note；没有滚动字幕时没有滚动警告', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.files.video, images: 0 },
      });
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      for (const phrase of ABSOLUTE_PHRASES) {
        assert.ok(!phrase.test(text), `overview 文本不该出现 ${phrase}`);
      }
      assert.match(text, /note: source is subtitle — from a subtitle file\/track/);
      assert.match(text, /but may be auto-generated: check names and numbers against the frame\./);
      assert.ok(!text.includes(ROLLING_SUBTITLE_WARNING), '没有滚动字幕时不该出现滚动警告');
    });
  } finally {
    await workspace.cleanup();
  }
});

test('media_overview：滚动字幕警告出现在 note 里', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.files.video, images: 0 },
      });
      assert.notEqual(result.isError, true);
      assert.ok(result.content[0].text.includes(ROLLING_SUBTITLE_WARNING));
    }, { backends: stubBackends({ warnings: [ROLLING_SUBTITLE_WARNING] }) });
  } finally {
    await workspace.cleanup();
  }
});

test('media_locate：滚动字幕警告出现在 warnings 里', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_locate',
        arguments: { path: workspace.files.video, query: '第一句' },
      });
      assert.notEqual(result.isError, true);
      assert.ok(result.structuredContent.warnings.includes(ROLLING_SUBTITLE_WARNING));
    }, { backends: stubBackends({ warnings: [ROLLING_SUBTITLE_WARNING] }) });
  } finally {
    await workspace.cleanup();
  }
});

test('media_locate：没有滚动字幕时 warnings 里不出现滚动警告', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_locate',
        arguments: { path: workspace.files.video, query: '第一句' },
      });
      assert.notEqual(result.isError, true);
      assert.ok(!(result.structuredContent.warnings ?? []).includes(ROLLING_SUBTITLE_WARNING));
    });
  } finally {
    await workspace.cleanup();
  }
});
