# MultiMediaGrep v0.3.1

本版本在 `v0.3.0` 基础上新增 **DeepSeek ASR provider** 支持，并修复 ASR 语言码 `auto` 的透传问题（无破坏性变更）。

- 仓库：<https://github.com/flmaximwang/MultiMediaGrep>
- 契约：[`docs/mcp-contract.md`](mcp-contract.md)（§12.2.1 / §12.7）｜安装运维：[`docs/install.md`](install.md)（§3.3）

## 安装

```bash
# 从 GitHub 装
npx -y github:flmaximwang/MultiMediaGrep

# 或装 release 里的运行时包
npm i -y https://github.com/flmaximwang/MultiMediaGrep/releases/download/v0.3.1/multimediagrep-mcp-0.3.1.tgz
```

## 更新内容

### 新功能

- **DeepSeek ASR provider（PR #9）**：
  - 新增 `MMGREP_ASR_PROVIDER=deepseek`（及每请求请求头 `x-mmgrep-asr-provider: deepseek`），对接 `POST {baseUrl}/tools/asr`（默认 `https://api.deepseek.com/v1`）。
  - 新增环境变量 `MMGREP_DEEPSEEK_API_KEY`、`MMGREP_DEEPSEEK_BASE_URL`、`MMGREP_DEEPSEEK_MODEL` 与对应每请求头 `x-mmgrep-deepseek-*`。
  - 按 `deepseek` 服务端限制设定默认单次上限为 `8 MiB`（`8388608` bytes），请求体仅发送 `file` 字段（不发送 `model` / `language`），并在音频/视频未配置提示与文档（`README.md`、`docs/install.md` §3.3、`docs/mcp-contract.md` §12.2.1 / §12.7、`src/providers/asr/README.md`）中同步补充说明。
- **同步 `SERVER_VERSION`**：将 `src/server/config.js` 中的 `SERVER_VERSION` 更新至 `0.3.1` 与 `package.json` 保持一致。

### 修复

- **ASR `auto` 语言码处理（PR #8，closes #5）**：当 `MMGREP_ASR_LANGUAGE=auto` 时不再把 `auto` 作为语言参数发往 ASR 服务商，避免部分服务商拒绝识别或报错。

## 验证

- `npm run check`：`137 file(s) ok`
- `npm test`：`709` tests / `24` suites 全部通过（0 fail, 0 skipped）
