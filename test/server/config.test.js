// test/server/config.test.js —— 契约 §12 的环境变量解析与默认值
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_ASR_MODEL,
  DEFAULT_CACHE_MAX_BYTES,
  DEFAULT_MAX_IMAGE_TOKENS,
  DEFAULT_MAX_TEXT_INLINE_CHARS,
  createLogger,
  describeConfig,
  loadConfig,
} from '../../src/server/config.js';

test('loadConfig：全部走契约 §12 的默认值', () => {
  const config = loadConfig({});
  assert.equal(config.cache.maxBytes, DEFAULT_CACHE_MAX_BYTES);
  assert.equal(config.cache.maxBytes, 10737418240);
  assert.equal(config.asr.provider, 'none');
  assert.equal(config.asr.model, DEFAULT_ASR_MODEL);
  assert.equal(config.asr.baseUrl, 'https://api.elevenlabs.io/v1');
  assert.equal(config.asr.timeoutMs, 120000);
  assert.equal(config.ocr.provider, 'none');
  assert.equal(config.ocr.timeoutMs, 180000);
  assert.equal(config.typeset.provider, 'builtin');
  assert.equal(config.typeset.timeoutMs, 180000);
  assert.equal(config.images.maxTokens, DEFAULT_MAX_IMAGE_TOKENS);
  assert.equal(config.images.maxEdge, 1600);
  assert.equal(config.text.maxInlineChars, DEFAULT_MAX_TEXT_INLINE_CHARS);
  assert.equal(config.runtime.concurrency, 2);
  assert.equal(config.audio.minDbfs, -35);
  assert.equal(config.audio.minSpeechRatio, 0.05);
  assert.equal(config.progress.enabled, true);
  assert.equal(config.logLevel, 'info');
  assert.deepEqual(config.warnings, []);
});

test('loadConfig：读取自定义环境变量（按 provider 分组）', () => {
  const config = loadConfig({
    MMGREP_CACHE_DIR: '/tmp/mmgrep-custom',
    MMGREP_CACHE_MAX_BYTES: '512MB',
    MMGREP_ASR_PROVIDER: 'ElevenLabs',
    MMGREP_ELEVENLABS_API_KEY: 'sk-secret-value',
    MMGREP_ELEVENLABS_MODEL: 'scribe_v2',
    MMGREP_ASR_LANGUAGE: 'zh',
    MMGREP_ASR_TIMEOUT_MS: '90000',
    MMGREP_OCR_PROVIDER: 'mineru',
    MMGREP_TYPESET_PROVIDER: 'mineru',
    MMGREP_MINERU_API_KEY: 'doc-secret',
    MMGREP_DOC_TIMEOUT_MS: '60000',
    MMGREP_MAX_IMAGE_TOKENS: '2000',
    MMGREP_MAX_IMAGE_EDGE: '1024',
    MMGREP_MAX_TEXT_INLINE_CHARS: '1000',
    MMGREP_MAX_CONCURRENCY: '1',
    MMGREP_AUDIO_MIN_DBFS: '-45',
    MMGREP_AUDIO_MIN_SPEECH_RATIO: '0.1',
    MMGREP_FFMPEG_PATH: '/usr/local/bin/ffmpeg',
    MMGREP_LOG_LEVEL: 'debug',
    MMGREP_PROGRESS_NOTIFICATIONS: 'off',
  });
  assert.equal(config.cache.dir, '/tmp/mmgrep-custom');
  assert.equal(config.cache.maxBytes, 512 * 1024 * 1024);
  assert.equal(config.asr.provider, 'elevenlabs');
  assert.equal(config.asr.apiKey, 'sk-secret-value');
  assert.equal(config.asr.apiKeySource, 'MMGREP_ELEVENLABS_API_KEY');
  assert.equal(config.asr.model, 'scribe_v2');
  assert.equal(config.asr.language, 'zh');
  assert.equal(config.asr.timeoutMs, 90000);
  assert.equal(config.ocr.provider, 'mineru');
  assert.equal(config.ocr.apiKey, 'doc-secret');
  assert.equal(config.ocr.apiKeySource, 'MMGREP_MINERU_API_KEY');
  assert.equal(config.ocr.timeoutMs, 60000);
  assert.equal(config.typeset.provider, 'mineru');
  assert.equal(config.typeset.apiKey, 'doc-secret');
  assert.equal(config.typeset.timeoutMs, 60000);
  assert.equal(config.images.maxTokens, 2000);
  assert.equal(config.images.maxEdge, 1024);
  assert.equal(config.text.maxInlineChars, 1000);
  assert.equal(config.runtime.concurrency, 1);
  assert.equal(config.audio.minDbfs, -45);
  assert.equal(config.audio.minSpeechRatio, 0.1);
  assert.equal(config.tools.ffmpegPath, '/usr/local/bin/ffmpeg');
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.progress.enabled, false);
  assert.deepEqual(config.warnings, []);
});

test('loadConfig：每个 provider 只读自己的变量组，baseUrl / model 默认值互不继承', () => {
  const config = loadConfig({
    MMGREP_ASR_PROVIDER: 'openai-compatible',
    MMGREP_ELEVENLABS_API_KEY: 'eleven-key-value',
    MMGREP_ELEVENLABS_BASE_URL: 'https://eleven.example/v1',
    MMGREP_ELEVENLABS_MODEL: 'scribe_v9',
    MMGREP_OPENAI_COMPATIBLE_API_KEY: 'openai-key-value',
    MMGREP_OPENAI_COMPATIBLE_BASE_URL: 'https://openai.example/v1',
  });

  assert.equal(config.asr.provider, 'openai-compatible');
  assert.equal(config.asr.apiKey, 'openai-key-value');
  assert.equal(config.asr.apiKeySource, 'MMGREP_OPENAI_COMPATIBLE_API_KEY');
  assert.equal(config.asr.baseUrl, 'https://openai.example/v1');
  assert.equal(config.asr.model, 'whisper-1', 'openai-compatible 不能继承 scribe_v1');
  assert.notEqual(config.asr.model, 'scribe_v9');
  assert.deepEqual(config.warnings, []);
});

test('loadConfig：旧 ASR 通用变量仍可兜底，并记一条弃用 warning', () => {
  const config = loadConfig({
    MMGREP_ASR_PROVIDER: 'elevenlabs',
    MMGREP_ASR_API_KEY: 'legacy-asr-key',
  });

  assert.equal(config.asr.apiKey, 'legacy-asr-key');
  assert.equal(config.asr.apiKeySource, 'MMGREP_ASR_API_KEY');

  const warnings = config.warnings.join('\n');
  assert.match(warnings, /MMGREP_ASR_API_KEY is deprecated.*MMGREP_ELEVENLABS_API_KEY/);
  assert.equal(warnings.includes('legacy-asr-key'), false, 'warning 不能带 key 原文');
});

test('loadConfig：0.2.0 删除的 MMGREP_DOC_* 启动时 warn，指出替代变量且不生效', () => {
  const config = loadConfig({
    MMGREP_DOC_PROVIDER: 'mineru',
    MMGREP_DOC_API_KEY: 'legacy-doc-key',
    MMGREP_DOC_BASE_URL: 'https://legacy.example/api/v4',
    MMGREP_DOC_MODEL: 'vlm',
    MMGREP_MINERU_API_KEY: 'still-mineru-key',
  });

  // 旧变量被完全忽略：不会因此打开 OCR，也不会兜底成凭据。
  assert.equal(config.ocr.provider, 'none');
  assert.equal(config.ocr.apiKey, '');
  assert.equal(config.ocr.apiKeySource, null);
  assert.equal(config.typeset.provider, 'builtin');
  assert.equal(config.typeset.apiKey, '');

  const warnings = config.warnings.join('\n');
  assert.match(warnings, /MMGREP_DOC_PROVIDER was removed in 0\.2\.0.*MMGREP_OCR_PROVIDER/);
  assert.match(warnings, /MMGREP_DOC_PROVIDER was removed in 0\.2\.0.*MMGREP_TYPESET_PROVIDER/);
  assert.match(warnings, /MMGREP_DOC_API_KEY was removed in 0\.2\.0.*MMGREP_MINERU_API_KEY/);
  assert.match(warnings, /MMGREP_DOC_BASE_URL was removed in 0\.2\.0.*MMGREP_MINERU_BASE_URL/);
  assert.match(warnings, /MMGREP_DOC_MODEL was removed in 0\.2\.0.*MMGREP_MINERU_MODEL/);
  assert.equal(warnings.includes('legacy-doc-key'), false, 'warning 不能带 key 原文');
});

test('loadConfig：旧 MMGREP_ASR_MODEL 配 openai-compatible 时额外警告可能不适配', () => {
  const config = loadConfig({
    MMGREP_ASR_PROVIDER: 'openai-compatible',
    MMGREP_ASR_API_KEY: 'legacy-key',
    MMGREP_ASR_BASE_URL: 'https://legacy.example/v1',
    MMGREP_ASR_MODEL: 'scribe_v1',
  });

  assert.equal(config.asr.baseUrl, 'https://legacy.example/v1');
  assert.equal(config.asr.model, 'scribe_v1');
  const warnings = config.warnings.join('\n');
  assert.match(warnings, /MMGREP_ASR_MODEL was shared across ASR providers/);
  assert.match(warnings, /may not be valid for "openai-compatible"/);
  assert.match(warnings, /MMGREP_OPENAI_COMPATIBLE_MODEL/);
  assert.equal(warnings.includes('scribe_v1'), false, 'warning 不该重复输出配置值');
});

test('loadConfig：未知 provider 记 warning 并回落到各角色默认值（不崩）', () => {
  const config = loadConfig({
    MMGREP_ASR_PROVIDER: 'elevenlabz',
    MMGREP_ELEVENLABS_API_KEY: 'never-used-key',
    MMGREP_OCR_PROVIDER: 'paddleocr',
    MMGREP_TYPESET_PROVIDER: 'tesseract',
    MMGREP_MINERU_API_KEY: 'never-used-token',
  });

  assert.equal(config.asr.provider, 'none');
  assert.equal(config.asr.apiKey, '');
  assert.equal(config.asr.apiKeySource, null);
  assert.equal(config.ocr.provider, 'none');
  assert.equal(config.ocr.apiKey, '');
  assert.equal(config.ocr.apiKeySource, null);
  assert.equal(config.typeset.provider, 'builtin');
  assert.equal(config.typeset.apiKey, '');

  const warnings = config.warnings.join('\n');
  assert.match(warnings, /MMGREP_ASR_PROVIDER is "elevenlabz".*not a supported provider.*falling back to "none"/);
  assert.match(warnings, /MMGREP_OCR_PROVIDER is "paddleocr".*not a supported ocr provider.*falling back to "none"/);
  assert.match(warnings, /MMGREP_TYPESET_PROVIDER is "tesseract".*not a supported typeset provider.*falling back to "builtin"/);
});

test('loadConfig：非法值回落默认并留下 warning（不崩 server）', () => {
  const config = loadConfig({
    MMGREP_MAX_IMAGE_TOKENS: 'lots',
    MMGREP_CACHE_MAX_BYTES: 'huge',
    MMGREP_LOG_LEVEL: 'verbose',
    MMGREP_MAX_CONCURRENCY: '0',
  });
  assert.equal(config.images.maxTokens, DEFAULT_MAX_IMAGE_TOKENS);
  assert.equal(config.cache.maxBytes, DEFAULT_CACHE_MAX_BYTES);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.runtime.concurrency, 2);
  assert.equal(config.warnings.length, 4);
  assert.ok(config.warnings.some((w) => w.includes('MMGREP_MAX_IMAGE_TOKENS')));
});

test('describeConfig：绝不泄露 API key', () => {
  const config = loadConfig({
    MMGREP_ASR_PROVIDER: 'elevenlabs',
    MMGREP_ELEVENLABS_API_KEY: 'sk-super-secret',
    MMGREP_OCR_PROVIDER: 'mineru',
    MMGREP_TYPESET_PROVIDER: 'mineru',
    MMGREP_MINERU_API_KEY: 'doc-super-secret',
  });
  const described = describeConfig(config);
  const json = JSON.stringify(described);
  assert.equal(json.includes('sk-super-secret'), false);
  assert.equal(json.includes('doc-super-secret'), false);
  assert.equal(described.asr.apiKey, 'set');
  assert.equal(described.ocr.apiKey, 'set');
  assert.equal(described.typeset.apiKey, 'set');
});

test('多 provider 的 key 互不串用，且不出现在 describeConfig / warnings / 报错里', async () => {
  const ELEVEN_SENTINEL = 'sk-eleven-sentinel-9f2c';
  const OPENAI_SENTINEL = 'sk-openai-sentinel-7c1a';
  const MINERU_SENTINEL = 'mineru-sentinel-4b8d';

  // 同一进程里三个 provider 的 key 同时存在；选中的 ASR provider 只能拿到自己的那一个。
  const config = loadConfig({
    MMGREP_ASR_PROVIDER: 'elevenlabs',
    MMGREP_ELEVENLABS_API_KEY: ELEVEN_SENTINEL,
    MMGREP_OPENAI_COMPATIBLE_API_KEY: OPENAI_SENTINEL,
    MMGREP_OCR_PROVIDER: 'mineru',
    MMGREP_TYPESET_PROVIDER: 'mineru',
    MMGREP_MINERU_API_KEY: MINERU_SENTINEL,
  });
  assert.equal(config.asr.apiKey, ELEVEN_SENTINEL);
  assert.equal(config.ocr.apiKey, MINERU_SENTINEL);
  assert.equal(config.typeset.apiKey, MINERU_SENTINEL);

  const described = JSON.stringify(describeConfig(config));
  const warnings = config.warnings.join('\n');
  for (const secret of [ELEVEN_SENTINEL, OPENAI_SENTINEL, MINERU_SENTINEL]) {
    assert.equal(described.includes(secret), false, 'describeConfig 不能出现 key 原文');
    assert.equal(warnings.includes(secret), false, 'warnings 不能出现 key 原文');
  }
  assert.equal(described.includes('openai-sentinel'), false, '未选中的 provider key 也不能出现');

  // provider 的缺 key 报错也不能带出任何其他 provider 的 key 原文。
  const { createAsrProvider } = await import('../../src/providers/asr/index.js');
  const asr = createAsrProvider({
    MMGREP_ASR_PROVIDER: 'elevenlabs',
    MMGREP_OPENAI_COMPATIBLE_API_KEY: OPENAI_SENTINEL,
    MMGREP_MINERU_API_KEY: MINERU_SENTINEL,
  });
  const asrError = await asr.transcribe({ audioPath: '/tmp/whatever.mp3' }).then(
    () => null,
    (err) => err,
  );
  assert.ok(asrError instanceof Error);
  assert.match(asrError.message, /MMGREP_ELEVENLABS_API_KEY/);
  for (const secret of [ELEVEN_SENTINEL, OPENAI_SENTINEL, MINERU_SENTINEL]) {
    assert.equal(asrError.message.includes(secret), false, 'ASR 报错不能出现 key 原文');
  }

  const { createDocProvider } = await import('../../src/providers/doc/index.js');
  const doc = createDocProvider('ocr', {
    MMGREP_OCR_PROVIDER: 'mineru',
    MMGREP_ELEVENLABS_API_KEY: ELEVEN_SENTINEL,
    MMGREP_OPENAI_COMPATIBLE_API_KEY: OPENAI_SENTINEL,
  });
  const docError = await doc.parse({ filePath: '/tmp/whatever.pdf', role: 'ocr' }).then(
    () => null,
    (err) => err,
  );
  assert.ok(docError instanceof Error);
  assert.match(docError.message, /MMGREP_MINERU_API_KEY/);
  for (const secret of [ELEVEN_SENTINEL, OPENAI_SENTINEL, MINERU_SENTINEL]) {
    assert.equal(docError.message.includes(secret), false, 'DOC 报错不能出现 key 原文');
  }
});

test('createLogger：只写注入的 stream，格式稳定', () => {
  const lines = [];
  const stream = { write: (line) => lines.push(line.trimEnd()) };
  const logger = createLogger({ level: 'debug', stream });
  logger.error('boom');
  logger.warn('careful');
  logger.info('hello');
  logger.debug('detail');
  assert.deepEqual(lines, [
    '[mmgrep] error: boom',
    '[mmgrep] warn: careful',
    '[mmgrep] info: hello',
    '[mmgrep] debug: detail',
  ]);
  const quiet = [];
  const warnLogger = createLogger({ level: 'warn', stream: { write: (l) => quiet.push(l.trimEnd()) } });
  warnLogger.info('hidden');
  warnLogger.warn('shown');
  assert.deepEqual(quiet, ['[mmgrep] warn: shown']);
});
