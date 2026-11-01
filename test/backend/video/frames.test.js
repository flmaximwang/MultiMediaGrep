// test/backend/video/frames.test.js —— 取帧 / 锐度选帧 / PNG 编码
//
// 锐度与滤镜串是纯函数测试；取帧、选帧、PNG 编码需要 ffmpeg，缺失时跳过。
// 素材用 lavfi 现场生成到临时目录，全部在 finally 里清理。

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  coverFilter,
  encodePngBuffer,
  extractFrameRaw,
  extractSharpest,
  sharpness,
} from '../../../src/backend/video/frames.js';
import { assertFfmpegAvailable, run } from '../../../src/media/ffmpeg.js';

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

/** 生成一张纯色 rgb24 缓冲 */
function solidRgb(width, height, [r, g, b]) {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  }
  return buf;
}

/** 生成一段 192×108、10fps 的测试片（mpeg4 是 ffmpeg 内置编码器，不依赖 x264） */
async function makeClip(dir, name, durationSec) {
  const out = path.join(dir, name);
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=192x108:rate=10:duration=${durationSec}`,
    '-pix_fmt', 'yuv420p', '-c:v', 'mpeg4', out,
  ]);
  return out;
}

test('sharpness：纯灰图 ≈ 0，棋盘格明显 > 0', () => {
  const size = 8;

  const flat = solidRgb(size, size, [128, 128, 128]);
  assert.equal(sharpness(flat, size, size), 0);

  // 逐像素黑白相间：每个内部像素与上下左右四邻都不同，Laplacian 方差很大。
  const board = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (x + y) % 2 === 0 ? 255 : 0;
      const i = (y * size + x) * 3;
      board[i] = v; board[i + 1] = v; board[i + 2] = v;
    }
  }
  assert.ok(sharpness(board, size, size) > 100, '棋盘格应明显比纯灰锐');
});

test('coverFilter：等比覆盖 + 居中裁切，绝不变形', () => {
  assert.equal(
    coverFilter(320, 180),
    'scale=320:180:force_original_aspect_ratio=increase,crop=320:180',
  );
});

test('encodePngBuffer：裸 RGB 编码后以 PNG 签名开头', { skip }, async () => {
  const width = 4;
  const height = 4;
  const png = await encodePngBuffer(solidRgb(width, height, [12, 34, 56]), width, height);

  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length >= 8);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG 魔数不对');
  assert.deepEqual(
    [...png.subarray(4, 8)],
    [0x0d, 0x0a, 0x1a, 0x0a],
    'PNG 魔数不对',
  );
});

test('extractFrameRaw：返回正好 cellW×cellH×3 字节与有限时刻', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-frames-'));
  try {
    const clip = await makeClip(dir, 'clip.mp4', 2);
    const cellW = 64;
    const cellH = 36;
    const frame = await extractFrameRaw({ input: clip, at: 0.2, dur: 0.5, cellW, cellH });

    assert.ok(Buffer.isBuffer(frame.buffer));
    assert.equal(frame.buffer.length, cellW * cellH * 3);
    assert.equal(typeof frame.t, 'number');
    assert.ok(Number.isFinite(frame.t), `t 应为有限数，实际 ${frame.t}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractFrameRaw：越过片尾时重试阶梯会终止并拒绝', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-frames-end-'));
  try {
    const clip = await makeClip(dir, 'clip.mp4', 1);
    await assert.rejects(
      () => extractFrameRaw({
        input: clip, at: 30, dur: 0.2, cellW: 32, cellH: 18, timeoutMs: 20_000,
      }),
      undefined,
      '远超过片尾的 seek 不应拿到帧',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractSharpest：短窗口内选出最锐帧，sharp 为有限数', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-frames-sharp-'));
  try {
    const clip = await makeClip(dir, 'clip.mp4', 2);
    const cellW = 64;
    const cellH = 36;
    const best = await extractSharpest({
      input: clip, at: 0, dur: 1, cellW, cellH, candidates: 3,
    });

    assert.ok(Buffer.isBuffer(best.buffer));
    assert.equal(best.buffer.length, cellW * cellH * 3);
    assert.equal(typeof best.t, 'number');
    assert.ok(Number.isFinite(best.t), `t 应为有限数，实际 ${best.t}`);
    assert.equal(typeof best.sharp, 'number');
    assert.ok(Number.isFinite(best.sharp), `sharp 应为有限数，实际 ${best.sharp}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
