// src/backend/video/storyboard.js —— overview 的镜头格与拼图
//
// 为什么不直接用 vendor 的 runStoryboard：
//   pipeline.js 无论如何都会 remember()/saveCells()，也就是往 ~/.cache/dsh-video-storyboard
//   写文件。本项目的约束是「临时文件只能进 MMGREP_CACHE_DIR」，所以这里只调用
//   vendor 里无副作用的纯 IO 层：scanShots / extractFrameRaw / composeSheet / encodePngBuffer。
//
// 格的时间范围严格覆盖 [startSec, endSec]：第一格从窗口起点开始，最后一格在窗口终点结束。
// 镜头切点只用来对齐边界；切点太多就合并，切点太少就在长段内均分。

import { ToolError } from '../../media/interface.js';
import {
  composeSheet,
  encodePngBuffer,
  extractFrameRaw,
  layoutCanvas,
} from '../../../vendor/dsh-video-storyboard/src/storyboard/sheet.js';
import { mapPool } from '../../../vendor/dsh-video-storyboard/src/storyboard/frames.js';
import { scanShots } from '../../../vendor/dsh-video-storyboard/src/storyboard/scan.js';

/** 与 server/images.js 的 layoutForCells 保持一致（1–16 格的宫格） */
export function layoutForCells(cells) {
  if (cells <= 1) return { cols: 1, rows: 1 };
  if (cells <= 2) return { cols: 2, rows: 1 };
  if (cells <= 4) return { cols: 2, rows: 2 };
  if (cells <= 6) return { cols: 3, rows: 2 };
  if (cells <= 9) return { cols: 3, rows: 3 };
  if (cells <= 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: 4 };
}

/** 扫描窗口内的硬切/渐变转场。失败只降级为「均分」，不让整次 overview 失败。 */
export async function detectCuts({ inputPath, fps, startSec, endSec, signal, warnings = [] }) {
  try {
    const scan = await scanShots({
      input: inputPath,
      fps,
      start: startSec,
      end: endSec,
      signal,
    });
    if (scan.degraded) warnings.push(`storyboard-scan-degraded: ${scan.degraded}`);
    return (scan.cuts ?? []).map((cut) => cut.t).filter((t) => Number.isFinite(t));
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
    warnings.push(`storyboard-scan-failed: ${error?.message ?? error}; cells are evenly spaced`);
    return [];
  }
}

function sanitizeCuts(cuts, startSec, endSec) {
  const points = [];
  for (const raw of cuts ?? []) {
    const t = Number(raw);
    if (!Number.isFinite(t)) continue;
    if (t <= startSec + 0.01 || t >= endSec - 0.01) continue;
    if (points.length > 0 && Math.abs(t - points[points.length - 1]) < 0.01) continue;
    points.push(t);
  }
  points.sort((a, b) => a - b);
  return points;
}

/**
 * 规划本次调用的格时间范围。
 *
 * 显式要了 cells×images 个格，就尽量给满（契约 §10.3：不能「问了 16 格只出 9 格」，
 * 否则 agent 会以为自己看过了 16 个瞬间）。唯一例外是窗口太短：
 * 每格至少 minCellSec，否则 1 秒窗口塞 18 格只会得到一堆同一帧。
 * 镜头切点只用来对齐边界，不改变目标格数。
 */
export function planCellRanges({
  cuts = [],
  startSec,
  endSec,
  capacity,
  minCellSec = 0.3,
}) {
  const span = endSec - startSec;
  if (!(span > 0)) return [];
  const cap = Math.max(1, Math.floor(capacity));
  const points = sanitizeCuts(cuts, startSec, endSec);
  let desired = Math.min(cap, Math.max(1, Math.floor(span / minCellSec)));
  if (desired <= 1) return [{ fromSec: startSec, toSec: endSec }];

  const boundaries = [startSec];
  for (let i = 1; i < desired; i += 1) {
    const prev = boundaries[boundaries.length - 1];
    const remaining = desired - i;
    const ideal = startSec + (span * i) / desired;
    const lower = prev + minCellSec;
    const upper = endSec - remaining * minCellSec;
    let chosen = ideal;

    if (upper >= lower) {
      const maxSnap = Math.max(0.05, (span / desired) * 0.5);
      let best = null;
      let bestDistance = Infinity;
      for (const cut of points) {
        if (cut < lower || cut > upper) continue;
        const distance = Math.abs(cut - ideal);
        if (distance < bestDistance) {
          best = cut;
          bestDistance = distance;
        }
      }
      chosen = best !== null && bestDistance <= maxSnap ? best : Math.min(upper, Math.max(lower, ideal));
    }

    if (!(chosen > prev)) {
      chosen = prev + (endSec - prev) / (remaining + 1);
    }
    if (chosen >= endSec) chosen = endSec - remaining * minCellSec;
    if (!(chosen > prev)) chosen = prev + 1e-3;
    boundaries.push(chosen);
  }
  boundaries.push(endSec);

  const ranges = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const fromSec = boundaries[i];
    const toSec = boundaries[i + 1];
    if (toSec > fromSec) ranges.push({ fromSec, toSec });
  }
  return ranges;
}

/** 把格分给至多 maxImages 张图；每张不超过 maxPerImage 格 */
export function groupRanges(ranges, maxPerImage, maxImages) {
  if (ranges.length === 0) return [];
  const per = Math.max(1, Math.floor(maxPerImage));
  const limit = Math.max(1, Math.floor(maxImages));
  const groupsCount = Math.min(limit, Math.ceil(ranges.length / per));
  const base = Math.floor(ranges.length / groupsCount);
  const extra = ranges.length % groupsCount;
  const groups = [];
  let cursor = 0;
  for (let i = 0; i < groupsCount; i += 1) {
    const size = base + (i < extra ? 1 : 0);
    groups.push(ranges.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

/**
 * 选一个使整图长边 ≤ maxEdge 的面板预算。
 *
 * composeSheet/layoutCanvas 只认面积 budget，长边由面积和整体宽高比推出来。
 * 先按目标宽度反推 budget，再在边界误差上做最多 8 次收紧。
 */
export function fitLayout(cols, rows, cellAspect, maxEdge) {
  const sheetAspect = (cols * cellAspect) / rows;
  const targetWidth = Math.max(1, Math.floor(
    sheetAspect >= 1 ? maxEdge : maxEdge * sheetAspect,
  ));
  let budget = Math.max(1024, Math.floor((targetWidth * targetWidth) / sheetAspect));
  let layout = layoutCanvas(cols, rows, cellAspect, budget);
  // 抬头带和格间隙会吃掉几十像素；在长边还没到 maxEdge 时把面积补回去。
  for (let i = 0; i < 6 && layout.width < maxEdge && layout.height < maxEdge; i += 1) {
    const longest = Math.max(layout.width, layout.height);
    if (!(longest > 0)) break;
    const grow = Math.min(maxEdge / longest, 2);
    if (grow <= 1.001) break;
    budget = Math.floor(budget * grow * grow * 0.995);
    layout = layoutCanvas(cols, rows, cellAspect, budget);
  }
  for (let i = 0; i < 10 && (layout.width > maxEdge || layout.height > maxEdge); i += 1) {
    const scale = Math.min(maxEdge / layout.width, maxEdge / layout.height);
    budget = Math.max(256, Math.floor(budget * scale * scale * 0.97));
    layout = layoutCanvas(cols, rows, cellAspect, budget);
  }
  return { budget, ...layout };
}

function normalizeAspect(aspect) {
  const value = Number(aspect);
  if (!Number.isFinite(value) || value <= 0) return 16 / 9;
  return Math.min(5, Math.max(0.2, value));
}

function textForRange(segments, fromMs, toMs) {
  const parts = [];
  const seen = new Set();
  for (const segment of segments) {
    const startMs = Number.isFinite(segment.startMs) ? segment.startMs : 0;
    const endMs = Number.isFinite(segment.endMs) ? segment.endMs : startMs;
    if (endMs <= fromMs || startMs >= toMs) continue;
    const text = String(segment.text ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts.join(' ');
}

async function grabFrame({ inputPath, range, cellW, cellH }) {
  const duration = Math.max(0, range.toSec - range.fromSec);
  const candidates = [range.fromSec + duration / 2];
  if (duration > 0.2) {
    candidates.push(range.fromSec + Math.min(0.1, duration / 2));
    candidates.push(range.toSec - Math.min(0.1, duration / 2));
  }
  const seen = new Set();
  let lastError = null;
  for (const candidate of candidates) {
    const at = Math.max(0, candidate);
    const key = at.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      return await extractFrameRaw({ input: inputPath, at, dur: 0, cellW, cellH });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('no readable frame in this cell');
}

/**
 * 出图 + 与格对齐的段落。
 *
 * @param {object} opts
 * @param {string} opts.inputPath
 * @param {number} opts.startSec
 * @param {number} opts.endSec
 * @param {number[]} opts.cuts 窗口内的绝对切点（秒）
 * @param {number} opts.capacity 每张图最多格数（cells）
 * @param {number} opts.maxImages 最多张数（images）
 * @param {number} opts.maxEdge
 * @param {number|null} opts.aspect 显示宽高比
 * @param {Array} opts.transcriptSegments 带绝对 ms 的段落
 * @param {string} opts.transcriptSource
 * @param {string} opts.transcriptOrigin
 * @param {number} [opts.concurrency]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.onProgress]
 * @param {string[]} [opts.warnings]
 * @returns {Promise<{images:Array, segments:Array}>}
 */
export async function composeOverviewImages({
  inputPath,
  startSec,
  endSec,
  cuts,
  capacity,
  maxImages,
  maxEdge,
  aspect,
  transcriptSegments,
  transcriptSource,
  transcriptOrigin,
  concurrency = 2,
  signal,
  onProgress,
  warnings = [],
}) {
  const ranges = planCellRanges({ cuts, startSec, endSec, capacity: capacity * maxImages });
  if (ranges.length === 0) return { images: [], segments: [] };
  const groups = groupRanges(ranges, capacity, maxImages);
  const cellAspect = normalizeAspect(aspect);
  const poolSize = Math.max(1, Math.min(4, Number(concurrency) || 2));
  const images = [];
  const segments = [];
  let nextCellIndex = 1;

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const { cols, rows } = layoutForCells(group.length);
    const { budget, width, height, cellW, cellH } = fitLayout(cols, rows, cellAspect, maxEdge);
    if (width > maxEdge || height > maxEdge) {
      throw new ToolError(
        'INTERNAL',
        `storyboard sheet would be ${width}x${height}, above the ${maxEdge}px limit.`,
      );
    }
    if (signal?.aborted) throw new Error('aborted');

    const firstCellIndex = nextCellIndex;
    const frames = await mapPool(group, poolSize, async (range, i) => {
      const cellNumber = firstCellIndex + i;
      try {
        const frame = await grabFrame({ inputPath, range, cellW, cellH });
        return { buffer: frame.buffer, index: cellNumber };
      } catch (error) {
        if (signal?.aborted) throw error;
        warnings.push(`cell ${cellNumber} frame extraction failed: ${error?.message ?? error}`);
        return null;
      }
    });

    const sheet = composeSheet({
      frames,
      cols,
      rows,
      cellAspect,
      budget,
      burn: 'index',
    });
    if (sheet.width > maxEdge || sheet.height > maxEdge) {
      throw new ToolError(
        'INTERNAL',
        `storyboard sheet came out ${sheet.width}x${sheet.height}, above the ${maxEdge}px limit.`,
      );
    }
    const png = await encodePngBuffer(sheet.buffer, sheet.width, sheet.height);
    images.push({
      index: images.length + 1,
      buffer: png,
      width: sheet.width,
      height: sheet.height,
      cells: group.length,
      mimeType: 'image/png',
    });

    for (const range of group) {
      const startMs = Math.round(range.fromSec * 1000);
      const endMs = Math.round(range.toSec * 1000);
      segments.push({
        index: nextCellIndex,
        startMs,
        endMs,
        text: textForRange(transcriptSegments, startMs, endMs),
        source: transcriptSource,
        origin: transcriptOrigin,
        page: null,
      });
      nextCellIndex += 1;
    }

    onProgress?.({
      stage: 'images',
      detail: `image ${groupIndex + 1}/${groups.length}`,
      progress: Math.round(((groupIndex + 1) / groups.length) * 100),
    });
  }

  return { images, segments };
}
