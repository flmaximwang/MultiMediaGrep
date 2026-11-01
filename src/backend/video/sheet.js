/**
 * sheet.js — 分镜宫格的纯绘制层：画布布局、填色、点阵数字、编号徽标、空位补灰、贴帧、拼图。
 * 只处理 rawvideo rgb24 Buffer，不碰 IO，也不起 ffmpeg 子进程。
 *
 * 为什么不用 ffmpeg 的 `tile` + `drawtext`：
 *  - drawtext 需要字体文件 + fontconfig + 平台相关的路径转义，装到别人机器上就得炸；
 *  - 我们只需要画 0-9 和一道横杠，用内置点阵字形更可控，且在低分辨率压缩后更抗糊。
 *
 * 布局约定（与 plan.js 一致）：
 *  - 每格按 cover 方式缩放裁切（不变形，溢出部分裁掉）
 *  - 整图面积 <= budget（默认 640k），间隙 4px
 *  - 空位填中性灰 + “—”，且不编号
 *
 * 来源与改编说明（Apache-2.0 §4(b) 变更声明）：
 *   派生自 dsh-video-storyboard v0.5.9 的 `src/storyboard/sheet.js`，
 *   © 2026 SAOS-3624，Apache-2.0 许可。
 *
 *   保留（逻辑逐字照搬，上游的中文“为什么”注释原样保留）：
 *   常量 BACKGROUND/PAD_FILL/PAD_GLYPH/BADGE_BG/BADGE_FG/GUTTER/BADGE_ALPHA；
 *   点阵字形 DIGITS（只留 0-9）、DIGIT_W/DIGIT_H；
 *   headerHeight、layoutCanvas、fillRect、drawGlyphs、badgeScale、drawBadge、
 *   drawPadding、blit、composeSheet。
 *
 *   删除（均不在本层，由本仓库的其它模块负责，故不在此重复实现）：
 *   - 音频条带（STRIP_* / addAudioStrip）
 *   - 子格切分（tileSubFrames）
 *   - 锐度选帧（sharpness / extractSharpest）
 *   - 每张图的抬头带（HEADER_* / clock / addSheetHeader）
 *   - 全部 ffmpeg IO（coverFilter / httpInputArgs / exec / extractFrameRaw /
 *     encodePngBuffer / encodeRaw）
 *   - 顶部的 `node:child_process` 与 `./probe.js` 导入 —— 本模块不导入任何东西
 */

export const BACKGROUND = [18, 18, 20];
export const PAD_FILL = [42, 42, 46];
export const PAD_GLYPH = [110, 110, 116];
export const BADGE_BG = [0, 0, 0];
export const BADGE_FG = [255, 235, 59];
export const GUTTER = 4;
export const BADGE_ALPHA = 0.85;

/**
 * 5×7 点阵，只有 0-9（scale 必须是整数，保证放大后边缘锐利）。
 * 上游还带时间码用的 `:` `/`，本仓库不再画时间码，已剥离；
 * `drawGlyphs` 查不到字形时直接跳过，与其它未知字符行为一致。
 */
export const DIGITS = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

export const DIGIT_W = 5;
export const DIGIT_H = 7;

/**
 * 顶部时间抬头的高度（像素）。只跟图宽有关 —— 字号是点阵整数倍，宽了就该更高一点。
 *
 * 本仓库不再绘制抬头带（addSheetHeader 已移除），但这个函数必须保留：
 * `layoutCanvas` 仍按同一个公式**预留**这条带子的高度。删掉它会让每条边
 * 少扣掉几十像素，改变每张图的 width/height/cellW/cellH，进而破坏
 * src/backend/video/storyboard.js 里基于 maxEdge 的长边适配。
 */
export function headerHeight(width) {
  return Math.max(18, Math.round(width * 0.024));
}

/**
 * 画布尺寸：整图面积 <= budget，格宽高按剩余空间均分。
 * @returns {{width:number,height:number,cellW:number,cellH:number}}
 */
export function layoutCanvas(cols, rows, cellAspect, budget = 640_000, gutter = GUTTER) {
  const aspect = (cols * cellAspect) / rows;
  const gw = Math.sqrt(budget * aspect);
  const gh = gw / aspect;
  // 每张图顶部有一条时间抬头（见 addSheetHeader）。它的高度必须**先扣掉**，
  // 否则"整图面积 <= budget"就成了假话（3×3 实测会超 3%）。
  // 扣完之后用**格高反推格宽**，比例才不会被这条带子拉偏（1×1 会从 1.78 变成 1.84）。
  // 注：抬头带本身已不由本模块绘制，但这段预留逻辑必须原样保留（见 headerHeight 注释）。
  const band = Math.ceil(headerHeight(gw));
  const cellH = Math.max(1, Math.floor((Math.max(rows, gh - band) - gutter * (rows + 1)) / rows));
  const cellW = Math.max(1, Math.floor(cellH * cellAspect));
  return {
    width: cols * cellW + gutter * (cols + 1),
    height: rows * cellH + gutter * (rows + 1),
    cellW,
    cellH,
  };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
/** 在 RGB 画布上填一块矩形（支持 alpha 混合） */
export function fillRect(buf, width, height, x, y, w, h, color, alpha = 1) {
  const [r, g, b] = color;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let py = y0; py < y1; py++) {
    let idx = (py * width + x0) * 3;
    for (let px = x0; px < x1; px++) {
      if (alpha >= 1) {
        buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b;
      } else {
        buf[idx] = clamp255(buf[idx] * (1 - alpha) + r * alpha);
        buf[idx + 1] = clamp255(buf[idx + 1] * (1 - alpha) + g * alpha);
        buf[idx + 2] = clamp255(buf[idx + 2] * (1 - alpha) + b * alpha);
      }
      idx += 3;
    }
  }
}

/**
 * 用点阵字形画一个字符串（0-9 与 `-`，空格只走位），返回实际占用尺寸。
 * `:` 与 `/` 已随 DIGITS 一起剥离：查不到字形就跳过，不占位、不改缓冲。
 */
export function drawGlyphs(buf, width, height, text, x, y, scale, color) {
  let cursor = x;
  for (const ch of String(text)) {
    if (ch === ' ') { cursor += (DIGIT_W + 1) * scale; continue; }
    if (ch === '-') {
      fillRect(buf, width, height, cursor, y + Math.floor(DIGIT_H * scale * 0.6),
        DIGIT_W * scale, Math.max(1, scale), color);
      cursor += (DIGIT_W + 1) * scale;
      continue;
    }
    const glyph = DIGITS[ch];
    if (!glyph) continue;
    for (let row = 0; row < DIGIT_H; row++) {
      for (let col = 0; col < DIGIT_W; col++) {
        if (glyph[row][col] === '1') {
          fillRect(buf, width, height, cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += (DIGIT_W + 1) * scale;
  }
  return { width: cursor - x, height: DIGIT_H * scale };
}

/**
 * 字形的整数缩放比：字号约占格高 22%，同时不超过格宽的 30%（两位编号时尤其重要）。
 * 大一点更抗压缩——低分辨率下"认一个字符"比"数格子"稳得多。
 */
export function badgeScale(cellH, cellW = Infinity, digits = 1, ratio = 0.18) {
  const byHeight = Math.floor((cellH * ratio) / DIGIT_H);
  const byWidth = Number.isFinite(cellW)
    ? Math.floor((cellW * 0.26) / (Math.max(1, digits) * (DIGIT_W + 1)))
    : byHeight;
  return Math.max(2, Math.min(byHeight, byWidth));
}

/**
 * 在一格里画编号徽标（黑底 + 黄字，左上角固定位置）。
 * 不透明优先：半透明底块在白板/雪景上会直接消失（实测见设计方案 §3.5）。
 */
export function drawBadge(buf, width, height, x, y, cellW, cellH, label, ratio = 0.18) {
  const digits = String(label).length;
  const scale = badgeScale(cellH, cellW, digits, ratio);
  const pad = Math.max(2, Math.round(cellH * 0.025));
  const textW = digits * (DIGIT_W + 1) * scale - scale;
  const textH = DIGIT_H * scale;
  fillRect(buf, width, height, x, y, textW + pad * 2, textH + pad * 2, BADGE_BG, BADGE_ALPHA);
  drawGlyphs(buf, width, height, label, x + pad, y + pad, scale, BADGE_FG);
  return { w: textW + pad * 2, h: textH + pad * 2 };
}

/** 空位：灰底 + 居中横杠，且绝对不编号 */
export function drawPadding(buf, width, height, x, y, cellW, cellH) {
  fillRect(buf, width, height, x, y, cellW, cellH, PAD_FILL);
  const barW = Math.max(6, Math.round(cellW * 0.32));
  const barH = Math.max(2, Math.round(cellH * 0.03));
  fillRect(buf, width, height,
    x + Math.round((cellW - barW) / 2), y + Math.round((cellH - barH) / 2),
    barW, barH, PAD_GLYPH);
}

/**
 * 把若干帧（rawvideo rgb24）拼成一张画布。
 * @param {{frames:Array<{buffer:Buffer, index:number}|null>, cols:number, rows:number,
 *          cellAspect:number, budget?:number, gutter?:number, burn?:'index'|'none'}} opts
 *   frames 顺序对应格位 1..cols*rows；null = 空位（补灰）
 * @returns {{buffer:Buffer,width:number,height:number,cellW:number,cellH:number}}
 */
export function composeSheet(opts) {
  const {
    frames, cols, rows, cellAspect, budget = 640_000, gutter = GUTTER,
    burn = 'index', badgeRatio = 0.18,
  } = opts;
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array');
  if (frames.length > cols * rows) throw new RangeError('more frames than cells');
  const { width, height, cellW, cellH } = layoutCanvas(cols, rows, cellAspect, budget, gutter);
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = BACKGROUND[0]; buf[i + 1] = BACKGROUND[1]; buf[i + 2] = BACKGROUND[2];
  }

  for (let pos = 0; pos < cols * rows; pos++) {
    const r = Math.floor(pos / cols);
    const c = pos % cols;
    const x = gutter + c * (cellW + gutter);
    const y = gutter + r * (cellH + gutter);
    const frame = frames[pos];
    if (!frame) {
      drawPadding(buf, width, height, x, y, cellW, cellH);
      continue;
    }
    // 画面比格子小时（黑场格）居中摆放：黑屏里没有内容，占满一整格纯属浪费画布
    const fw = frame.w ?? cellW;
    const fh = frame.h ?? cellH;
    if (fw < cellW || fh < cellH) {
      const dx = x + Math.round((cellW - fw) / 2);
      const dy = y + Math.round((cellH - fh) / 2);
      blit(buf, width, height, dx, dy, fw, fh, frame.buffer, fw);
    } else {
      blit(buf, width, height, x, y, cellW, cellH, frame.buffer);
    }
    if (burn !== 'none') drawBadge(buf, width, height, x + 2, y + 2, cellW, cellH, frame.index, badgeRatio);
  }
  return { buffer: buf, width, height, cellW, cellH };
}

/**
 * 把一张 RGB 图贴到目标缓冲区的 (x,y)，占 cellW×cellH。
 *
 * `srcW` 是**源图自己的行宽**。黑场格会取一张只占半格的小图（buffer 宽度就是 cellW/2），
 * 靠它才能按小图的行宽正确拷贝 —— 否则每行都会错位成斜的。
 */
export function blit(dst, dstW, dstH, x, y, cellW, cellH, src, srcW = cellW) {
  const need = srcW * cellH * 3;
  if (src.length < need) throw new RangeError(`frame buffer too small: ${src.length} < ${need}`);
  for (let row = 0; row < cellH; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dstH) continue;
    const sStart = row * srcW * 3;
    const dStart = (dy * dstW + x) * 3;
    src.copy(dst, dStart, sStart, sStart + cellW * 3);
  }
}
