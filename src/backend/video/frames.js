/**
 * frames.js — 取帧 + 锐度选帧 + PNG 编码：在 rawvideo rgb24 缓冲上做视频 IO。
 *
 * 来源与改编说明（Apache-2.0 §4(b) 变更声明）：
 *   派生自 dsh-video-storyboard v0.5.9 的 `src/storyboard/sheet.js`，
 *   © 2026 SAOS-3624，Apache-2.0 许可。
 *
 *   保留（逻辑逐字照搬，上游的中文“为什么”注释原样保留）：
 *   - coverFilter：cover 等比缩放 + 居中裁切的滤镜串；
 *   - extractFrameRaw：只保留 `mode: 'mid'`（段中点取帧）路径，包括
 *     「seek 越过最后一帧就向段起点方向退 0.5s 再试」的阶梯（issue #30）
 *     以及 `frame @…s too small` 的兜底错误；
 *   - sharpness：Laplacian 方差；
 *   - extractSharpest：均匀取候选点、`Promise.allSettled` 容忍单个候选取不到帧、
 *     全部失败时重抛第一个拒绝；
 *   - encodePngBuffer：stdin 喂裸像素、stdout 收 PNG，并保留 PNG 签名校验。
 *
 *   变更：
 *   - ffmpeg 进程改为经本仓库 `src/media/ffmpeg.js` 的 `runBuffer` 启动：
 *     它会按 `MMGREP_FFMPEG_PATH` 解析二进制、全程按 Buffer 收集 stdout、
 *     接受 `input` 写入 stdin，并把 ENOENT/超时/非零退出映射成 ToolError。
 *     上游私有的 `exec()`、`node:child_process` 的 `spawn` 导入、
 *     `DEFAULT_FFMPEG` 与 `ffmpegPath` 选项均已删除。
 *   - 删除远程/http 取帧（`httpInputArgs`、`http` 选项）：本服务只读本地文件。
 *   - 删除 `mode: 'thumb'` 分支及其 `thumbnail=n=...,showinfo` 滤镜与 `PTS_RE`
 *     时间戳解析：选帧改由 `extractSharpest` 的锐度比较负责。
 *   - 未采用 `encodeRaw`（落盘编码）与帧拼图/子格切分（`tileSubFrames` 等，
 *     由本仓库 `sheet.js` 负责）。
 */

import { runBuffer } from '../../media/ffmpeg.js';

/* ---------------------------------------------------------------- 锐度 */

/**
 * Laplacian 方差：越大越锐。用来避开"淡入/对焦中/高斯模糊转场"的中间帧。
 *
 * 为什么直方图不够：模糊不改变颜色分布，`thumbnail` 的"最接近均值"判据对
 * 模糊→清晰这种渐变完全不敏感。实测概念 PV 的片尾人员表就中过招：
 * 开头那 1 秒是高斯模糊，`thumbnail` 照样选它当代表帧。
 */
export function sharpness(buf, width, height) {
  const n = width * height;
  const gray = new Float32Array(n);
  for (let i = 0, p = 0; i < buf.length; i += 3, p++) {
    gray[p] = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
  }
  let sum = 0;
  let sum2 = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width];
      sum += v;
      sum2 += v * v;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sum2 / count - mean * mean;
}

/**
 * 段内取最锐的一帧：均匀取 candidates 个候选点，各抽一帧，比 Laplacian 方差。
 *
 * 成本：candidates 次「seek + 解 1 帧」，而不是解码整段。3 帧 ≈ 3 倍单帧耗时，
 * 但仍是毫秒级——真正的开销是进程启动，不是解码。
 */
export async function extractSharpest(opts) {
  const {
    input, at, dur, cellW, cellH,
    candidates = 3, margin = 0.25, timeoutMs,
  } = opts;
  const safeDur = Math.max(0, dur || 0);
  const pad = Math.min(margin, safeDur / 3);
  const span = Math.max(0, safeDur - pad * 2);
  const times = [];
  if (candidates <= 1 || span < 0.1) {
    times.push(safeDur > 0 ? at + safeDur / 2 : at);
  } else {
    for (let i = 0; i < candidates; i++) times.push(at + pad + (span * i) / (candidates - 1));
  }
  // 截断录制里末尾候选会越界（ffmpeg exit 0 + stdout 0 字节）。不能因为一个候选失败
  // 就丢掉另外两个可解候选 —— 一次失败会让整张分镜归零（issue #30）。
  const settled = await Promise.allSettled(times.map((t) =>
    extractFrameRaw({ input, at: t, cellW, cellH, timeoutMs })
      .then((f) => ({ ...f, sharp: sharpness(f.buffer, cellW, cellH) }))));
  const picked = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (picked.length === 0) {
    const first = settled.find((s) => s.status === 'rejected');
    throw first?.reason instanceof Error
      ? first.reason
      : new Error(`no readable frame around ${at.toFixed(2)}s`);
  }
  return picked.reduce((best, cur) => (cur.sharp > best.sharp ? cur : best));
}

/* ---------------------------------------------------------------- ffmpeg IO */

/** cover 缩放：等比放大到完全覆盖 cell，再居中裁切（绝不变形） */
export const coverFilter = (cellW, cellH) =>
  `scale=${cellW}:${cellH}:force_original_aspect_ratio=increase,crop=${cellW}:${cellH}`;

/**
 * 取一帧，返回 rawvideo rgb24（正好 cellW*cellH*3 字节）与真实时刻。
 * @param {{input:string, at:number, dur?:number, cellW:number, cellH:number,
 *          timeoutMs?:number}} opts
 */
export async function extractFrameRaw(opts) {
  const { input, at, dur, cellW, cellH, timeoutMs } = opts;
  const filter = coverFilter(cellW, cellH);
  const need = cellW * cellH * 3;
  const baseSeek = dur > 0 ? at + dur / 2 : at;
  // 截断录制/容器比视频流长时，末尾 seek 可能越过最后一帧：ffmpeg 仍 exit 0、stdout 为空。
  // 向段起点方向退几步再试，别让一格取不到帧拖垮整张图（issue #30）。
  let last = { seek: baseSeek, length: 0 };
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const seek = Math.max(0, baseSeek - attempt * 0.5);
    if (attempt > 0 && seek === last.seek) break;
    const args = ['-hide_banner', '-v', 'error', '-nostdin', '-ss', String(seek), '-i', input,
      '-an', '-sn', '-vf', filter, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
    const { stdout } = await runBuffer('ffmpeg', args, { timeoutMs });
    last = { seek, length: stdout.length };
    if (stdout.length < need) continue;
    return { buffer: Buffer.from(stdout.subarray(0, need)), t: seek };
  }
  throw new Error(`frame @${last.seek.toFixed(2)}s too small: ${last.length} < ${need}`);
}

/**
 * 把 rawvideo 画布编码成 **PNG 字节**（内存里，不落盘）。
 *
 * 宿主 `ctx.attachments.saveImage()` 会**解码**校验传入字节，所以必须给真正的
 * PNG，不能给 raw RGB（媒体类型写 image/png 但内容是裸像素 → "Unsupported or malformed image data"）。
 */
export async function encodePngBuffer(buffer, width, height, opts = {}) {
  const { timeoutMs = 60_000 } = opts;
  const { stdout } = await runBuffer('ffmpeg', ['-hide_banner', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', '-',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ], { input: buffer, timeoutMs });
  if (stdout.length < 8 || stdout[0] !== 0x89 || stdout.subarray(1, 4).toString() !== 'PNG') {
    throw new Error(`PNG encode produced ${stdout.length} bytes of non-PNG output`);
  }
  return stdout;
}
