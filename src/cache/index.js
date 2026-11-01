/**
 * MultiMediaGrep 的 server 侧内容缓存。
 *
 * ## 键控：按**文件内容 hash**（不是路径 + 大小 + mtime）
 *
 * 主键 = 源文件内容的 sha256：
 *
 *   sha256:<64 位 hex>              同一份内容的默认产物
 *   sha256:<64 位 hex>:<variant>    同一份内容的不同产物（宫格图 / 特写 / 全文 …）
 *
 * 内容变了 → hash 变了 → key 变了 → 自然失效，不会出现「文件改了但缓存还命中」。
 *
 * 为了避免每次都全文件哈希（视频动辄几个 GB），额外维护一份**指纹索引**：
 *
 *   fingerprint = sha256(绝对路径 + ':' + size + ':' + mtimeMs)
 *   → 内容 sha256
 *
 * 指纹只是「快速路径」的钥匙：命中指纹就跳过全文件哈希；指纹不命中（文件改了 /
 * 首次访问 / 索引损坏）就老老实实算内容 hash，并把新指纹写回索引。
 *
 * ## 硬约束
 *
 * 1. **绝不写到用户文件旁边**。缓存目录固定是一个独立目录（默认
 *    `~/.cache/multimediagrep`），所有写入都在这个目录内部完成——
 *    用户把 `foo.mp4` 放哪儿，缓存都不会在旁边生成任何文件。
 * 2. **原子写**：先写同目录下的唯一临时文件，再 `rename` 覆盖。
 *    进程被 kill 也不会留下半截文件；多个进程并发写同一个 key 也不会互相写坏
 *    （临时文件名唯一 + rename 原子，后写覆盖先写，文件始终完整）。
 * 3. **容量上限 + LRU**：超过 `maxBytes` 时按「最久未使用」淘汰。
 * 4. **只删自己登记过的条目**：每个条目旁边有一份 `.meta-<stem>.json` 记录
 *    （key / 类型 / 大小 / 最后使用时间 / 创建时间）。sweep 与 clear 只处理
 *    「有记录」或「符合本模块命名规则」的条目，**不会误删**别人放在缓存目录里的文件。
 *
 * ## 目录结构
 *
 *   <dir>/fingerprint-index.json              指纹索引（路径+大小+mtime → 内容 hash）
 *   <dir>/<shard>/<stem>                      条目载荷：单个文件
 *   <dir>/<shard>/<stem>/                     条目载荷：产物目录
 *                                             （content.md / segments.jsonl /
 *                                               manifest.json / images/ …）
 *   <dir>/<shard>/.meta-<stem>.json           条目记录（LRU 与清理的依据）
 *   <dir>/<shard>/.tmp-<随机>                 写入过程中的临时文件
 *
 * 例：key `sha256:ab12…cd` → `<dir>/ab/12…cd`；
 * key `sha256:ab12…cd:grid-4x3` → `<dir>/ab/12…cd.grid-4x3`
 * （variant 里的特殊字符做百分号编码，`:` → `%3A`）。
 *
 * ## LRU 依据（选型说明）
 *
 * **用条目记录里的 `lastUsed`（毫秒时间戳）当「最后使用时间」**，
 * 不用文件 mtime、不用 atime。
 *
 * 理由：
 *   - 产物**可以是目录**（content.md + images/ 一起）。目录的 mtime 只在
 *     子项增删时变，「读过」并不会改它，用 mtime 排 LRU 对目录条目是不准的。
 *   - atime 不可靠：Linux 默认 `relatime`、很多挂载点是 `noatime`，
 *     macOS/APFS 的 atime 更新也是延迟的。
 *   - 显式记录 lastUsed 语义明确、可测试；记录里顺带存了 size / created /
 *     条目类型（文件 or 目录），sweep 与 stats 都不需要再猜。
 *   - 没有记录文件的条目（崩溃遗留）按载荷的 mtime 兜底，并在下次扫描时补登记。
 *
 * 代价：每次命中要更新一次记录（小文件 + rename）。条目少、产物大，这个代价可忽略。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { assertSafeKey, hashBuffer, hashFile, fingerprintFor } from './hash.js';

/** 默认缓存目录：`~/.cache/multimediagrep` */
export const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'multimediagrep');

/** 默认容量上限：10GB */
export const DEFAULT_MAX_BYTES = 10 * 1024 ** 3;

/** 临时文件前缀（写入过程中的半成品；读取时忽略） */
export const TMP_PREFIX = '.tmp-';

/** 条目记录文件前缀（`.meta-<stem>.json`） */
export const META_PREFIX = '.meta-';

/** 指纹索引文件名（放在缓存根目录下） */
export const FINGERPRINT_INDEX_FILE = 'fingerprint-index.json';

/** 临时文件「陈旧」阈值：超过这个年龄的临时文件才允许被 sweep 清理（毫秒）。
 *  设得比较大是为了避免删掉别的进程**正在写**的临时文件。 */
export const STALE_TEMP_MS = 60 * 60 * 1000;

/** 指纹索引最多保留多少条（超出按最旧丢弃） */
export const MAX_FINGERPRINTS = 5000;

/** 条目文件名（stem）的最大长度，留出文件系统上限余量 */
const MAX_STEM_LENGTH = 200;

/** 条目文件名必须长这样：62 位十六进制摘要（去掉前 2 位）+ 可选的 .variant */
const ENTRY_NAME_RE = /^[0-9a-f]{62}(\.[A-Za-z0-9._%-]+)?$/;

/** 条目记录文件名 */
const META_NAME_RE = /^\.meta-(.+)\.json$/;

/** `sha256:<64 hex>[:<variant>]` 形式的 key */
const SHA_KEY_RE = /^sha256:([0-9a-fA-F]{64})(?::(.*))?$/;

/** sha256 十六进制格式 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** 容量字符串：数字 + 可选单位（二进制进制，KB=1024B） */
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|PB|KIB|MIB|GIB|TIB|K|M|G|T|P)?$/i;

/** 单位 → 字节 */
const SIZE_UNITS = {
  '': 1,
  B: 1,
  K: 1024,
  KB: 1024,
  KIB: 1024,
  M: 1024 ** 2,
  MB: 1024 ** 2,
  MIB: 1024 ** 2,
  G: 1024 ** 3,
  GB: 1024 ** 3,
  GIB: 1024 ** 3,
  T: 1024 ** 4,
  TB: 1024 ** 4,
  TIB: 1024 ** 4,
  P: 1024 ** 5,
  PB: 1024 ** 5,
  PIB: 1024 ** 5,
};

/**
 * 从环境变量解析缓存配置。
 *
 * - `MMGREP_CACHE_DIR`：缓存目录。默认 `~/.cache/multimediagrep`。
 *   `~` 展开成 home 目录；相对路径按 `process.cwd()` 解析。
 * - `MMGREP_CACHE_MAX_BYTES`：容量上限。默认 10GB。支持 `512MB` / `10GB` / `1024` 这类写法
 *   （KB/MB/GB/TB 按 1024 进制）。非法值会抛清晰错误，而不是悄悄用默认值。
 *
 * @param {object} [env] 环境变量对象，默认 process.env
 * @returns {{ dir: string, maxBytes: number }}
 */
export function resolveCacheConfig(env = process.env) {
  const source = env ?? {};
  return {
    dir: resolveCacheDir(source.MMGREP_CACHE_DIR),
    maxBytes: resolveMaxBytes(source.MMGREP_CACHE_MAX_BYTES),
  };
}

/**
 * 解析缓存目录：展开 `~`、相对路径按 cwd 解析，返回绝对路径。
 *
 * @param {string|undefined|null} raw
 * @returns {string}
 */
export function resolveCacheDir(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CACHE_DIR;
  if (typeof raw !== 'string') {
    throw new Error(`[mmgrep/cache] MMGREP_CACHE_DIR 必须是字符串，收到 ${typeof raw}`);
  }
  let value = raw.trim();
  if (value === '~') {
    value = os.homedir();
  } else if (value.startsWith('~/')) {
    value = path.join(os.homedir(), value.slice(2));
  }
  // path.resolve 会把相对路径按 process.cwd() 解析，并去掉 `.`/`..` 等
  return path.resolve(process.cwd(), value);
}

/**
 * 解析容量上限：支持 '512MB' / '10GB' / '1024' / 数字。
 *
 * @param {string|number|undefined|null} raw
 * @returns {number} 字节
 */
export function resolveMaxBytes(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MAX_BYTES;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error(`[mmgrep/cache] 非法容量上限：${raw}（必须是非负数）`);
    }
    return Math.floor(raw);
  }
  if (typeof raw !== 'string') {
    throw new Error(`[mmgrep/cache] 非法容量上限：${String(raw)}`);
  }
  const match = SIZE_RE.exec(raw.trim());
  if (!match) {
    throw new Error(
      `[mmgrep/cache] 无法解析容量上限 "${raw}"（支持 "512MB" / "10GB" / "1024" 这类写法）`,
    );
  }
  const unit = (match[2] ?? '').toUpperCase();
  const bytes = Math.floor(Number(match[1]) * SIZE_UNITS[unit]);
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`[mmgrep/cache] 非法容量上限："${raw}"`);
  }
  return bytes;
}

/**
 * 造一个缓存实例。
 *
 * @param {object} [opts]
 * @param {string} [opts.dir] 缓存目录（默认读环境变量，再默认 `~/.cache/multimediagrep`）
 * @param {string|number} [opts.maxBytes] 容量上限（默认读环境变量，再默认 10GB）
 * @param {object} [opts.logger] 日志对象（{ debug, info, warn, error }，缺省静默）
 * @param {boolean} [opts.autoSweep=true] 写入后超出上限时是否自动淘汰
 * @param {boolean} [opts.fsync=true] 写入临时文件后是否 fsync（保证断电后文件不残缺）
 * @returns {object} cache 实例
 */
export function createCache({ dir, maxBytes, logger, autoSweep = true, fsync = true } = {}) {
  const config = resolveCacheConfig();
  const root = path.resolve(
    dir === undefined || dir === null || dir === '' ? config.dir : resolveCacheDir(dir),
  );
  const limit = normalizeLimit(maxBytes === undefined || maxBytes === null ? config.maxBytes : maxBytes);
  const log = logger && typeof logger === 'object' ? logger : {};

  /** 内存里的容量估算（跨进程共享目录时只是估算，sweep 会用磁盘扫描结果覆盖它） */
  const state = { scanned: false, bytes: 0, entries: 0 };
  /** 指纹索引的内存缓存（避免每次都读盘；用文件的 mtime+size 判断要不要重读） */
  let fingerprintCache = null;
  /** 进程内严格单调递增的「最后使用时间」，保证同毫秒内的多次访问也能排出先后 */
  let lastUsedStamp = 0;

  /**
   * 计算某个 key 在磁盘上的绝对路径。
   *
   * 只算路径、不碰磁盘——**不保证文件存在**。
   * 用于「产物写进缓存、由 MCP 把路径返回给 agent」的场景。
   *
   * @param {string} key
   * @returns {string} 绝对路径
   */
  function getPath(key) {
    return entryPaths(key).target;
  }

  /**
   * 读取一个小产物到内存。
   *
   * 大产物（几十 MB 的图/文本）**不要**用这个——用 `getPath()` 返回路径，
   * 让调用方自己按路径处理。目录型条目（content.md + images/）也不走这里。
   *
   * @param {string} key
   * @returns {Promise<Buffer|null>} 不存在时返回 null
   */
  async function get(key) {
    const { target } = entryPaths(key);
    let stat;
    try {
      stat = await fs.stat(target);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    if (stat.isDirectory()) {
      const err = new Error(
        `[mmgrep/cache] 条目 ${key} 是目录，请用 getPath() 取路径而不是读进内存`,
      );
      err.code = 'ERR_CACHE_NOT_A_FILE';
      throw err;
    }
    const data = await fs.readFile(target);
    // 读即「用过」：刷新 LRU 时间
    await touch(key);
    return data;
  }

  /**
   * 写入一个小产物（单个文件）。
   *
   * 原子写：先写同目录唯一临时文件，再 rename 覆盖。
   *
   * @param {string} key
   * @param {Buffer|Uint8Array|string} data
   * @returns {Promise<string>} 落盘后的绝对路径
   */
  async function put(key, data) {
    const paths = entryPaths(key);
    const bytes = toBuffer(data);
    // 旧的目录型条目先清掉；旧的同名文件直接 rename 覆盖（保持原子，不留空窗）
    const previousSize = await prepareForFileWrite(paths.target);
    await fs.mkdir(path.dirname(paths.target), { recursive: true });

    const tempPath = await writeTemp(path.dirname(paths.target), bytes);
    try {
      await fs.rename(tempPath, paths.target);
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }
    await writeMeta(paths, { type: 'file', size: bytes.length, key });
    noteWrite(previousSize, bytes.length);
    await maybeSweep();
    return paths.target;
  }

  /**
   * 把一个外部文件复制进缓存（大产物走这条路，不占用内存）。
   *
   * 源文件**只读不改**，也不会被移动——用户文件旁边不会多出任何东西。
   *
   * @param {string} key
   * @param {string} srcPath 源文件路径
   * @returns {Promise<string>} 缓存内的绝对路径
   */
  async function putFile(key, srcPath) {
    const paths = entryPaths(key);
    const source = path.resolve(srcPath);
    const sourceStat = await statSafe(source);
    if (!sourceStat || !sourceStat.isFile()) {
      throw new Error(`[mmgrep/cache] putFile: 源文件不存在或不是普通文件：${source}`);
    }
    const previousSize = await prepareForFileWrite(paths.target);
    await fs.mkdir(path.dirname(paths.target), { recursive: true });

    const tempPath = await tempPathFor(path.dirname(paths.target));
    try {
      await fs.copyFile(source, tempPath);
      if (fsync) await syncFile(tempPath);
      await fs.rename(tempPath, paths.target);
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }
    await writeMeta(paths, { type: 'file', size: sourceStat.size, key });
    noteWrite(previousSize, sourceStat.size);
    await maybeSweep();
    return paths.target;
  }

  /**
   * 把一个**目录**复制进缓存（产物目录：content.md / segments.jsonl /
   * manifest.json / images/ …）。
   *
   * @param {string} key
   * @param {string} srcDir 源目录路径
   * @returns {Promise<string>} 缓存内的目录绝对路径
   */
  async function putDir(key, srcDir) {
    const paths = entryPaths(key);
    const source = path.resolve(srcDir);
    const sourceStat = await statSafe(source);
    if (!sourceStat || !sourceStat.isDirectory()) {
      throw new Error(`[mmgrep/cache] putDir: 源目录不存在：${source}`);
    }
    await fs.mkdir(path.dirname(paths.target), { recursive: true });
    const previousSize = await payloadSize(paths.target);

    const tempDir = path.join(path.dirname(paths.target), `${TMP_PREFIX}dir-${randomBytes(6).toString('hex')}`);
    try {
      await copyTree(source, tempDir);
    } catch (err) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    // 换位落盘：旧载荷先挪走 → 新目录 rename 上去 → 删旧的。
    // 并发写同一个 key 时可能撞上别人刚 rename 进来的目录，重试几次；
    // 一直撞就当作「别人先落盘」，以先落盘者为准。
    let placed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !placed; attempt += 1) {
      const oldPath = await stashPayload(paths.target);
      try {
        await fs.rename(tempDir, paths.target);
        placed = true;
        if (oldPath) await fs.rm(oldPath, { recursive: true, force: true }).catch(() => {});
      } catch (err) {
        lastError = err;
        if (!(await restorePayload(oldPath, paths.target)) && oldPath) {
          // 放不回去 = 别人已经把新版本 rename 进来了，旧载荷作废，删掉别留垃圾
          await fs.rm(oldPath, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
    if (!placed) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (lastError && (lastError.code === 'ENOTEMPTY' || lastError.code === 'EEXIST')) {
        log.debug?.('[mmgrep/cache] putDir 并发写同一个 key，以先落盘者为准');
      } else if (lastError) {
        throw lastError;
      }
    }

    const size = await dirSize(paths.target);
    await writeMeta(paths, { type: 'dir', size, key });
    noteWrite(previousSize, size);
    await maybeSweep();
    return paths.target;
  }

  /**
   * 准备一个**产物目录**条目：建好目录并返回路径。
   *
   * server 想把 content.md / segments.jsonl / manifest.json / images/
   * 直接写进缓存时：先 `prepareDir(key)` 拿到目录，往里写文件，
   * 写完再 `register(key)` 登记（记录大小与使用时间）。
   *
   * @param {string} key
   * @returns {Promise<string>} 缓存内的目录绝对路径
   */
  async function prepareDir(key) {
    const paths = entryPaths(key);
    await fs.mkdir(paths.target, { recursive: true });
    return paths.target;
  }

  /**
   * 登记一个**已经由调用方直接写进缓存目录**的条目。
   *
   * server 想把 content.md / segments.jsonl / manifest.json / images/
   * 直接写进 `getPath(key)` 时，写完之后调这个方法登记：
   * 记录条目类型、递归大小与使用时间，sweep 才知道怎么算容量、怎么清。
   *
   * @param {string} key
   * @returns {Promise<{ path: string, type: 'file'|'dir', size: number }>}
   */
  async function register(key) {
    const paths = entryPaths(key);
    const stat = await statSafe(paths.target);
    if (!stat) {
      throw new Error(`[mmgrep/cache] register: 条目不存在：${paths.target}`);
    }
    const type = stat.isDirectory() ? 'dir' : 'file';
    const size = type === 'dir' ? await dirSize(paths.target) : stat.size;
    const existing = await readMeta(paths.metaPath);
    await writeMeta(paths, { type, size, key });
    noteWrite(Number.isFinite(existing?.size) ? existing.size : 0, size);
    await maybeSweep();
    return { path: paths.target, type, size };
  }

  /**
   * 条目是否存在（文件型或目录型都算）。
   *
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async function has(key) {
    const { target } = entryPaths(key);
    const stat = await statSafe(target);
    return Boolean(stat && (stat.isFile() || stat.isDirectory()));
  }

  /**
   * 更新条目的使用时间（供 LRU 排序）。
   *
   * @param {string} key
   * @returns {Promise<boolean>} 条目是否存在（不存在返回 false）
   */
  async function touch(key) {
    const paths = entryPaths(key);
    const stat = await statSafe(paths.target);
    if (!stat) return false;
    const size = stat.isDirectory() ? await dirSize(paths.target) : stat.size;
    const existing = await readMeta(paths.metaPath);
    await writeMeta(paths, { type: stat.isDirectory() ? 'dir' : 'file', size, key });
    noteWrite(Number.isFinite(existing?.size) ? existing.size : 0, size);
    return true;
  }

  /**
   * 缓存统计。
   *
   * @returns {Promise<{ dir: string, entries: number, bytes: number, maxBytes: number }>}
   */
  async function stats() {
    const info = await scan();
    state.bytes = info.bytes;
    state.entries = info.entries.length;
    state.scanned = true;
    return {
      dir: root,
      entries: state.entries,
      bytes: state.bytes,
      maxBytes: limit,
    };
  }

  /**
   * 按 LRU 淘汰，直到缓存总大小 ≤ maxBytes。
   *
   * 同时清理「陈旧」的临时文件（进程崩溃留下的半截文件）。
   *
   * @returns {Promise<{ removed: string[], removedKeys: string[], freedBytes: number }>}
   *   `removed` 是被删掉的条目路径；
   *   `removedKeys` 是其中能还原成 `sha256:...` 形式 key 的那些（尽力而为）。
   */
  async function sweep() {
    const info = await scan();
    state.bytes = info.bytes;
    state.entries = info.entries.length;
    state.scanned = true;

    // 1) 清理陈旧临时文件。只删「明显是崩溃遗留」的（mtime 很旧），
    //    避免删掉别的进程正在写的临时文件。
    const staleBefore = Date.now() - STALE_TEMP_MS;
    for (const temp of info.temps) {
      if (temp.mtimeMs >= staleBefore) continue;
      await fs.rm(temp.path, { recursive: true, force: true }).catch(() => {});
    }

    // 2) 按 lastUsed 从旧到新淘汰
    const removed = [];
    const removedKeys = [];
    let freedBytes = 0;

    if (state.bytes > limit) {
      const ordered = info.entries
        .slice()
        .sort(
          (a, b) =>
            a.lastUsed - b.lastUsed ||
            (String(a.key ?? '') < String(b.key ?? '') ? -1 : String(a.key ?? '') > String(b.key ?? '') ? 1 : 0),
        );

      for (let i = 0; i < ordered.length; i += 1) {
        if (state.bytes <= limit) break;
        const item = ordered[i];
        // 最后一条（最新写入的）永远保留：单个产物比整个缓存还大时，
        // 立刻把它删掉会让上层返回一个已经不存在的路径，比超限更糟。
        if (i === ordered.length - 1) break;
        await fs.rm(item.path, { recursive: true, force: true }).catch(() => {});
        await fs.rm(item.metaPath, { force: true }).catch(() => {});
        state.bytes = Math.max(0, state.bytes - item.size);
        state.entries = Math.max(0, state.entries - 1);
        freedBytes += item.size;
        removed.push(item.path);
        if (item.key) removedKeys.push(item.key);
      }
      await pruneEmptyShardDirs();
    }

    if (removed.length > 0) {
      log.debug?.(
        `[mmgrep/cache] LRU 淘汰 ${removed.length} 条，释放 ${freedBytes} 字节（上限 ${limit}）`,
      );
    }
    return { removed, removedKeys, freedBytes };
  }

  /**
   * 清空缓存里**本模块登记过的**内容（测试与用户显式清理用）。
   *
   * 只删：登记过的条目、条目记录、临时文件、指纹索引。
   * **不动**别人放在缓存目录里的其它文件。
   *
   * @returns {Promise<void>}
   */
  async function clear() {
    await fs.mkdir(root, { recursive: true });
    const info = await scan();
    for (const item of info.entries) {
      await fs.rm(item.path, { recursive: true, force: true }).catch(() => {});
      await fs.rm(item.metaPath, { force: true }).catch(() => {});
    }
    for (const temp of info.temps) {
      await fs.rm(temp.path, { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(path.join(root, FINGERPRINT_INDEX_FILE), { force: true }).catch(() => {});
    await pruneEmptyShardDirs();
    fingerprintCache = null;
    state.bytes = 0;
    state.entries = 0;
    state.scanned = true;
  }

  /**
   * 确保缓存目录存在（写入前调用）。
   *
   * @returns {Promise<string>} 缓存目录绝对路径
   */
  async function init() {
    await fs.mkdir(root, { recursive: true });
    return root;
  }

  /* ------------------------------------------------------------------ *
   * 指纹索引：路径 + 大小 + mtime → 内容 hash
   * ------------------------------------------------------------------ */

  /**
   * 用指纹查内容 hash（快速路径：省掉一次全文件哈希）。
   *
   * @param {string|{ path: string, size: number, mtimeMs: number }} fingerprint
   *   可以直接给指纹字符串，也可以给 { path, size, mtimeMs } 让缓存自己算。
   * @returns {Promise<{ sha256: string, key: string }|null>}
   */
  async function lookupFingerprint(fingerprint) {
    const index = await readFingerprintIndex();
    const fp = typeof fingerprint === 'string' ? fingerprint : fingerprintFor(fingerprint);
    let record = index.entries[fp];
    if (!record && fp.length < 64) {
      // 允许用指纹前缀查（前 16 位那种）
      const hit = Object.entries(index.entries).find(([key]) => key.startsWith(fp));
      if (hit) record = hit[1];
    }
    if (!record || typeof record.sha256 !== 'string' || !SHA256_HEX_RE.test(record.sha256)) {
      return null;
    }
    return { sha256: record.sha256, key: `sha256:${record.sha256}` };
  }

  /**
   * 记一条指纹 → 内容 hash 的映射。
   *
   * @param {{ path: string, size: number, mtimeMs: number, sha256: string }} spec
   * @returns {Promise<void>}
   */
  async function recordFingerprint(spec) {
    const { path: filePath, size, mtimeMs, sha256 } = spec ?? {};
    if (typeof filePath !== 'string' || typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256)) {
      throw new Error('[mmgrep/cache] recordFingerprint: 需要 { path, size, mtimeMs, sha256（64 位十六进制） }');
    }
    const fp = fingerprintFor({ path: filePath, size, mtimeMs });
    const index = await readFingerprintIndex();
    index.entries[fp] = { sha256, size, mtimeMs, path: filePath, at: Date.now() };
    await writeFingerprintIndex(index);
  }

  /**
   * 取一个源文件的内容 hash key（server 最常用的一条路）。
   *
   * 先看指纹索引；命中 → 直接复用上次算出来的内容 sha256（**不重新全文件哈希**）；
   * 不命中（文件改了 / 首次访问 / 索引损坏）→ 全文件算 sha256 并把新指纹写回索引。
   *
   * 注意：指纹假设「文件内容变了 → 大小或 mtime 也会变」。极端情况
   * （内容被改但大小和 mtime 完全一样）会误命中，这是指纹法的固有代价，
   * 因此指纹只用来省 hash，缓存主键仍然是内容 sha256。
   *
   * @param {string} filePath 源文件路径
   * @returns {Promise<{ sha256: string, key: string, size: number, fromFingerprint: boolean }>}
   */
  async function contentKeyForFile(filePath) {
    const absolute = path.resolve(filePath);
    const stat = await fs.stat(absolute); // 不存在就让调用方自己处理 ENOENT
    const cached = await lookupFingerprint({
      path: absolute,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    if (cached) {
      return {
        sha256: cached.sha256,
        key: cached.key,
        size: stat.size,
        fromFingerprint: true,
      };
    }
    const { sha256, size } = await hashFile(absolute);
    try {
      await recordFingerprint({
        path: absolute,
        size,
        mtimeMs: stat.mtimeMs,
        sha256,
      });
    } catch (err) {
      // 指纹索引写失败不影响主流程（只是下次多算一次 hash）
      log.warn?.(`[mmgrep/cache] 写指纹索引失败：${err.message}`);
    }
    return { sha256, key: `sha256:${sha256}`, size, fromFingerprint: false };
  }

  /**
   * 读取指纹索引（损坏时优雅降级成空索引）。
   *
   * 内存里会缓存一份；每次读之前用文件的 mtime + size 判断有没有被**别的进程**
   * 改过，改过就重新读盘（多进程共享同一个缓存目录时不会读到过期索引）。
   *
   * @returns {Promise<{ version: number, entries: object }>}
   */
  async function readFingerprintIndex() {
    const file = path.join(root, FINGERPRINT_INDEX_FILE);
    const stat = await statSafe(file);
    const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : 'missing';
    if (fingerprintCache && fingerprintCache.stamp === stamp) return fingerprintCache;

    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        fingerprintCache = { version: parsed.version ?? 1, entries: parsed.entries, stamp };
        return fingerprintCache;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 索引损坏：忽略它，下一次写入时重建
        log.warn?.(`[mmgrep/cache] 指纹索引损坏，已忽略：${err.message}`);
      }
    }
    fingerprintCache = { version: 1, entries: {}, stamp: 'missing' };
    return fingerprintCache;
  }

  /**
   * 写指纹索引（原子写）。
   *
   * 并发策略：先读 → 合并 → 写临时文件 → 落盘前再检查一次索引有没有被别人改过；
   * 改过了说明**别人先落盘**，以先落盘者为准，放弃本次写入（自己的那条指纹
   * 下次再记一遍即可，丢一条指纹最坏只是多算一次 hash）。
   *
   * @param {{ version: number, entries: object }} index
   * @returns {Promise<void>}
   */
  async function writeFingerprintIndex(index) {
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, FINGERPRINT_INDEX_FILE);
    const before = await statSafe(file);

    // 超出上限就丢最旧的
    const entries = Object.entries(index.entries);
    if (entries.length > MAX_FINGERPRINTS) {
      entries.sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
      for (const [key] of entries.slice(0, entries.length - MAX_FINGERPRINTS)) {
        delete index.entries[key];
      }
    }

    const payload = JSON.stringify(
      { version: 1, updatedAt: Date.now(), entries: index.entries },
      null,
      0,
    );
    const tempPath = await tempPathFor(root);
    await fs.writeFile(tempPath, payload, 'utf8');
    if (fsync) await syncFile(tempPath);

    // 「先落盘者为准」：落盘前确认没人抢先改过索引
    const now = await statSafe(file);
    const changed =
      (before === null) !== (now === null) ||
      (before && now && (before.mtimeMs !== now.mtimeMs || before.size !== now.size));
    if (changed) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      fingerprintCache = null; // 内存缓存作废，下次重新读盘
      return;
    }
    await fs.rename(tempPath, file);
    const after = await statSafe(file);
    fingerprintCache = {
      version: 1,
      entries: index.entries,
      stamp: after ? `${after.mtimeMs}:${after.size}` : 'missing',
    };
  }

  /* ------------------------------------------------------------------ *
   * 内部：条目路径、记录、扫描
   * ------------------------------------------------------------------ */

  /**
   * 算出条目相关路径。
   *
   * @param {string} key
   * @returns {{ target: string, metaPath: string, shard: string, stem: string }}
   */
  function entryPaths(key) {
    const safeKey = assertSafeKey(key);
    const { shard, stem } = layoutFor(safeKey);
    const target = path.resolve(root, shard, stem);
    // 兜底：解析之后必须仍在 root 之内，否则说明 key 校验有漏洞，直接拒绝
    const relative = path.relative(root, target);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      const err = new Error(`[mmgrep/cache] 缓存路径越界：${key} → ${target}`);
      err.code = 'ERR_CACHE_PATH_ESCAPE';
      throw err;
    }
    return {
      target,
      metaPath: path.resolve(root, shard, `${META_PREFIX}${stem}.json`),
      shard,
      stem,
    };
  }

  /**
   * 写条目记录（原子写）。
   *
   * @param {{ metaPath: string, target: string }} paths
   * @param {{ type: 'file'|'dir', size: number, key?: string }} info
   */
  async function writeMeta(paths, { type, size, key }) {
    const now = nextLastUsed();
    const createdAt = Date.now();
    const existing = await readMeta(paths.metaPath);
    const meta = {
      key: key ?? existing?.key ?? null,
      type,
      size,
      created: existing?.created ?? createdAt,
      lastUsed: now,
    };
    const tempPath = await tempPathFor(path.dirname(paths.metaPath));
    await fs.writeFile(tempPath, JSON.stringify(meta), 'utf8');
    if (fsync) await syncFile(tempPath);
    await fs.rename(tempPath, paths.metaPath);
  }

  /**
   * 读条目记录（损坏时返回 null）。
   *
   * @param {string} metaPath
   * @returns {Promise<object|null>}
   */
  async function readMeta(metaPath) {
    try {
      const raw = await fs.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * 扫描缓存目录，列出条目 / 临时文件，并统计总字节数。
   *
   * @returns {Promise<{ entries: object[], temps: object[], bytes: number }>}
   */
  async function scan() {
    const entries = [];
    const temps = [];
    let bytes = 0;

    const shardNames = await readDirSafe(root);
    for (const shardName of shardNames) {
      if (shardName.startsWith('.')) continue;
      const shardPath = path.join(root, shardName);
      const shardStat = await statSafe(shardPath);
      if (!shardStat || !shardStat.isDirectory()) continue;

      const names = await readDirSafe(shardPath);
      const payloads = new Map(); // stem → 载荷信息
      const metas = new Map(); // stem → 记录

      for (const name of names) {
        const filePath = path.join(shardPath, name);
        const stat = await statSafe(filePath);
        if (!stat) continue;

        if (name.startsWith(TMP_PREFIX)) {
          temps.push({
            path: filePath,
            name,
            size: stat.isDirectory() ? await dirSize(filePath) : stat.size,
            mtimeMs: stat.mtimeMs,
          });
          continue;
        }

        const metaMatch = META_NAME_RE.exec(name);
        if (metaMatch) {
          metas.set(metaMatch[1], { path: filePath, meta: await readMeta(filePath) });
          continue;
        }

        if (!ENTRY_NAME_RE.test(name)) continue; // 不是本模块的条目名 → 不碰
        payloads.set(name, { path: filePath, stat });
      }

      for (const [stem, payload] of payloads) {
        const meta = metas.get(stem)?.meta ?? null;
        const isDir = payload.stat.isDirectory();
        const size = isDir ? await dirSize(payload.path) : payload.stat.size;
        const metaPath = path.join(shardPath, `${META_PREFIX}${stem}.json`);
        const lastUsed = Number.isFinite(meta?.lastUsed) ? meta.lastUsed : payload.stat.mtimeMs;
        bytes += size;

        // 没有记录的条目（崩溃遗留 / 直接写进来的）：补登记，之后才能被清理
        if (!meta) {
          const adopted = {
            key: keyFromStem(shardName, stem),
            type: isDir ? 'dir' : 'file',
            size,
            created: payload.stat.mtimeMs,
            lastUsed: payload.stat.mtimeMs,
          };
          const tempPath = await tempPathFor(shardPath);
          await fs.writeFile(tempPath, JSON.stringify(adopted), 'utf8').catch(() => {});
          await fs.rename(tempPath, metaPath).catch(() => {});
          await fs.rm(tempPath, { force: true }).catch(() => {});
        }

        entries.push({
          key: meta?.key ?? keyFromStem(shardName, stem),
          stem,
          shard: shardName,
          path: payload.path,
          metaPath,
          type: isDir ? 'dir' : 'file',
          size,
          lastUsed,
        });
      }
    }

    // 说明：容量口径 = **条目载荷的字节数**（目录型条目算递归大小）。
    // 条目记录文件、指纹索引、临时文件都是几百字节级别的开销，不计入额度。
    return { entries, temps, bytes };
  }

  /** 删掉空的分片目录 */
  async function pruneEmptyShardDirs() {
    const shardNames = await readDirSafe(root);
    for (const shardName of shardNames) {
      if (shardName.startsWith('.')) continue;
      const shardPath = path.join(root, shardName);
      const shardStat = await statSafe(shardPath);
      if (!shardStat || !shardStat.isDirectory()) continue;
      const remaining = await readDirSafe(shardPath);
      if (remaining.length === 0) {
        await fs.rmdir(shardPath).catch(() => {});
      }
    }
  }

  /**
   * 取下一个「最后使用时间」：进程内严格递增，避免同一毫秒内多次访问排不出先后。
   *
   * @returns {number} 毫秒时间戳
   */
  function nextLastUsed() {
    const now = Date.now();
    lastUsedStamp = now > lastUsedStamp ? now : lastUsedStamp + 1;
    return lastUsedStamp;
  }

  /**
   * 计算一个载荷当前占多少字节（文件型直接 stat，目录型递归累加）。
   *
   * @param {string} target
   * @returns {Promise<number>}
   */
  async function payloadSize(target) {
    const stat = await statSafe(target);
    if (!stat) return 0;
    return stat.isDirectory() ? dirSize(target) : stat.size;
  }

  /**
   * 记录一次写入对内存估算的影响。
   *
   * 只是估算：真正的数字以 stats()/sweep() 的磁盘扫描为准。
   *
   * @param {number} previousSize 写入前该条目的字节数（没有则 0）
   * @param {number} newSize 写入后的字节数
   */
  function noteWrite(previousSize, newSize) {
    if (!state.scanned) return; // 还没扫过盘，等下次扫描时自然校准
    state.bytes = Math.max(0, state.bytes - (previousSize || 0) + (newSize || 0));
  }

  /** 写入后如果超限就自动淘汰 */
  async function maybeSweep() {
    if (!autoSweep) return;
    await ensureScanned();
    if (state.bytes > limit) await sweep();
  }

  /** 第一次用到容量估算时先扫一次盘 */
  async function ensureScanned() {
    if (state.scanned) return;
    const info = await scan();
    state.bytes = info.bytes;
    state.entries = info.entries.length;
    state.scanned = true;
  }

  /**
   * 写临时文件并返回它的路径（不负责 rename）。
   *
   * @param {string} dirPath 临时文件所在目录（必须与目标同目录，保证 rename 原子）
   * @param {Buffer} bytes
   * @returns {Promise<string>}
   */
  async function writeTemp(dirPath, bytes) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const tempPath = await tempPathFor(dirPath);
      let handle;
      try {
        // 'wx'：文件已存在就失败，保证不会撞名
        handle = await fs.open(tempPath, 'wx');
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        throw err;
      }
      try {
        await handle.writeFile(bytes);
        if (fsync) await handle.sync();
      } catch (err) {
        await handle.close().catch(() => {});
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw err;
      }
      await handle.close();
      return tempPath;
    }
    throw new Error('[mmgrep/cache] 无法创建临时文件（连续撞名）');
  }

  /** 生成一个唯一的临时文件路径 */
  async function tempPathFor(dirPath) {
    const name = `${TMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`;
    return path.join(dirPath, name);
  }

  /**
   * 把载荷挪到一边（换位写入用）。
   *
   * @param {string} target
   * @returns {Promise<string|null>} 旧载荷挪到的路径（没有旧载荷时返回 null）
   */
  async function stashPayload(target) {
    const stat = await statSafe(target);
    if (!stat) return null;
    // 名字必须以 .tmp- 开头：扫描时会被当成临时文件，不会被误认成 variant 条目
    const stash = path.join(path.dirname(target), `${TMP_PREFIX}old-${randomBytes(4).toString('hex')}`);
    try {
      await fs.rename(target, stash);
      return stash;
    } catch (err) {
      // 并发写：stat 之后、rename 之前被别人挪走了——当作没有旧载荷
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * 把挪走的旧载荷放回去（换位失败时回滚）。
   *
   * @param {string|null} stash
   * @param {string} target
   * @returns {Promise<boolean>} 是否真的放回去了
   */
  async function restorePayload(stash, target) {
    if (!stash) return false;
    const stat = await statSafe(stash);
    if (!stat) return false;
    try {
      await fs.rename(stash, target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 为准写入单个文件做准备：旧载荷是目录就先删掉，是文件就留着让 rename 覆盖。
   *
   * @param {string} target
   * @returns {Promise<number>} 旧载荷占用的字节数（没有则 0）
   */
  async function prepareForFileWrite(target) {
    const stat = await statSafe(target);
    if (!stat) return 0;
    if (stat.isDirectory()) {
      const size = await dirSize(target);
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      return size;
    }
    return stat.size;
  }

  return {
    /** 缓存目录（绝对路径） */
    dir: root,
    /** 容量上限（字节） */
    maxBytes: limit,
    getPath,
    get,
    put,
    putFile,
    putDir,
    prepareDir,
    register,
    has,
    touch,
    stats,
    sweep,
    clear,
    init,
    lookupFingerprint,
    recordFingerprint,
    contentKeyForFile,
  };
}

/**
 * 计算 key 的磁盘布局：分片目录名 + 条目文件名。
 *
 * - `sha256:<64hex>[:<variant>]` → 直接用内容摘要（分片均匀、路径可读）
 * - 其它形态的 key → 用 `sha256(key)`
 *
 * @param {string} key 已通过 assertSafeKey
 * @returns {{ shard: string, stem: string, digest: string }}
 */
function layoutFor(key) {
  const match = SHA_KEY_RE.exec(key);
  let digest;
  let variant = null;
  if (match) {
    digest = match[1].toLowerCase();
    variant = match[2] ?? null;
  } else {
    digest = hashBuffer(key);
  }
  let stem = digest.slice(2);
  if (variant !== null && variant !== '') {
    stem += `.${encodeSegment(variant)}`;
  }
  if (stem.length > MAX_STEM_LENGTH) {
    const err = new Error(`[mmgrep/cache] 缓存 key "${key}" 过长（变体部分太长）`);
    err.code = 'ERR_CACHE_INVALID_KEY';
    throw err;
  }
  return { shard: digest.slice(0, 2), stem, digest };
}

/**
 * 从分片名 + 条目文件名还原 `sha256:...` 形式的 key（尽力而为）。
 *
 * 其它形态的 key 是 `sha256(key)` 的摘要，**无法**从路径反推。
 *
 * @param {string} shard
 * @param {string} stem
 * @returns {string|null}
 */
function keyFromStem(shard, stem) {
  const base = stem.slice(0, 62);
  if (!/^[0-9a-f]{62}$/.test(base)) return null;
  const hex = shard + base;
  if (stem.length === 62) return `sha256:${hex}`;
  if (stem[62] !== '.') return null;
  const variant = decodeSegment(stem.slice(63));
  return variant ? `sha256:${hex}:${variant}` : `sha256:${hex}`;
}

/**
 * 变体字符串 → 文件名安全的编码（百分号编码）。
 *
 * 只保留 `[A-Za-z0-9._-]`，其余按 UTF-8 字节做 `%XX` 编码。
 * 因为 `%` 本身不在保留字符里，编码是**单射**的（不会撞名）。
 *
 * @param {string} value
 * @returns {string}
 */
function encodeSegment(value) {
  const bytes = Buffer.from(value, 'utf8');
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9._-]/.test(char)) {
      out += char;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * 文件名安全编码 → 原字符串（encodeSegment 的逆运算）。
 *
 * @param {string} value
 * @returns {string}
 */
function decodeSegment(value) {
  const bytes = [];
  for (let i = 0; i < value.length; i += 1) {
    if (
      value[i] === '%' &&
      i + 2 < value.length &&
      /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))
    ) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 统一输入成 Buffer。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|string} input
 * @returns {Buffer}
 */
function toBuffer(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (Buffer.isBuffer(input)) return input;
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new TypeError('[mmgrep/cache] put 只接受 Buffer / Uint8Array / string');
}

/**
 * 校验并归一化容量上限。
 *
 * @param {string|number} value
 * @returns {number}
 */
function normalizeLimit(value) {
  const bytes = resolveMaxBytes(value);
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`[mmgrep/cache] 非法容量上限：${String(value)}`);
  }
  return bytes;
}

/**
 * 读目录，目录不存在时返回空数组。
 *
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
async function readDirSafe(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

/**
 * stat，文件不存在时返回 null。
 *
 * @param {string} target
 * @returns {Promise<import('node:fs').Stats|null>}
 */
async function statSafe(target) {
  try {
    return await fs.stat(target);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * 递归复制目录（自己实现，避免依赖 Node 20 上还是实验性的 fs.cp）。
 *
 * @param {string} source
 * @param {string} dest
 * @returns {Promise<void>}
 */
async function copyTree(source, dest) {
  const stat = await fs.stat(source); // 跟随符号链接
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    for (const name of await fs.readdir(source)) {
      await copyTree(path.join(source, name), path.join(dest, name));
    }
    return;
  }
  if (stat.isFile()) {
    await fs.copyFile(source, dest);
  }
}

/**
 * 递归统计目录里所有文件的字节数。
 *
 * @param {string} dirPath
 * @returns {Promise<number>}
 */
async function dirSize(dirPath) {
  let total = 0;
  const names = await readDirSafe(dirPath);
  for (const name of names) {
    const stat = await statSafe(path.join(dirPath, name));
    if (!stat) continue;
    if (stat.isDirectory()) total += await dirSize(path.join(dirPath, name));
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

/**
 * fsync 一个文件（保证断电后内容不残缺）。
 *
 * @param {string} target
 * @returns {Promise<void>}
 */
async function syncFile(target) {
  const handle = await fs.open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
