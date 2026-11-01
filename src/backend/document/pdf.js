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
 * 本机一个 PDF 文字抽取器都没有时的原因。
 *
 * 「判不出来」和「这份 PDF 没有文字层」是两件事：前者必须报原因，不能报成后者
 * （否则 agent 会以为这份文档只能靠 OCR，而 OCR provider 往往根本没配）。
 */
export const NO_TEXT_EXTRACTOR_REASON =
  'no PDF text extractor is installed on this machine (pdftotext / mutool), '
  + 'so the text layer cannot be checked.';

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
    // PDF 书签（outline）只有 qpdf 能一次读出「标题 + 物理页 + 页标签」：
    // mutool show outline 只给 /Title 与命名目标，解析目标还要逐条 mutool resolve，
    // 且拿不到 /PageLabels；pdftotext / pdfinfo 完全不读 outline。
    const outlineReader = (await isAvailable('qpdf')) ? 'qpdf' : null;
    return { rasterizer, textExtractor, info, outlineReader };
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
   * 抽取指定页的文字层（原始文本）。
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
   * 逐页文字层结果（供「逐页路由」用：有文字层的页走 typeset provider，没有的走 OCR）。
   *
   * 关键区分：
   *   - 没有装任何抽取器 → `textExtractor === null`，`reason` 说明原因；
   *   - 装了抽取器但某页没字 → 该页 `hasTextLayer === false`（这一页确实没字）。
   *
   * @param {string} filePath
   * @param {number[]} pages 1-based 页码（可乱序；内部去重升序）
   * @returns {Promise<{
   *   textExtractor: string|null,
   *   pages: Map<number, {text: string, hasTextLayer: boolean}>,
   *   reason: string|null,
   * }>}
   */
  async function extractTextLayers(filePath, pages, { signal } = {}) {
    const wanted = [...new Set((pages ?? []).filter(Number.isInteger))].sort((a, b) => a - b);
    const { textExtractor } = await resolveTools();
    if (!textExtractor) {
      // 没有抽取器 → 判不出「这一页有没有字」，只能报原因。
      return {
        textExtractor: null,
        pages: new Map(wanted.map((page) => [page, { text: '', hasTextLayer: false }])),
        reason: NO_TEXT_EXTRACTOR_REASON,
      };
    }

    const extracted = await extractText(filePath, wanted, { signal });
    const result = new Map();
    for (const page of wanted) {
      const text = extracted.pages.get(page) ?? '';
      result.set(page, { text, hasTextLayer: text.trim().length > 0 });
    }
    return { textExtractor, pages: result, reason: null };
  }

  /**
   * 「这个 PDF 有没有文字层？」——**采样多页**（首页 / 中间页 / 末页）。
   *
   * 只看第 1 页会把「图片封面 + 数字正文」这种最常见的形态误判成没有文字层，
   * 于是 agent 以为这份 PDF 只能靠 OCR。采样规则见 {@link sampleTextLayerPages}：
   * 任一采样页有非空文字就算有文字层（提前返回），全部采样页都空才算没有。
   *
   * @param {string} filePath
   * @param {{ pageCount?: number|null, signal?: AbortSignal }} [options]
   *   pageCount 已知就直接用（省一次元信息读取）；不知道就自己读。
   * @returns {Promise<{
   *   hasText: boolean,
   *   textExtractor: string|null,
   *   sampledPages: number[],
   *   checkedPages: number[],
   *   textPage: number|null,
   *   sampleText: string,
   *   reason: string|null,
   * }>}
   *   reason 非 null 表示「判不出来」（本机没装抽取器），不是「没有文字层」。
   *   sampleText 是命中页的文字（9z5.31 的可疑文字层启发式用它；没有文字时为空串）。
   */
  async function sampleHasText(filePath, { pageCount = null, signal } = {}) {
    const { textExtractor } = await resolveTools();
    if (!textExtractor) {
      return {
        hasText: false,
        textExtractor: null,
        sampledPages: [],
        checkedPages: [],
        textPage: null,
        sampleText: '',
        reason: NO_TEXT_EXTRACTOR_REASON,
      };
    }

    let total = Number.isInteger(pageCount) && pageCount >= 1 ? pageCount : null;
    if (total === null) {
      try {
        const meta = await readMetadata(filePath, { signal });
        total = Number.isInteger(meta.pageCount) && meta.pageCount >= 1 ? meta.pageCount : null;
      } catch (error) {
        // 页数读不到（没有元信息工具 / 文件坏了）：退回只看第 1 页，不因此让整个探针失败。
        if (!(error instanceof ToolError && error.code === 'TOOL_NOT_FOUND')) throw error;
        total = null;
      }
    }

    const sampledPages = sampleTextLayerPages(total);
    const checkedPages = [];
    let textPage = null;
    let sampleText = '';
    for (const page of sampledPages) {
      checkedPages.push(page);
      const extracted = await extractText(filePath, [page], { signal });
      const text = extracted.pages.get(page) ?? '';
      if (text.trim().length > 0) {
        textPage = page;
        sampleText = text;
        break; // 命中就收工：不必把采样页全读完。
      }
    }

    return {
      hasText: textPage !== null,
      textExtractor,
      sampledPages,
      checkedPages,
      textPage,
      sampleText,
      reason: null,
    };
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

  /**
   * 读取 PDF 书签（outline / bookmarks）。
   *
   * 用 `qpdf --json --json-key=outlines --json-key=pages`：一次调用同时得到
   *   - 书签树的标题与 `/Dest` 解析后的**物理页序号**（`destpageposfrom1`，1-based，
   *     与 media_overview 的 `pages` 参数同一口径）；
   *   - 每页的打印标签（`pages[].label`，PDF /PageLabels 定义时才有，如 "xii" / "37"）。
   *
   * 失败不抛错：probe 把原因写进 outline.reason。缺 qpdf 时说清缺什么。
   *
   * @returns {Promise<{
   *   reader: string|null,
   *   entries: Array<{level: number, title: string, page: number|null, label: string|null}>,
   *   total: number,
   *   reason: string|null,
   * }>}
   */
  async function readOutline(filePath, { signal } = {}) {
    const { outlineReader } = await resolveTools();
    if (!outlineReader) {
      return {
        reader: null,
        entries: [],
        total: 0,
        reason: 'PDF bookmarks cannot be read: qpdf is not installed (pdftotext / pdfinfo do not read outlines).',
      };
    }
    try {
      const { stdout } = await runCommand(
        'qpdf',
        ['--json', '--json-key=outlines', '--json-key=pages', filePath],
        { signal, timeoutMs: PDF_TIMEOUT_MS },
      );
      const entries = parseQpdfOutlineJson(JSON.parse(String(stdout)));
      if (entries.length === 0) {
        return { reader: 'qpdf', entries: [], total: 0, reason: 'this PDF has no bookmarks (no outline).' };
      }
      return { reader: 'qpdf', entries, total: entries.length, reason: null };
    } catch (error) {
      if (error instanceof ToolError && error.code === 'TOOL_NOT_FOUND') {
        return {
          reader: null,
          entries: [],
          total: 0,
          reason: 'PDF bookmarks cannot be read: qpdf is not installed (pdftotext / pdfinfo do not read outlines).',
        };
      }
      return {
        reader: 'qpdf',
        entries: [],
        total: 0,
        reason: `PDF bookmarks could not be read: ${error?.message ?? error}`,
      };
    }
  }

  return { resolveTools, readMetadata, extractText, extractTextLayers, sampleHasText, renderPage, readOutline };
}

/* ------------------------------------------------------------------ *
 * 纯函数：输出解析与文本整理
 * ------------------------------------------------------------------ */

/** 整数 → 小写罗马数字（PDF /PageLabels 的 /S /r；1 → i，1990 → mcmxc） */
export function romanNumeral(value) {
  let n = Math.max(0, Math.trunc(Number(value) || 0));
  if (n <= 0) return '';
  const table = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  for (const [amount, glyph] of table) {
    while (n >= amount) {
      out += glyph;
      n -= amount;
    }
  }
  return out;
}

/** 整数 → 字母序号（PDF /PageLabels 的 /S /a；1 → a，27 → aa） */
export function alphabeticNumeral(value) {
  let n = Math.max(0, Math.trunc(Number(value) || 0));
  if (n <= 0) return '';
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * qpdf 的 pages[].label（一张 /PageLabels 字典，/St 已按页递增）→ 打印页标签。
 * qpdf 给的是字典而不是算好的字符串（例如 {"/S": "/r", "/St": 2} → "ii"）。
 */
export function pageLabelFromQpdf(label) {
  if (typeof label === 'string') return label.length > 0 ? label : null;
  if (!label || typeof label !== 'object') return null;
  const style = String(label['/S'] ?? '').replace(/^\//, '');
  const prefix = String(label['/P'] ?? '');
  const start = Number.isInteger(label['/St']) && label['/St'] > 0 ? label['/St'] : 1;
  let body;
  switch (style) {
    case 'D':
      body = String(start);
      break;
    case 'R':
      body = romanNumeral(start).toUpperCase();
      break;
    case 'r':
      body = romanNumeral(start);
      break;
    case 'A':
      body = alphabeticNumeral(start).toUpperCase();
      break;
    case 'a':
      body = alphabeticNumeral(start);
      break;
    default:
      body = '';
  }
  const labelText = `${prefix}${body}`;
  return labelText.length > 0 ? labelText : null;
}

/**
 * qpdf --json 的 {pages, outlines} → 扁平书签列表。
 *
 * qpdf 已把 `/Dest` 的页对象解析成 `destpageposfrom1`（物理页，1-based），
 * `pages[].label` 是 /PageLabels 字典（没定义时为 null），这里换算成打印标签
 * （"xii" / "37"）。书签树用 kids 嵌套；层级从 1 开始，按文档顺序深度优先展开。
 *
 * @param {object} parsed qpdf --json 的输出
 * @returns {Array<{level: number, title: string, page: number|null, label: string|null}>}
 */
export function parseQpdfOutlineJson(parsed) {
  const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];
  /** @type {Map<number, string|null>} */
  const labels = new Map();
  for (const page of pages) {
    const physical = Number(page?.pageposfrom1);
    if (!Number.isInteger(physical) || physical < 1) continue;
    labels.set(physical, pageLabelFromQpdf(page?.label));
  }

  const entries = [];
  const walk = (nodes, level) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const title = String(node.title ?? '').replace(/[\r\n]+/g, ' ').trim();
      const page = Number(node.destpageposfrom1);
      const physical = Number.isInteger(page) && page >= 1 ? page : null;
      entries.push({
        level,
        title,
        page: physical,
        label: physical !== null ? (labels.get(physical) ?? null) : null,
      });
      if (Array.isArray(node.kids) && node.kids.length > 0) walk(node.kids, level + 1);
    }
  };
  walk(parsed?.outlines, 1);
  return entries;
}

/**
 * 文字层采样页：**首页 / 中间页 / 末页**，按这个顺序去重。
 *
 * 只看第 1 页不够：图片封面、扫描信笺头、期刊 cover page 之后接数字正文，
 * 是极常见的 PDF 形态 —— 第 1 页没字不代表整份没有文字层。
 *
 * @param {number|null} pageCount 总页数（null / 非法值 → 只看第 1 页）
 * @returns {number[]} 1-based 页码，保持采样顺序
 */
export function sampleTextLayerPages(pageCount) {
  const n = Number(pageCount);
  if (!Number.isInteger(n) || n < 1) return [1];
  const wanted = [1, Math.ceil(n / 2), n];
  const seen = new Set();
  const pages = [];
  for (const page of wanted) {
    if (page < 1 || page > n || seen.has(page)) continue;
    seen.add(page);
    pages.push(page);
  }
  return pages;
}

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
