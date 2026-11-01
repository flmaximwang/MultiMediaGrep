/**
 * 内容哈希与 key 工具的单元测试。
 *
 * 所有临时文件都建在系统临时目录（os.tmpdir()），跑完清理，不碰仓库。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  hashBuffer,
  hashFile,
  contentKey,
  assertSafeKey,
  isSafeKey,
  fingerprintFor,
} from '../../src/cache/hash.js';

/** sha256('abc') 的标准值 */
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('hashBuffer', () => {
  test('字符串 / Buffer / Uint8Array 结果一致', () => {
    assert.equal(hashBuffer('abc'), SHA256_ABC);
    assert.equal(hashBuffer(Buffer.from('abc', 'utf8')), SHA256_ABC);
    assert.equal(hashBuffer(new Uint8Array([97, 98, 99])), SHA256_ABC);
    assert.equal(hashBuffer(new Uint8Array([97, 98, 99]).buffer), SHA256_ABC);
  });

  test('输出是 64 位小写十六进制', () => {
    assert.match(hashBuffer('anything'), /^[0-9a-f]{64}$/);
  });

  test('不支持的类型抛错', () => {
    assert.throws(() => hashBuffer(42), TypeError);
    assert.throws(() => hashBuffer(null), TypeError);
  });
});

describe('hashFile', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmgrep-hash-'));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('小文件：与 hashBuffer 结果一致，且返回字节数', async () => {
    const file = path.join(tmpDir, 'small.txt');
    const content = 'hello 多媒体缓存';
    await fs.writeFile(file, content, 'utf8');

    const result = await hashFile(file);
    assert.equal(result.sha256, hashBuffer(content));
    assert.equal(result.size, Buffer.byteLength(content, 'utf8'));
  });

  test('大文件：流式计算结果与一次性计算一致', async () => {
    const file = path.join(tmpDir, 'big.bin');
    // 8MB 确定性内容
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const handle = await fs.open(file, 'w');
    for (let i = 0; i < 8; i += 1) {
      chunk.writeUInt32LE(i, 0);
      await handle.write(chunk);
    }
    await handle.close();

    const expected = hashBuffer(await fs.readFile(file));
    const result = await hashFile(file);
    assert.equal(result.size, 8 * 1024 * 1024);
    assert.equal(result.sha256, expected);
  });

  test('空文件也能算出摘要', async () => {
    const file = path.join(tmpDir, 'empty.bin');
    await fs.writeFile(file, '');
    const result = await hashFile(file);
    assert.equal(result.size, 0);
    assert.equal(result.sha256, hashBuffer(''));
  });

  test('文件不存在时 reject（ENOENT）', async () => {
    await assert.rejects(() => hashFile(path.join(tmpDir, 'nope.bin')), (err) => {
      assert.equal(err.code, 'ENOENT');
      return true;
    });
  });

  test('路径非法时抛 TypeError', async () => {
    await assert.rejects(() => hashFile(''), TypeError);
  });
});

describe('contentKey', () => {
  const hex = 'a'.repeat(64);

  test('只有 sha256 时生成 sha256:<hex>', () => {
    assert.equal(contentKey({ sha256: hex }), `sha256:${hex}`);
  });

  test('带 variant 时追加 :<variant>', () => {
    assert.equal(contentKey({ sha256: hex, variant: 'grid-4x3' }), `sha256:${hex}:grid-4x3`);
  });

  test('大写 hex 归一化成小写', () => {
    assert.equal(contentKey({ sha256: hex.toUpperCase() }), `sha256:${hex}`);
  });

  test('空 variant 等价于没有 variant', () => {
    assert.equal(contentKey({ sha256: hex, variant: '' }), `sha256:${hex}`);
    assert.equal(contentKey({ sha256: hex, variant: null }), `sha256:${hex}`);
    assert.equal(contentKey({ sha256: hex, variant: undefined }), `sha256:${hex}`);
  });

  test('variant 里可以带冒号（会被当成多段）', () => {
    const key = contentKey({ sha256: hex, variant: 'zoom:00:12-00:20' });
    assert.equal(key, `sha256:${hex}:zoom:00:12-00:20`);
    assert.ok(isSafeKey(key));
  });

  test('非法 sha256 抛错', () => {
    assert.throws(() => contentKey({ sha256: 'abc' }), /sha256/);
    assert.throws(() => contentKey({ sha256: 123 }), /sha256/);
    assert.throws(() => contentKey({}), /sha256/);
  });

  test('非法 variant 抛错', () => {
    assert.throws(() => contentKey({ sha256: hex, variant: 'a/b' }), /非法/);
    assert.throws(() => contentKey({ sha256: hex, variant: 'a b' }), /非法/);
    assert.throws(() => contentKey({ sha256: hex, variant: 42 }), /variant/);
  });
});

describe('fingerprintFor', () => {
  test('同样的路径/大小/mtime → 同样的指纹；任一变化 → 指纹变化', () => {
    const base = { path: '/tmp/a.mp4', size: 100, mtimeMs: 1_700_000_000_000 };
    const fp = fingerprintFor(base);
    assert.match(fp, /^[0-9a-f]{64}$/);
    assert.equal(fingerprintFor({ ...base }), fp);
    assert.notEqual(fingerprintFor({ ...base, size: 101 }), fp);
    assert.notEqual(fingerprintFor({ ...base, mtimeMs: base.mtimeMs + 1 }), fp);
    assert.notEqual(fingerprintFor({ ...base, path: '/tmp/b.mp4' }), fp);
  });

  test('相对路径会先解析成绝对路径（同一文件不同写法指纹相同）', () => {
    const file = path.join(os.tmpdir(), 'mmgrep-fp-relative.txt');
    const absolute = fingerprintFor({ path: file, size: 1, mtimeMs: 2 });
    const relative = path.relative(process.cwd(), file);
    assert.equal(fingerprintFor({ path: relative, size: 1, mtimeMs: 2 }), absolute);
  });

  test('缺参数时抛 TypeError', () => {
    assert.throws(() => fingerprintFor({}), TypeError);
    assert.throws(() => fingerprintFor({ path: '/tmp/a' }), TypeError);
  });
});

describe('assertSafeKey', () => {
  test('接受安全 key', () => {
    const hex = 'b'.repeat(64);
    assert.equal(assertSafeKey(`sha256:${hex}`), `sha256:${hex}`);
    assert.equal(assertSafeKey('sha256:abc:grid-4x3'), 'sha256:abc:grid-4x3');
    assert.equal(assertSafeKey('a-b_c.d'), 'a-b_c.d');
    assert.ok(isSafeKey('a-b_c.d'));
  });

  test('拒绝路径穿越与非法字符', () => {
    const bad = [
      '../evil',
      '../../etc/passwd',
      'a/b',
      '/absolute',
      'a\\b',
      'a b',
      'a\0b',
      '',
      '.',
      '..',
      'a:',
      ':a',
      'a::b',
    ];
    for (const key of bad) {
      assert.throws(() => assertSafeKey(key), (err) => {
        assert.equal(err.code, 'ERR_CACHE_INVALID_KEY');
        return true;
      }, `key "${key}" 应该被拒绝`);
      assert.equal(isSafeKey(key), false);
    }
  });

  test('拒绝非字符串与超长 key', () => {
    assert.throws(() => assertSafeKey(42), /非法/);
    assert.throws(() => assertSafeKey('x'.repeat(500)), /过长/);
  });
});
