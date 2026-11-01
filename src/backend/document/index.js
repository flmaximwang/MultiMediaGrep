// src/backend/document/index.js —— 文档后端（PDF / 图片 / 纯文本）
//
// 职责（docs/mcp-contract.md §4.3、§5、§6、§7）：
//   probe    文件元信息、页数、是否有文字层、OCR 能力
//   overview 页面缩略图拼图 + 每页文字（有 provider 用 provider，否则用 PDF 文字层）
//   zoom     单页整页 / 局部放大成一张 PNG
//   locate   在页面文字里找短语，返回页码；可选附最佳匹配页的图
//
// 设计约束：
//   - server 本身**不调用任何 LLM**。OCR / 文档解析交给用户配置的 ctx.docProvider；
//     没配就只出页面图，让多模态模型自己看。
//   - 不假设部署机装了 PDF 工具：运行时探测，缺工具时抛 TOOL_NOT_FOUND 并点名安装包。
//     栅格化链 pdftoppm → mutool draw → gs；文字层链 pdftotext → mutool。
//   - 所有命令走 media/ffmpeg.js 的 run()（spawn，无 shell 拼接）。
//   - 临时文件只写在 MMGREP_CACHE_DIR（默认 ~/.cache/multimediagrep）下，绝不在
//     用户文件旁边生成任何东西。
//   - 图片预算（§10）由 server 的 planImageBudget 传入；这里只保证不超：每张拼图
//     ≤ cells 格、≤ images 张、长边 ≤ maxEdge、单图 ≤ 2,000,000 px。

import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { hashFile } from '../../cache/hash.js';
import { resolveCacheConfig } from '../../cache/index.js';
import { extOf, sniffMagic } from '../../media/detect.js';
import { ffprobeJson } from '../../media/ffmpeg.js';
import { ToolError, validateCrop } from '../../media/interface.js';
import { matchSegments } from '../../media/match.js';
import { IMAGE_LIMITS, layoutForCells } from '../../server/images.js';
import { providerApiKeyEnv } from '../../server/config.js';
import { createPdfSupport, normalizePageText } from './pdf.js';
import {
  DEFAULT_LOCATE_FRAME_MAX_EDGE,
  DEFAULT_OVERVIEW_MAX_EDGE,
  DEFAULT_PAGE_ASPECT,
  DEFAULT_ZOOM_MAX_EDGE,
  MAX_IMAGE_PIXELS,
  composeGrid,
  cropAndScale,
  cropRect,
  fitSize,
  planGrid,
} from './render.js';

const DEFAULT_CELLS = 6;
const DEFAULT_IMAGES = 2;
const MAX_CELLS = IMAGE_LIMITS.maxCellsPerImage;
const MAX_IMAGES = IMAGE_LIMITS.maxImagesPerCall;
const MIN_EDGE = IMAGE_LIMITS.minMaxEdge;
const MAX_EDGE = IMAGE_LIMITS.maxMaxEdge;

/** 拼图渲染 DPI：缩略图不需要太高，但低于 ~96 dpi 的页面模型也很难看清。 */
const MIN_GRID_DPI = 96;
const MAX_GRID_DPI = 300;
/** zoom 时为了把局部裁切放大到 maxEdge，允许更高的渲染分辨率。 */
const MIN_ZOOM_DPI = 72;
const MAX_ZOOM_DPI = 600;
/** 单页栅格化的像素保险丝（避免异常大的页面把内存吃光）。 */
const MAX_RENDER_PIXELS = 40_000_000;

/** 拿不到 PDF 页面尺寸时用的 A4 竖版（仅用于估算渲染 DPI，裁切仍按实际像素）。 */
const FALLBACK_PAGE = Object.freeze({ width: 595, height: 842 });

const PDF_EXT = new Set(['.pdf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);
const TEXT_EXT = new Set(['.txt', '.md', '.markdown']);
/** Office 明确暂不支持（任务范围外，给 LibreOffice 转换提示）。 */
const OFFICE_EXT = new Set(['.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls']);
/** 其它常见但暂不支持的文档格式，同样提示先转 PDF。 */
const OTHER_DOC_EXT = new Set(['.odt', '.ods', '.odp', '.rtf', '.epub']);

const IMAGE_CONTAINER_BY_MAGIC = Object.freeze({
  png: 'png',
  jpg: 'jpeg',
  gif: 'gif',
  tiff: 'tiff',
  webp: 'webp',
});

const DOCUMENT_FORMATS_HINT =
  'Supported document inputs: PDF (.pdf), images (.png .jpg .jpeg .webp .bmp .gif .tif .tiff) '
  + 'and plain text (.txt .md .markdown).';

const OCR_HINT =
  'Configure a document parser with MMGREP_DOC_PROVIDER=mineru and MMGREP_MINERU_API_KEY, '
  + 'or use media_overview to work from the page images.';

/* ------------------------------------------------------------------ *
 * 文件类型判定
 * ------------------------------------------------------------------ */

async function readHead(filePath, bytes = 16) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function imageContainerFromExt(ext, magic) {
  if (magic && IMAGE_CONTAINER_BY_MAGIC[magic]) return IMAGE_CONTAINER_BY_MAGIC[magic];
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.tif' || ext === '.tiff') return 'tiff';
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

function officeError(ext, filePath) {
  const isOffice = OFFICE_EXT.has(ext);
  const label = isOffice
    ? `Office document format "${ext}" is not supported yet`
    : `Document format "${ext}" is not supported yet`;
  return new ToolError(
    'UNSUPPORTED_MEDIA_TYPE',
    `${label}. MultiMediaGrep's document backend currently reads PDF, page images and plain text.`,
    'Office support is deferred. Convert the file to PDF first — for example '
      + `\`soffice --headless --convert-to pdf ${JSON.stringify(filePath ?? `<file>${ext}`)}\` (LibreOffice) — then pass the PDF path.`,
  );
}

/**
 * 判定文档子类型。魔数优先于扩展名（一个 .docx 里装的可能是 PDF）。
 *
 * @returns {Promise<{kind:'pdf'|'image'|'text', ext:string, magic:string|null, container:string}>}
 */
async function classifyDocument(filePath) {
  const ext = extOf(filePath);
  let magic = null;
  try {
    magic = sniffMagic(await readHead(filePath));
  } catch {
    magic = null;
  }

  if (magic === 'pdf') return { kind: 'pdf', ext, magic, container: 'pdf' };
  if (IMAGE_CONTAINER_BY_MAGIC[magic]) {
    return { kind: 'image', ext, magic, container: IMAGE_CONTAINER_BY_MAGIC[magic] };
  }
  if (OFFICE_EXT.has(ext) || OTHER_DOC_EXT.has(ext)) throw officeError(ext, filePath);
  if (PDF_EXT.has(ext)) return { kind: 'pdf', ext, magic, container: 'pdf' };
  if (IMAGE_EXT.has(ext)) return { kind: 'image', ext, magic, container: imageContainerFromExt(ext, magic) };
  if (TEXT_EXT.has(ext)) {
    return {
      kind: 'text',
      ext,
      magic,
      container: ext === '.md' || ext === '.markdown' ? 'markdown' : 'text',
    };
  }

  throw new ToolError(
    'UNSUPPORTED_MEDIA_TYPE',
    `Unsupported document file type "${ext || 'unknown'}" for "${filePath}". ${DOCUMENT_FORMATS_HINT}`,
    'Convert the file to PDF first, or pass a supported PDF, image or plain-text file.',
  );
}

/* ------------------------------------------------------------------ *
 * 元信息与页尺寸
 * ------------------------------------------------------------------ */

async function readImageSize(filePath, { signal } = {}) {
  const info = await ffprobeJson(filePath, { signal });
  const streams = Array.isArray(info?.streams) ? info.streams : [];
  const stream = streams.find((item) => item?.codec_type === 'video') ?? streams[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new ToolError('INTERNAL', `could not read the pixel dimensions of "${filePath}" with ffprobe.`);
  }
  return { width, height };
}

/** 单个后端实例内的短缓存：一次 MCP 调用里 server 会先 probe、再调 overview/zoom/locate。 */
const INSPECT_CACHE_MAX = 32;

function cleanupQuietly(dir) {
  return rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function makeWorkDir(ctx, filePath, kind) {
  const { dir } = resolveCacheConfig(process.env);
  const { sha256 } = await hashFile(filePath);
  const base = path.join(dir, 'work', 'document', sha256.slice(0, 16));
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, `${kind}-`));
}

/**
 * 用 72 dpi 渲染第 1 页再量像素，作为 PDF 页面尺寸的兜底（72 dpi 下 1 px ≈ 1 pt）。
 * 没有栅格化工具时返回 null，不因为 probe 失败而拒绝整个文件。
 */
async function measurePdfPage(filePath, ctx, pdfSupport) {
  const workDir = await makeWorkDir(ctx, filePath, 'probe');
  try {
    const outPath = path.join(workDir, 'page.png');
    await pdfSupport.renderPage(filePath, 1, { dpi: 72, outPath, signal: ctx.signal });
    return await readImageSize(outPath, { signal: ctx.signal });
  } catch (error) {
    if (error instanceof ToolError && error.code === 'TOOL_NOT_FOUND') return null;
    throw error;
  } finally {
    await cleanupQuietly(workDir);
  }
}

/**
 * 读取文档元信息（带缓存）。
 *
 * width/height 的单位：
 *   - PDF  → 页面尺寸，单位 pt（第一页；/Rotate 90/270 时已交换宽高）
 *   - 图片 → 像素
 *   - 文本 → null
 */
async function inspectDocument(filePath, ctx, pdfSupport, cache) {
  const stats = await stat(filePath);
  const cacheKey = `${filePath}:${stats.size}:${stats.mtimeMs}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, stats };

  const classified = await classifyDocument(filePath);
  let pageCount = 1;
  let width = null;
  let height = null;
  let unit = null;
  let hasTextLayer = false;

  if (classified.kind === 'pdf') {
    const meta = await pdfSupport.readMetadata(filePath, { signal: ctx.signal });
    pageCount = meta.pageCount;
    width = meta.width;
    height = meta.height;
    unit = 'pt';
    if (width === null || height === null) {
      const measured = await measurePdfPage(filePath, ctx, pdfSupport);
      if (measured) {
        width = measured.width;
        height = measured.height;
      }
    }
    const sampled = await pdfSupport.sampleHasText(filePath, { signal: ctx.signal });
    hasTextLayer = sampled.hasText;
  } else if (classified.kind === 'image') {
    const size = await readImageSize(filePath, { signal: ctx.signal });
    width = size.width;
    height = size.height;
    unit = 'px';
    hasTextLayer = false;
  } else {
    // 纯文本：一页，没有像素尺寸，但「文字层」恒为真（任务口径）。
    hasTextLayer = true;
  }

  const info = {
    ...classified,
    path: filePath,
    stats,
    pageCount,
    width,
    height,
    unit,
    hasTextLayer,
  };

  if (cache.size >= INSPECT_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(cacheKey, info);
  return info;
}

/* ------------------------------------------------------------------ *
 * OCR / 文字层
 * ------------------------------------------------------------------ */

function isLoopback(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return ['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'].includes(host);
  } catch {
    return false;
  }
}

/** 与 server/tools.js 的 docProviderUsable 保持一致：provider 存在 ≠ 可用（可能缺 key）。 */
function docProviderState(ctx) {
  const provider = ctx.docProvider ?? null;
  if (!provider) {
    return {
      configured: false,
      available: false,
      id: null,
      provider: null,
      reason: 'No document parser is configured (MMGREP_DOC_PROVIDER is "none"). '
        + 'Scanned pages and images are returned as page images only.',
    };
  }
  const config = ctx.config?.doc;
  const configuredProvider = config?.provider && config.provider !== 'none' ? config.provider : null;
  const sameProvider = configuredProvider !== null && (!provider.id || configuredProvider === provider.id);
  if (config && sameProvider && !config.apiKey && !isLoopback(config.baseUrl)) {
    return {
      configured: true,
      available: false,
      id: provider.id ?? null,
      provider: null,
      reason: `${providerApiKeyEnv('doc', config.provider)} is not set for provider "${config.provider ?? provider.id ?? 'unknown'}".`,
    };
  }
  return {
    configured: true,
    available: true,
    id: provider.id ?? null,
    provider: provider.id ?? null,
    reason: null,
  };
}

function redactSecrets(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
}

/** describe() 是可选方法：它抛错不能把一次成功的 OCR 变成失败。 */
function describeModel(provider) {
  try {
    return provider.describe?.()?.model ?? null;
  } catch {
    return null;
  }
}

function toProviderFailure(error, secret = null) {
  let message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  // 已知的 key 原文先整段抹掉，再做通用的 Bearer / sk- / api_key 模式脱敏。
  if (secret) message = message.split(String(secret)).join('***');
  message = redactSecrets(message);
  const code = /MMGREP_[A-Z0-9_]+_API_KEY.*(?:missing|not set)|api[ _-]?key.*(?:missing|not set)/i.test(message)
    ? 'PROVIDER_NOT_CONFIGURED'
    : 'PROVIDER_FAILED';
  return { code, message };
}

function providerFailureHint(code) {
  return code === 'PROVIDER_NOT_CONFIGURED'
    ? 'Set the provider-specific API key (for MinerU: MMGREP_MINERU_API_KEY), or unset MMGREP_DOC_PROVIDER to fall back to page images.'
    : 'Retry, check MMGREP_MINERU_BASE_URL / MMGREP_MINERU_MODEL, or unset MMGREP_DOC_PROVIDER to fall back to page images.';
}

/** provider 的 pages 参数：连续区间用 {from,to}，离散页用 {list}。 */
function pageSpecForProvider(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const contiguous = pages.every((page, index) => index === 0 || page === pages[index - 1] + 1);
  return contiguous
    ? { from: pages[0], to: pages[pages.length - 1] }
    : { list: [...pages] };
}

function hasAnyText(texts) {
  for (const text of texts.values()) {
    if (String(text ?? '').trim()) return true;
  }
  return false;
}

function transcriptFor({ anyText, providerId = null, model = null, reason = null }) {
  return {
    source: anyText ? 'ocr' : 'none',
    origin: anyText ? 'ocr' : 'none',
    language: null,
    provider: providerId,
    model,
    file: null,
    ...(reason ? { reason } : {}),
  };
}

/**
 * 收集页文字：provider → PDF 文字层 → 空。
 *
 * 返回的 texts 对**每个请求页**都有条目（没有文字时为空串），这样 overview 的
 * 段落/page 号才能和页码严格对齐。
 *
 * @returns {Promise<{
 *   texts: Map<number,string>,
 *   transcript: object,
 *   warnings: string[],
 *   providerError: {code:string,message:string}|null,
 *   providerState: object,
 *   providerId: string|null,
 *   providerModel: string|null,
 *   providerUsed: boolean,
 *   nativeUsed: boolean,
 *   noTextReason: string|null,
 * }>}
 */
async function collectPageTexts({ info, pages, ctx, pdfSupport, warnings }) {
  const texts = new Map(pages.map((page) => [page, '']));

  // 纯文本不需要 OCR：文件本身就是文字层。
  if (info.kind === 'text') {
    let text = '';
    if (pages.length > 0) {
      text = normalizePageText(await readFile(info.path, 'utf8'));
      for (const page of pages) texts.set(page, text);
    }
    const anyText = hasAnyText(texts);
    const noTextReason = anyText ? null : 'the text file is empty.';
    return {
      texts,
      transcript: transcriptFor({ anyText, reason: noTextReason }),
      warnings,
      providerError: null,
      providerState: docProviderState(ctx),
      providerId: null,
      providerModel: null,
      providerUsed: false,
      nativeUsed: true,
      noTextReason,
    };
  }

  const state = docProviderState(ctx);
  let providerId = null;
  let providerModel = null;
  let providerUsed = false;
  let providerError = null;
  let providerTextCount = 0;

  if (state.available && pages.length > 0) {
    const provider = ctx.docProvider;
    ctx.onProgress?.({ stage: 'ocr', detail: `parsing ${pages.length} page(s) with ${state.id ?? 'document provider'}` });
    try {
      const result = await provider.parse(
        { filePath: info.path, pages: pageSpecForProvider(pages), signal: ctx.signal },
        {
          onProgress: (stage, detail) => ctx.onProgress?.({
            stage: 'ocr',
            detail: detail ? `${stage}: ${detail}` : String(stage ?? 'ocr'),
          }),
        },
      );
      providerUsed = true;
      providerId = result?.provider ?? state.id ?? null;
      providerModel = result?.model ?? describeModel(provider);
      for (const entry of Array.isArray(result?.pages) ? result.pages : []) {
        const page = Number(entry?.page);
        if (Number.isInteger(page) && texts.has(page)) {
          const text = String(entry?.text ?? '');
          if (text.trim()) providerTextCount += 1;
          texts.set(page, text);
        }
      }
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      providerError = toProviderFailure(error, ctx.config?.doc?.apiKey ?? null);
      providerId = null;
      providerModel = null;
    }
  }

  // PDF 文字层：只补齐还空着的页（provider 优先，失败或缺页时兜底）。
  let nativeUsed = false;
  if (info.kind === 'pdf') {
    const missing = pages.filter((page) => !String(texts.get(page) ?? '').trim());
    if (missing.length > 0) {
      const native = await pdfSupport.extractText(info.path, missing, { signal: ctx.signal });
      let filled = 0;
      for (const page of missing) {
        const text = native.pages.get(page) ?? '';
        if (text.trim()) {
          texts.set(page, text);
          filled += 1;
        }
      }
      nativeUsed = filled > 0;

      if (providerError) {
        warnings.push(
          `document parser "${state.id ?? 'unknown'}" failed: ${providerError.message}. `
            + (nativeUsed
              ? 'Fell back to the PDF text layer where one exists.'
              : 'No text layer was available; page images only.'),
        );
      } else if (providerUsed && filled > 0) {
        warnings.push(
          providerTextCount === 0
            ? 'the document parser returned no text; the PDF text layer was used instead.'
            : `the document parser returned no text for ${filled} requested page(s); the PDF text layer filled them in.`,
        );
      }
    } else if (providerError) {
      warnings.push(`document parser "${state.id ?? 'unknown'}" failed: ${providerError.message}. Page images only.`);
    }
  } else if (providerError) {
    warnings.push(`document parser "${state.id ?? 'unknown'}" failed: ${providerError.message}. Page images only.`);
  }

  const anyText = hasAnyText(texts);
  let noTextReason = null;
  if (!anyText) {
    if (providerError) {
      noTextReason = `the document parser failed (${providerError.message}).`;
    } else if (providerUsed) {
      noTextReason = 'the document parser returned no text for the requested pages.';
    } else if (state.configured && !state.available) {
      noTextReason = state.reason;
    } else if (info.kind === 'pdf') {
      const extractor = await pdfSupport.resolveTools();
      noTextReason = extractor.textExtractor
        ? 'no text layer and no OCR provider is configured.'
        : 'no text layer, no PDF text extractor is installed, and no OCR provider is configured.';
    } else if (info.kind === 'image') {
      noTextReason = 'no text layer and no OCR provider is configured.';
    } else {
      noTextReason = 'no page text is available.';
    }
  }

  return {
    texts,
    transcript: transcriptFor({
      anyText,
      providerId: anyText ? providerId : null,
      model: anyText ? providerModel : null,
      reason: noTextReason,
    }),
    warnings,
    providerError,
    providerState: state,
    providerId,
    providerModel,
    providerUsed,
    nativeUsed,
    noTextReason,
  };
}

/* ------------------------------------------------------------------ *
 * 图片渲染
 * ------------------------------------------------------------------ */

function normalizePages(pagesSpec, pageCount) {
  if (pagesSpec === null || pagesSpec === undefined) {
    const all = [];
    for (let page = 1; page <= pageCount; page += 1) all.push(page);
    return all;
  }
  if (!Array.isArray(pagesSpec)) {
    throw new ToolError('INVALID_ARGUMENT', 'pages must be an array of 1-based page numbers, or null for the whole document.');
  }
  const unique = [];
  for (const raw of pagesSpec) {
    const page = Number(raw);
    if (!Number.isInteger(page) || page < 1) {
      throw new ToolError('INVALID_ARGUMENT', `pages must contain 1-based integers (got ${JSON.stringify(raw)}).`);
    }
    if (page > pageCount) {
      throw new ToolError('OUT_OF_RANGE', `page ${page} is out of range. This document has ${pageCount} pages.`);
    }
    if (!unique.includes(page)) unique.push(page);
  }
  return unique.sort((a, b) => a - b);
}

function sanitizeOverviewBudget(input) {
  const cellsValue = Number(input?.cells);
  const imagesValue = Number(input?.images);
  const edgeValue = Number(input?.maxEdge);
  const cells = Math.min(MAX_CELLS, Math.max(1, Number.isInteger(cellsValue) ? cellsValue : DEFAULT_CELLS));
  const images = Math.min(MAX_IMAGES, Math.max(1, Number.isInteger(imagesValue) ? imagesValue : DEFAULT_IMAGES));
  const maxEdge = Math.min(MAX_EDGE, Math.max(MIN_EDGE, Number.isInteger(edgeValue) ? edgeValue : DEFAULT_OVERVIEW_MAX_EDGE));
  return { cells, images, maxEdge };
}

function sanitizeZoomEdge(value) {
  const edge = Number(value);
  return Math.min(MAX_EDGE, Math.max(MIN_EDGE, Number.isInteger(edge) ? edge : DEFAULT_ZOOM_MAX_EDGE));
}

/** 在列表中均匀抽 count 个页（首尾都保留），用于让有限格数覆盖整段页码范围。 */
function pickEvenly(list, count) {
  if (list.length <= count) return [...list];
  if (count <= 1) return [list[0]];
  const picked = [];
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (list.length - 1)) / (count - 1));
    if (!picked.includes(list[index])) picked.push(list[index]);
  }
  for (let i = 0; picked.length < count && i < list.length; i += 1) {
    if (!picked.includes(list[i])) picked.push(list[i]);
  }
  return picked.sort((a, b) => a - b);
}

function chunk(list, size) {
  const groups = [];
  for (let i = 0; i < list.length; i += size) groups.push(list.slice(i, i + size));
  return groups;
}

function pageAspectFor(info) {
  if (info.width && info.height) return info.width / info.height;
  return DEFAULT_PAGE_ASPECT;
}

function capDpiForPixels(dpi, pageWidth, pageHeight) {
  const scale = dpi / 72;
  const pixels = Math.ceil(pageWidth * scale) * Math.ceil(pageHeight * scale);
  if (pixels <= MAX_RENDER_PIXELS) return dpi;
  return Math.max(1, Math.floor(72 * Math.sqrt(MAX_RENDER_PIXELS / (pageWidth * pageHeight))));
}

function gridDpi({ cellWidth, cellHeight, pageWidth, pageHeight }) {
  const needed = Math.ceil(72 * Math.max(cellWidth / pageWidth, cellHeight / pageHeight));
  const dpi = Math.min(MAX_GRID_DPI, Math.max(MIN_GRID_DPI, needed));
  return capDpiForPixels(dpi, pageWidth, pageHeight);
}

/**
 * 渲染 overview 拼图。最多 images 张、每张最多 cells 格；请求页多于容量时
 * 均匀抽样（而不是只取前几页），让有限格数覆盖整段范围。
 */
async function renderOverviewImages({ info, pages, cells, images, maxEdge, ctx, pdfSupport, warnings }) {
  if (info.kind === 'text' || pages.length === 0) return [];

  const capacity = cells * images;
  const previewPages = info.kind === 'image' ? pages.slice(0, 1) : pickEvenly(pages, capacity);
  if (previewPages.length < pages.length) {
    warnings.push(
      `the image budget covers ${previewPages.length} of ${pages.length} requested pages `
        + `(images × cells = ${capacity}); page text still covers all requested pages. `
        + 'Pass a narrower "pages" range if you need every page as a thumbnail.',
    );
  }

  const aspect = pageAspectFor(info);
  const groups = chunk(previewPages, cells);
  const workDir = await makeWorkDir(ctx, info.path, 'overview');
  try {
    const out = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      const { cols, rows } = layoutForCells(group.length);
      const grid = planGrid({ pageAspect: aspect, cols, rows, maxEdge });
      const inputs = [];

      if (info.kind === 'image') {
        inputs.push(info.path);
      } else {
        const pageWidth = info.width ?? FALLBACK_PAGE.width;
        const pageHeight = info.height ?? FALLBACK_PAGE.height;
        const dpi = gridDpi({
          cellWidth: grid.cellWidth,
          cellHeight: grid.cellHeight,
          pageWidth,
          pageHeight,
        });
        for (const page of group) {
          const pagePath = path.join(workDir, `page-${String(page).padStart(4, '0')}.png`);
          await pdfSupport.renderPage(info.path, page, {
            dpi,
            outPath: pagePath,
            signal: ctx.signal,
          });
          inputs.push(pagePath);
        }
      }

      const gridPath = path.join(workDir, `grid-${String(groupIndex + 1).padStart(2, '0')}.png`);
      await composeGrid({
        inputs,
        cols,
        rows,
        cellWidth: grid.cellWidth,
        cellHeight: grid.cellHeight,
        outPath: gridPath,
        signal: ctx.signal,
      });
      out.push({
        index: groupIndex + 1,
        buffer: await readFile(gridPath),
        width: grid.width,
        height: grid.height,
        cells: group.length,
        mimeType: 'image/png',
      });
    }
    return out;
  } finally {
    await cleanupQuietly(workDir);
  }
}

/**
 * 渲染一页（整页或 crop）成一张 PNG，返回 buffer 与尺寸。
 * 调用方负责把 buffer 放进最终结果；临时目录在这里清理。
 */
async function renderSinglePage({ info, page, crop, maxEdge, ctx }) {
  const workDir = await makeWorkDir(ctx, info.path, 'page');
  try {
    if (info.kind === 'image') {
      const rect = cropRect(info.width, info.height, crop);
      const outPath = path.join(workDir, 'page.png');
      const size = await cropAndScale({
        input: info.path,
        rect,
        maxEdge,
        outPath,
        signal: ctx.signal,
      });
      return {
        buffer: await readFile(outPath),
        width: size.width,
        height: size.height,
        crop,
        warnings: [],
      };
    }

    // PDF：先估算能把裁切区放到 maxEdge 所需的 DPI，再按实际渲染尺寸裁切。
    const pageWidth = info.width ?? FALLBACK_PAGE.width;
    const pageHeight = info.height ?? FALLBACK_PAGE.height;
    const cropWidth = Math.max(1, (crop ? crop.width : 1) * pageWidth);
    const cropHeight = Math.max(1, (crop ? crop.height : 1) * pageHeight);
    const wantedDpi = Math.ceil((72 * maxEdge) / Math.max(cropWidth, cropHeight));
    const dpi = capDpiForPixels(
      Math.min(MAX_ZOOM_DPI, Math.max(MIN_ZOOM_DPI, wantedDpi)),
      pageWidth,
      pageHeight,
    );

    const renderedPath = path.join(workDir, 'rendered.png');
    await ctx.pdfSupport.renderPage(info.path, page, {
      dpi,
      outPath: renderedPath,
      signal: ctx.signal,
    });
    const renderedSize = await readImageSize(renderedPath, { signal: ctx.signal });
    const rect = cropRect(renderedSize.width, renderedSize.height, crop);
    const outPath = path.join(workDir, 'page.png');
    const size = await cropAndScale({
      input: renderedPath,
      rect,
      maxEdge,
      outPath,
      signal: ctx.signal,
    });
    const warnings = [];
    if (Math.max(size.width, size.height) < Math.floor(maxEdge * 0.98)) {
      warnings.push(
        `the requested crop could not fill ${maxEdge}px at ${dpi} dpi; the output is ${size.width}x${size.height}.`,
      );
    }
    return {
      buffer: await readFile(outPath),
      width: size.width,
      height: size.height,
      crop,
      warnings,
    };
  } finally {
    await cleanupQuietly(workDir);
  }
}

/* ------------------------------------------------------------------ *
 * 后端
 * ------------------------------------------------------------------ */

function recommendedFor(info) {
  if (info.kind === 'text') {
    return {
      mode: 'single',
      segmentSec: 300,
      overviewImages: 0,
      cellsPerImage: 0,
      estimatedImageTokens: 0,
      note: 'Plain-text document: one text segment holds the whole file. There are no page images.',
    };
  }
  const long = info.pageCount > 30;
  return {
    mode: long ? 'sequence' : 'single',
    segmentSec: 300,
    overviewImages: 2,
    cellsPerImage: 6,
    estimatedImageTokens: 2458,
    note: long
      ? 'Long document: pass "pages" to narrow the range, then media_zoom({ path, page }) to read one page.'
      : 'One overview shows page thumbnails and page text. Use media_zoom({ path, page }) to read a page closely.',
  };
}

export function createDocumentBackend(ctx = {}) {
  const backendCtx = () => ({
    ...ctx,
    config: ctx.config ?? {},
    // server 的 callCtx.signal 可能是 null；spawn 只接受 undefined 或 AbortSignal。
    signal: ctx.signal ?? undefined,
  });
  const pdfSupport = ctx.pdfSupport ?? createPdfSupport();
  const inspectCache = new Map();
  const withSupport = (callCtx) => ({
    ...(callCtx ?? {}),
    config: callCtx?.config ?? {},
    signal: callCtx?.signal ?? undefined,
    pdfSupport,
  });

  async function probe(input, callCtx = backendCtx()) {
    const c = withSupport(callCtx);
    const info = await inspectDocument(input.path, c, pdfSupport, inspectCache);
    const providerState = docProviderState(c);
    const hasTextSource = info.hasTextLayer || info.kind === 'text' || providerState.available;
    const transcriptSource = hasTextSource ? 'ocr' : 'none';

    return {
      mediaType: 'document',
      path: input.path,
      sizeBytes: info.stats.size,
      modifiedMs: Math.round(info.stats.mtimeMs),
      durationMs: null,
      durationSec: null,
      width: info.width,
      height: info.height,
      fps: null,
      rotation: null,
      aspect: null,
      videoCodec: null,
      container: info.container,
      hasAudio: false,
      audioCodec: null,
      audioChannels: null,
      sampleRateHz: null,
      audioHealth: null,
      pageCount: info.pageCount,
      hasTextLayer: info.hasTextLayer,
      subtitleTracks: [],
      audioTracks: [],
      capabilities: {
        asr: {
          available: false,
          provider: null,
          reason: 'asr is not applicable to document media.',
        },
        ocr: {
          available: providerState.available,
          provider: providerState.provider,
          reason: providerState.reason,
        },
        transcriptSource,
        transcriptOrigin: transcriptSource,
        transcriptPath: null,
      },
      recommended: recommendedFor(info),
    };
  }

  async function overview(input, callCtx = backendCtx()) {
    const c = withSupport(callCtx);
    const info = await inspectDocument(input.path, c, pdfSupport, inspectCache);
    const pages = normalizePages(input.pages ?? null, info.pageCount);
    const { cells, images, maxEdge } = sanitizeOverviewBudget(input);
    const warnings = [];

    c.onProgress?.({ stage: 'text', detail: `reading ${pages.length} page(s)` });
    const collected = await collectPageTexts({
      info,
      pages,
      ctx: c,
      pdfSupport,
      warnings,
    });

    const segments = pages.map((page) => ({
      page,
      text: collected.texts.get(page) ?? '',
      startMs: null,
      endMs: null,
      source: 'ocr',
      origin: 'ocr',
    }));

    if (info.kind === 'text') {
      warnings.push('plain-text documents have no page images; the page text is returned as the segment text.');
    }
    if (!hasAnyText(collected.texts)) {
      warnings.push(
        `no page text is available: ${collected.noTextReason ?? 'no page text was found.'}`
          + (info.kind === 'text' ? '' : ' Page images are still returned; use media_zoom to read them.'),
      );
    }

    c.onProgress?.({ stage: 'images', detail: `rendering ${Math.min(pages.length, cells * images)} page(s)` });
    const rendered = await renderOverviewImages({
      info,
      pages,
      cells,
      images,
      maxEdge,
      ctx: c,
      pdfSupport,
      warnings,
    });

    return {
      mediaType: 'document',
      path: input.path,
      pageCount: info.pageCount,
      segments,
      images: rendered,
      transcript: collected.transcript,
      warnings,
    };
  }

  async function zoom(input, callCtx = backendCtx()) {
    const c = withSupport(callCtx);
    const info = await inspectDocument(input.path, c, pdfSupport, inspectCache);

    if (info.kind === 'text') {
      throw new ToolError(
        'UNSUPPORTED_MEDIA_TYPE',
        'plain-text documents (.txt / .md) have no page image to zoom; read the text with media_overview or media_locate.',
        'Convert the text to PDF first if you need a rendered page image.',
      );
    }

    const page = Number(input.page);
    if (!Number.isInteger(page) || page < 1) {
      throw new ToolError('INVALID_ARGUMENT', `page must be a 1-based integer (got ${JSON.stringify(input.page)}).`);
    }
    if (page > info.pageCount) {
      throw new ToolError('OUT_OF_RANGE', `page ${page} is out of range. This document has ${info.pageCount} pages.`);
    }

    const crop = validateCrop(input.crop ?? null);
    const maxEdge = sanitizeZoomEdge(input.maxEdge);
    const rendered = await renderSinglePage({ info, page, crop, maxEdge, ctx: c });

    return {
      mediaType: 'document',
      path: input.path,
      target: {
        kind: 'page',
        page,
        atMs: null,
        atSec: null,
        crop,
      },
      images: [{
        index: 1,
        buffer: rendered.buffer,
        width: rendered.width,
        height: rendered.height,
        cells: 1,
        mimeType: 'image/png',
      }],
      warnings: rendered.warnings,
    };
  }

  async function locate(input, callCtx = backendCtx()) {
    const c = withSupport(callCtx);
    const info = await inspectDocument(input.path, c, pdfSupport, inspectCache);
    const pages = normalizePages(input.pages ?? null, info.pageCount);
    const warnings = [];

    const collected = await collectPageTexts({ info, pages, ctx: c, pdfSupport, warnings });
    const segments = pages.map((page) => ({
      page,
      text: collected.texts.get(page) ?? '',
      startMs: null,
      endMs: null,
      source: 'ocr',
      origin: 'ocr',
    }));

    if (!hasAnyText(collected.texts)) {
      if (collected.providerError) {
        throw new ToolError(
          collected.providerError.code,
          `cannot search this document: ${collected.providerError.message}`,
          providerFailureHint(collected.providerError.code),
        );
      }
      if (collected.providerState.configured && !collected.providerState.available) {
        throw new ToolError(
          'PROVIDER_NOT_CONFIGURED',
          `cannot search this document: ${collected.providerState.reason}`,
          providerFailureHint('PROVIDER_NOT_CONFIGURED'),
        );
      }
      const reason = collected.noTextReason
        ?? (info.kind === 'image'
          ? 'no text layer and no OCR provider is configured.'
          : 'no page text is available.');
      throw new ToolError(
        'NO_TRANSCRIPT',
        `cannot search this document: ${reason} There is nothing to search.`,
        OCR_HINT,
      );
    }

    const requestedMax = Number(input.max);
    const max = Number.isInteger(requestedMax) ? Math.min(20, Math.max(1, requestedMax)) : 5;
    const matched = matchSegments(segments, input.query ?? '', { max });
    const matches = matched.map((match, index) => ({
      rank: index + 1,
      score: match.score,
      startMs: null,
      endMs: null,
      startSec: null,
      endSec: null,
      text: match.text,
      source: 'ocr',
      origin: 'ocr',
      page: match.page,
    }));

    let frame = null;
    if (input.includeFrame && matches.length > 0) {
      const bestPage = matches[0].page;
      if (info.kind === 'text') {
        warnings.push('includeFrame is not available for plain-text documents: there is no page image.');
      } else {
        try {
          const rendered = await renderSinglePage({
            info,
            page: bestPage,
            crop: null,
            maxEdge: DEFAULT_LOCATE_FRAME_MAX_EDGE,
            ctx: c,
          });
          frame = {
            index: 1,
            page: bestPage,
            atMs: null,
            atSec: null,
            buffer: rendered.buffer,
            width: rendered.width,
            height: rendered.height,
            cells: 1,
            mimeType: 'image/png',
          };
        } catch (error) {
          if (c.signal?.aborted) throw error;
          if (error instanceof ToolError && error.code === 'TOOL_NOT_FOUND') {
            warnings.push(`includeFrame could not be rendered: ${error.message}`);
          } else {
            throw error;
          }
        }
      }
    }

    return {
      mediaType: 'document',
      path: input.path,
      query: input.query ?? '',
      matches,
      totalSegments: segments.length,
      transcript: collected.transcript,
      frame,
      warnings,
    };
  }

  return { probe, overview, zoom, locate };
}

export default createDocumentBackend;
