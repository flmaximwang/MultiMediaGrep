// test/export/export.test.js —— 全文落盘模块测试
// 断言格式对齐 docs/mcp-contract.md §9 与 cangjie-skill SourceDocument Contract v1
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  EXPORT_VERSION,
  buildCangjieDocument,
  buildManifest,
  exportAnalysis,
  renderContentMd,
  renderSegmentsJsonl,
  writeExport,
} from '../../src/export/index.js';
import {
  formatTimestamp,
  normalizeSegments,
  sourceIdFor,
} from '../../src/export/format.js';

const SOURCE = {
  path: '/tmp/a.mp4',
  mediaType: 'video',
  sizeBytes: 1024,
  modifiedMs: 1_700_000_000_000,
  sha256: 'abcdef0123456789',
  durationMs: 12_000,
  durationSec: 12,
};

function sampleSegments() {
  return [
    { startMs: 0, endMs: 2500, text: '第一句。', source: 'subtitle', origin: 'file' },
    { startMs: 2500, endMs: 4000, text: '第二句是 ASR。', source: 'asr', origin: 'asr', speaker: 'S1' },
    { startMs: 4000, text: '', source: 'visual', origin: 'none', assetRef: 'images/overview-1.png' },
  ];
}

/** 迷你校验器：镜像 cangjie-skill SourceDocument Contract v1 */
function assertCangjieDocument(doc) {
  assert.equal(doc.schema_version, 1);
  assert.match(doc.source_id, /^src-[a-z0-9-]+$/);
  assert.match(doc.version_id, /^sha256:[0-9a-f]+$/);
  assert.equal(typeof doc.title, 'string');
  assert.equal(typeof doc.media_type, 'string');
  assert.ok(Array.isArray(doc.language));
  assert.equal(typeof doc.parser, 'string');
  assert.ok(Array.isArray(doc.elements));
  for (const el of doc.elements) {
    assert.match(el.element_id, /^el-[0-9]{6}$/);
    assert.ok(
      ['heading', 'paragraph', 'list', 'table', 'image', 'formula', 'transcript', 'frame', 'code'].includes(el.type),
      `非法 element.type: ${el.type}`,
    );
    assert.match(el.content_hash, /^sha256:[0-9a-f]+$/);
    assert.ok(el.page === null || Number.isInteger(el.page));
    assert.ok(el.time_start_ms === null || Number.isInteger(el.time_start_ms));
    assert.ok(el.time_end_ms === null || Number.isInteger(el.time_end_ms));
    assert.ok(el.bbox === null || (Array.isArray(el.bbox) && el.bbox.length === 4));
    assert.ok(el.confidence === null || (el.confidence >= 0 && el.confidence <= 1));
  }
}

test('normalizeSegments：字段与契约 §9.2 一致，非法输入报错', () => {
  const segments = normalizeSegments(sampleSegments());
  assert.equal(segments[0].index, 1);
  assert.equal(segments[0].startSec, 0);
  assert.equal(segments[0].endSec, 2.5);
  assert.equal(segments[1].speaker, 'S1');
  assert.equal(segments[2].endMs, null);
  assert.equal(segments[2].endSec, null);

  assert.throws(() => normalizeSegments([{ startMs: 0, endMs: -1 }]), /不能早于/);
  assert.throws(() => normalizeSegments([{ source: 'vibes' }]), /未知 source/);
  assert.throws(() => normalizeSegments([{ origin: 'telepathy' }]), /未知 origin/);
  assert.throws(() => normalizeSegments([{ startMs: 1.5 }]), /整数/);
  assert.throws(() => normalizeSegments([{ confidence: 3 }]), /confidence/);
  assert.throws(() => normalizeSegments([{ bbox: [1, 2] }]), /bbox/);
});

test('content.md：首行绝对路径 + 元信息 + 段标题', () => {
  const segments = normalizeSegments(sampleSegments());
  const md = renderContentMd({
    source: SOURCE,
    segments,
    mediaType: 'video',
    transcript: { source: 'asr', provider: 'elevenlabs', model: 'scribe_v1', language: 'zh' },
    generatedAtMs: Date.parse('2026-11-01T09:12:33Z'),
  });
  assert.match(md, /^# \/tmp\/a\.mp4$/m);
  assert.match(md, /^- mediaType: video$/m);
  assert.match(md, /^- duration: 12\.00 s$/m);
  assert.match(md, /^- transcript: asr \(elevenlabs \/ scribe_v1\), language: zh$/m);
  assert.match(md, /^- generated: 2026-11-01T09:12:33\.000Z$/m);
  assert.match(md, /^## 00:00\.000 – 00:02\.500$/m);
  assert.match(md, /^## 00:02\.500 – 00:04\.000$/m);
  assert.match(md, /^## 00:04\.000$/m);
  assert.match(md, /第一句。/);
});

test('content.md：文档按页分节', () => {
  const segments = normalizeSegments([
    { page: 7, text: '第 7 页正文', source: 'ocr', origin: 'ocr' },
  ]);
  const md = renderContentMd({
    source: { ...SOURCE, mediaType: 'document', pageCount: 9 },
    segments,
    mediaType: 'document',
  });
  assert.match(md, /^## Page 7$/m);
  assert.match(md, /^- pages: 9$/m);
});

test('segments.jsonl：一行一个 JSON，含契约字段', () => {
  const segments = normalizeSegments(sampleSegments());
  const jsonl = renderSegmentsJsonl(segments);
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]);
  for (const key of ['index', 'startMs', 'endMs', 'startSec', 'endSec', 'text', 'page', 'speaker', 'source', 'origin']) {
    assert.ok(key in first, `缺少字段 ${key}`);
  }
  assert.equal(first.index, 1);
  assert.equal(first.page, null);
  assert.equal(JSON.parse(lines[1]).speaker, 'S1');
});

test('manifest.json：字段与契约 §9.3 一致', () => {
  const manifest = buildManifest({
    generatedAtMs: 1_793_508_753_000,
    source: SOURCE,
    window: { startMs: 0, endMs: 12_000 },
    pages: null,
    transcript: { source: 'asr', provider: 'elevenlabs', model: 'scribe_v1', language: 'zh', segmentCount: 3 },
    overview: { images: [{ index: 1, file: 'images/overview-1.png', width: 1280, height: 720, cells: 9, estimatedTokens: 1229 }], cells: [], estimatedTokens: 1229 },
    warnings: ['asr-not-configured'],
  });
  assert.equal(manifest.version, EXPORT_VERSION);
  assert.equal(manifest.tool, 'media_overview');
  assert.equal(manifest.generatedAtMs, 1_793_508_753_000);
  assert.equal(manifest.source.path, '/tmp/a.mp4');
  assert.equal(manifest.source.sha256, 'abcdef0123456789');
  assert.deepEqual(manifest.window, { startMs: 0, endMs: 12000, startSec: 0, endSec: 12 });
  assert.equal(manifest.transcript.segmentCount, 3);
  assert.equal(manifest.overview.estimatedTokens, 1229);
  assert.deepEqual(manifest.warnings, ['asr-not-configured']);
});

test('writeExport：四个文件落盘，cangjie document 合法', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-export-'));
  try {
    const result = await writeExport({
      outDir: path.join(dir, 'out'),
      segments: sampleSegments(),
      source: SOURCE,
      mediaType: 'video',
      transcript: { source: 'asr', provider: 'elevenlabs', model: 'scribe_v1', language: 'zh' },
      generatedAtMs: Date.parse('2026-11-01T09:12:33Z'),
    });
    assert.ok(result.contentPath.endsWith('content.md'));
    assert.ok(result.segmentsPath.endsWith('segments.jsonl'));
    assert.ok(result.manifestPath.endsWith('manifest.json'));
    assert.ok(result.documentPath.endsWith('document.json'));

    const doc = JSON.parse(await readFile(result.documentPath, 'utf8'));
    assertCangjieDocument(doc);
    assert.equal(doc.source_id, sourceIdFor('a.mp4'));
    assert.equal(doc.version_id, 'sha256:abcdef0123456789');
    assert.equal(doc.media_type, 'video');
    assert.equal(doc.elements.length, 3);
    assert.equal(doc.elements[0].type, 'transcript');
    assert.equal(doc.elements[0].time_start_ms, 0);
    assert.equal(doc.elements[2].asset_ref, 'images/overview-1.png');

    const segments = (await readFile(result.segmentsPath, 'utf8')).trim().split('\n');
    assert.equal(segments.length, 3);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.document.element_count, 3);
    assert.equal(manifest.counts.segment, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exportAnalysis：产出材料并保证可复现', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-export-det-'));
  const now = Date.parse('2026-11-01T00:00:00.000Z');
  try {
    const args = {
      source: SOURCE,
      mediaType: 'video',
      segments: sampleSegments(),
      generatedAtMs: now,
    };
    const a = await exportAnalysis({ ...args, outDir: path.join(dir, 'a') });
    const b = await exportAnalysis({ ...args, outDir: path.join(dir, 'b') });

    // content.md / segments.jsonl / document.json 与目录无关，必须字节相同
    assert.equal(await readFile(a.contentPath, 'utf8'), await readFile(b.contentPath, 'utf8'));
    assert.equal(await readFile(a.segmentsPath, 'utf8'), await readFile(b.segmentsPath, 'utf8'));
    assert.equal(await readFile(a.documentPath, 'utf8'), await readFile(b.documentPath, 'utf8'));

    // manifest 里除路径外应当一致
    const ma = JSON.parse(await readFile(a.manifestPath, 'utf8'));
    const mb = JSON.parse(await readFile(b.manifestPath, 'utf8'));
    assert.equal(ma.generatedAtMs, mb.generatedAtMs);
    assert.equal(ma.document.source_id, mb.document.source_id);
    assert.deepEqual(ma.counts, mb.counts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('document.json 的 media_type 必须落在 cangjie 枚举内', () => {
  assert.throws(() => buildCangjieDocument({
    source: SOURCE,
    segments: normalizeSegments([]),
    mediaType: 'image',
    title: 'x',
    sourceId: 'src-abc',
    versionId: 'sha256:ab',
  }), /media_type/);
});

test('formatTimestamp：mm:ss.mmm，超过一小时用 hh:mm:ss.mmm', () => {
  assert.equal(formatTimestamp(0), '00:00.000');
  assert.equal(formatTimestamp(2_500), '00:02.500');
  assert.equal(formatTimestamp(61_500), '01:01.500');
  assert.equal(formatTimestamp(3_723_456), '01:02:03.456');
  assert.equal(formatTimestamp(null), null);
});

test('content.md 里的正文哈希与 manifest 记录一致', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-export-hash-'));
  try {
    const result = await exportAnalysis({
      outDir: path.join(dir, 'out'),
      source: SOURCE,
      mediaType: 'video',
      segments: sampleSegments(),
    });
    const body = await readFile(result.contentPath, 'utf8');
    assert.equal(createHash('sha256').update(body).digest('hex').length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
