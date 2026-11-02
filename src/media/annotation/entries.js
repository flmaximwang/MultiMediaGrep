// src/media/annotation/entries.js —— 批注条目的规范化 / 校验 / 排序 / 格式化
//
// 侧车 JSON（*.mmgrep.annotation.json）是批注的唯一真相源；同一个条目结构被用在
// 五个地方，所以这里**不碰文件系统**，只做纯函数：
//   1. 首次写入时导入文件自带的批注（derive.js，9z5.38.2 提供真实数据源）；
//   2. 读侧车时校验（corrupt sidecar 绝不覆盖）；
//   3. add / update 操作校验与应用；
//   4. 嵌入器输入（9z5.38.2 PDF / 9z5.38.3 VTT）；
//   5. 结果文本（与读取侧同格式）。
//
// 条目形状（按媒体类型）——顺序即写进 sidecar 的字段顺序：
//   PDF       { id, type, note, author, page, rect?, raw? }
//             type = "text"（便签，rect 可选）| "square"（矩形区域，必须有 rect）；
//             rect = {x,y,width,height} 比例制 0..1，原点左上，与 media_zoom 的 crop 同一套几何；
//             raw 保存 v1 不能新建的类型（highlight / ink / stamp / freetext…）的几何与外观，
//             原样保留供 9z5.38.2 往返；本版本不读也不改它。
//   视频/音频 { id, note, author, start, end? }   秒；end 缺省 = start + 5 s（截到时长）
//   图片     { id, note, author, rect? }          图片没有时间轴，也没有原生批注可导入
//
// 通用引擎在 ../bookmark/engine.js（操作合并 / 嵌入 / 原子写 / 回读）：本文件只提供
// 批注专属的 adapter；id 前缀、sidecar 后缀、嵌入器注册表都由引擎参数注入，不复制流程。

import { validateCrop } from '../interface.js';
import { entryIdNumber, isEntryId } from '../bookmark/entries.js';

/** 批注 id 前缀：n1、n2、…（书签是 b1…） */
export const ANNOTATION_ID_PREFIX = 'n';

/** author 的最终兜底（参数 → MCP clientInfo.name → 这个字符串） */
export const DEFAULT_ANNOTATION_AUTHOR = 'MultiMediaGrep';

/** note 上限（纯文本字符数，换行允许） */
export const MAX_NOTE_CHARS = 4000;

/** author 上限（展示用的一行名字） */
export const MAX_AUTHOR_CHARS = 200;

/** 视频/音频批注的缺省时长（秒）：end 缺省 = start + 5 s，截到媒体时长 */
export const DEFAULT_ANNOTATION_END_SECONDS = 5;

/** 本版本可以新建的 PDF 批注类型（其它类型只能从文件导入） */
export const CREATABLE_ANNOTATION_TYPES = Object.freeze(['text', 'square']);

/** 结果文本里多行 note 的续行缩进 */
const NOTE_CONTINUATION_INDENT = '    ';

const POSITION_FIELDS = Object.freeze({
  pdf: Object.freeze(['page']),
  video: Object.freeze(['start', 'end']),
  audio: Object.freeze(['start', 'end']),
  image: Object.freeze([]),
});

/** 该媒体类型的位置字段（返回新数组） */
export function positionFields(media) {
  return [...(POSITION_FIELDS[media] ?? [])];
}

/**
 * sidecar 条目允许的字段（不含 id）——读侧车 / 首次导入用。
 * 比可写字段多 author 与 raw：author 来自导入或服务端，raw 只从文件导入。
 */
export function entryFields(media) {
  if (media === 'pdf') return ['type', 'note', 'author', 'page', 'rect', 'raw'];
  if (media === 'image') return ['note', 'author', 'rect'];
  if (media === 'video' || media === 'audio') return ['note', 'author', 'start', 'end'];
  return [];
}

/** add / update 允许用户写的字段（不含 id）；author / raw 由服务端或导入决定 */
export function writableFields(media) {
  if (media === 'pdf') return ['type', 'note', 'page', 'rect'];
  if (media === 'image') return ['note', 'rect'];
  if (media === 'video' || media === 'audio') return ['note', 'start', 'end'];
  return [];
}

/** 明确「属于别的媒体类型」的字段：报错时说清不适用，而不是笼统的未知字段 */
function notApplicableFields(media) {
  if (media === 'pdf') return ['start', 'end'];
  if (media === 'image') return ['type', 'page', 'start', 'end'];
  if (media === 'video' || media === 'audio') return ['type', 'rect', 'page'];
  return [];
}

/** 媒体类型是否支持批注（pdf / video / audio / image） */
export function isAnnotationMedia(media) {
  return Object.hasOwn(POSITION_FIELDS, media);
}

/**
 * note 归一化：只去首尾空白（**不折叠**内部换行 / 空格；不转义 XML/HTML），
 * 空串、非字符串、超长返回 null。
 */
export function normalizeNote(value) {
  if (typeof value !== 'string') return null;
  const note = value.trim();
  if (note.length === 0) return null;
  if (Array.from(note).length > MAX_NOTE_CHARS) return null;
  return note;
}

/** author 归一化：折叠空白成一行 + 去首尾；空 / 超长返回 null */
export function normalizeAuthor(value) {
  if (typeof value !== 'string') return null;
  const author = value.replace(/\s+/g, ' ').trim();
  if (author.length === 0) return null;
  if (Array.from(author).length > MAX_AUTHOR_CHARS) return null;
  return author;
}

/** sidecar 里的 type：非空字符串；未知类型保留（v1 不能新建，但导入的要能存） */
export function normalizeType(value) {
  if (typeof value !== 'string') return null;
  const type = value.trim();
  return type.length > 0 ? type : null;
}

/** 该类型是否能在本版本新建 */
export function isCreatableAnnotationType(value) {
  return CREATABLE_ANNOTATION_TYPES.includes(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------ *
 * 校验（全部累积错误，由调用方一次报全）
 * ------------------------------------------------------------------ */

/**
 * 通用字段检查：未知字段 / 属于别的媒体类型的字段 / id 是否允许出现。
 */
function checkFields(raw, { media, label, errors, allowed, idAllowed = false, requireId = false, authorError = 'is set by the call-level author argument, not per entry' }) {
  if (!isPlainObject(raw)) {
    const shape = writableFields(media);
    errors.push(`${label}: must be an object like { ${shape.join(', ')} }`);
    return;
  }
  if (raw.id !== undefined && !idAllowed) {
    errors.push(`${label}: must not include "id" (ids are assigned by the server; remove the old annotation and add a new one to change an id)`);
  }
  if (requireId && raw.id === undefined) {
    errors.push(`${label}: id is required`);
  }
  const notApplicable = notApplicableFields(media);
  for (const key of Object.keys(raw)) {
    if (key === 'id' || allowed.includes(key)) continue;
    if (notApplicable.includes(key)) {
      errors.push(`${label}: "${key}" is not applicable to ${media} annotations`);
      continue;
    }
    if (key === 'author') {
      errors.push(`${label}: "author" ${authorError}`);
      continue;
    }
    if (key === 'raw') {
      errors.push(`${label}: "raw" is only preserved for annotations imported from the file; this version cannot create or change it`);
      continue;
    }
    const shape = allowed.length > 0 ? ` (allowed: ${allowed.join(', ')})` : '';
    errors.push(`${label}: unknown field "${key}"${shape}`);
  }
}

function checkNote(value, { label, errors }) {
  if (value === undefined) {
    errors.push(`${label}: note is required`);
    return null;
  }
  if (typeof value !== 'string') {
    errors.push(`${label}: note must be a string (got ${describeValue(value)})`);
    return null;
  }
  const note = value.trim();
  if (note.length === 0) {
    errors.push(`${label}: note must not be empty`);
    return null;
  }
  const chars = Array.from(note).length;
  if (chars > MAX_NOTE_CHARS) {
    errors.push(`${label}: note must be at most ${MAX_NOTE_CHARS} characters (got ${chars})`);
    return null;
  }
  return note;
}

function checkAuthor(value, { label, errors }) {
  if (value === undefined) {
    errors.push(`${label}: author is required (imported annotations keep their original author)`);
    return null;
  }
  const author = normalizeAuthor(value);
  if (author === null) {
    errors.push(`${label}: author must be a non-empty string of at most ${MAX_AUTHOR_CHARS} characters (got ${describeValue(value)})`);
  }
  return author;
}

function checkPage(value, { label, pageCount, errors }) {
  if (value === undefined) {
    errors.push(`${label}: page is required for a PDF annotation (1-based physical page)`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    errors.push(`${label}: page must be an integer ≥ 1 (got ${describeValue(value)})`);
    return null;
  }
  if (Number.isInteger(pageCount) && pageCount > 0 && value > pageCount) {
    errors.push(`${label}: page ${value} is outside 1..${pageCount}`);
    return null;
  }
  return value;
}

function checkStart(value, { label, durationSec, errors }) {
  if (value === undefined) {
    errors.push(`${label}: start is required for a video/audio annotation (seconds)`);
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push(`${label}: start must be a finite number ≥ 0 in seconds (got ${describeValue(value)})`);
    return null;
  }
  if (Number.isFinite(durationSec) && durationSec > 0 && value >= durationSec) {
    errors.push(`${label}: start ${value}s must be less than the media duration ${durationSec}s`);
    return null;
  }
  return value;
}

function checkEnd(value, start, { label, durationSec, errors }) {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label}: end must be a finite number in seconds (got ${describeValue(value)})`);
    return null;
  }
  if (Number.isFinite(start) && value <= start) {
    errors.push(`${label}: end ${value}s must be greater than start ${start}s`);
    return null;
  }
  if (Number.isFinite(durationSec) && durationSec > 0 && value > durationSec) {
    errors.push(`${label}: end ${value}s is outside 0..${durationSec}s (the media is ${durationSec}s long)`);
    return null;
  }
  return value;
}

/** 缺省 end：start + 5 s，截到媒体时长 */
export function defaultAnnotationEnd(start, durationSec) {
  const wanted = start + DEFAULT_ANNOTATION_END_SECONDS;
  if (Number.isFinite(durationSec) && durationSec > 0) return Math.min(wanted, durationSec);
  return wanted;
}

/**
 * rect 校验：几何规则复用 media_zoom 的 validateCrop（比例制 0..1，原点左上），
 * 但错误文案说 "rect"，并把四个值都列出来。
 *
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function checkRect(value, { label, errors }) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    errors.push(`${label}: rect must be an object {x, y, width, height} with fractions 0..1 (got ${describeValue(value)})`);
    return null;
  }
  const numbers = {};
  let missing = false;
  for (const key of ['x', 'y', 'width', 'height']) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      errors.push(`${label}: rect.${key} must be a finite number (got ${describeValue(number)})`);
      missing = true;
    } else {
      numbers[key] = number;
    }
  }
  if (missing) return null;
  try {
    return validateCrop(numbers);
  } catch {
    errors.push(
      `${label}: rect must satisfy 0 <= x, 0 <= y, x + width <= 1, y + height <= 1 `
      + `(got x=${numbers.x}, y=${numbers.y}, width=${numbers.width}, height=${numbers.height})`,
    );
    return null;
  }
}

/** square 必须有 rect；text 的 rect 可选 */
function checkRectForType(type, value, options) {
  if (value === undefined) {
    if (type === 'square') options.errors.push(`${options.label}: rect is required for a "square" annotation`);
    return null;
  }
  return checkRect(value, options);
}

function checkStoredType(value, { label, errors }) {
  if (value === undefined) {
    errors.push(`${label}: type is required for a PDF annotation`);
    return null;
  }
  const type = normalizeType(value);
  if (type === null) {
    errors.push(`${label}: type must be a non-empty string (got ${describeValue(value)})`);
  }
  return type;
}

function checkCreatableType(value, { label, errors }) {
  if (value === undefined) {
    errors.push(`${label}: type is required for a PDF annotation ("text" or "square")`);
    return null;
  }
  const type = normalizeType(value);
  if (type === null || !isCreatableAnnotationType(type)) {
    errors.push(
      `${label}: type must be "text" or "square" (got ${describeValue(value)}); `
      + 'other annotation types cannot be created yet',
    );
    return null;
  }
  return type;
}

/* ------------------------------------------------------------------ *
 * 规范化
 * ------------------------------------------------------------------ */

function canonicalRect(rect) {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * 按固定字段顺序生成规范化条目（sidecar JSON 输出稳定，便于 diff 与回读比较）。
 *
 * @param {string} media
 * @param {{id?: string, type?: string, note: string, author: string,
 *          page?: number, start?: number, end?: number,
 *          rect?: object, raw?: object}} raw
 */
export function canonicalAnnotation(media, raw) {
  if (media === 'pdf') {
    const entry = {
      id: raw.id,
      type: raw.type,
      note: raw.note,
      author: raw.author,
      page: raw.page,
    };
    if (raw.rect !== undefined && raw.rect !== null) entry.rect = canonicalRect(raw.rect);
    if (raw.raw !== undefined && raw.raw !== null) entry.raw = raw.raw;
    return entry;
  }
  if (media === 'image') {
    const entry = { id: raw.id, note: raw.note, author: raw.author };
    if (raw.rect !== undefined && raw.rect !== null) entry.rect = canonicalRect(raw.rect);
    return entry;
  }
  const entry = { id: raw.id, note: raw.note, author: raw.author, start: raw.start };
  if (raw.end !== undefined && raw.end !== null) entry.end = raw.end;
  return entry;
}

/* ------------------------------------------------------------------ *
 * 校验入口：stored / add / update
 * ------------------------------------------------------------------ */

/**
 * 校验一条**已存在**于 sidecar 的批注。只做结构校验，不按页数/时长限制
 * （文件可能被换过；限制只针对本次调用新增/更新的值）。
 *
 * @returns {{entry: object|null, errors: string[]}}
 */
export function validateStoredAnnotation(raw, { media, idPrefix = ANNOTATION_ID_PREFIX, label = 'entry' } = {}) {
  const errors = [];
  checkFields(raw, { media, label, errors, allowed: entryFields(media), idAllowed: true });
  if (!isPlainObject(raw)) return { entry: null, errors };
  if (raw.id === undefined) errors.push(`${label}: id is required`);
  else if (!isEntryId(raw.id, idPrefix)) {
    errors.push(`${label}: id ${describeValue(raw.id)} is not a valid annotation id (expected ${idPrefix}1, ${idPrefix}2, …)`);
  }
  const note = checkNote(raw.note, { label, errors });
  const author = checkAuthor(raw.author, { label, errors });
  const position = {};
  if (media === 'pdf') {
    position.type = checkStoredType(raw.type, { label, errors });
    position.page = checkPage(raw.page, { label, errors });
    position.rect = checkRectForType(position.type, raw.rect, { label, errors });
    if (raw.raw !== undefined) {
      if (isPlainObject(raw.raw)) position.raw = raw.raw;
      else errors.push(`${label}: raw must be an object when present (got ${describeValue(raw.raw)})`);
    }
  } else if (media === 'video' || media === 'audio') {
    position.start = checkStart(raw.start, { label, errors });
    position.end = checkEnd(raw.end, position.start, { label, errors });
    if (position.end === null) delete position.end;
  } else if (media === 'image') {
    position.rect = checkRect(raw.rect, { label, errors });
  } else {
    errors.push(`${label}: unsupported media type "${media}"`);
  }
  if (errors.length > 0) return { entry: null, errors };
  return { entry: canonicalAnnotation(media, { id: raw.id, note, author, ...position }), errors };
}

/**
 * 校验一条 add 条目。id 由服务端分配（调用方不许传），author 来自本次调用的
 * context.author（缺省 "MultiMediaGrep"）。
 *
 * @returns {{entry: object|null, errors: string[]}}
 */
export function validateAddAnnotation(raw, { media, limits = {}, label = 'add annotation', context = {} } = {}) {
  const errors = [];
  checkFields(raw, { media, label, errors, allowed: writableFields(media) });
  if (!isPlainObject(raw)) return { entry: null, errors };
  const author = normalizeAuthor(context.author) ?? DEFAULT_ANNOTATION_AUTHOR;
  const note = checkNote(raw.note, { label, errors });
  const position = {};
  if (media === 'pdf') {
    position.type = checkCreatableType(raw.type, { label, errors });
    position.page = checkPage(raw.page, { label, pageCount: limits.pageCount, errors });
    position.rect = checkRectForType(position.type, raw.rect, { label, errors });
  } else if (media === 'video' || media === 'audio') {
    position.start = checkStart(raw.start, { label, durationSec: limits.durationSec, errors });
    let end = checkEnd(raw.end, position.start, { label, durationSec: limits.durationSec, errors });
    if (raw.end === undefined && position.start !== null) {
      end = defaultAnnotationEnd(position.start, limits.durationSec);
    }
    position.end = end;
  } else if (media === 'image') {
    position.rect = checkRect(raw.rect, { label, errors });
  } else {
    errors.push(`${label}: unsupported media type "${media}"`);
  }
  if (errors.length > 0) return { entry: null, errors };
  return { entry: canonicalAnnotation(media, { note, author, ...position }), errors };
}

/**
 * 校验一条 update patch。id 必填；至少改一个字段；author 不能改。
 * 跨字段约束（square 必须有 rect、end > start）在 applyAnnotationPatch 里检查。
 *
 * @returns {{patch: object|null, errors: string[]}}
 */
export function validateUpdateAnnotation(raw, { media, limits = {}, label = 'update annotation', idPrefix = ANNOTATION_ID_PREFIX } = {}) {
  const errors = [];
  checkFields(raw, {
    media,
    label,
    errors,
    allowed: writableFields(media),
    idAllowed: true,
    requireId: true,
    authorError: 'cannot be changed by update (it is set when the annotation is created)',
  });
  if (!isPlainObject(raw)) return { patch: null, errors };
  if (raw.id !== undefined && !isEntryId(raw.id, idPrefix)) {
    errors.push(`${label}: id ${describeValue(raw.id)} is not a valid annotation id (expected ${idPrefix}1, ${idPrefix}2, …)`);
  }

  const mutable = writableFields(media);
  const hasChange = mutable.some((field) => raw[field] !== undefined);
  if (!hasChange) {
    errors.push(`${label}: provide at least one field to change (${mutable.join(', ')}); the id itself never changes`);
  }

  const patch = {};
  if (raw.note !== undefined) {
    const note = checkNote(raw.note, { label, errors });
    if (note !== null) patch.note = note;
  }
  if (media === 'pdf') {
    if (raw.type !== undefined) {
      const type = checkCreatableType(raw.type, { label, errors });
      if (type !== null) patch.type = type;
    }
    if (raw.page !== undefined) {
      const page = checkPage(raw.page, { label, pageCount: limits.pageCount, errors });
      if (page !== null) patch.page = page;
    }
    if (raw.rect !== undefined) {
      const rect = checkRect(raw.rect, { label, errors });
      if (rect !== null) patch.rect = rect;
    }
  } else if (media === 'video' || media === 'audio') {
    // end 的跨字段约束依赖最终 start（patch 里没有 start 时用现有条目的 start），
    // 因此这里只做类型 / 时长检查；end > start 在 applyAnnotationPatch 里完成。
    if (raw.start !== undefined) {
      const start = checkStart(raw.start, { label, durationSec: limits.durationSec, errors });
      if (start !== null) patch.start = start;
    }
    if (raw.end !== undefined) {
      const end = checkEnd(raw.end, null, { label, durationSec: limits.durationSec, errors });
      if (end !== null) patch.end = end;
    }
  } else if (media === 'image') {
    if (raw.rect !== undefined) {
      const rect = checkRect(raw.rect, { label, errors });
      if (rect !== null) patch.rect = rect;
    }
  }
  if (errors.length > 0) return { patch: null, errors };
  return { patch, errors };
}

/**
 * 应用 update patch。square 必须有 rect、end > start 这类跨字段约束在这里检查。
 *
 * @returns {{entry: object|null, errors: string[]}}
 */
export function applyAnnotationPatch(entry, patch, { media, durationSec = null, label = 'update annotation' } = {}) {
  const errors = [];
  const merged = { ...entry, ...patch };
  if (media === 'pdf') {
    if (merged.type === 'square' && (merged.rect === undefined || merged.rect === null)) {
      errors.push(`${label}: rect is required for a "square" annotation`);
    }
  } else if (media === 'video' || media === 'audio') {
    if (typeof merged.start !== 'number' || !Number.isFinite(merged.start) || merged.start < 0) {
      errors.push(`${label}: start must be a finite number ≥ 0 in seconds (got ${describeValue(merged.start)})`);
    } else if (Number.isFinite(durationSec) && durationSec > 0 && merged.start >= durationSec) {
      errors.push(`${label}: start ${merged.start}s must be less than the media duration ${durationSec}s`);
    }
    if (merged.end !== undefined && merged.end !== null && !(merged.end > merged.start)) {
      errors.push(`${label}: end ${merged.end}s must be greater than start ${merged.start}s`);
    }
    if (Number.isFinite(durationSec) && durationSec > 0 && merged.end > durationSec) {
      errors.push(`${label}: end ${merged.end}s is outside 0..${durationSec}s (the media is ${durationSec}s long)`);
    }
  }
  if (errors.length > 0) return { entry: null, errors };
  return { entry: canonicalAnnotation(media, merged), errors };
}

/* ------------------------------------------------------------------ *
 * 排序与格式化
 * ------------------------------------------------------------------ */

function rectY(entry) {
  return Number.isFinite(entry?.rect?.y) ? entry.rect.y : Number.POSITIVE_INFINITY;
}

function rectX(entry) {
  return Number.isFinite(entry?.rect?.x) ? entry.rect.x : 0;
}

function idNumber(entry) {
  return entryIdNumber(entry?.id, ANNOTATION_ID_PREFIX) ?? 0;
}

/**
 * 按位置排序（稳定排序：位置相同保持原顺序）。
 *   PDF：页 → rect 的 y → x（没有 rect 的排在有 rect 的后面），最后按 id 兜底；
 *   视频/音频：start（允许重叠），相同 start 按 id；
 *   图片：没有位置，保持原顺序。
 */
export function sortAnnotations(entries, media) {
  const list = [...entries];
  if (media === 'pdf') {
    list.sort((a, b) => (a.page - b.page)
      || (rectY(a) - rectY(b))
      || (rectX(a) - rectX(b))
      || (idNumber(a) - idNumber(b)));
  } else if (media === 'video' || media === 'audio') {
    list.sort((a, b) => (a.start - b.start) || (idNumber(a) - idNumber(b)));
  }
  return list;
}

/** 秒 → `HH:MM:SS`（批注结果文本与 VTT 时间戳一致，总是带小时段） */
export function formatAnnotationClock(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 一条批注 → 结果文本的一行（读取侧同格式）：
 *   PDF      `n1 (p.12): note`
 *   视频/音频 `n1 (00:12:34–00:12:39): note`
 *   图片     `n1: note`
 * 多行 note 的续行用 4 个空格缩进（不丢换行）。
 */
export function formatAnnotation(entry, { media, idPrefix = ANNOTATION_ID_PREFIX } = {}) {
  const id = entry?.id ?? `${idPrefix}?`;
  const note = normalizeNote(entry?.note) ?? '(no note)';
  let prefix;
  if (media === 'pdf') {
    prefix = `${id} (p.${entry?.page}): `;
  } else if (media === 'video' || media === 'audio') {
    const end = Number.isFinite(entry?.end) ? `–${formatAnnotationClock(entry.end)}` : '';
    prefix = `${id} (${formatAnnotationClock(entry?.start)}${end}): `;
  } else {
    prefix = `${id}: `;
  }
  return prefix + note.split('\n').join(`\n${NOTE_CONTINUATION_INDENT}`);
}

/**
 * 批注条目适配器：把上面的纯函数接到通用引擎（../bookmark/engine.js）上。
 * 字段：kind 仅用于诊断；其余是引擎调用点。
 */
export const annotationEntryAdapter = Object.freeze({
  kind: 'annotation',
  validateStored: (raw, options) => validateStoredAnnotation(raw, options),
  validateAdd: (raw, options) => validateAddAnnotation(raw, options),
  validateUpdate: (raw, options) => validateUpdateAnnotation(raw, options),
  applyPatch: (entry, patch, options) => applyAnnotationPatch(entry, patch, options),
  canonical: (media, raw) => canonicalAnnotation(media, raw),
  sort: (entries, media) => sortAnnotations(entries, media),
  format: (entry, options) => formatAnnotation(entry, options),
});
