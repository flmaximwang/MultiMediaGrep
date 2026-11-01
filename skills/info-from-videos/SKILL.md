---
name: info-from-videos
description: "Use when 一条视频要变成可用的信息 —— 「总结这条视频」「这个视频讲了什么」「帮我看看 BVxxx」：B站（BV 号 / URL）、YouTube、本地文件。先登录拿 CC 字幕，没有字幕才走本地 ASR；要画面就抽关键帧读图。不属于：直播 / 录屏盯场 → watch-a-live；账号侧数据（历史 / 收藏 / 搜索）→ bilibili-reading。"
---

# info-from-videos

一条视频（或音频）变成**能引用的信息**：先拿到文字（CC 字幕最省，没有才走本地 ASR），
再按需读画面，最后按用户要的格式出结果（摘要 / 章节 / 观点清单 / thread / blog）。

## 前两步永远是这个顺序

1. **B站先登录**。匿名拿不到 CC 字幕（`subtitle.available: false` 是常态，只剩 danmaku），
   登录后 `bili video BVxxx --subtitle` 秒级拿到全文。判据不是「扫码成功」而是
   **回读凭证 + `bili status` 报出用户名** —— 非交互环境里 `bili login` 会存下**空的
   `sessdata`**（API 层登录成功了、本地解析 cookie 失败），看着像登上了其实没登上。
   全套做法（含可直接跑的扫码脚本）→ `references/bilibili-login.md`。
2. **先探路再下载**。有字幕就别下载视频；没有字幕才走音频 + 本地 ASR
   （B站音频约 0.5 MB/分钟，179 秒的视频音频 1.17 MiB）。

## 两岛路由

| 输入 / 要的东西 | 进哪 |
|---|---|
| 视频：有 CC 字幕，或要读画面（点位、手绘框、表格）→ 摘要 / 章节 | `references/watch-a-video/SKILL.md` |
| 没有字幕，或本来就是音频（B站 / YouTube / 本地 mp4·mp3）→ 转写再总结 | `references/video-transcript-summarization/SKILL.md` |

两条腿在此汇合：**文字**（CC 字幕 或 ASR 转写）→ 总结；**画面**（关键帧 → 读图）→ 只在
问题需要图中信息时才做，不替代文字。

## 硬规则（都踩过）

- **标注数据来源**：这份总结是 CC 字幕、ASR 转写，还是读图得来的，写清楚。三者可信度不同 ——
  ASR 会把人名、数字听错（实测把「成长股价值」听成「成長武士戒」），**不许把 ASR 的转写当原话引用**。
- **有字幕就先读完全文再动笔**，别边读边写；转写是正文的唯一来源。
- **结论带时间点**（第几分钟 / B站第几秒），否则没法回看核对。
- **读图只认裁过的单帧**，不认总览图（见 `watch-a-video` 的坑）。
- 长转写（>50K 字符）先分块（约 40K 带 2K 重叠）逐块摘要再合并。
- 视频 / 音频一律下到 `/tmp/`，不污染工作区。

## 分工

| 事情 | 去哪 |
|---|---|
| 直播 / 录屏盯场（跑着的东西记成 log） | `watching-video` 包 → `watch-a-live` |
| B站账号侧数据（观看历史 / 稍后再看 / 收藏 / 关注 / 搜索） | `watching-video` 包 → `bilibili-reading` |
| 总结落成 vault 笔记（分类、frontmatter、链接） | `knowledge-management-by-obsidian` |
