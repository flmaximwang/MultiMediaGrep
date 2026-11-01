// test/server/http.test.js —— Streamable HTTP 传输：无状态端点、鉴权、路由、配置与日志
//
// 全程用 fetch 驱动，**不连外网**：端口传 0 让操作系统挑一个空闲端口，
// 真实地址从 server.address() 读回来（不写死端口，免得跟别的测试撞车）。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  DEFAULT_MAX_TEXT_INLINE_CHARS,
  MAX_TEXT_INLINE_CHARS_HARD_CAP,
  createLogger,
  loadConfig,
} from '../../src/server/config.js';
import { createRuntime, createServer, logStartupBanner } from '../../src/server/index.js';
import { startHttpServer, isAuthorized } from '../../src/server/http.js';
import { assertFfmpegAvailable, run } from '../../src/media/ffmpeg.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src/index.js');

/** MCP 规范要求客户端同时接受 application/json 和 text/event-stream */
const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const TOOL_NAMES = ['media_probe', 'media_overview', 'media_zoom', 'media_locate'];

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** ffmpeg 在不在？不在就把依赖它的用例整个跳过 */
const ffmpegAvailable = await (async () => {
  try {
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
})();

/** 收集日志行：注入一个自己的 stream，而不是去 monkey-patch console */
function createCapturingLogger(level = 'debug') {
  const lines = [];
  const logger = createLogger({ level, stream: { write: (line) => { lines.push(line.trimEnd()); } } });
  return { logger, lines };
}

/**
 * 起一个 HTTP 端点跑 fn。
 *
 * 日志走注入的 logger（写到内存里的数组），这样既能断言「日志里没有令牌」，
 * 又不会去动全局的 console。
 */
async function withHttpServer(env, fn, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-http-'));
  const baseEnv = { MMGREP_CACHE_DIR: path.join(dir, 'cache'), ...env };
  const config = loadConfig(baseEnv);
  const { logger, lines } = createCapturingLogger();
  const runtime = await createRuntime({ env: baseEnv, config, logger });
  // 端口 0：让操作系统挑空闲端口，真实地址从 server 对象读回来
  const endpoint = await startHttpServer({
    runtime,
    config,
    port: 0,
    ...(options.serverFactory ? { serverFactory: options.serverFactory } : {}),
  });
  try {
    return await fn({ endpoint, config, runtime, logger, logs: lines, dir });
  } finally {
    await endpoint.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 发一条 JSON-RPC 请求 */
async function rpc(endpoint, message, headers = {}) {
  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 不是 JSON 响应体的情况留给调用方自己断言
  }
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * 用裸 socket 发一条 HTTP/1.1 POST，Authorization 的值按**原始字节**写入。
 *
 * 为什么不用 fetch / http.request：它们的头值必须是 ByteString（码位 ≤ 0xFF），
 * 多字节 UTF-8 令牌发不出去（fetch 抛 TypeError，http.request 抛 ERR_INVALID_CHAR）。
 * 真实客户端（curl 等）是直接把 UTF-8 字节塞进头里的，这里模拟的就是这种请求。
 */
function rawRpc(endpoint, message, tokenBytes) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.url);
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const head = Buffer.from(
      [
        `POST ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        'Content-Type: application/json',
        'Accept: application/json, text/event-stream',
        `Content-Length: ${body.length}`,
        'Connection: close',
        'Authorization: Bearer ',
      ].join('\r\n'),
      'latin1',
    );

    const socket = net.connect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.write(Buffer.concat([head, tokenBytes, Buffer.from('\r\n\r\n'), body]));
    });

    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      // 响应头是 ASCII；正文是 UTF-8 字节，先按 latin1 还原字节再按 utf8 解码。
      const raw = Buffer.concat(chunks).toString('latin1');
      const split = raw.indexOf('\r\n\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0);
      resolve({ status, text: Buffer.from(raw.slice(split + 4), 'latin1').toString('utf8') });
    });
  });
}

/** 生成一段 2 秒的测试音频（lavfi 正弦波），跟 test/backend/audio.test.js 一个套路 */
async function makeAudioFixture(dir) {
  const out = path.join(dir, 'tone.wav');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=sin(440):d=2:s=16000', out]);
  return out;
}

/**
 * 找一个空闲端口。
 *
 * 命令行的 --port 只接受 1–65535（跟 MMGREP_HTTP_PORT 一个口径），所以子进程那条路
 * 得自己先把号借出来。
 */
async function findFreePort() {
  const probe = http.createServer();
  await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(resolve); });
  return port;
}

/**
 * 起一个本地 ASR 供应商 stub：记录每个请求的 URL 与请求头，回一个固定 JSON。
 *
 * 为什么不用真网络：集成测试要证明「请求头里的 key 真的送到了 provider」，
 * 而不是只证明 config 里有字符串。stub 同时接 ElevenLabs（xi-api-key）与
 * OpenAI-compatible（Authorization: Bearer）两种鉴权方式。
 */
async function startProviderStub() {
  const requests = [];
  const stub = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const isEleven = String(req.url).includes('/speech-to-text');
    const payload = JSON.stringify({
      text: isEleven ? 'hello from elevenlabs' : 'hello from openai',
      segments: [{ start: 0, end: 1, text: isEleven ? 'hello from elevenlabs' : 'hello from openai' }],
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  });
  await new Promise((resolve) => { stub.listen(0, '127.0.0.1', resolve); });
  const { port } = stub.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      await new Promise((resolve) => { stub.close(resolve); });
    },
  };
}

/** 递归列出目录里的普通文件（缓存目录落盘检查用） */
async function listFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

test('http：initialize 之后 tools/list 返回 4 个工具', async () => {
  await withHttpServer({}, async ({ endpoint }) => {
    const init = await rpc(endpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'http-test', version: '0.0.0' },
      },
    });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.serverInfo.name, 'multimediagrep');
    assert.ok(init.json.result.instructions.length > 0);

    // 无状态：tools/list 是**另一个**请求，也不需要任何 session 头
    const list = await rpc(endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.result.tools.map((tool) => tool.name), TOOL_NAMES);
    assert.equal(list.headers.get('mcp-session-id'), null, '无状态模式不该下发 session id');
  });
});

test('http：tools/call media_probe 与 stdio 路径同形', { skip: !ffmpegAvailable }, async () => {
  await withHttpServer({}, async ({ endpoint, runtime, dir }) => {
    const fixture = await makeAudioFixture(dir);

    // 「stdio 路径」：同一个 runtime + 同一个工厂，只是换成进程内传输
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const stdioServer = createServer(runtime);
    await stdioServer.connect(serverTransport);
    const client = new Client({ name: 'in-memory-stdio', version: '0.0.0' });
    await client.connect(clientTransport);
    const stdioResult = await client.callTool({ name: 'media_probe', arguments: { path: fixture } });

    const http = await rpc(endpoint, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'media_probe', arguments: { path: fixture } },
    });
    assert.equal(http.status, 200);
    const httpResult = http.json.result;

    // 形状要一样：内容块 + 结构化字段，两边都逐字对得上
    assert.equal(httpResult.content.length, stdioResult.content.length);
    assert.equal(httpResult.content[0].type, stdioResult.content[0].type);
    assert.deepEqual(
      Object.keys(httpResult.structuredContent).sort(),
      Object.keys(stdioResult.structuredContent).sort(),
    );
    assert.deepEqual(httpResult.structuredContent, stdioResult.structuredContent);
    assert.match(httpResult.content[0].text, /<media path=/);

    await client.close();
    await stdioServer.close();
  });
});

test('http：配了令牌就必须带对 Authorization 头', async () => {
  const token = 'test-token-value-123';
  await withHttpServer({ MMGREP_HTTP_TOKEN: token }, async ({ endpoint }) => {
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

    const noHeader = await rpc(endpoint, message);
    assert.equal(noHeader.status, 401);
    assert.equal(noHeader.headers.get('www-authenticate'), 'Bearer realm="multimediagrep"');

    const wrong = await rpc(endpoint, message, { authorization: 'Bearer wrong-token' });
    assert.equal(wrong.status, 401);

    const right = await rpc(endpoint, message, { authorization: `Bearer ${token}` });
    assert.equal(right.status, 200);
    assert.equal(right.json.result.tools.length, 4);

    // 令牌**不认** query string：带了也没用
    const viaQuery = await fetch(`${endpoint.url}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(message),
    });
    assert.equal(viaQuery.status, 401);
  });
});

test('http：isAuthorized 按原始字节比较，非 ASCII 令牌才可能匹配', () => {
  const token = '测试令牌-éà';
  // node:http 把请求头的每个原始字节解码成一个 latin1 字符；这里还原服务端收到的样子。
  const asReceived = (text) => Buffer.from(text, 'utf8').toString('latin1');
  const reqWith = (authorization) => ({ headers: { authorization } });

  // 非 ASCII：能匹配；错一个字符就不行
  assert.equal(isAuthorized(reqWith(`Bearer ${asReceived(token)}`), token), true);
  assert.equal(isAuthorized(reqWith(`Bearer ${asReceived('测试令牌-éá')}`), token), false);

  // ASCII 行为不变
  assert.equal(isAuthorized(reqWith('Bearer ascii-token'), 'ascii-token'), true);
  assert.equal(isAuthorized(reqWith('Bearer ascii-token'), 'other-token'), false);

  // 空头 / 缺头 / 没有 Bearer 前缀 / 超长头：一律判否，且绝不抛
  // （timingSafeEqual 对不等长会抛异常，长度判断必须挡在它前面）
  assert.equal(isAuthorized(reqWith(''), token), false);
  assert.equal(isAuthorized(reqWith('Bearer '), token), false);
  assert.equal(isAuthorized({ headers: {} }, token), false);
  assert.equal(isAuthorized(reqWith(`Bearer ${'x'.repeat(65536)}`), token), false);

  // 没配令牌：放行
  assert.equal(isAuthorized(reqWith(''), ''), true);
});

test('http：非 ASCII 令牌经真实 HTTP 头（UTF-8 字节）端到端通过，错误令牌仍 401', async () => {
  const token = '测试令牌-éà';
  await withHttpServer({ MMGREP_HTTP_TOKEN: token }, async ({ endpoint }) => {
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

    const right = await rawRpc(endpoint, message, Buffer.from(token, 'utf8'));
    assert.equal(right.status, 200);
    assert.equal(JSON.parse(right.text).result.tools.length, 4);

    const wrong = await rawRpc(endpoint, message, Buffer.from('测试令牌-错误', 'utf8'));
    assert.equal(wrong.status, 401);
  });
});

test('http：GET /mcp → 405，未知路径 → 404，坏 JSON → 400', async () => {
  await withHttpServer({}, async ({ endpoint }) => {
    const get = await fetch(endpoint.url, { method: 'GET', headers: JSON_HEADERS });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');

    const unknown = await fetch(new URL('/nope', endpoint.url), { method: 'GET', headers: JSON_HEADERS });
    assert.equal(unknown.status, 404);

    const bad = await fetch(endpoint.url, { method: 'POST', headers: JSON_HEADERS, body: '{ not json' });
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.code, -32700, '要回 JSON-RPC 错误信封，不是堆栈');
    assert.ok(!/at .*\.js:\d+/.test(bad.headers.get('content-type') ?? ''));

    // 请求体超过 1 MiB → 413
    const tooLarge = await fetch(endpoint.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: 'x'.repeat(1024 * 1024 + 16),
    });
    assert.equal(tooLarge.status, 413);
  });
});

test('config：MMGREP_TRANSPORT 写错 → 警告并回落 stdio', () => {
  const config = loadConfig({ MMGREP_TRANSPORT: 'grpc' });
  assert.equal(config.transport.mode, 'stdio');
  assert.ok(
    config.warnings.some((w) => w.includes('MMGREP_TRANSPORT') && w.includes('grpc')),
    `没有警告：${JSON.stringify(config.warnings)}`,
  );

  assert.equal(loadConfig({}).transport.mode, 'stdio');
  assert.equal(loadConfig({ MMGREP_TRANSPORT: 'http' }).transport.mode, 'http');
  assert.equal(loadConfig({}).transport.host, '127.0.0.1');
  assert.equal(loadConfig({}).transport.port, 3927);
});

test('config：非回环地址又没有令牌 → 警告', () => {
  const exposed = loadConfig({ MMGREP_HTTP_HOST: '0.0.0.0' });
  assert.ok(
    exposed.warnings.some((w) => w.includes('MMGREP_HTTP_HOST') && w.includes('MMGREP_HTTP_TOKEN')),
    `没有警告：${JSON.stringify(exposed.warnings)}`,
  );

  // 配了令牌就不该再警告
  const guarded = loadConfig({ MMGREP_HTTP_HOST: '0.0.0.0', MMGREP_HTTP_TOKEN: 'x' });
  assert.equal(guarded.warnings.length, 0);

  // 回环地址 + 没令牌也不警告
  assert.equal(loadConfig({}).warnings.length, 0);
  assert.equal(loadConfig({ MMGREP_HTTP_HOST: '127.0.0.1' }).warnings.length, 0);
});

test('http：令牌的值不会出现在日志里', async () => {
  const token = 'never-log-this-token';
  await withHttpServer({ MMGREP_HTTP_TOKEN: token }, async ({ endpoint, runtime, logs }) => {
    logStartupBanner(runtime, { url: endpoint.url, tokenSet: true });
    await rpc(endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    await rpc(endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { authorization: 'Bearer wrong' });

    const text = logs.join('\n');
    assert.ok(text.length > 0, '应该真的记了日志');
    assert.ok(!text.includes(token), `令牌泄漏到日志里了：${text}`);
    assert.match(text, /auth: bearer set/);
  });
});

test('http：超时后中止在途的工具调用', { timeout: 20000 }, async () => {
  let aborted = false;
  // 一个专门用来「睡很久」的工具：超时时它要能收到 AbortSignal
  const slowFactory = () => {
    const server = new McpServer({ name: 'slow', version: '0.0.0' });
    server.registerTool('slow', { description: '睡到天荒地老', inputSchema: {} }, async (args, extra) => {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 15000);
        extra?.signal?.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(timer);
          resolve();
        });
      });
      return { content: [{ type: 'text', text: 'done' }] };
    });
    return server;
  };

  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-http-timeout-'));
  const config = loadConfig({ MMGREP_CACHE_DIR: path.join(dir, 'cache') });
  const { logger } = createCapturingLogger();
  const runtime = await createRuntime({ env: {}, config, logger });
  const endpoint = await startHttpServer({
    runtime,
    config,
    port: 0,
    serverFactory: slowFactory,
    timeoutMs: 300,
  });

  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'slow', arguments: {} },
      }),
    });
    assert.equal(res.status, 504);

    // 工具还在跑：超时要把在途调用 abort 掉
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    assert.equal(aborted, true, '超时没有 abort 在途的工具调用');
  } finally {
    await endpoint.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('http：真实进程起得来、鉴权生效、SIGINT 后退出码 0', async () => {
  const token = 'process-level-token';
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-http-proc-'));
  const port = await findFreePort();
  const child = spawn(process.execPath, [ENTRY, '--http', '--port', String(port), '--token', token], {
    cwd: ROOT,
    env: {
      ...process.env,
      MMGREP_CACHE_DIR: path.join(dir, 'cache'),
      MMGREP_ASR_PROVIDER: 'none',
      MMGREP_OCR_PROVIDER: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    // 横幅里会打出真实绑定地址，从里面把端口抠出来
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`横幅没出现：${stderr}`)), 20000);
      const tick = setInterval(() => {
        // 横幅是两行：先「ready on <地址>」，再「auth: bearer set」，两行都到齐才算数
        const match = /ready on (http:\/\/\S+\/mcp)/.exec(stderr);
        if (match && /auth: bearer set/.test(stderr)) {
          clearInterval(tick);
          clearTimeout(timer);
          resolve(match[1]);
        }
      }, 50);
      child.once('exit', () => {
        clearInterval(tick);
        clearTimeout(timer);
        reject(new Error(`进程提前退出：${stderr}`));
      });
    });

    assert.match(stderr, /auth: bearer set/);
    assert.ok(!stderr.includes(token), `令牌泄漏到 stderr 里了：${stderr}`);

    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual((await authorized.json()).result.tools.map((tool) => tool.name), TOOL_NAMES);

    // stdout 是 MCP 的协议通道：HTTP 模式下也不该有内容
    assert.equal(stdout, '');

    const exitCode = await new Promise((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.kill('SIGINT');
    });
    assert.equal(exitCode, 0, 'SIGINT 之后应该干净退出');
    assert.ok(!stderr.includes(token), `令牌泄漏到 stderr 里了：${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 逐请求凭据（HTTP 头）
 * ------------------------------------------------------------------ */

test('http：逐请求凭据 —— 同一端点两个请求各用各的 provider / key', async () => {
  const stub = await startProviderStub();
  const seen = [];
  const serverFactory = (runtimeForRequest) => {
    seen.push(runtimeForRequest);
    return createServer(runtimeForRequest);
  };

  try {
    await withHttpServer({}, async ({ endpoint, runtime, logs, dir }) => {
      const audioPath = path.join(dir, 'tone.bin');
      // provider stub 不解析音频内容，只要文件存在、读得出来即可。
      await writeFile(audioPath, Buffer.from('not really audio; the stub does not care'));

      const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
      const first = await rpc(endpoint, list, {
        'x-mmgrep-asr-provider': 'elevenlabs',
        'x-mmgrep-elevenlabs-api-key': 'sentinel-elevenlabs-request-key',
        'x-mmgrep-elevenlabs-base-url': `${stub.url}/eleven`,
        'x-mmgrep-elevenlabs-model': 'sentinel-elevenlabs-model',
      });
      assert.equal(first.status, 200);
      assert.equal(first.json.result.tools.length, 4);

      const second = await rpc(endpoint, { ...list, id: 2 }, {
        'x-mmgrep-asr-provider': 'openai-compatible',
        'x-mmgrep-openai-compatible-api-key': 'sentinel-openai-request-key',
        'x-mmgrep-openai-compatible-base-url': `${stub.url}/openai`,
        'x-mmgrep-openai-compatible-model': 'sentinel-openai-model',
      });
      assert.equal(second.status, 200);

      // 每个请求都有自己的 runtime / provider；共享的那个没有被改动。
      assert.equal(seen.length, 2);
      assert.notEqual(seen[0], runtime);
      assert.notEqual(seen[1], runtime);
      assert.notEqual(seen[0], seen[1], '两个请求必须各有一份 runtime');
      assert.equal(seen[0].config.asr.provider, 'elevenlabs');
      assert.equal(seen[1].config.asr.provider, 'openai-compatible');
      assert.equal(seen[0].config.asr.apiKey, 'sentinel-elevenlabs-request-key');
      assert.equal(seen[1].config.asr.apiKey, 'sentinel-openai-request-key');
      assert.equal(runtime.config.asr.provider, 'none', '共享 runtime 的配置被改动了');

      // 真正打一次 provider：各自的 key 要出现在各自的鉴权头里。
      const eleven = await seen[0].asrProvider.transcribe({ audioPath });
      const openai = await seen[1].asrProvider.transcribe({ audioPath });
      assert.equal(eleven.provider, 'elevenlabs');
      assert.equal(openai.provider, 'openai-compatible');

      assert.equal(stub.requests.length, 2);
      const [elevenRequest, openaiRequest] = stub.requests;
      assert.match(elevenRequest.url, /\/speech-to-text$/);
      assert.equal(elevenRequest.headers['xi-api-key'], 'sentinel-elevenlabs-request-key');
      assert.equal(elevenRequest.headers.authorization, undefined);
      assert.match(openaiRequest.url, /\/audio\/transcriptions$/);
      assert.equal(openaiRequest.headers.authorization, 'Bearer sentinel-openai-request-key');
      assert.equal(openaiRequest.headers['xi-api-key'], undefined);

      // 日志只回答「哪些头出现了」，绝不出现任何头的值。
      const text = logs.join('\n');
      assert.match(text, /x-mmgrep-asr-provider/);
      for (const secret of [
        'sentinel-elevenlabs-request-key',
        'sentinel-openai-request-key',
        'sentinel-elevenlabs-model',
        'sentinel-openai-model',
        stub.url,
      ]) {
        assert.ok(!text.includes(secret), `日志泄漏了请求头的值 ${secret}：${text}`);
      }
    }, { serverFactory });
  } finally {
    await stub.close();
  }
});

test('http：x-mmgrep-ocr-provider / x-mmgrep-typeset-provider 覆盖 env（仅本次请求）', async () => {
  const seen = [];
  const serverFactory = (runtimeForRequest) => {
    seen.push(runtimeForRequest);
    return createServer(runtimeForRequest);
  };

  await withHttpServer(
    { MMGREP_OCR_PROVIDER: 'none', MMGREP_TYPESET_PROVIDER: 'builtin' },
    async ({ endpoint, runtime, logs }) => {
      const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
      const res = await rpc(endpoint, list, {
        'x-mmgrep-ocr-provider': 'mineru',
        'x-mmgrep-typeset-provider': 'mineru',
        'x-mmgrep-mineru-api-key': 'sentinel-role-key',
      });
      assert.equal(res.status, 200);
      assert.equal(seen.length, 1);
      assert.notEqual(seen[0], runtime);
      assert.equal(seen[0].config.ocr.provider, 'mineru');
      assert.equal(seen[0].config.typeset.provider, 'mineru');
      assert.equal(seen[0].config.ocr.apiKey, 'sentinel-role-key');
      assert.equal(seen[0].config.typeset.apiKey, 'sentinel-role-key');
      assert.equal(seen[0].ocrProvider?.id, 'mineru');
      assert.equal(seen[0].typesetProvider?.id, 'mineru');
      // 两个角色同一 provider、同一份配置 → 复用同一个实例。
      assert.equal(seen[0].ocrProvider, seen[0].typesetProvider);

      // 共享 runtime 不受影响。
      assert.equal(runtime.config.ocr.provider, 'none');
      assert.equal(runtime.config.typeset.provider, 'builtin');
      assert.equal(runtime.ocrProvider, null);
      assert.equal(runtime.typesetProvider?.id, 'builtin');

      // 日志只出现头名，不出现头值。
      const text = logs.join('\n');
      assert.match(text, /x-mmgrep-ocr-provider/);
      assert.match(text, /x-mmgrep-typeset-provider/);
      assert.ok(!text.includes('sentinel-role-key'), `日志泄漏了角色头的 key：${text}`);

      // 第二个请求：typeset 关掉，ocr 保持 none → 两个 provider 都不建。
      const off = await rpc(endpoint, { ...list, id: 2 }, {
        'x-mmgrep-ocr-provider': 'none',
        'x-mmgrep-typeset-provider': 'none',
      });
      assert.equal(off.status, 200);
      assert.equal(seen.length, 2);
      assert.equal(seen[1].config.ocr.provider, 'none');
      assert.equal(seen[1].config.typeset.provider, 'none');
      assert.equal(seen[1].ocrProvider, null);
      assert.equal(seen[1].typesetProvider, null);
    },
    { serverFactory },
  );
});

test('http：未知文档角色 provider 头 → 400 / -32602，列出允许值', async () => {
  const seen = [];
  const serverFactory = (runtimeForRequest) => {
    seen.push(runtimeForRequest);
    return createServer(runtimeForRequest);
  };

  await withHttpServer({}, async ({ endpoint }) => {
    const res = await rpc(
      endpoint,
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { 'x-mmgrep-ocr-provider': 'tesseract' },
    );
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, -32602);
    assert.match(res.json.error.message, /x-mmgrep-ocr-provider/);
    assert.match(res.json.error.message, /mineru/);
    assert.equal(seen.length, 0);
  }, { serverFactory });
});

test('http：日志只脱敏 key 值，凭据头名保持完整', async () => {
  const sentinel = 'sentinel-log-redaction-must-vanish';
  const genericSentinel = 'sentinel-generic-log-redaction-must-vanish';
  await withHttpServer({}, async ({ endpoint, logs }) => {
    const res = await rpc(endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, {
      'x-mmgrep-asr-provider': 'elevenlabs',
      'x-mmgrep-elevenlabs-api-key': sentinel,
      'x-mmgrep-asr-api-key': genericSentinel,
    });
    assert.equal(res.status, 200);

    const text = logs.join('\n');
    // provider id（elevenlabs）是头名的一部分：脱敏只认 key 值，头名必须原样保留。
    assert.match(text, /x-mmgrep-elevenlabs-api-key/, `凭据头名被脱敏破坏了：${text}`);
    assert.match(text, /x-mmgrep-asr-api-key/, `通用凭据头名被脱敏破坏了：${text}`);
    assert.ok(!text.includes('x-mmgrep-[redacted]-api-key'), `凭据头名被脱敏破坏了：${text}`);
    assert.ok(!text.includes(sentinel), `日志泄漏了 provider 专属 key：${text}`);
    assert.ok(!text.includes(genericSentinel), `日志泄漏了通用 key：${text}`);
  });
});

test('http：没有凭据头的请求复用共享 runtime（不重建 provider）', async () => {
  const seen = [];
  const serverFactory = (runtimeForRequest) => {
    seen.push(runtimeForRequest);
    return createServer(runtimeForRequest);
  };

  await withHttpServer({}, async ({ endpoint, runtime }) => {
    const res = await rpc(endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], runtime, '没带凭据时必须原样复用共享 runtime');
  }, { serverFactory });
});

test('http：未知 provider 头 → 400 / -32602，不构造 provider，也不回显 key', async () => {
  const seen = [];
  const sentinel = 'sentinel-key-must-not-be-echoed';
  const serverFactory = (runtimeForRequest) => {
    seen.push(runtimeForRequest);
    return createServer(runtimeForRequest);
  };

  await withHttpServer({}, async ({ endpoint, logs }) => {
    const res = await rpc(
      endpoint,
      { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} },
      {
        'x-mmgrep-asr-provider': 'whisper-cloud',
        'x-mmgrep-elevenlabs-api-key': sentinel,
      },
    );

    assert.equal(res.status, 400);
    assert.equal(res.json.jsonrpc, '2.0');
    assert.equal(res.json.error.code, -32602, 'INVALID_ARGUMENT 应该是 JSON-RPC 的 -32602');
    assert.equal(res.json.id, 7, '错误信封要带回请求 id');
    assert.match(res.json.error.message, /x-mmgrep-asr-provider/);
    assert.match(res.json.error.message, /elevenlabs/);
    assert.match(res.json.error.message, /openai-compatible/);
    assert.ok(!res.text.includes(sentinel), '错误响应回显了 key');
    assert.equal(seen.length, 0, 'provider id 不合法时不该构造任何 server / provider');

    const text = logs.join('\n');
    assert.ok(!text.includes(sentinel), `日志泄漏了 key：${text}`);
    assert.ok(!text.includes('whisper-cloud'), `日志泄漏了 provider 头的值：${text}`);
  }, { serverFactory });
});

test('http：请求头里的 key 不会落进缓存目录', async () => {
  const sentinel = 'sentinel-cache-dir-must-stay-clean';

  await withHttpServer({}, async ({ endpoint, dir }) => {
    const res = await rpc(
      endpoint,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      {
        'x-mmgrep-asr-provider': 'elevenlabs',
        'x-mmgrep-elevenlabs-api-key': sentinel,
      },
    );
    assert.equal(res.status, 200);

    const files = await listFiles(path.join(dir, 'cache'));
    for (const file of files) {
      const content = await readFile(file);
      assert.ok(!content.includes(sentinel), `${file} 的落盘内容里出现了请求头的 key`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 非凭据的请求级设置（x-mmgrep-max-text-inline-chars）
 * ------------------------------------------------------------------ */

test('http：内联上限请求头 —— 无头基线 / 头优先于 env / 200000 截断 / 非法回落 env', async () => {
  const seen = [];
  const serverFactory = (runtimeForRequest) => {
    seen.push(runtimeForRequest);
    return createServer(runtimeForRequest);
  };
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const headersFor = (value) => ({ 'x-mmgrep-max-text-inline-chars': value });

  await withHttpServer({ MMGREP_MAX_TEXT_INLINE_CHARS: '32000' }, async ({ endpoint, runtime, logs }) => {
    assert.equal(runtime.config.text.maxInlineChars, 32000, 'env 基线没有生效');

    // 1) 无头基线：复用共享 runtime，客户端不覆盖
    assert.equal((await rpc(endpoint, list)).status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], runtime, '没带头时必须原样复用共享 runtime');
    assert.equal(seen[0].config.text.maxInlineChars, 32000);

    // 2) 带头：本请求按头值生效；共享 runtime 保持不变
    assert.equal((await rpc(endpoint, { ...list, id: 2 }, headersFor('5000'))).status, 200);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[1], runtime);
    assert.equal(seen[1].config.text.maxInlineChars, 5000);
    assert.equal(runtime.config.text.maxInlineChars, 32000, '共享 runtime 被请求头改动了');
    assert.match(logs.join('\n'), /applying per-request config \(x-mmgrep-max-text-inline-chars\)/);

    // 3) 超过硬上限：按 200000 截断并 warn；日志不回显头值
    assert.equal((await rpc(endpoint, { ...list, id: 3 }, headersFor('250000'))).status, 200);
    assert.equal(seen[2].config.text.maxInlineChars, MAX_TEXT_INLINE_CHARS_HARD_CAP);
    const clampedLogs = logs.join('\n');
    assert.match(clampedLogs, /x-mmgrep-max-text-inline-chars exceeds the hard cap 200000/);
    assert.ok(!clampedLogs.includes('250000'), `日志回显了请求头的值：${clampedLogs}`);

    // 4) 非法值：warn + 回落 env（32000），不是默认 24000
    assert.equal((await rpc(endpoint, { ...list, id: 4 }, headersFor('not-a-number'))).status, 200);
    assert.equal(seen[3].config.text.maxInlineChars, 32000);
    const invalidLogs = logs.join('\n');
    assert.match(invalidLogs, /x-mmgrep-max-text-inline-chars is invalid; using the configured value 32000/);
    assert.ok(!invalidLogs.includes('not-a-number'), `日志回显了请求头的值：${invalidLogs}`);

    // 5) 空头等于没带：仍复用共享 runtime
    assert.equal((await rpc(endpoint, { ...list, id: 5 }, headersFor('   '))).status, 200);
    assert.equal(seen.length, 5);
    assert.equal(seen[4], runtime, '空头不该触发请求级覆盖');
  }, { serverFactory });
});

test('http：内联上限请求头 —— 没配 env 时缺省回落到 24000', async () => {
  const seen = [];
  const serverFactory = (runtimeForRequest) => {
    seen.push(runtimeForRequest);
    return createServer(runtimeForRequest);
  };
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

  await withHttpServer({}, async ({ endpoint, runtime }) => {
    assert.equal(runtime.config.text.maxInlineChars, DEFAULT_MAX_TEXT_INLINE_CHARS);

    // 无头：默认值，且复用共享 runtime
    assert.equal((await rpc(endpoint, list)).status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], runtime);

    // 带头：按头值覆盖默认值
    assert.equal(
      (await rpc(endpoint, { ...list, id: 2 }, { 'x-mmgrep-max-text-inline-chars': '36000' })).status,
      200,
    );
    assert.equal(seen[1].config.text.maxInlineChars, 36000);
  }, { serverFactory });
});
