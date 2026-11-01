// src/server/credentials.js —— HTTP 请求级覆盖：把请求头解析成「只属于本次请求」的配置。
//
// 为什么需要这一层：HTTP 端点常常被多个调用方共用（同一台机器上的多个 agent、网关后面的
// 多个用户），他们不该被迫共用服务器启动时的那一把 API key，也不该被迫共用同一个内联上限。
// 请求头是唯一合适的载体：
//   - query string 会进访问日志 / 浏览器历史 / 代理日志，绝不能放 key；
//   - 请求体是 MCP 协议报文，不能塞旁路配置；
//   - 自定义头既不会落进 URL，也能被调用方逐请求替换。
//
// 三条安全规则（改这个文件前先读）：
//   1. 头里的值只进「本次请求」的 config / provider：不缓存、不落盘、不回显。
//   2. requestOverrides 只记录**用到了哪些头（名字）**，绝不记录头的值。
//   3. 空头（'' / 全空白）等于没带：调用方清空某个头不该意外覆盖服务器配置。
//
// 优先级（逐字段、逐 provider 计算）：
//   provider 专属头 > 通用 x-mmgrep-<kind>-api-key 头（仅 apiKey）
//   > 所选 provider 专属环境变量 > 服务器 baseConfig（仅当两边 provider 相同）
//   > provider 内置默认值。
// 注意：请求头切换 provider 时**只查新 provider 的变量组**，绝不会借用旧 provider 的 key。
//
// 非凭据设置走同一套「环境变量名 → 请求头名」映射（HEADER_CONFIG_*），但优先级只有
// 请求头 > baseConfig（env / 默认值）：它们不是秘密，不参与凭据检测与日志脱敏。

import { ToolError } from '../media/interface.js';
import {
  DEFAULT_MAX_TEXT_INLINE_CHARS,
  MAX_TEXT_INLINE_CHARS_HARD_CAP,
  PROVIDER_ENV,
} from './config.js';

/** 环境变量名 → 请求头名：MMGREP_ELEVENLABS_API_KEY → x-mmgrep-elevenlabs-api-key */
function headerName(envName) {
  return envName.toLowerCase().replace(/^mmgrep_/, 'x-mmgrep-').replace(/_/g, '-');
}

/**
 * 请求头表。结构刻意与 PROVIDER_ENV 对齐：
 *   REQUEST_HEADERS[kind].provider          provider 选择头
 *   REQUEST_HEADERS[kind].genericApiKey     旧的「共用」key 头（兜底，带弃用语义）
 *   REQUEST_HEADERS[kind].providers[id]     该 provider 专属的 apiKey / baseUrl / model 头
 *
 * 全部小写：Node 的 req.headers 键本来就是小写，比较时不用再做大小写归一。
 * 这张表由 PROVIDER_ENV 生成，provider 增删时不会和配置层漂移。
 */
function buildKindHeaders(kind) {
  const providers = {};
  for (const [providerId, spec] of Object.entries(PROVIDER_ENV[kind])) {
    providers[providerId] = Object.freeze({
      apiKey: headerName(spec.apiKey),
      baseUrl: headerName(spec.baseUrl),
      model: headerName(spec.model),
    });
  }
  return Object.freeze({
    provider: headerName(`MMGREP_${kind.toUpperCase()}_PROVIDER`),
    genericApiKey: headerName(`MMGREP_${kind.toUpperCase()}_API_KEY`),
    providers: Object.freeze(providers),
  });
}

export const REQUEST_HEADERS = Object.freeze({
  asr: buildKindHeaders('asr'),
  doc: buildKindHeaders('doc'),
});

/**
 * 全部认得的凭据头（固定顺序：先 provider，再各 provider 的专属头，最后通用兜底头）。
 * 用于「这个请求到底带没带凭据」与「该屏蔽哪些值」。
 */
function collectHeaderNames() {
  const names = [];
  for (const kind of ['asr', 'doc']) {
    const spec = REQUEST_HEADERS[kind];
    names.push(spec.provider);
    for (const provider of Object.values(spec.providers)) {
      names.push(provider.apiKey, provider.baseUrl, provider.model);
    }
    names.push(spec.genericApiKey);
  }
  return Object.freeze(names);
}

export const CREDENTIAL_HEADERS = collectHeaderNames();

/**
 * 非凭据的请求级设置头。与凭据头用**同一套** env → 头名映射规则
 * （MMGREP_FOO_BAR → x-mmgrep-foo-bar），这样新增设置时不用再发明命名。
 *
 * 键名是 config 里的字段名，值是请求头名。
 */
export const HEADER_CONFIG_HEADERS = Object.freeze({
  maxTextInlineChars: headerName('MMGREP_MAX_TEXT_INLINE_CHARS'),
});

/** 全部认得非凭据设置头（固定顺序）。 */
const HEADER_CONFIG_NAMES = Object.freeze(Object.values(HEADER_CONFIG_HEADERS));

/** 归一化头对象：键转小写（容忍测试/代理传进来的非小写键），只保留字符串值。 */
function normalizeHeaders(headers) {
  const out = Object.create(null);
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string') continue;
    const name = String(key).toLowerCase();
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/** 读一个头：去空白；空串视作「没带」。 */
function readHeader(headers, name) {
  const raw = headers?.[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 读环境变量：去空白；空串视作「没配」（与 config.js 的 readString 同口径）。 */
function readEnv(env, name) {
  const raw = env?.[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 本请求实际带了的凭据头名（按固定顺序）。
 * 长度为 0 表示「没有覆盖」——调用方应原样复用共享 runtime。
 */
export function presentCredentialHeaders(headers) {
  const normalized = normalizeHeaders(headers);
  return CREDENTIAL_HEADERS.filter((name) => readHeader(normalized, name) !== undefined);
}

/**
 * 本请求实际带了的非凭据设置头名（固定顺序）。
 * 长度为 0 表示「没有请求级设置覆盖」——即使别的头在场，也可以复用共享 runtime。
 */
export function presentConfigHeaders(headers) {
  const normalized = normalizeHeaders(headers);
  return HEADER_CONFIG_NAMES.filter((name) => readHeader(normalized, name) !== undefined);
}

/**
 * 本请求带了的凭据头的值，供日志脱敏用。
 * **只给 logger 包装器用**：调用方不得把它写进日志 / 响应 / 缓存。
 */
export function credentialHeaderValues(headers) {
  const normalized = normalizeHeaders(headers);
  const values = [];
  for (const name of CREDENTIAL_HEADERS) {
    const value = readHeader(normalized, name);
    if (value !== undefined) values.push(value);
  }
  // 长的先替换，避免短值先替换后把长值拆碎（例如 key 是另一个 key 的前缀）。
  return values.sort((a, b) => b.length - a.length);
}

/**
 * 未知 provider 时报错：消息里列出允许值。
 * 刻意**不回显收到的值**——调用方可能误把 key 填进 provider 头，错误响应不该原样弹回去。
 */
function unsupportedProvider(kind, header) {
  const allowed = Object.keys(PROVIDER_ENV[kind]);
  return new ToolError(
    'INVALID_ARGUMENT',
    `${header} is not a supported ${kind.toUpperCase()} provider. `
      + `Allowed values: ${allowed.join(', ')}.`,
  );
}

/** 字段名 → PROVIDER_ENV 里的默认值键名 */
const DEFAULT_FIELD = Object.freeze({ baseUrl: 'defaultBaseUrl', model: 'defaultModel' });

/**
 * 解析一个 provider 分组（asr / doc）。
 *
 * @param {'asr'|'doc'} kind
 * @param {object} baseSection baseConfig.asr / baseConfig.doc
 * @param {object} headers 已归一化（小写键）的头对象
 * @param {object} env 服务器环境变量
 * @returns {{section: object, used: object}}
 */
function resolveSection(kind, baseSection, headers, env) {
  const headerSpec = REQUEST_HEADERS[kind];
  const envSpec = PROVIDER_ENV[kind];
  const base = baseSection ?? {};
  const baseProvider = String(base.provider ?? 'none').trim().toLowerCase();

  const used = { provider: null, apiKey: null, baseUrl: null, model: null };

  const providerHeaderValue = readHeader(headers, headerSpec.provider);
  let provider = baseProvider;
  if (providerHeaderValue !== undefined) {
    const normalizedId = providerHeaderValue.toLowerCase();
    if (!Object.hasOwn(envSpec, normalizedId)) {
      throw unsupportedProvider(kind, headerSpec.provider);
    }
    provider = normalizedId;
    used.provider = headerSpec.provider;
  }

  // 没有启用 provider（none / 未知历史值）：没有可覆盖的 provider 字段，原样保留 base。
  if (!Object.hasOwn(envSpec, provider)) {
    return { section: { ...base, provider: base.provider ?? 'none' }, used };
  }

  const spec = envSpec[provider];
  const providerHeaders = headerSpec.providers[provider];
  const sameAsBase = baseProvider === provider;

  /**
   * 逐字段取优先级最高的值，同时记下「这个值从哪个头来的」（只记名字）。
   * base 只在 provider 相同时参与兜底——否则会把另一个 provider 的 key 借过来。
   */
  const pick = (field) => {
    const fromHeader = readHeader(headers, providerHeaders[field]);
    if (fromHeader !== undefined) {
      used[field] = providerHeaders[field];
      return { value: fromHeader, source: providerHeaders[field] };
    }

    // 通用 key 头是「旧共用变量」的头等价物：只在 apiKey 上兜底一次。
    if (field === 'apiKey') {
      const generic = readHeader(headers, headerSpec.genericApiKey);
      if (generic !== undefined) {
        used.apiKey = headerSpec.genericApiKey;
        return { value: generic, source: headerSpec.genericApiKey };
      }
    }

    const envName = spec[field];
    const envValue = readEnv(env, envName);
    if (envValue !== undefined) return { value: envValue, source: envName };

    if (sameAsBase) {
      const baseValue = base[field];
      if (field === 'apiKey') {
        return {
          value: typeof baseValue === 'string' ? baseValue : '',
          source: base.apiKeySource ?? null,
        };
      }
      if (typeof baseValue === 'string' && baseValue !== '') {
        return { value: baseValue, source: null };
      }
    }

    if (field === 'apiKey') return { value: '', source: null };
    return { value: spec[DEFAULT_FIELD[field]], source: null };
  };

  const apiKey = pick('apiKey');
  const baseUrl = pick('baseUrl');
  const model = pick('model');

  return {
    section: {
      ...base,
      provider,
      apiKey: apiKey.value,
      apiKeySource: apiKey.source,
      baseUrl: baseUrl.value,
      model: model.value,
    },
    used,
  };
}

/**
 * 解析请求级内联文本上限。优先级：请求头 > baseConfig（env / 默认 24000）。
 *
 * 与 provider 头不同，这个头**不合法也不报错**：配置类设置配错只记 warning 并回落到
 * 服务器侧的值，不能让一个可选调优毁掉整次请求。
 *   - 非正整数（含 0 / 负数 / 小数 / 带单位）→ warn，回落 baseConfig；
 *   - 超过硬上限 200000 → warn，按上限截断；
 *   - 空头已在 readHeader 里当成「没带」。
 *
 * warning 里刻意**不回显头值**：http.js 的约定是日志只出现头名，不出现头的值。
 */
function resolveMaxTextInlineChars(baseSection, headers, logger) {
  const name = HEADER_CONFIG_HEADERS.maxTextInlineChars;
  const base = baseSection ?? {};
  const fallback = Number.isFinite(base.maxInlineChars) && base.maxInlineChars > 0
    ? base.maxInlineChars
    : DEFAULT_MAX_TEXT_INLINE_CHARS;

  const raw = readHeader(headers, name);
  if (raw === undefined) return { value: fallback, used: null };

  const parsed = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger?.warn?.(`${name} is invalid; using the configured value ${fallback}.`);
    return { value: fallback, used: null };
  }
  if (parsed > MAX_TEXT_INLINE_CHARS_HARD_CAP) {
    logger?.warn?.(`${name} exceeds the hard cap ${MAX_TEXT_INLINE_CHARS_HARD_CAP}; clamping to the cap.`);
    return { value: MAX_TEXT_INLINE_CHARS_HARD_CAP, used: name };
  }
  return { value: parsed, used: name };
}

/**
 * 按请求头计算本次请求的配置。
 *
 * 返回**新的冻结对象**：形状与 loadConfig() 一致，另外多一个 `requestOverrides`
 * （只含用到的头名，供 handler 说明来源，绝不含值）。baseConfig 本身不会被改动。
 *
 * @param {object} baseConfig loadConfig() 的结果
 * @param {object} headers Node 的 req.headers（键已小写；这里也会再归一化一次）
 * @param {object} [env] 服务器环境变量（默认 process.env）
 * @param {object} [options]
 * @param {object} [options.logger] 配置类头的 warning 走这里（只含头名，不含值）
 * @returns {Readonly<object>}
 * @throws {ToolError} provider 头不是已知 id 时，code = INVALID_ARGUMENT
 */
export function resolveConfigForRequest(baseConfig, headers = {}, env = process.env, options = {}) {
  const logger = options.logger ?? null;
  const normalized = normalizeHeaders(headers);
  const overridesHeaderNames = presentCredentialHeaders(normalized);

  const asr = resolveSection('asr', baseConfig?.asr, normalized, env);
  const doc = resolveSection('doc', baseConfig?.doc, normalized, env);
  const maxInlineChars = resolveMaxTextInlineChars(baseConfig?.text, normalized, logger);

  const config = {
    ...baseConfig,
    asr: Object.freeze({ ...(baseConfig?.asr ?? {}), ...asr.section }),
    doc: Object.freeze({ ...(baseConfig?.doc ?? {}), ...doc.section }),
    text: Object.freeze({ ...(baseConfig?.text ?? {}), maxInlineChars: maxInlineChars.value }),
    requestOverrides: Object.freeze({
      // 只有名字：任何值都不许出现在这里（它可能被 handler / 调试端点序列化）。
      present: Object.freeze(overridesHeaderNames),
      asr: Object.freeze(asr.used),
      doc: Object.freeze(doc.used),
      text: Object.freeze({ maxInlineChars: maxInlineChars.used }),
    }),
  };
  return Object.freeze(config);
}
