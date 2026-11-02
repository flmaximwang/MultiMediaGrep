// src/export/index.js —— 全文落盘：给下游蒸馏器的材料
// 主格式对齐 docs/mcp-contract.md §9：
//   content.md      人读的 Markdown，按时间段/页码分节
//   segments.jsonl  一行一个 segment（契约 §9.2 的字段 + 扩展字段）
//   manifest.json   本次导出的元信息（契约 §9.3 的字段 + 扩展字段）
// 另加一个可选件：
//   document.json   cangjie-skill SourceDocument Contract v1（下游蒸馏器直接可吃）

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ELEMENT_TYPES,
  MEDIA_TYPES,
  contentHash,
  formatSeconds,
  formatTimestamp,
  normalizeSegments,
  normalizeText,
  sha256Hex,
  sourceIdFor,
  versionIdFromSha256,
} from './format.js';

export const EXPORT_VERSION = 1;
export const GENERATOR = Object.freeze({ name: 'multimediagrep', version: '0.2.0' });

/** content.md 的段标题：时间区间用「mm:ss.mmm – mm:ss.mmm」，文档用「Page N」 */
function segmentHeading(segment) {
  if (segment.page !== null && segment.page !== undefined) return `Page ${segment.page}`;
  const start = formatTimestamp(segment.startMs);
  const end = segment.endMs === null ? null : formatTimestamp(segment.endMs);
  return end ? `${start} – ${end}` : start;
}

/**
 * content.md（契约 §9.1）
 * 首行是绝对路径，随后是元信息列表，再按段落分节。
 */
export function renderContentMd({
  source,
  segments,
  transcript = null,
  generatedAtMs = null,
  mediaType,
}) {
  const lines = [];
  lines.push(`# ${source?.path ?? 'unknown'}`);
  lines.push('');
  lines.push(`- mediaType: ${mediaType ?? source?.mediaType ?? 'unknown'}`);
  if (source?.durationSec !== undefined && source?.durationSec !== null) {
    lines.push(`- duration: ${formatSeconds(source.durationSec)} s`);
  }
  if (source?.pageCount !== undefined && source?.pageCount !== null) {
    lines.push(`- pages: ${source.pageCount}`);
  }
  if (transcript) {
    const provider = transcript.provider ? `${transcript.provider}${transcript.model ? ` / ${transcript.model}` : ''}` : null;
    const bits = `${transcript.source}${provider ? ` (${provider})` : ''}${transcript.language ? `, language: ${transcript.language}` : ''}`;
    lines.push(`- transcript: ${bits}`);
  }
  if (generatedAtMs !== null) {
    lines.push(`- generated: ${new Date(generatedAtMs).toISOString()}`);
  }
  lines.push('');
  for (const segment of segments) {
    lines.push(`## ${segmentHeading(segment)}`);
    lines.push('');
    if (segment.text) {
      lines.push(segment.text);
      lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** segments.jsonl（契约 §9.2）：一行一个 JSON 对象，不是数组 */
export function renderSegmentsJsonl(segments) {
  return `${segments.map((s) => JSON.stringify({
    index: s.index,
    startMs: s.startMs,
    endMs: s.endMs,
    startSec: s.startSec,
    endSec: s.endSec,
    text: s.text,
    page: s.page,
    speaker: s.speaker,
    source: s.source,
    origin: s.origin,
    ...(s.assetRef ? { assetRef: s.assetRef } : {}),
    ...(s.bbox ? { bbox: s.bbox } : {}),
    ...(s.confidence !== null && s.confidence !== undefined ? { confidence: s.confidence } : {}),
    contentHash: contentHash(s.text),
  })).join('\n')}\n`;
}

/** manifest.json（契约 §9.3） */
export function buildManifest({
  tool = 'media_overview',
  generatedAtMs,
  source,
  window = null,
  pages = null,
  transcript = null,
  overview = null,
  outline = null,
  provider = null,
  warnings = [],
  extra = {},
}) {
  return {
    version: EXPORT_VERSION,
    tool,
    generatedAtMs,
    source: source
      ? {
        path: source.path ?? null,
        mediaType: source.mediaType ?? null,
        sizeBytes: source.sizeBytes ?? null,
        modifiedMs: source.modifiedMs ?? null,
        sha256: source.sha256 ?? null,
      }
      : null,
    window: window
      ? {
        startMs: window.startMs ?? null,
        endMs: window.endMs ?? null,
        startSec: window.startMs === null || window.startMs === undefined ? null : window.startMs / 1000,
        endSec: window.endMs === null || window.endMs === undefined ? null : window.endMs / 1000,
      }
      : null,
    pages,
    transcript: transcript
      ? {
        source: transcript.source ?? null,
        provider: transcript.provider ?? null,
        model: transcript.model ?? null,
        language: transcript.language ?? null,
        segmentCount: transcript.segmentCount ?? null,
        file: transcript.file ?? null,
      }
      : null,
    overview,
    outline,
    provider,
    warnings,
    ...extra,
  };
}

/**
 * document.json —— cangjie-skill SourceDocument Contract v1。
 * 契约说明「外部预处理仓库必须遵守」，本项目正是那个预处理仓库。
 */
export function buildCangjieDocument({ source, segments, mediaType, language, title, sourceId, versionId }) {
  if (!MEDIA_TYPES.includes(mediaType)) {
    throw new Error(`media_type 不在 cangjie 契约枚举内：${mediaType}（枚举：${MEDIA_TYPES.join(', ')}）`);
  }
  const elements = segments.map((segment, i) => {
    const type = segment.page !== null && segment.page !== undefined
      ? (segment.source === 'ocr' ? 'paragraph' : 'paragraph')
      : (segment.source === 'subtitle' || segment.source === 'asr' ? 'transcript' : 'frame');
    if (!ELEMENT_TYPES.includes(type)) throw new Error(`未知 element.type：${type}`);
    const element = {
      element_id: `el-${String(i + 1).padStart(6, '0')}`,
      type,
      text: segment.text ?? '',
      heading_path: [],
      page: segment.page ?? null,
      time_start_ms: segment.startMs ?? null,
      time_end_ms: segment.endMs ?? null,
      bbox: segment.bbox ?? null,
      asset_ref: segment.assetRef ?? null,
      confidence: segment.confidence ?? null,
      content_hash: contentHash(segment.text ?? ''),
    };
    if (segment.source) element.source = segment.source;
    return element;
  });
  return {
    schema_version: 1,
    source_id: sourceId,
    version_id: versionId,
    title,
    media_type: mediaType,
    language: Array.isArray(language) && language.length ? language.map(String) : ['und'],
    parser: `${GENERATOR.name}@${GENERATOR.version}`,
    elements,
  };
}

/**
 * 写出全部文件。
 * 返回各文件绝对路径 + manifest。
 */
export async function writeExport({
  outDir,
  segments,
  source,
  mediaType,
  tool = 'media_overview',
  transcript = null,
  overview = null,
  outline = null,
  window = null,
  pages = null,
  provider = null,
  warnings = [],
  language = ['und'],
  title,
  generatedAtMs = Date.now(),
  writeCangjieDocument = true,
}) {
  await mkdir(outDir, { recursive: true });
  const normSegments = normalizeSegments(segments);

  const contentMd = renderContentMd({ source, segments: normSegments, transcript, generatedAtMs, mediaType });
  const segmentsJsonl = renderSegmentsJsonl(normSegments);

  const basename = source?.path ? path.basename(source.path) : 'unknown';
  const sourceId = sourceIdFor(basename);
  const versionId = versionIdFromSha256(source?.sha256 ?? sha256Hex(basename));

  const document = writeCangjieDocument
    ? buildCangjieDocument({
      source,
      segments: normSegments,
      mediaType,
      language,
      title: title ?? basename.replace(/\.[^.]+$/, ''),
      sourceId,
      versionId,
    })
    : null;
  const documentJson = document ? `${JSON.stringify(document, null, 2)}\n` : null;

  const manifest = buildManifest({
    tool,
    generatedAtMs,
    source,
    window,
    pages,
    transcript: transcript ? { ...transcript, segmentCount: normSegments.length } : null,
    overview,
    outline,
    provider,
    warnings,
    extra: {
      generator: GENERATOR,
      document: document
        ? { source_id: document.source_id, version_id: document.version_id, element_count: document.elements.length }
        : null,
      counts: normSegments.reduce((acc, s) => {
        const key = s.page !== null && s.page !== undefined ? 'page' : 'segment';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    },
  });
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  const files = {
    content: { name: 'content.md', body: contentMd },
    segments: { name: 'segments.jsonl', body: segmentsJsonl },
    manifest: { name: 'manifest.json', body: manifestJson },
    ...(documentJson ? { document: { name: 'document.json', body: documentJson } } : {}),
  };

  const written = {};
  for (const [key, file] of Object.entries(files)) {
    const target = path.join(outDir, file.name);
    await writeFile(target, file.body, 'utf8');
    written[key] = target;
  }

  return {
    outDir,
    contentPath: written.content,
    segmentsPath: written.segments,
    manifestPath: written.manifest,
    documentPath: written.document ?? null,
    manifest,
    document,
    segments: normSegments,
  };
}

/**
 * 高层入口：一次媒体分析 → 材料落盘。
 * source: { path, mediaType, kind, sha256, sizeBytes, modifiedMs, durationMs, durationSec, pageCount }
 */
export async function exportAnalysis({
  outDir,
  source,
  mediaType,
  segments,
  language = ['und'],
  title,
  transcript = null,
  overview = null,
  outline = null,
  window = null,
  pages = null,
  provider = null,
  warnings = [],
  tool = 'media_overview',
  generatedAtMs = Date.now(),
  writeCangjieDocument = true,
}) {
  if (!source?.path) throw new Error('exportAnalysis 需要 source.path');
  return writeExport({
    outDir,
    segments,
    source,
    mediaType,
    tool,
    transcript,
    overview,
    outline,
    window,
    pages,
    provider,
    warnings,
    language,
    title,
    generatedAtMs,
    writeCangjieDocument,
  });
}

export { normalizeSegments, contentHash, sourceIdFor, versionIdFromSha256, formatTimestamp, normalizeText };
