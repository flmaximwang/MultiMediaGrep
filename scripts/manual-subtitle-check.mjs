// 手工验证脚本（不属于测试套件）：跑一遍真实后端，检查字幕措辞与滚动警告。
// 用法：MMGREP_CACHE_DIR=$(mktemp -d) node scripts/manual-subtitle-check.mjs <媒体文件>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createRuntime, createServer } from '../src/server/index.js';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/manual-subtitle-check.mjs <media-file>');
  process.exit(2);
}

const runtime = await createRuntime();
const server = createServer({ runtime });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'manual-check', version: '0.0.0' });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const probe = await client.callTool({ name: 'media_probe', arguments: { path: target } });
console.log('=== probe ===');
console.log(probe.content[0].text);

const overview = await client.callTool({ name: 'media_overview', arguments: { path: target, images: 0 } });
console.log('=== overview (images: 0) ===');
console.log(overview.content[0].text);

const locate = await client.callTool({ name: 'media_locate', arguments: { path: target, query: 'SUBTITLE' } });
console.log('=== locate ===');
console.log(locate.content[0].text);
console.log('locate warnings:', JSON.stringify(locate.structuredContent?.warnings ?? []));

const texts = [probe.content[0].text, overview.content[0].text, locate.content[0].text].join('\n');
const banned = [/safe to quote/i, /author'?s own words/i, /可安全引用/, /可以当原话引用/];
const hits = banned.filter((re) => re.test(texts)).map((re) => String(re));
console.log('=== verdict ===');
console.log('banned-phrase hits:', hits.length ? hits.join(', ') : 'none');

await client.close();
process.exit(hits.length ? 1 : 0);
