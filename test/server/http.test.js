// test/server/http.test.js —— Streamable HTTP 传输：无状态端点、鉴权、路由、配置与日志
//
// 全程用 fetch 驱动，**不连外网**：端口传 0 让操作系统挑一个空闲端口，
// 真实地址从 server.address() 读回来（不写死端口，免得跟别的测试撞车）。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createLogger, loadConfig } from '../../src/server/config.js';
import { createRuntime, createServer, logStartupBanner } from '../../src/server/index.js';
import { startHttpServer } from '../../src/server/http.js';
import { assertFfmpegAvailable, run } from '../../src/media/ffmpeg.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src/index.js');

/** MCP 规范要求客户端同时接受 application/json 和 text/event-stream */
const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const TOOL_NAMES = ['media_probe', 'media_overview', 'media_zoom', 'media_locate', 'video_subtitles'];

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
async function withHttpServer(env, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-http-'));
  const baseEnv = { MMGREP_CACHE_DIR: path.join(dir, 'cache'), ...env };
  const config = loadConfig(baseEnv);
  const { logger, lines } = createCapturingLogger();
  const runtime = await createRuntime({ env: baseEnv, config, logger });
  // 端口 0：让操作系统挑空闲端口，真实地址从 server 对象读回来
  const endpoint = await startHttpServer({ runtime, config, port: 0 });
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

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

test('http：initialize 之后 tools/list 返回 5 个工具', async () => {
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
    assert.equal(right.json.result.tools.length, 5);

    // 令牌**不认** query string：带了也没用
    const viaQuery = await fetch(`${endpoint.url}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(message),
    });
    assert.equal(viaQuery.status, 401);
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
      MMGREP_DOC_PROVIDER: 'none',
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
