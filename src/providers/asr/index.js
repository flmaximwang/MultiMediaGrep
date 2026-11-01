/**
 * ASR provider 工厂。
 *
 * 这一层只做三件事：
 *   1. 从环境变量解析出「用哪个 ASR、往哪儿发、用什么 key」；
 *   2. 按 provider id 造出对应的 provider 对象；
 *   3. 缺配置时**优雅降级**——不抛错、不崩 server。
 *
 * 降级规则（重要，server 集成要照着写）：
 *   - `MMGREP_ASR_PROVIDER` 没设或设为 `none` → 返回 **null**，表示「本次没有 ASR」，
 *     server 应当只返回画面内容，不要报错。
 *   - provider 明确选了（elevenlabs / openai-compatible）但没给 key → 返回一个
 *     **会在 transcribe() 时抛出清晰错误**的 provider（而不是在构造时炸），
 *     这样 server 可以在真正需要转写时才告诉用户「你少了 MMGREP_ELEVENLABS_API_KEY /
 *     MMGREP_OPENAI_COMPATIBLE_API_KEY」。
 *   - `MMGREP_ASR_PROVIDER` 是个不认识的值 → 构造时直接抛错（这是拼写错误，必须吵醒用户）。
 *
 * provider 对象契约：
 *   {
 *     id: 'elevenlabs' | 'openai-compatible' | 'none',
 *     transcribe({ audioPath, language?, mimeType?, signal? }) =>
 *       Promise<{ provider, model, language, segments: Array<{startMs, endMs, text}>, raw? }>,
 *     describe() => { id, model, baseUrl },   // 永远不含 apiKey
 *   }
 *
 * 时间单位：对外**一律整数毫秒**（startMs / endMs）。endMs 可以是 null（未知/延续到下一段）。
 */

import { createElevenLabsAsr, ELEVENLABS_DEFAULT_BASE_URL, ELEVENLABS_DEFAULT_MODEL } from './elevenlabs.js';
import {
  createOpenAICompatibleAsr,
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_MODEL,
} from './openai-compatible.js';

/** 所有可用的 ASR provider id。'none' = 明确不启用 ASR。 */
export const ASR_PROVIDERS = ['elevenlabs', 'openai-compatible', 'none'];

/** 默认超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** 默认单次请求的最大音频体积（字节） */
export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/** 默认 provider：什么都不配就只返回画面 */
export const DEFAULT_PROVIDER = 'none';

/** 每个 provider 专属的环境变量名；旧的通用变量只作兜底（config 层会记弃用 warning）。 */
const PROVIDER_ENV = Object.freeze({
  elevenlabs: Object.freeze({
    apiKey: 'MMGREP_ELEVENLABS_API_KEY',
    baseUrl: 'MMGREP_ELEVENLABS_BASE_URL',
    model: 'MMGREP_ELEVENLABS_MODEL',
  }),
  'openai-compatible': Object.freeze({
    apiKey: 'MMGREP_OPENAI_COMPATIBLE_API_KEY',
    baseUrl: 'MMGREP_OPENAI_COMPATIBLE_BASE_URL',
    model: 'MMGREP_OPENAI_COMPATIBLE_MODEL',
  }),
});

/** 0.2.0 删除：旧的「所有 ASR provider 共用一个变量」只做兼容兜底。 */
const LEGACY_ENV = Object.freeze({
  apiKey: 'MMGREP_ASR_API_KEY',
  baseUrl: 'MMGREP_ASR_BASE_URL',
  model: 'MMGREP_ASR_MODEL',
});

/** 专属变量优先，旧通用变量兜底；空串视作没配。 */
function readProviderEnv(env, providerId, field) {
  const names = PROVIDER_ENV[providerId];
  return readEnvString(env, names?.[field]) ?? readEnvString(env, LEGACY_ENV[field]);
}

function readEnvString(env, key) {
  if (!key) return undefined;
  const raw = env?.[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 按环境变量造一个 ASR provider。
 *
 * @param {object} [env]   环境变量对象，默认 process.env
 * @param {object} [opts]  覆盖项（主要用于测试）：
 *   - `provider`  强制使用某个 provider id（优先于 env）
 *   - `apiKey` / `baseUrl` / `model` / `language` / `timeoutMs`  覆盖 env
 *   - `fetchImpl` 注入的 fetch
 * @returns {object|null} provider 对象；没启用 ASR 时返回 null
 */
export function createAsrProvider(env = process.env, opts = {}) {
  const requested = normalizeProviderId(opts.provider ?? env.MMGREP_ASR_PROVIDER ?? DEFAULT_PROVIDER);

  if (!ASR_PROVIDERS.includes(requested)) {
    throw new Error(
      `Unsupported ASR provider "${requested}". MMGREP_ASR_PROVIDER must be one of: ${ASR_PROVIDERS.join(', ')}.`,
    );
  }

  // 没启用 ASR → 返回 null，让 server 走「只有画面」这条路。
  if (requested === 'none') return null;

  const apiKey = cleanEnvValue(opts.apiKey ?? readProviderEnv(env, requested, 'apiKey')) || '';
  const language = cleanEnvValue(opts.language ?? env.MMGREP_ASR_LANGUAGE) || undefined;
  const timeoutMs = positiveInt(opts.timeoutMs ?? env.MMGREP_ASR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxBytes = positiveInt(opts.maxBytes ?? env.MMGREP_ASR_MAX_BYTES, DEFAULT_MAX_BYTES);
  const baseUrl = stripTrailingSlash(
    cleanEnvValue(opts.baseUrl ?? readProviderEnv(env, requested, 'baseUrl')) || defaultBaseUrl(requested),
  );
  const model = cleanEnvValue(opts.model ?? readProviderEnv(env, requested, 'model')) || defaultModel(requested);

  // 选了 provider 却没给 key：返回一个「转写时才报错」的 provider，
  // 免得 server 在启动阶段就炸掉（server 需要能降级成「只有画面」）。
  if (!apiKey) {
    return createUnconfiguredProvider({ id: requested, model, baseUrl });
  }

  if (requested === 'elevenlabs') {
    return createElevenLabsAsr({
      apiKey,
      baseUrl,
      model,
      language,
      timeoutMs,
      maxBytes,
      diarize: parseBoolean(opts.diarize ?? env.MMGREP_ASR_DIARIZE),
      fetchImpl: opts.fetchImpl,
    });
  }

  return createOpenAICompatibleAsr({
    apiKey,
    baseUrl,
    model,
    language,
    timeoutMs,
    maxBytes,
    responseFormat: cleanEnvValue(opts.responseFormat ?? env.MMGREP_ASR_RESPONSE_FORMAT) || 'verbose_json',
    timestampGranularities: parseGranularities(
      opts.timestampGranularities ?? env.MMGREP_ASR_TIMESTAMP_GRANULARITIES,
    ),
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * 「明确不启用 ASR」的 provider。
 *
 * createAsrProvider() 在 provider 为 none 时返回 null（这是 server 判断「要不要转写」的依据）；
 * 这个函数给出的是**显式的** none provider，它的 transcribe() 会抛出说明性的错误，
 * 供上层需要「点一下就报清楚为什么没声音」的场景使用。
 */
export function createNoneAsrProvider() {
  return {
    id: 'none',
    async transcribe() {
      throw new Error(
        'No ASR provider is configured; only visual content is available. ' +
          'Set MMGREP_ASR_PROVIDER to "elevenlabs" or "openai-compatible" and provide the matching API key ' +
          '(MMGREP_ELEVENLABS_API_KEY or MMGREP_OPENAI_COMPATIBLE_API_KEY) to enable transcription.',
      );
    },
    describe() {
      return { id: 'none', model: null, baseUrl: null };
    },
  };
}

/** provider 选了但 key 缺失：构造时安静，转写时才说清楚缺哪个环境变量 */
function createUnconfiguredProvider({ id, model, baseUrl }) {
  const names = PROVIDER_ENV[id];
  return {
    id,
    async transcribe() {
      throw new Error(
        `ASR provider "${id}" is not configured: environment variable ${names.apiKey} is not set. ` +
          `Set ${names.apiKey} (and optionally ${names.baseUrl} / ${names.model}) to enable transcription, ` +
          `or set MMGREP_ASR_PROVIDER=none to disable ASR entirely.`,
      );
    },
    describe() {
      return { id, model, baseUrl };
    },
  };
}

function defaultBaseUrl(providerId) {
  return providerId === 'elevenlabs' ? ELEVENLABS_DEFAULT_BASE_URL : OPENAI_DEFAULT_BASE_URL;
}

function defaultModel(providerId) {
  return providerId === 'elevenlabs' ? ELEVENLABS_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL;
}

/** provider id 归一化：去空白、转小写 */
function normalizeProviderId(value) {
  return String(cleanEnvValue(value) ?? '').trim().toLowerCase();
}

/**
 * 读 env 时统一剥掉首尾成对的引号与空白。
 *
 * 为什么：Windows 上 `setx MMGREP_ELEVENLABS_BASE_URL "http://127.0.0.1:8000/v1"` 经过某些 shell
 * 转发后，注册表里存的是 `"http://127.0.0.1:8000/v1"`（**引号是值的一部分**），
 * 于是 fetch 报 ERR_INVALID_URL，看起来像「配置没生效」，其实是值坏了一点点。
 */
export function cleanEnvValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(["']).*\1$/s.test(trimmed)) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function stripTrailingSlash(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

function positiveInt(value, fallback) {
  const number = Number(cleanEnvValue(value));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  const text = String(cleanEnvValue(value) ?? '').toLowerCase();
  if (!text) return false;
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

/** "segment,word" → ['segment','word'] */
function parseGranularities(value) {
  if (Array.isArray(value)) {
    const list = value.map((item) => String(item).trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  const text = String(cleanEnvValue(value) ?? '');
  if (!text) return undefined;
  const list = text.split(',').map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}
