/**
 * 缓存模块的单元测试。
 *
 * 所有缓存目录都建在系统临时目录（os.tmpdir()）里，跑完清理：
 * **绝不碰真实缓存目录 `~/.cache/multimediagrep`，也绝不往仓库里写文件。**
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createCache, resolveCacheConfig, DEFAULT_MAX_BYTES } from '../../src/cache/index.js';
import { contentKey, hashBuffer, hashFile, fingerprintFor } from '../../src/cache/hash.js';

/** 当前测试文件路径（用来测「putFile 的 key 校验」，不会真去读它） */
const THIS_FILE = fileURLToPath(import.meta.url);

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

/**
 * 递归列出目录下的所有文件（相对路径）。
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFiles(dir) {
  const out = [];
  let names;
  try {
    names = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of names) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('cache: 基本读写', () => {
  let dir;
  let cache;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    cache = createCache({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('put 落盘并返回绝对路径，get 读回同样的内容', async () => {
    const key = contentKey({ sha256: HEX_A });
    const target = await cache.put(key, 'hello 缓存');

    assert.ok(path.isAbsolute(target));
    assert.equal(target, cache.getPath(key));
    assert.ok((await fs.stat(target)).isFile());

    const data = await cache.get(key);
    assert.ok(Buffer.isBuffer(data));
    assert.equal(data.toString('utf8'), 'hello 缓存');
  });

  test('get 不存在时返回 null', async () => {
    assert.equal(await cache.get(contentKey({ sha256: HEX_B })), null);
    assert.equal(await cache.has(contentKey({ sha256: HEX_B })), false);
  });

  test('has 对存在的条目返回 true', async () => {
    const key = contentKey({ sha256: HEX_A });
    await cache.put(key, Buffer.from([1, 2, 3]));
    assert.equal(await cache.has(key), true);
  });

  test('put 接受 Buffer / Uint8Array / string', async () => {
    const bytes = Buffer.from([9, 8, 7]);
    await cache.put(contentKey({ sha256: HEX_A }), bytes);
    await cache.put(contentKey({ sha256: HEX_B }), new Uint8Array([1, 2]));
    await cache.put(contentKey({ sha256: HEX_C }), '文本');

    assert.deepEqual(await cache.get(contentKey({ sha256: HEX_A })), bytes);
    assert.deepEqual(await cache.get(contentKey({ sha256: HEX_B })), Buffer.from([1, 2]));
    assert.equal((await cache.get(contentKey({ sha256: HEX_C }))).toString('utf8'), '文本');
  });

  test('同一个 key 重复 put 会覆盖', async () => {
    const key = contentKey({ sha256: HEX_A });
    await cache.put(key, '第一次');
    await cache.put(key, '第二次');
    assert.equal((await cache.get(key)).toString('utf8'), '第二次');
  });

  test('不同 variant 是不同条目', async () => {
    const base = contentKey({ sha256: HEX_A });
    const variant = contentKey({ sha256: HEX_A, variant: 'grid-4x3' });
    assert.notEqual(cache.getPath(base), cache.getPath(variant));

    await cache.put(base, 'a');
    await cache.put(variant, 'b');
    assert.equal((await cache.get(base)).toString('utf8'), 'a');
    assert.equal((await cache.get(variant)).toString('utf8'), 'b');
  });

  test('getPath 只算路径，不创建文件', async () => {
    const key = contentKey({ sha256: HEX_A });
    const target = cache.getPath(key);
    assert.ok(path.isAbsolute(target));
    await assert.rejects(() => fs.stat(target), (err) => err.code === 'ENOENT');
  });

  test('目录结构是 <dir>/<2 位分片>/<条目名>', async () => {
    const key = contentKey({ sha256: HEX_A });
    const target = await cache.put(key, 'x');
    const relative = path.relative(dir, target);
    const parts = relative.split(path.sep);
    assert.equal(parts.length, 2);
    assert.match(parts[0], /^[0-9a-f]{2}$/);
    assert.match(parts[1], /^[0-9a-f]{62}$/);
  });
});

describe('cache: key 校验与路径穿越防护', () => {
  let dir;
  let cache;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    cache = createCache({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const badKeys = ['../evil', '../../etc/passwd', 'a/b', '/abs/path', 'a b', '', '.', '..'];

  test('getPath 拒绝非法 key', () => {
    for (const key of badKeys) {
      assert.throws(() => cache.getPath(key), (err) => {
        assert.equal(err.code, 'ERR_CACHE_INVALID_KEY');
        return true;
      }, `key "${key}" 应该被拒绝`);
    }
  });

  test('put / get / has / putFile / touch 都拒绝非法 key', async () => {
    for (const key of badKeys) {
      await assert.rejects(() => cache.put(key, 'x'), /非法缓存 key/);
      await assert.rejects(() => cache.get(key), /非法缓存 key/);
      await assert.rejects(() => cache.has(key), /非法缓存 key/);
      await assert.rejects(() => cache.touch(key), /非法缓存 key/);
      await assert.rejects(() => cache.putFile(key, THIS_FILE), /非法缓存 key/);
    }
  });

  test('路径穿越不会写到缓存目录外面', async () => {
    await assert.rejects(() => cache.put('../escape.txt', 'boom'), /非法缓存 key/);
    const escaped = path.resolve(dir, '..', 'escape.txt');
    await assert.rejects(() => fs.stat(escaped), (err) => err.code === 'ENOENT');
  });
});

describe('cache: 原子写与临时文件', () => {
  let dir;
  let cache;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    cache = createCache({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('put 之后不留 .tmp- 残留', async () => {
    await cache.put(contentKey({ sha256: HEX_A }), 'data');
    await cache.put(contentKey({ sha256: HEX_B }), 'data2');

    const files = await listFiles(dir);
    const temps = files.filter((file) => path.basename(file).startsWith('.tmp-'));
    assert.deepEqual(temps, []);
  });

  test('putFile 之后不留 .tmp- 残留', async () => {
    const src = path.join(dir, '..', `src-${process.pid}.bin`);
    await fs.writeFile(src, '源文件内容');
    try {
      await cache.putFile(contentKey({ sha256: HEX_A }), src);
    } finally {
      await fs.rm(src, { force: true });
    }
    const files = await listFiles(dir);
    assert.deepEqual(files.filter((f) => path.basename(f).startsWith('.tmp-')), []);
  });

  test('sweep 清掉崩溃遗留的陈旧临时文件，但不动新的', async () => {
    const shard = path.join(dir, 'ab');
    await fs.mkdir(shard, { recursive: true });

    const stale = path.join(shard, '.tmp-9999-abcdef');
    const fresh = path.join(shard, '.tmp-9999-fedcba');
    await fs.writeFile(stale, 'x'.repeat(10));
    await fs.writeFile(fresh, 'y'.repeat(10));

    // 把 stale 的 mtime 改到 2 小时前（超过 STALE_TEMP_MS）
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old);

    await cache.sweep();

    await assert.rejects(() => fs.stat(stale), (err) => err.code === 'ENOENT');
    const stat = await fs.stat(fresh);
    assert.ok(stat.isFile());
  });
});

describe('cache: LRU 淘汰与容量上限', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('超过上限时淘汰最久未使用的条目', async () => {
    const cache = createCache({ dir, maxBytes: 250 });
    const keyA = contentKey({ sha256: HEX_A });
    const keyB = contentKey({ sha256: HEX_B });
    const keyC = contentKey({ sha256: HEX_C });

    await cache.put(keyA, 'a'.repeat(100));
    await cache.put(keyB, 'b'.repeat(100));
    await cache.put(keyC, 'c'.repeat(100));

    // 300 > 250 → 淘汰最旧的 A
    assert.equal(await cache.has(keyA), false);
    assert.equal(await cache.has(keyB), true);
    assert.equal(await cache.has(keyC), true);

    const stats = await cache.stats();
    assert.equal(stats.entries, 2);
    assert.equal(stats.bytes, 200);
  });

  test('读命中会把条目变「新鲜」，不会先被淘汰', async () => {
    const cache = createCache({ dir, maxBytes: 250 });
    const keyA = contentKey({ sha256: HEX_A });
    const keyB = contentKey({ sha256: HEX_B });
    const keyC = contentKey({ sha256: HEX_C });

    await cache.put(keyA, 'a'.repeat(100));
    await cache.put(keyB, 'b'.repeat(100));
    // 读一下 A，让它变成最新使用的
    await cache.get(keyA);
    await cache.put(keyC, 'c'.repeat(100));

    // B 最久未用 → 被淘汰；A 因为刚被读过而留下
    assert.equal(await cache.has(keyB), false);
    assert.equal(await cache.has(keyA), true);
    assert.equal(await cache.has(keyC), true);
  });

  test('touch 也能刷新使用时间', async () => {
    const cache = createCache({ dir, maxBytes: 250 });
    const keyA = contentKey({ sha256: HEX_A });
    const keyB = contentKey({ sha256: HEX_B });
    const keyC = contentKey({ sha256: HEX_C });

    await cache.put(keyA, 'a'.repeat(100));
    await cache.put(keyB, 'b'.repeat(100));
    assert.equal(await cache.touch(keyA), true);
    await cache.put(keyC, 'c'.repeat(100));

    assert.equal(await cache.has(keyB), false);
    assert.equal(await cache.has(keyA), true);
  });

  test('显式 sweep 会按 LRU 回收并报告释放的字节数', async () => {
    const cache = createCache({ dir, maxBytes: 1024 * 1024, autoSweep: false });
    const keyA = contentKey({ sha256: HEX_A });
    const keyB = contentKey({ sha256: HEX_B });

    await cache.put(keyA, 'a'.repeat(100));
    await cache.put(keyB, 'b'.repeat(100));
    assert.equal((await cache.stats()).bytes, 200);

    // 把上限调小不可能（构造时定死），所以手动构造一个更小的缓存来验证淘汰逻辑
    const small = createCache({ dir, maxBytes: 100, autoSweep: false });
    const result = await small.sweep();

    assert.equal(result.freedBytes, 100); // 淘汰了 A（100 字节），剩下 B
    assert.equal(result.removed.length, 1);
    assert.ok(result.removed[0].startsWith(dir));
    assert.equal(await cache.has(keyA), false);
    assert.equal(await cache.has(keyB), true);
  });

  test('单条产物比整个缓存还大时，保留最新写入的那条（不返回已删除的路径）', async () => {
    const cache = createCache({ dir, maxBytes: 50 });
    const keyA = contentKey({ sha256: HEX_A });
    const target = await cache.put(keyA, 'a'.repeat(100));

    assert.equal(await cache.has(keyA), true);
    assert.ok((await fs.stat(target)).isFile());
  });

  test('sweep 的 removedKeys 能还原 sha256 形式的 key', async () => {
    const cache = createCache({ dir, maxBytes: 100, autoSweep: false });
    const keyA = contentKey({ sha256: HEX_A });
    const keyB = contentKey({ sha256: HEX_B });
    await cache.put(keyA, 'a'.repeat(100));
    await cache.put(keyB, 'b'.repeat(100));

    const result = await cache.sweep();
    assert.deepEqual(result.removedKeys.sort(), [keyA].sort());
  });
});

describe('cache: stats / clear / putFile', () => {
  let dir;
  let cache;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    cache = createCache({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('stats 数字正确', async () => {
    assert.deepEqual(await cache.stats(), {
      dir,
      entries: 0,
      bytes: 0,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    await cache.put(contentKey({ sha256: HEX_A }), 'a'.repeat(10));
    await cache.put(contentKey({ sha256: HEX_B }), 'b'.repeat(20));

    const stats = await cache.stats();
    assert.equal(stats.entries, 2);
    assert.equal(stats.bytes, 30);
    assert.equal(stats.dir, dir);
    assert.equal(stats.maxBytes, DEFAULT_MAX_BYTES);
  });

  test('putFile 把外部文件复制进缓存，源文件不受影响', async () => {
    const src = path.join(dir, '..', `src-${process.pid}-${Date.now()}.txt`);
    await fs.writeFile(src, '源文件内容', 'utf8');
    try {
      const key = contentKey({ sha256: HEX_A });
      const target = await cache.putFile(key, src);

      assert.ok(path.isAbsolute(target));
      assert.ok(target.startsWith(dir));
      assert.notEqual(target, src);
      assert.equal(await fs.readFile(target, 'utf8'), '源文件内容');
      // 源文件还在、内容没变
      assert.equal(await fs.readFile(src, 'utf8'), '源文件内容');
      // 缓存里能读回来
      assert.equal((await cache.get(key)).toString('utf8'), '源文件内容');
    } finally {
      await fs.rm(src, { force: true });
    }
  });

  test('putFile 源文件不存在时抛清晰错误', async () => {
    await assert.rejects(
      () => cache.putFile(contentKey({ sha256: HEX_A }), path.join(dir, 'missing.bin')),
      /源文件/,
    );
  });

  test('clear 清空缓存目录', async () => {
    await cache.put(contentKey({ sha256: HEX_A }), 'a');
    await cache.put(contentKey({ sha256: HEX_B }), 'b');
    assert.equal((await cache.stats()).entries, 2);

    await cache.clear();

    const stats = await cache.stats();
    assert.equal(stats.entries, 0);
    assert.equal(stats.bytes, 0);
    assert.deepEqual(await listFiles(dir), []);
  });
});

describe('cache: 并发安全', () => {
  let dir;
  let cache;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    cache = createCache({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('并发 put 同一个 key 不会写坏文件', async () => {
    const key = contentKey({ sha256: HEX_A });
    const payload = 'x'.repeat(4096);

    await Promise.all(
      Array.from({ length: 20 }, () => cache.put(key, payload)),
    );

    const data = await cache.get(key);
    assert.equal(data.length, payload.length);
    assert.equal(data.toString('utf8'), payload);

    const files = await listFiles(dir);
    assert.deepEqual(files.filter((f) => path.basename(f).startsWith('.tmp-')), []);
  });

  test('并发 put 不同 key 都能落盘', async () => {
    // 16 个互不相同的 64 位十六进制 key
    const hexes = Array.from({ length: 16 }, (_, i) =>
      i.toString(16).padStart(2, '0').repeat(32),
    );
    await Promise.all(hexes.map((hex, i) => cache.put(contentKey({ sha256: hex }), `payload-${i}`)));

    const stats = await cache.stats();
    assert.equal(stats.entries, 16);
    for (const [i, hex] of hexes.entries()) {
      const data = await cache.get(contentKey({ sha256: hex }));
      assert.equal(data.toString('utf8'), `payload-${i}`);
    }
  });
});

describe('cache: 内容 hash 键控', () => {
  let dir;
  let cache;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    cache = createCache({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('条目路径直接由内容 sha256 决定（前 2 位分片）', async () => {
    const key = contentKey({ sha256: HEX_A });
    const target = await cache.put(key, 'x');
    const parts = path.relative(dir, target).split(path.sep);
    assert.equal(parts.length, 2);
    assert.equal(parts[0], HEX_A.slice(0, 2));
    assert.equal(parts[1], HEX_A.slice(2));
  });

  test('带 variant 的条目与主条目是两个路径', async () => {
    const base = contentKey({ sha256: HEX_A });
    const variant = contentKey({ sha256: HEX_A, variant: 'grid-4x3' });
    await cache.put(base, 'base');
    await cache.put(variant, 'variant');

    const basePath = cache.getPath(base);
    const variantPath = cache.getPath(variant);
    assert.notEqual(basePath, variantPath);
    assert.ok(path.basename(variantPath).endsWith('.grid-4x3'));
  });

  test('内容相同的不同来源文件落到同一个 key', async () => {
    const srcA = path.join(dir, '..', `same-a-${process.pid}.txt`);
    const srcB = path.join(dir, '..', `same-b-${process.pid}.txt`);
    await fs.writeFile(srcA, '同样的内容');
    await fs.writeFile(srcB, '同样的内容');
    try {
      const a = await cache.contentKeyForFile(srcA);
      const b = await cache.contentKeyForFile(srcB);
      assert.equal(a.key, b.key);
    } finally {
      await fs.rm(srcA, { force: true });
      await fs.rm(srcB, { force: true });
    }
  });
});

describe('cache: 指纹索引（省掉重复的全文件哈希）', () => {
  let dir;
  let cache;
  let sources;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    sources = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-src-'));
    cache = createCache({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(sources, { recursive: true, force: true });
  });

  test('第一次真算 hash，第二次命中指纹不用重算', async () => {
    const src = path.join(sources, 'video.mp4');
    const content = '假装这是一段视频';
    await fs.writeFile(src, content);

    const first = await cache.contentKeyForFile(src);
    assert.equal(first.fromFingerprint, false);
    assert.equal(first.sha256, hashBuffer(content));
    assert.equal(first.key, `sha256:${hashBuffer(content)}`);
    assert.equal(first.size, Buffer.byteLength(content));

    const second = await cache.contentKeyForFile(src);
    assert.equal(second.fromFingerprint, true);
    assert.equal(second.sha256, first.sha256);
    assert.equal(second.key, first.key);
  });

  test('指纹索引写在缓存根目录', async () => {
    const src = path.join(sources, 'a.bin');
    await fs.writeFile(src, 'abc');
    await cache.contentKeyForFile(src);

    const indexPath = path.join(dir, 'fingerprint-index.json');
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.ok(Object.keys(parsed.entries).length >= 1);
  });

  test('文件内容变了 → 指纹失效，重新计算', async () => {
    const src = path.join(sources, 'changing.bin');
    await fs.writeFile(src, 'v1');
    const first = await cache.contentKeyForFile(src);

    await fs.writeFile(src, 'v2-换了内容');
    const second = await cache.contentKeyForFile(src);
    assert.equal(second.fromFingerprint, false);
    assert.notEqual(second.sha256, first.sha256);
    assert.equal(second.sha256, hashBuffer('v2-换了内容'));
  });

  test('指纹索引损坏时优雅忽略并重建', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'fingerprint-index.json'), '{ 这不是 JSON');

    const src = path.join(sources, 'broken-index.bin');
    await fs.writeFile(src, 'data');
    const first = await cache.contentKeyForFile(src);
    assert.equal(first.fromFingerprint, false);

    const second = await cache.contentKeyForFile(src);
    assert.equal(second.fromFingerprint, true);
    assert.equal(second.sha256, first.sha256);
  });

  test('lookupFingerprint 支持指纹前缀（前 16 位）查询', async () => {
    const src = path.join(sources, 'prefix.bin');
    await fs.writeFile(src, 'prefix');
    const stat = await fs.stat(src);
    const fp = fingerprintFor({ path: src, size: stat.size, mtimeMs: stat.mtimeMs });

    await cache.recordFingerprint({
      path: src,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: hashBuffer('prefix'),
    });

    assert.deepEqual(await cache.lookupFingerprint(fp), {
      sha256: hashBuffer('prefix'),
      key: `sha256:${hashBuffer('prefix')}`,
    });
    assert.deepEqual(await cache.lookupFingerprint(fp.slice(0, 16)), {
      sha256: hashBuffer('prefix'),
      key: `sha256:${hashBuffer('prefix')}`,
    });
    assert.equal(await cache.lookupFingerprint('f'.repeat(64)), null);
  });

  test('另一个缓存实例（≈ 另一个进程）也能看到指纹索引', async () => {
    const src = path.join(sources, 'shared.bin');
    await fs.writeFile(src, 'shared');

    const first = await cache.contentKeyForFile(src);
    const other = createCache({ dir }); // 全新实例，内存里没有索引
    const second = await other.contentKeyForFile(src);
    assert.equal(second.fromFingerprint, true);
    assert.equal(second.sha256, first.sha256);
  });

  test('源文件不存在时 contentKeyForFile 抛 ENOENT', async () => {
    await assert.rejects(
      () => cache.contentKeyForFile(path.join(sources, 'missing.bin')),
      (err) => err.code === 'ENOENT',
    );
  });
});

describe('cache: 目录型条目（全文落盘产物）', () => {
  let dir;
  let cache;
  let sources;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    sources = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-artifacts-'));
    cache = createCache({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(sources, { recursive: true, force: true });
  });

  /** 造一份典型的「全文落盘」产物目录 */
  async function makeArtifacts(name) {
    const srcDir = path.join(sources, name);
    await fs.mkdir(path.join(srcDir, 'images'), { recursive: true });
    await fs.writeFile(path.join(srcDir, 'content.md'), '# 全文');
    await fs.writeFile(path.join(srcDir, 'segments.jsonl'), '{"startMs":0}\n');
    await fs.writeFile(path.join(srcDir, 'manifest.json'), '{}');
    await fs.writeFile(path.join(srcDir, 'images', 'p1.png'), Buffer.alloc(64));
    return srcDir;
  }

  test('putDir 把整个产物目录复制进缓存', async () => {
    const key = contentKey({ sha256: HEX_A });
    const srcDir = await makeArtifacts('doc1');

    const target = await cache.putDir(key, srcDir);
    assert.ok((await fs.stat(target)).isDirectory());
    assert.equal(target, cache.getPath(key));
    assert.equal(await fs.readFile(path.join(target, 'content.md'), 'utf8'), '# 全文');
    assert.equal(
      await fs.readFile(path.join(target, 'segments.jsonl'), 'utf8'),
      '{"startMs":0}\n',
    );
    assert.ok((await fs.stat(path.join(target, 'images', 'p1.png'))).isFile());

    assert.equal(await cache.has(key), true);
  });

  test('目录型条目不能用 get() 读进内存', async () => {
    const key = contentKey({ sha256: HEX_A });
    await cache.putDir(key, await makeArtifacts('doc2'));
    await assert.rejects(() => cache.get(key), (err) => err.code === 'ERR_CACHE_NOT_A_FILE');
  });

  test('stats 按递归大小统计目录型条目', async () => {
    const key = contentKey({ sha256: HEX_A });
    const srcDir = await makeArtifacts('doc3');
    await cache.putDir(key, srcDir);

    // content.md: 8 字节（'#' + 空格 + 两个 3 字节汉字）
    // segments.jsonl: 14；manifest.json: 2；images/p1.png: 64
    const expected = 8 + 14 + 2 + 64;
    const stats = await cache.stats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.bytes, expected);
  });

  test('prepareDir + register：调用方自己把产物写进缓存', async () => {
    const key = contentKey({ sha256: HEX_A });
    const entryDir = await cache.prepareDir(key);
    await fs.writeFile(path.join(entryDir, 'content.md'), 'x'.repeat(100));
    await fs.mkdir(path.join(entryDir, 'images'), { recursive: true });
    await fs.writeFile(path.join(entryDir, 'images', 'a.png'), Buffer.alloc(50));

    const info = await cache.register(key);
    assert.equal(info.type, 'dir');
    assert.equal(info.size, 150);
    assert.equal(info.path, entryDir);

    const stats = await cache.stats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.bytes, 150);
  });

  test('目录型条目参与 LRU 淘汰', async () => {
    const small = createCache({ dir, maxBytes: 250 });
    const dirA = path.join(sources, 'a');
    const dirB = path.join(sources, 'b');
    const dirC = path.join(sources, 'c');
    for (const d of [dirA, dirB, dirC]) {
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, 'content.md'), 'x'.repeat(100));
    }

    const keyA = contentKey({ sha256: HEX_A });
    const keyB = contentKey({ sha256: HEX_B });
    const keyC = contentKey({ sha256: HEX_C });
    await small.putDir(keyA, dirA);
    await small.putDir(keyB, dirB);
    await small.putDir(keyC, dirC);

    assert.equal(await small.has(keyA), false);
    assert.equal(await small.has(keyB), true);
    assert.equal(await small.has(keyC), true);
  });

  test('并发 putDir 同一个 key 不损坏', async () => {
    const key = contentKey({ sha256: HEX_A });
    const srcDir = await makeArtifacts('doc-concurrent');

    await Promise.all(Array.from({ length: 5 }, () => cache.putDir(key, srcDir)));

    const target = cache.getPath(key);
    assert.ok((await fs.stat(target)).isDirectory());
    assert.equal(await fs.readFile(path.join(target, 'content.md'), 'utf8'), '# 全文');
    assert.ok((await fs.stat(path.join(target, 'images', 'p1.png'))).isFile());
    // 没有把临时目录残留在条目里
    const leftovers = (await fs.readdir(path.dirname(target))).filter((n) => n.startsWith('.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  test('文件型条目可以覆盖成目录型条目（反之亦然）', async () => {
    const key = contentKey({ sha256: HEX_A });
    await cache.put(key, '先写成一个文件');
    assert.ok(Buffer.isBuffer(await cache.get(key)));

    await cache.putDir(key, await makeArtifacts('doc4'));
    assert.ok((await fs.stat(cache.getPath(key))).isDirectory());

    await cache.put(key, '又变回文件');
    assert.equal((await cache.get(key)).toString('utf8'), '又变回文件');
  });
});

describe('cache: 不误删非本模块写的文件', () => {
  let dir;
  let sources;
  let cache;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    sources = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-src-'));
    cache = createCache({ dir, maxBytes: 100, autoSweep: false });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(sources, { recursive: true, force: true });
  });

  test('sweep 与 clear 都不会碰别人的文件', async () => {
    const keyA = contentKey({ sha256: HEX_A });
    const keyB = contentKey({ sha256: HEX_B });
    await cache.put(keyA, 'a'.repeat(100));
    await cache.put(keyB, 'b'.repeat(100));

    // 别人的文件：缓存根目录一个、分片目录里一个（名字不符合条目规则）
    const foreignRoot = path.join(dir, 'user-notes.txt');
    await fs.writeFile(foreignRoot, '别删我');
    const shardDir = path.join(dir, HEX_A.slice(0, 2));
    await fs.mkdir(shardDir, { recursive: true });
    const foreignShard = path.join(shardDir, 'README.keep');
    await fs.writeFile(foreignShard, '别删我');

    await cache.sweep();
    // 自己的条目该淘汰还是淘汰
    assert.equal(await cache.has(keyA), false);
    // 别人的文件一根汗毛都不少
    assert.equal(await fs.readFile(foreignRoot, 'utf8'), '别删我');
    assert.equal(await fs.readFile(foreignShard, 'utf8'), '别删我');

    await cache.clear();
    assert.equal(await fs.readFile(foreignRoot, 'utf8'), '别删我');
    assert.equal(await fs.readFile(foreignShard, 'utf8'), '别删我');
  });
});

describe('resolveCacheConfig', () => {
  test('默认值：~/.cache/multimediagrep 与 10GB', () => {
    const config = resolveCacheConfig({});
    assert.equal(config.dir, path.join(os.homedir(), '.cache', 'multimediagrep'));
    assert.equal(config.maxBytes, 10 * 1024 ** 3);
  });

  test('MMGREP_CACHE_DIR 支持 ~ 展开', () => {
    const config = resolveCacheConfig({ MMGREP_CACHE_DIR: '~/custom/cache' });
    assert.equal(config.dir, path.join(os.homedir(), 'custom', 'cache'));
  });

  test('MMGREP_CACHE_DIR 相对路径按 cwd 解析', () => {
    const config = resolveCacheConfig({ MMGREP_CACHE_DIR: 'tmp/cache' });
    assert.equal(config.dir, path.resolve(process.cwd(), 'tmp/cache'));
    assert.ok(path.isAbsolute(config.dir));
  });

  test('MMGREP_CACHE_DIR 绝对路径原样保留', () => {
    const absolute = path.resolve(os.tmpdir(), 'mmgrep-abs');
    const config = resolveCacheConfig({ MMGREP_CACHE_DIR: absolute });
    assert.equal(config.dir, absolute);
  });

  test('MMGREP_CACHE_MAX_BYTES 解析带单位的字符串', () => {
    assert.equal(resolveCacheConfig({ MMGREP_CACHE_MAX_BYTES: '512MB' }).maxBytes, 512 * 1024 ** 2);
    assert.equal(resolveCacheConfig({ MMGREP_CACHE_MAX_BYTES: '10GB' }).maxBytes, 10 * 1024 ** 3);
    assert.equal(resolveCacheConfig({ MMGREP_CACHE_MAX_BYTES: '1GB' }).maxBytes, 1024 ** 3);
    assert.equal(resolveCacheConfig({ MMGREP_CACHE_MAX_BYTES: '2TB' }).maxBytes, 2 * 1024 ** 4);
  });

  test('MMGREP_CACHE_MAX_BYTES 解析纯数字（字节）', () => {
    assert.equal(resolveCacheConfig({ MMGREP_CACHE_MAX_BYTES: '1024' }).maxBytes, 1024);
    assert.equal(resolveCacheConfig({ MMGREP_CACHE_MAX_BYTES: '0' }).maxBytes, 0);
    assert.equal(resolveCacheConfig({ MMGREP_CACHE_MAX_BYTES: 2048 }).maxBytes, 2048);
  });

  test('MMGREP_CACHE_MAX_BYTES 非法值抛清晰错误', () => {
    assert.throws(() => resolveCacheConfig({ MMGREP_CACHE_MAX_BYTES: 'lots' }), /容量上限/);
    assert.throws(() => resolveCacheConfig({ MMGREP_CACHE_MAX_BYTES: '-5' }), /容量上限/);
    assert.throws(() => resolveCacheConfig({ MMGREP_CACHE_MAX_BYTES: '10 furlongs' }), /容量上限/);
  });
});

describe('createCache 配置', () => {
  test('maxBytes 可以传字符串', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    try {
      const cache = createCache({ dir, maxBytes: '1MB' });
      assert.equal(cache.maxBytes, 1024 ** 2);
      assert.equal((await cache.stats()).maxBytes, 1024 ** 2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('默认走环境变量', async () => {
    const previous = process.env.MMGREP_CACHE_DIR;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-cache-'));
    process.env.MMGREP_CACHE_DIR = dir;
    try {
      const cache = createCache();
      assert.equal(cache.dir, dir);
    } finally {
      if (previous === undefined) delete process.env.MMGREP_CACHE_DIR;
      else process.env.MMGREP_CACHE_DIR = previous;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
