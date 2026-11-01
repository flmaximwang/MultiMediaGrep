#!/usr/bin/env node
/**
 * Generate the synthetic test fixtures for MultiMediaGrep.
 *
 *   node fixtures/generate.mjs [--out <dir>]
 *
 * Everything is generated from scratch: no third-party media ever enters the
 * repository. Video/audio go through the ffmpeg CLI; documents are written by
 * hand-rolled PDF writers; images are rasterised in pure Node with a built-in
 * bitmap font (no font files, no image libraries, no npm dependencies).
 *
 * The generator is idempotent and deterministic: running it twice produces
 * byte-identical files.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Raster, textInkRect } from './lib/raster.mjs';
import { encodePNG } from './lib/png.mjs';
import { buildPDF, pdfLineOp, pdfTextOp } from './lib/pdf.mjs';
import { writeWAV } from './lib/audio.mjs';
import { ffmpeg, ffmpegCapabilities, hasEncoder, hasFilter, pngToJPEG, probe, run } from './lib/ffmpeg.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_OUT = path.join(REPO_ROOT, 'fixtures', 'generated');
const REPO_GROUND_TRUTH = path.join(REPO_ROOT, 'fixtures', 'ground-truth');

const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 360;
const FPS = 24;
const AUDIO_SAMPLE_RATE = 44100;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      if (i + 1 >= argv.length) throw new Error('--out requires a directory argument');
      args.out = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (argv[i].startsWith('--out=')) {
      args.out = path.resolve(process.cwd(), argv[i].slice('--out='.length));
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function fmt(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

function hex(rgb) {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** RMS of a full-scale sine, in dBFS. */
function sineRmsDb(amplitude) {
  return Math.round(20 * Math.log10(amplitude / Math.SQRT2) * 100) / 100;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Deterministic JSON serialisation used for every ground-truth file. */
function writeGroundTruth(dir, id, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const json = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(file, json, 'utf8');
  return json;
}

function writeFile(outDir, name, data) {
  const file = path.join(outDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

// ---------------------------------------------------------------------------
// shared building blocks
// ---------------------------------------------------------------------------

/**
 * Render one "scene card": a solid background plus a couple of text lines.
 * The text sits on a black panel so that H.264's 4:2:0 chroma subsampling
 * cannot smear the background colour into the glyphs (keeps OCR happy).
 * @returns {{png:Buffer, boxes:object[]}}
 */
function renderCard({ width, height, bg, lines, scale, color = [255, 255, 255], originX, originY }) {
  const raster = new Raster(width, height, bg);
  const lineHeight = 8 * scale + 8;
  const boxes = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  lines.forEach((line, i) => {
    const box = textInkRect(line, scale, originX, originY + i * lineHeight);
    boxes.push({ text: line, ...box });
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  });
  let panel = null;
  if (minX !== Infinity) {
    const pad = scale * 2;
    panel = {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
    raster.fillRect(panel.x, panel.y, panel.width, panel.height, [0, 0, 0]);
  }
  lines.forEach((line, i) => {
    raster.drawText(line, originX, originY + i * lineHeight, { scale, color });
  });
  return { png: encodePNG(width, height, raster.toRGB()), boxes, panel, scale, originX, originY };
}

/** Build a segment-aware tone generator (silence outside every segment). */
function toneSegments({ durationMs, segments }) {
  const total = Math.round(AUDIO_SAMPLE_RATE * (durationMs / 1000));
  const out = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const t = i / AUDIO_SAMPLE_RATE;
    const ms = t * 1000;
    let value = 0;
    for (const seg of segments) {
      if (ms >= seg.startMs && ms < seg.endMs) {
        value = seg.amplitude * Math.sin(2 * Math.PI * seg.toneHz * t);
        break;
      }
    }
    out[i] = value;
  }
  return out;
}

/**
 * Encode a sequence of still images into an H.264/AAC mp4.
 * Scene boundaries land exactly on frame boundaries because the image inputs
 * run at the target frame rate.
 */
function encodeVideo({ outFile, cards, frameDurationsMs, audioWav }) {
  const tmpDir = path.join(path.dirname(outFile), '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const cardFiles = [];
  cards.forEach((card, i) => {
    const p = path.join(tmpDir, `card-${i}.png`);
    fs.writeFileSync(p, card.png);
    cardFiles.push(p);
  });

  const inputs = [];
  cardFiles.forEach((p, i) => {
    inputs.push('-framerate', String(FPS), '-loop', '1', '-t', String(frameDurationsMs[i] / 1000), '-i', p);
  });
  const audioIndex = cardFiles.length;
  inputs.push('-i', audioWav);

  const concatInputs = cardFiles.map((_, i) => `[${i}:v]`).join('');
  const args = [
    '-y',
    '-v',
    'error',
    ...inputs,
    '-filter_complex',
    `${concatInputs}concat=n=${cardFiles.length}:v=1:a=0[v]`,
    '-map',
    '[v]',
    '-map',
    `${audioIndex}:a`,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    String(AUDIO_SAMPLE_RATE),
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    outFile,
  ];
  ffmpeg(args);
  cardFiles.forEach((p) => fs.rmSync(p, { force: true }));
}

// ---------------------------------------------------------------------------
// 1. sample-scene.mp4  — hard cuts + a loudness jump
// ---------------------------------------------------------------------------

const SCENE_CUTS_MS = [2000, 5000, 9000];
const SCENE_SEGMENTS = [
  { startMs: 0, endMs: 2000, text: 'SCENE ONE', bg: [200, 30, 30] },
  { startMs: 2000, endMs: 5000, text: 'SCENE TWO', bg: [30, 190, 30] },
  { startMs: 5000, endMs: 9000, text: 'SCENE THREE', bg: [30, 30, 200] },
  { startMs: 9000, endMs: 12000, text: 'SCENE FOUR', bg: [200, 190, 30] },
];
const SCENE_AUDIO_SEGMENTS = [
  { startMs: 0, endMs: 6000, toneHz: 440, amplitude: 0.1 },
  { startMs: 6000, endMs: 12000, toneHz: 880, amplitude: 0.7 },
];

function generateSampleScene(outDir) {
  const cards = SCENE_SEGMENTS.map((seg, index) => {
    const card = renderCard({
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT,
      bg: seg.bg,
      lines: [seg.text, `SEGMENT ${index + 1} OF 4`],
      scale: 5,
      originX: 40,
      originY: 40,
    });
    return card;
  });

  const wav = writeWAV({
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: 1,
    frames: [toneSegments({ durationMs: 12000, segments: SCENE_AUDIO_SEGMENTS })],
  });
  const tmpDir = path.join(outDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const wavPath = path.join(tmpDir, 'scene.wav');
  fs.writeFileSync(wavPath, wav);

  const outFile = path.join(outDir, 'sample-scene.mp4');
  encodeVideo({
    outFile,
    cards,
    frameDurationsMs: SCENE_SEGMENTS.map((s) => s.endMs - s.startMs),
    audioWav: wavPath,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const segments = SCENE_SEGMENTS.map((seg, i) => ({
    index: i,
    startMs: seg.startMs,
    endMs: seg.endMs,
    startFrame: Math.round((seg.startMs / 1000) * FPS),
    endFrame: Math.round((seg.endMs / 1000) * FPS),
    text: seg.text,
    bgColor: hex(seg.bg),
    bgColorRgb: seg.bg,
    textScale: cards[i].scale,
    textOrigin: { x: cards[i].originX, y: cards[i].originY },
    textPanel: cards[i].panel,
    textBoxes: cards[i].boxes,
  }));

  const groundTruth = {
    id: 'sample-scene',
    kind: 'video',
    file: 'sample-scene.mp4',
    generator: 'fixtures/generate.mjs',
    durationMs: 12000,
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    fps: FPS,
    frameCount: 288,
    cutsMs: SCENE_CUTS_MS,
    cutFrames: SCENE_CUTS_MS.map((ms) => Math.round((ms / 1000) * FPS)),
    segments,
    audio: {
      codec: 'aac',
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 1,
      volumeJumpsMs: [6000],
      segments: SCENE_AUDIO_SEGMENTS.map((seg, i) => ({
        index: i,
        startMs: seg.startMs,
        endMs: seg.endMs,
        toneHz: seg.toneHz,
        peakAmplitude: seg.amplitude,
        expectedMeanVolumeDb: sineRmsDb(seg.amplitude),
      })),
      loudnessJumpDb: round2(
        sineRmsDb(SCENE_AUDIO_SEGMENTS[1].amplitude) - sineRmsDb(SCENE_AUDIO_SEGMENTS[0].amplitude),
      ),
    },
  };
  return groundTruth;
}

// ---------------------------------------------------------------------------
// 2. sample-subtitles.mp4 + sample-subtitles.srt
// ---------------------------------------------------------------------------

const SUBTITLE_CUES = [
  { startMs: 500, endMs: 3000, text: 'FIRST SUBTITLE LINE' },
  { startMs: 3000, endMs: 6000, text: 'SECOND SUBTITLE LINE' },
  { startMs: 6000, endMs: 9000, text: 'THIRD SUBTITLE LINE' },
  { startMs: 9000, endMs: 11500, text: 'FOURTH SUBTITLE LINE' },
];

function generateSampleSubtitles(outDir) {
  const bg = [18, 18, 24];
  const subtitleY = 268;
  const subtitleScale = 4;

  // Video segments: one per cue boundary so each cue is burned in exactly
  // while it is active.
  const bounds = [0];
  for (const cue of SUBTITLE_CUES) {
    bounds.push(cue.startMs, cue.endMs);
  }
  bounds.push(12000);
  const segmentBounds = [...new Set(bounds)].sort((a, b) => a - b);

  const cards = [];
  const segmentCues = [];
  for (let i = 0; i < segmentBounds.length - 1; i += 1) {
    const startMs = segmentBounds[i];
    const endMs = segmentBounds[i + 1];
    const active = SUBTITLE_CUES.find((c) => c.startMs === startMs && c.endMs === endMs);
    const raster = new Raster(VIDEO_WIDTH, VIDEO_HEIGHT, bg);
    raster.fillRect(0, 240, VIDEO_WIDTH, 80, [0, 0, 0]);
    raster.drawText('SUBTITLE FIXTURE', 40, 40, { scale: 4, color: [235, 235, 235] });
    let box = null;
    if (active) {
      box = raster.drawText(active.text, 40, subtitleY, { scale: subtitleScale, color: [255, 255, 0] });
    }
    cards.push({ png: encodePNG(VIDEO_WIDTH, VIDEO_HEIGHT, raster.toRGB()) });
    segmentCues.push({ startMs, endMs, cue: active, box });
  }

  const wav = writeWAV({
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: 1,
    frames: [toneSegments({ durationMs: 12000, segments: [{ startMs: 0, endMs: 12000, toneHz: 330, amplitude: 0.25 }] })],
  });
  const tmpDir = path.join(outDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const wavPath = path.join(tmpDir, 'subs.wav');
  fs.writeFileSync(wavPath, wav);

  const outFile = path.join(outDir, 'sample-subtitles.mp4');
  encodeVideo({
    outFile,
    cards,
    frameDurationsMs: segmentBounds.slice(1).map((end, i) => end - segmentBounds[i]),
    audioWav: wavPath,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const srt =
    SUBTITLE_CUES.map((cue, i) => `${i + 1}\n${fmt(cue.startMs)} --> ${fmt(cue.endMs)}\n${cue.text}\n`).join('\n') +
    '\n';
  writeFile(outDir, 'sample-subtitles.srt', srt);

  const cues = SUBTITLE_CUES.map((cue, i) => {
    const seg = segmentCues.find((s) => s.cue === cue);
    return {
      index: i + 1,
      startMs: cue.startMs,
      endMs: cue.endMs,
      startTime: fmt(cue.startMs),
      endTime: fmt(cue.endMs),
      text: cue.text,
      textBox: seg.box,
    };
  });

  const groundTruth = {
    id: 'sample-subtitles',
    kind: 'video',
    file: 'sample-subtitles.mp4',
    srtFile: 'sample-subtitles.srt',
    generator: 'fixtures/generate.mjs',
    durationMs: 12000,
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    fps: FPS,
    frameCount: 288,
    subtitleBackground: hex(bg),
    subtitleBand: { x: 0, y: 240, width: VIDEO_WIDTH, height: 80 },
    subtitleScale,
    subtitleOrigin: { x: 40, y: subtitleY },
    headerText: 'SUBTITLE FIXTURE',
    headerOrigin: { x: 40, y: 40 },
    headerScale: 4,
    cues,
  };
  return groundTruth;
}

// ---------------------------------------------------------------------------
// 3. sample-zoom.mp4  — readable text at known pixel positions
// ---------------------------------------------------------------------------

const ZOOM_DURATION_MS = 8000;
const ZOOM_SWATCHES = [
  [230, 25, 75],
  [60, 180, 75],
  [255, 225, 25],
  [60, 180, 75],
  [0, 130, 200],
  [245, 130, 48],
  [145, 30, 180],
  [70, 70, 70],
];

function generateSampleZoom(outDir) {
  const raster = new Raster(VIDEO_WIDTH, VIDEO_HEIGHT, [245, 245, 245]);

  // Colour chart along the top.
  const swatchWidth = 70;
  const swatchGap = 5;
  const chartX = 20;
  const chartY = 20;
  const chartHeight = 90;
  const swatches = ZOOM_SWATCHES.map((color, i) => {
    const x = chartX + i * (swatchWidth + swatchGap);
    raster.fillRect(x, chartY, swatchWidth, chartHeight, color);
    raster.strokeRect(x, chartY, swatchWidth, chartHeight, [0, 0, 0], 1);
    return { index: i, x, y: chartY, width: swatchWidth, height: chartHeight, color: hex(color) };
  });

  // Black band so the white text survives chroma subsampling untouched.
  raster.fillRect(20, 130, 600, 80, [0, 0, 0]);
  const numberBox = raster.drawText('42', 40, 145, { scale: 8, color: [255, 255, 255] });

  raster.fillRect(20, 240, 600, 44, [0, 0, 0]);
  const captionBox = raster.drawText('CROP TARGET ALPHA', 40, 252, { scale: 3, color: [255, 255, 255] });

  const png = encodePNG(VIDEO_WIDTH, VIDEO_HEIGHT, raster.toRGB());
  const tmpDir = path.join(outDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const wav = writeWAV({
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: 1,
    frames: [toneSegments({ durationMs: ZOOM_DURATION_MS, segments: [{ startMs: 0, endMs: ZOOM_DURATION_MS, toneHz: 523.25, amplitude: 0.2 }] })],
  });
  const wavPath = path.join(tmpDir, 'zoom.wav');
  fs.writeFileSync(wavPath, wav);

  const outFile = path.join(outDir, 'sample-zoom.mp4');
  encodeVideo({
    outFile,
    cards: [{ png }],
    frameDurationsMs: [ZOOM_DURATION_MS],
    audioWav: wavPath,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const groundTruth = {
    id: 'sample-zoom',
    kind: 'video',
    file: 'sample-zoom.mp4',
    generator: 'fixtures/generate.mjs',
    durationMs: ZOOM_DURATION_MS,
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    fps: FPS,
    frameCount: Math.round((ZOOM_DURATION_MS / 1000) * FPS),
    static: true,
    background: hex([245, 245, 245]),
    colorChart: {
      x: chartX,
      y: chartY,
      width: swatchWidth * ZOOM_SWATCHES.length + swatchGap * (ZOOM_SWATCHES.length - 1),
      height: chartHeight,
      swatches,
    },
    regions: [
      {
        id: 'number',
        text: '42',
        scale: 8,
        origin: { x: 40, y: 145 },
        box: numberBox,
      },
      {
        id: 'caption',
        text: 'CROP TARGET ALPHA',
        scale: 3,
        origin: { x: 40, y: 252 },
        box: captionBox,
      },
    ],
    crops: [
      {
        id: 'number',
        rect: { x: 30, y: 135, width: 120, height: 70 },
        expectedText: '42',
      },
      {
        id: 'caption',
        rect: { x: 30, y: 245, width: 320, height: 34 },
        expectedText: 'CROP TARGET ALPHA',
      },
    ],
  };
  return groundTruth;
}

// ---------------------------------------------------------------------------
// 4. sample-tone.wav / sample-speechless.mp3
// ---------------------------------------------------------------------------

const TONE_DURATION_MS = 10000;
const TONE_LEFT_HZ = 440;
const TONE_RIGHT_HZ = 220;
const TONE_LEFT_AMP = 0.5;
const TONE_RIGHT_AMP = 0.25;
const TONE_SILENCES = [
  { startMs: 2000, endMs: 3000, channels: ['left', 'right'] },
  { startMs: 6000, endMs: 6500, channels: ['left', 'right'] },
  { startMs: 7500, endMs: 8000, channels: ['right'] },
];

function generateSampleTone(outDir) {
  const total = Math.round((TONE_DURATION_MS / 1000) * AUDIO_SAMPLE_RATE);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const t = i / AUDIO_SAMPLE_RATE;
    const ms = t * 1000;
    const leftSilent = TONE_SILENCES.some(
      (s) => s.channels.includes('left') && ms >= s.startMs && ms < s.endMs,
    );
    const rightSilent = TONE_SILENCES.some(
      (s) => s.channels.includes('right') && ms >= s.startMs && ms < s.endMs,
    );
    left[i] = leftSilent ? 0 : TONE_LEFT_AMP * Math.sin(2 * Math.PI * TONE_LEFT_HZ * t);
    right[i] = rightSilent ? 0 : TONE_RIGHT_AMP * Math.sin(2 * Math.PI * TONE_RIGHT_HZ * t);
  }

  const wav = writeWAV({ sampleRate: AUDIO_SAMPLE_RATE, channels: 2, frames: [left, right] });
  const wavFile = writeFile(outDir, 'sample-tone.wav', wav);

  // Speechless MP3: same content, encoded through libmp3lame. Xing/ID3 tags
  // are disabled so the file stays byte-reproducible.
  const mp3File = path.join(outDir, 'sample-speechless.mp3');
  ffmpeg([
    '-y',
    '-v',
    'error',
    '-i',
    wavFile,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    '-ar',
    String(AUDIO_SAMPLE_RATE),
    '-ac',
    '2',
    '-write_xing',
    '0',
    '-id3v2_version',
    '0',
    '-fflags',
    '+bitexact',
    mp3File,
  ]);

  const toneGroundTruth = {
    id: 'sample-tone',
    kind: 'audio',
    file: 'sample-tone.wav',
    generator: 'fixtures/generate.mjs',
    format: 'wav',
    codec: 'pcm_s16le',
    durationMs: TONE_DURATION_MS,
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: 2,
    tones: {
      left: { hz: TONE_LEFT_HZ, amplitude: TONE_LEFT_AMP, expectedRms: round2(TONE_LEFT_AMP / Math.SQRT2) },
      right: { hz: TONE_RIGHT_HZ, amplitude: TONE_RIGHT_AMP, expectedRms: round2(TONE_RIGHT_AMP / Math.SQRT2) },
    },
    silences: TONE_SILENCES,
    segments: buildToneSegments(),
  };

  const mp3GroundTruth = {
    id: 'sample-speechless',
    kind: 'audio',
    file: 'sample-speechless.mp3',
    generator: 'fixtures/generate.mjs',
    format: 'mp3',
    codec: 'mp3',
    durationMs: TONE_DURATION_MS,
    durationToleranceMs: 120,
    sampleRate: AUDIO_SAMPLE_RATE,
    channels: 2,
    bitrateKbps: 128,
    hasSpeech: false,
    encoderDelayMs: 26,
    note:
      'Contains tones only - no human voice. ASR ground truth is NOT asserted: ' +
      'cross-platform TTS is not available. Use a stub ASR provider instead.',
    tones: toneGroundTruth.tones,
    silences: TONE_SILENCES,
  };

  return [toneGroundTruth, mp3GroundTruth];
}

/** Contiguous non-silent spans of the tone fixture. */
function buildToneSegments() {
  const edges = new Set([0, TONE_DURATION_MS]);
  for (const s of TONE_SILENCES) {
    edges.add(s.startMs);
    edges.add(s.endMs);
  }
  const sorted = [...edges].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const startMs = sorted[i];
    const endMs = sorted[i + 1];
    const silent = TONE_SILENCES.find((s) => s.startMs === startMs && s.endMs === endMs);
    segments.push({
      startMs,
      endMs,
      silent: Boolean(silent),
      silentChannels: silent ? silent.channels : [],
      leftHz: silent && silent.channels.includes('left') ? null : TONE_LEFT_HZ,
      rightHz: silent && silent.channels.includes('right') ? null : TONE_RIGHT_HZ,
    });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// 5. sample-text.pdf
// ---------------------------------------------------------------------------

const PDF_WIDTH = 595;
const PDF_HEIGHT = 842;
const PDF_MARGIN = 72;

const TEXT_PDF_PAGES = [
  {
    page: 1,
    title: 'MULTIMEDIAGREP TEXT FIXTURE',
    lines: [
      'PAGE 1 OF 6',
      'THIS DOCUMENT HAS A REAL TEXT LAYER.',
      'EACH PAGE CARRIES UNIQUE LINES.',
      'LINE EXTRACTION MUST FIND THESE STRINGS.',
    ],
  },
  {
    page: 2,
    title: 'PAGE TWO HEADING',
    lines: [
      'SECOND PAGE OF THE TEXT FIXTURE.',
      'ALPHA BETA GAMMA DELTA.',
      'ONE TWO THREE FOUR FIVE.',
      'THE QUICK BROWN FOX JUMPS.',
    ],
  },
  {
    page: 3,
    title: 'PAGE THREE HEADING',
    lines: [
      'THIRD PAGE OF THE TEXT FIXTURE.',
      'SIX SEVEN EIGHT NINE TEN.',
      'RED GREEN BLUE YELLOW BLACK.',
      'PAGE THREE ENDS HERE.',
    ],
  },
  {
    page: 4,
    title: 'PAGE FOUR HEADING',
    lines: [
      'FOURTH PAGE OF THE TEXT FIXTURE.',
      'ALPHA CHARLIE BRAVO ECHO.',
      'FIXTURES MAKE ASSERTIONS POSSIBLE.',
      'NO IMAGE IS EMBEDDED ON THIS PAGE.',
    ],
  },
  {
    page: 5,
    title: 'PAGE FIVE HEADING',
    lines: [
      'FIFTH PAGE OF THE TEXT FIXTURE.',
      'THE TABLE BELOW IS VECTOR GRAPHICS.',
      'CELL CONTENTS ARE KNOWN.',
    ],
    table: {
      header: ['COL A', 'COL B', 'COL C', 'COL D'],
      rows: [
        ['A1', 'B1', 'C1', 'D1'],
        ['A2', 'B2', 'C2', 'D2'],
        ['A3', 'B3', 'C3', 'D3'],
      ],
    },
  },
  {
    page: 6,
    title: 'PAGE SIX HEADING',
    lines: [
      'SIXTH AND LAST PAGE OF THE TEXT FIXTURE.',
      'A SMALLER TABLE FOLLOWS.',
      'END OF DOCUMENT.',
    ],
    table: {
      header: ['KEY', 'VALUE'],
      rows: [
        ['ALPHA', 'ONE'],
        ['BETA', 'TWO'],
      ],
    },
  },
];

function buildTableOps({ header, rows, originX, topY, columnWidth, rowHeight }) {
  const ops = [];
  const colCount = header.length;
  const tableWidth = columnWidth * colCount;
  const tableHeight = rowHeight * (rows.length + 1);

  // Grid.
  for (let r = 0; r <= rows.length; r += 1) {
    const y = topY - r * rowHeight;
    ops.push(pdfLineOp(originX, y, originX + tableWidth, y, { width: 1 }));
  }
  for (let c = 0; c <= colCount; c += 1) {
    const x = originX + c * columnWidth;
    ops.push(pdfLineOp(x, topY, x, topY - tableHeight, { width: 1 }));
  }

  // Cell text.
  const cells = [];
  const putRow = (values, rowIndex, bold) => {
    values.forEach((value, colIndex) => {
      const x = originX + colIndex * columnWidth + 6;
      const y = topY - rowIndex * rowHeight - 16;
      ops.push(pdfTextOp(x, y, value, { font: bold ? 'F2' : 'F1', size: 11 }));
      cells.push({
        row: rowIndex,
        col: colIndex,
        text: value,
        xPt: x,
        yPt: y,
      });
    });
  };
  putRow(header, 0, true);
  rows.forEach((row, i) => putRow(row, i + 1, false));

  return {
    ops,
    cells,
    originX,
    topY,
    columnWidth,
    rowHeight,
    columnX: Array.from({ length: colCount }, (_, c) => originX + c * columnWidth),
    rowY: Array.from({ length: rows.length + 1 }, (_, r) => topY - r * rowHeight),
    header,
    rows,
  };
}

function generateSampleTextPdf(outDir) {
  const pages = [];
  const pageTruth = [];
  const tables = [];

  for (const spec of TEXT_PDF_PAGES) {
    const ops = [];
    const textOps = [];
    const lines = [];
    const titleY = PDF_HEIGHT - PDF_MARGIN;
    ops.push(pdfTextOp(PDF_MARGIN, titleY, spec.title, { font: 'F2', size: 16 }));
    lines.push({ text: spec.title, xPt: PDF_MARGIN, yPt: titleY, font: 'F2', size: 16 });
    textOps.push({ text: spec.title, xPt: PDF_MARGIN, yPt: titleY });

    spec.lines.forEach((text, i) => {
      const y = titleY - 30 - i * 20;
      ops.push(pdfTextOp(PDF_MARGIN, y, text, { font: 'F1', size: 11 }));
      lines.push({ text, xPt: PDF_MARGIN, yPt: y, font: 'F1', size: 11 });
      textOps.push({ text, xPt: PDF_MARGIN, yPt: y });
    });

    let tableTruth = null;
    if (spec.table) {
      const columnWidth = spec.table.header.length === 4 ? 110 : 140;
      const topY = titleY - 30 - spec.lines.length * 20 - 30;
      const built = buildTableOps({
        header: spec.table.header,
        rows: spec.table.rows,
        originX: PDF_MARGIN,
        topY,
        columnWidth,
        rowHeight: 24,
      });
      ops.push(...built.ops);
      built.cells.forEach((cell) => textOps.push({ text: cell.text, xPt: cell.xPt, yPt: cell.yPt }));
      tableTruth = {
        page: spec.page,
        originXPt: built.originX,
        topYPt: built.topY,
        columnWidthPt: built.columnWidth,
        rowHeightPt: built.rowHeight,
        columnXPt: built.columnX,
        rowYPt: built.rowY,
        header: built.header,
        rows: built.rows,
        cells: built.cells,
      };
      tables.push(tableTruth);
    }

    pages.push({ kind: 'text', width: PDF_WIDTH, height: PDF_HEIGHT, ops, fonts: ['F1', 'F2'] });
    pageTruth.push({ page: spec.page, lines, textOps });
  }

  const pdf = buildPDF({ pages });
  writeFile(outDir, 'sample-text.pdf', pdf);

  return {
    id: 'sample-text-pdf',
    kind: 'pdf',
    file: 'sample-text.pdf',
    generator: 'fixtures/generate.mjs',
    pageCount: pages.length,
    pageWidthPt: PDF_WIDTH,
    pageHeightPt: PDF_HEIGHT,
    marginPt: PDF_MARGIN,
    hasTextLayer: true,
    fonts: ['Helvetica', 'Helvetica-Bold'],
    pages: pageTruth,
    tables,
  };
}

// ---------------------------------------------------------------------------
// 5c. sample-twocolumn.pdf  (two-column reading order + heuristic blocks)
//
// The fixture is synthetic on purpose (no real paper enters the repo):
//   page 1: full-width title + abstract, then a two-column body;
//   page 2: two-column section headings ("2. Results", "2.1 ...") and
//           "Fig. N" / "Table N" captions;
//   page 3: single-column control with a vector table (must not be reflowed).
//
// pdftotext -layout emits page 1/2 body lines as "left text <spaces> right
// text"; the ground truth records which lines belong to which column so the
// reflow tests can assert left-then-right order without crossing columns.
// ---------------------------------------------------------------------------

const TWOCOL_MARGIN_PT = 42;
const TWOCOL_COLUMN_WIDTH_PT = 240;
const TWOCOL_GUTTER_PT = 30;
const TWOCOL_LEFT_X_PT = TWOCOL_MARGIN_PT;
const TWOCOL_RIGHT_X_PT = TWOCOL_LEFT_X_PT + TWOCOL_COLUMN_WIDTH_PT + TWOCOL_GUTTER_PT;
const TWOCOL_BODY_SIZE = 9;
const TWOCOL_LEADING_PT = 12;

const TWOCOL_PAGE1 = {
  title: 'TWO-COLUMN REFLOW FIXTURE',
  abstract:
    'ABSTRACT: This synthetic paper exercises reading-order reflow for the builtin typeset provider.',
  leftParagraphs: [[
    'Programmable small RNA-protein complexes such as',
    'CRISPR-Cas enable a single protein to serve as a',
    'flexible scaffold for targeting. Despite their',
    'flexibility, these systems are limited by off-target',
    'activity and unknown interactions with regulatory',
    'machinery. Genome mining and protein engineering',
    'continue to produce smaller variants, but delivery',
    'remains the dominant barrier for translation.',
  ]],
  rightParagraphs: [[
    'To address these limitations, we developed a',
    'modular platform that couples engineered guide RNAs',
    'with a compact effector domain. The resulting',
    'complexes retain programmable targeting while',
    'reducing unintended interactions in primary cells.',
    'In this study we characterize the platform across',
    'multiple cell types and report improved specificity',
    'without detectable off-target editing.',
  ]],
};

const TWOCOL_PAGE2 = {
  // null = an empty row on this side; the other column may still have text.
  leftRows: [
    '2. Results', null,
    '2.1 Reflow quality', null,
    'The reflowed page keeps the left column',
    'contiguous before the right column begins.',
    'Each sentence stays inside its own column.',
    null, null,
    'Fig. 1. Reading order after gutter reflow.',
  ],
  rightRows: [
    '2.2 Block heuristics', null,
    'Short numbered lines become headings and',
    'lines beginning with Fig. or Table become',
    'captions in the typeset output.',
    null, null,
    'Table 1. Heuristic block types.',
  ],
  leftParagraphs: [
    ['The reflowed page keeps the left column', 'contiguous before the right column begins.', 'Each sentence stays inside its own column.'],
  ],
  rightParagraphs: [
    ['Short numbered lines become headings and', 'lines beginning with Fig. or Table become', 'captions in the typeset output.'],
  ],
};

const TWOCOL_PAGE3 = {
  lines: [
    '3. Conclusion', null,
    'A single-column page must not be reflowed. The',
    'table below keeps its layout and cell contents.',
  ],
  table: {
    header: ['KEY', 'VALUE', 'NOTE'],
    rows: [
      ['ALPHA', 'ONE', 'FIRST'],
      ['BETA', 'TWO', 'SECOND'],
      ['GAMMA', 'THREE', 'THIRD'],
    ],
  },
};

/** One column of text ops; null rows advance the vertical position (blank line). */
function twoColumnOps(rows, x, topY) {
  const ops = [];
  rows.forEach((text, index) => {
    if (text === null) return;
    ops.push(pdfTextOp(x, topY - index * TWOCOL_LEADING_PT, text, { font: 'F1', size: TWOCOL_BODY_SIZE }));
  });
  return ops;
}

function twoColumnPageOps(page) {
  const ops = [];
  const topY = PDF_HEIGHT - 120;
  ops.push(...twoColumnOps(page.leftRows, TWOCOL_LEFT_X_PT, topY));
  ops.push(...twoColumnOps(page.rightRows, TWOCOL_RIGHT_X_PT, topY));
  return ops;
}

function generateSampleTwoColumnPdf(outDir) {
  // Page 1: title + abstract (full width) over a two-column body.
  const page1Ops = [
    pdfTextOp(170, PDF_HEIGHT - 60, TWOCOL_PAGE1.title, { font: 'F2', size: 15 }),
    pdfTextOp(42, PDF_HEIGHT - 88, TWOCOL_PAGE1.abstract, { font: 'F1', size: 9 }),
  ];
  const bodyTopY = PDF_HEIGHT - 120;
  for (const paragraph of TWOCOL_PAGE1.leftParagraphs) {
    page1Ops.push(...twoColumnOps(paragraph, TWOCOL_LEFT_X_PT, bodyTopY));
  }
  for (const paragraph of TWOCOL_PAGE1.rightParagraphs) {
    page1Ops.push(...twoColumnOps(paragraph, TWOCOL_RIGHT_X_PT, bodyTopY));
  }

  // Page 2: headings / captions inside the columns.
  const page2Ops = twoColumnPageOps(TWOCOL_PAGE2);

  // Page 3: single-column control page with a vector table.
  const page3Ops = [];
  const page3TopY = PDF_HEIGHT - 72;
  TWOCOL_PAGE3.lines.forEach((text, index) => {
    if (text === null) return;
    page3Ops.push(pdfTextOp(TWOCOL_MARGIN_PT, page3TopY - index * 12, text, { font: 'F1', size: 11 }));
  });
  const tableTopY = page3TopY - TWOCOL_PAGE3.lines.length * 12 - 20;
  const tableColumnWidth = 140;
  const tableRowHeight = 24;
  const table = buildTableOps({
    header: TWOCOL_PAGE3.table.header,
    rows: TWOCOL_PAGE3.table.rows,
    originX: TWOCOL_MARGIN_PT,
    topY: tableTopY,
    columnWidth: tableColumnWidth,
    rowHeight: tableRowHeight,
  });
  page3Ops.push(...table.ops);

  const pdf = buildPDF({
    pages: [
      { kind: 'text', width: PDF_WIDTH, height: PDF_HEIGHT, ops: page1Ops, fonts: ['F1', 'F2'] },
      { kind: 'text', width: PDF_WIDTH, height: PDF_HEIGHT, ops: page2Ops, fonts: ['F1', 'F2'] },
      { kind: 'text', width: PDF_WIDTH, height: PDF_HEIGHT, ops: page3Ops, fonts: ['F1', 'F2'] },
    ],
  });
  writeFile(outDir, 'sample-twocolumn.pdf', pdf);

  const page1Left = TWOCOL_PAGE1.leftParagraphs.flat();
  const page1Right = TWOCOL_PAGE1.rightParagraphs.flat();
  const page2Blocks = [
    { type: 'heading', level: 1, text: '2. Results' },
    { type: 'heading', level: 2, text: '2.1 Reflow quality' },
    { type: 'paragraph', text: TWOCOL_PAGE2.leftParagraphs[0].join('\n') },
    { type: 'caption', text: 'Fig. 1. Reading order after gutter reflow.' },
    { type: 'heading', level: 2, text: '2.2 Block heuristics' },
    { type: 'paragraph', text: TWOCOL_PAGE2.rightParagraphs[0].join('\n') },
    { type: 'caption', text: 'Table 1. Heuristic block types.' },
  ];

  return {
    id: 'sample-twocolumn-pdf',
    kind: 'pdf',
    file: 'sample-twocolumn.pdf',
    generator: 'fixtures/generate.mjs',
    pageCount: 3,
    pageWidthPt: PDF_WIDTH,
    pageHeightPt: PDF_HEIGHT,
    hasTextLayer: true,
    fonts: ['Helvetica', 'Helvetica-Bold'],
    layout: {
      marginPt: TWOCOL_MARGIN_PT,
      columnWidthPt: TWOCOL_COLUMN_WIDTH_PT,
      gutterPt: TWOCOL_GUTTER_PT,
      leftColumnXPt: TWOCOL_LEFT_X_PT,
      rightColumnXPt: TWOCOL_RIGHT_X_PT,
    },
    pages: [
      {
        page: 1,
        layout: 'two-column',
        title: TWOCOL_PAGE1.title,
        abstract: TWOCOL_PAGE1.abstract,
        leftLines: page1Left,
        rightLines: page1Right,
        leftParagraphs: TWOCOL_PAGE1.leftParagraphs,
        rightParagraphs: TWOCOL_PAGE1.rightParagraphs,
        expectedBlocks: [
          { type: 'heading', level: 1, text: TWOCOL_PAGE1.title },
          { type: 'paragraph', text: TWOCOL_PAGE1.abstract },
          { type: 'paragraph', text: page1Left.join('\n') },
          { type: 'paragraph', text: page1Right.join('\n') },
        ],
      },
      {
        page: 2,
        layout: 'two-column',
        leftRows: TWOCOL_PAGE2.leftRows,
        rightRows: TWOCOL_PAGE2.rightRows,
        leftParagraphs: TWOCOL_PAGE2.leftParagraphs,
        rightParagraphs: TWOCOL_PAGE2.rightParagraphs,
        headings: [{ level: 1, text: '2. Results' }, { level: 2, text: '2.1 Reflow quality' }, { level: 2, text: '2.2 Block heuristics' }],
        captions: ['Fig. 1. Reading order after gutter reflow.', 'Table 1. Heuristic block types.'],
        expectedBlocks: page2Blocks,
      },
      {
        page: 3,
        layout: 'single-column',
        lines: TWOCOL_PAGE3.lines.filter((text) => text !== null),
        headings: [{ level: 1, text: '3. Conclusion' }],
        table: {
          page: 3,
          originXPt: table.originX,
          topYPt: table.topY,
          columnWidthPt: table.columnWidth,
          rowHeightPt: table.rowHeight,
          columnXPt: table.columnX,
          rowYPt: table.rowY,
          header: table.header,
          rows: table.rows,
          cells: table.cells,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 5b. sample-longpage.pdf  (one page far above the 24k-char inline limit)
//
// 预览管线（9z5.20）必须能处理「单页正文超过内联上限」：不能把整页丢掉，
// 也不能再宣称「下面是每一页的全文」。这个 fixture 把三种情况放在一份文件里：
//   page 4：约 25k 字符，切成很多完整句子（抽样）
//   page 6：一个没有句末标点的长单元（硬截断 …[+N chars]）
// 其余页面是短页，用来验证 pages:"4-6" 时三页都出现。
// 页面用大尺寸（1000x1400 pt）写，字号保持可读，不靠挤小字堆字符数。
// ---------------------------------------------------------------------------

const LONGPAGE_WIDTH = 1000;
const LONGPAGE_HEIGHT = 1400;
const LONGPAGE_MARGIN = 50;
const LONGPAGE_TITLE_SIZE = 16;
const LONGPAGE_BODY_SIZE = 7;
const LONGPAGE_LEADING = 10;
const LONGPAGE_TITLE_OFFSET = 40;

const LONG_WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
  'yankee', 'zulu',
];

/** 一条完整句子（<= ~206 字符），保证抽样单元不会都被硬截断 */
function longPageSentence(index) {
  let text = `Sentence ${String(index).padStart(3, '0')} of the long page fixture. `
    + 'This line exists so that the inline preview has to sample complete units instead of dropping the page.';
  let step = 0;
  while (text.length < 205) {
    text += ` ${LONG_WORDS[(index + step) % LONG_WORDS.length]}`;
    step += 1;
  }
  return text.endsWith('.') ? text : `${text}.`;
}

/** 不含 . ! ? ; 的正文行：整个页面会被断句器看成一个超长单元 */
function longPageUnpunctuatedLine(index) {
  const parts = [];
  for (let step = 0; step < 26; step += 1) {
    parts.push(LONG_WORDS[(index * 7 + step) % LONG_WORDS.length]);
  }
  let text = parts.join(' ');
  while (text.length < 200) text += ` ${LONG_WORDS[(index + text.length) % LONG_WORDS.length]}`;
  return text;
}

const LONGPAGE_SENTENCES = Array.from({ length: 125 }, (_, i) => longPageSentence(i + 1));
const LONGPAGE_UNPUNCTUATED = Array.from({ length: 25 }, (_, i) => longPageUnpunctuatedLine(i + 1));

const LONGPAGE_PAGES = Array.from({ length: 6 }, (_, i) => {
  const page = i + 1;
  if (page === 4) return { page, title: 'PAGE FOUR: LONG BODY FOR INLINE PREVIEW', lines: LONGPAGE_SENTENCES };
  if (page === 6) return { page, title: 'PAGE SIX UNPUNCTUATED BODY', lines: LONGPAGE_UNPUNCTUATED };
  return {
    page,
    title: `PAGE ${page} OF THE LONG-PAGE FIXTURE`,
    lines: [`PAGE ${page} SHORT LINE ONE.`, `PAGE ${page} SHORT LINE TWO.`, `PAGE ${page} ENDS HERE.`],
  };
});

function generateSampleLongPagePdf(outDir) {
  const pages = [];
  const pageTruth = [];
  const charsByPage = {};

  for (const spec of LONGPAGE_PAGES) {
    const ops = [];
    const lines = [];
    const titleY = LONGPAGE_HEIGHT - LONGPAGE_MARGIN;
    ops.push(pdfTextOp(LONGPAGE_MARGIN, titleY, spec.title, { font: 'F2', size: LONGPAGE_TITLE_SIZE }));
    lines.push({ text: spec.title, xPt: LONGPAGE_MARGIN, yPt: titleY, font: 'F2', size: LONGPAGE_TITLE_SIZE });

    spec.lines.forEach((text, i) => {
      const y = titleY - LONGPAGE_TITLE_OFFSET - i * LONGPAGE_LEADING;
      ops.push(pdfTextOp(LONGPAGE_MARGIN, y, text, { font: 'F1', size: LONGPAGE_BODY_SIZE }));
      lines.push({ text, xPt: LONGPAGE_MARGIN, yPt: y, font: 'F1', size: LONGPAGE_BODY_SIZE });
    });

    charsByPage[spec.page] = lines.reduce((sum, line) => sum + line.text.length + 1, 0);
    pages.push({ kind: 'text', width: LONGPAGE_WIDTH, height: LONGPAGE_HEIGHT, ops, fonts: ['F1', 'F2'] });
    // 这个 fixture 只关心「页文字总量 / 断句」，不重复写 textOps（ground truth 体积减半）
    pageTruth.push({ page: spec.page, lines });
  }

  const pdf = buildPDF({ pages });
  writeFile(outDir, 'sample-longpage.pdf', pdf);

  return {
    id: 'sample-longpage-pdf',
    kind: 'pdf',
    file: 'sample-longpage.pdf',
    generator: 'fixtures/generate.mjs',
    pageCount: pages.length,
    pageWidthPt: LONGPAGE_WIDTH,
    pageHeightPt: LONGPAGE_HEIGHT,
    marginPt: LONGPAGE_MARGIN,
    hasTextLayer: true,
    fonts: ['Helvetica', 'Helvetica-Bold'],
    longPage: 4,
    unpunctuatedPage: 6,
    charsByPage,
    pages: pageTruth,
  };
}

// ---------------------------------------------------------------------------
// 6. sample-scanned.pdf  (image-only pages: no text layer)
// ---------------------------------------------------------------------------

const SCAN_WIDTH_PX = 1240;
const SCAN_HEIGHT_PX = 1754; // A4 at 150 dpi

const SCANNED_PAGES = [
  {
    page: 1,
    title: 'SCANNED PAGE ONE',
    lines: [
      'THIS PAGE HAS NO TEXT LAYER.',
      'OCR IS REQUIRED TO READ IT.',
      'SCAN LINE ALPHA',
    ],
  },
  {
    page: 2,
    title: 'SCANNED PAGE TWO',
    lines: [
      'SECOND IMAGE ONLY PAGE.',
      'EVERYTHING IS PIXELS HERE.',
      'SCAN LINE BRAVO',
    ],
  },
  {
    page: 3,
    title: 'SCANNED PAGE THREE',
    lines: [
      'THIRD IMAGE ONLY PAGE.',
      'THE TABLE IS ALSO PIXELS.',
    ],
    table: {
      header: ['ROW', 'ITEM'],
      rows: [
        ['1', 'ALPHA'],
        ['2', 'BRAVO'],
        ['3', 'CHARLIE'],
      ],
    },
  },
];

function renderScannedPage(spec) {
  const raster = new Raster(SCAN_WIDTH_PX, SCAN_HEIGHT_PX, [252, 250, 245]);
  const lines = [];
  const titleBox = raster.drawText(spec.title, 100, 120, { scale: 6, color: [15, 15, 15] });
  lines.push({ text: spec.title, box: titleBox });

  spec.lines.forEach((text, i) => {
    const box = raster.drawText(text, 100, 260 + i * 70, { scale: 3, color: [25, 25, 25] });
    lines.push({ text, box });
  });

  let table = null;
  if (spec.table) {
    const originX = 100;
    const originY = 560;
    const columnWidth = 420;
    const rowHeight = 70;
    const colCount = spec.table.header.length;
    raster.strokeRect(originX, originY, columnWidth * colCount, rowHeight * (spec.table.rows.length + 1), [20, 20, 20], 3);
    for (let r = 1; r <= spec.table.rows.length; r += 1) {
      raster.drawLine(originX, originY + r * rowHeight, originX + columnWidth * colCount, originY + r * rowHeight, [20, 20, 20], 3);
    }
    for (let c = 1; c < colCount; c += 1) {
      raster.drawLine(originX + c * columnWidth, originY, originX + c * columnWidth, originY + rowHeight * (spec.table.rows.length + 1), [20, 20, 20], 3);
    }
    const cells = [];
    const putRow = (values, rowIndex) => {
      values.forEach((value, colIndex) => {
        const box = raster.drawText(value, originX + colIndex * columnWidth + 16, originY + rowIndex * rowHeight + 20, {
          scale: 3,
          color: [20, 20, 20],
        });
        cells.push({ row: rowIndex, col: colIndex, text: value, box });
      });
    };
    putRow(spec.table.header, 0);
    spec.table.rows.forEach((row, i) => putRow(row, i + 1));
    table = { header: spec.table.header, rows: spec.table.rows, cells };
  }

  return { png: encodePNG(SCAN_WIDTH_PX, SCAN_HEIGHT_PX, raster.toRGB()), lines, table };
}

function generateSampleScannedPdf(outDir) {
  const tmpDir = path.join(outDir, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const pages = [];
  const pageTruth = [];
  SCANNED_PAGES.forEach((spec, i) => {
    const rendered = renderScannedPage(spec);
    const pngPath = path.join(tmpDir, `scan-${i}.png`);
    const jpgPath = path.join(tmpDir, `scan-${i}.jpg`);
    fs.writeFileSync(pngPath, rendered.png);
    pngToJPEG(pngPath, jpgPath, { quality: 2 });
    const jpeg = fs.readFileSync(jpgPath);
    pages.push({
      kind: 'image',
      width: PDF_WIDTH,
      height: PDF_HEIGHT,
      imageWidth: SCAN_WIDTH_PX,
      imageHeight: SCAN_HEIGHT_PX,
      jpeg,
    });
    pageTruth.push({ page: spec.page, lines: rendered.lines, table: rendered.table });
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const pdf = buildPDF({ pages });
  writeFile(outDir, 'sample-scanned.pdf', pdf);

  return {
    id: 'sample-scanned-pdf',
    kind: 'pdf',
    file: 'sample-scanned.pdf',
    generator: 'fixtures/generate.mjs',
    pageCount: pages.length,
    pageWidthPt: PDF_WIDTH,
    pageHeightPt: PDF_HEIGHT,
    hasTextLayer: false,
    imageWidthPx: SCAN_WIDTH_PX,
    imageHeightPx: SCAN_HEIGHT_PX,
    imageFormat: 'jpeg',
    jpegQuality: 2,
    pages: pageTruth,
  };
}

// ---------------------------------------------------------------------------
// 7. sample-image.png
// ---------------------------------------------------------------------------

const IMAGE_WIDTH_PX = 1240;
const IMAGE_HEIGHT_PX = 1754;

function generateSampleImage(outDir) {
  const raster = new Raster(IMAGE_WIDTH_PX, IMAGE_HEIGHT_PX, [255, 255, 255]);
  const lines = [];
  const push = (text, x, y, scale, color) => {
    const box = raster.drawText(text, x, y, { scale, color });
    lines.push({ text, box });
  };
  push('IMAGE DOCUMENT FIXTURE', 100, 120, 6, [10, 10, 10]);
  push('THIS IS A SINGLE PAGE IMAGE FILE.', 100, 260, 3, [30, 30, 30]);
  push('USED TO TEST THE IMAGE DOCUMENT BACKEND.', 100, 330, 3, [30, 30, 30]);
  push('OCR TEXT SHOULD MATCH THE LINES BELOW.', 100, 400, 3, [30, 30, 30]);
  push('ALPHA BRAVO CHARLIE DELTA ECHO.', 100, 470, 3, [30, 30, 30]);
  raster.fillRect(100, 560, 1040, 4, [0, 0, 0]);
  push('SECTION TWO', 100, 620, 4, [10, 10, 10]);
  push('THE FIXTURE IMAGE IS 1240 BY 1754 PIXELS.', 100, 700, 3, [30, 30, 30]);

  const png = encodePNG(IMAGE_WIDTH_PX, IMAGE_HEIGHT_PX, raster.toRGB());
  writeFile(outDir, 'sample-image.png', png);

  return {
    id: 'sample-image',
    kind: 'image',
    file: 'sample-image.png',
    generator: 'fixtures/generate.mjs',
    widthPx: IMAGE_WIDTH_PX,
    heightPx: IMAGE_HEIGHT_PX,
    format: 'png',
    hasTextLayer: true,
    lines,
  };
}

// ---------------------------------------------------------------------------
// sample-mixed.pdf  (page 1 is an image-only cover; pages 2+ have a text layer)
//
// 这是「图片封面 + 数字正文」这一最常见形态的回归素材：只看第 1 页会把整份
// 文档误判成没有文字层。
// ---------------------------------------------------------------------------

const MIXED_COVER_WIDTH_PX = 1240;
const MIXED_COVER_HEIGHT_PX = 1754; // A4 at 150 dpi

const MIXED_TEXT_PAGES = [
  {
    page: 2,
    title: 'BODY PAGE ONE',
    lines: [
      'PAGE 2 HAS A REAL TEXT LAYER.',
      'THE COVER PAGE BEFORE IT IS AN IMAGE ONLY.',
      'A DOC MUST NOT BE CALLED TEXTLESS BECAUSE OF PAGE ONE.',
    ],
  },
  {
    page: 3,
    title: 'BODY PAGE TWO',
    lines: [
      'THIRD PAGE OF THE MIXED FIXTURE.',
      'ALPHA BRAVO CHARLIE DELTA.',
      'ONE TWO THREE FOUR FIVE.',
    ],
  },
  {
    page: 4,
    title: 'BODY PAGE THREE',
    lines: [
      'LAST PAGE OF THE MIXED FIXTURE.',
      'THIS PAGE ALSO CARRIES A TEXT LAYER.',
      'END OF DOCUMENT.',
    ],
  },
];

function generateSampleMixedPdf(outDir) {
  const tmpDir = path.join(outDir, '.tmp-mixed');
  fs.mkdirSync(tmpDir, { recursive: true });

  // Page 1: image-only cover (an image page carries no /Font resource → no text layer).
  const coverRaster = new Raster(MIXED_COVER_WIDTH_PX, MIXED_COVER_HEIGHT_PX, [244, 241, 235]);
  const coverLines = [];
  const coverTitle = coverRaster.drawText('MIXED FIXTURE COVER', 120, 200, { scale: 6, color: [18, 18, 18] });
  coverLines.push({ text: 'MIXED FIXTURE COVER', box: coverTitle });
  const coverNote = coverRaster.drawText('THIS COVER PAGE IS AN IMAGE ONLY.', 120, 320, { scale: 3, color: [30, 30, 30] });
  coverLines.push({ text: 'THIS COVER PAGE IS AN IMAGE ONLY.', box: coverNote });
  const coverPng = encodePNG(MIXED_COVER_WIDTH_PX, MIXED_COVER_HEIGHT_PX, coverRaster.toRGB());
  const coverPngPath = path.join(tmpDir, 'cover.png');
  const coverJpgPath = path.join(tmpDir, 'cover.jpg');
  fs.writeFileSync(coverPngPath, coverPng);
  pngToJPEG(coverPngPath, coverJpgPath, { quality: 2 });
  const coverJpeg = fs.readFileSync(coverJpgPath);

  const pages = [
    {
      kind: 'image',
      width: PDF_WIDTH,
      height: PDF_HEIGHT,
      imageWidth: MIXED_COVER_WIDTH_PX,
      imageHeight: MIXED_COVER_HEIGHT_PX,
      jpeg: coverJpeg,
    },
  ];
  const pageTruth = [{ page: 1, lines: coverLines, table: null, hasTextLayer: false }];

  for (const spec of MIXED_TEXT_PAGES) {
    const ops = [];
    const textOps = [];
    const lines = [];
    const titleY = PDF_HEIGHT - PDF_MARGIN;
    ops.push(pdfTextOp(PDF_MARGIN, titleY, spec.title, { font: 'F2', size: 16 }));
    lines.push({ text: spec.title, xPt: PDF_MARGIN, yPt: titleY, font: 'F2', size: 16 });
    textOps.push({ text: spec.title, xPt: PDF_MARGIN, yPt: titleY });

    spec.lines.forEach((text, i) => {
      const y = titleY - 30 - i * 20;
      ops.push(pdfTextOp(PDF_MARGIN, y, text, { font: 'F1', size: 11 }));
      lines.push({ text, xPt: PDF_MARGIN, yPt: y, font: 'F1', size: 11 });
      textOps.push({ text, xPt: PDF_MARGIN, yPt: y });
    });

    pages.push({ kind: 'text', width: PDF_WIDTH, height: PDF_HEIGHT, ops, fonts: ['F1', 'F2'] });
    pageTruth.push({ page: spec.page, lines, textOps, hasTextLayer: true });
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const pdf = buildPDF({ pages });
  writeFile(outDir, 'sample-mixed.pdf', pdf);

  return {
    id: 'sample-mixed-pdf',
    kind: 'pdf',
    file: 'sample-mixed.pdf',
    generator: 'fixtures/generate.mjs',
    pageCount: pages.length,
    pageWidthPt: PDF_WIDTH,
    pageHeightPt: PDF_HEIGHT,
    marginPt: PDF_MARGIN,
    hasTextLayer: true,
    coverPage: 1,
    textLayerPages: MIXED_TEXT_PAGES.map((spec) => spec.page),
    noTextLayerPages: [1],
    imageWidthPx: MIXED_COVER_WIDTH_PX,
    imageHeightPx: MIXED_COVER_HEIGHT_PX,
    imageFormat: 'jpeg',
    jpegQuality: 2,
    pages: pageTruth,
  };
}

// ---------------------------------------------------------------------------
// optional: macOS `say` speech sample (skipped on other platforms)
// ---------------------------------------------------------------------------

const OPTIONAL_SPEECH_TEXT = 'MULTIMEDIA GREP OPTIONAL SPEECH FIXTURE.';

function generateOptionalSpeech(outDir) {
  if (process.platform !== 'darwin') return null;
  const file = path.join(outDir, 'sample-speech-optional.wav');
  const write = (voice) =>
    run('say', [
      ...(voice ? ['-v', voice] : []),
      '-o',
      file,
      '--file-format=WAVE',
      '--data-format=LEI16@44100',
      OPTIONAL_SPEECH_TEXT,
    ]);
  // `say` has no --version flag; just try a named voice and fall back to the
  // system default. Any failure means the asset is simply skipped.
  let res = write('Alex');
  if (!res.ok || !fs.existsSync(file)) {
    res = write(null);
  }
  if (!res.ok || !fs.existsSync(file)) return null;
  const info = probe(file);
  const durationMs = Math.round(Number(info.format?.duration ?? 0) * 1000);
  return {
    id: 'sample-speech-optional',
    kind: 'audio',
    file: 'sample-speech-optional.wav',
    generator: 'fixtures/generate.mjs',
    optional: true,
    platform: 'darwin',
    format: 'wav',
    durationMs,
    text: OPTIONAL_SPEECH_TEXT,
    note:
      'Optional asset produced with macOS `say`. Not asserted against: the voice, ' +
      'duration and waveform differ per platform. ASR truth requires a stub provider.',
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node fixtures/generate.mjs [--out <dir>]\n\n' +
        `Default output directory: ${DEFAULT_OUT}\n`,
    );
    return;
  }

  // Fail fast (and loudly) if the local ffmpeg cannot produce what we need.
  const missing = ['libx264', 'aac', 'mjpeg', 'libmp3lame'].filter((name) => !hasEncoder(name));
  if (missing.length > 0) {
    throw new Error(
      `this ffmpeg build is missing required encoders: ${missing.join(', ')} ` +
        `(${ffmpegCapabilities().version})`,
    );
  }
  process.stdout.write(
    hasFilter('drawtext')
      ? 'ffmpeg has drawtext; the built-in bitmap font is used anyway for reproducibility\n'
      : 'ffmpeg has no drawtext filter; rendering text with the built-in bitmap font\n',
  );

  const outDir = args.out;
  fs.mkdirSync(outDir, { recursive: true });
  const gtOutDir = path.join(outDir, 'ground-truth');
  fs.mkdirSync(gtOutDir, { recursive: true });

  const writeRepoCopy = path.resolve(outDir) === path.resolve(DEFAULT_OUT);

  const groundTruths = [];
  groundTruths.push(generateSampleScene(outDir));
  groundTruths.push(generateSampleSubtitles(outDir));
  groundTruths.push(generateSampleZoom(outDir));
  groundTruths.push(...generateSampleTone(outDir));
  groundTruths.push(generateSampleTextPdf(outDir));
  groundTruths.push(generateSampleTwoColumnPdf(outDir));
  groundTruths.push(generateSampleLongPagePdf(outDir));
  groundTruths.push(generateSampleScannedPdf(outDir));
  groundTruths.push(generateSampleImage(outDir));
  groundTruths.push(generateSampleMixedPdf(outDir));
  const optional = generateOptionalSpeech(outDir);
  if (optional) groundTruths.push(optional);

  for (const gt of groundTruths) {
    writeGroundTruth(gtOutDir, gt.id, gt);
    // The optional macOS-only asset is platform dependent, so it is never
    // committed to the repository copy of the ground truth.
    if (writeRepoCopy && !gt.optional) writeGroundTruth(REPO_GROUND_TRUTH, gt.id, gt);
  }

  // Manifest of the produced assets (hashes of everything except itself).
  const assets = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== 'manifest.json')
    .map((e) => e.name)
    .sort();
  const manifest = {
    generator: 'fixtures/generate.mjs',
    files: assets.map((name) => ({ name, bytes: fs.statSync(path.join(outDir, name)).size, sha256: sha256(path.join(outDir, name)) })),
    groundTruth: fs
      .readdirSync(gtOutDir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .map((name) => ({ name, sha256: sha256(path.join(gtOutDir, name)) })),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(`fixtures written to ${outDir}\n`);
  for (const line of manifest.files) {
    process.stdout.write(`  ${line.name} (${line.bytes} bytes)\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exitCode = 1;
});
