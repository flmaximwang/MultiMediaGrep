// src/backend/audio/index.js —— 录音后端
// 职责：probe（含音频体检）/ overview（字幕或 ASR → 带时间轴的段落列表）/ locate（短语→时间码）。
// 字幕来源判定、音频体检、切片与合并的约定见 docs/mcp-contract.md §4.3.1、§7、§8.5。

import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { hashFile } from '../../cache/hash.js';
import { resolveCacheConfig } from '../../cache/index.js';
import {
  detectSilence,
  ffprobeJson,
  measureLevels,
  normalizeToWav,
  renderWaveform,
  run,
} from '../../media/ffmpeg.js';
import { ToolError } from '../../media/interface.js';
import { matchSegments, splitIntoSentences } from '../../media/match.js';
import {
  analyzeSubtitleStreams,
  bitmapSkippedWarnings,
  describeSubtitleSelection,
  discoverSiblingSubtitles,
  resolveSubtitleSource,
} from '../../media/transcript.js';
import { audioConfig, computeAudioHealth } from '../../media/audio-health.js';

export { computeAudioHealth };
import { mergeTranscripts, planChunks } from './chunks.js';

async function shapeProbe({ info, audioHealth, input, ctx, stats, durationSec, subtitleHints }) {
  const streams = info?.streams ?? [];
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const audioTracks = audioStreams.map((s, i) => ({
    index: s.index ?? i,
    language: s.tags?.language ?? null,
    codec: s.codec_name ?? null,
  }));
  const transcriptMode = input?.transcript ?? 'auto';
  const asrProvider = ctx.asrProvider ?? null;
  let asrAvailable = Boolean(asrProvider) && audioHealth.effective;
  let asrReason = null;
  if (transcriptMode === 'off') {
    asrAvailable = false;
    asrReason = 'Transcription was disabled for this call (transcript: "off").';
  } else if (transcriptMode === 'subtitle') {
    asrAvailable = false;
    asrReason = 'transcript is "subtitle": only subtitle sources are read and ASR is never called.';
  } else if (!asrProvider) {
    asrReason = 'No ASR provider is configured (set MMGREP_ASR_PROVIDER and the matching provider key: '
      + 'MMGREP_ELEVENLABS_API_KEY or MMGREP_OPENAI_COMPATIBLE_API_KEY).';
  } else if (!audioHealth.effective) {
    asrReason = audioHealth.note;
  }

  // 字幕优先于 ASR（契约 §8.5）：显式选择 → 内嵌轨 → 同目录同名 → ASR。
  // probe 对显式选择只报告：不可用时不报错，也不拿自动来源冒充（契约 §4.5）。
  const explicit = await describeSubtitleSelection({ subtitle: input?.subtitle, streams });
  const explicitError = explicit?.error ?? null;
  const explicitNote = explicit?.warnings?.length ? explicit.warnings.join('; ') : null;
  const siblingPath = subtitleHints?.siblingPath ?? null;
  let transcriptSource = 'none';
  let transcriptOrigin = 'none';
  let transcriptPath = null;
  if (explicitError) {
    // 显式选择不可用：只报告原因
  } else if (transcriptMode !== 'off' && explicit) {
    transcriptSource = 'subtitle';
    transcriptOrigin = explicit.origin;
    transcriptPath = explicit.sourcePath;
  } else if (transcriptMode !== 'off' && subtitleHints?.hasEmbeddedSubtitle) {
    transcriptSource = 'subtitle';
    transcriptOrigin = 'embedded';
  } else if (transcriptMode !== 'off' && siblingPath) {
    transcriptSource = 'subtitle';
    transcriptOrigin = 'file';
    transcriptPath = siblingPath;
  } else if (asrAvailable) {
    transcriptSource = 'asr';
    transcriptOrigin = 'asr';
  }
  // 有字幕轨却没用上（如只有图形字幕）时，probe 也要说明原因；
  // 显式选择多条命中时，把「其余命中」一并交代出来。
  const bitmapReason = (subtitleHints?.warnings ?? []).join('; ');
  const transcriptReason = explicitError
    ?? (transcriptSource === 'subtitle' ? explicitNote : (bitmapReason || null));

  return {
    mediaType: 'audio',
    path: input.path,
    sizeBytes: stats.size,
    modifiedMs: Math.round(stats.mtimeMs),
    durationMs: durationSec ? Math.round(durationSec * 1000) : null,
    durationSec: durationSec ?? null,
    width: null,
    height: null,
    fps: null,
    rotation: null,
    aspect: null,
    videoCodec: null,
    container: info?.format?.format_name ?? null,
    hasAudio: audioStreams.length > 0,
    audioCodec: audioStreams[0]?.codec_name ?? null,
    audioChannels: audioStreams[0]?.channels ?? null,
    sampleRateHz: audioStreams[0] ? Number(audioStreams[0].sample_rate) || null : null,
    audioHealth,
    pageCount: null,
    hasTextLayer: null,
    subtitleTracks: streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s, i) => ({ index: s.index ?? i, language: s.tags?.language ?? null, codec: s.codec_name ?? null })),
    audioTracks,
    capabilities: {
      asr: {
        available: asrAvailable,
        provider: asrProvider?.id ?? null,
        reason: asrReason,
      },
      ocr: { available: false, provider: null, reason: 'Audio has no pages to OCR.' },
      transcriptSource,
      transcriptOrigin,
      transcriptPath,
      transcriptReason,
    },
    recommended: {
      mode: durationSec && durationSec > 600 ? 'sequence' : 'single',
      segmentSec: 600,
      overviewImages: audioHealth.effective || input?.envelope ? 1 : 0,
      cellsPerImage: 0,
      estimatedImageTokens: input?.envelope === false ? 0 : 400,
      note: audioHealth.effective
        ? 'Audio only: read the transcript or the subtitle file; ask for start/end windows for long recordings.'
        : 'No usable speech detected; only metadata and waveform are available.',
    },
  };
}

// 进程内短缓存：overview/locate 会先被 server 的 internalProbe 探一次，再被自己探一次。
// probe 要全片解码测音量（volumedetect + silencedetect），缓存按「路径+大小+mtime」失效。
const PROBE_CACHE = new Map();
const PROBE_CACHE_MAX = 32;

async function probeAudio(input, ctx) {
  const [info, stats] = await Promise.all([
    ffprobeJson(input.path, { signal: ctx.signal }),
    stat(input.path),
  ]);
  const cacheKey = `${input.path}:${stats.size}:${stats.mtimeMs}`;
  const cached = PROBE_CACHE.get(cacheKey);
  if (cached) return { ...cached, info, stats };
  const durationSec = Number(info?.format?.duration) || null;
  const hasAudioStream = (info?.streams ?? []).some((s) => s.codec_type === 'audio');
  const cfg = audioConfig(ctx);
  let audioHealth = {
    verdict: 'no-audio-track', meanDbfs: null, peakDbfs: null, speechRatio: null,
    silenceRatio: null, effective: false, note: 'This file has no audio track.',
  };
  if (hasAudioStream && durationSec) {
    ctx.onProgress?.({ stage: 'probe', detail: 'measuring audio levels' });
    const [levels, silences] = await Promise.all([
      measureLevels(input.path, { signal: ctx.signal }),
      detectSilence(input.path, { noiseDb: cfg.silenceNoiseDb, minDurationSec: cfg.silenceMinSec, signal: ctx.signal }),
    ]);
    audioHealth = computeAudioHealth({ levels, silences, durationSec, thresholds: cfg });
  }
  const sibling = (await discoverSiblingSubtitles(input.path))[0] ?? null;
  const subtitleAnalysis = analyzeSubtitleStreams(info?.streams ?? []);
  const result = {
    durationSec,
    audioHealth,
    subtitleHints: {
      siblingPath: sibling?.path ?? null,
      hasEmbeddedSubtitle: subtitleAnalysis.stream !== null,
      warnings: bitmapSkippedWarnings(subtitleAnalysis.bitmapSkipped),
    },
  };
  if (PROBE_CACHE.size >= PROBE_CACHE_MAX) {
    PROBE_CACHE.delete(PROBE_CACHE.keys().next().value);
  }
  PROBE_CACHE.set(cacheKey, result);
  return { ...result, info, stats };
}

function noneTranscript(reason) {
  return {
    source: 'none',
    origin: 'none',
    provider: null,
    model: null,
    language: null,
    file: null,
    reason,
  };
}

/** 字幕文件 / 内嵌轨 / ASR / 空转写，四条来源一条路 */
async function getTranscript(input, ctx, { info, durationSec, audioHealth }) {
  const warnings = [];

  // transcript: "off" 是「完全不要文字」：字幕也不读，直接返回空。
  if (input.transcript === 'off') {
    warnings.push('transcript-disabled');
    return {
      segments: [],
      transcript: noneTranscript('transcription was disabled for this call (transcript: "off").'),
      warnings,
    };
  }

  // 1–3：字幕来源（契约 §8.5）
  const subtitle = await resolveSubtitleSource({
    mediaPath: input.path,
    subtitle: input.subtitle,
    streams: info?.streams ?? [],
    signal: ctx.signal,
    warnings,
  });
  if (subtitle) {
    ctx.onProgress?.({ stage: 'transcript', detail: `read ${subtitle.origin} subtitles` });
    return {
      segments: subtitle.segments.map((s) => ({ ...s, source: 'subtitle', origin: subtitle.origin })),
      transcript: {
        source: 'subtitle',
        origin: subtitle.origin,
        provider: null,
        model: null,
        language: subtitle.language,
        file: subtitle.sourcePath,
      },
      warnings,
    };
  }

  // transcript: "subtitle" 只读字幕，绝不回退到 ASR。
  if (input.transcript === 'subtitle') {
    warnings.push('no-subtitle-source');
    return {
      segments: [],
      transcript: noneTranscript('no subtitle source was found for this file (transcript: "subtitle"); ASR was not used.'),
      warnings,
    };
  }

  if (!ctx.asrProvider) {
    warnings.push('asr-not-configured');
    return {
      segments: [],
      transcript: noneTranscript('no ASR provider is configured (MMGREP_ASR_PROVIDER="none").'),
      warnings,
    };
  }
  if (!audioHealth?.effective) {
    warnings.push(`audio-${audioHealth?.verdict ?? 'unusable'}`);
    return {
      segments: [],
      transcript: noneTranscript(audioHealth?.note || 'the audio has no effective speech; ASR is skipped.'),
      warnings,
    };
  }

  const cfg = audioConfig(ctx);
  ctx.onProgress?.({ stage: 'normalize', detail: 'normalizing audio for ASR' });
  const workDir = await makeWorkDir(ctx, input.path, 'audio');
  const normalized = path.join(workDir, 'normalized.wav');
  await normalizeToWav(input.path, normalized, { signal: ctx.signal });

  const silences = await detectSilence(normalized, {
    noiseDb: cfg.silenceNoiseDb,
    minDurationSec: cfg.silenceMinSec,
    signal: ctx.signal,
  });
  const chunks = planChunks({ durationSec, silences });

  const parts = [];
  let provider = null;
  let model = null;
  let language = null;
  for (const chunk of chunks) {
    const chunkPath = path.join(workDir, `chunk-${String(chunk.index).padStart(3, '0')}.wav`);
    await cutChunk(normalized, chunk, chunkPath, ctx);
    ctx.onProgress?.({
      stage: 'transcribe',
      detail: `chunk ${chunk.index + 1}/${chunks.length}`,
      progress: Math.round((chunk.index / Math.max(1, chunks.length)) * 100),
    });
    const result = await ctx.asrProvider.transcribe({
      audioPath: chunkPath,
      language: ctx.config?.asr?.language ?? process.env.MMGREP_ASR_LANGUAGE ?? undefined,
      mimeType: 'audio/wav',
      signal: ctx.signal,
    });
    parts.push({ startSec: chunk.startSec, segments: result.segments ?? [] });
    language = result.language ?? language;
    model = result.model ?? model;
    provider = result.provider ?? provider;
  }

  const merged = mergeTranscripts(parts).map((s) => ({ ...s, source: 'asr', origin: 'asr' }));
  return {
    segments: merged,
    transcript: {
      source: 'asr',
      origin: 'asr',
      provider,
      model,
      language,
      file: null,
    },
    warnings,
  };
}

async function cutChunk(normalized, chunk, outPath, ctx) {
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-ss', String(chunk.startSec),
    '-t', String(chunk.durationSec),
    '-i', normalized,
    '-c', 'copy',
    outPath,
  ], { signal: ctx.signal });
  return outPath;
}

async function makeWorkDir(ctx, sourcePath, kind) {
  const { dir } = resolveCacheConfig(process.env);
  const { sha256 } = await hashFile(sourcePath);
  const workDir = path.join(dir, 'work', kind, sha256.slice(0, 16));
  await mkdir(workDir, { recursive: true });
  return workDir;
}

/** 窗口语义：半开区间 [startMs, endMs)；恰好落在边界上的段落不算越过窗口 */
function inWindow(segment, startMs, endMs) {
  const s = segment.startMs ?? 0;
  const e = segment.endMs ?? s;
  if (startMs !== null && e <= startMs) return false;
  if (endMs !== null && s >= endMs) return false;
  return true;
}

async function readImage(imagePath, meta) {
  const buffer = await readFile(imagePath);
  return {
    ...meta,
    file: imagePath,
    buffer,
    mimeType: 'image/png',
    cells: 1,
  };
}

export function createAudioBackend(ctx = {}) {
  const backendCtx = () => ({ ...ctx, config: ctx.config ?? {} });

  async function probe(input, callCtx = backendCtx()) {
    const probed = await probeAudio(input, callCtx);
    return shapeProbe({
      info: probed.info,
      audioHealth: probed.audioHealth,
      input,
      ctx: callCtx,
      stats: probed.stats,
      durationSec: probed.durationSec,
      subtitleHints: probed.subtitleHints,
    });
  }

  async function overview(input, callCtx = backendCtx()) {
    const c = callCtx;
    const probed = await probeAudio(input, c);
    const transcriptData = await getTranscript(input, c, probed);
    const warnings = [...transcriptData.warnings];

    const window = {
      startMs: input.startMs ?? null,
      endMs: input.endMs ?? null,
    };
    let segments = transcriptData.segments;
    if (window.startMs !== null || window.endMs !== null) {
      segments = segments.filter((s) => inWindow(s, window.startMs, window.endMs));
    }

    // 可选音频包络图（后端只给 buffer + 尺寸，内容和预算由 server 组装）
    // images: 0 是零像素模式：压过 envelope，一律不出波形图。
    const images = [];
    if (input.envelope === true && input.images !== 0) {
      c.onProgress?.({ stage: 'images', detail: 'rendering waveform' });
      const workDir = await makeWorkDir(c, input.path, 'audio');
      const wavePath = path.join(workDir, 'envelope.png');
      await renderWaveform(input.path, wavePath, { width: 1200, height: 300, signal: c.signal });
      images.push(await readImage(wavePath, { index: 1, kind: 'envelope', width: 1200, height: 300 }));
    }

    return {
      mediaType: 'audio',
      path: input.path,
      durationMs: probed.durationSec ? Math.round(probed.durationSec * 1000) : null,
      audioHealth: probed.audioHealth,
      segments,
      images,
      transcript: transcriptData.transcript,
      warnings,
    };
  }

  async function locate(input, callCtx = backendCtx()) {
    const c = callCtx;
    const probed = await probeAudio(input, c);
    const transcriptData = await getTranscript(input, c, probed);

    if (transcriptData.transcript.source === 'none') {
      if (!c.asrProvider) {
        throw new ToolError(
          'NO_TRANSCRIPT',
          'no transcript available for this file and no ASR provider is configured (MMGREP_ASR_PROVIDER="none"). '
            + 'Pass subtitle with a local .srt/.vtt file, a track index, or a language code, or configure an ASR provider. '
            + 'For visuals only, use media_overview instead.',
        );
      }
      throw new ToolError(
        'NO_TRANSCRIPT',
        `no transcript available for this file: ${probed.audioHealth?.note ?? 'ASR produced no usable text.'} `
          + 'Pass subtitle with a local .srt/.vtt file, a track index, or a language code, or use media_overview instead.',
      );
    }

    const candidates = transcriptData.segments.flatMap((s) => splitIntoSentences(s));
    const matches = matchSegments(candidates, input.query ?? '', { max: input.max ?? 5 });
    return {
      mediaType: 'audio',
      query: input.query ?? '',
      totalSegments: candidates.length,
      matches,
      transcript: transcriptData.transcript,
      warnings: transcriptData.warnings,
      note: matches.length === 0
        ? `no line matched ${JSON.stringify(input.query ?? '')} among ${candidates.length} segments.`
        : undefined,
    };
  }

  return { probe, overview, locate };
}

export default createAudioBackend;
