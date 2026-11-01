// test/media/subtitles-rolling.test.js —— 滚动式字幕的合并、重叠检测与警告（9z5.26）
//
// 场景：自动生成的字幕常常是「滚动式」的——cue 之间时间重叠、首行与上一条的末行重复。
// 这里验证三件事：
//   1. 重复行被去掉，正文不再出现重复段；
//   2. 重叠且正文相同（或去重后为空）的 cue 合并，时间跨度 = 最早 start → 最晚 end；
//   3. 重叠比例 > 30% 时给出「按 ASR 对待」的警告；人工字幕（不重叠）没有警告、段落不变。
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  mergeRollingCues,
  parseSrt,
  parseSubtitleDocument,
  parseSubtitles,
  readSubtitleFile,
  ROLLING_OVERLAP_RATIO_THRESHOLD,
  ROLLING_SUBTITLE_WARNING,
  subtitleOverlapRatio,
} from '../../src/media/subtitles.js';
import { resolveSubtitleSource } from '../../src/media/transcript.js';

/** 滚动式字幕：两条 cue 时间重叠，且后一条的首行 = 前一条的末行 */
const ROLLING_SRT = `1
00:02:59,199 --> 00:03:03,199
attach the rinse adapter to the end of

2
00:03:00,878 --> 00:03:05,198
attach the rinse adapter to the end of

3
00:03:05,198 --> 00:03:09,198
the piston

4
00:03:06,000 --> 00:03:10,000
the piston
`;

/** 滚动式字幕的常见形态：每条两行，首行与上一条的末行重复 */
const ROLLING_TWO_LINE_SRT = `1
00:00:00,000 --> 00:00:03,000
LINE A

2
00:00:02,000 --> 00:00:05,000
LINE A
LINE B

3
00:00:04,000 --> 00:00:07,000
LINE B
LINE C
`;

/** 人工字幕：一条压一条，不重叠也不重复 */
const CLEAN_SRT = `1
00:00:01,000 --> 00:00:04,000
FIRST SUBTITLE LINE

2
00:00:04,500 --> 00:00:07,250
SECOND SUBTITLE LINE

3
00:00:08,000 --> 00:00:11,000
THIRD SUBTITLE LINE
`;

async function withTempSrt(name, content, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-rolling-'));
  try {
    const file = path.join(dir, name);
    await writeFile(file, content);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('mergeRollingCues：首行重复被去掉，重叠且同文的 cue 合并成一个跨度', () => {
  const merged = mergeRollingCues([
    { startMs: 179199, endMs: 183199, lines: ['attach the rinse adapter to the end of'] },
    { startMs: 180878, endMs: 185198, lines: ['attach the rinse adapter to the end of'] },
    { startMs: 185198, endMs: 189198, lines: ['the piston'] },
    { startMs: 186000, endMs: 190000, lines: ['the piston'] },
  ]);
  assert.equal(merged.length, 2);
  // 合并后时间跨度 = 参与合并的所有 cue 里最早的 start → 最晚的 end
  assert.deepEqual(merged[0], {
    startMs: 179199,
    endMs: 185198,
    lines: ['attach the rinse adapter to the end of'],
  });
  assert.deepEqual(merged[1], { startMs: 185198, endMs: 190000, lines: ['the piston'] });
});

test('mergeRollingCues：两行滚动字幕每行只出现一次', () => {
  const merged = mergeRollingCues([
    { startMs: 0, endMs: 3000, lines: ['LINE A'] },
    { startMs: 2000, endMs: 5000, lines: ['LINE A', 'LINE B'] },
    { startMs: 4000, endMs: 7000, lines: ['LINE B', 'LINE C'] },
  ]);
  assert.deepEqual(merged.map((cue) => cue.lines.join(' ')), ['LINE A', 'LINE B', 'LINE C']);
});

test('mergeRollingCues：人工字幕（不重叠、不重复）原样通过', () => {
  const cues = [
    { startMs: 1000, endMs: 4000, lines: ['FIRST'] },
    { startMs: 4500, endMs: 7250, lines: ['SECOND'] },
  ];
  assert.deepEqual(mergeRollingCues(cues), cues);
});

test('subtitleOverlapRatio：重叠 cue 占比（滚动式 ≈ 1，人工字幕 = 0）', () => {
  const rolling = subtitleOverlapRatio([
    { startMs: 179199, endMs: 183199 },
    { startMs: 180878, endMs: 185198 },
    { startMs: 185198, endMs: 189198 },
    { startMs: 186000, endMs: 190000 },
  ]);
  assert.equal(rolling, 1);

  const clean = subtitleOverlapRatio([
    { startMs: 1000, endMs: 4000 },
    { startMs: 4500, endMs: 7250 },
    { startMs: 8000, endMs: 11000 },
  ]);
  assert.equal(clean, 0);
});

test('parseSrt：滚动字幕合并后没有重复正文段，跨度取最早 start → 最晚 end', () => {
  const segments = parseSrt(ROLLING_SRT);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((s) => s.text), [
    'attach the rinse adapter to the end of',
    'the piston',
  ]);
  // 没有重复正文
  assert.equal(new Set(segments.map((s) => s.text)).size, segments.length);
  assert.deepEqual(segments[0], {
    startMs: 179199,
    endMs: 185198,
    text: 'attach the rinse adapter to the end of',
  });
  assert.deepEqual(segments[1], { startMs: 185198, endMs: 190000, text: 'the piston' });
});

test('parseSrt：两行滚动字幕每行只出现一次', () => {
  const segments = parseSrt(ROLLING_TWO_LINE_SRT);
  assert.deepEqual(segments.map((s) => s.text), ['LINE A', 'LINE B', 'LINE C']);
});

test('parseSrt：人工字幕逐字节不变', () => {
  const segments = parseSrt(CLEAN_SRT);
  assert.deepEqual(segments, [
    { startMs: 1000, endMs: 4000, text: 'FIRST SUBTITLE LINE' },
    { startMs: 4500, endMs: 7250, text: 'SECOND SUBTITLE LINE' },
    { startMs: 8000, endMs: 11000, text: 'THIRD SUBTITLE LINE' },
  ]);
});

test('parseSubtitleDocument：滚动字幕 overlapRatio > 30%，人工字幕 = 0', () => {
  const rolling = parseSubtitleDocument(ROLLING_SRT, { format: 'srt' });
  assert.ok(rolling.overlapRatio > ROLLING_OVERLAP_RATIO_THRESHOLD);
  assert.equal(rolling.segments.length, 2);

  const clean = parseSubtitleDocument(CLEAN_SRT, { format: 'srt' });
  assert.equal(clean.overlapRatio, 0);
  assert.equal(clean.segments.length, 3);

  // parseSubtitles 只给段落
  assert.equal(parseSubtitles(CLEAN_SRT, { format: 'srt' }).length, 3);
});

test('readSubtitleFile：带上 overlapRatio（滚动式 > 30%，人工字幕 = 0）', async () => {
  await withTempSrt('rolling.srt', ROLLING_SRT, async (file) => {
    const parsed = await readSubtitleFile(file);
    assert.ok(parsed.overlapRatio > ROLLING_OVERLAP_RATIO_THRESHOLD);
    assert.equal(parsed.segments.length, 2);
  });
  await withTempSrt('clean.srt', CLEAN_SRT, async (file) => {
    const parsed = await readSubtitleFile(file);
    assert.equal(parsed.overlapRatio, 0);
    assert.equal(parsed.segments.length, 3);
  });
});

test('resolveSubtitleSource：滚动字幕给出警告，人工字幕没有警告', async () => {
  await withTempSrt('rolling.srt', ROLLING_SRT, async (file) => {
    const warnings = [];
    const source = await resolveSubtitleSource({
      mediaPath: path.join(path.dirname(file), 'a.mp4'),
      subtitle: file,
      streams: [],
      embedded: false,
      siblings: false,
      warnings,
    });
    assert.ok(source, '显式字幕文件应当命中');
    assert.equal(source.segments.length, 2);
    assert.ok(warnings.includes(ROLLING_SUBTITLE_WARNING));
    assert.ok(source.warnings.includes(ROLLING_SUBTITLE_WARNING));
  });

  await withTempSrt('clean.srt', CLEAN_SRT, async (file) => {
    const warnings = [];
    const source = await resolveSubtitleSource({
      mediaPath: path.join(path.dirname(file), 'a.mp4'),
      subtitle: file,
      streams: [],
      embedded: false,
      siblings: false,
      warnings,
    });
    assert.ok(source);
    assert.equal(source.segments.length, 3);
    assert.ok(!warnings.includes(ROLLING_SUBTITLE_WARNING));
    assert.ok(!source.warnings.includes(ROLLING_SUBTITLE_WARNING));
  });
});

test('警告文案：说清「按 ASR 对待」，不给绝对的可引用承诺', () => {
  assert.equal(
    ROLLING_SUBTITLE_WARNING,
    'rolling/auto-style captions detected — treat like ASR: check names and numbers against the frame.',
  );
  assert.ok(!/safe to quote/i.test(ROLLING_SUBTITLE_WARNING));
});
