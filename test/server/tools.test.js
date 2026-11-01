// test/server/tools.test.js —— 5 个工具的参数校验、分派、返回信封与错误模型
//
// 用本地 stub 后端（不碰 ffmpeg / 网络），通过 InMemoryTransport 走完整 MCP 协议：
// listTools / callTool / notifications/progress 都是真实的 SDK 行为。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ToolError } from '../../src/media/interface.js';
import { createPlaceholderBackend } from '../../src/server/backends.js';
import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';

/* ------------------------------------------------------------------ *
 * 测试夹具
 * ------------------------------------------------------------------ */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-tools-'));
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
      return { sha256: 'b'.repeat(64), key: `sha256:${'b'.repeat(64)}` };
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

/** 造一个只记录调用的 stub 后端 */
function makeBackend(kind, overrides = {}) {
  const calls = [];
  const backend = {
    calls,
    async probe(input) {
      calls.push({ method: 'probe', input });
      if (kind === 'document') {
        return {
          mediaType: 'document',
          pageCount: 8,
          hasTextLayer: false,
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
        videoCodec: kind === 'video' ? 'h264' : null,
        audioCodec: 'aac',
        audioChannels: 2,
        sampleRateHz: 44100,
        hasAudio: true,
        subtitleTracks: [{ index: 2, language: 'zh', codec: 'subrip', default: true }],
        audioTracks: [{ index: 1, language: 'eng', codec: 'aac' }],
        capabilities: {
          asr: { available: true, provider: 'stub', reason: null },
          ocr: { available: false, provider: null, reason: 'ocr is not applicable to this media type.' },
          transcriptSource: 'subtitle',
          transcriptOrigin: 'file',
          transcriptPath: null,
        },
      };
    },
    async overview(input) {
      calls.push({ method: 'overview', input });
      if (kind === 'document') {
        return {
          segments: [
            { startMs: null, endMs: null, page: 3, text: 'page three text', source: 'ocr', origin: 'ocr' },
            { startMs: null, endMs: null, page: 4, text: 'page four text', source: 'ocr', origin: 'ocr' },
          ],
          images: [{ buffer: PNG, width: 1280, height: 720, cells: 6, index: 1 }],
          transcript: { source: 'ocr', origin: 'ocr', language: 'en', provider: 'mineru', model: 'stub' },
          warnings: [],
        };
      }
      if (kind === 'audio') {
        return {
          segments: [
            { startMs: 0, endMs: 4120, text: '第一段', source: 'asr', origin: 'asr' },
            { startMs: 4120, endMs: 9480, text: '第二段', source: 'asr', origin: 'asr' },
          ],
          images: input.envelope ? [{ buffer: PNG, width: 1280, height: 720, cells: 1, index: 1 }] : [],
          transcript: { source: 'asr', origin: 'asr', language: 'zh', provider: 'stub', model: 'stub-v1' },
          warnings: [],
        };
      }
      return {
        segments: [
          { startMs: 0, endMs: 30000, text: '第一句', source: 'subtitle', origin: 'file' },
          { startMs: 30000, endMs: 60000, text: '第二句', source: 'subtitle', origin: 'file' },
        ],
        images: [
          { buffer: PNG, width: 1280, height: 720, cells: 9, index: 1 },
          { buffer: PNG, width: 1280, height: 720, cells: 9, index: 2 },
        ],
        transcript: { source: 'subtitle', origin: 'file', language: 'zh', provider: null, model: null },
        warnings: [],
      };
    },
    async zoom(input) {
      calls.push({ method: 'zoom', input });
      return {
        images: [{ buffer: PNG, width: input.maxEdge ?? 1600, height: Math.round((input.maxEdge ?? 1600) / 1.777), cells: 1, index: 1 }],
        target: input.atMs !== undefined
          ? { kind: 'frame', atMs: input.atMs, atSec: input.atMs / 1000, selection: 'exact' }
          : undefined,
        warnings: [],
      };
    },
    async locate(input) {
      calls.push({ method: 'locate', input });
      return {
        matches: [
          { rank: 1, score: 0.92, startMs: 12480, endMs: 18900, text: '我们今天讲的是柏氏矢量', source: 'subtitle', origin: 'file' },
          { rank: 2, score: 0.61, startMs: 221100, endMs: 227260, text: '柏氏矢量这个概念', source: 'subtitle', origin: 'file' },
        ],
        totalSegments: 128,
        transcript: { source: 'subtitle', origin: 'file' },
        frame: input.includeFrame ? { buffer: PNG, width: 1280, height: 720, cells: 1, atMs: 12480 } : null,
        warnings: [],
      };
    },
    async subtitles(input) {
      calls.push({ method: 'subtitles', input });
      return {
        segments: [
          { startMs: 1200, endMs: 4560, text: '第一行字幕', source: 'subtitle', origin: 'file' },
          { startMs: 4560, endMs: 8100, text: '第二行字幕', source: 'subtitle', origin: 'file' },
        ],
        origin: 'file',
        sourcePath: '/abs/a.zh.srt',
        format: 'srt',
        language: 'zh',
        warnings: [],
      };
    },
  };
  return Object.assign(backend, overrides);
}

function stubBackends(overrides = {}) {
  return {
    video: makeBackend('video', overrides.video),
    audio: makeBackend('audio', overrides.audio),
    document: makeBackend('document', overrides.document),
  };
}

async function withClient(workspace, fn, { backends = stubBackends(), config = workspace.config, cache = workspace.cache } = {}) {
  const server = createServer({ config, backends, cache, logger: SILENT_LOGGER });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client, server);
  } finally {
    await client.close();
  }
}

function errorCode(result) {
  return result?.structuredContent?.error?.code ?? null;
}

/* ------------------------------------------------------------------ *
 * 工具目录
 * ------------------------------------------------------------------ */

test('listTools：5 个工具、描述带中文触发词、schema 完整', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), [
        'media_probe', 'media_overview', 'media_zoom', 'media_locate', 'video_subtitles',
      ]);
      const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));

      assert.match(byName.media_probe.description, /读取本地媒体/);
      assert.match(byName.media_overview.description, /生成媒体总览/);
      assert.match(byName.media_zoom.description, /取本地视频/);
      assert.match(byName.media_locate.description, /定位：/);
      assert.match(byName.video_subtitles.description, /读取本地字幕/);

      for (const tool of listed.tools) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.ok(tool.inputSchema.properties.path, `${tool.name} must declare path`);
        assert.deepEqual(
          tool.inputSchema.required,
          tool.name === 'media_locate' ? ['path', 'query'] : ['path'],
        );
      }

      assert.deepEqual(Object.keys(byName.media_overview.inputSchema.properties).sort(), [
        'cells', 'end', 'envelope', 'images', 'maxEdge', 'pages', 'path', 'segment', 'start', 'transcript', 'transcriptFile',
      ]);
      assert.deepEqual(Object.keys(byName.media_zoom.inputSchema.properties).sort(), [
        'at', 'crop', 'end', 'maxEdge', 'page', 'path', 'start',
      ]);
      assert.deepEqual(Object.keys(byName.media_locate.inputSchema.properties).sort(), [
        'end', 'includeFrame', 'max', 'pages', 'path', 'query', 'segment', 'start', 'transcript', 'transcriptFile',
      ]);

      // 参数 describe 里标注了适用媒体类型
      const overview = byName.media_overview.inputSchema.properties;
      assert.match(overview.pages.description, /document/);
      assert.match(overview.cells.description, /video and document/);
      assert.match(overview.envelope.description, /audio/);
      assert.match(byName.media_zoom.inputSchema.properties.at.description, /video/);
      assert.equal(byName.media_locate.inputSchema.required.join(','), 'path,query');
    });
  } finally {
    await workspace.cleanup();
  }
});

test('server instructions 从契约 §11.2 抄来，含关键约束', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const instructions = client.getInstructions();
      assert.match(instructions, /MultiMediaGrep gives you eyes and ears over LOCAL media files/);
      assert.match(instructions, /NEVER quote an\s+ASR segment/);
      assert.match(instructions, /at most 4 images, at most 16 cells per image/);
      assert.match(instructions, /"3-10,15"/);
      assert.match(instructions, /探媒体 \/ 视频 \/ 录音 \/ 文档 \/ 转写 \/ 字幕/);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 路径与错误模型
 * ------------------------------------------------------------------ */

test('media_probe：路径校验五步（契约 §2.4）', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const url = await client.callTool({ name: 'media_probe', arguments: { path: 'https://example.com/a.mp4' } });
      assert.equal(url.isError, true);
      assert.equal(errorCode(url), 'NOT_A_LOCAL_PATH');
      assert.match(url.content[0].text, /^NOT_A_LOCAL_PATH: path must be a local absolute file path; URLs are not accepted/);
      assert.match(url.content[0].text, /never downloads anything/);

      const fileUrl = await client.callTool({ name: 'media_probe', arguments: { path: 'file:///abs/a.mp4' } });
      assert.equal(errorCode(fileUrl), 'NOT_A_LOCAL_PATH');

      const relative = await client.callTool({ name: 'media_probe', arguments: { path: 'videos/a.mp4' } });
      assert.equal(errorCode(relative), 'INVALID_ARGUMENT');
      assert.match(relative.content[0].text, /must be an absolute local path/);

      const missing = await client.callTool({ name: 'media_probe', arguments: { path: '/definitely/not/here.mp4' } });
      assert.equal(errorCode(missing), 'PATH_NOT_FOUND');
      assert.match(missing.content[0].text, /^PATH_NOT_FOUND: path does not exist/);

      const directory = await client.callTool({ name: 'media_probe', arguments: { path: workspace.dir } });
      assert.equal(errorCode(directory), 'NOT_A_FILE');
    });
  } finally {
    await workspace.cleanup();
  }
});

test('后端未实现：占位后端返回 INTERNAL（不是崩溃）', async () => {
  const workspace = await makeWorkspace();
  try {
    const placeholders = {
      video: createPlaceholderBackend('video'),
      audio: createPlaceholderBackend('audio'),
      document: createPlaceholderBackend('document'),
    };
    await withClient(workspace, async (client) => {
      const result = await client.callTool({ name: 'media_probe', arguments: { path: workspace.files.video } });
      assert.equal(result.isError, true);
      assert.equal(errorCode(result), 'INTERNAL');
      assert.match(result.content[0].text, /^INTERNAL: video backend is not implemented yet\./);
      assert.match(result.structuredContent.error.hint, /src\/server\/README\.md/);

      const audio = await client.callTool({ name: 'media_probe', arguments: { path: workspace.files.audio } });
      assert.match(audio.content[0].text, /audio backend is not implemented yet/);
    }, { backends: placeholders });
  } finally {
    await workspace.cleanup();
  }
});

test('后端抛未知异常 → INTERNAL + stack 摘要；抛带码错误 → 原样透传', async () => {
  const workspace = await makeWorkspace();
  try {
    const backends = stubBackends({
      video: {
        async locate() {
          const error = new Error('boom inside the backend');
          throw error;
        },
      },
      audio: {
        async locate() {
          throw new ToolError('NO_TRANSCRIPT', 'no transcript available for this file and no ASR provider is configured (MMGREP_ASR_PROVIDER="none").');
        },
      },
    });
    await withClient(workspace, async (client) => {
      const crashed = await client.callTool({
        name: 'media_locate', arguments: { path: workspace.files.video, query: 'x' },
      });
      assert.equal(errorCode(crashed), 'INTERNAL');
      assert.match(crashed.structuredContent.error.stack, /Error: boom inside the backend/);

      const noTranscript = await client.callTool({
        name: 'media_locate', arguments: { path: workspace.files.audio, query: 'x' },
      });
      assert.equal(errorCode(noTranscript), 'NO_TRANSCRIPT');
      assert.match(noTranscript.content[0].text, /^NO_TRANSCRIPT: no transcript available/);
    }, { backends });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 参数 × 媒体适用性（契约 §2.2）
 * ------------------------------------------------------------------ */

test('不适用参数必须报契约原文案，不能静默忽略', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const cases = [
        ['media_overview', workspace.files.video, { pages: '3-5' },
          'pages is not applicable to video media. Use "start" and "end" (seconds) instead.'],
        ['media_overview', workspace.files.audio, { pages: '3-5' },
          'pages is not applicable to audio media. Use "start" and "end" (seconds) instead.'],
        ['media_overview', workspace.files.document, { start: 10 },
          'start is not applicable to document media. Use "pages" instead (e.g. pages: "3-10,15").'],
        ['media_overview', workspace.files.document, { end: 10 },
          'end is not applicable to document media. Use "pages" instead (e.g. pages: "3-10,15").'],
        ['media_overview', workspace.files.document, { segment: 60 },
          'segment is not applicable to document media.'],
        ['media_overview', workspace.files.audio, { cells: 9 },
          'cells is not applicable to audio media. A recording has no frames; media_overview returns a timestamped transcript instead.'],
        ['media_overview', workspace.files.audio, { images: 2 }, 'images is not applicable to audio media.'],
        ['media_overview', workspace.files.audio, { maxEdge: 1280 }, 'maxEdge is not applicable to audio media.'],
        ['media_overview', workspace.files.video, { envelope: true },
          'envelope is not applicable to video media. It only applies to audio recordings.'],
        ['media_overview', workspace.files.document, { transcriptFile: '/abs/a.srt' },
          'transcriptFile is not applicable to document media. Documents have a page text layer, not a transcript.'],
        ['media_overview', workspace.files.document, { transcript: 'off' },
          'transcript is not applicable to document media.'],
        ['media_locate', workspace.files.audio, { query: 'x', includeFrame: true },
          'includeFrame is not applicable to audio media. There are no frames to show.'],
        ['media_zoom', workspace.files.video, { at: 1, page: 3 },
          'page is not applicable to video media. media_zoom uses "at" (or "start"/"end") for video.'],
      ];
      for (const [tool, file, args, expected] of cases) {
        const result = await client.callTool({ name: tool, arguments: { path: file, ...args } });
        assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)} should fail`);
        assert.equal(errorCode(result), 'INVALID_ARGUMENT', `${tool} ${JSON.stringify(args)}`);
        assert.equal(result.structuredContent.error.message, expected, `${tool} ${JSON.stringify(args)}`);
      }
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * media_probe
 * ------------------------------------------------------------------ */

test('media_probe：结构化返回与文本形态', async () => {
  const workspace = await makeWorkspace();
  try {
    const backends = stubBackends();
    await withClient(workspace, async (client) => {
      const result = await client.callTool({ name: 'media_probe', arguments: { path: workspace.files.video } });
      assert.notEqual(result.isError, true);
      const data = result.structuredContent;
      assert.equal(data.mediaType, 'video');
      assert.equal(data.path, workspace.files.video);
      assert.equal(data.durationMs, 600000);
      assert.equal(data.durationSec, 600);
      assert.equal(data.hasAudio, true);
      assert.equal(data.subtitleTracks.length, 1);
      assert.equal(data.audioTracks.length, 1);
      assert.equal(data.capabilities.transcriptSource, 'subtitle');
      assert.equal(data.recommended.mode, 'single');
      assert.equal(data.recommended.segmentSec, 300);

      assert.equal(result.content.length, 1);
      const text = result.content[0].text;
      assert.match(text, /^<media path=".*a\.mp4" type="video" duration="600\.00" durationMs="600000" size="1920x1080" fps="25\.00"/);
      assert.match(text, /asr: available — provider "stub"\./);
      assert.match(text, /transcript source: subtitle/);

      assert.equal(backends.video.calls.length, 1);
      assert.equal(backends.video.calls[0].method, 'probe');
    }, { backends });
  } finally {
    await workspace.cleanup();
  }
});

test('media_probe：未配置 provider 时 capabilities 如实说不可用', async () => {
  const workspace = await makeWorkspace();
  try {
    const backends = stubBackends({
      video: {
        async probe(input) {
          return {
            mediaType: 'video',
            durationMs: 1000,
            durationSec: 1,
            hasAudio: true,
            subtitleTracks: [],
            audioTracks: [],
          };
        },
      },
    });
    await withClient(workspace, async (client) => {
      const result = await client.callTool({ name: 'media_probe', arguments: { path: workspace.files.video } });
      assert.equal(result.structuredContent.capabilities.asr.available, false);
      assert.match(result.structuredContent.capabilities.asr.reason, /MMGREP_ASR_PROVIDER is "none"/);
      assert.match(result.content[0].text, /asr: unavailable — MMGREP_ASR_PROVIDER is "none"\. Transcription will be empty\./);
      assert.match(result.content[0].text, /ocr: not applicable to this media type\./);
    }, { backends });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * media_overview
 * ------------------------------------------------------------------ */

test('media_overview（video）：先 text 后 image，全文落盘，budget 默认 2458', async () => {
  const workspace = await makeWorkspace();
  try {
    const backends = stubBackends();
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.files.video, start: 0, end: 300 },
      });
      assert.notEqual(result.isError, true);
      assert.equal(result.content[0].type, 'text');
      assert.equal(result.content[1].type, 'image');
      assert.equal(result.content[2].type, 'image');
      assert.equal(result.content[1].mimeType, 'image/png');

      const data = result.structuredContent;
      assert.equal(data.mediaType, 'video');
      assert.deepEqual(data.window.startMs, 0);
      assert.deepEqual(data.window.endMs, 300000);
      assert.equal(data.window.clipped, false);
      assert.equal(data.images.length, 2);
      assert.equal(data.images[0].cells, 9);
      assert.equal(data.images[0].estimatedTokens, 1229);
      assert.equal(data.images[0].source, 'visual');
      assert.equal(data.budget.requestedImages, 2);
      assert.equal(data.budget.producedImages, 2);
      assert.equal(data.budget.requestedCells, 18);
      assert.equal(data.budget.producedCells, 18);
      assert.equal(data.budget.estimatedTokens, 2458);
      assert.equal(data.budget.limit, 4000);
      assert.equal(data.transcript.source, 'subtitle');
      assert.equal(data.transcript.segmentCount, 2);
      assert.equal(data.segments.length, 2);
      assert.equal(data.segments[0].text, '第一句');
      assert.equal(data.truncated, false);

      // 全文落盘（契约 §9）
      assert.ok(data.fullText.contentMd.endsWith('content.md'));
      const contentMd = await readFile(data.fullText.contentMd, 'utf8');
      assert.match(contentMd, /第一句/);
      assert.match(contentMd, /transcript: subtitle/);
      const segmentsJsonl = await readFile(data.fullText.segmentsJsonl, 'utf8');
      assert.match(segmentsJsonl, /"text":"第一句"/);
      const manifest = JSON.parse(await readFile(data.fullText.manifestJson, 'utf8'));
      assert.equal(manifest.tool, 'media_overview');
      assert.equal(manifest.mediaType, undefined);
      assert.equal(manifest.source.mediaType, 'video');
      assert.equal(manifest.transcript.segmentCount, 2);

      // 续读提示：600 s 的媒体只读了 0-300
      assert.equal(data.continuation.nextStartMs, 300000);
      assert.equal(data.continuation.nextStartSec, 300);
      assert.match(data.continuation.note, /More media follows at 05:00\.000/);

      // 传给后端的形状是契约默认值
      const overviewCall = backends.video.calls.find((call) => call.method === 'overview');
      assert.deepEqual(
        { cells: overviewCall.input.cells, images: overviewCall.input.images, maxEdge: overviewCall.input.maxEdge },
        { cells: 9, images: 2, maxEdge: 1280 },
      );
      assert.equal(overviewCall.input.startMs, 0);
      assert.equal(overviewCall.input.endMs, 300000);

      // 文本清单形态（契约 §5.4）
      assert.match(result.content[0].text, /^<overview path=".*a\.mp4" type="video" window="0\.00-300\.00"/);
      assert.match(result.content[0].text, /\[cell 1\s*\] 00:00\.000-00:30\.000\s+\(subtitle\)\s+「第一句」/);
    }, { backends });
  } finally {
    await workspace.cleanup();
  }
});

test('media_overview：end 超出时长裁剪到末尾并标记 clipped', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.files.video, start: 500, end: 700 },
      });
      assert.equal(result.structuredContent.window.endMs, 600000);
      assert.equal(result.structuredContent.window.clipped, true);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('media_overview：范围/形状越界的契约错误', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const beyond = await client.callTool({
        name: 'media_overview', arguments: { path: workspace.files.video, start: 7200 },
      });
      assert.equal(errorCode(beyond), 'OUT_OF_RANGE');
      assert.equal(beyond.structuredContent.error.message, 'start (7200.0 s) is beyond the end of the media (duration 600.0 s).');

      const badEnd = await client.callTool({
        name: 'media_overview', arguments: { path: workspace.files.video, start: 30, end: 10 },
      });
      assert.equal(errorCode(badEnd), 'INVALID_ARGUMENT');
      assert.match(badEnd.content[0].text, /end must be greater than start/);

      const badSegment = await client.callTool({
        name: 'media_overview', arguments: { path: workspace.files.video, start: 10, segment: 5 },
      });
      assert.equal(badSegment.structuredContent.error.message, 'segment must be an integer between 30 and 3600 (seconds).');

      const tooManyCells = await client.callTool({
        name: 'media_overview', arguments: { path: workspace.files.video, cells: 25 },
      });
      assert.equal(errorCode(tooManyCells), 'BUDGET_EXCEEDED');
      assert.equal(tooManyCells.structuredContent.error.message, 'cells must be an integer between 1 and 16 (got 25).');

      const tooManyImages = await client.callTool({
        name: 'media_overview', arguments: { path: workspace.files.video, images: 5 },
      });
      assert.equal(errorCode(tooManyImages), 'BUDGET_EXCEEDED');
      assert.match(tooManyImages.content[0].text, /requested 5 images but the per-call limit is 4/);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('media_overview（document）：pages 解析、越界报错、按页文本', async () => {
  const workspace = await makeWorkspace();
  try {
    const backends = stubBackends();
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.files.document, pages: '3-4' },
      });
      assert.notEqual(result.isError, true);
      const data = result.structuredContent;
      assert.equal(data.mediaType, 'document');
      assert.deepEqual(data.window.pages, [3, 4]);
      assert.deepEqual(data.pages, [
        { page: 3, text: 'page three text', truncated: false },
        { page: 4, text: 'page four text', truncated: false },
      ]);
      assert.equal(data.transcript.source, 'ocr');
      assert.equal(data.images[0].cells, 6);
      assert.match(result.content[0].text, /^<overview path=".*a\.pdf" type="document" pages="3-4"/);
      assert.match(result.content[0].text, /\[page 3\s*\] \(ocr\)\s+「page three text」/);
      assert.equal(data.continuation.nextPage, 5);

      const overviewCall = backends.document.calls.find((call) => call.method === 'overview');
      assert.deepEqual(overviewCall.input.pages, [3, 4]);

      const outOfRange = await client.callTool({
        name: 'media_overview', arguments: { path: workspace.files.document, pages: '12-15' },
      });
      assert.equal(errorCode(outOfRange), 'OUT_OF_RANGE');
      assert.equal(outOfRange.structuredContent.error.message, 'pages out of range: 12-15. This document has 8 pages.');

      const invalid = await client.callTool({
        name: 'media_overview', arguments: { path: workspace.files.document, pages: 'abc' },
      });
      assert.equal(errorCode(invalid), 'INVALID_ARGUMENT');
      assert.match(invalid.content[0].text, /pages is invalid: "abc"/);
    }, { backends });
  } finally {
    await workspace.cleanup();
  }
});

test('media_overview（audio）：envelope 才出图，纯文本时 budget 为 0', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const plain = await client.callTool({ name: 'media_overview', arguments: { path: workspace.files.audio } });
      assert.notEqual(plain.isError, true);
      assert.equal(plain.content.length, 1);
      assert.equal(plain.structuredContent.images.length, 0);
      assert.equal(plain.structuredContent.budget.estimatedTokens, 0);
      assert.equal(plain.structuredContent.transcript.source, 'asr');
      assert.match(plain.content[0].text, /note: source is asr — machine transcription/);

      const withEnvelope = await client.callTool({
        name: 'media_overview', arguments: { path: workspace.files.audio, envelope: true },
      });
      assert.equal(withEnvelope.content.length, 2);
      assert.equal(withEnvelope.structuredContent.budget.estimatedTokens, 1229);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * media_zoom
 * ------------------------------------------------------------------ */

test('media_zoom（video）：at 精确取帧 / start+end 窗口 / 互斥与必填', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const at = await client.callTool({
        name: 'media_zoom', arguments: { path: workspace.files.video, at: 72.48 },
      });
      assert.notEqual(at.isError, true);
      assert.equal(at.content[0].type, 'text');
      assert.equal(at.content[1].type, 'image');
      assert.equal(at.structuredContent.imageCount, 1);
      assert.equal(at.structuredContent.target.kind, 'frame');
      assert.equal(at.structuredContent.target.atMs, 72480);
      assert.equal(at.structuredContent.target.atSec, 72.48);
      assert.equal(at.structuredContent.target.selection, 'exact');
      assert.equal(at.structuredContent.image.estimatedTokens, 1920);
      assert.match(at.content[0].text, /^<zoom path=".*a\.mp4" kind="frame" at="01:12\.480" atMs="72480" selection="exact" crop="full frame" image="1600x900"/);

      const windowed = await client.callTool({
        name: 'media_zoom', arguments: { path: workspace.files.video, start: 70, end: 75 },
      });
      assert.equal(windowed.structuredContent.target.selection, 'sharpest');
      assert.equal(windowed.structuredContent.target.fromMs, 70000);
      assert.equal(windowed.structuredContent.target.toMs, 75000);

      const mutex = await client.callTool({
        name: 'media_zoom', arguments: { path: workspace.files.video, at: 1, start: 0, end: 2 },
      });
      assert.equal(mutex.structuredContent.error.message, 'at and start/end are mutually exclusive — pass either a single timestamp or a window.');

      const neither = await client.callTool({
        name: 'media_zoom', arguments: { path: workspace.files.video },
      });
      assert.equal(neither.structuredContent.error.message, 'for video, pass "at" (one timestamp) or both "start" and "end" (a window).');

      const halfWindow = await client.callTool({
        name: 'media_zoom', arguments: { path: workspace.files.video, start: 10 },
      });
      assert.match(halfWindow.content[0].text, /pass "at" \(one timestamp\) or both "start" and "end"/);

      const beyond = await client.callTool({
        name: 'media_zoom', arguments: { path: workspace.files.video, at: 7200 },
      });
      assert.equal(errorCode(beyond), 'OUT_OF_RANGE');
      assert.equal(beyond.structuredContent.error.message, 'at (7200.0 s) is beyond the end of the media (duration 600.0 s).');
    });
  } finally {
    await workspace.cleanup();
  }
});

test('media_zoom（document / crop）：page 必填、越界、crop 校验', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const missingPage = await client.callTool({
        name: 'media_zoom', arguments: { path: workspace.files.document },
      });
      assert.equal(missingPage.structuredContent.error.message, 'page is required for document media.');

      const outOfRange = await client.callTool({
        name: 'media_zoom', arguments: { path: workspace.files.document, page: 15 },
      });
      assert.equal(errorCode(outOfRange), 'OUT_OF_RANGE');
      assert.equal(outOfRange.structuredContent.error.message, 'page 15 is out of range. This document has 8 pages.');

      const ok = await client.callTool({
        name: 'media_zoom',
        arguments: { path: workspace.files.document, page: 7, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.4 } },
      });
      assert.notEqual(ok.isError, true);
      assert.equal(ok.structuredContent.target.kind, 'page');
      assert.equal(ok.structuredContent.target.page, 7);
      assert.deepEqual(ok.structuredContent.target.crop, { x: 0.1, y: 0.1, width: 0.5, height: 0.4 });

      const badCrop = await client.callTool({
        name: 'media_zoom',
        arguments: { path: workspace.files.document, page: 1, crop: { x: 0.9, y: 0, width: 0.3, height: 0.2 } },
      });
      assert.equal(errorCode(badCrop), 'INVALID_ARGUMENT');
      assert.equal(badCrop.structuredContent.error.message, 'crop must satisfy 0 <= x, 0 <= y, x + width <= 1, y + height <= 1 (got x=0.9, width=0.3).');

      const partialCrop = await client.callTool({
        name: 'media_zoom',
        arguments: { path: workspace.files.document, page: 1, crop: { x: 0, y: 0, width: 1 } },
      });
      assert.equal(partialCrop.structuredContent.error.message, 'crop must be an object {x, y, width, height} with four numbers in 0..1.');
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * media_locate
 * ------------------------------------------------------------------ */

test('media_locate：query 必填、匹配文本、includeFrame 出图', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const missing = await client.callTool({
        name: 'media_locate', arguments: { path: workspace.files.video, query: '  ' },
      });
      assert.equal(missing.structuredContent.error.message, 'query is required.');

      const found = await client.callTool({
        name: 'media_locate', arguments: { path: workspace.files.video, query: '柏氏矢量' },
      });
      assert.notEqual(found.isError, true);
      assert.equal(found.structuredContent.mediaType, 'video');
      assert.equal(found.structuredContent.query, '柏氏矢量');
      assert.equal(found.structuredContent.transcriptSource, 'subtitle');
      assert.equal(found.structuredContent.transcriptOrigin, 'file');
      assert.equal(found.structuredContent.matches.length, 2);
      assert.equal(found.structuredContent.matches[0].rank, 1);
      assert.equal(found.structuredContent.matches[0].score, 0.92);
      assert.equal(found.structuredContent.matches[0].startSec, 12.48);
      assert.equal(found.structuredContent.totalSegments, 128);
      assert.equal(found.structuredContent.frame, null);
      assert.match(found.content[0].text, /^matches for "柏氏矢量" \(2 of 128 segments\):/);
      assert.match(found.content[0].text, /00:12\.480-00:18\.900  \(0\.92\)  「我们今天讲的是柏氏矢量」/);

      const framed = await client.callTool({
        name: 'media_locate', arguments: { path: workspace.files.video, query: '柏氏矢量', includeFrame: true },
      });
      assert.equal(framed.content.length, 2);
      assert.equal(framed.content[1].type, 'image');
      assert.equal(framed.structuredContent.frame.atMs, 12480);
      assert.equal(framed.structuredContent.frame.estimatedTokens, 1229);

      const noMatch = await client.callTool({
        name: 'media_locate',
        arguments: { path: workspace.files.video, query: '不存在的词' },
      });
      assert.notEqual(noMatch.isError, true);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('media_locate：零匹配不是错误（后端返回空数组）', async () => {
  const workspace = await makeWorkspace();
  try {
    const backends = stubBackends({
      video: {
        async locate() {
          return { matches: [], totalSegments: 128, transcript: { source: 'asr', origin: 'asr' }, warnings: [] };
        },
      },
    });
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_locate', arguments: { path: workspace.files.video, query: 'xxx' },
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent.matches, []);
      assert.equal(result.structuredContent.transcriptSource, 'asr');
      assert.equal(result.content[0].text, 'no line matched "xxx" among 128 transcript segments. Try shorter keywords, or a phrase that appears verbatim.');
    }, { backends });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * video_subtitles
 * ------------------------------------------------------------------ */

test('video_subtitles：字幕段落、时间窗、document 不适用', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'video_subtitles', arguments: { path: workspace.files.video },
      });
      assert.notEqual(result.isError, true);
      const data = result.structuredContent;
      assert.equal(data.source, 'subtitle');
      assert.equal(data.origin, 'file');
      assert.equal(data.format, 'srt');
      assert.equal(data.language, 'zh');
      assert.equal(data.segmentCount, 2);
      assert.equal(data.segments[0].startMs, 1200);
      assert.equal(data.segments[0].endSec, 4.56);
      assert.match(result.content[0].text, /^<subtitles path=".*a\.mp4" source="subtitle" origin="file" file="\/abs\/a\.zh\.srt" format="srt" language="zh" segments="2" \/>/);
      assert.match(result.content[0].text, /\[1\s+\] 00:01\.200-00:04\.560  \(subtitle\)  「第一行字幕」/);

      const pages = await client.callTool({
        name: 'video_subtitles', arguments: { path: workspace.files.video, pages: '1-3' },
      });
      assert.equal(pages.structuredContent.error.message, 'pages is not applicable to video media. Use "start" and "end" (seconds) instead.');

      const document = await client.callTool({
        name: 'video_subtitles', arguments: { path: workspace.files.document },
      });
      assert.equal(errorCode(document), 'INVALID_ARGUMENT');
      assert.match(document.content[0].text, /video_subtitles is not applicable to document media/);

      const missingFile = await client.callTool({
        name: 'video_subtitles', arguments: { path: workspace.files.video, transcriptFile: '/definitely/not/here.srt' },
      });
      assert.equal(errorCode(missingFile), 'PATH_NOT_FOUND');
      assert.equal(missingFile.structuredContent.error.message, 'transcriptFile does not exist: "/definitely/not/here.srt".');

      const badExt = await client.callTool({
        name: 'video_subtitles', arguments: { path: workspace.files.video, transcriptFile: '/abs/a.txt' },
      });
      assert.equal(errorCode(badExt), 'INVALID_ARGUMENT');
      assert.match(badExt.content[0].text, /transcriptFile must be one of \.srt, \.vtt, \.ass, \.ssa \(got "\.txt"\)\./);
    });
  } finally {
    await workspace.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 进度通知（契约 §2.6）
 * ------------------------------------------------------------------ */

test('media_overview：阻塞调用 + 带阶段与已用量的 progress notifications', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const events = [];
      const result = await client.callTool(
        { name: 'media_overview', arguments: { path: workspace.files.video, start: 0, end: 300 } },
        undefined,
        { onprogress: (event) => events.push(event) },
      );
      assert.notEqual(result.isError, true);
      assert.ok(events.length >= 3, `expected >= 3 progress events, got ${events.length}`);
      const messages = events.map((event) => event.message ?? '');
      assert.ok(messages.some((message) => /media_overview \d+\/5 · scanning 0-300s/.test(message)), messages.join(' | '));
      assert.ok(messages.some((message) => /media_overview \d+\/5 · transcribing/.test(message)), messages.join(' | '));
      assert.ok(messages.some((message) => /media_overview \d+\/5 · rendering 2 image\(s\)/.test(message)), messages.join(' | '));
      assert.ok(events.every((event) => Number.isFinite(event.progress) && Number.isFinite(event.total)));
    });
  } finally {
    await workspace.cleanup();
  }
});

test('media_probe：短任务不发 progress（best-effort）', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const events = [];
      await client.callTool(
        { name: 'media_probe', arguments: { path: workspace.files.video } },
        undefined,
        { onprogress: (event) => events.push(event) },
      );
      assert.deepEqual(events, []);
    });
  } finally {
    await workspace.cleanup();
  }
});
