/**
 * 文档解析 provider 工厂。
 *
 * 文档后端（PDF + 图片）在遇到「扫描件 / 无文本层」的页面时，需要把页面交给外部
 * 文档解析服务做 OCR。服务商可插拔：用户在 agent 的 MCP 配置里用环境变量指定用哪家、
 * 给 token，server 照单接受；没配就不调外部服务，只返回页面图让多模态模型自己看。
 *
 * 环境变量：
 *   MMGREP_DOC_PROVIDER          'mineru' | 'none'（默认 'none'）
 *   MMGREP_MINERU_API_KEY        token
 *   MMGREP_MINERU_BASE_URL       默认 https://mineru.net/api/v4
 *   MMGREP_MINERU_MODEL          默认留空（用服务端默认模型）
 *   MMGREP_DOC_TIMEOUT_MS        默认 300000
 *
 * 旧的 MMGREP_DOC_API_KEY / MMGREP_DOC_BASE_URL / MMGREP_DOC_MODEL 仅在专属变量
 * 未设置时兜底（0.2.0 删除）。
 *
 * 接口契约见同目录 README.md。
 */

import { createMineruDocProvider } from './mineru.js';

/** 支持的 provider id。 */
export const DOC_PROVIDERS = ['mineru', 'none'];

/** provider 专属环境变量；旧通用变量只作兜底。 */
const PROVIDER_ENV = Object.freeze({
  mineru: Object.freeze({
    apiKey: 'MMGREP_MINERU_API_KEY',
    baseUrl: 'MMGREP_MINERU_BASE_URL',
    model: 'MMGREP_MINERU_MODEL',
  }),
});

const LEGACY_ENV = Object.freeze({
  apiKey: 'MMGREP_DOC_API_KEY',
  baseUrl: 'MMGREP_DOC_BASE_URL',
  model: 'MMGREP_DOC_MODEL',
});

/** 专属变量优先，旧通用变量兜底；空串视作没配。 */
function readProviderEnv(source, providerId, field) {
  const names = PROVIDER_ENV[providerId];
  return readEnvString(source, names?.[field]) ?? readEnvString(source, LEGACY_ENV[field]);
}

function readEnvString(source, key) {
  if (!key) return undefined;
  const raw = source?.[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 根据环境变量创建文档解析 provider。
 *
 * @param {object} [env] 环境变量对象，默认 process.env 。
 * @param {object} [opts] 覆盖项（例如 { fetchImpl, onProgress, timeoutMs }），优先级高于 env 。
 * @returns {object|null} provider；'none'（或未配置）时返回 null，server 据此降级为「只出页面图」。
 */
export function createDocProvider(env = process.env, opts = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const overrides = opts && typeof opts === 'object' ? opts : {};
  // opts.provider 优先于环境变量（测试 / server 强制指定时用）。
  const raw = String(overrides.provider ?? source.MMGREP_DOC_PROVIDER ?? 'none')
    .trim()
    .toLowerCase();

  // 'none' / 未配置 → 不调外部服务，server 走「只返回页面图」的降级路径。
  if (raw === '' || raw === 'none') return null;

  if (raw === 'mineru') {
    const timeoutRaw = source.MMGREP_DOC_TIMEOUT_MS;
    const fromEnv = {
      apiKey: readProviderEnv(source, 'mineru', 'apiKey') ?? '',
      baseUrl: readProviderEnv(source, 'mineru', 'baseUrl'),
      model: readProviderEnv(source, 'mineru', 'model') ?? '',
      timeoutMs: timeoutRaw === undefined || timeoutRaw === '' ? undefined : Number(timeoutRaw),
    };
    const { provider: _provider, ...providerOpts } = overrides;
    return createMineruDocProvider({
      ...definedOnly(fromEnv),
      ...definedOnly(providerOpts),
    });
  }

  throw new Error(
    `Unsupported MMGREP_DOC_PROVIDER "${raw}". Supported providers: ${DOC_PROVIDERS.join(', ')}.`,
  );
}

/** 丢掉值为 undefined 的键，避免覆盖掉下层的默认值。 */
function definedOnly(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export { createMineruDocProvider };
