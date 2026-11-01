// src/backend/audio/chunks.js —— 长音频切片规划（纯函数，无 IO）
// 目标：每片 ≤45s（ASR provider 的一次调用上限），切点尽量落在静音中间，
// 切在语音中间时加少量重叠，拼接后时间码不漂移。

import { ToolError } from '../../media/interface.js';

export const DEFAULT_CHUNK = Object.freeze({
  targetSec: 45,   // 目标片长
  minSec: 20,      // 最短片长（再短就与下一段合并）
  maxSec: 60,      // 硬上限
  overlapSec: 0.25, // 硬切时的重叠
});

/**
 * @param {object} opts
 * @param {number} opts.durationSec 总时长
 * @param {Array<{startSec:number,endSec:number|null}>} opts.silences 静音区间
 * @returns {Array<{index:number,startSec:number,endSec:number,durationSec:number,overlapSec:number,cut:'start'|'silence'|'hard'|'end'}>}
 */
export function planChunks({ durationSec, silences = [], ...opts } = {}) {
  const cfg = { ...DEFAULT_CHUNK, ...opts };
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new ToolError('INTERNAL', `planChunks: invalid durationSec ${durationSec}`);
  }
  if (durationSec <= cfg.maxSec) {
    return [{ index: 0, startSec: 0, endSec: durationSec, durationSec, overlapSec: 0, cut: 'end' }];
  }

  // 只保留有明确结束时间的静音段，并按开始时间排序
  const usable = (silences ?? [])
    .filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  const chunks = [];
  let cursor = 0;
  let index = 0;
  while (cursor < durationSec - 0.001) {
    const remaining = durationSec - cursor;
    if (remaining <= cfg.maxSec) {
      chunks.push({
        index,
        startSec: round3(cursor),
        endSec: round3(durationSec),
        durationSec: round3(remaining),
        overlapSec: 0,
        cut: 'end',
      });
      break;
    }

    const desired = cursor + cfg.targetSec;
    const low = cursor + Math.min(cfg.minSec, cfg.targetSec * 0.5);
    const high = Math.min(cursor + cfg.maxSec, durationSec);

    // 在 [low, high] 里找静音段，取中点离 desired 最近的那个
    let best = null;
    for (const silence of usable) {
      const mid = (silence.startSec + silence.endSec) / 2;
      if (mid < low) continue;
      if (mid > high) break;
      if (!best || Math.abs(mid - desired) < Math.abs(best - desired)) best = mid;
    }

    if (best !== null) {
      chunks.push({
        index,
        startSec: round3(cursor),
        endSec: round3(best),
        durationSec: round3(best - cursor),
        overlapSec: 0,
        cut: 'silence',
      });
      cursor = best;
    } else {
      // 没有可用静音：硬切，下一片回退 overlapSec 以减少截断
      const end = Math.min(desired, durationSec);
      chunks.push({
        index,
        startSec: round3(cursor),
        endSec: round3(end),
        durationSec: round3(end - cursor),
        overlapSec: cfg.overlapSec,
        cut: 'hard',
      });
      cursor = Math.max(end - cfg.overlapSec, cursor + 0.001);
    }
    index += 1;
  }
  return chunks;
}

/**
 * 合并各片转写：片内时间戳加上片起点偏移；硬切重叠处去重。
 * @param {Array<{startSec:number, segments:Array<{startMs:number,endMs:number|null,text:string}>}>} parts
 */
export function mergeTranscripts(parts) {
  const merged = [];
  for (const part of parts) {
    const offsetMs = Math.round(part.startSec * 1000);
    for (const segment of part.segments ?? []) {
      const startMs = Math.max(0, Math.round(segment.startMs ?? 0) + offsetMs);
      const endMs = segment.endMs === null || segment.endMs === undefined
        ? null
        : Math.round(segment.endMs) + offsetMs;
      merged.push({ startMs, endMs, text: segment.text ?? '' });
    }
  }
  merged.sort((a, b) => a.startMs - b.startMs);

  // 重叠去重：与上一条时间高度重叠且文本相同/包含 → 丢弃
  const out = [];
  for (const segment of merged) {
    const prev = out[out.length - 1];
    if (prev && isDuplicate(prev, segment)) {
      if (prev.endMs === null || (segment.endMs !== null && segment.endMs > prev.endMs)) prev.endMs = segment.endMs;
      continue;
    }
    out.push({ ...segment });
  }
  return out;
}

function isDuplicate(a, b) {
  const aText = squeeze(a.text);
  const bText = squeeze(b.text);
  if (!aText || !bText) return false;
  if (aText !== bText && !aText.includes(bText) && !bText.includes(aText)) return false;
  const aEnd = a.endMs ?? a.startMs;
  const bStart = b.startMs;
  // 时间上确实挨着（重叠或首尾相接）
  return bStart <= aEnd + 50;
}

function squeeze(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
