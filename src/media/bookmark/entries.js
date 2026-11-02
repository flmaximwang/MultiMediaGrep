// src/media/bookmark/entries.js —— 书签条目的规范化 / 校验 / 排序 / 格式化
//
// 侧车 JSON（*.mmgrep.bookmark.json）是书签的唯一真相源；同一个条目结构被用在
// 四个地方，所以这里**不碰文件系统**，只做纯函数：
//   1. 首次写入时从文件自带目录导入（derive.js）；
//   2. 读侧车时校验；
//   3. add / update 操作校验与应用；
//   4. 嵌入器输入与结果文本（格式化）。
//
// 条目形状（按媒体类型）：
//   PDF      { id, title, page, level }    page = 物理页码（1 起），level = 1 起
//   视频/音频 { id, title, start, end? }   秒；end 可省略
//   图片     { id, title }                图片没有位置
//
// 9z5.38.1（media_annotate）复用同一套引擎：它只需要换一份 entry schema（字段
// 校验 / 合并 / 排序 / 格式化），id 前缀与 sidecar 后缀由引擎参数提供。

/** sidecar 版本号；将来格式不兼容时 +1，读侧据此拒绝 */
export const SIDECAR_VERSION = 1;

/** 每一级缩进（PDF 层级在文本结果里的展示宽度） */
const LEVEL_INDENT = '  ';

/** 各媒体类型的位置字段。图片没有位置字段。 */
const POSITION_FIELDS = Object.freeze({
  pdf: Object.freeze(['page']),
  video: Object.freeze(['start', 'end']),
  audio: Object.freeze(['start', 'end']),
  image: Object.freeze([]),
});

/** 该媒体类型的位置字段（返回新数组，调用方可以随便改） */
export function positionFields(media) {
  return [...(POSITION_FIELDS[media] ?? [])];
}

/** 该媒体类型允许的条目字段（不含 id） */
export function entryFields(media) {
  return ['title', ...positionFields(media), ...(media === 'pdf' ? ['level'] : [])];
}

/** 媒体类型是否支持书签 */
export function isBookmarkMedia(media) {
  return Object.hasOwn(POSITION_FIELDS, media);
}

/** 标题归一化：折叠空白 + 去首尾；空标题返回 null（= 非法） */
export function normalizeTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** id 是否形如 `<prefix><正整数>`（b1、b12；不含 b0） */
export function isEntryId(value, idPrefix) {
  if (typeof value !== 'string') return false;
  return new RegExp(`^${escapeRegExp(idPrefix)}[1-9]\\d*$`).test(value);
}

/** id → 数字（非法时 null） */
export function entryIdNumber(value, idPrefix) {
  if (!isEntryId(value, idPrefix)) return null;
  return Number(value.slice(String(idPrefix).length));
}

/** 当前条目里的最大编号 + 1；空集合 → 1 */
export function nextIdNumber(entries, idPrefix) {
  let max = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const n = entryIdNumber(entry?.id, idPrefix);
    if (n !== null && n > max) max = n;
  }
  return max + 1;
}

/** 数值必须是有限数（不接受数字字符串：契约里就是 number） */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerNumber(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
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
 * 校验
 * ------------------------------------------------------------------ */

/**
 * 通用字段检查：未知字段、id 是否允许出现。
 * @returns {string[]} 错误文案（带位置前缀，例如 `add[1]`）
 */
function checkFields(raw, { media, label, errors, idAllowed, requireId }) {
  const allowed = entryFields(media);
  if (!isPlainObject(raw)) {
    errors.push(`${label}: must be an object like { title, ${media === 'pdf' ? 'page' : media === 'image' ? '(no position)' : 'start, end'} }`);
    return;
  }
  if (raw.id !== undefined && !idAllowed) {
    errors.push(`${label}: must not include "id" (ids are assigned by the server; remove the old entry and add a new one to change an id)`);
  }
  if (requireId && raw.id === undefined) {
    errors.push(`${label}: id is required`);
  }
  for (const key of Object.keys(raw)) {
    if (key === 'id') continue;
    if (!allowed.includes(key)) {
      errors.push(`${label}: unknown field "${key}"${allowed.length > 0 ? ` (allowed: ${allowed.join(', ')})` : ''}`);
    }
  }
}

/** 校验标题；返回归一化后的标题（非法时 null） */
function checkTitle(raw, { label, errors }) {
  if (raw.title === undefined) {
    errors.push(`${label}: title is required`);
    return null;
  }
  const title = normalizeTitle(raw.title);
  if (title === null) {
    errors.push(`${label}: title must be a non-empty string (got ${describeValue(raw.title)})`);
  }
  return title;
}

/** PDF 页码：默认必须给（add / update 的最终条目必须有页码） */
function checkPage(value, { label, pageCount, errors }) {
  if (value === undefined) {
    errors.push(`${label}: page is required for a PDF bookmark (1-based physical page)`);
    return null;
  }
  const page = integerNumber(value);
  if (page === null || page < 1) {
    errors.push(`${label}: page must be an integer ≥ 1 (got ${describeValue(value)})`);
    return null;
  }
  if (Number.isInteger(pageCount) && pageCount > 0 && page > pageCount) {
    errors.push(`${label}: page ${page} is outside 1..${pageCount}`);
    return null;
  }
  return page;
}

/** PDF 层级：可省略（默认 1）；给了就必须是 ≥ 1 的整数 */
function checkLevel(value, { label, errors }) {
  if (value === undefined) return 1;
  const level = integerNumber(value);
  if (level === null || level < 1) {
    errors.push(`${label}: level must be an integer ≥ 1 (got ${describeValue(value)})`);
    return null;
  }
  return level;
}

function checkStart(value, { label, durationSec, errors }) {
  if (value === undefined) {
    errors.push(`${label}: start is required for video/audio bookmarks (seconds)`);
    return null;
  }
  const start = finiteNumber(value);
  if (start === null || start < 0) {
    errors.push(`${label}: start must be a finite number ≥ 0 in seconds (got ${describeValue(value)})`);
    return null;
  }
  if (Number.isFinite(durationSec) && durationSec > 0 && start >= durationSec) {
    errors.push(`${label}: start ${start}s is outside 0..${durationSec}s (the media is ${durationSec}s long)`);
    return null;
  }
  return start;
}

function checkEnd(value, start, { label, durationSec, errors }) {
  if (value === undefined) return null;
  const end = finiteNumber(value);
  if (end === null) {
    errors.push(`${label}: end must be a finite number in seconds (got ${describeValue(value)})`);
    return null;
  }
  if (Number.isFinite(start) && end <= start) {
    errors.push(`${label}: end ${end}s must be greater than start ${start}s`);
    return null;
  }
  if (Number.isFinite(durationSec) && durationSec > 0 && end > durationSec) {
    errors.push(`${label}: end ${end}s is outside 0..${durationSec}s (the media is ${durationSec}s long)`);
    return null;
  }
  return end;
}

/**
 * 按固定字段顺序生成规范化条目（JSON 输出稳定，便于 diff 与回读比较）。
 * @param {string} media
 * @param {{id?: string, title: string, page?: number, start?: number, end?: number, level?: number}} raw
 */
export function canonicalEntry(media, raw) {
  const entry = { id: raw.id, title: raw.title };
  if (media === 'pdf') {
    entry.page = raw.page;
    entry.level = raw.level ?? 1;
  } else if (media === 'video' || media === 'audio') {
    entry.start = raw.start;
    if (raw.end !== undefined && raw.end !== null) entry.end = raw.end;
  }
  return entry;
}

/**
 * 校验一条**已存在**于 sidecar 的条目。只做结构校验，不按页数/时长限制
 * （文件可能被换过；限制只针对本次调用新增/更新的值，避免旧条目把整个写操作卡死）。
 *
 * @returns {{entry: object|null, errors: string[]}}
 */
export function validateStoredEntry(raw, { media, idPrefix, label = 'entry' } = {}) {
  const errors = [];
  checkFields(raw, { media, label, errors, idAllowed: true, requireId: false });
  if (!isPlainObject(raw)) return { entry: null, errors };
  if (raw.id === undefined) errors.push(`${label}: id is required`);
  else if (!isEntryId(raw.id, idPrefix)) {
    errors.push(`${label}: id ${describeValue(raw.id)} is not a valid bookmark id (expected ${idPrefix}1, ${idPrefix}2, …)`);
  }
  const title = checkTitle(raw, { label, errors });
  const position = {};
  if (media === 'pdf') {
    position.page = checkPage(raw.page, { label, errors });
    position.level = checkLevel(raw.level, { label, errors });
  } else if (media === 'video' || media === 'audio') {
    position.start = checkStart(raw.start, { label, errors });
    position.end = checkEnd(raw.end, position.start, { label, errors });
    if (position.end === null) delete position.end;
  }
  if (errors.length > 0) return { entry: null, errors };
  return { entry: canonicalEntry(media, { id: raw.id, title, ...position }), errors };
}

/**
 * 校验一条 add 条目。id 由服务端分配，调用方不许传。
 *
 * @returns {{entry: object|null, errors: string[]}}
 */
export function validateAddEntry(raw, { media, limits = {}, label = 'add entry' } = {}) {
  const errors = [];
  checkFields(raw, { media, label, errors, idAllowed: false, requireId: false });
  if (!isPlainObject(raw)) return { entry: null, errors };
  const title = checkTitle(raw, { label, errors });
  const position = {};
  if (media === 'pdf') {
    position.page = checkPage(raw.page, { label, pageCount: limits.pageCount, errors });
    position.level = checkLevel(raw.level, { label, errors });
  } else if (media === 'video' || media === 'audio') {
    position.start = checkStart(raw.start, { label, durationSec: limits.durationSec, errors });
    position.end = checkEnd(raw.end, position.start, { label, durationSec: limits.durationSec, errors });
    if (position.end === null) delete position.end;
  }
  if (errors.length > 0) return { entry: null, errors };
  return { entry: canonicalEntry(media, { title, ...position }), errors };
}

/**
 * 校验一条 update patch。id 必填；至少改一个字段；只允许该媒体的字段。
 *
 * @returns {{patch: object|null, errors: string[]}}
 */
export function validateUpdatePatch(raw, { media, limits = {}, label = 'update entry', idPrefix = 'b' } = {}) {
  const errors = [];
  checkFields(raw, { media, label, errors, idAllowed: true, requireId: true });
  if (!isPlainObject(raw)) return { patch: null, errors };
  if (raw.id !== undefined && !isEntryId(raw.id, idPrefix)) {
    errors.push(`${label}: id ${describeValue(raw.id)} is not a valid bookmark id (expected ${idPrefix}1, ${idPrefix}2, …)`);
  }

  const patch = {};
  const mutable = entryFields(media);
  const hasChange = mutable.some((field) => raw[field] !== undefined);
  if (!hasChange) {
    errors.push(`${label}: provide at least one field to change (${mutable.join(', ')}); the id itself never changes`);
  }
  if (raw.title !== undefined) {
    const title = checkTitle(raw, { label, errors });
    if (title !== null) patch.title = title;
  }
  if (media === 'pdf') {
    if (raw.page !== undefined) {
      const page = checkPage(raw.page, { label, pageCount: limits.pageCount, errors });
      if (page !== null) patch.page = page;
    }
    if (raw.level !== undefined) {
      const level = checkLevel(raw.level, { label, errors });
      if (level !== null) patch.level = level;
    }
  } else if (media === 'video' || media === 'audio') {
    // end 的校验依赖最终 start（patch 里没有 start 时用现有条目的 start），
    // 因此这里只做类型检查；跨字段校验在 applyPatch 里完成。
    if (raw.start !== undefined) {
      const start = checkStart(raw.start, { label, durationSec: limits.durationSec, errors });
      if (start !== null) patch.start = start;
    }
    if (raw.end !== undefined) {
      if (finiteNumber(raw.end) === null) {
        errors.push(`${label}: end must be a finite number in seconds (got ${describeValue(raw.end)})`);
      } else if (Number.isFinite(limits.durationSec) && limits.durationSec > 0 && raw.end > limits.durationSec) {
        errors.push(`${label}: end ${raw.end}s is outside 0..${limits.durationSec}s (the media is ${limits.durationSec}s long)`);
      } else {
        patch.end = raw.end;
      }
    }
  }
  if (errors.length > 0) return { patch: null, errors };
  return { patch, errors };
}

/**
 * 应用 update patch。end ≤ start 这类跨字段约束在这里检查（patch 可能只改其中一个）。
 *
 * @returns {{entry: object|null, errors: string[]}}
 */
export function applyPatch(entry, patch, { media, durationSec = null, label = 'update entry' } = {}) {
  const errors = [];
  const merged = { ...entry, ...patch };
  if (media === 'video' || media === 'audio') {
    if (!Number.isFinite(merged.start)) {
      errors.push(`${label}: start must be a finite number ≥ 0 in seconds`);
    } else if (merged.start < 0) {
      errors.push(`${label}: start must be a finite number ≥ 0 in seconds (got ${describeValue(merged.start)})`);
    } else if (Number.isFinite(durationSec) && durationSec > 0 && merged.start >= durationSec) {
      errors.push(`${label}: start ${merged.start}s is outside 0..${durationSec}s (the media is ${durationSec}s long)`);
    }
    if (merged.end !== undefined && merged.end !== null && !(merged.end > merged.start)) {
      errors.push(`${label}: end ${merged.end}s must be greater than start ${merged.start}s`);
    }
    if (Number.isFinite(durationSec) && durationSec > 0 && merged.end > durationSec) {
      errors.push(`${label}: end ${merged.end}s is outside 0..${durationSec}s (the media is ${durationSec}s long)`);
    }
  }
  if (errors.length > 0) return { entry: null, errors };
  return { entry: canonicalEntry(media, merged), errors };
}

/* ------------------------------------------------------------------ *
 * 排序与格式化
 * ------------------------------------------------------------------ */

/**
 * 按位置排序（稳定排序：位置相同保持原顺序）。
 * 图片没有位置，保持原顺序。
 */
export function sortEntries(entries, media) {
  const list = [...entries];
  if (media === 'pdf') list.sort((a, b) => a.page - b.page);
  else if (media === 'video' || media === 'audio') list.sort((a, b) => a.start - b.start);
  return list;
}

/** 秒 → `mm:ss` / `hh:mm:ss`（书签位置不需要毫秒） */
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 一条书签 → 一行文本，与只读工具的统一目录格式一致：`b3  p.12  标题`。
 * PDF 层级只影响缩进；视频/音频显示起点时间；图片只有 id + 标题。
 */
export function formatEntry(entry, { media, idPrefix = 'b' } = {}) {
  const id = entry?.id ?? `${idPrefix}?`;
  const title = normalizeTitle(entry?.title) ?? '(untitled)';
  if (media === 'pdf') {
    const level = Math.max(1, Math.min(Number(entry?.level) || 1, 6));
    return `${LEVEL_INDENT.repeat(level - 1)}${id}  p.${entry?.page}  ${title}`;
  }
  if (media === 'video' || media === 'audio') {
    return `${id}  ${formatClock(entry?.start)}  ${title}`;
  }
  return `${id}  ${title}`;
}
