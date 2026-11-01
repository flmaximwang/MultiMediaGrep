// src/media/match.js —— 「这段文字在哪」：转写段落的关键词/短语匹配
// 视频与录音后端的 media_locate 共用。纯函数，无 IO。
// 思路沿用上游 locate.js 的「归一化 + 打分」，但实现独立（上游只做 SRT 段落、且与 DSH 耦合）。
// 文档后端另有一套：segment 粒度就是整页，定位要报「命中几次 + 命中附近的片段」，
// 见文件末尾的 countHits / buildSnippet。

/** 归一化：小写、NFKC、去标点、折叠空白 */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 紧凑形式：去掉所有空白，便于中文短语/跨词的包含判断 */
function compact(text) {
  return normalizeForMatch(text).replace(/\s+/g, '');
}

/**
 * 拆 token：拉丁词 + 中文双字（查询只有一个字时用单字）。
 * 中文整句拆双字可以容忍个别字错（ASR 常有错字）。
 */
export function tokenize(text, { cjkGram = 2 } = {}) {
  const norm = normalizeForMatch(text);
  const tokens = [];
  for (const word of norm.split(' ')) {
    if (!word) continue;
    if (/[㐀-鿿豈-﫿]/.test(word)) {
      // 中文串：按 n-gram 切，并保留整个串
      tokens.push(word);
      if (word.length > cjkGram) {
        for (let i = 0; i + cjkGram <= word.length; i += 1) tokens.push(word.slice(i, i + cjkGram));
      }
    } else {
      tokens.push(word);
    }
  }
  return [...new Set(tokens)];
}

/**
 * 给一个段落打分：0..1。
 * - 查询的紧凑形式是段落紧凑形式的子串 → 1（短语命中）
 * - 否则按查询 token 被段落覆盖的比例（整串命中额外加权）
 */
export function scoreSegment(segmentText, query) {
  const segNorm = normalizeForMatch(segmentText);
  const qNorm = normalizeForMatch(query);
  if (!qNorm) return 0;
  if (compact(segNorm).includes(compact(qNorm))) return 1;

  const qTokens = tokenize(qNorm);
  if (qTokens.length === 0) return 0;
  const segCompact = compact(segNorm);
  let hit = 0;
  for (const token of qTokens) {
    if (segCompact.includes(compact(token))) hit += 1;
  }
  return hit / qTokens.length;
}

/**
 * 在段落数组里找匹配。
 * segments: [{ startMs, endMs, text, ... }]
 * 返回按分数降序、同分按时间升序的结果，最多 max 条。
 */
export function matchSegments(segments, query, { max = 5, minScore = 0.34 } = {}) {
  const scored = [];
  for (const segment of segments ?? []) {
    const score = scoreSegment(segment.text, query);
    if (score >= minScore) scored.push({ ...segment, score: Number(score.toFixed(3)) });
  }
  scored.sort((a, b) => (b.score - a.score) || ((a.startMs ?? 0) - (b.startMs ?? 0)));
  return scored.slice(0, max);
}

/**
 * 打散长段落：一段 45 秒的转写里找一句话时，定位精度不够。
 * 这里只在「句末标点」处切分，保留原时间戳区间不精确到词。
 */
export function splitIntoSentences(segment) {
  const { text = '', startMs = null, endMs = null } = segment;
  const pieces = text.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
  if (pieces.length <= 1 || startMs === null || endMs === null) return [segment];
  const totalChars = pieces.reduce((n, p) => n + p.length, 0) || 1;
  const span = endMs - startMs;
  let cursor = startMs;
  return pieces.map((piece, i) => {
    const duration = i === pieces.length - 1 ? endMs - cursor : Math.round((span * piece.length) / totalChars);
    const part = { ...segment, text: piece, startMs: cursor, endMs: i === pieces.length - 1 ? endMs : cursor + duration };
    cursor = part.endMs;
    return part;
  });
}

/* ------------------------------------------------------------------ *
 * 文档定位：命中次数 + 片段（ticket 9z5.23）
 *
 * 文档后端的 segment 粒度就是「一整页」：命中即整页，把整页回吐等于复述全文
 * （实测一次调用 12 KB+）。这里把「命中」拆成三件事：
 *   countHits   —— 这一页命中了几次（精确短语；没有精确命中就退回 token 覆盖）
 *   buildSnippet —— 首个命中周围的片段（±DOC_SNIPPET_RADIUS 字符，对齐词边界）
 * 片段与 hits 是文档侧的替代指标：文档没有「分数」（同一字段两种语义会打架），
 * 视频 / 录音仍然用 scoreSegment 的 0..1 分数。
 * ------------------------------------------------------------------ */

/** 文档片段半径：命中前后各取多少字符 */
export const DOC_SNIPPET_RADIUS = 150;

/** 词边界对齐时最多往外扩这么多字符（中文没有空格，否则会一路扩到整页） */
const MAX_ALIGN_CHARS = 24;

/**
 * 归一化并保留「每个字符来自原文哪里」的映射（片段定位用）。
 * 语义与 normalizeForMatch 一致（小写、标点/符号→空格、折叠空白），
 * 差别只在 NFKC 按码点做、不做跨码点合成。
 */
function normalizeWithMap(text) {
  const src = String(text ?? '');
  const chars = [];
  const map = [];
  let pendingSpace = false;
  let index = 0;
  for (const cp of src) {
    const lower = cp.normalize('NFKC').toLowerCase();
    for (const ch of lower) {
      if (/\s/u.test(ch) || /[\p{P}\p{S}]/u.test(ch)) {
        if (chars.length > 0) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        chars.push(' ');
        map.push(index);
        pendingSpace = false;
      }
      chars.push(ch);
      map.push(index);
    }
    index += cp.length;
  }
  return { norm: chars.join(''), map };
}

/** 紧凑形式（去掉空白）+ 到原文的下标映射 */
function compactWithMap(normalized) {
  let text = '';
  const map = [];
  for (let i = 0; i < normalized.norm.length; i += 1) {
    if (normalized.norm[i] === ' ') continue;
    text += normalized.norm[i];
    map.push(normalized.map[i]);
  }
  return { text, map };
}

/** 非重叠出现次数 */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

/**
 * 文档用的命中计数。
 *
 * - 精确短语（归一化 + compact）出现次数 → hits，fuzzy = false；
 * - 没有精确命中时退回 token 覆盖：hits = 命中 token 的出现次数，fuzzy = true
 *   （被更长命中词包住的短 token 不重复计数，避免中文 n-gram 把次数放大）。
 *
 * 返回 { hits, fuzzy, index }：index 是首个命中在**原文**里的下标（-1 = 没找到）。
 */
export function countHits(pageText, query) {
  const qNorm = normalizeForMatch(query);
  if (!qNorm) return { hits: 0, fuzzy: false, index: -1 };

  const page = compactWithMap(normalizeWithMap(pageText));
  const qCompact = compact(qNorm);
  if (qCompact) {
    const hits = countOccurrences(page.text, qCompact);
    if (hits > 0) {
      return { hits, fuzzy: false, index: page.map[page.text.indexOf(qCompact)] ?? -1 };
    }
  }

  // 退回 token 覆盖
  const matched = [];
  for (const token of tokenize(qNorm)) {
    const t = compact(token);
    if (!t) continue;
    const count = countOccurrences(page.text, t);
    if (count > 0) matched.push({ token: t, count });
  }
  const kept = matched.filter((m) => !matched.some((other) => other !== m
    && other.token.length > m.token.length
    && other.token.includes(m.token)));
  let hits = 0;
  let index = -1;
  for (const m of kept) {
    hits += m.count;
    if (index === -1) index = page.map[page.text.indexOf(m.token)] ?? -1;
  }
  return { hits, fuzzy: true, index };
}

/**
 * 命中附近的片段：原文里首个命中 ±radius 个字符，对齐到词边界，
 * 折叠换行与排版空白（PDF 一行可能是几十个空格）。
 *
 * index 可以由调用方传入（countHits 已经算过）；不给就自己找。
 */
export function buildSnippet(pageText, query, { radius = DOC_SNIPPET_RADIUS, index = -1 } = {}) {
  const text = String(pageText ?? '');
  if (!text.trim()) return '';
  let anchor = Number.isInteger(index) ? index : -1;
  if (anchor < 0 || anchor >= text.length) anchor = countHits(text, query).index;
  if (anchor < 0 || anchor >= text.length) anchor = 0;

  let start = Math.max(0, anchor - radius);
  let end = Math.min(text.length, anchor + radius);

  // 对齐到词边界：往前找到词首，往后找到词尾（最多各扩 MAX_ALIGN_CHARS 个字符）
  if (start > 0) {
    let i = start - 1;
    let steps = 0;
    while (i >= 0 && !/\s/u.test(text[i]) && steps < MAX_ALIGN_CHARS) { i -= 1; steps += 1; }
    if (i >= 0 && /\s/u.test(text[i])) start = i + 1;
  }
  if (end < text.length) {
    let i = end;
    let steps = 0;
    while (i < text.length && !/\s/u.test(text[i]) && steps < MAX_ALIGN_CHARS) { i += 1; steps += 1; }
    if (i < text.length && /\s/u.test(text[i])) end = i;
  }

  let snippet = text.slice(start, end).replace(/\s+/gu, ' ').trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return snippet;
}
