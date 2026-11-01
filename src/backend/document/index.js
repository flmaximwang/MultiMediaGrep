// src/backend/document/index.js —— 文档后端（PDF / 图片 / 纯文本）
//
// 职责（docs/mcp-contract.md §4.3、§5、§6、§7）：
//   probe    文件元信息、页数、是否有文字层、OCR 能力
//   overview 页面缩略图拼图 + 每页文字（有 provider 用 provider，否则用 PDF 文字层）
//   zoom     单页整页 / 局部放大成一张 PNG
//   locate   在页面文字里找短语，返回页码；可选附最佳匹配页的图
//
// 设计约束：
//   - server 本身**不调用任何 LLM**。OCR 交给 ctx.ocrProvider，有文字层页的排版
//     交给 ctx.typesetProvider（契约 v2）；没配就只出页面图 / 原生文字层。
//   - 不假设部署机装了 PDF 工具：运行时探测，缺工具时抛 TOOL_NOT_FOUND 并点名安装包。
//     栅格化链 pdftoppm → mutool draw → gs；文字层链 pdftotext → mutool。
//   - 所有命令走 media/ffmpeg.js 的 run()（spawn，无 shell 拼接）。
//   - 临时文件只写在 MMGREP_CACHE_DIR（默认 ~/.cache/multimediagrep）下，绝不在
//     用户文件旁边生成任何东西。
//   - 图片预算（§10）由 server 的 planImageBudget 传入；这里只保证不超：每张拼图
//     ≤ cells 格、≤ images 张、长边 ≤ maxEdge、单图 ≤ 2,000,000 px。

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { contentKey, hashBuffer, hashFile } from '../../cache/hash.js';
import { resolveCacheConfig } from '../../cache/index.js';
import { extOf, sniffMagic } from '../../media/detect.js';
import { ffprobeJson } from '../../media/ffmpeg.js';
import { ToolError, validateCrop } from '../../media/interface.js';
import { matchSegments } from '../../media/match.js';
import { IMAGE_LIMITS, layoutForCells } from '../../server/images.js';
import { providerApiKeyEnv, providerEnv } from '../../server/config.js';
import {
  analyzePageText,
  blocksToText,
  createBuiltinTypesetProvider,
  normalizeBlocks,
  textToBlocks,
} from '../../providers/doc/builtin.js';
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
  'Configure an OCR provider with MMGREP_OCR_PROVIDER=mineru and MMGREP_MINERU_API_KEY, '
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
  // null = 判不出来（本机没有文字抽取器），与「这份文档没有文字层」是两件事。
  let hasTextLayer = false;
  let textLayer = {
    checked: false,
    reason: null,
    sampledPages: [],
    checkedPages: [],
    textPage: null,
  };

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
    // 采样首页 / 中间页 / 末页：图片封面 + 数字正文也是「有文字层」。
    const sampled = await pdfSupport.sampleHasText(filePath, { pageCount, signal: ctx.signal });
    const reason = sampled.reason ?? null;
    hasTextLayer = reason ? null : Boolean(sampled.hasText);
    textLayer = {
      checked: reason === null,
      reason,
      sampledPages: sampled.sampledPages ?? [],
      checkedPages: sampled.checkedPages ?? [],
      textPage: sampled.textPage ?? null,
    };
  } else if (classified.kind === 'image') {
    const size = await readImageSize(filePath, { signal: ctx.signal });
    width = size.width;
    height = size.height;
    unit = 'px';
    hasTextLayer = false;
    textLayer = { checked: true, reason: null, sampledPages: [], checkedPages: [], textPage: null };
  } else {
    // 纯文本：一页，没有像素尺寸，但「文字层」恒为真（任务口径）。
    hasTextLayer = true;
    textLayer = { checked: true, reason: null, sampledPages: [], checkedPages: [], textPage: null };
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
    textLayer,
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

/**
 * 文档 provider 的某个角色（ocr / typeset）的状态。
 *
 * 与 server/tools.js 的 docRoleProviderUsable 保持一致：provider 存在 ≠ 可用
 * （外部 provider 可能缺 key）。builtin / none 没有凭据，不需要 key。
 */
function docRoleState(ctx, role) {
  const provider = ctx?.[`${role}Provider`] ?? null;
  const config = ctx?.config?.[role] ?? null;
  const envName = role === 'ocr' ? 'MMGREP_OCR_PROVIDER' : 'MMGREP_TYPESET_PROVIDER';

  if (!provider) {
    return {
      role,
      configured: Boolean(config?.provider && config.provider !== 'none'),
      available: false,
      id: null,
      provider: null,
      reason: role === 'ocr'
        ? `No OCR provider is configured (${envName} is "none"). Pages without a text layer are returned as page images only.`
        : `No typeset provider is configured (${envName} is "none"). Pages with a text layer use the raw extracted text.`,
    };
  }

  const configuredProvider = config?.provider && config.provider !== 'none' ? config.provider : null;
  const sameProvider = configuredProvider !== null && (!provider.id || configuredProvider === provider.id);
  const external = providerEnv('doc', provider.id);
  if (config && sameProvider && external && !config.apiKey && !isLoopback(config.baseUrl)) {
    return {
      role,
      configured: true,
      available: false,
      id: provider.id ?? null,
      provider: null,
      reason: `${providerApiKeyEnv('doc', config.provider)} is not set for provider "${config.provider ?? provider.id ?? 'unknown'}".`,
    };
  }

  return {
    role,
    configured: true,
    available: true,
    id: provider.id ?? null,
    provider: provider.id ?? null,
    reason: null,
  };
}

/** 两个角色合并成一个旧形状（probe / locate 的兼容字段）。 */
function combinedDocState(ocrState, typesetState) {
  const available = ocrState.available || typesetState.available;
  const configured = ocrState.configured || typesetState.configured;
  return {
    configured,
    available,
    id: ocrState.available ? ocrState.id : typesetState.id,
    provider: ocrState.available ? ocrState.provider : typesetState.provider,
    reason: available
      ? null
      : [ocrState.reason, typesetState.reason].filter(Boolean).join(' '),
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

function providerFailureHint(code, role = null) {
  const fallback = role === 'ocr'
    ? 'set MMGREP_OCR_PROVIDER=none to return page images only'
    : role === 'typeset'
      ? 'set MMGREP_TYPESET_PROVIDER=none to use the raw PDF text layer'
      : 'set MMGREP_OCR_PROVIDER=none / MMGREP_TYPESET_PROVIDER=none to fall back';
  return code === 'PROVIDER_NOT_CONFIGURED'
    ? `Set the provider-specific API key (for MinerU: MMGREP_MINERU_API_KEY), or ${fallback}.`
    : `Retry, check MMGREP_MINERU_BASE_URL / MMGREP_MINERU_MODEL, or ${fallback}.`;
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

/**
 * 一页的对外 source / origin（契约 §2.5，9z5.21）。
 *
 *   textOrigin textlayer → source text（PDF 原生文字层；.txt / .md 记 origin=file）；
 *   ocr / unknown        → source ocr（不确定时取保守值：宁可提醒核对，也不谎称字符精确）；
 *   没有任何文字          → none / none（扫描件没配 OCR 时不能谎报有文本）。
 */
function pageSourceOrigin(entry, kind) {
  const text = String(entry?.text ?? '').trim();
  if (!text) return { source: 'none', origin: 'none' };
  if (entry?.textOrigin === 'textlayer') {
    return { source: 'text', origin: kind === 'text' ? 'file' : 'textlayer' };
  }
  return { source: 'ocr', origin: 'ocr' };
}

/**
 * 整份转写的 source / origin（契约 §2.5，9z5.21）。
 *
 * source：所有返回页一致时取该值（含「整份都没文字」→ none），不一致 → mixed。
 * origin：枚举里没有 mixed，所以 source=mixed 时只表示主要渠道（textlayer 优先）；
 *         逐页口径以 segments[].origin 为准。
 */
function transcriptFor({
  pageMap,
  kind,
  providerId = null,
  ocrProviderId = null,
  typesetProviderId = null,
  model = null,
  reason = null,
}) {
  const mapped = [...pageMap.values()].map((entry) => ({ ...entry, ...pageSourceOrigin(entry, kind) }));
  const sources = mapped.map((entry) => entry.source);
  let source = 'none';
  if (sources.length > 0) {
    source = sources.every((value) => value === sources[0]) ? sources[0] : 'mixed';
  }
  const origins = mapped.map((entry) => entry.origin).filter((origin) => origin !== 'none');
  const origin = origins.length === 0
    ? 'none'
    : ['textlayer', 'file', 'ocr'].find((candidate) => origins.includes(candidate)) ?? origins[0];

  return {
    source,
    origin,
    language: null,
    provider: providerId,
    model,
    ...(ocrProviderId ? { ocrProvider: ocrProviderId } : {}),
    ...(typesetProviderId ? { typesetProvider: typesetProviderId } : {}),
    file: null,
    ...(reason ? { reason } : {}),
  };
}

function emptyPage(page) {
  return { page, textOrigin: 'unknown', blocks: [], text: '' };
}

/** 规整 provider 返回的一页：blocks / textOrigin / text（text 由 blocks 派生）。 */
function normalizeProviderPage(entry, fallbackOrigin = 'unknown') {
  const page = Number(entry?.page);
  if (!Number.isInteger(page) || page < 1) return null;

  const blocks = normalizeBlocks(entry?.blocks);
  if (blocks.length === 0) {
    const fallbackText = String(entry?.text ?? '').trim();
    if (fallbackText) blocks.push({ type: 'paragraph', text: fallbackText });
  }
  const textOrigin = ['textlayer', 'ocr', 'unknown'].includes(entry?.textOrigin)
    ? entry.textOrigin
    : fallbackOrigin;
  const tables = Array.isArray(entry?.tables) ? entry.tables : undefined;

  return {
    page,
    textOrigin,
    blocks,
    text: blocksToText(blocks),
    ...(tables ? { tables } : {}),
  };
}

/** 调一次 provider.parse（契约 v2 的 role / ocrMode 输入）。 */
async function parseWithProvider({ provider, role, pages, ocrMode, textLayers, info, ctx }) {
  const stage = role === 'typeset' ? 'typeset' : 'ocr';
  ctx.onProgress?.({
    stage,
    detail: `parsing ${pages.length} page(s) with ${provider.id ?? 'document provider'} (${role})`,
  });
  return provider.parse(
    {
      filePath: info.path,
      pages: pageSpecForProvider(pages),
      role,
      ocrMode,
      signal: ctx.signal,
      ...(textLayers ? { textLayers } : {}),
    },
    {
      onProgress: (step, detail) => ctx.onProgress?.({
        stage,
        detail: detail ? `${step}: ${detail}` : String(step ?? stage),
      }),
    },
  );
}

/* ------------------------------------------------------------------ *
 * provider 逐页结果缓存（9z5.30）
 *
 * 复用 server 的内容缓存（src/cache）：**一个 namespace 一个缓存条目**
 * （`prepareDir` + `register`，参与同一套 LRU / MMGREP_CACHE_MAX_BYTES 上限），
 * 条目里**每页一个 JSON**，存契约 v2 的 page 对象：
 *
 *   <MMGREP_CACHE_DIR>/<shard>/<stem>/
 *     namespace.json             本 namespace 的身份（便于排查）
 *     page-0001.json             { version, page: { page, textOrigin, blocks, text, tables } }
 *     page-0002.json
 *
 * namespace key =
 *   sha256:<源文件内容 sha256>:doc-provider:<role>:<hash(源 sha256 + provider id + model + ocrMode + role)>
 *
 * 设计要点：
 *   - 主键仍由**源文件内容**决定（cache.contentKeyForFile，指纹索引加速）；
 *     文件内容一变，sha256 变，整组页缓存自然失效。
 *   - role（ocr / typeset）也进 key：同一 provider 的两个角色结果不能互相顶掉。
 *   - ocrMode 进 key：`force`（9z5.31）单独一个 namespace，**不覆盖** auto /
 *     文字层的结果。
 *   - 同一 provider 同时担两个角色、一次 `role: 'both'` 请求时，返回的每页按
 *     **该页实际路由到的角色**（有文字层 → typeset，无文字层 → ocr）落缓存；
 *     这样以后单独走 typeset / OCR 的调用也能复用。
 *   - 缓存是 best-effort：读坏 / 读不到 → 当成 miss；写失败只记 debug，绝不让
 *     provider 调用失败。命中会 touch 条目刷新 LRU。
 * ------------------------------------------------------------------ */

/** 缓存条目 / 页文件的格式版本（与 provider 契约 v2 绑定的落盘 schema）。 */
const PROVIDER_CACHE_SCHEMA = 1;

/** 每页一个文件，页码补零便于人读与排序。 */
function providerPageFileName(page) {
  return `page-${String(page).padStart(4, '0')}.json`;
}

/** 计算 namespace 的缓存 key（见上方注释）。 */
function providerCacheKey({ sha256, role, provider, model, ocrMode }) {
  const material = JSON.stringify({
    schema: PROVIDER_CACHE_SCHEMA,
    source: sha256,
    provider: provider?.id ?? null,
    model: model ?? null,
    ocrMode: ocrMode === 'force' ? 'force' : 'auto',
    role,
  });
  return `${contentKey({ sha256 })}:doc-provider:${role}:${hashBuffer(material).slice(0, 16)}`;
}

/**
 * 打开本次调用的 provider 页缓存。没有可用缓存 / 算不出源文件 hash 时返回 null
 * （整条链路退化成「每次都问 provider」，与 9z5.28 行为一致）。
 *
 * @param {{ cache?: object, logger?: object }} ctx
 * @param {{ path: string }} info
 * @returns {Promise<null|{
 *   lookup: Function,
 *   store: Function,
 * }>}
 */
async function openProviderPageCache(ctx, info) {
  const cache = ctx?.cache;
  if (
    !cache
    || typeof cache.contentKeyForFile !== 'function'
    || typeof cache.getPath !== 'function'
    || typeof cache.prepareDir !== 'function'
    || typeof cache.register !== 'function'
  ) {
    return null;
  }

  let sha256;
  try {
    ({ sha256 } = await cache.contentKeyForFile(info.path));
  } catch (error) {
    ctx?.logger?.debug?.(`provider page cache disabled: ${error?.message ?? error}`);
    return null;
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;

  const nsKey = ({ role, provider, model, ocrMode }) =>
    providerCacheKey({ sha256, role, provider, model, ocrMode });

  const nsMeta = ({ role, provider, model, ocrMode }) => ({
    version: PROVIDER_CACHE_SCHEMA,
    sourceSha256: sha256,
    provider: provider?.id ?? null,
    model: model ?? null,
    ocrMode: ocrMode === 'force' ? 'force' : 'auto',
    role,
  });

  /**
   * 读回已缓存的页。坏文件 / 读失败都当 miss。
   *
   * @param {{ role: string, provider: object, model: string|null, ocrMode: string, pages: number[] }} spec
   * @returns {Promise<Map<number, object>>} page → 契约 v2 page 对象
   */
  async function lookup({ role, provider, model, ocrMode, pages }) {
    const result = new Map();
    if (!Array.isArray(pages) || pages.length === 0) return result;
    let dir;
    try {
      dir = cache.getPath(nsKey({ role, provider, model, ocrMode }));
    } catch (error) {
      ctx?.logger?.debug?.(`provider page cache lookup skipped: ${error?.message ?? error}`);
      return result;
    }

    for (const page of pages) {
      try {
        const raw = await readFile(path.join(dir, providerPageFileName(page)), 'utf8');
        const parsed = JSON.parse(raw);
        const candidate = parsed && typeof parsed === 'object' && parsed.page && typeof parsed.page === 'object'
          ? parsed.page
          : parsed;
        const entry = normalizeProviderPage(candidate, 'unknown');
        if (entry && entry.page === page) result.set(page, entry);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // 损坏 / 半截文件：忽略并重取（下次写入会覆盖它）
          ctx?.logger?.debug?.(`ignoring unreadable provider cache page ${page}: ${error?.message ?? error}`);
        }
      }
    }

    if (result.size > 0 && typeof cache.touch === 'function') {
      try {
        await cache.touch(nsKey({ role, provider, model, ocrMode }));
      } catch {
        /* touch 失败只影响 LRU 新鲜度，不影响结果 */
      }
    }
    return result;
  }

  /**
   * 把 provider 返回的页写回缓存（逐页原子写，最后登记条目）。
   * 任何失败都只记 debug —— 缓存写坏不能把一次成功的解析变成失败。
   *
   * @param {{ role: string, provider: object, model: string|null, ocrMode: string, entries: object[] }} spec
   * @returns {Promise<void>}
   */
  async function store({ role, provider, model, ocrMode, entries }) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const key = nsKey({ role, provider, model, ocrMode });
    let dir;
    try {
      dir = await cache.prepareDir(key);
      await writeFile(path.join(dir, 'namespace.json'), JSON.stringify(nsMeta({ role, provider, model, ocrMode })), 'utf8');
      for (const entry of entries) {
        if (!entry || !Number.isInteger(entry.page) || entry.page < 1) continue;
        const target = path.join(dir, providerPageFileName(entry.page));
        const temp = path.join(dir, `.tmp-page-${process.pid}-${randomBytes(6).toString('hex')}`);
        try {
          await writeFile(temp, JSON.stringify({ version: PROVIDER_CACHE_SCHEMA, page: entry }), 'utf8');
          await rename(temp, target);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => {});
          throw error;
        }
      }
      await cache.register(key);
    } catch (error) {
      ctx?.logger?.debug?.(`provider page cache write failed: ${error?.message ?? error}`);
    }
  }

  return { lookup, store };
}

/**
 * builtin 对一页的版式判定：像不像双栏。
 *
 * 用于两处路由决策：
 *   - `MMGREP_TYPESET_SKIP_SIMPLE=true`（默认）时，单栏页交给 builtin 本地处理，
 *     只有判定双栏的「复杂页」才发给外部 typeset provider；
 *   - typeset provider 关闭时，给「本页像双栏」加一条 note，提醒 agent 阅读顺序
 *     可能交错。
 */
function looksTwoColumn(text) {
  try {
    return analyzePageText(text).twoColumn;
  } catch {
    return false;
  }
}

/** 用内置 typeset（本地，不重新识别字符）排出这页：柱检测 → 重排 → blocks。 */
function typesetPageLocally(page, text) {
  const analysis = analyzePageText(text);
  const blocks = textToBlocks(analysis.text);
  return {
    page,
    textOrigin: 'textlayer',
    blocks,
    text: blocksToText(blocks),
  };
}

/**
 * 收集页文字（契约 v2 的逐页路由）。
 *
 *   PDF：逐页文字层检测（9z5.27）→ 有文字层的页走 typeset，没有的走 OCR。
 *        两个角色是同一个 provider 且 ocrMode=auto 时只发**一次** parse（role: 'both'），
 *        再按 provider 返回的逐页 textOrigin 分配。
 *   图片：一律走 OCR。
 *   文本：不走 provider，textOrigin = textlayer。
 *
 * 返回的 texts 对**每个请求页**都有条目（没有文字时为空串），这样 overview 的
 * 段落/page 号才能和页码严格对齐。
 *
 * @returns {Promise<{
 *   texts: Map<number,string>,
 *   pages: Map<number,{page:number,textOrigin:string,blocks:Array<object>,text:string,tables?:Array<object>}>,
 *   transcript: object,
 *   warnings: string[],
 *   providerError: {code:string,message:string}|null,
 *   providerErrors: object,
 *   providerState: object,
 *   ocrState: object,
 *   typesetState: object,
 *   providerId: string|null,
 *   providerModel: string|null,
 *   providerUsed: boolean,
 *   nativeUsed: boolean,
 *   noTextReason: string|null,
 *   textPageCount: number,
 *   ocrPageCount: number,
 * }>}
 */
async function collectPageTexts({ info, pages, ctx, pdfSupport, warnings, ocrMode = 'auto' }) {
  const pageMap = new Map(pages.map((page) => [page, emptyPage(page)]));
  const texts = new Map(pages.map((page) => [page, '']));
  const ocrState = docRoleState(ctx, 'ocr');
  const typesetState = docRoleState(ctx, 'typeset');
  // MMGREP_TYPESET_SKIP_SIMPLE：外部 typeset provider 只收「builtin 判不准」的页。
  const skipSimple = ctx.config?.typeset?.skipSimple !== false;
  const providerErrors = {};
  const forceOcr = ocrMode === 'force';
  let textPageCount = 0;
  let ocrPageCount = 0;

  let providerUsed = false;
  let nativeUsed = false;
  let providerId = null;
  let providerModel = null;
  let typesetUsed = false;
  // 9z5.21：overview header 的 ocrProvider / typesetProvider 只列真正处理过返回页的角色。
  let ocrProviderId = null;
  let typesetProviderId = null;

  const setPage = (entry) => {
    if (!entry || !pageMap.has(entry.page)) return false;
    pageMap.set(entry.page, entry);
    texts.set(entry.page, entry.text);
    return true;
  };

  const markUsed = (result, provider, role, appliedOrigins = [], applied = false) => {
    providerUsed = true;
    const id = result?.provider ?? provider.id ?? null;
    const model = result?.model ?? describeModel(provider);
    if (role === 'ocr') {
      if (applied) ocrProviderId = id ?? ocrProviderId;
    } else if (role === 'typeset') {
      typesetUsed = true;
      if (applied) typesetProviderId = id ?? typesetProviderId;
      providerId = id ?? providerId;
      providerModel = model ?? providerModel;
      return;
    } else {
      // role: 'both'——同一 provider 担两个角色：按返回页的 textOrigin 判断
      // 哪个角色真的处理了这些页，没处理过的角色不出现在 header 里。
      if (applied && appliedOrigins.some((origin) => origin === 'textlayer')) {
        typesetProviderId = id ?? typesetProviderId;
      }
      if (applied && appliedOrigins.some((origin) => origin !== 'textlayer')) {
        ocrProviderId = id ?? ocrProviderId;
      }
      typesetUsed = true;
      providerId = id ?? providerId;
      providerModel = model ?? providerModel;
      return;
    }
    // 纯 OCR 路径（图片 / 无文字层页）：没有 typeset 结果时才用它填 transcript 的 provider。
    if (!typesetUsed) {
      providerId = id ?? providerId;
      providerModel = model ?? providerModel;
    }
  };

  /**
   * 把 provider 结果写进 pageMap；只接受本次目标页。
   * 返回实际写入的页对象（逐页落缓存时用）。
   */
  const applyResult = (result, provider, { role, targetPages, fallbackOrigin, forceOrigin = null }) => {
    const wanted = new Set(targetPages);
    const applied = [];
    const appliedOrigins = [];
    for (const raw of Array.isArray(result?.pages) ? result.pages : []) {
      const entry = normalizeProviderPage(raw, fallbackOrigin);
      if (!entry || !wanted.has(entry.page)) continue;
      if (forceOrigin) entry.textOrigin = entry.text.trim() ? forceOrigin : 'unknown';
      setPage(entry);
      applied.push(entry);
      appliedOrigins.push(entry.textOrigin);
    }
    markUsed(result, provider, role, appliedOrigins, applied.length > 0);
    return applied;
  };

  /** 把缓存命中的页写进 pageMap；命中也算「用到了 provider 的结果」。 */
  const applyCached = (cached, provider, role) => {
    const applied = [];
    const appliedOrigins = [];
    for (const entry of cached.values()) {
      if (!setPage(entry)) continue;
      applied.push(entry);
      appliedOrigins.push(entry.textOrigin);
    }
    if (applied.length > 0) markUsed(null, provider, role, appliedOrigins, true);
    return applied;
  };

  const useNativePage = (page) => {
    const text = String(info.kind === 'pdf' ? (nativeLayerText.get(page) ?? '') : '').trim();
    if (!text) return false;
    const blocks = textToBlocks(text);
    setPage({ page, textOrigin: 'textlayer', blocks, text: blocksToText(blocks) });
    nativeUsed = true;
    return true;
  };

  // 纯文本不需要 OCR：文件本身就是文字层（.21 会映射成 origin=file）。
  if (info.kind === 'text') {
    let text = '';
    if (pages.length > 0) {
      text = normalizePageText(await readFile(info.path, 'utf8'));
      for (const page of pages) {
        const blocks = textToBlocks(text);
        setPage({ page, textOrigin: 'textlayer', blocks, text: blocksToText(blocks) });
      }
    }
    const anyText = hasAnyText(texts);
    const noTextReason = anyText ? null : 'the text file is empty.';
    return {
      pages: pageMap,
      texts,
      transcript: transcriptFor({ pageMap, kind: 'text', reason: noTextReason }),
      warnings,
      providerError: null,
      providerErrors,
      providerState: combinedDocState(ocrState, typesetState),
      ocrState,
      typesetState,
      providerId: null,
      providerModel: null,
      providerUsed: false,
      nativeUsed: true,
      noTextReason,
      textPageCount: pages.length,
      ocrPageCount: 0,
    };
  }

  let nativeLayerText = new Map();

  // provider 结果按页缓存（9z5.30）：只读/写 MMGREP_CACHE_DIR；没有缓存时整条链路
  // 与 9z5.28 完全一致（每次直接问 provider）。
  const providerPageCache = ctx.cache && (ocrState.available || typesetState.available)
    ? await openProviderPageCache(ctx, info)
    : null;

  // 图片文档：一律走 OCR 角色（图片没有文字层）。
  if (info.kind === 'image') {
    ocrPageCount = pages.length;
    if (ocrState.available && pages.length > 0) {
      const provider = ctx.ocrProvider;
      const cacheRole = 'ocr';
      const callOcrMode = forceOcr ? 'force' : 'auto';
      const model = describeModel(provider);
      const cached = providerPageCache
        ? await providerPageCache.lookup({ role: cacheRole, provider, model, ocrMode: callOcrMode, pages })
        : new Map();
      applyCached(cached, provider, cacheRole);
      const missing = pages.filter((page) => !cached.has(page));
      if (missing.length > 0) {
        try {
          const result = await parseWithProvider({
            provider,
            role: 'ocr',
            pages: missing,
            ocrMode: callOcrMode,
            info,
            ctx,
          });
          const applied = applyResult(result, provider, {
            role: 'ocr',
            targetPages: missing,
            fallbackOrigin: 'ocr',
            forceOrigin: forceOcr ? 'ocr' : null,
          });
          if (providerPageCache) {
            await providerPageCache.store({ role: cacheRole, provider, model, ocrMode: callOcrMode, entries: applied });
          }
        } catch (error) {
          if (ctx.signal?.aborted) throw error;
          providerErrors.ocr = toProviderFailure(error, ctx.config?.ocr?.apiKey ?? null);
          warnings.push(
            `OCR provider "${ocrState.id ?? 'unknown'}" failed: ${providerErrors.ocr.message}. Page images only.`,
          );
        }
      }
    }
  } else if (info.kind === 'pdf') {
    // 逐页文字层：这是「逐页路由」的输入。
    const layers = await pdfSupport.extractTextLayers(info.path, pages, { signal: ctx.signal });
    nativeLayerText = new Map();
    const textPages = [];
    const ocrPages = [];
    for (const page of pages) {
      const layer = layers.pages.get(page);
      const text = String(layer?.text ?? '');
      nativeLayerText.set(page, text);
      if (layer?.hasTextLayer) textPages.push(page);
      else ocrPages.push(page);
    }
    textPageCount = textPages.length;
    ocrPageCount = ocrPages.length;

    if (forceOcr) {
      textPageCount = 0;
      ocrPageCount = pages.length;
      // 9z5.31：强制重新识别 —— 所有请求页都交给 OCR provider，不走 typeset。
      // 9z5.30：force 结果单独一个 namespace，不覆盖 auto / 文字层的结果。
      if (ocrState.available && pages.length > 0) {
        const provider = ctx.ocrProvider;
        const cacheRole = 'ocr';
        const callOcrMode = 'force';
        const model = describeModel(provider);
        const cached = providerPageCache
          ? await providerPageCache.lookup({ role: cacheRole, provider, model, ocrMode: callOcrMode, pages })
          : new Map();
        applyCached(cached, provider, cacheRole);
        const missing = pages.filter((page) => !cached.has(page));
        if (missing.length > 0) {
          try {
            const result = await parseWithProvider({
              provider,
              role: 'ocr',
              pages: missing,
              ocrMode: callOcrMode,
              info,
              ctx,
            });
            const applied = applyResult(result, provider, {
              role: 'ocr',
              targetPages: missing,
              fallbackOrigin: 'ocr',
              forceOrigin: 'ocr',
            });
            if (providerPageCache) {
              await providerPageCache.store({ role: cacheRole, provider, model, ocrMode: callOcrMode, entries: applied });
            }
          } catch (error) {
            if (ctx.signal?.aborted) throw error;
            providerErrors.ocr = toProviderFailure(error, ctx.config?.ocr?.apiKey ?? null);
            warnings.push(
              `OCR provider "${ocrState.id ?? 'unknown'}" failed: ${providerErrors.ocr.message}. Page images only.`,
            );
          }
        }
      } else {
        providerErrors.ocr = {
          code: 'PROVIDER_NOT_CONFIGURED',
          message: ocrState.reason ?? 'no OCR provider is configured.',
        };
      }
    } else {
      const sameProvider = textPages.length > 0
        && ocrPages.length > 0
        && typesetState.available
        && ocrState.available
        && typesetState.id
        && typesetState.id === ocrState.id;

      if (sameProvider) {
        // 同一 provider 担两个角色：只发一次 parse，按 textOrigin 分配。
        // SKIP_SIMPLE：双栏 / 复杂页才需要外部 typeset；单栏页由 builtin 本地处理。
        // OCR 页无论如何都要发（builtin 不做 OCR）。
        const simpleTextPages = [];
        const complexTextPages = [];
        for (const page of textPages) {
          if (skipSimple && !looksTwoColumn(nativeLayerText.get(page) ?? '')) simpleTextPages.push(page);
          else complexTextPages.push(page);
        }
        for (const page of simpleTextPages) {
          setPage(typesetPageLocally(page, nativeLayerText.get(page) ?? ''));
        }

        // 有缓存时，两个角色分别查各自的 namespace，随后把缺失页合并成**一次**请求。
        const provider = ctx.ocrProvider ?? ctx.typesetProvider;
        const model = describeModel(provider);
        const textSet = new Set(complexTextPages);
        const cachedText = providerPageCache
          ? await providerPageCache.lookup({ role: 'typeset', provider, model, ocrMode: 'auto', pages: complexTextPages })
          : new Map();
        const cachedOcr = providerPageCache
          ? await providerPageCache.lookup({ role: 'ocr', provider, model, ocrMode: 'auto', pages: ocrPages })
          : new Map();
        applyCached(cachedText, provider, 'typeset');
        applyCached(cachedOcr, provider, 'ocr');
        const missingText = complexTextPages.filter((page) => !cachedText.has(page));
        const missingOcr = ocrPages.filter((page) => !cachedOcr.has(page));
        const missing = [...missingText, ...missingOcr].sort((a, b) => a - b);

        if (missing.length > 0) {
          try {
            const result = await parseWithProvider({
              provider,
              role: 'both',
              pages: missing,
              ocrMode: 'auto',
              textLayers: missingText.length > 0
                ? Object.fromEntries(missingText.map((page) => [page, nativeLayerText.get(page) ?? '']))
                : undefined,
              info,
              ctx,
            });
            const applied = applyResult(result, provider, {
              role: 'both',
              targetPages: missing,
              fallbackOrigin: 'unknown',
            });
            if (providerPageCache && applied.length > 0) {
              // 一次 role:both 的结果按**该页实际路由到的角色**分桶落缓存：
              // 有文字层 → typeset，无文字层 → ocr。以后单独走某角色的调用也能命中。
              const byRole = { typeset: [], ocr: [] };
              for (const entry of applied) byRole[textSet.has(entry.page) ? 'typeset' : 'ocr'].push(entry);
              for (const [role, entries] of Object.entries(byRole)) {
                if (entries.length > 0) {
                  await providerPageCache.store({ role, provider, model, ocrMode: 'auto', entries });
                }
              }
            }
          } catch (error) {
            if (ctx.signal?.aborted) throw error;
            const failure = toProviderFailure(error, ctx.config?.ocr?.apiKey ?? null);
            providerErrors.ocr = failure;
            providerErrors.typeset = failure;
            warnings.push(
              `document provider "${ocrState.id ?? 'unknown'}" failed: ${failure.message}. `
                + 'Fell back to the PDF text layer where one exists; pages without one are returned as page images only.',
            );
          }
        }

        // typeset 的硬约束：有文字层的页必须保留原字符（缓存命中的页同样检查）。
        const reRecognized = complexTextPages.filter((page) => {
          const entry = pageMap.get(page);
          return entry && entry.text.trim() && entry.textOrigin !== 'textlayer';
        });
        if (reRecognized.length > 0) {
          warnings.push(
            `typeset provider "${typesetState.id}" returned textOrigin "${pageMap.get(reRecognized[0]).textOrigin}" `
              + `for ${reRecognized.length} page(s) that have a PDF text layer; characters may have been re-recognized.`,
          );
        }

        // 有文字层但 provider 没给文本的页：用原生文字层补齐。
        for (const page of textPages) {
          if (!String(texts.get(page) ?? '').trim()) useNativePage(page);
        }
      } else {
        // 两个角色由不同 provider 承担（或只有一个角色启用）。
        if (textPages.length > 0 && typesetState.available) {
          // builtin 是本地 provider，所有页都自己处理；外部 provider 才谈「跳过简单页」。
          const externalTypeset = typesetState.id !== 'builtin';
          const simpleTextPages = [];
          const providerTextPages = [];
          if (externalTypeset && skipSimple) {
            for (const page of textPages) {
              if (looksTwoColumn(nativeLayerText.get(page) ?? '')) providerTextPages.push(page);
              else simpleTextPages.push(page);
            }
          } else {
            providerTextPages.push(...textPages);
          }
          for (const page of simpleTextPages) {
            setPage(typesetPageLocally(page, nativeLayerText.get(page) ?? ''));
          }
          if (providerTextPages.length > 0) {
            // 9z5.30：命中缓存的页不发 provider，只发缺失页。
            const provider = ctx.typesetProvider;
            const cacheRole = 'typeset';
            const model = describeModel(provider);
            const cachedText = providerPageCache
              ? await providerPageCache.lookup({ role: cacheRole, provider, model, ocrMode: 'auto', pages: providerTextPages })
              : new Map();
            applyCached(cachedText, provider, cacheRole);
            const missingText = providerTextPages.filter((page) => !cachedText.has(page));
            if (missingText.length > 0) {
              try {
                const result = await parseWithProvider({
                  provider,
                  role: 'typeset',
                  pages: missingText,
                  ocrMode: 'auto',
                  textLayers: Object.fromEntries(missingText.map((page) => [page, nativeLayerText.get(page) ?? ''])),
                  info,
                  ctx,
                });
                const applied = applyResult(result, provider, {
                  role: 'typeset',
                  targetPages: missingText,
                  // 契约要求 typeset provider 显式返回 textOrigin；缺省时按保守值处理，
                  // 绝不能把「没声明」当成「保留了原字符」。
                  fallbackOrigin: 'unknown',
                });
                if (providerPageCache) {
                  await providerPageCache.store({ role: cacheRole, provider, model, ocrMode: 'auto', entries: applied });
                }
              } catch (error) {
                if (ctx.signal?.aborted) throw error;
                providerErrors.typeset = toProviderFailure(error, ctx.config?.typeset?.apiKey ?? null);
                warnings.push(
                  `typeset provider "${typesetState.id ?? 'unknown'}" failed: ${providerErrors.typeset.message}. `
                    + 'The PDF text layer was used instead where available.',
                );
              }
            }
            const reRecognized = providerTextPages.filter((page) => {
              const entry = pageMap.get(page);
              return entry && entry.text.trim() && entry.textOrigin !== 'textlayer';
            });
            if (reRecognized.length > 0) {
              warnings.push(
                `typeset provider "${typesetState.id}" returned textOrigin "${pageMap.get(reRecognized[0]).textOrigin}" `
                  + `for ${reRecognized.length} page(s) that have a PDF text layer; characters may have been re-recognized.`,
              );
            }
          }
        }
        // typeset=none 或失败 / 缺页：有文字层的页一律用原生文字层兜底（无警告）。
        for (const page of textPages) {
          if (!String(texts.get(page) ?? '').trim()) useNativePage(page);
        }

        // typeset 关闭时双栏页保持 -layout 原样：阅读顺序会左右交错，必须明说。
        // （typeset provider 失败的情况已有自己的 warning，这里只覆盖「没配 / none」。）
        if (!typesetState.available) {
          for (const page of textPages) {
            if (looksTwoColumn(nativeLayerText.get(page) ?? '')) {
              warnings.push(
                `page ${page} looks two-column; reading order may interleave — set MMGREP_TYPESET_PROVIDER=builtin.`,
              );
            }
          }
        }

        if (ocrPages.length > 0 && ocrState.available) {
          const provider = ctx.ocrProvider;
          const cacheRole = 'ocr';
          const model = describeModel(provider);
          const cachedOcr = providerPageCache
            ? await providerPageCache.lookup({ role: cacheRole, provider, model, ocrMode: 'auto', pages: ocrPages })
            : new Map();
          applyCached(cachedOcr, provider, cacheRole);
          const missingOcr = ocrPages.filter((page) => !cachedOcr.has(page));
          if (missingOcr.length > 0) {
            try {
              const result = await parseWithProvider({
                provider,
                role: 'ocr',
                pages: missingOcr,
                ocrMode: 'auto',
                info,
                ctx,
              });
              const applied = applyResult(result, provider, {
                role: 'ocr',
                targetPages: missingOcr,
                fallbackOrigin: 'ocr',
              });
              if (providerPageCache) {
                await providerPageCache.store({ role: cacheRole, provider, model, ocrMode: 'auto', entries: applied });
              }
            } catch (error) {
              if (ctx.signal?.aborted) throw error;
              providerErrors.ocr = toProviderFailure(error, ctx.config?.ocr?.apiKey ?? null);
              warnings.push(
                `OCR provider "${ocrState.id ?? 'unknown'}" failed: ${providerErrors.ocr.message}. `
                  + 'Pages without a text layer are returned as page images only.',
              );
            }
          }
        }
      }
    }
  }

  const anyText = hasAnyText(texts);
  let noTextReason = null;
  if (!anyText) {
    const firstError = providerErrors.ocr ?? providerErrors.typeset ?? null;
    if (firstError) {
      noTextReason = `the document provider failed (${firstError.message}).`;
    } else if (providerUsed) {
      noTextReason = 'the document provider returned no text for the requested pages.';
    } else if (ocrState.configured && !ocrState.available) {
      noTextReason = ocrState.reason;
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

  const providerError = providerErrors.ocr ?? providerErrors.typeset ?? null;

  return {
    pages: pageMap,
    texts,
    transcript: transcriptFor({
      pageMap,
      kind: info.kind,
      providerId: anyText ? providerId : null,
      ocrProviderId: anyText ? ocrProviderId : null,
      typesetProviderId: anyText ? typesetProviderId : null,
      model: anyText ? providerModel : null,
      reason: noTextReason,
    }),
    warnings,
    providerError,
    providerErrors,
    providerState: combinedDocState(ocrState, typesetState),
    ocrState,
    typesetState,
    providerId,
    providerModel,
    providerUsed,
    nativeUsed,
    noTextReason,
    textPageCount,
    ocrPageCount,
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
  // images: 0 = 零像素纯文本模式：只回页文字，不渲染任何页图。
  const images = Math.min(MAX_IMAGES, Math.max(0, Number.isInteger(imagesValue) ? imagesValue : DEFAULT_IMAGES));
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

/**
 * probe 的 transcriptSource 预判（契约 §4.3，9z5.21）。
 *
 * 只根据「本机有哪些能力 + 采样到的文字层」判断，不做全文抽取：
 *   text   PDF 有文字层且没配 OCR（只会走原生文字层）/ .txt .md；
 *   ocr    没有文字层、只有 OCR（图片 / 扫描件）；
 *   mixed  PDF 既有文字层又配了 OCR：逐页路由可能两种来源并存，以每页标签为准；
 *   none   没有任何可读文字的来源。
 */
function probeTranscriptSource(info, ocrAvailable) {
  if (info.kind === 'text') return 'text';
  if (info.hasTextLayer === true) return ocrAvailable ? 'mixed' : 'text';
  return ocrAvailable ? 'ocr' : 'none';
}

/** probe 的 transcriptOrigin：source=mixed 时给主要渠道（textlayer 优先，逐页以 segments 为准）。 */
function probeTranscriptOrigin(info, source) {
  if (source === 'none') return 'none';
  if (info.kind === 'text') return 'file';
  if (info.kind === 'image') return 'ocr';
  return info.hasTextLayer === true ? 'textlayer' : 'ocr';
}

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
  // builtin typeset 是本地实现、不需要凭据：直接持有 backend 的调用方（测试 / 嵌入）
  // 只要 config 里是 builtin，就不必再手动注入 provider 实例。
  const builtinTypesetProvider = createBuiltinTypesetProvider();
  const withSupport = (callCtx) => {
    const config = callCtx?.config ?? {};
    return {
      ...(callCtx ?? {}),
      config,
      signal: callCtx?.signal ?? undefined,
      ocrProvider: callCtx?.ocrProvider ?? null,
      typesetProvider: callCtx?.typesetProvider !== undefined
        ? callCtx.typesetProvider
        : (config.typeset?.provider === 'builtin' ? builtinTypesetProvider : null),
      pdfSupport,
    };
  };

  async function probe(input, callCtx = backendCtx()) {
    const c = withSupport(callCtx);
    const info = await inspectDocument(input.path, c, pdfSupport, inspectCache);
    const ocrState = docRoleState(c, 'ocr');
    const typesetState = docRoleState(c, 'typeset');
    // 9z5.21：不再把「有任何文字」一律记成 ocr；按本机能力与文字层预判。
    const transcriptSource = probeTranscriptSource(info, ocrState.available);
    const transcriptOrigin = probeTranscriptOrigin(info, transcriptSource);

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
          available: ocrState.available,
          provider: ocrState.provider,
          reason: ocrState.reason,
        },
        typeset: {
          available: typesetState.available,
          provider: typesetState.provider,
          reason: typesetState.reason,
        },
        transcriptSource,
        transcriptOrigin,
        transcriptPath: null,
        // 文字层探测的细节：采样了哪些页、命中的是哪一页、判不出来时的原因。
        // hasTextLayer 只是汇总结论；这里给出「结论是怎么来的」。
        textLayer: {
          checked: info.textLayer?.checked ?? false,
          reason: info.textLayer?.reason ?? null,
          sampledPages: info.textLayer?.sampledPages ?? [],
          checkedPages: info.textLayer?.checkedPages ?? [],
          textPage: info.textLayer?.textPage ?? null,
        },
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
      ocrMode: input.ocrMode === 'force' ? 'force' : 'auto',
    });

    // 9z5.21：source / origin 按每页 textOrigin 映射（textlayer → text，ocr/unknown → ocr，
    // 空页 → none）；textOrigin / blocks 保留给工具层做逐页展示。
    const segments = pages.map((page) => {
      const entry = collected.pages.get(page);
      const { source, origin } = pageSourceOrigin(entry, info.kind);
      return {
        page,
        text: collected.texts.get(page) ?? '',
        startMs: null,
        endMs: null,
        source,
        origin,
        textOrigin: entry?.textOrigin ?? 'unknown',
        blocks: entry?.blocks ?? [],
      };
    });

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
    // images: 0：零像素模式，不渲染页图（页文字照样覆盖全部请求页）。
    const rendered = images > 0
      ? await renderOverviewImages({
        info,
        pages,
        cells,
        images,
        maxEdge,
        ctx: c,
        pdfSupport,
        warnings,
      })
      : [];

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

  /**
   * 逐页文字层结果 —— 「逐页路由」的输入：
   * 有文字层的页可以按原样引用（typeset），没文字层的页才需要 OCR。
   *
   * @param {{path: string, pages?: number[]|null}} input pages 省略 = 整份文档
   * @returns {Promise<{
   *   pages: Map<number, {text: string, hasTextLayer: boolean}>,
   *   textExtractor: string|null,
   *   reason: string|null,
   * }>}
   */
  async function pageTextLayers(input, callCtx = backendCtx()) {
    const c = withSupport(callCtx);
    const info = await inspectDocument(input.path, c, pdfSupport, inspectCache);
    if (info.kind !== 'pdf') {
      return {
        pages: new Map(),
        textExtractor: null,
        reason: 'only PDF documents have a per-page text layer.',
      };
    }
    const pages = normalizePages(input.pages ?? null, info.pageCount);
    return pdfSupport.extractTextLayers(info.path, pages, { signal: c.signal });
  }

  async function locate(input, callCtx = backendCtx()) {
    const c = withSupport(callCtx);
    const info = await inspectDocument(input.path, c, pdfSupport, inspectCache);
    const pages = normalizePages(input.pages ?? null, info.pageCount);
    const warnings = [];

    const collected = await collectPageTexts({
      info,
      pages,
      ctx: c,
      pdfSupport,
      warnings,
      ocrMode: input.ocrMode === 'force' ? 'force' : 'auto',
    });
    const segments = pages.map((page) => {
      const entry = collected.pages.get(page);
      const { source, origin } = pageSourceOrigin(entry, info.kind);
      return {
        page,
        text: collected.texts.get(page) ?? '',
        startMs: null,
        endMs: null,
        // 9z5.21：逐页来源（与 overview 同一套映射）。
        source,
        origin,
        textOrigin: entry?.textOrigin ?? 'unknown',
        blocks: entry?.blocks ?? [],
      };
    });

    if (!hasAnyText(collected.texts)) {
      if (collected.providerError) {
        const role = collected.providerErrors.ocr ? 'ocr' : 'typeset';
        throw new ToolError(
          collected.providerError.code,
          `cannot search this document: ${collected.providerError.message}`,
          providerFailureHint(collected.providerError.code, role),
        );
      }
      const relevantStates = [];
      if (collected.textPageCount > 0) relevantStates.push(collected.typesetState);
      if (collected.ocrPageCount > 0) relevantStates.push(collected.ocrState);
      const unavailable = (relevantStates.length > 0
        ? relevantStates
        : [collected.ocrState, collected.typesetState])
        .filter((state) => state?.configured && !state?.available);
      if (unavailable.length > 0) {
        throw new ToolError(
          'PROVIDER_NOT_CONFIGURED',
          `cannot search this document: ${unavailable.map((state) => state.reason).filter(Boolean).join(' ')}`,
          providerFailureHint('PROVIDER_NOT_CONFIGURED', unavailable[0].role),
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
      // matchSegments 会展开 segment 的字段：逐页 source / origin / textOrigin 直接沿用。
      source: match.source ?? 'none',
      origin: match.origin ?? 'none',
      textOrigin: match.textOrigin ?? 'unknown',
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

  return { probe, overview, zoom, locate, pageTextLayers };
}

export default createDocumentBackend;
