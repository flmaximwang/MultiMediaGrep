// src/backend/video/probe.js —— ffprobe 元信息 + 音频体检 + probe 结果整形
//
// 这里只回答「这个视频是什么、有没有字幕、能不能转写」，不扫镜头、不出图。
// audioHealth 只解码**音频流**（-map 0:a:0），不碰视频，否则一次 probe 会把整片解一遍。

import { stat } from 'node:fs/promises';

import { audioConfig, computeAudioHealth } from '../../media/audio-health.js';
import { ffprobeJson, run } from '../../media/ffmpeg.js';
import { ToolError } from '../../media/interface.js';
import { discoverSiblingSubtitles, pickSubtitleStream } from '../../media/transcript.js';
import {
  displayAspect,
  normalizeRotation,
  parseRational,
  parseSar,
  uprightSize,
} from './geometry.js';

const NO_AUDIO_HEALTH = Object.freeze({
  verdict: 'no-audio-track',
  meanDbfs: null,
  peakDbfs: null,
  speechRatio: null,
  silenceRatio: null,
  effective: false,
  note: 'This file has no audio track.',
});

const HEALTH_TIMEOUT_MS = 300_000;
const HEALTH_CACHE_LIMIT = 32;
/** @type {Map<string, Promise<object>>} */
const healthCache = new Map();

/**
 * 读容器/流信息（不跑音频体检）。zoom/subtitles 只需要这些，不需要解码任何帧。
 * @returns {Promise<object>}
 */
export async function readVideoInfo(input, ctx = {}) {
  const [info, stats] = await Promise.all([
    ffprobeJson(input.path, { signal: ctx.signal }),
    stat(input.path),
  ]);
  const streams = Array.isArray(info?.streams) ? info.streams : [];
  const videoStream = streams.find((stream) => stream?.codec_type === 'video');
  if (!videoStream) {
    throw new ToolError('UNSUPPORTED_MEDIA_TYPE', `"${input.path}" has no video stream.`);
  }
  const audioStream = streams.find((stream) => stream?.codec_type === 'audio') ?? null;
  const subtitleStreams = streams.filter((stream) => stream?.codec_type === 'subtitle');
  const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');

  const durationSec = Number(info?.format?.duration) || Number(videoStream?.duration) || null;
  const rotation = normalizeRotation(
    videoStream?.side_data_list?.find((data) => data?.rotation !== undefined)?.rotation
      ?? videoStream?.tags?.rotate,
  );
  const codedWidth = Number(videoStream?.width) || 0;
  const codedHeight = Number(videoStream?.height) || 0;
  const { width, height } = uprightSize(codedWidth, codedHeight, rotation);
  const sar = parseSar(videoStream?.sample_aspect_ratio);
  const avgFps = parseRational(videoStream?.avg_frame_rate);
  const rFps = parseRational(videoStream?.r_frame_rate);
  const fps = avgFps ?? (rFps && rFps <= 240 ? rFps : null);

  return {
    info,
    stats,
    sourcePath: input.path,
    streams,
    durationSec,
    videoStream,
    audioStream,
    hasAudio: audioStream !== null,
    width: width > 0 ? width : null,
    height: height > 0 ? height : null,
    rotation,
    aspect: width > 0 && height > 0 ? displayAspect(codedWidth, codedHeight, sar, rotation) : null,
    fps,
    fpsForScan: fps && fps > 0 ? fps : 25,
    videoCodec: videoStream?.codec_name ?? null,
    container: info?.format?.format_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    audioChannels: audioStream?.channels ?? null,
    sampleRateHz: audioStream ? Number(audioStream.sample_rate) || null : null,
    audioTracks: audioStreams.map((stream, i) => ({
      index: stream.index ?? i,
      language: stream.tags?.language ?? null,
      codec: stream.codec_name ?? null,
    })),
    subtitleTracks: subtitleStreams.map((stream, i) => ({
      index: stream.index ?? i,
      language: stream.tags?.language ?? null,
      codec: stream.codec_name ?? null,
      default: Boolean(stream.disposition?.default),
    })),
  };
}

/** volumedetect，只映射音频流：视频不参与解码 */
async function measureAudioLevels(filePath, { signal } = {}) {
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', filePath, '-map', '0:a:0', '-vn',
      '-af', 'volumedetect', '-f', 'null', '-'],
    { signal, allowNonZero: true, timeoutMs: HEALTH_TIMEOUT_MS },
  );
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  const peak = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  return {
    meanDbfs: mean ? Number(mean[1]) : null,
    peakDbfs: peak ? Number(peak[1]) : null,
  };
}

/** silencedetect，只映射音频流；解析逻辑与 media/ffmpeg.js 的 detectSilence 一致 */
async function detectAudioSilence(filePath, { noiseDb, minDurationSec, signal }) {
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', filePath, '-map', '0:a:0', '-vn',
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`, '-f', 'null', '-'],
    { signal, allowNonZero: true, timeoutMs: HEALTH_TIMEOUT_MS },
  );
  const ranges = [];
  let pendingStart = null;
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start) {
      pendingStart = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (end && pendingStart !== null) {
      const endSec = Number(end[1]);
      ranges.push({ startSec: pendingStart, endSec, durationSec: Math.max(0, endSec - pendingStart) });
      pendingStart = null;
    }
  }
  // 以静音结尾的文件只有 silence_start
  if (pendingStart !== null) {
    ranges.push({ startSec: pendingStart, endSec: null, durationSec: null });
  }
  return ranges;
}

async function computeHealthFor(media, ctx) {
  if (!media.hasAudio) return { ...NO_AUDIO_HEALTH };
  const cfg = audioConfig(ctx);
  try {
    const [levels, silences] = await Promise.all([
      measureAudioLevels(media.sourcePath, { signal: ctx.signal }),
      media.durationSec
        ? detectAudioSilence(media.sourcePath, {
          noiseDb: cfg.silenceNoiseDb,
          minDurationSec: cfg.silenceMinSec,
          signal: ctx.signal,
        })
        : Promise.resolve([]),
    ]);
    return computeAudioHealth({ levels, silences, durationSec: media.durationSec, thresholds: cfg });
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return {
      verdict: 'silent',
      meanDbfs: null,
      peakDbfs: null,
      speechRatio: null,
      silenceRatio: null,
      effective: false,
      note: `Audio levels could not be measured (${error?.message ?? error}); ASR is skipped for this file.`,
    };
  }
}

/**
 * 音频体检（带进程内缓存）。server 在 overview/zoom/locate 之前都会先 probe，
 * 缓存让同一份文件不会每调用一次就重新解码一遍音频。
 *
 * 注意：缓存键含 audio 阈值，测试里换 MMGREP_AUDIO_MIN_DBFS 不会被旧结果污染。
 */
export async function getAudioHealth(media, ctx = {}) {
  if (!media.hasAudio) return { ...NO_AUDIO_HEALTH };
  const cfg = audioConfig(ctx);
  const key = [
    media.sourcePath ?? '',
    media.stats?.size ?? '',
    media.stats?.mtimeMs ?? '',
    cfg.minDbfs,
    cfg.minSpeechRatio,
    cfg.silenceNoiseDb,
    cfg.silenceMinSec,
  ].join('\0');
  if (healthCache.has(key)) return healthCache.get(key);

  const pending = computeHealthFor(media, ctx);
  healthCache.set(key, pending);
  if (healthCache.size > HEALTH_CACHE_LIMIT) {
    const oldest = healthCache.keys().next().value;
    healthCache.delete(oldest);
  }
  pending.catch(() => healthCache.delete(key));
  return pending;
}

/** 显式 transcriptFile 在 probe 里只「报告」：不存在/不是文件时不报错，也不当作来源 */
async function explicitSubtitleFile(filePath) {
  if (!filePath) return null;
  try {
    const info = await stat(filePath);
    return info.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

export async function shapeProbe({ media, audioHealth, input, ctx }) {
  let subtitlePath = null;
  let subtitleOrigin = null;
  const explicit = await explicitSubtitleFile(input?.transcriptFile);
  if (explicit) {
    subtitlePath = explicit;
    subtitleOrigin = 'file';
  } else if (pickSubtitleStream(media.streams) !== null) {
    subtitleOrigin = 'embedded';
  } else {
    const sibling = (await discoverSiblingSubtitles(input.path))[0] ?? null;
    if (sibling) {
      subtitlePath = sibling.path;
      subtitleOrigin = 'file';
    }
  }

  const provider = ctx.asrProvider ?? null;
  let asrAvailable = Boolean(provider) && audioHealth.effective;
  let asrReason = null;
  if (input?.transcript === 'off') {
    asrAvailable = false;
    asrReason = 'Transcription was disabled for this call (transcript: "off").';
  } else if (!media.hasAudio) {
    asrAvailable = false;
    asrReason = 'This file has no audio track.';
  } else if (!provider) {
    asrReason = 'No ASR provider is configured (set MMGREP_ASR_PROVIDER and MMGREP_ASR_API_KEY).';
  } else if (!audioHealth.effective) {
    asrReason = audioHealth.note;
  }

  let transcriptSource = 'none';
  let transcriptOrigin = 'none';
  if (subtitleOrigin) {
    transcriptSource = 'subtitle';
    transcriptOrigin = subtitleOrigin;
  } else if (asrAvailable) {
    transcriptSource = 'asr';
    transcriptOrigin = 'asr';
  }

  const long = media.durationSec !== null && media.durationSec > 1800;
  return {
    mediaType: 'video',
    path: input.path,
    sizeBytes: media.stats.size,
    modifiedMs: Math.round(media.stats.mtimeMs),
    durationMs: media.durationSec !== null ? Math.round(media.durationSec * 1000) : null,
    durationSec: media.durationSec,
    width: media.width,
    height: media.height,
    fps: media.fps,
    rotation: media.rotation,
    aspect: media.aspect,
    videoCodec: media.videoCodec,
    container: media.container,
    hasAudio: media.hasAudio,
    audioCodec: media.audioCodec,
    audioChannels: media.audioChannels,
    sampleRateHz: media.sampleRateHz,
    audioHealth,
    pageCount: null,
    hasTextLayer: null,
    subtitleTracks: media.subtitleTracks,
    audioTracks: media.audioTracks,
    capabilities: {
      asr: {
        available: asrAvailable,
        provider: provider?.id ?? null,
        reason: asrReason,
      },
      ocr: {
        available: false,
        provider: null,
        reason: 'OCR is not applicable to video media; use media_zoom to read a frame.',
      },
      transcriptSource,
      transcriptOrigin,
      transcriptPath: transcriptPathFor(transcriptOrigin, subtitlePath),
    },
    recommended: {
      mode: long ? 'sequence' : 'single',
      segmentSec: 300,
      overviewImages: 2,
      cellsPerImage: 9,
      estimatedImageTokens: 2458,
      note: long
        ? 'Long video: pass start/end for the part you need, then page through with the continuation hint.'
        : 'One overview is enough. media_overview({ path }) is the next step.',
    },
  };
}

function transcriptPathFor(origin, subtitlePath) {
  return origin === 'file' ? subtitlePath : null;
}

/** probe 的完整路径：元信息 + 音频体检 + 来源判定 */
export async function probeVideoMedia(input, ctx) {
  const media = await readVideoInfo(input, ctx);
  const audioHealth = await getAudioHealth(media, ctx);
  return shapeProbe({ media, audioHealth, input, ctx });
}
