// test/media/ffmpeg.test.js —— ffmpeg/ffprobe 封装（需要 PATH 上有 ffmpeg；没有就跳过）
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertFfmpegAvailable,
  detectSilence,
  ffprobeJson,
  measureLevels,
  normalizeToWav,
  renderWaveform,
  run,
} from '../../src/media/ffmpeg.js';

async function ffmpegAvailable() {
  try {
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
}

const hasFfmpeg = await ffmpegAvailable();
const skip = !hasFfmpeg;

async function makeToneThenSilence(dir) {
  const out = path.join(dir, 'tone-silence.wav');
  // 2 秒 440Hz + 2 秒静音
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'aevalsrc=if(lt(t\\,2)\\,sin(2*PI*440*t)\\,0):d=4:s=16000',
    out,
  ]);
  return out;
}

test('run：二进制缺失 → TOOL_NOT_FOUND', async () => {
  await assert.rejects(
    () => run('definitely-not-a-real-binary-xyz', ['x']),
    (e) => e.code === 'TOOL_NOT_FOUND',
  );
});

test('run：signal: null 不会被当成 AbortSignal 传给 spawn', async () => {
  const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write("ok")'], { signal: null });
  assert.equal(stdout, 'ok');
});

test('ffprobeJson / measureLevels / detectSilence', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-ffmpeg-'));
  try {
    const wav = await makeToneThenSilence(dir);

    const info = await ffprobeJson(wav);
    const duration = Number(info.format.duration);
    assert.ok(duration > 3.5 && duration < 4.5, `duration=${duration}`);
    assert.equal(info.streams.filter((s) => s.codec_type === 'audio').length, 1);

    const levels = await measureLevels(wav);
    assert.equal(typeof levels.meanDbfs, 'number');
    assert.ok(levels.meanDbfs < 0 && levels.meanDbfs > -60, `meanDbfs=${levels.meanDbfs}`);
    assert.ok(levels.peakDbfs >= levels.meanDbfs);

    const silences = await detectSilence(wav, { noiseDb: -45, minDurationSec: 0.3 });
    assert.ok(silences.length >= 1, `silences=${JSON.stringify(silences)}`);
    assert.ok(silences[0].startSec > 1.5, `silence starts at ${silences[0].startSec}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalizeToWav：16 kHz 单声道，不覆盖原文件', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-ffmpeg-norm-'));
  try {
    const src = await makeToneThenSilence(dir);
    const before = await stat(src);
    const out = path.join(dir, 'normalized.wav');
    await normalizeToWav(src, out);
    const info = await ffprobeJson(out);
    const audio = info.streams.find((s) => s.codec_type === 'audio');
    assert.equal(audio.sample_rate, '16000');
    assert.equal(audio.channels, 1);
    const after = await stat(src);
    assert.equal(before.size, after.size, '原文件不应被改动');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renderWaveform：产出 PNG', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-ffmpeg-wave-'));
  try {
    const src = await makeToneThenSilence(dir);
    const out = path.join(dir, 'wave.png');
    await renderWaveform(src, out, { width: 640, height: 160 });
    const body = await readFile(out);
    assert.deepEqual([...body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
