// src/media/sentences.js —— 句子切分：文档预览的「完整单元」
//
// 预览抽样以**完整单元**为单位：文档 = 句子（本文件），视频/录音 = 转写段落。
// 切分要容忍 PDF / 论文里常见的假句末，否则抽样会把一句话切成两半：
//   - 缩写：et al. / e.g. / i.e. / Fig. / Eq. / No. / etc.
//   - 小数：1.5 mM、v1.2
//   - 带编号引用：Fig. 3、Eq. 2（句号后是数字）
//   - 省略号 / 连续终止符：Wait... What?!
// 也不做语言假设：中文按 。！？； 切，英文按 . ! ? ; 切，中英混排同样能切。
// 纯函数、零 IO，供 tools.js 的内联预览与后续 skim 层（9z5.32）复用。

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 中文里的终止符：见到就断，不要求后面有空格 */
const CJK_TERMINATORS = new Set(['。', '！', '？', '；']);

/** 英文里的候选终止符：是否真的断句由 isAsciiBoundary 判断 */
const ASCII_TERMINATORS = new Set(['.', '!', '?', ';']);

/** 紧跟在终止符之后、属于同一句的收尾符号 */
const CLOSERS = new Set([
  '"', '\'', '”', '’', '」', '』', '»', ')', ']', '}', '）', '】', '》', '〉',
]);

/**
 * 常见缩写（整 token 匹配，大小写不敏感）。
 * 只用来避免在 "et al." / "Fig." 这类词后面断句；真正的句界仍由后续字符判断。
 */
const ABBREVIATION_TAIL = /(?:^|[\s([「『“‘])(?:et\s+al|e\.g|i\.e|etc|vs|cf|resp|approx|ca|fig|figs|eq|eqs|ref|refs|tab|sec|secs|no|dr|mr|mrs|ms|prof|st|vol|pp|p|ch|chap|min|max)\.$/i;

/**
 * 折叠空白：连续空白变一个空格；中文字符两侧的换行不插空格（PDF 一行一个字很常见）。
 * 行首/行尾的空白直接丢掉。
 */
function normalizeWhitespace(text) {
  const value = String(text ?? '');
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (!/\s/.test(ch)) {
      out += ch;
      continue;
    }
    let sawNewline = /[\r\n]/.test(ch);
    while (i + 1 < value.length && /\s/.test(value[i + 1])) {
      i += 1;
      if (/[\r\n]/.test(value[i])) sawNewline = true;
    }
    const prev = out.length > 0 ? out[out.length - 1] : '';
    const next = i + 1 < value.length ? value[i + 1] : '';
    if (!prev || !next) continue;
    // 只有「换行」落在两个中文字符之间时才吞掉空格（PDF 一行一个字）；
    // 原本就有的普通空格保留，避免把 "下 一 段" 粘成一个词。
    if (sawNewline && CJK.test(prev) && CJK.test(next)) continue;
    out += ' ';

  }
  return out.trim();
}

/**
 * 英文终止符是否真的是句界。
 * 只看终止符之后：数字 / 小写字母 / 缩写 → 不是句界；收尾引号后是空白或结尾 → 是。
 */
function isAsciiBoundary(value, index) {
  const ch = value[index];
  let j = index + 1;
  // "?!"、"..."、And then." —— 连续终止符与收尾引号都归前一句
  while (j < value.length && (ASCII_TERMINATORS.has(value[j]) || CLOSERS.has(value[j]))) j += 1;
  if (j >= value.length) return true;

  if (!/\s/.test(value[j])) return false;
  let k = j;
  while (k < value.length && /\s/.test(value[k])) k += 1;
  if (k >= value.length) return true;

  if (ch === ';' || ch === '!' || ch === '?') return true;

  const next = value[k];
  // 小数 / 版本号 / 引用编号：句号后直接跟数字（1.5、Fig. 3、Eq. 2）
  if (/[0-9]/.test(next)) return false;
  // 缩写：后面常接小写词（et al. showed、i.e. the）
  if (/[a-z]/.test(next)) return false;
  if (ABBREVIATION_TAIL.test(value.slice(Math.max(0, index - 12), index + 1))) return false;
  return true;
}

/**
 * 把一段文字切成句子（完整单元）。
 *
 * @param {string} text 原始文字（可以带换行 / 多余空白）
 * @returns {string[]} 句子数组；空输入返回 []
 */
export function splitSentences(text) {
  const value = normalizeWhitespace(text);
  if (!value) return [];

  const sentences = [];
  let start = 0;
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    let boundary = CJK_TERMINATORS.has(ch);
    if (!boundary && ASCII_TERMINATORS.has(ch)) boundary = isAsciiBoundary(value, i);
    if (!boundary) {
      i += 1;
      continue;
    }

    let end = i + 1;
    while (end < value.length && CLOSERS.has(value[end])) end += 1;
    const sentence = value.slice(start, end).trim();
    if (sentence) sentences.push(sentence);

    while (end < value.length && /\s/.test(value[end])) end += 1;
    start = end;
    i = end;
  }

  const tail = value.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

export default splitSentences;
