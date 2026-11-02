// test/media/bookmark.test.js —— 书签 sidecar 引擎（9z5.37.1）
//
// 覆盖 ticket 的验收点（用假嵌入器，不碰真实 PDF / VTT 写入器）：
//   - 首次写入从文件自带目录导入 b1…bN，且导入 id 与读侧共用派生函数一致；
//   - 一次调用混合 remove / update / add，顺序固定、all-or-nothing；
//   - 所有错误一次性报全；id 取 max+1、永不复用、update 保留 id；
//   - 嵌入失败 → sidecar 字节不变、无临时文件；嵌入先于 sidecar；
//   - 损坏的 sidecar → 报错带路径且绝不覆盖；目录不可写 → 明确报错、不回退；
//   - 引擎参数化（id 前缀 / sidecar 后缀）供 9z5.38.1 复用。
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ToolError } from '../../src/media/interface.js';
import {
  bookmarkEngine,
  createSidecarEngine,
  deriveEntriesFromProbe,
  deriveEntriesFromOutline,
  readSidecar,
  serializeSidecar,
} from '../../src/media/bookmark/index.js';

/* ------------------------------------------------------------------ *
 * 测试夹具
 * ------------------------------------------------------------------ */

const PDF_BYTES = Buffer.from('%PDF-1.7\n% bookmarks are fake\n');
const MP4_BYTES = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-bookmark-'));
  const pdf = path.join(dir, 'report.pdf');
  const video = path.join(dir, 'lecture.mp4');
  const image = path.join(dir, 'cover.png');
  await writeFile(pdf, PDF_BYTES);
  await writeFile(video, MP4_BYTES);
  await writeFile(image, PNG_BYTES);
  return {
    dir,
    pdf,
    video,
    image,
    sidecar: `${pdf}.mmgrep.bookmark.json`,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** PDF probe 结果（pageCount + 自带 outline 条目） */
function pdfProbe(entries, pageCount = 8) {
  return {
    mediaType: 'document',
    container: 'pdf',
    pageCount,
    outline: { available: entries.length > 0, source: 'pdf-bookmarks', total: entries.length, entries, reason: null },
  };
}

/** 视频 probe 结果（durationSec + 章节 outline，形状来自 chaptersToOutline） */
function videoProbe(entries, durationSec = 60) {
  return {
    mediaType: 'video',
    container: 'mov,mp4',
    durationSec,
    outline: { available: entries.length > 0, source: 'chapters', total: entries.length, entries, reason: null },
  };
}

/** 图片 probe 结果：图片没有自带目录 */
function imageProbe() {
  return {
    mediaType: 'document',
    container: 'png',
    pageCount: 1,
    outline: { available: false, source: null, total: 0, entries: [], reason: 'images have no outline' },
  };
}

/**
 * 假嵌入器：记录入参，并在调用时观察 sidecar 是否已经存在（验证「嵌入先于 sidecar」）。
 */
function fakeEmbedder(media, { result = null, error = null, onChange = null } = {}) {
  const calls = [];
  return {
    media,
    calls,
    async embed(input) {
      const call = {
        filePath: input.filePath,
        media: input.media,
        entries: input.entries,
        sidecarPath: input.sidecarPath,
        sidecarExisted: existsSync(input.sidecarPath),
      };
      calls.push(call);
      if (onChange) onChange(call);
      if (error) throw error;
      return result ?? {
        target: `${input.filePath}.mmgrep.bookmark.vtt`,
        checks: [{ name: 'fake-embed', ok: true, detail: `${input.entries.length} entries` }],
      };
    },
  };
}

async function listTemps(dir) {
  const names = await readdir(dir);
  return names.filter((name) => name.includes('.tmp'));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/** 直接写一份合法的 sidecar（模拟「已经有 sidecar」的状态，不经过一次真实写入） */
async function seedSidecar(filePath, media, entries) {
  await writeFile(`${filePath}.mmgrep.bookmark.json`, serializeSidecar(media, entries));
}

function errorOf(promise) {
  return promise.then(
    () => null,
    (error) => error,
  );
}

/* ------------------------------------------------------------------ *
 * 首次导入 + 操作合并
 * ------------------------------------------------------------------ */

test('首次写入：从 PDF 自带目录导入 b1…bN，再按 remove → update → add 合并', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const probe = pdfProbe([
    { level: 1, title: 'Intro', page: 1, label: null },
    { level: 1, title: 'Later', page: 7, label: null },
    { level: 2, title: 'Early', page: 3, label: null },
  ]);
  const embedder = fakeEmbedder('pdf');

  const result = await bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe,
    embedder,
    operations: {
      remove: ['b2'],
      update: [{ id: 'b3', title: 'Early section', level: 1 }],
      add: [{ title: 'Appendix', page: 8, level: 2 }],
    },
  });

  assert.equal(result.created, true);
  assert.equal(result.imported, 3);
  assert.deepEqual(result.applied, { remove: ['b2'], update: ['b3'], add: ['b4'] });
  // sidecar 按位置排序；id 保留，新 id = max(3)+1
  assert.deepEqual(result.outline.entries, [
    { id: 'b1', title: 'Intro', page: 1, level: 1 },
    { id: 'b3', title: 'Early section', page: 3, level: 1 },
    { id: 'b4', title: 'Appendix', page: 8, level: 2 },
  ]);
  assert.equal(result.sidecarPath, ws.sidecar);

  // 嵌入先于 sidecar：嵌入器被调用时 sidecar 还不存在
  assert.equal(embedder.calls.length, 1);
  assert.equal(embedder.calls[0].sidecarExisted, false);
  assert.deepEqual(embedder.calls[0].entries, result.outline.entries);

  // sidecar 是唯一真相源：形状 + 排序 + 结尾换行
  const text = await readFile(ws.sidecar, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(JSON.parse(text), {
    version: 1,
    media: 'pdf',
    entries: result.outline.entries,
  });
  assert.deepEqual(await readSidecar(ws.sidecar, { media: 'pdf', idPrefix: 'b' }), {
    exists: true,
    path: ws.sidecar,
    entries: result.outline.entries,
  });
  // 检查项：嵌入器的 + 回读
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ['fake-embed', true],
    ['sidecar-readback', true],
  ]);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('已有 sidecar 时不重新导入文件目录；删掉最大 id 再加号也不复用', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const probe = pdfProbe([
    { level: 1, title: 'One', page: 1 },
    { level: 1, title: 'Two', page: 2 },
    { level: 1, title: 'Three', page: 3 },
  ]);
  await seedSidecar(ws.pdf, 'pdf', [
    { id: 'b1', title: 'One', page: 1, level: 1 },
    { id: 'b2', title: 'Two', page: 2, level: 1 },
    { id: 'b3', title: 'Three', page: 3, level: 1 },
  ]);

  const result = await bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe,
    embedder: fakeEmbedder('pdf'),
    operations: { remove: ['b3'], add: [{ title: 'Fresh', page: 5 }] },
  });
  assert.equal(result.created, false);
  assert.equal(result.imported, 0);
  assert.deepEqual(result.applied, { remove: ['b3'], update: [], add: ['b4'] });
  assert.deepEqual(result.outline.entries.map((entry) => entry.id), ['b1', 'b2', 'b4']);
});

test('首次导入的 id 与读侧共用派生函数完全一致（含跳过 page=null）', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const outlineEntries = [
    { level: 1, title: 'Chapter A', page: 2, label: null },
    { level: 1, title: 'Broken destination', page: null, label: null },
    { level: 2, title: 'Chapter C', page: 1, label: null },
  ];
  const probe = pdfProbe(outlineEntries);

  const derived = deriveEntriesFromProbe('pdf', probe);
  assert.deepEqual(derived, [
    { id: 'b1', title: 'Chapter A', page: 2, level: 1 },
    { id: 'b2', title: 'Chapter C', page: 1, level: 2 },
  ]);

  const result = await bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe,
    embedder: fakeEmbedder('pdf'),
    operations: { add: [{ title: 'Chapter D', page: 3 }] },
  });
  assert.equal(result.imported, 2);
  for (const entry of derived) {
    assert.deepEqual(result.outline.entries.find((candidate) => candidate.id === entry.id), entry);
  }
  assert.deepEqual(result.outline.entries.map((entry) => entry.id), ['b2', 'b1', 'b3']);

  // 直接调用 outline → entries 的入口也一致（9z5.37.6 会用这一个）
  assert.deepEqual(deriveEntriesFromOutline('pdf', { entries: outlineEntries }), derived);
});

test('update 保留 id，只改给出的字段', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const probe = pdfProbe([{ level: 1, title: 'Old', page: 1 }]);
  await seedSidecar(ws.pdf, 'pdf', [{ id: 'b1', title: 'Old', page: 1, level: 1 }]);
  const result = await bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe,
    embedder: fakeEmbedder('pdf'),
    operations: { update: [{ id: 'b1', page: 4, level: 2 }] },
  });
  assert.deepEqual(result.applied, { remove: [], update: ['b1'], add: [] });
  assert.deepEqual(result.outline.entries, [{ id: 'b1', title: 'Old', page: 4, level: 2 }]);
});

/* ------------------------------------------------------------------ *
 * 校验：一次报全 + all-or-nothing
 * ------------------------------------------------------------------ */

test('非法操作一次报全，且不写 sidecar、不调用嵌入器、不留临时文件', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const probe = pdfProbe([
    { level: 1, title: 'One', page: 1 },
    { level: 1, title: 'Two', page: 2 },
    { level: 1, title: 'Three', page: 3 },
  ]);
  const embedder = fakeEmbedder('pdf');

  const error = await errorOf(bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe,
    embedder,
    operations: {
      remove: ['b9', 'b1', 'b1'],
      update: [{ id: 'b1', title: 'x' }, { id: 'b2', page: 99 }, { id: 'b9', title: 'y' }],
      add: [
        { title: '', page: 2 },
        { id: 'b5', title: 'has id', page: 3 },
        { title: 'bad page', page: 0 },
        { title: 'no page' },
        { title: 'unknown field', page: 1, level: 1, extra: 'x' },
      ],
    },
  }));

  assert.ok(error instanceof ToolError);
  assert.equal(error.code, 'INVALID_ARGUMENT');
  assert.match(error.message, /^media_bookmark refused the request, so nothing was written:/);
  for (const expected of [
    'remove[0]: unknown id "b9"',
    'remove[2]: duplicate id "b1"',
    'update[0]: id "b1" is also in remove',
    'update[1]: page 99 is outside 1..8',
    'update[2]: unknown id "b9"',
    'add[0]: title must be a non-empty string',
    'add[1]: must not include "id"',
    'add[2]: page must be an integer ≥ 1',
    'add[3]: page is required for a PDF bookmark',
    'add[4]: unknown field "extra"',
  ]) {
    assert.ok(error.message.includes(expected), `missing error line: ${expected}\n${error.message}`);
  }
  assert.match(error.hint, /Nothing was written/);
  assert.equal(embedder.calls.length, 0, 'a rejected plan must not embed');
  assert.equal(existsSync(ws.sidecar), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('没有任何操作 / 未知操作键：拒绝且不写文件', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const probe = pdfProbe([]);

  const empty = await errorOf(bookmarkEngine.execute({
    filePath: ws.pdf, media: 'pdf', probe, embedder: fakeEmbedder('pdf'), operations: {},
  }));
  assert.equal(empty.code, 'INVALID_ARGUMENT');
  assert.match(empty.message, /at least one operation: add, remove, or update/);

  const unknown = await errorOf(bookmarkEngine.execute({
    filePath: ws.pdf, media: 'pdf', probe, embedder: fakeEmbedder('pdf'), operations: { rename: ['b1'] },
  }));
  assert.equal(unknown.code, 'INVALID_ARGUMENT');
  assert.match(unknown.message, /unknown operation "rename"/);
  assert.equal(existsSync(ws.sidecar), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('视频：页码换成 start/end（秒），end 可省略，位置越界报错', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const probe = videoProbe([
    { title: 'Intro', startSec: 0, endSec: 10, startMs: 0, endMs: 10000 },
    { title: 'Main', startSec: 10, endSec: 40, startMs: 10000, endMs: 40000 },
  ]);
  const embedder = fakeEmbedder('video');

  const result = await bookmarkEngine.execute({
    filePath: ws.video,
    media: 'video',
    probe,
    embedder,
    operations: { add: [{ title: 'Q&A', start: 40 }] },
  });
  assert.equal(result.imported, 2);
  assert.deepEqual(result.outline.entries, [
    { id: 'b1', title: 'Intro', start: 0, end: 10 },
    { id: 'b2', title: 'Main', start: 10, end: 40 },
    { id: 'b3', title: 'Q&A', start: 40 },
  ]);
  assert.equal((await readJson(ws.video + '.mmgrep.bookmark.json')).media, 'video');
  assert.deepEqual(embedder.calls[0].entries, result.outline.entries);

  const error = await errorOf(bookmarkEngine.execute({
    filePath: ws.video,
    media: 'video',
    probe,
    embedder: fakeEmbedder('video'),
    operations: { add: [{ title: 'Too late', start: 90 }] },
  }));
  assert.equal(error.code, 'INVALID_ARGUMENT');
  assert.match(error.message, /start 90s is outside 0..60s/);

  const badEnd = await errorOf(bookmarkEngine.execute({
    filePath: ws.video,
    media: 'video',
    probe,
    embedder: fakeEmbedder('video'),
    operations: { add: [{ title: 'Backwards', start: 20, end: 10 }] },
  }));
  assert.equal(badEnd.code, 'INVALID_ARGUMENT');
  assert.match(badEnd.message, /end 10s must be greater than start 20s/);
});

test('图片：没有嵌入器，只写 sidecar（嵌入检查说明 sidecar 是唯一存储）', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const result = await bookmarkEngine.execute({
    filePath: ws.image,
    media: 'image',
    probe: imageProbe(),
    operations: { add: [{ title: 'Cover' }] },
  });
  assert.deepEqual(result.outline.entries, [{ id: 'b1', title: 'Cover' }]);
  assert.equal(result.embed.target, null);
  assert.equal(result.embed.checks.length, 1);
  assert.equal(result.embed.checks[0].ok, true);
  assert.match(result.embed.checks[0].detail, /sidecar is the only store/);
  assert.deepEqual(await readJson(`${ws.image}.mmgrep.bookmark.json`), {
    version: 1,
    media: 'image',
    entries: [{ id: 'b1', title: 'Cover' }],
  });
});

/* ------------------------------------------------------------------ *
 * 嵌入失败 / 损坏 sidecar / 不可写目录 / AbortSignal
 * ------------------------------------------------------------------ */

test('嵌入抛错：sidecar 字节不变、无临时文件、错误原样上抛', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const probe = pdfProbe([{ level: 1, title: 'One', page: 1 }]);
  await seedSidecar(ws.pdf, 'pdf', [{ id: 'b1', title: 'One', page: 1, level: 1 }]);
  const before = await readFile(ws.sidecar);

  const error = await errorOf(bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe,
    embedder: fakeEmbedder('pdf', { error: new ToolError('TOOL_NOT_FOUND', 'writer missing') }),
    operations: { add: [{ title: 'Two', page: 2 }] },
  }));
  assert.equal(error.code, 'TOOL_NOT_FOUND');
  assert.match(error.message, /writer missing/);
  assert.deepEqual(await readFile(ws.sidecar), before);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('嵌入检查项失败：报出失败的检查名，sidecar 不变', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const probe = pdfProbe([{ level: 1, title: 'One', page: 1 }]);
  await seedSidecar(ws.pdf, 'pdf', [{ id: 'b1', title: 'One', page: 1, level: 1 }]);
  const before = await readFile(ws.sidecar);

  const error = await errorOf(bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe,
    embedder: fakeEmbedder('pdf', {
      result: { target: ws.pdf, checks: [{ name: 'page-text', ok: false, detail: 'page 2 changed' }] },
    }),
    operations: { add: [{ title: 'Two', page: 2 }] },
  }));
  assert.equal(error.code, 'INTERNAL');
  assert.match(error.message, /embedding failed/);
  assert.match(error.message, /check "page-text" failed: page 2 changed/);
  assert.match(error.message, /sidecar was not written/);
  assert.deepEqual(await readFile(ws.sidecar), before);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('首次写入时嵌入失败：不创建 sidecar', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const error = await errorOf(bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe([]),
    embedder: fakeEmbedder('pdf', { error: new ToolError('INTERNAL', 'boom') }),
    operations: { add: [{ title: 'One', page: 1 }] },
  }));
  assert.equal(error.code, 'INTERNAL');
  assert.equal(existsSync(ws.sidecar), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('损坏的 sidecar：报错带路径、列出所有问题、绝不覆盖', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const corrupt = '{ this is not json';
  await writeFile(ws.sidecar, corrupt);
  const error = await errorOf(bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe([]),
    embedder: fakeEmbedder('pdf'),
    operations: { add: [{ title: 'One', page: 1 }] },
  }));
  assert.equal(error.code, 'INVALID_ARGUMENT');
  assert.match(error.message, /is corrupted/);
  assert.ok(error.message.includes(ws.sidecar), 'error must include the sidecar path');
  assert.match(error.message, /not valid JSON/);
  assert.equal(await readFile(ws.sidecar, 'utf8'), corrupt);

  const badEntries = JSON.stringify({
    version: 1,
    media: 'pdf',
    entries: [{ id: 'x1', title: 'T' }],
  });
  await writeFile(ws.sidecar, badEntries);
  const error2 = await errorOf(bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe([]),
    embedder: fakeEmbedder('pdf'),
    operations: { remove: ['b1'] },
  }));
  assert.equal(error2.code, 'INVALID_ARGUMENT');
  assert.ok(error2.message.includes(ws.sidecar));
  assert.match(error2.message, /entries\[0\]: id "x1" is not a valid bookmark id/);
  assert.match(error2.message, /entries\[0\]: page is required for a PDF bookmark/);
  assert.equal(await readFile(ws.sidecar, 'utf8'), badEntries);
});

test('AbortSignal：嵌入后被取消 → 不写 sidecar，错误是 AbortError', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const controller = new AbortController();
  const embedder = fakeEmbedder('pdf', { onChange: () => controller.abort() });

  const error = await errorOf(bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe([]),
    embedder,
    signal: controller.signal,
    operations: { add: [{ title: 'One', page: 1 }] },
  }));
  assert.equal(error.name, 'AbortError');
  assert.equal(embedder.calls.length, 1);
  assert.equal(existsSync(ws.sidecar), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('源目录不可写：明确报错、不回退、不留下半截文件', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: directory permissions are not enforced');
    return;
  }
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  await chmod(ws.dir, 0o500);
  let error;
  try {
    error = await errorOf(bookmarkEngine.execute({
      filePath: ws.pdf,
      media: 'pdf',
      probe: pdfProbe([]),
      embedder: fakeEmbedder('pdf'),
      operations: { add: [{ title: 'One', page: 1 }] },
    }));
  } finally {
    await chmod(ws.dir, 0o700);
  }

  assert.ok(error instanceof ToolError);
  assert.equal(error.code, 'INTERNAL');
  assert.match(error.message, /cannot write/);
  assert.match(error.hint, /no fallback location/);
  assert.equal(existsSync(ws.sidecar), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

/* ------------------------------------------------------------------ *
 * 参数化（9z5.38.1 复用）
 * ------------------------------------------------------------------ */

test('引擎参数化：id 前缀与 sidecar 后缀可换（media_annotate 的复用点）', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);
  const engine = createSidecarEngine({
    label: 'media_annotate',
    idPrefix: 'n',
    sidecarSuffix: '.mmgrep.annotation.json',
  });
  assert.equal(engine.sidecarPath(ws.pdf), `${ws.pdf}.mmgrep.annotation.json`);

  const result = await engine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe([]),
    embedder: fakeEmbedder('pdf'),
    operations: { add: [{ title: 'Note', page: 2 }] },
  });
  assert.deepEqual(result.outline.entries, [{ id: 'n1', title: 'Note', page: 2, level: 1 }]);
  assert.ok(result.sidecarPath.endsWith('.mmgrep.annotation.json'));
});

test('默认嵌入器注册表：PDF / VTT 写入器仍是 stub，报「尚未实现」并指出对应 ticket', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const pdfError = await errorOf(bookmarkEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe([]),
    operations: { add: [{ title: 'One', page: 1 }] },
  }));
  assert.equal(pdfError.code, 'TOOL_NOT_FOUND');
  assert.match(pdfError.message, /not implemented yet \(ticket 9z5\.37\.2\)/);

  const videoError = await errorOf(bookmarkEngine.execute({
    filePath: ws.video,
    media: 'video',
    probe: videoProbe([]),
    operations: { add: [{ title: 'One', start: 0 }] },
  }));
  assert.equal(videoError.code, 'TOOL_NOT_FOUND');
  assert.match(videoError.message, /not implemented yet \(ticket 9z5\.37\.4\)/);

  assert.equal(existsSync(ws.sidecar), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});
