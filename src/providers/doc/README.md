# 文档解析 provider

文档后端（PDF + 图片）复用「probe → overview → zoom」模式：有文字层的 PDF 直接抽文本，
**扫描件（无文字层）需要 OCR**。

0.2.0 起，文档 provider 拆成**两个角色**（契约 v2）：

| 角色 | 做什么 | 环境变量 | 默认 |
| --- | --- | --- | --- |
| **OCR** | 从像素识别字符；只处理**没有文字层**的页（以及 `ocrMode: 'force'` 的页） | `MMGREP_OCR_PROVIDER` = `mineru` \| `none` | `none` |
| **typeset** | 为**有文字层**的页恢复阅读顺序与结构（分栏、标题、段落、图注）；**不得重新识别字符** | `MMGREP_TYPESET_PROVIDER` = `builtin` \| `mineru` \| `none` | `builtin` |

> **typeset 的硬约束**：typeset 角色必须保留 PDF 文字层的原始字符。provider 无法保证
> 字符不被重新识别时，必须把该页的 `textOrigin` 返回为 `'ocr'` 或 `'unknown'`，绝不能
> 谎报 `'textlayer'`。文档后端会据此标注文本可信度（9z5.21）。

本目录提供：

| 文件 | 作用 |
| --- | --- |
| `index.js` | 工厂：按**角色**创建 provider；注册表声明每个 provider 支持哪些角色 |
| `builtin.js` | 内置 typeset provider（本地，不联网；9z5.24 在这里加柱检测 / 重排 / 标题启发式） |
| `mineru.js` | 外部 provider：MinerU 云 API v4（OCR + typeset） |
| `README.md` | 接口说明 + 如何新增 provider |

---

## 1. 工厂与注册表 v2

`index.js` 导出：

```js
export const DOC_ROLES = ['ocr', 'typeset'];
export const DOC_ROLE_ENV = {
  ocr: 'MMGREP_OCR_PROVIDER',
  typeset: 'MMGREP_TYPESET_PROVIDER',
};
export const DOC_ROLE_DEFAULTS = { ocr: 'none', typeset: 'builtin' };

// 每个 provider 声明自己支持的角色（none 不是 provider）。
export const DOC_PROVIDER_REGISTRY = {
  mineru:  { id: 'mineru',  roles: ['ocr', 'typeset'] },
  builtin: { id: 'builtin', roles: ['typeset'] },
};

export function createDocProvider(role, env = process.env, opts = {}) -> provider | null
```

行为：

- `role` 必须是 `'ocr'` / `'typeset'`，否则构造时抛错。
- 角色取值为空 / `none` → 返回 `null`（该角色关闭）。
- `typeset` 默认 `builtin`；`ocr` 默认 `none`。
- provider id 拼错 → 构造时抛错，消息列出该角色允许的取值。
- provider 不支持该角色（例如 `builtin` 当 OCR）→ 构造时抛错并说明它支持哪些角色。
- 外部 provider **没有 key 时构造不抛错**，等 `parse()` 时才抛清晰错误（点名缺哪个变量）。
- `opts` 优先级高于环境变量，常用：
  `{ provider, apiKey, baseUrl, model, timeoutMs, fetchImpl, onProgress, pollIntervalMs }`。
  `opts.provider` 可强制指定 provider id（测试 / server 显式选择时用）。

两个角色**共用** MinerU 的凭据变量（`MMGREP_MINERU_*`）与超时变量
（`MMGREP_DOC_TIMEOUT_MS`）；但各自独立选择 provider。

### 0.2.0 删除的变量

`MMGREP_DOC_PROVIDER` / `MMGREP_DOC_API_KEY` / `MMGREP_DOC_BASE_URL` /
`MMGREP_DOC_MODEL` **不再读取**。如果启动时检测到这些变量，server 会在 stderr 打一条
warning，指出替代变量（`MMGREP_OCR_PROVIDER` / `MMGREP_TYPESET_PROVIDER` /
`MMGREP_MINERU_*`），不会静默忽略。

---

## 2. provider 对象与 parse 契约 v2

```js
{
  id: 'mineru' | 'builtin',
  roles: ['ocr', 'typeset'],        // 该实例支持的角色

  // filePath 必须是本地路径；pages 可选；role / ocrMode 见下。
  async parse({
    filePath,
    pages,
    role = 'both',                  // 'ocr' | 'typeset' | 'both'
    ocrMode = 'auto',               // 'auto' | 'force'
    signal,
    textLayers,                     // 可选：本地 typeset provider 用（见下）
  }) -> {
    provider: 'mineru',
    model: 'vlm' | null,            // null 表示用服务端默认模型
    pages: [
      {
        page: 1,                    // 1 起的页码
        textOrigin: 'textlayer' | 'ocr' | 'unknown',
        blocks: [
          { type: 'heading' | 'paragraph' | 'list' | 'table' | 'caption' |
                  'equation' | 'footnote', level?: 1, text: '...' },
        ],
        text: '...',                // 由 blocks 派生，向后兼容的便利字段
        tables?: [{ rows: [['A','B'], ['1','2']], html, caption, footnote }],
      },
    ],
    raw: { ... },                   // 可选，调试用；绝不包含 token
  },

  describe() -> { id, model, baseUrl, roles }   // 绝不返回 apiKey
}
```

约定：

- `page` 是 **1 起的页码**，与 PDF 页码一致（与 `page_idx` 这类 0 基字段不同）。
- `pages` 按页码升序；**只包含请求范围内的页**。请求的页如果在文档里不存在，
  就不会出现在结果里；提取不到文字时 `text` 为空串、`blocks` 为空数组。
- `textOrigin` 必须是三态之一：
  - `'textlayer'`：字符来自 PDF 原生文字层，未重新识别（可原话引用）；
  - `'ocr'`：字符来自像素识别（数字 / 名称可能错）；
  - `'unknown'`：provider 无法保证字符来源（保守值；下游按 OCR 处理）。
- `text` 是 `blocks` 的派生便利字段；两者不一致时以 `blocks` 为准。
- `blocks` 只允许上面 7 种类型；`heading` 可带正整数 `level`。
- `tables` 可选，但只要有表格，每条至少含 `rows`（`string[][]`）。
- `parse()` 失败时抛出的 `Error` 必须可诊断（见 §5），且**不能包含 token**。
- `textLayers` 是给**本地 typeset provider** 的可选输入：文档后端已经把逐页文字层抽好
  （`pdfSupport.extractTextLayers`），以 `{ [page]: text }` 传入，builtin 直接据此产出
  blocks，避免重复跑 `pdftotext`。外部 provider 可以忽略它。

### role / ocrMode 的语义

| 输入 | 含义 |
| --- | --- |
| `role: 'ocr'` | 这些页需要从像素识别字符；结果 `textOrigin` 应为 `'ocr'`（或 `'unknown'`）。 |
| `role: 'typeset'` | 这些页有文字层，只恢复结构；**不得重新识别字符**。 |
| `role: 'both'` | 同一次调用里同时承担两个角色（两个角色是同一 provider 时由后端合并请求）。按页返回各自的 `textOrigin`。 |
| `ocrMode: 'auto'` | 默认。provider 自行决定是否 OCR（MinerU 不再强制 `is_ocr: true`）。 |
| `ocrMode: 'force'` | 调用方要求重新识别（9z5.31）。MinerU 发送 `is_ocr: true`，结果 `textOrigin = 'ocr'`。 |

### `pages` 参数支持的写法

| 写法 | 含义 |
| --- | --- |
| 不传 / `null` | 整个文档 |
| `{ from: 3, to: 9 }`（也可用 `start` / `end`） | 闭区间 3–9 |
| `[3, 9]` | 闭区间（**长度为 2 的数组按区间解释**） |
| `5` | 只解析第 5 页 |
| `{ list: [1, 3, 5] }`（也可用 `{ pages: [...] }`） | 离散页列表 |

页码必须是 ≥ 1 的整数；空范围（如 `{ from: 5, to: 3 }`）会报错。

---

## 3. 逐页路由（文档后端如何使用两个角色）

`src/backend/document/index.js` 的 `collectPageTexts`：

1. 用 9z5.27 的逐页文字层结果（`pdfSupport.extractTextLayers`）把请求页分成两组：
   有文字层 → typeset；没有文字层 → OCR。
2. **两个角色是同一个 provider 且 `ocrMode=auto`**：只发**一次** `parse`（`role: 'both'`），
   再按 provider 返回的逐页 `textOrigin` 分配。
3. 两个角色是不同 provider：各发一次请求（只包含各自负责的页）。
4. 角色为 `none` / provider 失败时降级：
   - 有文字层的页 → 原生 `pdftotext` 文本 + 最简 paragraph blocks（`textOrigin: 'textlayer'`）；
   - 没有文字层的页 → 空文本 + 页面图（`textOrigin: 'unknown'`）。
5. 图片文档（png/jpg/webp）一律走 OCR；`.txt/.md` 不走 provider，`textOrigin: 'textlayer'`。
6. `ocrMode: 'force'`（9z5.31）：所有请求页都交给 OCR provider，不再走 typeset。

---

## 4. MinerU 适配器（`mineru.js`）

```js
export function createMineruDocProvider({
  apiKey, baseUrl, model, timeoutMs, fetchImpl,
  onProgress,        // 可选：进度回调
  role = 'both',     // 工厂创建时绑定的角色（只用于错误提示）
  pollIntervalMs,    // 可选：首次轮询间隔，默认 1500（测试用的旋钮）
}) -> provider
```

### 真实 API 流程（已联网核对）

官方文档：<https://mineru.net/apiManage/docs>

1. **申请上传地址**
   `POST {baseUrl}/file-urls/batch`，带 `Authorization: Bearer <token>` 与
   `Content-Type: application/json`：

   ```json
   {
     "files": [{ "name": "doc.pdf", "page_ranges": "1-200" }],
     "model_version": "vlm"
   }
   ```

   响应：

   ```json
   { "code": 0, "msg": "ok", "data": { "batch_id": "…", "file_urls": ["https://…预签名 PUT URL…"] } }
   ```

   - `files[].is_ocr` 是**文件级**参数（不是顶层），只在 `ocrMode: 'force'` 时发送
     `true`；`auto` 不发送，让 MinerU 自行选择。
   - `page_ranges` 也是文件级。
   - `model_version` 只在显式配置 `MMGREP_MINERU_MODEL` 时发送。
   - 链接有效期 24 小时；单次最多 50 个文件（我们一次只传一个）。

2. **PUT 上传**
   对 `file_urls[0]` 直接 `PUT` 文件字节。**不能带 `Authorization`，也不能带
   `Content-Type`** —— 预签名 URL 已经绑定了签名头，多带一个就会
   `403 SignatureDoesNotMatch`。Node 的 `fetch` 对 `Buffer` body 不会自动加
   `Content-Type`，所以代码里直接传 `Buffer` 且不设任何自定义头。

3. **轮询结果**
   `GET {baseUrl}/extract-results/batch/{batch_id}`（带 Bearer）：

   ```json
   {
     "code": 0,
     "data": {
       "batch_id": "…",
       "extract_result": [
         { "file_name": "doc.pdf", "state": "done", "err_msg": "",
           "full_zip_url": "https://…预签名下载地址…",
           "extract_progress": { "extracted_pages": 1, "total_pages": 3 } }
       ]
     }
   }
   ```

   `state` 取值：`waiting-file` / `pending` / `running` / `converting` / `done` / `failed`
   （`expired` 也按失败处理）。轮询间隔从 1.5s 起按 1.5 倍退避，上限 10s，带 ±25% 抖动。

4. **下载结果包**
   `GET full_zip_url`（预签名 CDN 地址，**同样不带 Authorization**）。
   zip 内含 `full.md`、`layout.json`、`*_model.json`、`*_content_list.json`、`images/`。

### 契约 v2 的 blocks / textOrigin（本票的最小实现）

- `content_list.json` 的每条有文字的条目 → 一个 `paragraph` block；`text` 由 blocks
  派生（段落之间空行）。完整的类型映射（`text_level` → heading、图注 → caption、
  公式 → equation、表格 → table 等）属于 **9z5.29**。
- `textOrigin` 当前是保守值：
  - `ocrMode: 'force'` → `'ocr'`；
  - `model_version = vlm` → `'ocr'`（VLM 读页图，实质 OCR）；
  - `role: 'ocr'` → `'ocr'`；
  - `role: 'typeset'` / `'both'` 且未强制 OCR → `'unknown'`（pipeline 是否保留文字层
    尚未核实）。
- **TODO(9z5.29)**：核实 pipeline + `is_ocr=false` 对有文字层 PDF 的行为、结果包里是否
  有逐页解析模式字段；核实后再决定能否把 `'unknown'` 收窄成 `'textlayer'`，并补齐
  完整 blocks 映射与 typeset + vlm 的冲突处理。

### 字段兼容

对文档里没写死、或不同实现有分歧的地方做了兜底：

- 结果数组：`data.extract_result`（官方）→ `data.results` → `data` 本身；
  `extract_result` 是对象而不是数组时也会包一层。
- 结果包地址：`full_zip_url` → `zip_url` → `fullZipUrl` → 顶层 `data.full_zip_url`。
- 内容清单文件名：`content_list.json` 或 `<文件名>_content_list.json`，允许出现在子目录里
  （多文件 zip 会按子目录分组）。
- 没有 `content_list.json` 时退回 `full.md`（无法确定分页，整篇算作一页，页码取请求范围的
  第一页）。
- **页码基准**：官方说明 `page_idx` 是 0 基的**原始页索引**（抽页后保留原始页索引），
  所以页码 = `page_idx + 1`。如果某个副本/网关把切片重新从 0 编号（`page_idx` 全部落在
  `[0, 范围长度-1]` 内、且落在绝对区间之外），就按相对页码重算（偏移 = 起始页 - 1）。
  两种情况都有测试覆盖。

### 页数与大小限制

- **单文件 ≤ 200MB**：超过直接抛清晰错误（不做字节级切分 —— provider 手里只有文件路径，
  没有 PDF 处理能力）。**调用方（文档后端）需要在调用前把超大文件拆开**。
- **单文件 ≤ 200 页**：`parse()` 收到超过 200 页的范围时，按范围**切批**：
  每批最多 200 页，串行跑完整的「申请 → 上传 → 轮询 → 下载」，最后按页码合并。
  例如请求 1–450 页 → 三个批次，`page_ranges` 分别是 `1-200` / `201-400` / `401-450`。
- 切批是把**同一个文件**重复上传，用 `page_ranges` 让服务端只解析选中的页；
  之所以一个 chunk 一个批次（而不是一个批次塞多个文件条目），是为了让「批次 → 页码范围」
  的对应关系没有歧义。页数切批是边缘情况，串行足够简单可靠。
- ⚠️ **源文件本身的物理页数**超过 200 页时，MinerU 可能直接返回 `-60006`（文件页数超过限制），
  即使请求范围很小。遇到这种情况，provider 会把原始错误码和提示透出；**文档后端应在调用前
  把 >200 页的 PDF 物理拆分**（那属于 PDF 渲染层的职责）。

### 进度回调（给 MCP progress notification 用）

两种传法都支持，**单次调用优先于构造时**：

```js
const provider = createDocProvider('ocr', env, { onProgress: (e) => … }); // 构造时
await provider.parse({ filePath, pages }, { onProgress: (e) => … });      // 单次调用
```

回调形如 `({ stage, detail })`，`stage` 依次可能是：

| stage | 时机 |
| --- | --- |
| `requesting` | 申请预签名上传地址 |
| `uploading` | PUT 上传文件 |
| `parsing` | 轮询等待解析（每次轮询都会发一次，带 state / 已解析页数） |
| `downloading` | 下载结果 zip |
| `unpacking` | 解包、抽取文本与表格 |
| `done` | 结束（detail 里是页数） |

`detail` 永远是打码后的英文短句，可以直接塞进 MCP 的 progress 通知。

### 超时与取消

- `MMGREP_DOC_TIMEOUT_MS`（默认 300000，server 默认 180000）是**整个 parse 的墙钟上限**，
  包括排队。
- 超时错误会带上 `batch_id`，便于去 MinerU 控制台排查，并提示调大
  `MMGREP_DOC_TIMEOUT_MS`；任务在服务端可能仍在跑，不会自动取消（API 没有取消接口）。
- `parse({ signal })` 传入的 `AbortSignal` 会中止所有在途请求。

### 错误与安全

- **token 永不出现在** `describe()`、返回值 `raw`、进度回调、错误信息或日志里；
  错误信息统一走 `redact()`，把 token 替换成 `***`。
- HTTP 错误信息包含状态码、`statusText`，以及响应体里的 `code` / `msg` / `msgCode`；
  401/403 会额外提示检查 `MMGREP_MINERU_API_KEY`，404 提示检查 `MMGREP_MINERU_BASE_URL`，
  429 提示限流/额度。
- 常见业务错误码（`A0202` token 错、`A0211` token 过期、`-60005` 文件过大、
  `-60006` 页数超限、`-60018` 每日额度耗尽等）会附带一行可读提示。
- 业务层失败（`code != 0`，或鉴权层返回 `{ success: false, msgCode }`）也会被识别成错误，
  不会把失败响应当成成功结果解析。

### 零依赖的 zip 读取

Node 22 没有内置的 zip 读取 API（`node:zlib` 只有 `inflateRaw`）。`mineru.js` 里自带一个
最小 zip 读取器 `readZipEntries(buffer)`：

1. 从尾部向前找 EOCD（`0x06054b50`，最多回扫 65535 + 22 字节的注释区）；
2. 从 EOCD 取中央目录偏移与条目数，遍历中央目录条目（`0x02014b50`），
   读出压缩方式、压缩/原始大小、文件名、local header 偏移；
3. 按 local header（`0x04034b50`）算出数据起点（`30 + 文件名长度 + 扩展字段长度`）；
4. 压缩方式 `0` 直接取，`8` 用 `zlib.inflateRawSync` 解压；加密条目跳过，
   zip64 抛明确错误（MinerU 的结果包不会用到）。

只解析文本条目（`content_list.json` / `full.md`），不解压图片。

### 内存

`parse()` 会把整个文件读进内存再 PUT（≤ 200MB）。这是为了简单可靠地重试与切批；
如果将来要支持更大的文件，可以改成流式上传（`duplex: 'half'`）并按需重读。

---

## 5. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MMGREP_OCR_PROVIDER` | `none` | OCR 角色：`mineru` \| `none` |
| `MMGREP_TYPESET_PROVIDER` | `builtin` | typeset 角色：`builtin` \| `mineru` \| `none` |
| `MMGREP_MINERU_API_KEY` | — | MinerU token（两个角色共用；https://mineru.net/apiManage/token ） |
| `MMGREP_MINERU_BASE_URL` | `https://mineru.net/api/v4` | 接口地址（两个角色共用） |
| `MMGREP_MINERU_MODEL` | 空 | 留空 = 用服务端默认模型；MinerU 可选 `pipeline` / `vlm` / `MinerU-HTML` |
| `MMGREP_DOC_TIMEOUT_MS` | `180000`（server）/ `300000`（provider 默认） | 整体超时（包括上传、排队、解析、下载） |

`MMGREP_DOC_PROVIDER` / `MMGREP_DOC_API_KEY` / `MMGREP_DOC_BASE_URL` /
`MMGREP_DOC_MODEL` 已在 0.2.0 删除；启动时检测到会 warn 并指出替代变量。

---

## 6. 新增一个 provider

1. 在 `src/providers/doc/` 下新建 `<name>.js`，导出一个
   `create<Name>DocProvider(options)`，返回 §2 的 provider 对象：
   ```js
   export function createAcmeDocProvider({ apiKey, baseUrl, model, timeoutMs, fetchImpl, role } = {}) {
     return {
       id: 'acme',
       roles: ['ocr'],              // 必须声明支持的角色（ocr / typeset / 两者）
       async parse({ filePath, pages, role, ocrMode, signal }, { onProgress } = {}) { /* … */ },
       describe() { return { id: 'acme', model: model || null, baseUrl, roles: ['ocr'] }; },
     };
   }
   ```
2. 在 `index.js` 的 `DOC_PROVIDER_REGISTRY` 里注册，并声明 `roles`：
   ```js
   acme: { id: 'acme', roles: ['ocr'], create: (options) => createAcmeDocProvider(options) },
   ```
   同时更新 `DOC_ROLE_PROVIDERS`（配置层 / HTTP 头的允许值）与 `DOC_PROVIDER_ENV`
   （按 `MMGREP_<PROVIDER>_API_KEY` / `_BASE_URL` / `_MODEL` 的约定；MinerU 即
   `MMGREP_MINERU_*`）。
3. **遵守 typeset 硬约束**：如果 provider 不能保证原字符，返回 `textOrigin: 'ocr'` /
   `'unknown'`；本地 typeset provider 可以只读 `parse({ textLayers })`，不要自己 OCR。
4. 遵守同一条红线：**构造不抛错（缺 key 时），parse 时才抛清晰错误**；缺 key 的错误信息要
   点名缺哪个环境变量；`describe()` / 错误 / 进度里都不能出现 token。
5. 在 `test/doc/` 下加测试：用 `node:http` 起本地 stub，不联网、不用真 key；覆盖
   `role` / `ocrMode` / 逐页 `textOrigin`。
6. 更新本 README 的表格与「新增 provider」步骤。

---

## 7. 测试

```bash
node --test 'test/doc/*.test.js'
```

⚠️ 本机 Node 是 v22.22.3：按官方文档，`--test` 的位置参数是 **glob 模式**而不是目录，
所以 `node --test test/doc/` 会把目录当成模块去加载并报 `MODULE_NOT_FOUND`。
可用的写法：

- `node --test 'test/doc/*.test.js'`（只跑本目录，推荐）
- 在仓库根目录直接 `node --test`（默认模式里的 `**/test/**/*.js` 会覆盖本目录，同时也会跑
  其他模块的测试）

测试全程离线：用 `node:http` 起本地 stub server 模拟 MinerU 的四步流程，
zip 是测试里用 `node:zlib.deflateRawSync` + 手写 zip 结构现造的（不是 mock）。
覆盖：流程顺序、页码/文本映射、`pages` 范围过滤、>200 页切批、超时、401/500、
缺 key、token 不泄漏、进度回调、子目录 zip、`full.md` 兜底、相对页码兼容；
契约 v2 另外覆盖 `role` / `ocrMode`、`blocks` / `textOrigin`，以及逐页路由
（`test/doc/routing.test.js`：有文字层只发 typeset、无文字层只发 OCR、同一 provider 只发一次）。
