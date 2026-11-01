// src/backend/video/transcript.js —— 视频的转写来源（字幕优先，ASR 兜底）
//
// 契约 §8.5 的顺序写死：显式 transcriptFile → 内嵌字幕轨 → 同目录同名文件 → ASR。
// 只要前三步命中，就**绝不**跑 ASR：字幕是作者写的、准确且免费。
// ASR 只转写调用方关心的窗口（overview 的 start/end、locate 的搜索范围），
// 长视频不会因为窗口只有 1 分钟就整片转写。
//
// 每个段落都显式标 source/origin（契约 §2.5）：ASR 的 source='asr'，不能当原话引用。

import { audioConfig } from '../../media/audio-health.js';
import { detectSilence, ffprobeJson, run } from '../../media/ffmpeg.js';
import { resolveSubtitleSource } from '../../media/transcript.js';
import { mergeTranscripts, planChunks } from '../audio/chunks.js';
import { makeWorkDir } from './work.js';

export function noneTranscript(reason) {
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 解析本次调用实际可用的转写。
 *
 * @param {object} input 后端输入（path/transcriptFile/transcript）
 * @param {object} ctx backend call context
 * @param {object} media readVideoInfo() 的产物
 * @param {object} [opts]
 * @param {number} [opts.fromSec] ASR 只处理这个窗口（字幕仍读整份，由调用方裁剪）
 * @param {number|null} [opts.toSec]
 * @param {string[]} [opts.warnings] 复用的 warning 数组
 * @param {() => Promise<object>} [opts.healthProvider] 懒加载音频体检
 * @returns {Promise<{segments:Array, transcript:object, warnings:string[], audioHealth:object|null}>}
 */
export async function resolveTranscript(input, ctx, media, {
  fromSec = 0,
  toSec = media.durationSec,
  warnings = [],
  healthProvider = null,
} = {}) {
  // transcript: "off" 是「完全不要文字」：字幕也不读，直接返回空。
  if (input.transcript === 'off') {
    warnings.push('transcript-disabled');
    return {
      segments: [],
      transcript: noneTranscript('transcription was disabled for this call (transcript: "off").'),
      warnings,
      audioHealth: null,
    };
  }

  const subtitleWarnings = [];
  const subtitle = await resolveSubtitleSource({
    mediaPath: input.path,
    transcriptFile: input.transcriptFile,
    streams: media.streams,
    signal: ctx.signal,
    warnings: subtitleWarnings,
  });
  if (subtitle) {
    const segments = subtitle.segments.map((segment) => ({
      ...segment,
      source: 'subtitle',
      origin: subtitle.origin,
    }));
    return {
      segments,
      transcript: {
        source: 'subtitle',
        origin: subtitle.origin,
        provider: null,
        model: null,
        language: subtitle.language ?? null,
        file: subtitle.sourcePath ?? null,
        reason: null,
      },
      warnings: mergeWarnings(warnings, subtitleWarnings, subtitle.warnings),
      audioHealth: null,
    };
  }

  // transcript: "subtitle" 只读字幕，绝不回退到 ASR。
  if (input.transcript === 'subtitle') {
    warnings.push('no-subtitle-source');
    return {
      segments: [],
      transcript: noneTranscript('no subtitle source was found for this file (transcript: "subtitle"); ASR was not used.'),
      warnings: mergeWarnings(warnings, subtitleWarnings),
      audioHealth: null,
    };
  }

  if (!media.hasAudio) {
    warnings.push('audio-no-audio-track');
    return {
      segments: [],
      transcript: noneTranscript('this file has no audio track.'),
      warnings,
      audioHealth: null,
    };
  }
  if (!ctx.asrProvider) {
    warnings.push('asr-not-configured');
    return {
      segments: [],
      transcript: noneTranscript('no ASR provider is configured (MMGREP_ASR_PROVIDER="none").'),
      warnings,
      audioHealth: null,
    };
  }

  const audioHealth = healthProvider ? await healthProvider() : null;
  if (!audioHealth) {
    warnings.push('audio-health-unavailable');
    return {
      segments: [],
      transcript: noneTranscript('audio health could not be measured, so ASR was skipped.'),
      warnings,
      audioHealth: null,
    };
  }
  if (!audioHealth.effective) {
    warnings.push(`audio-${audioHealth.verdict ?? 'unusable'}`);
    return {
      segments: [],
      transcript: noneTranscript(audioHealth.note || 'the audio has no effective speech; ASR is skipped.'),
      warnings,
      audioHealth,
    };
  }

  const duration = media.durationSec;
  const clipStart = clamp(Number.isFinite(fromSec) ? fromSec : 0, 0, duration ?? Number.MAX_SAFE_INTEGER);
  let clipDuration = null;
  if (Number.isFinite(toSec) && toSec > clipStart) {
    clipDuration = toSec - clipStart;
    if (duration !== null) clipDuration = Math.min(clipDuration, Math.max(0, duration - clipStart));
  } else if (duration !== null) {
    clipDuration = Math.max(0, duration - clipStart);
  }
  if (clipDuration !== null && clipDuration < 0.05) {
    warnings.push('transcript-window-too-short');
    return {
      segments: [],
      transcript: noneTranscript('the requested window is too short to transcribe.'),
      warnings,
      audioHealth,
    };
  }

  const workDir = await makeWorkDir(input.path, 'asr');
  const normalized = `${workDir}/normalized-${Math.round(clipStart * 1000)}.wav`;
  ctx.onProgress?.({ stage: 'normalize', detail: 'normalizing audio for ASR' });
  await normalizeClip(input.path, normalized, { startSec: clipStart, durationSec: clipDuration, signal: ctx.signal });

  let clipSec = clipDuration;
  if (!clipSec) {
    const meta = await ffprobeJson(normalized, { signal: ctx.signal });
    clipSec = Number(meta?.format?.duration) || 0;
  }
  if (!(clipSec > 0.05)) {
    warnings.push('transcript-window-too-short');
    return {
      segments: [],
      transcript: noneTranscript('the requested window is too short to transcribe.'),
      warnings,
      audioHealth,
    };
  }

  const cfg = audioConfig(ctx);
  const silences = await detectSilence(normalized, {
    noiseDb: cfg.silenceNoiseDb,
    minDurationSec: cfg.silenceMinSec,
    signal: ctx.signal,
  });
  const chunks = planChunks({ durationSec: clipSec, silences });
  if (chunks.length === 0) {
    warnings.push('asr-empty');
    return {
      segments: [],
      transcript: noneTranscript('ASR produced no usable text for this window.'),
      warnings,
      audioHealth,
    };
  }

  const parts = [];
  let provider = null;
  let model = null;
  let language = null;
  for (const chunk of chunks) {
    const chunkPath = `${workDir}/chunk-${Math.round(clipStart * 1000)}-${String(chunk.index).padStart(3, '0')}.wav`;
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
    parts.push({ startSec: chunk.startSec, segments: result?.segments ?? [] });
    language = result?.language ?? language;
    model = result?.model ?? model;
    provider = result?.provider ?? provider;
  }

  const offsetMs = Math.round(clipStart * 1000);
  const clipEndMs = offsetMs + Math.round(clipSec * 1000);
  const segments = mergeTranscripts(parts)
    .map((segment) => {
      const rawStart = Number.isFinite(segment.startMs) ? segment.startMs : 0;
      const rawEnd = Number.isFinite(segment.endMs) ? segment.endMs : rawStart;
      const startMs = clamp(rawStart + offsetMs, offsetMs, clipEndMs);
      const endMs = clamp(rawEnd + offsetMs, startMs, clipEndMs);
      return {
        ...segment,
        startMs,
        endMs,
        text: String(segment.text ?? '').trim(),
        source: 'asr',
        origin: 'asr',
      };
    })
    .filter((segment) => segment.text && segment.endMs > segment.startMs);

  if (segments.length === 0) {
    warnings.push('asr-empty');
    return {
      segments: [],
      transcript: noneTranscript('ASR produced no usable text for this window.'),
      warnings,
      audioHealth,
    };
  }

  return {
    segments,
    transcript: {
      source: 'asr',
      origin: 'asr',
      provider,
      model,
      language,
      file: null,
      reason: null,
    },
    warnings,
    audioHealth,
  };
}

function mergeWarnings(target, ...sources) {
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const warning of source) {
      if (!target.includes(warning)) target.push(warning);
    }
  }
  return target;
}

/**
 * 只抽窗口内的音频并规范成 16 kHz 单声道 WAV。
 * `-ss`/`-t` 放在 `-i` 之前：只为省解码，代价是窗口起点可能落在最近的关键帧；
 * 这里的窗口用于 ASR 切段，不是逐帧定位，几十毫秒的偏差可接受。
 */
async function normalizeClip(inputPath, outputPath, { startSec, durationSec, signal }) {
  const args = ['-y', '-v', 'error'];
  if (startSec > 0) args.push('-ss', startSec.toFixed(3));
  if (durationSec !== null && durationSec !== undefined && durationSec > 0) {
    args.push('-t', durationSec.toFixed(3));
  }
  args.push(
    '-i', inputPath,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-ar', '16000', '-ac', '1',
    '-af', 'highpass=f=80,lowpass=f=8000,loudnorm=I=-18:TP=-1.5',
    outputPath,
  );
  await run('ffmpeg', args, { signal });
  return outputPath;
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
