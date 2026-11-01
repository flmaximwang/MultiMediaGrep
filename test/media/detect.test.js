// test/media/detect.test.js —— 媒体类型判定测试
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { detectMediaType, extOf, isSubtitlePath, sniffMagic } from '../../src/media/detect.js';

async function withFiles(files, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mmgrep-detect-'));
  try {
    const paths = {};
    for (const [name, body] of Object.entries(files)) {
      const p = path.join(dir, name);
      await writeFile(p, body);
      paths[name] = p;
    }
    return await fn(paths, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(8)]);

test('extOf / isSubtitlePath', () => {
  assert.equal(extOf('/a/b/c.MP4'), '.mp4');
  assert.equal(extOf('/a/b/noext'), '');
  assert.equal(extOf('/a.b/c'), '');
  assert.equal(isSubtitlePath('/x/a.srt'), true);
  assert.equal(isSubtitlePath('/x/a.vtt'), true);
  assert.equal(isSubtitlePath('/x/a.mp4'), false);
});

test('sniffMagic：认得常见容器与文档格式', () => {
  assert.equal(sniffMagic(MP4), 'mp4');
  assert.equal(sniffMagic(MP3), 'mp3');
  assert.equal(sniffMagic(PDF), 'pdf');
  assert.equal(sniffMagic(PNG), 'png');
  assert.equal(sniffMagic(WAV), 'wav');
  assert.equal(sniffMagic(Buffer.alloc(0)), null);
  assert.equal(sniffMagic(Buffer.from('not a media file at all')), null);
});

test('detectMediaType：Office 文档归到 document（让后端给出转 PDF 的提示）', async () => {
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  await withFiles({
    'a.docx': ZIP,
    'b.pptx': ZIP,
    'c.xlsx': ZIP,
  }, async (paths) => {
    for (const name of ['a.docx', 'b.pptx', 'c.xlsx']) {
      const result = await detectMediaType(paths[name]);
      assert.equal(result.mediaType, 'document', name);
    }
  });
});

test('detectMediaType：魔数优先于扩展名', async () => {
  await withFiles({
    'movie.mp4': MP4,
    'song.mp3': MP3,
    'paper.pdf': PDF,
    'shot.png': PNG,
    'voice.wav': WAV,
    // 扩展名骗人：其实是 PDF
    'lying.mp4': PDF,
  }, async (paths) => {
    assert.equal((await detectMediaType(paths['movie.mp4'])).mediaType, 'video');
    assert.equal((await detectMediaType(paths['song.mp3'])).mediaType, 'audio');
    assert.equal((await detectMediaType(paths['paper.pdf'])).mediaType, 'document');
    assert.equal((await detectMediaType(paths['shot.png'])).mediaType, 'document');
    assert.equal((await detectMediaType(paths['voice.wav'])).mediaType, 'audio');
    const lying = await detectMediaType(paths['lying.mp4']);
    assert.equal(lying.mediaType, 'document');
    assert.match(lying.detectedBy, /^magic:/);
  });
});

test('detectMediaType：魔数认不出时退回扩展名', async () => {
  await withFiles({
    'clip.mkv': Buffer.from('not really matroska'),
    'note.txt': Buffer.from('hello'),
    'thing.bin': Buffer.from('random'),
  }, async (paths) => {
    assert.equal((await detectMediaType(paths['clip.mkv'])).mediaType, 'video');
    assert.equal((await detectMediaType(paths['note.txt'])).mediaType, 'document');
    await assert.rejects(() => detectMediaType(paths['thing.bin']), /不支持的文件类型/);
  });
});

test('detectMediaType：文件不存在时不抛类型错误（探测失败由调用方处理）', async () => {
  const result = await detectMediaType('/definitely/not/here.mp4');
  assert.equal(result.mediaType, 'video');
  assert.match(result.detectedBy, /^extension:/);
});
