/**
 * Tiny RGB raster canvas with bitmap-font text rendering.
 *
 * Everything is plain `Buffer` math so the renderer behaves identically on
 * macOS and Linux and needs no image library.
 */

import { GLYPH_ADVANCE, GLYPH_HEIGHT, GLYPH_WIDTH, glyphRows } from './bitmap-font.mjs';

export class Raster {
  /**
   * @param {number} width
   * @param {number} height
   * @param {[number,number,number]} bg
   */
  constructor(width, height, bg = [255, 255, 255]) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 3);
    this.fillRect(0, 0, width, height, bg);
  }

  /** @param {[number,number,number]} color */
  setPixel(x, y, color) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.data[i] = color[0];
    this.data[i + 1] = color[1];
    this.data[i + 2] = color[2];
  }

  /** @param {[number,number,number]} color */
  fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.trunc(x));
    const y0 = Math.max(0, Math.trunc(y));
    const x1 = Math.min(this.width, Math.trunc(x + w));
    const y1 = Math.min(this.height, Math.trunc(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        this.setPixel(px, py, color);
      }
    }
  }

  /** @param {[number,number,number]} color */
  strokeRect(x, y, w, h, color, thickness = 1) {
    this.fillRect(x, y, w, thickness, color);
    this.fillRect(x, y + h - thickness, w, thickness, color);
    this.fillRect(x, y, thickness, h, color);
    this.fillRect(x + w - thickness, y, thickness, h, color);
  }

  /** Bresenham line with square pen. @param {[number,number,number]} color */
  drawLine(x0, y0, x1, y1, color, thickness = 1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const px = Math.round(x0 + (x1 - x0) * t);
      const py = Math.round(y0 + (y1 - y0) * t);
      this.fillRect(px, py, thickness, thickness, color);
    }
  }

  /**
   * Draw a single line of text. `x`/`y` address the top-left of the glyph
   * cell (not of the ink); the ink may start one pixel lower for glyphs that
   * do not use the first row.
   *
   * @param {string} text
   * @param {number} x
   * @param {number} y
   * @param {{scale?:number, color?:[number,number,number]}} [opts]
   * @returns {{x:number,y:number,width:number,height:number}} ink bounding box
   */
  drawText(text, x, y, opts = {}) {
    const scale = opts.scale ?? 1;
    const color = opts.color ?? [0, 0, 0];
    const upper = String(text).toUpperCase();

    for (let c = 0; c < upper.length; c += 1) {
      const rows = glyphRows(upper[c]);
      if (!rows) {
        throw new Error(`bitmap-font has no glyph for ${JSON.stringify(upper[c])} in ${JSON.stringify(text)}`);
      }
      const cellX = x + c * GLYPH_ADVANCE * scale;
      for (let r = 0; r < GLYPH_HEIGHT; r += 1) {
        const bits = rows[r];
        for (let col = 0; col < GLYPH_WIDTH; col += 1) {
          if (bits & (1 << (GLYPH_WIDTH - 1 - col))) {
            this.fillRect(cellX + col * scale, y + r * scale, scale, scale, color);
          }
        }
      }
    }

    return textInkRect(upper, scale, x, y);
  }

  /** Copy of the raw RGB bytes. */
  toRGB() {
    return Buffer.from(this.data);
  }
}

/**
 * Tight bounding box of the ink a string would produce, relative to the
 * drawing origin. Used to record exact ground-truth pixel positions.
 *
 * @param {string} text
 * @param {number} scale
 * @param {number} [originX]
 * @param {number} [originY]
 */
export function textInkRect(text, scale = 1, originX = 0, originY = 0) {
  const upper = String(text).toUpperCase();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let c = 0; c < upper.length; c += 1) {
    const rows = glyphRows(upper[c]);
    if (!rows) {
      throw new Error(`bitmap-font has no glyph for ${JSON.stringify(upper[c])} in ${JSON.stringify(text)}`);
    }
    const cellX = c * GLYPH_ADVANCE * scale;
    for (let r = 0; r < GLYPH_HEIGHT; r += 1) {
      const bits = rows[r];
      if (bits === 0) continue;
      for (let col = 0; col < GLYPH_WIDTH; col += 1) {
        if (bits & (1 << (GLYPH_WIDTH - 1 - col))) {
          const px = cellX + col * scale;
          const py = r * scale;
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px + scale - 1 > maxX) maxX = px + scale - 1;
          if (py + scale - 1 > maxY) maxY = py + scale - 1;
        }
      }
    }
  }

  if (minX === Infinity) {
    return { x: originX, y: originY, width: 0, height: 0 };
  }
  return {
    x: originX + minX,
    y: originY + minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

/**
 * Median channel values of an RGB buffer (robust against noise and against
 * the minority of pixels that carry text).
 */
export function medianColor(rgb, width, height) {
  const n = width * height;
  const r = new Uint8Array(n);
  const g = new Uint8Array(n);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    r[i] = rgb[i * 3];
    g[i] = rgb[i * 3 + 1];
    b[i] = rgb[i * 3 + 2];
  }
  const medianOf = (arr) => {
    const copy = Uint8Array.from(arr).sort();
    return copy[Math.floor(copy.length / 2)];
  };
  return [medianOf(r), medianOf(g), medianOf(b)];
}

/**
 * Build a boolean mask of pixels that differ noticeably from `background`.
 * @returns {Uint8Array} length width*height, 1 = ink
 */
export function inkMask(rgb, width, height, background, threshold = 40) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const dr = Math.abs(rgb[i * 3] - background[0]);
    const dg = Math.abs(rgb[i * 3 + 1] - background[1]);
    const db = Math.abs(rgb[i * 3 + 2] - background[2]);
    if (Math.max(dr, dg, db) >= threshold) mask[i] = 1;
  }
  return mask;
}

/**
 * Intersection-over-union of two ink masks restricted to a rectangle.
 * @returns {{iou:number, intersection:number, union:number}}
 */
export function maskIoU(maskA, maskB, width, x, y, w, h) {
  let intersection = 0;
  let union = 0;
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      const a = maskA[py * width + px];
      const b = maskB[py * width + px];
      if (a && b) intersection += 1;
      if (a || b) union += 1;
    }
  }
  return { iou: union === 0 ? 1 : intersection / union, intersection, union };
}
