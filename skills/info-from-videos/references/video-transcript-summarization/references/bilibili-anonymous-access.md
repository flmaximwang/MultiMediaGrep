# B站访问能力边界（实测）

决定「走字幕腿还是 ASR 腿」的判据表。**先看登录那半张表** —— 登录后字幕是秒级的，
比转写便宜一个数量级。

## 登录态（有 SESSDATA）

| 接口 / 用法 | 可用 | 说明 |
|---|---|---|
| `bili video <BV> --subtitle` | ✅ | 秒级拿 CC / AI 字幕全文（`bili video --yaml` 里 `subtitle.available: true`） |
| `bili video <BV> --subtitle-timeline --yaml` | ✅ | 带时间戳，用于「第几秒说了什么」 |
| `yt-dlp --list-subs <URL>` | ✅ | 出现除 `danmaku` 以外的语言才是真有字幕 |
| 1080P 高码率 | ✅（需大会员） | 有大会员 cookie 才拿得到；音频流不受影响 |

登录做法（含「扫码成功但存下空 sessdata」这个坑）→ `~/.hermes/skills/info-from-videos/references/bilibili-login.md`。

## 匿名（无 SESSDATA）

| 接口 / 用法 | 匿名可用 | 说明 |
|---|---|---|
| `x/web-interface/view?bvid=...` | ✅ `code:0` | 拿 title/desc/cid（cid 是后续接口的必需参数） |
| `x/player/playurl?bvid=&cid=&fnval=16` | ✅ `code:0` | 拿到音视频流地址；音频 only 流足够转写 |
| `x/player/v2?bvid=&cid=` | ⚠️ `code:0` 但 `subtitle.subtitles=[]` | 匿名字幕列表为空 → **字幕需登录态** |
| `x/web-interface/wbi/search/type` | ❌ | 风控：返回 412 / `v_voucher`（需 wbi 签名 + cookie） |
| `yt-dlp --list-subs <URL>` | ✅ 可跑 | 结果只列 `danmaku xml` = 该视频无 CC/AI 字幕可取 |
| `yt-dlp -f 30232 <URL>` | ✅ | 音频流匿名可下，约 **0.5 MB/分钟** |
| `yt-dlp bilisearchN:关键词` | ✅ 但限速 | yt-dlp 自带 wbi 签名，能返回 id 列表；**连续调用第二次 412**，间隔 sleep |
| 1080P 高码率 | ❌ | 需大会员 cookie；不影响音频 / 低清晰度 |

## 结论

- 想「秒级拿文字」→ **先登录**（`~/.hermes/skills/info-from-videos/references/bilibili-login.md`）：B站 CC/AI 字幕登录后可得，
  不必一上来就转写。
- 登录后 `subtitle.available` 仍为 false（该 UP 没开字幕），才走：
  `yt-dlp -f 30232/bestaudio` 取音频 → `mlx_whisper` 转写。
- 判断有没有字幕先跑 `--list-subs` 或看 `--yaml` 里的 `subtitle.available`，
  别凭「B站都没字幕」的印象直接放弃字幕腿。
