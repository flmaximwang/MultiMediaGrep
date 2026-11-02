// src/media/bookmark/embedder-pdf.js —— PDF 书签嵌入器：原地重写 /Outlines
//
// ===========================================================================
// 写入工具核实（9z5.37.2 的第一件事；2026-11-02 在本机实测）
// ===========================================================================
// 选定工具：mutool run（mupdf 1.28.0；本机 /opt/homebrew/bin/mutool）
//
// 确切调用（脚本见同目录 pdf-outline-writer.js，stdout 只输出一行 JSON）：
//   mutool run <pdf-outline-writer.js> preflight <input.pdf>
//   mutool run <pdf-outline-writer.js> write <input.pdf> <temp.pdf> <entries.json>
//
// 为什么可行（都在 fixtures/generated/*.pdf 与自建的「带注释/表单/元数据/页标签」
// PDF 上跑过）：
//   - mupdf JS API 有完整的 outline 迭代器（doc.outlineIterator()，方法
//     insert / delete / up / down / prev / next），可以从零重建整棵 /Outlines
//     树；3 层嵌套、中文/引号/反斜杠/emoji 标题回读一致。
//   - doc.save(path) 可以写到任意路径；默认保存选项**按原字节复制页面内容流**
//     （用 `qpdf --show-object=N --raw-stream-data | shasum` 对同一对象比较，
//     改写前后一致），/PageLabels、/Info、XMP /Metadata、/AcroForm、页面
//     /Annots 全部保留；qpdf --check 通过。
//   - 加密 PDF 能被 mupdf 打开（空密码），但保存会把文档写**解密**副本 —— 所以
//     先 preflight 检测 /Encrypt 与 doc.needsPassword()，命中就拒绝，不生成副本。
//   - 已签名 PDF：preflight 遍历 /AcroForm/Fields（含 /Kids），/FT /Sig 且 /V
//     非空即已签名；另有 /Perms /DocMDP（认证文档）也拒绝 —— 重写会破坏签名。
//
// 为什么不选 qpdf --update-from-json：qpdf 12.4.2 的 `--json-help` 里 outlines
// 只是**输出键**，`--update-from-json` 的输入结构不含 outlines（只有 acroform /
// attachments 之类固定字段），改不了书签树；手写 /Outlines 对象还要同时改
// /Root 与 xref，风险更高。
// 为什么不选 ghostscript：pdfmark 方案会重新蒸馏整份 PDF（内容流重编码、对象号
// 全变），违反「绝不重编码页面内容」。
//
// 9z5.38.2（PDF 注解嵌入器）能否复用：能，且已实测 mupdf 1.28：
//   page.createAnnotation(PDFAnnotation.TYPE_TEXT, [x0,y0,x1,y1]) 新建 Text 注释、
//   page.createAnnotation('Square', rect) 新建 Square 注释（保存后带外观流、
//   qpdf --check 通过、能读回 /Contents）；page.deleteAnnotation() 删除指定注释；
//   annot.setContents / getContents / setRect / getRect / setColor / setBorder 等
//   可读写。所以 9z5.38.2 可以继续用 mutool run，不需要换工具。
//
// 写入顺序（引擎要求）：sidecar 已定稿 → 本嵌入器写临时文件 → 四项校验 → rename；
// 任何一步失败都删临时文件，**原文件一个字节都不变**；校验通过才 rename，之后
// 引擎才写 sidecar。
// ===========================================================================

import { randomBytes } from 'node:crypto';
import { chmod, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPdfSupport, normalizePageText, sampleTextLayerPages } from '../../backend/document/pdf.js';
import { run } from '../ffmpeg.js';
import { ToolError } from '../interface.js';

/** writer（mutool）单次运行的超时 */
const WRITER_TIMEOUT_MS = 120_000;
/** 可用性探测超时（与 pdf.js 的 PROBE_TIMEOUT_MS 一致） */
const PROBE_TIMEOUT_MS = 10_000;

/** 由 mutool run 执行的 outline 写入脚本（ES5，见文件顶部注释） */
const WRITER_SCRIPT = fileURLToPath(new URL('./pdf-outline-writer.js', import.meta.url));

const MUTOOL_HINT =
  'Install mupdf-tools so that "mutool" is on PATH '
  + '(macOS: brew install mupdf-tools; Debian/Ubuntu: apt-get install mupdf-tools).';

const QPDF_HINT =
  'Install qpdf (macOS: brew install qpdf; Debian/Ubuntu: apt-get install qpdf).';

const SIGNED_HINT =
  'Rewriting the outline would invalidate the signature, so media_bookmark refuses to touch a signed PDF. '
  + 'Remove the signature (or use an unsigned copy of the document) and call again.';

const ENCRYPTED_HINT =
  'media_bookmark never writes a decrypted copy over an encrypted original. '
  + 'Decrypt the PDF first (for example `qpdf --decrypt in.pdf out.pdf`) and call again on the decrypted file.';

/** 取消时抛的 AbortError（与 engine.js / sidecar.js 的约定一致） */
function abortError() {
  const error = new Error('request was cancelled by the client');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/** 取字符串尾部，用于错误详情（stderr 可能很长） */
function tail(value, max = 400) {
  const text = String(value ?? '').replace(/\s+$/, '');
  if (text.length <= max) return text;
  return `…${text.slice(-max)}`;
}

/** 条目 → 回读比较用视图（level 缺省 1，与 entries.js 的 canonicalEntry 一致） */
function compareView(entry) {
  return {
    title: entry.title,
    page: entry.page,
    level: entry.level ?? 1,
  };
}

/** 把 checks 里剩下的检查项标成「未运行」（writer 没产出临时文件时） */
function pushNotRun(checks, names, reason) {
  for (const name of names) checks.push({ name, ok: false, detail: reason });
}

/** 校验失败详情里的条目摘要（最多 8 条） */
function formatEntries(entries) {
  if (entries.length === 0) return 'no entries';
  const shown = entries.slice(0, 8).map((entry) => `level ${entry.level} p.${entry.page} "${entry.title}"`);
  if (entries.length > shown.length) shown.push(`… ${entries.length - shown.length} more`);
  return shown.join('; ');
}

/**
 * 创建 PDF 书签嵌入器。
 *
 * @param {{
 *   runCommand?: typeof run,      // 测试可注入的命令执行器（坏 writer / 缺工具）
 *   writerScript?: string,        // 测试可换 writer 脚本（默认同目录的 pdf-outline-writer.js）
 * }} [options]
 * @returns {{ media: 'pdf', embedTarget: (filePath: string) => string, embed: Function }}
 */
export function createPdfBookmarkEmbedder({ runCommand = run, writerScript = WRITER_SCRIPT } = {}) {
  const pdfSupport = createPdfSupport({ runCommand });
  /** mutool 是否存在（Promise<boolean>，实例内缓存） */
  let mutoolAvailable = null;
  /** resolveTools() 结果（Promise，实例内缓存） */
  let toolsPromise = null;

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

  function tools() {
    if (!toolsPromise) toolsPromise = pdfSupport.resolveTools();
    return toolsPromise;
  }

  function missingWriterError() {
    return new ToolError(
      'TOOL_NOT_FOUND',
      'cannot write PDF bookmarks: the "mutool" writer (mupdf-tools) is not installed.',
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
          `cannot write PDF bookmarks: the "${bin}" tool is not installed.`,
          bin === 'qpdf' ? QPDF_HINT : MUTOOL_HINT,
        );
      }
      throw error;
    }
  }

  /**
   * 运行 writer 脚本的一个模式。
   * @returns {Promise<{code: number, parsed: object|null, stderr: string}>}
   */
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

  /** 读 PDF 结构（加密/签名/页数/现有 outline）；失败抛 INTERNAL。 */
  async function preflight(filePath, { signal = null } = {}) {
    const { code, parsed, stderr } = await runWriter('preflight', [filePath], { signal });
    if (!parsed || parsed.ok !== true) {
      const detail = parsed?.error || tail(stderr) || `mutool exited ${code} without a result`;
      throw new ToolError(
        'INTERNAL',
        `cannot read the PDF structure of "${filePath}": ${detail}`,
        'The PDF may be damaged or unsupported by mutool 1.28. The sidecar was not written.',
      );
    }
    return parsed;
  }

  /** 校验条目（引擎已校验过；这里按 writer 的页数口径再兜一层，错误仍是 INVALID_ARGUMENT）。 */
  function validateEntries(entries, pageCount) {
    for (const [index, entry] of entries.entries()) {
      if (!entry || typeof entry !== 'object') {
        throw new ToolError('INVALID_ARGUMENT', `bookmark entry #${index + 1} is not an object.`);
      }
      if (typeof entry.title !== 'string' || entry.title.trim() === '') {
        throw new ToolError('INVALID_ARGUMENT', `bookmark entry #${index + 1} has an empty title.`);
      }
      if (!Number.isInteger(entry.page) || entry.page < 1 || entry.page > pageCount) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `bookmark entry "${entry.title}" points at page ${entry.page}, but this PDF has ${pageCount} page(s).`,
        );
      }
      const level = entry.level ?? 1;
      if (!Number.isInteger(level) || level < 1) {
        throw new ToolError('INVALID_ARGUMENT', `bookmark entry "${entry.title}" has invalid level ${entry.level}.`);
      }
    }
  }

  /**
   * PDF outline 是一棵树：条目按位置（页码）排序后，第一条必须是 level 1，
   * 且下一条最多比上一条深一层 —— 否则 page 较小的子条目会排到父条目前面，
   * 在 PDF 里无法表达成 tree。这种 sidecar 无法嵌入，明确报 INVALID_ARGUMENT。
   */
  function validateLevelSequence(entries) {
    let previous = 0;
    for (const entry of entries) {
      const level = entry.level ?? 1;
      if (level > previous + 1) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `bookmark entry "${entry.title}" is level ${level}, but the entry before it is level ${previous || 'none'}; `
            + 'a PDF outline cannot skip levels (every nested entry needs a parent entry).',
          'Give the entry a parent (a level-1 entry on an earlier or same page) or flatten it to level 1.',
        );
      }
      previous = level;
    }
  }

  /** 写临时 PDF 之前的四项校验之一：临时文件页数不变，且首页/中间页/末页文字与原文件一致。 */
  async function checkPageText(originalPath, tempPath, originalPageCount, post, { signal }) {
    if (!post || !Number.isInteger(Number(post.pageCount)) || Number(post.pageCount) < 1) {
      return { name: 'page-text', ok: false, detail: 'not checked: the temporary PDF could not be read' };
    }
    const tempPageCount = Number(post.pageCount);
    if (tempPageCount !== originalPageCount) {
      return {
        name: 'page-text',
        ok: false,
        detail: `page count changed: ${originalPageCount} → ${tempPageCount}`,
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
      return { name: 'page-text', ok: false, detail: `not checked: text extraction failed (${tail(error?.message ?? error)})` };
    }
    for (const page of pages) {
      const before = normalizePageText(originalText.pages.get(page) ?? '');
      const after = normalizePageText(tempText.pages.get(page) ?? '');
      if (before !== after) {
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

  /** 写临时 PDF 之前的四项校验之一：从临时 PDF 回读 outline，与 sidecar 条目一致。 */
  async function checkOutlineReadback(tempPath, entries, post, { qpdfReader, signal }) {
    const expected = entries.map(compareView);
    let reader = 'mutool';
    let actual;
    let reason = null;
    if (qpdfReader) {
      const outline = await pdfSupport.readOutline(tempPath, { signal });
      reader = outline.reader ?? 'qpdf';
      actual = (outline.entries ?? []).map((entry) => ({ title: entry.title, page: entry.page, level: entry.level }));
      reason = outline.reason;
    } else if (post && Array.isArray(post.outline)) {
      actual = post.outline.map((entry) => ({ title: entry.title, page: entry.page, level: entry.level }));
    } else {
      return { name: 'outline-readback', ok: false, detail: 'not checked: the temporary PDF outline could not be read' };
    }
    const same = expected.length === actual.length
      && expected.every((entry, index) => {
        const found = actual[index];
        return found && found.title === entry.title && found.page === entry.page && found.level === entry.level;
      });
    if (same) {
      return {
        name: 'outline-readback',
        ok: true,
        detail: `${actual.length} outline entr${actual.length === 1 ? 'y' : 'ies'} match the sidecar (reader: ${reader})`,
      };
    }
    return {
      name: 'outline-readback',
      ok: false,
      detail: `outline mismatch (reader: ${reader}${reason ? `, ${reason}` : ''}): expected ${formatEntries(expected)}, found ${formatEntries(actual)}`,
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
        `refusing to rewrite the outline of "${target}": the PDF is encrypted${pre.needsPassword ? ' and needs a password to open' : ''}.`,
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
        `refusing to rewrite the outline of "${target}": ${detail}.`,
        SIGNED_HINT,
      );
    }
    const pageCount = Number(pre.pageCount);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new ToolError('INTERNAL', `cannot determine the page count of "${target}".`);
    }
    validateEntries(list, pageCount);
    validateLevelSequence(list);

    // 2) 临时文件（与源文件同目录，保证 rename 原子）+ 条目 JSON
    const directory = path.dirname(target);
    const baseName = path.basename(target);
    let tempPath = null;
    let entriesPath = null;
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
      entriesPath = path.join(directory, `.${baseName}.mmgrep-tmp-${stamp}.json`);
    }
    if (tempPath === null || entriesPath === null) {
      throw new ToolError('INTERNAL', `could not create a temporary file next to "${target}" (5 random names collided).`);
    }

    const checks = [];
    let renamed = false;
    try {
      await writeFile(entriesPath, JSON.stringify(list), 'utf8');
      throwIfAborted(signal);

      // 3) 写临时 PDF（writer 删光旧 outline、按 sidecar 重建、默认选项保存）
      const write = await runWriter('write', [target, tempPath, entriesPath], { signal });
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
        pushNotRun(checks, ['qpdf-check', 'page-text', 'outline-readback'], 'not run: the writer did not produce a temporary PDF');
        return { target, checks };
      }
      checks.push({
        name: 'writer-exit',
        ok: true,
        detail: `mutool exited 0 and wrote a ${tempSize}-byte temporary PDF`,
      });

      // 4) 临时 PDF 的结构：后面两项校验也要用（页数 / mutool 回读回退）
      let post = null;
      let postError = null;
      try {
        post = await preflight(tempPath, { signal });
      } catch (error) {
        post = null;
        postError = error?.message ?? String(error);
      }

      // 5) 校验 1/4：qpdf --check（没有 qpdf 就用 mutool 重开）
      const toolsAvailable = await tools();
      let qpdfReader = toolsAvailable.outlineReader === 'qpdf';
      let qpdfResult = null;
      if (qpdfReader) {
        try {
          qpdfResult = await runSafely('qpdf', ['--check', tempPath], { signal });
        } catch (error) {
          if (error instanceof ToolError && error.code === 'TOOL_NOT_FOUND') {
            qpdfReader = false;
          } else {
            throw error;
          }
        }
      }
      if (qpdfReader && qpdfResult) {
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
        const fallbackOk = post !== null && Number.isInteger(Number(post.pageCount)) && Number(post.pageCount) > 0;
        checks.push({
          name: 'qpdf-check',
          ok: fallbackOk,
          detail: fallbackOk
            ? 'qpdf is not installed; the temporary PDF was reopened with mutool instead'
            : `qpdf is not installed and the temporary PDF could not be reopened with mutool${postError ? `: ${tail(postError)}` : ''}`,
        });
      }

      // 6) 校验 2/4：页数 + 首页/中间页/末页文字与原文件一致
      checks.push(await checkPageText(target, tempPath, pageCount, post, { signal }));

      // 7) 校验 3/4：从临时文件回读 outline，与 sidecar 条目逐项一致
      checks.push(await checkOutlineReadback(tempPath, list, post, { qpdfReader, signal }));

      // 8) 全过才 rename（同目录 rename = 原子替换）
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
      if (entriesPath) await unlink(entriesPath).catch(() => {});
      if (!renamed && tempPath) await unlink(tempPath).catch(() => {});
    }
  }

  return {
    media: 'pdf',

    /** 嵌入目标：PDF 就是源文件本身（原地修改） */
    embedTarget(filePath) {
      return filePath;
    },

    embed,
  };
}

/** 默认嵌入器（注册表用）。 */
export const pdfBookmarkEmbedder = Object.freeze(
  createPdfBookmarkEmbedder(),
);
