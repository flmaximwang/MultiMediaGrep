/**
 * Thin wrappers around the ffmpeg / ffprobe CLIs plus capability probing.
 */

import { spawnSync } from 'node:child_process';

export class ToolError extends Error {
  constructor(message, { cmd, code, stderr } = {}) {
    super(message);
    this.name = 'ToolError';
    this.cmd = cmd;
    this.code = code;
    this.stderr = stderr;
  }
}

/** Run a command, capturing stdout/stderr as Buffers. */
export function run(cmd, args, { input, cwd, encoding = 'buffer' } = {}) {
  const res = spawnSync(cmd, args, {
    input,
    cwd,
    maxBuffer: 1024 * 1024 * 512,
  });
  if (res.error) throw new ToolError(`${cmd} failed to start: ${res.error.message}`, { cmd });
  const stdout = res.stdout ?? Buffer.alloc(0);
  const stderr = res.stderr ?? Buffer.alloc(0);
  return {
    ok: res.status === 0,
    status: res.status,
    stdout,
    stderr,
    stdoutText: encoding === 'buffer' ? stdout.toString('utf8') : stdout.toString(encoding),
    stderrText: encoding === 'buffer' ? stderr.toString('utf8') : stderr.toString(encoding),
  };
}

/** Run ffmpeg and throw on failure. */
export function ffmpeg(args, opts = {}) {
  const res = run('ffmpeg', ['-hide_banner', '-nostdin', ...args], opts);
  if (!res.ok) {
    throw new ToolError(`ffmpeg exited with ${res.status}: ${res.stderrText.slice(-2000)}`, {
      cmd: `ffmpeg ${args.join(' ')}`,
      code: res.status,
      stderr: res.stderrText,
    });
  }
  return res;
}

/** Run ffprobe and throw on failure. */
export function ffprobe(args, opts = {}) {
  const res = run('ffprobe', ['-hide_banner', ...args], opts);
  if (!res.ok) {
    throw new ToolError(`ffprobe exited with ${res.status}: ${res.stderrText.slice(-2000)}`, {
      cmd: `ffprobe ${args.join(' ')}`,
      code: res.status,
      stderr: res.stderrText,
    });
  }
  return res.stdoutText;
}

const capabilityCache = new Map();

function probeCapabilities() {
  if (capabilityCache.has('caps')) return capabilityCache.get('caps');
  const filters = run('ffmpeg', ['-hide_banner', '-filters']);
  const encoders = run('ffmpeg', ['-hide_banner', '-encoders']);
  const caps = {
    filters: filters.ok ? filters.stdoutText : '',
    encoders: encoders.ok ? encoders.stdoutText : '',
    version: (() => {
      const v = run('ffmpeg', ['-version']);
      return v.ok ? v.stdoutText.split('\n')[0].trim() : 'unknown';
    })(),
    drawtext: filters.ok && /\bdrawtext\b/.test(filters.stdoutText),
  };
  capabilityCache.set('caps', caps);
  return caps;
}

export function ffmpegCapabilities() {
  return probeCapabilities();
}

export function hasFilter(name) {
  const caps = probeCapabilities();
  return new RegExp(`\\b${name}\\b`).test(caps.filters);
}

export function hasEncoder(name) {
  const caps = probeCapabilities();
  return new RegExp(`\\b${name}\\b`).test(caps.encoders);
}

/** ffprobe JSON for a media file. */
export function probe(file) {
  const text = ffprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  return JSON.parse(text);
}

/**
 * Extract a single frame by index as raw RGB24 bytes.
 * Frame-index selection (rather than `-ss`) keeps the assertion exact.
 */
export function extractFrameRGB(file, frameIndex, width, height) {
  const res = ffmpeg([
    '-v',
    'error',
    '-i',
    file,
    '-vf',
    `select=eq(n\\,${frameIndex})`,
    '-fps_mode',
    'passthrough',
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  const expected = width * height * 3;
  if (res.stdout.length !== expected) {
    throw new ToolError(
      `extractFrameRGB: expected ${expected} bytes for frame ${frameIndex} of ${file}, got ${res.stdout.length}`,
      { cmd: 'extractFrameRGB', stderr: res.stderrText },
    );
  }
  return res.stdout;
}

/**
 * Decode an audio file to raw mono PCM (s16le) and return the samples.
 */
export function decodeAudioMono(file) {
  const res = ffmpeg([
    '-v',
    'error',
    '-i',
    file,
    '-ac',
    '1',
    '-ar',
    '44100',
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-',
  ]);
  const samples = new Float32Array(Math.floor(res.stdout.length / 2));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = res.stdout.readInt16LE(i * 2) / 32768;
  }
  return { samples, sampleRate: 44100 };
}

/** Mean volume in dB over a time range, using ffmpeg's volumedetect. */
export function meanVolumeDb(file, startSeconds, durationSeconds) {
  const res = run('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-v',
    'info',
    '-ss',
    String(startSeconds),
    '-t',
    String(durationSeconds),
    '-i',
    file,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(res.stderrText);
  if (!m) throw new ToolError(`meanVolumeDb: could not parse volumedetect output for ${file}`);
  return Number(m[1]);
}

/** Convert a PNG file to a JPEG file using ffmpeg's mjpeg encoder. */
export function pngToJPEG(pngPath, jpegPath, { quality = 2 } = {}) {
  ffmpeg([
    '-y',
    '-v',
    'error',
    '-i',
    pngPath,
    '-frames:v',
    '1',
    '-update',
    '1',
    '-c:v',
    'mjpeg',
    '-q:v',
    String(quality),
    '-pix_fmt',
    'yuvj444p',
    jpegPath,
  ]);
}
