// test/media/transcript.test.js —— 字幕来源判定顺序（契约 §8.5）
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { assertFfmpegAvailable, ffprobeJson, run } from '../../src/media/ffmpeg.js';
import {
  analyzeSubtitleStreams,
  bitmapSkippedWarnings,
  discoverSiblingSubtitles,
  pickSubtitleStream,
  resolveSubtitleSource,
  subtitleExtension,
} from '../../src/media/transcript.js';

const SRT = `1
00:00:00,000 --> 00:00:02,000
第一句

2
00:00:02,000 --> 00:00:04,000
第二句
`;

async function hasFfmpeg() {
  try {
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
}
const skip = !(await hasFfmpeg());

async function tempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test('subtitleExtension / pickSubtitleStream：只认文本型轨，按语言优先级', () => {
  assert.equal(subtitleExtension('/a/b.SRT'), '.srt');
  assert.equal(subtitleExtension('/a/b.txt'), null);

  const streams = [
    { index: 2, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'zh-Hans' } },
    { index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'en' } },
    { index: 4, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'zh-CN' } },
  ];
  assert.equal(pickSubtitleStream(streams).index, 4);
  assert.equal(pickSubtitleStream([]), null);
  assert.equal(pickSubtitleStream([{ index: 1, codec_type: 'video' }]), null);
});

test('analyzeSubtitleStreams：文本轨按语言优先级，位图轨记录跳过原因', () => {
  const streams = [
    { index: 2, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'zh-Hans' } },
    { index: 3, codec_type: 'subtitle', codec_name: 'dvd_subtitle' },
    { index: 4, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'en' } },
    { index: 5, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'zh-CN' } },
  ];
  const analysis = analyzeSubtitleStreams(streams);
  assert.equal(analysis.stream.index, 5);
  assert.deepEqual(analysis.bitmapSkipped, [
    { index: 2, codec: 'hdmv_pgs_subtitle' },
    { index: 3, codec: 'dvd_subtitle' },
  ]);
  assert.deepEqual(bitmapSkippedWarnings(analysis.bitmapSkipped), [
    'embedded-subtitle-bitmap-skipped (hdmv_pgs_subtitle, track 2)',
    'embedded-subtitle-bitmap-skipped (dvd_subtitle, track 3)',
  ]);
});

test('resolveSubtitleSource：只有位图字幕轨时返回 null 并写明 bitmap-skipped', async () => {
  const dir = await tempDir('mmgrep-bitmap-');
  try {
    const media = path.join(dir, 'a.mp4');
    await writeFile(media, 'video');
    const warnings = [];
    const resolved = await resolveSubtitleSource({
      mediaPath: media,
      streams: [{ index: 1, codec_type: 'subtitle', codec_name: 'dvd_subtitle' }],
      siblings: false,
      warnings,
    });
    assert.equal(resolved, null);
    assert.deepEqual(warnings, ['embedded-subtitle-bitmap-skipped (dvd_subtitle, track 1)']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('discoverSiblingSubtitles：精确同名优先，其次语言后缀', async () => {
  const dir = await tempDir('mmgrep-sibling-');
  try {
    await writeFile(path.join(dir, 'talk.mp4'), 'video');
    await writeFile(path.join(dir, 'talk.en.srt'), SRT);
    await writeFile(path.join(dir, 'talk.zh.srt'), SRT);
    await writeFile(path.join(dir, 'talk.zh-Hans.ass'), SRT);
    await writeFile(path.join(dir, 'talk.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.000\n中文\n');
    await writeFile(path.join(dir, 'other.srt'), SRT);

    const found = await discoverSiblingSubtitles(path.join(dir, 'talk.mp4'));
    assert.deepEqual(found.map((c) => path.basename(c.path)), ['talk.vtt', 'talk.zh-Hans.ass', 'talk.zh.srt', 'talk.en.srt']);
    assert.equal(found[0].exact, true);
    assert.equal(found[1].language, 'zh-Hans');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveSubtitleSource：显式 transcriptFile 优先，错误文案按契约', async () => {
  const dir = await tempDir('mmgrep-explicit-');
  try {
    const media = path.join(dir, 'a.mp4');
    await writeFile(media, 'video');
    const srt = path.join(dir, 'a.zh.srt');
    await writeFile(srt, SRT);

    const resolved = await resolveSubtitleSource({ mediaPath: media, transcriptFile: srt });
    assert.equal(resolved.origin, 'file');
    assert.equal(resolved.sourcePath, srt);
    assert.equal(resolved.segments.length, 2);

    await assert.rejects(
      () => resolveSubtitleSource({ mediaPath: media, transcriptFile: path.join(dir, 'missing.srt') }),
      (e) => e.code === 'PATH_NOT_FOUND' && e.message === `transcriptFile does not exist: "${path.join(dir, 'missing.srt')}".`,
    );
    await assert.rejects(
      () => resolveSubtitleSource({ mediaPath: media, transcriptFile: path.join(dir, 'a.txt') }),
      (e) => e.code === 'INVALID_ARGUMENT' && /transcriptFile must be one of \.srt, \.vtt, \.ass, \.ssa/.test(e.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveSubtitleSource：没有字幕来源 → null；同目录同名自动发现', async () => {
  const dir = await tempDir('mmgrep-autodiscover-');
  try {
    const media = path.join(dir, 'a.mp3');
    await writeFile(media, 'audio');
    assert.equal(await resolveSubtitleSource({ mediaPath: media }), null);

    await writeFile(path.join(dir, 'a.srt'), SRT);
    const resolved = await resolveSubtitleSource({ mediaPath: media });
    assert.equal(resolved.origin, 'file');
    assert.equal(path.basename(resolved.sourcePath), 'a.srt');
    assert.equal(resolved.segments[1].text, '第二句');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveSubtitleSource：内嵌字幕轨优先于同目录文件', { skip }, async () => {
  const dir = await tempDir('mmgrep-embedded-');
  try {
    const srt = path.join(dir, 'sub.srt');
    await writeFile(srt, SRT);
    const media = path.join(dir, 'clip.mp4');
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=4:r=10',
      '-i', srt,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:s', 'mov_text', '-metadata:s:s:0', 'language=zho',
      '-movflags', '+faststart',
      media,
    ]);
    await writeFile(path.join(dir, 'clip.srt'), SRT); // 有内嵌轨时不应被选中

    const info = await ffprobeJson(media);
    const resolved = await resolveSubtitleSource({ mediaPath: media, streams: info.streams });
    assert.equal(resolved.origin, 'embedded');
    assert.equal(resolved.format, 'embedded');
    assert.equal(resolved.sourcePath, null);
    assert.equal(resolved.language, 'zho');
    assert.equal(resolved.segments.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
