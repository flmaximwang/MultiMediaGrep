/**
 * 读取侧的统一目录（ticket 9z5.37.6）。
 *
 * media_probe / media_overview（view:outline|auto）/ media_locate 只展示**一份**
 * 目录，来源只取第一个可用者，不跨源合并、不去重：
 *
 *   1. sidecar（<file>.mmgrep.bookmark.json）——书签的唯一真相；存在就赢
 *   2. 文件自带目录——PDF 书签 / 视频·音频容器章节
 *   3. 从 blocks 的 heading 生成——仅 media_overview，且 >= 5 条（9z5.33）
 *
 * 行格式与 media_bookmark 结果完全一致，统一由 bookmark/entries.js 的 formatEntry
 * 渲染（PDF: `b3  p.12  title`，缩进表达层级；视频/音频: `b3  00:12:34  title`；
 * 图片: `b3  title`）。没有 sidecar 时，id 由 bookmark/derive.js 按文件目录顺序
 * 派生为 b1…bN——与 media_bookmark 首次导入完全一致，agent 可以直接拿这些 id
 * 去增删改。本模块是只读的：除了 readSidecar（只读文件）以外不碰磁盘。
 */

import {
  BOOKMARK_ID_PREFIX,
  deriveEntriesFromOutline,
  deriveEntriesFromProbe,
  formatEntry,
  readSidecar,
  sidecarPathFor,
} from '../media/bookmark/index.js';
import { ToolError } from '../media/interface.js';

/** 文档目录从 heading 生成时的最低条数（9z5.33 拍板）。 */
export const GENERATED_OUTLINE_MIN_HEADINGS = 5;

/** 图片容器：探测器对图片返回 mediaType document，container 是图片格式。 */
export const OUTLINE_IMAGE_CONTAINERS = new Set([
  'png', 'jpeg', 'jpg', 'gif', 'tiff', 'tif', 'webp', 'bmp',
]);

const PROBE_OUTLINE_MAX_DEPTH = 2;
const PROBE_OUTLINE_MAX_ENTRIES = 60;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|tiff?|webp|bmp)$/i;
const PDF_EXTENSION = /\.pdf$/i;

/**
 * 媒体类型 + 容器 → media_bookmark 的四种媒体之一（pdf / video / audio / image）。
 * 不支持书签的文档（txt、office…）返回 null：没有 sidecar 可读，也没有文件自带目录。
 */
export function outlineMediaFor({ mediaType, container = null, filePath = null } = {}) {
  if (mediaType === 'video' || mediaType === 'audio') return mediaType;
  if (mediaType !== 'document') return null;
  const containerName = typeof container === 'string' ? container.toLowerCase() : '';
  if (containerName === 'pdf' || PDF_EXTENSION.test(String(filePath ?? ''))) return 'pdf';
  if (OUTLINE_IMAGE_CONTAINERS.has(containerName)) return 'image';
  if (IMAGE_EXTENSION.test(String(filePath ?? ''))) return 'image';
  return null;
}

/** 文件自带目录（PDF 书签 / 容器章节）→ 派生条目；没有可用条目时 null。 */
function nativeOutlineFor({ media, probeOutline }) {
  if (!media) return null;
  if (!probeOutline || typeof probeOutline !== 'object' || probeOutline.available !== true) return null;
  const rawEntries = Array.isArray(probeOutline.entries) ? probeOutline.entries : [];
  if (rawEntries.length === 0) return null;
  const entries = deriveEntriesFromProbe(media, probeOutline, { idPrefix: BOOKMARK_ID_PREFIX });
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const source = probeOutline.source === 'pdf-bookmarks' || probeOutline.source === 'chapters'
    ? probeOutline.source
    : (media === 'pdf' ? 'pdf-bookmarks' : 'chapters');
  return {
    available: true,
    source,
    generated: false,
    media,
    total: entries.length,
    entries: media === 'pdf' ? withPdfLabels(entries, rawEntries) : entries,
    sidecarPath: null,
    sidecarError: null,
    reason: null,
  };
}

/**
 * 把 PDF 书签的打印页标签（9z5.33 的 label）带到派生条目上，供 structuredContent /
 * manifest.json 使用。id 与位置只由 derive.js 决定；这里只做装饰，且按 derive 的
 * 同一规则（page 为整数 >= 1）对齐，对不上就不加。
 */
function withPdfLabels(entries, rawEntries) {
  const eligible = rawEntries.filter((raw) => Number.isInteger(raw?.page) && raw.page >= 1);
  return entries.map((entry, index) => {
    const raw = eligible[index];
    if (!raw || raw.page !== entry.page) return entry;
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    return label ? { ...entry, label } : entry;
  });
}

/** 从契约 v2 blocks 的 heading 生成目录（仅文档，>= 5 条）。 */
function generatedOutlineFor(mediaType, segments) {
  if (mediaType !== 'document') return null;
  const rawEntries = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const page = Number.isInteger(segment?.page)
      ? segment.page
      : (Number.isInteger(segment?.index) ? segment.index : null);
    for (const block of Array.isArray(segment?.blocks) ? segment.blocks : []) {
      if (block?.type !== 'heading') continue;
      const title = String(block.text ?? '').trim();
      if (!title) continue;
      const level = Number.isInteger(block.level) && block.level > 0 ? Math.min(block.level, 6) : 1;
      rawEntries.push({ level, title, page });
    }
  }
  if (rawEntries.length < GENERATED_OUTLINE_MIN_HEADINGS) return null;
  const entries = deriveEntriesFromOutline('pdf', { entries: rawEntries }, { idPrefix: BOOKMARK_ID_PREFIX });
  if (!Array.isArray(entries) || entries.length < GENERATED_OUTLINE_MIN_HEADINGS) return null;
  return {
    available: true,
    source: 'headings',
    generated: true,
    media: 'pdf',
    total: entries.length,
    entries,
    sidecarPath: null,
    sidecarError: null,
    reason: null,
  };
}

/**
 * 读取 sidecar。只读，绝不创建/修改文件。
 * 损坏（ToolError）→ 返回一句短原因，交给调用方回退到文件自带目录。
 */
async function readSidecarFor({ filePath, media }) {
  const sidecarPath = sidecarPathFor(filePath);
  try {
    const sidecar = await readSidecar(sidecarPath, { media, idPrefix: BOOKMARK_ID_PREFIX });
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
  let text = `the bookmark sidecar "${sidecarPath}" could not be read`;
  if (detail) text += ` (${detail})`;
  if (text.length > 240) text = `${text.slice(0, 239)}…`;
  return text;
}

function unavailableReason({ mediaType, media, probeOutline, includeGenerated }) {
  if (media === 'image') {
    return 'this image has no outline of its own (only a bookmark sidecar can define one)';
  }
  if (mediaType === 'document') {
    if (!includeGenerated) return probeOutline?.reason ?? 'this PDF has no bookmarks (no outline).';
    return `this document has no PDF bookmarks (${probeOutline?.reason ?? 'no outline found'}) `
      + `and fewer than ${GENERATED_OUTLINE_MIN_HEADINGS} headings in the requested pages`;
  }
  return probeOutline?.reason ?? 'this file has no chapters (no chapter metadata in the container)';
}

/**
 * 装配唯一的读取侧目录。
 *
 * @returns {Promise<{
 *   available: boolean,
 *   source: 'sidecar'|'pdf-bookmarks'|'chapters'|'headings'|null,
 *   generated: boolean,
 *   media: 'pdf'|'video'|'audio'|'image'|null,
 *   total: number,
 *   entries: Array<object>,
 *   sidecarPath: string|null,
 *   sidecarError: string|null,
 *   reason: string|null,
 * }>}
 */
export async function resolveReadOutline({
  filePath,
  mediaType,
  container = null,
  probeOutline = null,
  segments = null,
  includeGenerated = false,
}) {
  const media = outlineMediaFor({ mediaType, container, filePath });
  const outline = {
    available: false,
    source: null,
    generated: false,
    media,
    total: 0,
    entries: [],
    sidecarPath: null,
    sidecarError: null,
    reason: null,
  };

  if (media) {
    const { sidecar, sidecarPath, error } = await readSidecarFor({ filePath, media });
    if (error) {
      // 损坏的 sidecar 不阻断读取：回退到文件自带目录，并把原因带上。
      outline.sidecarPath = sidecarPath;
      outline.sidecarError = error;
    } else if (sidecar?.exists) {
      outline.sidecarPath = sidecar.path ?? sidecarPath;
      if (sidecar.entries.length > 0) {
        return {
          ...outline,
          available: true,
          source: 'sidecar',
          total: sidecar.entries.length,
          entries: sidecar.entries,
        };
      }
      // sidecar 是唯一真相：空 sidecar 说明用户删光了书签，不能回退到文件自带目录。
      return {
        ...outline,
        available: false,
        source: 'sidecar',
        reason: 'the bookmark sidecar exists but has no entries',
      };
    }
  }

  const native = nativeOutlineFor({ media, probeOutline });
  if (native) {
    return { ...native, sidecarPath: outline.sidecarPath, sidecarError: outline.sidecarError };
  }

  if (includeGenerated) {
    const generated = generatedOutlineFor(mediaType, segments);
    if (generated) {
      return { ...generated, sidecarPath: outline.sidecarPath, sidecarError: outline.sidecarError };
    }
  }

  const reason = unavailableReason({ mediaType, media, probeOutline, includeGenerated });
  return {
    ...outline,
    reason: outline.sidecarError ? `${reason} (${outline.sidecarError})` : reason,
  };
}

const OUTLINE_SOURCE_LABELS = {
  sidecar: 'sidecar',
  'pdf-bookmarks': 'PDF outline',
  chapters: 'container chapters',
  headings: 'generated from headings',
};

function outlineSourceLabel(outline) {
  return OUTLINE_SOURCE_LABELS[outline?.source] ?? 'outline';
}

function outlineUnitLabel(outline, total) {
  if (outline?.source === 'chapters') return total === 1 ? 'chapter' : 'chapters';
  return total === 1 ? 'entry' : 'entries';
}

/** 首行：来源 + 条数，probe / overview 的指路词不同。 */
function outlineHeader(outline, target, total) {
  const base = `outline: ${outlineSourceLabel(outline)} — ${total} ${outlineUnitLabel(outline, total)}`;
  if (outline?.generated) {
    return `${base} (best-effort: built from block structure; full outline in structuredContent.outline and manifest.json)`;
  }
  if (target === 'probe') return `${base} — use the outline to pick a range`;
  return `${base} — full outline in structuredContent.outline and manifest.json`;
}

/** 文档目录的示例页码范围：第一条有页码的条目往后 4 页（不超过总页数）。 */
export function outlinePageArg(outline, pageCount) {
  const entry = (outline?.entries ?? []).find((item) => Number.isInteger(item?.page));
  if (!entry) return null;
  const start = entry.page;
  const end = Number.isInteger(pageCount) && pageCount >= start ? Math.min(pageCount, start + 4) : start + 4;
  return end > start ? `${start}-${end}` : String(start);
}

/** 视频/录音目录的示例时间范围：第一条的起点到终点（没有终点时给 5 分钟）。 */
export function outlineTimeArg(outline) {
  const entry = (outline?.entries ?? []).find((item) => Number.isFinite(item?.start));
  if (!entry) return { start: 0, end: 300 };
  const start = Number(entry.start.toFixed(2));
  const end = Number.isFinite(entry.end) ? entry.end : entry.start + 300;
  return { start, end: Number(Math.max(end, entry.start + 1).toFixed(2)) };
}

function outlineHintFooter(outline, pageCount) {
  if (outline?.media === 'pdf') {
    const arg = outlinePageArg(outline, pageCount);
    if (arg) return `hint: pick a range with pages, e.g. media_overview({ path, pages: "${arg}" }).`;
    return null;
  }
  if ((outline?.media === 'video' || outline?.media === 'audio') && (outline?.entries ?? []).length > 0) {
    const arg = outlineTimeArg(outline);
    return `hint: pick a range with start/end, e.g. media_overview({ path, start: ${arg.start}, end: ${arg.end} }).`;
  }
  return null;
}

function sidecarFallbackNote(outline) {
  if (!outline?.sidecarError) return null;
  const fellBack = outline.available && outline.source && outline.source !== 'sidecar';
  return `note: ${outline.sidecarError}${fellBack ? ` — showing ${outlineSourceLabel(outline)} instead.` : '.'}`;
}

/**
 * 目录块渲染（带预算）。maxDepth / maxEntries 控展示量，maxChars 控字符预算。
 * 返回的 inlined 是**真正写进文本**的条目数；total 是目录条目总数。
 * 存在（可用的）sidecar 时，最后一行固定是 `full detail: <sidecar path>`。
 */
export function renderOutlineBlock(outline, {
  target = 'overview', pageCount = null, maxDepth = Infinity, maxEntries = Infinity, maxChars = Infinity,
} = {}) {
  const entries = Array.isArray(outline?.entries) ? outline.entries : [];
  const total = Number.isInteger(outline?.total) ? outline.total : entries.length;
  const header = outlineHeader(outline, target, total);
  const footer = target === 'overview' ? outlineHintFooter(outline, pageCount) : null;
  const fallbackNote = sidecarFallbackNote(outline);
  // 损坏的 sidecar 不提供 "full detail"（路径存在但读不了，指过去只会误导）。
  const detailLine = outline?.sidecarPath && !outline?.sidecarError
    ? `full detail: ${outline.sidecarPath}`
    : null;

  // 给 sidecar 的 "full detail" 行预留预算：它是目录块的固定末行，不该被条目挤掉。
  const budget = Number.isFinite(maxChars)
    ? Math.max(0, maxChars - (detailLine ? detailLine.length + 1 : 0))
    : maxChars;

  const lines = [];
  let used = header.length;
  let inlined = 0;
  for (const entry of entries) {
    if (Number(entry?.level) > maxDepth) continue;
    if (inlined >= maxEntries) break;
    const line = formatEntry(entry, { media: outline.media, idPrefix: BOOKMARK_ID_PREFIX });
    if (used + 1 + line.length > budget) break;
    lines.push(line);
    used += 1 + line.length;
    inlined += 1;
  }

  const hidden = Math.max(0, total - inlined);
  if (hidden > 0) {
    const more = target === 'probe'
      ? `  +${hidden} more (full outline in structuredContent.outline)`
      : `  +${hidden} more entries (full outline in structuredContent.outline and manifest.json)`;
    if (used + 1 + more.length <= budget || lines.length === 0) {
      lines.push(more);
      used += 1 + more.length;
    }
  } else if (inlined === 0 && total > 0 && target === 'overview') {
    lines.push('  (no entry fits the inline budget; read the full outline in structuredContent.outline / manifest.json)');
  }

  let text = [header, ...lines].join('\n');
  if (fallbackNote) text += `\n${fallbackNote}`;
  if (footer && text.length + 1 + footer.length <= budget) text += `\n${footer}`;
  if (detailLine) text += `\n${detailLine}`;
  return { text, inlined, total, hidden };
}

/** view:"outline" 但没有目录时的正文（视频/录音必须明确说「没有章节」，不生成内容）。 */
export function noOutlineMessage(outline, mediaType) {
  const reason = String(outline?.reason ?? '').trim().replace(/\.$/, '');
  if (outline?.source === 'sidecar') {
    return `outline: none — ${reason}. Add entries with media_bookmark({ path, add: [...] }), `
      + 'or delete the sidecar to fall back to the file\'s own outline.';
  }
  if (mediaType === 'document') {
    return `outline: none — ${reason || 'no bookmarks and fewer than 5 headings'}. `
      + 'This server does not invent an outline from unstructured text. Use view:"auto" or view:"text" '
      + 'to read the text preview, or read content.md and write your own outline.';
  }
  return `outline: none — no chapters: ${reason || 'this file has no chapters (no chapter metadata in the container)'}. `
    + 'This server never generates an outline for video or audio (it does not call an LLM). '
    + 'Read media_overview({ path }) or a start/end window, then write your own outline from the '
    + 'time-aligned text and the storyboard grids.';
}

/** probe 文本里的目录行：有目录就列，没有就明说（PDF / 章节）。 */
export function formatProbeOutline(result) {
  const outline = result?.outline;
  if (!outline || typeof outline !== 'object') return [];
  if (outline.source === 'sidecar' && !outline.available) {
    return [`outline: none — ${outline.reason ?? 'the bookmark sidecar has no entries.'}`];
  }
  if (outline.available) {
    const block = renderOutlineBlock(outline, {
      target: 'probe',
      pageCount: result.pageCount,
      maxDepth: PROBE_OUTLINE_MAX_DEPTH,
      maxEntries: PROBE_OUTLINE_MAX_ENTRIES,
    });
    return block.text.split('\n');
  }
  if (result.mediaType === 'document') {
    // 没有目录又不是 PDF / 图片：和 9z5.33 一样，不输出一行无意义的 "outline: none"。
    if (!outline.media) return [];
    if (outline.media === 'image' && !outline.sidecarPath && !outline.sidecarError) return [];
    return [`outline: none — ${outline.reason ?? 'this document has no outline.'}`];
  }
  return [`chapters: none — ${outline.reason ?? 'this file has no chapters.'}`];
}
