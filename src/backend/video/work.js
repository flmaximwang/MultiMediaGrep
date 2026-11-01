// src/backend/video/work.js —— 视频后端的临时工作目录
//
// 约定（与 audio 后端一致）：**永远不往用户输入旁边写文件**。所有中间产物
// （ASR 用的 WAV / 切片、zoom 用的 PNG）都落在 MMGREP_CACHE_DIR 下的 work/video/。
//
// 工作目录的键不用文件内容的 sha256（长视频哈希整份文件会把一次 zoom 变成磁盘扫描）；
// 这里用「绝对路径 + size + mtime」的 sha256 前 16 位。它只用于避免并发调用互相覆盖，
// 不是内容寻址缓存，所以不承担「内容变了要复用」的语义。

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { resolveCacheConfig } from '../../cache/index.js';

function workKey({ path: filePath, size, mtimeMs }) {
  return createHash('sha256')
    .update(`${filePath}\0${size}\0${mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
}

/** 本次后端实例的工作目录（按源文件路径/大小/mtime 稳定，进程间可并存不同后缀文件） */
export async function makeWorkDir(sourcePath, kind = 'video') {
  const { dir } = resolveCacheConfig(process.env);
  const info = await stat(sourcePath);
  const workDir = path.join(dir, 'work', 'video', `${kind}-${workKey({
    path: sourcePath,
    size: info.size,
    mtimeMs: info.mtimeMs,
  })}`);
  await mkdir(workDir, { recursive: true });
  return workDir;
}

/** 一次调用独占的文件名后缀，避免同一进程内并发请求读到自己没写完的 PNG */
export function uniqueSuffix() {
  return randomUUID().slice(0, 10);
}
