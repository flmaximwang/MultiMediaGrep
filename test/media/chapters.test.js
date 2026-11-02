// test/media/chapters.test.js —— 容器章节 → 目录条目（9z5.33）
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chaptersFromProbe, chaptersToOutline, parseTimeBase } from '../../src/media/chapters.js';

test('ffprobe chapters：start_time / end_time 秒字符串优先', () => {
  const entries = chaptersFromProbe({
    chapters: [
      { start_time: '0.000000', end_time: '2.500000', tags: { title: 'Opening' } },
      { start_time: '2.500000', end_time: '5.000000', tags: {} },
    ],
  });
  assert.deepEqual(entries, [
    { title: 'Opening', startMs: 0, endMs: 2500, startSec: 0, endSec: 2.5 },
    { title: 'Chapter 2', startMs: 2500, endMs: 5000, startSec: 2.5, endSec: 5 },
  ]);
});

test('ffprobe chapters：没有秒字符串时用 time_base 刻度换算', () => {
  assert.equal(parseTimeBase('1/1000'), 0.001);
  assert.equal(parseTimeBase('bad'), null);
  const entries = chaptersFromProbe({
    chapters: [
      { time_base: '1/1000', start: 1500, end: 4000, tags: { title: 'Middle' } },
      { time_base: '1/1000', start: 'x', end: 5000 },
    ],
  });
  assert.deepEqual(entries, [
    { title: 'Middle', startMs: 1500, endMs: 4000, startSec: 1.5, endSec: 4 },
  ]);
});

test('chaptersToOutline：没有章节时 available=false 且给原因', () => {
  assert.deepEqual(chaptersToOutline({ chapters: [] }), {
    available: false,
    source: null,
    total: 0,
    entries: [],
    reason: 'this file has no chapters (no chapter metadata in the container).',
  });
  const outline = chaptersToOutline({
    chapters: [{ start_time: '1.0', end_time: '2.0', tags: { title: 'One' } }],
  });
  assert.equal(outline.available, true);
  assert.equal(outline.source, 'chapters');
  assert.equal(outline.total, 1);
  assert.equal(outline.entries[0].title, 'One');
});
