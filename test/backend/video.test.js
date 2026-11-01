// test/backend/video.test.js —— 视频后端：probe / overview / zoom / locate / subtitles
//
// 全部使用 fixtures/generated 里的合成素材（无第三方媒体）。ffmpeg 不可用时整组跳过；
// 素材缺失时先跑 node fixtures/generate.mjs。每个用例用独立的 MMGREP_CACHE_DIR，
// 并检查 ASR 中间文件只落在缓存目录、没有写到用户素材旁边。

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createVideoBackend } from '../../src/backend/video/index.js';
import { assertFfmpegAvailable } from '../../src/media/ffmpeg.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = path.join(ROOT, 'fixtures', 'generated');
const SCENE = path.join(GENERATED, 'sample-scene.mp4');
const SUBTITLES = path.join(GENERATED, 'sample-subtitles.mp4');
const SRT = path.join(GENERATED, 'sample-subtitles.srt');
const ZOOM = path.join(GENERATED, 'sample-zoom.mp4');

async function hasFfmpeg() {
  try {
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
}

async function ensureFixtures() {
  try {
    await Promise.all([SCENE, SUBTITLES, SRT, ZOOM].map((file) => access(file)));
    return true;
  } catch {
    try {
      await execFileAsync(process.execPath, [path.join(ROOT, 'fixtures', 'generate.mjs')], { cwd: ROOT });
      return true;
    } catch {
      return false;
    }
  }
}

const ffmpegReady = await hasFfmpeg();
const fixturesReady = ffmpegReady ? await ensureFixtures() : false;
const skip = !(ffmpegReady && fixturesReady);

async function withCache(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-video-'));
  const previous = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function stubProvider({ text = 'STUB SPOKEN LINE', onCall = null } = {}) {
  const calls = [];
  const provider = {
    id: 'stub',
    describe: () => ({ id: 'stub', model: 'stub-model', baseUrl: null }),
    transcribe: async ({ audioPath }) => {
      calls.push(audioPath);
      onCall?.(audioPath);
      return {
        provider: 'stub',
        model: 'stub-model',
        language: 'en',
        segments: [{ startMs: 0, endMs: 900, text }],
      };
    },
  };
  return { provider, calls };
}

/** 会抛错的 ASR stub：用来证明某些模式下一次都不会被调用 */
function throwingProvider() {
  const calls = [];
  const provider = {
    id: 'stub',
    describe: () => ({ id: 'stub', model: 'stub-model', baseUrl: null }),
    transcribe: async ({ audioPath }) => {
      calls.push(audioPath);
      throw new Error('ASR MUST NOT BE CALLED');
    },
  };
  return { provider, calls };
}

function assertPng(buffer) {
  assert.ok(Buffer.isBuffer(buffer), 'image must be a Buffer');
  assert.equal(buffer.subarray(1, 4).toString('latin1'), 'PNG', 'image must be a real PNG');
}

/**
 * 统计 ffmpeg 子进程调用次数：把 MMGREP_FFMPEG_PATH 指向一个记账脚本，
 * 每次调用都往日志里追加一行。仓库里没有别的统计手段，用这个来证明
 * 「零像素模式没有走抽帧 / 镜头扫描路径」。
 */
async function installFfmpegCounter(dir) {
  const logPath = path.join(dir, 'ffmpeg-calls.log');
  const scriptPath = path.join(dir, 'ffmpeg-counter.sh');
  await writeFile(scriptPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nexec ffmpeg "$@"\n`, { mode: 0o755 });
  const previous = process.env.MMGREP_FFMPEG_PATH;
  process.env.MMGREP_FFMPEG_PATH = scriptPath;
  return {
    async calls() {
      try {
        return (await readFile(logPath, 'utf8')).split('\n').filter((line) => line.length > 0);
      } catch {
        return [];
      }
    },
    restore() {
      if (previous === undefined) delete process.env.MMGREP_FFMPEG_PATH;
      else process.env.MMGREP_FFMPEG_PATH = previous;
    },
  };
}

function longestEdge(image) {
  return Math.max(image.width, image.height);
}

function assertOverviewShape(result, { cells, images, maxEdge }) {
  assert.ok(result.images.length >= 1, 'at least one storyboard image');
  assert.ok(result.images.length <= images, `at most ${images} images`);
  let producedCells = 0;
  for (const image of result.images) {
    assert.ok(image.cells >= 1);
    assert.ok(image.cells <= cells, `at most ${cells} cells per image`);
    assert.ok(longestEdge(image) <= maxEdge, `longest edge <= ${maxEdge}`);
    assert.equal(image.mimeType, 'image/png');
    assertPng(image.buffer);
    producedCells += image.cells;
  }
  assert.equal(result.segments.length, producedCells, 'one text segment per cell');
}

test('probe：契约 §4.3 字段、音频体检、字幕与 ASR 能力', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createVideoBackend({ config: {} });
    const probe = await backend.probe({ path: SCENE, transcript: 'auto', transcriptFile: null });

    assert.equal(probe.mediaType, 'video');
    assert.equal(probe.path, SCENE);
    assert.equal(probe.width, 640);
    assert.equal(probe.height, 360);
    assert.ok(probe.durationSec > 11.9 && probe.durationSec < 12.1);
    assert.equal(probe.durationMs, 12000);
    assert.ok(Math.abs(probe.fps - 24) < 0.01);
    assert.equal(probe.rotation, 0);
    assert.ok(Math.abs(probe.aspect - 16 / 9) < 1e-6);
    assert.equal(probe.videoCodec, 'h264');
    assert.match(probe.container, /mp4/);
    assert.equal(probe.hasAudio, true);
    assert.equal(probe.audioCodec, 'aac');
    assert.equal(probe.audioChannels, 1);
    assert.equal(probe.sampleRateHz, 44100);
    assert.equal(probe.audioHealth.verdict, 'has-speech');
    assert.equal(probe.audioHealth.effective, true);
    assert.equal(probe.pageCount, null);
    assert.equal(probe.hasTextLayer, null);
    assert.deepEqual(probe.subtitleTracks, []);
    assert.equal(probe.audioTracks.length, 1);
    assert.equal(probe.capabilities.asr.available, false);
    assert.equal(probe.capabilities.asr.provider, null);
    assert.equal(probe.capabilities.ocr.available, false);
    assert.equal(probe.capabilities.transcriptSource, 'none');
    assert.equal(probe.capabilities.transcriptOrigin, 'none');
    assert.equal(probe.capabilities.transcriptPath, null);
    assert.ok(probe.recommended && probe.recommended.mode);

    const sibling = await backend.probe({ path: SUBTITLES, transcript: 'auto', transcriptFile: null });
    assert.equal(sibling.capabilities.transcriptSource, 'subtitle');
    assert.equal(sibling.capabilities.transcriptOrigin, 'file');
    assert.equal(sibling.capabilities.transcriptPath, SRT);

    const stub = stubProvider();
    const withAsr = createVideoBackend({ config: {}, asrProvider: stub.provider });
    const asrProbe = await withAsr.probe({ path: SCENE, transcript: 'auto', transcriptFile: null });
    assert.equal(asrProbe.capabilities.asr.available, true);
    assert.equal(asrProbe.capabilities.asr.provider, 'stub');
    assert.equal(asrProbe.capabilities.transcriptSource, 'asr');
    assert.equal(asrProbe.capabilities.transcriptOrigin, 'asr');
    assert.equal(stub.calls.length, 0, 'probe must not run ASR');
  });
});

test('overview：cells/images/maxEdge 上限、PNG buffer、无转写时只出画面', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createVideoBackend({ config: {} });
    const result = await backend.overview({
      path: SCENE,
      startMs: 0,
      endMs: 12000,
      cells: 4,
      images: 2,
      maxEdge: 640,
      transcript: 'off',
      transcriptFile: null,
    });
    assertOverviewShape(result, { cells: 4, images: 2, maxEdge: 640 });
    assert.equal(result.images.length, 2, '12s window has enough room for 4 cells x 2 images');
    assert.equal(result.segments[0].startMs, 0);
    assert.equal(result.segments.at(-1).endMs, 12000);
    assert.ok(result.segments.every((segment) => segment.text === ''));
    assert.ok(result.segments.every((segment) => segment.source === 'none' && segment.origin === 'none'));
    assert.equal(result.transcript.source, 'none');
    assert.equal(result.transcript.origin, 'none');
    assert.ok(result.transcript.reason);
    assert.ok(result.warnings.includes('transcript-disabled'));
    assert.ok(result.images.every((image) => longestEdge(image) <= 640));
  });
});

test('overview：startMs/endMs 精确覆盖窗口', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createVideoBackend({ config: {} });
    const result = await backend.overview({
      path: SCENE,
      startMs: 2000,
      endMs: 8000,
      cells: 4,
      images: 1,
      maxEdge: 640,
      transcript: 'off',
      transcriptFile: null,
    });
    assertOverviewShape(result, { cells: 4, images: 1, maxEdge: 640 });
    assert.equal(result.segments[0].startMs, 2000);
    assert.equal(result.segments.at(-1).endMs, 8000);
    assert.ok(result.segments.every((segment) => segment.startMs >= 2000 && segment.endMs <= 8000));
  });
});

test('overview：字幕优先——sibling 自动发现、显式 transcriptFile 胜出，且不调用 ASR', { skip, timeout: 120000 }, async () => {
  await withCache(async (dir) => {
    const stub = stubProvider({ text: 'ASR SHOULD NOT RUN' });
    const backend = createVideoBackend({ config: {}, asrProvider: stub.provider });

    const sibling = await backend.overview({
      path: SUBTITLES,
      startMs: 0,
      endMs: 12000,
      cells: 4,
      images: 2,
      maxEdge: 640,
      transcript: 'auto',
      transcriptFile: null,
    });
    assertOverviewShape(sibling, { cells: 4, images: 2, maxEdge: 640 });
    assert.equal(stub.calls.length, 0, 'ASR must not run when a sibling subtitle exists');
    assert.equal(sibling.transcript.source, 'subtitle');
    assert.equal(sibling.transcript.origin, 'file');
    assert.equal(sibling.transcript.file, SRT);
    assert.ok(sibling.segments.some((segment) => /FIRST SUBTITLE LINE/.test(segment.text)));
    assert.ok(sibling.segments.some((segment) => /FOURTH SUBTITLE LINE/.test(segment.text)));
    assert.ok(sibling.segments.every((segment) => segment.source === 'subtitle' && segment.origin === 'file'));

    const explicit = path.join(dir, 'explicit.srt');
    await writeFile(explicit, '1\n00:00:00,000 --> 00:00:12,000\nEXPLICIT TRANSCRIPT LINE\n');
    const explicitResult = await backend.overview({
      path: SUBTITLES,
      startMs: 0,
      endMs: 12000,
      cells: 2,
      images: 1,
      maxEdge: 640,
      transcript: 'auto',
      transcriptFile: explicit,
    });
    assert.equal(stub.calls.length, 0);
    assert.equal(explicitResult.transcript.source, 'subtitle');
    assert.equal(explicitResult.transcript.file, explicit);
    assert.ok(explicitResult.segments.some((segment) => /EXPLICIT TRANSCRIPT LINE/.test(segment.text)));
    assert.ok(explicitResult.segments.every((segment) => !/FIRST SUBTITLE LINE/.test(segment.text)));
  });
});

test('overview：无字幕时 ASR 兜底，段落标 source/origin=asr，中间文件只在缓存目录', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const stub = stubProvider();
    const backend = createVideoBackend({ config: {}, asrProvider: stub.provider });
    const result = await backend.overview({
      path: SCENE,
      startMs: 0,
      endMs: 12000,
      cells: 4,
      images: 1,
      maxEdge: 640,
      transcript: 'auto',
      transcriptFile: null,
    });
    assertOverviewShape(result, { cells: 4, images: 1, maxEdge: 640 });
    assert.equal(stub.calls.length, 1, '12s audio fits in one ASR chunk');
    const cacheRoot = process.env.MMGREP_CACHE_DIR;
    assert.ok(stub.calls[0].startsWith(cacheRoot), 'ASR temp chunk must live under MMGREP_CACHE_DIR');
    assert.ok(!stub.calls[0].startsWith(path.dirname(SCENE)), 'nothing may be written next to the input');
    assert.equal(result.transcript.source, 'asr');
    assert.equal(result.transcript.origin, 'asr');
    assert.equal(result.transcript.provider, 'stub');
    assert.equal(result.transcript.model, 'stub-model');
    assert.ok(result.segments.every((segment) => segment.source === 'asr' && segment.origin === 'asr'));
    assert.ok(result.segments.some((segment) => /STUB SPOKEN LINE/.test(segment.text)));
  });
});

test('overview：transcript="subtitle" 只读字幕，无字幕时返回空结果且绝不调用 ASR', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const stub = throwingProvider();
    const backend = createVideoBackend({ config: {}, asrProvider: stub.provider });

    const withSubs = await backend.overview({
      path: SUBTITLES,
      startMs: 0,
      endMs: 12000,
      cells: 4,
      images: 1,
      maxEdge: 640,
      transcript: 'subtitle',
      transcriptFile: null,
    });
    assert.equal(stub.calls.length, 0);
    assert.equal(withSubs.transcript.source, 'subtitle');
    assert.equal(withSubs.transcript.origin, 'file');
    assert.ok(withSubs.segments.some((segment) => /FIRST SUBTITLE LINE/.test(segment.text)));

    const noSubs = await backend.overview({
      path: SCENE,
      startMs: 0,
      endMs: 12000,
      cells: 4,
      images: 1,
      maxEdge: 640,
      transcript: 'subtitle',
      transcriptFile: null,
    });
    assert.equal(stub.calls.length, 0, 'subtitle mode must never call ASR');
    // 视频 overview 的 segments 是宫格单元；没有字幕时每格 text 为空、来源 none。
    assert.ok(noSubs.segments.every((segment) => segment.text === '' && segment.source === 'none'));
    assert.equal(noSubs.transcript.source, 'none');
    assert.match(noSubs.transcript.reason, /no subtitle source/i);
    assert.ok(noSubs.warnings.includes('no-subtitle-source'));
  });
});

test('overview：transcript="off" 不读字幕也不跑 ASR', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const stub = throwingProvider();
    const backend = createVideoBackend({ config: {}, asrProvider: stub.provider });
    // SUBTITLES 自带字幕来源；off 必须连字幕都不读。
    const result = await backend.overview({
      path: SUBTITLES,
      startMs: 0,
      endMs: 12000,
      cells: 4,
      images: 1,
      maxEdge: 640,
      transcript: 'off',
      transcriptFile: null,
    });
    assert.equal(stub.calls.length, 0);
    assert.ok(result.segments.every((segment) => segment.text === '' && segment.source === 'none'));
    assert.equal(result.transcript.source, 'none');
    assert.equal(result.transcript.origin, 'none');
    assert.match(result.transcript.reason, /disabled/i);
    assert.ok(result.warnings.includes('transcript-disabled'));
  });
});

test('overview：images: 0 是零像素纯文本模式——不出图、不扫镜头、不抽帧', { skip, timeout: 120000 }, async () => {
  await withCache(async (dir) => {
    const counter = await installFfmpegCounter(dir);
    try {
      const backend = createVideoBackend({ config: {} });
      const result = await backend.overview({
        path: SUBTITLES,
        startMs: 0,
        endMs: 12000,
        cells: 4,
        images: 0,
        maxEdge: 640,
        transcript: 'subtitle',
        transcriptFile: null,
      });

      assert.equal(result.images.length, 0, '零像素模式不得出图');
      assert.ok(result.segments.length > 0, '仍要回字幕段落');
      assert.ok(result.segments.some((segment) => /FIRST SUBTITLE LINE/.test(segment.text)));
      assert.ok(result.segments.some((segment) => /FOURTH SUBTITLE LINE/.test(segment.text)));
      assert.ok(result.segments.every((segment) => segment.source === 'subtitle' && segment.origin === 'file'));
      assert.ok(result.segments.every((segment) => segment.startMs !== null && segment.endMs !== null));
      assert.ok(result.segments.every((segment) => segment.startMs >= 0 && segment.endMs <= 12000));
      assert.equal(result.transcript.source, 'subtitle');
      assert.equal(result.transcript.origin, 'file');

      // 关键断言：镜头扫描与抽帧都要跑 ffmpeg，这里一次都不许跑。
      const calls = await counter.calls();
      assert.deepEqual(calls, [], `零像素模式不得调用 ffmpeg（镜头扫描 / 抽帧），实际调用：\n${calls.join('\n')}`);

      // 对照组：images: 1 时确实会跑 ffmpeg —— 说明上面的计数是真的在数。
      const withImage = await backend.overview({
        path: SUBTITLES,
        startMs: 0,
        endMs: 12000,
        cells: 4,
        images: 1,
        maxEdge: 640,
        transcript: 'subtitle',
        transcriptFile: null,
      });
      assert.equal(withImage.images.length, 1);
      assert.ok((await counter.calls()).length > 0, '对照组必须记录到 ffmpeg 调用，否则计数没生效');
    } finally {
      counter.restore();
    }
  });
});

test('overview：images: 0 与 transcript="subtitle" 组合——零像素、零 ASR', { skip, timeout: 120000 }, async () => {
  await withCache(async (dir) => {
    const counter = await installFfmpegCounter(dir);
    try {
      const stub = throwingProvider();
      const backend = createVideoBackend({ config: {}, asrProvider: stub.provider });
      const result = await backend.overview({
        path: SUBTITLES,
        startMs: 0,
        endMs: 12000,
        cells: 4,
        images: 0,
        maxEdge: 640,
        transcript: 'subtitle',
        transcriptFile: null,
      });

      assert.equal(stub.calls.length, 0, '零像素模式不得触发 ASR');
      assert.equal(result.images.length, 0);
      assert.ok(result.segments.some((segment) => /FIRST SUBTITLE LINE/.test(segment.text)));
      assert.deepEqual(await counter.calls(), [], '零像素 + 字幕模式不得调用 ffmpeg');
    } finally {
      counter.restore();
    }
  });
});

test('overview：images: 0 时窗口仍然生效，超窗段落被过滤掉', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createVideoBackend({ config: {} });
    const result = await backend.overview({
      path: SUBTITLES,
      startMs: 3000,
      endMs: 6000,
      cells: 4,
      images: 0,
      maxEdge: 640,
      transcript: 'subtitle',
      transcriptFile: null,
    });

    assert.equal(result.images.length, 0);
    assert.ok(result.segments.length > 0);
    assert.ok(result.segments.every((segment) => segment.startMs >= 3000 && segment.endMs <= 6000));
    assert.ok(result.segments.some((segment) => /SECOND SUBTITLE LINE/.test(segment.text)));
    assert.ok(result.segments.every((segment) => !/FIRST SUBTITLE LINE/.test(segment.text)));
  });
});

test('probe：transcript 三值让 capabilities.asr 与 transcriptSource 如实变化', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const stub = throwingProvider();
    const backend = createVideoBackend({ config: {}, asrProvider: stub.provider });

    const auto = await backend.probe({ path: SCENE, transcript: 'auto', transcriptFile: null });
    assert.equal(auto.capabilities.asr.available, true);
    assert.equal(auto.capabilities.transcriptSource, 'asr');

    const subtitleMode = await backend.probe({ path: SCENE, transcript: 'subtitle', transcriptFile: null });
    assert.equal(subtitleMode.capabilities.asr.available, false);
    assert.match(subtitleMode.capabilities.asr.reason, /subtitle/i);
    assert.equal(subtitleMode.capabilities.transcriptSource, 'none');

    const subtitlePresent = await backend.probe({ path: SUBTITLES, transcript: 'subtitle', transcriptFile: null });
    assert.equal(subtitlePresent.capabilities.asr.available, false);
    assert.equal(subtitlePresent.capabilities.transcriptSource, 'subtitle');
    assert.equal(subtitlePresent.capabilities.transcriptOrigin, 'file');

    const off = await backend.probe({ path: SUBTITLES, transcript: 'off', transcriptFile: null });
    assert.equal(off.capabilities.asr.available, false);
    assert.match(off.capabilities.asr.reason, /disabled/i);
    assert.equal(off.capabilities.transcriptSource, 'none');
    assert.equal(off.capabilities.transcriptOrigin, 'none');
    assert.equal(off.capabilities.transcriptPath, null);
    assert.equal(stub.calls.length, 0, 'probe never runs ASR');
  });
});

test('zoom：at 精确帧返回一张 PNG 与 target 时间戳', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createVideoBackend({ config: {} });
    const result = await backend.zoom({
      path: ZOOM,
      atMs: 1500,
      atSec: 1.5,
      selection: 'exact',
      maxEdge: 640,
      crop: null,
    });
    assert.equal(result.images.length, 1);
    assertPng(result.images[0].buffer);
    assert.equal(result.images[0].cells, 1);
    assert.ok(longestEdge(result.images[0]) <= 640);
    assert.equal(result.target.kind, 'frame');
    assert.equal(result.target.selection, 'exact');
    assert.equal(result.target.atMs, 1500);
    assert.equal(result.target.fromMs, null);
    assert.equal(result.target.toMs, null);
    assert.equal(result.target.page, null);
    assert.equal(result.target.crop, null);
  });
});

test('zoom：start/end 窗口选最清晰帧，target 报告窗口与时刻', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createVideoBackend({ config: {} });
    const result = await backend.zoom({
      path: ZOOM,
      startMs: 1000,
      endMs: 3000,
      selection: 'sharpest',
      maxEdge: 640,
      crop: null,
    });
    assert.equal(result.images.length, 1);
    assertPng(result.images[0].buffer);
    assert.equal(result.target.kind, 'frame');
    assert.equal(result.target.selection, 'sharpest');
    assert.equal(result.target.fromMs, 1000);
    assert.equal(result.target.toMs, 3000);
    assert.ok(result.target.atMs >= 1000 && result.target.atMs <= 3000);
    assert.ok(result.target.atSec >= 1 && result.target.atSec <= 3);
  });
});

test('zoom：crop 在缩放后裁切，输出尺寸与比例一致', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createVideoBackend({ config: {} });
    const crop = { x: 30 / 640, y: 135 / 360, width: 120 / 640, height: 70 / 360 };
    const result = await backend.zoom({
      path: ZOOM,
      atMs: 1500,
      selection: 'exact',
      maxEdge: 640,
      crop,
    });
    assert.equal(result.images.length, 1);
    assertPng(result.images[0].buffer);
    assert.equal(result.images[0].width, 120);
    assert.equal(result.images[0].height, 70);
    assert.deepEqual(result.target.crop, crop);
  });
});

test('locate：字幕匹配、来源标注、includeFrame 单帧', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createVideoBackend({ config: {} });
    const result = await backend.locate({
      path: SUBTITLES,
      query: 'SECOND SUBTITLE',
      max: 5,
      startMs: 0,
      endMs: 12000,
      transcript: 'auto',
      transcriptFile: null,
      includeFrame: true,
    });
    assert.ok(result.matches.length >= 1);
    assert.equal(result.matches[0].rank, 1);
    assert.equal(result.matches[0].source, 'subtitle');
    assert.equal(result.matches[0].origin, 'file');
    assert.ok(result.matches[0].startMs >= 3000 && result.matches[0].startMs < 6000);
    assert.equal(result.totalSegments, 4);
    assert.equal(result.transcript.source, 'subtitle');
    assert.ok(result.frame?.buffer);
    assertPng(result.frame.buffer);
    assert.equal(result.frame.atMs, result.matches[0].startMs);
    assert.ok(longestEdge(result.frame) <= 1600);

    const windowed = await backend.locate({
      path: SUBTITLES,
      query: 'SUBTITLE',
      max: 5,
      startMs: 6000,
      endMs: 9000,
      transcript: 'auto',
      transcriptFile: null,
      includeFrame: false,
    });
    assert.equal(windowed.totalSegments, 1);
    assert.ok(windowed.matches.length >= 1);
    assert.ok(windowed.matches.every((match) => match.startMs >= 6000 && match.endMs <= 9000));
    assert.ok(windowed.matches.every((match) => /THIRD SUBTITLE LINE/.test(match.text)));
  });
});

test('locate：没有任何转写来源 → NO_TRANSCRIPT（契约 §7.5 文案）', { skip, timeout: 120000 }, async () => {
  await withCache(async () => {
    const backend = createVideoBackend({ config: {} });
    await assert.rejects(
      () => backend.locate({
        path: SCENE,
        query: 'anything',
        max: 5,
        startMs: 0,
        endMs: 12000,
        transcript: 'auto',
        transcriptFile: null,
        includeFrame: false,
      }),
      (error) => error.code === 'NO_TRANSCRIPT'
        && /^no transcript available for this file and no ASR provider is configured \(MMGREP_ASR_PROVIDER="none"\)\./.test(error.message)
        && /Pass transcriptFile with a local \.srt\/\.vtt file, or configure an ASR provider\./.test(error.message),
    );
  });
});

test('subtitles：sibling 文件、窗口过滤、显式文件；无字幕来源 → NO_TRANSCRIPT（契约 §8.6）', { skip, timeout: 120000 }, async () => {
  await withCache(async (dir) => {
    const backend = createVideoBackend({ config: {} });
    const clipped = await backend.subtitles({
      path: SUBTITLES,
      startMs: 3000,
      endMs: 6000,
      transcriptFile: null,
    });
    assert.equal(clipped.origin, 'file');
    assert.equal(clipped.sourcePath, SRT);
    assert.equal(clipped.format, 'srt');
    assert.equal(clipped.segments.length, 1);
    assert.equal(clipped.segments[0].index, 1);
    assert.equal(clipped.segments[0].source, 'subtitle');
    assert.equal(clipped.segments[0].origin, 'file');
    assert.match(clipped.segments[0].text, /SECOND SUBTITLE LINE/);

    const explicit = path.join(dir, 'picked.vtt');
    await writeFile(explicit, 'WEBVTT\n\n00:00:00.000 --> 00:00:12.000\nEXPLICIT VTT LINE\n');
    const picked = await backend.subtitles({
      path: SUBTITLES,
      startMs: 0,
      endMs: 12000,
      transcriptFile: explicit,
    });
    assert.equal(picked.origin, 'file');
    assert.equal(picked.sourcePath, explicit);
    assert.equal(picked.format, 'vtt');
    assert.ok(picked.segments.some((segment) => /EXPLICIT VTT LINE/.test(segment.text)));

    await assert.rejects(
      () => backend.subtitles({ path: SCENE, transcriptFile: null }),
      (error) => error.code === 'NO_TRANSCRIPT'
        && error.message === `no subtitle source for "${SCENE}": no embedded subtitle track, `
          + 'no sibling .srt/.vtt/.ass/.ssa file, and no ASR provider configured. '
          + 'Pass transcriptFile with a local subtitle file.',
    );
  });
});
