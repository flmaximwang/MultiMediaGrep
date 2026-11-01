# 缓存模块（`src/cache`）

MultiMediaGrep 的 **server 侧内容缓存**：把「同一条视频/录音/文档反复要的产物」
（分镜宫格图、特写图、`content.md`、`segments.jsonl`、`manifest.json`、`images/` …）
存下来，第二次直接给，不再重跑抽帧 / ASR / 排版。

两条硬规则：

1. **绝不写到用户文件旁边。** 缓存只有一个根目录（默认 `~/.cache/multimediagrep`），
   所有写入都在这个目录内部完成。用户把 `foo.mp4` 放哪儿，缓存都不会在旁边生成任何东西。
2. **按内容 hash 键控。** 键是源文件内容的 sha256，不是「路径 + 大小 + mtime」——
   文件内容一变，key 就变，缓存自然失效，不会出现「文件改了还命中旧产物」。

```js
import { createCache, resolveCacheConfig } from '../cache/index.js';
import { hashFile, contentKey } from '../cache/hash.js';

const cache = createCache();                   // 默认 ~/.cache/multimediagrep，上限 10GB
const { sha256 } = await hashFile('/videos/a.mp4');
const key = contentKey({ sha256, variant: 'grid-4x3' });

if (await cache.has(key)) {
  return { path: cache.getPath(key) };         // 命中：直接把路径返回给 agent
}
const outPath = await cache.putFile(key, '/tmp/agent-work/grid.jpg'); // 未命中：落缓存
return { path: outPath };
```

---

## 键控：内容 hash + 指纹索引

### 主键 = 内容 hash

```
sha256:<64 位 hex>              同一份内容的默认产物
sha256:<64 位 hex>:<variant>    同一份内容的不同产物（grid-4x3 / zoom-0-12 / content …）
```

`variant` 是「同一源文件、不同参数」的分桶。它只允许 `[A-Za-z0-9._-]`，
`:` 用作分段，其它字符一律拒绝（见下面的「key 安全」）。

**条目路径直接由内容 hash 决定**：`<根目录>/<hash 前 2 位>/<hash 其余 62 位>`，
`sha256:` 前缀不参与路径。所以缓存是自描述的：内容相同 → 同一个 key → 同一个路径。

### 指纹索引（省掉重复的全文件哈希）

内容 hash 要对整个文件算一次 sha256。视频动辄几个 GB，每次都全量哈希太贵，
所以额外维护一份**快速指纹索引** `<根目录>/fingerprint-index.json`：

```
fingerprint = sha256(绝对路径 + ':' + size + ':' + mtimeMs)
fingerprint → 内容 sha256
```

- 命中指纹 → 直接复用上次算出来的内容 sha256，**不重新读文件**；
- 不命中（首次访问 / 文件改了 / 索引损坏）→ 全文件流式计算 sha256，并把新指纹写回索引。

指纹只是**加速钥匙**，不是缓存主键：它假设「内容变了 → 大小或 mtime 也会变」。
极端情况（内容被改但大小和 mtime 分毫未变）会误命中，所以真正决定缓存键的永远是内容 sha256。

索引的并发与容错：

- 写入用「临时文件 + `rename`」原子替换；
- 落盘前会再检查一次索引有没有被别人改过，**以先落盘者为准**（放弃本次写入），
  丢一条指纹最坏只是下次多算一次 hash；
- 读到的 JSON 损坏 → 记一条 warn、当作空索引继续跑，下一次写入时重建；
- 最多保留 5000 条，超出按最旧丢弃。

---

## 目录结构

```
<dir>/fingerprint-index.json          指纹索引
<dir>/<shard>/<stem>                  文件型条目：单个产物
<dir>/<shard>/<stem>/                 目录型条目：产物目录
                                      （content.md / segments.jsonl / manifest.json / images/ …）
<dir>/<shard>/.meta-<stem>.json       条目记录：key / 类型 / 大小 / 创建与最后使用时间
<dir>/<shard>/.tmp-<pid>-<rand>       写入过程中的临时文件（读取时忽略，sweep 清理）
```

- `shard` = 内容摘要前 2 位十六进制（256 个分片，避免单目录文件过多）；
- `stem` = 内容摘要其余 62 位，带 variant 时追加 `.<variant>`（特殊字符做百分号编码，
  例如 `zoom:00:12` → `zoom%3A00%3A12`）；
- 文件名一律只含 `[0-9a-f]`、`.`、`%`、`-`、`_`、字母数字——**没有 `/`，也没有 `..`**。

---

## API

### `resolveCacheConfig(env = process.env) -> { dir, maxBytes }`

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MMGREP_CACHE_DIR` | `~/.cache/multimediagrep` | `~` 展开成 home；相对路径按 `process.cwd()` 解析 |
| `MMGREP_CACHE_MAX_BYTES` | `10 * 1024 ** 3`（10GB） | 支持 `512MB` / `10GB` / `1024` / `1.5GB`；KB/MB/GB/TB 按 1024 进制 |

非法值（例如 `lots`）会抛带说明的错误，而不是悄悄退回默认值。

### `createCache({ dir, maxBytes, logger, autoSweep, fsync }) -> cache`

同步构造，不碰磁盘（目录在第一次写入时创建）。`logger` 可选，未提供时静默；
**不要**传 `console`——MCP server 的 stdout 是 JSON-RPC 通道。

### cache 方法

| 方法 | 说明 |
|---|---|
| `getPath(key)` | 该条目的绝对路径。**只算路径，不保证存在**。大产物走这条。 |
| `get(key) -> Buffer \| null` | 小产物读回内存；不存在返回 `null`；目录型条目抛 `ERR_CACHE_NOT_A_FILE`。 |
| `put(key, data) -> path` | 写单个文件。`data` 可为 `Buffer / Uint8Array / string`。原子写。 |
| `putFile(key, srcPath) -> path` | 把外部文件**复制**进缓存（不占内存，源文件不动）。 |
| `putDir(key, srcDir) -> path` | 把产物目录整体复制进缓存（`content.md` + `images/` 等）。 |
| `prepareDir(key) -> path` | 建好条目目录交给调用方自己写（配 `register`）。 |
| `register(key) -> {path,type,size}` | 登记「调用方直接写进缓存」的条目（递归算大小、刷新使用时间）。 |
| `has(key) -> boolean` | 文件型、目录型都算存在。 |
| `touch(key) -> boolean` | 刷新 `lastUsed`（供 LRU）；条目不存在返回 `false`。 |
| `stats() -> {dir,entries,bytes,maxBytes}` | `bytes` = 条目载荷的字节数（目录按递归大小；不含记录/索引开销）。 |
| `sweep() -> {removed,removedKeys,freedBytes}` | 立刻按 LRU 淘汰到 ≤ `maxBytes`；`removed` 是条目路径，`removedKeys` 是能还原出来的 key。 |
| `clear() -> void` | 清掉**本模块登记过的**条目、记录、临时文件和指纹索引；别人的文件不动。 |
| `init() -> dir` | 确保缓存目录存在。 |
| `lookupFingerprint(fp \| {path,size,mtimeMs})` | 指纹查内容 hash（支持前 16 位前缀查询）。 |
| `recordFingerprint({path,size,mtimeMs,sha256})` | 手工记一条指纹。 |
| `contentKeyForFile(filePath) -> {sha256,key,size,fromFingerprint}` | 一步到位：stat → 查指纹 → 必要时全文件 hash → 记指纹。 |

### key 安全

`assertSafeKey`（`src/cache/hash.js`）在**每一层**都跑：

- key 必须是字符串、非空、≤ 200 字符；
- 用 `:` 分段，每段只允许 `[A-Za-z0-9._-]`，且不能是 `.` / `..`；
- `getPath` 里再兜底一次：`path.relative(root, target)` 必须以正常相对路径开头且不含 `..`，
  否则抛 `ERR_CACHE_PATH_ESCAPE`。

所以 `../evil`、`../../etc/passwd`、`a/b`、绝对路径、空格、控制字符全部被拒绝，
**不可能**写到缓存目录之外。

---

## LRU 与容量

**依据：条目记录里的 `lastUsed`（毫秒时间戳），不用文件 mtime、不用 atime。**

理由：

- 产物**可以是目录**（`content.md` + `images/`）。目录的 mtime 只在子项增删时变，
  「读过」并不会改它——对目录型条目，mtime 做 LRU 是不准的。
- atime 不可靠：Linux 默认 `relatime`、很多挂载点是 `noatime`，macOS/APFS 的 atime 更新也是延迟的。
- 显式记录还能顺带存 `size` / `created` / 类型，`sweep` 与 `stats` 不用猜。
- 没有记录的条目（崩溃遗留、调用方直接写进缓存）按载荷 mtime 兜底，
  并在下一次磁盘扫描时补登记，之后就能正常参与 LRU。

淘汰规则：

- `put / putFile / putDir / register` 之后如果估算总量超过 `maxBytes`，**自动** `sweep()`
  （`autoSweep: false` 可关掉，测试用）；
- 按 `lastUsed` 从旧到新删，删到总量 ≤ 上限为止；
- **最新的一条永远保留**：单个产物比整个缓存还大时，缓存会暂时超限，
  而不是把刚写好的、马上要返回给 agent 的路径删掉；
- 陈旧临时文件（mtime 超过 1 小时）一并清理；新鲜的临时文件不动
  （那可能是别的进程**正在写**的）。

---

## 并发与原子性

- **单条目写入**：同目录唯一临时文件（`.tmp-<pid>-<rand>`，`O_EXCL` 打开）→ `fsync` → `rename`。
  `rename` 是原子的，所以：
  - 进程被 kill 不会留下半截文件（最坏留一个 `.tmp-`，下次 sweep 清掉）；
  - 多个进程同时写同一个 key，后写覆盖先写，文件始终完整，**不会写坏**。
- **目录型条目**：先把旧载荷改名挪开（`.tmp-old-…`），再把新目录 `rename` 上去，
  最后删旧的；中途失败会尝试把旧载荷放回。并发写同一个 key 时可能撞上别人刚
  `rename` 进来的目录，会重试几次；一直撞就**以先落盘者为准**（后写者不覆盖，
  但也不会抛错——同一个 key 的产物内容本来就该一样）。
- **条目记录**（`.meta-*.json`）：临时文件 + `rename`。
- **指纹索引**：临时文件 + `rename` + 「先落盘者为准」的写前复查（见上）。
- 跨进程的总量统计以 `sweep()` / `stats()` 的磁盘扫描为准；进程内的增量计数只用来
  决定「要不要立刻 sweep」。

---

## server 集成要注意

1. **大产物一律用 `putFile` 或 `putDir`**，不要把几十 MB 的图读成 Buffer 再 `put`。
   `get()` 只适合小文本/小 JSON。
2. **图片产物返回路径**：`putFile` / `putDir` / `put` 都返回缓存内的绝对路径，
   直接把它放进 MCP 返回值让 agent 去读；文件型条目用 `getPath(key)` 也能提前算出来。
3. **全文落盘（目录型条目）**：两种写法都行——
   - `await cache.putDir(key, '/tmp/work/doc-1')`：整目录复制进来；
   - `const dir = await cache.prepareDir(key)` → 自己往里写 `content.md` / `images/*`
     → `await cache.register(key)` 登记大小。
   目录型条目 `has()` 为 true、`get()` 会抛 `ERR_CACHE_NOT_A_FILE`，用 `getPath()` 取目录。
4. **先查 `has()` 再算**：命中就直接返回路径，别重复跑重活。
5. **容量上限触发时**：写入后若超限会自动按 LRU 淘汰；`sweep()` 返回的
   `removed` 是**被删条目的路径**（`removedKeys` 是能还原的 key 列表，别的 key 形态反推不出来）。
   如果 server 自己维护了 key→路径的映射，用 `removed` 里的路径去对，别假设它一定非空。
6. **一个巨大产物**（比整个 `maxBytes` 还大）会保留不删，缓存暂时超过上限——这是有意的：
   否则刚写好的产物立刻被删，MCP 会返回一个不存在的路径。
7. **源文件路径只读**：`putFile` / `putDir` 只复制，不移动、不改、不在旁边写任何东西。
8. **指纹索引是加速层**：`contentKeyForFile(path)` 第二次调用会 `fromFingerprint: true`。
   如果文件可能被「改内容但保持大小和 mtime」，请传 `variant` 或干脆自己 `hashFile`。
9. `logger` 别传 `console`（stdout 是 JSON-RPC）；要日志就传 `console.error` 包一层。

---

## 测试

```bash
# 只跑缓存模块
node --test test/cache/*.test.js

# 整个仓库
npm test          # = node --test
```

> Node 22.6+ 里 `node --test <目录>` 的目录参数不再递归展开（会被当成 glob），
> 想按目录跑请写成 `node --test 'test/cache/**/*.test.js'` 或直接 `node --test`。

测试全部在 `os.tmpdir()` 下用 `fs.mkdtemp` 建临时缓存目录，跑完删除；
**不会**碰 `~/.cache/multimediagrep`，也不会往仓库里写任何文件。
