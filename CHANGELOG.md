# Changelog

本文件记录 MultiMediaGrep 的版本变更摘要；各版本的完整升级说明与迁移清单见 `docs/RELEASE-NOTES-v*.md`。

## [0.3.1] - 2026-11-24

详细说明见 [`docs/RELEASE-NOTES-v0.3.1.md`](docs/RELEASE-NOTES-v0.3.1.md)。

### Added
- 新增 **DeepSeek ASR provider**（`MMGREP_ASR_PROVIDER=deepseek` 与每请求头 `x-mmgrep-asr-provider: deepseek`），对接 `POST {baseUrl}/tools/asr`（默认 `https://api.deepseek.com/v1`）。
- 新增环境变量 `MMGREP_DEEPSEEK_API_KEY`、`MMGREP_DEEPSEEK_BASE_URL`、`MMGREP_DEEPSEEK_MODEL` 及对应每请求头 `x-mmgrep-deepseek-*`；`deepseek` 下 `MMGREP_ASR_MAX_BYTES` 默认为 `8 MiB`（`8388608` bytes），请求体仅发送 `file` 字段。

### Fixed
- 修复 `MMGREP_ASR_LANGUAGE=auto` 时将 `auto` 透传给 ASR 服务商导致识别失败的问题。
- 同步 `src/server/config.js` 的 `SERVER_VERSION` 与 `package.json` 版本一致。

## [0.3.0]

详细说明见 [`docs/RELEASE-NOTES-v0.3.0.md`](docs/RELEASE-NOTES-v0.3.0.md)。

### Added
- 新增两个写工具：`media_bookmark`（目录 / 章节 / 书签）与 `media_annotate`（批注 / 注释 / 评论），在源文件旁维护 `<file>.mmgrep.*.json` sidecar 作为唯一真相源，并同步嵌入 PDF（原地改写，需 `mutool`）或输出视频/录音同名 `.vtt`。
- 读侧（`media_probe` / `media_overview` / `media_locate`）统一展示目录（sidecar → 文件自带 → heading 生成）与批注（probe 报条数，overview 挂在页/时间段旁，locate 搜索批注 note）。

### Changed
- 目录文本行格式统一为 `b1  p.1  标题` / `b1  00:12:34  标题`（条目带稳定 id `b1…`）；原有四个只读工具的参数、环境变量与传输方式保持兼容。

## [0.2.0]

详细说明见 [`docs/RELEASE-NOTES-v0.2.0.md`](docs/RELEASE-NOTES-v0.2.0.md)。

### Added
- 新增可选 Streamable HTTP 传输（`--http` / `MMGREP_TRANSPORT=http`）、Bearer 鉴权、`x-mmgrep-*` 每请求凭据头与 `x-mmgrep-max-text-inline-chars` 内联上限覆盖。
- 文档新增 `text`（原生文字层/纯文本）与 `mixed` 来源标签，支持 `ocr: "force"` 强制重识别坏文字层与 `view`（`auto` / `outline` / `text`）内联预览分层（`whole` → `skim` → `sampled`）。

### Changed (Breaking)
- 文档解析拆分为 `MMGREP_OCR_PROVIDER`（默认 `none`）与 `MMGREP_TYPESET_PROVIDER`（默认 `builtin`）两个角色，移除 `MMGREP_DOC_PROVIDER` / `MMGREP_DOC_API_KEY` / `MMGREP_DOC_BASE_URL` / `MMGREP_DOC_MODEL`。
- 文档 `media_locate` 改为返回页码、命中次数与命中附近片段（`hits` / `snippet` / `fuzzy`），不再倾倒整页。

## [0.1.0]

详细说明见 [`docs/RELEASE-NOTES-v0.1.0.md`](docs/RELEASE-NOTES-v0.1.0.md)。

### Added
- 初始版本：基于 stdio 的本地媒体感知 MCP server，提供 `media_probe`、`media_overview`、`media_zoom`、`media_locate` 四个只读工具，支持视频、录音与文档（PDF / 纯文本 / 图片）。
