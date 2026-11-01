// test/media/subtitles.test.js —— 字幕解析（纯文本，不需要 ffmpeg）
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  cleanSubtitleText,
  detectSubtitleFormat,
  parseAss,
  parseSrt,
  parseSubtitles,
  parseVtt,
  readSubtitleFile,
} from '../../src/media/subtitles.js';

const SRT = `1
00:00:01,000 --> 00:00:04,000
第一句字幕。

2
00:00:04,500 --> 00:00:07,250
第二句，<i>带标记</i> &amp; 实体。
`;

const VTT = `WEBVTT

NOTE 这是注释，应当跳过

cue-1
00:00:01.000 --> 00:00:04.000 align:start position:10%
第一句 <c.color>字幕</c>

00:04.500 --> 00:07.250
第二句
`;

const ASS = `[Script Info]
Title: 测试
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\pos(100,200)}第一句，带逗号
Dialogue: 0,0:00:04.50,0:00:07.25,Default,,0,0,0,,第二句
`;

test('detectSubtitleFormat：扩展名与内容都能识别', () => {
  assert.equal(detectSubtitleFormat('a.srt'), 'srt');
  assert.equal(detectSubtitleFormat('a.vtt'), 'vtt');
  assert.equal(detectSubtitleFormat('a.ass'), 'ass');
  assert.equal(detectSubtitleFormat('a.ssa'), 'ssa');
  assert.equal(detectSubtitleFormat(VTT), 'vtt');
  assert.equal(detectSubtitleFormat(ASS), 'ass');
  assert.equal(detectSubtitleFormat(SRT), 'srt');
  assert.equal(detectSubtitleFormat('just some text'), null);
});

test('cleanSubtitleText：去标签、去 ASS 覆盖码、解实体', () => {
  assert.equal(cleanSubtitleText('<i>你好</i>'), '你好');
  assert.equal(cleanSubtitleText('{\\pos(1,2)}文字'), '文字');
  assert.equal(cleanSubtitleText('a &amp; b &lt;c&gt;'), 'a & b <c>');
  assert.equal(cleanSubtitleText('  多   空格  '), '多 空格');
});

test('parseSrt：毫秒与文本', () => {
  const segments = parseSrt(SRT);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { startMs: 1000, endMs: 4000, text: '第一句字幕。' });
  assert.deepEqual(segments[1], { startMs: 4500, endMs: 7250, text: '第二句，带标记 & 实体。' });
});

test('parseVtt：跳过 NOTE、忽略 cue 设置、支持省略小时', () => {
  const segments = parseVtt(VTT);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { startMs: 1000, endMs: 4000, text: '第一句 字幕' });
  assert.deepEqual(segments[1], { startMs: 4500, endMs: 7250, text: '第二句' });
});

test('parseAss：按 Format 字段定位，Text 里的逗号不切坏', () => {
  const segments = parseAss(ASS);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { startMs: 1000, endMs: 4000, text: '第一句，带逗号' });
  assert.deepEqual(segments[1], { startMs: 4500, endMs: 7250, text: '第二句' });
});

test('parseSubtitles：未识别的格式 → TRANSCRIPT_UNREADABLE', () => {
  assert.throws(() => parseSubtitles('随便什么文本'), (e) => e.code === 'TRANSCRIPT_UNREADABLE');
});

test('readSubtitleFile：读文件、报错清晰', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-subs-'));
  try {
    const srtPath = path.join(dir, 'a.srt');
    await writeFile(srtPath, SRT);
    const parsed = await readSubtitleFile(srtPath);
    assert.equal(parsed.format, 'srt');
    assert.equal(parsed.segments.length, 2);

    const emptyPath = path.join(dir, 'empty.vtt');
    await writeFile(emptyPath, 'WEBVTT\n\n');
    await assert.rejects(() => readSubtitleFile(emptyPath), (e) => e.code === 'TRANSCRIPT_UNREADABLE');

    await assert.rejects(() => readSubtitleFile(path.join(dir, 'nope.srt')), (e) => e.code === 'PATH_NOT_FOUND');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
