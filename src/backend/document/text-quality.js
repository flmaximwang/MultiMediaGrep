// src/backend/document/text-quality.js —— PDF 文字层的「可疑程度」启发式（ticket 9z5.31）
//
// 背景：有些 PDF 的文字层是早先劣质 OCR 工具写进去的——有文字层，但字符是错的。
// 逐页路由（9z5.28）会把这些页当作「有文字层」直接使用并标成 source=text（可原话
// 引用），agent 没有办法自行判断。probe 在这里给出一个**保守**的提示，让 agent
// 自己决定要不要用 media_overview({ path, ocr: "force" }) 重新识别。
//
// 只看采样到的页文本（sampleHasText 命中的第一页）。信号（任一命中即标记不可靠）：
//   1. U+FFFD 替换字符——编码 / 字体映射坏掉的典型症状；
//   2. 私用区字符（U+E000–U+F8FF）——ToUnicode 映射缺失时的常见产物；
//   3. 孤立单字母 token 占比过高——劣质 OCR 常见的「一个字一个字往外蹦」；
//   4. 非词 token（不含字母 / 数字）占比过高——符号噪声。
//
// 阈值刻意定得比正常论文高一个数量级（真实论文的单字母 token 占比约 2%–4%，
// 非词 token 占比约 0%–2%），避免对正常 PDF 误报。样本太小时不按比例判定。

/** 按比例判定时要求的最小 token 数（样本太小会被单个字母 / 符号放大）。 */
export const MIN_TOKENS_FOR_RATIO = 20;

/** 判定阈值（改这里之前先看 test/doc/ocr-force.test.js 的正常论文回归）。 */
export const TEXT_QUALITY_THRESHOLDS = Object.freeze({
  // U+FFFD：count >= 3 或占非空白字符 >= 0.2%
  replacementCount: 3,
  replacementRatio: 0.002,
  // 私用区：count >= 5 或占非空白字符 >= 0.5%（正常 PDF 的图标 / 项目符号偶有零星私用区字符）
  privateUseCount: 5,
  privateUseRatio: 0.005,
  // 孤立单字母 token / 有字母或数字的 token
  singleLetterRatio: 0.25,
  // 非词 token / 全部 token
  nonWordRatio: 0.3,
});

/** 提示 agent 怎么强制重新识别（与工具 inputSchema 的参数名一致）。 */
export const FORCE_OCR_HINT = 'consider media_overview({ path, ocr: "force" })';

const PUA_RE = /[\uE000-\uF8FF]/u;

function pct(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * 评估一段文字层样本。
 *
 * @param {string|null|undefined} text
 * @returns {{
 *   reliable: boolean|null,
 *   reasons: string[],
 *   warning: string|null,
 *   metrics: {
 *     characters: number,
 *     tokens: number,
 *     wordTokens: number,
 *     singleLetterTokens: number,
 *     nonWordTokens: number,
 *     replacementChars: number,
 *     privateUseChars: number,
 *   },
 * }}
 *   reliable = null 表示「没样本可判」（空文本 / 没有抽取器），不是「可靠」。
 *   warning 非 null 时可直接作为 probe 的文本行（`text layer: ${warning}`）。
 */
export function assessTextLayerQuality(text) {
  const source = String(text ?? '').trim();
  const metrics = {
    characters: [...source].length,
    tokens: 0,
    wordTokens: 0,
    singleLetterTokens: 0,
    nonWordTokens: 0,
    replacementChars: 0,
    privateUseChars: 0,
  };
  if (!source) {
    return { reliable: null, reasons: [], warning: null, metrics };
  }

  const tokens = source.split(/\s+/u).filter(Boolean);
  metrics.tokens = tokens.length;
  const nonSpaceChars = [...source].filter((char) => !/\s/u.test(char));

  for (const char of source) {
    if (char === '\uFFFD') metrics.replacementChars += 1;
    else if (PUA_RE.test(char)) metrics.privateUseChars += 1;
  }

  for (const token of tokens) {
    if (/[\p{L}\p{N}]/u.test(token)) {
      metrics.wordTokens += 1;
      if (/^[A-Za-z]$/.test(token)) metrics.singleLetterTokens += 1;
    } else {
      metrics.nonWordTokens += 1;
    }
  }

  const t = TEXT_QUALITY_THRESHOLDS;
  const reasons = [];
  const replacementRatio = nonSpaceChars.length > 0
    ? metrics.replacementChars / nonSpaceChars.length
    : 0;
  if (metrics.replacementChars >= t.replacementCount || replacementRatio >= t.replacementRatio) {
    reasons.push(`${metrics.replacementChars} U+FFFD replacement character(s)`);
  }
  const privateUseRatio = nonSpaceChars.length > 0
    ? metrics.privateUseChars / nonSpaceChars.length
    : 0;
  if (metrics.privateUseChars >= t.privateUseCount || privateUseRatio >= t.privateUseRatio) {
    reasons.push(`${metrics.privateUseChars} private-use character(s)`);
  }
  const enoughTokens = metrics.tokens >= MIN_TOKENS_FOR_RATIO;
  if (enoughTokens && metrics.wordTokens > 0) {
    const singleLetterRatio = metrics.singleLetterTokens / metrics.wordTokens;
    if (singleLetterRatio >= t.singleLetterRatio) {
      reasons.push(`${pct(singleLetterRatio)} of word tokens are isolated single letters`);
    }
  }
  if (enoughTokens && metrics.tokens > 0) {
    const nonWordRatio = metrics.nonWordTokens / metrics.tokens;
    if (nonWordRatio >= t.nonWordRatio) {
      reasons.push(`${pct(nonWordRatio)} of tokens contain no letter or digit`);
    }
  }

  if (reasons.length === 0) {
    return { reliable: true, reasons, warning: null, metrics };
  }
  return {
    reliable: false,
    reasons,
    warning: `looks unreliable (${reasons.join('; ')}) — ${FORCE_OCR_HINT}`,
    metrics,
  };
}
