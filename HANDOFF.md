# MultiMediaGrep — 交接说明

> 新 agent 从这里开始。读完这份文件 + `bd list`，再动手。

## 1. 这个 repo 是什么

**提取层**：管的是"**已经有了的**文档 / 视频 / 音频，Agent 如何从中提取信息"。
**不负责从数据源获取信息**——那是 IntelligenceAtlas + 各源自己的 skill/MCP 的事。

三层分工（全项目通用）：

```
┌─ 数据源层（获取）────────────────────────────────────┐
│  IntelligenceAtlas ← 另一个 repo，"查什么该去哪查"     │
│  各源自己的 skill / MCP：cnki-*、gnomad-graphql-skill、│
│  bilibili-mcp、tushare…                              │
└─────────────────────┬────────────────────────────────┘
                      │ 产出：文档 / 视频 / 音频 / 表格
┌─────────────────────▼────────────────────────────────┐
│  MultiMediaGrep（提取）= MCP                          │
│  输入：已经存在的媒体/文档                             │
│  输出：摘要 + 要点 + 带时间戳的证据                    │
└──────────────────────────────────────────────────────┘
```

**与 IntelligenceAtlas 的接口边界**：
- IntelligenceAtlas 决定"去哪个源拿"；本 repo 决定"拿到的东西怎么读"
- 本 repo **不写** `access` / `entry` / `auth` 这类取数信息
- 本 repo **不下载、不收 URL、不管 cookie**。下载、登录、账号侧数据全部是取数层的事（相关票已迁到 IntelligenceAtlas `ei7.1`~`ei7.5`）

**输入 / 输出契约（2026-11-01 定）**：
- 输入：已存在的本地文件，三类——**视频**（可附带字幕文件）、**录音**、**文档**
- 视频字幕由取数层一并拿（例如 B站：`yt-dlp --write-subs` 或 bilibili-mcp 拿字幕 + 任意下载器拿视频）。本 repo 有字幕就用字幕（区分人工 / AI 字幕），没有才跑 ASR
- 输出：要点 + 证据定位（视频/录音用时间戳，文档用页码/段落）+ 来源标注（`subtitle|ai_subtitle|asr|document`），摘要可选

## 2. 已经定死的决策（别推翻，除非用户明确说）

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| 1 | **MCP 不依赖 LLM**，只绑定专用模型服务（ASR 之类） | 跨 agent 复用时，server 带 LLM 就要每台机器配 key、各 agent 行为不一致。server 做客观提取，理解交给 client 的模型 | 2026-11-01 |
| 2 | **能力 = 工具，不做渐进式加载** | 用户明确纠正：多媒体理解是 bot 的基本能力，应该作为工具提供。skill 不直接暴露工具 | 2026-11-01 |
| 3 | 省 token 的来源是"**原始转写全文从不进 agent 上下文**"，不是接口分几层 | 我一开始做成 probe-first + handle 分页，被否了 | 2026-11-01 |
| 4 | **优先复用现成 MCP server**，不自研取数/转写 | 生态已很成熟，见 §4 | 2026-11-01 |
| 5 | skills 不再是能力载体，MultiMediaGrep 要从 skill 包转成 MCP server | skill 只暴露 prompt，不提供工具 | 2026-11-01 |
| 6 | 不锁 commit，跟随上游 latest | 用户决策 | 2026-11-01 |
| 7 | **只做提取，不取数**；输入是本地文件（视频+可选字幕 / 录音 / 文档） | 用户明确：取数不是本 repo 的事，B站字幕和视频由取数层一起拿 | 2026-11-01 |

**可选路径（未定）**：MCP sampling —— server 通过 `sampling/createMessage` 反向请求 client 的模型做摘要，server 自身零 LLM 依赖。
Hermes **支持**（`~/.hermes/hermes-agent/tools/mcp_tool_sampling.py`，含 modelPreferences / max_tokens_cap / 限流 / tool-use 结果）；Claude Code/Desktop 也支持。
`MultiMediaGrep-csd` 决策票里要定要不要走这条。

## 3. 当前 repo 状态

```
MultiMediaGrep/
├── README.md              ← 顶部有"定位变更"横幅，说明正在转 MCP server
├── skills/                ← 4 个旧 skill，尚未瘦身
│   ├── info-from-videos/     （视频：CC字幕→ASR→关键帧）
│   ├── listen-to-a-record/   （本地录音转写）
│   ├── watching-video/       （B站账号侧 + 直播 + 本机app录屏）
│   └── download-from-anywhere/（通用下载兜底，**属取数层**，按决策 #7 不再归本 repo）
├── .beads/                ← 21 张票 + 7 张已关
└── issue_map.json{2,3}    ← 建票时生成的映射（未跟踪，可删）
```

- git：`229e61a` 初始提交 + `6936082` bd init。**README.md 已改未提交**
- skills 内容源自 `~/Documents/Evolution/Strategic/Personal/InformationCollection` 等包（**Evolution 才是真源**）

## 4. 生态调研结论（2026-11-01，必读，省得重查）

> **按决策 #7 读这张表**：bilibili-mcp / bilinote / linkdigest / Apify 是**取数工具**，对本 repo 只是上游，不是要复用的提取后端（评估票已迁 IntelligenceAtlas）。yueying / vidknot 只看它们的**本地文件**路径。文档与录音的候选见表后补充。

现成方案已覆盖大部分工作量：

| 候选 | 覆盖 | 关键特点 |
|---|---|---|
| **yueying**（PyPI，6 工具） | B站/YouTube/抖音/小红书/本地文件 | `uvx` 即跑，**离线无 API key**；文字稿+关键帧九宫格；yt-dlp ≤720p 后删原视频；先九宫格再看单帧，每次≤3张 |
| **@xzxzzx/bilibili-mcp**（npm v1.14.4，13 工具） | B站全能力 | 原生字幕优先 + 显式 `fallback_to_asr`；**区分 ai-* 与人工字幕**（双读完整性评估）；关键词搜原话带 `?p=4&t=1.12` 时刻链接；扫码登录，凭据不外泄；纯 stdio |
| **bilinote**（PyPI，15 工具） | B站 + 批量字幕 CLI | 纯 Python，自维护 Wbi 签名；ASR 走必剪免费接口（IP 频控 -412）；README 目标客户端直接含 DSH |
| **vidknot**（PyPI） | 11+ 平台 | 双 ASR 交叉校验；**同时给 CLI/FastAPI/MCP/Python API**（FastAPI 可部署成 HTTP 给远端 agent） |
| **youtube-knowledge-mcp**（npm，44 工具） | YouTube | HTTP+Docker+Render；MCP_AUTH_TOKEN；transcript 缓存 TTL 30 天 |
| **vidlens-mcp**（npm，40+ 工具） | 多平台 + 视觉索引 | Apple Vision OCR + Gemini 帧描述 + 嵌入检索 |
| **mcptube**（PyPI，13 工具） | YouTube | passthrough：server 不做 LLM 推理，client 做 |
| **linkdigest.dev** | 抖音/小红书/TikTok/YouTube/X | 托管，**不支持 B站**（412），10 免费 credits 后 $5/250 |
| **Apify** | 多 actor | 托管 HTTP MCP + OAuth，$4-25/1000 |

**补充：文档与录音（候选，尚未核实）**：
- 文档：markitdown（含 markitdown-mcp，Microsoft）、Docling（含 docling-mcp，IBM，版面/表格更强）→ 票 `9z5.1`
- 录音：本地 Whisper 系（mlx-whisper / faster-whisper / whisperX），社区 Whisper MCP 多但无公认标准；需评估说话人区分 → 票 `9z5.2`

**两个关键判断**：
1. **取数+转写全覆盖（取数部分归上游），但"压成摘要+要点+带时间戳证据"这层是空的**——现有 server 基本都把转写全文交给 agent
2. **MCP 工具数量直接吃常驻上下文**。挂 20-40 个工具的 schema 与"省 token"目标冲突。所以对外只暴露 1-3 个工具

**建议路线**（`csd` 票待定）：薄压缩层——我们的 server 内部作为 MCP client 调现成的（或直接调底层库），对外只暴露 `media_understand(path, subtitles?, question?)` → `{summary?, key_points[], evidence[{start,end,quote}], source(subtitle|ai_subtitle|asr|document), duration, frames?}`，原始全文留在 server 侧。`path` 只收本地文件，不收 URL。

## 5. beads 票（2026-11-01 更新）

```
P1 决策  csd   最终定位三选一（A 零开发 / B 薄压缩层 / C 全自研）—— 建议 B
P1 设计  ypk   工具面契约（media_understand 为主入口）      ← csd 的下游
       32x   token 预算原则（原始转写不进 agent 上下文）
       9my   多宿主分发与部署形态（Claude / DS220p2022 / 腾讯云）
P1 评估  8vh   yueying 实测
       gv5   vidknot 实测
       9z5.1 文档理解后端（markitdown / docling）
       9z5.2 录音理解（本地 ASR + 说话人区分）
P1 实现  5iv   media_understand 一次调用完成整套理解
       3e6   问答与证据定位（全文检索 + 时间戳证据）
       q3w   ASR 后端可插拔（mlx-whisper / faster-whisper / 外部服务）
       qdc   server 骨架（stdio+HTTP、无状态、后端插件化、/health）
P1 设计  0yw   薄压缩层工具面
P2 决策  29f   部署拓扑：各处各跑一份 vs 中心服务
P2 部署  4m6   DS220p2022 运行形态（Container Manager / 裸机 systemd / venv）
       3l4   腾讯云 research profile 接入与常驻
P2 接入  qz6   三个 Hermes 实例挂载并实测
       3lh   Claude Code 接入验证
       54c   端到端对照（skill 路径 vs MCP 路径）
P2 方向  m7d   skill 退役决策
P3      8b0   打包发布 / 4f1 README 重写 / 61h 第三个 client
P3      wud   MultiMediaGrep 与 Scratch 两个 beads 库的归一方案
```

已关（7 张，理由在 close reason 里）：`yyw` probe、`pkk` transcript、`3rj` frames、`kfk` summarize、`7l7` audio_transcribe、`rk5` handle 存储、`lke` resources 层——**都被合并进主入口或降级为内部实现，不要复活成独立对外工具**。

已迁 IntelligenceAtlas（取数层，2026-11-01）：`cmh` 下载兜底 → `ei7.1`、`0u2` cookie 管理 → `ei7.2`、`j8u` bilibili-mcp 实测 → `ei7.3`、`e5x` 托管方案 → `ei7.4`、`qht` watching-video 独有能力（B站账号侧 + 直播/录屏）→ `ei7.5`。**不要在本 repo 重建这些票**。

`bd ready` 会给出当前无阻塞的票。

## 6. 命令

```bash
cd ~/Repositories/AgentNative/MultiMediaGrep
bd list                      # 全部票
bd ready                     # 无阻塞可做
bd show <id> --long          # 看验收标准
bd close <id> --reason "..." # 关票要写理由
```

Hermes MCP 相关：
```bash
~/.local/bin/hermes mcp add <name> --command <cmd> --args ...   # stdio
~/.local/bin/hermes mcp add <name> --url <http-url> --auth header # HTTP
~/.local/bin/hermes mcp list / test / configure                  # 查看/测试/工具级开关
~/.local/bin/hermes mcp catalog                                 # Hermes 官方目录（SaaS 类为主，无视频/转写类）
```

## 7. 环境事实

- 腾讯云 research profile：`43.142.18.254`，`~/.local/bin/hermes -p research`
- DS220p2022：NAS，Linux x86，Tailscale `wfl-ds220p2022`（LAN IP 10.10.74.242 **不可达**，只走 Tailscale）
- 腾讯云：Linux x86，**无 GPU**；NAS 也是 x86 无独显 → ASR 只能用 CPU 后端（faster-whisper / whisper.cpp）
- Mac 是 arm64 → 可用 mlx-whisper
- **ASR 必须留在有 GPU 的机器或用 CPU 后端**，跨机调用会引入网络与延迟问题
- Hermes MCP 客户端支持 sampling（`~/.hermes/hermes-agent/tools/mcp_tool_sampling.py`）

## 8. 未决问题（要用户拍板，别自己定）

1. **路线 A/B/C**（`csd`）—— 我倾向 B
2. **部署拓扑**（`29f`）—— 我倾向"各处各跑一份"（Mac 关机不影响 NAS），代价是两套实例要各自维护（cookie 已归取数层，不再是本 repo 的代价）
3. **4 个 skill 删还是留薄说明**（`m7d`）—— 我倾向留薄说明
4. **摘要放哪**：server 侧专用模型 / MCP sampling 借 client 的模型 / 不做摘要只给结构化提取

## 9. 给新 agent 的约束

- **不要擅自 commit**。用户明确要求：只执行明确指令，禁止超出范围的额外操作（如提交文档）。改完文件先告诉用户，由他决定是否提交
- **不要往用户的 Python 环境装东西**。用 `uvx` / `pipx` 隔离；要装 Hermes 相关依赖先问
- **经验写 Hindsight**，不要写进 Hermes 自己的记忆或自动创建 skill
- **cookie / 凭据不经手**。bilibili-mcp / bilinote 都要求在本地终端交互输入，不要索要或记录用户凭据
- 别把 `~/Workspace/Scratch` 里的一次性脚本当成正式工具——那些只是当轮生成用的，`scripts/` 下的两个脚本才是仓库里的正式工具

## 10. 已知坑

- `bd dep add A B` 是 **A 依赖 B**（第一个参数是依赖方），方向搞反会让 `bd ready` 给出错误的可做清单
- `bd dep add` **不支持逗号分隔**的多目标，必须逐个调用
- Hermes `config set` 不认 `agent.personalities.X.system_prompt`，要用顶层 `personalities.X.system_prompt`
- personality 激活会**顶掉** `agent.system_prompt`（`resolve_ephemeral_system_prompt` 直接返回人格文本），所以基线只能写 SOUL.md
- 插件按 profile 安装：`plugins.enabled: [hindsight]` 不够，还要 `profiles/<name>/plugins/<name>` 软链
- 新建 Hermes profile 的 `.env` 是空的，不继承全局，缺 key 会报 401
