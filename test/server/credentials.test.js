// test/server/credentials.test.js —— 逐请求凭据：请求头 → 本次请求配置
//
// 这一层是 HTTP 端点的安全边界：头里的 key 只能活在一次请求里。
// 单测只碰纯函数，不构造 provider、不发网络请求（集成路径见 http.test.js）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
  loadConfig,
} from '../../src/server/config.js';
import {
  REQUEST_HEADERS,
  presentCredentialHeaders,
  resolveConfigForRequest,
} from '../../src/server/credentials.js';
import { ToolError } from '../../src/media/interface.js';

/** 一份「服务器侧已配置两家 ASR」的环境：测试逐字段优先级用 */
const SERVER_ENV = Object.freeze({
  MMGREP_ASR_PROVIDER: 'elevenlabs',
  MMGREP_ELEVENLABS_API_KEY: 'env-elevenlabs-key',
  MMGREP_ELEVENLABS_BASE_URL: 'https://env.elevenlabs.example/v1',
  MMGREP_ELEVENLABS_MODEL: 'env-elevenlabs-model',
  MMGREP_OPENAI_COMPATIBLE_API_KEY: 'env-openai-key',
  MMGREP_DOC_PROVIDER: 'mineru',
  MMGREP_MINERU_API_KEY: 'env-mineru-key',
  MMGREP_MINERU_BASE_URL: 'https://env.mineru.example/api/v4',
});

function baseConfig(env = SERVER_ENV) {
  return loadConfig(env);
}

test('REQUEST_HEADERS：头名就是环境变量名的小写连字符形式', () => {
  assert.deepEqual(REQUEST_HEADERS, {
    asr: {
      provider: 'x-mmgrep-asr-provider',
      genericApiKey: 'x-mmgrep-asr-api-key',
      providers: {
        elevenlabs: {
          apiKey: 'x-mmgrep-elevenlabs-api-key',
          baseUrl: 'x-mmgrep-elevenlabs-base-url',
          model: 'x-mmgrep-elevenlabs-model',
        },
        'openai-compatible': {
          apiKey: 'x-mmgrep-openai-compatible-api-key',
          baseUrl: 'x-mmgrep-openai-compatible-base-url',
          model: 'x-mmgrep-openai-compatible-model',
        },
      },
    },
    doc: {
      provider: 'x-mmgrep-doc-provider',
      genericApiKey: 'x-mmgrep-doc-api-key',
      providers: {
        mineru: {
          apiKey: 'x-mmgrep-mineru-api-key',
          baseUrl: 'x-mmgrep-mineru-base-url',
          model: 'x-mmgrep-mineru-model',
        },
      },
    },
  });
});

test('presentCredentialHeaders：只认非空的已知凭据头', () => {
  assert.deepEqual(presentCredentialHeaders({}), []);
  assert.deepEqual(presentCredentialHeaders({ authorization: 'Bearer x' }), []);
  assert.deepEqual(
    presentCredentialHeaders({
      'x-mmgrep-asr-provider': 'elevenlabs',
      'x-mmgrep-elevenlabs-api-key': '',
      'X-MMGREP-ELEVENLABS-MODEL': '  scribe_v2  ',
    }),
    ['x-mmgrep-asr-provider', 'x-mmgrep-elevenlabs-model'],
  );
});

test('请求头优先于环境变量（apiKey / baseUrl / model 三个字段）', () => {
  const config = resolveConfigForRequest(
    baseConfig(),
    {
      'x-mmgrep-elevenlabs-api-key': 'header-key',
      'x-mmgrep-elevenlabs-base-url': 'https://header.example/v1',
      'x-mmgrep-elevenlabs-model': 'header-model',
    },
    SERVER_ENV,
  );

  assert.equal(config.asr.provider, 'elevenlabs');
  assert.equal(config.asr.apiKey, 'header-key');
  assert.equal(config.asr.apiKeySource, 'x-mmgrep-elevenlabs-api-key');
  assert.equal(config.asr.baseUrl, 'https://header.example/v1');
  assert.equal(config.asr.model, 'header-model');
});

test('没带头的字段回落到所选 provider 专属的环境变量', () => {
  const config = resolveConfigForRequest(
    baseConfig(),
    { 'x-mmgrep-asr-provider': 'elevenlabs' },
    SERVER_ENV,
  );

  assert.equal(config.asr.apiKey, 'env-elevenlabs-key');
  assert.equal(config.asr.apiKeySource, 'MMGREP_ELEVENLABS_API_KEY');
  assert.equal(config.asr.baseUrl, 'https://env.elevenlabs.example/v1');
  assert.equal(config.asr.model, 'env-elevenlabs-model');
});

test('请求头切换 provider：只用新 provider 的变量组，绝不借用旧 provider 的 key', () => {
  const config = resolveConfigForRequest(
    baseConfig(),
    { 'x-mmgrep-asr-provider': 'openai-compatible' },
    SERVER_ENV,
  );

  assert.equal(config.asr.provider, 'openai-compatible');
  // 新 provider 自己的 env 变量在——可以用。
  assert.equal(config.asr.apiKey, 'env-openai-key');

  // 环境里没有 openai-compatible 的 key、只有 elevenlabs 的 key 时：必须是空，不能借用。
  const envWithoutOpenAi = {
    MMGREP_ASR_PROVIDER: 'elevenlabs',
    MMGREP_ELEVENLABS_API_KEY: 'elevenlabs-only-key',
  };
  const noBorrow = resolveConfigForRequest(
    baseConfig(envWithoutOpenAi),
    { 'x-mmgrep-asr-provider': 'openai-compatible' },
    envWithoutOpenAi,
  );
  assert.equal(noBorrow.asr.provider, 'openai-compatible');
  assert.equal(noBorrow.asr.apiKey, '');
  assert.equal(noBorrow.asr.apiKeySource, null);
  // baseUrl / model 也不能沿用 elevenlabs 的，而是新 provider 的内置默认值。
  assert.equal(noBorrow.asr.baseUrl, DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
  assert.equal(noBorrow.asr.model, DEFAULT_OPENAI_COMPATIBLE_MODEL);
});

test('空头 / 纯空白头等于没带', () => {
  for (const empty of ['', '   ', '\t\n']) {
    const config = resolveConfigForRequest(
      baseConfig(),
      {
        'x-mmgrep-elevenlabs-api-key': empty,
        'x-mmgrep-asr-provider': empty,
      },
      SERVER_ENV,
    );
    assert.equal(config.asr.provider, 'elevenlabs');
    assert.equal(config.asr.apiKey, 'env-elevenlabs-key');
    assert.equal(config.asr.apiKeySource, 'MMGREP_ELEVENLABS_API_KEY');
  }
});

test('未知 provider → INVALID_ARGUMENT，消息列出允许值', () => {
  assert.throws(
    () => resolveConfigForRequest(baseConfig(), { 'x-mmgrep-asr-provider': 'whisper-cloud' }, SERVER_ENV),
    (error) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /x-mmgrep-asr-provider/);
      assert.match(error.message, /elevenlabs/);
      assert.match(error.message, /openai-compatible/);
      return true;
    },
  );

  assert.throws(
    () => resolveConfigForRequest(baseConfig(), { 'x-mmgrep-doc-provider': 'tesseract' }, SERVER_ENV),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /x-mmgrep-doc-provider/);
      assert.match(error.message, /mineru/);
      return true;
    },
  );
});

test('provider id 头大小写不敏感；"none" 不能通过请求头选择', () => {
  const config = resolveConfigForRequest(
    baseConfig(),
    { 'x-mmgrep-asr-provider': 'OpenAI-Compatible' },
    SERVER_ENV,
  );
  assert.equal(config.asr.provider, 'openai-compatible');

  assert.throws(
    () => resolveConfigForRequest(baseConfig(), { 'x-mmgrep-asr-provider': 'none' }, SERVER_ENV),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('旧的通用 key 头对「本次选中的 provider」生效', () => {
  const config = resolveConfigForRequest(
    baseConfig(),
    {
      'x-mmgrep-asr-provider': 'openai-compatible',
      'x-mmgrep-asr-api-key': 'generic-header-key',
    },
    SERVER_ENV,
  );

  assert.equal(config.asr.provider, 'openai-compatible');
  assert.equal(config.asr.apiKey, 'generic-header-key');
  assert.equal(config.asr.apiKeySource, 'x-mmgrep-asr-api-key');
});

test('专属 key 头优先于通用 key 头', () => {
  const config = resolveConfigForRequest(
    baseConfig(),
    {
      'x-mmgrep-asr-provider': 'elevenlabs',
      'x-mmgrep-elevenlabs-api-key': 'specific-header-key',
      'x-mmgrep-asr-api-key': 'generic-header-key',
    },
    SERVER_ENV,
  );
  assert.equal(config.asr.apiKey, 'specific-header-key');
  assert.equal(config.asr.apiKeySource, 'x-mmgrep-elevenlabs-api-key');
});

test('doc 分组同理：专属头 / 通用头 / env / 切 provider', () => {
  const headerConfig = resolveConfigForRequest(
    baseConfig(),
    {
      'x-mmgrep-doc-provider': 'mineru',
      'x-mmgrep-mineru-api-key': 'header-mineru-key',
      'x-mmgrep-mineru-model': 'pipeline',
    },
    SERVER_ENV,
  );
  assert.equal(headerConfig.doc.provider, 'mineru');
  assert.equal(headerConfig.doc.apiKey, 'header-mineru-key');
  assert.equal(headerConfig.doc.apiKeySource, 'x-mmgrep-mineru-api-key');
  assert.equal(headerConfig.doc.model, 'pipeline');

  const generic = resolveConfigForRequest(
    baseConfig(),
    { 'x-mmgrep-doc-provider': 'mineru', 'x-mmgrep-doc-api-key': 'doc-generic-key' },
    SERVER_ENV,
  );
  assert.equal(generic.doc.apiKey, 'doc-generic-key');
  assert.equal(generic.doc.apiKeySource, 'x-mmgrep-doc-api-key');

  const fromEnv = resolveConfigForRequest(baseConfig(), {}, SERVER_ENV);
  assert.equal(fromEnv.doc.apiKey, 'env-mineru-key');
  assert.equal(fromEnv.doc.apiKeySource, 'MMGREP_MINERU_API_KEY');
});

test('requestOverrides 只记录头名，绝不出现任何头的值', () => {
  const asrKey = 'sentinel-asr-key-never-serialised';
  const asrBase = 'https://sentinel-base.example/v1';
  const docKey = 'sentinel-doc-key-never-serialised';
  const config = resolveConfigForRequest(
    baseConfig(),
    {
      'x-mmgrep-asr-provider': 'openai-compatible',
      'x-mmgrep-openai-compatible-api-key': asrKey,
      'x-mmgrep-openai-compatible-base-url': asrBase,
      'x-mmgrep-doc-provider': 'mineru',
      'x-mmgrep-mineru-api-key': docKey,
    },
    SERVER_ENV,
  );

  assert.deepEqual(config.requestOverrides, {
    present: [
      'x-mmgrep-asr-provider',
      'x-mmgrep-openai-compatible-api-key',
      'x-mmgrep-openai-compatible-base-url',
      'x-mmgrep-doc-provider',
      'x-mmgrep-mineru-api-key',
    ],
    asr: {
      provider: 'x-mmgrep-asr-provider',
      apiKey: 'x-mmgrep-openai-compatible-api-key',
      baseUrl: 'x-mmgrep-openai-compatible-base-url',
      model: null,
    },
    doc: {
      provider: 'x-mmgrep-doc-provider',
      apiKey: 'x-mmgrep-mineru-api-key',
      baseUrl: null,
      model: null,
    },
  });

  const serialized = JSON.stringify(config.requestOverrides);
  for (const secret of [asrKey, asrBase, docKey]) {
    assert.ok(!serialized.includes(secret), `requestOverrides 泄漏了请求头的值：${serialized}`);
  }
  assert.ok(Object.isFrozen(config.requestOverrides));
  assert.ok(Object.isFrozen(config.requestOverrides.asr));
});

test('返回新配置：冻结、不改 baseConfig、非 provider 字段原样继承', () => {
  const base = baseConfig();
  const before = JSON.stringify({ asr: base.asr, doc: base.doc });
  const config = resolveConfigForRequest(
    base,
    { 'x-mmgrep-elevenlabs-api-key': 'header-key' },
    SERVER_ENV,
  );

  assert.notEqual(config, base);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.asr));
  assert.ok(Object.isFrozen(config.doc));
  assert.equal(JSON.stringify({ asr: base.asr, doc: base.doc }), before, 'baseConfig 被改动了');

  assert.deepEqual(config.cache, base.cache);
  assert.deepEqual(config.images, base.images);
  assert.deepEqual(config.audio, base.audio);
  assert.deepEqual(config.transport, base.transport);
  assert.deepEqual(config.warnings, base.warnings);
  assert.equal(config.asr.language, base.asr.language);
  assert.equal(config.doc.timeoutMs, base.doc.timeoutMs);
});

test('没有任何头时：整份配置与 baseConfig 等价（provider / key 都不变）', () => {
  const base = baseConfig();
  const config = resolveConfigForRequest(base, {}, SERVER_ENV);

  assert.deepEqual(config.asr, base.asr);
  assert.deepEqual(config.doc, base.doc);
  assert.deepEqual(config.requestOverrides.present, []);
  assert.deepEqual(config.requestOverrides.asr, {
    provider: null, apiKey: null, baseUrl: null, model: null,
  });
});

test('没有头但 env 与 baseConfig 不同：所选 provider 的 env 值优先（baseConfig 只是最后兜底）', () => {
  // baseConfig 是在「只有 provider、没有 key」的环境里加载的；解析时 env 里多了 key。
  const staleBase = baseConfig({ MMGREP_ASR_PROVIDER: 'elevenlabs' });
  const env = {
    MMGREP_ASR_PROVIDER: 'elevenlabs',
    MMGREP_ELEVENLABS_API_KEY: 'fresh-env-key',
    MMGREP_ELEVENLABS_BASE_URL: 'https://fresh.example/v1',
  };
  const config = resolveConfigForRequest(staleBase, {}, env);

  assert.equal(config.asr.apiKey, 'fresh-env-key');
  assert.equal(config.asr.baseUrl, 'https://fresh.example/v1');
  assert.equal(config.asr.model, staleBase.asr.model, '模型应回落到 baseConfig 的值');
});
