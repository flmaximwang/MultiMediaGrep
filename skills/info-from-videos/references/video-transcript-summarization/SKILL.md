---
name: video-transcript-summarization
description: "Use when 总结视频/音频内容（B站 / YouTube / 本地）—— 没有字幕、或本来就是音频时走本地 ASR：yt-dlp 取音频（约 0.5 MB/分钟）→ mlx-whisper large-v3-turbo 转写 → 按用户要的格式出摘要/章节/观点清单。不属于：有 CC 字幕、或要读画面的视频 → watch-a-video（那边更快）。"
version: 1.1.0
author: hermes-curator
license: MIT
platforms: [macos]
metadata:
  hermes:
    tags: [media, video, audio, transcript, asr, whisper, bilibili, youtube, yt-dlp]
    related_skills: [info-from-videos, watch-a-video, bilibili-reading]
---

# 视频 / 音频 → 转写 → 总结

把视频（B站 / YouTube）或本地音视频变成文字，再按用户要的格式产出摘要 / 章节 / 观点提炼。
**核心：先探路（有没有现成字幕），再决定用不用 ASR。**

## When to Use

- 用户丢来视频 / 音频链接或文件（BV 号 / av 号、bilibili 或 youtu.be 链接、本地 mp4/mp3），
  要求「总结 / 讲了什么 / 转成文字 / 提炼观点」
- 该视频**没有 CC 字幕**（登录后 `subtitle.available` 仍为 false），或输入本来就是音频
- 要把某条视频的内容归档成笔记（投资类 → 配合 `knowledge-management-by-obsidian`）
- 需要逐字稿或带时间戳章节，作为后续统计 / 复盘 / 引用的输入

有字幕的视频**不要走这条腿** —— 上级 skill 的 `watch-a-video` 用 CC 字幕秒级拿全文，
本岛是它的兜底。

## 工具链（一次性安装，二进制落 `~/.local/bin`）

```bash
uv tool install yt-dlp          # 下载 + 平台解析（自带 wbi 签名，比手写 API 稳）
uv tool install mlx-whisper     # Apple Silicon 本地 ASR（M 系列）
export PATH="$HOME/.local/bin:$PATH"
export PATH="$PATH:$(ls -d $HOME/.hermes/tools/ffmpeg-* | head -1)"   # mlx_whisper 解码音频依赖 ffmpeg
```

ffmpeg 目录名带版本号会变，用 `ls -d ~/.hermes/tools/ffmpeg-*` 现取，别硬编码。

## 取文路线：先选路，再动手

| 路线 | 何时用 | 代价 |
|---|---|---|
| **A 字幕** | 平台有 CC/AI 字幕 **且** 有登录态（B站 → `~/.hermes/skills/info-from-videos/references/bilibili-login.md`） | 秒级，最省 |
| **B 本地 ASR** | 兜底，零登录 | 首次下模型 708M；M1 实测 tiny ≈35×、large-v3-turbo ≈18× 实时 |

匿名状态下 B站**取不到字幕**（`--list-subs` 只列 `danmaku`），但**音频流匿名可下**。
所以「B站 + 没登录」时就走 B；**先试着登录**往往比转写便宜得多。

## 步骤

1. **探元信息 + 字幕列表**：`bili video BVxxx --yaml`（看 `subtitle.available`）或 `yt-dlp --list-subs <URL>`
   - 出现 `zh-CN` / `ai-zh` 之类的语言表 = 路线 A 可行；只有 `danmaku` = 这条腿取不到字幕。
2. **路线 A 下字幕**：B站 `bili video BVxxx --subtitle`；YouTube
   `yt-dlp --write-subs --sub-langs "ai-zh,zh-CN" --skip-download -o subs <URL>`
3. **路线 B 取音频**（只下音频流，体积极小）：
   ```bash
   yt-dlp -f "30232/bestaudio" --no-playlist -o audio.m4a <URL>   # B站 30232 ≈76k m4a；YouTube 用 -f bestaudio
   ```
   实测 B站：129 秒视频音频仅 1.17 MiB，1.7 秒下完（4.9 MiB/s）—— 约 **0.5 MB/分钟**，长视频也不怕。
4. **转写**：
   ```bash
   env -u PYTHONPATH ~/.local/bin/mlx_whisper audio.m4a --model mlx-community/whisper-large-v3-turbo \
     --language zh --initial-prompt "以下是普通话的句子，请输出简体中文。" \
     --output-format txt --output-dir out
   ```
   - 中文成稿**必须** large-v3-turbo（tiny 只能验证链路）。实测 turbo：129.4 秒音频 → **7.2 秒墙钟**（≈18× 实时，含模型加载）。
   - 要时间戳章节换成 `--output-format srt`（实测同样可用：129 秒音频出 16 条带时间戳字幕）。
   - 长音频先分段（约 30 分钟/段）再逐段转写，别一次性长跑。
   - **`env -u PYTHONPATH` 不是可省的**：运行时导出的 `PYTHONPATH` 指向 python3.14 的 site-packages，
     whisper 的环境是 3.11，不加会报 `No module named 'numpy._core._multiarray_umath'`。
5. **总结**：默认出摘要；用户点明格式时才给时间戳章节 / 观点清单 / thread / blog。
   - 转写 >50K 字符先分块（约 40K 带 2K 重叠）逐块摘要再合并。
6. **标注来源**：这一份是 ASR 转写（不是 CC 字幕，也不是原话照抄），摘要里写明 ——
   whisper 会听错人名与数字，引用原话前要回音频核对。

## 坑（实测）

- **B站匿名没有字幕**：`x/player/v2` 的 `subtitles` 返回 `[]`，`--list-subs` 只给 `danmaku`。
  要 SESSDATA 才有 CC/AI 字幕；**先按 `~/.hermes/skills/info-from-videos/references/bilibili-login.md` 登录**，登录后仍无字幕才走 ASR。
- **1080P 以上高码率需大会员 cookie**，但音频流不受影响 —— 音频路线无需登录。
- **B站搜索接口匿名会被风控**：`x/web-interface/wbi/search/type` 返回 412 / `v_voucher`。改用 yt-dlp
  内置搜索（自带 wbi 签名）：`yt-dlp --flat-playlist --print "%(id)s|%(url)s" "bilisearch5:关键词"`；
  **连打第二次就 412**，调用间隔 sleep 数秒，拿到 id 后用 `https://www.bilibili.com/video/av<id>` 形式访问。
- **whisper tiny 中文不可用**：会把「成长股价值」听成「成長武士戒」。中文一律 large-v3-turbo；
  输出偏繁体 / 错字时用 `--initial-prompt`「以下是普通话的句子，请输出简体中文。」压简体。
- **大模型 708M（不是 1.6G，实测 `du -sh`），别在前台等**：放后台任务 + notify；HF 缓存断点续传，
  被前台超时杀掉后重跑即续（用 `du -sh ~/.cache/huggingface/hub/models--mlx-community--*` 看下了多少）。
- mlx_whisper 解码依赖 ffmpeg 在 PATH 上，否则直接报错。
- **静音录音会编出字幕**：whisper 对静音不返回空，而是按训练先验编出像样的句子（实测 1 秒静音 →
  「优优独播剧场——YoYo Television Series Exclusive」；3 分钟空录 → 同一句重复 14 次）。
  转写前先 `ffmpeg -hide_banner -i audio.m4a -af volumedetect -f null - 2>&1 | grep max_volume`，
  `-91.0 dB` 这种就是没有语音，别把编出来的字当成内容。
- **`~/Documents`、`~/Desktop`、`~/Downloads` 枚举卡死 ≠ 目录坏了**：实测是 macOS TCC 权限，
  症状是 `ls` 数秒零输出直到超时，而 `~/Repositories` 之类正常列出。

## 工作纪律（用户偏好）

- 先给**完整计划**待确认再动手，勿抢跑；但探测性实测（探接口 / 试链路）可以直接做，因为它喂给结论。
- 结论必须基于**实测数据**（体积 / 耗时 / 接口返回码），不要凭猜。

## Support files

| 文件 | 承担什么 |
|---|---|
| `references/bilibili-anonymous-access.md` | 登录 vs 匿名下各接口的实测边界表 —— 决定走字幕腿还是 ASR 腿 |
| `references/example-output.md` | 一份真实输出样例（B站投资类短视频：摘要 + 原话 + 时间戳章节 + 结构化字段） |
