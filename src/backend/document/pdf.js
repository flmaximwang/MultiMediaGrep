// src/backend/document/pdf.js —— PDF 工具层：探测、页文字层、页面栅格化
//
// 设计约束（docs/mcp-contract.md §2.4 与交付说明）：
//   - 不假设 Linux 部署机装了 PDF 工具。运行时探测，缺失时给出 TOOL_NOT_FOUND
//     并点名要装什么。
//   - 栅格化链：pdftoppm → mutool draw → gs → 报错
//   - 文字层链：pdftotext -layout -enc UTF-8 → mutool draw -F txt → 无文字层
//   - 元数据链：pdfinfo → mutool info → qpdf --show-npages（qpdf 没有页面尺寸）
//   - 所有命令都走 media/ffmpeg.js 的 run()（spawn，无 shell），绝不拼接 shell 字符串。

import { run } from '../../media/ffmpeg.js';
import { ToolError } from '../../media/interface.js';

/** 版本探测的超时（只是为了确认二进制存在） */
const PROBE_TIMEOUT_MS = 10_000;
/** PDF 操作超时：大文档的文字层提取 / 高 DPI 栅格化都可能慢 */
const PDF_TIMEOUT_MS = 300_000;

/** 元数据工具缺失时的安装提示 */
const METADATA_HINT =
  'Install poppler-utils (pdfinfo / pdftoppm) or mupdf-tools (mutool). '
  + 'On Debian/Ubuntu: apt-get install poppler-utils; on macOS: brew install poppler.';

/** 栅格化工具缺失时的安装提示 */
const RASTER_HINT =
  'Install poppler-utils (pdftoppm), mupdf-tools (mutool), or ghostscript (gs). '
  + 'On Debian/Ubuntu: apt-get install poppler-utils; on macOS: brew install poppler.';

/**
 * 创建一份 PDF 工具支持对象。每个后端实例一份，二进制探测结果在实例内缓存。
 *
 * @param {{ runCommand?: typeof run }} [options] 测试可注入的命令执行器
 */
export function createPdfSupport({ runCommand = run } = {}) {
  /** bin → Promise<boolean>（存在性缓存） */
  const availability = new Map();

  async function probeBinary(bin) {
    try {
      // 版本参数只是让进程立刻退出；不同工具接受的写法不同，但 allowNonZero 让
      // 「存在但参数不对」也算存在。ENOENT 才是「没装」。
      await runCommand(bin, ['-v'], { allowNonZero: true, timeoutMs: PROBE_TIMEOUT_MS });
      return true;
    } catch (error) {
      if (error instanceof ToolError && error.code === 'TOOL_NOT_FOUND') return false;
      // 超时 / 其它启动错误：当作存在（真正的失败会在实际命令上暴露）
      return true;
    }
  }

  async function isAvailable(bin) {
    if (!availability.has(bin)) availability.set(bin, probeBinary(bin));
    return availability.get(bin);
  }

  /** 解析当前机器上可用的 PDF 工具链 */
  async function resolveTools() {
    const mutool = await isAvailable('mutool');
    const rasterizer = (await isAvailable('pdftoppm'))
      ? 'pdftoppm'
      : mutool
        ? 'mutool'
        : (await isAvailable('gs'))
          ? 'gs'
          : null;
    const textExtractor = (await isAvailable('pdftotext'))
      ? 'pdftotext'
      : mutool
        ? 'mutool'
        : null;
    const info = (await isAvailable('pdfinfo'))
      ? 'pdfinfo'
      : mutool
        ? 'mutool'
        : (await isAvailable('qpdf'))
          ? 'qpdf'
          : null;
    return { rasterizer, textExtractor, info };
  }

  /**
   * 读取 PDF 元信息。
   * @returns {Promise<{pageCount: number, width: number|null, height: number|null}>}
   *   width/height 是**第一页的页面尺寸，单位 pt**（PDF 的原生坐标单位）。
   */
  async function readMetadata(filePath, { signal } = {}) {
    const { info } = await resolveTools();
    if (!info) {
      throw new ToolError(
        'TOOL_NOT_FOUND',
        'cannot read PDF metadata: no PDF tool is installed (pdfinfo, mutool, or qpdf).',
        METADATA_HINT,
      );
    }

    if (info === 'pdfinfo') {
      const { stdout } = await runCommand('pdfinfo', [filePath], { signal, timeoutMs: PDF_TIMEOUT_MS });
      const parsed = parsePdfinfo(stdout);
      if (parsed.pageCount === null) {
        throw new ToolError('INTERNAL', `could not determine the page count of "${filePath}" with pdfinfo.`);
      }
      return parsed;
    }

    if (info === 'mutool') {
      const { stdout } = await runCommand('mutool', ['info', filePath], {
        signal,
        timeoutMs: PDF_TIMEOUT_MS,
        allowNonZero: true,
      });
      const parsed = parseMutoolInfo(stdout);
      if (parsed.pageCount === null) {
        throw new ToolError('INTERNAL', `could not determine the page count of "${filePath}" with mutool.`);
      }
      return parsed;
    }

    // qpdf 只能给页数；页面尺寸留给调用方按需回退（渲染一页再量）。
    const { stdout } = await runCommand('qpdf', ['--show-npages', filePath], {
      signal,
      timeoutMs: PDF_TIMEOUT_MS,
    });
    const pageCount = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new ToolError('INTERNAL', `could not determine the page count of "${filePath}" with qpdf.`);
    }
    return { pageCount, width: null, height: null };
  }

  /**
   * 抽取指定页的文字层。
   *
   * @param {string} filePath
   * @param {number[]} pages 1-based 页码（可乱序；内部去重升序）
   * @returns {Promise<{ textExtractor: string|null, pages: Map<number, string> }>}
   *   textExtractor 为 null 表示本机没有任何 PDF 文字抽取器。
   */
  async function extractText(filePath, pages, { signal } = {}) {
    const { textExtractor } = await resolveTools();
    const wanted = [...new Set((pages ?? []).filter(Number.isInteger))].sort((a, b) => a - b);
    const result = new Map();
    if (!textExtractor || wanted.length === 0) {
      for (const page of wanted) result.set(page, '');
      return { textExtractor, pages: result };
    }

    for (const runPages of toContiguousRuns(wanted)) {
      const first = runPages[0];
      const last = runPages[runPages.length - 1];
      let stdout;
      if (textExtractor === 'pdftotext') {
        // `-` 表示输出到 stdout；页与页之间用 form feed (\f) 分隔，末尾也有一个。
        ({ stdout } = await runCommand(
          'pdftotext',
          ['-layout', '-enc', 'UTF-8', '-f', String(first), '-l', String(last), filePath, '-'],
          { signal, timeoutMs: PDF_TIMEOUT_MS },
        ));
      } else {
        // mutool 的页范围是**位置参数**（不是 -p，-p 是 password）。
        ({ stdout } = await runCommand(
          'mutool',
          ['draw', '-q', '-F', 'txt', '-o', '-', filePath, runPages.length === 1 ? String(first) : `${first}-${last}`],
          { signal, timeoutMs: PDF_TIMEOUT_MS },
        ));
      }

      const chunks = String(stdout).split('\f');
      runPages.forEach((page, index) => {
        result.set(page, normalizePageText(chunks[index] ?? ''));
      });
    }
    return { textExtractor, pages: result };
  }

  /**
   * 「这个 PDF 有没有文字层？」用第 1 页采样（契约 §4.3 的 hasTextLayer 口径）。
   * 没有任何文字抽取器时返回 false —— 调用方会在 capabilities.reason 里说明原因。
   */
  async function sampleHasText(filePath, { signal } = {}) {
    const { textExtractor } = await resolveTools();
    if (!textExtractor) return { hasText: false, textExtractor: null };
    const { pages } = await extractText(filePath, [1], { signal });
    return { hasText: (pages.get(1) ?? '').trim().length > 0, textExtractor };
  }

  /**
   * 把一页 PDF 栅格化成 PNG。
   *
   * @param {string} filePath
   * @param {number} page 1-based
   * @param {{ dpi: number, outPath: string, signal?: AbortSignal }} options
   * @returns {Promise<string>} outPath
   */
  async function renderPage(filePath, page, { dpi, outPath, signal } = {}) {
    const { rasterizer } = await resolveTools();
    if (!rasterizer) {
      throw new ToolError(
        'TOOL_NOT_FOUND',
        'no PDF page rasterizer is available on this machine (pdftoppm, mutool, and gs were all missing).',
        RASTER_HINT,
      );
    }
    const resolution = String(Math.max(1, Math.round(Number(dpi) || 72)));

    if (rasterizer === 'pdftoppm') {
      // -singlefile 让输出固定是 <prefix>.png，不会因页数位数变成 prefix-01.png。
      const prefix = outPath.toLowerCase().endsWith('.png') ? outPath.slice(0, -4) : outPath;
      await runCommand(
        'pdftoppm',
        ['-png', '-r', resolution, '-f', String(page), '-l', String(page), '-singlefile', filePath, prefix],
        { signal, timeoutMs: PDF_TIMEOUT_MS },
      );
      return outPath;
    }

    if (rasterizer === 'mutool') {
      await runCommand(
        'mutool',
        ['draw', '-q', '-o', outPath, '-r', resolution, filePath, String(page)],
        { signal, timeoutMs: PDF_TIMEOUT_MS },
      );
      return outPath;
    }

    await runCommand(
      'gs',
      [
        '-dSAFER', '-dBATCH', '-dNOPAUSE', '-q',
        '-sDEVICE=png16m',
        `-r${resolution}`,
        `-dFirstPage=${page}`,
        `-dLastPage=${page}`,
        `-sOutputFile=${outPath}`,
        filePath,
      ],
      { signal, timeoutMs: PDF_TIMEOUT_MS },
    );
    return outPath;
  }

  return { resolveTools, readMetadata, extractText, sampleHasText, renderPage };
}

/* ------------------------------------------------------------------ *
 * 纯函数：输出解析与文本整理
 * ------------------------------------------------------------------ */

/** pdfinfo → { pageCount, width, height }（width/height 单位 pt，已按 /Rotate 归一） */
export function parsePdfinfo(stdout) {
  const pages = /^Pages:\s*(\d+)/m.exec(stdout);
  const size = /^Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/m.exec(stdout);
  const rotation = /^Page rot:\s*(-?\d+)/m.exec(stdout);
  let width = size ? Math.round(Number(size[1])) : null;
  let height = size ? Math.round(Number(size[2])) : null;
  if (width !== null && height !== null && rotation) {
    const deg = ((Number(rotation[1]) % 360) + 360) % 360;
    if (deg === 90 || deg === 270) [width, height] = [height, width];
  }
  return { pageCount: pages ? Number(pages[1]) : null, width, height };
}

/** mutool info → { pageCount, width, height }（取第一条 MediaBox） */
export function parseMutoolInfo(stdout) {
  const pages = /^Pages:\s*(\d+)/m.exec(stdout);
  const section = String(stdout).split('Mediaboxes')[1] ?? '';
  const box = /\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(section);
  let width = null;
  let height = null;
  if (box) {
    width = Math.round(Math.abs(Number(box[3]) - Number(box[1])));
    height = Math.round(Math.abs(Number(box[4]) - Number(box[2])));
  }
  return { pageCount: pages ? Number(pages[1]) : null, width, height };
}

/**
 * 页文本整理：统一换行、去掉行尾空白和首尾空行，但保留排版（表格列间距）。
 * 不做空白折叠 —— 下游定位匹配会自己归一化（media/match.js）。
 */
export function normalizePageText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把升序页码切成连续区间：[1,2,3,5,6] → [[1,2,3],[5,6]] */
export function toContiguousRuns(pages) {
  const runs = [];
  let current = [];
  for (const page of pages) {
    if (current.length === 0 || page === current[current.length - 1] + 1) {
      current.push(page);
    } else {
      runs.push(current);
      current = [page];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}
