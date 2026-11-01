// test/media/interface.test.js —— 路径/范围/pages 校验与分派测试
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  METHOD_MATRIX,
  ToolError,
  createDispatcher,
  parsePages,
  validateCrop,
  validatePath,
  validateTimeRange,
} from '../../src/media/interface.js';

async function withTempFile(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-iface-'));
  try {
    const p = path.join(dir, 'a.mp4');
    await writeFile(p, 'x');
    return await fn(p, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('validatePath：五步校验的错误码与文案', async () => {
  await assert.rejects(() => validatePath(undefined), (e) => e instanceof ToolError && e.code === 'INVALID_ARGUMENT' && e.message === 'path is required.');
  await assert.rejects(() => validatePath(''), (e) => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(() => validatePath('https://example.com/a.mp4'), (e) => e.code === 'NOT_A_LOCAL_PATH' && /never downloads/.test(e.message));
  await assert.rejects(() => validatePath('file:///abs/a.mp4'), (e) => e.code === 'NOT_A_LOCAL_PATH');
  await assert.rejects(() => validatePath('videos/a.mp4'), (e) => e.code === 'INVALID_ARGUMENT' && /absolute local path/.test(e.message));
  await assert.rejects(() => validatePath('/definitely/not/here.mp4'), (e) => e.code === 'PATH_NOT_FOUND');
  await withTempFile(async (p, dir) => {
    await assert.rejects(() => validatePath(dir), (e) => e.code === 'NOT_A_FILE');
    const resolved = await validatePath(p);
    assert.equal(resolved, p);
  });
});

test('parsePages：语法、去重合并、越界', () => {
  assert.deepEqual(parsePages('3-10,15'), [3, 4, 5, 6, 7, 8, 9, 10, 15]);
  assert.deepEqual(parsePages('3-10,15,3'), [3, 4, 5, 6, 7, 8, 9, 10, 15]);
  assert.deepEqual(parsePages(' 5 , 2 '), [2, 5]);
  assert.deepEqual(parsePages('7'), [7]);
  assert.throws(() => parsePages(''), (e) => e.code === 'INVALID_ARGUMENT' && /must not be empty/.test(e.message));
  assert.throws(() => parsePages('3,,5'), (e) => e.code === 'INVALID_ARGUMENT');
  assert.throws(() => parsePages('abc'), (e) => e.code === 'INVALID_ARGUMENT' && /"abc"/.test(e.message));
  assert.throws(() => parsePages('0'), (e) => e.code === 'INVALID_ARGUMENT' && /start at 1/.test(e.message));
  assert.throws(() => parsePages('10-3'), (e) => e.code === 'INVALID_ARGUMENT' && /low-to-high/.test(e.message));
  assert.throws(() => parsePages('12-15', { pageCount: 8 }), (e) => e.code === 'OUT_OF_RANGE' && /This document has 8 pages/.test(e.message));
  assert.deepEqual(parsePages('12-15', { pageCount: 20 }), [12, 13, 14, 15]);
});

test('validateTimeRange：start 越界报错，end 越界裁剪并标记', () => {
  assert.throws(() => validateTimeRange({ startSec: -1 }), (e) => e.code === 'INVALID_ARGUMENT' && /start must be >= 0/.test(e.message));
  assert.throws(() => validateTimeRange({ startSec: 30, endSec: 10 }), (e) => e.code === 'INVALID_ARGUMENT' && /greater than start/.test(e.message));
  assert.throws(
    () => validateTimeRange({ startSec: 7200, durationSec: 3600 }),
    (e) => e.code === 'OUT_OF_RANGE' && /beyond the end of the media/.test(e.message),
  );
  const clipped = validateTimeRange({ startSec: 10, endSec: 7200, durationSec: 3600 });
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.endSec, 3600);
  assert.equal(clipped.endMs, 3_600_000);
  const inside = validateTimeRange({ startSec: 1.5, endSec: 2.5, durationSec: 10 });
  assert.equal(inside.clipped, false);
  assert.equal(inside.startMs, 1500);
  assert.equal(inside.endMs, 2500);
});

test('validateCrop：比例制边界', () => {
  assert.deepEqual(validateCrop({ x: 0, y: 0, width: 1, height: 1 }), { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(validateCrop(null), null);
  assert.throws(() => validateCrop({ x: 0.9, y: 0, width: 0.3, height: 0.2 }), (e) => e.code === 'INVALID_ARGUMENT' && /crop must satisfy/.test(e.message));
  assert.throws(() => validateCrop({ x: -0.1, y: 0, width: 0.5, height: 0.5 }), (e) => e.code === 'INVALID_ARGUMENT');
});

test('ToolError.toResult：契约 §2.4 的错误结果形状', () => {
  const err = new ToolError('INVALID_ARGUMENT', 'pages is invalid: "abc".', 'pages: "3-10,15"');
  const result = err.toResult();
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /^INVALID_ARGUMENT: pages is invalid/);
  assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.equal(result.structuredContent.error.hint, 'pages: "3-10,15"');
});

test('createDispatcher：按媒体类型分派，不适用的方法明确报错', async () => {
  const calls = [];
  const backend = (name) => ({
    probe: async () => `${name}:probe`,
    overview: async () => `${name}:overview`,
    zoom: async () => `${name}:zoom`,
    locate: async () => `${name}:locate`,
  });
  const d = createDispatcher({ video: backend('video'), audio: backend('audio'), document: backend('document') });
  assert.equal(await d.call('video', 'overview', {}, {}), 'video:overview');
  assert.equal(await d.call('audio', 'probe', {}, {}), 'audio:probe');
  assert.equal(await d.call('document', 'zoom', {}, {}), 'document:zoom');
  assert.equal(await d.call('video', 'locate', {}, {}), 'video:locate');
  await assert.rejects(() => d.call('audio', 'zoom', {}, {}), (e) => e.code === 'INVALID_ARGUMENT' && /not applicable to audio/.test(e.message));
  await assert.rejects(() => d.call('audio', 'subtitles', {}, {}), (e) => e.code === 'INVALID_ARGUMENT' && /unknown method/.test(e.message));
  await assert.rejects(() => d.call('video', 'nope', {}, {}), (e) => e.code === 'INVALID_ARGUMENT' && /unknown method/.test(e.message));
  assert.deepEqual(METHOD_MATRIX.audio, ['probe', 'overview', 'locate']);
  assert.ok(calls.length === 0);
});
