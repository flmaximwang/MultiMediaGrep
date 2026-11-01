/**
 * Fixture generator contract tests.
 *
 *   node --test test/fixtures.test.js
 *
 * The suite regenerates every fixture from scratch into a temporary directory
 * and then asserts that the produced media really carries the ground truth
 * that ships in `fixtures/ground-truth/`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Raster, inkMask, maskIoU, medianColor } from '../fixtures/lib/raster.mjs';
import { decodePNG } from '../fixtures/lib/png.mjs';
import { countPages, extractContentStreams, extractTextOps } from '../fixtures/lib/pdf.mjs';
import { goertzel, readWAV, rms } from '../fixtures/lib/audio.mjs';
import {
  decodeAudioMono,
  extractFrameRGB,
  ffmpeg,
  meanVolumeDb,
  probe,
} from '../fixtures/lib/ffmpeg.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const REPO_GT_DIR = path.join(REPO_ROOT, 'fixtures', 'ground-truth');
const GENERATOR = path.join(REPO_ROOT, 'fixtures', 'generate.mjs');

let outDir = null;
let manifest = null;

/** Run the generator CLI into a fresh temporary directory. */
function runGenerator(targetDir) {
  const res = spawnSync(process.execPath, [GENERATOR, '--out', targetDir], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  assert.equal(
    res.status,
    0,
    `generator failed (${res.status}):\n${res.stdout ?? ''}\n${res.stderr ?? ''}`,
  );
}

test.before(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmg-fixtures-'));
  runGenerator(outDir);
  manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
});

test.after(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

/** Ground truth shipped in the repository. */
function repoGroundTruth(id) {
  return JSON.parse(fs.readFileSync(path.join(REPO_GT_DIR, `${id}.json`), 'utf8'));
}

function generatedGroundTruth(id) {
  return JSON.parse(fs.readFileSync(path.join(outDir, 'ground-truth', `${id}.json`), 'utf8'));
}

function asset(name) {
  return path.join(outDir, name);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function near(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? 'value'}: expected ${expected} (+/- ${tolerance}), got ${actual}`,
  );
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

test('the generator produces every expected asset', () => {
  const expected = [
    'sample-image.png',
    'sample-scanned.pdf',
    'sample-scene.mp4',
    'sample-speechless.mp3',
    'sample-subtitles.mp4',
    'sample-subtitles.srt',
    'sample-text.pdf',
    'sample-tone.wav',
    'sample-zoom.mp4',
  ];
  for (const name of expected) {
    const file = asset(name);
    assert.ok(fs.existsSync(file), `missing fixture: ${name}`);
    assert.ok(fs.statSync(file).size > 0, `empty fixture: ${name}`);
  }
  for (const entry of manifest.files) {
    assert.equal(entry.sha256, sha256(asset(entry.name)), `manifest hash mismatch: ${entry.name}`);
  }
});

test('the generated ground truth matches the committed ground truth', () => {
  const committed = fs.readdirSync(REPO_GT_DIR).filter((n) => n.endsWith('.json')).sort();
  assert.ok(committed.length > 0, 'no committed ground truth found');
  for (const name of committed) {
    const repoBytes = fs.readFileSync(path.join(REPO_GT_DIR, name));
    const genBytes = fs.readFileSync(path.join(outDir, 'ground-truth', name));
    assert.deepEqual(
      genBytes.toString('utf8'),
      repoBytes.toString('utf8'),
      `ground truth differs between repository and generated copy: ${name}`,
    );
  }
});

test('generation is idempotent and deterministic', () => {
  const before = manifest.files.map((f) => f.sha256);
  runGenerator(outDir);
  const after = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')).files.map(
    (f) => f.sha256,
  );
  assert.deepEqual(after, before, 're-running the generator changed the produced bytes');
});

// ---------------------------------------------------------------------------
// sample-scene.mp4
// ---------------------------------------------------------------------------

test('sample-scene.mp4 is a 12s 640x360 24fps video with an audio track', () => {
  const gt = repoGroundTruth('sample-scene');
  const info = probe(asset('sample-scene.mp4'));
  near(Number(info.format.duration) * 1000, gt.durationMs, 60, 'duration');

  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  assert.ok(video, 'no video stream');
  assert.ok(audio, 'no audio stream');
  assert.equal(video.width, gt.width);
  assert.equal(video.height, gt.height);
  assert.equal(video.r_frame_rate, `${gt.fps}/1`);
  assert.equal(Number(audio.sample_rate), gt.audio.sampleRate);
});

test('sample-scene.mp4 has hard cuts at the ground-truth timestamps', () => {
  const gt = repoGroundTruth('sample-scene');
  const { width, height } = gt;

  for (const cut of gt.cutsMs) {
    const frameIndex = Math.round((cut / 1000) * gt.fps);
    const before = medianColor(
      extractFrameRGB(asset('sample-scene.mp4'), frameIndex - 1, width, height),
      width,
      height,
    );
    const after = medianColor(
      extractFrameRGB(asset('sample-scene.mp4'), frameIndex, width, height),
      width,
      height,
    );

    const previous = gt.segments.find((s) => s.endMs === cut);
    const next = gt.segments.find((s) => s.startMs === cut);
    assert.ok(previous && next, `no segment boundary at ${cut}ms`);

    near(before[0], previous.bgColorRgb[0], 12, `frame ${frameIndex - 1} red channel`);
    near(before[1], previous.bgColorRgb[1], 12, `frame ${frameIndex - 1} green channel`);
    near(before[2], previous.bgColorRgb[2], 12, `frame ${frameIndex - 1} blue channel`);
    near(after[0], next.bgColorRgb[0], 12, `frame ${frameIndex} red channel`);
    near(after[1], next.bgColorRgb[1], 12, `frame ${frameIndex} green channel`);
    near(after[2], next.bgColorRgb[2], 12, `frame ${frameIndex} blue channel`);
  }
});

test('sample-scene.mp4 shows the ground-truth text in every segment', () => {
  const gt = repoGroundTruth('sample-scene');
  for (const segment of gt.segments) {
    const frameIndex = Math.min(segment.endFrame - 1, segment.startFrame + 5);
    const frame = extractFrameRGB(asset('sample-scene.mp4'), frameIndex, gt.width, gt.height);

    // Reference rendering, rebuilt from the ground truth only.
    const reference = new Raster(gt.width, gt.height, segment.bgColorRgb);
    reference.fillRect(
      segment.textPanel.x,
      segment.textPanel.y,
      segment.textPanel.width,
      segment.textPanel.height,
      [0, 0, 0],
    );
    const lineHeight = 8 * segment.textScale + 8;
    segment.textBoxes.forEach((box, i) => {
      reference.drawText(box.text, segment.textOrigin.x, segment.textOrigin.y + i * lineHeight, {
        scale: segment.textScale,
        color: [255, 255, 255],
      });
    });

    const actualMask = inkMask(frame, gt.width, gt.height, segment.bgColorRgb, 40);
    const referenceMask = inkMask(reference.toRGB(), gt.width, gt.height, segment.bgColorRgb, 40);

    const box = segment.textBoxes[0];
    const { iou, union } = maskIoU(
      actualMask,
      referenceMask,
      gt.width,
      box.x,
      box.y,
      box.width,
      box.height,
    );
    assert.ok(union > 0, `no ink found for "${segment.text}"`);
    assert.ok(
      iou >= 0.85,
      `burned-in text of segment "${segment.text}" does not match the ground truth (IoU ${iou.toFixed(3)})`,
    );
  }
});

test('sample-scene.mp4 has a loudness jump at 6s', () => {
  const gt = repoGroundTruth('sample-scene');
  const quiet = meanVolumeDb(asset('sample-scene.mp4'), 1, 4); // inside 0-6s
  const loud = meanVolumeDb(asset('sample-scene.mp4'), 7, 4); // inside 6-12s

  near(quiet, gt.audio.segments[0].expectedMeanVolumeDb, 1.5, 'mean volume 0-6s');
  near(loud, gt.audio.segments[1].expectedMeanVolumeDb, 1.5, 'mean volume 6-12s');
  assert.ok(
    loud - quiet >= 10,
    `expected a clear loudness jump, got ${(loud - quiet).toFixed(1)} dB`,
  );
  near(loud - quiet, gt.audio.loudnessJumpDb, 2, 'loudness jump size');
});

// ---------------------------------------------------------------------------
// sample-subtitles.mp4 + sample-subtitles.srt
// ---------------------------------------------------------------------------

function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 3) continue;
    const index = Number(lines[0]);
    const [start, end] = lines[1].split('-->').map((s) => s.trim());
    const body = lines.slice(2).join('\n');
    cues.push({ index, start, end, text: body });
  }
  return cues;
}

test('sample-subtitles.srt matches the ground-truth cue list', () => {
  const gt = repoGroundTruth('sample-subtitles');
  const cues = parseSrt(fs.readFileSync(asset('sample-subtitles.srt'), 'utf8'));
  assert.equal(cues.length, gt.cues.length, 'cue count');
  gt.cues.forEach((cue, i) => {
    assert.equal(cues[i].index, cue.index);
    assert.equal(cues[i].start, cue.startTime);
    assert.equal(cues[i].end, cue.endTime);
    assert.equal(cues[i].text, cue.text);
  });
});

test('sample-subtitles.mp4 burns the cue text into the picture', () => {
  const gt = repoGroundTruth('sample-subtitles');
  const info = probe(asset('sample-subtitles.mp4'));
  near(Number(info.format.duration) * 1000, gt.durationMs, 60, 'duration');
  assert.ok(info.streams.some((s) => s.codec_type === 'video'), 'no video stream');
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'), 'no audio stream');

  for (const cue of gt.cues) {
    const startFrame = Math.round((cue.startMs / 1000) * gt.fps);
    const frame = extractFrameRGB(asset('sample-subtitles.mp4'), startFrame + 2, gt.width, gt.height);

    const reference = new Raster(gt.width, gt.height, [0, 0, 0]);
    reference.drawText(cue.text, gt.subtitleOrigin.x, gt.subtitleOrigin.y, {
      scale: gt.subtitleScale,
      color: [255, 255, 0],
    });

    const actualMask = inkMask(frame, gt.width, gt.height, [0, 0, 0], 60);
    const referenceMask = inkMask(reference.toRGB(), gt.width, gt.height, [0, 0, 0], 60);
    const box = cue.textBox;
    const { iou, union } = maskIoU(
      actualMask,
      referenceMask,
      gt.width,
      box.x,
      box.y,
      box.width,
      box.height,
    );
    assert.ok(union > 0, `no subtitle ink found for "${cue.text}"`);
    assert.ok(
      iou >= 0.8,
      `burned-in subtitle "${cue.text}" does not match the ground truth (IoU ${iou.toFixed(3)})`,
    );
  }

  // Outside of every cue window the subtitle band must stay empty.
  const gapFrames = [
    { frame: 2, label: 'before the first cue' },
    { frame: gt.frameCount - 2, label: 'after the last cue' },
  ];
  for (const gap of gapFrames) {
    const frame = extractFrameRGB(asset('sample-subtitles.mp4'), gap.frame, gt.width, gt.height);
    const mask = inkMask(frame, gt.width, gt.height, [0, 0, 0], 60);
    const box = gt.cues[0].textBox;
    const { union } = maskIoU(
      mask,
      new Uint8Array(gt.width * gt.height),
      gt.width,
      box.x,
      box.y,
      box.width,
      box.height,
    );
    assert.equal(union, 0, `a subtitle is visible ${gap.label}`);
  }
});

// ---------------------------------------------------------------------------
// sample-zoom.mp4
// ---------------------------------------------------------------------------

test('sample-zoom.mp4 exposes readable text at the ground-truth pixel positions', () => {
  const gt = repoGroundTruth('sample-zoom');
  const info = probe(asset('sample-zoom.mp4'));
  near(Number(info.format.duration) * 1000, gt.durationMs, 60, 'duration');

  const frame = extractFrameRGB(asset('sample-zoom.mp4'), 10, gt.width, gt.height);

  for (const region of gt.regions) {
    const reference = new Raster(gt.width, gt.height, [0, 0, 0]);
    reference.drawText(region.text, region.origin.x, region.origin.y, {
      scale: region.scale,
      color: [255, 255, 255],
    });
    const actualMask = inkMask(frame, gt.width, gt.height, [0, 0, 0], 60);
    const referenceMask = inkMask(reference.toRGB(), gt.width, gt.height, [0, 0, 0], 60);
    const { iou, union } = maskIoU(
      actualMask,
      referenceMask,
      gt.width,
      region.box.x,
      region.box.y,
      region.box.width,
      region.box.height,
    );
    assert.ok(union > 0, `no ink found for region "${region.id}"`);
    assert.ok(
      iou >= 0.85,
      `region "${region.id}" does not contain the expected text (IoU ${iou.toFixed(3)})`,
    );
  }

  // The documented crop rectangles must contain that text.
  for (const crop of gt.crops) {
    const region = gt.regions.find((r) => r.id === crop.id);
    const reference = new Raster(gt.width, gt.height, [0, 0, 0]);
    reference.drawText(region.text, region.origin.x, region.origin.y, {
      scale: region.scale,
      color: [255, 255, 255],
    });
    const actualMask = inkMask(frame, gt.width, gt.height, [0, 0, 0], 60);
    const referenceMask = inkMask(reference.toRGB(), gt.width, gt.height, [0, 0, 0], 60);
    const { iou, union } = maskIoU(
      actualMask,
      referenceMask,
      gt.width,
      crop.rect.x,
      crop.rect.y,
      crop.rect.width,
      crop.rect.height,
    );
    assert.ok(union > 0, `crop "${crop.id}" is empty`);
    assert.ok(
      iou >= 0.8,
      `crop "${crop.id}" does not show "${crop.expectedText}" (IoU ${iou.toFixed(3)})`,
    );
  }
});

test('sample-zoom.mp4 keeps the colour chart swatches', () => {
  const gt = repoGroundTruth('sample-zoom');
  const frame = extractFrameRGB(asset('sample-zoom.mp4'), 10, gt.width, gt.height);
  for (const swatch of gt.colorChart.swatches) {
    const x = swatch.x + Math.floor(swatch.width / 2);
    const y = swatch.y + Math.floor(swatch.height / 2);
    const i = (y * gt.width + x) * 3;
    const expected = [
      parseInt(swatch.color.slice(1, 3), 16),
      parseInt(swatch.color.slice(3, 5), 16),
      parseInt(swatch.color.slice(5, 7), 16),
    ];
    near(frame[i], expected[0], 16, `swatch ${swatch.index} red`);
    near(frame[i + 1], expected[1], 16, `swatch ${swatch.index} green`);
    near(frame[i + 2], expected[2], 16, `swatch ${swatch.index} blue`);
  }
});

// ---------------------------------------------------------------------------
// sample-tone.wav / sample-speechless.mp3
// ---------------------------------------------------------------------------

test('sample-tone.wav has the ground-truth duration, silences and channel tones', () => {
  const gt = repoGroundTruth('sample-tone');
  const wav = readWAV(fs.readFileSync(asset('sample-tone.wav')));
  assert.equal(wav.sampleRate, gt.sampleRate);
  assert.equal(wav.channels, gt.channels);
  near((wav.numFrames / wav.sampleRate) * 1000, gt.durationMs, 1, 'duration');

  const peakAround = (channel, ms, spanMs = 20) => {
    const centre = Math.round((ms / 1000) * wav.sampleRate);
    const span = Math.round((spanMs / 1000) * wav.sampleRate);
    let peak = 0;
    for (let i = Math.max(0, centre - span); i < Math.min(wav.numFrames, centre + span); i += 1) {
      peak = Math.max(peak, Math.abs(wav.frames[channel][i]));
    }
    return peak;
  };

  for (const silence of gt.silences) {
    const mid = Math.round((silence.startMs + silence.endMs) / 2);
    for (const channelName of silence.channels) {
      const channel = channelName === 'left' ? 0 : 1;
      assert.equal(
        peakAround(channel, mid),
        0,
        `channel ${channelName} should be silent at ${mid}ms`,
      );
    }
    // Channels that are not silenced must still carry their tone.
    for (const channelName of ['left', 'right']) {
      if (silence.channels.includes(channelName)) continue;
      const channel = channelName === 'left' ? 0 : 1;
      assert.ok(
        peakAround(channel, mid) > 0.1,
        `channel ${channelName} should not be silent at ${mid}ms`,
      );
    }
  }

  // Spectral content: Goertzel on a one-second window of each channel.
  const window = wav.sampleRate;
  const leftWindow = wav.frames[0].subarray(0, window);
  const rightWindow = wav.frames[1].subarray(0, window);
  const left440 = goertzel(leftWindow, gt.tones.left.hz, wav.sampleRate);
  const left220 = goertzel(leftWindow, gt.tones.right.hz, wav.sampleRate);
  const right220 = goertzel(rightWindow, gt.tones.right.hz, wav.sampleRate);
  const right440 = goertzel(rightWindow, gt.tones.left.hz, wav.sampleRate);
  assert.ok(left440 > left220 * 5, 'left channel should carry 440 Hz');
  assert.ok(right220 > right440 * 5, 'right channel should carry 220 Hz');

  near(rms(leftWindow), gt.tones.left.expectedRms, 0.02, 'left RMS');
  near(rms(rightWindow), gt.tones.right.expectedRms, 0.02, 'right RMS');
});

test('sample-speechless.mp3 is a speechless mp3 of the expected length', () => {
  const gt = repoGroundTruth('sample-speechless');
  const info = probe(asset('sample-speechless.mp3'));
  assert.equal(info.streams.length, 1, 'mp3 must contain exactly one stream');
  assert.equal(info.streams[0].codec_type, 'audio');
  assert.equal(info.streams[0].codec_name, 'mp3');
  assert.equal(info.streams[0].channels, gt.channels);
  near(
    Number(info.format.duration) * 1000,
    gt.durationMs,
    gt.durationToleranceMs,
    'mp3 duration (encoder padding included)',
  );
  assert.equal(gt.hasSpeech, false);

  // Still carries the tones, so the file is not empty or broken. The mono mix
  // down contains both channel tones, so they are compared against a
  // frequency that is not present at all.
  const { samples, sampleRate } = decodeAudioMono(asset('sample-speechless.mp3'));
  const window = samples.subarray(0, sampleRate);
  const at440 = goertzel(window, gt.tones.left.hz, sampleRate);
  const at220 = goertzel(window, gt.tones.right.hz, sampleRate);
  const atReference = goertzel(window, 1000, sampleRate);
  assert.ok(at440 > atReference * 5, 'decoded mp3 should still carry the 440 Hz tone');
  assert.ok(at220 > atReference * 5, 'decoded mp3 should still carry the 220 Hz tone');
});

// ---------------------------------------------------------------------------
// sample-text.pdf
// ---------------------------------------------------------------------------

test('sample-text.pdf has 6 pages and a real text layer', () => {
  const gt = repoGroundTruth('sample-text-pdf');
  const bytes = fs.readFileSync(asset('sample-text.pdf'));
  assert.equal(countPages(bytes), gt.pageCount, 'page count');
  assert.equal(gt.pageCount, 6);

  const text = bytes.toString('latin1');
  assert.ok(text.includes('/Font'), 'expected a font resource in the text PDF');
  assert.ok(text.includes('/BaseFont /Helvetica'), 'expected a base-14 font');

  const streams = extractContentStreams(bytes).filter((s) => s.includes(' Tm '));
  assert.equal(streams.length, gt.pageCount, 'one content stream per page');

  gt.pages.forEach((page, i) => {
    const ops = extractTextOps(streams[i]);
    assert.equal(ops.length, page.textOps.length, `page ${page.page} text operation count`);
    page.textOps.forEach((op, j) => {
      assert.equal(ops[j].text, op.text, `page ${page.page} text op ${j}`);
      assert.equal(ops[j].x, op.xPt, `page ${page.page} text op ${j} x`);
      assert.equal(ops[j].y, op.yPt, `page ${page.page} text op ${j} y`);
    });
    // The body lines come first, in reading order.
    page.lines.forEach((line, j) => {
      assert.equal(ops[j].text, line.text, `page ${page.page} body line ${j}`);
    });
  });
});

test('sample-text.pdf contains the ground-truth table cells at the right positions', () => {
  const gt = repoGroundTruth('sample-text-pdf');
  const bytes = fs.readFileSync(asset('sample-text.pdf'));
  const streams = extractContentStreams(bytes).filter((s) => s.includes(' Tm '));

  for (const table of gt.tables) {
    const ops = extractTextOps(streams[table.page - 1]);
    for (const cell of table.cells) {
      const match = ops.find((op) => op.text === cell.text && op.x === cell.xPt && op.y === cell.yPt);
      assert.ok(
        match,
        `table cell "${cell.text}" (page ${table.page}) missing at ${cell.xPt}/${cell.yPt}`,
      );
    }
    assert.equal(table.header.length, 4 - (table.page === 6 ? 2 : 0));
    assert.ok(table.rows.length >= 2, 'table should have data rows');
  }
});

// ---------------------------------------------------------------------------
// sample-scanned.pdf
// ---------------------------------------------------------------------------

test('sample-scanned.pdf has 3 image-only pages and no text layer', () => {
  const gt = repoGroundTruth('sample-scanned-pdf');
  const bytes = fs.readFileSync(asset('sample-scanned.pdf'));
  assert.equal(countPages(bytes), gt.pageCount, 'page count');
  assert.equal(gt.pageCount, 3);

  const text = bytes.toString('latin1');
  assert.ok(!text.includes('/Font'), 'a scanned PDF must not declare any font resource');
  assert.ok(!text.includes(' Tj'), 'a scanned PDF must not contain a text layer');
  const dct = text.match(/DCTDecode/g) ?? [];
  assert.equal(dct.length, gt.pageCount, 'one JPEG XObject per page');

  // Every embedded image is a real JPEG with the documented pixel size.
  const images = text.match(/\/Width (\d+) \/Height (\d+)[\s\S]*?\/Filter \/DCTDecode/g) ?? [];
  assert.equal(images.length, gt.pageCount);
  for (const image of images) {
    assert.ok(image.includes(`/Width ${gt.imageWidthPx}`), 'unexpected image width');
    assert.ok(image.includes(`/Height ${gt.imageHeightPx}`), 'unexpected image height');
  }
  assert.ok(text.includes('/ColorSpace /DeviceRGB'), 'expected a DeviceRGB JPEG XObject');
});

// ---------------------------------------------------------------------------
// sample-image.png
// ---------------------------------------------------------------------------

test('sample-image.png is a 1240x1754 image whose text sits at the ground-truth boxes', () => {
  const gt = repoGroundTruth('sample-image');
  const png = decodePNG(fs.readFileSync(asset('sample-image.png')));
  assert.equal(png.width, gt.widthPx);
  assert.equal(png.height, gt.heightPx);
  assert.equal(png.channels, 3);

  for (const line of gt.lines) {
    assert.ok(line.box.width > 0 && line.box.height > 0, `empty box for "${line.text}"`);
    assert.ok(
      line.box.x >= 0 &&
        line.box.y >= 0 &&
        line.box.x + line.box.width <= png.width &&
        line.box.y + line.box.height <= png.height,
      `box for "${line.text}" is outside the image`,
    );
    let ink = 0;
    for (let y = line.box.y; y < line.box.y + line.box.height; y += 1) {
      for (let x = line.box.x; x < line.box.x + line.box.width; x += 1) {
        const i = (y * png.width + x) * 3;
        if (png.data[i] < 160) ink += 1;
      }
    }
    assert.ok(ink > 50, `expected ink pixels for "${line.text}", found ${ink}`);
  }
});

// ---------------------------------------------------------------------------
// optional macOS-only asset
// ---------------------------------------------------------------------------

test('the optional macOS speech asset is only present where `say` exists', () => {
  const optional = path.join(outDir, 'ground-truth', 'sample-speech-optional.json');
  if (process.platform !== 'darwin') {
    assert.ok(!fs.existsSync(optional), 'the optional asset must not be produced off macOS');
    return;
  }
  if (!fs.existsSync(optional)) return; // `say` unavailable / failed - acceptable
  const gt = JSON.parse(fs.readFileSync(optional, 'utf8'));
  assert.equal(gt.optional, true);
  assert.ok(gt.durationMs > 0);
  assert.ok(fs.existsSync(asset('sample-speech-optional.wav')));
});
