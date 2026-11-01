// src/media/transcript.js —— 字幕来源解析（契约 §8.5，视频与录音共用）
//
// 显式选择（subtitle，一个参数三种形态）：
//   绝对路径 → 本地字幕文件；非负整数 → ffprobe 流 index；其他字符串 → 语言码（tags.language）。
//   显式选择是排他的：只按它来，不可用就抛 INVALID_ARGUMENT，绝不静默回退。
//
// 未显式选择时的判定顺序（写死）：
//   1. 容器内嵌的字幕轨（第一条文本型轨，语言优先级 zh-Hans → zh-CN → zh → en-US → en → 轨序）
//   2. 同目录同名文件（a.mp4 → a.srt / a.vtt / a.ass / a.ssa，再 base.<lang>.<ext>）
// 两步都没有 → 返回 null（ASR 兜底由后端决定；video_subtitles 直接 NO_TRANSCRIPT）。

import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { run } from './ffmpeg.js';
import { ToolError } from './interface.js';
import { parseSubtitles, readSubtitleFile, SUBTITLE_FORMATS } from './subtitles.js';

/** 文本型字幕编码（位图字幕轨无法解析成文字，跳过） */
const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

/** 语言优先级（契约 §8.5），未列出的语言排在后面、按字典序 */
export const LANGUAGE_PRIORITY = Object.freeze(['zh-Hans', 'zh-CN', 'zh', 'en-US', 'en']);

/** 语言码的常见别名（ISO 639-1 ↔ ISO 639-2），值统一到主语言子标签 */
const LANGUAGE_ALIASES = new Map([
  ['zh', 'zh'], ['zho', 'zh'], ['chi', 'zh'],
  ['en', 'en'], ['eng', 'en'],
  ['ja', 'ja'], ['jpn', 'ja'],
  ['ko', 'ko'], ['kor', 'ko'],
  ['fr', 'fr'], ['fre', 'fr'], ['fra', 'fr'],
  ['de', 'de'], ['ger', 'de'], ['deu', 'de'],
  ['es', 'es'], ['spa', 'es'],
  ['ru', 'ru'], ['rus', 'ru'],
  ['it', 'it'], ['ita', 'it'],
  ['pt', 'pt'], ['por', 'pt'],
  ['ar', 'ar'], ['ara', 'ar'],
  ['hi', 'hi'], ['hin', 'hi'],
]);

function languageRank(language) {
  if (!language) return LANGUAGE_PRIORITY.length + 1;
  const norm = String(language).trim().toLowerCase().replace('_', '-');
  const index = LANGUAGE_PRIORITY.findIndex((item) => item.toLowerCase() === norm);
  if (index >= 0) return index;
  // zh-Hant / zh-TW 之类的中文变体仍然优先于其它外语
  if (norm.startsWith('zh')) return LANGUAGE_PRIORITY.length;
  return LANGUAGE_PRIORITY.length + 1;
}

/** 语言标签归一：小写、下划线换连字符，只保留主语言子标签并套用别名表 */
function languageKey(language) {
  const norm = String(language ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!norm) return '';
  const primary = norm.split('-')[0];
  return LANGUAGE_ALIASES.get(primary) ?? primary;
}

/** 显式语言码是否命中某条轨的 tags.language（大小写不敏感；zh ≈ chi/zho、en ≈ eng） */
export function subtitleLanguageMatches(streamLanguage, language) {
  const wanted = languageKey(language);
  return wanted !== '' && wanted === languageKey(streamLanguage);
}

export function subtitleExtension(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  return SUBTITLE_FORMATS.includes(ext.slice(1)) ? ext : null;
}

/**
 * 拆开字幕轨：挑出真正能读成文字的那一条（先按语言优先级，再按轨序），
 * 同时把因是位图而被跳过的轨记录下来——「有字幕但没用上」要能对 agent 交代。
 *
 * @returns {{stream: object|null, bitmapSkipped: Array<{index: number|null, codec: string}>}}
 */
export function analyzeSubtitleStreams(streams = []) {
  const bitmapSkipped = [];
  const candidates = [];
  for (const stream of (streams ?? []).filter((item) => item?.codec_type === 'subtitle')) {
    const codec = String(stream?.codec_name ?? '').toLowerCase();
    if (BITMAP_SUBTITLE_CODECS.has(codec)) {
      bitmapSkipped.push({ index: stream?.index ?? null, codec: codec || 'unknown' });
    } else {
      candidates.push(stream);
    }
  }
  const ranked = candidates
    .map((stream, order) => ({
      stream,
      order,
      rank: languageRank(stream?.tags?.language),
    }))
    .sort((a, b) => (a.rank - b.rank) || (a.order - b.order));
  return { stream: ranked[0]?.stream ?? null, bitmapSkipped };
}

/** 挑出真正能读成文字的字幕轨：先按语言优先级，再按轨序 */
export function pickSubtitleStream(streams = []) {
  return analyzeSubtitleStreams(streams).stream;
}

/** 位图字幕被跳过时的 warning 文案（契约 §8.5；带 codec 与轨道号） */
export function bitmapSkippedWarnings(bitmapSkipped = []) {
  return bitmapSkipped.map(
    ({ index, codec }) => `embedded-subtitle-bitmap-skipped (${codec}, track ${index ?? '?'})`,
  );
}

function trackIndex(stream, fallback = '?') {
  return Number.isInteger(stream?.index) ? stream.index : fallback;
}

function subtitleTrackSummary(streams = []) {
  const tracks = (streams ?? []).filter((stream) => stream?.codec_type === 'subtitle');
  if (tracks.length === 0) return 'no subtitle tracks';
  return `subtitle tracks: ${tracks
    .map((stream) => `${stream?.tags?.language ?? 'unknown'} (track ${trackIndex(stream)})`)
    .join(', ')}`;
}

/**
 * 判定 subtitle 的形态（契约 §8.5）：文件路径 / 轨道 index / 语言码。
 * 只做字符串形态判断，不碰文件系统。
 *
 * @returns {{kind:'file', path:string} | {kind:'index', value:number} | {kind:'language', value:string}}
 */
export function classifySubtitleSelection(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `subtitle track index must be a non-negative integer (got ${JSON.stringify(value)}).`,
      );
    }
    return { kind: 'index', value };
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(
      'INVALID_ARGUMENT',
      'subtitle must be a local subtitle file path, a non-negative track index, or a language code '
        + `(got ${JSON.stringify(value ?? null)}).`,
    );
  }
  const raw = value.trim();
  // 绝对路径，或任何带路径分隔符 / 字幕扩展名的字符串，都按「文件」解释
  if (path.isAbsolute(raw) || raw.includes('/') || raw.includes('\\') || subtitleExtension(raw)) {
    return { kind: 'file', path: raw };
  }
  if (/^[+-]?\d+$/.test(raw)) {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `subtitle track index must be a non-negative integer (got "${raw}").`,
      );
    }
    return { kind: 'index', value: index };
  }
  return { kind: 'language', value: raw };
}

/** 位图字幕轨不能读成文字：错误文案沿用 §8.5 的 bitmap warning 形态 */
function assertTextSubtitleStream(stream) {
  const codec = String(stream?.codec_name ?? '').toLowerCase();
  if (!BITMAP_SUBTITLE_CODECS.has(codec)) return;
  throw new ToolError(
    'INVALID_ARGUMENT',
    `subtitle track ${trackIndex(stream)} is a bitmap subtitle track and cannot be read as text: `
      + `embedded-subtitle-bitmap-skipped (${codec || 'unknown'}, track ${trackIndex(stream)}).`,
    'Pick a text subtitle track, a local subtitle file, or omit subtitle to use automatic selection.',
  );
}

/**
 * 解析显式 subtitle 选中的轨（文件只返回路径，不读内容）。
 * 轨道 index / 语言码不可用 → INVALID_ARGUMENT，绝不回退。
 *
 * @returns {{kind:'file', path:string, stream:null, language:null, warnings:string[]}
 *   | {kind:'embedded', stream:object, language:string|null, warnings:string[]}}
 */
export function inspectSubtitleSelection({ subtitle, streams = [] } = {}) {
  const selection = classifySubtitleSelection(subtitle);
  const allStreams = streams ?? [];

  if (selection.kind === 'file') {
    return { kind: 'file', path: selection.path, stream: null, language: null, warnings: [] };
  }

  if (selection.kind === 'index') {
    const stream = allStreams.find((item) => item?.index === selection.value);
    if (!stream) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `subtitle track index ${selection.value} does not exist in this file (${subtitleTrackSummary(allStreams)}).`,
        'Pass an index from subtitleTracks, a local subtitle file path, or a language code.',
      );
    }
    if (stream.codec_type !== 'subtitle') {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `subtitle track index ${selection.value} is not a subtitle track (it is a ${stream.codec_type ?? 'unknown'} track).`,
      );
    }
    assertTextSubtitleStream(stream);
    return { kind: 'embedded', stream, language: stream?.tags?.language ?? null, warnings: [] };
  }

  const matches = [];
  const bitmapMatches = [];
  for (const [order, stream] of allStreams.entries()) {
    if (stream?.codec_type !== 'subtitle') continue;
    if (!subtitleLanguageMatches(stream?.tags?.language, selection.value)) continue;
    if (BITMAP_SUBTITLE_CODECS.has(String(stream?.codec_name ?? '').toLowerCase())) {
      bitmapMatches.push({ index: stream?.index ?? null, codec: String(stream?.codec_name ?? '').toLowerCase() || 'unknown' });
    } else {
      matches.push({ stream, order });
    }
  }

  if (matches.length === 0) {
    const bitmapNote = bitmapMatches.length > 0
      ? ` Bitmap subtitle tracks cannot be read as text: ${bitmapSkippedWarnings(bitmapMatches).join('; ')}.`
      : '';
    throw new ToolError(
      'INVALID_ARGUMENT',
      `no subtitle track matches language "${selection.value}" (${subtitleTrackSummary(allStreams)}).${bitmapNote}`,
      'Pass a subtitle file path, a track index, or omit subtitle to use automatic selection.',
    );
  }

  // 多条命中取文件中靠前的一条，其余写进 warnings（契约 §8.5）
  matches.sort((a, b) => (trackIndex(a.stream, a.order) - trackIndex(b.stream, b.order)) || (a.order - b.order));
  const chosen = matches[0].stream;
  const warnings = matches.length > 1
    ? [`subtitle-language-multiple-matches (language "${selection.value}": `
      + `tracks ${matches.map(({ stream, order }) => trackIndex(stream, order)).join(', ')}; `
      + `using track ${trackIndex(chosen)})`]
    : [];
  return { kind: 'embedded', stream: chosen, language: chosen?.tags?.language ?? null, warnings };
}

/** 文件路径的形态校验（契约 §2.4 的路径规则 + 字幕扩展名） */
function assertSubtitleFileShape(filePath) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath) || filePath.startsWith('//')) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `subtitle file must be a local absolute file path; URLs are not accepted ("${filePath}"). `
        + 'This server never downloads anything — fetch the file first, then pass its local path.',
      'Pass a bare absolute path such as "/abs/path/a.srt".',
    );
  }
  if (!path.isAbsolute(filePath)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `subtitle file must be an absolute local path; got "${filePath}". Use an absolute path such as "/abs/path/a.srt".`,
    );
  }
  if (!subtitleExtension(filePath)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `subtitle file must be one of .srt, .vtt, .ass, .ssa (got "${path.extname(filePath) || '(none)'}").`,
      'Pass a local subtitle file path, e.g. "/abs/a.zh.srt".',
    );
  }
}

/** 文件存在、是普通文件、可读；不可用 → INVALID_ARGUMENT（显式选择不回退） */
async function checkSubtitleFileUsable(filePath) {
  assertSubtitleFileShape(filePath);
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new ToolError('INVALID_ARGUMENT', `subtitle file does not exist: "${filePath}".`);
  }
  if (!info.isFile()) {
    throw new ToolError('INVALID_ARGUMENT', `subtitle file is not a regular file: "${filePath}".`);
  }
  try {
    await access(filePath, constants.R_OK);
  } catch (error) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `subtitle file cannot be read: "${filePath}" (${error?.code ?? error?.message ?? 'unknown'}).`,
    );
  }
}

/** 读显式字幕文件并解析；任何不可用都归为 INVALID_ARGUMENT */
async function readExplicitSubtitleFile(filePath) {
  await checkSubtitleFileUsable(filePath);
  let parsed;
  try {
    parsed = await readSubtitleFile(filePath);
  } catch (error) {
    if (error instanceof ToolError && error.code === 'TRANSCRIPT_UNREADABLE') {
      throw new ToolError('INVALID_ARGUMENT', `no subtitle cue could be parsed from "${filePath}".`, error.hint);
    }
    if (error instanceof ToolError && error.code === 'PATH_NOT_FOUND') {
      throw new ToolError('INVALID_ARGUMENT', `subtitle file cannot be read: "${filePath}".`);
    }
    throw error;
  }
  return {
    origin: 'file',
    format: parsed.format,
    sourcePath: filePath,
    language: null,
    segments: parsed.segments,
    warnings: [],
  };
}

/**
 * probe 用的非抛错描述：显式 subtitle 可用 → 返回来源；不可用 → `error` 里给出原因。
 * probe 只报告、不解析内容，也不借用其它来源冒充显式选择（契约 §4.5）。
 *
 * @returns {Promise<{origin:'file'|'embedded', sourcePath:string|null, language:string|null,
 *   warnings:string[], error:string|null} | null>}
 */
export async function describeSubtitleSelection({ subtitle, streams = [] } = {}) {
  if (subtitle === undefined || subtitle === null) return null;
  try {
    const selection = inspectSubtitleSelection({ subtitle, streams });
    if (selection.kind === 'file') {
      await checkSubtitleFileUsable(selection.path);
      return { origin: 'file', sourcePath: selection.path, language: null, warnings: [], error: null };
    }
    return {
      origin: 'embedded',
      sourcePath: null,
      language: selection.language,
      warnings: selection.warnings,
      error: null,
    };
  } catch (error) {
    if (error instanceof ToolError) {
      return { origin: null, sourcePath: null, language: null, warnings: [], error: error.message };
    }
    throw error;
  }
}

/** 把内嵌字幕轨抽成 SRT 文本（ffmpeg 的 srt muxer 直接输出到 stdout） */
export async function extractEmbeddedSubtitle(mediaPath, streamIndex, { signal } = {}) {
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-i', mediaPath, '-map', `0:${streamIndex}`, '-f', 'srt', 'pipe:1'],
    { signal, timeoutMs: 120_000 },
  );
  return stdout;
}

/**
 * 同目录同名自动发现（契约 §8.5 的「不向上、不向旁」）。
 * 返回按优先级排好的候选：精确同名 → 语言后缀（语言优先级 → 扩展名顺序 → 字典序）。
 *
 * @returns {Promise<Array<{path:string, format:'srt'|'vtt'|'ass'|'ssa', language:string|null, exact:boolean}>>}
 */
export async function discoverSiblingSubtitles(mediaPath) {
  const dir = path.dirname(mediaPath);
  const base = path.basename(mediaPath, path.extname(mediaPath));
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const byLower = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
  const candidates = [];

  // 精确同名：a.mp4 → a.srt / a.vtt / a.ass / a.ssa
  for (const format of SUBTITLE_FORMATS) {
    const actual = byLower.get(`${base}.${format}`.toLowerCase());
    if (actual) candidates.push({ path: path.join(dir, actual), format, language: null, exact: true });
  }

  // 带语言后缀：a.zh-Hans.srt / a.en.vtt …
  const suffix = new RegExp(`^${escapeRegExp(base)}\\.(.+)\\.(${SUBTITLE_FORMATS.join('|')})$`, 'i');
  const suffixed = [];
  for (const entry of entries) {
    const match = suffix.exec(entry);
    if (!match) continue;
    const language = match[1];
    const format = match[2].toLowerCase();
    suffixed.push({
      path: path.join(dir, entry),
      format,
      language,
      exact: false,
      rank: languageRank(language),
      formatRank: SUBTITLE_FORMATS.indexOf(format),
    });
  }
  suffixed.sort((a, b) => (a.rank - b.rank)
    || (a.formatRank - b.formatRank)
    || a.path.localeCompare(b.path));
  for (const entry of suffixed) {
    if (candidates.some((candidate) => candidate.path === entry.path)) continue;
    candidates.push(entry);
  }
  return candidates;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按契约 §8.5 找字幕。
 * 显式 subtitle → 只按它（不可用就抛 INVALID_ARGUMENT，不回退）；
 * 未给 → 内嵌轨 → 同目录同名文件。找到 → {origin, format, sourcePath, language, segments, warnings}；都没有 → null。
 *
 * @param {object} opts
 * @param {string} opts.mediaPath
 * @param {string|number} [opts.subtitle] 显式选择：文件绝对路径 / 非负 track index / 语言码
 * @param {Array<object>} [opts.streams] ffprobe 的 streams（用于找内嵌字幕轨）
 * @param {boolean} [opts.embedded=true] 是否尝试内嵌轨（纯音频文件通常没有）
 * @param {boolean} [opts.siblings=true] 是否尝试同目录同名文件
 * @param {AbortSignal} [opts.signal]
 */
export async function resolveSubtitleSource({
  mediaPath,
  subtitle,
  streams = [],
  embedded = true,
  siblings = true,
  signal,
  warnings = [],
} = {}) {
  if (subtitle !== undefined && subtitle !== null) {
    const selection = inspectSubtitleSelection({ subtitle, streams });
    if (selection.kind === 'file') {
      const explicit = await readExplicitSubtitleFile(selection.path);
      warnings.push(...explicit.warnings);
      return explicit;
    }

    const streamIndex = selection.stream?.index;
    if (streamIndex === undefined || streamIndex === null) {
      throw new ToolError('INVALID_ARGUMENT', 'subtitle track has no stream index; pass a subtitle file or a language code instead.');
    }
    const track = streamIndex;
    let text;
    try {
      text = await extractEmbeddedSubtitle(mediaPath, streamIndex, { signal });
    } catch (error) {
      throw new ToolError('INVALID_ARGUMENT', `subtitle track ${track} could not be read: ${error?.message ?? error}.`);
    }
    let segments;
    try {
      segments = parseSubtitles(text, { format: 'srt' });
    } catch (error) {
      throw new ToolError('INVALID_ARGUMENT', `subtitle track ${track} could not be parsed: ${error?.message ?? error}.`);
    }
    if (segments.length === 0) {
      throw new ToolError('INVALID_ARGUMENT', `subtitle track ${track} contains no subtitle cues.`);
    }
    warnings.push(...selection.warnings);
    return {
      origin: 'embedded',
      format: 'embedded',
      sourcePath: null,
      language: selection.language,
      segments,
      warnings,
    };
  }

  if (embedded) {
    const analysis = analyzeSubtitleStreams(streams);
    const stream = analysis.stream;
    if (stream) {
      const track = stream.index ?? '?';
      try {
        const text = await extractEmbeddedSubtitle(mediaPath, stream.index, { signal });
        const segments = parseSubtitles(text, { format: 'srt' });
        if (segments.length > 0) {
          return {
            origin: 'embedded',
            format: 'embedded',
            sourcePath: null,
            language: stream?.tags?.language ?? null,
            segments,
            warnings,
          };
        }
        warnings.push(`embedded-subtitle-empty (track ${track})`);
      } catch (error) {
        warnings.push(`embedded-subtitle-unreadable (track ${track}): ${error?.message ?? error}`);
      }
    }
    // 没有任何文本轨被用上（或文本轨读不出来）时，把被跳过的位图轨也交代清楚
    warnings.push(...bitmapSkippedWarnings(analysis.bitmapSkipped));
  }

  if (siblings) {
    for (const candidate of await discoverSiblingSubtitles(mediaPath)) {
      try {
        const parsed = await readSubtitleFile(candidate.path);
        return {
          origin: 'file',
          format: parsed.format,
          sourcePath: candidate.path,
          language: candidate.language,
          segments: parsed.segments,
          warnings,
        };
      } catch (error) {
        warnings.push(`sibling-subtitle-unreadable: ${candidate.path}: ${error?.message ?? error}`);
      }
    }
  }

  return null;
}

/**
 * 给 media_overview / media_locate 的「没有转写」说明用：
 * 区分「真的没有字幕来源」与「有字幕但读不出来」。
 */
export function subtitleWarnings(source) {
  return source?.warnings ?? [];
}
