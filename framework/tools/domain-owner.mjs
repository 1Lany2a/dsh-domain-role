#!/usr/bin/env node
// domain-owner.mjs — 域名册（在任声明）命令行工具
// 契约：D:\dsh\Generated\2026-10-10\域名册-接口约定.md  §1 存储 + §2 CLI
// 只用 node:fs / node:os / node:path，零依赖。
//
// 设计要点：
//  - 读-改-写 + 原子替换（写 .tmp 再 rename），绝不整体覆盖别的域
//  - 文件不存在 = 正常状态（尚无任何声明），任何读者都不得当成错误
//  - 输出一律中文大白话

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 本文件位于 {体系根}\tools\ ⇒ 解析结果即契约规定的 {体系根}\_registry\domains.json
const REGISTRY_PATH = path.resolve(SCRIPT_DIR, '..', '_registry', 'domains.json');
const TMP_PATH = REGISTRY_PATH + '.tmp';

// 会话存档文件名带格式版本：session.jsonl.zstd / session.v3.jsonl.zstd / session.v4.jsonl.zstd
const ARCHIVE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

// ---------------------------------------------------------------- 小工具

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_ABNORMAL = 2; // check 专用：有异常
const EXIT_CONFLICT = 3; // claim 冲突
const EXIT_AMBIGUOUS = 4; // 未指定项目且同名域有多个（契约未定义，取更大号以免误删）

function nowIso() {
  return new Date().toISOString();
}

function line(text = '') {
  process.stdout.write(text + '\n');
}

function fail(message, code = EXIT_USAGE) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function parseArgv(argv) {
  const flags = Object.create(null);
  const positional = [];
  const boolFlags = new Set(['force', 'dry-run', 'json']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    let name = token.slice(2);
    let inlineValue;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (boolFlags.has(name)) {
      flags[name] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      fail('参数 --' + name + ' 后面缺少取值。');
    }
    flags[name] = next;
    i++;
  }
  return { flags, positional };
}

function assertName(value, label) {
  if (!value) fail(label + '不能为空。');
  if (value.includes(':')) fail(label + '里不能包含英文冒号（冒号是“项目:域”的分隔符）。');
  if (value.includes('/') || value.includes('\\')) fail(label + '里不能包含斜杠。');
  return value;
}

// ---------------------------------------------------------------- 存档探测

function sessionsRoot() {
  return path.join(os.homedir(), '.dsh', 'sessions');
}

// 在一个会话目录里挑最新的 session*.jsonl.zstd（按 mtime，不写死版本号）
function pickArchiveFile(sessionDir) {
  let names = [];
  try {
    names = fs
      .readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return { archive: null, candidates: [] };
  }

  const candidates = names.filter((name) => ARCHIVE_RE.test(name)).sort();
  let best = null;
  for (const name of candidates) {
    const full = path.join(sessionDir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = {
        name,
        path: full,
        mtimeMs: stat.mtimeMs,
        mtime: stat.mtime,
        version: Number((ARCHIVE_RE.exec(name) || [])[1] || 0),
      };
    }
  }
  return { archive: best, candidates };
}

// 实测：本机会话目录名有两种写法 —— 带前缀的 session-<uuid> 和不带前缀的 <uuid>。
// 两种都试，只为少报一次“查无存档”，不改变任何退出码含义。
function sessionDirNameCandidates(sessionId) {
  const names = [sessionId];
  if (sessionId.startsWith('session-')) names.push(sessionId.slice('session-'.length));
  else names.push('session-' + sessionId);
  return names;
}

// 在工作区目录下找 <会话id> 目录，返回存档信息；找不到返回 null
function findSessionArchive(sessionId) {
  if (!sessionId) return null;
  const root = sessionsRoot();
  let workspaceNames = [];
  try {
    workspaceNames = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  for (const workspaceName of workspaceNames) {
    const workspaceDir = path.join(root, workspaceName);
    for (const dirName of sessionDirNameCandidates(sessionId)) {
      const sessionDir = path.join(workspaceDir, dirName);
      let stat;
      try {
        stat = fs.statSync(sessionDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const picked = pickArchiveFile(sessionDir);
      return {
        workspaceName,
        workspaceDir,
        sessionDir,
        matchedAs: dirName,
        archive: picked.archive,
        candidates: picked.candidates,
      };
    }
  }
  return null;
}

// 没给 --project 时，从会话存档所在的工作区目录名推项目短名；再退到当前工作目录名
function inferProject(sessionId) {
  const found = findSessionArchive(sessionId);
  if (found) {
    const base = found.workspaceName;
    const middle = base.replace(/^--/, '').replace(/--$/, '');
    const guess = middle.split('-').filter(Boolean).pop();
    if (guess) return { project: guess, source: '会话存档所在工作区目录' };
  }
  const cwdBase = path.basename(process.cwd());
  return { project: cwdBase || 'unknown', source: '当前工作目录' };
}

// ---------------------------------------------------------------- 读写文件

function seedRegistry() {
  return { schemaVersion: 1, updatedAt: nowIso(), owners: {} };
}

function normalizeRegistry(data) {
  const out = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  if (out.schemaVersion === undefined) out.schemaVersion = 1;
  if (!out.updatedAt) out.updatedAt = nowIso();
  if (!out.owners || typeof out.owners !== 'object' || Array.isArray(out.owners)) out.owners = {};
  return out;
}

// 返回 { data, fileExisted, parseError }
function readRegistry() {
  let raw;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { data: seedRegistry(), fileExisted: false, parseError: null };
    }
    throw error;
  }
  try {
    return { data: normalizeRegistry(JSON.parse(raw)), fileExisted: true, parseError: null };
  } catch (error) {
    return { data: seedRegistry(), fileExisted: true, parseError: error.message };
  }
}

// 读-改-写 + 原子替换：先写同目录 .tmp，再 rename 覆盖；绝不先删原文件
function writeRegistryAtomic(data, dryRun) {
  data.updatedAt = nowIso();
  const body = JSON.stringify(data, null, 2) + '\n';
  if (dryRun) return { bytes: Buffer.byteLength(body, 'utf8'), written: false };

  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  try {
    fs.writeFileSync(TMP_PATH, body, 'utf8');
    fs.renameSync(TMP_PATH, REGISTRY_PATH);
  } catch (error) {
    try {
      fs.unlinkSync(TMP_PATH);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error;
  }
  return { bytes: Buffer.byteLength(body, 'utf8'), written: true };
}

function registryBytes() {
  try {
    return fs.statSync(REGISTRY_PATH).size;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------- 展示格式

function fmtHours(hours) {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '未知';
  const value = hours < 0 ? 0 : hours;
  if (value < 1) return value.toFixed(2) + 'h';
  return Math.floor(value) + 'h';
}

function ageHours(iso, now = Date.now()) {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return (now - parsed) / 3600000;
}

function shortSession(sessionId) {
  return sessionId ? String(sessionId) : '（未记录）';
}

// ---------------------------------------------------------------- claim

function cmdClaim(argv) {
  const { flags, positional } = parseArgv(argv);
  const domain = assertName(positional[0], '域');
  if (positional.length > 1) fail('claim 只接受一个域参数，多了：' + positional.slice(1).join(' '));
  const sessionId = flags.session;
  if (!sessionId) fail('claim 必须给 --session <会话id>。');
  const dryRun = flags['dry-run'] === true;

  let project = flags.project;
  let projectSource = '命令行指定';
  if (!project) {
    const inferred = inferProject(sessionId);
    project = inferred.project;
    projectSource = inferred.source;
  }
  assertName(project, '项目');

  const key = project + ':' + domain;
  const { data, parseError } = readRegistry();
  if (parseError) fail('声明文件已存在但解析失败，为避免覆盖别人的声明，本次操作中止：' + parseError);

  const existing = Object.prototype.hasOwnProperty.call(data.owners, key) ? data.owners[key] : null;
  const claimer = flags.by || null;
  const userNote = flags.note || '';

  // 幂等：同一个会话再认领 = 刷新起算时间
  if (existing && existing.sessionId === sessionId) {
    const refreshed = {
      ...existing,
      project,
      domain,
      since: nowIso(),
      by: claimer || existing.by || null,
      note: userNote || existing.note || '',
    };
    data.owners[key] = refreshed;
    const result = writeRegistryAtomic(data, dryRun);
    if (flags.json) {
      line(JSON.stringify({ action: 'claim', outcome: 'refreshed', dryRun, key, owner: refreshed }, null, 2));
      return EXIT_OK;
    }
    line('该域本来就是你在任，已刷新在岗起算时间（幂等，不算冲突）。');
    line('  ' + key + '  ->  ' + sessionId);
    line('  在岗起算：' + refreshed.since);
    if (dryRun) line('（--dry-run 演练模式：只是打印，没有写入任何文件）');
    else line('  已写回：' + REGISTRY_PATH + '（' + result.bytes + ' 字节，原子替换）');
    return EXIT_OK;
  }

  // 冲突：被别的会话占着
  if (existing && existing.sessionId !== sessionId && !flags.force) {
    const waited = ageHours(existing.since);
    const oldId = shortSession(existing.sessionId);
    line('该域已有在任负责人 ' + oldId + '（在岗 ' + fmtHours(waited) + '）。换人请先 release，或加 --force（＝交接）');
    line('  ' + key + '  在任起算：' + (existing.since || '未知') + '，声明人：' + (existing.by || '未记录'));
    line('  想强行交接就加 --force（旧负责人会写进 note 留痕）。');
    if (dryRun) line('（--dry-run 演练模式：没有写入任何文件）');
    return EXIT_CONFLICT;
  }

  const handoverFrom = existing && existing.sessionId !== sessionId ? existing.sessionId : null;
  if (handoverFrom) {
    const oldId = shortSession(handoverFrom);
    const note = userNote ? '接手自 ' + oldId + '；' + userNote : '接手自 ' + oldId;
    data.owners[key] = {
      project,
      domain,
      sessionId,
      since: nowIso(),
      by: claimer,
      note,
    };
    const result = writeRegistryAtomic(data, dryRun);
    if (flags.json) {
      line(JSON.stringify({ action: 'claim', outcome: 'handover', dryRun, key, owner: data.owners[key] }, null, 2));
      return EXIT_OK;
    }
    line('已强制交接：' + key);
    line('  新负责人：' + sessionId);
    line('  旧负责人：' + oldId + '（已写进 note 留痕）');
    if (dryRun) line('（--dry-run 演练模式：只是打印，没有写入任何文件）');
    else line('  已写回：' + REGISTRY_PATH + '（' + result.bytes + ' 字节，原子替换）');
    return EXIT_OK;
  }

  // 全新认领
  data.owners[key] = {
    project,
    domain,
    sessionId,
    since: nowIso(),
    by: claimer,
    note: userNote,
  };
  const result = writeRegistryAtomic(data, dryRun);
  if (flags.json) {
    line(JSON.stringify({ action: 'claim', outcome: 'created', dryRun, key, owner: data.owners[key] }, null, 2));
    return EXIT_OK;
  }
  line('已认领在任：' + key);
  line('  在任负责人：' + sessionId);
  line('  起算时间：' + data.owners[key].since);
  if (!flags.project) line('  项目名没给，是按' + projectSource + '推出来的：' + project);
  if (dryRun) line('（--dry-run 演练模式：只是打印，没有写入任何文件）');
  else line('  已写回：' + REGISTRY_PATH + '（' + result.bytes + ' 字节，原子替换）');
  return EXIT_OK;
}

// ---------------------------------------------------------------- release

function cmdRelease(argv) {
  const { flags, positional } = parseArgv(argv);
  const domain = assertName(positional[0], '域');
  if (positional.length > 1) fail('release 只接受一个域参数，多了：' + positional.slice(1).join(' '));
  const dryRun = flags['dry-run'] === true;

  const { data, parseError } = readRegistry();
  if (parseError) fail('声明文件已存在但解析失败，为避免误删，本次操作中止：' + parseError);

  let keys = [];
  if (flags.project) {
    const key = flags.project + ':' + domain;
    if (Object.prototype.hasOwnProperty.call(data.owners, key)) keys = [key];
  } else {
    keys = Object.keys(data.owners).filter((key) => key.split(':').slice(1).join(':') === domain);
  }

  if (keys.length === 0) {
    if (flags.json) {
      line(JSON.stringify({ action: 'release', outcome: 'absent', dryRun, keys: [] }, null, 2));
      return EXIT_OK;
    }
    line('本来就没有这个在任声明（域 ' + domain + (flags.project ? '，项目 ' + flags.project : '') + '），无需释放。');
    return EXIT_OK;
  }

  if (keys.length > 1) {
    line('同名域有多个在任声明，不替你猜是哪一个，请加 --project 指定：');
    for (const key of keys.sort()) line('  ' + key + '  ->  ' + shortSession(data.owners[key].sessionId));
    line('（--project 指定后重新执行；本次没有写入任何文件）');
    return EXIT_AMBIGUOUS;
  }

  const key = keys[0];
  const removed = data.owners[key];
  delete data.owners[key];
  const result = writeRegistryAtomic(data, dryRun);

  if (flags.json) {
    line(JSON.stringify({ action: 'release', outcome: 'released', dryRun, key, removedSessionId: removed.sessionId }, null, 2));
    return EXIT_OK;
  }
  line('已释放：' + key);
  line('  被删掉的负责人：' + shortSession(removed.sessionId));
  if (dryRun) line('（--dry-run 演练模式：只是打印，没有写入任何文件）');
  else line('  已写回：' + REGISTRY_PATH + '（' + result.bytes + ' 字节，原子替换）');
  return EXIT_OK;
}

// ---------------------------------------------------------------- list

function cmdList(argv) {
  const { flags } = parseArgv(argv);
  const { data, parseError, fileExisted } = readRegistry();
  if (parseError) {
    line('声明文件存在但读不懂（JSON 解析失败）：' + parseError);
    return EXIT_ABNORMAL;
  }

  const keys = Object.keys(data.owners).sort();
  if (flags.json) {
    line(
      JSON.stringify(
        {
          file: REGISTRY_PATH,
          fileExisted,
          count: keys.length,
          owners: keys.map((key) => ({ key, ...data.owners[key] })),
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  if (keys.length === 0) {
    line('当前没有任何在任声明');
    if (!fileExisted) line('（声明文件还没建立，等同“没人认领”，这不是错误）');
    return EXIT_OK;
  }

  line('当前在任声明共 ' + keys.length + ' 个：');
  const now = Date.now();
  for (const key of keys) {
    const owner = data.owners[key] || {};
    line('  ' + key + '  ->  ' + shortSession(owner.sessionId) + '  (在岗 ' + fmtHours(ageHours(owner.since, now)) + ')');
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------- check

function cmdCheck(argv) {
  const { flags } = parseArgv(argv);
  const { data, parseError, fileExisted } = readRegistry();
  const now = Date.now();
  const problems = [];
  const records = [];

  if (parseError) {
    problems.push('声明文件读不懂（JSON 解析失败）：' + parseError);
  }

  const keys = parseError ? [] : Object.keys(data.owners).sort();
  for (const key of keys) {
    const owner = data.owners[key] || {};
    const dirty = [];

    const parts = key.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      dirty.push('key 不是“项目:域”的样子');
    } else {
      if (owner.project !== parts[0]) dirty.push('project 字段（' + JSON.stringify(owner.project) + '）与 key 不一致');
      if (owner.domain !== parts[1]) dirty.push('domain 字段（' + JSON.stringify(owner.domain) + '）与 key 不一致');
    }
    if (!owner.sessionId) dirty.push('缺 sessionId');

    const found = owner.sessionId ? findSessionArchive(owner.sessionId) : null;
    const archive = found && found.archive ? found.archive : null;
    const record = {
      key,
      project: owner.project ?? null,
      domain: owner.domain ?? null,
      sessionId: owner.sessionId ?? null,
      since: owner.since ?? null,
      by: owner.by ?? null,
      onDutyHours: ageHours(owner.since, now),
      dirty,
      archiveFound: Boolean(archive),
      archivePath: archive ? archive.path : null,
      archiveMtime: archive ? archive.mtime.toISOString() : null,
      archiveAgeHours: archive ? (now - archive.mtimeMs) / 3600000 : null,
      archiveCandidates: found ? found.candidates : [],
    };
    records.push(record);

    if (!archive) {
      problems.push(key + '：查无存档（会话 ' + owner.sessionId + ' 的工作区目录或存档文件找不到）');
    }
    if (dirty.length > 0) {
      problems.push(key + '：脏记录 —— ' + dirty.join('；'));
    }
  }

  const ok = problems.length === 0 && !parseError;

  if (flags.json) {
    line(
      JSON.stringify(
        {
          file: REGISTRY_PATH,
          fileExisted,
          checkedAt: nowIso(),
          ok,
          count: keys.length,
          records,
          problems,
        },
        null,
        2,
      ),
    );
    return ok ? EXIT_OK : EXIT_ABNORMAL;
  }

  line('在任声明体检（只读，不改任何东西）');
  line('  声明文件：' + REGISTRY_PATH + (fileExisted ? '' : '（还没建立，等同“没人认领”，不算异常）'));

  if (keys.length === 0) {
    line('  声明条数：0');
  } else {
    line('  声明条数：' + keys.length);
    for (const record of records) {
      line('');
      line('  ' + record.key + '  ->  ' + shortSession(record.sessionId) + '  (在岗 ' + fmtHours(record.onDutyHours) + ')');
      if (record.archiveFound) {
        line('    存档：找到了 ' + record.archivePath);
        line('    存档最后写入距今 ' + fmtHours(record.archiveAgeHours) + '（只报数，不判断在线与否）');
      } else {
        line('    存档：查无存档 ⚠（会话目录或 session*.jsonl.zstd 都没找到）');
      }
      if (record.dirty.length > 0) line('    脏记录 ⚠：' + record.dirty.join('；'));
    }
  }

  line('');
  if (ok) {
    line('结论：没有异常。（退出码 0）');
  } else {
    line('结论：发现 ' + problems.length + ' 处异常，请人工看看上面标 ⚠ 的地方。（退出码 2）');
  }
  return ok ? EXIT_OK : EXIT_ABNORMAL;
}

// ---------------------------------------------------------------- 入口

const USAGE = [
  '域名册（在任声明）工具 —— 只维护 D:\\xiangmu\\_registry\\domains.json',
  '',
  '  node domain-owner.mjs claim <域> --session <会话id> [--project <项目>] [--note <说明>] [--by <声明人>] [--force]',
  '  node domain-owner.mjs release <域> [--project <项目>]',
  '  node domain-owner.mjs list [--json]',
  '  node domain-owner.mjs check [--json]',
  '',
  '所有命令都支持 --dry-run（只打印，不写文件）。',
  '退出码：0 正常 / 1 用法错 / 2 check 发现异常 / 3 claim 撞上别人的在任 / 4 release 同名域有多个、需指定项目。',
].join('\n');

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    line(USAGE);
    return command ? EXIT_OK : EXIT_USAGE;
  }
  if (command === 'claim') return cmdClaim(rest);
  if (command === 'release') return cmdRelease(rest);
  if (command === 'list') return cmdList(rest);
  if (command === 'check') return cmdCheck(rest);

  process.stderr.write('不认识的命令：' + command + '\n\n' + USAGE + '\n');
  return EXIT_USAGE;
}

try {
  const code = main();
  // 兜底：任何情况下都不留 .tmp 残渣
  try {
    if (fs.existsSync(TMP_PATH)) fs.unlinkSync(TMP_PATH);
  } catch {
    /* 忽略 */
  }
  process.exit(code);
} catch (error) {
  try {
    if (fs.existsSync(TMP_PATH)) fs.unlinkSync(TMP_PATH);
  } catch {
    /* 忽略 */
  }
  process.stderr.write('执行出错：' + (error && error.message ? error.message : String(error)) + '\n');
  process.exit(EXIT_USAGE);
}
