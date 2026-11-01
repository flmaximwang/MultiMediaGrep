# CREDITS.md

本文件说明 MultiMediaGrep 里**别人贡献了什么**，以及哪些东西**由用户自己安装、不随本仓库分发**。

> 上游项目自己的完整致谢（设计灵感来源、社区贡献者名单、测试素材作者）见
> [dsh-video-storyboard 的 CREDITS.md](https://github.com/SAOS-3624/dsh-video-storyboard/blob/main/CREDITS.md)。
> 本项目只派生其中一部分源码（见第 1 节），未复制整棵源码树。

---

## 1. 派生自上游的源码

本项目有四个模块，外加一个内联函数，派生自
[dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)
（Apache-2.0，© 2026 SAOS-3624）v0.5.9，commit `6bc8291`。

| 本项目的模块 | 内容 | 上游来源文件 |
|---|---|---|
| `src/backend/video/geometry.js` | 显示几何：帧率/SAR 解析、旋转归一、显示宽高比 | `src/storyboard/probe.js` |
| `src/backend/video/frames.js` | 取帧、锐度选帧（Laplacian 方差）、PNG 编码 | `src/storyboard/sheet.js` |
| `src/backend/video/sheet.js` | 宫格的纯绘制层：画布布局、填色、点阵数字、编号徽标、贴帧 | `src/storyboard/sheet.js` |
| `src/backend/video/shots.js` | HSV 加权镜头切分（PySceneDetect ContentDetector 思路的独立实现） | `src/storyboard/scan.js` |
| `src/backend/video/storyboard.js` 的私有 `mapPool` | 固定并发数、保持输出顺序的 map | `src/storyboard/frames.js` |

- 这些源码**已被修改**：只保留本项目实际用到的函数，进程调用统一改走本项目自己的
  `src/media/ffmpeg.js`，未使用的上游特性已删除；每个派生文件顶部都有
  「来源与改编说明」段落（Apache-2.0 §4(b)）。
- 根目录 `NOTICE` 按 Apache-2.0 §4(d) 复现了上游 `Copyright 2026 SAOS-3624` 行与
  Apache-2.0 授权文本；其余部分（镜头格规划、拼装、缓存封装等）是本项目自己的代码。
- 上游的设计灵感（dsh-video-see / dsh-video-lens / watch-skill / PySceneDetect / TransNet V2）
  **只取判断、不取代码**，上游自己已逐项声明，见
  [上游 CREDITS.md 第 1 节](https://github.com/SAOS-3624/dsh-video-storyboard/blob/main/CREDITS.md)。

## 2. 运行时外部依赖（**不随本仓库分发**，由用户自行安装）

| 组件 | 许可 | 在本项目里的用法 |
|---|---|---|
| FFmpeg / ffprobe | LGPL-2.1-or-later（用户自选构建，可能是 GPL） | 在 `PATH` 上查找，或经 `MMGREP_FFMPEG_PATH` / `MMGREP_FFPROBE_PATH` 指定；以独立子进程调用（argv，不经 shell），**不打包、不链接** |
| ElevenLabs（ASR） | 商业 API | 由本项目的 ASR provider 直接调用（HTTP），结果作为带时间轴的段落进入后端；不含第三方客户端库 |
| MinerU（文档解析） | 外部 API 服务 | 由本项目的文档 provider 直接调用（HTTP），把页面栅格图解析成每页文字；不含其模型或二进制 |

## 3. 模型权重（**不随本仓库分发**）

| 模型 | 许可 | 说明 |
|---|---|---|
| SenseVoiceSmall | FunASR Model Open Source License Agreement v1.1（© 2023-2028 Alibaba Group） | **本项目不使用它**。它属于上游的 ASR 方案，本项目未采用该方案。若你自行装了它，按协议 §2.2 须注明出处与作者 |
| rapidocr（本地 OCR） | Apache-2.0 | **本项目不使用它**。上游靠 Python + rapidocr 做本地 OCR，本项目改走外部 OCR 服务（MinerU），所以没有引入 `ocr_bridge.py` / `python.js` |

## 4. 本项目自带的依赖

见 `package.json` 的 `dependencies`。其中 `@modelcontextprotocol/sdk` 与 `zod` 均为 MIT。
派生自上游的那部分代码**零 npm 运行时依赖**（上游 `package.json` 的 `dependencies` 是空的，
唯一的 `peerDependencies` 是 DeepSeek Harness 宿主包 `@deepseek-ai/dsh-tools`，本项目不用它）。

## 5. 上游的社区贡献

上游的贡献者名单（提出诊断、复现反例、提交 PR 的人）见
[dsh-video-storyboard 的 CREDITS.md 第 4 节](https://github.com/SAOS-3624/dsh-video-storyboard/blob/main/CREDITS.md)。
本项目的派生代码来自他们的工作，特此说明。

---

*本文件不是法律意见；它只是把「该做的事」写成了清单。*
