/**
 * createDocProvider 工厂的测试。全程离线，不触网。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDocProvider, DOC_PROVIDERS } from '../../src/providers/doc/index.js';

test('DOC_PROVIDERS lists the supported provider ids', () => {
  assert.deepEqual(DOC_PROVIDERS, ['mineru', 'none']);
});

test('returns null when the provider is not configured', () => {
  assert.equal(createDocProvider({}), null);
  assert.equal(createDocProvider({ MMGREP_DOC_PROVIDER: '' }), null);
  assert.equal(createDocProvider({ MMGREP_DOC_PROVIDER: 'none' }), null);
  assert.equal(createDocProvider({ MMGREP_DOC_PROVIDER: '  NONE  ' }), null);
});

test('defaults to process.env when no env object is given', () => {
  const saved = process.env.MMGREP_DOC_PROVIDER;
  try {
    delete process.env.MMGREP_DOC_PROVIDER;
    assert.equal(createDocProvider(), null);
    process.env.MMGREP_DOC_PROVIDER = 'none';
    assert.equal(createDocProvider(), null);
  } finally {
    if (saved === undefined) delete process.env.MMGREP_DOC_PROVIDER;
    else process.env.MMGREP_DOC_PROVIDER = saved;
  }
});

test('builds a mineru provider from environment variables', () => {
  const provider = createDocProvider({
    MMGREP_DOC_PROVIDER: 'mineru',
    MMGREP_DOC_API_KEY: 'super-secret-token',
    MMGREP_DOC_MODEL: 'vlm',
    MMGREP_DOC_BASE_URL: 'https://example.test/api/v4/',
    MMGREP_DOC_TIMEOUT_MS: '12345',
  });

  assert.ok(provider);
  assert.equal(provider.id, 'mineru');
  assert.equal(typeof provider.parse, 'function');
  assert.equal(typeof provider.describe, 'function');

  const described = provider.describe();
  assert.deepEqual(described, {
    id: 'mineru',
    model: 'vlm',
    baseUrl: 'https://example.test/api/v4',
  });
  assert.ok(!JSON.stringify(described).includes('super-secret-token'));
});

test('uses the default base URL and model when not configured', () => {
  const provider = createDocProvider({ MMGREP_DOC_PROVIDER: 'mineru', MMGREP_DOC_API_KEY: 'k' });
  assert.deepEqual(provider.describe(), {
    id: 'mineru',
    model: null,
    baseUrl: 'https://mineru.net/api/v4',
  });
});

test('opts override environment variables', () => {
  const provider = createDocProvider(
    { MMGREP_DOC_PROVIDER: 'mineru', MMGREP_DOC_API_KEY: 'k', MMGREP_DOC_MODEL: 'vlm' },
    { model: 'pipeline', baseUrl: 'http://127.0.0.1:9999/api/v4' },
  );
  assert.deepEqual(provider.describe(), {
    id: 'mineru',
    model: 'pipeline',
    baseUrl: 'http://127.0.0.1:9999/api/v4',
  });
});

test('opts.provider overrides the environment variable', () => {
  const provider = createDocProvider(
    { MMGREP_DOC_PROVIDER: 'none', MMGREP_DOC_API_KEY: 'k' },
    { provider: 'mineru', baseUrl: 'http://127.0.0.1:1234/api/v4' },
  );
  assert.ok(provider);
  assert.equal(provider.describe().baseUrl, 'http://127.0.0.1:1234/api/v4');

  assert.equal(createDocProvider({ MMGREP_DOC_PROVIDER: 'mineru', MMGREP_DOC_API_KEY: 'k' }, { provider: 'none' }), null);
});

test('constructing mineru without an API key does not throw; parse() does', async () => {
  const provider = createDocProvider({ MMGREP_DOC_PROVIDER: 'mineru' });
  assert.ok(provider);
  assert.equal(provider.describe().id, 'mineru');
  await assert.rejects(() => provider.parse({ filePath: '/tmp/whatever.pdf' }), /MMGREP_DOC_API_KEY/);
});

test('an unknown provider is rejected with a clear message', () => {
  assert.throws(
    () => createDocProvider({ MMGREP_DOC_PROVIDER: 'paddleocr' }),
    (err) => {
      assert.match(err.message, /Unsupported MMGREP_DOC_PROVIDER/);
      assert.match(err.message, /paddleocr/);
      assert.match(err.message, /mineru/);
      return true;
    },
  );
});

test('a malformed timeout falls back to the default instead of breaking', () => {
  const provider = createDocProvider({
    MMGREP_DOC_PROVIDER: 'mineru',
    MMGREP_DOC_API_KEY: 'k',
    MMGREP_DOC_TIMEOUT_MS: 'not-a-number',
  });
  assert.equal(provider.describe().id, 'mineru');
});
