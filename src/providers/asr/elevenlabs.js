/**
 * ElevenLabs Speech-to-Text（Scribe）适配器。
 *
 * 官方文档：https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 *   - 端点：POST {baseUrl}/speech-to-text（baseUrl 默认 https://api.elevenlabs.io/v1）
 *   - 认证：请求头 `xi-api-key: <key>`（不是 Authorization）
 *   - 请求体：multipart/form-data，字段 file / model_id / language_code / diarize /
 *     timestamps_granularity
 *   - 响应：{ text, language_code, language_probability, words: [...] }
 *     words[] 每项含 { text, start, end, type, speaker_id, logprob }，**start/end 单位是秒**；
 *     type 取 word / spacing / audio_event。
 *
 * 分段策略（按优先级）：
 *   1. 响应里带 `segments[]` → 直接采用（这是 API 自己给的句级切分）；
 *   2. 只有 `words[]` → 按「相邻词间隙 > 0.6s 视为断句」聚合成句子级片段；
 *   3. 只有 `text` → 退化成单段全文（startMs=0，endMs=null）。
 *
 * 时间单位：本模块对外**一律用整数毫秒**（startMs / endMs），秒→毫秒在 toMs() 里做。
 *
 * 边界：单次调用。≤45s 的分块由上层 server 负责（见 README.md）；
 * 本模块只负责「一次调用」，并对超大的文件给出清晰报错，避免把几十分钟的音频直接甩给云端。
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export const ELEVENLABS_DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';
export const ELEVENLABS_DEFAULT_MODEL = 'scribe_v1';

/** 相邻两个词之间超过这个间隙（秒）就断句 */
const SENTENCE_GAP_SECONDS = 0.6;

/** 单次请求的默认超时（毫秒）—— 与 index.js 的 DEFAULT_TIMEOUT_MS 保持一致 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 单次请求允许的最大音频体积（字节）。超出请在上层切成 ≤45s 的片段后再逐片调用。 */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

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
 * 造一个 ElevenLabs ASR provider。
 *
 * @param {object} opts
 * @param {string} opts.apiKey      ElevenLabs API key（不会出现在返回值/错误里）
 * @param {string} [opts.baseUrl]   默认 https://api.elevenlabs.io/v1
 * @param {string} [opts.model]     默认 scribe_v1
 * @param {string} [opts.language]  语言代码（如 'zh' / 'en'），可被 transcribe() 覆盖
 * @param {number} [opts.timeoutMs] 默认 120000
 * @param {number} [opts.maxBytes]  单次请求的最大音频字节数，默认 100MB
 * @param {boolean} [opts.diarize]  是否请求说话人分离，默认 false
 * @param {Function} [opts.fetchImpl] 注入的 fetch（测试用），默认 globalThis.fetch
 * @returns {{id:'elevenlabs', transcribe:Function, describe:Function}}
 */
export function createElevenLabsAsr({
  apiKey,
  baseUrl = ELEVENLABS_DEFAULT_BASE_URL,
  model = ELEVENLABS_DEFAULT_MODEL,
  language,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  diarize = false,
  fetchImpl,
} = {}) {
  const root = stripTrailingSlash(baseUrl);
  const endpoint = `${root}/speech-to-text`;

  return {
    id: 'elevenlabs',

    /**
     * 调一次 ElevenLabs，转写整个音频文件。
     *
     * @param {object} args
     * @param {string} args.audioPath  本地音频文件路径
     * @param {string} [args.language] 覆盖 provider 级语言
     * @param {string} [args.mimeType]  上传时的 MIME（默认按扩展名猜）
     * @param {AbortSignal} [args.signal] 调用方的取消信号
     * @returns {Promise<{provider:string, model:string, language:string|null, segments:Array<{startMs:number,endMs:number|null,text:string}>, raw:object}>}
     */
    async transcribe({ audioPath, language: languageOverride, mimeType, signal } = {}) {
      if (!audioPath) {
        throw new Error('ElevenLabs ASR: "audioPath" is required.');
      }
      if (!apiKey) {
        // 正常情况下 index.js 会在缺 key 时直接返回一个「会报错」的 provider，根本走不到这里。
        throw new Error(
          'ElevenLabs ASR is not configured: environment variable MMGREP_ELEVENLABS_API_KEY is not set.',
        );
      }

      const buffer = await readFile(audioPath);
      if (buffer.byteLength > maxBytes) {
        throw new Error(
          `ElevenLabs ASR: audio file is ${buffer.byteLength} bytes, over the ${maxBytes} byte limit for a single request. ` +
            'Split the audio into chunks of at most 45 seconds and transcribe each chunk separately (see src/providers/asr/README.md).',
        );
      }

      const languageCode = languageOverride ?? language;
      const form = new FormData();
      form.append(
        'file',
        new Blob([buffer], { type: mimeType ?? guessMimeType(audioPath) }),
        fileNameFor(audioPath),
      );
      form.append('model_id', model);
      if (languageCode) form.append('language_code', languageCode);
      form.append('diarize', diarize ? 'true' : 'false');
      // 明确要词级时间戳，否则拿不到 words[] 里的 start/end，就没法自己聚合句子。
      form.append('timestamps_granularity', 'word');

      const fetchFn = fetchImpl ?? globalThis.fetch;
      if (typeof fetchFn !== 'function') {
        throw new Error('ElevenLabs ASR: no fetch implementation available (globalThis.fetch is undefined).');
      }

      const { signal: requestSignal, timeoutSignal } = buildRequestSignal(timeoutMs, signal);

      let response;
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey },
          body: form,
          signal: requestSignal,
        });
      } catch (error) {
        throw buildRequestError(error, { endpoint, timeoutMs, signal, timeoutSignal });
      }

      const bodyText = await response.text().catch(() => '');
      if (!response.ok) {
        throw new Error(
          `ElevenLabs ASR request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ` +
            `${redact(truncate(bodyText, 500), apiKey)} (endpoint: ${endpoint})`,
        );
      }

      let payload;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        throw new Error(
          `ElevenLabs ASR returned a non-JSON response (HTTP ${response.status}): ` +
            `${redact(truncate(bodyText, 500), apiKey)} (endpoint: ${endpoint})`,
        );
      }

      const segments = parseElevenLabsSegments(payload);
      return {
        provider: 'elevenlabs',
        model: typeof payload?.model === 'string' && payload.model ? payload.model : model,
        language: typeof payload?.language_code === 'string' && payload.language_code
          ? payload.language_code
          : (languageCode ?? null),
        segments,
        raw: payload,
      };
    },

    /** 描述这次要往哪儿发请求。**永远不含 apiKey。** */
    describe() {
      return { id: 'elevenlabs', model, baseUrl: root };
    },
  };
}

/**
 * 把 ElevenLabs 的响应变成 { startMs, endMs, text } 数组。
 *
 * 优先用 API 自带的 `segments[]`；没有就用 `words[]` 自己聚合；再没有就用 `text` 兜底。
 */
export function parseElevenLabsSegments(payload) {
  const apiSegments = Array.isArray(payload?.segments) ? payload.segments : [];
  if (apiSegments.length > 0) {
    const mapped = finalizeSegments(
      apiSegments.map((seg) => ({
        startSec: Number(seg?.start),
        endSec: Number(seg?.end),
        text: textOf(seg),
      })),
    );
    if (mapped.length > 0) return mapped;
  }

  const words = Array.isArray(payload?.words) ? payload.words : [];
  if (words.length > 0) {
    const mapped = finalizeSegments(groupWordsIntoSentences(words));
    if (mapped.length > 0) return mapped;
  }

  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  return text ? [{ startMs: 0, endMs: null, text }] : [];
}

/**
 * 把词级数组聚合成句子级片段。
 *
 * 断句规则：相邻两个词之间的时间间隙 > SENTENCE_GAP_SECONDS（0.6s）就另起一段。
 * 读法上，一句话中间的停顿通常远小于 0.6s，而换话题/换句子的停顿明显更长。
 *
 * @param {Array<object>} words [{ text, start, end, type }]，start/end 单位秒
 * @returns {Array<{startSec:number,endSec:number,text:string}>}
 */
export function groupWordsIntoSentences(words) {
  const usable = (Array.isArray(words) ? words : [])
    .map((word) => ({
      start: Number(word?.start),
      end: Number(word?.end),
      text: typeof word?.text === 'string' ? word.text.trim() : '',
    }))
    .filter((word) => Number.isFinite(word.start) && word.text !== '')
    .sort((a, b) => a.start - b.start);

  if (usable.length === 0) return [];

  const sentences = [];
  let current = null;
  for (const word of usable) {
    const wordEnd = Number.isFinite(word.end) ? word.end : word.start;
    // 间隙过大 → 上一句结束，另起一句
    if (current && word.start - current.endSec > SENTENCE_GAP_SECONDS) {
      sentences.push(current);
      current = null;
    }
    if (!current) {
      current = { startSec: word.start, endSec: wordEnd, text: word.text };
    } else {
      current.text = `${current.text} ${word.text}`;
      current.endSec = Math.max(current.endSec, wordEnd);
    }
  }
  if (current) sentences.push(current);
  return sentences;
}

/** 秒 → 整数毫秒 */
function toMs(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000);
}

/** 秒级片段 → 对外的 { startMs, endMs, text }，过滤空文本并按时间升序 */
function finalizeSegments(sentences) {
  return (Array.isArray(sentences) ? sentences : [])
    .map((sentence) => {
      const text = String(sentence?.text ?? '').trim();
      if (!text) return null;
      const startMs = toMs(sentence.startSec);
      const endRaw = sentence.endSec;
      const hasEnd = endRaw !== null && endRaw !== undefined && endRaw !== ''
        && Number.isFinite(Number(endRaw));
      const endMs = hasEnd ? toMs(endRaw) : null;
      return { startMs, endMs: endMs === null ? null : Math.max(endMs, startMs), text };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs || (a.endMs ?? 0) - (b.endMs ?? 0));
}

/** segments[] 里的文本：优先 text，其次把 words[] 拼起来 */
function textOf(segment) {
  if (typeof segment?.text === 'string' && segment.text.trim()) return segment.text.trim();
  if (Array.isArray(segment?.words)) {
    const joined = segment.words
      .map((word) => (typeof word?.text === 'string' ? word.text : typeof word?.word === 'string' ? word.word : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    if (joined) return joined;
  }
  return '';
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
    return new Error(`ElevenLabs ASR request was aborted by the caller (endpoint: ${endpoint}).`);
  }
  if (timeoutSignal?.aborted) {
    return new Error(
      `ElevenLabs ASR request timed out after ${timeoutMs} ms (endpoint: ${endpoint}). ` +
        'Shorten the audio (chunk to at most 45 seconds) or raise MMGREP_ASR_TIMEOUT_MS.',
    );
  }
  return new Error(`ElevenLabs ASR request failed: ${explainFetchError(error)} (endpoint: ${endpoint}).`);
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
