---
name: listen-to-a-record
description: "Use when 用户给一段本地录音/音频文件（m4a、mp3、wav、aac、mp4）要听懂、转写、总结、提炼行动项，尤其是中文和 English 混说的会议、讲座、语音备忘录。默认本地优先：先检查音频是否有有效人声，再用 mlx-whisper large-v3-turbo 分段转写；专名、数字、术语和重复幻觉要复核，必要时切换已启用的在线 speech-to-text 模型。不属于：视频画面理解 → info-from-videos/watch-a-video；正在进行的会议录制 → using-obs。"
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [audio, recording, m4a, transcription, asr, bilingual, chinese, english]
    related_skills: [info-from-videos, video-transcript-summarization, using-obs]
---

# Listen to a Record

把一段本地录音变成可靠的文字和可用结论。录音识别的目标不是“有字就算完成”：中文和 English 混说时，模型最容易错的是人名、机构名、产品名、数字和技术术语；安静尾段还可能被 Whisper 编成重复的假字幕。因此先验收音频，再转写，再复核，最后才总结。

## 路由

- 本地录音文件：直接走本 skill。
- 本地视频且需要画面：转 `info-from-videos` → `watch-a-video`；只要声音可把音频抽出来后回到本 skill。
- 正在进行的单个 Mac app 录音：转 `using-obs`。
- 已经有可信的人工逐字稿：跳过 ASR，直接总结，但保留来源说明。

## 1. 检查输入和声音

不要把录音复制进工作区；临时文件放 `/tmp/listen-to-a-record/`。先读格式、时长、采样率、声道和音量：

```bash
export PATH="$HOME/.local/bin:$HOME/.hermes/tools/ffmpeg-9.0.1-darwin-arm64:$PATH"
mkdir -p /tmp/listen-to-a-record
ffprobe -v error -show_entries format=duration,size:stream=codec_name,sample_rate,channels \
  -of default=nw=1 <recording>
ffmpeg -hide_banner -i <recording> -af volumedetect -f null - 2>&1 \
  | grep -E 'mean_volume|max_volume'
```

- 如果 `max_volume` 接近 `-91 dB`，按无有效声音处理，不要让 Whisper 生成的句子进入结果。
- 如果有声音但音量很低，先规范化到临时 WAV；不要覆盖原文件：

```bash
ffmpeg -y -v error -i <recording> -ar 16000 -ac 1 \
  -af 'highpass=f=80,lowpass=f=8000,loudnorm=I=-18:TP=-1.5' \
  /tmp/listen-to-a-record/input.wav
```

## 2. 选择转写模型

统一从 bundled adapter 调用，不要现场拼 HTTP 请求或另写脚本：

```bash
SKILL=/path/to/listen-to-a-record
python3 "$SKILL/scripts/listen_to_record.py" \
  <recording> --provider local --output /tmp/listen-to-a-record/local
```

本地 adapter 默认调用 Apple Silicon 上的 `mlx-whisper large-v3-turbo`，避免上传私密录音。它自动清除 `PYTHONPATH`，使用自动语言识别，并关闭跨窗口上下文传播。`large-v3-turbo` 是默认质量下限；tiny/base 只能验证链路，不能作为中文成稿。

长录音或模型出现重复时，先按约 20 分钟切片，每片保留 2--4 秒重叠；短录音也应按约 20 秒窗口抽查。

## 3. 在线模型（可选）

只有用户允许上传，且某个已配置的在线 speech-to-text provider 明确开放了音频模型时才走在线路线。先查该 provider 的可用模型和权限，不要猜模型名或接口形状。优先使用现有 provider 文档、CLI 或连接配置；chat completion 模型不等于 speech-to-text 模型，不能因为能聊天就假设能读 m4a。

### 已配置 provider 的调用

Secrets are read automatically from the active Hermes profile's `$HERMES_HOME/.env` (`~/.hermes/.env` when `HERMES_HOME` is unset); an existing process environment variable takes precedence. For ElevenAPI, use `ELEVENLABS_API_KEY=...`. Keep this file outside the repository; `.env` is ignored by git.

```bash
# ElevenAPI：密钥从环境变量读取，不写入命令行或仓库
python3 "$SKILL/scripts/listen_to_record.py" <recording> \
  --provider elevenapi \
  --keyterm "已知英文人名" --keyterm "机构或产品名" \
  --output /tmp/listen-to-a-record/elevenapi

# 任意 OpenAI-compatible STT provider：只换配置，不改调用脚本
STT_BASE_URL=https://provider.example/v1 \
STT_API_KEY=... STT_MODEL=provider-stt-model \
python3 "$SKILL/scripts/listen_to_record.py" <recording> \
  --provider openai-compatible --output /tmp/listen-to-a-record/online
```

`elevenapi` adapter 使用批量 speech-to-text、自动语言识别、keyterms 和词级时间戳；需要区分说话人时加 `--diarize`，可用 `--num-speakers` 给出人数上限；只有客服类场景才使用 `--detect-speaker-roles`。输出中的 `speaker_0`、`speaker_1` 是声纹聚类标签，不是姓名；如需姓名，须在复核阶段根据上下文手动映射。`--no-verbatim` 按需启用。在线 adapter 会保存 `provider.json`、`transcript.txt` 和能生成时的 `transcript.srt`，随后仍必须按第 4 节复核。添加另一个供应商时，只增加一个 adapter 并复用同一 CLI 参数，调用方不变。

### 在线模型选择顺序

根据任务选择能力，不按品牌选择：

1. **已有录音、中英混说、优先准确度**：选支持 multilingual/code-switching、自动语言识别、批量文件转写的高质量模型。
2. **专名和术语很多**：优先支持 keyterms / vocabulary / prompt / custom dictionary 的模型；把用户已知的人名、机构、产品、基因/药物名、软件名作为提示词传入。没有这项能力时，不要伪造参数，转写后把这些词列入待核对项。
3. **需要多人区分**：选支持 speaker diarization 的 batch 模型，并确认它仍支持中文和 code-switching。
4. **只要低成本粗稿**：选同一 provider 的 value/economy batch 模型；不能把便宜模型结果直接当可引用原话。
5. **实时录音**：才选 realtime/streaming 模型；已完成的本地录音不要为“实时”付费。

在线请求失败或返回“无权限”时立即回到本地，不要循环重试。在线转写若可用，仍需保留原始时间戳，并把 provider、模型名和“录音已上传”写进来源说明。敏感录音默认不上传。

### 成本估算

先读取 provider 返回的实际 usage/cost；没有实际值时才按其官方费率估算。统一用音频秒数计算：

- 按时长计费：`预计费用 = 音频秒数 / 3600 × 每小时费率`，或 `音频秒数 / 60 × 每分钟费率`。
- 按 token 计费：`预计费用 = 音频输入 token / 1M × 输入费率 + 文本输出 token / 1M × 输出费率`；没有 token 统计时给区间，不要伪造精确值。
- 加上 keyterms、diarization、redaction、translation 等功能的独立附加费；实时模型按连接时长计费时，注意空闲连接也可能计费。
- 报价至少写清币种、计费单位、是否有最低消费/免费额度、是否按声道重复计费，以及本次音频的预计金额。

只为这条 148 秒 testcase 做一次在线复核时，正常的按时长 STT 服务通常是美分以下到约一美分量级；不要因为模型单价低就省略准确度复核。

## 4. 复核转写

先完整读完 SRT/VTT/JSON，再写摘要。复核的最低标准：

1. 时间轴连续，没有整段缺失或同一句异常重复。
2. 中英文切换位置基本合理；English 专名保留原文，不用猜测的中文音译替换。
3. 人名、机构、产品、药物/基因/软件名和数字标为“待核对”，除非音频或用户提供的上下文能确认。
4. 低置信或明显重复的片段回听原音频；不要把 Whisper 的 ASR 文本当成逐字原话。
5. 尾段若连续出现同一句、频道口播或与音量不符的内容，删除并标记为模型幻觉/背景音。

建议至少抽查：开头 30 秒、中间每个主题切换处、所有专名和数字、结尾 30 秒。需要回听时用：

```bash
ffmpeg -y -v error -ss <start> -to <end> -i <recording> \
  /tmp/listen-to-a-record/check-<start>.m4a
```

## 5. 输出

默认输出四段，短而可核对：

- **来源与质量**：文件、时长、ASR/人工/在线来源、模型、已知限制。
- **一句话摘要**：只写转写中有证据的内容。
- **要点与时间点**：每条带 `[MM:SS]`；不确定处写“疑似”，不要补全。
- **待核对项**：专名、数字、听不清片段和被删除的重复幻觉。

用户要逐字稿时给带时间戳的清理稿，保留中英原文；用户要总结时不要把整段 ASR 原文冒充引用。录音的摘要必须明确“基于 ASR 转写”，除非有人逐句核对过原音频。

## 本 testcase 的验收约束

对于混合中文和 English 的 `m4a`：本地转写可作为初稿，但如果输出出现无法解释的专名或连续重复，就不能宣称结果合格；应请求用户启用一个可用的 speech-to-text provider，或在输出中明确降级为“待核对的低置信初稿”。
