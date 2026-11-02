// src/media/annotation/derive.js —— 首次写入时导入文件自带的批注
//
// 与 ../bookmark/derive.js 同角色：sidecar 还不存在时，先把文件自带的目录派生出来，
// 让「导入的 n1…nN」与只读工具派生的编号一致。批注的**真实读取**（PDF 注释对象）
// 归 9z5.38.2；本文件只定义接缝：probe 结果里若带 `annotationOutline`
// （{ available, entries }），就按「页 → rect 的 y → x」排好、连续编号；
// 没有这个字段时返回 []（视频/录音本来就没有内置批注可导入）。
//
// 导入条目的形状必须是合法的 sidecar 条目：note / author 缺失时用中性占位
// （"(no note)" / "unknown"），type 缺失时按 "text" 猜；逐条过一遍
// validateStoredAnnotation，不合格的跳过——导入不能让 sidecar 写不出去。

import { validateCrop } from '../interface.js';
import {
  ANNOTATION_ID_PREFIX,
  normalizeAuthor,
  normalizeNote,
  normalizeType,
  validateStoredAnnotation,
} from './entries.js';

/** 从 probe 结果 / outline 对象 / 裸数组里取出批注原始列表（没有就返回 []） */
export function annotationEntriesOf(probeOrOutline) {
  const source = probeOrOutline?.annotationOutline ?? probeOrOutline?.annotations ?? probeOrOutline;
  if (Array.isArray(source)) return source;
  if (source && typeof source === 'object') {
    if (Array.isArray(source.entries)) return source.entries;
    if (Array.isArray(source.annotations)) return source.annotations;
  }
  return [];
}

function rectY(raw) {
  return Number.isFinite(raw?.rect?.y) ? raw.rect.y : Number.POSITIVE_INFINITY;
}

function rectX(raw) {
  return Number.isFinite(raw?.rect?.x) ? raw.rect.x : 0;
}

function rectOf(raw) {
  if (!raw || typeof raw !== 'object' || !raw.rect || typeof raw.rect !== 'object') return null;
  try {
    return validateCrop(raw.rect);
  } catch {
    return null;
  }
}

function rawOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw.raw;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return undefined;
}

/**
 * 文件自带批注 → sidecar 条目（按 9z5.38.1 的契约）。
 *
 * - PDF：按 page、rect.y、rect.x 排序后连续编号 n1…nN（没有 rect 的排在有 rect 的后面）；
 * - 视频/音频：v1 没有内置批注可导入（容器章节是书签，不是批注）→ []；
 * - 图片：没有原生批注 → []。
 *
 * @param {string} media pdf | video | audio | image
 * @param {object|object[]|null} outline probe.annotationOutline / {entries} / 裸数组
 * @param {{idPrefix?: string}} [options]
 * @returns {object[]} sidecar 条目（已按位置排序、已规范化）
 */
export function deriveAnnotationsFromOutline(media, outline, { idPrefix = ANNOTATION_ID_PREFIX } = {}) {
  if (media === 'image' || media === 'video' || media === 'audio') return [];
  if (media !== 'pdf') throw new Error(`deriveAnnotationsFromOutline: unsupported media type "${media}"`);

  const ordered = annotationEntriesOf(outline)
    .map((raw, index) => ({ raw, index }))
    .filter(({ raw }) => Number.isInteger(raw?.page) && raw.page >= 1)
    .sort((a, b) => (a.raw.page - b.raw.page)
      || (rectY(a.raw) - rectY(b.raw))
      || (rectX(a.raw) - rectX(b.raw))
      || (a.index - b.index));

  const entries = [];
  for (const { raw } of ordered) {
    const candidate = {
      id: `${idPrefix}${entries.length + 1}`,
      type: normalizeType(raw?.type) ?? 'text',
      note: normalizeNote(raw?.note) ?? '(no note)',
      author: normalizeAuthor(raw?.author) ?? 'unknown',
      page: raw.page,
    };
    const rect = rectOf(raw);
    if (rect !== null) candidate.rect = rect;
    const rawValue = rawOf(raw);
    if (rawValue !== undefined) candidate.raw = rawValue;
    const { entry } = validateStoredAnnotation(candidate, {
      media: 'pdf',
      idPrefix,
      label: `imported[${entries.length}]`,
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * probe 结果 → sidecar 条目。找不到批注信息时返回 []（首次写入就是「没有可导入的」）。
 *
 * @param {string} media
 * @param {object|null} probe
 * @param {{idPrefix?: string}} [options]
 */
export function deriveAnnotationEntriesFromProbe(media, probe, { idPrefix = ANNOTATION_ID_PREFIX } = {}) {
  return deriveAnnotationsFromOutline(media, probe?.annotationOutline ?? probe?.annotations ?? probe, { idPrefix });
}

/** probe 里是否有可导入的原生批注（读取侧 9z5.38.4 也会用） */
export function hasNativeAnnotations(media, probeOrOutline) {
  if (media !== 'pdf') return false;
  const source = probeOrOutline?.annotationOutline ?? probeOrOutline?.annotations ?? probeOrOutline;
  if (!source || typeof source !== 'object' || source.available !== true) return false;
  return annotationEntriesOf(source).length > 0;
}
