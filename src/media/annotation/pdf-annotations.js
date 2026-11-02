// src/media/annotation/pdf-annotations.js —— 读取 PDF 自带的批注对象（9z5.38.2）
//
// 读取与写入共用同一个 MuJS 脚本（pdf-annotation-writer.js 的 read 模式），
// 所以「导入时看到的批注」和「写入后回读到的批注」出自同一套坐标换算：
//   - 注释对象来自页面 /Annots，按 PDF 用户空间读 /Rect、/QuadPoints、/InkList、
//     /Vertices，再按 /CropBox（缺省 /MediaBox）+ /Rotate 换算成 media_zoom 的
//     裁剪坐标（0..1，左上角原点，和 media_zoom 的 crop 完全一致）。
//   - 只有 note-like 的批注算「可导入」：Text / FreeText / Square / Circle / Line /
//     Polygon / PolyLine / Highlight / Underline / Squiggly / StrikeOut / Stamp /
//     Caret / Ink。Link、表单 Widget、Popup 以及 FileAttachment / Movie / Screen /
//     Sound / PrinterMark / TrapNet / Watermark / Redact 一律归为「受保护」，既不
//     导入也不修改（见 kind: link | widget | popup | other）。
//   - 每条批注额外带一个 `raw`（subtype + 原始几何 + 颜色/旗标/图标），
//     entry.raw 就是「这条 sidecar 条目拥有哪个批注对象」的身份，写入时靠它把
//     未改动的条目匹配回原来的注释对象（外观流因此得以保留）。
//
// 读不到（mutool 缺失 / PDF 损坏）时返回 available:false + reason，绝不抛错：
// probe 是只读接口，读不到要说明原因，而不是让整次 probe 失败。
//
// 本文件只做「PDF 批注 → probe.annotationOutline」这一段；把它挂进 probe 结果
// 的接线在 src/backend/document/index.js。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../ffmpeg.js';
import { ToolError } from '../interface.js';

/** 与嵌入器共用的 MuJS 脚本 */
export const PDF_ANNOTATION_WRITER_SCRIPT = fileURLToPath(
  new URL('./pdf-annotation-writer.js', import.meta.url),
);

/** probe.annotationOutline.source 的取值（文件自带的批注） */
export const PDF_ANNOTATION_READER_SOURCE = 'pdf-annotations';

/** 单次读取的超时（大 PDF 的 /Annots 解析很快，留足冷启动余量） */
const READER_TIMEOUT_MS = 60_000;
/** 探测 mutool 是否存在的超时 */
const PROBE_TIMEOUT_MS = 10_000;

const MUTOOL_HINT =
  'Install mupdf-tools so that "mutool" is on PATH '
  + '(macOS: brew install mupdf-tools; Debian/Ubuntu: apt-get install mupdf-tools).';

/** 空集时的说明（读取侧要能区分「没有批注」和「读不到批注」）。 */
export const NO_NATIVE_ANNOTATIONS_REASON = 'this PDF has no annotations of its own';

function tail(value, max = 300) {
  const text = String(value ?? '').replace(/\s+$/, '');
  if (text.length <= max) return text;
  return `…${text.slice(-max)}`;
}

function abortError() {
  const error = new Error('request was cancelled by the client');
  error.name = 'AbortError';
  return error;
}

/**
 * 批注 subtype → sidecar 的 type（小写）。
 *
 * Text → text、Square → square 是 v1 唯一能创建的两类；其余类型保留小写
 * subtype 作为 type（如 highlight / ink / freetext / strikeout），这样 sidecar
 * 能如实记录「这条批注是文件自带的，不是我们创建的」，也能被删除/改 note。
 */
export function annotationTypeOfSubtype(subtype) {
  return String(subtype ?? '').trim().toLowerCase();
}

/**
 * 批注对象 → sidecar 条目形状（derive.js 只取 type/note/author/page/rect/raw）。
 * note/author 留原样（空串），由 derive.js 补 '(no note)' / 'unknown'。
 */
export function annotationEntryFromRecord(record) {
  const entry = {
    type: annotationTypeOfSubtype(record?.subtype),
    note: typeof record?.contents === 'string' ? record.contents : '',
    author: typeof record?.author === 'string' ? record.author : '',
    page: record?.page,
  };
  if (record?.rect && typeof record.rect === 'object') entry.rect = record.rect;
  const raw = record?.raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) entry.raw = raw;
  return entry;
}

/** 读不到批注时的空结果 */
function unavailable(reason) {
  return {
    readable: false,
    available: false,
    source: null,
    reason,
    pageCount: 0,
    pageBoxes: [],
    annotations: [],
    entries: [],
    total: 0,
  };
}

/**
 * 创建 PDF 批注读取器。
 *
 * @param {{
 *   runCommand?: typeof run,   // 测试可注入
 *   writerScript?: string,     // 测试可换脚本（默认同目录 pdf-annotation-writer.js）
 * }} [options]
 */
export function createPdfAnnotationReader({ runCommand = run, writerScript = PDF_ANNOTATION_WRITER_SCRIPT } = {}) {
  /** mutool 是否存在（实例内缓存） */
  let mutoolAvailable = null;

  async function hasMutool() {
    if (mutoolAvailable === null) {
      mutoolAvailable = (async () => {
        try {
          await runCommand('mutool', ['-v'], { allowNonZero: true, timeoutMs: PROBE_TIMEOUT_MS });
          return true;
        } catch (error) {
          if (error instanceof ToolError && error.code === 'TOOL_NOT_FOUND') return false;
          // 超时等其它启动问题：当作存在，真正失败会在读取时暴露
          return true;
        }
      })();
    }
    return mutoolAvailable;
  }

  /**
   * 读一份 PDF 的全部批量批注。
   *
   * @returns {Promise<{
   *   readable: boolean, available: boolean, source: string|null, reason: string|null,
   *   pageCount: number, pageBoxes: object[],
   *   annotations: object[], entries: object[], total: number,
   * }>}
   */
  async function readInventory(filePath, { signal = null } = {}) {
    const target = path.resolve(String(filePath ?? ''));
    if (signal?.aborted) throw abortError();
    if (!(await hasMutool())) {
      return unavailable(
        `the "mutool" reader (mupdf-tools) is not installed, so this PDF's own annotations cannot be read. ${MUTOOL_HINT}`,
      );
    }
    let result;
    try {
      result = await runCommand('mutool', ['run', writerScript, 'read', target], {
        allowNonZero: true,
        timeoutMs: READER_TIMEOUT_MS,
        signal: signal ?? undefined,
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error instanceof ToolError && error.code === 'TOOL_NOT_FOUND') {
        return unavailable(
          `the "mutool" reader (mupdf-tools) is not installed, so this PDF's own annotations cannot be read. ${MUTOOL_HINT}`,
        );
      }
      return unavailable(`this PDF's own annotations could not be read (${tail(error?.message ?? error)})`);
    }
    const lines = String(result?.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    let parsed = null;
    if (lines.length > 0) {
      try {
        parsed = JSON.parse(lines[lines.length - 1]);
      } catch {
        parsed = null;
      }
    }
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.annotations)) {
      const detail = parsed?.error
        ? tail(parsed.error)
        : tail(result?.stderr) || (Number.isInteger(result?.code) ? `mutool exited ${result.code}` : 'mutool printed no result');
      return unavailable(`this PDF's own annotations could not be read (${detail})`);
    }
    const annotations = parsed.annotations.map((record) => ({
      page: record.page,
      kind: record.kind,
      subtype: record.subtype,
      contents: typeof record.contents === 'string' ? record.contents : '',
      author: typeof record.author === 'string' ? record.author : '',
      subject: typeof record.subject === 'string' ? record.subject : '',
      rect: record.rect && typeof record.rect === 'object' ? record.rect : null,
      raw: record.raw && typeof record.raw === 'object' ? record.raw : {},
      signature: typeof record.signature === 'string' ? record.signature : '',
    }));
    const entries = annotations
      .filter((record) => record.kind === 'markup')
      .map((record) => annotationEntryFromRecord(record));
    return {
      readable: true,
      available: entries.length > 0,
      source: entries.length > 0 ? PDF_ANNOTATION_READER_SOURCE : null,
      reason: entries.length > 0 ? null : NO_NATIVE_ANNOTATIONS_REASON,
      pageCount: Number.isInteger(parsed.pageCount) ? parsed.pageCount : 0,
      pageBoxes: Array.isArray(parsed.pageBoxes) ? parsed.pageBoxes : [],
      annotations,
      entries,
      total: entries.length,
    };
  }

  return { readInventory };
}

/** 默认读取器（probe 接线用）。 */
export const pdfAnnotationReader = createPdfAnnotationReader();

/**
 * probe.result 里的 `annotationOutline` 字段（与 `outline` 同一套形状）。
 *
 * @param {object} inventory readInventory() 的结果
 */
export function annotationOutlineFromInventory(inventory) {
  return {
    available: inventory?.available === true,
    source: inventory?.source ?? null,
    total: Number.isInteger(inventory?.total) ? inventory.total : 0,
    entries: Array.isArray(inventory?.entries) ? inventory.entries : [],
    reason: inventory?.reason ?? null,
  };
}
