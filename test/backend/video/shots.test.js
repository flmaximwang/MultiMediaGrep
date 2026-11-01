// test/backend/video/shots.test.js —— SHOTS 镜头切分：纯函数判定 + ffmpeg 合成素材端到端
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  autoThreshold,
  barFraction,
  decideCuts,
  detectGradual,
  frameToHsv,
  scanShots,
  scorePair,
} from '../../../src/backend/video/shots.js';
import { assertFfmpegAvailable, run } from '../../../src/media/ffmpeg.js';

async function hasFfmpeg() {
  try {
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
}

const skip = !(await hasFfmpeg());

/** 按 25fps 把一组分数铺成 stats（t 只用于定位，判定本身与 fps 无关） */
function seq(scores, fps = 25) {
  return scores.map((score, i) => ({ t: +(i / fps).toFixed(6), score }));
}

test('decideCuts：平稳低分序列 0 刀；单个尖峰恰好 1 刀', () => {
  assert.equal(decideCuts(seq(new Array(60).fill(2))).cuts.length, 0);

  // 20 帧安静（0–0.76s），第 20 帧（0.8s）一刀 60 分，之后继续安静
  const stats = seq([...new Array(20).fill(2), 60, ...new Array(20).fill(2)]);
  const { cuts, threshold } = decideCuts(stats);
  assert.equal(cuts.length, 1, JSON.stringify(cuts));
  assert.ok(Math.abs(cuts[0].t - 0.8) < 0.06, `cut at ${cuts[0].t}`);
  assert.ok(cuts[0].score >= threshold);
});

test('decideCuts：同亮度、不同色相仍能判出切点（HSV 加权）', () => {
  // 纯红 → 纯绿：V 完全相同，只有色相变；只看亮度会得到 0 分
  const red = frameToHsv(Uint8Array.from([255, 0, 0]));
  const green = frameToHsv(Uint8Array.from([0, 255, 0]));
  assert.equal(red[2], green[2], '两色亮度（V）应相同');
  assert.notEqual(red[0], green[0], '两色色相（H）应不同');

  const hueScore = scorePair(red, green);
  assert.ok(hueScore > 12, `hue-only score ${hueScore} should clear the floor`);

  const stats = seq([...new Array(20).fill(2), hueScore, ...new Array(20).fill(2)]);
  const { cuts } = decideCuts(stats);
  assert.equal(cuts.length, 1, JSON.stringify(cuts));
  assert.ok(Math.abs(cuts[0].t - 0.8) < 0.06, `cut at ${cuts[0].t}`);
});

/**
 * 1 秒的平滑渐变：longStats 在 0.5–1.5s 之间抬到门槛之上并缓慢起伏，
 * frameStats 对应地保持低分（渐变期间逐帧差本来就小）。
 */
function rampStats({ frameScore = 2 } = {}) {
  const step = 0.04;
  const longStats = [];
  const frameStats = [];
  for (let i = 0; i * step <= 2 + 1e-9; i += 1) {
    const t = +(i * step).toFixed(3);
    const inRamp = t >= 0.5 && t <= 1.5;
    const score = inRamp ? 12 + 8 * Math.sin(((t - 0.5) / 1) * Math.PI) : 1;
    longStats.push({ t, score });
    frameStats.push({ t, score: inRamp ? frameScore : 1 });
  }
  return { longStats, frameStats };
}

test('detectGradual：平滑渐变判 1 个 gradual；甩镜（前后都吵）判 0 个', () => {
  const { longStats, frameStats } = rampStats({ frameScore: 2 });
  const found = detectGradual(longStats, frameStats);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].kind, 'gradual');

  // 甩镜：长时差同样大，但相邻帧差一直很高 → 不是转场
  const busy = frameStats.map((s) => ({ t: s.t, score: 15 }));
  const none = detectGradual(longStats, busy);
  assert.equal(none.length, 0, JSON.stringify(none));
});

test('autoThreshold：全静默不小于 12；低于单个主导尖峰', () => {
  const quiet = new Array(100).fill(2);
  assert.equal(autoThreshold(quiet), 12);
  assert.ok(autoThreshold(quiet) >= 12);

  const spiky = [...new Array(99).fill(2), 50];
  const thr = autoThreshold(spiky);
  assert.ok(thr >= 12, `threshold ${thr}`);
  assert.ok(thr < 50, `threshold ${thr} should stay below the dominant spike`);
});

test('barFraction：全黑窗口 0；遮幅窗口为正比例', () => {
  const h = 36;
  // 整窗全黑（片尾黑场）：上下都吃满 → 不做补偿
  assert.equal(barFraction({
    rowV: new Float64Array(h),
    rowVMax: new Float64Array(h),
    frames: 100,
  }), 0);

  // 上下各 5 行一直是黑的，中间是亮的
  const rowV = new Float64Array(h).fill(160 * 100);
  const rowVMax = new Float64Array(h).fill(220);
  for (let y = 0; y < 5; y += 1) { rowV[y] = 0; rowVMax[y] = 0; }
  for (let y = h - 5; y < h; y += 1) { rowV[y] = 0; rowVMax[y] = 0; }
  const frac = barFraction({ rowV, rowVMax, frames: 100 });
  assert.equal(frac, +(10 / h).toFixed(3));
  assert.ok(frac > 0 && frac < 0.35, `fraction ${frac}`);
});

test('scanShots：三段纯色硬切，边界两侧 ±0.5s 内各判出切点', { skip, timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-shots-'));
  try {
    const input = path.join(dir, 'cuts.mp4');
    // 3 段各 1 秒的纯色（红 / 绿 / 蓝），硬切边界在 1.0s 与 2.0s。
    // 同亮度换色正是这个检测器要抓的场景。
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=1',
      '-f', 'lavfi', '-i', 'color=c=lime:s=320x240:r=25:d=1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]',
      '-map', '[v]', input,
    ]);

    const result = await scanShots({ input, fps: 25 });
    assert.ok(Array.isArray(result.cuts), 'cuts must be an array');
    assert.equal(result.degraded, null, '干净的硬切序列不应判成 motion');
    assert.ok(result.cuts.length >= 2, JSON.stringify(result.cuts));

    for (const boundary of [1, 2]) {
      const near = result.cuts.filter((c) => Math.abs(c.t - boundary) <= 0.5);
      assert.ok(near.length >= 1, `no cut near ${boundary}s: ${JSON.stringify(result.cuts)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
