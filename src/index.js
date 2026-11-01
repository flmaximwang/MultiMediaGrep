#!/usr/bin/env node
// src/index.js —— MultiMediaGrep MCP server 入口
//
// **stdout 是 MCP 协议通道**：这里所有日志都走 stderr（createLogger 固定写 process.stderr）。
// 两种传输方式：
//   - stdio（默认）：连上 StdioServerTransport，进程阻塞在 stdin 上，直到 client 关闭连接；
//   - http：起一个 Streamable HTTP 端点（POST /mcp），见 src/server/http.js。

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { applyTransportOverrides, isLoopbackHost, loadConfig } from './server/config.js';
import { createRuntime, createServer, logStartupBanner } from './server/index.js';
import { startHttpServer } from './server/http.js';

const USAGE = `用法：multimediagrep-mcp [选项]

给 agent 提供「看片 / 听录音 / 读文档」能力的 MCP server：
视频抽帧成故事板、音频转写、文档逐页 OCR。全部只读本地文件，不下载、不调大模型。

选项：
  --http              启用 Streamable HTTP 传输（默认走 stdio）
  --host <地址>       HTTP 监听地址，默认 127.0.0.1
  --port <端口>       HTTP 监听端口，默认 3927
  --token <令牌>      Bearer 令牌；设置后每个请求都要带 Authorization: Bearer <令牌>
  --help              打印本帮助并退出

环境变量：
  MMGREP_TRANSPORT    传输方式：stdio（默认）或 http
  MMGREP_HTTP_HOST    HTTP 监听地址，默认 127.0.0.1
  MMGREP_HTTP_PORT    HTTP 监听端口，默认 3927
  MMGREP_HTTP_TOKEN   Bearer 令牌；设置后 /mcp 必须带 Authorization 头

优先级：命令行参数 > 环境变量 > 默认值。

示例：
  multimediagrep-mcp
  multimediagrep-mcp --http --host 127.0.0.1 --port 3927
  multimediagrep-mcp --http --token <你的令牌>

说明：
  - 令牌的值不会出现在任何日志或本帮助里；HTTP 模式的鉴权只认 Authorization 头，
    不接受用 query string 传令牌。
  - HTTP 模式是**无状态**的：每个请求独立处理，不在内存里保留会话。
`;

/**
 * 解析命令行参数。
 *
 * 优先级链是「命令行 > 环境变量 > 默认值」：这里只解析命令行那层，
 * 真正的合并由 applyTransportOverrides 完成。
 *
 * @returns {{overrides?: object, help?: boolean, error?: string}}
 */
function parseCliArgs(argv) {
  const overrides = {};

  const applyValue = (flag, value) => {
    if (flag === '--host') {
      if (!value) return { error: '--host 需要一个非空的监听地址' };
      overrides.host = value;
      return {};
    }
    if (flag === '--port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { error: `--port 需要 1–65535 之间的整数（收到 "${value}"）` };
      }
      overrides.port = port;
      return {};
    }
    if (flag === '--token') {
      if (!value) return { error: '--token 需要一个非空的令牌' };
      overrides.token = value;
      return {};
    }
    return { error: `未知参数：${flag}` };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--http') {
      overrides.mode = 'http';
      continue;
    }

    // --flag=value 形式
    const inline = /^(--host|--port|--token)=(.*)$/.exec(arg);
    if (inline) {
      const result = applyValue(inline[1], inline[2]);
      if (result.error) return { error: result.error };
      continue;
    }

    if (arg === '--host' || arg === '--port' || arg === '--token') {
      const value = argv[i + 1];
      // --host / --port 的取值不可能以 -- 开头；撞上了就是少写了值。
      // --token 是原样透传的不透明字符串，不做这个判断。
      const looksLikeFlag = value !== undefined && value.startsWith('--') && arg !== '--token';
      if (value === undefined || looksLikeFlag) {
        return { error: `${arg} 缺少参数值` };
      }
      i += 1;
      const result = applyValue(arg, value);
      if (result.error) return { error: result.error };
      continue;
    }

    return { error: `未知参数：${arg}` };
  }

  return { overrides };
}

/** stdio 传输：连上 StdioServerTransport，进程阻塞在 stdin 上 */
async function runStdio(runtime) {
  const server = createServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStartupBanner(runtime);

  const shutdown = async (signal) => {
    runtime.logger.info(`received ${signal}; shutting down.`);
    try {
      await server.close();
    } catch (error) {
      runtime.logger.warn(`error while closing the server: ${error?.message ?? error}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

/** HTTP 传输：起一个 Streamable HTTP 端点 */
async function runHttp(runtime, config) {
  const endpoint = await startHttpServer({ runtime, config });
  const tokenSet = Boolean(config.transport.token);
  const exposed = !isLoopbackHost(config.transport.host) && !tokenSet;

  logStartupBanner(runtime, {
    url: endpoint.url,
    tokenSet,
    warn: exposed
      ? 'http: /mcp 正在监听非回环地址且没有 Bearer 令牌，任何能连到这台机器的人都可以调用'
      : null,
  });

  const shutdown = async (signal) => {
    runtime.logger.info(`received ${signal}; shutting down.`);
    try {
      // 连着未结束的连接一起收掉，否则 close() 会一直等下去
      await endpoint.close();
    } catch (error) {
      runtime.logger.warn(`error while closing the HTTP server: ${error?.message ?? error}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.error) {
    process.stderr.write(`[mmgrep] error: ${cli.error}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  }
  if (cli.help) {
    // 帮助走 stdout：这时进程立刻退出，不会占用 MCP 的协议通道
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const env = process.env;
  const config = applyTransportOverrides(loadConfig(env), cli.overrides);
  const runtime = await createRuntime({ env, config });

  if (config.transport.mode === 'http') {
    await runHttp(runtime, config);
    return;
  }
  await runStdio(runtime);
}

// 未捕获异常也只写 stderr；MCP 客户端会在连接断开时看到 EOF。
process.on('uncaughtException', (error) => {
  process.stderr.write(`[mmgrep] error: uncaught exception: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[mmgrep] error: unhandled rejection: ${reason?.stack ?? reason}\n`);
  process.exitCode = 1;
});

main().catch((error) => {
  process.stderr.write(`[mmgrep] error: failed to start: ${error?.stack ?? error}\n`);
  process.exit(1);
});
