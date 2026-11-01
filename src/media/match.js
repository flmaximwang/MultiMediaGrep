// src/media/match.js —— 「这段文字在哪」：转写段落的关键词/短语匹配
// 视频与录音后端的 media_locate 共用。纯函数，无 IO。
// 思路沿用上游 locate.js 的「归一化 + 打分」，但实现独立（上游只做 SRT 段落、且与 DSH 耦合）。

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
