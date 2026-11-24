/**
 * DeepSeek ASR 适配器的测试。
 *
 * 全部打本地 stub server（node:http），**不联网、不用真 key**。
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  createDeepSeekAsr,
  parseDeepSeekResponse,
} from '../../src/providers/asr/deepseek.js';
import { createAsrProvider, createNoneAsrProvider } from '../../src/providers/asr/index.js';

const FAKE_KEY = 'sk-deepseek-test-secret';

/** DeepSeek 单请求上限：8 MiB */
const EIGHT_MIB = 8 * 1024 * 1024;

/**
 * 起一个本地 stub server，把收到的请求记下来。
 * @param {(ctx:{req:http.IncomingMessage,res:http.ServerResponse,raw:string}) => void} handler
 */
function startStub(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('latin1');
        requests.push({ method: req.method, url: req.url, headers: req.headers, raw });
        handler({ req, res, raw });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        requests,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        endpoint: `http://127.0.0.1:${port}/v1/tools/asr`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function jsonHandler(payload, status = 200) {
  return ({ res }) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

describe('DeepSeek ASR provider', () => {
  let dir;
  let audioPath;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mmgrep-asr-deepseek-'));
    audioPath = join(dir, 'sample.wav');
    await writeFile(audioPath, Buffer.from('fake-wav-bytes'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('正常响应：整段 text + duration_ms 变成单段毫秒', async () => {
    const stub = await startStub(
      jsonHandler({ request_id: 'req-123', text: 'Hello from DeepSeek', duration_ms: 4200 }),
    );
    try {
      const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const result = await provider.transcribe({ audioPath, language: 'en' });

      assert.equal(result.provider, 'deepseek');
      assert.equal(result.model, null, 'DEEPSEEK_DEFAULT_MODEL 为空，对外是 null');
      assert.equal(result.language, 'en');
      assert.deepEqual(result.segments, [
        { startMs: 0, endMs: 4200, text: 'Hello from DeepSeek' },
      ]);
      assert.deepEqual(result.raw, { request_id: 'req-123', text: 'Hello from DeepSeek', duration_ms: 4200 });
    } finally {
      await stub.close();
    }
  });

  test('text 首尾空白会被 trim；duration_ms 取整', async () => {
    const stub = await startStub(
      jsonHandler({ request_id: 'req-2', text: '  你好世界  ', duration_ms: 1500.4 }),
    );
    try {
      const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const result = await provider.transcribe({ audioPath });
      assert.deepEqual(result.segments, [{ startMs: 0, endMs: 1500, text: '你好世界' }]);
    } finally {
      await stub.close();
    }
  });

  test('空 / 纯空白 text → segments: []', async () => {
    for (const text of ['', '   ', '\n\t']) {
      const stub = await startStub(jsonHandler({ request_id: 'req-empty', text, duration_ms: 1000 }));
      try {
        const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
        const result = await provider.transcribe({ audioPath });
        assert.deepEqual(result.segments, [], `text=${JSON.stringify(text)} 应当没有分段`);
        assert.equal(result.provider, 'deepseek');
      } finally {
        await stub.close();
      }
    }
  });

  test('缺 duration_ms / 非法 duration_ms → endMs: null', async () => {
    for (const payload of [
      { request_id: 'req-x', text: 'One line' },
      { request_id: 'req-x', text: 'One line', duration_ms: 'n/a' },
      { request_id: 'req-x', text: 'One line', duration_ms: -1 },
    ]) {
      const stub = await startStub(jsonHandler(payload));
      try {
        const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
        const result = await provider.transcribe({ audioPath });
        assert.deepEqual(result.segments, [{ startMs: 0, endMs: null, text: 'One line' }]);
      } finally {
        await stub.close();
      }
    }
  });

  test('请求形状：POST {baseUrl}/tools/asr，Bearer 认证，multipart 只发 file', async () => {
    const stub = await startStub(jsonHandler({ request_id: 'req-3', text: 'ok', duration_ms: 100 }));
    try {
      const provider = createDeepSeekAsr({
        apiKey: FAKE_KEY,
        baseUrl: stub.baseUrl,
        language: 'zh',
      });
      await provider.transcribe({ audioPath });

      assert.equal(stub.requests.length, 1);
      const request = stub.requests[0];
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/tools/asr');
      assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`);
      assert.match(request.headers['content-type'], /^multipart\/form-data/);
      assert.match(request.raw, /name="file"/);
      assert.match(request.raw, /name="file"; filename="sample.wav"/);
      assert.match(request.raw, /Content-Type: audio\/wav/i);
      // DeepSeek /v1/tools/asr 只有 file 一个字段：发 model / language 会被判非法参数。
      assert.doesNotMatch(request.raw, /name="model"/);
      assert.doesNotMatch(request.raw, /name="language"/);
    } finally {
      await stub.close();
    }
  });

  test('MMGREP_ASR_LANGUAGE=auto 归一成 null，绝不作为字段发出去', async () => {
    const stub = await startStub(jsonHandler({ request_id: 'req-auto', text: 'ok', duration_ms: 100 }));
    try {
      for (const language of ['auto', 'AUTO', ' auto ']) {
        const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl, language });
        const result = await provider.transcribe({ audioPath });
        assert.equal(result.language, null);
      }
      assert.equal(stub.requests.length, 3);
      for (const request of stub.requests) {
        assert.doesNotMatch(request.raw, /name="language"\r\n/);
      }
    } finally {
      await stub.close();
    }
  });

  test('自定义 baseUrl：去掉末尾斜杠；describe() 绝不返回 apiKey', () => {
    const provider = createDeepSeekAsr({
      apiKey: FAKE_KEY,
      baseUrl: 'http://127.0.0.1:9999/v1/',
      model: 'deepseek-asr',
    });
    const described = provider.describe();
    assert.deepEqual(Object.keys(described).sort(), ['baseUrl', 'id', 'model']);
    assert.equal(described.id, 'deepseek');
    assert.equal(described.baseUrl, 'http://127.0.0.1:9999/v1');
    assert.equal(described.model, 'deepseek-asr');
    assert.ok(!JSON.stringify(described).includes(FAKE_KEY), 'describe() 不能出现 apiKey');

    const defaults = createDeepSeekAsr({ apiKey: FAKE_KEY });
    assert.deepEqual(defaults.describe(), {
      id: 'deepseek',
      model: null,
      baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
    });
    assert.equal(DEEPSEEK_DEFAULT_MODEL, '');
  });

  test('超过 8 MiB 的文件在 fetch 之前就被拒绝', async () => {
    const bigPath = join(dir, 'too-big.wav');
    await writeFile(bigPath, Buffer.alloc(EIGHT_MIB + 1, 1));

    const stub = await startStub(jsonHandler({ request_id: 'req-big', text: 'should not happen' }));
    try {
      const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const error = await provider.transcribe({ audioPath: bigPath }).then(
        () => null,
        (err) => err,
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /byte limit/);
      assert.match(error.message, /chunks/i, '错误信息要提示分块');
      assert.ok(error.message.includes(String(EIGHT_MIB)), '错误信息要给出字节上限');
      assert.equal(stub.requests.length, 0, '超限时不许发请求');
      assert.ok(!error.message.includes(FAKE_KEY));
    } finally {
      await stub.close();
      await rm(bigPath, { force: true });
    }
  });

  test('HTTP 400 / 413 / 429 / 500：错误可诊断且不回显 apiKey', async () => {
    for (const status of [400, 413, 429, 500]) {
      const stub = await startStub(
        jsonHandler({ error: { message: `boom with key ${FAKE_KEY}` } }, status),
      );
      try {
        const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
        const error = await provider.transcribe({ audioPath }).then(
          () => null,
          (err) => err,
        );
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(String(status)));
        assert.equal(error.message.includes(FAKE_KEY), false, '错误信息里不能出现 apiKey');
      } finally {
        await stub.close();
      }
    }
  });

  test('非 JSON 响应（HTTP 200）：报错并打码 apiKey', async () => {
    const stub = await startStub(
      ({ res }) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`upstream gateway says: key=${FAKE_KEY} is invalid`);
      },
    );
    try {
      const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const error = await provider.transcribe({ audioPath }).then(
        () => null,
        (err) => err,
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /non-JSON/i);
      assert.equal(error.message.includes(FAKE_KEY), false, '错误信息里不能出现 apiKey');
    } finally {
      await stub.close();
    }
  });

  test('超时：超过 timeoutMs 后报超时', async () => {
    const stub = await startStub(
      ({ res }) => {
        setTimeout(() => {
          try {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: 'too late' }));
          } catch {
            /* 客户端已经断开，忽略 */
          }
        }, 400).unref?.();
      },
    );
    try {
      const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl, timeoutMs: 80 });
      const error = await provider.transcribe({ audioPath }).then(
        () => null,
        (err) => err,
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /timed out/i);
    } finally {
      await stub.close();
    }
  });

  test('调用方的 AbortSignal：报「被调用方取消」', async () => {
    const stub = await startStub(
      ({ res }) => {
        setTimeout(() => {
          try {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ text: 'too late' }));
          } catch {
            /* 忽略 */
          }
        }, 400).unref?.();
      },
    );
    try {
      const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const controller = new AbortController();
      const pending = provider.transcribe({ audioPath, signal: controller.signal }).then(
        () => null,
        (err) => err,
      );
      controller.abort();
      const error = await pending;
      assert.ok(error instanceof Error);
      assert.match(error.message, /aborted by the caller/i);
    } finally {
      await stub.close();
    }
  });

  test('缺 audioPath → 直接报错，不发请求', async () => {
    const provider = createDeepSeekAsr({ apiKey: FAKE_KEY, baseUrl: 'http://127.0.0.1:1/v1' });
    const error = await provider.transcribe({}).then(
      () => null,
      (err) => err,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /audioPath/);
  });
});

describe('parseDeepSeekResponse（纯函数）', () => {
  test('text + duration_ms → 单段全文', () => {
    assert.deepEqual(
      parseDeepSeekResponse({ request_id: 'r', text: ' hi ', duration_ms: 2000 }),
      [{ startMs: 0, endMs: 2000, text: 'hi' }],
    );
  });

  test('空文本 → []；缺时长 → endMs: null', () => {
    assert.deepEqual(parseDeepSeekResponse({ text: '' }), []);
    assert.deepEqual(parseDeepSeekResponse(null), []);
    assert.deepEqual(parseDeepSeekResponse({ text: 'x' }), [{ startMs: 0, endMs: null, text: 'x' }]);
  });
});

describe('createAsrProvider（DeepSeek 相关）', () => {
  test('provider = deepseek 且有 key → 造出 provider，默认 baseUrl / model 正确', () => {
    const provider = createAsrProvider({
      MMGREP_ASR_PROVIDER: 'deepseek',
      MMGREP_DEEPSEEK_API_KEY: FAKE_KEY,
    });
    assert.equal(provider.id, 'deepseek');
    assert.deepEqual(provider.describe(), {
      id: 'deepseek',
      model: null,
      baseUrl: 'https://api.deepseek.com/v1',
    });
  });

  test('自定义 baseUrl（含末尾斜杠）/ model / language 生效', () => {
    const provider = createAsrProvider({
      MMGREP_ASR_PROVIDER: 'deepseek',
      MMGREP_DEEPSEEK_API_KEY: FAKE_KEY,
      MMGREP_DEEPSEEK_BASE_URL: 'http://127.0.0.1:8000/v1/',
      MMGREP_DEEPSEEK_MODEL: 'deepseek-asr-v1',
    });
    assert.deepEqual(provider.describe(), {
      id: 'deepseek',
      model: 'deepseek-asr-v1',
      baseUrl: 'http://127.0.0.1:8000/v1',
    });
  });

  test('MMGREP_ASR_MAX_BYTES 未设置时默认按 provider 分组（deepseek = 8 MiB）', async () => {
    const bigPath = join(
      await mkdtemp(join(tmpdir(), 'mmgrep-asr-deepseek-max-')),
      'big.wav',
    );
    await writeFile(bigPath, Buffer.alloc(EIGHT_MIB + 1, 1));

    const stub = await startStub(jsonHandler({ request_id: 'r', text: 'nope', duration_ms: 1 }));
    try {
      const provider = createAsrProvider({
        MMGREP_ASR_PROVIDER: 'deepseek',
        MMGREP_DEEPSEEK_API_KEY: FAKE_KEY,
        MMGREP_DEEPSEEK_BASE_URL: stub.baseUrl,
      });
      const error = await provider.transcribe({ audioPath: bigPath }).then(
        () => null,
        (err) => err,
      );
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(String(EIGHT_MIB)), 'deepseek 默认上限必须是 8 MiB');
      assert.equal(stub.requests.length, 0);
    } finally {
      await stub.close();
      await rm(bigPath, { force: true });
    }
  });

  test('provider = deepseek 但没给 key → 构造不报错，transcribe() 时说清缺哪个环境变量', async () => {
    const provider = createAsrProvider({ MMGREP_ASR_PROVIDER: 'deepseek' });
    assert.ok(provider, '缺 key 时也要返回 provider，不能是 null');
    assert.equal(provider.id, 'deepseek');

    const error = await provider.transcribe({ audioPath: '/tmp/whatever.wav' }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /MMGREP_DEEPSEEK_API_KEY/);
    assert.ok(!/sk-/.test(error.message), '错误信息里不能出现任何看起来像 key 的东西');
  });

  test('none provider：错误信息提到 deepseek 与 MMGREP_DEEPSEEK_API_KEY', async () => {
    const provider = createNoneAsrProvider();
    assert.equal(provider.id, 'none');
    const error = await provider.transcribe({ audioPath: '/tmp/whatever.wav' }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /only visual content/i);
    assert.match(error.message, /deepseek/);
    assert.match(error.message, /MMGREP_DEEPSEEK_API_KEY/);
  });

  test('provider id 大小写不敏感', () => {
    const provider = createAsrProvider({
      MMGREP_ASR_PROVIDER: 'DeepSeek',
      MMGREP_DEEPSEEK_API_KEY: FAKE_KEY,
    });
    assert.equal(provider.id, 'deepseek');
  });
});
