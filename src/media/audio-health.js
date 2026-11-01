// src/media/audio-health.js —— 音频体检（契约 §4.3.1）
// 视频与录音共用：太安静就跳过 ASR，避免幻觉台词。

export const DEFAULT_AUDIO_CONFIG = Object.freeze({
  minDbfs: -35,
  minSpeechRatio: 0.05,
  silenceNoiseDb: -45,
  silenceMinSec: 0.3,
  silentDbfs: -60,
});

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function audioConfig(ctx = {}, env = process.env) {
  const cfg = ctx.config?.audio ?? {};
  return {
    minDbfs: numberOr(cfg.minDbfs ?? env.MMGREP_AUDIO_MIN_DBFS, DEFAULT_AUDIO_CONFIG.minDbfs),
    minSpeechRatio: numberOr(cfg.minSpeechRatio ?? env.MMGREP_AUDIO_MIN_SPEECH_RATIO, DEFAULT_AUDIO_CONFIG.minSpeechRatio),
    silenceNoiseDb: numberOr(cfg.silenceNoiseDb, DEFAULT_AUDIO_CONFIG.silenceNoiseDb),
    silenceMinSec: numberOr(cfg.silenceMinSec, DEFAULT_AUDIO_CONFIG.silenceMinSec),
    silentDbfs: DEFAULT_AUDIO_CONFIG.silentDbfs,
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** 先体检，再决定要不要花 ASR */
export function computeAudioHealth({ levels = {}, silences = [], durationSec, thresholds } = {}) {
  const cfg = { ...DEFAULT_AUDIO_CONFIG, ...thresholds };
  const meanDbfs = levels.meanDbfs ?? null;
  const peakDbfs = levels.peakDbfs ?? null;
  let silenceSec = 0;
  for (const s of silences) {
    if (Number.isFinite(s.durationSec)) silenceSec += s.durationSec;
    else if (Number.isFinite(s.startSec) && Number.isFinite(durationSec)) {
      silenceSec += Math.max(0, durationSec - s.startSec);
    }
  }
  const silenceRatio = durationSec ? clamp01(silenceSec / durationSec) : null;
  const speechRatio = silenceRatio === null ? null : clamp01(1 - silenceRatio);

  let verdict;
  if (meanDbfs === null) verdict = 'silent';
  else if (meanDbfs < cfg.silentDbfs) verdict = 'silent';
  else if (meanDbfs < cfg.minDbfs || (speechRatio !== null && speechRatio < cfg.minSpeechRatio)) verdict = 'too-quiet';
  else verdict = 'has-speech';

  const notes = {
    'has-speech': 'The recording contains audible speech; transcription can run.',
    'too-quiet': 'The recording is too quiet or almost entirely silent; ASR is skipped to avoid hallucinated lines.',
    silent: 'The recording is effectively silent; transcription is empty.',
    'no-audio-track': 'This file has no audio track.',
  };
  return {
    verdict,
    meanDbfs,
    peakDbfs,
    speechRatio,
    silenceRatio,
    effective: verdict === 'has-speech',
    note: notes[verdict],
  };
}
