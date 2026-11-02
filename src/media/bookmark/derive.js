// src/media/bookmark/derive.js —— 从文件自带目录推导书签条目（首次写入 + 读侧共用）
//
// **这是首次写入与只读工具（probe / overview / locate）共用的唯一推导函数**：
// 9z5.37.6 必须从本文件 import，保证没有 sidecar 时读侧显示的 b1…bN 与
// media_bookmark 首次写入的 id 完全一致。任何改动都会破坏两边的一致性，
// 因此推导规则只允许加注释，不允许悄悄改顺序或编号。
//
// 推导规则：
//   - 按文件自带目录的**原始顺序**编号（PDF outline 深度优先 / 视频章节顺序）；
//   - 编号连续：b1、b2、…（中间不跳号；被跳过的条目不会占号）；
//   - PDF：{level, title, page}，page 是物理页码（1 起）。page 为 null 的条目
//     （目标页无法解析）跳过 —— sidecar 条目必须有真实页码；
//   - 视频/音频：{title, start, end?}，秒。start 缺失或非有限的条目跳过；
//   - 图片：图片没有自带目录，返回空数组。
//
// 返回顺序 = 展示顺序（文件顺序）；写入 sidecar 时引擎再按位置稳定排序。

import { normalizeTitle, positionFields } from './entries.js';

/** 从 probe 结果取 outline 对象（probe.outline = {available, source, total, entries, reason}） */
export function outlineEntriesOf(probeOrOutline) {
  const outline = probeOrOutline?.outline ?? probeOrOutline;
  if (Array.isArray(outline)) return outline;
  return Array.isArray(outline?.entries) ? outline.entries : [];
}

function titleOr(fallback, title) {
  return normalizeTitle(title) ?? fallback;
}

/**
 * 从文件自带目录推导书签条目（id 按顺序分配）。
 *
 * @param {'pdf'|'video'|'audio'|'image'} media
 * @param {{entries?: Array<object>}|Array<object>} outline probe 的 outline 或 probe 本身
 * @param {{idPrefix?: string}} [options]
 * @returns {Array<object>} 条目数组（file order，id 连续）
 */
export function deriveEntriesFromOutline(media, outline, { idPrefix = 'b' } = {}) {
  const source = outlineEntriesOf(outline);
  if (media === 'image') return [];
  const entries = [];

  if (media === 'pdf') {
    for (const raw of source) {
      const page = Number.isInteger(raw?.page) && raw.page >= 1 ? raw.page : null;
      if (page === null) continue;
      const level = Number.isInteger(raw?.level) && raw.level >= 1 ? raw.level : 1;
      entries.push({
        id: `${idPrefix}${entries.length + 1}`,
        title: titleOr(`Page ${page}`, raw?.title),
        page,
        level,
      });
    }
    return entries;
  }

  if (media === 'video' || media === 'audio') {
    for (let index = 0; index < source.length; index += 1) {
      const raw = source[index];
      const start = Number.isFinite(raw?.startSec) ? raw.startSec : Number.isFinite(raw?.startMs) ? raw.startMs / 1000 : null;
      if (start === null || start < 0) continue;
      const end = Number.isFinite(raw?.endSec) ? raw.endSec : Number.isFinite(raw?.endMs) ? raw.endMs / 1000 : null;
      const entry = {
        id: `${idPrefix}${entries.length + 1}`,
        title: titleOr(`Chapter ${index + 1}`, raw?.title),
        start,
      };
      if (end !== null && end > start) entry.end = end;
      entries.push(entry);
    }
    return entries;
  }

  throw new Error(`deriveEntriesFromOutline: unsupported media type "${media}"`);
}

/**
 * probe 结果 → 条目（读侧最常用的入口）。
 * @param {string} media
 * @param {object} probe dispatcher 的 probe 结果
 */
export function deriveEntriesFromProbe(media, probe, { idPrefix = 'b' } = {}) {
  return deriveEntriesFromOutline(media, probe?.outline ?? probe, { idPrefix });
}

/** 该媒体类型是否有自带目录可导入（读侧/引擎判断用） */
export function hasNativeOutline(media, probeOrOutline) {
  if (positionFields(media).length === 0) return false;
  const outline = probeOrOutline?.outline ?? probeOrOutline;
  return outline?.available === true && outlineEntriesOf(outline).length > 0;
}
