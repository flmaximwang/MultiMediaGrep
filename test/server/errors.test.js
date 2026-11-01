// test/server/errors.test.js —— 契约 §2.4 的错误模型
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ToolError } from '../../src/media/interface.js';
import {
  asCodedError,
  guardToolHandler,
  redactMessage,
  stackSummary,
  toErrorResult,
} from '../../src/server/errors.js';

function assertErrorShape(result, code) {
  assert.equal(result.isError, true);
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.ok(result.content[0].text.startsWith(`${code}:`));
  assert.equal(result.structuredContent.error.code, code);
  assert.equal(typeof result.structuredContent.error.message, 'string');
}

test('toErrorResult：ToolError 原样透传 code / message / hint', () => {
  const error = new ToolError('OUT_OF_RANGE', 'page 15 is out of range.', 'Use page <= 8.');
  const result = toErrorResult(error);
  assertErrorShape(result, 'OUT_OF_RANGE');
  assert.equal(result.structuredContent.error.message, 'page 15 is out of range.');
  assert.equal(result.structuredContent.error.hint, 'Use page <= 8.');
  assert.equal(result.content[0].text, 'OUT_OF_RANGE: page 15 is out of range.');
  assert.equal('stack' in result.structuredContent.error, false);
});

test('toErrorResult：任何带契约错误码的 Error 也按该码透传', () => {
  const error = new Error('ASR request timed out after 120000 ms.');
  error.code = 'PROVIDER_FAILED';
  const result = toErrorResult(error);
  assertErrorShape(result, 'PROVIDER_FAILED');
  assert.match(result.content[0].text, /timed out/);
});

test('toErrorResult：未知异常 → INTERNAL，并带 stack 摘要', () => {
  const error = new TypeError('boom in the backend');
  const result = toErrorResult(error);
  assertErrorShape(result, 'INTERNAL');
  assert.match(result.structuredContent.error.message, /unexpected server error: boom in the backend/);
  assert.equal(typeof result.structuredContent.error.stack, 'string');
  assert.match(result.structuredContent.error.stack, /TypeError: boom in the backend/);
  assert.match(result.content[0].text, /INTERNAL:/);
  assert.match(result.content[0].text, /TypeError/);
});

test('toErrorResult：非 Error 值也能映射', () => {
  const result = toErrorResult('just a string');
  assertErrorShape(result, 'INTERNAL');
});

test('toErrorResult：abort 映射成可读的取消说明', () => {
  const error = new Error('aborted');
  error.name = 'AbortError';
  const result = toErrorResult(error);
  assertErrorShape(result, 'INTERNAL');
  assert.match(result.structuredContent.error.message, /cancelled by the client/);
});

test('guardToolHandler：捕获异常并返回错误结果，而不是 throw', async () => {
  const handler = guardToolHandler('media_probe', async () => {
    throw new ToolError('PATH_NOT_FOUND', 'path does not exist: "/nope".');
  });
  const result = await handler({});
  assertErrorShape(result, 'PATH_NOT_FOUND');
});

test('guardToolHandler：成功路径原样返回', async () => {
  const handler = guardToolHandler('media_probe', async (args) => ({ content: [], structuredContent: { ok: args.ok } }));
  const result = await handler({ ok: 1 });
  assert.deepEqual(result.structuredContent, { ok: 1 });
});

test('asCodedError：只认错误码全集里的 code', () => {
  assert.equal(asCodedError(new ToolError('INTERNAL', 'x'))?.code, 'INTERNAL');
  const unknown = new Error('x');
  unknown.code = 'ENOENT';
  assert.equal(asCodedError(unknown), null);
});

test('stackSummary / redactMessage', () => {
  const error = new Error('bad key sk-abcdef123456789');
  const summary = stackSummary(error);
  assert.match(summary, /Error: bad key sk-abcdef123456789/);
  assert.equal(redactMessage('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer ***');
  assert.equal(redactMessage('key sk-abcdefgh'), 'key sk-***');
});
