// test/backend/video/geometry.test.js —— probe 几何纯函数：fps/SAR 解析、旋转归一、显示宽高比
//
// 这些函数决定「编码尺寸 → 观众看到的尺寸」，错一步后续抓帧/拼图的格子比例就全歪；
// 边界（0 分母、缺 SAR、旋转 90）都在这里钉死，不依赖 ffmpeg 与素材。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  displayAspect,
  normalizeRotation,
  parseRational,
  parseSar,
  uprightSize,
} from '../../../src/backend/video/geometry.js';

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `期望 ${actual} ≈ ${expected}（误差 < ${epsilon}）`,
  );
}

test('parseRational：分式字符串 → 正数；0、空串、非数字、非字符串 → null', () => {
  assert.equal(parseRational('25/1'), 25);
  closeTo(parseRational('30000/1001'), 29.97, 0.001);
  assert.equal(parseRational('0/1'), null);
  assert.equal(parseRational(''), null);
  assert.equal(parseRational('abc'), null);
  assert.equal(parseRational(25), null);
  assert.equal(parseRational(undefined), null);
});

test('parseSar：冒号写法 → 比例；缺失、0:1、斜杠写法都按方像素 1', () => {
  assert.equal(parseSar('4:3'), 4 / 3);
  assert.equal(parseSar('1:1'), 1);
  assert.equal(parseSar('0:1'), 1);
  assert.equal(parseSar(undefined), 1);
  assert.equal(parseSar('16/9'), 1);
});

test('displayAspect：SAR 参与显示宽度；旋转 90 取倒数；退化尺寸回 16:9', () => {
  closeTo(displayAspect(1920, 1080, 1), 16 / 9);
  // 1440×1080 的 4:3 SAR 正是 DVD 素材：编码比例 4:3，显示比例 16:9
  closeTo(displayAspect(1440, 1080, 4 / 3), 16 / 9);
  closeTo(displayAspect(1920, 1080, 1, 90), 9 / 16);
  assert.equal(displayAspect(0, 1080, 1), 16 / 9);
});

test('normalizeRotation：归一化到 (-180, 180]，NaN → 0', () => {
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(-90), -90);
  assert.equal(normalizeRotation(270), -90);
  assert.equal(normalizeRotation(180), 180);
  assert.equal(normalizeRotation(Number.NaN), 0);
});

test('uprightSize：旋转 90/270 交换宽高，180 与 0 不交换', () => {
  assert.deepEqual(uprightSize(1920, 1080, 90), { width: 1080, height: 1920 });
  assert.deepEqual(uprightSize(1920, 1080, 270), { width: 1080, height: 1920 });
  assert.deepEqual(uprightSize(1920, 1080, 180), { width: 1920, height: 1080 });
  assert.deepEqual(uprightSize(1920, 1080, 0), { width: 1920, height: 1080 });
});
