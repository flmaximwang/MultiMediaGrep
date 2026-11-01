// src/media/subtitles.js —— 字幕文件解析
// 支持 SRT / WebVTT / ASS-SSA（上游 transcript-file.js 只支持 SRT + JSON，VTT 与 ASS 是本项目新写的）。
// 解析结果统一成 { startMs, endMs, text }，来源恒为 subtitle（作者提供，可当原话引用）。

import { readFile } from 'node:fs/promises';

import { ToolError } from './interface.js';

export const SUBTITLE_FORMATS = Object.freeze(['srt', 'vtt', 'ass', 'ssa']);

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
    .replace(/ /g, ' ')
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

/** SRT：块之间空行分隔 */
export function parseSrt(text) {
  const segments = [];
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
    const body = cleanSubtitleText(lines.slice(timeIdx + 1).join(' '));
    if (!body) continue;
    segments.push({ startMs, endMs, text: body });
  }
  return segments;
}

/** WebVTT：`WEBVTT` 头、NOTE/STYLE/REGION 块跳过、cue 可带标识行与设置 */
export function parseVtt(text) {
  const segments = [];
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
    const body = cleanSubtitleText(lines.slice(timeIdx + 1).join(' '));
    if (!body) continue;
    segments.push({ startMs, endMs, text: body });
  }
  return segments;
}

/** ASS/SSA：[Events] 里的 Dialogue 行，字段位置由 Format 行决定 */
export function parseAss(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const segments = [];
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
    const body = cleanSubtitleText(cols.slice(textIdx).join(','));
    if (!body) continue;
    segments.push({ startMs, endMs, text: body });
  }
  return segments.sort((a, b) => a.startMs - b.startMs);
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

/** 按格式解析；格式未知时按内容猜 */
export function parseSubtitles(text, { format = null } = {}) {
  const fmt = format ?? detectSubtitleFormat(text);
  if (fmt === 'srt') return parseSrt(text);
  if (fmt === 'vtt') return parseVtt(text);
  if (fmt === 'ass' || fmt === 'ssa') return parseAss(text);
  throw new ToolError(
    'TRANSCRIPT_UNREADABLE',
    'transcriptFile format is not recognized. Supported formats: .srt, .vtt, .ass, .ssa.',
    'Pass a subtitle file with one of those extensions.',
  );
}

/** 读本地字幕文件 → { format, segments }；解析不出内容 → TRANSCRIPT_UNREADABLE */
export async function readSubtitleFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new ToolError('PATH_NOT_FOUND', `transcriptFile does not exist or cannot be read: "${filePath}". (${err.code ?? err.message})`);
  }
  const format = detectSubtitleFormat(filePath) ?? detectSubtitleFormat(text);
  let segments;
  try {
    segments = parseSubtitles(text, { format });
  } catch (err) {
    throw new ToolError('TRANSCRIPT_UNREADABLE', err.message);
  }
  if (!segments || segments.length === 0) {
    throw new ToolError(
      'TRANSCRIPT_UNREADABLE',
      `transcriptFile parsed to zero subtitles: "${filePath}" (detected format: ${format ?? 'unknown'}).`,
      'Check that the file is a real subtitle file with timestamps (srt/vtt/ass/ssa).',
    );
  }
  return { path: filePath, format: format ?? 'unknown', segments };
}
