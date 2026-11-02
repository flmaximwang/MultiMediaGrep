// src/media/bookmark/embedder-vtt.js —— 视频/音频书签嵌入器（VTT 投影）
//
// 书签的真相源是同目录的 `.mmgrep.bookmark.json` sidecar；本嵌入器额外把条目投影成
// `<dir>/<full basename>.mmgrep.bookmark.vtt`，让 ffmpeg / 播放器直接看到章节：
//   - cue identifier = 条目 id（b1…），cue 文本 = 标题（单行）；
//   - 缺省 end = 下一条 start，最后一条 = 媒体时长（end == duration 合法）；
//   - 时间戳 `HH:MM:SS.mmm`；UTF-8 无 BOM、LF、`WEBVTT` 头；
//   - 标题是纯文本：只做 VTT 实体转义（`& < >`，`-->` 因此被中和成 `--&gt;`），
//     换行折成空格；任何空行都不会出现在 cue 里（空行会结束 cue）；
//   - **绝不修改媒体文件**：embed 前后比较 size + mtime，作为 media-unchanged 检查项。
//
// 写入是原子的：同目录隐藏临时文件 → 写 + fsync → **回读校验**（结构 + 时间 + 文本，
// 以及 src/media/subtitles.js 解析器的结果）→ rename。失败 / 取消时删临时文件，
// 旧 VTT 保持原样；失败的检查项会让引擎拒绝写 sidecar。
//
// 9z5.38.3（media_annotate 的 VTT）复用本文件的纯函数：
//   escapeVttCueLine / buildVttCues / renderVttCues / renderVtt / verifyVttText /
//   writeTextAtomicVerified。多行注释传 `multiline: true`；注意 VTT 里空行会结束
//   cue，所以多行文本中的空行会被丢弃。

import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { ffprobeJson } from '../ffmpeg.js';
import { ToolError } from '../interface.js';
import { cleanSubtitleText, mergeRollingCues, parseVtt } from '../subtitles.js';

/** VTT 投影文件后缀（`<dir>/<full basename>.mmgrep.bookmark.vtt`） */
export const BOOKMARK_VTT_SUFFIX = '.mmgrep.bookmark.vtt';

const VTT_HEADER = 'WEBVTT';
const VTT_EMBED_MEDIA = new Set(['video', 'audio']);
// 只保留可打印字符：C0 控制字符（\t、\n 之外）与 DEL 会破坏 cue
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const WRITE_HINT =
  "The source file's directory must be writable: the VTT is written next to the source, with no fallback location. Check the directory permissions and free space.";

function abortError() {
  const error = new Error('request was cancelled by the client');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/** 视频/音频书签的 VTT 目标路径：与 sidecar 同目录、同样带完整文件名 */
export function bookmarkVttPathFor(filePath) {
  const resolved = path.resolve(String(filePath));
  return path.join(path.dirname(resolved), `${path.basename(resolved)}${BOOKMARK_VTT_SUFFIX}`);
}

/* ------------------------------------------------------------------ *
 * 时间戳：秒 → 毫秒 → `HH:MM:SS.mmm`
 * ------------------------------------------------------------------ */

/**
 * 秒 → 整数毫秒（四舍五入，负数夹到 0）。非有限数字 → null（= 缺省）。
 *
 * @param {unknown} seconds
 * @returns {number|null}
 */
export function secondsToMs(seconds) {
  const value = typeof seconds === 'string' ? Number(seconds) : seconds;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value * 1000));
}

/**
 * 毫秒 → WebVTT 时间戳 `HH:MM:SS.mmm`（小时补到两位；超过 99 小时就自然变长）。
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatVttTimestamp(ms) {
  const total = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/* ------------------------------------------------------------------ *
 * 纯文本 → cue 行：折行 / 转义
 * ------------------------------------------------------------------ */

/**
 * 把任意文本折成单行：CR/LF → 空格、NBSP → 空格、连续空白 → 一个空格、去首尾。
 * 标题因此永远只占一行（VTT 里换行会变成新的一行 cue 文本）。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function foldVttText(text) {
  return String(text ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join(' ');
}

/**
 * 单行 cue 文本的 VTT 转义：`&` → `&amp;`、`<` → `&lt;`、`>` → `&gt;`。
 *
 * `-->` 里的 `>` 被编码成 `&gt;`，计时行分隔符因此不可能出现在正文里；`<tag>` 也
 * 不会在回读时被当成标签剥掉。解码由 src/media/subtitles.js 的 cleanSubtitleText
 * 与 ffmpeg 的 webvtt demuxer 负责（两者都支持这些命名实体）。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function escapeVttCueLine(text) {
  return String(text ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cueTextLines(text, { multiline = false } = {}) {
  if (!multiline) {
    const folded = foldVttText(text);
    return folded === '' ? [] : [folded];
  }
  // 多行（9z5.38.3 的注释）：逐行折叠；空行会结束 cue，所以直接丢掉
  return String(text ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
}

/* ------------------------------------------------------------------ *
 * 条目 → cues → VTT 文本
 * ------------------------------------------------------------------ */

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
      `entry ${index + 1} has an id that cannot be a VTT cue identifier: ${JSON.stringify(raw ?? null)}`,
      'The sidecar engine assigns ids like "b1". A cue identifier must be a single line, must not contain "-->" or leading/trailing spaces, and must not start with WEBVTT/NOTE/STYLE/REGION.',
    );
  }
  return id;
}

/**
 * 条目 → cue 列表（纯函数）。
 *
 * 缺省 end 的解析顺序：下一条的 start → 媒体时长 durationSec（最后一条）；
 * end 必须严格大于 start，冲突时向后推 minCueMs 毫秒。条目按 start 稳定排序。
 *
 * @param {Array<{id?: string, title?: string, start?: number, end?: number}>} entries
 * @param {{durationSec?: number|null, textOf?: (entry: object, index: number) => unknown,
 *          multiline?: boolean, minCueMs?: number}} [options]
 * @returns {Array<{id: string, startMs: number, endMs: number, lines: string[]}>}
 */
export function buildVttCues(entries, options = {}) {
  const { durationSec = null, textOf = (entry) => entry?.title, multiline = false, minCueMs = 1 } = options;
  if (!Array.isArray(entries)) {
    throw new ToolError('INVALID_ARGUMENT', 'bookmark VTT entries must be an array', 'media_bookmark passes the sidecar entries.');
  }
  const durationMs = secondsToMs(durationSec);
  if (durationSec !== null && durationSec !== undefined && durationMs === null) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `durationSec must be a finite number of seconds (got ${JSON.stringify(durationSec)})`,
      'Pass the media duration from probe; omit it only when every entry has an end.',
    );
  }

  const cues = entries.map((entry, index) => {
    const id = cueIdOf(entry, index);
    const startMs = secondsToMs(entry?.start);
    if (startMs === null) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `entry "${id}" has no finite start time (got ${JSON.stringify(entry?.start ?? null)})`,
        'video/audio entries carry "start" in seconds.',
      );
    }
    const lines = cueTextLines(textOf(entry, index), { multiline });
    if (lines.length === 0) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `entry "${id}" has empty cue text`,
        'VTT cues need at least one text line: the engine validates titles, so this indicates a bad textOf() option.',
      );
    }
    return { id, startMs, endMs: secondsToMs(entry?.end), lines, order: index };
  });

  cues.sort((a, b) => a.startMs - b.startMs || a.order - b.order);
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    let endMs = cue.endMs;
    if (endMs === null) {
      const next = cues[index + 1];
      endMs = next ? next.startMs : durationMs;
      if (endMs === null) {
        throw new ToolError(
          'INTERNAL',
          `cannot resolve the end of bookmark "${cue.id}": it has no end, no later entry exists, and the media duration is unknown`,
          'Re-probe the media (ffprobe must report format.duration) or give the entry an explicit end.',
        );
      }
    }
    if (endMs <= cue.startMs) endMs = cue.startMs + Math.max(1, minCueMs);
    cue.endMs = endMs;
    delete cue.order;
  }
  return cues;
}

/**
 * cues → VTT 文本（纯函数）。块之间空一行，文件以单个换行结尾。
 *
 * @param {Array<{id: string, startMs: number, endMs: number, lines: string[]}>} cues
 * @param {{eol?: string, header?: string, escape?: boolean}} [options]
 * @returns {string}
 */
export function renderVttCues(cues, options = {}) {
  const { eol = '\n', header = VTT_HEADER, escape = true } = options;
  if (!Array.isArray(cues)) {
    throw new ToolError('INVALID_ARGUMENT', 'bookmark VTT cues must be an array', 'Pass the result of buildVttCues().');
  }
  const blocks = cues.map((cue) => {
    const lines = (Array.isArray(cue?.lines) ? cue.lines : []).map((line) => (escape ? escapeVttCueLine(line) : String(line)));
    const timing = `${formatVttTimestamp(cue?.startMs)} --> ${formatVttTimestamp(cue?.endMs)}`;
    return [String(cue?.id ?? ''), timing, ...lines].join('\n');
  });
  const text = blocks.length === 0 ? `${header}\n` : `${header}\n\n${blocks.join('\n\n')}\n`;
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

/**
 * 条目 → VTT 文本（`buildVttCues` + `renderVttCues`）。
 *
 * @param {Array<object>} entries
 * @param {object} [options] buildVttCues / renderVttCues 的选项
 * @returns {string}
 */
export function renderVtt(entries, options = {}) {
  return renderVttCues(buildVttCues(entries, options), options);
}

/* ------------------------------------------------------------------ *
 * 回读校验：结构逐字节 + 共享解析器的结果
 * ------------------------------------------------------------------ */

/** 从 VTT 文本里读回 cue 块（id / 计时行 / 正文行）。解析器不保留 cue id，所以自己读。 */
function readVttBlocks(text) {
  const blocks = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) continue;
    // 头块（空 VTT 只有这一块）
    if (cues.length === 0 && lines[0].trim().startsWith(VTT_HEADER)) continue;
    const timeIdx = lines.findIndex((line) => line.includes('-->'));
    if (timeIdx === -1) continue;
    cues.push({
      id: timeIdx > 0 ? lines[timeIdx - 1].trim() : '',
      timingLine: lines[timeIdx].trim(),
      textLines: lines.slice(timeIdx + 1),
    });
  }
  return cues;
}

/** 把 cues 按共享解析器的语义（cleanSubtitleText + mergeRollingCues）展开成段 */
function parserSegmentsFor(cues, { escape = true } = {}) {
  const cleaned = cues.map((cue) => ({
    startMs: cue.startMs,
    endMs: cue.endMs,
    lines: cue.lines
      .map((line) => cleanSubtitleText(escape ? escapeVttCueLine(line) : String(line)))
      .filter((line) => line !== ''),
  }));
  return mergeRollingCues(cleaned).map((cue) => ({
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.lines.join(' ').trim(),
  }));
}

function firstSegmentDifference(actual, expected) {
  if (actual.length !== expected.length) {
    return `it produced ${actual.length} segment${actual.length === 1 ? '' : 's'}, expected ${expected.length}`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const got = actual[index];
    const want = expected[index];
    if (got.startMs !== want.startMs) return `segment ${index + 1} starts at ${got.startMs} ms, expected ${want.startMs} ms`;
    if (got.endMs !== want.endMs) return `segment ${index + 1} ends at ${got.endMs} ms, expected ${want.endMs} ms`;
    if (got.text !== want.text) {
      return `segment ${index + 1} text is ${JSON.stringify(got.text)}, expected ${JSON.stringify(want.text)}`;
    }
  }
  return null;
}

/**
 * 校验 VTT 文本：无 BOM、只有 LF、`WEBVTT` 头、每个 cue 块逐字节等于期望
 * （id / `HH:MM:SS.mmm` 计时行 / 转义后的正文行），再用 src/media/subtitles.js
 * 的 parseVtt 回读，比较 count / 时间 / 文本。
 *
 * 解析器会把「与上一条重叠且正文相同」的 cue 合并、把重复首行丢掉（滚动字幕的
 * 启发式），所以解析结果按同样的语义（cleanSubtitleText + mergeRollingCues）比较；
 * 正常的人工章节两边完全一致。
 *
 * @param {string} text 磁盘上读回的 VTT 文本
 * @param {Array<{id: string, startMs: number, endMs: number, lines: string[]}>} cues 期望的 cue 列表
 * @param {{escape?: boolean}} [options]
 * @returns {{ok: boolean, detail: string}} 失败时 detail 指出第一处差异
 */
export function verifyVttText(text, cues, options = {}) {
  const { escape = true } = options;
  const fail = (detail) => ({ ok: false, detail });
  const source = typeof text === 'string' ? text : '';
  const expected = Array.isArray(cues) ? cues : [];

  if (source.length === 0) return fail('the VTT file is empty');
  if (source.charCodeAt(0) === 0xfeff) return fail('the VTT file starts with a UTF-8 BOM');
  if (source.includes('\r')) return fail('the VTT file contains CR characters (expected LF line endings)');
  if (!source.startsWith(`${VTT_HEADER}\n`)) return fail(`the VTT file does not start with the "${VTT_HEADER}" header line`);

  const blocks = readVttBlocks(source);
  if (blocks.length !== expected.length) {
    return fail(`the VTT file holds ${blocks.length} cue block${blocks.length === 1 ? '' : 's'}, expected ${expected.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const cue = expected[index];
    const block = blocks[index];
    if (block.id !== cue.id) {
      return fail(`cue ${index + 1}: identifier is ${JSON.stringify(block.id)}, expected ${JSON.stringify(cue.id)}`);
    }
    const timing = `${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}`;
    if (block.timingLine !== timing) {
      return fail(`cue "${cue.id}": timing line is ${JSON.stringify(block.timingLine)}, expected ${JSON.stringify(timing)}`);
    }
    const lines = cue.lines.map((line) => (escape ? escapeVttCueLine(line) : String(line)));
    if (JSON.stringify(block.textLines) !== JSON.stringify(lines)) {
      return fail(`cue "${cue.id}": text lines are ${JSON.stringify(block.textLines)}, expected ${JSON.stringify(lines)}`);
    }
  }

  const segments = parseVtt(source);
  const parserExpected = parserSegmentsFor(expected, { escape });
  const mismatch = firstSegmentDifference(segments, parserExpected);
  if (mismatch) return fail(`the shared VTT parser read something else: ${mismatch}`);

  const merged = expected.length - parserExpected.length;
  const base = `${expected.length} cue${expected.length === 1 ? '' : 's'}, ids, HH:MM:SS.mmm times and text match`;
  return {
    ok: true,
    detail: merged > 0 ? `${base} (the parser merges ${merged} rolling-style duplicate${merged === 1 ? '' : 's'})` : base,
  };
}

/* ------------------------------------------------------------------ *
 * 原子写：临时文件 + fsync + 回读校验 + rename（9z5.38.3 复用）
 * ------------------------------------------------------------------ */

async function openTempFile(directory, baseName, signal) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    throwIfAborted(signal);
    const name = `.${baseName}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
    const tempPath = path.join(directory, name);
    let handle;
    try {
      // 'wx'：撞名就失败（换一个随机名重试），绝不覆盖任何已有文件
      handle = await open(tempPath, 'wx');
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    return { handle, tempPath };
  }
  throw new ToolError('INTERNAL', `could not create a temporary file next to "${baseName}" (5 random names collided).`);
}

/**
 * 原子写文本文件并回读校验：同目录临时文件 → write + fsync → 读回 → verifyText →
 * rename。校验失败返回 `{ok:false, detail}`（临时文件已删，目标文件不变）；IO
 * 失败抛 ToolError；AbortSignal 取消抛 AbortError。三种情况下旧目标都保持原样。
 *
 * @param {string} targetPath
 * @param {string} text
 * @param {{signal?: AbortSignal|null, verifyText?: ((readBack: string) => ({ok: boolean, detail?: string}|boolean))|null}} [options]
 * @returns {Promise<{ok: true} | {ok: false, detail: string}>}
 */
export async function writeTextAtomicVerified(targetPath, text, options = {}) {
  const { signal = null, verifyText = null } = options;
  const target = path.resolve(String(targetPath));
  const directory = path.dirname(target);
  const baseName = path.basename(target);
  let handle = null;
  let tempPath = null;
  const discardTemp = async () => {
    if (!tempPath) return;
    const victim = tempPath;
    tempPath = null;
    await rm(victim, { force: true }).catch(() => {});
  };

  try {
    throwIfAborted(signal);
    ({ handle, tempPath } = await openTempFile(directory, baseName, signal));
    await handle.writeFile(String(text), 'utf8');
    // fsync 尽力而为：文件系统不支持时继续，rename 本身已是原子的
    await handle.sync().catch(() => {});
    await handle.close();
    handle = null;
    throwIfAborted(signal);

    if (typeof verifyText === 'function') {
      const readBack = await readFile(tempPath, 'utf8');
      throwIfAborted(signal);
      const verdict = await verifyText(readBack);
      const ok = verdict === true || (verdict !== null && typeof verdict === 'object' && verdict.ok === true);
      if (!ok) {
        const detail =
          verdict !== null && typeof verdict === 'object' && typeof verdict.detail === 'string' && verdict.detail !== ''
            ? verdict.detail
            : 'read-back verification failed';
        await discardTemp();
        return { ok: false, detail };
      }
      throwIfAborted(signal);
    }

    await rename(tempPath, target);
    tempPath = null;
    return { ok: true };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await discardTemp();
    if (error instanceof ToolError) throw error;
    if (error?.name === 'AbortError') throw error;
    throw new ToolError('INTERNAL', `cannot write "${target}": ${error?.message ?? error}`, WRITE_HINT);
  }
}

/* ------------------------------------------------------------------ *
 * 嵌入器
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

export const vttBookmarkEmbedder = Object.freeze({
  media: 'video',

  /** 嵌入目标：源文件旁边的 VTT（不改媒体文件） */
  embedTarget(filePath) {
    return bookmarkVttPathFor(filePath);
  },

  /**
   * 把条目写成源文件旁边的 VTT 投影。
   *
   * @param {{filePath: string, media: string, entries: Array<object>,
   *          sidecarPath?: string|null, signal?: AbortSignal|null}} input
   * @returns {Promise<{target: string, checks: Array<{name: string, ok: boolean, detail?: string}>}>}
   */
  async embed({ filePath, media, entries, signal = null } = {}) {
    if (!VTT_EMBED_MEDIA.has(media)) {
      throw new ToolError(
        'INTERNAL',
        `the VTT embedder only handles video/audio (got ${JSON.stringify(media ?? null)})`,
        'This embedder is registered for video and audio; the engine selects it by media type.',
      );
    }
    const source = path.resolve(String(filePath));
    const target = bookmarkVttPathFor(source);
    const list = Array.isArray(entries) ? entries : [];
    throwIfAborted(signal);

    const before = await statMedia(source);

    // 只有「最后一条没有 end」才需要媒体时长；ffprobe 失败时如实返回失败检查项
    let durationSec = null;
    const last = list[list.length - 1];
    const lastHasEnd = last !== undefined && last?.end !== undefined && last?.end !== null;
    if (last !== undefined && !lastHasEnd) {
      const probed = await probeDurationSec(source, { signal });
      if (probed.durationSec === null) {
        return {
          target,
          checks: [
            {
              name: 'vtt-duration',
              ok: false,
              detail: `the last bookmark ("${last?.id ?? '?'}") has no end and ${probed.reason}; the VTT was not written`,
            },
          ],
        };
      }
      durationSec = probed.durationSec;
    }

    const cues = buildVttCues(list, { durationSec });
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
            detail: `${write.detail}; the VTT was not written (its temporary file was removed)`,
          },
        ],
      };
    }

    const after = await statMedia(source);
    const unchanged = before.size === after.size && before.mtimeMs === after.mtimeMs;
    return {
      target,
      checks: [
        {
          name: 'vtt-readback',
          ok: true,
          detail: readBackVerdict?.ok === true ? readBackVerdict.detail : `${cues.length} cues read back`,
        },
        {
          name: 'media-unchanged',
          ok: unchanged,
          detail: unchanged
            ? `"${source}" is unchanged (${describeMediaStat(before)})`
            : `the media file changed while the VTT was written: ${describeMediaStat(before)} → ${describeMediaStat(after)}`,
        },
      ],
    };
  },
});
