// src/server/config.js —— server 配置层：读契约 §12 的环境变量，给全套默认值。
//
// 两条硬规则：
//   1. **绝不以任何形式输出 API key**：describeConfig() 只回答「有没有配」，不回答「配的是什么」。
//   2. 环境变量写错时**不崩 server**：用默认值 + 记一条 warning，让 probe 的 capabilities 能把原因讲清楚。
//
// 注意：这里不 import src/cache 或 src/providers/*——那些模块可能由别的 agent 同时改，
// 配置层只持有「值」，不持有「实现」。

import os from 'node:os';
import path from 'node:path';

/** 契约 §12.1：缓存上限默认 10 GiB */
export const DEFAULT_CACHE_MAX_BYTES = 10 * 1024 ** 3;

/** 契约 §12.1：缓存目录默认 ~/.cache/multimediagrep */
export const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'multimediagrep');

/** 契约 §12.5：单次调用图片 token 软预算 */
export const DEFAULT_MAX_IMAGE_TOKENS = 4000;
/** 契约 §10.2：单图最长边硬上限 */
export const DEFAULT_MAX_IMAGE_EDGE = 1600;
/** 契约 §12.5：内联文本字符上限 */
export const DEFAULT_MAX_TEXT_INLINE_CHARS = 24000;
/** 契约 §12.5：HTTP 请求头覆盖内联上限时的硬上限（防客户端把响应撑爆） */
export const MAX_TEXT_INLINE_CHARS_HARD_CAP = 200000;
/** 契约 §12.5：并行任务数 */
export const DEFAULT_MAX_CONCURRENCY = 2;
/** 契约 §4.3.1 / §12.5：音频体检阈值 */
export const DEFAULT_AUDIO_MIN_DBFS = -35;
export const DEFAULT_AUDIO_MIN_SPEECH_RATIO = 0.05;
/** 契约 §12.5：provider 超时 */
export const DEFAULT_ASR_TIMEOUT_MS = 120000;
export const DEFAULT_DOC_TIMEOUT_MS = 180000;
/** 契约 §12.2 / §12.3：默认基址与模型（按 provider 分组） */
export const DEFAULT_ASR_BASE_URL = 'https://api.elevenlabs.io/v1';
export const DEFAULT_ASR_MODEL = 'scribe_v1';
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'whisper-1';
export const DEFAULT_DOC_BASE_URL = 'https://mineru.net/api/v4';
export const DEFAULT_DOC_MODEL = '';

/* ------------------------------------------------------------------ *
 * 传输方式（stdio / http）
 * ------------------------------------------------------------------ */

/** 默认走 stdio：MCP 客户端最常见的方式，不用开端口、不用鉴权 */
export const DEFAULT_TRANSPORT_MODE = 'stdio';
/** 目前只支持这两种传输方式 */
export const TRANSPORT_MODES = Object.freeze(['stdio', 'http']);
/** HTTP 默认只监听回环地址：本机自用不该暴露到网络上 */
export const DEFAULT_HTTP_HOST = '127.0.0.1';
/** HTTP 默认端口 */
export const DEFAULT_HTTP_PORT = 3927;

/**
 * 文档 provider 的两个角色（契约 v2）：
 *   ocr     只处理没有文字层的页；默认 none。
 *   typeset 只处理有文字层的页，不得重新识别字符；默认 builtin。
 */
export const DOC_ROLE_ENV = Object.freeze({
  ocr: 'MMGREP_OCR_PROVIDER',
  typeset: 'MMGREP_TYPESET_PROVIDER',
});

export const DOC_ROLE_DEFAULTS = Object.freeze({
  ocr: 'none',
  typeset: 'builtin',
});

/** 各角色允许的取值（含 none）。与 src/providers/doc 的注册表保持一致。 */
export const DOC_ROLE_PROVIDERS = Object.freeze({
  ocr: Object.freeze(['mineru', 'none']),
  typeset: Object.freeze(['builtin', 'mineru', 'none']),
});

/**
 * provider → 环境变量组。选哪个 provider 就只读哪一组，互不串用。
 *
 * 键名固定为 apiKey / baseUrl / model，值是**该 provider 专属**的环境变量名；
 * defaultBaseUrl / defaultModel 是该 provider 自己的默认值。
 *
 * `doc` 现在是**外部文档 provider 的凭据组**（MinerU），由 ocr / typeset 两个角色
 * 共用；它不再是一个「选哪个 provider」的配置段。
 */
export const PROVIDER_ENV = Object.freeze({
  asr: Object.freeze({
    elevenlabs: Object.freeze({
      apiKey: 'MMGREP_ELEVENLABS_API_KEY',
      baseUrl: 'MMGREP_ELEVENLABS_BASE_URL',
      model: 'MMGREP_ELEVENLABS_MODEL',
      defaultBaseUrl: DEFAULT_ASR_BASE_URL,
      defaultModel: DEFAULT_ASR_MODEL,
    }),
    'openai-compatible': Object.freeze({
      apiKey: 'MMGREP_OPENAI_COMPATIBLE_API_KEY',
      baseUrl: 'MMGREP_OPENAI_COMPATIBLE_BASE_URL',
      model: 'MMGREP_OPENAI_COMPATIBLE_MODEL',
      defaultBaseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
      defaultModel: DEFAULT_OPENAI_COMPATIBLE_MODEL,
    }),
  }),
  doc: Object.freeze({
    mineru: Object.freeze({
      apiKey: 'MMGREP_MINERU_API_KEY',
      baseUrl: 'MMGREP_MINERU_BASE_URL',
      model: 'MMGREP_MINERU_MODEL',
      defaultBaseUrl: DEFAULT_DOC_BASE_URL,
      defaultModel: DEFAULT_DOC_MODEL,
    }),
  }),
});

/** 旧的「所有 ASR provider 共用一个」变量：专属变量未设置时兜底，并记弃用 warning。 */
const LEGACY_ENV = Object.freeze({
  asr: Object.freeze({
    apiKey: 'MMGREP_ASR_API_KEY',
    baseUrl: 'MMGREP_ASR_BASE_URL',
    model: 'MMGREP_ASR_MODEL',
  }),
});

const PROVIDER_ENV_VAR = Object.freeze({
  asr: 'MMGREP_ASR_PROVIDER',
});

/**
 * 0.2.0 删除的文档 provider 变量：不再读取，只负责在启动时给出可操作的 warning。
 * 值是替代变量的说明（错误信息里只出现变量名，不出现变量值）。
 */
const LEGACY_DOC_ENV = Object.freeze({
  MMGREP_DOC_PROVIDER:
    'use MMGREP_OCR_PROVIDER for pages without a text layer and MMGREP_TYPESET_PROVIDER for pages with one (default: builtin)',
  MMGREP_DOC_API_KEY: 'use MMGREP_MINERU_API_KEY',
  MMGREP_DOC_BASE_URL: 'use MMGREP_MINERU_BASE_URL',
  MMGREP_DOC_MODEL: 'use MMGREP_MINERU_MODEL',
});

/** provider=none 时仍保持旧内部形状的默认值（不读任何 provider 变量）。 */
const NONE_DEFAULTS = Object.freeze({
  asr: Object.freeze({ baseUrl: DEFAULT_ASR_BASE_URL, model: DEFAULT_ASR_MODEL }),
});

/**
 * 取某个 provider 的某个配置项：专属变量优先，旧的通用变量兜底。
 * warning 里只出现变量名 / provider id，**永远不含变量值**。
 */
function readProviderSetting(env, kind, provider, field, warnings) {
  const spec = PROVIDER_ENV[kind][provider];
  const primary = spec[field];
  const legacy = LEGACY_ENV[kind]?.[field];

  const primaryValue = readString(env, primary);
  if (primaryValue !== undefined) return { value: primaryValue, source: primary };

  if (!legacy) return { value: undefined, source: null };
  const legacyValue = readString(env, legacy);
  if (legacyValue === undefined) return { value: undefined, source: null };

  warnings.push(`${legacy} is deprecated for provider "${provider}"; use ${primary} instead.`);
  if (kind === 'asr' && provider === 'openai-compatible' && field === 'model') {
    warnings.push(
      `${legacy} was shared across ASR providers and may not be valid for "openai-compatible"; ` +
        `use ${primary} instead (default: ${spec.defaultModel}).`,
    );
  }
  return { value: legacyValue, source: legacy };
}

/**
 * 解析一个 provider 分组（asr / doc），产出旧内部形状：
 * { provider, apiKey, apiKeySource, baseUrl, model }。
 */
function resolveProviderSection(kind, requestedProvider, env, warnings) {
  const noneDefaults = NONE_DEFAULTS[kind];
  if (requestedProvider === 'none') {
    return {
      provider: 'none',
      apiKey: '',
      apiKeySource: null,
      baseUrl: noneDefaults.baseUrl,
      model: noneDefaults.model,
    };
  }

  const spec = PROVIDER_ENV[kind][requestedProvider];
  if (!spec) {
    const envName = PROVIDER_ENV_VAR[kind];
    warnings.push(
      `${envName} is "${requestedProvider}", which is not a supported provider ` +
        `(${Object.keys(PROVIDER_ENV[kind]).join(', ')}, none); falling back to "none".`,
    );
    return {
      provider: 'none',
      apiKey: '',
      apiKeySource: null,
      baseUrl: noneDefaults.baseUrl,
      model: noneDefaults.model,
    };
  }

  const apiKey = readProviderSetting(env, kind, requestedProvider, 'apiKey', warnings);
  const baseUrl = readProviderSetting(env, kind, requestedProvider, 'baseUrl', warnings);
  const model = readProviderSetting(env, kind, requestedProvider, 'model', warnings);

  return {
    provider: requestedProvider,
    apiKey: apiKey.value ?? '',
    apiKeySource: apiKey.source,
    baseUrl: baseUrl.value ?? spec.defaultBaseUrl,
    model: model.value ?? spec.defaultModel,
  };
}

/**
 * 读外部文档 provider（MinerU）的专属变量：**没有旧 MMGREP_DOC_* 兜底**。
 * 旧变量只在启动时 warn，不再影响行为。
 */
function readExternalProviderSetting(env, provider, field) {
  const spec = PROVIDER_ENV.doc?.[provider];
  if (!spec) return { value: undefined, source: null };
  const primary = spec[field];
  const value = readString(env, primary);
  return { value, source: value === undefined ? null : primary };
}

/** 解析一个文档角色（ocr / typeset）的 provider 与凭据。 */
function resolveDocRoleSection(role, requestedProvider, env, warnings) {
  const envName = DOC_ROLE_ENV[role];
  const allowed = DOC_ROLE_PROVIDERS[role];
  const fallback = DOC_ROLE_DEFAULTS[role];
  let provider = String(requestedProvider ?? fallback).trim().toLowerCase();
  if (provider === '') provider = fallback;

  if (!allowed.includes(provider)) {
    warnings.push(
      `${envName} is "${provider}", which is not a supported ${role} provider ` +
        `(${allowed.join(', ')}); falling back to "${fallback}".`,
    );
    provider = fallback;
  }

  // none / builtin 不需要凭据；baseUrl / model 保留内置默认值，方便 describeConfig 输出。
  if (provider === 'none' || provider === 'builtin') {
    return {
      provider,
      apiKey: '',
      apiKeySource: null,
      baseUrl: DEFAULT_DOC_BASE_URL,
      model: DEFAULT_DOC_MODEL,
    };
  }

  const apiKey = readExternalProviderSetting(env, provider, 'apiKey');
  const baseUrl = readExternalProviderSetting(env, provider, 'baseUrl');
  const model = readExternalProviderSetting(env, provider, 'model');
  const spec = PROVIDER_ENV.doc[provider];

  return {
    provider,
    apiKey: apiKey.value ?? '',
    apiKeySource: apiKey.source,
    baseUrl: baseUrl.value ?? spec.defaultBaseUrl,
    model: model.value ?? spec.defaultModel,
  };
}

/** 0.2.0 删除的变量：设置过就明确 warn，绝不静默忽略。 */
function warnLegacyDocEnv(env, warnings) {
  for (const [name, replacement] of Object.entries(LEGACY_DOC_ENV)) {
    if (readString(env, name) === undefined) continue;
    warnings.push(`${name} was removed in 0.2.0 and is ignored; ${replacement}.`);
  }
}

/** 取某 provider 的变量组（未知 provider 返回 null）。 */
export function providerEnv(kind, providerId) {
  return PROVIDER_ENV[kind]?.[String(providerId ?? '').toLowerCase()] ?? null;
}

/** 缺 key 报错时应点名的环境变量；未知 provider 回落到旧的通用名。 */
export function providerApiKeyEnv(kind, providerId) {
  return providerEnv(kind, providerId)?.apiKey ?? LEGACY_ENV[kind]?.apiKey ?? 'MMGREP_API_KEY';
}

/** server 身份（与 package.json 保持一致的硬编码，避免运行时读包信息） */
export const SERVER_NAME = 'multimediagrep';
export const SERVER_VERSION = '0.1.0';

const LOG_LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

/** 读字符串：去空白；空串视作没配 */
function readString(env, key) {
  const raw = env?.[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 读整数；非法值回落默认并记 warning（契约 §12「配错时用默认值」） */
function readInt(env, key, fallback, { min = -Infinity, max = Infinity, warnings } = {}) {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const number = Number(raw);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) {
    warnings?.push(`${key} is invalid ("${raw}"); using the default ${fallback}.`);
    return fallback;
  }
  return number;
}

/** 读浮点数；非法值回落默认 */
function readNumber(env, key, fallback, { min = -Infinity, max = Infinity, warnings } = {}) {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < min || number > max) {
    warnings?.push(`${key} is invalid ("${raw}"); using the default ${fallback}.`);
    return fallback;
  }
  return number;
}

/** 读布尔：1/true/yes/on 为真，0/false/no/off 为假，其它回落默认 */
function readBool(env, key, fallback, { warnings } = {}) {
  const raw = readString(env, key);
  if (raw === undefined) return fallback;
  const text = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  warnings?.push(`${key} is invalid ("${raw}"); using the default ${fallback}.`);
  return fallback;
}

/**
 * 读传输方式：只认 stdio / http，写错就回落 stdio 并记 warning。
 * 传输方式写错时**绝不能崩**——回落到 stdio 至少还能正常服务。
 */
function readTransportMode(env, warnings) {
  const raw = readString(env, 'MMGREP_TRANSPORT');
  if (raw === undefined) return DEFAULT_TRANSPORT_MODE;
  const mode = raw.toLowerCase();
  if (TRANSPORT_MODES.includes(mode)) return mode;
  warnings.push(
    `MMGREP_TRANSPORT is invalid ("${raw}"); using the default "${DEFAULT_TRANSPORT_MODE}" `
      + `(supported: ${TRANSPORT_MODES.join(', ')}).`,
  );
  return DEFAULT_TRANSPORT_MODE;
}

/**
 * 判断监听地址是不是「只有本机能连」。
 *
 * 与 src/server/index.js 的 isLoopbackUrl **故意不同**：那里 0.0.0.0 当作「本地基址」，
 * 但这里 0.0.0.0 / :: 意味着绑定所有网卡——那是对外暴露，必须当成非回环。
 */
export function isLoopbackHost(host) {
  if (!host) return false;
  const text = String(host).trim().toLowerCase();
  if (text === 'localhost') return true;
  // 去掉 IPv6 的方括号与 zone id（fe80::1%en0）
  const bare = text.replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
  if (bare === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** 缓存目录：`~` 展开；相对路径按 cwd 解析（与 cache 模块的语义一致） */
function readCacheDir(env, warnings) {
  const raw = readString(env, 'MMGREP_CACHE_DIR');
  if (raw === undefined) return DEFAULT_CACHE_DIR;
  if (raw === '~') return os.homedir();
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  try {
    return path.resolve(process.cwd(), expanded);
  } catch {
    warnings.push(`MMGREP_CACHE_DIR is invalid ("${raw}"); using the default ${DEFAULT_CACHE_DIR}.`);
    return DEFAULT_CACHE_DIR;
  }
}

/** 缓存上限：支持 "10GB" / "512MB" / 纯字节数；非法值回落默认 */
function readCacheMaxBytes(env, warnings) {
  const raw = readString(env, 'MMGREP_CACHE_MAX_BYTES');
  if (raw === undefined) return DEFAULT_CACHE_MAX_BYTES;
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)?$/i.exec(raw);
  if (!match) {
    warnings.push(`MMGREP_CACHE_MAX_BYTES is invalid ("${raw}"); using the default ${DEFAULT_CACHE_MAX_BYTES}.`);
    return DEFAULT_CACHE_MAX_BYTES;
  }
  const units = { '': 1, B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
  const bytes = Math.floor(Number(match[1]) * (units[(match[2] ?? '').toUpperCase()] ?? 1));
  return Number.isFinite(bytes) && bytes >= 0 ? bytes : DEFAULT_CACHE_MAX_BYTES;
}

/**
 * 读取全部 MMGREP_* 环境变量，产出 server 的配置对象。
 *
 * @param {object} [env] 环境变量对象（默认 process.env；测试可注入）
 * @returns {Readonly<object>} 冻结的配置；`warnings` 里收集了所有「配错回落默认」的记录
 */
export function loadConfig(env = process.env) {
  const warnings = [];

  const asrProvider = (readString(env, 'MMGREP_ASR_PROVIDER') ?? 'none').toLowerCase();
  const ocrProvider = (readString(env, DOC_ROLE_ENV.ocr) ?? DOC_ROLE_DEFAULTS.ocr).toLowerCase();
  const typesetProvider = (readString(env, DOC_ROLE_ENV.typeset) ?? DOC_ROLE_DEFAULTS.typeset).toLowerCase();
  const logLevelRaw = (readString(env, 'MMGREP_LOG_LEVEL') ?? 'info').toLowerCase();
  const logLevel = LOG_LEVELS[logLevelRaw] === undefined ? 'info' : logLevelRaw;
  if (LOG_LEVELS[logLevelRaw] === undefined) {
    warnings.push(`MMGREP_LOG_LEVEL is invalid ("${logLevelRaw}"); using "info".`);
  }

  const asrSection = resolveProviderSection('asr', asrProvider, env, warnings);
  const ocrSection = resolveDocRoleSection('ocr', ocrProvider, env, warnings);
  const typesetSection = resolveDocRoleSection('typeset', typesetProvider, env, warnings);
  const docTimeoutMs = readInt(env, 'MMGREP_DOC_TIMEOUT_MS', DEFAULT_DOC_TIMEOUT_MS, { min: 1, warnings });
  warnLegacyDocEnv(env, warnings);

  const transportMode = readTransportMode(env, warnings);
  const httpHost = readString(env, 'MMGREP_HTTP_HOST') ?? DEFAULT_HTTP_HOST;
  const httpPort = readInt(env, 'MMGREP_HTTP_PORT', DEFAULT_HTTP_PORT, { min: 1, max: 65535, warnings });
  // 令牌本身是敏感值：这里只存原文给鉴权用，**任何日志路径都不许打印它**
  // （describeConfig 只回答 set / unset）。
  const httpToken = readString(env, 'MMGREP_HTTP_TOKEN') ?? '';

  // 监听非回环地址又不配令牌 = 端点裸奔在网络上，必须提醒。
  if (!isLoopbackHost(httpHost) && !httpToken) {
    warnings.push(
      `MMGREP_HTTP_HOST is not a loopback address ("${httpHost}") and MMGREP_HTTP_TOKEN is not set; `
        + 'the HTTP endpoint would accept unauthenticated requests.',
    );
  }

  const config = {
    server: Object.freeze({ name: SERVER_NAME, version: SERVER_VERSION }),
    transport: Object.freeze({
      mode: transportMode,
      host: httpHost,
      port: httpPort,
      token: httpToken,
    }),
    cache: Object.freeze({
      dir: readCacheDir(env, warnings),
      maxBytes: readCacheMaxBytes(env, warnings),
    }),
    asr: Object.freeze({
      ...asrSection,
      language: readString(env, 'MMGREP_ASR_LANGUAGE') ?? 'auto',
      timeoutMs: readInt(env, 'MMGREP_ASR_TIMEOUT_MS', DEFAULT_ASR_TIMEOUT_MS, { min: 1, warnings }),
    }),
    ocr: Object.freeze({ ...ocrSection, timeoutMs: docTimeoutMs }),
    typeset: Object.freeze({ ...typesetSection, timeoutMs: docTimeoutMs }),
    images: Object.freeze({
      maxTokens: readInt(env, 'MMGREP_MAX_IMAGE_TOKENS', DEFAULT_MAX_IMAGE_TOKENS, { min: 1, warnings }),
      maxEdge: readInt(env, 'MMGREP_MAX_IMAGE_EDGE', DEFAULT_MAX_IMAGE_EDGE, { min: 1, warnings }),
    }),
    text: Object.freeze({
      maxInlineChars: readInt(env, 'MMGREP_MAX_TEXT_INLINE_CHARS', DEFAULT_MAX_TEXT_INLINE_CHARS, { min: 1, warnings }),
    }),
    audio: Object.freeze({
      minDbfs: readNumber(env, 'MMGREP_AUDIO_MIN_DBFS', DEFAULT_AUDIO_MIN_DBFS, { max: 0, warnings }),
      minSpeechRatio: readNumber(env, 'MMGREP_AUDIO_MIN_SPEECH_RATIO', DEFAULT_AUDIO_MIN_SPEECH_RATIO, { min: 0, max: 1, warnings }),
    }),
    runtime: Object.freeze({
      concurrency: readInt(env, 'MMGREP_MAX_CONCURRENCY', DEFAULT_MAX_CONCURRENCY, { min: 1, warnings }),
    }),
    tools: Object.freeze({
      ffmpegPath: readString(env, 'MMGREP_FFMPEG_PATH') ?? null,
      ffprobePath: readString(env, 'MMGREP_FFPROBE_PATH') ?? null,
    }),
    progress: Object.freeze({
      // 契约 §2.6 只要求 best-effort；这个开关是本 server 的运维扩展（契约 §12 未列），
      // 默认开启，宿主不支持 notifications/progress 时由框架静默跳过。
      enabled: readBool(env, 'MMGREP_PROGRESS_NOTIFICATIONS', true, { warnings }),
    }),
    logLevel,
    warnings: Object.freeze(warnings),
  };
  return Object.freeze(config);
}

/**
 * 用命令行参数覆盖传输配置：**CLI > 环境变量 > 默认值**。
 *
 * 只覆盖 transport 这一段——后端、provider、缓存这些跟传输方式无关，
 * 命令行也管不着。
 *
 * @param {object} config loadConfig() 的结果
 * @param {object} [overrides] { mode?, host?, port?, token? }；值为 undefined 表示「不覆盖」
 * @returns {Readonly<object>} 新的配置对象（原来那个保持不变）
 */
export function applyTransportOverrides(config, overrides = {}) {
  const current = config.transport ?? {};
  const next = {
    mode: overrides.mode ?? current.mode ?? DEFAULT_TRANSPORT_MODE,
    host: overrides.host ?? current.host ?? DEFAULT_HTTP_HOST,
    port: overrides.port ?? current.port ?? DEFAULT_HTTP_PORT,
    token: overrides.token ?? current.token ?? '',
  };
  return Object.freeze({ ...config, transport: Object.freeze(next) });
}

/**
 * 给日志/启动信息用的脱敏视图：**永远不含 apiKey 原文**。
 */
export function describeConfig(config) {
  return {
    server: `${config.server.name}@${config.server.version}`,
    transport: {
      mode: config.transport?.mode ?? DEFAULT_TRANSPORT_MODE,
      host: config.transport?.host ?? DEFAULT_HTTP_HOST,
      port: config.transport?.port ?? DEFAULT_HTTP_PORT,
      // 只回答「有没有配」，永远不回答「配的是什么」
      token: config.transport?.token ? 'set' : 'unset',
    },
    cache: { dir: config.cache.dir, maxBytes: config.cache.maxBytes },
    asr: {
      provider: config.asr.provider,
      apiKey: config.asr.apiKey ? 'set' : 'unset',
      baseUrl: config.asr.baseUrl,
      model: config.asr.model,
      language: config.asr.language,
      timeoutMs: config.asr.timeoutMs,
    },
    ocr: {
      provider: config.ocr.provider,
      apiKey: config.ocr.apiKey ? 'set' : 'unset',
      baseUrl: config.ocr.baseUrl,
      model: config.ocr.model,
      timeoutMs: config.ocr.timeoutMs,
    },
    typeset: {
      provider: config.typeset.provider,
      apiKey: config.typeset.apiKey ? 'set' : 'unset',
      baseUrl: config.typeset.baseUrl,
      model: config.typeset.model,
      timeoutMs: config.typeset.timeoutMs,
    },
    images: { maxTokens: config.images.maxTokens, maxEdge: config.images.maxEdge },
    text: { maxInlineChars: config.text.maxInlineChars },
    audio: { minDbfs: config.audio.minDbfs, minSpeechRatio: config.audio.minSpeechRatio },
    runtime: { concurrency: config.runtime.concurrency },
    tools: { ffmpegPath: config.tools.ffmpegPath, ffprobePath: config.tools.ffprobePath },
    progress: { enabled: config.progress.enabled },
    logLevel: config.logLevel,
    warnings: config.warnings,
  };
}

/**
 * 最小 logger：**只写 stderr**。
 *
 * MCP 的 stdout 是协议通道，任何一行非协议内容都会让 client 解析失败，
 * 所以这里的 stream 默认锁死为 process.stderr，且不提供改 stdout 的入口。
 */
export function createLogger({ level = 'info', stream = process.stderr } = {}) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const write = (levelName, args) => {
    const line = `[mmgrep] ${levelName}: ${args
      .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
      .join(' ')}`;
    stream.write(`${line}\n`);
  };
  const logger = {
    level,
    error: (...args) => { if (threshold >= LOG_LEVELS.error) write('error', args); },
    warn: (...args) => { if (threshold >= LOG_LEVELS.warn) write('warn', args); },
    info: (...args) => { if (threshold >= LOG_LEVELS.info) write('info', args); },
    debug: (...args) => { if (threshold >= LOG_LEVELS.debug) write('debug', args); },
  };
  return logger;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
