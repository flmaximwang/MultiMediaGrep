// test/server/bookmark-tool.test.js —— media_bookmark 的 MCP 注册与调用（9z5.37.1）
//
// 走真实 MCP 协议（InMemoryTransport），后端是 stub，嵌入器是假的：
// 本 ticket 只验证工具骨架，不验证真实 PDF / VTT 写入（那是 9z5.37.2 / 9z5.37.4）。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLogger, loadConfig } from '../../src/server/config.js';
import { createServer } from '../../src/server/index.js';

/* ------------------------------------------------------------------ *
 * 测试夹具
 * ------------------------------------------------------------------ */

const PDF = Buffer.from('%PDF-1.7\n% bookmark skeleton test\n');
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const SILENT_LOGGER = createLogger({ level: 'error', stream: { write() {} } });

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-bookmark-tool-'));
  const files = {
    pdf: path.join(dir, 'report.pdf'),
    video: path.join(dir, 'lecture.mp4'),
    image: path.join(dir, 'cover.png'),
    text: path.join(dir, 'notes.txt'),
  };
  await writeFile(files.pdf, PDF);
  await writeFile(files.video, MP4);
  await writeFile(files.image, PNG);
  await writeFile(files.text, 'plain text, no outline\n');
  return {
    dir,
    files,
    config: loadConfig({ MMGREP_CACHE_DIR: path.join(dir, 'cache'), MMGREP_MAX_IMAGE_TOKENS: '4000' }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** document 后端的 stub（只实现 probe，书签工具只用到 probe） */
function documentBackend({ container = 'pdf', pageCount = 8, outlineEntries = [] } = {}) {
  return {
    async probe() {
      return {
        mediaType: 'document',
        pageCount,
        container,
        hasTextLayer: container === 'pdf',
        hasAudio: false,
        subtitleTracks: [],
        audioTracks: [],
        durationSec: null,
        outline: {
          available: container === 'pdf' && outlineEntries.length > 0,
          source: container === 'pdf' ? 'pdf-bookmarks' : null,
          total: outlineEntries.length,
          entries: outlineEntries,
          reason: container === 'pdf' ? null : 'not a PDF',
        },
      };
    },
  };
}

/** video 后端的 stub（章节 outline 形状来自 chaptersToOutline） */
function videoBackend({ durationSec = 60, outlineEntries = [] } = {}) {
  return {
    async probe() {
      return {
        mediaType: 'video',
        durationMs: durationSec * 1000,
        durationSec,
        width: 1920,
        height: 1080,
        fps: 25,
        container: 'mov,mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        audioChannels: 2,
        sampleRateHz: 44100,
        hasAudio: true,
        subtitleTracks: [],
        audioTracks: [],
        outline: { available: outlineEntries.length > 0, source: 'chapters', total: outlineEntries.length, entries: outlineEntries, reason: null },
      };
    },
  };
}

function stubBackends(overrides = {}) {
  return {
    document: overrides.document ?? documentBackend(),
    video: overrides.video ?? videoBackend(),
    audio: overrides.audio ?? videoBackend(),
  };
}

/** 假 PDF 嵌入器：记录入参，返回一个检查项；绝不写真实 PDF */
function fakePdfEmbedder({ checks = null, error = null } = {}) {
  const calls = [];
  return {
    media: 'pdf',
    calls,
    async embed(input) {
      calls.push(input);
      if (error) throw error;
      return {
        target: input.filePath,
        checks: checks ?? [{ name: 'fake-pdf-outline', ok: true, detail: `${input.entries.length} entries` }],
      };
    },
  };
}

/** 假 VTT 嵌入器：目标固定为 <basename>.mmgrep.bookmark.vtt（与 9z5.37.4 一致） */
function fakeVttEmbedder({ error = null } = {}) {
  const calls = [];
  return {
    media: 'video',
    calls,
    async embed(input) {
      calls.push(input);
      if (error) throw error;
      return {
        target: `${input.filePath}.mmgrep.bookmark.vtt`,
        checks: [{ name: 'fake-vtt', ok: true, detail: `${input.entries.length} cues` }],
      };
    },
  };
}

async function withClient(workspace, fn, { backends = stubBackends(), bookmarkEmbedders } = {}) {
  const server = createServer({
    config: workspace.config,
    backends,
    cache: null,
    logger: SILENT_LOGGER,
    bookmarkEmbedders,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bookmark-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client, server);
  } finally {
    await client.close();
  }
}

function errorCode(result) {
  return result?.structuredContent?.error?.code ?? null;
}

async function listTemps(dir) {
  return (await readdir(dir)).filter((name) => name.includes('.tmp'));
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

test('注册：media_bookmark 是第 5 个工具，带破坏性注解、警告与中文触发词', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  await withClient(ws, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [
      'media_probe',
      'media_overview',
      'media_zoom',
      'media_locate',
      'media_bookmark',
    ]);

    const bookmark = tools.find((tool) => tool.name === 'media_bookmark');
    assert.ok(bookmark);
    // 只读工具保持只读；写工具明确声明破坏性 / 非幂等
    assert.equal(bookmark.annotations.readOnlyHint, false);
    assert.equal(bookmark.annotations.destructiveHint, true);
    assert.equal(bookmark.annotations.idempotentHint, false);
    assert.equal(bookmark.annotations.openWorldHint, false);
    for (const name of ['media_probe', 'media_overview', 'media_zoom', 'media_locate']) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.equal(tool.annotations.readOnlyHint, true, `${name} must stay read-only`);
      assert.equal(tool.annotations.openWorldHint, false);
    }

    // 参数：path 必填；add/remove/update 可选；顶层未知参数被拒绝
    assert.equal(bookmark.inputSchema.type, 'object');
    assert.equal(bookmark.inputSchema.additionalProperties, false);
    assert.deepEqual(bookmark.inputSchema.required, ['path']);
    assert.deepEqual(Object.keys(bookmark.inputSchema.properties).sort(), ['add', 'path', 'remove', 'update']);

    // 描述：中文触发词 + 英文警告（原地改写 / 源文件旁写文件 / 覆盖外部编辑 / git）
    for (const trigger of ['书签', '目录', '章节', 'bookmark', 'outline', 'chapter']) {
      assert.ok(bookmark.description.includes(trigger), `description must mention "${trigger}"`);
    }
    assert.match(bookmark.description, /IN PLACE/);
    assert.match(bookmark.description, /\*\.mmgrep\.\*/);
    assert.match(bookmark.description, /OVERWRITTEN/);
    assert.match(bookmark.description, /git/);
  });
});

/* ------------------------------------------------------------------ *
 * 调用：成功路径（假嵌入器）
 * ------------------------------------------------------------------ */

test('PDF：首次写入导入自带目录 + 混合 update/add，返回完整目录、sidecar、嵌入目标与检查项', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const backends = stubBackends({
    document: documentBackend({
      pageCount: 8,
      outlineEntries: [
        { level: 1, title: 'One', page: 1, label: null },
        { level: 2, title: 'Two', page: 3, label: null },
      ],
    }),
  });
  const embedder = fakePdfEmbedder();

  await withClient(ws, async (client) => {
    const result = await client.callTool({
      name: 'media_bookmark',
      arguments: {
        path: ws.files.pdf,
        update: [{ id: 'b2', title: 'Second', level: 1 }],
        add: [{ title: 'Appendix', page: 8, level: 2 }],
      },
    });

    assert.notEqual(result.isError, true);
    const structured = result.structuredContent;
    assert.equal(structured.path, ws.files.pdf);
    assert.equal(structured.media, 'pdf');
    assert.equal(structured.created, true);
    assert.equal(structured.imported, 2);
    assert.deepEqual(structured.applied, { remove: [], update: ['b2'], add: ['b3'] });
    assert.deepEqual(structured.outline, {
      source: 'sidecar',
      available: true,
      total: 3,
      entries: [
        { id: 'b1', title: 'One', page: 1, level: 1 },
        { id: 'b2', title: 'Second', page: 3, level: 1 },
        { id: 'b3', title: 'Appendix', page: 8, level: 2 },
      ],
    });
    assert.equal(structured.sidecarPath, `${ws.files.pdf}.mmgrep.bookmark.json`);
    assert.equal(structured.embed.target, ws.files.pdf);
    assert.deepEqual(structured.checks.map((check) => [check.name, check.ok]), [
      ['fake-pdf-outline', true],
      ['sidecar-readback', true],
    ]);
    // 嵌入器收到的是最终条目（含新 id），且只调用一次
    assert.equal(embedder.calls.length, 1);
    assert.deepEqual(embedder.calls[0].entries, structured.outline.entries);

    // 文本结果：完整目录（统一格式）+ sidecar 路径 + 嵌入目标 + 检查
    const text = result.content[0].text;
    assert.match(text, /Bookmarks written for .*report\.pdf.* \(pdf\): 3 entries; imported 2 from the file's own outline/);
    assert.match(text, /applied: updated b2; added b3/);
    assert.match(text, /sidecar: .*report\.pdf\.mmgrep\.bookmark\.json/);
    assert.match(text, /embed target: .*report\.pdf/);
    assert.match(text, /checks: fake-pdf-outline: ok \(3 entries\); sidecar-readback: ok \(3 entries\)/);
    assert.match(text, /b1 {2}p\.1 {2}One/);
    assert.match(text, /b3 {2}p\.8 {2}Appendix/);

    // sidecar 落盘：版本 / 媒体 / 排序后的条目
    assert.deepEqual(JSON.parse(await readFile(structured.sidecarPath, 'utf8')), {
      version: 1,
      media: 'pdf',
      entries: structured.outline.entries,
    });
    assert.deepEqual(await listTemps(ws.dir), []);
  }, { backends, bookmarkEmbedders: { pdf: embedder } });
});

test('视频：注入假 VTT 嵌入器后写 sidecar，位置是 start/end 秒', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const backends = stubBackends({
    video: videoBackend({
      durationSec: 60,
      outlineEntries: [
        { title: 'Intro', startSec: 0, endSec: 10, startMs: 0, endMs: 10000 },
        { title: 'Main', startSec: 10, endSec: 40, startMs: 10000, endMs: 40000 },
      ],
    }),
  });
  const embedder = fakeVttEmbedder();

  await withClient(ws, async (client) => {
    const result = await client.callTool({
      name: 'media_bookmark',
      arguments: { path: ws.files.video, add: [{ title: 'Q&A', start: 40 }] },
    });

    assert.notEqual(result.isError, true);
    const structured = result.structuredContent;
    assert.equal(structured.media, 'video');
    assert.equal(structured.imported, 2);
    assert.deepEqual(structured.outline.entries, [
      { id: 'b1', title: 'Intro', start: 0, end: 10 },
      { id: 'b2', title: 'Main', start: 10, end: 40 },
      { id: 'b3', title: 'Q&A', start: 40 },
    ]);
    assert.equal(structured.embed.target, `${ws.files.video}.mmgrep.bookmark.vtt`);
    assert.match(result.content[0].text, /b1 {2}00:00 {2}Intro/);
    assert.match(result.content[0].text, /b3 {2}00:40 {2}Q&A/);
    assert.deepEqual(JSON.parse(await readFile(`${ws.files.video}.mmgrep.bookmark.json`, 'utf8')), {
      version: 1,
      media: 'video',
      entries: structured.outline.entries,
    });
  }, { backends, bookmarkEmbedders: { video: embedder } });
});

test('图片：没有嵌入器，只写 sidecar（嵌入目标为 null）', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const backends = stubBackends({ document: documentBackend({ container: 'png', pageCount: 1, outlineEntries: [] }) });

  await withClient(ws, async (client) => {
    const result = await client.callTool({
      name: 'media_bookmark',
      arguments: { path: ws.files.image, add: [{ title: 'Cover' }] },
    });

    assert.notEqual(result.isError, true);
    const structured = result.structuredContent;
    assert.equal(structured.media, 'image');
    assert.deepEqual(structured.outline.entries, [{ id: 'b1', title: 'Cover' }]);
    assert.equal(structured.embed.target, null);
    assert.equal(structured.embed.checks[0].ok, true);
    assert.match(structured.embed.checks[0].detail, /sidecar is the only store/);
    assert.match(result.content[0].text, /embed target: \(none — sidecar only\)/);
    assert.ok(existsSync(`${ws.files.image}.mmgrep.bookmark.json`));
  }, { backends });
});

/* ------------------------------------------------------------------ *
 * 调用：失败路径
 * ------------------------------------------------------------------ */

test('默认嵌入器仍是 stub：PDF 写入报 TOOL_NOT_FOUND（9z5.37.2），不写 sidecar', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  await withClient(ws, async (client) => {
    const result = await client.callTool({
      name: 'media_bookmark',
      arguments: { path: ws.files.pdf, add: [{ title: 'One', page: 1 }] },
    });
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), 'TOOL_NOT_FOUND');
    assert.match(result.content[0].text, /not implemented yet \(ticket 9z5\.37\.2\)/);
    assert.equal(existsSync(`${ws.files.pdf}.mmgrep.bookmark.json`), false);
    assert.deepEqual(await readFile(ws.files.pdf), PDF);
    assert.deepEqual(await listTemps(ws.dir), []);
  });
});

test('非法操作：一次列出所有错误、什么都不写', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const backends = stubBackends({
    document: documentBackend({
      pageCount: 8,
      outlineEntries: [
        { level: 1, title: 'One', page: 1, label: null },
        { level: 1, title: 'Two', page: 2, label: null },
      ],
    }),
  });
  const embedder = fakePdfEmbedder();

  await withClient(ws, async (client) => {
    const result = await client.callTool({
      name: 'media_bookmark',
      arguments: {
        path: ws.files.pdf,
        remove: ['b9'],
        update: [{ id: 'b2', page: 99 }, { id: 'b2' }],
        add: [{ title: '', page: 1 }, { title: 'No page' }],
      },
    });

    assert.equal(result.isError, true);
    assert.equal(errorCode(result), 'INVALID_ARGUMENT');
    const text = result.content[0].text;
    for (const expected of [
      'remove[0]: unknown id "b9"',
      'update[0]: page 99 is outside 1..8',
      'update[1]: provide at least one field to change',
      'add[0]: title must be a non-empty string',
      'add[1]: page is required for a PDF bookmark',
    ]) {
      assert.ok(text.includes(expected), `missing error line: ${expected}\n${text}`);
    }
    assert.match(text, /nothing was written/i);
    assert.equal(embedder.calls.length, 0);
    assert.equal(existsSync(`${ws.files.pdf}.mmgrep.bookmark.json`), false);
    assert.deepEqual(await listTemps(ws.dir), []);
  }, { backends, bookmarkEmbedders: { pdf: embedder } });
});

test('嵌入检查项失败：报出失败检查，sidecar 不变', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const backends = stubBackends({
    document: documentBackend({
      pageCount: 8,
      outlineEntries: [{ level: 1, title: 'One', page: 1, label: null }],
    }),
  });
  const good = fakePdfEmbedder();
  const bad = fakePdfEmbedder({ checks: [{ name: 'page-text', ok: false, detail: 'page 2 changed' }] });

  await withClient(ws, async (client) => {
    const first = await client.callTool({
      name: 'media_bookmark',
      arguments: { path: ws.files.pdf, update: [{ id: 'b1', title: 'One' }] },
    });
    assert.notEqual(first.isError, true);
  }, { backends, bookmarkEmbedders: { pdf: good } });

  // 第二轮用坏嵌入器（单独建 client，确保注入生效）
  await withClient(ws, async (client) => {
    const before = await readFile(`${ws.files.pdf}.mmgrep.bookmark.json`);
    const result = await client.callTool({
      name: 'media_bookmark',
      arguments: { path: ws.files.pdf, add: [{ title: 'Two', page: 2 }] },
    });
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), 'INTERNAL');
    assert.match(result.content[0].text, /page-text/);
    assert.deepEqual(await readFile(`${ws.files.pdf}.mmgrep.bookmark.json`), before);
    assert.deepEqual(await listTemps(ws.dir), []);
  }, { backends, bookmarkEmbedders: { pdf: bad } });
});

test('文本 / Office 文档：没有书签概念，报 UNSUPPORTED_MEDIA_TYPE 且不写文件', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const backends = stubBackends({ document: documentBackend({ container: 'text', pageCount: 1, outlineEntries: [] }) });

  await withClient(ws, async (client) => {
    const result = await client.callTool({
      name: 'media_bookmark',
      arguments: { path: ws.files.text, add: [{ title: 'Note' }] },
    });
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), 'UNSUPPORTED_MEDIA_TYPE');
    // 提示（hint）不进 content 文本，放在 structuredContent.error 里
    assert.match(result.structuredContent.error.hint, /convert it to PDF first/i);
    assert.equal(existsSync(`${ws.files.text}.mmgrep.bookmark.json`), false);
  }, { backends });
});

test('参数校验：没有任何操作 / 顶层未知参数都拒绝', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  await withClient(ws, async (client) => {
    const empty = await client.callTool({ name: 'media_bookmark', arguments: { path: ws.files.pdf } });
    assert.equal(empty.isError, true);
    assert.equal(errorCode(empty), 'INVALID_ARGUMENT');
    assert.match(empty.content[0].text, /at least one operation/);

    const unknown = await client.callTool({
      name: 'media_bookmark',
      arguments: { path: ws.files.pdf, add: [{ title: 'One', page: 1 }], bogus: true },
    });
    assert.equal(unknown.isError, true);
    assert.equal(existsSync(`${ws.files.pdf}.mmgrep.bookmark.json`), false);
  });
});
