/**
 * OpenAI 兼容 ASR 适配器的测试。
 *
 * 全部打本地 stub server（node:http），**不联网、不用真 key**。
 */

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpenAICompatibleAsr } from '../../src/providers/asr/openai-compatible.js';
import { createAsrProvider, createNoneAsrProvider } from '../../src/providers/asr/index.js';

const FAKE_KEY = 'sk-openai-test-secret';

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
        endpoint: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
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

describe('OpenAI-compatible ASR provider', () => {
  let dir;
  let audioPath;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mmgrep-asr-oai-'));
    audioPath = join(dir, 'sample.wav');
    await writeFile(audioPath, Buffer.from('fake-wav-bytes'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('segments[] 直接解析成毫秒', async () => {
    const stub = await startStub(
      jsonHandler({
        text: 'Hello there my friend',
        language: 'en',
        model: 'whisper-1',
        segments: [
          { start: 0, end: 1.25, text: 'Hello there' },
          { start: 2.5, end: 3, text: 'my friend' },
        ],
      }),
    );
    try {
      const provider = createOpenAICompatibleAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const result = await provider.transcribe({ audioPath });

      assert.equal(result.provider, 'openai-compatible');
      assert.equal(result.model, 'whisper-1');
      assert.equal(result.language, 'en');
      assert.deepEqual(result.segments, [
        { startMs: 0, endMs: 1250, text: 'Hello there' },
        { startMs: 2500, endMs: 3000, text: 'my friend' },
      ]);
    } finally {
      await stub.close();
    }
  });

  test('没有 segments 时退化到 words[]（OpenAI 的词项用 word 键）并按 0.6s 断句', async () => {
    const stub = await startStub(
      jsonHandler({
        text: 'Hi there ok bye',
        words: [
          { word: 'Hi', start: 0, end: 0.2 },
          { word: 'there', start: 0.25, end: 0.6 },
          // 间隔 1.5 - 0.6 = 0.9s > 0.6s → 断句
          { word: 'ok', start: 1.5, end: 1.7 },
          { word: 'bye', start: 1.75, end: 2 },
        ],
      }),
    );
    try {
      const provider = createOpenAICompatibleAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const result = await provider.transcribe({ audioPath });
      assert.deepEqual(result.segments, [
        { startMs: 0, endMs: 600, text: 'Hi there' },
        { startMs: 1500, endMs: 2000, text: 'ok bye' },
      ]);
    } finally {
      await stub.close();
    }
  });

  test('既没有 segments 也没有 words 时退化成单段全文（endMs = null）', async () => {
    const stub = await startStub(jsonHandler({ text: 'One single line' }));
    try {
      const provider = createOpenAICompatibleAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const result = await provider.transcribe({ audioPath });
      assert.deepEqual(result.segments, [
        { startMs: 0, endMs: null, text: 'One single line' },
      ]);
    } finally {
      await stub.close();
    }
  });

  test('请求形状：POST {baseUrl}/audio/transcriptions，Authorization 用 Bearer，multipart 字段齐全', async () => {
    const stub = await startStub(jsonHandler({ text: 'ok' }));
    try {
      const provider = createOpenAICompatibleAsr({
        apiKey: FAKE_KEY,
        baseUrl: stub.baseUrl,
        model: 'whisper-1',
        language: 'zh',
      });
      await provider.transcribe({ audioPath });

      assert.equal(stub.requests.length, 1);
      const request = stub.requests[0];
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/audio/transcriptions');
      assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`);
      assert.match(request.headers['content-type'], /^multipart\/form-data/);
      assert.match(request.raw, /name="file"/);
      assert.match(request.raw, /name="model"\r\n\r\nwhisper-1/);
      assert.match(request.raw, /name="response_format"\r\n\r\nverbose_json/);
      assert.match(request.raw, /name="language"\r\n\r\nzh/);
    } finally {
      await stub.close();
    }
  });

  test('HTTP 401：错误可诊断（状态码 + 响应体），且不含 apiKey', async () => {
    const stub = await startStub(
      jsonHandler({ error: { message: 'Incorrect API key provided' } }, 401),
    );
    try {
      const provider = createOpenAICompatibleAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
      const error = await provider.transcribe({ audioPath }).then(
        () => null,
        (err) => err,
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /401/);
      assert.match(error.message, /Incorrect API key provided/);
      assert.ok(!error.message.includes(FAKE_KEY), '错误信息里不能出现 apiKey');
    } finally {
      await stub.close();
    }
  });

  test('HTTP 429 / 500：错误里带状态码', async () => {
    for (const status of [429, 500]) {
      const stub = await startStub(jsonHandler({ error: 'boom' }, status));
      try {
        const provider = createOpenAICompatibleAsr({ apiKey: FAKE_KEY, baseUrl: stub.baseUrl });
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
      const provider = createOpenAICompatibleAsr({
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
    } finally {
      await stub.close();
    }
  });

  test('describe() 绝不返回 apiKey', () => {
    const provider = createOpenAICompatibleAsr({
      apiKey: FAKE_KEY,
      baseUrl: 'https://api.openai.com/v1',
      model: 'whisper-1',
    });
    const described = provider.describe();
    assert.deepEqual(Object.keys(described).sort(), ['baseUrl', 'id', 'model']);
    assert.equal(described.id, 'openai-compatible');
    assert.equal(described.model, 'whisper-1');
    assert.equal(described.baseUrl, 'https://api.openai.com/v1');
    assert.ok(!JSON.stringify(described).includes(FAKE_KEY));
  });
});

describe('createAsrProvider（OpenAI 兼容相关）', () => {
  test('provider = openai-compatible 且有 key → 造出 provider，默认 baseUrl / model 正确', () => {
    const provider = createAsrProvider({
      MMGREP_ASR_PROVIDER: 'openai-compatible',
      MMGREP_OPENAI_COMPATIBLE_API_KEY: FAKE_KEY,
    });
    assert.equal(provider.id, 'openai-compatible');
    assert.deepEqual(provider.describe(), {
      id: 'openai-compatible',
      model: 'whisper-1',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  test('自定义 baseUrl / model / language 生效', () => {
    const provider = createAsrProvider({
      MMGREP_ASR_PROVIDER: 'openai-compatible',
      MMGREP_OPENAI_COMPATIBLE_API_KEY: FAKE_KEY,
      MMGREP_OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:8000/v1/',
      MMGREP_OPENAI_COMPATIBLE_MODEL: 'FunAudioLLM/SenseVoiceSmall',
    });
    assert.deepEqual(provider.describe(), {
      id: 'openai-compatible',
      model: 'FunAudioLLM/SenseVoiceSmall',
      baseUrl: 'http://127.0.0.1:8000/v1',
    });
  });

  test('MMGREP_ASR_LANGUAGE=auto（含大小写变体）不发送语言字段', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mmgrep-asr-oai-auto-'));
    const audioPath = join(dir, 'sample.wav');
    await writeFile(audioPath, Buffer.from('fake-wav-bytes'));
    const stub = await startStub(jsonHandler({ text: 'ok' }));
    try {
      for (const language of ['auto', 'AUTO', ' auto ']) {
        const provider = createAsrProvider({
          MMGREP_ASR_PROVIDER: 'openai-compatible',
          MMGREP_OPENAI_COMPATIBLE_API_KEY: FAKE_KEY,
          MMGREP_OPENAI_COMPATIBLE_BASE_URL: stub.baseUrl,
          MMGREP_ASR_LANGUAGE: language,
        });
        await provider.transcribe({ audioPath });
      }
      assert.equal(stub.requests.length, 3);
      for (const request of stub.requests) {
        assert.doesNotMatch(request.raw, /name="language"\r\n/, 'auto 不能作为语言码发出去');
      }
    } finally {
      await stub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('provider = openai-compatible 但没给 key → 构造不报错，transcribe() 时说清缺哪个环境变量', async () => {
    const provider = createAsrProvider({ MMGREP_ASR_PROVIDER: 'openai-compatible' });
    assert.ok(provider, '缺 key 时也要返回 provider，不能是 null');
    assert.equal(provider.id, 'openai-compatible');

    const error = await provider.transcribe({ audioPath: '/tmp/whatever.mp3' }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /MMGREP_OPENAI_COMPATIBLE_API_KEY/);
    assert.ok(!/sk-/.test(error.message), '错误信息里不能出现任何看起来像 key 的东西');
  });

  test('none provider：transcribe() 抛出「只返回画面内容」的明确错误', async () => {
    const provider = createNoneAsrProvider();
    assert.equal(provider.id, 'none');
    const error = await provider.transcribe({ audioPath: '/tmp/whatever.mp3' }).then(
      () => null,
      (err) => err,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /only visual content/i);
    assert.match(error.message, /MMGREP_ASR_PROVIDER/);
  });
});
