// src/media/bookmark/sidecar.js —— 书签侧车的路径 / 解析 / 原子落盘
//
// 侧车是**唯一真相源**：`<dir>/<basename>.mmgrep.bookmark.json`
//   { "version": 1, "media": "pdf|video|audio|image", "entries": [ … ] }
// 条目按位置排序（见 entries.js），JSON 固定两空格缩进 + 结尾换行，便于 diff。
//
// 写入一律「同目录隐藏临时文件 → 写 + fsync → rename」：
//   - 同目录才能保证 rename 是原子的（跨文件系统 rename 会退化成复制）；
//   - 文件名以 `.` 开头带随机串，撞名概率可忽略；'wx' 保证绝不覆盖已有文件；
//   - 失败 / AbortSignal → 关句柄、删临时文件，原文件与旧 sidecar 保持不变。
//
// 读取失败（JSON 坏了 / 结构不对）一律报 ToolError，**绝不覆盖**：
// 侧车可能是用户手写的，覆盖等于丢数据。

import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { ToolError } from '../interface.js';
import { SIDECAR_VERSION, canonicalEntry, isEntryId, sortEntries, validateStoredEntry } from './entries.js';

/** sidecar 文件后缀（书签）；9z5.38.1 的注释侧车用 `.mmgrep.annotation.json` */
export const BOOKMARK_SIDECAR_SUFFIX = '.mmgrep.bookmark.json';

/**
 * 默认（书签）sidecar 适配器：条目校验 / 规范化 / 排序。
 * media_annotate 传自己的 adapter，其余读写逻辑完全共用。
 */
export const BOOKMARK_SIDECAR_ADAPTER = Object.freeze({
  validateStored: (raw, options) => validateStoredEntry(raw, options),
  canonical: (media, raw) => canonicalEntry(media, raw),
  sort: (entries, media) => sortEntries(entries, media),
});

/** 源文件旁边的 sidecar 路径：`/a/b/report.pdf` → `/a/b/report.pdf.mmgrep.bookmark.json` */
export function sidecarPathFor(filePath, suffix = BOOKMARK_SIDECAR_SUFFIX) {
  const resolved = path.resolve(String(filePath));
  return path.join(path.dirname(resolved), `${path.basename(resolved)}${suffix}`);
}

function corruptedSidecar(sidecarPath, details, { noun = 'bookmark', toolName = 'media_bookmark', hint = null } = {}) {
  const lines = details.map((detail) => `  - ${detail}`);
  return new ToolError(
    'INVALID_ARGUMENT',
    `the ${noun} sidecar "${sidecarPath}" is corrupted, so nothing was written:\n${lines.join('\n')}`,
    hint ?? `Fix or delete the sidecar file, then call ${toolName} again. The sidecar was not modified.`,
  );
}

/**
 * 解析并校验 sidecar 文本。
 *
 * @param {string} text 文件内容
 * @param {{sidecarPath: string, media: string, idPrefix: string, adapter?: object,
 *          noun?: string, toolName?: string}} options
 * @returns {Array<object>} 排序后的条目（结构合法）
 */
export function parseSidecarText(text, {
  sidecarPath,
  media,
  idPrefix,
  adapter = BOOKMARK_SIDECAR_ADAPTER,
  noun = 'bookmark',
  toolName = 'media_bookmark',
}) {
  const context = { noun, toolName };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw corruptedSidecar(sidecarPath, [`it is not valid JSON: ${error?.message ?? error}`], context);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corruptedSidecar(sidecarPath, ['the top level must be a JSON object { version, media, entries }'], context);
  }

  const details = [];
  if (parsed.version !== SIDECAR_VERSION) {
    details.push(`version must be ${SIDECAR_VERSION} (found ${JSON.stringify(parsed.version)})`);
  }
  if (parsed.media !== media) {
    details.push(`media must be "${media}" (found ${JSON.stringify(parsed.media)})`);
  }
  if (!Array.isArray(parsed.entries)) {
    details.push('entries must be an array');
  }

  const entries = [];
  if (Array.isArray(parsed.entries)) {
    for (let index = 0; index < parsed.entries.length; index += 1) {
      const { entry, errors } = adapter.validateStored(parsed.entries[index], {
        media,
        idPrefix,
        label: `entries[${index}]`,
      });
      details.push(...errors);
      if (entry) entries.push(entry);
    }
    const seen = new Set();
    for (const entry of entries) {
      if (seen.has(entry.id)) details.push(`duplicate id "${entry.id}"`);
      seen.add(entry.id);
    }
    if (entries.length !== parsed.entries.length && details.length === 0) {
      details.push('entries could not be parsed');
    }
  }

  if (details.length > 0) throw corruptedSidecar(sidecarPath, details, context);
  return adapter.sort(entries, media);
}

/**
 * 读 sidecar。不存在 → `{exists:false, entries:[]}`（首次写入由调用方导入）。
 *
 * @returns {Promise<{exists: boolean, path: string, entries: Array<object>}>}
 */
export async function readSidecar(sidecarPath, {
  media,
  idPrefix,
  adapter = BOOKMARK_SIDECAR_ADAPTER,
  noun = 'bookmark',
  toolName = 'media_bookmark',
}) {
  const context = { noun, toolName };
  let text;
  try {
    text = await readFile(sidecarPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, path: sidecarPath, entries: [] };
    throw corruptedSidecar(sidecarPath, [`it cannot be read: ${error?.message ?? error}`], context);
  }
  return {
    exists: true,
    path: sidecarPath,
    entries: parseSidecarText(text, { sidecarPath, media, idPrefix, adapter, ...context }),
  };
}

/** 条目数组 → sidecar JSON 文本（规范化字段顺序 + 两空格缩进 + 结尾换行） */
export function serializeSidecar(media, entries, { adapter = BOOKMARK_SIDECAR_ADAPTER } = {}) {
  const document = {
    version: SIDECAR_VERSION,
    media,
    entries: entries.map((entry) => adapter.canonical(media, entry)),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function abortError() {
  const error = new Error('request was cancelled by the client');
  error.name = 'AbortError';
  return error;
}

async function openTempFile(directory, baseName, signal) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (signal?.aborted) throw abortError();
    const name = `.${baseName}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
    const tempPath = path.join(directory, name);
    let handle;
    try {
      // 'wx'：文件已存在就失败（撞名时换一个随机名重试），绝不碰已有文件
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
 * 原子写文本文件：同目录临时文件 → write + fsync → rename 覆盖目标。
 *
 * @throws {ToolError} 目录不可写 / AbortSignal —— 临时文件会被删除，目标文件不变
 */
export async function writeFileAtomic(targetPath, text, { signal = null } = {}) {
  const directory = path.dirname(targetPath);
  const baseName = path.basename(targetPath);

  let handle = null;
  let tempPath = null;
  try {
    ({ handle, tempPath } = await openTempFile(directory, baseName, signal));
    await handle.writeFile(text, 'utf8');
    // fsync 尽力而为：不支持时（某些文件系统）仍然继续，rename 本身已是原子的
    await handle.sync().catch(() => {});
    await handle.close();
    handle = null;
    if (signal?.aborted) throw abortError();
    await rename(tempPath, targetPath);
    tempPath = null;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (tempPath) await rm(tempPath, { force: true }).catch(() => {});
    if (error instanceof ToolError) throw error;
    if (error?.name === 'AbortError') throw error;
    throw new ToolError(
      'INTERNAL',
      `cannot write "${targetPath}": ${error?.message ?? error}`,
      'The source file\'s directory must be writable: the sidecar is written next to the source, with no fallback location. Check the directory permissions and free space.',
    );
  }
}

/** 写 sidecar（原子）。调用方负责先完成嵌入；嵌入失败时不会走到这里。 */
export async function writeSidecar(sidecarPath, media, entries, { signal = null, adapter = BOOKMARK_SIDECAR_ADAPTER } = {}) {
  const text = serializeSidecar(media, entries, { adapter });
  await writeFileAtomic(sidecarPath, text, { signal });
  return text;
}

/** 回读比较用：条目数组的稳定指纹（字段顺序已由 canonicalEntry 固定） */
export function entriesFingerprint(entries) {
  return JSON.stringify(entries);
}

/** 判断一个 id 是不是该前缀下的合法 id（供工具层复用） */
export function isValidSidecarId(value, idPrefix) {
  return isEntryId(value, idPrefix);
}
