# B站登录（拿 CC 字幕的前置）

**为什么要登录**：匿名 `x/player/v2` 的 `subtitle.subtitles` 是空的，`--list-subs` 只列
`danmaku` —— 拿不到 CC / AI 字幕就只能走 ASR，转录质量差一档（人名、数字、术语都可能错）。
登录后 `bili video BVxxx --subtitle` 直接给全文，秒级、零下载。

凭证文件：`~/.bilibili-cli/credential.json`（键 `sessdata` / `bili_jct` / `dedeuserid` /
`ac_time_value` 与 `saved_at`）。

## 什么样的登录算成功（判据，不是感觉）

```bash
export PATH="$HOME/.local/bin:$PATH"
bili status        # authenticated: true 且报出 user.name（实测 2026-10-13：Swcpk）
```

再回读凭证里 `sessdata` **非空**。两条都过才算登上 —— 只看「扫码后 CLI 没报错」会踩下面的坑。

## 坑 1 · 非交互环境里 `bili login` 会存下空 `sessdata`

`bili login` 把二维码画在终端里（无人值守时没人看得见），而且实测（2026-10-13）**它在 API 层
登录成功后写下的凭证里 `sessdata` 是空的** —— 库解析 poll 响应里的 cookie 没取到，于是
`bili status` 依旧报未登录。症状是「用户说扫了、CLI 说成功、凭证文件也在，但一点用没有」。

做法：用包里的 `scripts/bili-qr-login.py` —— 同一个库拿二维码，**自己解析 poll 的原始响应**
（`Set-Cookie` 头 + URL 查询串两路取），写凭证前先调 nav 验一次：

```bash
PY=$(ls -d ~/.local/share/uv/tools/bilibili-cli/bin/python)   # 该 venv 才有 aiohttp/qrcode/bilibili_api
"$PY" scripts/bili-qr-login.py /tmp/bili-qr.png               # → QR_SAVED <路径>
```

把 PNG 发给用户扫，等它打 `LOGIN_OK 凭证已保存并验证`（期间会逐行打 `SCANNED`）。

- **二维码是一次性的、有效期约 3 分钟**：用户扫的是最新那张，旧码作废；过期就重跑一次生成新码。
- `NO_SESSDATA` = 这次白扫，直接重来，别去猜 cookie 为什么不完整。

## 坑 2 · `refresh_token` 续不了期

凭证里的 `ac_time_value` 是 refresh token，但 B站的 refresh 流程**必须先有 `sessdata`**。
凭证里 `sessdata` 空着时，试 refresh 一律失败 —— 不要在这条死路上耗时间，直接重扫。

## 坑 3 · 只读不写

`bili` 还能点赞 / 投币 / 发动态，那是拿用户真实账号写操作。**没有明确要求不做**，别为了「测一下
登录好没好」去调用写接口 —— 验证用 `bili status` 与 `nav`。

## 登录后字幕怎么取

```bash
bili video BVxxx --subtitle                  # 纯文本（首选，不用解析）
bili video BVxxx --subtitle-timeline --yaml  # 带时间戳（要引用某一句在第几秒时用）
bili video BVxxx --yaml                      # 先看 subtitle.available 决定走哪条腿
```

`--yaml` 的正文是一个几千字的大块：**别用嵌套量词正则去挖**（实测 `(.+?)+` 这类写法当场回溯炸掉），
逐行处理就够：切出 `text:` 到 `\n  comments:` 之间的块 → 每行 strip → 去掉行首尾单引号 → 拼成全文。
