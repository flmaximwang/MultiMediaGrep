// src/server/index.js —— server 组装：运行时上下文 + McpServer 创建
//
// 分层：
//   createRuntime()  —— 读配置、装缓存、装 provider、装后端（失败一律降级，不崩）
//   createServer()   —— 建 McpServer、写入 instructions、注册 5 个工具
//   src/index.js     —— 入口：connect(StdioServerTransport)，日志只走 stderr
//
// 测试可以只调用 createServer({ config, backends, ... }) 注入 stub 后端，不需要真的起进程。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createDispatcher } from '../media/interface.js';
import { createPlaceholderBackend, loadBackends } from './backends.js';
import {
  SERVER_NAME,
  SERVER_VERSION,
  createLogger,
  loadConfig,
} from './config.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { registerTools } from './tools.js';

/** 回环地址不需要 API key（契约 §12.2 / §12.3） */
export function isLoopbackUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 装缓存。模块缺失 / 构造失败 → 返回 null（overview 的全文落盘会退回临时目录）。
 * 缓存是「加速 + 归档」，不是功能前提，绝不能因为它起不来。
 */
async function loadCache(config, logger) {
  try {
    const mod = await import('../cache/index.js');
    if (typeof mod.createCache !== 'function') {
      logger.warn('the cache module does not export createCache(); results will not be cached.');
      return null;
    }
    return mod.createCache({ dir: config.cache.dir, maxBytes: config.cache.maxBytes, logger });
  } catch (error) {
    logger.warn(`the cache module is unavailable; overview exports will go to a temp directory: ${error?.message ?? error}`);
    return null;
  }
}

/**
 * 装 ASR / 文档解析 provider（契约 §12.2 / §12.3 的三态降级）：
 *   - 没配（none）→ null，功能降级为「只有画面」；
 *   - 配了但缺 key → provider 对象存在，真正转写时才抛清晰错误（由 provider 自己负责）；
 *   - provider 名拼错 / 模块缺失 → 记进 providerErrors，probe 的 capabilities 会说明原因。
 *
 * `pinCredentials` 供 HTTP 的逐请求路径使用：config 已经是「本请求最终生效」的凭据，
 * 传空串也会原样钉住，从而阻止各 provider 工厂再去环境变量里找 key —— 否则请求头切到
 * 另一个 provider 时，工厂的兜底逻辑可能把服务器上另一组凭据又捡回来。
 *
 * @param {object} config
 * @param {object} env
 * @param {object} logger
 * @param {{ pinCredentials?: boolean }} [options]
 */
export async function loadProviders(config, env, logger, { pinCredentials = false } = {}) {
  const providerErrors = {};
  let asrProvider = null;
  let docProvider = null;

  if (config.asr.provider !== 'none') {
    try {
      const mod = await import('../providers/asr/index.js');
      if (typeof mod.createAsrProvider !== 'function') {
        providerErrors.asr = 'the ASR provider module does not export createAsrProvider().';
        logger.warn(providerErrors.asr);
      } else {
        asrProvider = mod.createAsrProvider(env, {
          provider: config.asr.provider,
          apiKey: pinCredentials ? config.asr.apiKey : (config.asr.apiKey || undefined),
          baseUrl: config.asr.baseUrl,
          model: config.asr.model,
          language: pinCredentials && config.asr.language === 'auto'
            ? ''
            : (config.asr.language === 'auto' ? undefined : config.asr.language),
          timeoutMs: config.asr.timeoutMs,
        });
      }
    } catch (error) {
      providerErrors.asr = `ASR provider "${config.asr.provider}" could not be configured: ${error?.message ?? error}`;
      logger.error(providerErrors.asr);
      asrProvider = null;
    }
  }

  if (config.doc.provider !== 'none') {
    try {
      const mod = await import('../providers/doc/index.js');
      if (typeof mod.createDocProvider !== 'function') {
        providerErrors.doc = `MMGREP_DOC_PROVIDER is "${config.doc.provider}" but src/providers/doc/index.js `
          + 'does not export createDocProvider() yet.';
        logger.warn(providerErrors.doc);
      } else {
        docProvider = mod.createDocProvider(env, {
          provider: config.doc.provider,
          apiKey: pinCredentials ? config.doc.apiKey : (config.doc.apiKey || undefined),
          baseUrl: config.doc.baseUrl,
          model: pinCredentials ? config.doc.model : (config.doc.model || undefined),
          timeoutMs: config.doc.timeoutMs,
        });
      }
    } catch (error) {
      const missing = error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND';
      providerErrors.doc = missing
        ? `MMGREP_DOC_PROVIDER is "${config.doc.provider}" but the document parser module (src/providers/doc/index.js) is not available yet.`
        : `document provider "${config.doc.provider}" could not be configured: ${error?.message ?? error}`;
      logger.warn(providerErrors.doc);
      docProvider = null;
    }
  }

  return { asrProvider, docProvider, providerErrors };
}

/**
 * 造完整运行时（装配顺序：config → logger → cache → providers → backends → dispatcher）。
 *
 * @param {object} [options]
 * @param {object} [options.env] 环境变量（默认 process.env）
 * @param {object} [options.config] 覆盖 loadConfig 的结果（测试用）
 * @param {object} [options.backends] 覆盖后端（测试注入 stub）
 * @param {object} [options.cache] 显式传入 cache（传 null 表示禁用）
 * @param {object} [options.asrProvider] / [options.docProvider] 显式传入 provider
 * @param {object} [options.logger]
 */
export async function createRuntime(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig(env);
  const logger = options.logger ?? createLogger({ level: config.logLevel });

  for (const warning of config.warnings ?? []) logger.warn(warning);

  const cache = options.cache !== undefined ? options.cache : await loadCache(config, logger);

  const providers = options.providers
    ?? (options.asrProvider !== undefined || options.docProvider !== undefined
      ? { asrProvider: options.asrProvider ?? null, docProvider: options.docProvider ?? null, providerErrors: {} }
      : await loadProviders(config, env, logger));

  const backendCtx = {
    cache,
    asrProvider: providers.asrProvider ?? null,
    docProvider: providers.docProvider ?? null,
    logger,
    config,
  };
  const backends = options.backends ?? await loadBackends(backendCtx, { logger });
  const dispatcher = options.dispatcher ?? createDispatcher(backends);

  return {
    env,
    config,
    logger,
    cache: cache ?? null,
    asrProvider: providers.asrProvider ?? null,
    docProvider: providers.docProvider ?? null,
    providerErrors: providers.providerErrors ?? {},
    backends,
    dispatcher,
  };
}

/** 没有显式后端时的占位集合（createServer 同步可用） */
function placeholderBackends() {
  return {
    video: createPlaceholderBackend('video'),
    audio: createPlaceholderBackend('audio'),
    document: createPlaceholderBackend('document'),
  };
}

/**
 * 用运行时（或直接给的组件）创建 McpServer。
 *
 * @param {object} runtimeOrOptions
 * @returns {McpServer}
 */
export function createServer(runtimeOrOptions = {}) {
  const source = runtimeOrOptions.runtime ?? runtimeOrOptions;
  const config = source.config ?? loadConfig();
  const logger = source.logger ?? createLogger({ level: config.logLevel });
  const backends = source.backends ?? placeholderBackends();
  const dispatcher = source.dispatcher ?? createDispatcher(backends);

  const runtime = {
    config,
    logger,
    cache: source.cache ?? null,
    asrProvider: source.asrProvider ?? null,
    docProvider: source.docProvider ?? null,
    providerErrors: source.providerErrors ?? {},
    backends,
    dispatcher,
  };

  const server = new McpServer(
    { name: config.server?.name ?? SERVER_NAME, version: config.server?.version ?? SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, runtime);

  // 给测试 / 运维留一个只读入口（不参与 MCP 协议）
  Object.defineProperty(server, 'mmgrepRuntime', { value: runtime, enumerable: false });
  return server;
}

/**
 * 启动信息（只写 stderr；绝不写 stdout）。
 *
 * @param {object} runtime
 * @param {object} [options]
 * @param {string} [options.url] HTTP 模式下的真实地址；不给就走原来的 stdio 横幅（逐字不变）
 * @param {boolean} [options.tokenSet] 是否配了 Bearer 令牌（**只说 set / unset，不说值**）
 * @param {string|null} [options.warn] 需要额外提醒的一行（例如对外暴露且没有令牌）
 */
export function logStartupBanner(runtime, options = {}) {
  const { logger, config, backends } = runtime;
  const backendLabels = Object.entries(backends ?? {})
    .map(([mediaType, backend]) => {
      const status = backend?.describeStatus?.();
      return `${mediaType}=${status?.placeholder === false ? 'ready' : 'placeholder'}`;
    })
    .join(' ');
  if (options.url) {
    logger.info(`${config.server.name}@${config.server.version} ready on ${options.url}`);
    logger.info(`auth: bearer ${options.tokenSet ? 'set' : 'unset'}`);
    if (options.warn) logger.warn(options.warn);
  } else {
    logger.info(`${config.server.name}@${config.server.version} ready on stdio`);
  }
  logger.info(`cache: ${config.cache.dir} (max ${config.cache.maxBytes} bytes)`);
  logger.info(`asr: ${config.asr.provider}${config.asr.apiKey ? '' : ' (no API key)'} · doc: ${config.doc.provider} · ocr: ${config.ocr.provider}`);
  logger.info(`backends: ${backendLabels || '(none)'}`);
  logger.info(`image budget: ${config.images.maxTokens} tokens/call, maxEdge ${config.images.maxEdge}px`);
}

export { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, loadConfig, createLogger };
export { loadBackends, createPlaceholderBackend } from './backends.js';
