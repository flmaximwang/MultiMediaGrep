# CREDITS.md

本文件说明 MultiMediaGrep 里**别人贡献了什么**，以及哪些东西**由用户自己安装、不随本仓库分发**。

> 上游项目自己的完整致谢（设计灵感来源、社区贡献者名单、测试素材作者）原样保留在
> [`vendor/dsh-video-storyboard/CREDITS.md`](vendor/dsh-video-storyboard/CREDITS.md)。
> 那份文件是 vendored 代码的一部分，不要改它。

---

## 1. Vendored 源码（本仓库唯一的第三方代码）

| 项目 | 许可 | 版权 | 用法 |
|---|---|---|---|
| [dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) | Apache-2.0 | © 2026 SAOS-3624 | 源码 vendor 进 `vendor/dsh-video-storyboard/`，本地改动逐文件标注（见 `VENDOR.md`） |

- 上游版本：**v0.5.9**，commit `6bc8291`，vendor 时间 2026-11-01。
- 许可全文：`vendor/dsh-video-storyboard/LICENSE`（逐字复制，未改动）。
- 上游 NOTICE：`vendor/dsh-video-storyboard/NOTICE`（逐字复制）；根目录 `NOTICE` 按 Apache-2.0 §4(d)
  复制了其中的署名内容。
- Apache-2.0 §4 要求「被改动的文件要标注修改」：本仓库的每个改动文件顶部都有
  `Modifications:` 段落，完整清单见 `VENDOR.md`。
- 上游的设计灵感（dsh-video-see / dsh-video-lens / watch-skill / PySceneDetect / TransNet V2）
  **只取判断、不取代码**，上游自己已逐项声明，见 vendored 的 `CREDITS.md` 第 1 节。

## 2. 运行时外部依赖（**不随本仓库分发**，由用户自行安装）

| 组件 | 许可 | 在本项目里的用法 |
|---|---|---|
| FFmpeg / ffprobe | LGPL-2.1-or-later（用户自选构建，可能是 GPL） | 通过 `PATH` 以独立子进程调用（argv，不经 shell），**不打包、不链接**。上游的 `binaries.js` 会找宿主目录里的 ffmpeg/ffprobe |
| yt-dlp | Unlicense | 可选。只有宿主显式给出可执行文件路径时，站点字幕轨（`subtitles.js`）才会用；**本仓库不内置下载能力**，取数由宿主项目负责 |
| ElevenLabs（ASR） | 商业 API | 由本项目的 ASR provider 调用，结果以 `transcriptSegments` 传入 vendored pipeline；vendored 代码里**不含**任何 ASR 客户端 |

## 3. 模型权重（**不随本仓库分发**）

| 模型 | 许可 | 说明 |
|---|---|---|
| SenseVoiceSmall | FunASR Model Open Source License Agreement v1.1（© 2023-2028 Alibaba Group） | **本项目不使用它**。它属于上游的 ASR 方案，而上游的 ASR 模块（`asr.js`）没有 vendor 进来。若你自行装了它，按协议 §2.2 须注明出处与作者 |
| rapidocr（本地 OCR） | Apache-2.0 | **本项目不使用它**。上游靠 Python + rapidocr 做本地 OCR，本项目改走外部 OCR 服务（MinerU），所以 `ocr_bridge.py` 与 `python.js` 没有 vendor 进来 |

## 4. 本项目自带的依赖

见 `package.json` 的 `dependencies`。其中 `@modelcontextprotocol/sdk` 与 `zod` 均为 MIT。
vendored 的那部分代码**零 npm 运行时依赖**（上游 `package.json` 的 `dependencies` 是空的，
唯一的 `peerDependencies` 是 DeepSeek Harness 宿主包 `@deepseek-ai/dsh-tools`，本项目不用它）。

## 5. 上游的社区贡献

上游的贡献者名单（提出诊断、复现反例、提交 PR 的人）在
[`vendor/dsh-video-storyboard/CREDITS.md`](vendor/dsh-video-storyboard/CREDITS.md) 第 4 节。
我们 vendor 的是他们的代码，所以那份名单原样跟着走。

---

*本文件不是法律意见；它只是把「该做的事」写成了清单。*
