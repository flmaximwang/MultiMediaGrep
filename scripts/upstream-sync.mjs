#!/usr/bin/env node
// upstream-sync.mjs — 跟进上游 dsh-video-storyboard 的更新。
//
// **只产出清单，绝不自动合入。** 这个脚本不写 vendor/、不写 src/、不动 git 索引 ——
// 它只回答一个问题："上游从我们上次同步以来改了什么，其中哪些撞上我们本地改过的文件？"
// 合入与否由人决定。
//
// 用法：
//   node scripts/upstream-sync.mjs --upstream <本地 git 仓库路径 | GitHub URL> [--since <commit>]
//
//   --upstream  上游仓库。本地路径（有 .git/ 的目录）直接分析；
//               GitHub URL 会浅克隆到临时目录再分析（需要网络）。
//   --since     对比的起点 commit。缺省读 vendor/dsh-video-storyboard/UPSTREAM.json 的 commit。
//
// 离线可用：给一个本地 clone 就不需要网络。
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VENDOR_DIR = join(ROOT, 'vendor', 'dsh-video-storyboard');
const UPSTREAM_JSON = join(VENDOR_DIR, 'UPSTREAM.json');
const VENDOR_MD = join(ROOT, 'VENDOR.md');

// 上游仓库里我们没有 vendor 进来的目录/文件（上游的 CLI、测试、文档、CI 配置）。
const NOT_VENDORED_PREFIXES = ['bin/', 'test/', 'docs/', 'scripts/', '.github/', 'extras/'];
const NOT_VENDORED_FILES = new Set([
  'package.json', 'package-lock.json', 'dsh.plugin.json', 'cordis.patch.yml',
  '.gitignore', '.gitattributes', '.mailmap', 'README.md', 'README.zh.md', 'README.en.md',
]);

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { upstream: null, since: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--upstream' || a === '-u') out.upstream = argv[++i];
    else if (a === '--since' || a === '-s') out.since = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--upstream=')) out.upstream = a.slice('--upstream='.length);
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function usage() {
  return [
    'usage: node scripts/upstream-sync.mjs --upstream <local git repo path | GitHub URL> [--since <commit>]',
    '',
    '  --upstream  上游仓库（本地路径或 GitHub URL）。缺省读环境变量 DSH_VIDEO_STORYBOARD_UPSTREAM。',
    '  --since     对比起点 commit。缺省读 vendor/dsh-video-storyboard/UPSTREAM.json 的 commit。',
    '',
    '本脚本只打印待吸收清单，不会修改任何文件。',
  ].join('\n');
}

function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

async function git(cwd, args, opts = {}) {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    maxBuffer: 64 << 20,
    ...opts,
  });
  return stdout;
}

async function gitOrNull(cwd, args, opts = {}) {
  try {
    return await git(cwd, args, opts);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 上游元信息
// ---------------------------------------------------------------------------

async function readUpstreamMeta() {
  if (!existsSync(UPSTREAM_JSON)) {
    throw new Error(`missing ${UPSTREAM_JSON}`);
  }
  return JSON.parse(await readFile(UPSTREAM_JSON, 'utf8'));
}

/**
 * 读 VENDOR.md 里的「本地补丁清单」。
 *
 * 优先读机器可读的 JSON 块（<!-- upstream-sync:patch-list --> 里的 ```json）；
 * 读不到就退回解析 Markdown 表格的第一列 + 状态列。
 */
async function readPatchList() {
  let text = '';
  try {
    text = await readFile(VENDOR_MD, 'utf8');
  } catch {
    return { modified: [], deleted: [], found: false };
  }

  const block = text.match(/<!--\s*upstream-sync:patch-list\s*-->\s*```json\s*([\s\S]*?)```/);
  if (block) {
    try {
      const j = JSON.parse(block[1]);
      return {
        modified: (j.modified ?? []).map(String),
        deleted: (j.deleted ?? []).map(String),
        found: true,
      };
    } catch { /* 落到表格解析 */ }
  }

  const modified = new Set();
  const deleted = new Set();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim().replace(/`/g, ''));
    if (cells.length < 2) continue;
    const path = cells[0];
    if (!path || path.startsWith('-') || path.startsWith('文件')) continue;
    if (!/^(src\/|LICENSE$|NOTICE$|CREDITS\.md$|CHANGELOG\.md$)/.test(path)) continue;
    if (cells.some((c) => /删除|deleted|已移除/i.test(c))) deleted.add(path);
    else modified.add(path);
  }
  return { modified: [...modified], deleted: [...deleted], found: modified.size + deleted.size > 0 };
}

// ---------------------------------------------------------------------------
// CHANGELOG
// ---------------------------------------------------------------------------

function parseChangelog(md) {
  const entries = [];
  const re = /^##\s*\[?([^\]\s]+)\]?\s*(?:[-–]\s*(.*))?$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    entries.push({ version: m[1], date: (m[2] ?? '').trim(), bodyStart: re.lastIndex });
  }
  for (let i = 0; i < entries.length; i += 1) {
    entries[i].body = md
      .slice(entries[i].bodyStart, entries[i + 1] ? entries[i + 1].bodyStart - 200 : md.length)
      .trim();
  }
  return entries;
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 取一条 CHANGELOG 的摘要：优先第一条项目符号，其次正文首行，最后才用标题。 */
function summarize(entry) {
  if (!entry) return '—';
  const clean = (line) => line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/[*_`]/g, '')
    .trim();
  const lines = entry.body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('<!--'));

  // 1) 第一条项目符号（`- xxx`）—— 这通常是"改了什么"最具体的一行
  for (const l of lines) {
    if (/^[-*+]\s+/.test(l)) return clean(l).slice(0, 90) || '—';
  }
  // 2) 第一条不是标题的正文
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) continue;
    const s = clean(l);
    if (s) return s.slice(0, 90);
  }
  // 3) 只有标题（比如某个版本只写了 `### Fixed`）
  for (const l of lines) {
    const s = clean(l);
    if (s) return s.slice(0, 90);
  }
  return '—';
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function resolveUpstream(spec) {
  const local = resolve(expandHome(spec));
  if (existsSync(local) && statSync(local).isDirectory()) {
    if (!existsSync(join(local, '.git'))) {
      throw new Error(`${local} is not a git repository (no .git/)`);
    }
    return { dir: local, cleanup: null };
  }
  // URL：浅克隆到临时目录
  const dir = await mkdtemp(join(tmpdir(), 'dsh-upstream-'));
  try {
    await run('git', ['clone', '--quiet', '--depth', '300', spec, dir], { timeout: 300_000 });
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(
      `cannot clone ${spec}: ${String(e?.stderr || e?.message || e).trim().split('\n')[0]}\n` +
      '提示：没有网络时，改用本地 clone：--upstream /path/to/dsh-video-storyboard',
    );
  }
  return { dir, cleanup: dir };
}

function vendorPathFor(upstreamFile) {
  if (upstreamFile.startsWith('src/')) return join('vendor', 'dsh-video-storyboard', upstreamFile);
  if (['LICENSE', 'NOTICE', 'CREDITS.md', 'CHANGELOG.md'].includes(upstreamFile)) {
    return join('vendor', 'dsh-video-storyboard', upstreamFile);
  }
  return null;
}

function isNotVendored(upstreamFile) {
  return NOT_VENDORED_PREFIXES.some((p) => upstreamFile.startsWith(p))
    || NOT_VENDORED_FILES.has(upstreamFile);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const upstreamSpec = args.upstream ?? process.env.DSH_VIDEO_STORYBOARD_UPSTREAM ?? null;
  if (!upstreamSpec) {
    console.error(usage());
    console.error('\nerror: --upstream is required (or set DSH_VIDEO_STORYBOARD_UPSTREAM)');
    return 2;
  }

  const meta = await readUpstreamMeta();
  const since = args.since ?? meta.commit;
  const patches = await readPatchList();

  const { dir, cleanup } = await resolveUpstream(upstreamSpec);
  try {
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const shortHead = head.slice(0, 7);
    const tag = (await gitOrNull(dir, ['describe', '--tags', '--abbrev=0']))?.trim() || '(no tag)';

    console.log('# 上游更新检查清单\n');
    console.log(`- 上游：${meta.repo}`);
    console.log(`- 本地副本：${upstreamSpec}`);
    console.log(`- 上游最新 tag：${tag}`);
    console.log(`- 上游最新 commit：${shortHead}`);
    console.log(`- 已同步到：${meta.tag} (${meta.commit})，vendoredAt ${meta.vendoredAt}`);
    console.log(`- 对比起点（--since）：${since}`);
    console.log(`- 本地补丁清单：${patches.found ? `${patches.modified.length} 改 / ${patches.deleted.length} 删` : '未找到（VENDOR.md）'}\n`);

    // 起点 commit 是否在仓库里
    const known = await gitOrNull(dir, ['cat-file', '-e', `${since}^{commit}`]);
    if (known === null) {
      console.error(`error: commit ${since} not found in ${upstreamSpec}`);
      console.error('       用 --since 指定一个存在的 commit，或先更新 UPSTREAM.json。');
      return 2;
    }

    const range = `${since}..${head}`;
    const logRaw = await gitOrNull(dir, ['log', '--format=%H%x09%h%x09%ad%x09%s', '--date=short', range]);
    const commits = (logRaw ?? '').trim().split('\n').filter(Boolean).map((line) => {
      const [hash, short, date, subject] = line.split('\t');
      return { hash, short, date, subject: subject ?? '' };
    });

    const changedRaw = await gitOrNull(dir, ['diff', '--name-only', range]);
    const changedFiles = (changedRaw ?? '').trim().split('\n').filter(Boolean);

    // CHANGELOG：比已 vendor 版本新的条目
    let changelogEntries = [];
    const changelogPath = join(dir, 'CHANGELOG.md');
    if (existsSync(changelogPath)) {
      const md = await readFile(changelogPath, 'utf8');
      changelogEntries = parseChangelog(md).filter((e) => cmpVersion(e.version, meta.version) > 0);
    }

    if (commits.length === 0 && changedFiles.length === 0) {
      console.log(`## 结论：无变化\n`);
      console.log(`上游 ${tag} (${shortHead}) 与已 vendor 的 ${meta.tag} (${meta.commit}) 一致，没有需要吸收的改动。`);
      return 0;
    }

    console.log(`## 上游新增提交（${commits.length}）\n`);
    for (const c of commits.slice(0, 40)) {
      console.log(`- \`${c.short}\` ${c.date} ${c.subject}`);
    }
    if (commits.length > 40) console.log(`- …还有 ${commits.length - 40} 条`);
    console.log('');

    if (changelogEntries.length > 0) {
      console.log(`## CHANGELOG 新条目（${changelogEntries.length}）\n`);
      for (const e of changelogEntries) {
        console.log(`### ${e.version}${e.date ? ` — ${e.date}` : ''}\n`);
        const body = e.body.split('\n').slice(0, 12).join('\n');
        console.log(body);
        console.log('');
      }
    } else {
      console.log('## CHANGELOG 新条目\n');
      console.log('（上游 CHANGELOG 里没有比已 vendor 版本更新的条目，或没有 CHANGELOG.md）\n');
    }

    // 受影响的 vendor 文件
    const rows = [];
    for (const file of changedFiles) {
      const lastTouch = (await gitOrNull(dir, ['log', '-1', '--format=%h%x09%s', range, '--', file])) ?? '';
      const [commitShort = '—', subject = ''] = lastTouch.trim().split('\t');

      const vendored = vendorPathFor(file);
      const locallyModified = vendored
        && patches.modified.some((p) => p.endsWith(file) || p === file);
      const locallyDeleted = vendored
        && patches.deleted.some((p) => p.endsWith(file) || p === file);

      // CHANGELOG 摘要：优先找提到这个文件的那条
      const mention = changelogEntries.find((e) => e.body.includes(file.split('/').pop()));
      const summary = mention ? summarize(mention) : (changelogEntries[0] ? summarize(changelogEntries[0]) : '—');

      let action;
      if (!vendored) action = '不 vendor（上游非源码文件）';
      else if (locallyDeleted) action = '⚠ 本地已删除该文件：确认是否需要恢复';
      else if (locallyModified) action = '⚠ 需人工合并（本地有改动）';
      else action = '可直接覆盖（本地无改动）';

      rows.push({
        commit: commitShort,
        subject,
        file,
        vendored: vendored ?? '—',
        // 「本地改过」这一列也要能看出"是我们删掉的" —— 那同样是上游改动会撞上的地方
        modified: locallyDeleted ? '是（已删除）' : (locallyModified ? '是' : '否'),
        deleted: locallyDeleted,
        summary,
        action,
      });
    }

    console.log('## 待吸收清单\n');
    console.log('| 上游 commit | 改动文件 | CHANGELOG 摘要 | 本地改过 | 建议动作 |');
    console.log('|---|---|---|---|---|');
    for (const r of rows) {
      const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      console.log(`| \`${cell(r.commit)}\` | \`${cell(r.file)}\` | ${cell(r.summary)} | ${cell(r.modified)} | ${cell(r.action)} |`);
    }
    console.log('');

    const hits = rows.filter((r) => r.modified !== '否');
    if (hits.length > 0) {
      console.log('### 撞上本地改动，需要人工判断的文件\n');
      for (const h of hits) {
        console.log(`- \`${h.vendored}\`（上游 \`${h.file}\`，${h.commit}）— ${h.action}`);
      }
      console.log('');
    }

    console.log('---');
    console.log('本脚本只产出清单：**没有修改任何文件，也没有动 git 索引**。');
    console.log(`合入步骤见 VENDOR.md「与上游对比」一节（vendor/dsh-video-storyboard/UPSTREAM.json 记得同步 commit / tag）。`);
    return 0;
  } finally {
    if (cleanup) await rm(cleanup, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((e) => {
    console.error(`\nupstream-sync: ${e?.message ?? e}`);
    process.exitCode = 2;
  });
