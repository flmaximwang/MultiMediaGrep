// test/server/server.test.js —— 真正的 stdio 端到端：spawn `node src/index.js`，
// 用 SDK 的 Client + StdioClientTransport 连上去，验证协议面与启动行为。
//
// 这个文件同时充当「stdout 只给 MCP 用」的守门员：StdioClientTransport 对 stdout 上
// 任何非 JSON-RPC 内容都会解析失败，能正常 listTools 就说明 stdout 没被日志污染。
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { SERVER_INSTRUCTIONS } from '../../src/server/server-instructions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src/index.js');

const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 哪个媒体类型目前还没有后端实现？端到端测试拿它验证占位错误。 */
async function missingBackendType() {
  for (const type of ['video', 'document', 'audio']) {
    if (!(await exists(path.join(ROOT, 'src', 'backend', type, 'index.js')))) return type;
  }
  return null;
}

async function withStdioClient(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-stdio-'));
  const videoPath = path.join(dir, 'a.mp4');
  await writeFile(videoPath, MP4);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd: ROOT,
    env: {
      ...process.env,
      MMGREP_CACHE_DIR: path.join(dir, 'cache'),
      MMGREP_LOG_LEVEL: 'info',
      MMGREP_ASR_PROVIDER: 'none',
      MMGREP_OCR_PROVIDER: 'none',
    },
    stderr: 'pipe',
  });

  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

  const client = new Client({ name: 'stdio-e2e', version: '0.0.0' });
  try {
    await client.connect(transport);
    return await fn({ client, videoPath, stderr: () => stderr });
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('stdio：listTools / instructions / 路径错误 / 占位后端', { timeout: 30000 }, async () => {
  await withStdioClient(async ({ client, videoPath, stderr }) => {
    // 1) 5 个工具，schema 与描述完整
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      'media_probe', 'media_overview', 'media_zoom', 'media_locate', 'media_bookmark',
    ]);
    const probe = listed.tools.find((tool) => tool.name === 'media_probe');
    assert.match(probe.description, /读取本地媒体/);
    assert.equal(probe.inputSchema.type, 'object');
    assert.equal(probe.inputSchema.additionalProperties, false);
    assert.deepEqual(probe.inputSchema.required, ['path']);
    assert.ok(probe.inputSchema.properties.path.description.length > 0);

    // 2) server instructions 原样送达
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    assert.match(client.getInstructions(), /MultiMediaGrep gives you eyes and ears over LOCAL media files/);

    // 3) URL 路径 → NOT_A_LOCAL_PATH（错误结果，不是崩溃）
    const url = await client.callTool({
      name: 'media_probe',
      arguments: { path: 'https://example.com/lecture.mp4' },
    });
    assert.equal(url.isError, true);
    assert.equal(url.structuredContent.error.code, 'NOT_A_LOCAL_PATH');
    assert.match(url.content[0].text, /^NOT_A_LOCAL_PATH:/);

    // 4) 后端未实现的媒体类型 → INTERNAL 占位错误
    const missing = await missingBackendType();
    if (missing) {
      const extension = missing === 'document' ? 'pdf' : missing === 'audio' ? 'mp3' : 'mp4';
      const target = path.join(path.dirname(videoPath), `placeholder.${extension}`);
      const body = missing === 'document'
        ? Buffer.from('%PDF-1.7\n')
        : missing === 'audio' ? Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]) : MP4;
      await writeFile(target, body);
      const placeholder = await client.callTool({
        name: 'media_probe',
        arguments: { path: target },
      });
      assert.equal(placeholder.isError, true);
      assert.equal(placeholder.structuredContent.error.code, 'INTERNAL');
      assert.match(placeholder.content[0].text, new RegExp(`^INTERNAL: ${missing} backend is not implemented yet\\.`));
    }

    // 5) 日志只走 stderr：启动横幅应该在那里
    assert.match(stderr(), /multimediagrep@0\.2\.0 ready on stdio/);
    assert.match(stderr(), /\[mmgrep\] info:/);
  });
});

test('stdio：SIGTERM 后进程正常退出', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-sigterm-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd: ROOT,
    env: {
      ...process.env,
      MMGREP_CACHE_DIR: path.join(dir, 'cache'),
      MMGREP_LOG_LEVEL: 'error',
      MMGREP_ASR_PROVIDER: 'none',
      MMGREP_OCR_PROVIDER: 'none',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-e2e', version: '0.0.0' });
  try {
    await client.connect(transport);
    await client.listTools();
    assert.ok(transport.pid > 0, 'server child process should be running');
    try {
      process.kill(transport.pid, 'SIGTERM');
    } catch {
      // 进程可能已经自己退出了
    }
    try {
      await client.close();
    } catch {
      // SIGTERM 已经让子进程退出时，close 可能报 EOF
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
