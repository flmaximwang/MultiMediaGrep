// src/media/chapters.js —— 容器内置章节（MP4 / MKV / M4B …）→ probe / overview 的目录
//
// ffprobe -show_chapters 的章节时间是 time_base 的整数刻度 + 秒字符串（start_time /
// end_time）。两者都可能有，优先用秒字符串（ffprobe 已经按容器时间戳换算好）；
// 只有刻度时用 time_base 换算。章节标题在 tags.title，缺失时给 "Chapter N"。
//
// server 不生成视频/录音目录（不调 LLM）：没有章节就是没有，调用方据此提示 agent
// 自己从 overview 的转写与分镜里写目录。

/** "1/1000" → 0.001；非法时 null */
export function parseTimeBase(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function secondsToMs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

/** 一个 ffprobe chapter → {title, startMs, endMs, startSec, endSec}；时间不可用时返回 null */
function normalizeChapter(chapter, index) {
  if (!chapter || typeof chapter !== 'object') return null;
  const timeBase = parseTimeBase(chapter.time_base);
  let startMs = null;
  let endMs = null;
  if (chapter.start_time !== undefined && chapter.start_time !== null && chapter.start_time !== '') {
    startMs = secondsToMs(chapter.start_time);
  } else if (timeBase !== null && Number.isFinite(Number(chapter.start))) {
    startMs = Math.round(Number(chapter.start) * timeBase * 1000);
  }
  if (chapter.end_time !== undefined && chapter.end_time !== null && chapter.end_time !== '') {
    endMs = secondsToMs(chapter.end_time);
  } else if (timeBase !== null && Number.isFinite(Number(chapter.end))) {
    endMs = Math.round(Number(chapter.end) * timeBase * 1000);
  }
  if (startMs === null || startMs < 0) return null;
  if (endMs !== null && endMs < startMs) endMs = null;
  const title = String(chapter.tags?.title ?? '').trim() || `Chapter ${index + 1}`;
  return {
    title,
    startMs,
    endMs,
    startSec: startMs / 1000,
    endSec: endMs === null ? null : endMs / 1000,
  };
}

/**
 * ffprobe JSON → 章节清单（按 ffprobe 顺序，不排序：章节本来就有序）。
 * @param {object|null} info ffprobe -print_format json 的输出
 * @returns {Array<{title: string, startMs: number, endMs: number|null, startSec: number, endSec: number|null}>}
 */
export function chaptersFromProbe(info) {
  const raw = Array.isArray(info?.chapters) ? info.chapters : [];
  return raw.map(normalizeChapter).filter(Boolean);
}

/**
 * probe 的 outline 字段（video / audio）。
 *
 * 没有章节时 available=false 且 reason 是人话；有章节时 entries 是完整目录
 * （probe 文本只展示前 60 条，完整目录进 structuredContent 与 manifest.json）。
 */
export function chaptersToOutline(info) {
  const entries = chaptersFromProbe(info);
  if (entries.length === 0) {
    return {
      available: false,
      source: null,
      total: 0,
      entries: [],
      reason: 'this file has no chapters (no chapter metadata in the container).',
    };
  }
  return {
    available: true,
    source: 'chapters',
    total: entries.length,
    entries,
    reason: null,
  };
}
