// src/media/subtitles.js —— 字幕文件解析
// 支持 SRT / WebVTT / ASS-SSA（上游 transcript-file.js 只支持 SRT + JSON，VTT 与 ASS 是本项目新写的）。
// 解析结果统一成 { startMs, endMs, text }；来源恒为 subtitle —— 字幕来自字幕文件或容器内嵌轨，
// 通常是作者自己的话，但也可能是机器自动生成的（自动字幕），专有名词与数字要自己核对画面。
//
// 滚动式字幕（cue 之间时间重叠、首行与上一条的末行重复）在这里合并：
// 见 mergeRollingCues() 与 subtitleOverlapRatio()。

import { readFile } from 'node:fs/promises';

import { ToolError } from './interface.js';

export const SUBTITLE_FORMATS = Object.freeze(['srt', 'vtt', 'ass', 'ssa']);

/**
 * 滚动/自动样式字幕的警告文案（契约 §2.5 / §8.5）。
 * 重叠比例超过阈值时，overview 与 locate 都要把这句话带给 agent。
 */
export const ROLLING_SUBTITLE_WARNING = 'rolling/auto-style captions detected — treat like ASR: check names and numbers against the frame.';

/** 重叠 cue 比例超过这个值就算「滚动/自动样式字幕」 */
export const ROLLING_OVERLAP_RATIO_THRESHOLD = 0.3;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** 清掉标记：VTT/HTML 标签、ASS 覆盖码、实体 */
export function cleanSubtitleText(text) {
  return String(text ?? '')
    .replace(/\{\\[^}]*\}/g, '')            // ASS 覆盖码 {\pos(...)}
    .replace(/<[^>]*>/g, '')                // VTT/HTML 标签与时间戳标签
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name) => {
      if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      return ENTITIES[name.toLowerCase()] ?? m;
    })
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function clockToMs(clock) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(String(clock).trim());
  if (!m) return null;
  const h = m[1] === undefined ? 0 : Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const fracRaw = m[4];
  const ms = Number(fracRaw.padEnd(3, '0'));
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/** ASS 的时间：H:MM:SS.cc（百分之一秒） */
function assClockToMs(clock) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,2})$/.exec(String(clock).trim());
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(2, '0')) * 10;
}

export function detectSubtitleFormat(textOrName) {
  const s = String(textOrName ?? '');
  const lower = s.toLowerCase();
  if (lower.endsWith('.vtt')) return 'vtt';
  if (lower.endsWith('.ass')) return 'ass';
  if (lower.endsWith('.ssa')) return 'ssa';
  if (lower.endsWith('.srt')) return 'srt';
  if (/^\s*WEBVTT/.test(s)) return 'vtt';
  if (/\[Script Info\]/i.test(s) && /\[Events\]/i.test(s)) {
    return /^Format:\s*Layer/m.test(s) ? 'ass' : 'ssa';
  }
  if (/-->/m.test(s)) return 'srt';
  return null;
}

/* ------------------------------------------------------------------ *
 * 滚动字幕：合并与重叠检测
 *
 * cue 的中间形态是 { startMs, endMs, lines } —— 行结构要留着，
 * 因为「当前 cue 的首行 = 上一条的末行」这种重复只有按行才看得出来。
 * ------------------------------------------------------------------ */

/** 按 startMs 排序（start 相同则 end 短的在前），稳定 */
function sortCues(cues) {
  return [...cues].sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs));
}

/** 两条 cue 是否时间重叠（端点相接不算重叠） */
function cuesOverlap(a, b) {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

function cueText(cue) {
  return cue.lines.join(' ').trim();
}

/**
 * 重叠 cue 比例 = 与别的 cue 时间重叠的 cue 数 / cue 总数。
 * 人工字幕（一条压一条，不重叠）得到 0；滚动式字幕（大量重叠）接近 1。
 *
 * @param {Array<{startMs:number,endMs:number}>} cues
 * @returns {number} 0–1
 */
export function subtitleOverlapRatio(cues) {
  const sorted = sortCues(cues ?? []);
  const total = sorted.length;
  if (total === 0) return 0;

  // 与更早的 cue 重叠 ⟺ 前面存在某条 endMs > 本条 startMs
  const maxEndBefore = new Array(total).fill(-Infinity);
  let maxEnd = -Infinity;
  for (let i = 0; i < total; i += 1) {
    maxEndBefore[i] = maxEnd;
    maxEnd = Math.max(maxEnd, sorted[i].endMs);
  }
  // 与更晚的 cue 重叠 ⟺ 后面存在某条 startMs < 本条 endMs
  // （minStartAfter[i] = 下标大于 i 的所有 cue 的最小 startMs）
  const minStartAfter = new Array(total).fill(Infinity);
  let minStart = Infinity;
  for (let i = total - 1; i >= 0; i -= 1) {
    minStartAfter[i] = minStart;
    minStart = Math.min(minStart, sorted[i].startMs);
  }

  let overlapping = 0;
  for (let i = 0; i < total; i += 1) {
    const overlapsEarlier = maxEndBefore[i] > sorted[i].startMs;
    const overlapsLater = minStartAfter[i] < sorted[i].endMs;
    if (overlapsEarlier || overlapsLater) overlapping += 1;
  }
  return overlapping / total;
}

/**
 * 合并滚动式字幕（设计见 9z5.26）：
 *   1. 当前 cue 的首行 == 上一条 cue 的末行 → 丢掉这行重复；
 *   2. 时间重叠且正文相同（或去重后为空）的 cue 合并成一条；
 *   3. 合并后的时间跨度 = 参与合并的所有 cue 里最早的 start → 最晚的 end。
 * 人工字幕（不重叠、不重复）原样通过。
 *
 * @param {Array<{startMs:number,endMs:number,lines:string[]}>} cues
 * @returns {Array<{startMs:number,endMs:number,lines:string[]}>}
 */
export function mergeRollingCues(cues) {
  const merged = [];
  for (const cue of sortCues(cues ?? [])) {
    const lines = [...(cue.lines ?? [])];
    const prev = merged[merged.length - 1];
    if (prev) {
      const prevLast = prev.lines[prev.lines.length - 1];
      if (prevLast !== undefined && lines.length > 0 && lines[0] === prevLast) {
        lines.shift();
      }
    }
    const text = lines.join(' ').trim();
    if (prev) {
      const prevText = cueText(prev);
      if (cuesOverlap(prev, cue) && (text === '' || text === prevText)) {
        prev.startMs = Math.min(prev.startMs, cue.startMs);
        prev.endMs = Math.max(prev.endMs, cue.endMs);
        continue;
      }
      // 去重后正文为空 → 这条 cue 没有内容可读，丢掉
      if (text === '') continue;
    } else if (text === '') {
      continue;
    }
    merged.push({ startMs: cue.startMs, endMs: cue.endMs, lines });
  }
  return merged;
}

/** cue → segment（对外的统一形态） */
function cuesToSegments(cues) {
  return cues.map((cue) => ({
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.lines.join(' ').trim(),
  }));
}

/* ------------------------------------------------------------------ *
 * 各格式解析：先出 cue（含行），再统一走合并
 * ------------------------------------------------------------------ */

/** SRT：块之间空行分隔 */
function parseSrtCues(text) {
  const cues = [];
  const blocks = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const m = /^\s*(\S+)\s*-->\s*(\S+)/.exec(lines[timeIdx]);
    if (!m) continue;
    const startMs = clockToMs(m[1]);
    const endMs = clockToMs(m[2]);
    if (startMs === null || endMs === null) continue;
    const body = lines.slice(timeIdx + 1).map((l) => cleanSubtitleText(l)).filter((l) => l !== '');
    if (body.length === 0) continue;
    cues.push({ startMs, endMs, lines: body });
  }
  return cues;
}

/** WebVTT：`WEBVTT` 头、NOTE/STYLE/REGION 块跳过、cue 可带标识行与设置 */
function parseVttCues(text) {
  const cues = [];
  const blocks = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(trimmed)) continue;
    const lines = trimmed.split('\n');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    // 时间行可能带 cue settings：00:00:01.000 --> 00:00:04.000 align:start position:10%
    const m = /^\s*(\d{1,2}(?::\d{1,2}){1,2}[.,]\d{1,3})\s*-->\s*(\d{1,2}(?::\d{1,2}){1,2}[.,]\d{1,3})/.exec(lines[timeIdx]);
    if (!m) continue;
    const startMs = clockToMs(m[1]);
    const endMs = clockToMs(m[2]);
    if (startMs === null || endMs === null) continue;
    const body = lines.slice(timeIdx + 1).map((l) => cleanSubtitleText(l)).filter((l) => l !== '');
    if (body.length === 0) continue;
    cues.push({ startMs, endMs, lines: body });
  }
  return cues;
}

/** ASS/SSA：[Events] 里的 Dialogue 行，字段位置由 Format 行决定 */
function parseAssCues(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  let inEvents = false;
  let fields = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[Events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\[/.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    const formatLine = /^Format:\s*(.+)$/i.exec(line);
    if (formatLine) {
      fields = formatLine[1].split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    const dialogue = /^Dialogue:\s*(.+)$/i.exec(line);
    if (!dialogue) continue;
    const cols = splitAssFields(dialogue[1], fields?.length ?? 10);
    if (!fields) continue;
    const startIdx = fields.indexOf('start');
    const endIdx = fields.indexOf('end');
    const textIdx = fields.indexOf('text');
    if (startIdx === -1 || endIdx === -1 || textIdx === -1) continue;
    const startMs = assClockToMs(cols[startIdx]);
    const endMs = assClockToMs(cols[endIdx]);
    if (startMs === null || endMs === null) continue;
    // ASS 的硬换行是 \N / \n；滚动式字幕常靠它分行，去重要按行看
    const body = cols.slice(textIdx).join(',')
      .split(/\\N|\\n/)
      .map((l) => cleanSubtitleText(l))
      .filter((l) => l !== '');
    if (body.length === 0) continue;
    cues.push({ startMs, endMs, lines: body });
  }
  return cues;
}

/** Dialogue 行按逗号切，但 Text 是最后一个字段（可能自己含逗号） */
function splitAssFields(body, fieldCount) {
  const cols = [];
  let rest = body;
  for (let i = 0; i < fieldCount - 1; i += 1) {
    const comma = rest.indexOf(',');
    if (comma === -1) break;
    cols.push(rest.slice(0, comma).trim());
    rest = rest.slice(comma + 1);
  }
  cols.push(rest);
  return cols;
}

export function parseSrt(text) {
  return cuesToSegments(mergeRollingCues(parseSrtCues(text)));
}

export function parseVtt(text) {
  return cuesToSegments(mergeRollingCues(parseVttCues(text)));
}

export function parseAss(text) {
  return cuesToSegments(mergeRollingCues(parseAssCues(text)));
}

/**
 * 解析字幕 → { segments, overlapRatio }
 * overlapRatio 是「与别的 cue 时间重叠的 cue 占比」，用来判断是不是滚动/自动样式字幕。
 */
export function parseSubtitleDocument(text, { format = null } = {}) {
  const fmt = format ?? detectSubtitleFormat(text);
  let cues;
  if (fmt === 'srt') cues = parseSrtCues(text);
  else if (fmt === 'vtt') cues = parseVttCues(text);
  else if (fmt === 'ass' || fmt === 'ssa') cues = parseAssCues(text);
  else {
    throw new ToolError(
      'TRANSCRIPT_UNREADABLE',
      'subtitle format is not recognized. Supported formats: .srt, .vtt, .ass, .ssa.',
      'Pass a subtitle file with one of those extensions.',
    );
  }
  return {
    segments: cuesToSegments(mergeRollingCues(cues)),
    overlapRatio: subtitleOverlapRatio(cues),
  };
}

/** 按格式解析；格式未知时按内容猜 */
export function parseSubtitles(text, { format = null } = {}) {
  return parseSubtitleDocument(text, { format }).segments;
}

/** 读本地字幕文件 → { format, segments, overlapRatio }；解析不出内容 → TRANSCRIPT_UNREADABLE */
export async function readSubtitleFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new ToolError('PATH_NOT_FOUND', `subtitle file does not exist or cannot be read: "${filePath}". (${err.code ?? err.message})`);
  }
  const format = detectSubtitleFormat(filePath) ?? detectSubtitleFormat(text);
  let parsed;
  try {
    parsed = parseSubtitleDocument(text, { format });
  } catch (err) {
    throw new ToolError('TRANSCRIPT_UNREADABLE', err.message);
  }
  const segments = parsed.segments;
  if (!segments || segments.length === 0) {
    throw new ToolError(
      'TRANSCRIPT_UNREADABLE',
      `subtitle file parsed to zero subtitles: "${filePath}" (detected format: ${format ?? 'unknown'}).`,
      'Check that the file is a real subtitle file with timestamps (srt/vtt/ass/ssa).',
    );
  }
  return { path: filePath, format: format ?? 'unknown', segments, overlapRatio: parsed.overlapRatio };
}
