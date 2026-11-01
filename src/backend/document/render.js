// src/backend/document/render.js —— 页面缩略图拼图 / 裁切 / 缩放（ffmpeg）
//
// 契约约束（docs/mcp-contract.md §10）：
//   - 单张图最长边 ≤ maxEdge（默认 overview 1280 / zoom 1600）
//   - 单张图像素 ≤ 2,000,000（硬上限，超了 server 的 validateProducedImages 会报错）
//   - 每个拼图 ≤ 16 格、单次调用 ≤ 64 格（由调用方的 cells × images 保证）
//
// 这里只负责「把已经栅格化的页图拼起来 / 裁一块 / 缩一下」。PDF 栅格化在 pdf.js，
// 页面尺寸语义在 index.js。

import { run } from '../../media/ffmpeg.js';
import { IMAGE_LIMITS, layoutForCells } from '../../server/images.js';

/** 契约 §10.2：单图像素硬上限 */
export const MAX_IMAGE_PIXELS = IMAGE_LIMITS.maxPixelsPerImage;

/** 契约 §10.3：overview / zoom / locate includeFrame 的默认最长边 */
export const DEFAULT_OVERVIEW_MAX_EDGE = 1280;
export const DEFAULT_ZOOM_MAX_EDGE = 1600;
export const DEFAULT_LOCATE_FRAME_MAX_EDGE = 1280;

/** 页面默认宽高比（A4 竖版；拿不到页面尺寸时用） */
export const DEFAULT_PAGE_ASPECT = 595 / 842;

/**
 * 规划一张拼图的格子尺寸与输出尺寸。
 *
 * 先让「cols × aspect : rows」的整张图压进 maxEdge 和 maxPixels 两个上限，
 * 再把整张图切成等大的格子。返回的 width/height 是拼图输出尺寸。
 *
 * @param {{ pageAspect?: number, cols: number, rows: number, maxEdge: number, maxPixels?: number }} spec
 */
export function planGrid({
  pageAspect = DEFAULT_PAGE_ASPECT,
  cols,
  rows,
  maxEdge,
  maxPixels = MAX_IMAGE_PIXELS,
}) {
  const aspect = Number.isFinite(pageAspect) && pageAspect > 0 ? pageAspect : DEFAULT_PAGE_ASPECT;
  const scale = Math.min(
    maxEdge / (cols * aspect),
    maxEdge / rows,
    Math.sqrt(maxPixels / (cols * rows * aspect)),
  );
  const cellWidth = Math.max(1, Math.floor(aspect * scale));
  const cellHeight = Math.max(1, Math.floor(scale));
  return { cellWidth, cellHeight, width: cols * cellWidth, height: rows * cellHeight };
}

/**
 * 把 contentW × contentH 的图压进 maxEdge / maxPixels。只缩小，不放大。
 *
 * @returns {{ width: number, height: number }}
 */
export function fitSize(contentWidth, contentHeight, maxEdge, maxPixels = MAX_IMAGE_PIXELS) {
  const width = Math.max(1, Math.floor(contentWidth));
  const height = Math.max(1, Math.floor(contentHeight));
  const scale = Math.min(1, maxEdge / width, maxEdge / height, Math.sqrt(maxPixels / (width * height)));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/**
 * 比例制 crop（0..1）→ 像素矩形。边界夹紧，保证 1 ≤ w ≤ width、1 ≤ h ≤ height。
 *
 * @param {number} width
 * @param {number} height
 * @param {{x:number,y:number,width:number,height:number}|null} crop
 */
export function cropRect(width, height, crop) {
  if (!crop) return { x: 0, y: 0, width, height };
  const x = clamp(Math.round(crop.x * width), 0, Math.max(0, width - 1));
  const y = clamp(Math.round(crop.y * height), 0, Math.max(0, height - 1));
  const w = clamp(Math.round(crop.width * width), 1, width - x);
  const h = clamp(Math.round(crop.height * height), 1, height - y);
  return { x, y, width: w, height: h };
}

/**
 * 用 ffmpeg 把多张页图拼成一张 PNG 拼图。
 *
 * @param {object} spec
 * @param {string[]} spec.inputs 页图路径（按阅读顺序）
 * @param {number} spec.cols
 * @param {number} spec.rows
 * @param {number} spec.cellWidth
 * @param {number} spec.cellHeight
 * @param {string} spec.outPath
 * @param {AbortSignal} [spec.signal]
 */
export async function composeGrid({
  inputs,
  cols,
  rows,
  cellWidth,
  cellHeight,
  outPath,
  signal,
}) {
  const list = Array.isArray(inputs) ? inputs : [];
  if (list.length === 0) throw new Error('composeGrid: no page images to compose.');
  if (list.length > cols * rows) throw new Error('composeGrid: more inputs than grid cells.');

  const inputArgs = [];
  for (const input of list) inputArgs.push('-i', input);

  const filters = list.map((_, index) => {
    // scale + pad：页面比例与格子不一致时留白，但格子尺寸严格一致。
    return `[${index}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,`
      + `pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=white,format=rgb24[v${index}]`;
  });

  let graph;
  let mapLabel;
  if (list.length === 1) {
    graph = filters[0];
    mapLabel = '[v0]';
  } else {
    const labels = list.map((_, index) => `[v${index}]`).join('');
    const layout = list
      .map((_, index) => `${(index % cols) * cellWidth}_${Math.floor(index / cols) * cellHeight}`)
      .join('|');
    graph = `${filters.join(';')};${labels}xstack=inputs=${list.length}:layout=${layout}:fill=white[out]`;
    mapLabel = '[out]';
  }

  await run(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      ...inputArgs,
      '-filter_complex', graph,
      '-map', mapLabel,
      '-frames:v', '1',
      outPath,
    ],
    { signal },
  );
  return outPath;
}

/**
 * 裁切 + 缩放到 PNG。
 *
 * @param {object} spec
 * @param {string} spec.input 源图（PNG / JPEG / WebP / …，ffmpeg 能解码即可）
 * @param {{x:number,y:number,width:number,height:number}} spec.rect 像素矩形
 * @param {number} spec.maxEdge
 * @param {string} spec.outPath
 * @param {AbortSignal} [spec.signal]
 * @returns {Promise<{ width: number, height: number }>} 输出尺寸
 */
export async function cropAndScale({ input, rect, maxEdge, outPath, signal }) {
  const target = fitSize(rect.width, rect.height, maxEdge);
  const filters = [`crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`];
  if (target.width !== rect.width || target.height !== rect.height) {
    filters.push(`scale=${target.width}:${target.height}:flags=lanczos`);
  }
  await run(
    'ffmpeg',
    ['-y', '-v', 'error', '-i', input, '-vf', filters.join(','), '-frames:v', '1', outPath],
    { signal },
  );
  return target;
}

/** 给一组页数算格子布局（与 server 的图片预算口径一致） */
export function gridLayoutFor(pageCount) {
  return layoutForCells(pageCount);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
