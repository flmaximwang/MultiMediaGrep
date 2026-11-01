// test/backend/audio.test.js —— 录音后端：切片规划、合并去重、体检、probe/overview/zoom/locate
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createAudioBackend, computeAudioHealth } from '../../src/backend/audio/index.js';
import { mergeTranscripts, planChunks } from '../../src/backend/audio/chunks.js';
import { matchSegments, splitIntoSentences } from '../../src/media/match.js';
import { assertFfmpegAvailable, run } from '../../src/media/ffmpeg.js';

async function hasFfmpeg() {
  try {
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
}

const fixtured = await hasFfmpeg();
const skip = !fixtured;

/** 生成一段 30s 的「有声 + 静音」音频：0-10s 音调，10-12s 静音，12-30s 音调 */
async function makeAudio(dir, name, expr, durationSec) {
  const out = path.join(dir, name);
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `aevalsrc=${expr}:d=${durationSec}:s=16000`,
    out,
  ]);
  return out;
}

test('planChunks：短音频一片；长音频在静音中点切；无静音则硬切并加重叠', () => {
  assert.equal(planChunks({ durationSec: 30 }).length, 1);

  const withSilence = planChunks({
    durationSec: 120,
    silences: [
      { startSec: 44, endSec: 46 },
      { startSec: 88, endSec: 90 },
    ],
  });
  assert.ok(withSilence.length >= 3);
  const cuts = withSilence.filter((c) => c.cut === 'silence');
  assert.ok(cuts.length >= 2, JSON.stringify(withSilence));
  assert.equal(cuts[0].endSec, 45);
  assert.equal(cuts[1].endSec, 89);
  assert.ok(withSilence.every((c) => c.durationSec <= 60.001));

  const hard = planChunks({ durationSec: 100 });
  assert.ok(hard.length >= 2);
  assert.equal(hard[0].cut, 'hard');
  assert.equal(hard[0].endSec, 45);
  assert.equal(hard[1].startSec, 44.75);
  assert.equal(hard[0].overlapSec, 0.25);
  assert.equal(hard[1].overlapSec, 0, '收尾片不再需要重叠');
});

test('mergeTranscripts：偏移回填与重叠去重', () => {
  // 硬切重叠：第一片 0–45s，第二片从 44.75s 起，同一句在两个片里各出现一次
  const merged = mergeTranscripts([
    { startSec: 0, segments: [{ startMs: 0, endMs: 2000, text: '开头第一句' }, { startMs: 43000, endMs: 45000, text: '结尾句' }] },
    { startSec: 44.75, segments: [{ startMs: 0, endMs: 1200, text: '结尾句' }, { startMs: 1500, endMs: 3000, text: '跨片之后' }] },
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged[1].startMs, 43000);
  assert.equal(merged[2].startMs, 46250);
  assert.equal(merged[2].text, '跨片之后');
  // 重复的「结尾句」被合并，结束时间取更晚的
  assert.equal(merged[1].endMs, 45950);
});

test('computeAudioHealth：has-speech / too-quiet / silent 三档', () => {
  const loud = computeAudioHealth({ levels: { meanDbfs: -20, peakDbfs: -1 }, silences: [], durationSec: 10 });
  assert.equal(loud.verdict, 'has-speech');
  assert.equal(loud.effective, true);
  assert.equal(loud.speechRatio, 1);

  const quiet = computeAudioHealth({ levels: { meanDbfs: -50, peakDbfs: -30 }, silences: [], durationSec: 10 });
  assert.equal(quiet.verdict, 'too-quiet');
  assert.equal(quiet.effective, false);

  const silent = computeAudioHealth({ levels: { meanDbfs: -80, peakDbfs: -70 }, silences: [], durationSec: 10 });
  assert.equal(silent.verdict, 'silent');

  const mostlySilent = computeAudioHealth({
    levels: { meanDbfs: -20, peakDbfs: -1 },
    silences: [{ startSec: 0, endSec: 9.8, durationSec: 9.8 }],
    durationSec: 10,
  });
  assert.equal(mostlySilent.verdict, 'too-quiet');
  assert.ok(mostlySilent.speechRatio < 0.05);
});

test('matchSegments / splitIntoSentences：中文短语与分词打分', () => {
  const segments = [
    { startMs: 0, endMs: 3000, text: '今天我们讨论柏氏矢量与位错运动。' },
    { startMs: 3000, endMs: 6000, text: '下一段讲别的东西。' },
  ];
  const exact = matchSegments(segments, '柏氏矢量');
  assert.equal(exact.length, 1);
  assert.equal(exact[0].score, 1);
  assert.equal(matchSegments(segments, '不相关的词').length, 0);

  const parts = splitIntoSentences(segments[0]);
  assert.equal(parts.length, 1);
  const long = splitIntoSentences({ startMs: 0, endMs: 10000, text: '第一句。第二句！第三句？' });
  assert.equal(long.length, 3);
  assert.equal(long[0].startMs, 0);
  assert.equal(long[2].endMs, 10000);
});

test('后端 probe/overview/zoom/locate：字幕文件路径', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-audio-'));
  const prevCache = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  try {
    const audio = await makeAudio(dir, 'tone.wav', '0.5*sin(2*PI*440*t)', 12);
    const srt = path.join(dir, 'tone.srt');
    await writeFile(srt, `1
00:00:00,000 --> 00:00:03,000
开场第一句

2
00:00:03,000 --> 00:00:06,000
柏氏矢量是位错理论的核心
`);

    const backend = createAudioBackend({ config: {} });

    const probe = await backend.probe({ path: audio });
    assert.equal(probe.mediaType, 'audio');
    assert.ok(probe.durationSec > 11 && probe.durationSec < 13);
    assert.equal(probe.hasAudio, true);
    // 同目录的 tone.srt 被自动发现（契约 §8.5），字幕优先于 ASR
    assert.equal(probe.capabilities.transcriptSource, 'subtitle');
    assert.equal(probe.capabilities.transcriptOrigin, 'file');
    assert.equal(probe.capabilities.transcriptPath, srt);
    assert.equal(probe.capabilities.asr.available, false); // 没配 ASR
    assert.equal(probe.audioHealth.verdict, 'has-speech');

    const overview = await backend.overview({ path: audio, transcriptFile: srt, envelope: true });
    assert.equal(overview.segments.length, 2);
    assert.equal(overview.segments[0].source, 'subtitle');
    assert.equal(overview.segments[0].origin, 'file');
    assert.equal(overview.transcript.source, 'subtitle');
    assert.ok(overview.images.length >= 1);
    assert.ok(Buffer.isBuffer(overview.images[0].buffer), '图片必须带 buffer 交给 MCP 层');
    assert.equal(overview.images[0].width, 1200);

    const subs = await backend.subtitles({ path: audio, transcriptFile: srt });
    assert.equal(subs.segments.length, 2);
    assert.equal(subs.format, 'srt');
    assert.equal(subs.sourcePath, srt);
    assert.equal(subs.segments[1].source, 'subtitle');
    const clipped = await backend.subtitles({ path: audio, transcriptFile: srt, startMs: 3000, endMs: 6000 });
    assert.equal(clipped.segments.length, 1);
    assert.match(clipped.segments[0].text, /柏氏矢量/);

    const bare = await makeAudio(dir, 'bare.wav', '0.5*sin(2*PI*440*t)', 3);
    await assert.rejects(
      () => backend.subtitles({ path: bare }),
      (e) => e.code === 'NO_TRANSCRIPT' && /no subtitle source/.test(e.message),
    );

    const locate = await backend.locate({ path: audio, transcriptFile: srt, query: '位错理论' });
    assert.equal(locate.matches.length, 1);
    assert.equal(locate.matches[0].startMs, 3000);
  } finally {
    if (prevCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = prevCache;
    await rm(dir, { recursive: true, force: true });
  }
});

test('后端 overview：images: 0 是零像素纯文本模式——即使 envelope: true 也不出波形图', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-audio-zero-'));
  const prevCache = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  try {
    const audio = await makeAudio(dir, 'tone.wav', '0.5*sin(2*PI*440*t)', 12);
    await writeFile(path.join(dir, 'tone.srt'), `1
00:00:00,000 --> 00:00:03,000
零像素也要有文字

2
00:00:03,000 --> 00:00:06,000
第二句
`);

    const backend = createAudioBackend({ config: {} });

    // images: 0 压过 envelope: true：一张图都不出，文字照旧。
    const zero = await backend.overview({ path: audio, images: 0, envelope: true });
    assert.deepEqual(zero.images, [], '零像素模式不得出波形图');
    assert.equal(zero.segments.length, 2);
    assert.ok(zero.segments.some((segment) => /零像素也要有文字/.test(segment.text)));
    assert.equal(zero.transcript.source, 'subtitle');

    // 对照组：envelope: true（不带 images: 0）仍然出波形图。
    const withWave = await backend.overview({ path: audio, envelope: true });
    assert.equal(withWave.images.length, 1);
    assert.equal(withWave.images[0].width, 1200);

    // images: 0 且不要波形：同样零图。
    const plain = await backend.overview({ path: audio, images: 0, envelope: false });
    assert.deepEqual(plain.images, []);
  } finally {
    if (prevCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = prevCache;
    await rm(dir, { recursive: true, force: true });
  }
});

test('后端 transcript 三值：subtitle 只读字幕、off 不读字幕，且都不调用 ASR', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-audio-modes-'));
  const prevCache = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  try {
    const audio = await makeAudio(dir, 'toned.wav', '0.5*sin(2*PI*440*t)', 12);
    await writeFile(path.join(dir, 'toned.srt'), `1
00:00:00,000 --> 00:00:03,000
有字幕的录音

2
00:00:03,000 --> 00:00:06,000
第二句
`);
    const bare = await makeAudio(dir, 'bare.wav', '0.5*sin(2*PI*440*t)', 3);

    const calls = [];
    const asrProvider = {
      id: 'stub',
      describe: () => ({ id: 'stub', model: 'stub', baseUrl: null }),
      transcribe: async ({ audioPath }) => {
        calls.push(audioPath);
        throw new Error('ASR MUST NOT BE CALLED');
      },
    };
    const backend = createAudioBackend({ asrProvider, config: {} });

    // subtitle + 有字幕：正常读到
    const withSubs = await backend.overview({ path: audio, transcript: 'subtitle', envelope: false });
    assert.equal(calls.length, 0);
    assert.equal(withSubs.transcript.source, 'subtitle');
    assert.ok(withSubs.segments.some((segment) => /有字幕的录音/.test(segment.text)));

    // subtitle + 无字幕：空结果 + 原因
    const noSubs = await backend.overview({ path: bare, transcript: 'subtitle', envelope: false });
    assert.equal(calls.length, 0, 'subtitle mode must never call ASR');
    assert.deepEqual(noSubs.segments, []);
    assert.equal(noSubs.transcript.source, 'none');
    assert.match(noSubs.transcript.reason, /no subtitle source/i);
    assert.ok(noSubs.warnings.includes('no-subtitle-source'));

    // off + 有字幕：字幕也不读
    const off = await backend.overview({ path: audio, transcript: 'off', envelope: false });
    assert.equal(calls.length, 0);
    assert.deepEqual(off.segments, []);
    assert.equal(off.transcript.source, 'none');
    assert.match(off.transcript.reason, /disabled/i);
    assert.ok(off.warnings.includes('transcript-disabled'));

    // probe capabilities 随参数变化
    const autoProbe = await backend.probe({ path: bare, transcript: 'auto' });
    assert.equal(autoProbe.capabilities.asr.available, true);
    const subProbe = await backend.probe({ path: bare, transcript: 'subtitle' });
    assert.equal(subProbe.capabilities.asr.available, false);
    assert.match(subProbe.capabilities.asr.reason, /subtitle/i);
    const offProbe = await backend.probe({ path: audio, transcript: 'off' });
    assert.equal(offProbe.capabilities.asr.available, false);
    assert.match(offProbe.capabilities.asr.reason, /disabled/i);
    assert.equal(offProbe.capabilities.transcriptSource, 'none');
    assert.equal(offProbe.capabilities.transcriptOrigin, 'none');
    assert.equal(calls.length, 0, 'probe never runs ASR');
  } finally {
    if (prevCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = prevCache;
    await rm(dir, { recursive: true, force: true });
  }
});

test('后端 overview：静音录音不调用 ASR', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-audio-quiet-'));
  const prevCache = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  try {
    const silent = await makeAudio(dir, 'silent.wav', '0', 8);
    let called = false;
    const asrProvider = {
      id: 'stub',
      describe: () => ({ id: 'stub', model: 'stub', baseUrl: null }),
      transcribe: async () => {
        called = true;
        return { provider: 'stub', model: 'stub', language: null, segments: [{ startMs: 0, endMs: 1000, text: '幻觉台词' }] };
      },
    };
    const backend = createAudioBackend({ asrProvider, config: {} });
    const overview = await backend.overview({ path: silent, envelope: false });
    assert.equal(called, false, '太安静时不应调用 ASR');
    assert.equal(overview.segments.length, 0);
    assert.ok(overview.warnings.some((w) => /audio-(silent|too-quiet)/.test(w)));
  } finally {
    if (prevCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = prevCache;
    await rm(dir, { recursive: true, force: true });
  }
});

test('后端 overview：ASR 路径的分片偏移与来源标注', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-audio-asr-'));
  const prevCache = process.env.MMGREP_CACHE_DIR;
  process.env.MMGREP_CACHE_DIR = path.join(dir, 'cache');
  try {
    const audio = await makeAudio(dir, 'long.wav', '0.4*sin(2*PI*440*t)', 20);
    const calls = [];
    const asrProvider = {
      id: 'stub',
      describe: () => ({ id: 'stub', model: 'stub-model', baseUrl: null }),
      transcribe: async ({ audioPath }) => {
        calls.push(audioPath);
        return {
          provider: 'stub',
          model: 'stub-model',
          language: 'zh',
          segments: [{ startMs: 0, endMs: 1000, text: `片段${calls.length}` }],
        };
      },
    };
    const backend = createAudioBackend({ asrProvider, config: {} });
    const overview = await backend.overview({ path: audio, envelope: false });
    assert.equal(calls.length, 1, '20s 音频应一次调用');
    assert.equal(overview.segments.length, 1);
    assert.equal(overview.segments[0].source, 'asr');
    assert.equal(overview.segments[0].origin, 'asr');
    assert.equal(overview.transcript.provider, 'stub');
    assert.equal(overview.transcript.model, 'stub-model');

    const locate = await backend.locate({ path: audio, query: '片段' });
    assert.ok(locate.matches.length >= 1);
  } finally {
    if (prevCache === undefined) delete process.env.MMGREP_CACHE_DIR;
    else process.env.MMGREP_CACHE_DIR = prevCache;
    await rm(dir, { recursive: true, force: true });
  }
});
