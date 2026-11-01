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
  assert.equal(config.doc.provider, 'none');
  assert.equal(config.doc.timeoutMs, 180000);
  assert.equal(config.ocr.provider, 'none');
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

test('loadConfig：读取自定义环境变量', () => {
  const config = loadConfig({
    MMGREP_CACHE_DIR: '/tmp/mmgrep-custom',
    MMGREP_CACHE_MAX_BYTES: '512MB',
    MMGREP_ASR_PROVIDER: 'ElevenLabs',
    MMGREP_ASR_API_KEY: 'sk-secret-value',
    MMGREP_ASR_MODEL: 'scribe_v2',
    MMGREP_ASR_LANGUAGE: 'zh',
    MMGREP_ASR_TIMEOUT_MS: '90000',
    MMGREP_DOC_PROVIDER: 'mineru',
    MMGREP_DOC_API_KEY: 'doc-secret',
    MMGREP_DOC_TIMEOUT_MS: '60000',
    MMGREP_OCR_PROVIDER: 'tesseract',
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
  assert.equal(config.asr.model, 'scribe_v2');
  assert.equal(config.asr.language, 'zh');
  assert.equal(config.asr.timeoutMs, 90000);
  assert.equal(config.doc.provider, 'mineru');
  assert.equal(config.doc.apiKey, 'doc-secret');
  assert.equal(config.doc.timeoutMs, 60000);
  assert.equal(config.ocr.provider, 'tesseract');
  assert.equal(config.images.maxTokens, 2000);
  assert.equal(config.images.maxEdge, 1024);
  assert.equal(config.text.maxInlineChars, 1000);
  assert.equal(config.runtime.concurrency, 1);
  assert.equal(config.audio.minDbfs, -45);
  assert.equal(config.audio.minSpeechRatio, 0.1);
  assert.equal(config.tools.ffmpegPath, '/usr/local/bin/ffmpeg');
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.progress.enabled, false);
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
    MMGREP_ASR_API_KEY: 'sk-super-secret',
    MMGREP_DOC_API_KEY: 'doc-super-secret',
  });
  const described = describeConfig(config);
  const json = JSON.stringify(described);
  assert.equal(json.includes('sk-super-secret'), false);
  assert.equal(json.includes('doc-super-secret'), false);
  assert.equal(described.asr.apiKey, 'set');
  assert.equal(described.doc.apiKey, 'set');
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
