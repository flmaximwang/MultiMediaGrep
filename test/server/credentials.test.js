// test/server/credentials.test.js —— 逐请求凭据：请求头 → 本次请求配置
//
// 这一层是 HTTP 端点的安全边界：头里的 key 只能活在一次请求里。
// 单测只碰纯函数，不构造 provider、不发网络请求（集成路径见 http.test.js）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_MAX_TEXT_INLINE_CHARS,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
  MAX_TEXT_INLINE_CHARS_HARD_CAP,
  loadConfig,
} from '../../src/server/config.js';
import {
  HEADER_CONFIG_HEADERS,
  REQUEST_HEADERS,
  presentConfigHeaders,
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
  MMGREP_OCR_PROVIDER: 'mineru',
  MMGREP_TYPESET_PROVIDER: 'mineru',
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
    ocr: {
      provider: 'x-mmgrep-ocr-provider',
      providers: {
        mineru: {
          apiKey: 'x-mmgrep-mineru-api-key',
          baseUrl: 'x-mmgrep-mineru-base-url',
          model: 'x-mmgrep-mineru-model',
        },
      },
    },
    typeset: {
      provider: 'x-mmgrep-typeset-provider',
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

test('HEADER_CONFIG_HEADERS：非凭据设置沿用同一套 env → 头名映射', () => {
  assert.deepEqual(HEADER_CONFIG_HEADERS, {
    maxTextInlineChars: 'x-mmgrep-max-text-inline-chars',
  });
});

test('presentConfigHeaders：只认非空的已知设置头，凭据头不算', () => {
  assert.deepEqual(presentConfigHeaders({}), []);
  assert.deepEqual(presentConfigHeaders({ authorization: 'Bearer x' }), []);
  assert.deepEqual(presentConfigHeaders({ 'x-mmgrep-asr-provider': 'elevenlabs' }), []);
  // 非凭据设置头也不能反过来被当成凭据头（否则会触发不必要的 provider 重建）
  assert.deepEqual(presentCredentialHeaders({ 'x-mmgrep-max-text-inline-chars': '5000' }), []);
  assert.deepEqual(
    presentConfigHeaders({ 'X-MMGREP-MAX-TEXT-INLINE-CHARS': '  5000  ' }),
    ['x-mmgrep-max-text-inline-chars'],
  );
  // 空头等于没带（与凭据头同口径）
  for (const empty of ['', '   ', '\t\n']) {
    assert.deepEqual(presentConfigHeaders({ 'x-mmgrep-max-text-inline-chars': empty }), []);
  }
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
    () => resolveConfigForRequest(baseConfig(), { 'x-mmgrep-ocr-provider': 'tesseract' }, SERVER_ENV),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /x-mmgrep-ocr-provider/);
      assert.match(error.message, /mineru/);
      assert.match(error.message, /none/);
      return true;
    },
  );

  assert.throws(
    () => resolveConfigForRequest(baseConfig(), { 'x-mmgrep-typeset-provider': 'tesseract' }, SERVER_ENV),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /x-mmgrep-typeset-provider/);
      assert.match(error.message, /builtin/);
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

test('文档角色头：ocr / typeset 各自选 provider，共用 MinerU 凭据头', () => {
  const headerConfig = resolveConfigForRequest(
    baseConfig(),
    {
      'x-mmgrep-ocr-provider': 'mineru',
      'x-mmgrep-typeset-provider': 'mineru',
      'x-mmgrep-mineru-api-key': 'header-mineru-key',
      'x-mmgrep-mineru-model': 'pipeline',
    },
    SERVER_ENV,
  );
  assert.equal(headerConfig.ocr.provider, 'mineru');
  assert.equal(headerConfig.ocr.apiKey, 'header-mineru-key');
  assert.equal(headerConfig.ocr.apiKeySource, 'x-mmgrep-mineru-api-key');
  assert.equal(headerConfig.ocr.model, 'pipeline');
  assert.equal(headerConfig.typeset.provider, 'mineru');
  assert.equal(headerConfig.typeset.apiKey, 'header-mineru-key');

  // 没有角色 provider 头时沿用 env。
  const fromEnv = resolveConfigForRequest(baseConfig(), {}, SERVER_ENV);
  assert.equal(fromEnv.ocr.provider, 'mineru');
  assert.equal(fromEnv.ocr.apiKey, 'env-mineru-key');
  assert.equal(fromEnv.ocr.apiKeySource, 'MMGREP_MINERU_API_KEY');
  assert.equal(fromEnv.typeset.provider, 'mineru');
  assert.equal(fromEnv.typeset.apiKey, 'env-mineru-key');
});

test('文档角色头可以选 builtin / none（仅 typeset 允许 builtin）', () => {
  const builtin = resolveConfigForRequest(
    baseConfig(),
    { 'x-mmgrep-ocr-provider': 'none', 'x-mmgrep-typeset-provider': 'builtin' },
    SERVER_ENV,
  );
  assert.equal(builtin.ocr.provider, 'none');
  assert.equal(builtin.ocr.apiKey, '');
  assert.equal(builtin.typeset.provider, 'builtin');
  assert.equal(builtin.typeset.apiKey, '');

  const none = resolveConfigForRequest(
    baseConfig(),
    { 'x-mmgrep-ocr-provider': 'mineru', 'x-mmgrep-typeset-provider': 'none' },
    SERVER_ENV,
  );
  assert.equal(none.typeset.provider, 'none');
  assert.equal(none.typeset.apiKey, '');
  assert.equal(none.ocr.provider, 'mineru');
  assert.equal(none.ocr.apiKey, 'env-mineru-key');

  // ocr 角色不允许 builtin。
  assert.throws(
    () => resolveConfigForRequest(baseConfig(), { 'x-mmgrep-ocr-provider': 'builtin' }, SERVER_ENV),
    (error) => error.code === 'INVALID_ARGUMENT' && /x-mmgrep-ocr-provider/.test(error.message),
  );
});

test('角色 provider 头切到 mineru 时只读 MinerU 的变量组，不借用 baseConfig 的旧凭据', () => {
  const env = {
    MMGREP_OCR_PROVIDER: 'none',
    MMGREP_TYPESET_PROVIDER: 'builtin',
    MMGREP_MINERU_API_KEY: 'env-mineru-only-key',
  };
  const base = baseConfig(env);
  const config = resolveConfigForRequest(
    base,
    { 'x-mmgrep-ocr-provider': 'mineru' },
    env,
  );
  assert.equal(config.ocr.provider, 'mineru');
  assert.equal(config.ocr.apiKey, 'env-mineru-only-key');
  assert.equal(config.ocr.apiKeySource, 'MMGREP_MINERU_API_KEY');
  assert.equal(config.typeset.provider, 'builtin');
});

test('内联上限请求头：头 > env > 默认 24000，超过 200000 按上限截断', () => {
  const env = { MMGREP_MAX_TEXT_INLINE_CHARS: '12000' };
  const base = baseConfig(env);
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  const resolve = (header) => resolveConfigForRequest(
    base,
    header === undefined ? {} : { 'x-mmgrep-max-text-inline-chars': header },
    env,
    { logger },
  );

  // 请求头优先于 env
  const fromHeader = resolve('5000');
  assert.equal(fromHeader.text.maxInlineChars, 5000);
  assert.deepEqual(fromHeader.requestOverrides.text, {
    maxInlineChars: 'x-mmgrep-max-text-inline-chars',
  });
  assert.ok(Object.isFrozen(fromHeader.text));
  assert.deepEqual(warnings, []);

  // 没带头 → env
  const fromEnv = resolve(undefined);
  assert.equal(fromEnv.text.maxInlineChars, 12000);
  assert.deepEqual(fromEnv.requestOverrides.text, { maxInlineChars: null });

  // 边界：正好 200000 不截断；200001 截断并 warn
  const atCap = resolve(String(MAX_TEXT_INLINE_CHARS_HARD_CAP));
  assert.equal(atCap.text.maxInlineChars, MAX_TEXT_INLINE_CHARS_HARD_CAP);
  assert.deepEqual(warnings, []);

  const overCap = resolve(String(MAX_TEXT_INLINE_CHARS_HARD_CAP + 1));
  assert.equal(overCap.text.maxInlineChars, MAX_TEXT_INLINE_CHARS_HARD_CAP);
  assert.equal(overCap.requestOverrides.text.maxInlineChars, 'x-mmgrep-max-text-inline-chars');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /x-mmgrep-max-text-inline-chars/);
  assert.match(warnings[0], new RegExp(String(MAX_TEXT_INLINE_CHARS_HARD_CAP)));
  assert.ok(
    !warnings[0].includes(String(MAX_TEXT_INLINE_CHARS_HARD_CAP + 1)),
    `warning 回显了头值：${warnings[0]}`,
  );

  // 非法值 → warn + 回落 env（不是回落默认）
  for (const invalid of ['abc', '-5', '1.5', '10kb']) {
    warnings.length = 0;
    const result = resolve(invalid);
    assert.equal(result.text.maxInlineChars, 12000, `非法值 ${JSON.stringify(invalid)} 没有回落 env`);
    assert.deepEqual(result.requestOverrides.text, { maxInlineChars: null });
    assert.equal(warnings.length, 1, `非法值 ${JSON.stringify(invalid)} 没有 warn`);
    assert.match(warnings[0], /is invalid/);
    assert.ok(!warnings[0].includes(invalid), `warning 回显了头值：${warnings[0]}`);
  }

  // 0 也是非法值（上限至少 1 个字符）
  warnings.length = 0;
  assert.equal(resolve('0').text.maxInlineChars, 12000);
  assert.equal(warnings.length, 1);

  // 空头 / 纯空白头等于没带：静默回落 env
  for (const empty of ['', '   ', '\t\n']) {
    warnings.length = 0;
    const result = resolve(empty);
    assert.equal(result.text.maxInlineChars, 12000);
    assert.deepEqual(result.requestOverrides.text, { maxInlineChars: null });
    assert.deepEqual(warnings, []);
  }
});

test('内联上限请求头：env 也没配时回落到默认 24000', () => {
  const base = loadConfig({});
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };

  const invalid = resolveConfigForRequest(
    base,
    { 'x-mmgrep-max-text-inline-chars': 'nope' },
    {},
    { logger },
  );
  assert.equal(invalid.text.maxInlineChars, DEFAULT_MAX_TEXT_INLINE_CHARS);
  assert.equal(warnings.length, 1);

  const header = resolveConfigForRequest(
    base,
    { 'x-mmgrep-max-text-inline-chars': '60000' },
    {},
    { logger },
  );
  assert.equal(header.text.maxInlineChars, 60000);
  assert.equal(warnings.length, 1, '合法头不该加 warning');
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
      'x-mmgrep-ocr-provider': 'mineru',
      'x-mmgrep-typeset-provider': 'builtin',
      'x-mmgrep-mineru-api-key': docKey,
      'x-mmgrep-max-text-inline-chars': '5000',
    },
    SERVER_ENV,
  );

  assert.equal(config.text.maxInlineChars, 5000, '凭据头与设置头应该能同时生效');
  assert.deepEqual(config.requestOverrides, {
    present: [
      'x-mmgrep-asr-provider',
      'x-mmgrep-openai-compatible-api-key',
      'x-mmgrep-openai-compatible-base-url',
      'x-mmgrep-ocr-provider',
      'x-mmgrep-mineru-api-key',
      'x-mmgrep-typeset-provider',
    ],
    asr: {
      provider: 'x-mmgrep-asr-provider',
      apiKey: 'x-mmgrep-openai-compatible-api-key',
      baseUrl: 'x-mmgrep-openai-compatible-base-url',
      model: null,
    },
    ocr: {
      provider: 'x-mmgrep-ocr-provider',
      apiKey: 'x-mmgrep-mineru-api-key',
      baseUrl: null,
      model: null,
    },
    typeset: {
      provider: 'x-mmgrep-typeset-provider',
      apiKey: null,
      baseUrl: null,
      model: null,
    },
    text: { maxInlineChars: 'x-mmgrep-max-text-inline-chars' },
  });

  const serialized = JSON.stringify(config.requestOverrides);
  for (const secret of [asrKey, asrBase, docKey]) {
    assert.ok(!serialized.includes(secret), `requestOverrides 泄漏了请求头的值：${serialized}`);
  }
  assert.ok(!serialized.includes('5000'), `requestOverrides 泄漏了设置头的值：${serialized}`);
  assert.ok(Object.isFrozen(config.requestOverrides));
  assert.ok(Object.isFrozen(config.requestOverrides.asr));
  assert.ok(Object.isFrozen(config.requestOverrides.text));
});

test('返回新配置：冻结、不改 baseConfig、非 provider 字段原样继承', () => {
  const base = baseConfig();
  const before = JSON.stringify({ asr: base.asr, ocr: base.ocr, typeset: base.typeset });
  const config = resolveConfigForRequest(
    base,
    { 'x-mmgrep-elevenlabs-api-key': 'header-key' },
    SERVER_ENV,
  );

  assert.notEqual(config, base);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.asr));
  assert.ok(Object.isFrozen(config.ocr));
  assert.ok(Object.isFrozen(config.typeset));
  assert.equal(JSON.stringify({ asr: base.asr, ocr: base.ocr, typeset: base.typeset }), before, 'baseConfig 被改动了');

  assert.deepEqual(config.cache, base.cache);
  assert.deepEqual(config.images, base.images);
  assert.deepEqual(config.text, base.text, '没有内联上限头时 text 段不该变');
  assert.deepEqual(config.audio, base.audio);
  assert.deepEqual(config.transport, base.transport);
  assert.deepEqual(config.warnings, base.warnings);
  assert.equal(config.asr.language, base.asr.language);
  assert.equal(config.ocr.timeoutMs, base.ocr.timeoutMs);
  assert.equal(config.typeset.timeoutMs, base.typeset.timeoutMs);
});

test('没有任何头时：整份配置与 baseConfig 等价（provider / key 都不变）', () => {
  const base = baseConfig();
  const config = resolveConfigForRequest(base, {}, SERVER_ENV);

  assert.deepEqual(config.asr, base.asr);
  assert.deepEqual(config.ocr, base.ocr);
  assert.deepEqual(config.typeset, base.typeset);
  assert.deepEqual(config.text, base.text);
  assert.deepEqual(config.requestOverrides.present, []);
  assert.deepEqual(config.requestOverrides.asr, {
    provider: null, apiKey: null, baseUrl: null, model: null,
  });
  assert.deepEqual(config.requestOverrides.text, { maxInlineChars: null });
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
