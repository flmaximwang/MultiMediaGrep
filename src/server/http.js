// src/server/http.js —— Streamable HTTP 传输（无状态）
//
// 为什么选**无状态**（sessionIdGenerator: undefined）：
//   MCP 的 Streamable HTTP 有两种模式——有会话（server 记住 sessionId，把后续请求串起来）
//   和无会话（每个请求独立处理）。这里选无会话，理由是：
//     1. 未来的 provider 凭据是**逐请求**带过来的，没有什么是值得跨请求保留的；
//     2. 无会话就不用在内存里维护 session 表，也就不用考虑清理与泄漏；
//     3. 每个 POST 都用同一个工厂新建一份 server + transport，用完即关。
//
// 安全约定（改这个文件前请先读完这三条）：
//   1. 令牌只从 Authorization 头读，**绝不**从 query string 读——query 会进访问日志、
//      进浏览器历史、进代理日志，是泄漏令牌最常见的姿势；
//   2. **任何请求头的值都不打日志**（只记头名）：后续请求头里会带 provider 的 API key，
//      一行日志就能泄底；key 值另有一层脱敏兜底；
//   3. 令牌值本身永远不出现在日志里，只说 set / unset。

import crypto from 'node:crypto';
import http from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  REQUEST_HEADERS,
  presentCredentialHeaders,
  resolveConfigForRequest,
} from './credentials.js';
import { createServer as createMcpServer, loadProviders } from './index.js';

/** MCP 端点路径 */
export const HTTP_PATH = '/mcp';
/** 请求体上限：1 MiB。MCP 消息都是 JSON-RPC 小报文，超过这个量级基本是异常流量 */
export const MAX_BODY_BYTES = 1024 * 1024;
/** 单次请求超时：2 分钟。超时后关掉 transport，从而 abort 在途的工具调用 */
export const REQUEST_TIMEOUT_MS = 120000;

/** 组一个 JSON-RPC 错误信封（HTTP 状态码由调用方决定） */
function jsonRpcError(message, code = -32000, id = null) {
  return { jsonrpc: '2.0', error: { code, message }, id };
}

/** 回一个 JSON 响应 */
function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/** 只削掉 ASCII 空白（HTTP 头里的 OWS 只可能是空格 / 制表符）。
 *
 * 为什么不用 String#trim()：令牌允许任意 UTF-8。node:http 把请求头按 latin1 解码，
 * 一个字节对应一个字符；UTF-8 字节 0xA0 会变成 U+00A0（NBSP），而 trim() 把 NBSP
 * 当空白削掉——令牌里恰好含这个字节（很多多字节字符的末字节就是 0xA0）就会被悄悄改写。
 */
function trimAsciiWhitespace(text) {
  return text.replace(/^[ \t]+|[ \t]+$/g, '');
}

/**
 * 校验 Bearer 令牌。
 *
 * 用 crypto.timingSafeEqual 比较：等长才比，长度不同直接判否（timingSafeEqual 对
 * 不等长会抛异常）。没配令牌时一律放行——「没配令牌」和「令牌校验通过」是两回事，
 * 但结果一样是允许请求。
 *
 * 为什么要显式做 latin1 → 原始字节的还原：node:http 按 latin1 解码请求头值，收到的
 * 字符串里每个字符对应一个原始字节。若直接 Buffer.from(provided, 'utf8')，非 ASCII
 * 令牌（如「测试令牌」）会被二次编码，永远匹配不上。这里按 latin1 还原出客户端发来的
 * UTF-8 字节，再与期望令牌的 UTF-8 字节逐字节比较。
 */
export function isAuthorized(req, token) {
  if (!token) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(trimAsciiWhitespace(header));
  if (!match) return false;
  const provided = Buffer.from(trimAsciiWhitespace(match[1]), 'latin1');
  const expected = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function makeBodyError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 读请求体，超过上限就报错。
 *
 * 超限时把剩下的数据读掉丢掉（req.resume()），否则 socket 卡在半截的状态下
 * 既写不出 413 也关不掉。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(makeBodyError('Request body too large.', 'BODY_TOO_LARGE'));
      return;
    }

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(makeBodyError('Request body too large.', 'BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** 把监听地址拼成 URL（IPv6 要加方括号） */
export function formatHostForUrl(host) {
  const text = String(host ?? '');
  if (text.includes(':') && !text.startsWith('[')) return `[${text}]`;
  return text;
}

/** JSON-RPC 请求的 id（批量 / 非对象请求回 null） */
function requestId(parsed) {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
  return parsed.id ?? null;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 本请求里真正算「秘密」的头值：只有 api-key（provider 专属 + 通用兜底两种）。
 *
 * 为什么不再把 provider id / baseUrl / model 也当敏感值：它们不是秘密，而且 provider id
 * 往往就是头名的一部分（`x-mmgrep-elevenlabs-api-key`）——把 elevenlabs 当子串替换，
 * 日志里就会冒出 `x-mmgrep-[redacted]-api-key`，头名被毁，排查时就不知道是哪个头了。
 * 值一律去空白后再收集，与 credentials.js 的读取口径一致。
 */
function secretHeaderValues(headers) {
  // 与 credentials.js 的 normalizeHeaders 同口径：键转小写，同名只取第一个字符串值。
  const normalized = Object.create(null);
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string') continue;
    const name = String(key).toLowerCase();
    if (!(name in normalized)) normalized[name] = value;
  }

  const names = [];
  for (const kind of Object.keys(REQUEST_HEADERS)) {
    const spec = REQUEST_HEADERS[kind];
    names.push(spec.genericApiKey);
    for (const provider of Object.values(spec.providers)) names.push(provider.apiKey);
  }

  const values = [];
  for (const name of names) {
    const raw = normalized[name];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed !== '') values.push(trimmed);
  }
  // 长的先替换，避免短 key 是长 key 的前缀时先把长值拆碎（与 credentials.js 同策略）。
  return values.sort((a, b) => b.length - a.length);
}

/**
 * 给请求级日志套一层脱敏：把本请求带过的 **api-key 头值**替换成 [redacted]。
 *
 * 只屏蔽 key：provider id / baseUrl / model 会正常出现在日志上下文里（尤其是头名），
 * 屏蔽它们只会把日志打烂，换不来任何安全收益。key 的值仍然保证不会出现在任何日志行。
 */
function createRequestLogger(logger, secrets) {
  if (!logger || secrets.length === 0) return logger;
  const redact = (text) => {
    let out = String(text);
    for (const value of secrets) out = out.split(value).join('[redacted]');
    return out;
  };
  const mapArg = (arg) => (typeof arg === 'string' ? redact(arg) : redact(safeStringify(arg)));
  const wrap = (method) => (typeof logger[method] === 'function'
    ? (...args) => logger[method](...args.map(mapArg))
    : () => {});
  return {
    level: logger.level,
    error: wrap('error'),
    warn: wrap('warn'),
    info: wrap('info'),
    debug: wrap('debug'),
  };
}

/**
 * 为「带了凭据头」的请求造一份独立 runtime。
 *
 * 共享的东西：cache、logger（外面套脱敏）、backends、dispatcher；它们不含凭据状态，
 * 重建反而会丢掉缓存。
 * 重建的东西：config 与 asr / doc provider——provider 持有 apiKey 闭包，必须逐请求新建，
 * **绝不按 key / 头做缓存**，否则明文密钥会在内存里活过这次请求。
 */
async function createRequestRuntime(runtime, config, headers, env, logger = runtime?.logger) {
  const requestLogger = createRequestLogger(logger, secretHeaderValues(headers));
  const names = presentCredentialHeaders(headers);
  requestLogger?.info?.(
    `http: applying per-request credentials (${names.join(', ')}); providers are built for this request only.`,
  );
  const providers = await loadProviders(config, env, requestLogger, { pinCredentials: true });
  return {
    ...runtime,
    config,
    logger: requestLogger,
    asrProvider: providers.asrProvider,
    docProvider: providers.docProvider,
    providerErrors: providers.providerErrors,
  };
}

/**
 * 处理一个已经解析好的 POST /mcp。
 *
 * 无状态模式的核心：每次请求都新建一份 server + transport，处理完立刻关掉。
 */
async function handleMcpPost(req, res, ctx) {
  const { runtime, logger, serverFactory, parsed, timeoutMs } = ctx;

  // 先算「本请求的凭据覆盖」，再碰任何 provider：provider id 写错是客户端的参数问题，
  // 必须在建 server / 构造 provider 之前就回 400。
  let requestRuntime = runtime;
  const headers = req.headers ?? {};
  const present = presentCredentialHeaders(headers);
  if (present.length > 0) {
    try {
      const env = runtime?.env ?? process.env;
      const config = resolveConfigForRequest(runtime?.config ?? {}, headers, env);
      requestRuntime = await createRequestRuntime(runtime, config, headers, env, logger);
    } catch (error) {
      if (error?.code === 'INVALID_ARGUMENT') {
        // 这条消息只含 provider id 与允许值（由 credentials.js 构造），不含任何 key。
        sendJson(res, 400, jsonRpcError(`Invalid params: ${error.message}`, -32602, requestId(parsed)));
      } else {
        // 不记录 error.message：它可能带着请求头里的某个值；只记错误类型。
        createRequestLogger(logger, secretHeaderValues(headers))?.error?.(
          `http: per-request credentials could not be applied (${error?.name ?? 'Error'}).`,
        );
        sendJson(res, 500, jsonRpcError('Internal error.'));
      }
      return;
    }
  }

  const log = requestRuntime.logger ?? logger;

  // 用的是 stdio 那条路同一个工厂：同一个 runtime，同一批工具定义。
  const server = serverFactory(requestRuntime);
  const transport = new StreamableHTTPServerTransport({
    // undefined = 无会话：server 不生成 sessionId，也不校验 Mcp-Session-Id 头
    sessionIdGenerator: undefined,
    // 无会话下没有服务端主动推送的流，响应一次写完即可；
    // application/json 比 text/event-stream 少一层流解析，SDK 客户端两种都认。
    enableJsonResponse: true,
  });

  let closed = false;
  const closeOnce = async () => {
    if (closed) return;
    closed = true;
    try {
      // server.close() 会顺带 close transport；transport 关闭会触发 SDK 的 onclose，
      // SDK 随即 abort 在途请求的 AbortController——工具调用因此能感知到取消。
      await server.close();
    } catch (error) {
      log?.warn(`http: error while closing the per-request server: ${error?.message ?? error}`);
    }
  };

  // 客户端中途断开：立刻收摊，别让工具调用在没人等的情况下继续跑
  res.once('close', () => {
    if (!res.writableEnded) void closeOnce();
  });

  // 响应真正写完的信号：关 server 之前要等它，免得把还没 flush 的响应带跑
  const responseDone = new Promise((resolve) => {
    res.once('close', resolve);
    res.once('finish', resolve);
  });

  await server.connect(transport);

  let settleTimeout;
  const timeoutPromise = new Promise((resolve) => { settleTimeout = resolve; });
  const timer = setTimeout(() => {
    log?.warn('http: the request timed out; the in-flight tool call was aborted.');
    // 关掉 transport → SDK abort 在途请求 → 工具调用收到 AbortSignal
    void closeOnce();
    if (!res.headersSent) sendJson(res, 504, jsonRpcError('Request timed out.'));
    settleTimeout();
  }, timeoutMs);

  try {
    await Promise.race([
      transport.handleRequest(req, res, parsed).catch((error) => {
        log?.warn(`http: the MCP transport failed: ${error?.message ?? error}`);
        if (!res.headersSent) sendJson(res, 500, jsonRpcError('Internal error.'));
      }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
    await Promise.race([responseDone, timeoutPromise]);
    await closeOnce();
  }
}

/**
 * 造一个 (req, res) 处理函数。
 *
 * @param {object} options
 * @param {object} options.runtime createRuntime() 的产物（后端 / 缓存 / provider 共享）
 * @param {object} [options.config]
 * @param {object} [options.logger]
 * @param {Function} [options.serverFactory] 建 McpServer 的工厂（默认用 stdio 那条路的 createServer）
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBodyBytes]
 */
export function createHttpRequestHandler({
  runtime,
  config,
  logger,
  serverFactory = createMcpServer,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxBodyBytes = MAX_BODY_BYTES,
} = {}) {
  const token = config?.transport?.token ?? '';
  const log = logger ?? runtime?.logger;

  return async function handleHttpRequest(req, res) {
    // 路由只看 pathname：query string 不参与路由，更不能拿来传令牌
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }

    if (pathname !== HTTP_PATH) {
      sendJson(res, 404, jsonRpcError('Not Found.'));
      return;
    }

    // 鉴权排在方法判断之前：受保护的端点不该让未授权方探测到「哪些方法可用」
    if (!isAuthorized(req, token)) {
      sendJson(res, 401, jsonRpcError('Unauthorized.'), {
        'WWW-Authenticate': 'Bearer realm="multimediagrep"',
      });
      return;
    }

    if (req.method !== 'POST') {
      // 无会话模式下没有服务端主动推送的 SSE 流，GET 没有可服务的语义
      sendJson(res, 405, jsonRpcError('Method Not Allowed.'), { Allow: 'POST' });
      return;
    }

    let raw;
    try {
      raw = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, jsonRpcError('Request body too large.'));
        return;
      }
      log?.warn(`http: could not read the request body: ${error?.message ?? error}`);
      sendJson(res, 400, jsonRpcError('Could not read the request body.', -32700));
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      // 解析失败是客户端的问题：回 JSON-RPC 错误信封，不甩堆栈
      sendJson(res, 400, jsonRpcError('Parse error: Invalid JSON', -32700));
      return;
    }

    await handleMcpPost(req, res, { runtime, logger: log, serverFactory, parsed, timeoutMs });
  };
}

/**
 * 起一个 Streamable HTTP 端点。
 *
 * @param {object} options
 * @param {object} options.runtime
 * @param {object} [options.config]
 * @param {object} [options.logger]
 * @param {Function} [options.serverFactory]
 * @param {string} [options.host]
 * @param {number} [options.port] 传 0 让操作系统挑一个空闲端口
 * @returns {Promise<{server: http.Server, host: string, port: number, url: string, close: () => Promise<void>}>}
 */
export async function startHttpServer({
  runtime,
  config = runtime?.config,
  logger = runtime?.logger,
  serverFactory = createMcpServer,
  host = config?.transport?.host,
  port = config?.transport?.port,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxBodyBytes = MAX_BODY_BYTES,
} = {}) {
  const handler = createHttpRequestHandler({
    runtime,
    config,
    logger,
    serverFactory,
    timeoutMs,
    maxBodyBytes,
  });

  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      logger?.error(`http: unhandled error while serving a request: ${error?.stack ?? error}`);
      if (!res.headersSent) sendJson(res, 500, jsonRpcError('Internal error.'));
      else res.end();
    });
  });

  // 记下所有连接：关服时要把还挂着的连接一起收掉，否则 server.close() 会一直等
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;

  return {
    server,
    host,
    port: boundPort,
    url: `http://${formatHostForUrl(host)}:${boundPort}${HTTP_PATH}`,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => {
        server.close(() => resolve());
        // 空闲的 keep-alive 连接不会自己结束，强制收掉
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      });
    },
  };
}
