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
  resolveBinary,
  run,
  runBuffer,
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

test('run：stdout 仍以字符串返回', async () => {
  const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(typeof stdout, 'string');
  assert.equal(stdout, 'ok');
});

test('resolveBinary：环境变量优先；未设置/空白回退到 PATH 查找', () => {
  const prevFfmpeg = process.env.MMGREP_FFMPEG_PATH;
  const prevFfprobe = process.env.MMGREP_FFPROBE_PATH;
  try {
    process.env.MMGREP_FFMPEG_PATH = '/opt/custom/bin/ffmpeg';
    process.env.MMGREP_FFPROBE_PATH = '  /opt/custom/bin/ffprobe \n';
    assert.equal(resolveBinary('ffmpeg'), '/opt/custom/bin/ffmpeg');
    assert.equal(resolveBinary('ffprobe'), '/opt/custom/bin/ffprobe');

    process.env.MMGREP_FFMPEG_PATH = '   ';
    delete process.env.MMGREP_FFPROBE_PATH;
    assert.equal(resolveBinary('ffmpeg'), 'ffmpeg');
    assert.equal(resolveBinary('ffprobe'), 'ffprobe');

    // 其它工具名不受这两个变量影响
    process.env.MMGREP_FFMPEG_PATH = '/opt/custom/bin/ffmpeg';
    assert.equal(resolveBinary('some-other-tool'), 'some-other-tool');
  } finally {
    if (prevFfmpeg === undefined) delete process.env.MMGREP_FFMPEG_PATH;
    else process.env.MMGREP_FFMPEG_PATH = prevFfmpeg;
    if (prevFfprobe === undefined) delete process.env.MMGREP_FFPROBE_PATH;
    else process.env.MMGREP_FFPROBE_PATH = prevFfprobe;
  }
});

test('MMGREP_FFPROBE_PATH 指向不存在的路径 → TOOL_NOT_FOUND 且提示环境变量', async () => {
  const prev = process.env.MMGREP_FFPROBE_PATH;
  const missing = path.join(tmpdir(), `mmgrep-missing-ffprobe-${process.pid}-${Date.now()}`);
  process.env.MMGREP_FFPROBE_PATH = missing;
  try {
    await assert.rejects(
      () => ffprobeJson(path.join(tmpdir(), 'not-read-because-ffprobe-is-missing.mp4')),
      (e) => {
        assert.equal(e.code, 'TOOL_NOT_FOUND');
        assert.ok(e.message.includes(missing), `message should mention "${missing}": ${e.message}`);
        assert.match(e.message, /MMGREP_FFPROBE_PATH/);
        return true;
      },
    );
  } finally {
    if (prev === undefined) delete process.env.MMGREP_FFPROBE_PATH;
    else process.env.MMGREP_FFPROBE_PATH = prev;
  }
});

test('runBuffer：二进制缺失 → TOOL_NOT_FOUND', async () => {
  await assert.rejects(
    () => runBuffer('definitely-not-a-real-binary-xyz', ['x']),
    (e) => e.code === 'TOOL_NOT_FOUND',
  );
});

test('runBuffer：input 原样写入 stdin，stdout 按字节返回 Buffer', async () => {
  // 含 NUL 与非法 UTF-8 字节，证明中间没有经过字符串解码
  const payload = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff, 0x0a]);
  const { code, stdout } = await runBuffer(
    process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    { input: payload },
  );
  assert.equal(code, 0);
  assert.ok(Buffer.isBuffer(stdout), 'stdout 应是 Buffer');
  assert.deepEqual(stdout, payload);
});

test('runBuffer：非零退出映射为 INTERNAL 并带 stderr 尾部', async () => {
  await assert.rejects(
    () => runBuffer(process.execPath, [
      '-e',
      'console.error("boom-1"); console.error("boom-2"); process.exit(3)',
    ]),
    (e) => e.code === 'INTERNAL' && /exited with code 3/.test(e.message) && /boom-2/.test(e.message),
  );
});

test('runBuffer：rawvideo 输出长度等于像素字节数', { skip }, async () => {
  const width = 32;
  const height = 24;
  const { stdout } = await runBuffer('ffmpeg', [
    '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=0x336699:s=${width}x${height}:d=1`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  assert.ok(Buffer.isBuffer(stdout), 'stdout 应是 Buffer');
  assert.equal(stdout.length, width * height * 3);
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
