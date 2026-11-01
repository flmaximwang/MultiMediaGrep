# ASR providers

MultiMediaGrep 的 **ASR 走外部服务**：本地不装 whisper，服务商可插拔。
这个目录只负责「把一个本地音频文件交给某个 ASR 服务，拿到带时间轴的台词」，
**不做取数**（下载/CC 字幕那条路不归这里），也不做降噪、切片、缓存。

## 用法

```js
import { createAsrProvider } from './src/providers/asr/index.js';

// 返回 null = 本次没有 ASR，server 应当只返回画面内容
const asr = createAsrProvider(process.env);
if (asr) {
  const { provider, model, language, segments } = await asr.transcribe({
    audioPath: '/abs/path/to/audio.mp3',
    // language: 'zh',        // 可选，覆盖 provider 级语言
    // mimeType: 'audio/mpeg',// 可选，默认按扩展名猜
    // signal: controller.signal, // 可选，取消用
  });
  // segments: [{ startMs: 0, endMs: 1240, text: '你好' }, ...]
}
```

## provider 契约

```js
{
  id: 'elevenlabs' | 'openai-compatible' | 'none',
  transcribe({ audioPath, language?, mimeType?, signal? }) =>
    Promise<{
      provider: string,          // = id
      model: string,             // 服务实际用的模型
      language: string | null,   // 服务返回的语言代码（认不出来就是 null）
      segments: Array<{ startMs: number, endMs: number | null, text: string }>,
      raw?: object,              // 服务返回的原始 JSON（可选，server 一般用不上）
    }>,
  describe() => ({ id, model, baseUrl }),   // 永远不含 apiKey
}
```

硬约定：

- `startMs` / `endMs` 都是**整数毫秒**；`endMs` 允许为 `null`（未知 / 延续到下一段）。
- `segments` 按 `startMs` **升序**。
- `describe()` **绝不返回 apiKey**（也别把 key 塞进 `raw` —— 服务返回体里不会有，但别自找麻烦）。
- 面向 agent 的错误信息一律英文，且**不许回显 apiKey**。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MMGREP_ASR_PROVIDER` | `none` | `elevenlabs` / `openai-compatible` / `none` |
| `MMGREP_ASR_API_KEY` | — | 服务 key。`none` 时不需要 |
| `MMGREP_ASR_BASE_URL` | ElevenLabs `https://api.elevenlabs.io/v1`；OpenAI 兼容 `https://api.openai.com/v1` | 自建服务填自己的地址 |
| `MMGREP_ASR_MODEL` | ElevenLabs `scribe_v1`；OpenAI 兼容 `whisper-1` | |
| `MMGREP_ASR_LANGUAGE` | — | 语言代码，如 `zh` / `en`。不填就交给服务自己判断 |
| `MMGREP_ASR_TIMEOUT_MS` | `120000` | 单次请求超时 |
| `MMGREP_ASR_MAX_BYTES` | `104857600`（100MB） | 单次请求的音频体积上限 |
| `MMGREP_ASR_DIARIZE` | `false` | 仅 ElevenLabs：请求说话人分离 |
| `MMGREP_ASR_RESPONSE_FORMAT` | `verbose_json` | 仅 OpenAI 兼容 |
| `MMGREP_ASR_TIMESTAMP_GRANULARITIES` | 模型名含 `whisper` 时为 `segment` | 仅 OpenAI 兼容，逗号分隔 |

环境变量值外面带了成对的引号会被自动剥掉（Windows `setx` 的老坑：
`setx MMGREP_ASR_BASE_URL "http://127.0.0.1:8000/v1"` 在某些 shell 转发后会带上引号）。

## 降级语义（server 集成必须照着写）

`createAsrProvider(env, opts)`：

| 情况 | 返回 | server 应该怎么办 |
|---|---|---|
| 没设 `MMGREP_ASR_PROVIDER`，或设成 `none` | `null` | **不报错**，只返回画面内容 |
| provider 选了，但没给 `MMGREP_ASR_API_KEY` | 一个 provider（构造**不抛错**） | 真正要转写时，`transcribe()` 会抛一条说清「缺 `MMGREP_ASR_API_KEY`」的错误；server 应当把这条错误原样告诉用户，而不是让整个请求崩掉 |
| `MMGREP_ASR_PROVIDER` 是个不认识的值 | **抛错** | 拼写错误要在启动时吵醒用户。server 构造 provider 时建议 `try/catch` 包一下，退化成「只有画面」 |

想显式拿到那个「明确不启用 ASR」的 provider（`id: 'none'`），用：

```js
import { createNoneAsrProvider } from './src/providers/asr/index.js';
const none = createNoneAsrProvider();
await none.transcribe({ audioPath });   // 抛错："only visual content is available"
```

## 分块契约（上层 server 负责）

**这个模块只做「一次调用」。** 长音频的切片由上层 server 做：

- 切片长度 **≤ 45 秒**（云端 ASR 对超长输入要么超时要么时间码被压早）；
- 切片边界尽量落在**静音中间**，避免把词劈成两半；
- 每片单独调一次 `transcribe()`，再把每片返回的 `startMs` / `endMs` **加上该片的起始偏移**，
  然后按 `startMs` 合并排序；
- 跨片重复的词要去重（同一句可能在上一片尾和这一片头各出现一次）。

单次请求的体积上限是 `MMGREP_ASR_MAX_BYTES`（默认 100MB）；超了 `transcribe()` 会直接抛错，
并在错误里告诉你去切 ≤45 秒的片段。

## 新增一个 provider

1. 新建 `src/providers/asr/<your-id>.js`，导出一个工厂：

   ```js
   export function createYourAsr({ apiKey, baseUrl, model, language, timeoutMs, fetchImpl } = {}) {
     return {
       id: 'your-id',
       async transcribe({ audioPath, language: languageOverride, mimeType, signal }) {
         // …调你的服务，返回 { provider, model, language, segments, raw }
       },
       describe() {
         return { id: 'your-id', model, baseUrl };   // 不含 apiKey
       },
     };
   }
   ```

   几条硬要求：

   - 必须支持注入 `fetchImpl`（测试要靠它，或者至少别硬编码 `globalThis.fetch`）。
   - 时间一律**整数毫秒**；`segments` 按 `startMs` 升序。
   - **任何**错误信息里都不能出现 apiKey（请求失败时把响应体截断后打码再报）。
   - 请求失败要给出可诊断信息：HTTP 状态码 + 截断的响应体。

2. 在 `src/providers/asr/index.js` 里：
   - 把 id 加进 `ASR_PROVIDERS`；
   - 在 `createAsrProvider()` 里加分支，配上默认 baseUrl / model；
   - 缺 key 的分支是通用的，不用改。

3. 在 `test/asr/` 加一个 `*.test.js`：用 `node:http` 起本地 stub server，
   覆盖「正常响应 / 空结果 / 401 / 429 / 500 / 超时」，
   **不许联网、不许用真 key**。

## 测试

```bash
node --test "test/asr/**/*.test.js"    # 只跑 ASR
node --test                            # 全仓库（= npm test）
```

> 注意：Node 22 起 `node --test` 的位置参数按 **glob** 解释，`node --test test/asr/`
> 会把目录当成模块去 require 而报错。用上面两条命令，或 `node --test test/asr/*.test.js`。

## 参考

- ElevenLabs Speech-to-Text（Create transcript）：
  <https://elevenlabs.io/docs/api-reference/speech-to-text/convert>
  - 端点 `POST {baseUrl}/speech-to-text`，认证头 `xi-api-key`；
  - multipart 字段 `file` / `model_id` / `language_code` / `diarize` / `timestamps_granularity`；
  - 响应 `{ text, language_code, words: [{ text, start, end, type, speaker_id, logprob }] }`，
    `start` / `end` 单位**秒**。
- OpenAI Audio transcription：
  <https://platform.openai.com/docs/api-reference/audio/createTranscription>
  - 端点 `POST {baseUrl}/audio/transcriptions`，认证头 `Authorization: Bearer <key>`；
  - multipart 字段 `file` / `model` / `response_format` / `language` / `timestamp_granularities[]`；
  - `verbose_json` 响应含 `segments: [{ start, end, text }]`，`start` / `end` 单位**秒**。

## 实现说明

- ElevenLabs 响应里的 `start` / `end` 是**秒**，OpenAI 兼容接口的 `segments[].start` / `end` 也是**秒**；
  对外一律换算成**整数毫秒**（`Math.round(sec * 1000)`）。
- 句子级分段：ElevenLabs 的 `words[]` 里**相邻两个词间隙 > 0.6 秒**就断句；
  OpenAI 兼容接口没有 `segments[]` 时用 `words[]` 走同一套规则。
  两边都会优先用服务自己给的 `segments[]`。
- `words[]` 里的 `type` 有 `word` / `spacing` / `audio_event` 三种；空文本的条目（spacing）会被丢掉，
  `audio_event`（比如音乐提示）当作普通文本保留 —— 需要更精细的处理时在上层过滤。
