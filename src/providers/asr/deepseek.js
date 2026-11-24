/**
 * DeepSeek ASR 适配器。
 *
 * 协议：
 *   - 端点：POST {baseUrl}/tools/asr（baseUrl 默认 https://api.deepseek.com/v1）
 *   - 认证：请求头 `Authorization: Bearer <key>`
 *   - 请求体：multipart/form-data，**只有 file 一个字段**。
 *     DeepSeek `/v1/tools/asr` 不接受 model / language：语言自动判定，也没有模型选择参数。
 *     支持 16-bit PCM WAV（8000–48000 Hz，单/双声道）或 Ogg Opus。
 *   - 响应：{ request_id, text, duration_ms }
 *     duration_ms 是整个音频的毫秒时长（没有分段），所以这里只能给出**单段全文**。
 *
 * 分段策略：DeepSeek 不返回分段，`text` 非空时退化成单段全文
 * （startMs=0，endMs=duration_ms；没有 duration_ms 时 endMs=null）。
 *
 * 时间单位：本模块对外**一律用整数毫秒**（startMs / endMs）。
 *
 * 边界：单次调用。DeepSeek 单请求上限 8 MiB，超出请在上层切成 ≤45s 的片段后再逐片调用。
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
/** DeepSeek `/v1/tools/asr` 没有模型选择参数，默认模型留空（对外表现为 null）。 */
export const DEEPSEEK_DEFAULT_MODEL = '';

/** 单次请求的默认超时（毫秒）—— 与 index.js 的 DEFAULT_TIMEOUT_MS 保持一致 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** DeepSeek 单请求允许的最大音频体积（字节）：8 MiB。超出请在上层切片。 */
export const DEEPSEEK_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
};

/**
 * 造一个 DeepSeek ASR provider。
 *
 * @param {object} opts
 * @param {string} opts.apiKey      DeepSeek API key（不会出现在返回值/错误里）
 * @param {string} [opts.baseUrl]   默认 https://api.deepseek.com/v1
 * @param {string} [opts.model]     默认 ''（DeepSeek 没有模型选择参数）
 * @param {string} [opts.language]  语言代码（如 'zh' / 'en'）；DeepSeek 自动判定，仅用于回填
 * @param {number} [opts.timeoutMs] 默认 120000
 * @param {number} [opts.maxBytes]  单次请求的最大音频字节数，默认 8 MiB
 * @param {Function} [opts.fetchImpl] 注入的 fetch（测试用），默认 globalThis.fetch
 * @returns {{id:'deepseek', transcribe:Function, describe:Function}}
 */
export function createDeepSeekAsr({
  apiKey,
  baseUrl = DEEPSEEK_DEFAULT_BASE_URL,
  model = DEEPSEEK_DEFAULT_MODEL,
  language,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEEPSEEK_DEFAULT_MAX_BYTES,
  fetchImpl,
} = {}) {
  const root = stripTrailingSlash(baseUrl);
  const endpoint = `${root}/tools/asr`;

  return {
    id: 'deepseek',

    /**
     * 调一次 DeepSeek 的转写接口。
     *
     * @param {object} args
     * @param {string} args.audioPath  本地音频文件路径
     * @param {string} [args.language] 覆盖 provider 级语言（DeepSeek 自动判定，仅回填）
     * @param {string} [args.mimeType] 上传时的 MIME（默认按扩展名猜）
     * @param {AbortSignal} [args.signal] 调用方的取消信号
     * @returns {Promise<{provider:string, model:string|null, language:string|null, segments:Array<{startMs:number,endMs:number|null,text:string}>, raw:object}>}
     */
    async transcribe({ audioPath, language: languageOverride, mimeType, signal } = {}) {
      if (!audioPath) {
        throw new Error('DeepSeek ASR: "audioPath" is required.');
      }
      if (!apiKey) {
        // 正常情况下 index.js 会在缺 key 时直接返回一个「会报错」的 provider，根本走不到这里。
        throw new Error(
          'DeepSeek ASR is not configured: environment variable MMGREP_DEEPSEEK_API_KEY is not set.',
        );
      }

      const buffer = await readFile(audioPath);
      if (buffer.byteLength > maxBytes) {
        throw new Error(
          `DeepSeek ASR: audio file is ${buffer.byteLength} bytes, over the ${maxBytes} byte limit for a single request. ` +
            'Split the audio into chunks of at most 45 seconds and transcribe each chunk separately (see src/providers/asr/README.md).',
        );
      }

      const languageCode = normalizeLanguageCode(languageOverride ?? language);
      const form = new FormData();
      // DeepSeek 只认 file 字段：model / language 都不能发（/v1/tools/asr 没有这两个参数）。
      form.append(
        'file',
        new Blob([buffer], { type: mimeType ?? guessMimeType(audioPath) }),
        fileNameFor(audioPath),
      );

      const fetchFn = fetchImpl ?? globalThis.fetch;
      if (typeof fetchFn !== 'function') {
        throw new Error('DeepSeek ASR: no fetch implementation available (globalThis.fetch is undefined).');
      }

      const { signal: requestSignal, timeoutSignal } = buildRequestSignal(timeoutMs, signal);

      let response;
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: requestSignal,
        });
      } catch (error) {
        throw buildRequestError(error, { endpoint, timeoutMs, signal, timeoutSignal });
      }

      const bodyText = await response.text().catch(() => '');
      if (!response.ok) {
        throw new Error(
          `DeepSeek ASR request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ` +
            `${redact(truncate(bodyText, 500), apiKey)} (endpoint: ${endpoint})`,
        );
      }

      let payload;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        throw new Error(
          `DeepSeek ASR returned a non-JSON response (HTTP ${response.status}): ` +
            `${redact(truncate(bodyText, 500), apiKey)} (endpoint: ${endpoint})`,
        );
      }

      return {
        provider: 'deepseek',
        // DeepSeek 没有模型选择参数：配置里给了就回填，没给就是 null。
        model: model || null,
        language: languageCode ?? null,
        segments: parseDeepSeekResponse(payload),
        raw: payload,
      };
    },

    /** 描述这次要往哪儿发请求。**永远不含 apiKey。** */
    describe() {
      return { id: 'deepseek', model: model || null, baseUrl: root };
    },
  };
}

/**
 * 把 DeepSeek 的响应变成 { startMs, endMs, text } 数组。
 *
 * DeepSeek 只返回整段 `text` + `duration_ms`，没有分段信息：
 *   - `text` 非空 → 单段全文，endMs = duration_ms（缺失/非法时为 null）；
 *   - `text` 为空/纯空白 → 空数组（没有可说出口的词）。
 *
 * @param {object} payload DeepSeek 的响应 JSON
 * @returns {Array<{startMs:number, endMs:number|null, text:string}>}
 */
export function parseDeepSeekResponse(payload) {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text) return [];

  const endMs =
    Number.isFinite(Number(payload?.duration_ms)) && Number(payload.duration_ms) >= 0
      ? Math.round(Number(payload.duration_ms))
      : null;
  return [{ startMs: 0, endMs, text }];
}

/**
 * 语言码归一化。配置层用 `auto` 表示「由 provider 自动判定」，但服务商那边
 * 的语义是「不传该字段」——这里不发语言字段，`auto` 归一成 undefined（对外即 null）。
 */
function normalizeLanguageCode(language) {
  const value = typeof language === 'string' ? language.trim() : '';
  return value && value.toLowerCase() !== 'auto' ? value : undefined;
}

/** 组合「超时信号」与「调用方信号」 */
function buildRequestSignal(timeoutMs, external) {
  const safeTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(safeTimeout);
  if (!external) return { signal: timeoutSignal, timeoutSignal };

  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([timeoutSignal, external]), timeoutSignal };
  }
  // 老 Node 的兜底
  const controller = new AbortController();
  const relay = (from) => () => controller.abort(from?.reason);
  if (external.aborted) controller.abort(external.reason);
  else external.addEventListener('abort', relay(external), { once: true });
  timeoutSignal.addEventListener('abort', relay(timeoutSignal), { once: true });
  return { signal: controller.signal, timeoutSignal };
}

/** 把 fetch 的失败展开成可诊断的原因（"fetch failed" 本身什么都不说） */
function buildRequestError(error, { endpoint, timeoutMs, signal, timeoutSignal }) {
  if (signal?.aborted) {
    return new Error(`DeepSeek ASR request was aborted by the caller (endpoint: ${endpoint}).`);
  }
  if (timeoutSignal?.aborted) {
    return new Error(
      `DeepSeek ASR request timed out after ${timeoutMs} ms (endpoint: ${endpoint}). ` +
        'Shorten the audio (chunk to at most 45 seconds) or raise MMGREP_ASR_TIMEOUT_MS.',
    );
  }
  return new Error(
    `DeepSeek ASR request failed: ${explainFetchError(error)} (endpoint: ${endpoint}).`,
  );
}

/** fetch 错误的可读原因 */
function explainFetchError(error) {
  const parts = [String(error?.message ?? error)];
  const cause = error?.cause;
  if (cause) {
    const code = cause.code || cause.errno || '';
    const message = cause.message || String(cause);
    if (message && message !== parts[0]) parts.push(`${code ? `${code}: ` : ''}${message}`.trim());
  }
  return parts.join(' — ');
}

/** 打码：任何可能回显 key 的地方都先替换掉 */
function redact(text, secret) {
  let out = String(text ?? '');
  if (secret && typeof secret === 'string' && secret.length >= 4) {
    out = out.split(secret).join('***');
  }
  return out;
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function stripTrailingSlash(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

/** 按扩展名猜 MIME，认不出来就用通用二进制 */
export function guessMimeType(audioPath) {
  const ext = extname(String(audioPath ?? '')).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** 上传时的文件名：保留原名，没有扩展名就补一个 */
function fileNameFor(audioPath) {
  const name = basename(String(audioPath ?? ''));
  return name && extname(name) ? name : `${name || 'audio'}.bin`;
}
