// src/server/tools.js —— 4 个 MCP 工具的定义与 handler
//
// 分工（重要）：
//   - 本文件负责**参数校验 + 分派 + 结果信封**（content blocks / structuredContent / 文本清单）。
//   - 真正的媒体处理（取帧、转写、栅格化）由 src/backend/<type>/ 负责，见 backends.js。
//   - 工具描述逐字来自 docs/mcp-contract.md §4.1 / §5.1 / §6.1 / §7.1，不要改写。
//
// 校验一律复用 src/media/interface.js：validatePath / parsePages / validateTimeRange / validateCrop。

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { formatTimestamp } from '../export/format.js';
import { exportAnalysis } from '../export/index.js';
import { detectMediaType } from '../media/detect.js';
import { DOC_SNIPPET_RADIUS, buildSnippet, countHits } from '../media/match.js';
import { ROLLING_SUBTITLE_WARNING } from '../media/subtitles.js';
import {
  METHOD_MATRIX,
  ToolError,
  createDispatcher,
  parsePages,
  validateCrop,
  validatePath,
  validateTimeRange,
} from '../media/interface.js';
import { splitSentences } from '../media/sentences.js';
import { guardToolHandler } from './errors.js';
import {
  DEFAULT_MAX_IMAGE_TOKENS,
  DEFAULT_MAX_TEXT_INLINE_CHARS,
  providerApiKeyEnv,
  providerEnv,
} from './config.js';
import {
  IMAGE_LIMITS,
  budgetReport,
  describeImages,
  planImageBudget,
  validateImageShape,
  validateProducedImages,
} from './images.js';

/* ------------------------------------------------------------------ *
 * 工具描述（契约 §4.1–§7.1，逐字复制）
 * ------------------------------------------------------------------ */

export const PROBE_DESCRIPTION = `Inspect a local media file — video, audio recording, or document — and report what it is:
duration, resolution, page count, codec, available tracks (audio / subtitle / text layer), and
whether transcription (ASR) and OCR are available for this file.
(读取本地媒体的元信息：时长、分辨率、页数、编码、可用轨道（音轨 / 字幕轨 / 文本层），
以及能否做 ASR / OCR 的初判。)

Call this FIRST on any file you have not inspected yet. It costs no image tokens and decodes
nothing. Then pick the right next tool:
- video / audio  -> media_overview to read it
- document       -> media_overview to see page thumbnails and per-page text
- a specific moment or page -> media_zoom for a close-up
- "where was X said / on which page" -> media_locate for a timestamp or a page number

For documents it also checks whether the text layer looks unreliable — U+FFFD replacement
characters, private-use characters, isolated single letters, symbol noise — and, when it does,
points at media_overview({ path, ocr: "force" }) to re-recognize the pages.
(文档文字层看起来不可靠时会提示，可用 ocr: "force" 强制重新识别)

For audio it also reports a quick health check — average level, speech ratio and silence ratio
— so you know whether the recording actually contains audible speech before you spend an ASR
call on it. A recording that is effectively silent is reported as such and is never sent to ASR
(no hallucinated transcript).

This server never downloads anything and never calls an LLM: you always pass a local absolute
path, and it only prepares images and text for your own model to look at.`;

export const OVERVIEW_DESCRIPTION = `Build an overview of a local media file so you can read it without guessing.
(生成媒体总览：视频出分镜宫格图与按时间对齐的文本清单；录音出带时间轴的转写；文档出页面缩略图与每页文字。)

What you get depends on the media:
- video    : one or more numbered storyboard grids (each cell carries its cell number) plus a
             time-aligned text index of the cells
- audio    : a timestamped transcript, segment by segment
- document : a grid of page thumbnails plus page text, when a document parser is configured

For DOCUMENTS, ocr: "auto" (default) uses the PDF text layer where one exists and calls the OCR
provider only for pages without one; ocr: "force" re-recognizes every requested page with the
OCR provider, even pages that already have a text layer, and tags them (ocr). Use force when
media_probe says "text layer: looks unreliable" or when the extracted text is visibly garbled.
Forced results are cached separately from auto. (文档：ocr: "force" = 强制重新 OCR / 重新识别文字层)

Pass images: 0 for a text-only, zero-pixel overview: no grid is rendered and no frame is
decoded (a video costs no ffmpeg work at all), so you get only the transcript — or the page
text for a document — and the reported budget is all zeros. Use it when you only need the words.

TEXT SOURCE ORDER — subtitles first, ASR only as a fallback:
1. a subtitle you select explicitly (external subtitle file, track index or language code),
2. the subtitle track embedded in the container,
3. a subtitle file with the same base name in the same directory (a.srt next to a.mp4),
4. ASR — only when none of the above exists and an ASR provider is configured.
Every segment is tagged with its source. subtitle = from a subtitle file/track; usually the
author's words, but may be auto-generated: check names and numbers against the frame.
asr = machine transcription: names, numbers and jargon are often wrong, so do NOT quote an ASR
segment verbatim and do not present it as the speaker's exact words. visual = there is no text
at all, only the picture.

The storyboard grid is for FINDING things, not for reading them: cells are small, so text
inside a cell is usually unreadable. To read text on screen, call media_zoom on that moment
and read the cropped single frame.

The full text is NOT inlined. It is written to disk, and the text of the result ends with a line
like "full text: /abs/path/content.md (segments.jsonl, manifest.json in the same directory)".
That absolute path is what you read: content.md is the readable full text, segments.jsonl has
one segment per line, manifest.json records what was produced and how. Read those files section
by section and summarise them in chunks yourself — do not ask for the same range again just to
get more inline text. If the export could not be written, the line reads
"full text: NOT written — <reason>" instead.

The inline text is a PREVIEW. It is complete when the requested range fits (the result says
"complete text ... nothing omitted"); otherwise it is SAMPLED from complete units — document
sentences, video/audio transcript segments — and the result carries a line like
"preview: sampled 84 of 312 sentences across pages 1-28; not represented: 2-6, 8-12". Sampling
never drops a whole page silently: every requested page gets at least one unit when the budget
allows, pages that could not be represented are listed, and a single over-long unit is
truncated with a trailing "…[+N chars]". Read content.md when you need the complete text.

Always call media_probe first: it tells you how long the file is, whether a subtitle source
exists, and which transcript source applies, for free. Long media must be narrowed with
start/end (video, audio) or pages (document) — one giant grid of a two-hour film gives you
illegible cells and spoils the ending. Follow the continuation hint in the result to page
through the rest.`;

export const ZOOM_DESCRIPTION = `Get a close-up of one moment in a local video, or one page of a local document, returned as a
single image. (取本地视频某一时刻的特写单帧，或本地文档某一页的整页 / 局部放大图。)

Use it after media_overview when one cell or page needs a closer look: "what exactly is on
screen at 01:12?" "what does line 3 of page 7 say?"

For video, pass at (a single timestamp) or start/end (a window — the sharpest frame inside it
is returned, and the exact timestamp is reported back). For a document, pass page, optionally
with crop. crop is {x, y, width, height}, each a fraction 0..1 of the frame or page, origin
top-left.

Keep it to one frame. It costs roughly 1,900 vision tokens — far more than a whole overview
cell. Zoom the parts that matter instead of re-scanning the file.

This is the ONLY tool whose image is meant for reading. A storyboard cell is a few hundred
pixels wide and the text inside it is unreadable; a cropped single frame at up to 1600 px is
readable. So: locate in the overview grid, then zoom to read. The returned image is always
source "visual" — what you read off it is your own reading of pixels, not a transcript, so
treat it as an observation rather than a quotation.`;

export const LOCATE_DESCRIPTION = `Find where something appears in a local media file and return its position: a timestamp
(milliseconds and seconds) for a video or recording, a page number for a document.
(定位：给一段文本或关键词，返回它在视频 / 录音里的时间戳，在文档里的页码。)

Use it when you know roughly what was said but not when ("where does it mention X"), or when
you need to know which page a phrase is on. Matching ignores punctuation, spacing and case,
and works for both Chinese and English. Long phrases match better than single characters.

For a video or recording, each match is a time window with a match score (0..1) and the
matched line. For a document, each match is a page: the page number, how many times the
query appears on that page (hits), and a short snippet around the first hit — never the
whole page. Pages that matched but did not fit are listed as "N more pages match: ...".
Read a full page with media_overview({ path, pages }).

For DOCUMENTS, ocr: "auto" (default) searches the PDF text layer where one exists and OCRs only
pages without one; ocr: "force" re-recognizes every requested page with the OCR provider first,
even pages that already have a text layer, and tags those matches (ocr). Use force when
media_probe says "text layer: looks unreliable". Forced results are cached separately from auto.
(文档：ocr: "force" = 强制重新 OCR / 重新识别文字层)

Text only by default — no image, no pixels spent. Add includeFrame: true to also get the
picture at the best match (one image, roughly 1,900 vision tokens).

A transcript is required: the embedded subtitle track, a subtitle you select explicitly, or ASR
configured via MMGREP_ASR_PROVIDER. Subtitles win over ASR. If none is available this tool
says so instead of guessing. Use media_overview if you only need the visuals.

Each match is tagged with its source. A match whose source is "asr" came from machine
transcription, so the wording may be wrong (names, numbers, jargon) — do not present it as the
speaker's exact words.`;

/* ------------------------------------------------------------------ *
 * 参数 schema
 *
 * 约定：数值参数用 z.number()（不用 z.number().int()），这样越界 / 非整数时
 * 由我们自己的校验器给出契约 §2.2 / §10.2 的原文案，而不是 zod 的通用报错。
 * 每个字段的 describe 都标注适用媒体类型。
 * ------------------------------------------------------------------ */

const PATH_PARAM = z.string().describe(
  'Absolute path to a LOCAL file: video, audio recording, or document. URLs and relative paths are rejected — this server never downloads anything. (本地文件绝对路径)',
);

const SUBTITLE_PARAM = z.union([z.string(), z.number()]).optional().describe(
  'Choose the subtitle source explicitly (video and audio only, one parameter for all forms). '
  + 'An absolute path to a local subtitle file (.srt, .vtt, .ass, .ssa); '
  + 'a non-negative integer = the ffprobe stream index of a text subtitle track; '
  + 'any other string = a language code matched against track tags.language (case-insensitive; "zh" also matches '
  + '"chi"/"zho", "en" matches "eng"). An explicit choice never falls back: if it cannot be used, media_probe '
  + 'only reports the reason and the other tools fail with INVALID_ARGUMENT. Omit it for the automatic order '
  + '(embedded text track, then a sibling subtitle file, then ASR). (显式选择字幕来源：文件路径 / 字幕轨序号 / 语言码)',
);

const TRANSCRIPT_PARAM = z.enum(['auto', 'subtitle', 'off']).optional().describe(
  '"auto" (default): use subtitles first (explicit subtitle selection, embedded track, sibling file), ASR only as a fallback. '
  + '"subtitle": read subtitles only and never call ASR; if there is no subtitle source the result is empty and says why. '
  + '"off": no transcription at all, neither subtitles nor ASR; visuals only. Applicable to video and audio only.',
);

const START_PARAM = z.number().optional().describe(
  'Window start in seconds (closed interval, both ends included). Applicable to video and audio only; document media uses "pages" instead. Default 0. (起点，秒)',
);

const END_PARAM = z.number().optional().describe(
  'Window end in seconds (closed interval, both ends included). Applicable to video and audio only. Defaults to the end of the media; a value past the end is clipped and reported. (终点，秒)',
);

const SEGMENT_PARAM = z.number().optional().describe(
  'Window length in seconds (30-3600, default 300), used when only "start" is given. Applicable to video and audio only.',
);

const PAGES_PARAM = z.string().optional().describe(
  'Page range for document media: comma-separated 1-based page numbers and closed ranges, e.g. "3-10,15". Not applicable to video or audio. (页码范围)',
);

const OCR_PARAM = z.enum(['auto', 'force']).optional().describe(
  'Document media only: how to obtain page text. "auto" (default) uses the PDF text layer where one exists and OCR only for pages without one. '
  + '"force" re-recognizes every requested page with the OCR provider even if it already has a text layer, and tags those pages (ocr); use it when '
  + 'media_probe says "text layer: looks unreliable" or the extracted text is garbled. Forced results are cached separately from "auto". '
  + 'Requires a configured OCR provider; not applicable to video or audio. (文档：ocr auto 默认；force = 强制重新 OCR / 重新识别文字层)',
);

const CELLS_PARAM = z.number().optional().describe(
  'Cells per puzzle image: storyboard shots for video, page thumbnails for document. 1-16; default 9 for video and 6 for document. Applicable to video and document only. (每张拼图的格数)',
);

const IMAGES_PARAM = z.number().optional().describe(
  'How many puzzle images to return: 0-4, default 2. Use 0 for the text-only mode: zero pixels — for video nothing is scanned '
  + 'and no frame is decoded, for audio no waveform is drawn, for document no page is rendered; only the transcript '
  + '(or page text) comes back and the budget is all zeros. Applicable to video and document; audio accepts 0 only. (返回几张拼图；0 = 纯文本模式)',
);

const MAX_EDGE_PARAM = z.number().optional().describe(
  'Longest edge of each image in pixels: 256-1600. Default 1280 for overview, 1600 for zoom. Applicable to video and document only. (单张图最长边)',
);

const ENVELOPE_PARAM = z.boolean().optional().describe(
  'Attach an audio envelope waveform image (default false). Applicable to audio recordings only. (音频包络图)',
);

const AT_PARAM = z.number().optional().describe(
  'Exact timestamp in seconds for a video frame. Mutually exclusive with start/end. Applicable to video only. (精确时刻，秒)',
);

const PAGE_PARAM = z.number().optional().describe(
  '1-based page number to render. Required for document media; not applicable to video. (页码)',
);

const CROP_PARAM = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
}).optional().describe(
  'Crop rectangle {x, y, width, height}: all four required, each a fraction 0..1 of the frame or page, origin top-left. Applicable to video and document only. (裁切区域，比例制)',
);

const QUERY_PARAM = z.string().describe(
  'Text or keyword to find. Matching ignores punctuation, spacing and case; Chinese and English both work. (要找的文本 / 关键词)',
);

const MAX_MATCHES_PARAM = z.number().optional().describe(
  'Maximum number of matches to return: 1-20, default 5. (最多返回几条匹配)',
);

const INCLUDE_FRAME_PARAM = z.boolean().optional().describe(
  'Also return one picture at the best match (default false). Applicable to video and document only. (是否附带最佳匹配处的画面)',
);

/** 每个工具的 zod raw shape（`.strict()`：未知参数直接拒绝，不静默吞掉） */
export const TOOL_SHAPES = Object.freeze({
  media_probe: {
    path: PATH_PARAM,
    subtitle: SUBTITLE_PARAM,
    transcript: TRANSCRIPT_PARAM,
  },
  media_overview: {
    path: PATH_PARAM,
    subtitle: SUBTITLE_PARAM,
    transcript: TRANSCRIPT_PARAM,
    start: START_PARAM,
    end: END_PARAM,
    segment: SEGMENT_PARAM,
    pages: PAGES_PARAM,
    ocr: OCR_PARAM,
    cells: CELLS_PARAM,
    images: IMAGES_PARAM,
    maxEdge: MAX_EDGE_PARAM,
    envelope: ENVELOPE_PARAM,
  },
  media_zoom: {
    path: PATH_PARAM,
    at: AT_PARAM,
    start: START_PARAM,
    end: END_PARAM,
    page: PAGE_PARAM,
    crop: CROP_PARAM,
    maxEdge: MAX_EDGE_PARAM,
  },
  media_locate: {
    path: PATH_PARAM,
    query: QUERY_PARAM,
    max: MAX_MATCHES_PARAM,
    subtitle: SUBTITLE_PARAM,
    transcript: TRANSCRIPT_PARAM,
    start: START_PARAM,
    end: END_PARAM,
    segment: SEGMENT_PARAM,
    pages: PAGES_PARAM,
    ocr: OCR_PARAM,
    includeFrame: INCLUDE_FRAME_PARAM,
  },
});

/* ------------------------------------------------------------------ *
 * 参数 × 媒体适用性（契约 §2.2）
 * ------------------------------------------------------------------ */

const ALL_MEDIA = Object.freeze(['video', 'audio', 'document']);

/**
 * 每个参数适用的媒体类型与不适用时的原文案（契约 §2.2 的「节选」表格）。
 * `message(mediaType)` 返回契约里的错误文案。
 */
export const PARAM_APPLICABILITY = Object.freeze({
  path: { media: ALL_MEDIA },
  query: { media: ALL_MEDIA },
  max: { media: ALL_MEDIA },
  subtitle: {
    media: ['video', 'audio'],
    message: (t) => (t === 'document'
      ? 'subtitle is not applicable to document media. Documents have a page text layer, not a transcript.'
      : `subtitle is not applicable to ${t} media.`),
  },
  transcript: {
    media: ['video', 'audio'],
    message: (t) => `transcript is not applicable to ${t} media.`,
  },
  start: {
    media: ['video', 'audio'],
    message: (t) => (t === 'document'
      ? 'start is not applicable to document media. Use "pages" instead (e.g. pages: "3-10,15").'
      : `start is not applicable to ${t} media.`),
  },
  end: {
    media: ['video', 'audio'],
    message: (t) => (t === 'document'
      ? 'end is not applicable to document media. Use "pages" instead (e.g. pages: "3-10,15").'
      : `end is not applicable to ${t} media.`),
  },
  segment: {
    media: ['video', 'audio'],
    message: (t) => `segment is not applicable to ${t} media.`,
  },
  pages: {
    media: ['document'],
    message: (t) => (t === 'document'
      ? 'pages is not applicable to document media.'
      : `pages is not applicable to ${t} media. Use "start" and "end" (seconds) instead.`),
  },
  ocr: {
    media: ['document'],
    message: (t) => `ocr is not applicable to ${t} media. Only documents have a page text layer or page images to OCR; `
      + 'video and audio use subtitles/transcript instead.',
  },
  includeFrame: {
    media: ['video', 'document'],
    message: (t) => `includeFrame is not applicable to ${t} media. There are no frames to show.`,
  },
  at: {
    media: ['video'],
    message: (t) => (t === 'audio'
      ? 'at is not applicable to audio media. media_zoom returns one frame for video and one page image for document; for audio use media_locate to find timestamps.'
      : `at is not applicable to ${t} media. media_zoom uses "at" (or "start"/"end") for video.`),
  },
  crop: {
    media: ['video', 'document'],
    message: (t) => `crop is not applicable to ${t} media.`,
  },
  page: {
    media: ['document'],
    message: (t) => (t === 'video'
      ? 'page is not applicable to video media. media_zoom uses "at" (or "start"/"end") for video.'
      : `page is not applicable to ${t} media.`),
  },
  cells: {
    media: ['video', 'document'],
    message: (t) => (t === 'audio'
      ? 'cells is not applicable to audio media. A recording has no frames; media_overview returns a timestamped transcript instead.'
      : `cells is not applicable to ${t} media.`),
  },
  images: {
    media: ['video', 'document'],
    // 录音只认 images: 0（零像素纯文本模式）；其它取值对录音依然不适用。
    allow: (value, mediaType) => mediaType === 'audio' && value === 0,
    message: (t) => `images is not applicable to ${t} media.`,
  },
  maxEdge: {
    media: ['video', 'document'],
    message: (t) => `maxEdge is not applicable to ${t} media.`,
  },
  envelope: {
    media: ['audio'],
    message: (t) => `envelope is not applicable to ${t} media. It only applies to audio recordings.`,
  },
});

/**
 * 契约 §2.2 的硬规则：**不适用的参数必须报错，不能静默忽略。**
 * 只检查调用方真的传了的参数（默认值不触发）。
 * 规则的 `allow(value, mediaType)` 是值级豁免：参数对某媒体「部分适用」时用它放行。
 */
export function checkApplicability(args, mediaType) {
  for (const [param, rule] of Object.entries(PARAM_APPLICABILITY)) {
    if (args?.[param] === undefined) continue;
    if (rule.media.includes(mediaType)) continue;
    if (rule.allow?.(args[param], mediaType)) continue;
    throw new ToolError('INVALID_ARGUMENT', rule.message(mediaType));
  }
}

/** 方法级适用性（契约 §2.2 + interface.js 的 METHOD_MATRIX） */
export function checkMethod(mediaType, method) {
  if ((METHOD_MATRIX[mediaType] ?? []).includes(method)) return;
  throw new ToolError(
    'INVALID_ARGUMENT',
    `${method} is not applicable to ${mediaType} media. Supported methods for ${mediaType}: ${(METHOD_MATRIX[mediaType] ?? []).join(', ')}.`,
  );
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

const MEDIA_TYPES = new Set(['video', 'audio', 'document']);

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function integerOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function fixed2(value) {
  return value === null || value === undefined ? null : Number(value).toFixed(2);
}

function rangeLabel(startMs, endMs) {
  return `${formatTimestamp(startMs)}-${formatTimestamp(endMs)}`;
}

/** 媒体类型判定 + 文件元信息。detect 失败 → 契约的 UNSUPPORTED_MEDIA_TYPE。 */
async function resolveMedia(args) {
  const resolved = await validatePath(args.path);
  let detected;
  try {
    detected = await detectMediaType(resolved);
  } catch (error) {
    throw new ToolError(
      'UNSUPPORTED_MEDIA_TYPE',
      `cannot determine the media type of "${resolved}". Supported media: video (mp4, mov, mkv, webm, ...), `
        + 'audio (mp3, wav, m4a, ...), document (pdf, docx, pptx, xlsx, txt, md, images).',
      'Check the file extension; PDF and image files are documents. If the file is a valid media file, report it — '
        + `the detector said: ${error?.message ?? error}`,
    );
  }
  const info = await stat(resolved);
  return {
    path: resolved,
    mediaType: detected.mediaType,
    detection: detected,
    sizeBytes: info.size,
    modifiedMs: Math.round(info.mtimeMs),
  };
}

/** 契约 §2.1：扩展名只是候选，容器嗅探（probe）可以纠正媒体类型 */
function refineMediaType(probed, fallback) {
  const candidate = probed?.mediaType;
  return typeof candidate === 'string' && MEDIA_TYPES.has(candidate) ? candidate : fallback;
}

/** 传给后端的公共输入片段 */
function baseInput(base) {
  return {
    path: base.path,
    mediaType: base.mediaType,
    sizeBytes: base.sizeBytes,
    modifiedMs: base.modifiedMs,
    detectedBy: base.detection?.detectedBy ?? null,
  };
}

/** 内部 probe：overview / zoom / locate / subtitles 需要 durationSec / pageCount 做范围校验 */
async function internalProbe(base, extraInput, call) {
  const input = { ...baseInput(base), subtitle: null, transcript: 'auto', ...extraInput };
  const result = await call.dispatcher.call(base.mediaType, 'probe', input, call.backendCtx);
  return result ?? {};
}

/** 时间窗参数 → 闭区间 [startMs, endMs]（契约 §2.3） */
function computeTimeWindow(args, durationSec) {
  if (args.segment !== undefined) {
    const segment = Number(args.segment);
    if (!Number.isInteger(segment) || segment < 30 || segment > 3600) {
      throw new ToolError('INVALID_ARGUMENT', 'segment must be an integer between 30 and 3600 (seconds).');
    }
  }
  const segmentSec = args.segment !== undefined ? Number(args.segment) : 300;
  const startSec = args.start !== undefined ? Number(args.start) : 0;
  let endSec;
  if (args.end !== undefined) endSec = Number(args.end);
  else if (args.start !== undefined) endSec = startSec + segmentSec;
  else endSec = durationSec; // 整段媒体

  const validated = validateTimeRange({ startSec, endSec, durationSec });
  const startMs = validated.startMs ?? 0;
  const endMs = validated.endMs;
  return {
    startMs,
    endMs,
    startSec: startMs / 1000,
    endSec: endMs === null ? null : endMs / 1000,
    clipped: validated.clipped,
  };
}

/** document 的 pages 参数 → 页码数组（省略 = 全文） */
function computePages(args, pageCount) {
  if (args.pages !== undefined) return parsePages(args.pages, { pageCount });
  if (pageCount !== null && pageCount !== undefined) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  return null;
}

/** 图片形状规划：按媒体类型给默认值，走 images.js 的硬上限 + 软预算 */
function planOverviewImages(args, mediaType, config) {
  const limitTokens = config?.images?.maxTokens ?? DEFAULT_MAX_IMAGE_TOKENS;
  const limitEdge = config?.images?.maxEdge ?? IMAGE_LIMITS.maxMaxEdge;

  if (mediaType === 'audio') {
    // images: 0 是零像素模式，压过 envelope：true —— 录音不出波形图。
    if (args.images !== undefined && Number(args.images) === 0) {
      return planImageBudget({ cells: 1, images: 0, maxEdge: 1280, explicit: true, limitTokens, limitEdge });
    }
    if (!args.envelope) return null;
    return planImageBudget({ cells: 1, images: 1, maxEdge: 1280, explicit: false, limitTokens, limitEdge });
  }
  const cells = args.cells !== undefined ? Number(args.cells) : (mediaType === 'document' ? 6 : 9);
  const images = args.images !== undefined ? Number(args.images) : 2;
  const maxEdge = args.maxEdge !== undefined ? Number(args.maxEdge) : 1280;
  const explicit = args.cells !== undefined || args.images !== undefined || args.maxEdge !== undefined;
  return planImageBudget({ cells, images, maxEdge, explicit, limitTokens, limitEdge });
}

function zeroBudget(config) {
  return {
    requestedImages: 0,
    producedImages: 0,
    requestedCells: 0,
    producedCells: 0,
    estimatedTokens: 0,
    limit: config?.images?.maxTokens ?? DEFAULT_MAX_IMAGE_TOKENS,
    warning: null,
  };
}

/** 组装后端返回的 images 为 MCP content + 结构化描述，并核对实际产物 */
function collectImages(rawImages, plan, config) {
  const list = Array.isArray(rawImages) ? rawImages : [];
  const limitEdge = config?.images?.maxEdge ?? IMAGE_LIMITS.maxMaxEdge;
  validateProducedImages(list, { limitEdge });
  return describeImages(list, { source: 'visual' });
}

/** 段落的通用归一化（合同 §5.3 / §9.2 的字段口径；source/origin 缺省为 none） */
function normalizeSegmentsSafe(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((segment, i) => {
    const startMs = integerOrNull(segment?.startMs);
    const endMs = integerOrNull(segment?.endMs);
    return {
      index: Number.isInteger(segment?.index) ? segment.index : i + 1,
      startMs,
      endMs,
      startSec: startMs === null ? null : startMs / 1000,
      endSec: endMs === null ? null : endMs / 1000,
      text: String(segment?.text ?? ''),
      source: segment?.source ?? 'none',
      origin: segment?.origin ?? 'none',
      // 契约 v2（9z5.28）的逐页来源细节：source 已按它映射，textOrigin 原样暴露，
      // 让 agent 能看到「这页是文字层 / OCR / 没声明」（9z5.21）。
      textOrigin: segment?.textOrigin ?? null,
      page: integerOrNull(segment?.page),
      speaker: segment?.speaker ? String(segment.speaker) : null,
    };
  });
}

/** 从 transcript 对象 / 段落推断整份转写的来源（契约 §2.5） */
function resolveTranscriptInfo(result, segments) {
  const given = result?.transcript && typeof result.transcript === 'object' ? result.transcript : {};
  const first = segments.find((s) => s.source && s.source !== 'none') ?? segments[0] ?? null;
  return {
    source: given.source ?? first?.source ?? 'none',
    origin: given.origin ?? first?.origin ?? 'none',
    language: given.language ?? null,
    segmentCount: segments.length,
    provider: given.provider ?? null,
    model: given.model ?? null,
    // 文档 provider 的两个角色（9z5.28 契约 v2）：只列真正处理过返回页的角色。
    ocrProvider: given.ocrProvider ?? null,
    typesetProvider: given.typesetProvider ?? null,
    file: given.file ?? null,
    reason: given.reason ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * 文本格式化（契约 §4.4 / §5.4 / §6.4 / §7.4 / §8.4）
 * ------------------------------------------------------------------ */

/**
 * 只有 ASR（机器听写）不加引号，避免看起来像原话（契约 §2.5 的硬约束）。
 * subtitle / text / ocr 都加「」：text 是字符精确的原生文字（可当原话引用），
 * subtitle / ocr 也是「文件里/页面上已有的字」，只是可能自动生成或识别错。
 */
function quoteBySource(text, source) {
  const value = String(text ?? '');
  if (!value) return '';
  return source === 'asr' ? value : `「${value}」`;
}

function padLabel(label, width = 9) {
  return label.padEnd(width);
}

/* ---------------- 内联预览（契约 §12.5，9z5.20） ----------------
 *
 * 内联上限（MMGREP_MAX_TEXT_INLINE_CHARS）之内只放**预览**，全文始终落盘：
 *   tier 1 whole  请求范围整体放得下 → 原样全量返回；
 *   tier 2 skim   标题 + 段首句（9z5.32 实现，这里只留钩子）；
 *   tier 3 sample 按**完整单元**（文档 = 句子，视频/录音 = 转写段落）等距抽样。
 * 旧实现按「行」截断且一超限就 break：文档一页一行，于是超限页和它后面的所有页
 * 一起消失，而文本末尾还宣称「包含每一页」。这里改成按单元抽样的原因是：
 * 单个超长单元可以硬截断（…[+N chars]），但绝不静默丢掉整页。
 */

/** 单个预览单元的硬上限：min(正文预算 / 4, 2000) 字符 */
const PREVIEW_UNIT_MAX_CHARS = 2000;
/** 给预览说明（抽样数 / 未覆盖范围 / 截断提示）预留的字符数，先留再分配正文 */
const PREVIEW_NOTE_RESERVE = 420;
/** not represented 页码区间串的最大长度；超了压缩成 "+ N more ranges" */
const PREVIEW_RANGE_LIST_MAX_CHARS = 140;

function inlineCharLimit(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_TEXT_INLINE_CHARS;
}

/** 单元硬截断：尾部标 …[+N chars]（表格、参考文献、无标点 CJK 会踩到） */
function capUnitText(text, cap) {
  const value = String(text ?? '');
  if (!Number.isFinite(cap) || cap <= 0 || value.length <= cap) {
    return { text: value, truncated: false };
  }
  return { text: `${value.slice(0, cap)}…[+${value.length - cap} chars]`, truncated: true };
}

/**
 * 预览单元：文档把每页正文切成句子；视频/录音一个转写段落就是一个单元。
 * `order` 是单元在全文里的位置，用来在渲染时判断相邻单元之间有没有省略。
 */
function buildPreviewUnits(mediaType, segments) {
  if (mediaType !== 'document') {
    return segments.map((segment, index) => ({
      order: index,
      page: null,
      source: segment.source ?? 'none',
      origin: segment.origin ?? 'none',
      textOrigin: segment.textOrigin ?? null,
      text: String(segment.text ?? ''),
      segment,
    }));
  }
  const units = [];
  for (const segment of segments) {
    const page = segment.page ?? segment.index;
    for (const sentence of splitSentences(segment.text)) {
      units.push({
        order: units.length,
        page,
        source: segment.source ?? 'none',
        origin: segment.origin ?? 'none',
        // 9z5.21：逐页来源细节要一路带到 structuredContent.segments。
        textOrigin: segment.textOrigin ?? null,
        text: sentence,
        segment,
      });
    }
  }
  return units;
}

/** 正文渲染：文档按页聚合（一页一行），视频/录音一行一个单元，省略处插 … */
function renderPreviewBody({ mediaType, units, textOnly }) {
  if (units.length === 0) return '';
  if (mediaType === 'document') {
    const byPage = new Map();
    for (const unit of units) {
      if (!byPage.has(unit.page)) byPage.set(unit.page, []);
      byPage.get(unit.page).push(unit);
    }
    const lines = [];
    for (const [page, list] of byPage) {
      const parts = [];
      list.forEach((unit, index) => {
        if (index > 0 && unit.order !== list[index - 1].order + 1) parts.push('…');
        parts.push(quoteBySource(unit.renderText, unit.source));
      });
      const source = list[0].source ?? 'none';
      lines.push(`${padLabel(`[page ${page}`)}] (${source})  ${parts.join(' ')}`.trimEnd());
    }
    return lines.join('\n');
  }
  const lines = [];
  units.forEach((unit, index) => {
    if (index > 0 && unit.order !== units[index - 1].order + 1) lines.push('…');
    lines.push(formatOverviewSegmentLine({ ...unit.segment, text: unit.renderText }, mediaType, textOnly));
  });
  return lines.join('\n');
}

/** 升序索引里等距取 m 个（含首尾）；m >= n 时全取 */
function evenlySpacedIndices(n, m) {
  if (m >= n) return Array.from({ length: n }, (_, i) => i);
  if (m <= 1) return [0];
  const picked = new Set();
  for (let i = 0; i < m; i += 1) picked.add(Math.round((i * (n - 1)) / (m - 1)));
  return [...picked].sort((a, b) => a - b);
}

/** 升序页码 → 压缩区间 ["2-6", "8"] */
function compressPageRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = sorted[i];
    prev = sorted[i];
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges;
}

/** 压缩区间串；太长时只列前几段，其余写成 "+ N more ranges"（9z5.20 要求） */
function formatRangeList(numbers, maxChars = PREVIEW_RANGE_LIST_MAX_CHARS) {
  const ranges = compressPageRanges(numbers);
  let out = '';
  for (let i = 0; i < ranges.length; i += 1) {
    const piece = `${out ? ', ' : ''}${ranges[i]}`;
    if (out && out.length + piece.length > maxChars) {
      return `${out}, + ${ranges.length - i} more ranges`;
    }
    out += piece;
  }
  return out;
}

function pagesLabel(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return 'the requested pages';
  if (pages.length === 1) return `page ${pages[0]}`;
  return `pages ${formatPageRangeLabel(pages)}`;
}

/** tier 1 才允许说「完整」；非 tier 1 必须说清抽样与未覆盖范围 */
function buildCompletenessNote({ mediaType, pages }) {
  if (mediaType === 'document') return `note: complete text of ${pagesLabel(pages)} (nothing omitted).`;
  return 'note: complete text of this window (nothing omitted).';
}

function buildPreviewNote({ mediaType, preview, pages, window, cap, anyTruncated }) {
  const tail = anyTruncated ? `; units longer than ${cap} chars end with …[+N chars]` : '';
  if (mediaType === 'document') {
    const coverage = preview.notRepresented.length > 0
      ? `not represented: ${formatRangeList(preview.notRepresented)}`
      : 'every requested page is represented';
    return `preview: sampled ${preview.units} of ${preview.totalUnits} sentences across ${pagesLabel(pages)}; ${coverage}${tail}.`;
  }
  const windowLabel = window
    ? `${fixed2(window.startSec)}-${fixed2(window.endSec)} s`
    : 'this window';
  const coverage = preview.units >= 2 ? '; first and last are included' : '';
  return `preview: sampled ${preview.units} of ${preview.totalUnits} segments across ${windowLabel}${coverage}${tail}.`;
}

/** 文档抽样：先保证「每页至少一个单元」；预算不够就等距选页并列出未覆盖页 */
function selectDocumentUnits(units, requestedPages, target) {
  const cap = Math.max(1, Math.min(Math.floor(target / 4), PREVIEW_UNIT_MAX_CHARS));
  const capped = units.map((unit) => {
    const { text, truncated } = capUnitText(unit.text, cap);
    return { ...unit, renderText: text, unitTruncated: truncated };
  });

  const byPage = new Map();
  for (const unit of capped) {
    if (unit.page === null || unit.page === undefined) continue;
    if (!byPage.has(unit.page)) byPage.set(unit.page, []);
    byPage.get(unit.page).push(unit);
  }
  const requested = Array.isArray(requestedPages) && requestedPages.length > 0
    ? requestedPages
    : [...byPage.keys()].sort((a, b) => a - b);
  const pagesWithUnits = requested.filter((page) => (byPage.get(page)?.length ?? 0) > 0);
  if (pagesWithUnits.length === 0) {
    return { units: [], cap, notRepresented: [], anyTruncated: false };
  }

  const pageCost = (page) => {
    const first = byPage.get(page)[0];
    return 10 + String(page).length + first.renderText.length + 4 + 1;
  };
  const costForPageCount = (m) => evenlySpacedIndices(pagesWithUnits.length, m)
    .reduce((sum, index) => sum + pageCost(pagesWithUnits[index]), 0);

  let pageCount = 1;
  if (costForPageCount(pagesWithUnits.length) <= target) {
    pageCount = pagesWithUnits.length;
  } else {
    let lo = 1;
    let hi = pagesWithUnits.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (costForPageCount(mid) <= target) lo = mid;
      else hi = mid - 1;
    }
    pageCount = lo;
  }

  const selectedPages = evenlySpacedIndices(pagesWithUnits.length, pageCount)
    .map((index) => pagesWithUnits[index]);
  const selectedOrders = new Set();
  const cursors = new Map();
  let spent = costForPageCount(pageCount);
  for (const page of selectedPages) {
    selectedOrders.add(byPage.get(page)[0].order);
    cursors.set(page, 1);
  }

  // 剩余预算按「每页第 r 个单元」逐轮补充，保持页内均匀，直到预算用完
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const page of selectedPages) {
      const list = byPage.get(page);
      let cursor = cursors.get(page) ?? 0;
      while (cursor < list.length) {
        const delta = list[cursor].renderText.length + 4;
        if (spent + delta > target) break;
        selectedOrders.add(list[cursor].order);
        spent += delta;
        cursor += 1;
        progressed = true;
      }
      cursors.set(page, cursor);
    }
  }

  const selected = capped.filter((unit) => selectedOrders.has(unit.order));
  const represented = new Set(selected.map((unit) => unit.page));
  return {
    units: selected,
    cap,
    // 包括「整页没有文字」的页：它们同样没有出现在预览里（agent 可以据此去 zoom 看画面）
    notRepresented: requested.filter((page) => !represented.has(page)),
    anyTruncated: selected.some((unit) => unit.unitTruncated),
  };
}

/** 视频/录音抽样：等距选 m 个单元（含首尾），剩余预算按顺序补齐 */
function selectTimeUnits(units, target) {
  const cap = Math.max(1, Math.min(Math.floor(target / 4), PREVIEW_UNIT_MAX_CHARS));
  const capped = units.map((unit) => {
    const { text, truncated } = capUnitText(unit.text, cap);
    return { ...unit, renderText: text, unitTruncated: truncated };
  });
  const n = capped.length;
  if (n === 0) return { units: [], cap, notRepresented: [], anyTruncated: false };

  // 只做成本估算：真实长度由调用方渲染后再核（见 planOverviewPreview 的重试）
  const unitCost = (unit) => unit.renderText.length + 32;
  const costForCount = (m) => evenlySpacedIndices(n, m)
    .reduce((sum, index) => sum + unitCost(capped[index]) + 3, 0);

  let count = 1;
  if (costForCount(n) <= target) {
    count = n;
  } else {
    let lo = 1;
    let hi = n;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (costForCount(mid) <= target) lo = mid;
      else hi = mid - 1;
    }
    count = lo;
  }

  const selected = new Set(evenlySpacedIndices(n, count));
  let spent = costForCount(count);
  for (let index = 0; index < n; index += 1) {
    if (selected.has(index)) continue;
    const cost = unitCost(capped[index]) + 3;
    if (spent + cost > target) continue;
    selected.add(index);
    spent += cost;
  }
  const picked = [...selected].sort((a, b) => a - b).map((index) => capped[index]);
  return {
    units: picked,
    cap,
    notRepresented: [],
    anyTruncated: picked.some((unit) => unit.unitTruncated),
  };
}

/**
 * 预览装配：tier 1 whole 放得下就全量；否则抽样。
 * capacity = 上限减去 header / 固定 notes / full text 行之后的正文余量。
 */
function planOverviewPreview({ mediaType, segments, pages, window, textOnly, capacity }) {
  const units = buildPreviewUnits(mediaType, segments);
  const totalUnits = units.length;
  // 没有任何可内联的文字（扫描件、无字幕的视频……）：预览是空的，不编也不抽样
  if (totalUnits === 0) {
    return {
      mode: 'whole',
      bodyText: '',
      units: [],
      preview: { mode: 'whole', units: 0, totalUnits: 0, notRepresented: [] },
      note: null,
    };
  }
  const wholeUnits = units.map((unit) => ({ ...unit, renderText: unit.text, unitTruncated: false }));
  const wholeBody = renderPreviewBody({ mediaType, units: wholeUnits, textOnly });
  const wholeNote = buildCompletenessNote({ mediaType, pages });
  const wholeNeeded = (wholeBody ? wholeBody.length + 1 : 0) + (wholeNote ? wholeNote.length + 1 : 0);
  if (wholeNeeded <= capacity) {
    return {
      mode: 'whole',
      bodyText: wholeBody,
      units: wholeUnits,
      preview: { mode: 'whole', units: totalUnits, totalUnits, notRepresented: [] },
      note: wholeNote,
    };
  }

  // 先给说明预留空间，再把余量交给正文；渲染后按实际长度回退重试。
  let target = Math.max(1, capacity - PREVIEW_NOTE_RESERVE);
  let fallback = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const selection = mediaType === 'document'
      ? selectDocumentUnits(units, pages, target)
      : selectTimeUnits(units, target);
    const bodyText = renderPreviewBody({ mediaType, units: selection.units, textOnly });
    const preview = {
      mode: 'sampled',
      units: selection.units.length,
      totalUnits,
      notRepresented: selection.notRepresented,
    };
    const note = buildPreviewNote({
      mediaType,
      preview,
      pages,
      window,
      cap: selection.cap,
      anyTruncated: selection.anyTruncated,
    });
    const needed = (bodyText ? bodyText.length + 1 : 0) + (note ? note.length + 1 : 0);
    const result = { mode: 'sampled', bodyText, units: selection.units, preview, note };
    if (needed <= capacity) return result;
    fallback = result;
    if (target <= 1) break;
    target = Math.max(1, target - (needed - capacity) - 40);
  }
  // 上限小到连说明都放不下：交给 clampInlineText 收尾，保证硬性质
  return fallback ?? {
    mode: 'sampled',
    bodyText: '',
    units: [],
    preview: { mode: 'sampled', units: 0, totalUnits, notRepresented: [] },
    note: null,
  };
}

/** 最后一道保险：任何情况下 text 长度 <= 上限（极端小上限时截断并标注） */
function clampInlineText(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  if (limit <= 0) return '';
  let keep = Math.max(0, limit - 20);
  let marker = `…[+${text.length - keep} chars]`;
  while (keep > 0 && keep + marker.length > limit) {
    keep = Math.max(0, keep - (keep + marker.length - limit));
    marker = `…[+${Math.max(0, text.length - keep)} chars]`;
  }
  return keep > 0 ? `${text.slice(0, keep)}${marker}` : text.slice(0, limit);
}

/** 预览单元 → structuredContent.segments：只放**实际内联**的单元 */
function unitsToInlineSegments(units, mediaType) {
  return units.map((unit) => {
    if (mediaType === 'document') {
      return {
        index: unit.order + 1,
        startMs: null,
        endMs: null,
        startSec: null,
        endSec: null,
        text: unit.renderText,
        source: unit.source,
        origin: unit.origin,
        textOrigin: unit.textOrigin ?? null,
        page: unit.page,
        speaker: unit.segment?.speaker ?? null,
      };
    }
    return { ...unit.segment, text: unit.renderText };
  });
}

function formatOverviewSegmentLine(segment, mediaType, textOnly = false) {
  if (mediaType === 'document') {
    return `${padLabel(`[page ${segment.page ?? segment.index}`)}] (${segment.source})  ${quoteBySource(segment.text, segment.source)}`.trimEnd();
  }
  // 纯文本模式（images: 0）没有宫格格位，段落是转写行而不是 cell。
  const label = mediaType === 'video' && !textOnly ? `[cell ${segment.index}` : `[seg ${segment.index}`;
  const time = `${rangeLabel(segment.startMs, segment.endMs)}  `;
  return `${padLabel(label)}] ${time}(${segment.source})  ${quoteBySource(segment.text, segment.source)}`.trimEnd();
}

/**
 * probe 文本里的文字层行（9z5.21）：三态 yes | no | unknown。
 *
 * `hasTextLayer = null` 是「本机没有文字抽取器，判不出来」，不能渲染成 no；
 * 后者会让 agent 以为这份 PDF 只能靠 OCR。
 */
function formatTextLayerLine(result) {
  const layer = result.capabilities?.textLayer ?? {};
  const checked = Array.isArray(layer.checkedPages) ? layer.checkedPages : [];
  const sampled = checked.length > 0 ? checked.join(', ') : null;
  // 9z5.31：有文字层不代表文字是对的。劣质 OCR 写进去的文字层会优先提示
  // 「看起来不可靠 + 怎么强制重新识别」，而不是让 agent 直接引用。
  if (layer.reliable === false && layer.warning) {
    return `text layer: ${layer.warning}`;
  }
  if (result.hasTextLayer === null || result.hasTextLayer === undefined) {
    return `text layer: unknown — ${layer.reason ?? 'the PDF text layer could not be checked.'}`;
  }
  if (result.hasTextLayer === false) {
    return `text layer: no${sampled ? ` (checked pages ${sampled})` : ''}.`;
  }
  if (Number.isInteger(layer.textPage)) {
    return `text layer: yes (sampled pages ${sampled ?? layer.textPage}; first text on page ${layer.textPage}).`;
  }
  return 'text layer: yes.';
}

function formatProbeText(result) {
  const mediaType = result.mediaType;
  const lines = [];
  const attrs = [`path="${result.path}"`, `type="${mediaType}"`];

  if (mediaType === 'document') {
    attrs.push(`pages="${result.pageCount ?? '-'}"`);
    const textLayer = result.hasTextLayer === null || result.hasTextLayer === undefined
      ? 'unknown'
      : (result.hasTextLayer ? 'yes' : 'no');
    attrs.push(`textLayer="${textLayer}"`);
  } else {
    attrs.push(`duration="${fixed2(result.durationSec) ?? '-'}"`);
    attrs.push(`durationMs="${result.durationMs ?? '-'}"`);
    if (mediaType === 'video') {
      attrs.push(`size="${result.width && result.height ? `${result.width}x${result.height}` : '-'}"`);
      attrs.push(`fps="${fixed2(result.fps) ?? '-'}"`);
    }
    attrs.push(`codec="${(mediaType === 'video' ? result.videoCodec : result.audioCodec) ?? '-'}"`);
    if (mediaType === 'audio') {
      attrs.push(`channels="${result.audioChannels ?? '-'}"`);
      attrs.push(`samplerate="${result.sampleRateHz ?? '-'}"`);
    }
    attrs.push(`audio="${result.hasAudio ? 'present' : 'none'}"`);
  }
  attrs.push(`container="${result.container ?? '-'}"`);
  attrs.push(`subtitles="${(result.subtitleTracks ?? []).length > 0 ? 'yes' : 'no'}"`);
  lines.push(`<media ${attrs.join(' ')} />`);

  if (result.audioHealth) {
    const h = result.audioHealth;
    const parts = [];
    if (h.meanDbfs !== null && h.meanDbfs !== undefined) parts.push(`mean level ${Number(h.meanDbfs).toFixed(1)} dBFS`);
    if (h.speechRatio !== null && h.speechRatio !== undefined) parts.push(`speech ratio ${(Number(h.speechRatio) * 100).toFixed(1)}%`);
    lines.push(`audio health: ${h.verdict ?? 'unknown'}${parts.length ? ` — ${parts.join(', ')}` : ''}`);
    if (h.note) lines.push(`  ${h.note}`);
  }

  const caps = result.capabilities ?? {};
  const asr = caps.asr ?? {};
  if (mediaType === 'document') {
    lines.push('asr: not applicable to this media type.');
  } else if (asr.available) {
    lines.push(`asr: available — provider "${asr.provider ?? 'unknown'}".`);
  } else {
    lines.push(`asr: unavailable — ${asr.reason ?? 'no ASR provider is configured.'}`);
  }

  const ocr = caps.ocr ?? {};
  const typeset = caps.typeset ?? {};
  if (mediaType !== 'document') {
    lines.push('ocr: not applicable to this media type.');
    lines.push('typeset: not applicable to this media type.');
  } else {
    // 9z5.21：拆成「文字层状态 + 两个角色各自是否可用 + 实际会走的来源」，
    // 不再出现「ocr: unavailable」与「transcript source: ocr」自相矛盾的两行。
    lines.push(formatTextLayerLine(result));
    if (ocr.available) {
      lines.push(`ocr provider: ${ocr.provider ?? 'unknown'}.`);
    } else {
      lines.push(`ocr provider: none${ocr.reason ? ` — ${ocr.reason}` : '.'}`);
    }
    if (typeset.available) {
      lines.push(`typeset provider: ${typeset.provider ?? 'unknown'}.`);
    } else {
      lines.push(`typeset provider: none${typeset.reason ? ` — ${typeset.reason}` : '.'}`);
    }
  }

  lines.push(`transcript source: ${caps.transcriptSource ?? 'none'}${caps.transcriptPath ? ` (${caps.transcriptPath})` : ''}`);
  if (caps.transcriptReason) {
    lines.push(`transcript reason: ${caps.transcriptReason}`);
  }

  const recommended = result.recommended ?? {};
  if (recommended.note) {
    lines.push(recommended.note);
  } else if (result.durationSec !== null && result.durationSec !== undefined) {
    const minutes = Math.round(result.durationSec / 60);
    lines.push(`How to read ${minutes} min: one overview is enough. media_overview({ path, cells: ${recommended.cellsPerImage ?? 9}, images: ${recommended.overviewImages ?? 2} })`);
  } else {
    lines.push('How to read: call media_overview({ path }) next.');
  }
  return lines.join('\n');
}

/** 字幕来源的措辞：字幕通常来自作者，但也可能是自动生成的（9z5.26：不作「可安全引用」的绝对承诺） */
const SUBTITLE_SOURCE_NOTE = 'note: source is subtitle — from a subtitle file/track; usually the author\'s words, but may be auto-generated: check names and numbers against the frame.';

function formatOverviewText({
  mediaType, base, window, pages, durationSec, segments, transcript, imageDescriptors, textOnly, budget, hasAudio,
  fullTextNote = null, continuationNote = null, warnings = [],
}) {
  const lines = [];
  const attrs = [`path="${base.path}"`, `type="${mediaType}"`];

  if (mediaType === 'document') {
    attrs.push(`pages="${formatPageRangeLabel(pages)}"`);
    if (imageDescriptors.length > 0) {
      const totalCells = imageDescriptors.reduce((sum, d) => sum + (d.cells ?? 0), 0);
      attrs.push(`grid="${totalCells} pages x ${imageDescriptors.length} image(s)"`);
      attrs.push(`image="${imageDescriptors.map((d) => `${d.width}x${d.height}`).join(' ')}"`);
      attrs.push(`tokens="~${budget.estimatedTokens}"`);
    }
    // 9z5.21：删除误导的 text="<provider>"（它其实是 provider id，且原生文字层没有
    // provider），改为只列本次真正处理过返回页的角色（后端按逐页 textOrigin 判定）。
    attrs.push(`source="${transcript.source}"`);
    if (transcript.ocrProvider) attrs.push(`ocrProvider="${transcript.ocrProvider}"`);
    if (transcript.typesetProvider) attrs.push(`typesetProvider="${transcript.typesetProvider}"`);
  } else {
    if (window) {
      attrs.push(`window="${fixed2(window.startSec)}-${fixed2(window.endSec ?? durationSec ?? 0)}"`);
    }
    if (durationSec !== null && durationSec !== undefined) attrs.push(`duration="${fixed2(durationSec)}"`);
    if (mediaType === 'video') {
      if (imageDescriptors.length > 0) {
        const totalCells = imageDescriptors.reduce((sum, d) => sum + (d.cells ?? 0), 0);
        attrs.push(`grid="${totalCells} cells x ${imageDescriptors.length} image(s)"`);
        attrs.push(`cell="${cellSizeLabel(imageDescriptors)}"`);
        attrs.push(`image="${imageDescriptors.map((d) => `${d.width}x${d.height}`).join(' ')}"`);
        attrs.push(`tokens="~${budget.estimatedTokens}"`);
      }
      attrs.push(`audio="${hasAudio ? 'present' : 'none'}"`);
    }
    attrs.push(`transcript="${transcript.source}"`);
    attrs.push(`origin="${transcript.origin}"`);
    if (transcript.file) attrs.push(`file="${transcript.file}"`);
    if (mediaType === 'audio') attrs.push(`segments="${transcript.segmentCount}"`);
  }
  lines.push(`<overview ${attrs.join(' ')} />`);

  if (transcript.source === 'none' && segments.length === 0) {
    lines.push(`transcript: NONE (${transcript.reason ?? 'no transcript source is available for this file'})`);
  }

  const bodyNotes = [];
  if (imageDescriptors.length > 0) {
    bodyNotes.push(`cost: ${imageDescriptors.length} image(s) x ~${budget.perImageTokens ?? '-'} = ~${budget.estimatedTokens} vision tokens · transcript from ${transcript.source}${transcript.file ? ` (${transcript.file})` : ''}`);
  }
  if (mediaType === 'video') {
    if (textOnly) {
      // 不再无条件宣称「下面是这个窗口的转写」——抽样时这句话是错的。
      bodyNotes.push('note: text-only mode (images: 0) — no storyboard grid was rendered and no frame was decoded.');
      bodyNotes.push('note: to see the picture, call media_zoom({ path, at }) for a single frame.');
    } else {
      bodyNotes.push('note: the grids are for locating. To read text on screen, media_zoom({ path, at }) and read the cropped single frame.');
    }
    if (transcript.source === 'asr') {
      bodyNotes.push('note: source is asr — machine transcription. Names, numbers and jargon may be wrong; do not quote these lines as the speaker\'s exact words.');
    } else if (transcript.source === 'subtitle') {
      bodyNotes.push(SUBTITLE_SOURCE_NOTE);
    }
  } else if (mediaType === 'audio') {
    if (transcript.source === 'asr') {
      bodyNotes.push('note: source is asr — machine transcription. Names, numbers and jargon may be wrong; do not quote these lines as the speaker\'s exact words.');
    } else if (transcript.source === 'subtitle') {
      bodyNotes.push(SUBTITLE_SOURCE_NOTE);
    }
  } else if (mediaType === 'document') {
    if (textOnly) {
      bodyNotes.push('note: text-only mode (images: 0) — no page thumbnail was rendered.');
    }
    // 9z5.21：按实际来源给 note，不再无条件宣称「page text 来自 OCR」。
    if (transcript.source === 'text') {
      bodyNotes.push('note: page text comes from the native text layer (or the plain-text file) — characters are exact and may be quoted.');
    } else if (transcript.source === 'mixed') {
      bodyNotes.push('note: page sources differ — read the tag on each page (text = character-exact native text, ocr = machine recognition).');
    }
    if (segments.some((segment) => segment.source === 'ocr')) {
      bodyNotes.push('note: some page text comes from OCR — names, numbers and jargon may be misread; verify them against the page image via media_zoom({ path, page }).');
    }
  }
  if (warnings.includes(ROLLING_SUBTITLE_WARNING)) bodyNotes.push(ROLLING_SUBTITLE_WARNING);
  if (budget.warning) bodyNotes.push(`budget: ${budget.warning}`);

  // 全文落盘路径 / 续读提示也进 text content（9z5.22），并计入内联上限。
  const headText = lines.join('\n');
  const tailNotes = [fullTextNote, continuationNote].filter(Boolean);
  const limit = inlineCharLimit(budget.maxInlineChars);
  const fixedLength = headText.length
    + [...bodyNotes, ...tailNotes].reduce((sum, note) => sum + note.length + 1, 0);
  const capacity = limit - fixedLength - 1;

  const plan = planOverviewPreview({ mediaType, segments, pages, window, textOnly, capacity });
  const notes = [plan.note, ...bodyNotes, ...tailNotes].filter(Boolean);
  const text = [headText, plan.bodyText, ...notes].filter(Boolean).join('\n');
  return {
    // 最后一道保险：任何输入下 text 长度都不超过 MMGREP_MAX_TEXT_INLINE_CHARS
    text: clampInlineText(text, limit),
    truncated: plan.preview.mode !== 'whole',
    inlineSegments: unitsToInlineSegments(plan.units, mediaType),
    preview: plan.preview,
  };
}

function cellSizeLabel(imageDescriptors) {
  const first = imageDescriptors[0];
  if (!first?.width || !first?.height) return '-';
  const cells = first.cells ?? 1;
  const cols = Math.ceil(Math.sqrt(cells));
  const rows = Math.ceil(cells / cols);
  return `${Math.floor(first.width / cols)}x${Math.floor(first.height / rows)}`;
}

function formatPageRangeLabel(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return '-';
  if (pages.length === 1) return String(pages[0]);
  const sorted = [...pages].sort((a, b) => a - b);
  const contiguous = sorted.every((p, i) => i === 0 || p === sorted[i - 1] + 1);
  return contiguous ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(',');
}

function formatZoomText({ base, mediaType, target, image, cropLabel }) {
  const attrs = [`path="${base.path}"`, `kind="${target.kind}"`];
  if (target.kind === 'frame') {
    if (target.atMs !== null && target.atMs !== undefined) {
      attrs.push(`at="${formatTimestamp(target.atMs)}"`);
      attrs.push(`atMs="${target.atMs}"`);
    }
    if (target.selection) attrs.push(`selection="${target.selection}"`);
    if (target.fromMs !== null && target.fromMs !== undefined && target.toMs !== null && target.toMs !== undefined) {
      attrs.push(`window="${fixed2(target.fromMs / 1000)}-${fixed2(target.toMs / 1000)}"`);
    }
  } else {
    attrs.push(`page="${target.page}"`);
  }
  attrs.push(`crop="${cropLabel}"`);
  if (image) {
    attrs.push(`image="${image.width}x${image.height}"`);
    attrs.push(`tokens="~${image.estimatedTokens}"`);
  }
  const header = `<zoom ${attrs.join(' ')} />`;

  let body;
  if (target.kind === 'frame') {
    const where = target.atMs !== null && target.atMs !== undefined
      ? `at ${formatTimestamp(target.atMs)}`
      : `${fixed2(target.fromMs != null ? target.fromMs / 1000 : null)}-${fixed2(target.toMs != null ? target.toMs / 1000 : null)}s`;
    const selection = target.selection === 'sharpest'
      ? ` (sharpest${target.fromMs != null ? ` in ${fixed2(target.fromMs / 1000)}-${fixed2(target.toMs / 1000)}s` : ''})`
      : '';
    body = `one frame ${where}${selection}, ${cropLabel}, ${image ? `${image.width}x${image.height}` : 'no image'}.`;
  } else {
    body = `page ${target.page}, ${cropLabel}, ${image ? `${image.width}x${image.height}` : 'no image'}.`;
  }
  return `${header}\n${body}`;
}

/* ------------------------------------------------------------------ *
 * 文档 locate 的输出计划（ticket 9z5.23）
 *
 * 文档的 segment 粒度就是整页，命中即整页：直接回吐等于把命中的页复述一遍
 * （实测一次调用 12 KB+）。文档侧的定位指标改成「页码 + 命中次数 + 命中附近的片段」：
 *   - hits   —— 这一页命中几次（精确短语；没有精确命中就退回 token 覆盖，标 fuzzy）
 *   - snippet—— 首个命中 ±150 字符，对齐词边界，折叠换行与排版空白
 * 视频 / 录音不变：仍是 score（0..1）+ 时间戳 + 整段原文。
 * ------------------------------------------------------------------ */

/** 文档 locate 的总输出预算（约 3 KB）：超了就少展示几页，其余折叠成一行 */
const DOC_LOCATE_TEXT_BUDGET = 3072;

/** 向后端要的候选页上限（后端 locate 的 max 上限也是 20）；排序后再按用户的 max 截断 */
const DOC_LOCATE_CANDIDATE_MAX = 20;

const DOC_LOCATE_FOOTER = 'Feed any of these pages to media_zoom({ path, page }) — no need to re-read the whole file.';

/** 文档命中行：`page 11  hits=3  (text)  「…片段…」`（没有 score：文档侧不用分数） */
function documentMatchLine(match) {
  const flags = [match.fuzzy ? 'fuzzy' : null, match.source ?? null].filter(Boolean).join(', ');
  return `  page ${match.page}  hits=${match.hits}${flags ? ` (${flags})` : ''}  「${match.snippet}」`;
}

/** 没展示的命中页折成一行：`  3 more pages match: 3, 9, 14`（页码升序） */
function documentMorePagesLine(morePages) {
  const pages = morePages
    .map((match) => match.page)
    .sort((a, b) => (a ?? 0) - (b ?? 0))
    .join(', ');
  return `  ${morePages.length} more pages match: ${pages}`;
}

/**
 * 决定展示哪几页：先按 hits 排序（已排好），再受用户的 max 与总预算（约 3 KB）约束。
 * 返回 { matches, morePages }：morePages 是命中了但没展示的页。
 */
function planDocumentLocate({ query, matches, totalSegments, max }) {
  const capped = matches.slice(0, max);
  const overflow = matches.slice(max);
  const render = (shown) => {
    const hidden = capped.slice(shown.length).concat(overflow);
    const lines = [`matches for "${query}" (${shown.length} of ${totalSegments} pages):`];
    for (const match of shown) lines.push(documentMatchLine(match));
    if (hidden.length > 0) lines.push(documentMorePagesLine(hidden));
    lines.push(DOC_LOCATE_FOOTER);
    return { hidden, text: lines.join('\n') };
  };

  let best = null;
  for (let shown = 0; shown <= capped.length; shown += 1) {
    const candidate = render(capped.slice(0, shown));
    if (Buffer.byteLength(candidate.text, 'utf8') > DOC_LOCATE_TEXT_BUDGET) continue;
    best = { matches: capped.slice(0, shown), morePages: candidate.hidden };
  }
  if (best) return best;

  // 连一行都放不下（片段异常长）：至少展示第一页，片段按预算裁短
  const first = capped[0];
  if (!first) return { matches: [], morePages: overflow };
  const overhead = Buffer.byteLength(`matches for "${query}" (1 of ${totalSegments} pages):\n${DOC_LOCATE_FOOTER}`, 'utf8');
  const room = Math.max(0, DOC_LOCATE_TEXT_BUDGET - overhead - 64);
  return {
    matches: [{ ...first, snippet: trimToBytes(first.snippet, room) }],
    morePages: capped.slice(1).concat(overflow),
  };
}

/** 按 UTF-8 字节裁字符串 */
function trimToBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

function formatLocateText({ query, matches, totalSegments, mediaType, morePages = null }) {
  const header = `matches for "${query}" (${matches.length} of ${totalSegments} ${mediaType === 'document' ? 'pages' : 'segments'}):`;
  if (matches.length === 0) {
    return `no line matched "${query}" among ${totalSegments} ${mediaType === 'document' ? 'page texts' : 'transcript segments'}. `
      + 'Try shorter keywords, or a phrase that appears verbatim.';
  }
  const lines = [header];
  if (mediaType === 'document') {
    for (const match of matches) {
      lines.push(documentMatchLine(match));
    }
    if (morePages && morePages.length > 0) {
      lines.push(documentMorePagesLine(morePages));
    }
    lines.push(DOC_LOCATE_FOOTER);
    return lines.join('\n');
  }
  for (const match of matches) {
    const position = match.page !== null && match.page !== undefined
      ? `page ${match.page}`
      : rangeLabel(match.startMs, match.endMs);
    lines.push(`  ${position}  (${Number(match.score ?? 0).toFixed(2)})  ${quoteBySource(match.text, match.source)}`);
  }
  lines.push('Feed any of these windows to media_zoom({ path, start, end }) — no need to re-read the whole file.');
  return lines.join('\n');
}

/**
 * 续读提示（契约 §5.3 的 continuation）：只表达「请求范围之外还有内容」。
 * 抽样（9z5.20）之后不存在「内联到哪就从哪续」的概念了，所以不再用 lastSegment
 * 推算下一个起点；文档仍按页码翻页。
 */
function buildContinuation({ mediaType, window, durationMs, pages, pageCount }) {
  if (mediaType === 'document') {
    if (!Array.isArray(pages) || pages.length === 0 || pageCount === null || pageCount === undefined) return null;
    const lastPage = pages[pages.length - 1];
    if (lastPage >= pageCount) return null;
    const nextPage = lastPage + 1;
    const batch = Math.min(pageCount, nextPage + 11);
    return {
      nextPage,
      note: `More pages follow (${nextPage}-${pageCount}). Call media_overview with pages: "${nextPage}-${batch}".`,
    };
  }
  const duration = numberOrNull(durationMs);
  if (!window || window.endMs === null || window.endMs === undefined) return null;
  if (duration !== null && window.endMs >= duration) return null;
  const nextStartMs = window.endMs;
  return {
    nextStartMs,
    nextStartSec: nextStartMs / 1000,
    note: `More media follows at ${formatTimestamp(nextStartMs)}. Call media_overview with start: ${(nextStartMs / 1000).toFixed(2)} (and end, or segment) to page through the rest.`,
  };
}

/** document 的 pages[]（结构化返回） */
function buildPageTexts(segments) {
  const byPage = new Map();
  for (const segment of segments) {
    if (segment.page === null || segment.page === undefined) continue;
    if (!byPage.has(segment.page)) byPage.set(segment.page, []);
    if (segment.text) byPage.get(segment.page).push(segment.text);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, texts]) => ({ page, text: texts.join('\n'), truncated: false }));
}

/* ------------------------------------------------------------------ *
 * handler 实现
 * ------------------------------------------------------------------ */

async function handleProbe(args, call) {
  const base = await resolveMedia(args);
  checkApplicability(args, base.mediaType);

  const input = {
    ...baseInput(base),
    subtitle: args.subtitle ?? null,
    transcript: args.transcript ?? 'auto',
  };
  const result = (await call.dispatcher.call(base.mediaType, 'probe', input, call.backendCtx)) ?? {};
  const mediaType = refineMediaType(result, base.mediaType);
  const normalized = normalizeProbeResult(result, { ...base, mediaType }, call);

  return {
    content: [{ type: 'text', text: formatProbeText(normalized) }],
    structuredContent: normalized,
  };
}

/** 回环地址不需要 API key（与 provider 的规则一致，契约 §12.2 / §12.3） */
function isLoopback(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return ['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'].includes(host);
  } catch {
    return false;
  }
}

/** ASR provider 是否真的可用（配了 provider 但缺 key 时 probe 应如实说 available=false） */
function asrProviderUsable(runtime) {
  const provider = runtime?.asrProvider;
  if (!provider) return false;
  const config = runtime?.config?.asr;
  if (!config) return true;
  return Boolean(config.apiKey) || isLoopback(config.baseUrl);
}

/** 文档 provider 的某个角色（ocr / typeset）是否真的可用 */
function docRoleProviderUsable(runtime, role) {
  const provider = runtime?.[`${role}Provider`];
  if (!provider) return false;
  const config = runtime?.config?.[role];
  if (!config) return true;
  // builtin / none 没有凭据；只有外部 provider 才需要 key（回环地址免 key）。
  if (!providerEnv('doc', config.provider)) return true;
  return Boolean(config.apiKey) || isLoopback(config.baseUrl);
}

/** 补全 ProbeResult 的默认字段（契约 §4.3）；后端给了的值优先 */
function normalizeProbeResult(result, base, call) {
  const mediaType = base.mediaType;
  const hasAudio = result.hasAudio ?? (mediaType !== 'document');
  const audioHealth = result.audioHealth ?? null;
  const capabilities = result.capabilities ?? {};
  const asrConfigured = asrProviderUsable(call.runtime);
  const ocrConfigured = docRoleProviderUsable(call.runtime, 'ocr');
  const typesetConfigured = docRoleProviderUsable(call.runtime, 'typeset');
  const asrAvailable = asrConfigured
    && mediaType !== 'document'
    && hasAudio
    && (audioHealth === null || audioHealth.effective !== false);
  const ocrAvailable = ocrConfigured && mediaType === 'document';
  const typesetAvailable = typesetConfigured && mediaType === 'document';

  const defaults = {
    mediaType,
    path: base.path,
    sizeBytes: base.sizeBytes,
    modifiedMs: base.modifiedMs,
    durationMs: null,
    durationSec: null,
    width: null,
    height: null,
    fps: null,
    rotation: null,
    aspect: null,
    videoCodec: null,
    container: null,
    hasAudio,
    audioCodec: null,
    audioChannels: null,
    sampleRateHz: null,
    audioHealth,
    pageCount: null,
    hasTextLayer: null,
    subtitleTracks: [],
    audioTracks: [],
    capabilities: {
      asr: {
        available: asrAvailable,
        provider: asrAvailable ? (call.runtime?.asrProvider?.id ?? null) : null,
        reason: asrAvailable ? null : asrUnavailableReason({ mediaType, hasAudio, audioHealth, call }),
      },
      ocr: {
        available: ocrAvailable,
        provider: ocrAvailable ? (call.runtime?.ocrProvider?.id ?? null) : null,
        reason: ocrAvailable ? null : ocrUnavailableReason(mediaType, call),
      },
      typeset: {
        available: typesetAvailable,
        provider: typesetAvailable ? (call.runtime?.typesetProvider?.id ?? null) : null,
        reason: typesetAvailable ? null : typesetUnavailableReason(mediaType, call),
      },
      transcriptSource: result.capabilities?.transcriptSource ?? 'none',
      transcriptOrigin: result.capabilities?.transcriptOrigin ?? 'none',
      transcriptPath: result.capabilities?.transcriptPath ?? null,
      transcriptReason: result.capabilities?.transcriptReason ?? null,
    },
    recommended: defaultRecommended(mediaType, result.durationSec ?? null, result.pageCount ?? null),
  };

  return {
    ...defaults,
    ...result,
    mediaType,
    path: base.path,
    sizeBytes: base.sizeBytes,
    modifiedMs: base.modifiedMs,
    capabilities: {
      ...defaults.capabilities,
      ...capabilities,
      asr: { ...defaults.capabilities.asr, ...(capabilities.asr ?? {}) },
      ocr: { ...defaults.capabilities.ocr, ...(capabilities.ocr ?? {}) },
      typeset: { ...defaults.capabilities.typeset, ...(capabilities.typeset ?? {}) },
    },
    recommended: { ...defaults.recommended, ...(result.recommended ?? {}) },
  };
}

function asrUnavailableReason({ mediaType, hasAudio, audioHealth, call }) {
  if (mediaType === 'document') return 'asr is not applicable to document media.';
  if (!hasAudio) return 'this file has no audio track.';
  if (audioHealth && audioHealth.effective === false) {
    return `audio health is "${audioHealth.verdict ?? 'too-quiet'}" — no effective speech, so ASR is skipped to avoid a hallucinated transcript.`;
  }
  if (call.runtime?.providerErrors?.asr) return call.runtime.providerErrors.asr;
  if (!call.runtime?.asrProvider) return 'MMGREP_ASR_PROVIDER is "none". Transcription will be empty.';
  const config = call.runtime?.config?.asr;
  if (config && !config.apiKey && !isLoopback(config.baseUrl)) {
    return `${providerApiKeyEnv('asr', config.provider)} is not set for provider "${config.provider}".`;
  }
  return null;
}

function ocrUnavailableReason(mediaType, call) {
  if (mediaType !== 'document') return 'ocr is not applicable to this media type.';
  if (call.runtime?.providerErrors?.ocr) return call.runtime.providerErrors.ocr;
  if (!call.runtime?.ocrProvider) return 'MMGREP_OCR_PROVIDER is "none". Pages without a text layer are returned as page images only.';
  const config = call.runtime?.config?.ocr;
  if (config && providerEnv('doc', config.provider) && !config.apiKey && !isLoopback(config.baseUrl)) {
    return `${providerApiKeyEnv('doc', config.provider)} is not set for provider "${config.provider}".`;
  }
  return null;
}

function typesetUnavailableReason(mediaType, call) {
  if (mediaType !== 'document') return 'typeset is not applicable to this media type.';
  if (call.runtime?.providerErrors?.typeset) return call.runtime.providerErrors.typeset;
  if (!call.runtime?.typesetProvider) {
    return 'MMGREP_TYPESET_PROVIDER is "none". Pages with a text layer use the raw extracted text.';
  }
  const config = call.runtime?.config?.typeset;
  if (config && providerEnv('doc', config.provider) && !config.apiKey && !isLoopback(config.baseUrl)) {
    return `${providerApiKeyEnv('doc', config.provider)} is not set for provider "${config.provider}".`;
  }
  return null;
}

function defaultRecommended(mediaType, durationSec, pageCount) {
  const long = mediaType === 'document'
    ? (pageCount !== null && pageCount > 30)
    : (durationSec !== null && durationSec > 1800);
  return {
    mode: long ? 'sequence' : 'single',
    segmentSec: 300,
    overviewImages: 2,
    cellsPerImage: mediaType === 'document' ? 6 : 9,
    estimatedImageTokens: 2458,
    note: long
      ? 'Long media: narrow the range first (start/end for video and audio, pages for documents), then page through with the continuation hint.'
      : 'One overview is enough. media_overview({ path }) is the next step.',
  };
}

async function handleOverview(args, call) {
  const base = await resolveMedia(args);
  checkApplicability(args, base.mediaType);
  checkMethod(base.mediaType, 'overview');

  await call.onProgress({ stage: 'scanning', used: describeWindowForProgress(args) });

  const probe = await internalProbe(base, {
    subtitle: args.subtitle ?? null,
    transcript: args.transcript ?? 'auto',
  }, call);
  const mediaType = refineMediaType(probe, base.mediaType);
  if (mediaType !== base.mediaType) {
    checkApplicability(args, mediaType);
    checkMethod(mediaType, 'overview');
  }

  const durationSec = numberOrNull(probe.durationSec);
  const pageCount = integerOrNull(probe.pageCount);
  const window = mediaType === 'document' ? null : computeTimeWindow(args, durationSec);
  const pages = mediaType === 'document' ? computePages(args, pageCount) : null;

  const plan = planOverviewImages(args, mediaType, call.config);
  // images: 0 → 零像素纯文本模式：后端不出图，段落直接来自转写/页文字。
  const textOnly = Boolean(plan && plan.requested.images === 0);
  const input = {
    ...baseInput({ ...base, mediaType }),
    subtitle: args.subtitle ?? null,
    transcript: mediaType === 'document' ? undefined : (args.transcript ?? 'auto'),
    startMs: window?.startMs ?? null,
    endMs: window?.endMs ?? null,
    startSec: window?.startSec ?? null,
    endSec: window?.endSec ?? null,
    clipped: window?.clipped ?? false,
    pages,
    pageCount,
    durationSec,
    envelope: Boolean(args.envelope),
    // 9z5.31：文档 ocr:"force" → 后端 ocrMode；video/audio 已被 checkApplicability 拒绝。
    ocrMode: mediaType === 'document' ? (args.ocr ?? 'auto') : undefined,
    ...(plan ? { cells: plan.produced.cells, images: plan.produced.images, maxEdge: plan.produced.maxEdge } : {}),
  };

  await call.onProgress({ stage: 'transcribing', used: args.subtitle !== undefined ? String(args.subtitle) : (args.transcript ?? 'auto') });
  const result = (await call.dispatcher.call(mediaType, 'overview', input, call.backendCtx)) ?? {};
  await call.onProgress({ stage: 'rendering', used: `${Array.isArray(result.images) ? result.images.length : 0} image(s)` });

  const segments = normalizeSegmentsSafe(result.segments);
  const rawImages = Array.isArray(result.images) ? result.images : [];
  const { blocks, descriptors } = plan
    ? collectImages(rawImages, plan, call.config)
    : { blocks: [], descriptors: [] };
  const budget = plan
    ? budgetReport(plan, {
      producedImages: descriptors.length,
      producedCells: descriptors.reduce((sum, d) => sum + (d.cells ?? 0), 0),
      extraWarnings: result.warnings,
    })
    : { ...zeroBudget(call.config), warning: null };
  const transcript = resolveTranscriptInfo(result, segments);

  // 全文落盘（契约 §9）：返回路径，不内联全文。
  const exported = await persistOverview({
    call,
    base: { ...base, mediaType },
    mediaType,
    segments,
    transcript,
    window,
    pages,
    descriptors,
    budget,
    warnings: [...(Array.isArray(result.warnings) ? result.warnings : [])],
    durationSec,
    pageCount,
  });
  // 落盘成功与否都要在 text content 里说明（.22）：只放 structuredContent 的话，
  // 依赖文本通道的宿主永远看不到路径。
  const fullTextNote = exported.ok
    ? exported.note
    : `full text: NOT written — ${exported.reason}`;

  // 续读提示只依赖请求范围（不再依赖内联截断到哪），所以可以在格式化之前算好，
  // 并作为固定 notes 计入内联上限。
  const continuation = buildContinuation({
    mediaType,
    window,
    durationMs: numberOrNull(probe.durationMs) ?? (durationSec !== null ? Math.round(durationSec * 1000) : null),
    pages,
    pageCount,
  });

  const text = formatOverviewText({
    mediaType,
    base,
    window,
    pages,
    durationSec,
    segments,
    transcript,
    imageDescriptors: descriptors,
    textOnly,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    budget: {
      ...budget,
      maxInlineChars: call.config?.text?.maxInlineChars ?? DEFAULT_MAX_TEXT_INLINE_CHARS,
      perImageTokens: plan?.perImageTokens ?? null,
    },
    hasAudio: probe.hasAudio ?? mediaType !== 'document',
    fullTextNote,
    continuationNote: continuation?.note ?? null,
  });

  const structuredContent = {
    mediaType,
    path: base.path,
    window: {
      startMs: window?.startMs ?? null,
      endMs: window?.endMs ?? null,
      startSec: window?.startSec ?? null,
      endSec: window?.endSec ?? null,
      pages,
      clipped: window?.clipped ?? false,
    },
    images: descriptors,
    // 只放**实际内联**的单元（抽样后就是被抽到的那些；全文在 content.md / segments.jsonl）
    segments: text.inlineSegments,
    transcript,
    pages: mediaType === 'document' ? buildPageTexts(segments) : null,
    fullText: exported.ok
      ? {
        dir: exported.outDir,
        contentMd: exported.contentPath,
        segmentsJsonl: exported.segmentsPath,
        manifestJson: exported.manifestPath,
      }
      : null,
    fullTextReason: exported.ok ? null : exported.reason,
    truncated: text.truncated,
    // 预览是 whole（全量）还是 sampled（抽样），以及覆盖了哪些页
    preview: text.preview,
    continuation,
    budget,
  };

  return {
    content: [{ type: 'text', text: text.text }, ...blocks],
    structuredContent,
  };
}

function describeWindowForProgress(args) {
  if (args.pages !== undefined) return `pages ${args.pages}`;
  if (args.start !== undefined || args.end !== undefined) {
    return `${args.start ?? 0}-${args.end ?? 'end'}s`;
  }
  return 'whole media';
}

/**
 * 工具层的三类媒体 → cangjie SourceDocument 的 `media_type` 枚举（契约 §9.4）。
 * 注意：`manifest.json` 的 `source.mediaType` 用本项目口径（video/audio/document），
 * 这里只给 `document.json` 用；图片类文档按契约偏差映射成 `pdf`。
 */
export function cangjieMediaType(mediaType, filePath) {
  if (mediaType === 'video' || mediaType === 'audio') return mediaType;
  const ext = (/\.[^./\\]+$/.exec(String(filePath).toLowerCase())?.[0]) ?? '';
  switch (ext) {
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.txt':
      return 'txt';
    case '.html':
    case '.htm':
      return 'html';
    case '.epub':
      return 'epub';
    case '.docx':
    case '.doc':
      return 'docx';
    case '.pptx':
    case '.ppt':
      return 'pptx';
    case '.xlsx':
    case '.xls':
      return 'xlsx';
    case '.srt':
    case '.vtt':
    case '.ass':
    case '.ssa':
      return 'subtitle';
    // PDF、图片类文档以及识别不出的页面式文档都落在这个枚举值上
    default:
      return 'pdf';
  }
}

/** 全文落盘：契约 §9 的 content.md / segments.jsonl / manifest.json */
async function persistOverview({ call, base, mediaType, segments, transcript, window, pages, descriptors, budget, warnings, durationSec, pageCount }) {
  const { cache, logger } = call;
  let sha256 = null;
  if (cache?.contentKeyForFile) {
    try {
      const info = await cache.contentKeyForFile(base.path);
      sha256 = info?.sha256 ?? null;
    } catch (error) {
      logger?.warn?.(`could not hash ${base.path} for the cache key: ${error?.message ?? error}`);
    }
  }
  if (!sha256) sha256 = await sha256File(base.path);

  const key = `sha256:${sha256}`;
  let outDir;
  let fallbackDir = false;
  if (cache?.prepareDir) {
    try {
      outDir = await cache.prepareDir(key);
    } catch (error) {
      logger?.warn?.(`could not prepare the cache directory: ${error?.message ?? error}`);
    }
  }
  if (!outDir) {
    outDir = path.join(os.tmpdir(), 'multimediagrep', sha256);
    fallbackDir = true;
  }

  let exported;
  try {
    exported = await exportAnalysis({
      outDir,
      source: {
        path: base.path,
        mediaType,
        sizeBytes: base.sizeBytes,
        modifiedMs: base.modifiedMs,
        sha256,
        durationSec,
        pageCount,
      },
      mediaType: cangjieMediaType(mediaType, base.path),
      segments,
      transcript: {
        source: transcript.source,
        origin: transcript.origin,
        language: transcript.language,
        provider: transcript.provider,
        model: transcript.model,
        file: transcript.file,
      },
      overview: {
        images: descriptors.map((d) => ({
          index: d.index,
          width: d.width,
          height: d.height,
          cells: d.cells,
          mimeType: d.mimeType,
          bytes: d.bytes,
          estimatedTokens: d.estimatedTokens,
        })),
        estimatedTokens: budget.estimatedTokens,
      },
      window: window ? { startMs: window.startMs, endMs: window.endMs } : null,
      pages,
      provider: transcript.provider,
      warnings,
      tool: 'media_overview',
    });
  } catch (error) {
    // 落盘失败不能让整个 overview 调用失败：inline 预览仍然有用，
    // 但必须在 text content 里把「没写成 + 原因」说清楚（.22）。
    const reason = error?.message ?? String(error);
    logger?.warn?.(`could not write the full text export: ${reason}`);
    return { ok: false, reason };
  }

  if (cache?.register) {
    try {
      await cache.register(key);
    } catch (error) {
      logger?.debug?.(`could not register the export entry in the cache: ${error?.message ?? error}`);
    }
  }
  const noteSuffix = fallbackDir
    ? '; the cache directory was unavailable, so this copy went to the OS temp directory and may be cleaned up'
    : '';
  return {
    ok: true,
    ...exported,
    fallbackDir,
    note: `full text: ${exported.contentPath} (segments.jsonl, manifest.json in the same directory${noteSuffix})`,
  };
}

/** 没有 cache 模块时的兜底哈希（流式，不把整个视频读进内存） */
async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function handleZoom(args, call) {
  const base = await resolveMedia(args);
  checkApplicability(args, base.mediaType);
  checkMethod(base.mediaType, 'zoom');

  const probe = await internalProbe(base, {}, call);
  const mediaType = refineMediaType(probe, base.mediaType);
  if (mediaType !== base.mediaType) {
    checkApplicability(args, mediaType);
    checkMethod(mediaType, 'zoom');
  }
  const durationSec = numberOrNull(probe.durationSec);
  const pageCount = integerOrNull(probe.pageCount);

  const maxEdge = args.maxEdge !== undefined ? Number(args.maxEdge) : 1600;
  const limitEdge = call.config?.images?.maxEdge ?? IMAGE_LIMITS.maxMaxEdge;
  validateImageShape({ cells: 1, images: 1, maxEdge, limitEdge });

  let crop = null;
  if (args.crop !== undefined) {
    const { x, y, width, height } = args.crop ?? {};
    if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new ToolError('INVALID_ARGUMENT', 'crop must be an object {x, y, width, height} with four numbers in 0..1.');
    }
    crop = validateCrop(args.crop);
  }

  const input = { ...baseInput({ ...base, mediaType }), crop, maxEdge };
  let target;

  if (mediaType === 'video') {
    const hasAt = args.at !== undefined;
    const hasWindow = args.start !== undefined || args.end !== undefined;
    if (hasAt && hasWindow) {
      throw new ToolError('INVALID_ARGUMENT', 'at and start/end are mutually exclusive — pass either a single timestamp or a window.');
    }
    if (!hasAt && (args.start === undefined || args.end === undefined)) {
      throw new ToolError('INVALID_ARGUMENT', 'for video, pass "at" (one timestamp) or both "start" and "end" (a window).');
    }
    if (hasAt) {
      const atSec = Number(args.at);
      if (!Number.isFinite(atSec) || atSec < 0) {
        throw new ToolError('INVALID_ARGUMENT', 'at must be >= 0.');
      }
      if (durationSec !== null && atSec > durationSec) {
        throw new ToolError(
          'OUT_OF_RANGE',
          `at (${atSec.toFixed(1)} s) is beyond the end of the media (duration ${durationSec.toFixed(1)} s).`,
        );
      }
      const atMs = Math.round(atSec * 1000);
      input.atMs = atMs;
      input.atSec = atSec;
      input.selection = 'exact';
      target = {
        kind: 'frame',
        atMs,
        atSec,
        fromMs: null,
        toMs: null,
        selection: 'exact',
        page: null,
        crop,
      };
    } else {
      const window = computeTimeWindow({ start: args.start, end: args.end, segment: args.segment }, durationSec);
      input.startMs = window.startMs;
      input.endMs = window.endMs;
      input.startSec = window.startSec;
      input.endSec = window.endSec;
      input.clipped = window.clipped;
      input.selection = 'sharpest';
      target = {
        kind: 'frame',
        atMs: null,
        atSec: null,
        fromMs: window.startMs,
        toMs: window.endMs,
        selection: 'sharpest',
        page: null,
        crop,
      };
    }
  } else {
    if (args.page === undefined) {
      throw new ToolError('INVALID_ARGUMENT', 'page is required for document media.');
    }
    const page = Number(args.page);
    if (!Number.isInteger(page) || page < 1) {
      throw new ToolError('INVALID_ARGUMENT', `page must be a 1-based integer (got ${JSON.stringify(args.page)}).`);
    }
    if (pageCount !== null && page > pageCount) {
      throw new ToolError('OUT_OF_RANGE', `page ${page} is out of range. This document has ${pageCount} pages.`);
    }
    input.page = page;
    target = { kind: 'page', atMs: null, atSec: null, page, crop };
  }

  const result = (await call.dispatcher.call(mediaType, 'zoom', input, call.backendCtx)) ?? {};
  const rawImages = Array.isArray(result.images) ? result.images : [];
  validateProducedImages(rawImages, { limitEdge });
  if (rawImages.length !== 1) {
    throw new ToolError('INTERNAL', `the ${mediaType} backend returned ${rawImages.length} images; media_zoom returns exactly one.`);
  }
  const described = describeImages(rawImages, { source: 'visual' });
  const image = described.descriptors[0];
  const backendTarget = result.target && typeof result.target === 'object' ? result.target : null;
  const finalTarget = backendTarget ? { ...target, ...backendTarget, page: backendTarget.page ?? target.page ?? null } : target;

  // 软预算：单张图超预算时只警告（显式形状不改形）
  const config = call.config ?? {};
  const limitTokens = config?.images?.maxTokens ?? DEFAULT_MAX_IMAGE_TOKENS;
  const warnings = [...(Array.isArray(result.warnings) ? result.warnings : [])];
  if (image?.estimatedTokens && image.estimatedTokens > limitTokens) {
    warnings.push(`this image needs ~${image.estimatedTokens} image tokens, above the soft budget of ${limitTokens}. Lower maxEdge to reduce cost.`);
  }

  const structuredContent = {
    mediaType,
    path: base.path,
    target: finalTarget,
    image,
    imageCount: 1,
    text: formatZoomText({
      base,
      mediaType,
      target: finalTarget,
      image,
      cropLabel: crop ? `crop ${crop.x},${crop.y} ${crop.width}x${crop.height}` : 'full frame',
    }),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  const text = structuredContent.text;

  return {
    content: [{ type: 'text', text }, ...described.blocks],
    structuredContent,
  };
}

async function handleLocate(args, call) {
  const base = await resolveMedia(args);
  checkApplicability(args, base.mediaType);
  checkMethod(base.mediaType, 'locate');

  if (typeof args.query !== 'string' || args.query.trim() === '') {
    throw new ToolError('INVALID_ARGUMENT', 'query is required.');
  }
  const max = args.max !== undefined ? Number(args.max) : 5;
  if (!Number.isInteger(max) || max < 1 || max > 20) {
    throw new ToolError('INVALID_ARGUMENT', `max must be an integer between 1 and 20 (got ${JSON.stringify(args.max)}).`);
  }

  const probe = await internalProbe(base, {
    subtitle: args.subtitle ?? null,
    transcript: args.transcript ?? 'auto',
  }, call);
  const mediaType = refineMediaType(probe, base.mediaType);
  if (mediaType !== base.mediaType) {
    checkApplicability(args, mediaType);
    checkMethod(mediaType, 'locate');
  }

  const durationSec = numberOrNull(probe.durationSec);
  const pageCount = integerOrNull(probe.pageCount);
  const window = mediaType === 'document' ? null : computeTimeWindow(args, durationSec);
  const pages = mediaType === 'document' ? computePages(args, pageCount) : null;

  const input = {
    ...baseInput({ ...base, mediaType }),
    query: args.query,
    // 文档：向后端多要几页候选，才能按 hits 排序后再按用户的 max 截断
    max: mediaType === 'document' ? DOC_LOCATE_CANDIDATE_MAX : max,
    subtitle: args.subtitle ?? null,
    transcript: mediaType === 'document' ? undefined : (args.transcript ?? 'auto'),
    startMs: window?.startMs ?? null,
    endMs: window?.endMs ?? null,
    startSec: window?.startSec ?? null,
    endSec: window?.endSec ?? null,
    clipped: window?.clipped ?? false,
    pages,
    pageCount,
    durationSec,
    includeFrame: Boolean(args.includeFrame),
    // 9z5.31：文档 ocr:"force" → 后端 ocrMode（locate 也要能搜重新识别出来的文字）。
    ocrMode: mediaType === 'document' ? (args.ocr ?? 'auto') : undefined,
  };

  const result = (await call.dispatcher.call(mediaType, 'locate', input, call.backendCtx)) ?? {};
  const rawMatches = normalizeMatches(result.matches, pageCount);
  // 文档分支：整页命中 → 页码 + 命中次数 + 命中附近的片段（score 在文档侧没有意义）
  const documentMatches = mediaType === 'document'
    ? buildDocumentMatches(rawMatches, args.query)
    : null;
  const matches = documentMatches ?? rawMatches;
  const transcriptSource = result.transcript?.source ?? matches[0]?.source ?? 'none';
  const transcriptOrigin = result.transcript?.origin ?? matches[0]?.origin ?? 'none';
  const totalSegments = Number.isInteger(result.totalSegments) ? result.totalSegments : matches.length;
  const warnings = [...(Array.isArray(result.warnings) ? result.warnings : [])];

  const contentBlocks = [];
  let frame = null;
  if (args.includeFrame) {
    const rawFrame = result.frame;
    if (rawFrame?.buffer) {
      const described = describeImages([rawFrame], { source: 'visual' });
      const descriptor = described.descriptors[0];
      const frameAtMs = integerOrNull(rawFrame.atMs) ?? matches[0]?.startMs ?? null;
      frame = {
        atMs: frameAtMs,
        atSec: frameAtMs === null ? null : frameAtMs / 1000,
        width: descriptor.width,
        height: descriptor.height,
        estimatedTokens: descriptor.estimatedTokens,
      };
      contentBlocks.push(...described.blocks);
    } else {
      warnings.push('includeFrame was requested but the backend returned no frame for the best match.');
    }
  }

  const plan = documentMatches
    ? planDocumentLocate({ query: args.query, matches: documentMatches, totalSegments, max })
    : null;
  const shownMatches = plan ? plan.matches : matches;

  const text = formatLocateText({
    query: args.query,
    matches: shownMatches,
    totalSegments,
    mediaType,
    morePages: plan ? plan.morePages : null,
  });

  const structuredContent = {
    mediaType,
    path: base.path,
    query: args.query,
    transcriptSource,
    transcriptOrigin,
    matches: shownMatches,
    totalSegments,
    searchedWindow: {
      startMs: window?.startMs ?? null,
      endMs: window?.endMs ?? null,
      pages,
    },
    frame,
    text,
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  return {
    content: [{ type: 'text', text }, ...contentBlocks],
    structuredContent,
  };
}

function normalizeMatches(rawMatches, pageCount) {
  const list = Array.isArray(rawMatches) ? rawMatches : [];
  return list.map((match, i) => {
    const startMs = integerOrNull(match?.startMs);
    const endMs = integerOrNull(match?.endMs);
    const page = integerOrNull(match?.page);
    if (page !== null && pageCount !== null && page > pageCount) {
      throw new ToolError('OUT_OF_RANGE', `page ${page} is out of range. This document has ${pageCount} pages.`);
    }
    return {
      rank: Number.isInteger(match?.rank) ? match.rank : i + 1,
      score: Number.isFinite(Number(match?.score)) ? Number(match.score) : 0,
      startMs,
      endMs,
      startSec: startMs === null ? null : startMs / 1000,
      endSec: endMs === null ? null : endMs / 1000,
      text: String(match?.text ?? ''),
      source: match?.source ?? 'none',
      origin: match?.origin ?? 'none',
      // 文档：逐页来源细节（契约 v2 的 textOrigin；视频/录音为 null）。
      textOrigin: match?.textOrigin ?? null,
      page,
    };
  });
}

/**
 * 文档分支：把「整页命中」变成「页码 + 命中次数 + 命中附近的片段」。
 *
 * - hits：这页命中几次（精确短语；没有精确命中就退回 token 覆盖，标 fuzzy）
 * - snippet：首个命中 ±150 字符，对齐词边界，折叠换行与排版空白
 * - 不带 score：文档没有「分数」，同一字段两种语义会打架（9z5.23 / 9z5.25）
 * - 不带 text：整页正文不再返回（要整页用 media_overview({ pages }) 或 content.md）
 * 排序：精确命中优先 → 命中次数降序 → 页码升序。
 */
function buildDocumentMatches(matches, query) {
  const out = [];
  for (const match of matches) {
    const { hits, fuzzy, index } = countHits(match.text, query);
    if (hits <= 0) continue;
    out.push({
      page: match.page,
      hits,
      fuzzy,
      snippet: buildSnippet(match.text, query, { index, radius: DOC_SNIPPET_RADIUS }),
      source: match.source,
      origin: match.origin,
      textOrigin: match.textOrigin ?? null,
    });
  }
  // 排序：精确命中优先 → 命中次数降序 → 页码升序。
  // 精确命中优先是必要的：token 覆盖（fuzzy）会把只命中一个常见词的页也算进来，
  // 那些页的 hits 可能比整句命中的一页还多（“SECOND PAGE” vs 每页都有的 “PAGE”）。
  out.sort((a, b) => (Number(a.fuzzy) - Number(b.fuzzy))
    || (b.hits - a.hits)
    || ((a.page ?? 0) - (b.page ?? 0)));
  return out.map((match, index) => ({
    rank: index + 1,
    startMs: null,
    endMs: null,
    startSec: null,
    endSec: null,
    ...match,
  }));
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

/** 4 个工具的定义表（顺序即注册顺序） */
export const TOOL_DEFINITIONS = Object.freeze([
  { name: 'media_probe', title: 'Probe media', description: PROBE_DESCRIPTION, shape: TOOL_SHAPES.media_probe, handler: handleProbe },
  { name: 'media_overview', title: 'Overview', description: OVERVIEW_DESCRIPTION, shape: TOOL_SHAPES.media_overview, handler: handleOverview },
  { name: 'media_zoom', title: 'Zoom', description: ZOOM_DESCRIPTION, shape: TOOL_SHAPES.media_zoom, handler: handleZoom },
  { name: 'media_locate', title: 'Locate', description: LOCATE_DESCRIPTION, shape: TOOL_SHAPES.media_locate, handler: handleLocate },
]);

/**
 * 进度上报器（契约 §2.6）：阻塞调用 + `notifications/progress`。
 * 宿主没给 progressToken / 宿主不支持 / 主动关闭时静默跳过，不影响结果。
 */
export function createProgressReporter({ tool, extra, config, logger = null }) {
  const token = extra?._meta?.progressToken;
  if (config?.progress?.enabled === false || token === undefined || typeof extra?.sendNotification !== 'function') {
    return async () => {};
  }
  let counter = 0;
  const defaultTotal = 5;
  return async (event = {}) => {
    const payload = typeof event === 'string' ? { stage: event } : event;
    const stage = payload.stage ?? 'working';
    counter += 1;
    const progress = Number.isFinite(payload.progress) ? payload.progress : counter;
    const total = Number.isFinite(payload.total) ? payload.total : defaultTotal;
    const detail = payload.used ?? payload.message ?? null;
    const message = `${tool} ${progress}/${total} · ${stage}${detail ? ` ${detail}` : ''}`;
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, total, message },
      });
    } catch (error) {
      // best-effort：进度失败绝不能影响结果
      logger?.debug?.(`progress notification failed: ${error?.message ?? error}`);
    }
  };
}

/** 每次调用共享的上下文 */
export function createCallContext(runtime, extra, toolName) {
  const onProgress = createProgressReporter({
    tool: toolName,
    extra,
    config: runtime.config,
    logger: runtime.logger,
  });
  return {
    runtime,
    tool: toolName,
    config: runtime.config,
    logger: runtime.logger,
    cache: runtime.cache ?? null,
    dispatcher: runtime.dispatcher,
    signal: extra?.signal ?? null,
    onProgress,
    backendCtx: {
      cache: runtime.cache ?? null,
      asrProvider: runtime.asrProvider ?? null,
      ocrProvider: runtime.ocrProvider ?? null,
      typesetProvider: runtime.typesetProvider ?? null,
      logger: runtime.logger,
      onProgress,
      signal: extra?.signal ?? null,
      config: runtime.config,
    },
  };
}

/**
 * 把 4 个工具注册到 McpServer。
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} runtime { config, logger, cache, asrProvider, ocrProvider, typesetProvider, backends, dispatcher }
 */
export function registerTools(server, runtime) {
  for (const definition of TOOL_DEFINITIONS) {
    const inputSchema = z.object(definition.shape).strict();
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guardToolHandler(
        definition.name,
        async (args, extra) => definition.handler(args ?? {}, createCallContext(runtime, extra, definition.name)),
        { logger: runtime.logger },
      ),
    );
  }
}

/** 默认 dispatcher 工厂（测试 / createServer 用） */
export function createRuntimeDispatcher(backends) {
  return createDispatcher(backends ?? {});
}
