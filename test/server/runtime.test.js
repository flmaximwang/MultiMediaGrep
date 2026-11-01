// test/server/runtime.test.js —— runtime 装配：provider 三态降级 + 本地 HTTP stub
//
// 用 node:http 起一个假的 OpenAI 兼容 ASR 服务，验证：
//   1. 用户配置的 ASR provider 被装进 runtime（不联网、只用 127.0.0.1）；
//   2. provider 真正按 OpenAI 协议发 multipart 请求，响应被归一化成毫秒；
//   3. key 不会出现在 describe() / 日志里；
//   4. provider 名拼错时 runtime 不崩，错误记进 providerErrors。
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createPlaceholderBackend } from '../../src/server/backends.js';
import { createLogger } from '../../src/server/config.js';
import { createRuntime, isLoopbackUrl } from '../../src/server/index.js';

const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });
const SECRET = 'sk-test-secret-key';

/** 起一个本地 HTTP stub，记录请求并返回固定 JSON */
async function startStub(responseBody) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('latin1'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function runtimeOptions(env, extra = {}) {
  return {
    env,
    cache: null,
    logger: SILENT_LOGGER,
    backends: {
      video: createPlaceholderBackend('video'),
      audio: createPlaceholderBackend('audio'),
      document: createPlaceholderBackend('document'),
    },
    ...extra,
  };
}

test('createRuntime：ASR provider 接上 stub 端点，transcribe 走 multipart 并归一化毫秒', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-runtime-'));
  const audioPath = path.join(dir, 'clip.mp3');
  await writeFile(audioPath, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]));

  const stub = await startStub({
    text: '你好世界',
    language: 'zh',
    model: 'whisper-1',
    segments: [{ start: 0.5, end: 1.75, text: '你好世界' }],
  });

  try {
    const runtime = await createRuntime(runtimeOptions({
      MMGREP_CACHE_DIR: path.join(dir, 'cache'),
      MMGREP_ASR_PROVIDER: 'openai-compatible',
      MMGREP_ASR_API_KEY: SECRET,
      MMGREP_ASR_BASE_URL: stub.baseUrl,
      MMGREP_ASR_MODEL: 'whisper-1',
      MMGREP_ASR_LANGUAGE: 'zh',
    }));

    assert.deepEqual(runtime.providerErrors, {});
    assert.ok(runtime.asrProvider, 'ASR provider should be wired into the runtime');
    const described = runtime.asrProvider.describe();
    assert.equal(described.id, 'openai-compatible');
    assert.equal(described.baseUrl, stub.baseUrl);
    assert.equal(JSON.stringify(described).includes(SECRET), false, 'describe() must not leak the key');

    const result = await runtime.asrProvider.transcribe({ audioPath });
    assert.equal(result.provider, 'openai-compatible');
    assert.deepEqual(result.segments, [{ startMs: 500, endMs: 1750, text: '你好世界' }]);

    assert.equal(stub.requests.length, 1);
    const [request] = stub.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/audio/transcriptions');
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
    assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(request.body, /name="model"/);
    assert.match(request.body, /whisper-1/);
  } finally {
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('createRuntime：provider=none → null；provider 拼错 → 不崩，记进 providerErrors', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-runtime-'));
  try {
    const none = await createRuntime(runtimeOptions({
      MMGREP_CACHE_DIR: path.join(dir, 'cache-none'),
      MMGREP_ASR_PROVIDER: 'none',
    }));
    assert.equal(none.asrProvider, null);
    assert.deepEqual(none.providerErrors, {});

    const typo = await createRuntime(runtimeOptions({
      MMGREP_CACHE_DIR: path.join(dir, 'cache-typo'),
      MMGREP_ASR_PROVIDER: 'elevenlabz',
    }));
    assert.equal(typo.asrProvider, null);
    assert.match(typo.providerErrors.asr, /elevenlabz/);
    assert.match(typo.providerErrors.asr, /could not be configured/);

    // 选了 provider 但缺 key → provider 对象仍在，真正调用时才报错（三态降级）
    const missingKey = await createRuntime(runtimeOptions({
      MMGREP_CACHE_DIR: path.join(dir, 'cache-nokey'),
      MMGREP_ASR_PROVIDER: 'elevenlabs',
    }));
    assert.ok(missingKey.asrProvider);
    await assert.rejects(
      () => missingKey.asrProvider.transcribe({ audioPath: path.join(dir, 'missing.mp3') }),
      /MMGREP_ASR_API_KEY/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isLoopbackUrl：回环地址不需要 API key', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:8080/v1'), true);
  assert.equal(isLoopbackUrl('http://localhost:9000'), true);
  assert.equal(isLoopbackUrl('http://[::1]:9000'), true);
  assert.equal(isLoopbackUrl('https://api.elevenlabs.io/v1'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
  assert.equal(isLoopbackUrl(null), false);
});
