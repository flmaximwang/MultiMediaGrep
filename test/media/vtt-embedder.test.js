// test/media/vtt-embedder.test.js —— 视频/音频书签的 VTT 投影（9z5.37.4）
//
// 覆盖验收点：
//   - 首次 add：从容器章节导入 b1…b4 + 新条目 → VTT 的 cue id / 时间 / 文本；
//   - 中文与特殊字符（& < > -->、换行、空白）转义后回读一致；
//   - 缺省 end：下一条 start，最后一条 = 媒体时长；end == duration 允许；
//   - 原子性：回读校验失败 / 取消 / 目录不可写 → 旧 VTT 不变、无临时文件、不写 sidecar；
//   - ffprobe 与 src/media/subtitles.js 都能读这份 VTT；
//   - 9z5.38.3 复用的纯函数（时间戳 / 转义 / buildVttCues / renderVtt / verifyVttText）。
//
// 只用 fixtures/generated 的合成素材：先复制到临时目录再写，绝不改动仓库素材。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BOOKMARK_VTT_SUFFIX,
  bookmarkVttPathFor,
  buildVttCues,
  escapeVttCueLine,
  foldVttText,
  formatVttTimestamp,
  renderVtt,
  renderVttCues,
  secondsToMs,
  verifyVttText,
  vttBookmarkEmbedder,
  writeTextAtomicVerified,
} from '../../src/media/bookmark/embedder-vtt.js';
import { bookmarkEngine } from '../../src/media/bookmark/index.js';
import { chaptersToOutline } from '../../src/media/chapters.js';
import { assertFfmpegAvailable, ffprobeJson, run } from '../../src/media/ffmpeg.js';
import { ToolError } from '../../src/media/interface.js';
import { parseVtt } from '../../src/media/subtitles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = path.join(ROOT, 'fixtures', 'generated');
const CHAPTERS_MP4 = path.join(GENERATED, 'sample-chapters.mp4');
const TONE_WAV = path.join(GENERATED, 'sample-tone.wav');
const CHAPTERS_GT = JSON.parse(await readFile(path.join(ROOT, 'fixtures', 'ground-truth', 'sample-chapters.json'), 'utf8'));

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasFfmpeg() {
  try {
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
}

const ffmpegReady = await hasFfmpeg();
const skipChapters = ffmpegReady && (await exists(CHAPTERS_MP4))
  ? false
  : 'ffprobe/ffmpeg + fixtures/generated/sample-chapters.mp4 are required (run npm run fixtures)';
const skipAudio = ffmpegReady && (await exists(TONE_WAV))
  ? false
  : 'ffprobe/ffmpeg + fixtures/generated/sample-tone.wav are required (run npm run fixtures)';

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

async function makeWorkspace(t, { fixture = null, name = 'media.bin' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-vtt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const media = path.join(dir, name);
  if (fixture) await copyFile(fixture, media);
  return { dir, media };
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function listTemps(dir) {
  return (await readdir(dir)).filter((name) => name.includes('.tmp'));
}

/** 视频 probe 结果（durationSec + 章节 outline，形状与 server/tools.js 一致） */
async function videoProbe(filePath) {
  const info = await ffprobeJson(filePath);
  return {
    mediaType: 'video',
    container: info?.format?.format_name ?? null,
    durationSec: Number(info?.format?.duration) || null,
    outline: chaptersToOutline(info),
  };
}

/** 按块读回 cue id（共享解析器不保留 cue id，所以这里自己读：正文行之前的标识行） */
function cueIdsOf(text) {
  const blocks = String(text).split(/\n{2,}/).slice(1);
  return blocks.filter((block) => block.trim() !== '').map((block) => block.split('\n')[0].trim());
}

function bodyLinesOf(text) {
  return String(text)
    .split('\n')
    .filter((line) => line !== '' && !/^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/.test(line));
}

function errorOf(promise) {
  return promise.then(
    () => null,
    (error) => error,
  );
}

/* ------------------------------------------------------------------ *
 * 纯函数：时间戳 / 转义 / cues / 渲染 / 回读校验
 * ------------------------------------------------------------------ */

test('纯函数：秒 → 毫秒 → HH:MM:SS.mmm 时间戳', () => {
  assert.equal(secondsToMs(0), 0);
  assert.equal(secondsToMs(1.2345), 1235);
  assert.equal(secondsToMs('2.5'), 2500);
  assert.equal(secondsToMs(-3), 0);
  assert.equal(secondsToMs(Number.NaN), null);
  assert.equal(secondsToMs(undefined), null);
  assert.equal(secondsToMs(null), null);

  assert.equal(formatVttTimestamp(0), '00:00:00.000');
  assert.equal(formatVttTimestamp(1235), '00:00:01.235');
  assert.equal(formatVttTimestamp(3_661_500), '01:01:01.500');
  assert.equal(formatVttTimestamp(360_000_000), '100:00:00.000');
});

test('纯函数：折行与转义（-->、& < >、空白、控制字符）', () => {
  assert.equal(foldVttText('  line1\n\nline2\r\nline3\t  '), 'line1 line2 line3');
  assert.equal(foldVttText('a\u00a0\u00a0b'), 'a b');
  assert.equal(foldVttText('a\u0000b\u0007c'), 'abc');
  assert.equal(foldVttText(''), '');

  assert.equal(escapeVttCueLine('a --> b & <c>'), 'a --&gt; b &amp; &lt;c&gt;');
  assert.equal(escapeVttCueLine('已转义 &amp; 不再动'), '已转义 &amp;amp; 不再动');
  assert.equal(escapeVttCueLine('x'), 'x');
});

test('纯函数：cue 排序、缺省 end 解析与同 start 冲突（不依赖 ffmpeg）', () => {
  const cues = buildVttCues(
    [
      { id: 'b2', title: 'Second', start: 5 },
      { id: 'b1', title: 'First', start: 0, end: 3 },
      { id: 'b3', title: 'Same start', start: 5 },
      { id: 'b4', title: 'Last', start: 7 },
    ],
    { durationSec: 10 },
  );
  assert.deepEqual(cues, [
    { id: 'b1', startMs: 0, endMs: 3000, lines: ['First'] },
    { id: 'b2', startMs: 5000, endMs: 5001, lines: ['Second'] },
    { id: 'b3', startMs: 5000, endMs: 7000, lines: ['Same start'] },
    { id: 'b4', startMs: 7000, endMs: 10_000, lines: ['Last'] },
  ]);

  // 显式 end 超过 duration 不校验（引擎负责范围校验），渲染器只保证 end > start
  assert.equal(buildVttCues([{ id: 'b1', title: 'X', start: 2, end: 2 }])[0].endMs, 2001);

  const text = renderVtt(
    [
      { id: 'b1', title: 'First', start: 0, end: 3 },
      { id: 'b2', title: 'Last', start: 5 },
    ],
    { durationSec: 10 },
  );
  assert.equal(text, 'WEBVTT\n\nb1\n00:00:00.000 --> 00:00:03.000\nFirst\n\nb2\n00:00:05.000 --> 00:00:10.000\nLast\n');
  assert.deepEqual(verifyVttText(text, buildVttCues([
    { id: 'b1', title: 'First', start: 0, end: 3 },
    { id: 'b2', title: 'Last', start: 5 },
  ], { durationSec: 10 })).ok, true);

  // 空条目 → 只有头
  assert.equal(renderVtt([]), 'WEBVTT\n');
  assert.deepEqual(verifyVttText('WEBVTT\n', []), { ok: true, detail: '0 cues, ids, HH:MM:SS.mmm times and text match' });
});

test('纯函数：多行 cue（9z5.38.3 的注释模式）与非法输入', () => {
  const cues = buildVttCues(
    [
      { id: 'n1', title: 'note line 1\n\nnote line 2\nnote line 3', start: 0, end: 2 },
      { id: 'n2', title: 'overlap', start: 1, end: 3 },
    ],
    { durationSec: 3, multiline: true },
  );
  assert.deepEqual(cues[0].lines, ['note line 1', 'note line 2', 'note line 3']);
  const text = renderVttCues(cues);
  assert.ok(text.includes('n1\n00:00:00.000 --> 00:00:02.000\nnote line 1\nnote line 2\nnote line 3\n'));
  assert.deepEqual(parseVtt(text).map((segment) => segment.text), ['note line 1 note line 2 note line 3', 'overlap']);
  assert.equal(verifyVttText(text, cues).ok, true);

  // 非法 id / 空文本 / 缺 duration 的缺省 end
  assert.throws(() => buildVttCues([{ id: 'a --> b', title: 'x', start: 0, end: 1 }]), (error) => error instanceof ToolError && error.code === 'INTERNAL');
  assert.throws(() => buildVttCues([{ id: 'b1', title: '  \n ', start: 0, end: 1 }]), (error) => error instanceof ToolError && error.code === 'INVALID_ARGUMENT');
  assert.throws(() => buildVttCues([{ id: 'b1', title: 'x', start: 0 }]), (error) => error instanceof ToolError && error.code === 'INTERNAL');
});

test('回读校验：BOM / CRLF / 错误 id / 错误时间 / 错误文本都会失败并指出差异', () => {
  const cues = buildVttCues([{ id: 'b1', title: 'One', start: 0, end: 2 }], { durationSec: 2 });
  const good = renderVttCues(cues);
  assert.equal(verifyVttText(good, cues).ok, true);

  const cases = [
    ['\ufeff' + good, /BOM/],
    [good.replace(/\n/g, '\r\n'), /CR/],
    [good.replace('b1', 'b9'), /identifier/],
    [good.replace('00:00:02.000', '00:00:03.000'), /timing line/],
    [good.replace('One', 'Two'), /text lines/],
    ['', /empty/],
    ['hello\n', /WEBVTT/],
  ];
  for (const [text, pattern] of cases) {
    const verdict = verifyVttText(text, cues);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, pattern);
  }
});

test('回读校验：相邻同名 cue 会被共享解析器当成滚动字幕折叠（媒体书签仍然合法）', () => {
  const cues = buildVttCues(
    [
      { id: 'b1', title: 'Intro', start: 0, end: 2 },
      { id: 'b2', title: 'Intro', start: 3, end: 5 },
    ],
    { durationSec: 5 },
  );
  const text = renderVttCues(cues);
  const verdict = verifyVttText(text, cues);
  assert.equal(verdict.ok, true);
  assert.match(verdict.detail, /parser merges 1 rolling-style duplicate/);
  assert.deepEqual(parseVtt(text), [{ startMs: 0, endMs: 2000, text: 'Intro' }]);
});

/* ------------------------------------------------------------------ *
 * 原子写
 * ------------------------------------------------------------------ */

test('原子写：回读校验失败 → 目标文件不变、没有临时文件', async (t) => {
  const ws = await makeWorkspace(t);
  const target = path.join(ws.dir, 'lecture.mp4.mmgrep.bookmark.vtt');
  await writeFile(target, 'WEBVTT\n\nold\n');

  const result = await writeTextAtomicVerified(target, 'WEBVTT\n\nnew\n', {
    verifyText: () => ({ ok: false, detail: 'injected read-back mismatch' }),
  });
  assert.deepEqual(result, { ok: false, detail: 'injected read-back mismatch' });
  assert.equal(await readFile(target, 'utf8'), 'WEBVTT\n\nold\n');
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('原子写：写入过程中取消 → AbortError、目标文件不变、没有临时文件', async (t) => {
  const ws = await makeWorkspace(t);
  const target = path.join(ws.dir, 'lecture.mp4.mmgrep.bookmark.vtt');
  await writeFile(target, 'WEBVTT\n\nold\n');

  const controller = new AbortController();
  const error = await errorOf(writeTextAtomicVerified(target, 'WEBVTT\n\nnew\n', {
    signal: controller.signal,
    verifyText: () => {
      controller.abort();
      return { ok: true };
    },
  }));
  assert.equal(error?.name, 'AbortError');
  assert.equal(await readFile(target, 'utf8'), 'WEBVTT\n\nold\n');
  assert.deepEqual(await listTemps(ws.dir), []);

  // 开始前就已取消：同样不写
  const aborted = await errorOf(writeTextAtomicVerified(target, 'WEBVTT\n\nnew\n', {
    signal: AbortSignal.abort(),
    verifyText: () => ({ ok: true }),
  }));
  assert.equal(aborted?.name, 'AbortError');
  assert.equal(await readFile(target, 'utf8'), 'WEBVTT\n\nold\n');
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('嵌入器：媒体不可探测（缺 end 需要时长）→ vtt-duration 失败检查项，不写 VTT', async (t) => {
  const ws = await makeWorkspace(t);
  await writeFile(ws.media, 'this is not a media file\n');

  const result = await vttBookmarkEmbedder.embed({
    filePath: ws.media,
    media: 'video',
    entries: [{ id: 'b1', title: 'One', start: 0 }],
    sidecarPath: null,
    signal: null,
  });
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [['vtt-duration', false]]);
  assert.match(result.checks[0].detail, /ffprobe failed/);
  assert.equal(existsSync(result.target), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('嵌入器：非 video/audio 直接拒绝（注册表只会把这两种交给它）', async () => {
  const error = await errorOf(vttBookmarkEmbedder.embed({ filePath: '/tmp/x.pdf', media: 'pdf', entries: [] }));
  assert.ok(error instanceof ToolError);
  assert.equal(error.code, 'INTERNAL');
  assert.match(error.message, /only handles video\/audio/);
});

test('引擎：目录不可写 → 报 cannot write、不写 sidecar、旧 VTT 不变、没有临时文件', { skip: skipChapters }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: path.basename(CHAPTERS_MP4) });
  const vttPath = bookmarkVttPathFor(ws.media);
  await writeFile(vttPath, 'WEBVTT\n\nold\n');
  const probe = await videoProbe(ws.media);

  await chmod(ws.dir, 0o500);
  let error;
  try {
    error = await errorOf(bookmarkEngine.execute({
      filePath: ws.media,
      media: 'video',
      probe,
      operations: { add: [{ title: 'One', start: 0 }] },
    }));
  } finally {
    await chmod(ws.dir, 0o700);
  }

  assert.ok(error instanceof ToolError);
  assert.equal(error.code, 'INTERNAL');
  assert.match(error.message, /cannot write/);
  assert.equal(existsSync(`${ws.media}.mmgrep.bookmark.json`), false);
  assert.equal(await readFile(vttPath, 'utf8'), 'WEBVTT\n\nold\n');
  assert.deepEqual(await listTemps(ws.dir), []);
});

/* ------------------------------------------------------------------ *
 * 端到端：引擎 + 真实 mp4 / wav
 * ------------------------------------------------------------------ */

test('首次 add：导入容器章节 + 新条目 → VTT 的 cue id/时间/文本正确，媒体文件哈希不变', { skip: skipChapters }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: 'sample-chapters.mp4' });
  const beforeHash = await sha256(ws.media);
  const probe = await videoProbe(ws.media);
  assert.equal(probe.durationSec, CHAPTERS_GT.durationMs / 1000);
  assert.deepEqual(
    probe.outline.entries.map((entry) => [entry.title, entry.startSec * 1000, entry.endSec * 1000]),
    CHAPTERS_GT.chapters.map((chapter) => [chapter.title, chapter.startMs, chapter.endMs]),
  );

  const result = await bookmarkEngine.execute({
    filePath: ws.media,
    media: 'video',
    probe,
    operations: {
      add: [
        { title: '中文段落 & <tag> --> 箭头', start: 6 },
        { title: 'Second', start: 7.5, end: 10 },
      ],
    },
  });

  // 首次写入：导入 4 章 + 2 条新条目（b5/b6）
  assert.equal(result.created, true);
  assert.equal(result.imported, 4);
  assert.deepEqual(result.applied, { remove: [], update: [], add: ['b5', 'b6'] });
  assert.deepEqual(result.embed.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
  ]);
  assert.match(result.embed.checks[0].detail, /^6 cues, ids, HH:MM:SS\.mmm times and text match/);
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
    ['sidecar-readback', true],
  ]);

  const vttPath = bookmarkVttPathFor(ws.media);
  assert.equal(vttPath, `${ws.media}${BOOKMARK_VTT_SUFFIX}`);
  assert.equal(result.embed.target, vttPath);
  assert.equal(await sha256(ws.media), beforeHash, '媒体文件必须逐字节不变');
  assert.deepEqual((await readdir(ws.dir)).sort(), [
    'sample-chapters.mp4',
    'sample-chapters.mp4.mmgrep.bookmark.json',
    'sample-chapters.mp4.mmgrep.bookmark.vtt',
  ].sort());
  assert.deepEqual(await listTemps(ws.dir), []);

  const text = await readFile(vttPath, 'utf8');
  assert.notEqual(text.charCodeAt(0), 0xfeff);
  assert.ok(text.startsWith('WEBVTT\n\n'));
  assert.ok(text.endsWith('\n'));
  assert.equal(text.includes('\r'), false);

  // cue id = 条目 id，按 start 排序（b5 插在 b3 与 b4 之间）
  assert.deepEqual(cueIdsOf(text), ['b1', 'b2', 'b3', 'b5', 'b6', 'b4']);
  // 缺省 end：b5 的 end = 下一条 b6 的 start；b4 的 end = 容器章节的 end（== duration）
  assert.ok(text.includes('b5\n00:00:06.000 --> 00:00:07.500\n中文段落 &amp; &lt;tag&gt; --&gt; 箭头\n'));
  assert.ok(text.includes('b6\n00:00:07.500 --> 00:00:10.000\nSecond\n'));
  assert.ok(text.includes('b4\n00:00:09.000 --> 00:00:12.000\nWrap Up\n'));
  // 正文行里不存在未转义的 -->
  assert.equal(bodyLinesOf(text).some((line) => line.includes('-->')), false);

  // 共享解析器（src/media/subtitles.js）回读：时间与文本一致
  assert.deepEqual(parseVtt(text), [
    { startMs: 0, endMs: 2000, text: 'Opening' },
    { startMs: 2000, endMs: 5000, text: 'Build Up' },
    { startMs: 5000, endMs: 9000, text: 'Main Section' },
    { startMs: 6000, endMs: 7500, text: '中文段落 & <tag> --> 箭头' },
    { startMs: 7500, endMs: 10_000, text: 'Second' },
    { startMs: 9000, endMs: 12_000, text: 'Wrap Up' },
  ]);

  // ffprobe / ffmpeg 能读这份 VTT：webvtt 格式，每个 cue 一个 packet
  const vttInfo = await ffprobeJson(vttPath);
  assert.equal(vttInfo.format.format_name, 'webvtt');
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', vttPath]);
  const packets = JSON.parse(stdout).packets;
  assert.equal(packets.length, 6);
  assert.deepEqual(
    packets.map((packet) => [Number(packet.pts_time), Number(packet.duration_time)]),
    [[0, 2], [2, 3], [5, 4], [6, 1.5], [7.5, 2.5], [9, 3]],
  );

  // sidecar 仍是真相源（VTT 只是投影）
  const sidecar = JSON.parse(await readFile(result.sidecarPath, 'utf8'));
  assert.equal(sidecar.media, 'video');
  assert.deepEqual(sidecar.entries.map((entry) => entry.id), ['b1', 'b2', 'b3', 'b5', 'b6', 'b4']);
  assert.deepEqual(sidecar.entries.find((entry) => entry.id === 'b5'), { id: 'b5', title: '中文段落 & <tag> --> 箭头', start: 6 });
});

test('中文与特殊字符：转义 → 回读文本一致（换行折行、--&gt; 不破坏 cue、ffprobe 可读）', { skip: skipChapters }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: 'sample-chapters.mp4' });
  const entries = [
    { id: 'b1', title: '中文：第一章 — & <b>bold</b> --> 箭头', start: 0, end: 2 },
    { id: 'b2', title: 'line1\nline2\r\nline3', start: 2, end: 4 },
    { id: 'b3', title: '  \t  空白   折叠  ', start: 4, end: 6 },
    { id: 'b4', title: 'a --> b --> c', start: 6, end: 8 },
  ];

  const result = await vttBookmarkEmbedder.embed({ filePath: ws.media, media: 'video', entries, sidecarPath: null, signal: null });
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
  ]);

  const text = await readFile(result.target, 'utf8');
  assert.notEqual(text.charCodeAt(0), 0xfeff);
  assert.equal(text.includes('\r'), false);
  assert.deepEqual(cueIdsOf(text), ['b1', 'b2', 'b3', 'b4']);
  assert.equal(bodyLinesOf(text).some((line) => line.includes('-->')), false);

  const segments = parseVtt(text);
  assert.deepEqual(segments.map((segment) => segment.text), [
    '中文：第一章 — & <b>bold</b> --> 箭头',
    'line1 line2 line3',
    '空白 折叠',
    'a --> b --> c',
  ]);
  assert.deepEqual(segments.map((segment) => [segment.startMs, segment.endMs]), [
    [0, 2000],
    [2000, 4000],
    [4000, 6000],
    [6000, 8000],
  ]);

  const vttInfo = await ffprobeJson(result.target);
  assert.equal(vttInfo.format.format_name, 'webvtt');
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'packet=pts_time', '-of', 'json', result.target]);
  assert.equal(JSON.parse(stdout).packets.length, 4);
});

test('缺省 end：下一条 start / 媒体时长（音频 fixture），end == duration 允许', { skip: skipAudio }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: TONE_WAV, name: 'sample-tone.wav' });
  const entries = [
    { id: 'b1', title: 'One', start: 1 },
    { id: 'b2', title: 'Two', start: 4, end: 10 },
    { id: 'b3', title: 'Three', start: 6 },
  ];

  const result = await vttBookmarkEmbedder.embed({ filePath: ws.media, media: 'audio', entries, sidecarPath: null, signal: null });
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
  ]);
  assert.match(result.checks[1].detail, /is unchanged/);

  const text = await readFile(result.target, 'utf8');
  assert.deepEqual(cueIdsOf(text), ['b1', 'b2', 'b3']);
  assert.deepEqual(parseVtt(text), [
    { startMs: 1000, endMs: 4000, text: 'One' },      // 缺省 end = 下一条 start
    { startMs: 4000, endMs: 10_000, text: 'Two' },    // 显式 end == 媒体时长（允许）
    { startMs: 6000, endMs: 10_000, text: 'Three' },  // 最后一条缺省 end = 媒体时长
  ]);

  const vttInfo = await ffprobeJson(result.target);
  assert.equal(vttInfo.format.format_name, 'webvtt');
});

test('第二次写入：VTT 全量重写为 sidecar 的投影（旧 cue 被移除，媒体哈希不变）', { skip: skipChapters }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: 'sample-chapters.mp4' });
  const probe = await videoProbe(ws.media);
  const beforeHash = await sha256(ws.media);

  await bookmarkEngine.execute({
    filePath: ws.media,
    media: 'video',
    probe,
    operations: { add: [{ title: 'Q&A', start: 10 }] },
  });
  const result = await bookmarkEngine.execute({
    filePath: ws.media,
    media: 'video',
    probe,
    operations: { remove: ['b2'], update: [{ id: 'b5', title: '问答 & 讨论' }] },
  });

  assert.deepEqual(result.applied, { remove: ['b2'], update: ['b5'], add: [] });
  const text = await readFile(bookmarkVttPathFor(ws.media), 'utf8');
  assert.deepEqual(cueIdsOf(text), ['b1', 'b3', 'b4', 'b5']);
  assert.ok(text.includes('问答 &amp; 讨论'));
  assert.equal(text.includes('Build Up'), false);
  assert.equal(await sha256(ws.media), beforeHash);
  assert.deepEqual(await listTemps(ws.dir), []);
});
