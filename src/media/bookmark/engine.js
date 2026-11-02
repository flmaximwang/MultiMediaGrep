// src/media/bookmark/engine.js —— sidecar 引擎：操作合并 / 嵌入 / 原子落盘
//
// 一次 media_bookmark 调用的完整流程（顺序是契约的一部分）：
//   1. 读 sidecar（不存在 = 首次写入；存在但坏了 = 报错，绝不覆盖）；
//   2. 首次写入：从文件自带目录导入 b1…bN（derive.js，与读侧共用同一函数）；
//   3. 合并操作：remove → update → add，全部校验，**所有错误一起报**，
//      只有零错误才继续（all-or-nothing）；
//   4. 嵌入（embedder 自己保证原子）：失败 / 检查项失败 → 不写 sidecar；
//   5. 原子写 sidecar（同目录临时文件 → fsync → rename）；
//   6. 回读 sidecar 校验（检查项 sidecar-readback）。
//
// 引擎本身不绑定书签：entry 的字段校验 / 合并 / 排序 / 格式化通过 adapter 注入，
// id 前缀、sidecar 后缀、嵌入器注册表都是参数 —— 9z5.38.1 的 media_annotate
// （id n1…、`.mmgrep.annotation.json`）复用同一份实现，不复制流程。

import path from 'node:path';

import { ToolError } from '../interface.js';
import {
  applyPatch,
  canonicalEntry,
  formatEntry,
  isEntryId,
  nextIdNumber,
  sortEntries,
  validateAddEntry,
  validateStoredEntry,
  validateUpdatePatch,
} from './entries.js';
import { deriveEntriesFromProbe } from './derive.js';
import { BOOKMARK_SIDECAR_SUFFIX, readSidecar, sidecarPathFor, writeSidecar } from './sidecar.js';
import { defaultBookmarkEmbedders, embedderFor } from './embedders.js';

/** 书签 id 前缀 / sidecar 后缀的默认值（9z5.38.1 会传自己的） */
export const BOOKMARK_ID_PREFIX = 'b';

/** 书签条目适配器：把 entries.js 的纯函数接到引擎上（38.1 换一份即可） */
export const bookmarkEntryAdapter = Object.freeze({
  kind: 'bookmark',
  validateStored: (raw, options) => validateStoredEntry(raw, options),
  validateAdd: (raw, options) => validateAddEntry(raw, options),
  validateUpdate: (raw, options) => validateUpdatePatch(raw, options),
  applyPatch: (entry, patch, options) => applyPatch(entry, patch, options),
  canonical: (media, raw) => canonicalEntry(media, raw),
  sort: (entries, media) => sortEntries(entries, media),
  format: (entry, options) => formatEntry(entry, options),
});

function abortError() {
  const error = new Error('request was cancelled by the client');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function describeValue(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function refuseMessage(label, details) {
  return `${label} refused the request, so nothing was written:\n${details.map((detail) => `  - ${detail}`).join('\n')}`;
}

/**
 * 操作列表规范化：必须是 {add?, remove?, update?}，每个存在的键必须是数组，
 * 且至少有一项操作（全部为空 = 没意义，直接拒绝）。
 */
function normalizeOperations(operations) {
  const errors = [];
  const ops = { remove: [], update: [], add: [] };
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) {
    errors.push('operations must be an object like { add, remove, update }');
    return { ops, errors, valid: false };
  }
  for (const key of Object.keys(operations)) {
    if (!Object.hasOwn(ops, key)) {
      errors.push(`unknown operation "${key}" (allowed: add, remove, update)`);
    }
  }
  for (const name of ['remove', 'update', 'add']) {
    if (operations[name] === undefined) continue;
    if (!Array.isArray(operations[name])) {
      errors.push(`${name} must be an array`);
      continue;
    }
    ops[name] = operations[name];
  }
  const total = ops.remove.length + ops.update.length + ops.add.length;
  if (errors.length === 0 && total === 0) {
    errors.push('the call must contain at least one operation: add, remove, or update');
  }
  return { ops, errors, valid: errors.length === 0 };
}

/**
 * 合并一次调用里的所有操作（纯函数，不碰文件系统）。
 *
 * remove → update → add 的顺序决定了可观察语义：同一 id 不能既 remove 又 update；
 * update 只能改已存在的条目；add 总是拿新 id。
 * 所有错误都会累积返回，由调用方一次性报告。
 *
 * @returns {{ok: true, entries: Array<object>, applied: {remove: string[], update: string[], add: string[]}}
 *          | {ok: false, errors: string[]}}
 */
export function applyOperations({
  entries,
  media,
  operations,
  limits = {},
  idPrefix = BOOKMARK_ID_PREFIX,
  adapter = bookmarkEntryAdapter,
  idNoun = 'bookmark',
  context = {},
}) {
  const pre = Array.isArray(entries) ? entries : [];
  const { ops, errors } = normalizeOperations(operations);
  if (errors.length > 0) return { ok: false, errors };

  const working = new Map(pre.map((entry) => [entry.id, entry]));
  const knownIds = [...working.keys()].sort((a, b) => Number(a.slice(idPrefix.length)) - Number(b.slice(idPrefix.length)));
  const knownList = knownIds.length > 0 ? knownIds.join(', ') : 'none';
  const applied = { remove: [], update: [], add: [] };

  // ---- remove ----
  const removeSet = new Set();
  ops.remove.forEach((rawId, index) => {
    const label = `remove[${index}]`;
    if (typeof rawId !== 'string') {
      errors.push(`${label}: id must be a string (got ${describeValue(rawId)})`);
      return;
    }
    if (!isEntryId(rawId, idPrefix)) {
      errors.push(`${label}: ${describeValue(rawId)} is not a valid ${idNoun} id (expected ${idPrefix}1, ${idPrefix}2, …)`);
      return;
    }
    if (removeSet.has(rawId)) {
      errors.push(`${label}: duplicate id ${describeValue(rawId)}`);
      return;
    }
    if (!working.has(rawId)) {
      errors.push(`${label}: unknown id ${describeValue(rawId)} (known: ${knownList})`);
      return;
    }
    removeSet.add(rawId);
    working.delete(rawId);
    applied.remove.push(rawId);
  });

  // ---- update ----
  const updateSeen = new Set();
  ops.update.forEach((raw, index) => {
    const label = `update[${index}]`;
    const rawId = raw !== null && typeof raw === 'object' ? raw.id : undefined;
    if (typeof rawId === 'string' && removeSet.has(rawId)) {
      errors.push(`${label}: id ${describeValue(rawId)} is also in remove (the entry would not exist)`);
      return;
    }
    const { patch, errors: patchErrors } = adapter.validateUpdate(raw, { media, limits, label, idPrefix, context });
    errors.push(...patchErrors);
    if (!patch) return;
    if (updateSeen.has(raw.id)) {
      errors.push(`${label}: duplicate id ${describeValue(raw.id)}`);
      return;
    }
    updateSeen.add(raw.id);
    const existing = working.get(raw.id);
    if (!existing) {
      errors.push(`${label}: unknown id ${describeValue(raw.id)} (known: ${[...working.keys()].join(', ') || 'none'})`);
      return;
    }
    const { entry, errors: applyErrors } = adapter.applyPatch(existing, patch, {
      media,
      durationSec: limits.durationSec,
      label,
      context,
    });
    errors.push(...applyErrors);
    if (!entry) return;
    working.set(raw.id, entry);
    applied.update.push(raw.id);
  });

  // ---- add ----
  // id 从**操作前**的最大编号 + 1 开始，保证同一次调用里删掉最大 id 再加也不会复用。
  let counter = nextIdNumber(pre, idPrefix);
  ops.add.forEach((raw, index) => {
    const label = `add[${index}]`;
    if (raw !== null && typeof raw === 'object' && raw.id !== undefined) {
      errors.push(`${label}: must not include "id" (ids are assigned by the server; remove the old entry and add a new one to change an id)`);
      const { errors: addErrors } = adapter.validateAdd({ ...raw, id: undefined }, { media, limits, label, context });
      errors.push(...addErrors);
      return;
    }
    const { entry, errors: addErrors } = adapter.validateAdd(raw, { media, limits, label, context });
    errors.push(...addErrors);
    if (!entry) return;
    const id = `${idPrefix}${counter}`;
    counter += 1;
    entry.id = id;
    working.set(id, entry);
    applied.add.push(id);
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries: adapter.sort([...working.values()], media), applied };
}

/** probe 结果 → 本次调用的范围限制（页码 / 时长）；不知道就为 null（不做范围校验） */
export function limitsFromProbe(media, probe) {
  if (media === 'pdf') {
    const pageCount = probe?.pageCount;
    return { pageCount: Number.isInteger(pageCount) && pageCount > 0 ? pageCount : null };
  }
  if (media === 'video' || media === 'audio') {
    const durationSec = probe?.durationSec;
    return { durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null };
  }
  return {};
}

function normalizeEmbedResult(result, media) {
  if (!result || typeof result !== 'object') {
    return { target: null, checks: [{ name: 'embed', ok: false, detail: 'the embedder returned no result object' }] };
  }
  const target = typeof result.target === 'string' && result.target.length > 0 ? result.target : null;
  const checks = Array.isArray(result.checks)
    ? result.checks
        .filter((check) => check && typeof check === 'object')
        .map((check) => ({
          name: String(check.name ?? 'check'),
          ok: check.ok === true,
          ...(check.detail === undefined ? {} : { detail: String(check.detail) }),
        }))
    : [];
  return { target, checks };
}

/**
 * 创建 sidecar 引擎。书签用默认参数；media_annotate 传自己的 adapter / idPrefix /
 * sidecarSuffix / deriveEntries / resultKey（9z5.38.1 起复用同一份实现）。
 *
 * @param {{
 *   label?: string,                  // 错误信息里的工具名
 *   idPrefix?: string,               // 'b'（书签）/'n'（注释）
 *   sidecarSuffix?: string,          // '.mmgrep.bookmark.json'
 *   adapter?: object,                // 条目 schema 适配器
 *   embedders?: Record<string, object>|null, // 默认嵌入器注册表
 *   deriveEntries?: Function,        // 首次写入的导入函数 (media, probe, {idPrefix}) → entries
 *   resultKey?: string,              // 结果对象里条目列表的键（书签 'outline' / 批注 'annotations'）
 *   idNoun?: string,                 // 错误信息里的 id 名词（'bookmark' / 'annotation'）
 *   sidecarNoun?: string,            // 错误信息里的 sidecar 名词（'bookmark' / 'annotation'）
 *   imageSidecarDetail?: string,     // 图片没有嵌入器时的检查说明
 * }} [options]
 */
export function createSidecarEngine({
  label = 'media_bookmark',
  idPrefix = BOOKMARK_ID_PREFIX,
  sidecarSuffix = BOOKMARK_SIDECAR_SUFFIX,
  adapter = bookmarkEntryAdapter,
  embedders = defaultBookmarkEmbedders,
  deriveEntries = deriveEntriesFromProbe,
  resultKey = 'outline',
  idNoun = 'bookmark',
  sidecarNoun = 'bookmark',
  imageSidecarDetail = 'image: no native outline; the sidecar is the only store',
} = {}) {
  return {
    label,
    idPrefix,
    sidecarSuffix,
    adapter,
    embedders,
    deriveEntries,
    resultKey,
    idNoun,
    sidecarNoun,

    /** 源文件 → 它的 sidecar 路径 */
    sidecarPath(filePath) {
      return sidecarPathFor(filePath, sidecarSuffix);
    },

    /**
     * 执行一次写操作。
     *
     * @param {{
     *   filePath: string,
     *   media: string,
     *   probe?: object|null,           // probe 结果（提供 pageCount / durationSec）
     *   operations: object,            // { add?, remove?, update? }
     *   embedder?: object|null,        // undefined = 用注册表；null = 明确不嵌入
     *   signal?: AbortSignal|null,
     *   context?: object,              // 传给 adapter 的调用级上下文（批注用 { author }）
     * }} input
     */
    async execute({
      filePath,
      media,
      probe = null,
      operations,
      embedder = undefined,
      signal = null,
      context = {},
    }) {
      throwIfAborted(signal);
      const resolvedPath = path.resolve(String(filePath));
      const resolvedSidecarPath = sidecarPathFor(resolvedPath, sidecarSuffix);
      const sidecarOptions = { media, idPrefix, adapter, noun: sidecarNoun, toolName: label };

      // 1) 读 sidecar —— 坏了就报错，绝不覆盖
      const existing = await readSidecar(resolvedSidecarPath, sidecarOptions);
      const created = !existing.exists;

      // 2) 首次写入：从文件自带目录导入
      let baseEntries = existing.entries;
      let imported = 0;
      if (created) {
        baseEntries = deriveEntries(media, probe, { idPrefix });
        imported = baseEntries.length;
      }

      // 3) 合并操作（all-or-nothing；所有错误一次性报）
      throwIfAborted(signal);
      const limits = limitsFromProbe(media, probe);
      const plan = applyOperations({
        entries: baseEntries,
        media,
        operations,
        limits,
        idPrefix,
        adapter,
        idNoun,
        context,
      });
      if (!plan.ok) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          refuseMessage(label, plan.errors),
          'Fix the listed problems and call again. Nothing was written: no sidecar, no embed target.',
        );
      }

      // 4) 嵌入（先于 sidecar；失败则 sidecar 字节保持不变）
      const selected =
        embedder === undefined ? embedderFor(media, embedders) : embedder;
      let embed = { target: null, checks: [] };
      if (selected) {
        if (typeof selected.embed !== 'function') {
          throw new ToolError('INTERNAL', `${label} embedder for "${media}" has no embed() function`);
        }
        throwIfAborted(signal);
        const rawResult = await selected.embed({
          filePath: resolvedPath,
          media,
          entries: plan.entries,
          sidecarPath: resolvedSidecarPath,
          signal,
        });
        embed = normalizeEmbedResult(rawResult, media);
        const failed = embed.checks.filter((check) => !check.ok);
        if (failed.length > 0) {
          const details = failed.map((check) => `  - check "${check.name}" failed${check.detail ? `: ${check.detail}` : ''}`);
          throw new ToolError(
            'INTERNAL',
            `embedding failed${embed.target ? ` for "${embed.target}"` : ''}, so the sidecar was not written:\n${details.join('\n')}`,
            'The embedder is responsible for leaving its target unchanged on failure; the sidecar was not touched.',
          );
        }
      } else {
        embed = normalizeEmbedResult(
          {
            target: null,
            checks: [
              {
                name: 'embed',
                ok: true,
                detail:
                  media === 'image'
                    ? imageSidecarDetail
                    : `no embedder registered for "${media}"; only the sidecar is written`,
              },
            ],
          },
          media,
        );
      }

      // 5) 原子写 sidecar
      throwIfAborted(signal);
      try {
        await writeSidecar(resolvedSidecarPath, media, plan.entries, { signal, adapter });
      } catch (error) {
        // 嵌入已完成而 sidecar 写失败：必须如实报告，避免用户以为什么都没写
        if (error instanceof ToolError) {
          throw new ToolError(
            error.code,
            `${error.message}\nNote: the embedding step already completed${embed.target ? ` (target: ${embed.target})` : ''}; only the sidecar was not written.`,
            error.hint,
          );
        }
        throw error;
      }

      // 6) 回读校验
      const readBack = await readSidecar(resolvedSidecarPath, sidecarOptions);
      const expected = JSON.stringify(plan.entries);
      const actual = JSON.stringify(readBack.entries);
      if (expected !== actual) {
        throw new ToolError(
          'INTERNAL',
          `${label} read back a different sidecar than it wrote: expected ${expected}, found ${actual}`,
          `The sidecar "${resolvedSidecarPath}" was not modified after the write, but its content could not be verified.`,
        );
      }
      const readbackCheck = {
        name: 'sidecar-readback',
        ok: true,
        detail: `${readBack.entries.length} entries`,
      };

      return {
        media,
        path: resolvedPath,
        sidecarPath: resolvedSidecarPath,
        created,
        imported,
        applied: plan.applied,
        embed: { target: embed.target, checks: embed.checks },
        checks: [...embed.checks, readbackCheck],
        [resultKey]: {
          source: 'sidecar',
          available: true,
          total: plan.entries.length,
          entries: plan.entries,
        },
      };
    },
  };
}

/** 默认书签引擎（pdf/video/audio/image + b 前缀 + .mmgrep.bookmark.json） */
export const bookmarkEngine = createSidecarEngine();
