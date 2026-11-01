#!/usr/bin/env node
// src/index.js —— MultiMediaGrep MCP server 入口（stdio transport）
//
// **stdout 是 MCP 协议通道**：这里所有日志都走 stderr（createLogger 固定写 process.stderr）。
// 启动后进程阻塞在 stdin 上，直到 client 关闭连接。

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createRuntime, createServer, logStartupBanner } from './server/index.js';

async function main() {
  const runtime = await createRuntime();
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
