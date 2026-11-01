/**
 * 内置 typeset provider：为**已经有文字层**的页恢复阅读顺序与结构。
 *
 * 硬约束（契约 v2，见同目录 README §1）：
 *   typeset 角色**不得重新识别字符**。本 provider 只搬运调用方抽好的文字层文本，
 *   永远返回 `textOrigin: 'textlayer'`。
 *
 * 0.2.0（9z5.24）在这里实现三件事：
 *   1. **柱检测**：对 `pdftotext -layout` 的逐页输出，在中部区域找在 ≥80% 非空行上
 *      为空的列区间（gutter），两侧栏宽相近 → 判定双栏。阈值见 COLUMN_DETECTION。
 *   2. **重排**：判定双栏的页按 gutter 切成「左栏全部行 → 右栏全部行」。
 *      为什么不用 `pdftotext` 不带 `-layout` 的阅读顺序：在合成双栏 fixture 的第 2 页
 *      实测它仍会把右栏标题排在左栏小标题之前（左右交错），并不可靠；按 gutter
 *      切分用的是同一份文字层，字符不丢、顺序确定。证据见
 *      test/doc/reflow.test.js 的 raw 阅读顺序回归用例。
 *   3. **启发式 blocks**：空行 / 缩进分段 → paragraph；编号或短标题行 → heading；
 *      "Fig. N" / "Table N" 开头 → caption；其余一律 paragraph，textOrigin 始终是
 *      textlayer。
 *
 * 为什么文本由调用方传入：builtin 是**本地** provider，不解析文件、不联网；
 * 文档后端已经把逐页文字层抽好了（pdfSupport.extractTextLayers），通过
 * `parse({ textLayers })` 传进来即可，避免重复跑 pdftotext。
 */

/** 该 provider 支持的角色（注册表用）。 */
export const BUILTIN_ROLES = Object.freeze(['typeset']);

/**
 * 柱检测阈值。这些数字是**判定双栏**的全部依据，测试直接引用，避免魔法数字散落。
 *
 * 中缝（gutter）必须：
 *   - 在 ≥ MIN_BLANK_RATIO 的非空行上都是空白（默认 80%）；
 *   - 位于页面文字宽度的中部（MIDDLE_START_RATIO–MIDDLE_END_RATIO）；
 *   - 至少 MIN_GUTTER_WIDTH_CHARS 列宽，且 ≥ MIN_GUTTER_WIDTH_RATIO 页宽
 *     （`pdftotext -layout` 有时把真实 30pt 的中缝压成 3 个空格，所以下限很小）；
 *   - 两侧各至少 MIN_COLUMN_LINES 行、栏宽 ≥ MIN_COLUMN_WIDTH_CHARS，且两栏宽度
 *     差 ≤ MAX_COLUMN_WIDTH_DIFFERENCE；
 *   - 两侧行内的词间距中位数 ≤ MAX_MEDIAN_WORD_GAP（表格单元格之间通常有 10+ 个
 *     空格，靠这一条把表格挡在双栏之外）。
 */
export const COLUMN_DETECTION = Object.freeze({
  MIN_BLANK_RATIO: 0.8,
  MIDDLE_START_RATIO: 0.2,
  MIDDLE_END_RATIO: 0.8,
  MIN_GUTTER_WIDTH_CHARS: 3,
  MIN_GUTTER_WIDTH_RATIO: 0.02,
  MAX_GUTTER_WIDTH_RATIO: 0.2,
  MIN_COLUMN_LINES: 2,
  MIN_COLUMN_WIDTH_CHARS: 15,
  MAX_COLUMN_WIDTH_DIFFERENCE: 0.35,
  MAX_MEDIAN_WORD_GAP: 4,
});

/** 标题/图注启发式的上限，防止把整段正文当成标题。 */
const MAX_HEADING_CHARS = 72;
const MAX_HEADING_WORDS = 12;

/** 标题里允许出现的小写连接词（Title Case 判定用）。 */
const SMALL_TITLE_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on',
  'or', 'the', 'to', 'via', 'vs', 'with',
]);

/**
 * 把 pages 参数规整成「1 起的页码集合」；返回 null 表示不限制。
 * 语义与 mineru.js 的 normalizePageList 一致（builtin 不 import mineru，避免循环依赖）。
 */
function pageSetFromSpec(pages) {
  if (pages === undefined || pages === null || pages === '') return null;
  let list = [];
  if (typeof pages === 'number') {
    list = [pages];
  } else if (Array.isArray(pages)) {
    if (pages.length === 2 && pages.every((n) => typeof n === 'number')) {
      const [from, to] = pages.map(Number);
      for (let page = from; page <= to; page += 1) list.push(page);
    } else {
      list = pages.slice();
    }
  } else if (typeof pages === 'object') {
    const from = pages.from ?? pages.start ?? pages.first;
    const to = pages.to ?? pages.end ?? pages.last;
    if (typeof from === 'number' && typeof to === 'number') {
      for (let page = Number(from); page <= Number(to); page += 1) list.push(page);
    } else if (typeof from === 'number') {
      list = [from];
    } else if (Array.isArray(pages.list)) {
      list = pages.list.slice();
    } else if (Array.isArray(pages.pages)) {
      list = pages.pages.slice();
    } else {
      throw new Error(
        'Invalid page range for the builtin typeset provider. Use {from, to}, [from, to], a page number, or {list: [...]}.',
      );
    }
  } else {
    throw new Error(
      'Invalid page range for the builtin typeset provider. Use {from, to}, [from, to], a page number, or {list: [...]}.',
    );
  }

  const out = new Set();
  for (const raw of list) {
    const page = Number(raw);
    if (!Number.isInteger(page) || page < 1) {
      throw new Error(`Invalid page number in the requested range: ${raw} (pages are 1-based).`);
    }
    out.add(page);
  }
  return out;
}

/** 契约 v2 允许的 block 类型。 */
const BLOCK_TYPES = new Set([
  'heading',
  'paragraph',
  'list',
  'table',
  'caption',
  'equation',
  'footnote',
]);

/* ------------------------------------------------------------------ *
 * 文字整理：归一化、行内内容区间
 * ------------------------------------------------------------------ */

/**
 * 文字层页文本的归一化：统一换行、去掉行尾空白、折叠 3+ 空行。
 * 与 `backend/document/pdf.js#normalizePageText` 保持一致；不折叠行内空格
 * （柱检测需要看到 `-layout` 保留的横向位置）。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeLayoutText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 一行里第一个与最后一个非空白字符的位置；全是空白返回 null。 */
function contentBounds(line) {
  let start = -1;
  let end = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '\t') {
      if (start < 0) start = i;
      end = i + 1;
    }
  }
  return start < 0 ? null : { start, end };
}

/** line[0,end) 里最后一个非空白字符之后的位置（没有内容时返回 0）。 */
function lastContentEndBefore(line, end) {
  for (let i = Math.min(end, line.length) - 1; i >= 0; i -= 1) {
    if (line[i] !== ' ' && line[i] !== '\t') return i + 1;
  }
  return 0;
}

/** 从 from 开始第一个非空白字符的位置（没有内容时返回 line.length）。 */
function firstContentStartFrom(line, from) {
  for (let i = Math.max(0, from); i < line.length; i += 1) {
    if (line[i] !== ' ' && line[i] !== '\t') return i;
  }
  return line.length;
}

/**
 * 一行里最宽的连续空白区间（只在中缝附近找）。
 * @returns {{start:number,end:number,length:number}}
 */
function widestInternalGap(line, start, end) {
  let best = { start, end: start, length: 0 };
  let runStart = -1;
  for (let i = Math.max(0, start); i < Math.min(end, line.length); i += 1) {
    const blank = line[i] === ' ' || line[i] === '\t';
    if (blank && runStart < 0) runStart = i;
    if (!blank && runStart >= 0) {
      const length = i - runStart;
      if (length > best.length) best = { start: runStart, end: i, length };
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    const length = Math.min(end, line.length) - runStart;
    if (length > best.length) best = { start: runStart, end: Math.min(end, line.length), length };
  }
  return best;
}

/**
 * 按中缝把一行归类。`pdftotext -layout` 的双栏正文行通常是「左栏文字 + 若干空格
 * + 右栏文字」，不能整行当成跨栏宽行：
 *
 *   - 两侧都有内容、且中间有一段 ≥ MIN_GUTTER_WIDTH_CHARS 的空白（栏间空白）
 *     → 这一行同时属于左右两栏（both），按这段空白切开；
 *   - 两侧都有内容但没有足够宽的空白（标题 / 摘要的单词间距只有 1 个空格，
 *     字符横穿中缝）→ spanning；
 *   - 只有一侧有内容（可能探进中缝几个字符）→ left / right。
 *
 * 返回 { type: 'left'|'right'|'both'|'spanning', left?, right? }，left/right 是
 * 该侧内容在字符列上的区间。
 */
function classifyLineForGutter(line, bounds, gutterStart, gutterEnd) {
  const hasLeft = bounds.start < gutterStart;
  const hasRight = bounds.end > gutterEnd;

  if (hasLeft && hasRight) {
    // 栏间空白：整行最宽的内部空白区间。正文两栏之间至少有 MIN_GUTTER_WIDTH_CHARS
    // 个空格；全宽标题的词间距没有这么宽，所以会被判成 spanning。
    const gap = widestInternalGap(line, bounds.start, bounds.end);
    if (gap.length < COLUMN_DETECTION.MIN_GUTTER_WIDTH_CHARS) return { type: 'spanning' };
    const leftEnd = lastContentEndBefore(line, gap.start);
    const rightStart = firstContentStartFrom(line, gap.end);
    if (leftEnd <= bounds.start || rightStart >= bounds.end) return { type: 'spanning' };
    return {
      type: 'both',
      left: { start: bounds.start, end: leftEnd },
      right: { start: rightStart, end: bounds.end },
    };
  }
  if (hasLeft) return { type: 'left', left: { start: bounds.start, end: bounds.end } };
  if (hasRight) return { type: 'right', right: { start: bounds.start, end: bounds.end } };
  return { type: 'spanning' };
}

/** 一行内最长的连续空格数（用来区分正文与表格单元格）。 */
function longestWordGap(line, start, end) {
  let longest = 0;
  let run = 0;
  for (let i = start; i < end; i += 1) {
    if (line[i] === ' ' || line[i] === '\t') {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** 把连续多空格压成一个空格：只用于横跨两栏的整行（标题 / 摘要 / 脚注）。 */
function collapseInlineSpaces(line) {
  return String(line ?? '').replace(/[ \t]{2,}/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * 柱检测与重排
 * ------------------------------------------------------------------ */

/**
 * 在 `pdftotext -layout` 的页文本里找中缝，判定这一页是不是双栏。
 *
 * 返回形状：
 *   { twoColumn, gutter: {start,end,width}|null, columns: {left,right}|null,
 *     pageWidth, nonEmptyLines }
 * 坐标是**字符列**（0 起，左闭右开），不是 PDF pt。
 *
 * @param {string} text
 * @returns {object}
 */
export function detectColumns(text) {
  const normalized = normalizeLayoutText(text);
  const lines = normalized === '' ? [] : normalized.split('\n');
  const entries = [];
  for (const line of lines) {
    const bounds = contentBounds(line);
    if (bounds) entries.push({ line, ...bounds });
  }

  const empty = { twoColumn: false, gutter: null, columns: null, pageWidth: 0, nonEmptyLines: entries.length };
  if (entries.length < COLUMN_DETECTION.MIN_COLUMN_LINES * 2 + 1) return empty;

  let pageWidth = 0;
  for (const entry of entries) pageWidth = Math.max(pageWidth, entry.end);
  if (pageWidth < 30) return { ...empty, pageWidth };

  // 每一列被多少条非空行占用（只看真实字符，不看词间空格）。
  const occupancy = new Uint16Array(pageWidth);
  for (const entry of entries) {
    for (let i = entry.start; i < entry.end; i += 1) {
      if (entry.line[i] !== ' ' && entry.line[i] !== '\t') occupancy[i] += 1;
    }
  }

  // 「在 ≥80% 非空行上为空」= 占用的行数 ≤ 20%。用整数阈值，避免 10 * 0.2 的
  // 浮点误差把恰好 2 行的占用误判成「不空」。
  const blankLimit = Math.floor(entries.length * (1 - COLUMN_DETECTION.MIN_BLANK_RATIO) + 1e-9);
  const isBlankColumn = (index) => occupancy[index] <= blankLimit;
  const middleStart = Math.floor(pageWidth * COLUMN_DETECTION.MIDDLE_START_RATIO);
  const middleEnd = Math.ceil(pageWidth * COLUMN_DETECTION.MIDDLE_END_RATIO);
  const minGutterWidth = Math.max(
    COLUMN_DETECTION.MIN_GUTTER_WIDTH_CHARS,
    Math.ceil(pageWidth * COLUMN_DETECTION.MIN_GUTTER_WIDTH_RATIO),
  );

  const candidates = [];
  let runStart = -1;
  for (let i = middleStart; i <= middleEnd; i += 1) {
    const blank = i < middleEnd && isBlankColumn(i);
    if (blank && runStart < 0) runStart = i;
    if (!blank && runStart >= 0) {
      const start = runStart;
      const end = i;
      runStart = -1;
      if (end - start < minGutterWidth) continue;
      if (end - start > Math.floor(pageWidth * COLUMN_DETECTION.MAX_GUTTER_WIDTH_RATIO)) continue;

      const leftEntries = [];
      const rightEntries = [];
      for (const entry of entries) {
        const sides = classifyLineForGutter(entry.line, entry, start, end);
        if (sides.left) leftEntries.push({ line: entry.line, ...sides.left });
        if (sides.right) rightEntries.push({ line: entry.line, ...sides.right });
      }
      if (leftEntries.length < COLUMN_DETECTION.MIN_COLUMN_LINES) continue;
      if (rightEntries.length < COLUMN_DETECTION.MIN_COLUMN_LINES) continue;

      const leftStart = Math.min(...leftEntries.map((entry) => entry.start));
      const leftEnd = Math.max(...leftEntries.map((entry) => entry.end));
      const rightStart = Math.min(...rightEntries.map((entry) => entry.start));
      const rightEnd = Math.max(...rightEntries.map((entry) => entry.end));
      const leftWidth = leftEnd - leftStart;
      const rightWidth = rightEnd - rightStart;
      if (leftWidth < COLUMN_DETECTION.MIN_COLUMN_WIDTH_CHARS) continue;
      if (rightWidth < COLUMN_DETECTION.MIN_COLUMN_WIDTH_CHARS) continue;

      const widest = Math.max(leftWidth, rightWidth);
      const asymmetry = widest === 0 ? 1 : Math.abs(leftWidth - rightWidth) / widest;
      if (asymmetry > COLUMN_DETECTION.MAX_COLUMN_WIDTH_DIFFERENCE) continue;

      const medianGapLeft = median(leftEntries.map((entry) => longestWordGap(entry.line, entry.start, entry.end)));
      const medianGapRight = median(rightEntries.map((entry) => longestWordGap(entry.line, entry.start, entry.end)));
      if (medianGapLeft > COLUMN_DETECTION.MAX_MEDIAN_WORD_GAP) continue;
      if (medianGapRight > COLUMN_DETECTION.MAX_MEDIAN_WORD_GAP) continue;

      candidates.push({
        start,
        end,
        width: end - start,
        columns: {
          left: { start: leftStart, end: leftEnd, width: leftWidth, lines: leftEntries.length },
          right: { start: rightStart, end: rightEnd, width: rightWidth, lines: rightEntries.length },
        },
        score: (end - start) * (1 - asymmetry),
      });
    }
  }

  if (candidates.length === 0) return { ...empty, pageWidth };

  candidates.sort((a, b) => b.score - a.score || b.width - a.width || a.start - b.start);
  const best = candidates[0];
  return {
    twoColumn: true,
    gutter: { start: best.start, end: best.end, width: best.width },
    columns: best.columns,
    pageWidth,
    nonEmptyLines: entries.length,
  };
}

/**
 * 一栏的行 → 以空行分段的正文。
 *
 * `entries` 里的 index 是原始 layout 行号：同一栏里两行之间如果隔着别的行
 * （另一栏的正文 / 空行），说明这一栏在这一高度是空的 → 分段。第一行缩进
 * （相对栏内基准缩进多出空格）也当作分段信号。
 */
function columnText(entries, baseStart) {
  if (entries.length === 0) return '';
  const segments = [];
  for (const { index, line, end } of entries) {
    const text = line.slice(baseStart, end).replace(/[ \t]+$/, '');
    if (!text.trim()) continue;
    segments.push({ index, text });
  }
  if (segments.length === 0) return '';

  const indents = segments.map(({ text }) => /^ */.exec(text)[0].length);
  const baseIndent = Math.min(...indents);

  const paragraphs = [];
  let current = [];
  let previousIndex = null;
  let previousIndent = null;
  for (let i = 0; i < segments.length; i += 1) {
    const { index, text } = segments[i];
    const indent = indents[i] - baseIndent;
    const stripped = text.slice(baseIndent).trim();
    if (!stripped) continue;
    const gap = previousIndex === null ? Infinity : index - previousIndex;
    const startsParagraph = previousIndex !== null
      && (gap > 1 || (indent > 0 && previousIndent === 0));
    if (startsParagraph && current.length > 0) {
      paragraphs.push(current.join('\n'));
      current = [];
    }
    current.push(stripped);
    previousIndex = index;
    previousIndent = indent;
  }
  if (current.length > 0) paragraphs.push(current.join('\n'));
  return paragraphs.join('\n\n');
}

/**
 * 双栏页重排：所有左栏行（含左栏内的段落顺序）→ 所有右栏行。
 *
 * 横跨中缝的行（标题 / 摘要 / 脚注等）整行保留，并作为栏间块按原位置插入：
 * 顶部的宽行在左栏之前，脚注在右栏之后。这样既不会把标题切成两半，也不会让
 * 宽行打断栏内正文。
 *
 * @param {string} text `pdftotext -layout` 页文本
 * @param {object} [detection] detectColumns() 的结果（不传则内部重算）
 * @returns {string} 重排后的文本；不是双栏时返回归一化后的原文
 */
export function reflowTwoColumn(text, detection = detectColumns(text)) {
  const normalized = normalizeLayoutText(text);
  if (!detection?.twoColumn) return normalized;

  const { start, end } = detection.gutter;
  const lines = normalized === '' ? [] : normalized.split('\n');
  const blocks = [];
  let leftEntries = [];
  let rightEntries = [];
  let spanningLines = [];

  const flushColumns = () => {
    if (leftEntries.length === 0 && rightEntries.length === 0) return;
    const rightBaseStart = rightEntries.length > 0
      ? Math.min(...rightEntries.map((entry) => entry.start))
      : 0;
    const leftText = columnText(leftEntries, 0);
    const rightText = columnText(rightEntries, rightBaseStart);
    if (leftText) blocks.push(leftText);
    if (rightText) blocks.push(rightText);
    leftEntries = [];
    rightEntries = [];
  };
  const flushSpanning = () => {
    if (spanningLines.length === 0) return;
    blocks.push(spanningLines.join('\n'));
    spanningLines = [];
  };

  lines.forEach((line, index) => {
    const bounds = contentBounds(line);
    if (!bounds) return;
    const sides = classifyLineForGutter(line, bounds, start, end);

    if (sides.type === 'spanning') {
      flushColumns();
      spanningLines.push(collapseInlineSpaces(line));
      return;
    }
    if (spanningLines.length > 0) flushSpanning();
    if (sides.left) leftEntries.push({ index, line, ...sides.left });
    if (sides.right) rightEntries.push({ index, line, ...sides.right });
  });
  flushColumns();
  flushSpanning();

  return blocks.filter(Boolean).join('\n\n');
}

/**
 * 一页文字层文本 → 重排后的文本 + 版式判定。
 *
 * @param {string} text
 * @returns {{text: string, twoColumn: boolean, detection: object}}
 */
export function analyzePageText(text) {
  const normalized = normalizeLayoutText(text);
  const detection = detectColumns(normalized);
  return {
    text: detection.twoColumn ? reflowTwoColumn(normalized, detection) : normalized,
    twoColumn: detection.twoColumn,
    detection,
  };
}

/* ------------------------------------------------------------------ *
 * blocks 启发式
 * ------------------------------------------------------------------ */

/** "Fig. 3" / "Figure 3" / "Table 2" 开头的段落 → caption。 */
const CAPTION_PREFIX = /^(?:fig(?:ure)?|table)\s*\.?\s*\d+[a-z]?(?:[.:)]|\s)/i;

/**
 * 单行、足够短、没有句末标点，并且（编号样式 / 全大写 / Title Case）→ heading。
 * 返回 heading level（0 表示不是标题）。编号深度即 level："2.3 Methods" → 2。
 */
function headingLevelForLine(line) {
  const text = line.trim();
  if (!text) return 0;
  if (text.length > MAX_HEADING_CHARS) return 0;
  if (/[.!?,;:]$/.test(text)) return 0;
  if (text.split(/\s+/).length > MAX_HEADING_WORDS) return 0;
  // 表格行常用多空格对齐（"KEY          VALUE"）；标题不会有这种列对齐空白。
  if (longestWordGap(text, 0, text.length) > COLUMN_DETECTION.MAX_MEDIAN_WORD_GAP) return 0;

  const numbered = /^(\d+(?:\.\d+)*)[.)]?\s+\S/.exec(text);
  if (numbered) return Math.min(Math.max(numbered[1].split('.').length, 1), 6);

  if (!/^[A-Z0-9]/.test(text)) return 0;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return 0;
  if (text === text.toUpperCase()) return 1;

  const words = text.split(/\s+/);
  const titleCase = words.every((word, index) => {
    const bare = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (!bare) return true;
    if (index > 0 && SMALL_TITLE_WORDS.has(bare.toLowerCase())) return true;
    return /^[A-Z0-9]/.test(bare);
  });
  return titleCase ? 1 : 0;
}

/** 段落 → heading level；只认「整段就是一行标题」的情况。 */
function headingLevelForParagraph(paragraph) {
  const lines = paragraph.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return 0;
  return headingLevelForLine(lines[0]);
}

/**
 * 把一页文字层文本切成段落：空行分段，段内保留单换行。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitParagraphs(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/**
 * 文字层文本 → blocks。
 *
 * 段落级判定顺序：caption（Fig./Table 前缀）→ heading（编号/短标题行）→ paragraph。
 * heading 的 level 只由编号深度决定；无编号标题是 level 1。
 *
 * @param {string} text
 * @returns {Array<{type: string, text: string, level?: number}>}
 */
export function textToBlocks(text) {
  return splitParagraphs(text).map((paragraph) => {
    if (CAPTION_PREFIX.test(paragraph)) return { type: 'caption', text: paragraph };
    const level = headingLevelForParagraph(paragraph);
    if (level > 0) return { type: 'heading', level, text: paragraph };
    return { type: 'paragraph', text: paragraph };
  });
}

/**
 * blocks → 纯文本（契约 v2 的 `text` 是「由 blocks 派生」的便利字段）。
 *
 * @param {Array<{text?: string}>} blocks
 * @returns {string}
 */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => String(block?.text ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 规整 provider 返回的 blocks：丢掉空文本与未知类型，heading 的 level 只保留正整数。
 * 这个函数也被后端用于校验外部 provider 的输出（契约 v2 的公共形状）。
 *
 * @param {Array<object>} blocks
 * @returns {Array<{type: string, text: string, level?: number}>}
 */
export function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const text = String(block.text ?? '').trim();
    if (!text) continue;
    const type = BLOCK_TYPES.has(block.type) ? block.type : 'paragraph';
    const normalized = { type, text };
    const level = Number(block.level);
    if (Number.isInteger(level) && level > 0) normalized.level = level;
    out.push(normalized);
  }
  return out;
}

/**
 * 把调用方传入的逐页文字层文本规整成 Map<number, string>。
 * 接受 Map、数组（[{page,text}]）或普通对象（{ "1": "..." }）。
 *
 * @param {Map<number,string>|Array<{page:number,text:string}>|Record<string,string>|null|undefined} textLayers
 * @returns {Map<number,string>}
 */
export function normalizeTextLayers(textLayers) {
  const out = new Map();
  if (textLayers instanceof Map) {
    for (const [page, text] of textLayers) {
      const number = Number(page);
      if (Number.isInteger(number) && number >= 1) out.set(number, String(text ?? ''));
    }
    return out;
  }
  if (Array.isArray(textLayers)) {
    for (const entry of textLayers) {
      const page = Number(entry?.page);
      if (Number.isInteger(page) && page >= 1) out.set(page, String(entry?.text ?? ''));
    }
    return out;
  }
  if (textLayers && typeof textLayers === 'object') {
    for (const [page, text] of Object.entries(textLayers)) {
      const number = Number(page);
      if (Number.isInteger(number) && number >= 1) out.set(number, String(text ?? ''));
    }
  }
  return out;
}

/**
 * 创建内置 typeset provider。
 *
 * @returns {object} 契约 v2 的 provider 对象
 */
export function createBuiltinTypesetProvider() {
  return {
    id: 'builtin',
    roles: BUILTIN_ROLES,

    /**
     * @param {object} [input]
     * @param {'typeset'} [input.role] 只接受 typeset（默认）。
     * @param {Map|Array|object} [input.textLayers] 调用方抽好的逐页文字层文本。
     * @returns {Promise<{provider: 'builtin', model: null, pages: Array<object>, raw: object}>}
     */
    async parse(input = {}) {
      const role = input?.role ?? 'typeset';
      if (!BUILTIN_ROLES.includes(role)) {
        throw new Error(
          `The builtin typeset provider only supports role "typeset" (got "${role}"); it never re-recognizes characters. ` +
            'Configure MMGREP_OCR_PROVIDER for pages without a text layer.',
        );
      }

      const layers = normalizeTextLayers(input?.textLayers);
      const wanted = pageSetFromSpec(input?.pages);
      const twoColumnPages = [];
      const pages = [...layers.entries()]
        .filter(([page]) => !wanted || wanted.has(page))
        .sort((a, b) => a[0] - b[0])
        .map(([page, text]) => {
          const analysis = analyzePageText(text);
          if (analysis.twoColumn) twoColumnPages.push(page);
          const blocks = textToBlocks(analysis.text);
          return {
            page,
            textOrigin: 'textlayer',
            blocks,
            text: blocksToText(blocks),
          };
        });

      return {
        provider: 'builtin',
        model: null,
        pages,
        raw: { role, pages: pages.length, twoColumnPages },
      };
    },

    /** 描述信息 —— builtin 没有凭据，也没有网络端点。 */
    describe() {
      return { id: 'builtin', model: null, baseUrl: null, roles: BUILTIN_ROLES };
    },
  };
}
