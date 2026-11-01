/**
 * 内容哈希与缓存键工具。
 *
 * 缓存是**内容寻址**的：同一个输入文件算出的 sha256 就是它的身份，
 * 产物（宫格图 / 特写图 / content.md / segments.jsonl）挂在同一个 sha256 下，
 * 用 `variant` 区分「同一个源文件的不同参数产物」。
 *
 * 典型用法：
 *   const { sha256, size } = await hashFile('/path/to/video.mp4');
 *   const key = contentKey({ sha256 });              // 'sha256:ab12...'
 *   const key2 = contentKey({ sha256, variant: 'grid-4x3' }); // 'sha256:ab12...:grid-4x3'
 *
 * key 的安全性由 `assertSafeKey` 把关：key 最终要落成文件名，
 * 所以只允许 `[A-Za-z0-9._-]` 的「段」，段与段之间用 `:` 分隔，
 * 任何 `/`、空格、控制字符、`.`/`..` 段都会被拒绝——杜绝路径穿越。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

/** 哈希算法：内容寻址的稳定标识 */
export const HASH_ALGO = 'sha256';

/** sha256 的十六进制长度 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** key 单段允许的字符：字母、数字、点、下划线、连字符 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** key 的最大长度（防止超长文件名 / 超长命令行） */
export const MAX_KEY_LENGTH = 200;

/** key 单段（variant）的最大长度 */
export const MAX_SEGMENT_LENGTH = 100;

/**
 * 计算 buffer / 字符串的 sha256（十六进制，小写）。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|string} buf
 * @returns {string} 64 位十六进制摘要
 */
export function hashBuffer(buf) {
  return createHash(HASH_ALGO).update(toBytes(buf)).digest('hex');
}

/**
 * 流式计算文件的 sha256 与字节数。
 *
 * 大文件不会整块读进内存：按 chunk 推进哈希，同时累加字节数。
 *
 * @param {string} filePath 文件路径
 * @returns {Promise<{ sha256: string, size: number }>}
 */
export async function hashFile(filePath) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new TypeError('hashFile: 需要非空的文件路径');
  }
  const hash = createHash(HASH_ALGO);
  let size = 0;

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return { sha256: hash.digest('hex'), size };
}

/**
 * 算一个文件的「快速指纹」：路径 + 大小 + mtime 的摘要。
 *
 * 用途是**省掉一次全文件哈希**：
 *   - 指纹命中 → 直接复用上次算出来的内容 sha256（前提是文件没变）；
 *   - 指纹不命中（文件改了 / 首次访问 / 索引丢了）→ 老老实实全文件算 sha256。
 *
 * 指纹只是加速用的钥匙，**不能**当缓存主键：文件内容改了但大小和 mtime 恰好
 * 没变时，指纹会误命中。缓存主键永远是**内容 sha256**。
 *
 * @param {object} spec
 * @param {string} spec.path 文件路径（相对路径会按 cwd 解析成绝对路径）
 * @param {number} spec.size 文件字节数
 * @param {number} spec.mtimeMs 文件修改时间（毫秒）
 * @returns {string} 64 位十六进制摘要
 */
export function fingerprintFor({ path: filePath, size, mtimeMs } = {}) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new TypeError('fingerprintFor: 需要文件路径');
  }
  if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) {
    throw new TypeError('fingerprintFor: 需要数值型的 size / mtimeMs');
  }
  const absolute = path.resolve(filePath);
  return createHash(HASH_ALGO)
    .update(`${absolute}:${size}:${mtimeMs}`)
    .digest('hex');
}

/**
 * 校验 key 是否安全（可安全地落成文件名）。
 *
 * 规则：
 *   - 必须是字符串、非空、长度 ≤ MAX_KEY_LENGTH；
 *   - 用 `:` 分成若干段，每段都要匹配 `[A-Za-z0-9._-]+`；
 *   - 段不能是 `.` 或 `..`（防目录穿越 / 隐藏文件歧义）。
 *
 * 因此 `../evil`、`a/b`、绝对路径、空格、控制字符都会被拒绝。
 *
 * @param {string} key
 * @returns {string} 原样返回（便于链式使用）
 * @throws {Error} code = 'ERR_CACHE_INVALID_KEY'
 */
export function assertSafeKey(key) {
  if (typeof key !== 'string') {
    throw invalidKey(`key 必须是字符串，收到 ${typeof key}`);
  }
  if (key.length === 0) {
    throw invalidKey('key 不能为空');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw invalidKey(`key 过长（${key.length} > ${MAX_KEY_LENGTH}）`);
  }
  for (const segment of key.split(':')) {
    if (segment.length === 0) {
      throw invalidKey(`key "${key}" 含空段`);
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw invalidKey(`key "${key}" 的段过长（> ${MAX_SEGMENT_LENGTH}）`);
    }
    if (segment === '.' || segment === '..') {
      throw invalidKey(`key "${key}" 含非法段 "${segment}"`);
    }
    if (!SAFE_SEGMENT_RE.test(segment)) {
      throw invalidKey(
        `key "${key}" 含非法字符（只允许 A-Z a-z 0-9 . _ - ，段之间用 ":" 分隔）`,
      );
    }
  }
  return key;
}

/**
 * key 是否安全（不抛错的版本）。
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSafeKey(key) {
  try {
    assertSafeKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * 造一个规范的缓存 key。
 *
 * @param {object} spec
 * @param {string} spec.sha256  内容 sha256（大小写不敏感，内部统一小写）
 * @param {string} [spec.variant] 同一内容的不同产物变体（例如 'grid-4x3'、'zoom-0-12'）
 * @returns {string} `sha256:<hex>` 或 `sha256:<hex>:<variant>`
 */
export function contentKey({ sha256, variant } = {}) {
  if (typeof sha256 !== 'string') {
    throw invalidKey('contentKey: sha256 必须是字符串');
  }
  const hex = sha256.trim().toLowerCase();
  if (!SHA256_HEX_RE.test(hex)) {
    throw invalidKey('contentKey: sha256 必须是 64 位十六进制');
  }
  if (variant === undefined || variant === null || variant === '') {
    return `sha256:${hex}`;
  }
  if (typeof variant !== 'string') {
    throw invalidKey('contentKey: variant 必须是字符串');
  }
  const key = `sha256:${hex}:${variant}`;
  // 复用 key 校验：variant 里不能出现路径分隔符等危险字符
  return assertSafeKey(key);
}

/**
 * 把任意输入统一成 Buffer（字符串按 utf-8 编码）。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|string} input
 * @returns {Buffer}
 */
function toBytes(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (Buffer.isBuffer(input)) return input;
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new TypeError('hashBuffer: 需要 Buffer / Uint8Array / ArrayBuffer / string');
}

/**
 * 造一个带错误码的 key 校验异常。
 *
 * @param {string} message
 * @returns {Error}
 */
function invalidKey(message) {
  const err = new Error(`[mmgrep/cache] 非法缓存 key：${message}`);
  err.code = 'ERR_CACHE_INVALID_KEY';
  return err;
}
