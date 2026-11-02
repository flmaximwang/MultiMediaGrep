// src/server/annotation-view.js —— 读取侧的批注（ticket 9z5.38.4）
//
// media_probe / media_overview / media_locate 只读地展示**一份**批注，来源只取第一个
// 可用者，不跨源合并：
//
//   1. sidecar（<file>.mmgrep.annotation.json）——批注的唯一真相；存在就赢
//   2. 文件自带的批注——PDF 的批注对象（probe.annotationOutline，9z5.38.2 接数据源）
//
// 与书签读取侧（./outline-view.js）对称：
//   - 损坏的 sidecar 不阻断读取：回退到文件自带的批注，并把原因说清楚（sidecarError）；
//   - 没有 sidecar 时 id 由 media/annotation/derive.js 按文件里的顺序（页 → rect.y →
//     rect.x）派生为 n1…nN——与 media_annotate 首次导入完全一致，agent 可以直接拿
//     这些 id 去增删改；
//   - 空 sidecar = 用户把批注删光了：sidecar 是唯一真相源，不回退到文件自带批注。
//
// 行格式与 media_annotate 的结果完全一致，统一由 media/annotation/entries.js 的
// formatAnnotation 渲染（PDF: `n3 (p.12): note`；视频/音频: `n3 (00:12:34–00:12:39):
// note`；图片: `n3: note`）。作者只出现在结构化结果里，文本里永远是纯 note。
//
// 本模块是**只读**的：除了 readAnnotationSidecar（只读文件）以外不碰磁盘——
// 读取侧永远不创建、不修改源文件旁边的任何文件。

import {
  ANNOTATION_ID_PREFIX,
  annotationSidecarPathFor,
  deriveAnnotationsFromOutline,
  formatAnnotation,
  readAnnotationSidecar,
} from '../media/annotation/index.js';
import { countHits } from '../media/match.js';
import { ToolError } from '../media/interface.js';
import { OUTLINE_IMAGE_CONTAINERS } from './outline-view.js';

const PDF_EXTENSION = /\.pdf$/i;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|tiff?|webp|bmp)$/i;

/** overview 里最多内联的批注条数 */
export const ANNOTATION_BLOCK_MAX_ENTRIES = 20;
/** overview 里批注块最多占用的字符数（不含 sidecar 路径行） */
export const ANNOTATION_BLOCK_MAX_CHARS = 2000;

/** 来源标签（文本里说「批注来自哪」） */
const ANNOTATION_SOURCE_LABELS = {
  sidecar: 'sidecar',
  file: "the file's own annotations",
};

function sourceLabel(source) {
  return ANNOTATION_SOURCE_LABELS[source] ?? 'annotations';
}

/**
 * 媒体类型 + 容器 → media_annotate 的四种媒体之一（pdf / video / audio / image）。
 * 装不下批注的文档（txt、office…）返回 null：既没有 sidecar 可读，也没有自带批注。
 */
export function annotationMediaFor({ mediaType, container = null, filePath = null } = {}) {
  if (mediaType === 'video' || mediaType === 'audio') return mediaType;
  if (mediaType !== 'document') return null;
  const containerName = typeof container === 'string' ? container.toLowerCase() : '';
  if (containerName === 'pdf' || PDF_EXTENSION.test(String(filePath ?? ''))) return 'pdf';
  if (OUTLINE_IMAGE_CONTAINERS.has(containerName)) return 'image';
  if (IMAGE_EXTENSION.test(String(filePath ?? ''))) return 'image';
  return null;
}

/**
 * 文件自带的批注 → sidecar 形状的条目。
 *
 * 只有 PDF 有原生批注；9z5.38.2 之前后端还不给 `probe.annotationOutline`，此时返回
 * 空列表并说明原因（读取侧不能因为「还没有数据源」就报错，也不能假装「文件没有批注」）。
 */
function nativeAnnotationsFor({ media, probe }) {
  if (media !== 'pdf') {
    return {
      entries: [],
      uncertain: false,
      reason: `this ${media} has no built-in annotations (annotations come from the sidecar)`,
    };
  }
  const source = probe?.annotationOutline ?? probe?.annotations ?? null;
  if (!source || typeof source !== 'object') {
    return {
      entries: [],
      uncertain: true,
      reason: "this PDF's own annotations cannot be read yet (no annotation reader in the probe)",
    };
  }
  let entries;
  try {
    // 复用 derive.js：id 的派生规则与 media_annotate 首次导入完全一致。
    entries = deriveAnnotationsFromOutline('pdf', source, { idPrefix: ANNOTATION_ID_PREFIX });
  } catch {
    entries = [];
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      entries: [],
      uncertain: false,
      reason: source.reason ?? "this PDF has no annotations of its own",
    };
  }
  return { entries, uncertain: false, reason: null };
}

/**
 * 读 sidecar。只读，绝不创建/修改文件。
 * 损坏（ToolError）→ 返回一句短原因，交给调用方回退到文件自带批注。
 */
async function readSidecarFor({ filePath, media }) {
  const sidecarPath = annotationSidecarPathFor(filePath);
  try {
    const sidecar = await readAnnotationSidecar(sidecarPath, { media, idPrefix: ANNOTATION_ID_PREFIX });
    return { sidecar, sidecarPath, error: null };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { sidecar: null, sidecarPath, error: describeSidecarError(sidecarPath, error) };
  }
}

/** 损坏原因只保留一行（路径 + 第一个具体问题），不把整个 ToolError 堆出去。 */
function describeSidecarError(sidecarPath, error) {
  const message = String(error instanceof Error ? error.message : error ?? '').trim();
  const detail = message.split('\n')
    .slice(1)
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .find(Boolean);
  let text = `the annotation sidecar "${sidecarPath}" could not be read`;
  if (detail) text += ` (${detail})`;
  if (text.length > 240) text = `${text.slice(0, 239)}…`;
  return text;
}

/**
 * 装配唯一的读取侧批注。
 *
 * @returns {Promise<{
 *   available: boolean,
 *   source: 'sidecar'|'file'|null,
 *   media: 'pdf'|'video'|'audio'|'image'|null,
 *   total: number,
 *   entries: Array<object>,
 *   sidecarPath: string|null,
 *   sidecarError: string|null,
 *   reason: string|null,
 * }>}
 */
export async function resolveReadAnnotations({
  filePath,
  mediaType,
  container = null,
  probe = null,
} = {}) {
  const media = annotationMediaFor({ mediaType, container, filePath });
  const base = {
    available: false,
    source: null,
    media,
    total: 0,
    entries: [],
    sidecarPath: null,
    sidecarError: null,
    reason: null,
    // 需要当面告诉用户的一句话（空 sidecar / 还读不到文件自带批注）。
    note: null,
  };
  if (!media) {
    return {
      ...base,
      reason: 'this media type cannot carry annotations (only PDF, image, video and audio can)',
    };
  }

  const { sidecar, sidecarPath, error } = await readSidecarFor({ filePath, media });
  if (!error && sidecar?.exists) {
    if (sidecar.entries.length > 0) {
      return {
        ...base,
        available: true,
        source: 'sidecar',
        total: sidecar.entries.length,
        entries: sidecar.entries,
        sidecarPath: sidecar.path ?? sidecarPath,
      };
    }
    // sidecar 是唯一真相：空 sidecar 说明用户删光了批注，不能回退到文件自带批注。
    return {
      ...base,
      source: 'sidecar',
      sidecarPath: sidecar.path ?? sidecarPath,
      reason: 'the annotation sidecar exists but has no entries',
      note: 'the annotation sidecar exists but has no entries',
    };
  }

  // 没有 sidecar（或 sidecar 损坏）：看文件自带的批注。
  const native = nativeAnnotationsFor({ media, probe });
  if (native.entries.length > 0) {
    return {
      ...base,
      available: true,
      source: 'file',
      total: native.entries.length,
      entries: native.entries,
      sidecarPath: error ? sidecarPath : null,
      sidecarError: error,
    };
  }

  return {
    ...base,
    sidecarPath: error ? sidecarPath : null,
    sidecarError: error,
    reason: error ? `${native.reason} (${error})` : native.reason,
    // 读不到文件自带的批注时明说：0 ≠ 文件没有批注（9z5.38.2 之前就是这个状态）。
    // sidecar 损坏时不再重复说——损坏本身已经是头号说明。
    note: error ? null : (native.uncertain ? native.reason : null),
  };
}

/** 结构化结果里的批注摘要（probe 不倒每一条 note，只报条数与 sidecar 路径）。 */
export function annotationSummary(annotations) {
  return {
    available: Boolean(annotations?.available),
    source: annotations?.source ?? null,
    media: annotations?.media ?? null,
    total: Number.isInteger(annotations?.total) ? annotations.total : 0,
    sidecarPath: annotations?.sidecarPath ?? null,
    sidecarError: annotations?.sidecarError ?? null,
    reason: annotations?.reason ?? null,
    note: annotations?.note ?? null,
  };
}

/**
 * 请求范围里的批注。
 *
 * - PDF：页码在请求页里的；
 * - 视频/录音：与请求时间窗**有重叠**的（起点在窗内，或跨过窗的边界）；
 * - 图片：只有一个位置，全部。
 *
 * @param {object} annotations resolveReadAnnotations 的结果
 * @param {{pages?: number[]|null, window?: {startSec: number|null, endSec: number|null}|null}} range
 */
export function annotationsInRange(annotations, { pages = null, window = null } = {}) {
  const entries = Array.isArray(annotations?.entries) ? annotations.entries : [];
  const media = annotations?.media ?? null;
  if (media === 'pdf') {
    if (!Array.isArray(pages) || pages.length === 0) return entries;
    const wanted = new Set(pages);
    return entries.filter((entry) => wanted.has(entry.page));
  }
  if (media === 'video' || media === 'audio') {
    if (!window || window.startSec === null || window.startSec === undefined) return entries;
    const start = Number(window.startSec);
    const end = window.endSec === null || window.endSec === undefined
      ? Number.POSITIVE_INFINITY
      : Number(window.endSec);
    return entries.filter((entry) => {
      const entryStart = Number(entry.start);
      if (!Number.isFinite(entryStart)) return false;
      const entryEnd = Number.isFinite(Number(entry.end)) ? Number(entry.end) : entryStart;
      return entryStart <= end && entryEnd >= start;
    });
  }
  return entries;
}

/** 损坏的 sidecar → 一行说明（和书签读取侧同款）。 */
function sidecarFallbackNote(annotations) {
  if (!annotations?.sidecarError) return null;
  const fellBack = annotations.available && annotations.source && annotations.source !== 'sidecar';
  return `note: ${annotations.sidecarError}`
    + `${fellBack ? ` — showing ${sourceLabel(annotations.source)} instead.` : '.'}`;
}

/**
 * 需要当面说的一句 note（只说一条：sidecar 坏了就说 sidecar 坏了，
 * 否则说「还读不到文件自带的批注」）。
 */
function annotationNoteLine(annotations) {
  if (!annotations) return null;
  if (annotations.sidecarError) return sidecarFallbackNote(annotations);
  if (annotations.note) return `note: ${annotations.note}`;
  return null;
}

/**
 * 批注块渲染（带预算）。行格式与 media_annotate 的结果一致（`n3 (p.12): note`）。
 *
 * @param {object} annotations resolveReadAnnotations 的结果
 * @param {{entries?: object[]|null, rangeLabel?: string|null,
 *          maxEntries?: number, maxChars?: number}} options
 * @returns {{text: string|null, inlined: number, total: number, inRange: number}}
 */
export function renderAnnotationBlock(annotations, {
  entries = null,
  rangeLabel = null,
  maxEntries = ANNOTATION_BLOCK_MAX_ENTRIES,
  maxChars = ANNOTATION_BLOCK_MAX_CHARS,
} = {}) {
  const media = annotations?.media ?? null;
  const all = Array.isArray(annotations?.entries) ? annotations.entries : [];
  const inRange = Array.isArray(entries) ? entries : all;
  const total = Number.isInteger(annotations?.total) ? annotations.total : all.length;
  if (total === 0 && inRange.length === 0) {
    // 没有批注可展示，但有话要说（sidecar 坏了 / 还读不到文件自带的批注）——别沉默。
    return { text: annotationNoteLine(annotations), inlined: 0, total: 0, inRange: 0 };
  }

  const where = rangeLabel ? ` in ${rangeLabel}` : '';
  const label = sourceLabel(annotations?.source);
  const lines = [];
  let inlined = 0;

  if (inRange.length === 0) {
    lines.push(`annotations: none${where} (${total} in the file, ${label}).`);
  } else {
    lines.push(`annotations (${inRange.length} of ${total}${where}, ${label}):`);
    let used = lines[0].length;
    for (const entry of inRange) {
      if (inlined >= maxEntries) break;
      const line = formatAnnotation(entry, { media, idPrefix: ANNOTATION_ID_PREFIX });
      if (used + 1 + line.length > maxChars) break;
      lines.push(line);
      used += 1 + line.length;
      inlined += 1;
    }
    const hidden = inRange.length - inlined;
    if (hidden > 0) {
      lines.push(`  +${hidden} more annotations (all annotations in structuredContent.annotations)`);
    } else if (inlined === 0) {
      lines.push('  (no annotation fits the inline budget; read structuredContent.annotations)');
    }
  }

  let text = lines.join('\n');
  // 损坏的 sidecar 不提供 "full detail"（路径存在但读不了，指过去只会误导）。
  if (annotations?.sidecarPath && !annotations?.sidecarError) {
    text += `\nfull detail: ${annotations.sidecarPath}`;
  }
  const note = annotationNoteLine(annotations);
  if (note) text += `\n${note}`;
  return { text, inlined, total, inRange: inRange.length };
}

/**
 * probe 文本里的批注行：只报**条数**与 sidecar 路径（不在 probe 里倒每一条 note）。
 */
export function formatProbeAnnotations(result) {
  const annotations = result?.annotations;
  if (!annotations || typeof annotations !== 'object') return [];
  if (!annotations.media) return []; // 这种媒体装不下批注（txt / office）

  const total = Number.isInteger(annotations.total) ? annotations.total : 0;
  const label = annotations.source ? sourceLabel(annotations.source) : 'none';
  const lines = [total > 0 ? `annotations: ${total} (${label})` : 'annotations: 0 (none)'];
  if (annotations.sidecarPath && !annotations.sidecarError) {
    lines.push(`annotation sidecar: ${annotations.sidecarPath}`);
  }
  const note = annotationNoteLine(annotations);
  if (note) lines.push(note);
  return lines;
}

/**
 * 在批注的 note 文本里找命中（和媒体内容的搜索是两回事：命中的是「人写的批注」，
 * 不是转写 / 页面正文）。命中一定标 kind:"annotation" 并带 id。
 */
export function searchAnnotations(annotations, query, { max = 5 } = {}) {
  const entries = Array.isArray(annotations?.entries) ? annotations.entries : [];
  const media = annotations?.media ?? null;
  const needle = String(query ?? '').trim();
  if (!needle || entries.length === 0) return [];

  const hits = [];
  for (const entry of entries) {
    const note = String(entry.note ?? '');
    const { hits: count, fuzzy } = countHits(note, needle);
    if (count <= 0) continue;
    const timed = media === 'video' || media === 'audio';
    const startSec = timed ? Number(entry.start) : null;
    const endSec = timed
      ? (Number.isFinite(Number(entry.end)) ? Number(entry.end) : startSec)
      : null;
    hits.push({
      kind: 'annotation',
      id: entry.id,
      media,
      page: media === 'pdf' && Number.isInteger(entry.page) ? entry.page : null,
      startMs: timed && Number.isFinite(startSec) ? Math.round(startSec * 1000) : null,
      endMs: timed && Number.isFinite(endSec) ? Math.round(endSec * 1000) : null,
      startSec: timed && Number.isFinite(startSec) ? startSec : null,
      endSec: timed && Number.isFinite(endSec) ? endSec : null,
      text: note,
      author: entry.author ?? null,
      hits: count,
      fuzzy,
      source: 'annotation',
      origin: annotations.source ?? null,
      // 文本行与 media_annotate 的结果同形：`n3 (p.12): note`
      line: formatAnnotation(entry, { media, idPrefix: ANNOTATION_ID_PREFIX }),
    });
  }
  return hits.slice(0, Math.max(1, Number(max) || 1));
}

/**
 * locate 文本里的批注命中段。必须明说：这些是**批注**，不是媒体内容。
 */
export function formatAnnotationMatches(annotationMatches, { query = '' } = {}) {
  if (!Array.isArray(annotationMatches) || annotationMatches.length === 0) return [];
  const lines = [`annotation matches for "${query}" (${annotationMatches.length}):`];
  for (const match of annotationMatches) {
    lines.push(`  ${match.line ?? match.id}`);
  }
  lines.push(
    'note: the lines above are ANNOTATIONS — notes written next to the media (sidecar or the file itself), '
      + 'not media content. They are not part of the transcript or the page text.',
  );
  return lines;
}
