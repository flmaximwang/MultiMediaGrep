/**
 * Modifications (Apache-2.0 §4.b — this file was changed):
 *   - Removed the local Python/rapidocr bridge: `ocrPython()`, `runBridge()`,
 *     the `OCR_BRIDGE` path constant, the `~/.dsh/video.json` OCR-config
 *     reader, and the `./python.js` import.
 *     Why: this project OCRs through an external service (MinerU), so a local
 *     Python + rapidocr install is dead weight — and `python.js` was imported
 *     by this file only.
 *   - The OCR backend is now **injected** (`setOcrBackend()`) instead of being
 *     hard-wired to a local subprocess. `detectSubtitleBand()` / `readBand()`
 *     keep the same return contract; with no backend registered they report
 *     `kind:'no-backend'` and callers degrade (skip) rather than fail.
 *   - `OCR_MAX_ITEMS`, `similarity()` and `shouldReplace()` are upstream
 *     verbatim — the replacement-decision logic is unchanged.
 *
 * ocr.js — 用画面上的硬字幕校正语音转写。
 *
 * 为什么需要：ASR 会听错专有名词（实测「像差」→「相差」、「也要忘记吗」→「他也忘记」），
 * 而画面里烧进去的字幕是**确定的文本**。两者对不上时，画面更可信。
 *
 * 为什么不是"让模型自己看图"：模型看到的格子是 331×184，实测同一句字幕在那一档会掉字
 * （"也要忘记吗" → "也要记"），而且它只看得到 9–20 帧，覆盖不了全片。OCR 是在原分辨率上做的。
 *
 * OCR 引擎由宿主注入（见 setOcrBackend）：上游原本走 Python + rapidocr 子进程，
 * 本副本改成"外部 OCR 服务"，所以这里不再捆绑任何 Python 依赖。
 */

/** 单次最多校正多少条 —— 每条要解一次 ffmpeg、跑一次 OCR，太多就不划算了 */
export const OCR_MAX_ITEMS = 16;

// ---------------------------------------------------------------------------
// OCR 后端注入
//
// 后端契约（宿主实现）：
//   detectBand({ frames }) -> { ok:true, band:number[], detected?:boolean, boxes?:object[] }
//                             | { ok:false, kind:string, message:string }
//   readBand({ images })  -> { ok:true, items:object[] }
//                             | { ok:false, kind:string, message:string }
// ---------------------------------------------------------------------------

/**
 * 已注册的 OCR 后端；没有就是 null（此时 OCR 相关路径一律跳过）。
 * @type {null | {detectBand: Function, readBand: Function}}
 */
let backend = null;

/**
 * 注入 OCR 后端。宿主项目（这里是本项目的 MinerU 适配层）调用一次，
 * vendor 里的 `ocr-subs.js` / `subtitle-strip.js` 就改用那个后端。
 * @param {null | {detectBand: Function, readBand: Function}} next
 * @returns {() => void} 注销函数
 */
export function setOcrBackend(next) {
  const prev = backend;
  backend = next ?? null;
  return () => { if (backend === next) backend = prev; };
}

/** 当前 OCR 后端（没注册就是 null）。 */
export function getOcrBackend() {
  return backend;
}

/**
 * 用 2–3 帧全图检测，找出字幕带（y 的归一化区间）。检测是最贵的一步，只跑这一次。
 * @returns {Promise<{ok:true, band:number[], detected:boolean, boxes:object[]} |
 *                   {ok:false, kind:string, message:string}>}
 */
export async function detectSubtitleBand({ frames } = {}) {
  if (!backend) return { ok: false, kind: 'no-backend', message: 'no OCR backend registered' };
  if (!frames?.length) return { ok: false, kind: 'no-frames', message: 'no probe frames' };
  let res;
  try {
    res = await backend.detectBand({ frames: frames.slice(0, 3) });
  } catch (e) {
    return { ok: false, kind: 'backend-crashed', message: String(e?.message ?? e).slice(0, 300) };
  }
  if (!res?.ok) {
    return {
      ok: false,
      kind: res?.kind ?? 'detect-failed',
      message: String(res?.message ?? 'OCR backend detect failed').slice(0, 300),
    };
  }
  if (!res.band) {
    return { ok: false, kind: 'no-band', message: 'detect returned no band' };
  }
  return {
    ok: true,
    band: res.band,
    detected: Boolean(res.detected),
    boxes: res.boxes ?? [],
  };
}

/**
 * 已知字幕带后只做识别（比全图检测快约 12 倍）
 * @returns {Promise<{ok:true, items:object[]} | {ok:false, kind:string, message:string}>}
 */
export async function readBand({ images } = {}) {
  if (!backend) return { ok: false, kind: 'no-backend', message: 'no OCR backend registered' };
  if (!images?.length) return { ok: false, kind: 'no-images', message: 'no band images' };
  let res;
  try {
    res = await backend.readBand({ images });
  } catch (e) {
    return { ok: false, kind: 'backend-crashed', message: String(e?.message ?? e).slice(0, 300) };
  }
  if (!res?.ok) {
    return {
      ok: false,
      kind: res?.kind ?? 'read-failed',
      message: String(res?.message ?? 'OCR backend read failed').slice(0, 300),
    };
  }
  const items = res.items;
  if (!items) return { ok: false, kind: 'no-items', message: 'read returned no items' };
  return { ok: true, items };
}


/**
 * 文本相似度：用「公共子序列长度 / 较长者长度」做粗判。
 * 不用编辑距离的绝对值 —— 两句 20 字的台词差 2 个字和两句 8 字的台词差 2 个字，含义完全不同。
 */
export function similarity(a, b) {
  const s1 = String(a ?? '').replace(/[\s，。、！？；：""''（）()]/g, '');
  const s2 = String(b ?? '').replace(/[\s，。、！？；""''（）()]/g, '');
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  const m = s1.length;
  const n = s2.length;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j += 1) {
      cur[j] = s1[i - 1] === s2[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n] / Math.max(m, n);
}

/**
 * 决定"要不要用 OCR 文本替换 ASR 文本"。
 *
 * 规则刻意保守：只有**三条同时成立**才替换，否则保留 ASR 并记一笔"存疑"。
 *   1. OCR 置信度 ≥ 0.65（低置信的 OCR 比 ASR 还不可信；代码是 0.65，注释以前写成 0.75）
 *   2. 两边长度差不超过 30%（差太多说明截到别的字幕了）
 *   3. 相似度在 0.2–0.9 之间
 *      —— <0.2：完全是两句话，可能帧没对上；>0.9：本来就一致，没必要动
 */
export function shouldReplace({ asr, ocr, conf }) {
  const clean = (x) => String(x ?? '').replace(/[\s，。、！？；：""''（）()…—]/g, '');
  const A = clean(asr);
  const B = clean(ocr);
  if (B.length < 2) return { replace: false, reason: 'empty-ocr' };
  if (!(conf >= 0.65)) return { replace: false, reason: 'low-conf' };
  if (A.length === 0) return { replace: true, reason: 'asr-empty', text: String(ocr).trim() };

  // 一条字幕带里常常同时留着上下两句（上一句还没消失），所以先把 OCR 切成分句，
  // 再挑"和这句 ASR 最吻合的那一块"——拿整条去比长度，永远会被判成"长度差太多"。
  const pieces = String(ocr).split(/[，。、！？；,;!?\n]/).map((x) => clean(x)).filter((x) => x.length >= 2);
  const candidates = pieces.length > 0 ? pieces : [B];

  // ASR 按停顿切段，常常包含好几个分句（60–100 字）；硬字幕一次只显示一句（10–20 字）。
  // 拿整段 ASR 去和一行 OCR 比，cover 天生被 ASR 长度稀释，长度判据也会误伤。
  // 所以在**分句级别**找最吻合的一对，再只替换命中的那一句。
  const clauses = splitClauses(asr);
  const units = clauses.length > 0
    ? clauses
    : [{ start: 0, end: String(asr ?? '').length, text: String(asr ?? '') }];
  let best = null;
  for (const clause of units) {
    const clauseClean = clean(clause.text);
    if (clauseClean.length === 0) continue;
    for (const piece of candidates) {
      const cover = lcsLength(clauseClean, piece) / clauseClean.length;
      const gap = Math.abs(clauseClean.length - piece.length) / Math.max(clauseClean.length, piece.length);
      if (!best || cover > best.cover + 1e-9
        || (Math.abs(cover - best.cover) <= 1e-9 && gap < best.gap - 1e-9)) {
        best = { cover, gap, clause, clauseClean, piece };
      }
    }
  }
  if (!best) return { replace: false, reason: 'unrelated', cover: 0 };
  const { cover } = best;

  // 顺序很重要：先问“是不是同一句”，再问“长度像不像”。
  // 否则 cover=0.08 的完全无关文本会先被报成 length-gap，把“帧没对上”误读成“只差长度”。
  // ASR 是 OCR 的子序列且 OCR 不更长（通常只差标点）才是真一致；
  // 如果 OCR 更长，可能是 ASR 漏了字（例如“错字”→“错别字”），不能直接判 agree。
  if (cover > 0.98 && best.piece.length <= best.clauseClean.length) {
    return { replace: false, reason: 'agree' };
  }
  // 多分句时只替换其中一句，命中门槛要比单句更保守，降低“抽错帧还改了一句”的风险。
  const minCover = units.length > 1 ? 0.7 : 0.6;
  if (cover < minCover) return { replace: false, reason: 'unrelated', cover: +cover.toFixed(2) };
  if (best.gap > 0.5) return { replace: false, reason: 'length-gap', cover: +cover.toFixed(2) };

  // 多出来的字如果明显多于这一分句，说明带子把相邻那句也截进来了 —— 按匹配区间剪掉两头
  const match = lcsMatch(best.clauseClean, best.piece);
  // 剪到匹配区间，两侧各放宽 1 个字：ASR 常常漏掉句尾的语气词（吗/了/啊），
  // 但再宽就会把相邻那句的头一个字带进来。
  const replacement = best.piece.length - best.clauseClean.length > 2
    ? best.piece.slice(Math.max(0, match.lo - 1), Math.min(best.piece.length, match.hi + 2))
    : best.piece;

  // 单句保持旧行为（text 只给 OCR 文本）；多句只替换命中的那一句，其余 ASR 原样保留。
  if (units.length <= 1) {
    return { replace: true, reason: 'ocr-covers-asr', cover: +cover.toFixed(2), text: replacement };
  }
  const original = String(asr ?? '');
  const text = original.slice(0, best.clause.start) + replacement + original.slice(best.clause.end);
  if (text === original) return { replace: false, reason: 'agree' };
  return { replace: true, reason: 'ocr-covers-asr', cover: +cover.toFixed(2), text };
}

/** 按标点切分 ASR 分句，保留它在原文里的位置（替换时不能动其他句子）。 */
function splitClauses(text) {
  const source = String(text ?? '');
  const out = [];
  const re = /[^，。、！？；：,;!?\n]+/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const raw = m[0];
    if (raw.trim()) out.push({ text: raw, start: m.index, end: m.index + raw.length });
  }
  return out;
}

/** 最长公共子序列长度（按字符） */
function lcsLength(a, b) {
  return lcsMatch(a, b).length;
}

/**
 * 最长公共子序列 + 它在 b 里覆盖的区间。
 * 区间用来把"顺带截进来的上一句/下一句"剪掉：字幕带上常常同时有两条字幕。
 */
function lcsMatch(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  let i = m; let j = n; let lo = Infinity; let hi = -1;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lo = Math.min(lo, j - 1);
      hi = Math.max(hi, j - 1);
      i -= 1; j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i -= 1;
    else j -= 1;
  }
  return { length: dp[m][n], lo: hi >= 0 ? lo : 0, hi: hi >= 0 ? hi : n - 1 };
}
