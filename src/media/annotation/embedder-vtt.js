// src/media/annotation/embedder-vtt.js —— 视频/录音批注嵌入器（VTT 投影）
//
// 批注的真相源是同目录的 `.mmgrep.annotation.json` sidecar；本嵌入器额外把批注
// 投影成 `<dir>/<full basename>.mmgrep.annotation.vtt`，让 ffmpeg / 播放器直接看到批注：
//   - cue identifier = 批注 id（n1…），cue 正文 = note；
//   - 多行 note 在 cue 里保持多行；note 里的空行换成「只含一个空格的行」
//     （VTT 里空行会结束 cue，留空会把 note 截断；只含空格的行不是空行，cue 因此继续，
//      读侧也能把它还原成空行）；
//   - 允许时间重叠；缺省 end = start + 5 s（截到媒体时长；时长未知时不截断，
//     因为引擎写进 sidecar 的也是不截断的 start + 5 s，两者必须一致）；
//   - 时间戳 `HH:MM:SS.mmm`；UTF-8 无 BOM、LF、`WEBVTT` 头；
//   - note 是纯文本：只做 VTT 实体转义（`& < >`，`-->` 因此被中和成 `--&gt;`），
//     换行保持换行；任何空行都不会出现在 cue 里（空行会结束 cue）；
//   - **绝不修改媒体文件**：embed 前后比较 size + mtime，作为 media-unchanged 检查项。
//
// 写入是原子的：同目录隐藏临时文件 → 写 + fsync → **回读校验**（结构 + 时间 + 文本，
// 以及 src/media/subtitles.js 解析器的结果）→ rename。失败 / 取消时删临时文件，
// 旧 VTT 保持原样；失败的检查项会让引擎拒绝写 sidecar。
//
// 9z5.38.3 复用 9z5.37.4 的纯函数（src/media/bookmark/embedder-vtt.js）：
//   secondsToMs / renderVttCues / verifyVttText / writeTextAtomicVerified。
//
// 读侧：parseAnnotationVtt(text) → [{id, startMs, endMs, note, lines}]。
// 共享的字幕解析器（src/media/subtitles.js）不保留 cue id，所以这里自己读块：
// 计时行之前那一行就是批注 id。

import { stat } from 'node:fs/promises';
import path from 'node:path';

import {
  renderVttCues,
  secondsToMs,
  verifyVttText,
  writeTextAtomicVerified,
} from '../bookmark/embedder-vtt.js';
import { sidecarPathFor } from '../bookmark/sidecar.js';
import { DEFAULT_ANNOTATION_END_SECONDS } from './entries.js';
import { ffprobeJson } from '../ffmpeg.js';
import { ToolError } from '../interface.js';
import { cleanSubtitleText } from '../subtitles.js';

/** 视频/录音批注 VTT 的后缀（写在源文件同目录） */
export const ANNOTATION_VTT_SUFFIX = '.mmgrep.annotation.vtt';

/** 批注缺省时长（秒）：end 缺省 = start + 5 s */
const DEFAULT_END_SECONDS = DEFAULT_ANNOTATION_END_SECONDS;

const VTT_EMBED_MEDIA = new Set(['video', 'audio']);
// 只保留可打印字符：C0 控制字符（\t、\n 之外）与 DEL 会破坏 cue
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/**
 * note 里的空行换成这个：只含一个空格。
 * 不是空行（空行会结束 cue，note 会被截断），但只有空白（读侧能还原成空行）。
 */
const BLANK_LINE_PLACEHOLDER = ' ';

function abortError() {
  const error = new Error('request was cancelled by the client');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/** <dir>/<basename>.mmgrep.annotation.vtt（9z5.38.3 写的就是这个路径） */
export function annotationVttPathFor(filePath) {
  return sidecarPathFor(filePath, ANNOTATION_VTT_SUFFIX);
}

/* ------------------------------------------------------------------ *
 * 批注 → cue 行
 * ------------------------------------------------------------------ */

/**
 * cue id = 批注 id（n1…）。不能是 VTT 的保留字，也不能含换行 / `-->`。
 *
 * @param {{id?: string}} entry
 * @param {number} index
 * @returns {string}
 */
function cueIdOf(entry, index) {
  const raw = entry?.id;
  const id = typeof raw === 'string' ? raw : '';
  const unusable =
    id === '' ||
    id.trim() !== id ||
    /[\r\n]/.test(id) ||
    id.includes('-->') ||
    /^(?:WEBVTT|NOTE|STYLE|REGION)/.test(id);
  if (unusable) {
    throw new ToolError(
      'INTERNAL',
      `annotation ${index + 1} has an id that cannot be a VTT cue identifier: ${JSON.stringify(raw ?? null)}`,
      'The sidecar engine assigns ids like "n1". A cue identifier must be a single line, must not contain "-->" or leading/trailing spaces, and must not start with WEBVTT/NOTE/STYLE/REGION.',
    );
  }
  return id;
}

/**
 * note → cue 正文行（纯函数）。
 *
 *   - CRLF/CR → LF；NBSP → 空格；控制字符去掉；行内连续空白折成一个空格；
 *   - **空行换成只含一个空格的行**：VTT 里空行会结束 cue，直接留空会把 note 截断；
 *     只含空格的行不是空行，cue 因此继续，读侧也能把它还原成空行。
 *
 * @param {unknown} note
 * @returns {string[]}
 */
function noteCueLines(note) {
  const raw = String(note ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ');
  if (raw.trim() === '') return [];
  return raw
    .split('\n')
    .map((line) => {
      const folded = line.replace(/\s+/g, ' ').trim();
      return folded === '' ? BLANK_LINE_PLACEHOLDER : folded;
    });
}

/* ------------------------------------------------------------------ *
 * 批注 → cues
 * ------------------------------------------------------------------ */

/**
 * 批注 → cue 列表（纯函数）。
 *
 *   - cue id = 批注 id；cue 正文 = note 的各行（空行换成占位行，见 noteCueLines）；
 *   - 缺省 end = start + 5 s，截到媒体时长（durationSec 未知 → 不截断）；
 *   - end 必须严格大于 start，否则向后推 minCueMs 毫秒；
 *   - 按 start 稳定排序（相同 start 保持 sidecar 的顺序，sidecar 是按 start + id 排的）。
 *
 * @param {Array<{id?: string, note?: string, start?: number, end?: number}>} entries
 * @param {{durationSec?: number|null, minCueMs?: number}} [options]
 * @returns {Array<{id: string, startMs: number, endMs: number, lines: string[]}>}
 */
export function buildAnnotationVttCues(entries, options = {}) {
  const { durationSec = null, minCueMs = 1 } = options;
  if (!Array.isArray(entries)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      'annotation VTT entries must be an array',
      'media_annotate passes the sidecar entries.',
    );
  }
  const durationMs = secondsToMs(durationSec);
  if (durationSec !== null && durationSec !== undefined && durationMs === null) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `durationSec must be a finite number of seconds (got ${JSON.stringify(durationSec)})`,
      'Pass the media duration from probe; omit it only when every annotation has an end.',
    );
  }

  const cues = entries.map((entry, index) => {
    const id = cueIdOf(entry, index);
    const startMs = secondsToMs(entry?.start);
    if (startMs === null) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `annotation "${id}" has no finite start time (got ${JSON.stringify(entry?.start ?? null)})`,
        'video/audio annotations carry "start" in seconds.',
      );
    }
    const lines = noteCueLines(entry?.note);
    if (lines.length === 0) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `annotation "${id}" has an empty note`,
        'A VTT cue needs at least one text line; media_annotate validates notes before embedding.',
      );
    }
    return { id, startMs, endMs: secondsToMs(entry?.end), lines, order: index };
  });

  cues.sort((a, b) => a.startMs - b.startMs || a.order - b.order);
  for (const cue of cues) {
    let endMs = cue.endMs;
    if (endMs === null) {
      const wanted = cue.startMs + Math.round(DEFAULT_END_SECONDS * 1000);
      endMs = durationMs === null ? wanted : Math.min(wanted, durationMs);
    }
    if (endMs <= cue.startMs) endMs = cue.startMs + Math.max(1, minCueMs);
    cue.endMs = endMs;
    delete cue.order;
  }
  return cues;
}

/* ------------------------------------------------------------------ *
 * 读侧：批注 VTT → [{id, startMs, endMs, note, lines}]
 * ------------------------------------------------------------------ */

/** `HH:MM:SS.mmm`（也接受 `MM:SS.mmm`）→ 毫秒；不合法 → null */
function clockToMs(clock) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(String(clock).trim());
  if (!m) return null;
  const hours = m[1] === undefined ? 0 : Number(m[1]);
  return ((hours * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0'));
}

/**
 * 读侧 API：把批注 VTT 读回批注列表。
 *
 * 共享的字幕解析器（src/media/subtitles.js 的 parseVtt）不保留 cue id，所以这里自己
 * 读块：计时行之前那一行就是 cue id（批注 id）。正文逐行解码（实体反转义、标记剥离、
 * 空白归一）；**只含空白的行还原成空行**，因此多行 note（含空行）能原样读回。
 *
 * 不做滚动字幕合并：这是批注，不是字幕，重叠的批注必须各自保留。
 *
 * @param {string} text 批注 VTT 的文本
 * @returns {Array<{id: string, startMs: number, endMs: number, note: string, lines: string[]}>}
 */
export function parseAnnotationVtt(text) {
  const source = typeof text === 'string' ? text : '';
  const blocks = source.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) continue;
    if (/^WEBVTT\b/.test(lines[0].trim())) continue; // 头块
    const timeIdx = lines.findIndex((line) => line.includes('-->'));
    if (timeIdx === -1) continue;
    const timing = /^\s*(\d{1,3}(?::\d{1,2}){1,2}[.,]\d{1,3})\s*-->\s*(\d{1,3}(?::\d{1,2}){1,2}[.,]\d{1,3})/.exec(lines[timeIdx]);
    if (!timing) continue;
    const startMs = clockToMs(timing[1]);
    const endMs = clockToMs(timing[2]);
    if (startMs === null || endMs === null) continue;
    const noteLines = lines.slice(timeIdx + 1).map((line) => (line.trim() === '' ? '' : cleanSubtitleText(line)));
    cues.push({
      id: timeIdx > 0 ? lines[timeIdx - 1].trim() : '',
      startMs,
      endMs,
      lines: noteLines,
      note: noteLines.join('\n'),
    });
  }
  return cues;
}

/* ------------------------------------------------------------------ *
 * 媒体文件与时长
 * ------------------------------------------------------------------ */

async function statMedia(filePath) {
  try {
    const info = await stat(filePath);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    throw new ToolError(
      'PATH_NOT_FOUND',
      `cannot read the source file "${filePath}": ${error?.message ?? error}`,
      'The media file must exist and be readable; the VTT is written next to it.',
    );
  }
}

function describeMediaStat(info) {
  return `${info.size} bytes, mtime ${new Date(info.mtimeMs).toISOString()}`;
}

/** ffprobe 时长；失败 / 报不出时长 → { durationSec: null, reason } */
async function probeDurationSec(filePath, { signal } = {}) {
  try {
    const info = await ffprobeJson(filePath, { signal });
    const formatDuration = Number(info?.format?.duration);
    if (Number.isFinite(formatDuration) && formatDuration > 0) return { durationSec: formatDuration, reason: null };
    const streams = Array.isArray(info?.streams) ? info.streams : [];
    const streamDuration = streams.map((stream) => Number(stream?.duration)).find((value) => Number.isFinite(value) && value > 0);
    if (streamDuration !== undefined) return { durationSec: streamDuration, reason: null };
    return { durationSec: null, reason: 'ffprobe reported neither format.duration nor a stream duration' };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { durationSec: null, reason: `ffprobe failed: ${error?.message ?? error}` };
  }
}

/* ------------------------------------------------------------------ *
 * 嵌入器
 * ------------------------------------------------------------------ */

/**
 * 视频/录音批注嵌入器接口（与 bookmark 嵌入器一致）：
 *   { media: 'video'|'audio', embedTarget(filePath) => string,
 *     async embed({ filePath, media, entries, sidecarPath, signal }) => { target, checks[] } }
 */
export const vttAnnotationEmbedder = Object.freeze({
  media: 'video',

  /** 嵌入目标：源文件旁边的 VTT（不改媒体文件） */
  embedTarget(filePath) {
    return annotationVttPathFor(filePath);
  },

  /**
   * 把批注写成源文件旁边的 VTT 投影。
   *
   * @param {{filePath: string, media: string, entries: Array<object>,
   *          sidecarPath?: string|null, signal?: AbortSignal|null}} input
   * @returns {Promise<{target: string, checks: Array<{name: string, ok: boolean, detail?: string}>}>}
   */
  async embed({ filePath, media, entries, signal = null } = {}) {
    if (!VTT_EMBED_MEDIA.has(media)) {
      throw new ToolError(
        'INTERNAL',
        `the annotation VTT embedder only handles video/audio (got ${JSON.stringify(media ?? null)})`,
        'This embedder is registered for video and audio; the engine selects it by media type.',
      );
    }
    const source = path.resolve(String(filePath));
    const target = annotationVttPathFor(source);
    const list = Array.isArray(entries) ? entries : [];
    throwIfAborted(signal);

    const before = await statMedia(source);

    // 只有「有条目缺 end」才需要媒体时长（引擎通常已经补好 end）
    const missingEnd = list.filter((entry) => entry?.end === undefined || entry?.end === null);
    let durationSec = null;
    let durationReason = null;
    if (missingEnd.length > 0) {
      const probed = await probeDurationSec(source, { signal });
      durationSec = probed.durationSec;
      durationReason = probed.reason;
    }

    const cues = buildAnnotationVttCues(list, { durationSec });
    const text = renderVttCues(cues);
    let readBackVerdict = null;
    const write = await writeTextAtomicVerified(target, text, {
      signal,
      verifyText: (readBack) => {
        readBackVerdict = verifyVttText(readBack, cues);
        return readBackVerdict;
      },
    });
    if (!write.ok) {
      return {
        target,
        checks: [
          {
            name: 'vtt-readback',
            ok: false,
            detail: `${write.detail}; the annotation VTT was not written (its temporary file was removed)`,
          },
        ],
      };
    }

    const after = await statMedia(source);
    const unchanged = before.size === after.size && before.mtimeMs === after.mtimeMs;
    const checks = [
      {
        name: 'vtt-readback',
        ok: true,
        detail: readBackVerdict?.ok === true
          ? `the annotation VTT reads back: ${readBackVerdict.detail}`
          : `${cues.length} annotation cues read back`,
      },
      {
        name: 'media-unchanged',
        ok: unchanged,
        detail: unchanged
          ? `"${source}" is unchanged (${describeMediaStat(before)})`
          : `the media file changed while the annotation VTT was written: ${describeMediaStat(before)} → ${describeMediaStat(after)}`,
      },
    ];
    if (missingEnd.length > 0 && durationSec === null) {
      // 时长未知：不能截断，但引擎写进 sidecar 的也是不截断的 start + 5 s，两者必须一致
      checks.push({
        name: 'vtt-end-default',
        ok: true,
        detail: `the media duration is unknown (${durationReason}); ${missingEnd.length} annotation(s) without an end use the default end (start + ${DEFAULT_END_SECONDS}s), not clipped to the duration`,
      });
    }
    return { target, checks };
  },
});
