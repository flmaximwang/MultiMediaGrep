// src/backend/video/capture.js —— zoom / locate(includeFrame) 的单帧抓取
//
// 为什么不用 media/ffmpeg.js 的 run() 直接吃 stdout：run() 把 stdout 当字符串收集，
// 二进制 PNG 会在 toString() 里损坏。这里让 ffmpeg 把 PNG 写进 MMGREP_CACHE_DIR 下的
// 临时文件，再 readFile 回来。
//
// crop 在**缩放之后**应用（契约 §6.2）：先把整帧缩放到长边 = maxEdge，再按比例裁。
// 这样 crop 的像素尺寸只取决于输出尺寸，不受源分辨率影响。

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { run } from '../../media/ffmpeg.js';
import { ToolError } from '../../media/interface.js';
import { extractSharpest } from './frames.js';
import { makeWorkDir, uniqueSuffix } from './work.js';

const MIN_EDGE = 256;
const MAX_EDGE = 1600;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampEdge(maxEdge) {
  const value = Number(maxEdge);
  if (!Number.isFinite(value)) return MAX_EDGE;
  return Math.floor(clamp(value, MIN_EDGE, MAX_EDGE));
}

/**
 * 输出几何：先等比缩放到长边 = maxEdge，再按比例裁切。
 * @returns {{scaledW:number,scaledH:number,outW:number,outH:number,x0:number,y0:number,crop:object|null,maxEdge:number}}
 */
export function outputGeometry({ width, height, maxEdge, crop = null }) {
  const edge = clampEdge(maxEdge);
  const srcW = Number(width) > 0 ? Number(width) : 16;
  const srcH = Number(height) > 0 ? Number(height) : 9;
  let scaledW;
  let scaledH;
  if (srcW >= srcH) {
    scaledW = edge;
    scaledH = Math.max(1, Math.round((srcH * edge) / srcW));
  } else {
    scaledH = edge;
    scaledW = Math.max(1, Math.round((srcW * edge) / srcH));
  }

  let x0 = 0;
  let y0 = 0;
  let outW = scaledW;
  let outH = scaledH;
  if (crop) {
    x0 = clamp(Math.round(Number(crop.x) * scaledW), 0, scaledW - 1);
    y0 = clamp(Math.round(Number(crop.y) * scaledH), 0, scaledH - 1);
    outW = clamp(Math.round(Number(crop.width) * scaledW), 1, scaledW - x0);
    outH = clamp(Math.round(Number(crop.height) * scaledH), 1, scaledH - y0);
  }
  return { scaledW, scaledH, outW, outH, x0, y0, crop: crop ?? null, maxEdge: edge };
}

function pngSignatureOk(buffer) {
  return buffer.length >= 8
    && buffer[0] === 0x89
    && buffer.subarray(1, 4).toString('latin1') === 'PNG';
}

/**
 * 按候选时刻依次尝试抓帧；成功返回 PNG buffer 与输出尺寸。
 * `-ss` 放在 `-i` 之前：契约 §6.5 要求单帧误差 ≤1 帧时用输入 seek（ffmpeg 转码时会解码到目标点）。
 */
export async function captureFrame({ inputPath, atSeconds, geometry, ctx }) {
  const { scaledW, scaledH, outW, outH, x0, y0, crop } = geometry;
  const workDir = await makeWorkDir(inputPath, 'zoom');
  const filters = [`scale=${scaledW}:${scaledH}:flags=lanczos`];
  if (crop) filters.push(`crop=${outW}:${outH}:${x0}:${y0}`);
  const filter = filters.join(',');

  let lastError = null;
  for (const candidate of atSeconds) {
    const at = Math.max(0, Number(candidate));
    if (!Number.isFinite(at)) continue;
    const outPath = path.join(workDir, `frame-${uniqueSuffix()}.png`);
    try {
      await run('ffmpeg', [
        '-y', '-v', 'error',
        '-ss', at.toFixed(4),
        '-i', inputPath,
        '-an', '-sn', '-dn',
        '-vf', filter,
        '-frames:v', '1',
        '-f', 'image2', '-c:v', 'png',
        outPath,
      ], { signal: ctx?.signal, timeoutMs: 60_000 });
      const buffer = await readFile(outPath);
      if (!pngSignatureOk(buffer)) throw new Error('ffmpeg produced a non-PNG file');
      return { buffer, width: outW, height: outH, atSeconds: at };
    } catch (error) {
      if (ctx?.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw new ToolError(
    'INTERNAL',
    `could not extract a frame at ${atSeconds.map((value) => Number(value).toFixed(3)).join(' / ')}s from "${inputPath}".`,
    lastError ? `${lastError.message} Try a timestamp inside the video, or check that ffmpeg can decode this file.` : undefined,
  );
}

/**
 * 在窗口内挑最清晰的一帧（Laplacian 方差最大的候选）。
 * 只抽 3 张小尺寸候选帧用于比较，真正输出再按选中的时刻抽一次全尺寸图。
 */
export async function pickSharpest({ inputPath, startSec, endSec, width, height, ctx, warnings = [] }) {
  const duration = Math.max(0.001, endSec - startSec);
  const longEdge = 320;
  let probeW = 320;
  let probeH = 180;
  if (Number(width) > 0 && Number(height) > 0) {
    if (Number(width) >= Number(height)) {
      probeW = longEdge;
      probeH = Math.max(2, Math.round((Number(height) * longEdge) / Number(width)));
    } else {
      probeH = longEdge;
      probeW = Math.max(2, Math.round((Number(width) * longEdge) / Number(height)));
    }
  }
  try {
    const picked = await extractSharpest({
      input: inputPath,
      at: startSec,
      dur: duration,
      cellW: probeW,
      cellH: probeH,
      candidates: 3,
      margin: Math.min(0.25, duration / 3),
    });
    return clamp(Number(picked.t), startSec, endSec);
  } catch (error) {
    if (ctx?.signal?.aborted) throw error;
    warnings.push(`sharpest-selection-failed: ${error?.message ?? error}; using the window midpoint`);
    return startSec + duration / 2;
  }
}
