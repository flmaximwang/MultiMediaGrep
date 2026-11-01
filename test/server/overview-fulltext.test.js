// test/server/overview-fulltext.test.js —— 全文落盘路径必须出现在 text content（.22）
//
// 为什么单独一个文件：这条是「宿主只看 text content」的回归。
// 用 InMemoryTransport 走完整 MCP 协议 + 真实 exportAnalysis 落盘，
// 只把后端和缓存目录换成临时目录（不碰 ffmpeg / 网络）。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';

const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');

/** 每页正文都远大于测试里设的内联上限，保证「没被内联」的部分确实存在 */
function pageText(page) {
  const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(24);
  return `PAGE ${page} START. ${filler} PAGE ${page} END.`;
}

const DOCUMENT_PAGES = [3, 4, 5];

async function makeWorkspace({ prepareDir } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-fulltext-'));
  const file = path.join(dir, 'a.pdf');
  await writeFile(file, PDF);
  const config = loadConfig({
    MMGREP_CACHE_DIR: path.join(dir, 'cache'),
    MMGREP_MAX_TEXT_INLINE_CHARS: '900',
    MMGREP_MAX_IMAGE_TOKENS: '4000',
  });
  const exportDir = path.join(dir, 'export');
  const cache = {
    async contentKeyForFile() {
      return { sha256: 'c'.repeat(64), key: `sha256:${'c'.repeat(64)}` };
    },
    async prepareDir(key) {
      if (prepareDir) return prepareDir(key, { exportDir, dir });
      await mkdir(exportDir, { recursive: true });
      return exportDir;
    },
    async register() {
      return { path: exportDir, type: 'dir', size: 0 };
    },
  };
  return { dir, file, config, cache, exportDir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 文档后端 stub：返回请求页码的完整页文字（刻意超长） */
function documentBackend() {
  return {
    async probe() {
      return {
        mediaType: 'document',
        pageCount: 8,
        hasTextLayer: true,
        hasAudio: false,
        container: 'pdf',
        subtitleTracks: [],
        audioTracks: [],
      };
    },
    async overview(input) {
      const pages = Array.isArray(input.pages) && input.pages.length > 0 ? input.pages : DOCUMENT_PAGES;
      return {
        segments: pages.map((page) => ({
          page,
          text: pageText(page),
          startMs: null,
          endMs: null,
          source: 'ocr',
          origin: 'ocr',
        })),
        images: [],
        transcript: { source: 'ocr', origin: 'ocr', language: 'en', provider: 'mineru', model: 'stub' },
        warnings: [],
      };
    },
  };
}

function audioBackend() {
  return {
    async probe() {
      return {
        mediaType: 'audio',
        durationMs: 60000,
        durationSec: 60,
        hasAudio: true,
        container: 'mp3',
        subtitleTracks: [],
        audioTracks: [],
        capabilities: { asr: { available: true, provider: 'stub' }, transcriptSource: 'asr' },
      };
    },
    async overview() {
      return {
        segments: [{ startMs: 0, endMs: 4000, text: '第一段', source: 'asr', origin: 'asr' }],
        images: [],
        transcript: { source: 'asr', origin: 'asr', language: 'zh', provider: 'stub', model: 'stub-v1' },
        warnings: [],
      };
    },
  };
}

async function withClient(workspace, fn, { document = documentBackend(), audio = audioBackend() } = {}) {
  const server = createServer({
    config: workspace.config,
    backends: { document, audio, video: { async probe() { throw new Error('video not used'); } } },
    cache: workspace.cache,
    logger: SILENT_LOGGER,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fulltext-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('document overview：text content 含 content.md 绝对路径，文件可读且包含未内联的页', async () => {
  const workspace = await makeWorkspace();
  try {
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.file, pages: '3-5', images: 0 },
      });
      assert.notEqual(result.isError, true);

      const text = result.content[0].text;
      const data = result.structuredContent;
      assert.ok(data.fullText.contentMd, 'structuredContent.fullText 仍然给路径');
      assert.equal(data.fullTextReason, null);

      // 1) 路径在模型看得到的通道里
      assert.match(text, /^full text: \/.*content\.md \(segments\.jsonl, manifest\.json in the same directory\)$/m);
      assert.ok(text.includes(`full text: ${data.fullText.contentMd} `), 'text content 必须含 contentMd 的绝对路径');

      // 2) 文件真实存在，且包含本次请求的全部页（包括没被内联的部分）
      await stat(data.fullText.contentMd);
      await stat(data.fullText.segmentsJsonl);
      const contentMd = await readFile(data.fullText.contentMd, 'utf8');
      for (const page of DOCUMENT_PAGES) {
        assert.match(contentMd, new RegExp(`PAGE ${page} START\\.`));
        assert.match(contentMd, new RegExp(`PAGE ${page} END\\.`));
      }

      // 3) 续读提示也进 text content
      assert.match(data.continuation.note, /More pages follow \(6-8\)/);
      assert.ok(text.includes(data.continuation.note), 'continuation.note 必须出现在 text content 里');
    });
  } finally {
    await workspace.cleanup();
  }
});

test('audio overview：text content 同样含 full text 行', async () => {
  const workspace = await makeWorkspace();
  try {
    const audioFile = path.join(workspace.dir, 'a.mp3');
    await writeFile(audioFile, Buffer.from('ID3'));
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: audioFile, images: 0 },
      });
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      const data = result.structuredContent;
      assert.ok(text.includes(`full text: ${data.fullText.contentMd} `));
      await stat(data.fullText.contentMd);
      const contentMd = await readFile(data.fullText.contentMd, 'utf8');
      assert.match(contentMd, /第一段/);
    });
  } finally {
    await workspace.cleanup();
  }
});

test('落盘抛错时调用仍然成功：text 写 NOT written，fullText = null + 原因', async () => {
  const workspace = await makeWorkspace({
    // 把「目录」指到一个普通文件上：mkdir 必然失败 → exportAnalysis 抛错
    prepareDir: async (key, { dir }) => {
      const blocker = path.join(dir, 'blocked-dir');
      await writeFile(blocker, 'not a directory');
      return blocker;
    },
  });
  try {
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.file, pages: '3-5', images: 0 },
      });
      assert.notEqual(result.isError, true, '落盘失败不能让 overview 失败');
      const text = result.content[0].text;
      assert.match(text, /^full text: NOT written — /m);
      assert.equal(result.structuredContent.fullText, null);
      assert.ok(result.structuredContent.fullTextReason, '必须给出落盘失败原因');
      assert.ok(text.includes(result.structuredContent.fullTextReason));
    });
  } finally {
    await workspace.cleanup();
  }
});

test('cache.prepareDir 失败回落 os.tmpdir()：text 里说明这是临时目录', async () => {
  const workspace = await makeWorkspace({
    prepareDir: async () => {
      throw new Error('cache is read-only');
    },
  });
  let tmpOutDir = null;
  try {
    await withClient(workspace, async (client) => {
      const result = await client.callTool({
        name: 'media_overview',
        arguments: { path: workspace.file, pages: '3-4', images: 0 },
      });
      assert.notEqual(result.isError, true);
      const text = result.content[0].text;
      const data = result.structuredContent;
      assert.match(text, /OS temp directory/);
      assert.ok(text.includes(`full text: ${data.fullText.contentMd} `));
      tmpOutDir = data.fullText.dir;
      assert.ok(tmpOutDir.startsWith(tmpdir()));
      await stat(data.fullText.contentMd);
    });
  } finally {
    if (tmpOutDir) await rm(tmpOutDir, { recursive: true, force: true });
    await workspace.cleanup();
  }
});
