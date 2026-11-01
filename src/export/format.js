// src/export/format.js —— 段落/文档的规范化与格式化
// 主格式对齐 docs/mcp-contract.md §9（全文落盘格式）；
// document.json 额外对齐 cangjie-skill 的 SourceDocument Contract v1。

import { createHash } from 'node:crypto';

/** 契约 §2.5：文字来源（可信度口径）。text = 原生文字层 / 纯文本，字符精确；
 *  mixed 只出现在整份 transcript 上（逐页标签不一致）。 */
export const SOURCE_VALUES = Object.freeze(['subtitle', 'text', 'ocr', 'asr', 'visual', 'mixed', 'none']);

/** 契约 §2.5：来源渠道口径。textlayer = PDF 原生文字层。 */
export const ORIGIN_VALUES = Object.freeze(['file', 'embedded', 'textlayer', 'asr', 'ocr', 'none']);

/** cangjie 契约里 element.type 的枚举 */
export const ELEMENT_TYPES = Object.freeze([
  'heading', 'paragraph', 'list', 'table', 'image', 'formula', 'transcript', 'frame', 'code',
]);

/** 本项目在 cangjie 契约枚举里的 media_type 取值 */
export const MEDIA_TYPES = Object.freeze([
  'markdown', 'txt', 'pdf', 'html', 'epub', 'docx', 'pptx', 'xlsx', 'subtitle', 'audio', 'video',
]);

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** 归一化文本：去首尾空白 + 折叠空白，保证同一段话的 hash 稳定 */
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function contentHash(text) {
  return `sha256:${sha256Hex(normalizeText(text))}`;
}

/**
 * source_id：稳定 ID，「文件改名不得自动变成新来源」。
 * 用文件名的哈希（不含目录）：改名后仍指向同一个来源，版本差异由 version_id 区分。
 */
export function sourceIdFor(basename) {
  const base = String(basename ?? '').trim().toLowerCase();
  return `src-${sha256Hex(base).slice(0, 12)}`;
}

export function versionIdFromSha256(hex) {
  return `sha256:${String(hex).toLowerCase()}`;
}

function pad6(n) {
  return String(n).padStart(6, '0');
}

function nullableInt(value, field) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${field} 必须是整数（毫秒或页码），收到：${value}`);
  return n;
}

function nullableNumber(value, field) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} 必须是有限数字，收到：${value}`);
  return n;
}

function toBbox(bbox) {
  if (!bbox) return null;
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error(`bbox 必须是 4 个数字（x, y, w, h），收到：${JSON.stringify(bbox)}`);
  }
  return bbox.map(Number);
}

/**
 * 规范化一条段落（契约 §9.2 的 segments 模型）。
 * 输入：{ startMs, endMs, text, page, speaker, source, origin, assetRef, bbox, confidence }
 */
export function normalizeSegment(input, index) {
  if (!input || typeof input !== 'object') throw new Error('segment 必须是对象');
  const startMs = nullableInt(input.startMs, 'startMs');
  const endMs = nullableInt(input.endMs, 'endMs');
  const page = nullableInt(input.page, 'page');
  const source = input.source ?? 'none';
  const origin = input.origin ?? 'none';
  if (!SOURCE_VALUES.includes(source)) throw new Error(`未知 source：${source}（合法值：${SOURCE_VALUES.join(', ')}）`);
  if (!ORIGIN_VALUES.includes(origin)) throw new Error(`未知 origin：${origin}（合法值：${ORIGIN_VALUES.join(', ')}）`);
  if (startMs !== null && endMs !== null && endMs < startMs) {
    throw new Error(`endMs(${endMs}) 不能早于 startMs(${startMs})`);
  }
  const confidence = input.confidence === null || input.confidence === undefined ? null : Number(input.confidence);
  if (confidence !== null && (Number.isNaN(confidence) || confidence < 0 || confidence > 1)) {
    throw new Error(`confidence 必须在 0..1 之间，收到：${input.confidence}`);
  }
  return {
    index: index + 1,
    startMs,
    endMs,
    startSec: startMs === null ? null : startMs / 1000,
    endSec: endMs === null ? null : endMs / 1000,
    text: String(input.text ?? ''),
    page,
    speaker: input.speaker ? String(input.speaker) : null,
    source,
    origin,
    assetRef: input.assetRef ? String(input.assetRef) : null,
    bbox: toBbox(input.bbox),
    confidence,
  };
}

export function normalizeSegments(items) {
  if (!Array.isArray(items)) throw new Error('segments 必须是数组');
  return items.map((item, i) => normalizeSegment(item, i));
}

/**
 * 毫秒 → mm:ss.mmm（超过一小时用 hh:mm:ss.mmm）。
 * 契约 §9.1 的 content.md 段标题格式。
 */
export function formatTimestamp(ms) {
  if (ms === null || ms === undefined) return null;
  const total = Math.max(0, Math.round(Number(ms)));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const mmm = String(milli).padStart(3, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`;
}

/** 秒 → "600.00" 之类的短表示（契约 §9.1 的 duration 行） */
export function formatSeconds(sec) {
  if (sec === null || sec === undefined) return null;
  return Number(sec).toFixed(2);
}
