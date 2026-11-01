// src/media/transcript.js —— 字幕来源解析（契约 §8.5，视频与录音共用）
//
// 判定顺序（写死）：
//   1. transcriptFile（显式给出，读不了就报错，不静默回退）
//   2. 容器内嵌的字幕轨（第一条文本型轨，语言优先级 zh-Hans → zh-CN → zh → en-US → en → 轨序）
//   3. 同目录同名文件（a.mp4 → a.srt / a.vtt / a.ass / a.ssa，再 base.<lang>.<ext>）
// 三步都没有 → 返回 null（ASR 兜底由后端决定；video_subtitles 直接 NO_TRANSCRIPT）。

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { run } from './ffmpeg.js';
import { ToolError } from './interface.js';
import { parseSubtitles, readSubtitleFile, SUBTITLE_FORMATS } from './subtitles.js';

/** 文本型字幕编码（位图字幕轨无法解析成文字，跳过） */
const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

/** 语言优先级（契约 §8.5），未列出的语言排在后面、按字典序 */
export const LANGUAGE_PRIORITY = Object.freeze(['zh-Hans', 'zh-CN', 'zh', 'en-US', 'en']);

function languageRank(language) {
  if (!language) return LANGUAGE_PRIORITY.length + 1;
  const norm = String(language).trim().toLowerCase().replace('_', '-');
  const index = LANGUAGE_PRIORITY.findIndex((item) => item.toLowerCase() === norm);
  if (index >= 0) return index;
  // zh-Hant / zh-TW 之类的中文变体仍然优先于其它外语
  if (norm.startsWith('zh')) return LANGUAGE_PRIORITY.length;
  return LANGUAGE_PRIORITY.length + 1;
}

export function subtitleExtension(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  return SUBTITLE_FORMATS.includes(ext.slice(1)) ? ext : null;
}

/** 挑出真正能读成文字的字幕轨：先按语言优先级，再按轨序 */
export function pickSubtitleStream(streams = []) {
  const candidates = (streams ?? [])
    .filter((stream) => stream?.codec_type === 'subtitle')
    .filter((stream) => !BITMAP_SUBTITLE_CODECS.has(String(stream?.codec_name ?? '').toLowerCase()));
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map((stream, order) => ({
      stream,
      order,
      rank: languageRank(stream?.tags?.language),
    }))
    .sort((a, b) => (a.rank - b.rank) || (a.order - b.order));
  return ranked[0].stream;
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
 * 解析一个显式的 transcriptFile：路径与扩展名的错误按契约 §8.6 的文案抛出。
 * @returns {Promise<{origin:'file', format:string, sourcePath:string, language:null, segments:Array, warnings:string[]}>}
 */
export async function readExplicitTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    throw new ToolError('INVALID_ARGUMENT', 'transcriptFile must be a non-empty string.');
  }
  const ext = subtitleExtension(transcriptPath);
  if (!ext) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `transcriptFile must be one of .srt, .vtt, .ass, .ssa (got "${path.extname(transcriptPath) || '(none)'}").`,
    );
  }
  let parsed;
  try {
    parsed = await readSubtitleFile(transcriptPath);
  } catch (error) {
    if (error?.code === 'PATH_NOT_FOUND') {
      throw new ToolError('PATH_NOT_FOUND', `transcriptFile does not exist: "${transcriptPath}".`);
    }
    throw error;
  }
  return {
    origin: 'file',
    format: parsed.format,
    sourcePath: transcriptPath,
    language: null,
    segments: parsed.segments,
    warnings: [],
  };
}

/**
 * 按契约 §8.5 的顺序找字幕：transcriptFile → 内嵌轨 → 同目录同名文件。
 * 找到 → {origin, format, sourcePath, language, segments, warnings}；都没有 → null。
 *
 * @param {object} opts
 * @param {string} opts.mediaPath
 * @param {string} [opts.transcriptFile]
 * @param {Array<object>} [opts.streams] ffprobe 的 streams（用于找内嵌字幕轨）
 * @param {boolean} [opts.embedded=true] 是否尝试内嵌轨（纯音频文件通常没有）
 * @param {boolean} [opts.siblings=true] 是否尝试同目录同名文件
 * @param {AbortSignal} [opts.signal]
 */
export async function resolveSubtitleSource({
  mediaPath,
  transcriptFile,
  streams = [],
  embedded = true,
  siblings = true,
  signal,
  warnings = [],
} = {}) {
  if (transcriptFile !== undefined && transcriptFile !== null) {
    const explicit = await readExplicitTranscript(transcriptFile);
    warnings.push(...explicit.warnings);
    return explicit;
  }

  if (embedded) {
    const stream = pickSubtitleStream(streams);
    if (stream) {
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
        warnings.push('embedded-subtitle-empty');
      } catch (error) {
        warnings.push(`embedded-subtitle-unreadable: ${error?.message ?? error}`);
      }
    }
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
