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
  classifySubtitleSelection,
  describeSubtitleSelection,
  discoverSiblingSubtitles,
  inspectSubtitleSelection,
  pickSubtitleStream,
  resolveSubtitleSource,
  subtitleExtension,
  subtitleLanguageMatches,
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

test('classifySubtitleSelection / subtitleLanguageMatches：形态与语言码', () => {
  assert.deepEqual(classifySubtitleSelection('/abs/a.srt'), { kind: 'file', path: '/abs/a.srt' });
  assert.deepEqual(classifySubtitleSelection('a.srt'), { kind: 'file', path: 'a.srt' });
  assert.deepEqual(classifySubtitleSelection('subs/a'), { kind: 'file', path: 'subs/a' });
  assert.deepEqual(classifySubtitleSelection('2'), { kind: 'index', value: 2 });
  assert.deepEqual(classifySubtitleSelection(2), { kind: 'index', value: 2 });
  assert.deepEqual(classifySubtitleSelection('zh'), { kind: 'language', value: 'zh' });

  assert.throws(
    () => classifySubtitleSelection(-1),
    (e) => e.code === 'INVALID_ARGUMENT' && /non-negative integer/.test(e.message),
  );
  assert.throws(
    () => classifySubtitleSelection(1.5),
    (e) => e.code === 'INVALID_ARGUMENT' && /non-negative integer/.test(e.message),
  );
  assert.throws(() => classifySubtitleSelection(''), (e) => e.code === 'INVALID_ARGUMENT');

  assert.equal(subtitleLanguageMatches('chi', 'zh'), true);
  assert.equal(subtitleLanguageMatches('zho', 'zh'), true);
  assert.equal(subtitleLanguageMatches('ZH-Hans', 'zh'), true);
  assert.equal(subtitleLanguageMatches('eng', 'en'), true);
  assert.equal(subtitleLanguageMatches('EN-us', 'en'), true);
  assert.equal(subtitleLanguageMatches('jpn', 'en'), false);
  assert.equal(subtitleLanguageMatches(null, 'zh'), false);
});

test('inspectSubtitleSelection：轨 index / 语言码 / 图形轨 / 多条命中', () => {
  const streams = [
    { index: 0, codec_type: 'video' },
    { index: 1, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'chi' } },
    { index: 2, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'zho' } },
    { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'zh' } },
    { index: 4, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
  ];
  assert.equal(inspectSubtitleSelection({ subtitle: 2, streams }).stream.index, 2);
  assert.equal(inspectSubtitleSelection({ subtitle: '2', streams }).stream.index, 2);

  const byLanguage = inspectSubtitleSelection({ subtitle: 'zh', streams });
  assert.equal(byLanguage.stream.index, 1);
  assert.deepEqual(byLanguage.warnings, [
    'subtitle-language-multiple-matches (language "zh": tracks 1, 2; using track 1)',
  ]);

  assert.equal(inspectSubtitleSelection({ subtitle: 'en', streams }).stream.index, 4);
  assert.equal(inspectSubtitleSelection({ subtitle: 'eng', streams }).stream.index, 4);

  assert.throws(
    () => inspectSubtitleSelection({ subtitle: 0, streams }),
    (e) => e.code === 'INVALID_ARGUMENT' && /not a subtitle track \(it is a video track\)/.test(e.message),
  );
  assert.throws(
    () => inspectSubtitleSelection({ subtitle: 99, streams }),
    (e) => e.code === 'INVALID_ARGUMENT' && /does not exist in this file/.test(e.message),
  );
  assert.throws(
    () => inspectSubtitleSelection({ subtitle: 3, streams }),
    (e) => e.code === 'INVALID_ARGUMENT'
      && /bitmap subtitle track.*embedded-subtitle-bitmap-skipped \(hdmv_pgs_subtitle, track 3\)/.test(e.message),
  );
  assert.throws(
    () => inspectSubtitleSelection({ subtitle: 'ja', streams }),
    (e) => e.code === 'INVALID_ARGUMENT' && /no subtitle track matches language "ja"/.test(e.message),
  );
});

test('describeSubtitleSelection：probe 只报告不抛错', async () => {
  const dir = await tempDir('mmgrep-describe-');
  try {
    const media = path.join(dir, 'a.mp4');
    await writeFile(media, 'video');
    const missing = path.join(dir, 'missing.srt');
    const described = await describeSubtitleSelection({ subtitle: missing });
    assert.equal(described.origin, null);
    assert.equal(described.error, `subtitle file does not exist: "${missing}".`);

    const streams = [
      { index: 1, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'zho' } },
    ];
    const embedded = await describeSubtitleSelection({ subtitle: 'zh', streams });
    assert.equal(embedded.origin, 'embedded');
    assert.equal(embedded.language, 'zho');
    assert.equal(embedded.error, null);

    const noMatch = await describeSubtitleSelection({ subtitle: 'ja', streams });
    assert.match(noMatch.error, /no subtitle track matches language "ja"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveSubtitleSource：显式 subtitle 文件优先，错误统一为 INVALID_ARGUMENT 且不回退', async () => {
  const dir = await tempDir('mmgrep-explicit-');
  try {
    const media = path.join(dir, 'a.mp4');
    await writeFile(media, 'video');
    const srt = path.join(dir, 'a.zh.srt');
    await writeFile(srt, SRT);
    await writeFile(path.join(dir, 'a.srt'), SRT); // 自动发现候选：显式失败时绝不能用它

    const resolved = await resolveSubtitleSource({ mediaPath: media, subtitle: srt });
    assert.equal(resolved.origin, 'file');
    assert.equal(resolved.sourcePath, srt);
    assert.equal(resolved.segments.length, 2);

    const missing = path.join(dir, 'missing.srt');
    await assert.rejects(
      () => resolveSubtitleSource({ mediaPath: media, subtitle: missing }),
      (e) => e.code === 'INVALID_ARGUMENT' && e.message === `subtitle file does not exist: "${missing}".`,
    );
    await assert.rejects(
      () => resolveSubtitleSource({ mediaPath: media, subtitle: path.join(dir, 'a.txt') }),
      (e) => e.code === 'INVALID_ARGUMENT' && /subtitle file must be one of \.srt, \.vtt, \.ass, \.ssa/.test(e.message),
    );
    await assert.rejects(
      () => resolveSubtitleSource({ mediaPath: media, subtitle: 'relative/a.srt' }),
      (e) => e.code === 'INVALID_ARGUMENT' && /absolute local path/.test(e.message),
    );

    const empty = path.join(dir, 'empty.srt');
    await writeFile(empty, '');
    await assert.rejects(
      () => resolveSubtitleSource({ mediaPath: media, subtitle: empty }),
      (e) => e.code === 'INVALID_ARGUMENT' && /no subtitle cue could be parsed/.test(e.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveSubtitleSource：显式内嵌轨 index / 语言码，zh ≈ chi/zho，多条命中 warning', { skip }, async () => {
  const dir = await tempDir('mmgrep-explicit-track-');
  try {
    const srtChi = path.join(dir, 'chi.srt');
    const srtChi2 = path.join(dir, 'chi2.srt');
    const srtEng = path.join(dir, 'eng.srt');
    await writeFile(srtChi, '1\n00:00:00,000 --> 00:00:02,000\n中文一轨\n');
    await writeFile(srtChi2, '1\n00:00:00,000 --> 00:00:02,000\n中文二轨\n');
    await writeFile(srtEng, '1\n00:00:00,000 --> 00:00:02,000\nENGLISH TRACK\n');
    const media = path.join(dir, 'multi.mp4');
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=2:r=10',
      '-i', srtChi, '-i', srtChi2, '-i', srtEng,
      '-map', '0:v', '-map', '1:s', '-map', '2:s', '-map', '3:s',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:s', 'mov_text',
      '-metadata:s:s:0', 'language=zho',
      '-metadata:s:s:1', 'language=chi',
      '-metadata:s:s:2', 'language=eng',
      media,
    ]);
    const info = await ffprobeJson(media);
    const chi = info.streams.find((s) => s.codec_type === 'subtitle' && s.tags?.language === 'zho');
    const chi2 = info.streams.find((s) => s.codec_type === 'subtitle' && s.tags?.language === 'chi');
    const eng = info.streams.find((s) => s.codec_type === 'subtitle' && s.tags?.language === 'eng');

    const byIndex = await resolveSubtitleSource({ mediaPath: media, subtitle: chi.index, streams: info.streams });
    assert.equal(byIndex.origin, 'embedded');
    assert.match(byIndex.segments[0].text, /中文一轨/);

    const warnings = [];
    const byLanguage = await resolveSubtitleSource({
      mediaPath: media, subtitle: 'zh', streams: info.streams, warnings,
    });
    assert.equal(byLanguage.origin, 'embedded');
    assert.match(byLanguage.segments[0].text, /中文一轨/);
    assert.deepEqual(byLanguage.warnings, [
      `subtitle-language-multiple-matches (language "zh": tracks ${chi.index}, ${chi2.index}; using track ${chi.index})`,
    ]);

    const byEng = await resolveSubtitleSource({ mediaPath: media, subtitle: 'eng', streams: info.streams });
    assert.match(byEng.segments[0].text, /ENGLISH TRACK/);
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
