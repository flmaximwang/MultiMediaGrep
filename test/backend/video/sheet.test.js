// test/backend/video/sheet.test.js —— 分镜宫格纯绘制层：布局 / 填色 / 点阵 / 拼图 / 贴帧
//
// 全部是纯函数测试，不需要 ffmpeg、不写盘。layout 的数字是从上游实现
// 跑一遍后**钉死**的：将来有人"顺手清理" headerHeight 或预算公式时，这里会立刻报警。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BACKGROUND,
  BADGE_ALPHA,
  DIGITS,
  GUTTER,
  PAD_FILL,
  PAD_GLYPH,
  blit,
  composeSheet,
  drawGlyphs,
  fillRect,
  layoutCanvas,
} from '../../../src/backend/video/sheet.js';

/** 取 (x,y) 处 RGB，返回 [r,g,b] */
function pixel(buf, width, x, y) {
  const i = (y * width + x) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]];
}

/** 生成一张纯色 rgb24 帧 */
function solidFrame(width, height, [r, g, b]) {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  }
  return buf;
}

test('layoutCanvas 的 3×3 / 1×1 尺寸与上游逐像素一致，且面积不超预算', () => {
  const budget = 640_000;

  // 上游实现的实测输出。
  // 这些数字同时隐含了 headerHeight 的预留（删除它会让 width/height 都变）。
  assert.deepEqual(layoutCanvas(3, 3, 16 / 9, budget), {
    width: 1006, height: 574, cellW: 330, cellH: 186,
  });
  assert.deepEqual(layoutCanvas(1, 1, 16 / 9, budget), {
    width: 1014, height: 574, cellW: 1006, cellH: 566,
  });

  for (const [cols, rows] of [[3, 3], [1, 1]]) {
    const { width, height } = layoutCanvas(cols, rows, 16 / 9, budget);
    assert.ok(width * height <= budget, `${cols}×${rows} 面积 ${width * height} 超出 ${budget}`);
  }
});

test('fillRect 在画布边缘裁切，并按 alpha 混合', () => {
  // 负坐标 + 越界宽高：只覆盖 [0,2)×[0,2) 的 2×2 块。
  const clipped = Buffer.alloc(4 * 3 * 3);
  fillRect(clipped, 4, 3, -1, -1, 3, 3, [255, 0, 0]);
  assert.deepEqual(pixel(clipped, 4, 0, 0), [255, 0, 0]);
  assert.deepEqual(pixel(clipped, 4, 1, 1), [255, 0, 0]);
  assert.deepEqual(pixel(clipped, 4, 2, 0), [0, 0, 0]);
  assert.deepEqual(pixel(clipped, 4, 0, 2), [0, 0, 0]);

  // 正坐标向右/向下溢出：只画到画布右下角为止。
  const overflowing = Buffer.alloc(2 * 2 * 3);
  fillRect(overflowing, 2, 2, 1, 1, 5, 5, [0, 255, 0]);
  assert.deepEqual(pixel(overflowing, 2, 1, 1), [0, 255, 0]);
  assert.deepEqual(pixel(overflowing, 2, 0, 0), [0, 0, 0]);

  // alpha = 0.5：100 与 200 → 150，0 → 50。
  const blended = solidFrame(2, 1, [100, 100, 100]);
  fillRect(blended, 2, 1, 0, 0, 2, 1, [200, 0, 0], 0.5);
  assert.deepEqual(pixel(blended, 2, 0, 0), [150, 50, 50]);
  assert.deepEqual(pixel(blended, 2, 1, 0), [150, 50, 50]);
});

test('drawGlyphs 画得出数字 7，未知字符（含已剥离的 : /）不改动缓冲', () => {
  const drawn = Buffer.alloc(16 * 8 * 3);
  drawGlyphs(drawn, 16, 8, '7', 0, 0, 1, [255, 255, 255]);
  assert.ok(drawn.some((v) => v !== 0), "'7' 应该画出至少一个白点");
  // 7 的第一行是 11111：x=0..4 全亮。
  assert.deepEqual(pixel(drawn, 16, 0, 0), [255, 255, 255]);
  assert.deepEqual(pixel(drawn, 16, 4, 0), [255, 255, 255]);
  // 第二行是 00001：左边空、最右一列亮。
  assert.deepEqual(pixel(drawn, 16, 0, 1), [0, 0, 0]);
  assert.deepEqual(pixel(drawn, 16, 4, 1), [255, 255, 255]);

  // 未知字符直接跳过：缓冲逐字节不变。
  assert.equal(DIGITS[':'], undefined);
  assert.equal(DIGITS['/'], undefined);
  for (const text of ['X', ':', '/']) {
    const buf = Buffer.alloc(16 * 8 * 3);
    const before = Buffer.from(buf);
    const used = drawGlyphs(buf, 16, 8, text, 0, 0, 1, [255, 255, 255]);
    assert.ok(buf.equals(before), `'${text}' 不应改动缓冲`);
    assert.equal(used.width, 0);
  }
});

test('composeSheet 拼 2×2 纯色帧：尺寸正确、每格落在正确位置', () => {
  const cols = 2;
  const rows = 2;
  const { width, height, cellW, cellH } = layoutCanvas(cols, rows, 1, 100_000);
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  const frames = colors.map((color, i) => ({
    buffer: solidFrame(cellW, cellH, color),
    index: i + 1,
  }));

  const sheet = composeSheet({ frames, cols, rows, cellAspect: 1, budget: 100_000 });
  assert.equal(sheet.width, width);
  assert.equal(sheet.height, height);
  assert.equal(sheet.buffer.length, width * height * 3);

  // 间隙是 BACKGROUND。
  assert.deepEqual(pixel(sheet.buffer, width, 0, 0), BACKGROUND);

  // 每格中心是各自的纯色（徽标只压在左上角，不影响中心）。
  colors.forEach((color, pos) => {
    const r = Math.floor(pos / cols);
    const c = pos % cols;
    const x = GUTTER + c * (cellW + GUTTER);
    const y = GUTTER + r * (cellH + GUTTER);
    assert.deepEqual(
      pixel(sheet.buffer, width, x + Math.floor(cellW / 2), y + Math.floor(cellH / 2)),
      color,
      `第 ${pos} 格颜色不对`,
    );
  });
});

test('composeSheet 把 null 格位补成 PAD_FILL（且不画徽标）', () => {
  const cols = 2;
  const rows = 2;
  const { width, cellW, cellH } = layoutCanvas(cols, rows, 1, 100_000);
  const frames = [
    { buffer: solidFrame(cellW, cellH, [255, 0, 0]), index: 1 },
    null,
    { buffer: solidFrame(cellW, cellH, [0, 0, 255]), index: 3 },
    { buffer: solidFrame(cellW, cellH, [255, 255, 0]), index: 4 },
  ];

  const sheet = composeSheet({ frames, cols, rows, cellAspect: 1, budget: 100_000 });
  // 空位是右上角（pos 1）。
  const x = GUTTER + (cellW + GUTTER);
  const y = GUTTER;
  // 角落必然是灰底（徽标只画在有效帧上；居中横杠也碰不到角落）。
  assert.deepEqual(pixel(sheet.buffer, width, x + 1, y + 1), PAD_FILL);
  // 正中是 PAD_GLYPH 横杠。
  assert.deepEqual(
    pixel(sheet.buffer, width, x + Math.floor(cellW / 2), y + Math.floor(cellH / 2)),
    PAD_GLYPH,
  );
});

test('composeSheet 在 frames 多于格位时抛 RangeError', () => {
  const { cellW, cellH } = layoutCanvas(2, 2, 1, 100_000);
  const frame = () => ({ buffer: solidFrame(cellW, cellH, [1, 2, 3]), index: 1 });
  assert.throws(
    () => composeSheet({
      frames: [frame(), frame(), frame(), frame(), frame()],
      cols: 2, rows: 2, cellAspect: 1, budget: 100_000,
    }),
    RangeError,
  );
});

test('blit 按 srcW 的行宽逐行拷贝，不会把行错位', () => {
  // 源是 2×2 的小图，每行两个像素；目标更宽，用来暴露"用错 stride"的斜切。
  const src = Buffer.from([
    10, 10, 10, 20, 20, 20, // 第 0 行
    30, 30, 30, 40, 40, 40, // 第 1 行
  ]);
  const dstW = 5;
  const dstH = 3;
  const dst = Buffer.alloc(dstW * dstH * 3);

  // cellW=srcW=2（黑场格的实际用法），贴到 (1,1)。
  blit(dst, dstW, dstH, 1, 1, 2, 2, src, 2);

  assert.deepEqual(pixel(dst, dstW, 1, 1), [10, 10, 10]);
  assert.deepEqual(pixel(dst, dstW, 2, 1), [20, 20, 20]);
  assert.deepEqual(pixel(dst, dstW, 1, 2), [30, 30, 30]);
  assert.deepEqual(pixel(dst, dstW, 2, 2), [40, 40, 40]);
  // 行首/行尾与目标其它位置保持原样（错误 stride 会写到这里）。
  assert.deepEqual(pixel(dst, dstW, 0, 1), [0, 0, 0]);
  assert.deepEqual(pixel(dst, dstW, 3, 1), [0, 0, 0]);
  assert.deepEqual(pixel(dst, dstW, 1, 0), [0, 0, 0]);
  assert.deepEqual(pixel(dst, dstW, 0, 0), [0, 0, 0]);

  // 缓冲不够大时明确报错。
  assert.throws(() => blit(dst, dstW, dstH, 0, 0, 2, 2, Buffer.alloc(11), 2), RangeError);
});

test('常量与徽标透明度保持上游数值', () => {
  assert.equal(GUTTER, 4);
  assert.equal(BADGE_ALPHA, 0.85);
  assert.deepEqual(BACKGROUND, [18, 18, 20]);
  assert.deepEqual(PAD_FILL, [42, 42, 46]);
});
