// src/media/ffmpeg.js —— ffmpeg / ffprobe 的公共封装
// 只做「跑命令 + 解析输出」，媒体语义留给各后端。所有调用都不经过 shell。

import { spawn } from 'node:child_process';

import { ToolError } from './interface.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 32 * 1024 * 1024;
// runBuffer 的 stdout 上限：rawvideo 一帧就有几 MB，64 MiB 足以覆盖正常帧流；
// 超限时只保留前 64 MiB 并继续排空管道，避免子进程因管道写满而卡死。
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** 环境变量覆盖：把工具名映射到部署机上的绝对路径 */
const ENV_BY_BINARY = Object.freeze({
  ffmpeg: 'MMGREP_FFMPEG_PATH',
  ffprobe: 'MMGREP_FFPROBE_PATH',
});

/**
 * 把 'ffmpeg' / 'ffprobe' 解析成实际要 spawn 的命令。
 * 环境变量在调用时读取（而不是模块加载时），这样 server 启动后改配置、
 * 以及测试在 import 之后再设置 env 都能生效。空白值视同未设置，
 * 避免 `MMGREP_FFMPEG_PATH=" "` 把 PATH 查找弄坏。
 */
export function resolveBinary(name) {
  const envVar = ENV_BY_BINARY[name];
  if (!envVar) return name;
  const raw = process.env[envVar];
  if (typeof raw !== 'string') return name;
  const trimmed = raw.trim();
  return trimmed || name;
}

/** ENOENT 时的提示：点名覆盖用的环境变量，否则用户只会看到「not on PATH」而不知道还能显式指定 */
function toolNotFoundMessage(name, command) {
  const envVar = ENV_BY_BINARY[name];
  if (!envVar) return `${name} is not installed or not on PATH.`;
  if (command !== name) {
    return `${name} was not found at "${command}" (from ${envVar}). Point ${envVar} at the binary or unset it to fall back to PATH.`;
  }
  return `${name} is not installed or not on PATH (set ${envVar} to an absolute path if it lives elsewhere).`;
}

/**
 * 跑一个子进程，收集 stdout/stderr。
 * 二进制缺失 → TOOL_NOT_FOUND（契约 §2.4）；超时/非零退出 → INTERNAL。
 */
export function run(bin, args, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, allowNonZero = false } = {}) {
  return new Promise((resolve, reject) => {
    const command = resolveBinary(bin);
    let child;
    try {
      // signal 可能是 null（server 的调用上下文用 null 表示「没有取消信号」）；
      // 直接传给 spawn 会抛 TypeError，被误报成 TOOL_NOT_FOUND。
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    } catch (err) {
      reject(new ToolError('TOOL_NOT_FOUND', `${bin} is not available: ${err.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new ToolError('INTERNAL', `${bin} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new ToolError('TOOL_NOT_FOUND', toolNotFoundMessage(bin, command)));
      } else {
        reject(new ToolError('INTERNAL', `${bin} failed to start: ${err.message}`));
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !allowNonZero) {
        const tail = stderr.trim().split('\n').slice(-4).join(' | ');
        reject(new ToolError('INTERNAL', `${bin} exited with code ${code}: ${tail}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 与 run() 相同，但 stdout 以 Buffer 收集，并可通过 input 往 stdin 写入二进制。
 * rawvideo 帧流不能经过 UTF-8 字符串：chunk.toString() 会把非法字节替换成 U+FFFD，
 * 后续按字节解析像素就会错位，所以这里全程保持 Buffer。
 * 错误映射与 run() 一致：ENOENT → TOOL_NOT_FOUND，超时/非零退出 → INTERNAL。
 */
export function runBuffer(bin, args, { input = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const command = resolveBinary(bin);
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    } catch (err) {
      reject(new ToolError('TOOL_NOT_FOUND', `${bin} is not available: ${err.message}`));
      return;
    }

    const chunks = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new ToolError('INTERNAL', `${bin} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    // 子进程提前退出（例如参数错误）时写 stdin 会得到 EPIPE；
    // 吞掉该错误，结果统一由 close/error 事件决定。
    child.stdin.on('error', () => {});
    child.stdin.end(input == null ? undefined : Buffer.isBuffer(input) ? input : Buffer.from(input));

    child.stdout.on('data', (chunk) => {
      const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
      if (remaining <= 0) return; // 超限后继续排空管道，但不占内存
      const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      chunks.push(kept);
      stdoutBytes += kept.length;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new ToolError('TOOL_NOT_FOUND', toolNotFoundMessage(bin, command)));
      } else {
        reject(new ToolError('INTERNAL', `${bin} failed to start: ${err.message}`));
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-4).join(' | ');
        reject(new ToolError('INTERNAL', `${bin} exited with code ${code}: ${tail}`));
        return;
      }
      resolve({ code, stdout: Buffer.concat(chunks, stdoutBytes), stderr });
    });
  });
}

/** ffprobe -print_format json：容器与流信息 */
export async function ffprobeJson(filePath, { timeoutMs, signal } = {}) {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs, signal },
  );
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new ToolError('INTERNAL', `ffprobe returned invalid JSON for "${filePath}": ${err.message}`);
  }
}

/** volumedetect：全片平均/峰值音量（dBFS） */
export async function measureLevels(filePath, opts = {}) {
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', filePath, '-map', '0:a:0', '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
    { ...opts, allowNonZero: true },
  );
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  const max = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  return {
    meanDbfs: mean ? Number(mean[1]) : null,
    peakDbfs: max ? Number(max[1]) : null,
  };
}

/**
 * silencedetect：静音区间。
 * 短时 RMS 低于 noiseDb 且持续 minDurationSec 秒算静音（契约 §4.3.1 默认 -45 dBFS / 0.3s）。
 */
export async function detectSilence(filePath, { noiseDb = -45, minDurationSec = 0.3, ...opts } = {}) {
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', filePath, '-map', '0:a:0', '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`, '-f', 'null', '-'],
    { ...opts, allowNonZero: true },
  );
  const ranges = [];
  let pendingStart = null;
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start) {
      pendingStart = Math.max(0, Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (end && pendingStart !== null) {
      const endSec = Number(end[1]);
      ranges.push({ startSec: pendingStart, endSec, durationSec: Math.max(0, endSec - pendingStart) });
      pendingStart = null;
    }
  }
  // 录音以静音结尾时，只有 silence_start、没有 silence_end
  if (pendingStart !== null) {
    ranges.push({ startSec: pendingStart, endSec: null, durationSec: null });
  }
  return ranges;
}

/** 规范化成 ASR 友好的 WAV：16 kHz 单声道、限带、loudnorm（不覆盖原文件） */
export async function normalizeToWav(input, output, opts = {}) {
  const {
    sampleRate = 16000,
    channels = 1,
    filter = 'highpass=f=80,lowpass=f=8000,loudnorm=I=-18:TP=-1.5',
    ...rest
  } = opts;
  await run(
    'ffmpeg',
    ['-y', '-v', 'error', '-i', input, '-ar', String(sampleRate), '-ac', String(channels), '-af', filter, output],
    rest,
  );
  return output;
}

/** 波形图（音频包络）：PNG */
export async function renderWaveform(input, output, { width = 1200, height = 300, color = '0x4a9eff', ...opts } = {}) {
  await run(
    'ffmpeg',
    [
      '-y', '-v', 'error', '-i', input,
      '-filter_complex', `aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=${color}`,
      '-frames:v', '1', output,
    ],
    opts,
  );
  return output;
}

/** 契约 §2.4：ffmpeg/ffprobe 缺失 → TOOL_NOT_FOUND */
export async function assertFfmpegAvailable(opts = {}) {
  try {
    await run('ffprobe', ['-version'], { ...opts, timeoutMs: 10_000 });
  } catch (err) {
    if (err instanceof ToolError && err.code === 'TOOL_NOT_FOUND') {
      throw new ToolError(
        'TOOL_NOT_FOUND',
        'ffprobe is required but was not found on PATH. Install ffmpeg (which bundles ffprobe), or set MMGREP_FFPROBE_PATH to an absolute path, and retry.',
      );
    }
    throw err;
  }
}
