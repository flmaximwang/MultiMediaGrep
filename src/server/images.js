// src/server/images.js —— 图片内容与图片 token 预算（契约 §10）
//
// 这一层只做三件事：
//   1. 把后端产出的图片 buffer 变成 MCP 的 image content block；
//   2. 按契约 §10.1 的两种计价模型算 token（取较大者）；
//   3. 在**出图之前**校验硬上限、在**出图之后**核对实际产物，软预算超了给降级警告。
//
// 契约的六个硬数（§10.2）：≤4 张/调用、≤16 格/图、≤64 格/调用、长边 ≤1600px、
// 单图 ≤2,000,000 px、软预算 4,000 token/调用（MMGREP_MAX_IMAGE_TOKENS）。

import { ToolError } from '../media/interface.js';

/** 契约 §10.2 的硬上限（数值写死；maxEdge 的运行时可配上限见 config.images.maxEdge） */
export const IMAGE_LIMITS = Object.freeze({
  maxImagesPerCall: 4,
  maxCellsPerImage: 16,
  maxCellsPerCall: 64,
  minMaxEdge: 256,
  maxMaxEdge: 1600,
  maxPixelsPerImage: 2_000_000,
});

/** 默认画面宽高比（契约 §10.3 的默认形状是 1280×720 / 1600×900） */
export const DEFAULT_ASPECT = 16 / 9;

/** 契约 §10.4 的可读性档位（每格至少多少像素） */
export const READABILITY_TIERS = Object.freeze([
  { tier: 'text', width: 480, height: 270 },
  { tier: 'scene', width: 320, height: 180 },
  { tier: 'shot', width: 160, height: 90 },
]);

/** 契约 §10.1 网格计价：ceil(w/42) * (ceil(h/42) + 1) + 2 */
export function gridTokens(width, height) {
  return Math.ceil(width / 42) * (Math.ceil(height / 42) + 1) + 2;
}

/** 契约 §10.1 像素计价：ceil(w*h/750) */
export function pixelTokens(width, height) {
  return Math.ceil((width * height) / 750);
}

/**
 * 两种模型都算、取较大者（契约 §10.1：宁可报高）。
 * @returns {{ gridTokens: number, pixelTokens: number, estimatedTokens: number }}
 */
export function estimateImageTokens(width, height) {
  const grid = gridTokens(width, height);
  const pixels = pixelTokens(width, height);
  return { gridTokens: grid, pixelTokens: pixels, estimatedTokens: Math.max(grid, pixels) };
}

/** 由最长边推实际像素尺寸（16:9 默认） */
export function imageSizeFor(maxEdge, aspect = DEFAULT_ASPECT) {
  const edge = Math.max(1, Math.floor(maxEdge));
  return { width: edge, height: Math.max(1, Math.round(edge / aspect)) };
}

/** 1–16 格对应的拼图布局（行列数）。契约 §10.4 的表只给 4/6/9/16，这里把中间值补齐。 */
export function layoutForCells(cells) {
  if (cells <= 1) return { cols: 1, rows: 1 };
  if (cells <= 2) return { cols: 2, rows: 1 };
  if (cells <= 4) return { cols: 2, rows: 2 };
  if (cells <= 6) return { cols: 3, rows: 2 };
  if (cells <= 9) return { cols: 3, rows: 3 };
  if (cells <= 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: 4 };
}

/** 保证每格到 scene 档所需的最小 maxEdge（契约 §10.4 的「最小 maxEdge 表」） */
export function minimumMaxEdgeForCells(cells) {
  const { cols, rows } = layoutForCells(cells);
  return Math.max(cols * 320, Math.ceil((rows * 180) / DEFAULT_ASPECT));
}

/**
 * 可读性评估：给定图片尺寸与格数，返回每格像素与档位。
 * `tier` 为 'below-shot' 时连「是不是另一个镜头」都分不清。
 */
export function readabilityFor({ width, height, cells }) {
  const { cols, rows } = layoutForCells(cells);
  const cellWidth = Math.floor(width / cols);
  const cellHeight = Math.floor(height / rows);
  let tier = 'below-shot';
  for (const candidate of READABILITY_TIERS) {
    if (cellWidth >= candidate.width && cellHeight >= candidate.height) {
      tier = candidate.tier;
      break;
    }
  }
  return { tier, cols, rows, cellWidth, cellHeight };
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

function assertInteger(value, name) {
  if (!Number.isInteger(value)) {
    throw new ToolError('INVALID_ARGUMENT', `${name} must be an integer (got ${JSON.stringify(value)}).`);
  }
}

/**
 * 校验请求的图片形状（契约 §10.2 的硬上限）。**超出即 BUDGET_EXCEEDED，不静默改形。**
 *
 * @param {{ cells?: number, images?: number, maxEdge?: number, limitEdge?: number }} shape
 * @returns {{ cells: number, images: number, maxEdge: number }}
 */
export function validateImageShape({ cells = 1, images = 1, maxEdge = 1280, limitEdge = IMAGE_LIMITS.maxMaxEdge } = {}) {
  const maxAllowedEdge = Math.min(IMAGE_LIMITS.maxMaxEdge, Math.max(IMAGE_LIMITS.minMaxEdge, Number(limitEdge) || IMAGE_LIMITS.maxMaxEdge));

  assertInteger(cells, 'cells');
  assertInteger(images, 'images');
  if (images < 1) {
    throw new ToolError('INVALID_ARGUMENT', `images must be an integer >= 1 (got ${images}).`);
  }
  if (images > IMAGE_LIMITS.maxImagesPerCall) {
    throw new ToolError(
      'BUDGET_EXCEEDED',
      `requested ${images} images but the per-call limit is ${IMAGE_LIMITS.maxImagesPerCall}. `
        + `Reduce images to ${IMAGE_LIMITS.maxImagesPerCall}, or reduce cells and split the range into several calls with start/end.`,
      `images: ${IMAGE_LIMITS.maxImagesPerCall}`,
    );
  }

  // 总格数先于单图格数检查：契约 §10.2 的两个例子分别是
  //   cells=25, images=1 → 「cells must be an integer between 1 and 16」
  //   cells=25, images=4 → 「requested 25 cells x 4 images = 100 cells ...」(总格数)
  const totalCells = cells * images;
  if (totalCells > IMAGE_LIMITS.maxCellsPerCall) {
    throw new ToolError(
      'BUDGET_EXCEEDED',
      `requested ${cells} cells x ${images} images = ${totalCells} cells but the per-call limit is ${IMAGE_LIMITS.maxCellsPerCall}. `
        + 'Lower cells, lower images, or split the range into several calls.',
      'Keep cells x images <= 64.',
    );
  }

  if (cells < 1 || cells > IMAGE_LIMITS.maxCellsPerImage) {
    throw new ToolError(
      'BUDGET_EXCEEDED',
      `cells must be an integer between 1 and ${IMAGE_LIMITS.maxCellsPerImage} (got ${cells}).`,
      'Use cells <= 16; to cover more moments, add another image instead of adding cells.',
    );
  }

  assertInteger(maxEdge, 'maxEdge');
  if (maxEdge < IMAGE_LIMITS.minMaxEdge || maxEdge > maxAllowedEdge) {
    throw new ToolError(
      'BUDGET_EXCEEDED',
      `maxEdge must be an integer between ${IMAGE_LIMITS.minMaxEdge} and ${maxAllowedEdge} (got ${maxEdge}).`,
      `Use maxEdge <= ${maxAllowedEdge}.`,
    );
  }

  const { width, height } = imageSizeFor(maxEdge);
  const pixels = width * height;
  if (pixels > IMAGE_LIMITS.maxPixelsPerImage) {
    throw new ToolError(
      'BUDGET_EXCEEDED',
      `the requested shape would need ${pixels.toLocaleString('en-US')} pixels per image but the limit is ${IMAGE_LIMITS.maxPixelsPerImage.toLocaleString('en-US')}. `
        + 'Lower cells or maxEdge.',
    );
  }

  return { cells, images, maxEdge };
}

/**
 * 校验后端实际产出的图片（防止后端绕过请求形状多出图）。
 * 这一步在图片已经生成之后跑；违反硬上限说明后端有 bug，必须报错而不是静默截断。
 */
export function validateProducedImages(images, { limitEdge = IMAGE_LIMITS.maxMaxEdge } = {}) {
  const list = Array.isArray(images) ? images : [];
  if (list.length > IMAGE_LIMITS.maxImagesPerCall) {
    throw new ToolError(
      'BUDGET_EXCEEDED',
      `the backend produced ${list.length} images but the per-call limit is ${IMAGE_LIMITS.maxImagesPerCall}. `
        + `Reduce images to ${IMAGE_LIMITS.maxImagesPerCall}, or reduce cells and split the range into several calls with start/end.`,
    );
  }
  let totalCells = 0;
  for (const image of list) {
    const cells = Number.isInteger(image?.cells) ? image.cells : 1;
    if (cells > IMAGE_LIMITS.maxCellsPerImage) {
      throw new ToolError(
        'BUDGET_EXCEEDED',
        `cells must be an integer between 1 and ${IMAGE_LIMITS.maxCellsPerImage} (got ${cells}).`,
      );
    }
    totalCells += cells;
    if (image?.width && image?.height && image.width * image.height > IMAGE_LIMITS.maxPixelsPerImage) {
      throw new ToolError(
        'BUDGET_EXCEEDED',
        `the requested shape would need ${(image.width * image.height).toLocaleString('en-US')} pixels per image but the limit is ${IMAGE_LIMITS.maxPixelsPerImage.toLocaleString('en-US')}. `
          + 'Lower cells or maxEdge.',
      );
    }
    if (image?.width && image?.height) {
      const edge = Math.max(image.width, image.height);
      const maxAllowed = Math.min(IMAGE_LIMITS.maxMaxEdge, Number(limitEdge) || IMAGE_LIMITS.maxMaxEdge);
      if (edge > maxAllowed) {
        throw new ToolError(
          'BUDGET_EXCEEDED',
          `maxEdge must be an integer between ${IMAGE_LIMITS.minMaxEdge} and ${maxAllowed} (got ${edge}).`,
        );
      }
    }
  }
  if (totalCells > IMAGE_LIMITS.maxCellsPerCall) {
    throw new ToolError(
      'BUDGET_EXCEEDED',
      `requested ${totalCells} cells in ${list.length} images but the per-call limit is ${IMAGE_LIMITS.maxCellsPerCall}. `
        + 'Lower cells, lower images, or split the range into several calls.',
    );
  }
  return list;
}

/* ------------------------------------------------------------------ *
 * 预算规划
 * ------------------------------------------------------------------ */

/**
 * 规划一次调用的图片预算（契约 §10.3 / §10.5）。
 *
 * - `explicit === true`（agent 给了 cells / images / maxEdge）：**不偷偷改形**；
 *   超软预算照出，在 warning 里给出降级建议（阶梯第 3、4 条）。
 * - `explicit === false`（自动模式）：默认形状已保证落在软预算内；万一配置调低预算，
 *   按契约的降级阶梯先减图片数、再降 maxEdge。
 */
export function planImageBudget({
  cells,
  images = 1,
  maxEdge = 1280,
  explicit = false,
  limitTokens = 4000,
  limitEdge = IMAGE_LIMITS.maxMaxEdge,
  aspect = DEFAULT_ASPECT,
} = {}) {
  const requested = validateImageShape({ cells, images, maxEdge, limitEdge });

  const shapeTokens = (shape) => {
    const { width, height } = imageSizeFor(shape.maxEdge, aspect);
    return { width, height, perImage: estimateImageTokens(width, height).estimatedTokens };
  };

  let produced = { ...requested };
  let dims = shapeTokens(produced);
  let notes = [];

  if (produced.images * dims.perImage > limitTokens) {
    if (explicit) {
      // 契约 §10.3：显式模式不偷偷改形，只警告 + 给建议。
      const suggestImages = Math.max(1, Math.floor(limitTokens / dims.perImage));
      notes.push(
        `requested shape needs ~${produced.images * dims.perImage} image tokens, above the soft budget of ${limitTokens}. `
          + 'Produced as requested (not silently reduced). To stay within budget: split the range into several calls with start/end (preferred), '
          + `or reduce images to ${suggestImages}, or reduce maxEdge.`,
      );
    } else {
      // 自动模式：阶梯 3（减少图片数）→ 降 maxEdge（保持每张可读）。
      const original = { ...produced };
      while (produced.images > 1 && produced.images * dims.perImage > limitTokens) {
        produced.images -= 1;
      }
      while (dims.perImage > limitTokens && produced.maxEdge > IMAGE_LIMITS.minMaxEdge) {
        produced.maxEdge = Math.max(IMAGE_LIMITS.minMaxEdge, produced.maxEdge - 64);
        dims = shapeTokens(produced);
      }
      if (produced.images !== original.images || produced.maxEdge !== original.maxEdge) {
        notes.push(
          `budget plan reduced the shape from ${original.images} x ${original.cells} cells @ ${original.maxEdge}px `
            + `to ${produced.images} x ${produced.cells} cells @ ${produced.maxEdge}px to stay within ${limitTokens} image tokens.`,
        );
      }
    }
  }

  const readability = readabilityFor({ width: dims.width, height: dims.height, cells: produced.cells });
  if (readability.tier === 'shot' || readability.tier === 'below-shot') {
    const needed = minimumMaxEdgeForCells(produced.cells);
    notes.push(
      `cells below readability target: ${readability.tier}-level (${readability.cellWidth}x${readability.cellHeight} px per cell). `
        + `Use maxEdge >= ${needed} with ${produced.cells} cells, or fewer cells.`,
    );
  }

  return {
    requested,
    produced,
    width: dims.width,
    height: dims.height,
    perImageTokens: dims.perImage,
    estimatedTokens: produced.images * dims.perImage,
    limit: limitTokens,
    readability,
    warning: notes.length > 0 ? notes.join(' ') : null,
  };
}

/**
 * 组装契约 §5.3 的 `budget` 字段（请求 vs 实际）。
 *
 * @param {object} plan planImageBudget() 的返回值
 * @param {{ producedImages?: number, producedCells?: number, extraWarnings?: string[] }} [actual]
 */
export function budgetReport(plan, actual = {}) {
  const producedImages = Number.isInteger(actual.producedImages) ? actual.producedImages : plan.produced.images;
  const producedCells = Number.isInteger(actual.producedCells) ? actual.producedCells : plan.produced.cells;
  const estimatedTokens = producedImages * plan.perImageTokens;
  const warnings = [];
  if (plan.warning) warnings.push(plan.warning);

  // 后端出图数少于请求：说清楚（上游踩过「asked 16, produced 8」的坑）。
  if (producedImages < plan.requested.images) {
    warnings.push(
      `requested ${plan.requested.images} images but ${producedImages} were produced (the window does not contain enough distinct cells); `
        + 'request more cells or widen the range if you need full coverage.',
    );
  }
  const requestedCells = plan.requested.cells * plan.requested.images;
  if (producedImages === plan.requested.images && producedCells > 0 && producedCells < requestedCells) {
    warnings.push(`asked ${requestedCells} cells, produced ${producedCells}.`);
  }
  if (Array.isArray(actual.extraWarnings)) warnings.push(...actual.extraWarnings);

  const warning = warnings.length > 0 ? warnings.join(' ') : null;

  return {
    requestedImages: plan.requested.images,
    producedImages,
    requestedCells: plan.requested.cells * plan.requested.images,
    producedCells,
    estimatedTokens,
    limit: plan.limit,
    warning,
  };
}

/* ------------------------------------------------------------------ *
 * MCP image content
 * ------------------------------------------------------------------ */

/** 从 buffer 魔数判断 MIME（后端只需交回 PNG/JPEG buffer） */
export function mimeTypeOfBuffer(buffer) {
  if (!buffer || buffer.length < 4) return 'image/png';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return 'image/png';
}

/**
 * 把图片 buffer 转成 MCP image content block：
 * `{ type: 'image', data: <base64>, mimeType }`（契约 §13.1 #15：标准 MCP content）。
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {string} [mimeType] 不传则按魔数判断
 */
export function toImageContent(buffer, mimeType = null) {
  if (!buffer) {
    throw new ToolError('INTERNAL', 'the backend returned an image without data.');
  }
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return {
    type: 'image',
    data: bytes.toString('base64'),
    mimeType: mimeType ?? mimeTypeOfBuffer(bytes),
  };
}

/**
 * 把后端产出的 images[] 变成「content block + 结构化描述」两部分。
 *
 * 后端每张图形如 `{ buffer, mimeType?, width, height, cells?, index? }`。
 *
 * @returns {{ blocks: object[], descriptors: object[], totalCells: number }}
 */
export function describeImages(images, { source = 'visual' } = {}) {
  const list = Array.isArray(images) ? images : [];
  const blocks = [];
  const descriptors = [];
  let totalCells = 0;
  list.forEach((image, i) => {
    const bytes = Buffer.isBuffer(image?.buffer) ? image.buffer : (image?.buffer ? Buffer.from(image.buffer) : null);
    if (!bytes) {
      throw new ToolError('INTERNAL', `the backend returned image ${i + 1} without a buffer.`);
    }
    const mimeType = image.mimeType ?? mimeTypeOfBuffer(bytes);
    const width = Number.isInteger(image.width) ? image.width : null;
    const height = Number.isInteger(image.height) ? image.height : null;
    const cells = Number.isInteger(image.cells) ? image.cells : 1;
    totalCells += cells;
    const tokens = width && height ? estimateImageTokens(width, height).estimatedTokens : null;
    blocks.push(toImageContent(bytes, mimeType));
    descriptors.push({
      index: Number.isInteger(image.index) ? image.index : i + 1,
      width,
      height,
      cells,
      mimeType,
      bytes: bytes.length,
      estimatedTokens: tokens,
      source,
    });
  });
  return { blocks, descriptors, totalCells };
}
