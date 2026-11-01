# 旧 skill 能力覆盖对照

> 对照对象：`skills/` 下四个旧 skill（已于 2026-11-01 删除，原始真源仍在 `~/Documents/Evolution` 的对应包里）。
> 目的：新 MCP 工具上线前，逐项确认「旧 skill 能做的提取类能力」都有归宿，不留静默缺口。
> 边界：**取数类能力不在本项目**（已迁至 IntelligenceAtlas `ei7.*`），下表只统计「把本地已有文件变成文字/画面材料」这一类。

## 对照表

| 旧 skill 的能力 | 归属 | 说明 |
|---|---|---|
| 本地视频/音频抽关键帧读图 | ✅ `media_overview` + `media_zoom` | 宫格图找位置，裁切单帧读字（旧 `watch-a-video` 的「读图只认裁过的单帧」规矩保留） |
| 视频内嵌/外挂字幕优先，字幕不足才 ASR | ✅ `media_overview`（`images: 0` + `transcript: "subtitle"`） | 字幕优先的顺序写进工具描述与 server instructions |
| 没有字幕时转写（音频、视频） | ✅ `media_overview`（配外部 ASR provider） | 本地 mlx-whisper 被外部服务取代（见 epic 决策 14/15） |
| 长录音转写、分段且时间码不漂移 | ✅ `media_overview`（录音后端） | 长音频切片规则见 9z5.8 |
| 短语的定位（时间点） | ✅ `media_locate` | 视频/录音到时间戳，文档到页码 |
| 音频体检（时长/采样率/声道/音量） | ✅ `media_probe`（需补音量与静音判断，见 G1） | 旧 skill 用 `volumedetect` 手工做，现在由工具返回 |
| 结论必须带时间点可回溯 | ✅ `segments.jsonl` / `content.md` 带毫秒时间码 | 全文落盘格式见 9z5.10 |
| 长转写分块摘要 | ✅（交给 agent） | 本项目不调 LLM；只保证分段文本与落盘全文可分块读 |
| 临时文件不污染工作区 | ✅ 缓存目录可配置 | `MMGREP_CACHE_DIR`，默认 `~/.cache/multimediagrep`，从不写用户文件旁边 |
| B 站登录取 CC 字幕、先探路再下载 | ➡️ IntelligenceAtlas `ei7.*` | 取数层，不在本项目；cookie/凭据本项目一律不经手 |
| B 站账号侧数据（历史/收藏/搜索） | ➡️ IntelligenceAtlas `ei7.*` | 取数层 |
| 直播流/本机 app 实时盯场记 log | ➡️ 属「采集」而非「转换」 | 不在本项目范围；若要做，属于取数/录制侧 |
| 通用下载兜底（aria2c/curl/代理/cron） | ➡️ IntelligenceAtlas `ei7.*` | 取数层 |

## 迁移到新 MCP 的经验（必须体现在实现里）

- **G1 音频体检**：安静尾段会被 ASR 编成重复的假字幕。`media_probe` 对音频要给出音量/静音判断；`media_overview` 在整段近乎无声时直接报「无有效人声」，不要让 ASR 段落进入结果。
- **G2 规范化**：ASR 前把音频规范化到 16 kHz 单声道、限带 80–8000 Hz、`loudnorm I=-18 TP=-1.5`，且**不覆盖原文件**（临时文件进缓存目录）。
- **G3 长音频切片**：约 20 分钟一片、片间重叠 2–4 秒，拼接后时间码不漂移。
- **G4 来源标注**：返回结构带来源字段（subtitle / asr / visual / ocr）；ASR 转写**不可当原话引用**（人名、数字会错），这句进工具描述。
- **G5 只认裁过的单帧**：总览图只用于定位，文字必须走 `media_zoom` 裁切。
- **G6 字幕优先**：有字幕就不必 ASR；字幕是正文唯一来源，读完再动笔。
- **G7 长素材先收窄**：`start/end`、`pages` 范围要在契约里写清越界行为。

## 明确放弃（不再覆盖）

- 本地 ASR（mlx-whisper）：按用户决策改用外部 ASR 服务，用户自备 key；未配置 key 时只有画面与字幕。
- 本地 OCR（rapidocr 桥接）：改用外部文档解析服务（MinerU）。
- 任何下载/登录/账号态能力：不在本项目。

## 待补：前后对比（54c 验收项）

等 MCP server 可用后，用同一素材做新旧对照：agent 上下文 token 数、端到端耗时、结论可回溯到时间戳的比例。结论补进本文件并写进 README。
