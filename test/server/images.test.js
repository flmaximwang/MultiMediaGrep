// test/server/images.test.js —— 契约 §10 的计价、硬上限、软预算与降级
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ToolError } from '../../src/media/interface.js';
import {
  IMAGE_LIMITS,
  budgetReport,
  describeImages,
  estimateImageTokens,
  gridTokens,
  imageSizeFor,
  mimeTypeOfBuffer,
  minimumMaxEdgeForCells,
  pixelTokens,
  planImageBudget,
  readabilityFor,
  toImageContent,
  validateImageShape,
  validateProducedImages,
} from '../../src/server/images.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);

function expectBudgetError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, 'BUDGET_EXCEEDED');
    assert.match(error.message, pattern);
    return true;
  });
}

test('计价公式：契约 §10.3 的默认形状数值', () => {
  assert.equal(gridTokens(1280, 720), 591);
  assert.equal(pixelTokens(1280, 720), 1229);
  assert.deepEqual(estimateImageTokens(1280, 720), { gridTokens: 591, pixelTokens: 1229, estimatedTokens: 1229 });
  // media_zoom 默认 1600×900
  assert.equal(gridTokens(1600, 900), 899);
  assert.equal(pixelTokens(1600, 900), 1920);
  assert.equal(estimateImageTokens(1600, 900).estimatedTokens, 1920);
});

test('imageSizeFor：默认 16:9', () => {
  assert.deepEqual(imageSizeFor(1280), { width: 1280, height: 720 });
  assert.deepEqual(imageSizeFor(1600), { width: 1600, height: 900 });
});

test('validateImageShape：接受合法形状', () => {
  assert.deepEqual(validateImageShape({ cells: 9, images: 2, maxEdge: 1280 }), { cells: 9, images: 2, maxEdge: 1280 });
  assert.deepEqual(validateImageShape({ cells: 16, images: 4, maxEdge: 1600 }), { cells: 16, images: 4, maxEdge: 1600 });
});

test('validateImageShape：硬上限的契约原文案', () => {
  expectBudgetError(
    () => validateImageShape({ cells: 9, images: 5, maxEdge: 1280 }),
    /^requested 5 images but the per-call limit is 4\. Reduce images to 4, or reduce cells and split the range into several calls with start\/end\.$/,
  );
  expectBudgetError(
    () => validateImageShape({ cells: 25, images: 1, maxEdge: 1280 }),
    /^cells must be an integer between 1 and 16 \(got 25\)\.$/,
  );
  expectBudgetError(
    () => validateImageShape({ cells: 25, images: 1, maxEdge: 1280 }),
    /cells must be an integer/,
  );
});

test('validateImageShape：总格数上限先于单图格数（契约 §10.2 的两个例子）', () => {
  // cells=25, images=4 → 100 格：报「总格数」文案
  expectBudgetError(
    () => validateImageShape({ cells: 25, images: 4, maxEdge: 1600 }),
    /^requested 25 cells x 4 images = 100 cells but the per-call limit is 64\. Lower cells, lower images, or split the range into several calls\.$/,
  );
  // cells=25, images=1 → 25 格：报「单图格数」文案
  expectBudgetError(
    () => validateImageShape({ cells: 25, images: 1, maxEdge: 1280 }),
    /^cells must be an integer between 1 and 16 \(got 25\)\.$/,
  );
  expectBudgetError(
    () => validateImageShape({ cells: 9, images: 2, maxEdge: 3000 }),
    /^maxEdge must be an integer between 256 and 1600 \(got 3000\)\.$/,
  );
  expectBudgetError(
    () => validateImageShape({ cells: 9, images: 2, maxEdge: 100 }),
    /^maxEdge must be an integer between 256 and 1600 \(got 100\)\.$/,
  );
});

test('validateImageShape：配置的 MMGREP_MAX_IMAGE_EDGE 收紧上限', () => {
  expectBudgetError(
    () => validateImageShape({ cells: 4, images: 1, maxEdge: 1280, limitEdge: 1024 }),
    /between 256 and 1024 \(got 1280\)/,
  );
});

test('validateProducedImages：单图像素硬上限（后端实际产物）', () => {
  assert.throws(
    () => validateProducedImages([{ width: 1920, height: 1080, cells: 1, buffer: PNG }]),
    (error) => error.code === 'BUDGET_EXCEEDED'
      && /the requested shape would need 2,073,600 pixels per image but the limit is 2,000,000\. Lower cells or maxEdge\./.test(error.message),
  );
  assert.throws(
    () => validateProducedImages(Array.from({ length: 5 }, () => ({ width: 640, height: 360, cells: 1 }))),
    (error) => error.code === 'BUDGET_EXCEEDED' && /per-call limit is 4/.test(error.message),
  );
});

test('planImageBudget：自动模式默认形状落在软预算内', () => {
  const plan = planImageBudget({ cells: 9, images: 2, maxEdge: 1280, explicit: false, limitTokens: 4000 });
  assert.equal(plan.estimatedTokens, 2458);
  assert.equal(plan.warning, null);
  assert.deepEqual(plan.produced, { cells: 9, images: 2, maxEdge: 1280 });
  assert.equal(plan.readability.tier, 'scene');
});

test('planImageBudget：显式模式超软预算不偷偷改形，只警告', () => {
  const plan = planImageBudget({ cells: 16, images: 4, maxEdge: 1600, explicit: true, limitTokens: 4000 });
  assert.deepEqual(plan.produced, { cells: 16, images: 4, maxEdge: 1600 });
  assert.equal(plan.estimatedTokens, 7680);
  assert.match(plan.warning, /above the soft budget of 4000/);
  assert.match(plan.warning, /Produced as requested \(not silently reduced\)/);
  assert.match(plan.warning, /split the range into several calls/);
});

test('planImageBudget：自动模式超预算时按降级阶梯减少图片数', () => {
  const plan = planImageBudget({ cells: 9, images: 2, maxEdge: 1280, explicit: false, limitTokens: 2000 });
  assert.equal(plan.produced.images, 1);
  assert.equal(plan.produced.cells, 9);
  assert.equal(plan.estimatedTokens, 1229);
  assert.match(plan.warning, /reduced the shape/);
});

test('planImageBudget：可读性不足时给出警告（契约 §10.4）', () => {
  const plan = planImageBudget({ cells: 16, images: 1, maxEdge: 640, explicit: true, limitTokens: 4000 });
  assert.ok(['shot', 'below-shot'].includes(plan.readability.tier));
  assert.match(plan.warning, /cells below readability target: (shot|below-shot)-level/);
  assert.equal(minimumMaxEdgeForCells(16), 1280);
  assert.equal(minimumMaxEdgeForCells(9), 960);
  assert.equal(minimumMaxEdgeForCells(6), 960);
  assert.equal(minimumMaxEdgeForCells(4), 640);
});

test('readabilityFor：三档边界', () => {
  assert.equal(readabilityFor({ width: 960, height: 540, cells: 9 }).tier, 'scene');
  assert.equal(readabilityFor({ width: 1440, height: 810, cells: 9 }).tier, 'text');
  assert.equal(readabilityFor({ width: 640, height: 360, cells: 4 }).tier, 'scene');
});

test('budgetReport：请求 vs 实际', () => {
  const plan = planImageBudget({ cells: 9, images: 2, maxEdge: 1280, explicit: false, limitTokens: 4000 });
  const report = budgetReport(plan, { producedImages: 2, producedCells: 18 });
  assert.deepEqual(report, {
    requestedImages: 2,
    producedImages: 2,
    requestedCells: 18,
    producedCells: 18,
    estimatedTokens: 2458,
    limit: 4000,
    warning: null,
  });

  const short = budgetReport(plan, { producedImages: 1, producedCells: 9 });
  assert.equal(short.estimatedTokens, 1229);
  assert.match(short.warning, /requested 2 images but 1 were produced/);
});

test('describeImages：PNG/JPEG buffer → MCP image content', () => {
  const described = describeImages([
    { buffer: PNG, width: 1280, height: 720, cells: 9, index: 1 },
    { buffer: JPEG, width: 640, height: 360, cells: 4, index: 2 },
  ]);
  assert.equal(described.blocks.length, 2);
  assert.equal(described.blocks[0].type, 'image');
  assert.equal(described.blocks[0].mimeType, 'image/png');
  assert.equal(described.blocks[1].mimeType, 'image/jpeg');
  assert.equal(Buffer.from(described.blocks[0].data, 'base64').equals(PNG), true);
  assert.equal(described.descriptors[0].estimatedTokens, 1229);
  assert.equal(described.descriptors[0].source, 'visual');
  assert.equal(described.totalCells, 13);
});

test('mimeTypeOfBuffer / toImageContent', () => {
  assert.equal(mimeTypeOfBuffer(PNG), 'image/png');
  assert.equal(mimeTypeOfBuffer(JPEG), 'image/jpeg');
  assert.equal(mimeTypeOfBuffer(Buffer.alloc(4)), 'image/png');
  const block = toImageContent(PNG, 'image/png');
  assert.deepEqual(Object.keys(block).sort(), ['data', 'mimeType', 'type']);
  assert.equal(IMAGE_LIMITS.maxImagesPerCall, 4);
  assert.equal(IMAGE_LIMITS.maxCellsPerCall, 64);
  assert.equal(IMAGE_LIMITS.maxPixelsPerImage, 2000000);
});
