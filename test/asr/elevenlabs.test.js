/**
 * ElevenLabs ASR 适配器的测试。
 *
 * 全部打本地 stub server（node:http），**不联网、不用真 key**。
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createElevenLabsAsr } from '../../src/providers/asr/elevenlabs.js';
import { createAsrProvider } from '../../src/providers/asr/index.js';

const FAKE_KEY = 'sk-elevenlabs-test-secret';

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
        endpoint: `http://127.0.0.1:${port}/v1/speech-to-text`,
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

describe('ElevenLabs ASR provider', () => {
  let dir;
  let audioPath;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mmgrep-asr-el-'));
    audioPath = join(dir, 'sample.mp3');
    // 只是占位：适配器只负责把字节原样上传，不解析音频内容
    await writeFile(audioPath, Buffer.from('fake-mp3-bytes'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('words[] 聚合成句子级片段，秒换算成整数毫秒', async () => {
    const stub = await startStub(
      jsonHandler({
        text: 'Hello world. How are you?',
        language_code: 'en',
        words: [
          { text: 'Hello', start: 0, end: 0.4, type: 'word' },
          { text: 'world', start: 0.5, end: 0.9, type: 'word' },
          // 间隔 2.0 - 0.9 = 1.1s > 0.6s → 断句
          { text: 'How', start: 2, end: 2.3, type: 'word' },
          { text: 'are', start: 2.35, end: 2.6, type: 'word' },
          { text: 'you', start: 2.65, end: 3.1, type: 'word' },
        ],
      }),
    );
    try {
      const provider = createElevenLabsAsr({
        apiKey: FAKE_KEY,
        baseUrl: stub.baseUrl,
        model: 'scribe_v1',
      });
      const result = await provider.transcribe({ audioPath });

      assert.equal(result.provider, 'elevenlabs');
      assert.equal(result.model, 'scribe_v1');
      assert.equal(result.language, 'en');
      assert.deepEqual(result.segments, [
        { startMs: 0, endMs: 900, text: 'Hello world' },
        { startMs: 2000, endMs: 3100, text: 'How are you' },
      ]);
      for (const segment of result.segments) {
        assert.ok(Number.isInteger(segment.startMs), 'startMs 必须是整数');
        assert.ok(Number.isInteger(segment.endMs), 'endMs 必须是整数');
        assert.ok(segment.endMs >= segment.startMs, 'endMs 不能早于 startMs');
      }
    } finally {
      await stub.close();
    }
  });

  test('请求形状：POST {baseUrl}/speech-to-text，header 用 xi-api-key，multipart 字段齐全', async () => {
    const stub = await startStub(jsonHandler({ text: 'ok', words: [] }));
    try {
      const provider = createElevenLabsAsr({
        apiKey: FAKE_KEY,
        baseUrl: stub.baseUrl,
        model: 'scribe_v1',
        language: 'zh',
      });
      await provider.transcribe({ audioPath });

      assert.equal(stub.requests.length, 1);
      const request = stub.requests[0];
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/speech-to-text');
      assert.equal(request.headers['xi-api-key'], FAKE_KEY);
      assert.match(request.headers['content-type'], /^multipart\/form-data/);
      assert.match(request.raw, /name="file"/);
      assert.match(request.raw, /name="model_id"\r\n\r\nscribe_v1/);
      assert.match(request.raw, /name="language_code"\r\n\r\nzh/);
      assert.match(request.raw, /name="diarize"\r\n\r\nfalse/);
      assert.match(request.raw, /name="timestamps_granularity"\r\n\r\nword/);
    } finally {
      await stub.close();
    }
  });

  test('响应带 segments[] 时直接采用', async () => {
    const stub = await startStub(
      jsonHandler({
        text: 'Hi there',
        segments: [
          { start: 1, end: 2, text: 'Hi' },
          { start: 3.5, end: 4.25, text: 'there' },
        ],
      }),
    );
    try {
      const provider = createElevenLabsAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const result = await provider.transcribe({ audioPath });
      assert.deepEqual(result.segments, [
        { startMs: 1000, endMs: 2000, text: 'Hi' },
        { startMs: 3500, endMs: 4250, text: 'there' },
      ]);
    } finally {
      await stub.close();
    }
  });

  test('只有 text 时退化成单段全文（endMs = null）', async () => {
    const stub = await startStub(jsonHandler({ text: 'Just one blob of text' }));
    try {
      const provider = createElevenLabsAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const result = await provider.transcribe({ audioPath });
      assert.deepEqual(result.segments, [
        { startMs: 0, endMs: null, text: 'Just one blob of text' },
      ]);
    } finally {
      await stub.close();
    }
  });

  test('空结果：没有 words / segments / text 时 segments 为空数组', async () => {
    const stub = await startStub(jsonHandler({ text: '', words: [] }));
    try {
      const provider = createElevenLabsAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const result = await provider.transcribe({ audioPath });
      assert.deepEqual(result.segments, []);
    } finally {
      await stub.close();
    }
  });

  test('HTTP 401：错误可诊断（状态码 + 响应体），且不含 apiKey', async () => {
    const stub = await startStub(
      jsonHandler({ detail: 'Invalid API key supplied' }, 401),
    );
    try {
      const provider = createElevenLabsAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const error = await provider.transcribe({ audioPath }).then(
        () => null,
        (err) => err,
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /401/);
      assert.match(error.message, /Invalid API key supplied/);
      assert.ok(!error.message.includes(FAKE_KEY), '错误信息里不能出现 apiKey');
    } finally {
      await stub.close();
    }
  });

  test('HTTP 429 / 500：错误里带状态码', async () => {
    for (const status of [429, 500]) {
      const stub = await startStub(jsonHandler({ error: 'boom' }, status));
      try {
        const provider = createElevenLabsAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
        const error = await provider.transcribe({ audioPath }).then(
          () => null,
          (err) => err,
        );
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(String(status)));
        assert.ok(!error.message.includes(FAKE_KEY));
      } finally {
        await stub.close();
      }
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
      const provider = createElevenLabsAsr({
        apiKey: FAKE_KEY,
        baseUrl: stub.baseUrl,
        timeoutMs: 80,
      });
      const error = await provider.transcribe({ audioPath }).then(
        () => null,
        (err) => err,
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /timed out/i);
      assert.ok(!error.message.includes(FAKE_KEY));
    } finally {
      await stub.close();
    }
  });

  test('describe() 绝不返回 apiKey', async () => {
    const provider = createElevenLabsAsr({
      apiKey: FAKE_KEY,
      baseUrl: 'https://api.elevenlabs.io/v1',
      model: 'scribe_v1',
    });
    const described = provider.describe();
    assert.deepEqual(Object.keys(described).sort(), ['baseUrl', 'id', 'model']);
    assert.equal(described.id, 'elevenlabs');
    assert.equal(described.model, 'scribe_v1');
    assert.equal(described.baseUrl, 'https://api.elevenlabs.io/v1');
    assert.ok(!JSON.stringify(described).includes(FAKE_KEY));
  });

  test('语言与超时可以由环境变量控制（language_code 真的发出去）', async () => {
    const stub = await startStub(jsonHandler({ text: 'ok' }));
    try {
      const provider = createAsrProvider({
        MMGREP_ASR_PROVIDER: 'elevenlabs',
        MMGREP_ELEVENLABS_API_KEY: FAKE_KEY,
        MMGREP_ELEVENLABS_BASE_URL: stub.baseUrl,
        MMGREP_ASR_LANGUAGE: 'zh',
        MMGREP_ASR_TIMEOUT_MS: '30000',
      });
      await provider.transcribe({ audioPath });
      assert.match(stub.requests[0].raw, /name="language_code"\r\n\r\nzh/);
    } finally {
      await stub.close();
    }
  });

  test('音频超过体积上限：给出清晰错误并提示去切 ≤45 秒', async () => {
    const provider = createElevenLabsAsr({
      apiKey: FAKE_KEY,
      baseUrl: 'https://api.elevenlabs.io/v1',
      maxBytes: 4,
    });
    const error = await provider.transcribe({ audioPath }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /45 seconds/);
    assert.match(error.message, /over the 4 byte limit/);
  });

  test('调用方的 signal 可以取消请求', async () => {
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
      const provider = createElevenLabsAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const controller = new AbortController();
      const pending = provider.transcribe({ audioPath, signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      const error = await pending.then(
        () => null,
        (err) => err,
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /aborted by the caller/i);
    } finally {
      await stub.close();
    }
  });
});

describe('createAsrProvider（ElevenLabs 相关）', () => {
  test('默认（没设 MMGREP_ASR_PROVIDER）返回 null', () => {
    assert.equal(createAsrProvider({}), null);
  });

  test('provider = none 返回 null', () => {
    assert.equal(createAsrProvider({ MMGREP_ASR_PROVIDER: 'none' }), null);
  });

  test('provider = elevenlabs 且有 key → 造出 provider，默认 baseUrl / model 正确', () => {
    const provider = createAsrProvider({
      MMGREP_ASR_PROVIDER: 'elevenlabs',
      MMGREP_ELEVENLABS_API_KEY: FAKE_KEY,
    });
    assert.equal(provider.id, 'elevenlabs');
    assert.deepEqual(provider.describe(), {
      id: 'elevenlabs',
      model: 'scribe_v1',
      baseUrl: 'https://api.elevenlabs.io/v1',
    });
  });

  test('provider = elevenlabs 但没给 key → 构造不报错，transcribe() 时说清缺哪个环境变量', async () => {
    const provider = createAsrProvider({ MMGREP_ASR_PROVIDER: 'elevenlabs' });
    assert.ok(provider, '缺 key 时也要返回 provider，不能是 null');
    assert.equal(provider.id, 'elevenlabs');

    const error = await provider.transcribe({ audioPath: '/tmp/whatever.mp3' }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /MMGREP_ELEVENLABS_API_KEY/);
    assert.ok(!/sk-/.test(error.message), '错误信息里不能出现任何看起来像 key 的东西');
  });

  test('不认识的 provider id 直接报错（拼写错误必须吵醒用户）', () => {
    assert.throws(
      () => createAsrProvider({ MMGREP_ASR_PROVIDER: 'eleven-lab' }),
      /MMGREP_ASR_PROVIDER/,
    );
  });

  test('baseUrl 外面包了引号也能用（Windows setx 的老坑）', () => {
    const provider = createAsrProvider({
      MMGREP_ASR_PROVIDER: 'elevenlabs',
      MMGREP_ELEVENLABS_API_KEY: FAKE_KEY,
      MMGREP_ELEVENLABS_BASE_URL: '"https://example.test/v1"',
    });
    assert.equal(provider.describe().baseUrl, 'https://example.test/v1');
  });
});
