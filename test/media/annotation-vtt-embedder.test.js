// test/media/annotation-vtt-embedder.test.js —— 视频/录音批注的 VTT 投影（9z5.38.3）
//
// 覆盖验收点（MultiMediaGrep-9z5.38.3）：
//   - 批注写成 <源文件>.mmgrep.annotation.vtt（源文件同目录），**媒体文件逐字节不变**；
//   - cue id = 批注 id（n1…），cue 正文 = note；
//   - 多行 note 在 cue 里保持多行；note 里的空行不截断 cue（读侧还原成空行）；
//   - 重叠批注允许（各占一个 cue）；缺省 end = start + 5 s（截到媒体时长）；
//   - 中文与特殊字符（& < > -->）转义后回读一致；
//   - 回读：共享解析器（src/media/subtitles.js）与读侧 API（parseAnnotationVtt）一致；
//   - 原子性：写失败 → 旧 VTT 不变、无临时文件、sidecar 不写。
//
// 只用 fixtures/generated 的合成素材：先复制到临时目录再写，绝不改动仓库素材。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderVttCues } from '../../src/media/bookmark/embedder-vtt.js';
import {
  ANNOTATION_VTT_SUFFIX,
  annotationVttPathFor,
  buildAnnotationVttCues,
  parseAnnotationVtt,
  vttAnnotationEmbedder,
} from '../../src/media/annotation/embedder-vtt.js';
import { annotationEngine } from '../../src/media/annotation/index.js';
import { assertFfmpegAvailable, ffprobeJson } from '../../src/media/ffmpeg.js';
import { ToolError } from '../../src/media/interface.js';
import { parseVtt } from '../../src/media/subtitles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = path.join(ROOT, 'fixtures', 'generated');
const CHAPTERS_MP4 = path.join(GENERATED, 'sample-chapters.mp4');
const TONE_WAV = path.join(GENERATED, 'sample-tone.wav');
const CHAPTERS_GT = JSON.parse(
  await readFile(path.join(ROOT, 'fixtures', 'ground-truth', 'sample-chapters.json'), 'utf8'),
);
const DURATION_SEC = CHAPTERS_GT.durationMs / 1000;

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
const skipChapters =
  ffmpegReady && (await exists(CHAPTERS_MP4))
    ? false
    : 'ffprobe/ffmpeg + fixtures/generated/sample-chapters.mp4 are required (run npm run fixtures)';
const skipAudio =
  ffmpegReady && (await exists(TONE_WAV))
    ? false
    : 'ffprobe/ffmpeg + fixtures/generated/sample-tone.wav are required (run npm run fixtures)';
// 目录权限在 root 下不生效（root 可以无视 0500），那种环境跳过权限相关的用例
const skipPerm = process.getuid?.() === 0 ? 'running as root: directory permissions are not enforced' : false;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

async function makeWorkspace(t, { fixture = null, name = 'media.bin' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-annotation-vtt-'));
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

/** 按块读回 cue id（共享解析器不保留 cue id，所以这里自己读：计时行之前的标识行） */
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

/** 视频 probe 结果（形状与 server/tools.js 一致）：只需要 durationSec */
async function videoProbe(filePath) {
  const info = await ffprobeJson(filePath);
  return {
    mediaType: 'video',
    container: info?.format?.format_name ?? null,
    durationSec: Number(info?.format?.duration) || null,
  };
}

/* ------------------------------------------------------------------ *
 * 纯函数：批注 → cue
 * ------------------------------------------------------------------ */

test('纯函数：批注 → cue（cue id = 批注 id、多行 note、空行占位、按 start 排序）', () => {
  const cues = buildAnnotationVttCues([
    { id: 'n2', note: '第二条', start: 5, end: 7 },
    { id: 'n1', note: '第一行\n\n第三行', start: 0, end: 2 },
    { id: 'n3', note: '与 n2 同时开始', start: 5, end: 9 },
  ]);
  assert.deepEqual(cues, [
    { id: 'n1', startMs: 0, endMs: 2000, lines: ['第一行', ' ', '第三行'] },
    { id: 'n2', startMs: 5000, endMs: 7000, lines: ['第二条'] },
    { id: 'n3', startMs: 5000, endMs: 9000, lines: ['与 n2 同时开始'] },
  ]);
});

test('纯函数：缺省 end = start + 5 s（截到时长）；end <= start 时向后推 1 ms', () => {
  const cues = buildAnnotationVttCues(
    [
      { id: 'n1', note: '缺省 end', start: 1 },
      { id: 'n2', note: '靠近结尾', start: 10 },
      { id: 'n3', note: '就在结尾', start: 12 },
    ],
    { durationSec: 12 },
  );
  assert.deepEqual(cues.map((cue) => [cue.id, cue.startMs, cue.endMs]), [
    ['n1', 1000, 6000],
    ['n2', 10_000, 12_000],
    ['n3', 12_000, 12_001],
  ]);

  // 时长未知 → 不截断（引擎写进 sidecar 的也是不截断的 start + 5 s）
  const unknown = buildAnnotationVttCues([{ id: 'n1', note: 'x', start: 1 }]);
  assert.deepEqual(unknown.map((cue) => [cue.startMs, cue.endMs]), [[1000, 6000]]);
});

test('纯函数：非法 id / 空 note / 非有限 start 会报错', () => {
  assert.throws(
    () => buildAnnotationVttCues([{ id: 'a --> b', note: 'x', start: 0, end: 1 }]),
    (error) => error instanceof ToolError && error.code === 'INTERNAL',
  );
  assert.throws(
    () => buildAnnotationVttCues([{ id: 'WEBVTT', note: 'x', start: 0, end: 1 }]),
    (error) => error instanceof ToolError && error.code === 'INTERNAL',
  );
  assert.throws(
    () => buildAnnotationVttCues([{ id: 'n1', note: '  \n ', start: 0, end: 1 }]),
    (error) => error instanceof ToolError && error.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => buildAnnotationVttCues([{ id: 'n1', note: 'x', start: Number.NaN, end: 1 }]),
    (error) => error instanceof ToolError && error.code === 'INVALID_ARGUMENT',
  );
});

/* ------------------------------------------------------------------ *
 * 读侧 API
 * ------------------------------------------------------------------ */

test('读侧：parseAnnotationVtt 把 note 原样读回（多行、空行、中文、实体反转义）', () => {
  const cues = buildAnnotationVttCues([
    { id: 'n1', note: '中文 & <tag> --> 箭头', start: 0, end: 2 },
    { id: 'n2', note: '第一行\n\n第三行', start: 2, end: 4 },
  ]);
  const text = renderVttCues(cues);

  const parsed = parseAnnotationVtt(text);
  assert.deepEqual(parsed.map((cue) => [cue.id, cue.startMs, cue.endMs]), [
    ['n1', 0, 2000],
    ['n2', 2000, 4000],
  ]);
  // note 原样读回：空行还原成空行，实体反转义
  assert.equal(parsed[0].note, '中文 & <tag> --> 箭头');
  assert.equal(parsed[1].note, '第一行\n\n第三行');
  assert.deepEqual(parsed[1].lines, ['第一行', '', '第三行']);
});

/* ------------------------------------------------------------------ *
 * 嵌入器
 * ------------------------------------------------------------------ */

test('嵌入器：写 <源文件>.mmgrep.annotation.vtt；cue id = 批注 id；媒体文件哈希不变', { skip: skipChapters }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: 'lecture.mp4' });
  const beforeHash = await sha256(ws.media);
  const beforeStat = await stat(ws.media);

  const result = await vttAnnotationEmbedder.embed({
    filePath: ws.media,
    media: 'video',
    entries: [
      { id: 'n1', note: '第一条批注', start: 0, end: 2 },
      { id: 'n2', note: '第二条批注', start: 2, end: 4 },
    ],
    sidecarPath: null,
    signal: null,
  });

  assert.equal(result.target, annotationVttPathFor(ws.media));
  assert.equal(result.target, `${ws.media}${ANNOTATION_VTT_SUFFIX}`);
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
  ]);
  assert.match(result.checks[0].detail, /2 cues, ids, HH:MM:SS\.mmm times and text match/);
  assert.match(result.checks[1].detail, /is unchanged/);

  // 媒体文件逐字节不变（sha256 + size + mtime）
  assert.equal(await sha256(ws.media), beforeHash, '媒体文件必须逐字节不变');
  const afterStat = await stat(ws.media);
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);

  const text = await readFile(result.target, 'utf8');
  assert.notEqual(text.charCodeAt(0), 0xfeff, '不能有 BOM');
  assert.equal(text.includes('\r'), false, '只能是 LF');
  assert.ok(text.startsWith('WEBVTT\n\n'));
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(cueIdsOf(text), ['n1', 'n2']);
  assert.ok(text.includes('n1\n00:00:00.000 --> 00:00:02.000\n第一条批注\n'));
  assert.deepEqual(await listTemps(ws.dir), []);
  assert.deepEqual((await readdir(ws.dir)).sort(), ['lecture.mp4', 'lecture.mp4.mmgrep.annotation.vtt']);

  // 共享解析器回读：时间与文本一致
  assert.deepEqual(parseVtt(text), [
    { startMs: 0, endMs: 2000, text: '第一条批注' },
    { startMs: 2000, endMs: 4000, text: '第二条批注' },
  ]);
  // ffprobe 能读这份 VTT
  const vttInfo = await ffprobeJson(result.target);
  assert.equal(vttInfo.format.format_name, 'webvtt');
});

test('中文与特殊字符：--> & < > 与多行 note 不损坏 cue，回读一致', { skip: skipChapters }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: 'lecture.mp4' });
  const entries = [
    { id: 'n1', note: '中文：引号 " 与 & <b>粗体</b> --> 箭头', start: 0, end: 2 },
    { id: 'n2', note: '第一行\n\n第三行', start: 2, end: 4 },
    { id: 'n3', note: 'a --> b --> c', start: 4, end: 6 },
    { id: 'n4', note: '尾行', start: 6, end: 8 },
  ];

  const result = await vttAnnotationEmbedder.embed({
    filePath: ws.media,
    media: 'video',
    entries,
    sidecarPath: null,
    signal: null,
  });
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
  ]);

  const text = await readFile(result.target, 'utf8');
  assert.deepEqual(cueIdsOf(text), ['n1', 'n2', 'n3', 'n4']);
  // 正文行里不存在未转义的 -->
  assert.equal(bodyLinesOf(text).some((line) => line.includes('-->')), false);
  assert.ok(text.includes('中文：引号 " 与 &amp; &lt;b&gt;粗体&lt;/b&gt; --&gt; 箭头'));
  // note 里的空行换成「只含一个空格的行」：cue 没被截断，读侧能还原
  assert.ok(text.includes('n2\n00:00:02.000 --> 00:00:04.000\n第一行\n \n第三行\n'));
  assert.deepEqual(parseVtt(text).map((segment) => segment.text), [
    '中文：引号 " 与 & <b>粗体</b> --> 箭头',
    '第一行 第三行',
    'a --> b --> c',
    '尾行',
  ]);
  // 读侧 API：note 原样回来
  const parsed = parseAnnotationVtt(text);
  assert.deepEqual(parsed.map((cue) => cue.note), entries.map((entry) => entry.note));
});

test('重叠批注：两条时间重叠的批注各占一个 cue（共享字幕解析器会把同文本的合并）', { skip: skipChapters }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: 'lecture.mp4' });

  const result = await vttAnnotationEmbedder.embed({
    filePath: ws.media,
    media: 'video',
    entries: [
      { id: 'n1', note: '重叠的第一条', start: 1, end: 4 },
      { id: 'n2', note: '重叠的第二条', start: 2, end: 5 },
    ],
    sidecarPath: null,
    signal: null,
  });
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
  ]);

  const text = await readFile(result.target, 'utf8');
  assert.deepEqual(cueIdsOf(text), ['n1', 'n2']);
  assert.deepEqual(parseAnnotationVtt(text).map((cue) => [cue.id, cue.startMs, cue.endMs]), [
    ['n1', 1000, 4000],
    ['n2', 2000, 5000],
  ]);
  // 文本不同 → 共享字幕解析器也保留两条
  assert.deepEqual(parseVtt(text).map((segment) => segment.text), ['重叠的第一条', '重叠的第二条']);

  // 文本相同且重叠 → 共享字幕解析器按滚动字幕合并（VTT 里仍是两个 cue）
  const same = await vttAnnotationEmbedder.embed({
    filePath: ws.media,
    media: 'video',
    entries: [
      { id: 'n1', note: '相同', start: 0, end: 3 },
      { id: 'n2', note: '相同', start: 1, end: 4 },
    ],
    sidecarPath: null,
    signal: null,
  });
  const sameText = await readFile(same.target, 'utf8');
  assert.deepEqual(cueIdsOf(sameText), ['n1', 'n2']);
  assert.match(same.checks[0].detail, /parser merges 1 rolling-style duplicate/);
  assert.deepEqual(parseVtt(sameText).length, 1);
  // 读侧 API 不合并：批注必须各自保留
  assert.deepEqual(parseAnnotationVtt(sameText).map((cue) => cue.id), ['n1', 'n2']);
});

test('缺省 end：start + 5 s，截到媒体时长（12 s 的合成视频）', { skip: skipChapters }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: 'lecture.mp4' });
  const result = await vttAnnotationEmbedder.embed({
    filePath: ws.media,
    media: 'video',
    entries: [
      { id: 'n1', note: '缺省 end', start: 1 },
      { id: 'n2', note: '靠近结尾', start: 10 },
      { id: 'n3', note: '就在结尾', start: 12 },
    ],
    sidecarPath: null,
    signal: null,
  });
  // 时长可探测 → 不需要 vtt-end-default 检查项
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
  ]);

  const cues = parseAnnotationVtt(await readFile(result.target, 'utf8'));
  assert.deepEqual(cues.map((cue) => [cue.id, cue.startMs, cue.endMs]), [
    ['n1', 1000, 6000],
    ['n2', 10_000, 12_000],
    ['n3', 12_000, 12_001],
  ]);
  assert.equal(DURATION_SEC, 12);
});

test('媒体时长未知（ffprobe 失败）：end = start + 5 s 不截断，并给出 vtt-end-default 检查项', async (t) => {
  const ws = await makeWorkspace(t, { name: 'broken.mp4' });
  await writeFile(ws.media, 'this is not a media file\n');

  const result = await vttAnnotationEmbedder.embed({
    filePath: ws.media,
    media: 'video',
    entries: [{ id: 'n1', note: '时长未知', start: 1 }],
    sidecarPath: null,
    signal: null,
  });
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
    ['vtt-end-default', true],
  ]);
  assert.match(result.checks[2].detail, /ffprobe failed/);
  assert.match(result.checks[2].detail, /start \+ 5s/);

  const cues = parseAnnotationVtt(await readFile(result.target, 'utf8'));
  assert.deepEqual(cues.map((cue) => [cue.startMs, cue.endMs]), [[1000, 6000]]);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('每条批注都有 end：不探测媒体时长（没有 vtt-end-default 检查项）', async (t) => {
  const ws = await makeWorkspace(t, { name: 'broken.mp4' });
  await writeFile(ws.media, 'this is not a media file\n');

  const result = await vttAnnotationEmbedder.embed({
    filePath: ws.media,
    media: 'video',
    entries: [{ id: 'n1', note: '显式 end', start: 1, end: 2 }],
    sidecarPath: null,
    signal: null,
  });
  assert.deepEqual(result.checks.map((check) => check.name), ['vtt-readback', 'media-unchanged']);
  const cues = parseAnnotationVtt(await readFile(result.target, 'utf8'));
  assert.deepEqual(cues.map((cue) => [cue.startMs, cue.endMs]), [[1000, 2000]]);
});

test('嵌入器：非 video/audio 直接拒绝', async () => {
  const error = await errorOf(
    vttAnnotationEmbedder.embed({ filePath: '/tmp/x.pdf', media: 'pdf', entries: [] }),
  );
  assert.ok(error instanceof ToolError);
  assert.equal(error.code, 'INTERNAL');
  assert.match(error.message, /only handles video\/audio/);
});

/* ------------------------------------------------------------------ *
 * 原子性
 * ------------------------------------------------------------------ */

test('原子性：目录不可写 → 报错、旧 VTT 不变、没有临时文件', { skip: skipPerm }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: 'lecture.mp4' });
  const target = annotationVttPathFor(ws.media);
  await writeFile(target, 'WEBVTT\n\nold\n');

  await chmod(ws.dir, 0o500);
  let error;
  try {
    error = await errorOf(
      vttAnnotationEmbedder.embed({
        filePath: ws.media,
        media: 'video',
        entries: [{ id: 'n1', note: '写不进去', start: 0, end: 1 }],
        sidecarPath: null,
        signal: null,
      }),
    );
  } finally {
    await chmod(ws.dir, 0o700);
  }

  assert.ok(error instanceof ToolError, `期望 ToolError，实际 ${error}`);
  assert.match(error.message, /cannot write/);
  assert.equal(await readFile(target, 'utf8'), 'WEBVTT\n\nold\n');
  assert.deepEqual(await listTemps(ws.dir), []);
});

/* ------------------------------------------------------------------ *
 * 端到端：引擎 + 真实 mp4 / wav
 * ------------------------------------------------------------------ */

test('引擎：写 sidecar + VTT，媒体文件哈希不变；第二次写入全量重写 VTT', { skip: skipChapters }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: 'lecture.mp4' });
  const beforeHash = await sha256(ws.media);
  const probe = await videoProbe(ws.media);

  const result = await annotationEngine.execute({
    filePath: ws.media,
    media: 'video',
    probe,
    operations: {
      add: [
        { note: '引擎写的第一条', start: 1 },
        { note: '引擎写的第二条', start: 3 },
      ],
    },
    context: { author: 'Tester' },
  });

  assert.equal(result.created, true);
  assert.deepEqual(result.applied, { remove: [], update: [], add: ['n1', 'n2'] });
  assert.deepEqual(result.embed.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
  ]);
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
    ['sidecar-readback', true],
  ]);
  assert.equal(result.embed.target, annotationVttPathFor(ws.media));

  // sidecar 是真相源：批注的 end 由引擎补齐（start + 5 s，截到时长）
  const sidecar = JSON.parse(await readFile(result.sidecarPath, 'utf8'));
  assert.deepEqual(sidecar.entries, [
    { id: 'n1', note: '引擎写的第一条', author: 'Tester', start: 1, end: 6 },
    { id: 'n2', note: '引擎写的第二条', author: 'Tester', start: 3, end: 8 },
  ]);

  // VTT 是 sidecar 的投影
  const cues = parseAnnotationVtt(await readFile(result.embed.target, 'utf8'));
  assert.deepEqual(cues.map((cue) => [cue.id, cue.startMs, cue.endMs, cue.note]), [
    ['n1', 1000, 6000, '引擎写的第一条'],
    ['n2', 3000, 8000, '引擎写的第二条'],
  ]);

  // 媒体文件逐字节不变，目录里没有临时文件
  assert.equal(await sha256(ws.media), beforeHash, '媒体文件必须逐字节不变');
  assert.deepEqual(await listTemps(ws.dir), []);
  assert.deepEqual((await readdir(ws.dir)).sort(), [
    'lecture.mp4',
    'lecture.mp4.mmgrep.annotation.json',
    'lecture.mp4.mmgrep.annotation.vtt',
  ]);

  // 第二次写入：更新 + 删除 → VTT 全量重写
  const second = await annotationEngine.execute({
    filePath: ws.media,
    media: 'video',
    probe,
    operations: { remove: ['n1'], update: [{ id: 'n2', note: '改过的批注' }] },
    context: { author: 'Tester' },
  });
  assert.deepEqual(second.applied, { remove: ['n1'], update: ['n2'], add: [] });
  const rewritten = parseAnnotationVtt(await readFile(second.embed.target, 'utf8'));
  assert.deepEqual(rewritten.map((cue) => [cue.id, cue.note]), [['n2', '改过的批注']]);
  assert.equal(await sha256(ws.media), beforeHash);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('引擎：嵌入写失败 → sidecar 不写（媒体不变、无临时文件）', { skip: skipPerm }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: CHAPTERS_MP4, name: 'lecture.mp4' });
  const beforeHash = await sha256(ws.media);
  const probe = await videoProbe(ws.media);

  await chmod(ws.dir, 0o500);
  let error;
  try {
    error = await errorOf(
      annotationEngine.execute({
        filePath: ws.media,
        media: 'video',
        probe,
        operations: { add: [{ note: '写不进去', start: 1 }] },
        context: { author: 'Tester' },
      }),
    );
  } finally {
    await chmod(ws.dir, 0o700);
  }

  assert.ok(error instanceof ToolError, `期望 ToolError，实际 ${error}`);
  assert.match(error.message, /cannot write/);
  assert.equal(await sha256(ws.media), beforeHash);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('音频：wav 也写同名的批注 VTT', { skip: skipAudio }, async (t) => {
  const ws = await makeWorkspace(t, { fixture: TONE_WAV, name: 'tone.wav' });
  const beforeHash = await sha256(ws.media);

  const result = await vttAnnotationEmbedder.embed({
    filePath: ws.media,
    media: 'audio',
    entries: [
      { id: 'n1', note: '第一句', start: 1 },
      { id: 'n2', note: '第二句', start: 4, end: 9 },
    ],
    sidecarPath: null,
    signal: null,
  });
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['vtt-readback', true],
    ['media-unchanged', true],
  ]);
  assert.equal(result.target, `${ws.media}${ANNOTATION_VTT_SUFFIX}`);

  const text = await readFile(result.target, 'utf8');
  assert.deepEqual(cueIdsOf(text), ['n1', 'n2']);
  // 缺省 end = start + 5 s（10 s 的音频里不会被截断）
  assert.deepEqual(parseAnnotationVtt(text).map((cue) => [cue.startMs, cue.endMs]), [
    [1000, 6000],
    [4000, 9000],
  ]);
  assert.equal(await sha256(ws.media), beforeHash);
  const vttInfo = await ffprobeJson(result.target);
  assert.equal(vttInfo.format.format_name, 'webvtt');
});
