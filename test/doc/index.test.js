/**
 * createDocProvider 工厂的测试（契约 v2：ocr / typeset 两个角色）。
 * 全程离线，不触网。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOC_PROVIDERS,
  DOC_ROLE_DEFAULTS,
  DOC_ROLE_ENV,
  DOC_ROLE_PROVIDERS,
  createDocProvider,
  providerSupportsRole,
  providersForRole,
} from '../../src/providers/doc/index.js';

test('注册表 v2：每个 provider 声明自己支持的角色', () => {
  assert.deepEqual(DOC_PROVIDERS, ['mineru', 'builtin']);
  assert.deepEqual(providersForRole('ocr'), ['mineru']);
  assert.deepEqual(providersForRole('typeset'), ['mineru', 'builtin']);
  assert.equal(providerSupportsRole('mineru', 'ocr'), true);
  assert.equal(providerSupportsRole('mineru', 'typeset'), true);
  assert.equal(providerSupportsRole('builtin', 'typeset'), true);
  assert.equal(providerSupportsRole('builtin', 'ocr'), false);
  assert.equal(providerSupportsRole('none', 'ocr'), false);

  // 配置层的允许值必须与注册表一致（防止两处漂移）。
  assert.deepEqual(DOC_ROLE_PROVIDERS.ocr, ['mineru', 'none']);
  assert.deepEqual(DOC_ROLE_PROVIDERS.typeset, ['builtin', 'mineru', 'none']);
  assert.deepEqual(DOC_ROLE_ENV, {
    ocr: 'MMGREP_OCR_PROVIDER',
    typeset: 'MMGREP_TYPESET_PROVIDER',
  });
  assert.deepEqual(DOC_ROLE_DEFAULTS, { ocr: 'none', typeset: 'builtin' });
});

test('默认值：OCR=none（null），TYPESET=builtin', () => {
  assert.equal(createDocProvider('ocr', {}), null);
  assert.equal(createDocProvider('ocr', { MMGREP_OCR_PROVIDER: '' }), null);
  assert.equal(createDocProvider('ocr', { MMGREP_OCR_PROVIDER: '  NONE  ' }), null);

  const typeset = createDocProvider('typeset', {});
  assert.ok(typeset);
  assert.equal(typeset.id, 'builtin');
  assert.deepEqual(typeset.roles, ['typeset']);
  assert.equal(createDocProvider('typeset', { MMGREP_TYPESET_PROVIDER: 'none' }), null);
});

test('默认读取 process.env（按角色各读各的变量）', () => {
  const saved = {
    MMGREP_OCR_PROVIDER: process.env.MMGREP_OCR_PROVIDER,
    MMGREP_TYPESET_PROVIDER: process.env.MMGREP_TYPESET_PROVIDER,
  };
  try {
    delete process.env.MMGREP_OCR_PROVIDER;
    delete process.env.MMGREP_TYPESET_PROVIDER;
    assert.equal(createDocProvider('ocr'), null);
    assert.equal(createDocProvider('typeset').id, 'builtin');

    process.env.MMGREP_OCR_PROVIDER = 'none';
    process.env.MMGREP_TYPESET_PROVIDER = 'none';
    assert.equal(createDocProvider('ocr'), null);
    assert.equal(createDocProvider('typeset'), null);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('MMGREP_OCR_PROVIDER=mineru 时按共享的 MinerU 变量构造 ocr provider', () => {
  const provider = createDocProvider('ocr', {
    MMGREP_OCR_PROVIDER: 'mineru',
    MMGREP_MINERU_API_KEY: 'super-secret-token',
    MMGREP_MINERU_MODEL: 'vlm',
    MMGREP_MINERU_BASE_URL: 'https://example.test/api/v4/',
    MMGREP_DOC_TIMEOUT_MS: '12345',
  });

  assert.ok(provider);
  assert.equal(provider.id, 'mineru');
  assert.deepEqual(provider.roles, ['ocr', 'typeset']);
  assert.equal(typeof provider.parse, 'function');
  assert.equal(typeof provider.describe, 'function');

  const described = provider.describe();
  assert.deepEqual(described, {
    id: 'mineru',
    model: 'vlm',
    baseUrl: 'https://example.test/api/v4',
    roles: ['ocr', 'typeset'],
  });
  assert.ok(!JSON.stringify(described).includes('super-secret-token'));
});

test('MMGREP_TYPESET_PROVIDER=mineru 也走同一组 MinerU 变量', () => {
  const provider = createDocProvider('typeset', {
    MMGREP_TYPESET_PROVIDER: 'mineru',
    MMGREP_MINERU_API_KEY: 'k',
    MMGREP_MINERU_MODEL: 'pipeline',
    MMGREP_MINERU_BASE_URL: 'https://typeset.example/api/v4',
  });
  assert.equal(provider.id, 'mineru');
  assert.deepEqual(provider.describe(), {
    id: 'mineru',
    model: 'pipeline',
    baseUrl: 'https://typeset.example/api/v4',
    roles: ['ocr', 'typeset'],
  });
});

test('opts 覆盖环境变量（model / baseUrl）', () => {
  const provider = createDocProvider(
    'ocr',
    {
      MMGREP_OCR_PROVIDER: 'mineru',
      MMGREP_MINERU_API_KEY: 'k',
      MMGREP_MINERU_MODEL: 'vlm',
    },
    { model: 'pipeline', baseUrl: 'http://127.0.0.1:9999/api/v4' },
  );
  assert.deepEqual(provider.describe(), {
    id: 'mineru',
    model: 'pipeline',
    baseUrl: 'http://127.0.0.1:9999/api/v4',
    roles: ['ocr', 'typeset'],
  });
});

test('opts.provider 覆盖环境变量', () => {
  const provider = createDocProvider(
    'ocr',
    { MMGREP_OCR_PROVIDER: 'none', MMGREP_MINERU_API_KEY: 'k' },
    { provider: 'mineru', baseUrl: 'http://127.0.0.1:1234/api/v4' },
  );
  assert.ok(provider);
  assert.equal(provider.describe().baseUrl, 'http://127.0.0.1:1234/api/v4');

  assert.equal(
    createDocProvider('ocr', { MMGREP_OCR_PROVIDER: 'mineru', MMGREP_MINERU_API_KEY: 'k' }, { provider: 'none' }),
    null,
  );
});

test('缺 key 时构造不抛错；parse() 才抛，并点名 MMGREP_MINERU_API_KEY', async () => {
  const provider = createDocProvider('ocr', { MMGREP_OCR_PROVIDER: 'mineru' });
  assert.ok(provider);
  await assert.rejects(
    () => provider.parse({ filePath: '/tmp/whatever.pdf', role: 'ocr' }),
    (error) => {
      assert.match(error.message, /MMGREP_MINERU_API_KEY/);
      assert.match(error.message, /MMGREP_OCR_PROVIDER/);
      assert.doesNotMatch(error.message, /MMGREP_DOC_PROVIDER/);
      return true;
    },
  );
});

test('未知 provider / 角色不匹配 → 构造时抛清晰错误（列出允许值）', () => {
  assert.throws(
    () => createDocProvider('ocr', { MMGREP_OCR_PROVIDER: 'paddleocr' }),
    (error) => {
      assert.match(error.message, /Unsupported MMGREP_OCR_PROVIDER/);
      assert.match(error.message, /paddleocr/);
      assert.match(error.message, /mineru/);
      assert.match(error.message, /none/);
      return true;
    },
  );

  assert.throws(
    () => createDocProvider('typeset', { MMGREP_TYPESET_PROVIDER: 'paddleocr' }),
    (error) => {
      assert.match(error.message, /Unsupported MMGREP_TYPESET_PROVIDER/);
      assert.match(error.message, /builtin/);
      return true;
    },
  );

  // builtin 只支持 typeset，不能拿来当 OCR。
  assert.throws(
    () => createDocProvider('ocr', { MMGREP_OCR_PROVIDER: 'builtin' }),
    (error) => {
      assert.match(error.message, /does not support the ocr role/);
      assert.match(error.message, /MMGREP_OCR_PROVIDER/);
      return true;
    },
  );

  assert.throws(
    () => createDocProvider('reader', {}),
    /Unknown document provider role/,
  );
});

test('旧的 MMGREP_DOC_API_KEY 不再兜底（工厂只读 MinerU 专属变量）', async () => {
  const provider = createDocProvider('ocr', {
    MMGREP_OCR_PROVIDER: 'mineru',
    MMGREP_DOC_API_KEY: 'legacy-doc-key',
  });
  assert.ok(provider);
  await assert.rejects(
    () => provider.parse({ filePath: '/tmp/whatever.pdf', role: 'ocr' }),
    /MMGREP_MINERU_API_KEY/,
  );
});

test('非法 timeout 回落默认值，不炸构造', () => {
  const provider = createDocProvider('ocr', {
    MMGREP_OCR_PROVIDER: 'mineru',
    MMGREP_MINERU_API_KEY: 'k',
    MMGREP_DOC_TIMEOUT_MS: 'not-a-number',
  });
  assert.equal(provider.describe().id, 'mineru');
});
