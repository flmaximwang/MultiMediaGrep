// src/backend/video/geometry.js —— probe 元信息里的显示几何：帧率/SAR 解析、旋转归一、显示宽高比
//
// 派生自 dsh-video-storyboard v0.5.9 的 `src/storyboard/probe.js`
// （https://github.com/SAOS-3624/dsh-video-storyboard），© 2026 SAOS-3624，
// Apache-2.0。按 Apache-2.0 §4(b) 标注改动：**只做了提取，逻辑未改**。
//
// 保留：parseRational、parseSar、displayAspect、normalizeRotation、uprightSize，
//       以及上游解释「为什么」的注释。
// 丢弃：probeVideo、endEdge、私有 execFile 包装 run()，以及 DEFAULT_FFMPEG /
//       DEFAULT_FFPROBE 的再导出——本项目的 ffprobe 调用统一走 media/ffmpeg.js。
//
// 单独成文件的原因：这五个函数是「编码尺寸 → 观众看到的尺寸」的唯一换算口径，
// probe 和后续抓帧/裁切都依赖同一份实现；它们不碰进程、文件系统与环境变量，
// 单测可以逐条钉住边界（0 分母、缺 SAR、旋转 90）。

/** "25/1" | "30000/1001" → number | null */
export function parseRational(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const [num, den = '1'] = value.split('/');
  const a = Number(num);
  const b = Number(den);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const v = a / b;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 像素宽高比（SAR）：`4:3` / `1:1` / `0:1`。
 * 0:1 或缺失表示"未声明"，按方像素（1:1）处理。
 */
export function parseSar(value) {
  // ffprobe 的 sample_aspect_ratio 是 `4:3` 这种冒号写法（不是帧率的 `24/1` 斜杠写法）
  if (typeof value !== 'string' || !value.includes(':')) return 1;
  const [num, den = '1'] = value.split(':');
  const a = Number(num);
  const b = Number(den);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0 || a <= 0) return 1;
  return a / b;
}

/**
 * 显示宽高比（DAR）= 编码宽 × SAR / 编码高；转 90° 后取倒数。
 *
 * 为什么不能用 width/height 直接算：非方形像素的素材（DVD 时代的 1440×1080 存成 4:3 SAR、
 * 部分手机的变形录制）编码尺寸和**显示**尺寸不是一回事。用编码尺寸算比例，格子会被压扁/拉长，
 * 而模型对"人脸比例不对"是敏感的。
 */
export function displayAspect(codedW, codedH, sar, rotation = 0) {
  if (!(codedW > 0) || !(codedH > 0)) return 16 / 9;
  const dar = (codedW * (sar > 0 ? sar : 1)) / codedH;
  return Math.abs(rotation) % 180 === 90 ? 1 / dar : dar;
}

/** 旋转角归一化到 (-180, 180] */
export function normalizeRotation(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  let a = v % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.round(a);
}

/** 旋转 90/270 时，观众看到的宽高与编码宽高互换 */
export function uprightSize(codedWidth, codedHeight, rotation) {
  return Math.abs(rotation) % 180 === 90
    ? { width: codedHeight, height: codedWidth }
    : { width: codedWidth, height: codedHeight };
}
