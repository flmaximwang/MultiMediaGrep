// test/media/annotation.test.js —— 批注 sidecar 引擎（9z5.38.1）
//
// 覆盖 ticket 的验收点（用假嵌入器，不碰真实 PDF 批注对象 / VTT 写入器）：
//   - 按媒体类型的字段校验，所有错误一次列全（PDF / 视频音频 / 图片各自的字段适用性）；
//   - remove → update → add 的顺序与 all-or-nothing：校验失败不写 sidecar、不调嵌入器、无临时文件；
//   - id 取 max+1、被删掉的 max 也不复用；update 保留 id 与 author；
//   - author：新条目用 context.author，导入条目保留原作者，update 不改 author；
//   - 首次写入从 probe.annotationOutline 导入 n1…nN（页 → rect.y → rect.x），与读侧派生一致；
//   - 视频缺省 end = start + 5 s（截到时长）；
//   - 损坏 sidecar 绝不覆盖；嵌入失败 / 检查项失败 → sidecar 不变、无临时文件；
//   - 默认嵌入器是 9z5.38.2 / 9z5.38.3 的占位：TOOL_NOT_FOUND 且什么都不写；
//   - 图片 / 无嵌入器时只写 sidecar；导入的 raw / 不可新建类型原样保留。
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ToolError } from '../../src/media/interface.js';
import {
  ANNOTATION_ID_PREFIX,
  annotationEngine,
  deriveAnnotationEntriesFromProbe,
  deriveAnnotationsFromOutline,
  readAnnotationSidecar,
  serializeAnnotationSidecar,
  formatAnnotation,
} from '../../src/media/annotation/index.js';

/* ------------------------------------------------------------------ *
 * 测试夹具
 * ------------------------------------------------------------------ */

const PDF_BYTES = Buffer.from('%PDF-1.7\n% annotations are fake\n');
const MP4_BYTES = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-annotation-'));
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
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** PDF probe：pageCount + 可选的 annotationOutline（38.2 会填真实数据源） */
function pdfProbe(entries = [], pageCount = 8) {
  return {
    mediaType: 'document',
    container: 'pdf',
    pageCount,
    annotationOutline: {
      available: entries.length > 0,
      source: 'pdf-annotations',
      total: entries.length,
      entries,
      reason: entries.length === 0 ? 'no annotations' : null,
    },
  };
}

function videoProbe(durationSec = 60) {
  return { mediaType: 'video', container: 'mov,mp4', durationSec };
}

function imageProbe() {
  return { mediaType: 'document', container: 'png', pageCount: 1 };
}

/** 假嵌入器：记录入参，并观察调用时 sidecar 是否已经存在（验证「嵌入先于 sidecar」） */
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
        target: `${input.filePath}.mmgrep.annotation.vtt`,
        checks: [{ name: 'fake-embed', ok: true, detail: `${input.entries.length} entries` }],
      };
    },
  };
}

async function listTemps(dir) {
  return (await readdir(dir)).filter((name) => name.includes('.tmp'));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/** 直接写一份合法的 sidecar（模拟「已经有 sidecar」的状态） */
async function seedSidecar(filePath, media, entries) {
  const sidecarPath = annotationEngine.sidecarPath(filePath);
  await writeFile(sidecarPath, serializeAnnotationSidecar(media, entries));
  return sidecarPath;
}

async function errorOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to reject');
}

function lines(error) {
  return error.message.split('\n');
}

/* ------------------------------------------------------------------ *
 * 首次写入：从 probe.annotationOutline 导入，id 与读侧派生一致
 * ------------------------------------------------------------------ */

test('首次写入：导入 n1…nN（页 → rect.y → rect.x），再按 remove → update → add 应用', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const imported = [
    { page: 3, rect: { x: 0.5, y: 0.1, width: 0.1, height: 0.05 }, type: 'text', note: 'third', author: 'Alice' },
    { page: 1, rect: { x: 0.4, y: 0.2, width: 0.1, height: 0.05 }, type: 'highlight', note: 'first', author: 'Bob', raw: { Subtype: 'Highlight' } },
    { page: 1, rect: { x: 0.1, y: 0.3, width: 0.2, height: 0.1 }, type: 'square', note: 'second', author: 'Carol' },
  ];
  const probe = pdfProbe(imported);
  const embedder = fakeEmbedder('pdf');

  const result = await annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe,
    embedder,
    operations: {
      remove: ['n2'],
      update: [{ id: 'n3', note: 'third (edited)' }],
      add: [{ type: 'text', note: 'new note', page: 4 }, { type: 'square', note: 'new box', page: 5, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
    },
    context: { author: 'Agent' },
  });

  assert.equal(result.created, true);
  assert.equal(result.imported, 3);
  // 派生顺序：页 → rect.y → rect.x；id 与读侧 derive 完全一致
  assert.deepEqual(
    deriveAnnotationsFromOutline('pdf', probe.annotationOutline, { idPrefix: ANNOTATION_ID_PREFIX }).map((entry) => entry.id),
    ['n1', 'n2', 'n3'],
  );
  assert.deepEqual(result.applied, { remove: ['n2'], update: ['n3'], add: ['n4', 'n5'] });
  // n2 被删掉不影响新 id：仍从导入的最大 id 往后接
  assert.deepEqual(result.annotations.entries.map((entry) => entry.id), ['n1', 'n3', 'n4', 'n5']);
  assert.equal(result.annotations.entries[0].author, 'Bob');
  assert.equal(result.annotations.entries[0].type, 'highlight');
  assert.deepEqual(result.annotations.entries[0].raw, { Subtype: 'Highlight' });
  const edited = result.annotations.entries.find((entry) => entry.id === 'n3');
  assert.equal(edited.author, 'Alice', 'update keeps the original author');
  const added = result.annotations.entries.find((entry) => entry.id === 'n4');
  assert.equal(added.author, 'Agent', 'new annotations use the call-level author');
  // 嵌入先于 sidecar：嵌入器看到 sidecar 还不存在
  assert.equal(embedder.calls.length, 1);
  assert.equal(embedder.calls[0].sidecarExisted, false);

  const stored = await readJson(annotationEngine.sidecarPath(ws.pdf));
  assert.equal(stored.version, 1);
  assert.equal(stored.media, 'pdf');
  assert.deepEqual(stored.entries.map((entry) => entry.id), ['n1', 'n3', 'n4', 'n5']);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('已有 sidecar 时不重新导入；被删掉的 max id 不复用', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  await seedSidecar(ws.pdf, 'pdf', [
    { id: 'n1', type: 'text', note: 'one', author: 'Alice', page: 1 },
    { id: 'n2', type: 'text', note: 'two', author: 'Alice', page: 2 },
    { id: 'n3', type: 'text', note: 'three', author: 'Alice', page: 3 },
  ]);
  const embedder = fakeEmbedder('pdf');

  const result = await annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe([{ page: 1, type: 'text', note: 'ignored', author: 'Zoe' }]),
    embedder,
    operations: { remove: ['n3'], add: [{ type: 'text', note: 'four', page: 4 }] },
    context: { author: 'Agent' },
  });

  assert.equal(result.created, false);
  assert.equal(result.imported, 0);
  assert.deepEqual(result.applied, { remove: ['n3'], update: [], add: ['n4'] });
  assert.deepEqual(result.annotations.entries.map((entry) => entry.id), ['n1', 'n2', 'n4']);
});

test('update 保留 id 与 author，只改内容；可以只改位置字段', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  await seedSidecar(ws.pdf, 'pdf', [
    { id: 'n2', type: 'square', note: 'old note', author: 'Alice', page: 2, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
  ]);
  const embedder = fakeEmbedder('pdf');

  const result = await annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe(),
    embedder,
    operations: { update: [{ id: 'n2', note: 'new note', rect: { x: 0.3, y: 0.3, width: 0.1, height: 0.1 } }] },
    context: { author: 'Agent' },
  });

  assert.deepEqual(result.annotations.entries, [{
    id: 'n2',
    type: 'square',
    note: 'new note',
    author: 'Alice',
    page: 2,
    rect: { x: 0.3, y: 0.3, width: 0.1, height: 0.1 },
  }]);

  // 只改 note 时 type / rect / page 都不动
  const again = await annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe(),
    embedder,
    operations: { update: [{ id: 'n2', note: 'only the note' }] },
    context: { author: 'Agent' },
  });
  assert.equal(again.annotations.entries[0].type, 'square');
  assert.deepEqual(again.annotations.entries[0].rect, { x: 0.3, y: 0.3, width: 0.1, height: 0.1 });
});

/* ------------------------------------------------------------------ *
 * 按媒体类型的字段校验：所有错误一次列全，什么都不写
 * ------------------------------------------------------------------ */

test('PDF 校验：type / page / rect / note / 未知字段一次列全，且不写 sidecar、不调嵌入器', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const embedder = fakeEmbedder('pdf');
  const error = await errorOf(annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe([], 8),
    embedder,
    operations: {
      add: [
        { note: 'missing type', page: 1 },
        { type: 'square', note: 'missing rect', page: 2 },
        { type: 'text', note: 'bad page', page: 0 },
        { type: 'text', note: 'page out of range', page: 99 },
        { type: 'text', note: 'unknown field', page: 1, level: 2 },
        { type: 'highlight', note: 'not creatable', page: 1 },
        { type: 'text', note: '   ', page: 1 },
        { type: 'text', note: 'author field', page: 1, author: 'Zoe' },
        { type: 'text', note: 'raw field', page: 1, raw: {} },
        { type: 'square', note: 'bad rect', page: 1, rect: { x: 0.9, y: 0.1, width: 0.2, height: 0.1 } },
        { type: 'text', note: 'x'.repeat(4001), page: 1 },
        { type: 'text', note: 'has id', page: 1, id: 'n9' },
      ],
    },
    context: { author: 'Agent' },
  }));

  assert.equal(error.code, 'INVALID_ARGUMENT');
  const text = lines(error);
  assert.ok(text[0].startsWith('media_annotate refused the request, so nothing was written:'));
  for (const expected of [
    'add[0]: type is required for a PDF annotation ("text" or "square")',
    'add[1]: rect is required for a "square" annotation',
    'add[2]: page must be an integer ≥ 1',
    'add[3]: page 99 is outside 1..8',
    'add[4]: unknown field "level"',
    'add[5]: type must be "text" or "square" (got "highlight")',
    'add[6]: note must not be empty',
    'add[7]: "author" is set by the call-level author argument',
    'add[8]: "raw" is only preserved for annotations imported from the file',
    'add[9]: rect must satisfy 0 <= x, 0 <= y, x + width <= 1, y + height <= 1',
    'add[10]: note must be at most 4000 characters',
    'add[11]: must not include "id"',
  ]) {
    assert.ok(text.some((line) => line.includes(expected)), `missing error: ${expected}\n${error.message}`);
  }
  assert.equal(embedder.calls.length, 0);
  assert.equal(existsSync(annotationEngine.sidecarPath(ws.pdf)), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('视频 / 音频校验：start / end / 时长范围与不适用字段一次列全', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const embedder = fakeEmbedder('video');
  const error = await errorOf(annotationEngine.execute({
    filePath: ws.video,
    media: 'video',
    probe: videoProbe(60),
    embedder,
    operations: {
      add: [
        { note: 'missing start' },
        { note: 'end before start', start: 10, end: 5 },
        { note: 'end past duration', start: 50, end: 61 },
        { note: 'negative start', start: -1 },
        { note: 'start past duration', start: 60 },
        { note: 'type not applicable', start: 1, type: 'text' },
        { note: 'page not applicable', start: 1, page: 2 },
        { note: 'rect not applicable', start: 1, rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
        { note: 'unknown field', start: 1, level: 2 },
      ],
    },
    context: { author: 'Agent' },
  }));

  const text = lines(error);
  for (const expected of [
    'add[0]: start is required for a video/audio annotation',
    'add[1]: end 5s must be greater than start 10s',
    'add[2]: end 61s is outside 0..60s',
    'add[3]: start must be a finite number ≥ 0',
    'add[4]: start 60s must be less than the media duration 60s',
    'add[5]: "type" is not applicable to video annotations',
    'add[6]: "page" is not applicable to video annotations',
    'add[7]: "rect" is not applicable to video annotations',
    'add[8]: unknown field "level"',
  ]) {
    assert.ok(text.some((line) => line.includes(expected)), `missing error: ${expected}\n${error.message}`);
  }
  assert.equal(embedder.calls.length, 0);
  assert.equal(existsSync(annotationEngine.sidecarPath(ws.video)), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('图片校验：page / start / end / type 都不适用；rect 越界一次列全', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const embedder = fakeEmbedder('image');
  const error = await errorOf(annotationEngine.execute({
    filePath: ws.image,
    media: 'image',
    probe: imageProbe(),
    embedder,
    operations: {
      add: [
        { note: 'page', page: 2 },
        { note: 'start', start: 1 },
        { note: 'end', start: 1, end: 2 },
        { note: 'type', type: 'text' },
        { note: 'bad rect', rect: { x: 0.95, y: 0.1, width: 0.2, height: 0.1 } },
        { note: '' },
      ],
    },
    context: { author: 'Agent' },
  }));

  const text = lines(error);
  for (const expected of [
    'add[0]: "page" is not applicable to image annotations',
    'add[1]: "start" is not applicable to image annotations',
    'add[2]: "end" is not applicable to image annotations',
    'add[3]: "type" is not applicable to image annotations',
    'add[4]: rect must satisfy 0 <= x, 0 <= y, x + width <= 1, y + height <= 1',
    'add[5]: note must not be empty',
  ]) {
    assert.ok(text.some((line) => line.includes(expected)), `missing error: ${expected}\n${error.message}`);
  }
  assert.equal(embedder.calls.length, 0);
  assert.equal(existsSync(annotationEngine.sidecarPath(ws.image)), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('remove / update / add 的错误一起报：未知 id、重复 id、update 改 author、add 带 id', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const sidecarPath = await seedSidecar(ws.pdf, 'pdf', [
    { id: 'n1', type: 'text', note: 'one', author: 'Alice', page: 1 },
  ]);
  const before = await readFile(sidecarPath, 'utf8');
  const embedder = fakeEmbedder('pdf');
  const error = await errorOf(annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe(),
    embedder,
    operations: {
      remove: ['n1', 'n1'],
      update: [{ id: 'n8', note: 'x' }, { id: 'n1', author: 'Zoe' }],
      add: [{ type: 'text', note: 'ok', page: 1 }, { id: 'n1', type: 'text', note: 'bad', page: 1 }],
    },
    context: { author: 'Agent' },
  }));

  const text = lines(error);
  for (const expected of [
    'remove[1]: duplicate id "n1"',
    'update[0]: unknown id "n8"',
    'update[1]: id "n1" is also in remove',
    'add[1]: must not include "id"',
  ]) {
    assert.ok(text.some((line) => line.includes(expected)), `missing error: ${expected}\n${error.message}`);
  }
  assert.equal(embedder.calls.length, 0);
  assert.equal(await readFile(sidecarPath, 'utf8'), before);
});

/* ------------------------------------------------------------------ *
 * 视频：缺省 end = start + 5 s，截到时长
 * ------------------------------------------------------------------ */

test('视频：end 缺省 = start + 5 s；接近结尾时截到时长；跨媒体类型参数照常工作', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const embedder = fakeEmbedder('video');
  const result = await annotationEngine.execute({
    filePath: ws.video,
    media: 'video',
    probe: videoProbe(60),
    embedder,
    operations: {
      add: [
        { note: 'middle', start: 12 },
        { note: 'tail', start: 58 },
        { note: 'explicit', start: 20, end: 25 },
      ],
    },
    context: { author: 'Agent' },
  });

  const byNote = Object.fromEntries(result.annotations.entries.map((entry) => [entry.note, entry]));
  assert.equal(byNote.middle.start, 12);
  assert.equal(byNote.middle.end, 17);
  assert.equal(byNote.tail.start, 58);
  assert.equal(byNote.tail.end, 60, 'default end is clipped to the duration');
  assert.equal(byNote.explicit.end, 25);
  // 读侧行格式：00:12:34–00:12:39
  assert.equal(formatAnnotation(byNote.middle, { media: 'video' }), 'n1 (00:00:12–00:00:17): middle');
  // 排序按 start，id 与位置无关
  assert.deepEqual(result.annotations.entries.map((entry) => entry.id), ['n1', 'n3', 'n2']);
  assert.deepEqual(await listTemps(ws.dir), []);
});

/* ------------------------------------------------------------------ *
 * 损坏的 sidecar：报错并给路径，绝不覆盖
 * ------------------------------------------------------------------ */

test('损坏的 sidecar：报错带路径与全部细节，字节原样保留、不调嵌入器', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const sidecarPath = annotationEngine.sidecarPath(ws.pdf);
  const corrupt = '{"version":1,"media":"pdf","entries":[{ "id": "x1", "note": "" }]}';
  await writeFile(sidecarPath, corrupt);
  const embedder = fakeEmbedder('pdf');

  const error = await errorOf(annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe(),
    embedder,
    operations: { add: [{ type: 'text', note: 'valid', page: 1 }] },
    context: { author: 'Agent' },
  }));

  assert.equal(error.code, 'INVALID_ARGUMENT');
  assert.match(error.message, /the annotation sidecar .* is corrupted, so nothing was written:/);
  assert.match(error.message, /entries\[0\]: id "x1" is not a valid annotation id/);
  assert.match(error.hint, /then call media_annotate again/);
  assert.equal(await readFile(sidecarPath, 'utf8'), corrupt);
  assert.equal(embedder.calls.length, 0);
  assert.deepEqual(await listTemps(ws.dir), []);
});

/* ------------------------------------------------------------------ *
 * 嵌入失败 / 检查项失败：sidecar 不变、无临时文件
 * ------------------------------------------------------------------ */

test('嵌入器抛错：sidecar 字节不变、无临时文件；首次写入也不产生 sidecar', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const before = serializeAnnotationSidecar('pdf', [
    { id: 'n1', type: 'text', note: 'one', author: 'Alice', page: 1 },
  ]);
  const sidecarPath = await seedSidecar(ws.pdf, 'pdf', [
    { id: 'n1', type: 'text', note: 'one', author: 'Alice', page: 1 },
  ]);
  assert.equal(await readFile(sidecarPath, 'utf8'), before);

  const embedder = fakeEmbedder('pdf', { error: new ToolError('INTERNAL', 'mutool exploded') });
  const error = await errorOf(annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe(),
    embedder,
    operations: { add: [{ type: 'text', note: 'two', page: 2 }] },
    context: { author: 'Agent' },
  }));
  assert.equal(error.message, 'mutool exploded');
  assert.equal(await readFile(sidecarPath, 'utf8'), before);
  assert.deepEqual(await listTemps(ws.dir), []);

  // 首次写入：嵌入失败 → 连 sidecar 都不存在
  const fresh = path.join(ws.dir, 'fresh.pdf');
  await writeFile(fresh, PDF_BYTES);
  const error2 = await errorOf(annotationEngine.execute({
    filePath: fresh,
    media: 'pdf',
    probe: pdfProbe(),
    embedder: fakeEmbedder('pdf', { error: new ToolError('INTERNAL', 'mutool exploded') }),
    operations: { add: [{ type: 'text', note: 'x', page: 1 }] },
    context: { author: 'Agent' },
  }));
  assert.equal(error2.code, 'INTERNAL');
  assert.equal(existsSync(annotationEngine.sidecarPath(fresh)), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('嵌入检查项失败：报出失败检查，sidecar 不变、无临时文件', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const sidecarPath = await seedSidecar(ws.video, 'video', [
    { id: 'n1', note: 'one', author: 'Alice', start: 1, end: 6 },
  ]);
  const before = await readFile(sidecarPath, 'utf8');

  const embedder = fakeEmbedder('video', {
    result: { target: `${ws.video}.mmgrep.annotation.vtt`, checks: [{ name: 'vtt-readback', ok: false, detail: 'cue count 0 != 1' }] },
  });
  const error = await errorOf(annotationEngine.execute({
    filePath: ws.video,
    media: 'video',
    probe: videoProbe(),
    embedder,
    operations: { add: [{ note: 'two', start: 10 }] },
    context: { author: 'Agent' },
  }));

  assert.equal(error.code, 'INTERNAL');
  assert.match(error.message, /check "vtt-readback" failed: cue count 0 != 1/);
  assert.equal(await readFile(sidecarPath, 'utf8'), before);
  assert.deepEqual(await listTemps(ws.dir), []);
});

/* ------------------------------------------------------------------ *
 * 只写 sidecar：图片 / 显式 null 注册表
 * ------------------------------------------------------------------ */

test('图片：没有嵌入器，只写 sidecar（嵌入目标 null，检查项说明原因）', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  // 不传 embedder：图片在默认注册表里没有嵌入器 → 只写 sidecar
  const result = await annotationEngine.execute({
    filePath: ws.image,
    media: 'image',
    probe: imageProbe(),
    operations: { add: [{ note: 'cover note', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }] },
    context: { author: 'Agent' },
  });

  assert.equal(result.embed.target, null);
  assert.match(result.checks[0].detail, /image: no native annotation surface; the sidecar is the only store/);
  assert.equal(result.annotations.entries[0].author, 'Agent');
  assert.deepEqual(result.annotations.entries[0].rect, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
});

test('embedder: null 明确只写 sidecar（不嵌入、不报错）', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const result = await annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe(),
    embedder: null,
    operations: { add: [{ type: 'text', note: 'sidecar only', page: 1 }] },
    context: { author: 'Agent' },
  });
  assert.equal(result.embed.target, null);
  assert.match(result.checks[0].detail, /no embedder registered for "pdf"/);
  assert.equal(existsSync(annotationEngine.sidecarPath(ws.pdf)), true);
});

/* ------------------------------------------------------------------ *
 * 默认嵌入器是 9z5.38.2 / 9z5.38.3 的占位：TOOL_NOT_FOUND 且什么都不写
 * ------------------------------------------------------------------ */

test('默认 PDF 嵌入器（占位）：TOOL_NOT_FOUND，不写 sidecar、无临时文件', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const error = await errorOf(annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe(),
    operations: { add: [{ type: 'text', note: 'x', page: 1 }] },
    context: { author: 'Agent' },
  }));
  assert.equal(error.code, 'TOOL_NOT_FOUND');
  assert.match(error.message, /MultiMediaGrep-9z5\.38\.2/);
  assert.equal(existsSync(annotationEngine.sidecarPath(ws.pdf)), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

test('默认 VTT 嵌入器（占位）：TOOL_NOT_FOUND，不写 sidecar 也不写 VTT', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const error = await errorOf(annotationEngine.execute({
    filePath: ws.video,
    media: 'video',
    probe: videoProbe(),
    operations: { add: [{ note: 'x', start: 1 }] },
    context: { author: 'Agent' },
  }));
  assert.equal(error.code, 'TOOL_NOT_FOUND');
  assert.match(error.message, /MultiMediaGrep-9z5\.38\.3/);
  assert.equal(existsSync(annotationEngine.sidecarPath(ws.video)), false);
  assert.equal(existsSync(`${ws.video}.mmgrep.annotation.vtt`), false);
  assert.deepEqual(await listTemps(ws.dir), []);
});

/* ------------------------------------------------------------------ *
 * 导入保留 raw / 不可新建类型；读侧派生与 sidecar 一致
 * ------------------------------------------------------------------ */

test('导入的 raw 几何与不可新建类型原样保留；改 note 后仍可读回', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  const probe = pdfProbe([
    { page: 2, rect: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 }, type: 'underline', note: 'imported underline', author: 'Alice', raw: { Subtype: 'Underline', QuadPoints: [1, 2, 3, 4] } },
  ]);
  const embedder = fakeEmbedder('pdf');

  const first = await annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe,
    embedder,
    operations: { add: [{ type: 'text', note: 'agent note', page: 3 }] },
    context: { author: 'Agent' },
  });
  assert.equal(first.imported, 1);
  assert.deepEqual(first.annotations.entries[0].raw, { Subtype: 'Underline', QuadPoints: [1, 2, 3, 4] });

  const second = await annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe,
    embedder,
    operations: { update: [{ id: 'n1', note: 'edited underline' }] },
    context: { author: 'Agent' },
  });
  assert.equal(second.created, false);
  assert.equal(second.imported, 0);
  const underline = second.annotations.entries.find((entry) => entry.id === 'n1');
  assert.equal(underline.type, 'underline');
  assert.equal(underline.note, 'edited underline');
  assert.deepEqual(underline.raw, { Subtype: 'Underline', QuadPoints: [1, 2, 3, 4] });
  assert.equal(underline.author, 'Alice');

  const readBack = await readAnnotationSidecar(annotationEngine.sidecarPath(ws.pdf), { media: 'pdf' });
  assert.deepEqual(readBack.entries, second.annotations.entries);
});

test('读侧派生：没有 annotationOutline 时为空；按页 → rect.y → rect.x 编号，与只读工具一致', () => {
  assert.deepEqual(deriveAnnotationEntriesFromProbe('pdf', { pageCount: 3 }), []);
  assert.deepEqual(deriveAnnotationsFromOutline('pdf', null), []);
  assert.deepEqual(deriveAnnotationsFromOutline('video', { entries: [{ startSec: 1 }] }), []);
  assert.deepEqual(deriveAnnotationsFromOutline('image', { entries: [{ page: 1 }] }), []);

  const derived = deriveAnnotationsFromOutline('pdf', {
    entries: [
      { page: 2, rect: { x: 0.1, y: 0.5, width: 0.1, height: 0.1 }, note: 'b', type: 'text', author: 'A' },
      { page: 1, rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 }, note: 'd', type: 'text', author: 'A' },
      { page: 1, rect: { x: 0.1, y: 0.5, width: 0.1, height: 0.1 }, note: 'c', type: 'text', author: 'A' },
    ],
  });
  assert.deepEqual(derived.map((entry) => entry.note), ['c', 'd', 'b']);
  assert.deepEqual(derived.map((entry) => entry.id), ['n1', 'n2', 'n3']);
});

/* ------------------------------------------------------------------ *
 * 源目录不可写：明确报错、不回退、无临时文件残留
 * ------------------------------------------------------------------ */

test('源目录不可写：明确报错、不回退、不留下半截文件', { skip: process.getuid?.() === 0 }, async (t) => {
  const ws = await makeWorkspace();
  t.after(async () => {
    await chmod(ws.dir, 0o700).catch(() => {});
    await ws.cleanup();
  });
  const embedder = fakeEmbedder('pdf');
  await chmod(ws.dir, 0o500);

  const error = await errorOf(annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe(),
    embedder,
    operations: { add: [{ type: 'text', note: 'x', page: 1 }] },
    context: { author: 'Agent' },
  }));

  assert.equal(error.code, 'INTERNAL');
  assert.match(error.message, /cannot write/);
  assert.match(error.hint, /no fallback location/);
  assert.match(error.message, /Note: the embedding step already completed/);
  assert.equal(embedder.calls.length, 1);
});

/* ------------------------------------------------------------------ *
 * 操作信封本身：空操作 / 未知操作 / sidecar 路径
 * ------------------------------------------------------------------ */

test('参数信封：空操作与未知操作被拒绝；sidecar 路径固定为 <file>.mmgrep.annotation.json', async (t) => {
  const ws = await makeWorkspace();
  t.after(ws.cleanup);

  assert.equal(annotationEngine.sidecarPath(ws.pdf), `${ws.pdf}.mmgrep.annotation.json`);

  const empty = await errorOf(annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe(),
    embedder: null,
    operations: {},
    context: { author: 'Agent' },
  }));
  assert.equal(empty.code, 'INVALID_ARGUMENT');
  assert.match(empty.message, /at least one operation/);

  const unknown = await errorOf(annotationEngine.execute({
    filePath: ws.pdf,
    media: 'pdf',
    probe: pdfProbe(),
    embedder: null,
    operations: { rename: [] },
    context: { author: 'Agent' },
  }));
  assert.match(unknown.message, /unknown operation "rename"/);
});
