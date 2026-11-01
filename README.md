# MultiMediaGrep

**取数兜底层（fallback / substrate），不是"多媒体专用包"。**

四条 skill 覆盖的是「专用 skill 都匹配不上时怎么办」：

| skill | 干什么 |
|---|---|
| `info-from-videos` | 一条视频/音频变成可引用的信息：先登录拿 CC 字幕，无字幕才走本地 ASR，要画面才抽关键帧 |
| `listen-to-a-record` | 本地录音（m4a/mp3/wav/aac/mp4）转写 + 提炼行动项，中英混说；mlx-whisper large-v3-turbo |
| `watching-video` | 平台侧数据（B站历史/稍后再看/收藏/关注/搜索）与实时盯场（直播流、任意本机 app 的画面+声音记 log） |
| `download-from-anywhere` | 通用下载兜底：aria2c/curl 选型、代理策略、后台执行带日志、长下载 cron 监控与断点续传。**只在没有站点专用下载 skill 时用** |

## 边界

- 不属于：具体站点的检索/抓取（那些在 `Procedural/<Tool>` 或第三方 skill 里）
- 不属于：视频生成（ComfyUI、manim 那一类）
- 不属于：`blocked-page-recovery` —— 那是 Hermes 自带 skill，随发行版走，不收进来

## 与 Evolution 的关系

这四条的内容目前仍以 `~/Documents/Evolution` 里的包为准：

```
Strategic/Personal/InformationCollection/skills/{info-from-videos,listen-to-a-record}
Strategic/Personal/AgentSkill-WatchingVideo/skills/watching-video
Strategic/Personal/AgentSkill-Download/skills/download-from-anywhere
```

本仓库是它们的**发行副本**：给云端和别的设备一个单点拉取入口。改动请先改 Evolution 里的源，再同步过来，不要在这里直接改。

## 许可

MIT
