/**
 * 文档 provider 工厂（契约 v2）。
 *
 * 文档 provider 拆成**两个角色**（0.2.0，破坏性变更）：
 *
 *   ocr     从像素识别字符，只处理**没有文字层**的页（以及 ocrMode=force 的页）。
 *           env MMGREP_OCR_PROVIDER = mineru | none（默认 none）。
 *   typeset 为**有文字层**的页恢复阅读顺序与结构，**不得重新识别字符**。
 *           env MMGREP_TYPESET_PROVIDER = builtin | mineru | none（默认 builtin）。
 *
 * 每个 provider 在注册表里声明自己支持的角色：
 *   mineru  → ocr + typeset
 *   builtin → typeset（本地，不联网；文本由调用方通过 parse({ textLayers }) 传入）
 *
 * 两个角色共用 MinerU 的凭据变量（MMGREP_MINERU_*）与超时变量
 * （MMGREP_DOC_TIMEOUT_MS），不再有 MMGREP_DOC_PROVIDER / MMGREP_DOC_API_KEY /
 * MMGREP_DOC_BASE_URL / MMGREP_DOC_MODEL。
 *
 * 接口契约见同目录 README.md。
 */

import { createBuiltinTypesetProvider } from './builtin.js';
import { createMineruDocProvider } from './mineru.js';

/** provider 角色。 */
export const DOC_ROLES = Object.freeze(['ocr', 'typeset']);

/** 角色 → 环境变量名。 */
export const DOC_ROLE_ENV = Object.freeze({
  ocr: 'MMGREP_OCR_PROVIDER',
  typeset: 'MMGREP_TYPESET_PROVIDER',
});

/** 角色 → 默认 provider。 */
export const DOC_ROLE_DEFAULTS = Object.freeze({
  ocr: 'none',
  typeset: 'builtin',
});

/** provider 专属环境变量（两个角色共用同一组）。 */
export const DOC_PROVIDER_ENV = Object.freeze({
  mineru: Object.freeze({
    apiKey: 'MMGREP_MINERU_API_KEY',
    baseUrl: 'MMGREP_MINERU_BASE_URL',
    model: 'MMGREP_MINERU_MODEL',
  }),
});

/**
 * provider 注册表 v2：每个 provider 声明 `roles`，工厂按角色校验。
 *
 * `none` 不是 provider：它是「该角色关闭」的取值，工厂返回 null。
 */
export const DOC_PROVIDER_REGISTRY = Object.freeze({
  mineru: Object.freeze({
    id: 'mineru',
    roles: Object.freeze(['ocr', 'typeset']),
    create: (options) => createMineruDocProvider(options),
  }),
  builtin: Object.freeze({
    id: 'builtin',
    roles: Object.freeze(['typeset']),
    create: () => createBuiltinTypesetProvider(),
  }),
});

/** 所有已注册 provider id（不含 none）。 */
export const DOC_PROVIDERS = Object.freeze(Object.keys(DOC_PROVIDER_REGISTRY));

/** 各角色允许的取值（含 none），用于配置层 / HTTP 头的错误提示。 */
export const DOC_ROLE_PROVIDERS = Object.freeze({
  ocr: Object.freeze(['mineru', 'none']),
  typeset: Object.freeze(['builtin', 'mineru', 'none']),
});

/** 某个角色支持的 provider id（不含 none）。 */
export function providersForRole(role) {
  return DOC_PROVIDERS.filter((id) => DOC_PROVIDER_REGISTRY[id].roles.includes(role));
}

/** 某个 provider 是否支持某个角色。 */
export function providerSupportsRole(providerId, role) {
  return Boolean(DOC_PROVIDER_REGISTRY[String(providerId ?? '').toLowerCase()]?.roles.includes(role));
}

function readEnvString(source, key) {
  if (!key) return undefined;
  const raw = source?.[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 丢掉值为 undefined 的键，避免覆盖掉下层的默认值。 */
function definedOnly(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * 按角色创建文档 provider。
 *
 * @param {'ocr'|'typeset'} role
 * @param {object} [env] 环境变量对象，默认 process.env 。
 * @param {object} [opts] 覆盖项（优先级高于 env）：
 *   { provider, apiKey, baseUrl, model, timeoutMs, fetchImpl, onProgress, pollIntervalMs }
 * @returns {object|null} provider；角色取值为 'none'（或未配置）时返回 null。
 */
export function createDocProvider(role, env = process.env, opts = {}) {
  const normalizedRole = String(role ?? '').trim().toLowerCase();
  if (!DOC_ROLES.includes(normalizedRole)) {
    throw new Error(
      `Unknown document provider role "${role ?? ''}". Supported roles: ${DOC_ROLES.join(', ')}.`,
    );
  }

  const source = env && typeof env === 'object' ? env : {};
  const overrides = opts && typeof opts === 'object' ? opts : {};
  const envName = DOC_ROLE_ENV[normalizedRole];

  // opts.provider 优先于环境变量（测试 / server 显式选择时用）。
  const raw = String(overrides.provider ?? source[envName] ?? DOC_ROLE_DEFAULTS[normalizedRole])
    .trim()
    .toLowerCase();

  if (raw === '' || raw === 'none') return null;

  const entry = DOC_PROVIDER_REGISTRY[raw];
  if (!entry) {
    throw new Error(
      `Unsupported ${envName} "${raw}" for the ${normalizedRole} role. ` +
        `Supported providers: ${DOC_ROLE_PROVIDERS[normalizedRole].join(', ')}.`,
    );
  }
  if (!entry.roles.includes(normalizedRole)) {
    throw new Error(
      `Provider "${raw}" does not support the ${normalizedRole} role (it supports: ${entry.roles.join(', ')}). ` +
        `Use ${DOC_ROLE_PROVIDERS[normalizedRole].join(' / ')} for ${envName}.`,
    );
  }

  const { provider: _provider, role: _role, ...providerOpts } = overrides;

  if (raw === 'builtin') {
    return entry.create();
  }

  const envSpec = DOC_PROVIDER_ENV[raw] ?? {};
  const timeoutRaw = source.MMGREP_DOC_TIMEOUT_MS;
  const fromEnv = {
    apiKey: readEnvString(source, envSpec.apiKey) ?? '',
    baseUrl: readEnvString(source, envSpec.baseUrl),
    model: readEnvString(source, envSpec.model) ?? '',
    timeoutMs: timeoutRaw === undefined || timeoutRaw === '' ? undefined : Number(timeoutRaw),
  };

  return entry.create({
    ...definedOnly(fromEnv),
    ...definedOnly(providerOpts),
    role: normalizedRole,
  });
}

export { createBuiltinTypesetProvider, createMineruDocProvider };
