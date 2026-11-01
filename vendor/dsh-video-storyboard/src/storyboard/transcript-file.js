/**
 * Modifications (Apache-2.0 §4.b — this file was changed):
 *   - Moved IN from upstream `src/storyboard/asr.js` (v0.5.9): `shortStamp`,
 *     `CELL_BREAK_GAP`, `alignCells`, `speechCurve`, `filterSuspectSegments`,
 *     `applyTermMap`, `extractSubtitleTrack`.
 *     Why: upstream's `asr.js` was dropped from this vendored copy (this
 *     project drives its own ASR provider — see VENDOR.md), but those helpers
 *     are ASR-independent and `pipeline.js` still needs them. The moved code
 *     is verbatim upstream except that it now uses this file's own (more
 *     tolerant) `parseSrt` instead of `asr.js`'s, and takes `DEFAULT_FFMPEG`
 *     from `./probe.js`.
 *   - Everything else is upstream verbatim.
 *
 * transcript-file.js — 读取一份**已有的**转写，跳过 ASR。
 *
 * 为什么需要它：B 站视频大多带 CC / AI 字幕，`yt-dlp --write-subs` 或字幕接口能直接
 * 拿到带时间码的文本。为了这份已经存在的东西去跑一遍 ASR，是纯粹浪费——一条 10 分钟
 * 的口播要 60–120 秒，还多一次模型调用。
 *
 * 顺带解决另一类问题：很多宿主的 ASR 走 chat/completions 方言，接不上
 * `/audio/transcriptions`。有字幕文件时，这条路根本不需要通。
 *
 * 支持三种形态，自动识别：
 *   1. SRT               `00:00:01,000 --> 00:00:03,500`
 *   2. 通用 JSON 数组     `[{start,end,text}]` 或 `[{from,to,text}]`
 *   3. B 站字幕 JSON      `{"body":[{"from":0.0,"to":2.5,"content":"..."}]}`
 *
 * 统一输出 `[{from, to, text}]` —— 和 asr.js 的 segments 同构，下游 alignCells 不用改。
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG } from './probe.js';

const run = promisify(execFile);

/** `00:01:02,500` / `00:01:02.500` / `1:02,5` → 秒 */
export function parseTimecode(raw) {
  const s = String(raw).trim().replace(',', '.');
  const parts = s.split(':');
  if (parts.length === 3) {
    const [h, m, sec] = parts;
    return Number(h) * 3600 + Number(m) * 60 + Number(sec);
  }
  if (parts.length === 2) {
    const [m, sec] = parts;
    return Number(m) * 60 + Number(sec);
  }
  const n = Number(parts[0]);
  return Number.isFinite(n) ? n : NaN;
}

/** 去掉字幕里常见的标记：`<i>` `<font color=...>` `{\an8}` 和 `&nbsp;` */
export function stripMarkup(text) {
  return String(text)
    .replace(/<[^>]{1,80}>/g, '')
    .replace(/\{\\[^}]{1,40}\}/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 解析 SRT。容忍：BOM、CRLF、缺序号、时间码用 `.` 而不是 `,`、正文多行。
 * @returns {{from:number,to:number,text:string}[]}
 */
export function parseSrt(source) {
  const text = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const segments = [];
  // 以空行分块，比逐行状态机更耐受"最后一块没有尾随空行"的畸形文件
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    const arrowAt = lines.findIndex((line) => line.includes('-->'));
    if (arrowAt === -1) continue;
    const [left, right] = lines[arrowAt].split('-->');
    const from = parseTimecode(left);
    // 右侧可能带坐标后缀：`00:00:03,500 X1:100 X2:200 Y1:...`
    const to = parseTimecode(String(right).trim().split(/\s+/)[0]);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const body = stripMarkup(lines.slice(arrowAt + 1).join(' '));
    if (!body) continue;
    segments.push({ from, to: Math.max(to, from), text: body });
  }
  return segments;
}

const pick = (obj, keys) => {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
};

/**
 * 解析 JSON 形态。不假设固定 schema —— 三种常见布局都认：
 *   数组 + {start,end,text} / {from,to,text} / {from,to,content}
 *   {body:[...]}（B 站）   {segments:[...]}（OpenAI verbose_json / whisper）
 */
export function parseJsonTranscript(payload) {
  let list = null;
  if (Array.isArray(payload)) {
    list = payload;
  } else if (payload && typeof payload === 'object') {
    for (const key of ['body', 'segments', 'subtitles', 'items', 'data']) {
      if (Array.isArray(payload[key])) { list = payload[key]; break; }
    }
  }
  if (!list) throw new Error('unrecognised transcript JSON: expected an array, or an object with body/segments/subtitles/items/data');

  const segments = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const start = Number(pick(item, ['start', 'from', 'startTime', 'start_time', 'st']));
    const end = Number(pick(item, ['end', 'to', 'endTime', 'end_time', 'et']));
    const raw = pick(item, ['text', 'content', 'line', 'transcript', 'caption']);
    if (!Number.isFinite(start) || !Number.isFinite(end) || raw === undefined) continue;
    const body = stripMarkup(raw);
    if (!body) continue;
    segments.push({ from: start, to: Math.max(end, start), text: body });
  }
  return segments;
}

/** 猜格式：先看内容，再看扩展名。JSON 解析失败就退回 SRT，让错误信息更具体。 */
export function parseTranscript(source, filename = '') {
  const text = String(source).replace(/^\uFEFF/, '');
  const head = text.trimStart().slice(0, 1);
  const looksJson = head === '[' || head === '{';
  const ext = String(filename).toLowerCase().split('.').pop();

  if (looksJson || ext === 'json') {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`transcript JSON is not valid JSON: ${error.message}`);
    }
    return { segments: parseJsonTranscript(payload), format: 'json' };
  }
  const segments = parseSrt(text);
  if (segments.length === 0) {
    throw new Error('could not find any timed text: no "--> " blocks (SRT) and no JSON array');
  }
  return { segments, format: 'srt' };
}

/**
 * 读文件并解析。时间轴统一成**相对整段视频**的秒数；窗口偏移由 pipeline 负责减。
 * @param {string} path
 * @returns {Promise<{segments:{from:number,to:number,text:string}[], format:string}>}
 */
export async function loadTranscriptFile(path) {
  const text = await readFile(path, 'utf8');
  const { segments, format } = parseTranscript(text, path);
  // 按起点排序：手工编辑过的 SRT 时常出现顺序错乱，alignCells 假设递增
  segments.sort((a, b) => a.from - b.from || a.to - b.to);
  return { segments, format };
}

// ---------------------------------------------------------------------------
// 以下函数从上游 `asr.js` 原样搬来（见文件头的 Modifications 说明）。
// 它们与"调哪个 ASR"无关，只与"手里有一段带时间码的文本"有关，所以放在本模块。
// ---------------------------------------------------------------------------

/** 从容器里抽字幕轨（有就直接用，比 ASR 准且免费） */
export async function extractSubtitleTrack({ input, ffmpegPath = DEFAULT_FFMPEG, timeoutMs = 60_000 } = {}) {
  try {
    const { stdout } = await run(ffmpegPath, [
      '-hide_banner', '-v', 'error', '-nostdin', '-i', input,
      '-map', '0:s:0', '-f', 'srt', '-',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs });
    const segments = parseSrt(stdout);
    return segments.length > 0 ? segments : null;
  } catch {
    return null;                                  // 没有字幕轨就是常态，不算错误
  }
}

/**
 * 把台词按时间重叠贴到每一格上。
 * 一句跨两格时两边都保留（宁可重复，也别让某一格"没话说"）。
 */
/** `10:09.4` —— 内联时间戳用，比 `00:10:09.40` 省一半字符 */
export function shortStamp(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** 相邻两句之间出现这么长的静默，就认为格内存在一个"断点"，值得标出来 */
export const CELL_BREAK_GAP = 1.0;

/**
 * 把台词贴到格子上。
 *
 * **不再是简单 join。** 一格常常跨两三句，而 `join(' ')` 抹掉了每句自己的起点 ——
 * 模型只能拿 `cell.from` 当整段的锚点，结果整段被提前几十秒（实测被错位 30s）。
 *
 * 折中做法：只在**真有断点**的地方插内联时间戳（相邻句间隔 ≥ CELL_BREAK_GAP），
 * 而不是每句都插 —— 每句都插会让 120 字的台词预算被 `[10:09.4]` 吃掉四分之一。
 * 同时把 `lines`（每条带自己的 from/to）留给渲染层，将来要"一格多行"不必再改这里。
 */
export function alignCells(cells, segments) {
  return cells.map((cell) => {
    const hits = segments.filter((s) => s.to > cell.from && s.from < cell.to);
    const parts = [];
    for (let i = 0; i < hits.length; i++) {
      if (i > 0 && hits[i].from - hits[i - 1].to >= CELL_BREAK_GAP) {
        parts.push(`[${shortStamp(hits[i].from)}]`);
      }
      parts.push(hits[i].text);
    }
    const text = parts.join(' ').trim();
    const dur = Math.max(0.1, cell.to - cell.from);
    return {
      text,
      chars: text.length,
      charsPerSec: +(text.length / dur).toFixed(2),
      segments: hits.length,
      // 每句自己的时间轴：信息本来就有，之前被 join 丢掉了
      lines: hits.map((s) => ({
        from: +Number(s.from).toFixed(2),
        to: +Number(s.to).toFixed(2),
        text: s.text,
      })),
      // 格内存在断点时为 true —— 渲染层可以据此提示"这一格跨了两件事"
      broken: hits.length > 1 && hits.some((s, i) => i > 0 && s.from - hits[i - 1].to >= CELL_BREAK_GAP),
    };
  });
}

/**
 * 过滤"疑似音乐段幻觉"。
 *
 * 背景（实测）：概念 PV 只有一句真台词，但 ASR 在纯音乐段吐出一条
 * `45.35–74.33`（29 秒、9 个字）的假句子。`alignCells` 按时间重叠贴，
 * 这一条会命中 5 个格子，把同一句垃圾复制五遍——比直接丢掉更糟。
 *
 * 两条判据：
 *  - **长时段 + 极低字/秒**：正常口播 2–6 字/秒（实测三条素材：5.60 / 2.07 / 0.32），
 *    超过 8 秒却不到 0.8 字/秒，几乎必然是音乐/噪声被"翻译"成了字；
 *  - **没有实义字符**：只剩标点或空白的段直接丢。
 *
 * 丢掉的段不贴到格子，但会在清单里报出来——过滤不能变成静默丢数据。
 */
export function filterSuspectSegments(segments, { minDur = 8, minCharsPerSec = 0.8 } = {}) {
  const kept = [];
  const dropped = [];
  for (const seg of segments ?? []) {
    const dur = Math.max(0.1, seg.to - seg.from);
    const text = String(seg.text ?? '').trim();
    const meaningful = text.replace(/[\s\p{P}\p{S}]/gu, '').length;
    if (meaningful === 0) {
      dropped.push({ ...seg, reason: 'punctuation-only', charsPerSec: 0 });
      continue;
    }
    const cps = meaningful / dur;
    if (dur > minDur && cps < minCharsPerSec) {
      dropped.push({ ...seg, reason: 'music-like', charsPerSec: +cps.toFixed(2) });
      continue;
    }
    kept.push(seg);
  }
  return { kept, dropped };
}

/**
 * 术语校正表。
 *
 * 实测 ASR 对专业名词必错（`彗差→绘插`、`八羽怪→巴与怪`、`沧野→苍野`、`收光圈→烧光圈`）。
 * 与其让模型自己猜，不如给一份用户词典做**确定性替换**，并把替换次数报出来（不静默改写原文）。
 *
 * 长词优先匹配，避免 `像散` 被 `像` 抢先替换掉。
 *
 * @param {Array<{text:string}>} segments
 * @param {Record<string,string>} terms 错误写法 → 正确写法
 * @returns {{segments:Array, replaced:number, touched:number}}
 */
export function applyTermMap(segments, terms) {
  const entries = Object.entries(terms ?? {})
    .filter(([from, to]) => typeof from === 'string' && from && typeof to === 'string');
  if (entries.length === 0) return { segments: segments ?? [], replaced: 0, touched: 0 };

  // 一次扫描、单遍替换：用"长词优先"的交替式正则，避免替换出来的新文本被后面的短词二次命中
  // （踩过：像散→像散(AST) 之后，"像"又把新文本里的"像"替换掉）
  const map = new Map(entries);
  const pattern = entries
    .map(([from]) => from)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(pattern, 'g');

  let replaced = 0;
  let touched = 0;
  const out = (segments ?? []).map((seg) => {
    const text = String(seg.text ?? '');
    let hit = false;
    const next = text.replace(re, (m) => {
      replaced += 1;
      hit = true;
      return map.get(m) ?? m;
    });
    if (!hit) return seg;
    touched += 1;
    return { ...seg, text: next };
  });
  return { segments: out, replaced, touched };
}

/** 语音密度曲线：每秒字数，按 bin 采样（供 planCellRanges 当第三条密度信号） */
export function speechCurve(segments, { duration, bin = 0.1 }) {
  const bins = Math.max(1, Math.ceil(duration / bin));
  const out = new Float64Array(bins);
  if (!segments?.length) return { bins, curve: out, mean: 0 };
  for (const s of segments) {
    const a = Math.max(0, Math.floor(s.from / bin));
    const b = Math.min(bins, Math.ceil(s.to / bin));
    const len = Math.max(1, b - a);
    const per = s.text.length / len;
    for (let i = a; i < b; i++) out[i] += per;
  }
  const mean = out.reduce((x, y) => x + y, 0) / bins;
  return { bins, curve: out, mean };
}
