// test/integration/media-stdio.test.js —— 三种媒体走真实 stdio server 的端到端测试。
// 后端全部真实（video/audio/document），外部服务全部关闭（ASR/doc provider = none），
// 只依赖仓库内的生成素材与本地 ffmpeg / poppler。素材不在时整组跳过。
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { assertFfmpegAvailable } from '../../src/media/ffmpeg.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'src/index.js');
const FIX = path.join(ROOT, 'fixtures', 'generated');

const ASSETS = {
  scene: path.join(FIX, 'sample-scene.mp4'),
  subsVideo: path.join(FIX, 'sample-subtitles.mp4'),
  subsFile: path.join(FIX, 'sample-subtitles.srt'),
  tone: path.join(FIX, 'sample-tone.wav'),
  textPdf: path.join(FIX, 'sample-text.pdf'),
  scannedPdf: path.join(FIX, 'sample-scanned.pdf'),
  image: path.join(FIX, 'sample-image.png'),
};

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fixturesReady() {
  for (const file of Object.values(ASSETS)) {
    if (!(await exists(file))) return false;
  }
  try {
    await assertFfmpegAvailable();
    return true;
  } catch {
    return false;
  }
}

const ready = await fixturesReady();
const skip = !ready;
if (skip) {
  test('integration：缺少 fixtures/generated 或 ffmpeg，跳过', { skip: true }, () => {});
}

/** 启动真 server 进程，返回 client + 临时目录清理 */
async function withServer(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-int-'));
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
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: 'integration', version: '0.0.0' });
  try {
    await client.connect(transport);
    return await fn({ client, dir, stderr: () => stderr });
  } finally {
    try { await client.close(); } catch { /* 进程可能已自行退出 */ }
    await rm(dir, { recursive: true, force: true });
  }
}

const call = (client, name, args) => client.callTool({ name, arguments: args });

test('video：probe / overview / zoom / locate 走真 server', { skip, timeout: 120000 }, async () => {
  await withServer(async ({ client }) => {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      'media_probe', 'media_overview', 'media_zoom', 'media_locate', 'media_bookmark', 'media_annotate',
    ]);

    const probe = await call(client, 'media_probe', { path: ASSETS.scene });
    assert.notEqual(probe.isError, true);
    assert.equal(probe.structuredContent.mediaType, 'video');
    assert.ok(Math.abs(probe.structuredContent.durationSec - 12) < 0.2);
    assert.equal(probe.structuredContent.hasAudio, true);

    const overview = await call(client, 'media_overview', {
      path: ASSETS.subsVideo, cells: 4, images: 1, maxEdge: 1280,
    });
    assert.notEqual(overview.isError, true);
    const ov = overview.structuredContent;
    assert.equal(ov.images.length, 1);
    assert.equal(ov.images[0].cells, 4);
    assert.ok(overview.content.some((block) => block.type === 'image'));
    assert.equal(ov.segments.length, 4);
    assert.equal(ov.transcript.source, 'subtitle');
    assert.equal(ov.transcript.origin, 'file');
    assert.match(overview.content[0].text, /THIRD SUBTITLE LINE/);
    const contentMd = await readFile(ov.fullText.contentMd, 'utf8');
    assert.match(contentMd, /^## 00:06\.000 – 00:09\.000$/m);

    const zoom = await call(client, 'media_zoom', { path: ASSETS.scene, at: 5 });
    assert.notEqual(zoom.isError, true);
    assert.equal(zoom.structuredContent.imageCount, 1);
    assert.ok(Math.abs(zoom.structuredContent.target.atMs - 5000) <= 50);
    assert.ok(zoom.content.some((block) => block.type === 'image'));

    const locate = await call(client, 'media_locate', { path: ASSETS.subsVideo, query: 'THIRD SUBTITLE' });
    assert.notEqual(locate.isError, true);
    assert.equal(locate.structuredContent.matches[0].startMs, 6000);
    assert.equal(locate.structuredContent.matches[0].source, 'subtitle');
    assert.match(locate.content[0].text, /media_zoom\(\{ path, start, end \}\)/);

    const subs = await call(client, 'media_overview', {
      path: ASSETS.subsVideo, images: 0, transcript: 'subtitle',
    });
    assert.notEqual(subs.isError, true);
    assert.equal(subs.structuredContent.segments.length, 4);
    assert.equal(subs.structuredContent.transcript.source, 'subtitle');
    assert.equal(subs.structuredContent.transcript.origin, 'file');

    const noSource = await call(client, 'media_overview', {
      path: ASSETS.scene, images: 0, transcript: 'subtitle',
    });
    assert.notEqual(noSource.isError, true);
    assert.deepEqual(noSource.structuredContent.segments, []);
    assert.equal(noSource.structuredContent.transcript.source, 'none');
  });
});

test('audio：probe / overview（字幕优先 + 包络图）/ locate', { skip, timeout: 120000 }, async () => {
  await withServer(async ({ client }) => {
    const probe = await call(client, 'media_probe', { path: ASSETS.tone });
    assert.notEqual(probe.isError, true);
    assert.equal(probe.structuredContent.mediaType, 'audio');
    assert.ok(Math.abs(probe.structuredContent.durationSec - 10) < 0.2);
    assert.equal(probe.structuredContent.capabilities.transcriptSource, 'none');

    const overview = await call(client, 'media_overview', {
      path: ASSETS.tone, subtitle: ASSETS.subsFile, envelope: true,
    });
    assert.notEqual(overview.isError, true);
    const ov = overview.structuredContent;
    assert.equal(ov.transcript.source, 'subtitle');
    assert.equal(ov.transcript.origin, 'file');
    assert.ok(ov.segments.length >= 3);
    assert.equal(ov.images.length, 1, 'envelope:true 应返回一张波形图');
    assert.ok(overview.content.some((block) => block.type === 'image'));

    const locate = await call(client, 'media_locate', {
      path: ASSETS.tone, subtitle: ASSETS.subsFile, query: 'THIRD SUBTITLE',
    });
    assert.notEqual(locate.isError, true);
    assert.equal(locate.structuredContent.matches[0].startMs, 6000);

    const zoom = await call(client, 'media_zoom', { path: ASSETS.tone, at: 1 });
    assert.equal(zoom.isError, true);
    assert.equal(zoom.structuredContent.error.code, 'INVALID_ARGUMENT');
  });
});

test('document：probe / overview pages / zoom / locate / 扫描件降级', { skip, timeout: 120000 }, async () => {
  await withServer(async ({ client, dir }) => {
    const probe = await call(client, 'media_probe', { path: ASSETS.textPdf });
    assert.notEqual(probe.isError, true);
    assert.equal(probe.structuredContent.mediaType, 'document');
    assert.equal(probe.structuredContent.pageCount, 6);
    assert.equal(probe.structuredContent.hasTextLayer, true);

    const overview = await call(client, 'media_overview', {
      path: ASSETS.textPdf, pages: '1-2', cells: 2, images: 1, maxEdge: 1280,
    });
    assert.notEqual(overview.isError, true);
    const ov = overview.structuredContent;
    assert.deepEqual(ov.window.pages, [1, 2]);
    // 9z5.20：结构化 segments = 实际内联的**单元**（文档 = 句子），不再是「一页一条」。
    assert.deepEqual([...new Set(ov.segments.map((segment) => segment.page))], [1, 2]);
    assert.equal(ov.preview.mode, 'whole');
    assert.equal(ov.preview.totalUnits, ov.segments.length);
    assert.match(ov.segments[0].text, /MULTIMEDIAGREP TEXT FIXTURE/);
    assert.equal(ov.images.length, 1);
    const contentMd = await readFile(ov.fullText.contentMd, 'utf8');
    assert.match(contentMd, /^## Page 1$/m);

    const zoom = await call(client, 'media_zoom', { path: ASSETS.textPdf, page: 1 });
    assert.notEqual(zoom.isError, true);
    assert.equal(zoom.structuredContent.imageCount, 1);
    assert.equal(zoom.structuredContent.target.page, 1);
    assert.ok(zoom.content.some((block) => block.type === 'image'));

    const locate = await call(client, 'media_locate', { path: ASSETS.textPdf, query: 'SECOND PAGE' });
    assert.notEqual(locate.isError, true);
    assert.equal(locate.structuredContent.matches[0].page, 2);
    assert.match(locate.content[0].text, /media_zoom\(\{ path, page \}\)/);

    const scanned = await call(client, 'media_overview', {
      path: ASSETS.scannedPdf, pages: '1-2', cells: 2, images: 1,
    });
    assert.notEqual(scanned.isError, true);
    assert.equal(scanned.structuredContent.transcript.source, 'none');
    assert.equal(scanned.structuredContent.images.length, 1);

    const docx = path.join(dir, 'a.docx');
    await writeFile(docx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
    const office = await call(client, 'media_probe', { path: docx });
    assert.equal(office.isError, true);
    assert.equal(office.structuredContent.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.match(office.content[0].text, /LibreOffice|PDF/i);
  });
});
