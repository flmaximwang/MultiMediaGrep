// src/media/annotation/embedder-pdf.js —— PDF 注解嵌入器：把 sidecar 里的批注写成
// 真正的 PDF 注释对象（/Annots 里的 Text / Square …），原地重写源 PDF
//
// ===========================================================================
// 写入工具复用（9z5.37.2 已核实，9z5.38.2 直接复用同一结论）
// ===========================================================================
// 工具：mutool run（mupdf 1.28.0；本机 /opt/homebrew/bin/mutool），脚本是同目录
// 的 pdf-annotation-writer.js（ES5/MuJS，stdout 只输出一行 JSON）：
//   mutool run <pdf-annotation-writer.js> preflight <input.pdf>
//   mutool run <pdf-annotation-writer.js> read       <input.pdf>
//   mutool run <pdf-annotation-writer.js> write      <input.pdf> <temp.pdf> <plan.json>
//
// 为什么还是 mutool（而不是换工具）：
//   - mupdf 1.28 的 JS API 直接有 page.createAnnotation(type, rect)、
//     annot.setRect / setContents / setAuthor / setColor / setBorder、
//     page.deleteAnnotation()，新建的 Text/Square 注释**带外观流（/AP）**；
//     doc.save(path) 按原字节复制页面内容流，同时保留 /PageLabels、/Info、
//     XMP /Metadata、/AcroForm 和页面 /Annots —— 所以批注落在 /Annots 里，
//     绝不会被画进页面内容，qpdf --check 通过。
//   - qpdf --update-from-json 写不了批注：qpdf 12.4.2 的 JSON 输入结构只有
//     acroform/attachments 之类固定键，没有 annotations 输入通道。
//   - ghostscript 会重新蒸馏整份 PDF（内容流重编码、对象号全变），违反
//     「绝不重编码页面内容」。
//
// mupdf 行为里必须绕开的三点（都在本机实测过，细节见 writer 脚本顶部注释）：
//   1. annot.setRect() 用**显示坐标**（左上角原点、y 向下、相对 /CropBox 左上角，
//      /Rotate 已折算），写进文件的 /Rect 才是规范的用户空间坐标；
//   2. Text 注解的矩形被强制成 20x20 图标（挂在请求的左上角），Square 的 /Rect
//      每边长大 1pt（边框）——所以回读校验对 Text 只比左上角，对 Square 留 2pt 容差；
//   3. mupdf 给每个新建 Text 注解自动建一个 /Popup 并塞进页面 /Annots；writer 会
//      删掉 /Popup 键并把该 popup 排除在重建后的 /Annots 之外，从而保证
//      「Popup 不被新建/修改」。
//
// 写入顺序（引擎要求）：sidecar 已定稿 → 本嵌入器写临时文件 → 五项校验 →
// rename；任何一步失败或取消都删临时文件，**原文件一个字节都不变**，sidecar 由
// 引擎在校验全过之后才写。checks 的顺序固定为：
//   writer-exit → qpdf-check → page-text → annotation-readback → other-annotations
// ===========================================================================

import { randomBytes } from 'node:crypto';
import { chmod, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createPdfSupport, normalizePageText, sampleTextLayerPages } from '../../backend/document/pdf.js';
import { run } from '../ffmpeg.js';
import { ToolError } from '../interface.js';
import { normalizeAuthor, normalizeNote } from './entries.js';
import { createPdfAnnotationReader, PDF_ANNOTATION_WRITER_SCRIPT } from './pdf-annotations.js';

/** 嵌入目标标识（README / 结果里给用户看的说明） */
export const PDF_ANNOTATION_EMBED_TARGET = 'in-place';

/** writer（mutool）单次运行的超时 */
const WRITER_TIMEOUT_MS = 120_000;
/** 可用性探测超时（与 backend/document/pdf.js 的 PROBE_TIMEOUT_MS 一致） */
const PROBE_TIMEOUT_MS = 10_000;

/** 回读校验里 rect 的容差（pt）：Square 的边框每边 1pt，再加取整余量。 */
const RECT_TOLERANCE_POINTS = 2;

/** derive.js 在导入时给空 note/author 的占位值（回读比较要用同一套有效值）。 */
const DEFAULT_NOTE = '(no note)';
const DEFAULT_AUTHOR = 'unknown';

const MUTOOL_HINT =
  'Install mupdf-tools so that "mutool" is on PATH '
  + '(macOS: brew install mupdf-tools; Debian/Ubuntu: apt-get install mupdf-tools).';
const QPDF_HINT = 'Install qpdf (macOS: brew install qpdf; Debian/Ubuntu: apt-get install qpdf).';
const ENCRYPTED_HINT =
  'media_annotate never writes a decrypted copy over an encrypted original. '
  + 'Decrypt the PDF first (for example `qpdf --decrypt in.pdf out.pdf`) and call again on the decrypted file.';
const SIGNED_HINT =
  'Rewriting the annotations would invalidate the signature, so media_annotate refuses to touch a signed PDF. '
  + 'Remove the signature (or use an unsigned copy of the document) and call again.';

function abortError() {
  const error = new Error('request was cancelled by the client');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function tail(value, max = 400) {
  const text = String(value ?? '').replace(/\s+$/, '');
  if (text.length <= max) return text;
  return `…${text.slice(-max)}`;
}

function pushNotRun(checks, names, reason) {
  for (const name of names) checks.push({ name, ok: false, detail: reason });
}

/** 有效 note / author：空值用 derive.js 的占位值，保证「导入的没改」能被认出来。 */
function effectiveNote(value) {
  return normalizeNote(value) ?? DEFAULT_NOTE;
}

function effectiveAuthor(value) {
  return normalizeAuthor(value) ?? DEFAULT_AUTHOR;
}

function describeChecks(checks) {
  return checks.filter((check) => check.ok !== true).map((check) => `${check.name}: ${check.detail ?? 'failed'}`);
}

/**
 * 创建 PDF 注解嵌入器。
 *
 * @param {{
 *   runCommand?: typeof run,      // 测试可注入（坏 writer / 缺工具）
 *   writerScript?: string,        // 测试可换 writer 脚本（默认同目录的 pdf-annotation-writer.js）
 * }} [options]
 */
export function createPdfAnnotationEmbedder({
  runCommand = run,
  writerScript = PDF_ANNOTATION_WRITER_SCRIPT,
} = {}) {
  const pdfSupport = createPdfSupport({ runCommand });
  const reader = createPdfAnnotationReader({ runCommand, writerScript });
  /** mutool 是否存在（Promise<boolean>，实例内缓存） */
  let mutoolAvailable = null;

  async function hasMutool() {
    if (!mutoolAvailable) {
      mutoolAvailable = (async () => {
        try {
          await runCommand('mutool', ['-v'], { allowNonZero: true, timeoutMs: PROBE_TIMEOUT_MS });
          return true;
        } catch (error) {
          if (error instanceof ToolError && error.code === 'TOOL_NOT_FOUND') return false;
          // 超时 / 其它启动错误：当作存在（真正的失败会在 writer 运行时暴露）
          return true;
        }
      })();
    }
    return mutoolAvailable;
  }

  function missingWriterError() {
    return new ToolError(
      'TOOL_NOT_FOUND',
      'cannot write PDF annotations: the "mutool" writer (mupdf-tools) is not installed.',
      MUTOOL_HINT,
    );
  }

  /** 统一执行外部命令：AbortSignal → AbortError；缺二进制 → TOOL_NOT_FOUND。 */
  async function runSafely(bin, args, { signal = null, timeoutMs = WRITER_TIMEOUT_MS, allowNonZero = true } = {}) {
    throwIfAborted(signal);
    try {
      return await runCommand(bin, args, { allowNonZero, timeoutMs, signal });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error instanceof ToolError && error.code === 'TOOL_NOT_FOUND') {
        throw new ToolError(
          'TOOL_NOT_FOUND',
          `cannot write PDF annotations: the "${bin}" tool is not installed.`,
          bin === 'qpdf' ? QPDF_HINT : MUTOOL_HINT,
        );
      }
      throw error;
    }
  }

  /** 运行 writer 脚本的一个模式。 */
  async function runWriter(mode, args, { signal = null } = {}) {
    const result = await runSafely('mutool', ['run', writerScript, mode, ...args], { signal });
    const lines = String(result.stdout ?? '')
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
    return {
      code: Number.isInteger(result.code) ? result.code : 0,
      parsed,
      stderr: String(result.stderr ?? ''),
    };
  }

  /** 读 PDF 结构（加密 / 签名 / 页数）—— 所有拒绝都发生在创建临时文件之前。 */
  async function preflight(filePath, { signal = null } = {}) {
    const run = await runWriter('preflight', [filePath], { signal });
    if (!run.parsed || run.parsed.ok !== true) {
      const detail = run.parsed?.error ? tail(run.parsed.error) : tail(run.stderr) || `mutool exited ${run.code}`;
      throw new ToolError(
        'INTERNAL',
        `cannot read the PDF structure of "${filePath}": ${detail}`,
        'The file may not be a valid PDF, or it may be damaged.',
      );
    }
    return run.parsed;
  }

  /** 条目自身的前置校验（引擎已经校验过一遍，这里是防御性再检查，错误更贴近 PDF）。 */
  function validateEntries(entries, pageCount) {
    for (const entry of entries) {
      if (!Number.isInteger(entry.page) || entry.page < 1 || entry.page > pageCount) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `annotation "${entry.id}" points at page ${entry.page}, but this PDF has ${pageCount} page(s).`,
        );
      }
      if (entry.type === 'square' && !entry.rect) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `annotation "${entry.id}" is a square annotation without a rect; a square needs x/y/width/height.`,
        );
      }
    }
  }

  /** 校验 3/5：临时 PDF 页数不变，且首页/中间页/末页文字与原文件一致。 */
  async function checkPageText(originalPath, tempPath, originalPageCount, after, { signal }) {
    if (!after?.readable || !Number.isInteger(after.pageCount) || after.pageCount < 1) {
      return { name: 'page-text', ok: false, detail: 'not checked: the temporary PDF could not be read' };
    }
    if (after.pageCount !== originalPageCount) {
      return {
        name: 'page-text',
        ok: false,
        detail: `page count changed: ${originalPageCount} → ${after.pageCount}`,
      };
    }
    const pages = sampleTextLayerPages(originalPageCount);
    let originalText;
    let tempText;
    try {
      originalText = await pdfSupport.extractText(originalPath, pages, { signal });
      tempText = await pdfSupport.extractText(tempPath, pages, { signal });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      return {
        name: 'page-text',
        ok: false,
        detail: `not checked: text extraction failed (${tail(error?.message ?? error)})`,
      };
    }
    for (const page of pages) {
      const before = normalizePageText(originalText.pages.get(page) ?? '');
      const afterText = normalizePageText(tempText.pages.get(page) ?? '');
      if (before !== afterText) {
        return { name: 'page-text', ok: false, detail: `text changed on page ${page}` };
      }
    }
    const extractor = originalText.textExtractor ?? 'no text extractor';
    return {
      name: 'page-text',
      ok: true,
      detail: `${originalPageCount} page(s); text of page(s) ${pages.join(', ')} is unchanged (${extractor})`,
    };
  }

  /** 页显示尺寸（fraction → pt 换算用） */
  function displayBoxOf(boxes, page) {
    const box = (boxes ?? []).find((candidate) => candidate?.page === page);
    const width = Number(box?.displayWidth);
    const height = Number(box?.displayHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  }

  function rectInPoints(rect, box) {
    if (!rect || typeof rect !== 'object') return null;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
    if (!box) return { x, y, width, height };
    return { x: x * box.width, y: y * box.height, width: width * box.width, height: height * box.height };
  }

  function rectMatches(expected, actual, box, { cornersOnly = false } = {}) {
    const a = rectInPoints(expected, box);
    const b = rectInPoints(actual, box);
    if (!a || !b) return true; // 没有可比信息就不算错
    if (Math.abs(a.x - b.x) > RECT_TOLERANCE_POINTS) return false;
    if (Math.abs(a.y - b.y) > RECT_TOLERANCE_POINTS) return false;
    if (cornersOnly) return true;
    return Math.abs(a.width - b.width) <= RECT_TOLERANCE_POINTS * 2
      && Math.abs(a.height - b.height) <= RECT_TOLERANCE_POINTS * 2;
  }

  /** 校验 4/5：从临时 PDF 回读批注，与 sidecar 条目逐条一致（type/page/rect/note/author）。 */
  function checkAnnotationReadback(entries, after, boxes) {
    const records = (after?.annotations ?? []).filter((record) => record.kind === 'markup');
    if (records.length !== entries.length) {
      return {
        name: 'annotation-readback',
        ok: false,
        detail: `the temporary PDF has ${records.length} markup annotation(s), but the sidecar has ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
      };
    }
    const free = records.map((record) => ({ record, used: false }));
    for (const entry of entries) {
      const expectedType = String(entry.type ?? '').toLowerCase();
      const expectedNote = effectiveNote(entry.note);
      const expectedAuthor = effectiveAuthor(entry.author);
      const samePageAndType = free.filter((slot) => (
        !slot.used
        && slot.record.page === entry.page
        && String(slot.record.subtype ?? '').toLowerCase() === expectedType
      ));
      const sameContent = samePageAndType.filter((slot) => (
        effectiveNote(slot.record.contents) === expectedNote
        && effectiveAuthor(slot.record.author) === expectedAuthor
      ));
      const chosen = sameContent[0] ?? samePageAndType[0];
      if (!chosen) {
        return {
          name: 'annotation-readback',
          ok: false,
          detail: `annotation "${entry.id}" (${entry.type} on page ${entry.page}) is missing from the temporary PDF`,
        };
      }
      chosen.used = true;
      const found = chosen.record;
      if (effectiveNote(found.contents) !== expectedNote) {
        return {
          name: 'annotation-readback',
          ok: false,
          detail: `annotation "${entry.id}" note mismatch: expected ${JSON.stringify(expectedNote)}, found ${JSON.stringify(found.contents ?? '')}`,
        };
      }
      if (effectiveAuthor(found.author) !== expectedAuthor) {
        return {
          name: 'annotation-readback',
          ok: false,
          detail: `annotation "${entry.id}" author mismatch: expected ${JSON.stringify(expectedAuthor)}, found ${JSON.stringify(found.author ?? '')}`,
        };
      }
      if (entry.rect) {
        const box = displayBoxOf(boxes, entry.page);
        const cornersOnly = expectedType === 'text';
        if (!rectMatches(entry.rect, found.rect, box, { cornersOnly })) {
          return {
            name: 'annotation-readback',
            ok: false,
            detail: `annotation "${entry.id}" rect mismatch on page ${entry.page}: `
              + `expected ${JSON.stringify(entry.rect)}, found ${JSON.stringify(found.rect)}`,
          };
        }
      }
    }
    return {
      name: 'annotation-readback',
      ok: true,
      detail: `${entries.length} annotation(s) read back from the temporary PDF match the sidecar (type, page, rect, note, author)`,
    };
  }

  /** 多重集合比较：返回 after 里缺少的签名（按出现次数）。 */
  function missingSignatures(beforeList, afterList, tolerated = []) {
    const remaining = new Map();
    for (const signature of afterList) {
      remaining.set(signature, (remaining.get(signature) ?? 0) + 1);
    }
    const toleratedLeft = new Map();
    for (const signature of tolerated) {
      toleratedLeft.set(signature, (toleratedLeft.get(signature) ?? 0) + 1);
    }
    const missing = [];
    for (const signature of beforeList) {
      const count = remaining.get(signature) ?? 0;
      if (count > 0) {
        remaining.set(signature, count - 1);
        continue;
      }
      const allowance = toleratedLeft.get(signature) ?? 0;
      if (allowance > 0) {
        toleratedLeft.set(signature, allowance - 1);
        continue;
      }
      missing.push(signature);
    }
    return missing;
  }

  function signaturesOf(inventory, kind) {
    return (inventory?.annotations ?? [])
      .filter((record) => record.kind === kind)
      .map((record) => record.signature ?? '')
      .sort();
  }

  /**
   * 校验 5/5：Link / Widget / Popup 三类注释对象在写入前后一致。
   *
   * Popup 的例外只有一种：它所属的批注被替换或删除时，popup 必须随父对象一起消失
   * （否则 /Parent 悬空，PDF 本身就是坏的）——writer 把这些 popup 的签名放进
   * removedPopups 报告，这里正好把它们从「必须一致」的集合里排除。
   */
  function checkOtherAnnotations(before, after, writeResult) {
    if (!before?.readable || !after?.readable) {
      return { name: 'other-annotations', ok: false, detail: 'not checked: the annotations of one of the two PDFs could not be read' };
    }
    const tolerated = (Array.isArray(writeResult?.removedPopups) ? writeResult.removedPopups : [])
      .map((popup) => (typeof popup === 'string' ? popup : popup?.signature))
      .filter((signature) => typeof signature === 'string' && signature.length > 0);
    const counts = { link: 0, widget: 0, popup: 0 };
    for (const kind of ['link', 'widget', 'popup']) {
      const beforeList = signaturesOf(before, kind);
      const afterList = signaturesOf(after, kind);
      counts[kind] = beforeList.length;
      const missing = missingSignatures(beforeList, afterList, kind === 'popup' ? tolerated : []);
      if (missing.length > 0) {
        return {
          name: 'other-annotations',
          ok: false,
          detail: `${missing.length} ${kind} annotation(s) changed or disappeared: ${tail(missing[0], 200)}`,
        };
      }
    }
    const toleratedNote = tolerated.length > 0 ? `, ${tolerated.length} popup(s) removed with their replaced annotation` : '';
    return {
      name: 'other-annotations',
      ok: true,
      detail: `${counts.link} link(s), ${counts.widget} widget(s) and ${counts.popup} popup(s) are unchanged${toleratedNote}`,
    };
  }

  async function embed({ filePath, entries, signal = null } = {}) {
    throwIfAborted(signal);
    if (!(await hasMutool())) throw missingWriterError();
    const target = path.resolve(String(filePath ?? ''));
    const list = Array.isArray(entries) ? entries : [];

    // 1) 读结构：加密 / 签名 / 页数 —— 任何一种拒绝都在创建临时文件之前
    const pre = await preflight(target, { signal });
    throwIfAborted(signal);
    if (pre.encrypted === true || pre.needsPassword === true) {
      throw new ToolError(
        'UNSUPPORTED_MEDIA_TYPE',
        `refusing to rewrite the annotations of "${target}": the PDF is encrypted${pre.needsPassword ? ' and needs a password to open' : ''}.`,
        ENCRYPTED_HINT,
      );
    }
    const signed = (Array.isArray(pre.signatures) ? pre.signatures : []).filter((field) => field?.signed === true);
    if (signed.length > 0 || pre.docMDP === true) {
      const names = signed.map((field) => field.name).filter((name) => typeof name === 'string' && name.length > 0);
      const detail = signed.length > 0
        ? `it is digitally signed${names.length > 0 ? ` (signature field ${names.map((name) => `"${name}"`).join(', ')})` : ''}`
        : 'it is a certified PDF (/Perms /DocMDP)';
      throw new ToolError(
        'UNSUPPORTED_MEDIA_TYPE',
        `refusing to rewrite the annotations of "${target}": ${detail}.`,
        SIGNED_HINT,
      );
    }
    const pageCount = Number(pre.pageCount);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new ToolError('INTERNAL', `cannot determine the page count of "${target}".`);
    }
    validateEntries(list, pageCount);

    // 2) 写入前的批注清单：既用于「其他注释是否被动过」的前后对比，也提供页面显示尺寸
    const before = await reader.readInventory(target, { signal });
    throwIfAborted(signal);
    if (!before.readable) {
      throw new ToolError(
        'INTERNAL',
        `cannot read the annotations of "${target}": ${tail(before.reason ?? 'the PDF annotations could not be read')}`,
        'The file may not be a valid PDF, or it may be damaged.',
      );
    }

    // 3) 临时文件（与源文件同目录，保证 rename 原子）+ 计划 JSON
    const directory = path.dirname(target);
    const baseName = path.basename(target);
    let tempPath = null;
    let planPath = null;
    for (let attempt = 0; attempt < 5 && tempPath === null; attempt += 1) {
      const stamp = `${process.pid}-${randomBytes(6).toString('hex')}`;
      const candidate = path.join(directory, `.${baseName}.mmgrep-tmp-${stamp}.pdf`);
      let handle = null;
      try {
        handle = await open(candidate, 'wx');
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw new ToolError(
          'INTERNAL',
          `cannot create a temporary file next to "${target}": ${error?.message ?? error}`,
          'The source file\'s directory must be writable (the PDF is rewritten in place via a temporary file + rename).',
        );
      } finally {
        await handle?.close().catch(() => {});
      }
      tempPath = candidate;
      planPath = path.join(directory, `.${baseName}.mmgrep-tmp-${stamp}.json`);
    }
    if (tempPath === null || planPath === null) {
      throw new ToolError('INTERNAL', `could not create a temporary file next to "${target}" (5 random names collided).`);
    }

    const checks = [];
    let renamed = false;
    try {
      const plan = { defaults: { note: DEFAULT_NOTE, author: DEFAULT_AUTHOR }, entries: list };
      await writeFile(planPath, JSON.stringify(plan), 'utf8');
      throwIfAborted(signal);

      // 4) 写临时 PDF：writer 读原文件全部批注 → 按 sidecar 保留/改/建/删 → 保存
      const write = await runWriter('write', [target, tempPath, planPath], { signal });
      throwIfAborted(signal);
      let tempSize = 0;
      try {
        tempSize = (await stat(tempPath)).size;
      } catch {
        tempSize = 0;
      }
      const writerOk = write.code === 0 && write.parsed?.ok === true && tempSize > 0;
      if (!writerOk) {
        const why = write.parsed?.error
          ? `mutool reported: ${tail(write.parsed.error)}`
          : tail(write.stderr) || 'mutool printed no result';
        checks.push({
          name: 'writer-exit',
          ok: false,
          detail: `mutool exited ${write.code} without a usable temporary PDF (${why})`,
        });
        pushNotRun(
          checks,
          ['qpdf-check', 'page-text', 'annotation-readback', 'other-annotations'],
          'not run: the writer did not produce a temporary PDF',
        );
        return { target, checks };
      }
      const writeResult = write.parsed;
      const createdCount = Array.isArray(writeResult.created) ? writeResult.created.length : 0;
      const updatedCount = Array.isArray(writeResult.updated) ? writeResult.updated.length : 0;
      const keptCount = Array.isArray(writeResult.kept) ? writeResult.kept.length : 0;
      const deletedCount = Array.isArray(writeResult.deleted) ? writeResult.deleted.length : 0;
      checks.push({
        name: 'writer-exit',
        ok: true,
        detail: `mutool exited 0 and wrote a ${tempSize}-byte temporary PDF `
          + `(${createdCount} created, ${updatedCount} updated, ${keptCount} kept, ${deletedCount} deleted)`,
      });

      // 5) 校验 1/5：qpdf --check（没有 qpdf 就用 mutool 重开）
      const after = await reader.readInventory(tempPath, { signal });
      let qpdfUsed = true;
      let qpdfResult = null;
      try {
        qpdfResult = await runSafely('qpdf', ['--check', tempPath], { signal });
      } catch (error) {
        if (error instanceof ToolError && error.code === 'TOOL_NOT_FOUND') {
          qpdfUsed = false;
        } else {
          throw error;
        }
      }
      if (qpdfUsed && qpdfResult) {
        const qpdfOk = qpdfResult.code === 0 || qpdfResult.code === 3;
        const note = qpdfResult.code === 3 ? ' (warnings only)' : '';
        checks.push({
          name: 'qpdf-check',
          ok: qpdfOk,
          detail: qpdfOk
            ? `qpdf --check found no errors in the temporary PDF${note}`
            : `qpdf --check exited ${qpdfResult.code}: ${tail(qpdfResult.stderr || qpdfResult.stdout)}`,
        });
      } else {
        const fallbackOk = after.readable && Number.isInteger(after.pageCount) && after.pageCount > 0;
        checks.push({
          name: 'qpdf-check',
          ok: fallbackOk,
          detail: fallbackOk
            ? 'qpdf is not installed; the temporary PDF was reopened with mutool instead'
            : `qpdf is not installed and the temporary PDF could not be reopened with mutool (${tail(after.reason ?? 'unknown error')})`,
        });
      }

      // 6) 校验 2/5：页数 + 首页/中间页/末页文字与原文件一致（批注绝不进页面内容）
      checks.push(await checkPageText(target, tempPath, pageCount, after, { signal }));

      // 7) 校验 3/5：从临时文件回读批注，与 sidecar 条目逐条一致
      checks.push(checkAnnotationReadback(list, after, before.pageBoxes));

      // 8) 校验 4/5：Link / Widget / Popup 没被动过
      checks.push(checkOtherAnnotations(before, after, writeResult));

      // 9) 全过才 rename（同目录 rename = 原子替换）
      if (checks.every((check) => check.ok === true)) {
        throwIfAborted(signal);
        try {
          const originalStat = await stat(target);
          await chmod(tempPath, originalStat.mode).catch(() => {});
          await rename(tempPath, target);
          renamed = true;
        } catch (error) {
          if (signal?.aborted) throw abortError();
          throw new ToolError(
            'INTERNAL',
            `cannot replace "${target}" with the rewritten PDF: ${error?.message ?? error}`,
            'The original file was left untouched; check the directory permissions and free space.',
          );
        }
      }
      return { target, checks };
    } catch (error) {
      if (signal?.aborted && error?.name !== 'AbortError') throw abortError();
      throw error;
    } finally {
      // 成功 rename 后 tempPath 已不存在；失败时删掉临时文件，原文件保持原样
      if (planPath) await unlink(planPath).catch(() => {});
      if (!renamed && tempPath) await unlink(tempPath).catch(() => {});
    }
  }

  return {
    media: 'pdf',

    /** 嵌入目标：PDF 就是源文件本身（原地修改） */
    embedTarget(filePath) {
      return path.resolve(String(filePath ?? ''));
    },

    embed,
  };
}

/** 默认嵌入器（注册表用）。 */
export const pdfAnnotationEmbedder = Object.freeze(
  createPdfAnnotationEmbedder(),
);

export { describeChecks };
