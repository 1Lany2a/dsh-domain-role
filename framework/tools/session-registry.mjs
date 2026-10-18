#!/usr/bin/env node
/**
 * session-registry v2 -- the system-wide index (mission x session table + file reverse-lookup table).
 *
 * WHY THIS EXISTS
 *   A main session forgets which windows already exist, so it re-opens one for work that already
 *   has a window. dsh cannot fix that in code: `send_message` only reaches a **direct child agent**
 *   (source: dsh-subagent/lib/index.js sendMessage), while the windows a human opens by hand are
 *   **top-level sessions with no parent link**. So the index can only REMEMBER and POINT.
 *
 * WHAT IT PRODUCES (both in the shared, git-less directory `{体系根}\_registry\`)
 *   INDEX.md      -- summary block + table 1 (mission x session) + table 2 (file risk rows)
 *   registry.json -- the same data, machine-readable (`schemaVersion` fixed), for agents/plugins
 *
 * TABLE 1: mission x session (primary key = mission name, which is the mission number)
 *   The number already appears in FOUR stores -- session title (`【使命】S03-...`) | branch
 *   (`feature/S03-...`) | commit (`feat(S03): ...`) | report (`.dsh\missions\S03-*.md`) -- which is
 *   what makes one row usable as an index into branches, commits and reports, not just a status list.
 *   NO COLUMN IS COPIED BY HAND. Every value comes from project_map's mission JSON, git, or archives.
 *
 *   TWO TIME COLUMNS, TWO DIFFERENT QUESTIONS (added 2026-09-20 -- do not merge them back into one):
 *     「窗口」     = the archive file's mtime = when this window was last LOADED / ALIVE
 *                    -> answers "is that window still open", the hard gate for reusing it
 *     「最后活动」 = the newest record that is NOT lifecycle bookkeeping
 *                    -> answers "is it still warm / when did it last do real work"
 *   They disagree whenever a session was opened but not used -- 45 of 316 archives on 2026-09-20.
 *   See the mtime gotcha below for the evidence.
 *
 * TABLE 2: file reverse lookup (primary key = absolute file path)
 *   Answers "who touched this file, when, and did two sessions touch it close together". md lists only
 *   the L2/L3 RISK rows; the full set goes to json and is queryable with `--file <path>`.
 *
 * COST NOTE (measured 2026-09-16, from ~/.dsh/storages/meow_cachebilling.json)
 *   Per-step cost is nearly flat across context sizes ($0.0138/step at 14-50k vs $0.0156 at 200-400k,
 *   $0.0227 above 400k). Cache reads cost 1/10 of input, so re-sending a long history is cheap; what
 *   costs money is what each NEW turn adds (large tool outputs, whole-file reads). => context size is
 *   NOT a cost threshold. Reuse-vs-cold-start is decided by how much work is LEFT, not by size.
 *
 * DATA SOURCES (all read-only)
 *   missions : ~/.dsh/project-map-kit/missions/m-*.json          (name/feature/status/files/sessionId)
 *   archives : ~/.dsh/sessions/<ws>/<id>/session[.vN].jsonl.zstd  (cwd, title, usage, tool/call + time)
 *   fallback : ~/.dsh/storages/session_projcache.json            (session id -> cwd; survives archive deletion)
 *   git      : `git -C <repo> branch` / `git ls-files`
 *   domains  : <out-dir>\domains.json                            (在任声明 -- 「谁**现在**在任」，NOT a ledger:
 *              no history / no tasks / no status. Written and mutated ONLY by domain-owner.mjs; read-only here.
 *              Missing / unreadable / malformed = "无人在任" and NEVER an error -- the rest of the index must
 *              still print. 路径与格式见 D:\dsh\Generated\2026-10-10\域名册-接口约定.md §1；索引集成见 §3.)
 *
 * FIELD GOTCHAS THAT COST REAL TIME (verified 2026-09-18 -- do not "fix" these without re-verifying)
 *   - `tool/call.data.arguments` is a **JSON string**, not an object. Object.keys() on it returns
 *     1335 character indices and silently yields zero file paths.
 *   - The per-write timestamp is the record's **top-level `time`** (epoch ms), NOT `ts`/`data.ts`.
 *     Using the wrong field made every hit in a session share the archive mtime and destroyed L3.
 *   - 52 of 76 missions point at session archives that no longer exist. `session_projcache.json`
 *     covers them; without it the mission table loses two thirds of its rows.
 *   - Mission branches are almost always already deleted (merged then pruned), so "branch" is
 *     reported as `已删` rather than being silently blank.
 *   - The archive file's **mtime is NOT "last activity"**. dsh appends `session/end-seed` inside the
 *     Session CONSTRUCTOR (`dsh-session\lib\index.js` L1086-1087; the doc comment at L1023-1028 says
 *     "reopening an untouched session leaves that event at a smaller seq"), i.e. that marker -- and
 *     the whole-file rewrite that accompanies loading -- happens when a session is (re)OPENED. A
 *     human merely clicking a window open to read it counts. Measured 2026-09-20: 276 of 316
 *     archives carry the marker, 45 end with it, and **every one of those 45 has mtime != real
 *     activity** (skew up to 568h); 23 of 77 mission rows printed a wrong age. Hence the two
 *     columns above -- never "fix" this by pointing both at the same source.
 *
 * USAGE
 *   node session-registry.mjs                      # refresh {体系根}\_registry\ (slim default view)
 *   node session-registry.mjs --dry-run            # print, write nothing
 *   node session-registry.mjs --full --dry-run     # + 使命一句话/分支 columns and the file-reverse-lookup table
 *   node session-registry.mjs --summary            # print only the summary block
 *   node session-registry.mjs --project blog       # one project's rows only
 *   node session-registry.mjs --file "{知识库}\INDEX.md"   # reverse lookup one file
 *   node session-registry.mjs --days 60 --json     # window + machine output on stdout
 *
 * SAFETY: read-only against every archive/mission; writes only INDEX.md + registry.json inside
 * --out-dir, and refuses to overwrite INDEX.md unless it already carries this tool's signature.
 *
 * Snapshot basis: dsh 0.2.0-rc.2, re-verified 2026-10-10.
 *
 *   - **NEVER hardcode the archive filename.** It carries the format version and dsh has changed it
 *     twice: legacy `session.jsonl.zstd` -> `session.v3.jsonl.zstd` -> `session.v4.jsonl.zstd`.
 *     Hardcoding `session.v3` as this tool did until v2.4.0 hid **560 of 939 archives** (measured
 *     2026-10-10: v3 379 / v4 143 / legacy 417) -- the tool's own sessions included. We now glob
 *     `session[.vN].jsonl.zstd` inside each session dir and keep the one with the NEWEST MTIME.
 *   - **54 session dirs hold TWO archives** (an old-format copy left behind by the migration). The
 *     migration rewrites the whole history into the new file, so the newest one is the complete one
 *     -- verified on the 2026-10-04 sample: v3 198 recs / 370 KB vs v4 199 recs / 225 KB (same
 *     content, newer encoding). Counting both would double the session and print a stale "last
 *     activity". The leftovers are counted and reported, never read.
 *   - Therefore `counts.sessions` changed meaning on 2026-10-10 (379 -> sessions actually present).
 *     Cross-version numbers from before that date are NOT comparable.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const TOOL_VERSION = '2.8.0'; // 2.8.0: A01 分层 —— `--scope <system|项目名|auto>`：按交接者只取自己那一层、各落自己目录（不带新参数＝既有混排行为逐字不变）＋ §三 只取顶层条目（缩进子项算父项的一部分、A03）＋ 溢出现在**显式写出省略条数** ＋ 行预算改**从各节末尾丢**（2026-10-15）
// 2.7.0: --handoff 默认产物改为 JSON（<out-dir>\handoff.json，待办/编号/名称/changelog 标题存全文、不截断）；MD 退成按需 `--handoff-md`（隐含 --handoff，一行命令渲染，P1–P4 2026-10-14）
// 2.6.2: --handoff §五 补「体系总览 / 知识库索引」两条路径；开头"只读这一份就够"改为"先读本页、再补读这两份"（2026-10-11 主会话交接，接手方反馈）
// 2.6.1: --handoff §三 取法修正（跳 [x] + 体系根 6 条；**取头/取尾见 readNextSteps——只有整节纯编号且递增才取尾**）＋ §四 补 changelog 标题
                              // 2.6.0: --handoff 一页纸交接包（派生自使命库+索引+PROJECT.md，只增不改）
                              // 2.5.0: --domains + 域负责人行 + json 的 counts.domainOwners / domainOwners（契约 §3，只增不改）
const SCHEMA_VERSION = 1;
const SNAPSHOT = 'dsh 0.2.0-rc.2 / session[.vN].jsonl.zstd（取最新 mtime） / 2026-10-10';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
// `session.jsonl.zstd` (legacy) | `session.v3.jsonl.zstd` | `session.v4.jsonl.zstd` ...
const ARCHIVE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

const DEFAULT_OUT_DIR = 'D:\\xiangmu\\_registry';
const DEFAULT_PROJECTS_ROOT = 'D:\\xiangmu';
const INDEX_NAME = 'INDEX.md';
const JSON_NAME = 'registry.json';
// Handoff pack, v2.7.0: the **artifact is the JSON** (`handoff.json`); the one-page MD is an
// on-demand RENDERING of it (`--handoff-md`). All layout constraints -- item quotas, `clip()`,
// the 62-line budget -- live in the MD renderer only, so the JSON stays the full truth.
const HANDOFF_JSON_NAME = 'handoff.json';
const HANDOFF_JSON_SCHEMA_VERSION = 1; // handoff.json 是独立文档，**不**跟着 INDEX/registry 的 SCHEMA_VERSION 走
const HANDOFF_NAME = 'HANDOFF.md';
// A01 (2026-10-15): per-layer handoff (体系 / 项目 各一份). The system layer writes into --out-dir
// (which IS the system's own directory); a project layer writes into this sub-directory of the
// project itself, mirroring the system layout and keeping the project root clean. A sub-directory --
// not the project root -- is deliberate: several projects already keep a HANDOFF.md of their own
// (e.g. study\cpp-learning\HANDOFF.md), and the signature guard would REFUSE to touch those.
const HANDOFF_SCOPE_SUBDIR = '_registry';
// MD clobber protection: the fixed first line is the signature, and a file at this path without it
// is treated as foreign and never overwritten. The JSON uses a different signature (see main()):
// it must parse as JSON and carry `tool === 'session-registry'`.
const HANDOFF_SIGNATURE = '# 一页纸交接包 · HANDOFF';
const HANDOFF_RECENT = 8;        // how many recent mission changes to list
const HANDOFF_RECENT_CHANGELOG = 3; // how many `SYSTEM-changelog.md` titles to append to §四
const HANDOFF_MAX_PROJECTS = 6;  // MD only: how many PROJECT.md files to mine for "next steps"
const HANDOFF_ITEMS_PER_PROJECT = 3; // MD only
const HANDOFF_ITEMS_ROOT = 6;    // MD only. 体系根是交接主文件：上限放宽（取法修正 2026-10-11）
const HANDOFF_MAX_LINES = 62;    // MD only: hard stop: one page
// 开局口径（P3）：新会话先读 handoff.json 拿导航；MD 要给人读时才现渲染。JSON 与 MD 头部共用这一句，
// 免得两处口径各写各的。
const HANDOFF_README = '开局先读本文件拿导航；体系侧活跃待办主表＝D:\\xiangmu\\PROJECT.md 的 §下一步；'
  + '知识库坑/经验速查表＝D:\\dsh\\knowledge\\INDEX.md。本文件是派生产物、勿手改；'
  + '重跑：node D:\\xiangmu\\tools\\session-registry.mjs --handoff；要给人读的 MD：同一命令加 --handoff-md。';
// §四 补 changelog 标题的来源（体系侧"无使命登记"的活只有这里看得见）。
const CHANGELOG_REL = path.join('templates', 'SYSTEM-changelog.md');
// 域名册（在任声明）。默认与 INDEX.md 同目录；读不到＝"无人在任"，不是错误（契约 §1/§3）。
const DOMAINS_NAME = 'domains.json';
const INDEX_SIGNATURE = '# 体系索引 · 会话/文件';

// Files that other sessions are likely to touch from several projects. Used only to label rows.
const SHARED_HINTS = ['D:\\dsh\\knowledge\\', 'D:\\xiangmu\\SYSTEM-OVERVIEW.md', 'D:\\xiangmu\\templates\\',
  'D:\\xiangmu\\提案\\', 'D:\\xiangmu\\_registry\\', 'D:\\xiangmu\\tools\\'];

// ---------------------------------------------------------------- argv

function parseArgs(argv) {
  const opts = {
    sessionsRoot: path.join(os.homedir(), '.dsh', 'sessions'),
    missionsDir: path.join(os.homedir(), '.dsh', 'project-map-kit', 'missions'),
    projCache: path.join(os.homedir(), '.dsh', 'storages', 'session_projcache.json'),
    projectsRoot: DEFAULT_PROJECTS_ROOT,
    outDir: DEFAULT_OUT_DIR,
    domainsPath: null, // null => <outDir>\domains.json, resolved after all args are parsed
    days: 30,
    project: null,
    fileQuery: null,
    staleMinutes: 30,
    l3Minutes: 30,
    minBytes: 5000,
    includeSubagents: false,
    dryRun: false,
    summaryOnly: false,
    jsonOut: false,
    full: false,
    help: false,
    handoff: false,     // --handoff [file] : write the handoff JSON (the artifact; default <outDir>\handoff.json)
    handoffPath: null,  // null => <out-dir>\handoff.json (or, with --scope, that layer's own dir); resolved in main()
    handoffMd: false,   // --handoff-md [file] : ALSO write the rendered one-page MD (implies --handoff)
    handoffMdPath: null, // null => <out-dir>\HANDOFF.md (or, with --scope, that layer's own dir); resolved in main()
    scope: null,        // --scope <system|项目名|auto> (A01): only that handoff layer, into its own dir
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--full') opts.full = true;
    else if (a === '--summary') opts.summaryOnly = true;
    else if (a === '--json') opts.jsonOut = true;
    else if (a === '--include-subagents') opts.includeSubagents = true;
    else if (a === '--days') opts.days = Number(next());
    else if (a === '--project') opts.project = next();
    else if (a === '--file') opts.fileQuery = next();
    else if (a === '--out-dir') opts.outDir = next();
    else if (a === '--domains') opts.domainsPath = next();
    else if (a === '--sessions-root') opts.sessionsRoot = next();
    else if (a === '--missions-dir') opts.missionsDir = next();
    else if (a === '--projcache') opts.projCache = next();
    else if (a === '--projects-root') opts.projectsRoot = next();
    else if (a === '--by-window') opts.byWindow = true;
    else if (a === '--handoff') {
      opts.handoff = true;
      // optional value: a following non-flag token is the target file, otherwise the default path
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { opts.handoffPath = v; i += 1; }
    }
    else if (a === '--handoff-md') {
      // P1/P4: the MD is now on demand and is a RENDERING of the JSON, so it implies --handoff:
      // both files are written (the JSON is the source of truth, the MD its one-page view).
      opts.handoffMd = true;
      opts.handoff = true;
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { opts.handoffMdPath = v; i += 1; }
    }
    else if (a === '--scope') {
      // A01: value is required. A bare `--scope` (next token is a flag / nothing) must fail loudly
      // instead of silently falling back to the mixed page, which is what the caller was avoiding.
      const v = next();
      if (v === undefined || v.startsWith('--')) throw new Error('--scope requires a value: system | <项目名> | auto');
      opts.scope = v;
    }
    else if (a === '--by-mission') opts.byMission = true;
    else if (a === '--stale-minutes') opts.staleMinutes = Number(next());
    else if (a === '--l3-minutes') opts.l3Minutes = Number(next());
    else if (a === '--min-bytes') opts.minBytes = Number(next());
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) throw new Error('--days must be a positive number');
  if (!Number.isFinite(opts.staleMinutes) || opts.staleMinutes < 0) throw new Error('--stale-minutes must be >= 0');
  if (!Number.isFinite(opts.l3Minutes) || opts.l3Minutes <= 0) throw new Error('--l3-minutes must be positive');
  // --scope only means something to the handoff artifact; accepting it silently next to a plain
  // index refresh would read as "the page is now layered" while nothing changed.
  if (opts.scope != null && !opts.handoff && !opts.handoffMd) {
    throw new Error('--scope only applies to --handoff / --handoff-md');
  }
  // resolve the default AFTER parsing: `--domains` and `--out-dir` may appear in any order
  if (!opts.domainsPath) opts.domainsPath = path.join(opts.outDir, DOMAINS_NAME);
  // The two handoff artifact paths are resolved in main(), not here: with --scope their default is
  // that LAYER's own directory, which is only known after the project roots have been collected.
  return opts;
}

const HELP = `session-registry v${TOOL_VERSION} -- system index: mission x session + file reverse lookup
usage: node session-registry.mjs [options]
  (no flag)            refresh ${DEFAULT_OUT_DIR}\\ (${INDEX_NAME} + ${JSON_NAME})
                       默认表一只列"有没有窗口/干完没/还热吗"
                       （编号｜状态｜会话id｜窗口｜最后活动｜体量；窗口=最近加载、最后活动=最近干活）
  --full               add 使命一句话 + 分支 columns, and append the file-reverse-lookup table
  --dry-run            print to stdout, write nothing
  --summary            print only the summary block
  --json               print the machine document to stdout
  --project <name>     restrict table 1 to one project group
  --by-mission        table 1 回到"一使命一行"平铺（旧读法；默认已是「窗口 > 使命」两级）
  --file <path>        reverse lookup a single file (absolute, or relative to cwd)
  --days <n>           file-view window, default 30
  --stale-minutes <n>  summary ages past this print a stale warning, default 30
  --l3-minutes <n>     "near simultaneous" threshold, default 30
  --include-subagents  include auto subagents in the file view (default hidden)
  --domains <path>     domain declarations file, default <out-dir>\\${DOMAINS_NAME}
                       (read-only; missing or malformed = "no one on duty", never an error)
  --handoff [file]     write the handoff pack as JSON (default <out-dir>\\${HANDOFF_JSON_NAME}).
                       New sessions read this ONE file instead of INDEX.md + PROJECT.md + missions.
                       Derived, not hand-written: owner-on-duty (domains.json) + status + next steps
                       parsed from PROJECT.md + the last ${HANDOFF_RECENT} mission changes + key paths.
                       Next steps keep EVERY unfinished item, in full (see readNextSteps); \`[x]\`
                       items are skipped; only TOP-LEVEL items count (indented sub-items are folded
                       into the item above them, A03). Quotas (体系根 ${HANDOFF_ITEMS_ROOT} / 项目 ${HANDOFF_ITEMS_PER_PROJECT}),
                       \`clip()\` and the ${HANDOFF_MAX_LINES}-line budget are the MD renderer's business, not the JSON's.
                       §四 also carries the top ${HANDOFF_RECENT_CHANGELOG} changelog titles from ${CHANGELOG_REL}.
                       With --dry-run (or --json) it is PRINTED instead of written.
  --handoff-md [file]  also render the human-readable one-page MD (default <out-dir>\\${HANDOFF_NAME}).
                       Implies --handoff: JSON is the source, the MD is its one-page rendering, and
                       BOTH are written. This is where every layout cap lives (每源 ${HANDOFF_ITEMS_ROOT}/${HANDOFF_ITEMS_PER_PROJECT} 条,
                       item \`clip(…,96)\`, changelog title \`clip(…,70)\`, ${HANDOFF_MAX_LINES} lines).
                       The ${HANDOFF_MAX_LINES}-line budget drops the LOWEST-priority end first and, when it
                       drops anything, says how many items it omitted (A01, 2026-10-15).
  --scope <s>          A01 layering: emit ONLY the handoff of the party being handed over, into that
                       party's own directory. <s> = system | <项目名> | auto.
                         system  => the system root only; artifacts stay in <out-dir>
                         <项目名>=> that project only; artifacts go to <项目>\\${HANDOFF_SCOPE_SUBDIR}\\
                         auto    => derive from cwd (must resolve unambiguously, else it fails)
                       A project-layer page carries a pointer to the system-layer handoff.
                       WITHOUT --scope the old mixed page is kept (same ONE file, same paths): the
                       documented command in living docs is unchanged. §三 content differs from
                       v2.7.0 only because A03 landed in the same release.
                       Only meaningful together with --handoff / --handoff-md.
  --out-dir / --sessions-root / --missions-dir / --projcache / --projects-root   override paths
snapshot: ${SNAPSHOT}`;

// ---------------------------------------------------------------- archive parsing

function splitFrames(buf) {
  const idx = [];
  let pos = 0;
  for (;;) { const i = buf.indexOf(ZSTD_MAGIC, pos); if (i < 0) break; idx.push(i); pos = i + 4; }
  const out = [];
  for (let k = 0; k < idx.length; k += 1) {
    out.push(buf.subarray(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length));
  }
  return out;
}

function loadArchive(file) {
  const buf = fs.readFileSync(file);
  const recs = [];
  for (const frame of splitFrames(buf)) {
    let text;
    try { text = zlib.zstdDecompressSync(frame).toString('utf8'); } catch { continue; } // partial last frame
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { recs.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
  }
  return { recs, bytes: buf.length };
}

/**
 * Pick the ONE current archive inside a session dir. Never hardcode a filename: the name carries
 * the format version and dsh changes it (legacy -> v3 -> v4). Newest mtime wins; ties go to the
 * higher version. Extra archives are migration leftovers holding a subset of the same history --
 * they are counted (`superseded`) and reported, never read. See the header gotcha.
 */
function pickArchive(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  let superseded = 0;
  for (const name of names) {
    const m = ARCHIVE_RE.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const cand = { archiveName: name, file, version: m[1] ? Number(m[1]) : 0, mtime: st.mtimeMs, bytes: st.size };
    const better = !best || cand.mtime > best.mtime || (cand.mtime === best.mtime && cand.version > best.version);
    if (better) { if (best) superseded += 1; best = cand; } else superseded += 1;
  }
  if (best) best.superseded = superseded;
  return best;
}

function walkSessions(root, out = [], depth = 0) {
  if (depth > 2) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(root, e.name);
    const a = pickArchive(full);
    if (a) out.push({ id: e.name, file: a.file, mtime: a.mtime, bytes: a.bytes, version: a.version, superseded: a.superseded, archiveName: a.archiveName });
    else walkSessions(full, out, depth + 1);
  }
  return out;
}

// `arguments` is a JSON **string** in the archive -- see the gotcha note in the header.
function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- small helpers

const ageText = (ms) => {
  if (ms == null) return '—';
  const h = ms / 36e5;
  if (h < 5 / 60) return '刚刚（可能还开着）';
  if (h < 1) return `${Math.round(h * 60)} 分钟前`;
  if (h < 24) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
};

const ctxText = (t) => (t == null ? '—' : (t >= 1000 ? `${Math.round(t / 1000)}k` : String(t)));

// Local time, NOT toISOString() -- an 8h-UTC machine would print a misleading "generated at".
const stamp = (ms) => {
  if (ms == null) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const shortSession = (id) => {
  if (!id) return '—';
  const m = /([0-9a-f]{8})-[0-9a-f]{4}/i.exec(id);
  return m ? `sess-${m[1]}` : id;
};

const isSubagentSession = (sess) => Boolean(sess) && (sess.origin === 'subagent' || (sess.delegationDepth || 0) > 0);

const normKey = (p) => path.resolve(p).replace(/\\+$/, '').toLowerCase();

function isSharedPath(p) {
  const l = p.toLowerCase();
  return SHARED_HINTS.some((h) => l.startsWith(h.toLowerCase()));
}

// ---------------------------------------------------------------- session metadata

function readSessionMeta(archive) {
  const { recs, bytes } = loadArchive(archive.file);
  const sess = recs.find((r) => r.type === 'session');
  if (!sess) return null;

  const titles = recs.filter((r) => r.type === 'session/title' && r.data && r.data.title).map((r) => r.data.title);
  const turns = recs.filter((r) => r.type === 'turn/start').length;
  let peak = null;
  for (const r of recs) {
    if (r.type !== 'assistant/message') continue;
    const u = r.data && r.data.usage;
    if (u && typeof u.inputTokens === 'number' && (peak == null || u.inputTokens > peak)) peak = u.inputTokens;
  }
  const userMsgs = recs.filter((r) => r.type === 'user/message').length;

  // Real last activity = the newest record that is NOT lifecycle bookkeeping. `session/end-seed` is
  // appended when the session is (re)opened, so it must never count as "did work" (header gotcha).
  let lastActive = null;
  for (let i = recs.length - 1; i >= 0; i -= 1) {
    const r = recs[i];
    if (typeof r.time !== 'number' || r.type === 'session/end-seed') continue;
    lastActive = r.time;
    break;
  }

  return {
    id: archive.id,
    file: archive.file,
    mtime: archive.mtime,
    bytes,
    cwd: sess.cwd || null,
    isSubagent: isSubagentSession(sess),
    createdAt: sess.createdAt || null,
    title: titles.length ? titles[titles.length - 1] : '(无标题)',
    turns,
    peak,
    userMsgs,
    lastActive,
    recs,
  };
}

// ---------------------------------------------------------------- project roots

/**
 * A `git worktree` (e.g. `项目甲-zcode`) has `.git` as a FILE pointing at the parent repo, and
 * carries a COPY of the same file tree. Including those as grouping candidates makes the files[]
 * probe tie on every mission (`daily-collect.ps1` exists in both) and silently collapses whole
 * projects into the parent directory -- measured 2026-09-18: 27 项目甲 missions all landed in
 * "{体系根}". Worktrees are aliases of the same project, so they are not grouping candidates.
 */
function isWorktree(root) {
  const g = path.join(root, '.git');
  try { return fs.existsSync(g) && !fs.statSync(g).isDirectory(); } catch { return false; }
}

function looksLikeProjectRoot(dir) {
  return fs.existsSync(path.join(dir, '.git'))
    || fs.existsSync(path.join(dir, 'PROJECT.md'))
    || fs.existsSync(path.join(dir, 'KNOWLEDGE.md'));
}

/** Immediate children, plus one nested level (`study\<subject>` carries its own PROJECT.md). */
function discoverProjectRoots(root) {
  const out = [];
  const push = (dir) => {
    if (!looksLikeProjectRoot(dir)) return;
    if (isWorktree(dir)) return;
    out.push(dir);
  };
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const full = path.join(root, e.name);
    const isRoot = looksLikeProjectRoot(full) && !isWorktree(full);
    if (isRoot) push(full);
    // one nested level (a project that groups sub-projects, e.g. study\)
    let sub;
    try { sub = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
    for (const s of sub) {
      if (!s.isDirectory() || s.name.startsWith('.') || s.name.startsWith('_')) continue;
      push(path.join(full, s.name));
    }
  }
  return out;
}

/**
 * Score how well a mission lands inside a candidate root.
 * The decisive signal is the mission's OWN report file (`.dsh\missions\<name>.md`): it is
 * mission-specific and, unlike source files, does not exist in a worktree copy. Declared `files[]`
 * are a weak tiebreaker (+1 each).
 */
function filesProbeScore(mission, root) {
  let score = 0;
  const rn = normKey(root);
  for (const f of mission.files || []) {
    if (!f || typeof f !== 'string') continue;
    try {
      if (path.isAbsolute(f)) {
        // An absolute path must be ATTRIBUTED to the root that contains it. Counting it for every
        // root scores all candidates equally, the tie check then fails, and whole projects silently
        // collapse into the parent directory (measured: 15 项目甲 missions).
        const n = normKey(f);
        if (n === rn || n.startsWith(rn + path.sep)) score += 1;
      } else if (fs.existsSync(path.join(root, f))) {
        score += 1;
      }
    } catch { /* ignore */ }
  }
  try {
    if (mission.name && fs.existsSync(path.join(root, '.dsh', 'missions', `${mission.name}.md`))) score += 10;
  } catch { /* ignore */ }
  return score;
}

/**
 * Group a mission by the project it belongs to.
 * Precedence: the session's cwd when it IS a project root -> files[] probe when cwd is only a parent
 * (this is what rescues the 项目甲 missions that were opened from `{体系根}`) -> the raw cwd as
 * a documented fallback.
 */
function resolveProject(mission, sessionCwd, projectRoots) {
  const byNorm = new Map(projectRoots.map((r) => [normKey(r), r]));

  if (sessionCwd) {
    const exact = byNorm.get(normKey(sessionCwd));
    if (exact) return { path: exact, name: path.basename(exact), how: 'cwd' };

    // cwd is a directory that merely CONTAINS project roots (typically {体系根} itself)
    const under = projectRoots.filter((r) => normKey(r).startsWith(normKey(sessionCwd) + path.sep));
    if (under.length > 0) {
      let best = null;
      let bestScore = 0;
      let tie = false;
      for (const r of under) {
        const s = filesProbeScore(mission, r);
        if (s > bestScore) { best = r; bestScore = s; tie = false; } else if (s === bestScore && s > 0) tie = true;
      }
      if (best && bestScore > 0 && !tie) return { path: best, name: path.basename(best), how: 'files' };
      return { path: sessionCwd, name: `${sessionCwd}（多项目/体系根）`, how: 'cwd-parent' };
    }
    return { path: sessionCwd, name: sessionCwd, how: 'cwd' };
  }

  const scored = projectRoots
    .map((r) => ({ r, s: filesProbeScore(mission, r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (scored.length === 1 || (scored.length > 1 && scored[0].s > scored[1].s)) {
    return { path: scored[0].r, name: path.basename(scored[0].r), how: 'files' };
  }
  return { path: null, name: '未识别', how: 'unknown' };
}

// ---------------------------------------------------------------- git

function gitBranchList(repo) {
  if (!fs.existsSync(path.join(repo, '.git'))) return null;
  try {
    const out = execFileSync('git', ['-C', repo, 'branch', '--format=%(refname:short)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return null; }
}

function gitTrackedSet(repo, cache) {
  const key = normKey(repo);
  if (cache.has(key)) return cache.get(key);
  let set = null;
  try {
    const out = execFileSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    set = new Set(out.split('\0').filter(Boolean).map((f) => normKey(path.join(repo, f))));
  } catch { set = null; }
  cache.set(key, set);
  return set;
}

function findRepoRoot(p, repoRoots) {
  const n = normKey(p);
  let best = null;
  for (const r of repoRoots) {
    const rn = normKey(r);
    if (n === rn || n.startsWith(rn + path.sep)) {
      if (!best || rn.length > normKey(best).length) best = r;
    }
  }
  return best;
}

// ---------------------------------------------------------------- collect

function collect(opts) {
  const warnings = [];

  // -- missions
  let missionFiles = [];
  try { missionFiles = fs.readdirSync(opts.missionsDir).filter((f) => f.endsWith('.json')); } catch {
    warnings.push(`missions dir unreadable: ${opts.missionsDir}`);
  }
  const missions = [];
  for (const f of missionFiles) {
    try { missions.push({ file: f, ...JSON.parse(fs.readFileSync(path.join(opts.missionsDir, f), 'utf8')) }); } catch {
      warnings.push(`mission unreadable: ${f}`);
    }
  }

  // -- session -> cwd fallback cache (covers missions whose archive is gone)
  const cacheCwd = new Map();
  try {
    const pc = JSON.parse(fs.readFileSync(opts.projCache, 'utf8'));
    for (const [id, v] of Object.entries((pc.tables && pc.tables.sessions) || {})) {
      const c = v && v.identity && v.identity.cwd;
      if (c) cacheCwd.set(id, c);
    }
  } catch { warnings.push(`projcache unreadable: ${opts.projCache}`); }

  // -- archives
  const archives = walkSessions(opts.sessionsRoot);
  const archiveFiles = archives.reduce((n, a) => n + 1 + a.superseded, 0);
  const archivesSuperseded = archives.reduce((n, a) => n + a.superseded, 0);
  const projectRoots = discoverProjectRoots(opts.projectsRoot);

  const sessions = new Map(); // id -> meta (only sessions we actually read)
  const allSessions = [];     // lightweight, every archive
  const fileHits = new Map(); // abs path -> [{sessionId, cwd, ts, number}]
  const windowCutoff = Date.now() - opts.days * 864e5;
  let peakBytes = 0;

  // mission name -> number, so the file view can label hits
  const numberBySession = new Map();
  for (const m of missions) {
    if (m.sessionId) {
      if (!numberBySession.has(m.sessionId)) numberBySession.set(m.sessionId, []);
      numberBySession.get(m.sessionId).push(m.name);
    }
  }

  for (const a of archives) {
    let meta;
    try { meta = readSessionMeta(a); } catch { warnings.push(`archive unreadable: ${a.id}`); continue; }
    if (!meta) continue;
    allSessions.push({ id: meta.id, cwd: meta.cwd, mtime: meta.mtime, isSubagent: meta.isSubagent, bytes: meta.bytes });
    if (meta.bytes > peakBytes) peakBytes = meta.bytes;

    // keep meta for missions that reference this session
    const referenced = (numberBySession.get(a.id) || []).length > 0;
    if (referenced) sessions.set(a.id, meta);

    // file view: window + real sessions only (unless told otherwise)
    if (a.mtime < windowCutoff) continue;
    if (meta.isSubagent && !opts.includeSubagents) continue;
    if (!meta.cwd) continue;
    if (meta.userMsgs < 2 && !opts.includeSubagents) continue;

    for (const r of meta.recs) {
      if (r.type !== 'tool/call') continue;
      const d = r.data || {};
      if (d.name !== 'write' && d.name !== 'edit') continue;
      const args = parseArguments(d.arguments);
      if (!args) continue;
      const fp = args.file_path || args.path;
      if (typeof fp !== 'string' || !fp) continue;
      const abs = path.isAbsolute(fp) ? path.normalize(fp) : path.resolve(meta.cwd, fp);
      const ts = typeof r.time === 'number' ? r.time : meta.mtime;
      if (!fileHits.has(abs)) fileHits.set(abs, []);
      fileHits.get(abs).push({ sessionId: meta.id, cwd: meta.cwd, ts, numbers: numberBySession.get(meta.id) || [] });
    }
    meta.recs = null; // release
  }

  // -- git branch availability per candidate repo
  const repoRoots = projectRoots.filter((r) => fs.existsSync(path.join(r, '.git')));
  const branchCache = new Map();
  for (const r of repoRoots) branchCache.set(r, gitBranchList(r));

  // -- table 1 rows
  const rows = [];
  for (const m of missions) {
    const sid = m.sessionId || null;
    const meta = sid ? sessions.get(sid) : null;
    const cwd = (meta && meta.cwd) || (sid ? cacheCwd.get(sid) : null) || null;
    const grp = resolveProject(m, cwd, projectRoots);

    // branch: exists, or explicitly "已删" when the project is a git repo
    let branch = '—';
    let branchState = 'none';
    if (grp.path) {
      const list = branchCache.get(grp.path);
      if (list) {
        const hit = list.find((b) => b.includes(m.name));
        if (hit) { branch = hit; branchState = 'exists'; } else { branch = '已删'; branchState = 'deleted'; }
      }
    }

    // report file probe (json only)
    let reportPath = null;
    for (const base of [grp.path, cwd]) {
      if (!base) continue;
      const cand = path.join(base, '.dsh', 'missions', `${m.name}.md`);
      if (fs.existsSync(cand)) { reportPath = cand; break; }
    }

    rows.push({
      number: m.name,
      domain: domainOf(m.name),
      feature: m.feature || '（未填 feature）',
      branch,
      branchState,
      status: m.status || 'unknown',
      sessionId: sid,
      sessionShort: shortSession(sid),
      sessionExists: Boolean(meta),
      // 窗口: archive mtime == when this window was last loaded/alive (NOT when it worked).
      windowLoadedAt: meta ? meta.mtime : null,
      // 最后活动: newest non-lifecycle record == when it actually last did work.
      lastActivity: meta ? meta.lastActive : null,
      turns: meta ? meta.turns : null,
      peak: meta ? meta.peak : null,
      kb: meta ? Math.round(meta.bytes / 1024) : null,
      projectPath: grp.path,
      project: grp.name,
      groupedBy: grp.how,
      files: m.files || [],
      reportPath,
      createdAt: m.createdAt || null,
      updatedAt: m.updatedAt || null,
    });
  }

  // -- table 2 rows + L grading
  const files = [];
  for (const [p, hits] of fileHits) {
    hits.sort((a, b) => a.ts - b.ts);
    const sessionIds = [...new Set(hits.map((h) => h.sessionId))];
    const cwds = [...new Set(hits.map((h) => h.cwd))];

    // L3: two writes by DIFFERENT sessions less than the threshold apart.
    let minGap = null;
    for (let i = 1; i < hits.length; i += 1) {
      if (hits[i].sessionId === hits[i - 1].sessionId) continue;
      const gap = hits[i].ts - hits[i - 1].ts;
      if (minGap == null || gap < minGap) minGap = gap;
    }
    const l3 = minGap != null && minGap < opts.l3Minutes * 60000;
    const l2 = cwds.length > 1;

    const repo = findRepoRoot(p, repoRoots);
    files.push({
      path: p,
      sessions: sessionIds,
      sessionShorts: sessionIds.map(shortSession),
      numbers: [...new Set(hits.flatMap((h) => h.numbers))],
      writes: hits.length,
      first: hits[0].ts,
      last: hits[hits.length - 1].ts,
      cwds,
      L1: sessionIds.length > 1,
      L2: l2,
      L3: l3,
      minGapMs: minGap,
      shared: isSharedPath(p),
      repo: repo || null,
      tracked: null, // filled below with a shared per-repo cache (never per-file git calls)
      exists: fs.existsSync(p),
    });
  }
  // Resolve tracked-ness per REPO from a shared cache. Never look the repo up by basename: two
  // roots can share a leaf name (cpp-learning exists at the top level and under study\).
  const trackedCache = new Map();
  for (const f of files) {
    f.repoName = f.repo ? path.basename(f.repo) : null;
    f.tracked = f.repo ? (() => { const s = gitTrackedSet(f.repo, trackedCache); return s ? s.has(normKey(f.path)) : null; })() : null;
  }

  // -- domain declarations (契约 §3). Read-only; never throws and never warns, because a missing /
  // broken file is a NORMAL state ("nobody on duty") and must not damage the rest of the index.
  // "查无存档" is judged against the archives actually walked, not against a second filesystem scan.
  const archiveIds = new Set(archives.map((a) => normSessionKey(a.id)));
  const domainOwners = readDomainOwners(opts, archiveIds, rows, Date.now());

  return { missions, rows, files, allSessions, projectRoots, repoRoots, peakBytes, warnings, windowCutoff, archiveFiles, archivesSuperseded, domainOwners };
}

// ---------------------------------------------------------------- grading summary

function gradeSummary(files) {
  const g = { total: files.length, L1: 0, L2: 0, L3: 0, noFile: 0, inRepo: 0, tracked: 0, untracked: 0, noRepo: 0 };
  for (const f of files) {
    if (f.L1) g.L1 += 1;
    if (f.L2) g.L2 += 1;
    if (f.L3) g.L3 += 1;
    if (!f.exists) g.noFile += 1;
    if (f.repo) { g.inRepo += 1; if (f.tracked) g.tracked += 1; else g.untracked += 1; } else g.noRepo += 1;
  }
  return g;
}

// ---------------------------------------------------------------- render

/**
 * 摘要块 = 派发前唯一要求读的那块，必须小。2026-09-19 实测从 825 token 压到约 230：
 *  - 删掉「三点必知」——它讲的两件事（会话不能被 send_message 接管、复用判据）
 *    在 `templates\dispatch-template.md` 的「优先复用原会话」节里**已经各有一份**，而那份派发时
 *    本来就要读。此处只留指针，不复制（体系原则：AI 写的每个字都该是判断，不是把别处的数据再抄一遍）。
 *  - 「分支列已删属正常」撤销：分支列已从默认视图移出，不必再解释。
 */
/**
 * 使命名里的域名：约定 `S##-<域>-<slug>`。
 * ⚠️ **必须用白名单收紧**（2026-10-01 实测踩到）：老使命名如 `fix-registry-time-columns` 也是"三段以上"，
 * 只按段数取第 2 段会把它误判成域 `registry`——首版因此统计出 **53 个"域"**，全是假的。
 * 白名单外的第 2 段一律视为"未标域"：宁可漏报，不可虚报（统计是拿来做交接决策的）。
 * 新域出现时**在此加一行**（并在 `dispatch-template.md` 的域定义处同步）。
 */
const KNOWN_DOMAINS = new Set([
  'gui', 'backend', 'frontend', 'build', 'data', 'test', 'docs', 'infra', 'cli',
  'api', 'ui', 'db', 'perf', 'security', 'config', 'deploy', 'asr', 'vision', 'pipeline',
])

function domainOf(name) {
  if (!name) return null
  const seg = String(name).split('-')
  if (seg.length < 3) return null // S##-slug：没有域段
  const d = (seg[1] || '').trim().toLowerCase()
  if (!d) return null
  return KNOWN_DOMAINS.has(d) ? d : null
}

/**
 * 按域汇总：每个域多少件使命、多少件进行中、**历史上被几个会话用过**。
 * ⚠️ `windows` 是**历史**计数（该域所有已标域使命引用过的不同会话 id），**不是"当前有几个负责人在线"**。
 * 2026-10-09 曾把它当成"同域多在线违规"的证据，实测是虚警（死窗口也照样算进来）——一对一不变量管的是
 * **当前在线**的负责人，判违规要看在线会话列表，不看本计数。故打印时不加 ⚠。
 */
function domainStats(rows) {
  const m = new Map()
  for (const r of rows) {
    const d = r.domain
    if (!d) continue
    if (!m.has(d)) m.set(d, { domain: d, missions: 0, active: 0, windows: new Set() })
    const e = m.get(d)
    e.missions++
    if (r.status === 'active') e.active++
    if (r.sessionId) e.windows.add(r.sessionId)
  }
  return [...m.values()].map((e) => ({ ...e, windows: e.windows.size })).sort((a, b) => b.missions - a.missions)
}

/**
 * 域统计行（一行，不占预算）。用途：域会话机制下回答"哪个域在忙、忙了几件、历史用过几个会话"。
 * ⚠️ 旧口径「一个域占多个窗口＝该考虑并回一个负责人」**已作废**（2026-10-09 裁定：不变量加在**负责人**身上，
 * 一个域同时只有一个负责人；多出来的窗口属**交接链 / 历史**，不是违规；并发改由负责人在域内派子代理）。
 */
function renderDomainLine(stats) {
  if (!stats.length) return ''
  const total = stats.reduce((a, e) => a + e.missions, 0)
  const parts = stats
    .slice(0, 8)
    .map((e) => `${e.domain} ${e.missions}${e.active ? `(进行中${e.active})` : ''}${e.windows > 1 ? `（${e.windows} 会话用过）` : ''}`)
  const more = stats.length > 8 ? ` …共 ${stats.length} 个域` : ''
  return `> 域统计：**${total}** 条使命已标域 → ${parts.join('｜')}${more}。（约定 \`S##-<域>-<slug>\`；按域看窗口用默认视图。**"N 会话用过"是历史，不是"同域多在线"违规**——判违规看当前在线）`
}

// ---------------------------------------------------------------- 域名册（在任声明）集成

/**
 * 会话 id 归一化：本机同一个会话的目录名有两种写法（`session-<uuid>` 与裸 `<uuid>`，见
 * domain-owner.mjs 的 sessionDirNameCandidates）。这里也必须两种都认，否则会给**活着的**负责人
 * 误打「⚠查无存档」。
 */
const normSessionKey = (id) => String(id || '').replace(/^session-/i, '').toLowerCase();

const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n)}…` : t; };

const ageHoursOf = (iso, now) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / 36e5 : null;
};

/**
 * 使命库里"该域最近干活的会话"。
 * ⚠️ 只在域名上比对会立刻出假警报：`gui` 同时长在 `项目甲` 与 `项目乙`（契约 §1 实测），
 * 所以使命库里有**同项目**的行时只信那些行；一条都没有才退回"按域名全库取最近"。
 */
function latestLibrarySessionForDomain(rows, project, domain) {
  const all = rows.filter((r) => r.domain === domain && r.sessionId);
  if (!all.length) return null;
  const sameProject = all.filter((r) => r.project === project);
  const pool = sameProject.length ? sameProject : all;
  return pool.reduce((best, r) => (
    best == null || (r.lastActivity ?? -Infinity) > (best.lastActivity ?? -Infinity) ? r : best
  ), null);
}

/**
 * 读域名册（在任声明）。**绝不抛错、绝不进 warnings**：文件不存在 / 读不到 / JSON 坏了，
 * 一律降级成"无在任声明"，索引其余部分照常输出（契约 §1/§3 明写"不得当成错误"）。
 * 返回声明**原样转发** + 逐条校验结果，供 registry.json 用。
 */
function readDomainOwners(opts, archiveIds, rows, now) {
  const out = {
    file: opts.domainsPath,
    state: 'missing', // missing | unreadable | broken | ok
    fileExisted: false,
    readError: null,
    parseError: null,
    sourceSchemaVersion: null,
    sourceUpdatedAt: null,
    count: 0,
    owners: [],
  };

  let raw;
  try {
    raw = fs.readFileSync(out.file, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      out.state = 'unreadable';
      out.readError = err.message ? String(err.message) : String(err);
    }
    return out; // ENOENT keeps state='missing' -- a file that was never created is a NORMAL state
  }
  out.fileExisted = true;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    out.state = 'broken';
    out.parseError = err && err.message ? String(err.message) : String(err);
    return out;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    out.state = 'broken';
    out.parseError = 'top-level JSON value is not an object';
    return out;
  }

  out.state = 'ok';
  out.sourceSchemaVersion = data.schemaVersion ?? null;
  out.sourceUpdatedAt = data.updatedAt ?? null;
  const declared = (data.owners && typeof data.owners === 'object' && !Array.isArray(data.owners)) ? data.owners : {};

  for (const key of Object.keys(declared).sort()) {
    const rec = declared[key] && typeof declared[key] === 'object' ? declared[key] : {};
    const parts = String(key).split(':');
    const project = parts[0] || null;
    const domain = parts.slice(1).join(':') || null;
    const lib = latestLibrarySessionForDomain(rows, project, domain);
    const librarySessionId = lib ? lib.sessionId : null;
    // 不一致的判据只看"是不是同一个会话"；使命库没有该域的行 = 无从判定 = 不算不一致。
    const libraryMismatch = Boolean(librarySessionId
      && normSessionKey(librarySessionId) !== normSessionKey(rec.sessionId));
    out.owners.push({
      ...rec, // the declaration forwarded as-is ...
      key, project, domain,                 // ... plus the key it is filed under
      // ---- 逐条校验结果（只并列提示，绝不回写声明）----
      onDutyHours: ageHoursOf(rec.since, now),
      archiveFound: rec.sessionId ? archiveIds.has(normSessionKey(rec.sessionId)) : false,
      librarySessionId,
      librarySessionShort: librarySessionId ? shortSession(librarySessionId) : null,
      libraryMismatch,
    });
  }
  out.count = out.owners.length;
  return out;
}

/**
 * 域负责人行（契约 §3）：在「域统计」行**下面**追加**一行**，最多列 8 条，其余折成 `…共 N 个`。
 * 后缀两种：` ⚠查无存档`（声明所指会话的存档找不到）、`（使命库另有 sess-xxxx）`（使命库里
 * 该域最近干活的会话**不是**声明这个）——**只并列提示，绝不自动改声明**；判在任要看声明的权威源。
 * 域名册读不到时**不产生 warning**（那是正常状态），只在行里说明。
 */
function renderDomainOwnerLine(owners) {
  if (!owners.count) {
    const why = owners.state === 'broken' ? `域名册读不懂：${clip(owners.parseError, 60)}`
      : owners.state === 'unreadable' ? `域名册读不到：${clip(owners.readError, 60)}`
      : owners.fileExisted ? '域名册里没有任何声明'
      : '域名册文件不存在';
    return `> 域负责人（在任声明 0 个）：无在任声明（${why}；按"无人在任"处理，不是错误）`;
  }
  const parts = owners.owners.slice(0, 8).map((o) => {
    const duty = o.onDutyHours == null ? '在岗未知'
      : `在岗 ${o.onDutyHours < 1 ? o.onDutyHours.toFixed(1) : Math.floor(o.onDutyHours)}h`;
    const flags = [];
    if (!o.archiveFound) flags.push(' ⚠查无存档');
    if (o.libraryMismatch) flags.push(`（使命库另有 ${o.librarySessionShort}）`);
    return `${o.project}:${o.domain} → ${shortSession(o.sessionId)}（${duty}）${flags.join('')}`;
  });
  const more = owners.count > 8 ? `｜…共 ${owners.count} 个` : '';
  return `> 域负责人（在任声明 ${owners.count} 个）：${parts.join('｜')}${more}`;
}

function renderSummary(opts, ctx, now) {
  const g = gradeSummary(ctx.files);
  const realSessions = ctx.allSessions.filter((s) => !s.isSubagent).length;
  const active = ctx.rows.filter((r) => r.status === 'active').length;
  // "存档已删" 只对**本来有会话**的使命成立；无 sessionId 的（如 zcode 侧）不是"已删"，不能混进同一个数。
  const unseen = ctx.rows.filter((r) => r.sessionId && !r.sessionExists).length;
  const noSession = ctx.rows.filter((r) => !r.sessionId).length;
  const ungrouped = ctx.rows.filter((r) => r.groupedBy === 'unknown').length;
  const groups = new Set(ctx.rows.map((r) => r.project)).size;
  // 域名统计（2026-10-01 加，域会话机制的配套视角）：只统计**显式标了域**的使命。
  const dom = domainStats(ctx.rows);
  // 生成时刻＝**本次渲染的时刻**（2026-10-08 修正）。旧实现把 generatedAt 取成"已有 INDEX.md 的 mtime"，
  // 于是文件里印的"生成于"永远是**上一次**的刷新时刻：实测文件 mtime 13:38、头部却写"生成于 13:13 /
  // 表龄 25 分钟"（差一个刷新周期），"上次刷新 N 分钟前"同样是被写死的字符串 ⇒ 09-30 那个坑只修了一半。
  // 静态文件里的"N 分钟前"必然撒谎，**只有绝对时间戳是诚实的**：读者拿它跟当前时间自己比。
  // 上一份的年龄只作**刷新间隔**诊断（说明这次覆盖了多大空档），单独放一行 + stdout。
  const builtAt = Date.now();
  const prevAt = ctx.hadPrevious ? ctx.generatedAt : null;
  const pubAge = prevAt === null ? 0 : Math.max(0, Math.round((builtAt - prevAt) / 60000));
  const pubDays = Math.floor(pubAge / 1440);
  const pubAgeText = pubAge < 60 ? `${pubAge} 分钟`
    : pubAge < 1440 ? `${Math.round(pubAge / 60)} 小时`
    : `${pubDays} 天（${Math.round(pubAge / 60)} 小时）`;
  const L = [];
  L.push(INDEX_SIGNATURE);
  L.push('');
  L.push(`> **本索引生成于 ${stamp(builtAt)}** —— 读到时请与当前时间**自己比**：超过 ${opts.staleMinutes} 分钟就先跑 \`node D:\\xiangmu\\tools\\session-registry.mjs\`（约 10 秒）刷新再读。**刷新必须自己跑、不会自动。**`);
  if (prevAt !== null) {
    L.push(`> 上一次生成于 ${stamp(prevAt)}，距本次刷新 **${pubAgeText}**${pubAge > opts.staleMinutes ? '（⚠️ 覆盖了一段空档：这中间新起的会话/新做的使命，本表是补上的）' : ''} —— 这行只是**刷新间隔**，**不代表本文件现在的年龄**。`);
  }
  L.push('> 读法：**派发前读「本节 + 本项目段」**（约 0.3–0.9k token）。表一**默认按「窗口 > 使命」两级**（一级＝窗口，答"这个窗口管哪个域/几件/还开着吗"；二级＝使命）。单条使命看两列时间：**「窗口」＝还开着吗、「最后活动」＝还热吗**。查单文件谁改过 → `--file "<路径>"`；旧的一使命一行平铺 → `--by-mission`；要「使命一句话 / 分支」全列 → `--full`。**复用判据与"会话不能被 send_message 接管"都在 `templates\\dispatch-template.md`，此处不重复。**');
  L.push(`> 本期：使命 **${ctx.rows.length}** 条（进行中 ${active}）｜项目分组 ${groups} 个${ungrouped ? `（${ungrouped} 条未识别归属）` : ''}｜会话存档 ${ctx.allSessions.length}（文件 ${ctx.archiveFiles} 个；真会话 ${realSessions}；旧格式副本 ${ctx.archivesSuperseded} 个已忽略；使命引用的会话中 **${unseen}** 条存档已删${noSession ? `、**${noSession}** 条本就没有会话（如 zcode 侧）` : ''}）｜${opts.days} 天被写文件 **${g.total}**：多手(L1) ${g.L1}｜跨 cwd(L2) **${g.L2}**｜近同时(L3<${opts.l3Minutes}分) **${g.L3}**｜git 仓库外 **${g.noRepo}**。`);
  // 域名统计（域会话的对账依据）：只在**有域**时输出，老使命没域就不占行
  const domLine = renderDomainLine(dom);
  if (domLine) L.push(domLine);
  else L.push(`> 域统计：本期**没有一条使命标了域**（约定 ` + '`S##-<域>-<slug>`' + `）——域会话机制从下一件活起生效，历史使命不改名、不计入。`);
  // 域负责人（在任声明的权威源；契约 §3）：紧跟在「域统计」**下面**，仍然只占一行。
  L.push(renderDomainOwnerLine(ctx.domainOwners));
  L.push('> 盲区：`pwsh` 脚本里改的文件 / 编辑器手工改 / 窗口外会话 / dsh 之外的 agent 都抓不到；**L3 是信号不是结论**（阈值 ' + opts.l3Minutes + ' 分，判真冲突要查 git/文件历史）。');
  L.push('');
  return L.join('\n');
}

/**
/**
 * 表一（一使命一行平铺版；2026-10-01 起**非默认**，用 `--by-mission` 调出）。
 *  两列时间各有分工：「窗口」= mtime = 还开着吗；「最后活动」= 真实最后干活 = 热不热。
 *   `--full`     ＝ 多「使命一句话」「分支」——只在 slug 看不懂时才花这一次。
 * 实测依据（2026-09-19，项目甲 28 行）：默认 5 列 ≈ 600 token；加回「使命一句话」≈ 1289。
 * 2026-09-20 加「窗口」列后为默认 6 列（同一段多约 10~30 token，见上）。
 * 「使命一句话」与项目 `PROJECT.md` 判断记录的括号说明**重叠 62%**（76 条里 47 条项目表有对应行），
 * 所以默认不放；但仍有 38% 在项目表里查不到，故 `--full` 必须保留。
 * ↺N：同一个会话 id 承载 N 个使命＝复用了那个窗口（脚本能看出的事实；项目表里写成"（S## 会话执行）"）。
 */
function renderMissionTable(rows, opts) {
  const reuse = new Map();
  for (const r of rows) if (r.sessionId) reuse.set(r.sessionId, (reuse.get(r.sessionId) || 0) + 1);

  const byProject = new Map();
  for (const r of rows) {
    if (opts.project && r.project !== opts.project) continue;
    if (!byProject.has(r.project)) byProject.set(r.project, []);
    byProject.get(r.project).push(r);
  }
  const groups = [...byProject.entries()].sort((a, b) => {
    if (a[0] === '未识别') return 1;
    if (b[0] === '未识别') return -1;
    return b[1].length - a[1].length;
  });

  const full = Boolean(opts.full);
  const heads = full
    ? ['编号（使命名）', '使命一句话', '分支', '状态', '会话 id', '窗口', '最后活动', '体量']
    : ['编号（使命名）', '状态', '会话 id', '窗口', '最后活动', '体量'];
  const L = [];
  L.push('## 表一：使命 × 会话');
  L.push('');
  L.push(full
    ? '全列版（`--full`）：主键＝**使命名**；`状态/使命一句话` 来自使命库、`分支` 来自 git、`会话 id/窗口/最后活动/体量` 来自会话存档。**没有一列是手抄的。**'
    : '默认 6 列只回答**"有没有窗口 / 干完没 / 还热吗"**，其中两列各答一个问题：**「窗口」＝这个会话最后一次被 dsh 加载/写入的时间（点开看也会更新它）→ 答"还开着吗"**；**「最后活动」＝最后一次真正干活（最后一轮对话结束）→ 答"热不热"**。两列接近＝正常；**「窗口」新而「最后活动」旧＝窗口开着但已经冷了**。不放「使命一句话」（它与项目 `PROJECT.md` 判断记录的说明重叠 62%）；要看全列 → `--full`。`↺N`＝这个会话 id 承载了 N 个使命（即复用了那个窗口）。');
  L.push('');
  for (const [project, list] of groups) {
    // Sorted by 窗口 (archive mtime) desc = "most recently alive first", unchanged from the
    // pre-2026-09-20 behaviour; the real last-activity column is deliberately NOT the sort key.
    list.sort((a, b) => {
      const aa = a.windowLoadedAt == null ? Infinity : -a.windowLoadedAt;
      const bb = b.windowLoadedAt == null ? Infinity : -b.windowLoadedAt;
      return aa - bb;
    });
    const activeN = list.filter((r) => r.status === 'active').length;
    L.push(`### ${project}（${list.length} 条${activeN ? `，进行中 ${activeN}` : ''}）`);
    if (list.some((r) => r.groupedBy === 'cwd-parent' || r.groupedBy === 'unknown')) {
      L.push('> ⚠️ 本组含**按 cwd 兜底**归组的行（会话在父目录打开、无法反查到单一项目），个别行可能错位，看 json 的 `groupedBy` 字段。');
    }
    L.push('');
    L.push('| ' + heads.join(' | ') + ' |');
    L.push('|' + heads.map(() => '---').join('|') + '|');
    for (const r of list) {
      const st = r.status === 'completed' ? '完成' : (r.status === 'active' ? '**进行中**' : r.status);
      let sess = r.sessionId ? r.sessionShort : '—';
      const n = r.sessionId ? (reuse.get(r.sessionId) || 0) : 0;
      if (n > 1) sess += ` ↺${n}`;
      const vol = r.sessionExists ? `${ctxText(r.peak)} · ${r.kb}KB` : (r.sessionId ? '—（存档已删）' : '—（无会话）');
      const win = ageText(r.windowLoadedAt == null ? null : Date.now() - r.windowLoadedAt);
      const act = ageText(r.lastActivity == null ? null : Date.now() - r.lastActivity);
      const feat = String(r.feature).replace(/\|/g, '\\|').slice(0, 40);
      const cells = full
        ? [r.number, feat, r.branch, st, sess, win, act, vol]
        : [r.number, st, sess, win, act, vol];
      L.push('| ' + cells.join(' | ') + ' |');
    }
    L.push('');
  }
  if (groups.length === 0) L.push('_（无匹配行）_');
  L.push('');
  return L.join('\n');
}

/**
 * 表一「窗口 > 使命」两级版（`--by-window`，2026-10-01 加）。
 *
 * 为什么要有这个视图：域会话形态下**一个窗口长期负责一个域、里面装很多件使命**，
 * 而"这个窗口在管哪个域 / 管了几件 / 活了多久 / 该不该换人"是**窗口级**状态——
 * 旧的一使命一行答不了，只能靠人把同名 sessionId 的行自己拼起来。
 * 它同时就是"域会话机制正式启用后"登记视图的雏形（见 SYSTEM-OVERVIEW 待办）。
 *
 * 默认**不启用**：现有"一使命一行"的读法与文档口径不变，避免打断已在跑的习惯。
 * 使命名里的域约定：`S<域字母或域名>-<slug>` 时把第一段当作域显示（拿不准就留空）。
 */
function renderMissionTableByWindow(rows, opts) {
  const full = Boolean(opts.full);
  const byWin = new Map();
  for (const r of rows) {
    const key = r.sessionId || `(无会话) ${r.project}`;
    if (!byWin.has(key)) byWin.set(key, []);
    byWin.get(key).push(r);
  }
  // 排序：窗口活着在前（沿用表一主排序键），无窗口的垫底
  const winList = [...byWin.entries()].sort((a, b) => {
    const at = Math.max(...a[1].map((r) => r.windowLoadedAt ?? -Infinity));
    const bt = Math.max(...b[1].map((r) => r.windowLoadedAt ?? -Infinity));
    return bt - at;
  });

  const L = [];
  L.push('## 表一（窗口 > 使命）');
  L.push('');
  L.push('**两级**：一级＝**窗口**（一个会话＝一个域负责人），二级＝它承载的**使命**。回答旧表答不了的问题——**这个窗口在管哪个域 / 管了几件 / 活了多久 / 体量该不该压缩**。**这是默认视图**；要旧的一使命一行平铺 → `--by-mission`。');
  L.push('');
  for (const [winKey, list] of winList) {
    const withSess = list.filter((r) => r.sessionId);
    const sessShort = withSess.length ? withSess[0].sessionShort : '—（无会话）';
    const projects = [...new Set(list.map((r) => r.project))].join(' / ');
    const activeN = list.filter((r) => r.status === 'active').length;
    const windowAt = Math.max(...list.map((r) => r.windowLoadedAt ?? -Infinity));
    const winAge = ageText(windowAt === -Infinity ? null : Date.now() - windowAt);
    // 窗口寿命 = 最早的使命建立 → 最近一次更新
    const created = list.map((r) => r.createdAt).filter((x) => Number.isFinite(x))
    const updated = list.map((r) => r.updatedAt).filter((x) => Number.isFinite(x))
    const spanDays = created.length && updated.length
      ? Math.max(0, Math.round((Math.max(...updated) - Math.min(...created)) / 86400000))
      : null;
    L.push(`### ${sessShort} ↺${list.length} — ${projects}（${list.length} 件使命${activeN ? `，进行中 ${activeN}` : ''}）`);
    const peakMax = Math.max(...list.map((r) => r.peak ?? 0));
    // 软信号（2026-10-08 改口径）：不再有硬阈值；>500k 只提示"该压缩了"，交不交接由人临场定。
    const softBig = peakMax >= 500000;
    L.push(`> 窗口：**${winAge}**｜域记录寿命：${spanDays === null ? '—' : `${spanDays} 天`}${spanDays !== null && spanDays >= 14 ? '　⚠️ **>14 天**' : ''}｜体量：${ctxText(peakMax)}${softBig ? '　⚠️ **>500k，优先压缩**' : ''}`);
    L.push('');
    L.push('| ' + (full ? '使命名 | 状态 | 分支 | 最后活动 | 体量 | 一句话' : '使命名 | 状态 | 最后活动 | 体量') + ' |');
    L.push('|' + (full ? '---|---|---|---|---|---' : '---|---|---|---') + '|');
    for (const r of list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) {
      const st = r.status === 'completed' ? '完成' : (r.status === 'active' ? '**进行中**' : r.status);
      const act = ageText(r.lastActivity == null ? null : Date.now() - r.lastActivity);
      const vol = r.sessionExists ? `${ctxText(r.peak)} · ${r.kb}KB` : '—（存档已删）';
      const feat = String(r.feature).replace(/\|/g, '\\|').slice(0, 40);
      L.push('| ' + (full ? [r.number, st, r.branch, act, vol, feat] : [r.number, st, act, vol]).join(' | ') + ' |');
    }
    L.push('');
  }
  if (winList.length === 0) L.push('_（无匹配行）_');
  L.push('');
  return L.join('\n');
}

function renderFileTable(files, opts) {
  const risk = files.filter((f) => f.L2 || f.L3).sort((a, b) => {
    const sa = (a.L3 ? 2 : 0) + (a.L2 ? 1 : 0);
    const sb = (b.L3 ? 2 : 0) + (b.L2 ? 1 : 0);
    return sb - sa || b.writes - a.writes;
  });
  const L = [];
  L.push('## 表二：文件反查表（只列风险项）');
  L.push('');
  L.push('主键＝**文件绝对路径**。`md` 只列 L2/L3 风险项；**全量**在 json 里（`--file <路径>` 可反查任意文件）。');
  L.push('`L2`＝被**跨 cwd 的多个会话**改过（可能两个项目在改同一文件）；`L3`＝两次**不同会话**的写入间隔小于阈值（近同时，**信号不是结论**）。');
  L.push('');
  L.push(`| 文件路径 | 会话 id | 使命 | 改动次数 | 首改 | 末改 | 标记 |`);
  L.push('|---|---|---|---|---|---|---|');
  if (risk.length === 0) L.push('| _（窗口内无风险项）_ | | | | | | |');
  for (const f of risk) {
    const flags = [];
    if (f.L3) flags.push(`L3 近同时(${Math.round(f.minGapMs / 60000)}分)`);
    if (f.L2) flags.push('L2 跨cwd');
    if (f.shared) flags.push('共享文件');
    L.push(`| ${f.path} | ${f.sessionShorts.join(', ')} | ${f.numbers.join(', ') || '—'} | ${f.writes} | ${stamp(f.first)} | ${stamp(f.last)} | ${flags.join(' · ')} |`);
  }
  L.push('');
  return L.join('\n');
}

/**
 * 默认**不打印表二**（文件反查）：它只服务于"改共享文件前"那个触发点，按需 `--file` 即可。
 * 实测这笔白搭是 1163 token/次（真实数据），是省 token 的最大单块。
 * `--full` 时才把表二附上。
 */
function renderIndex(opts, ctx, now) {
  const parts = [
    renderSummary(opts, ctx, now),
    opts.byMission ? renderMissionTable(ctx.rows, opts) : renderMissionTableByWindow(ctx.rows, opts),
  ];
  if (opts.full) parts.push(renderFileTable(ctx.files, opts));
  parts.push('---');
  parts.push('> 刷新：`node D:\\xiangmu\\tools\\session-registry.mjs`　｜　全列（含使命一句话/分支/表二）：加 `--full`　｜　单文件反查：`--file "<路径>"`');
  parts.push('> 本文件由脚本生成，**不要手工编辑**（会被下次刷新覆盖）；需要改口径请改生成器或提案。');
  parts.push('');
  return parts.join('\n');
}

function renderFileQuery(rows, opts) {
  const norm = normKey(opts.fileQuery);
  const hits = rows.filter((f) => normKey(f.path) === norm || normKey(f.path).endsWith(path.sep + norm) || f.path.toLowerCase().includes(opts.fileQuery.toLowerCase()));
  const L = [];
  L.push(`# 文件反查：${opts.fileQuery}`);
  L.push('');
  if (hits.length === 0) {
    L.push(`窗口 ${opts.days} 天内没有任何会话通过 write/edit 写过该文件。`);
    L.push('（若确定有人改过：可能改法不在 write/edit 里，如 `pwsh` 脚本改写——属已声明盲区。）');
    return L.join('\n');
  }
  for (const f of hits) {
    L.push(`**${f.path}**`);
    L.push(`- 改动 ${f.writes} 次，首改 ${stamp(f.first)}，末改 ${stamp(f.last)}`);
    L.push(`- 改过它的会话：${f.sessions.join(', ')}`);
    L.push(`- 涉及的使命编号：${f.numbers.join(', ') || '—'}`);
    L.push(`- 跨 cwd：${f.cwds.join(' | ')}`);
    L.push(`- 标记：L1多手=${f.L1} L2跨cwd=${f.L2} L3近同时=${f.L3}${f.minGapMs != null ? `（最小跨会话间隔 ${Math.round(f.minGapMs / 60000)} 分）` : ''}${f.shared ? ' 共享文件' : ''}`);
    L.push(`- git：${f.repo ? `${f.repo} / ${f.tracked ? '已跟踪' : '未跟踪或已忽略'}` : '不在任何 git 仓库内'}`);
    L.push('');
    if (f.L3) L.push('> ⚠️ L3 只说明"两次不同会话的写入靠得近"，不等于冲突；判真冲突请查 git 历史或文件内容。');
    L.push('');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- one-page handoff pack

const NEXT_HEADING_RE = /^#{2,4}\s*(下一步|待办|TODO|Next)/i; // no \b: JS \w excludes CJK, so \b never matches after 下一步
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * Mine the "下一步 / 待办" section of a PROJECT.md. Returns [] when the file or the section is
 * missing -- the caller then prints "未取到" instead of inventing content. Nothing is cached and
 * nothing is written back: the handoff stays a pure projection of the files already being read.
 *
 * WHICH items (corrected 2026-10-11, v2.6.1) -- the direction of the original pick was backwards.
 * The first version took the FIRST `max` items, i.e. the OLDEST ones. `{体系根}\PROJECT.md`
 * numbers its list 1..11 with the HIGHER number being the NEWER handoff item, so "the newest 3"
 * silently became "the oldest 3" and exactly the entries a successor needs most (9/10/11:
 * 会话协作框架 + 提案 / 在任声明第二步 / 轨道 1 + 待裁决) were cut. Rule now:
 *   1. `[x]` items are skipped -- quoting finished work under "下一步/待办" misleads the reader.
 *   2. a NUMBERED list whose numbers ascend down the file is an append-style "higher = newer" list
 *      => keep the TAIL (newest). Anything else (bullets, descending numbers) keeps the HEAD: the
 *      text carries no "which end is newer" signal, and a bulleted queue is normally priority-ordered.
 *   3. the kept items are re-emitted in FILE ORDER, so §三 still reads like its source section.
 *
 * v2.7.0 (P2): this function no longer clips or caps anything. `max` defaults to Infinity, i.e. it
 * returns EVERY unfinished item, in full, in file order -- that is what handoff.json stores. The
 * `newestLast` rule above is kept verbatim and is still exercised by the MD renderer, which is the
 * only caller that now passes a real `max`; the layout caps belong to the rendering layer.
 *
 * WHICH items, take 2 -- A03, 2026-10-15 (user-picked option A): only TOP-LEVEL list lines are
 * entries; an indented sub-item is PART OF the entry above it (its text is appended to that entry,
 * and it no longer consumes a quota slot). Measured cause (2026-10-13): of the system root's 6
 * quota slots, 3 were eaten by ONE entry's sub-items, so the entries ranked 4th-6th never reached
 * the page -- the page shows the head of the section, so sub-items stole exactly the highest-value
 * slots. Behaviour kept deliberately unchanged: a `[x]` parent takes its sub-items with it (they
 * belong to finished work), and `newestLast` still requires "no indented sub-items anywhere in the
 * section" -- dropping that condition would have silently INVERTED the take end for the system
 * root (it is all-numbered and ascending once sub-items stop being entries), i.e. the page would
 * have started showing the section's TAIL. See the A01/A03 report; `PROJECT.md` §排序规则 是
 * 该口径的正本，本轮未改它。
 */
function readNextSteps(projectDir, max = Infinity) {
  let text;
  try { text = fs.readFileSync(path.join(projectDir, 'PROJECT.md'), 'utf8'); } catch { return []; }
  const lines = []; // { text, numbered, n, indent } in file order, `[x]` lines NOT yet dropped
  let depth = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const h = /^(#{1,6})\s+/.exec(line);
    if (h) {
      if (depth !== null && h[1].length <= depth) break; // section ended at same-or-higher level
      if (depth === null && NEXT_HEADING_RE.test(line)) depth = h[1].length;
      continue;
    }
    if (depth === null) continue;
    if (!LIST_ITEM_RE.test(line)) continue;
    const numbered = /^\s*(\d+)[.)]\s+/.exec(line);
    const indent = /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
    const item = line.replace(LIST_ITEM_RE, '').replace(/\*\*/g, '').trim();
    if (item) lines.push({ text: item, numbered: Boolean(numbered), n: numbered ? Number(numbered[1]) : null, indent });
  }
  // A03: the top level of this section = the smallest indentation actually used by its list lines.
  // Anything deeper is a sub-item and is folded into the entry above it (never a slot of its own).
  // A leading indented line with no parent above it is kept as an entry rather than silently lost.
  const base = lines.length ? Math.min(...lines.map((l) => l.indent)) : 0;
  const raw = [];                                  // every top-level line, `[x]` included for now
  let hasSubItems = false;
  for (const it of lines) {
    if (it.indent > base && raw.length) {
      hasSubItems = true;
      // `[x]` sub-items keep the old rule (finished work is not quoted); they just also stop
      // consuming a slot. The parent's own `[x]` still takes the whole entry -- and its sub-items
      // with it, because they are part of it ("完成项必须让位").
      if (!/^\[[xX]\]/.test(it.text)) raw[raw.length - 1].text += ` ${it.text}`;
      continue;
    }
    raw.push({ text: it.text, numbered: it.numbered, n: it.n, done: /^\[[xX]\]/.test(it.text) });
  }
  // `[x]` entries are already done -- quoting them under "下一步/待办" would mislead the reader.
  // v2.7.0: full text (no `clip(…,96)`) -- the JSON must carry the whole item; MD clips at render.
  const items = raw.filter((it) => !it.done);
  // "编号越大越新" only when the WHOLE list is numbered, the numbers ascend in file order, AND the
  // section carries no indented sub-items (A03: sub-items no longer break `every(numbered)` on
  // their own, so this condition has to be stated explicitly to keep the pre-2.8.0 take end).
  const newestLast = !hasSubItems && items.length > 1 && items.every((it) => it.numbered)
    && items.every((it, i) => i === 0 || it.n > items[i - 1].n);
  const kept = items.length > max ? (newestLast ? items.slice(-max) : items.slice(0, max)) : items;
  return kept.map((it) => it.text);
}

/**
 * Recent `### ` titles from `templates\SYSTEM-changelog.md` (the file is newest-first).
 * WHY (2026-10-11): §四 originally read ONLY the mission library, and the system-side work of a day
 * is routinely done by the main session WITHOUT a declared mission (体系主会话直办). Those changes
 * live in the changelog with a date, so today's work showed up nowhere in the handoff. Reading the
 * top N titles is one file read and adds no second ledger. Missing/unreadable file => null and the
 * caller says so, instead of pretending the list is complete.
 *
 * v2.7.0: returns `{ date, title }` with the title UNCLIPPED -- handoff.json stores the full title.
 * The `${date || '—'}｜${clip(title, 70)}` line the MD prints is built by the MD renderer instead.
 */
function readRecentChangelog(file, n) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const out = [];
  let date = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const d = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (d) { date = d[1]; continue; }
    const t = /^###\s+(.+?)\s*$/.exec(line);
    if (!t) continue;
    out.push({ date: date || null, title: t[1].replace(/\*\*/g, '') });
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Which PROJECT.md files are worth quoting: the maintenance system's own first, then the projects
 * that actually have an unsettled mission. Order is fully specified (active count desc, then path)
 * so that re-running on the same inputs yields the same bytes.
 *
 * v2.7.0 (P2): returns EVERY candidate -- the old `slice(0, HANDOFF_MAX_PROJECTS)` is gone, because
 * handoff.json has no "one page" constraint. The MD renderer applies the cap itself.
 * `max` still travels with the candidate for the MD's per-source quota: the system root is the
 * handoff's main file and gets a wider cap (HANDOFF_ITEMS_ROOT) than the project files
 * (HANDOFF_ITEMS_PER_PROJECT). The JSON ignores `max` entirely.
 *
 * v2.8.0 (A01): `scope` (from --scope) narrows the answer to ONE layer. The whole point is that a
 * handoff is not a survey of everything: the successor of a project session needs that project's
 * list, the system session needs the system's list. With a scope we do not even read the other
 * PROJECT.md files. Quotas stay exactly as before (体系根 6 / 项目 3): a quota is a threshold, and
 * changing one is a user decision, not a side effect of layering -- flagged in the report instead.
 */
function handoffNextStepSources(opts, ctx, scope = null) {
  if (scope) {
    return [scope.kind === 'system'
      ? { label: '体系', dir: opts.projectsRoot, max: HANDOFF_ITEMS_ROOT }
      : { label: scope.label, dir: scope.dir, max: HANDOFF_ITEMS_PER_PROJECT }];
  }
  const activeByProject = new Map();
  for (const r of ctx.rows) {
    if (r.status === 'completed' || !r.projectPath) continue;
    const k = normKey(r.projectPath);
    activeByProject.set(k, (activeByProject.get(k) || 0) + 1);
  }
  const cand = [{ label: '体系', dir: opts.projectsRoot, max: HANDOFF_ITEMS_ROOT }];
  const sorted = ctx.projectRoots.slice().sort((a, b) => {
    const d = (activeByProject.get(normKey(b)) || 0) - (activeByProject.get(normKey(a)) || 0);
    return d !== 0 ? d : a.localeCompare(b);
  });
  for (const dir of sorted) {
    if (!activeByProject.get(normKey(dir))) continue;
    cand.push({ label: path.relative(opts.projectsRoot, dir) || path.basename(dir), dir, max: HANDOFF_ITEMS_PER_PROJECT });
  }
  return cand;
}

/**
 * L4 (2026-10-18): a path into the user's home must stay portable IN THE ARTIFACT, not just in the
 * computation. `os.homedir()` already builds the real path (parseArgs / --missions-dir), but writing
 * that result verbatim bakes this machine's user name into every rendered handoff. Fold the home
 * prefix to `~` for DISPLAY only -- reads from disk still use the absolute path.
 */
function displayPath(p) {
  const home = os.homedir();
  const s = String(p ?? '');
  if (s.slice(0, home.length).toLowerCase() !== home.toLowerCase()) return s;
  const rest = s.slice(home.length);
  return rest === '' || rest.startsWith(path.sep) || rest.startsWith('/') ? `~${rest}` : s;
}

/**
 * §五 as data: `{ label, path }` pairs for handoff.json. This is the JSON twin of the MD's 關鍵文件
 * list; the MD text keeps its own (richer) prose and is intentionally NOT rebuilt from this array,
 * so that adding fields here can never silently rewrite the one-page page. Paths are resolved from
 * the options actually used.
 *
 * v2.8.0 (A01): a project-layer handoff carries a pointer to the SYSTEM layer (that is the one
 * thing a project successor cannot derive locally), inserted right after the two self-paths.
 */
function handoffKeyPaths(opts, ctx, scope = null) {
  const out = [
    { label: '交接包 JSON（本文件・真值源・机器读）', path: opts.handoffPath },
    { label: '交接包 MD（按需渲染・人读）', path: opts.handoffMdPath || path.join(scope ? scope.outDir : opts.outDir, HANDOFF_NAME) },
  ];
  if (scope && scope.kind === 'project') {
    out.push({ label: `体系交接包（跨项目导航・本文件只覆盖「${scope.label}」一层）`, path: path.join(opts.outDir, HANDOFF_JSON_NAME) });
  }
  out.push(
    { label: '索引（人读）', path: path.join(opts.outDir, INDEX_NAME) },
    { label: '索引（机器读）', path: path.join(opts.outDir, JSON_NAME) },
    { label: '体系总览（交接主文档＝机制正本；其 §五 自 2026-10-13「甲」起只剩指针——体系侧活跃待办主表＝体系 PROJECT.md 的 §下一步）', path: 'D:\\xiangmu\\SYSTEM-OVERVIEW.md' },
    { label: '知识库坑/经验速查表', path: 'D:\\dsh\\knowledge\\INDEX.md' },
    { label: '知识库方面文档目录', path: 'D:\\dsh\\knowledge\\aspects\\' },
    { label: '在任声明（只读真值）', path: opts.domainsPath },
    { label: `使命库（身份真值，${ctx.missions.length} 条）`, path: displayPath(opts.missionsDir) },
    { label: '派发口径', path: 'D:\\xiangmu\\templates\\dispatch-template.md' },
    { label: '域文档', path: 'KNOWLEDGE\\<域>.md' },
    { label: '工具目录（session-registry.mjs / mission.mjs / domain-owner.mjs）', path: 'D:\\xiangmu\\tools\\' },
  );
  return out;
}

/**
 * handoff.json -- the handoff ARTIFACT since v2.7.0 (P1). Same five sections as the one-page MD,
 * same data, but with NO layout constraint: every unfinished "next step" is stored in full, and no
 * per-source quota / project cap / line budget is applied. `renderHandoff()` is the one-page view of
 * this document, so the two are deliberately built from separate arrays -- the MD's budget loop
 * `shift()`s its own copies and must never be able to shorten what is written here.
 * Everything except `generatedAt` / `generatedAtLocal` / `sourceIndexGeneratedAt` /
 * `refreshGapMinutes` is a pure function of the inputs, so two runs on the same input differ only in
 * those four fields. That claim holds ONLY because `ownerOnDuty.owners[]` drops the clock-derived
 * `onDutyHours` below -- forward it again and this sentence becomes a lie whose practical effect is
 * that every diff of two handoff.json files reports a change that never happened.
 * v2.8.0 (A01): under --scope the document gains exactly one key, `scope` (kind / label / dir /
 * systemHandoff), and `nextSteps` carries that one layer. Without --scope the key set is unchanged,
 * so an unscoped consumer never has to learn a new field.
 */
function buildHandoffJson(opts, ctx, now, scope = null) {
  const active = ctx.rows.filter((r) => r.status === 'active').length;
  const groups = new Set(ctx.rows.map((r) => r.project)).size;
  const realSessions = ctx.allSessions.filter((s) => !s.isSubagent).length;
  const unseen = ctx.rows.filter((r) => r.sessionId && !r.sessionExists).length;
  const changelogPath = path.join(opts.projectsRoot, CHANGELOG_REL);

  return {
    schemaVersion: HANDOFF_JSON_SCHEMA_VERSION,
    tool: 'session-registry',
    version: TOOL_VERSION,
    generatedAt: new Date(now).toISOString(),
    generatedAtLocal: stamp(now),
    // 上一份 INDEX.md 的 mtime ＝ 上次刷新时刻；没有旧文件时为 null（不是 0，免得被读成"刚好刷新过"）。
    sourceIndexGeneratedAt: ctx.hadPrevious ? new Date(ctx.generatedAt).toISOString() : null,
    refreshGapMinutes: ctx.hadPrevious ? Math.max(0, Math.round((now - ctx.generatedAt) / 60000)) : null,
    staleAfterMinutes: opts.staleMinutes, // 复用既有 --stale-minutes（默认 30），不是新门槛
    readMe: HANDOFF_README,
    ownerOnDuty: {
      file: ctx.domainOwners.file,
      state: ctx.domainOwners.state,
      count: ctx.domainOwners.count,
      // `onDutyHours` 有意**不转发**：它＝`now - since`，是**读时钟**得来的，不是输入的函数。
      // 转发它会让上面那句"除 4 个字段外皆为输入纯函数"变成假话，并让任意两次 handoff.json 的
      // diff 永远报出一处并未发生的变更（2026-10-14 由独立核验者实测抓出）。真值是 `since`，
      // 消费方要小时数自己算。**不要再加回来。**
      owners: ctx.domainOwners.owners.map(({ onDutyHours, ...rest }) => rest),
    },
    status: {
      missions: ctx.rows.length,
      missionsActive: active,
      projectGroups: groups,
      sessions: ctx.allSessions.length,
      realSessions,
      archivesGone: unseen, // 使命引用的会话里，存档已被删掉的条数
      fileWindowDays: opts.days,
      files: ctx.files.length,
      warnings: ctx.warnings,
    },
    // P2: every unfinished item, full text, file order, no 6/3 quota and no project cap.
    // A01: with --scope this array has exactly ONE entry -- the layer being handed over.
    ...(scope ? {
      scope: {
        kind: scope.kind,
        label: scope.label,
        dir: scope.dir,
        // the layer above: only a project layer needs the pointer (the system layer IS the top).
        // `null` on the system layer is meaningful, not missing data.
        systemHandoff: scope.kind === 'project' ? path.join(opts.outDir, HANDOFF_JSON_NAME) : null,
      },
    } : {}),
    nextSteps: handoffNextStepSources(opts, ctx, scope).map((s) => ({
      scope: s.label,
      dir: s.dir,
      items: readNextSteps(s.dir),
    })),
    recentChanges: ctx.rows.slice().sort((a, b) => {
      const ta = a.updatedAt ?? a.createdAt ?? 0;
      const tb = b.updatedAt ?? b.createdAt ?? 0;
      return tb - ta || String(a.number).localeCompare(String(b.number));
    }).slice(0, HANDOFF_RECENT).map((r) => ({
      at: stamp(r.updatedAt ?? r.createdAt),
      status: r.status,
      number: String(r.number == null ? '' : r.number),   // full text; MD clips to 44
      feature: String(r.feature == null ? '' : r.feature), // full text; MD clips to 40
    })),
    recentChangelog: (() => {
      const cl = readRecentChangelog(changelogPath, HANDOFF_RECENT_CHANGELOG);
      return cl ? cl.map((c) => ({ date: c.date, title: c.title })) : null; // full title; MD clips to 70
    })(),
    keyPaths: handoffKeyPaths(opts, ctx, scope),
  };
}

/**
 * The one-page handoff pack (提案 2026-10-09 §2.2). MD-only since v2.7.0: this is a RENDERING of
 * handoff.json and is the ONLY place where layout constraints live -- per-source quotas (体系根 6 /
 * 项目 3), `clip()`, the ${HANDOFF_MAX_LINES}-line budget. Derived content, no second ledger:
 *   owner on duty  <- domains.json (read-only truth)
 *   status         <- the same counts INDEX.md prints
 *   next steps     <- PROJECT.md "下一步/待办" sections; TOP-LEVEL items only (A03: an indented
 *                     sub-item is part of the entry above it, never a slot of its own); `[x]`
 *                     skipped; take end decided in readNextSteps (体系根 6 条 / 项目 3 条)
 *   recent changes <- mission library, newest updatedAt first, + the top SYSTEM-changelog titles
 *                     (the system-side work that has no mission record)
 *   key paths      <- resolved from the options actually used; a project layer also points up
 *                     at the system layer (A01)
 * Everything except the generation timestamp is a pure function of those inputs.
 * v2.8.0 (A01): every difference this function makes because of `scope` is limited to (a) which
 * sources are read, (b) one extra header line naming the layer, (c) one extra §五 pointer line on
 * a project layer. Unscoped, all three collapse back to the v2.7.0 text.
 */
function renderHandoff(opts, ctx, now, scope = null) {
  const active = ctx.rows.filter((r) => r.status === 'active').length;
  const groups = new Set(ctx.rows.map((r) => r.project)).size;
  const realSessions = ctx.allSessions.filter((s) => !s.isSubagent).length;
  const unseen = ctx.rows.filter((r) => r.sessionId && !r.sessionExists).length;
  const L = [];
  const systemHandoffPath = path.join(opts.outDir, HANDOFF_JSON_NAME);

  L.push(HANDOFF_SIGNATURE);
  L.push('');
  L.push(`> 生成于 ${stamp(now)}｜session-registry v${TOOL_VERSION} --handoff-md${scope ? ` --scope ${scope.label}` : ''}｜数据源＝使命库 + 本索引 + ${scope ? `「${scope.label}」的 PROJECT.md` : '各 PROJECT.md'}`);
  L.push(`> **新会话开局**：先读 \`${opts.handoffPath}\` 拿导航（**真值源就是它**），**再补读两份**——体系总览 \`D:\\xiangmu\\SYSTEM-OVERVIEW.md\` 的 §五「待办」区（**自 2026-10-13「甲」起只剩一行指针**；**体系侧活跃待办主表＝体系 \`PROJECT.md\` 的 §下一步**）＋ 知识库坑/经验速查表 \`D:\\dsh\\knowledge\\INDEX.md\`（§五 也列了）。**有意不复制它们的待办正文**（同一口径写多处必烂）。**本页是那份 JSON 的按需渲染**、给人读时才现生成：不要手写，要改动就改上游文件再重跑：`);
  // A01: one layer per file. A project layer says so and points up; the system layer points back
  // at the per-project layers so a successor can tell the two apart. Unscoped keeps the old text.
  if (scope && scope.kind === 'project') {
    L.push(`> **本页只覆盖「${scope.label}」这一层**（A01 分层：体系／项目各生成一份、各落自己目录）｜**体系侧（跨项目导航）交接包** \`${systemHandoffPath}\``);
  } else if (scope) {
    L.push(`> **本页只覆盖「体系」这一层**（A01 分层：体系／项目各生成一份、各落自己目录）｜**各项目自己的交接包**在其项目目录的 \`${HANDOFF_SCOPE_SUBDIR}\\${HANDOFF_JSON_NAME}\``);
  }
  L.push('> `node D:\\xiangmu\\tools\\session-registry.mjs --handoff-md`（隐含 `--handoff`：JSON 是源、本页是它的渲染，两份一起写）');
  if (ctx.hadPrevious) {
    const gapMin = Math.max(0, Math.round((now - ctx.generatedAt) / 60000));
    L.push(`> 上一份索引生成于 ${stamp(ctx.generatedAt)}，距本次刷新 **${gapMin} 分钟**（只是刷新间隔，不是本文件年龄）。`);
  }
  L.push('');
  L.push('## 一、当前负责人（在任声明 · 权威源即下方 domains.json，本脚本只读不改）');
  L.push(renderDomainOwnerLine(ctx.domainOwners));
  L.push('');
  L.push('## 二、现状（本期）');
  L.push(`> 使命 **${ctx.rows.length}** 条（进行中 **${active}**）｜项目分组 ${groups} 个｜会话存档 ${ctx.allSessions.length}（真会话 ${realSessions}）｜使命引用的会话中 ${unseen} 条存档已删｜${opts.days} 天内被写文件 ${ctx.files.length} 个`);
  L.push(`> 本次已刷新：\`${path.join(opts.outDir, INDEX_NAME)}\` + \`${path.join(opts.outDir, JSON_NAME)}\`${ctx.warnings.length ? `｜⚠️ collect warnings ${ctx.warnings.length} 条（见 registry.json）` : ''}`);
  L.push('');

  // -- §四/§五 are built FIRST: they are fixed-size (never allowed to shrink), and §三 is the only
  //    section that may lose items -- it sizes itself against the one-page cap, so the four sections
  //    this file promises (在任声明 / 现状 / 最近变更 / 关键路径) can never be cut off the tail.
  const recent = ctx.rows.slice().sort((a, b) => {
    const ta = a.updatedAt ?? a.createdAt ?? 0;
    const tb = b.updatedAt ?? b.createdAt ?? 0;
    return tb - ta || String(a.number).localeCompare(String(b.number));
  }).slice(0, HANDOFF_RECENT);
  const tail = [];
  tail.push(`## 四、最近变更（使命库按 updatedAt 倒序，取前 ${HANDOFF_RECENT} 条）`);
  if (recent.length) {
    for (const r of recent) tail.push(`- ${stamp(r.updatedAt ?? r.createdAt)}｜${r.status}｜${clip(r.number, 44)}｜${clip(r.feature, 40)}`);
  } else tail.push('- （使命库为空）');
  // 使命库只认 declare 过的活；体系主会话直办的那些（无使命登记，如 2026-10-11 的轨道 1 / A′ / 域可达
  // 第二步）只在 changelog 里留标题。读不到文件就如实写明限制，不假装这份清单是完整的。
  const changelogPath = path.join(opts.projectsRoot, CHANGELOG_REL);
  const changelog = readRecentChangelog(changelogPath, HANDOFF_RECENT_CHANGELOG);
  if (changelog && changelog.length) {
    tail.push('');
    tail.push(`> 体系侧最近变更（\`${CHANGELOG_REL}\` 标题，新在上；只列标题、不抄正文）：`);
    for (const c of changelog) tail.push(`- ${c.date || '—'}｜${clip(c.title, 70)}`);
  } else {
    tail.push(`- 已知限制：使命库只含已登记的使命，「体系主会话直办」的活不在其中；本次也没读到 \`${changelogPath}\` 的标题。`);
  }
  tail.push('');

  tail.push('## 五、关键文件路径');
  // A01: a project-layer page must point UP -- the cross-project navigation lives in the system
  // layer, and a project successor cannot derive that path locally.
  if (scope && scope.kind === 'project') {
    tail.push(`- **体系交接包（跨项目导航・本页只覆盖「${scope.label}」一层）** \`${systemHandoffPath}\``);
  }
  tail.push(`- 索引（人读）\`${path.join(opts.outDir, INDEX_NAME)}\`｜（机器读）\`${path.join(opts.outDir, JSON_NAME)}\``);
  tail.push('- **体系总览**（交接主文档＝**机制正本**；**其 §五 自 2026-10-13「甲」起只剩指针——体系侧活跃待办主表＝体系 `PROJECT.md` 的 §下一步**）`D:\\xiangmu\\SYSTEM-OVERVIEW.md`');
  tail.push('- **知识库坑/经验速查表** `D:\\dsh\\knowledge\\INDEX.md`｜方面文档目录 `D:\\dsh\\knowledge\\aspects\\`');
  tail.push(`- 在任声明（只读真值）\`${opts.domainsPath}\``);
  tail.push(`- 使命库（身份真值，${ctx.missions.length} 条）\`${displayPath(opts.missionsDir)}\``);
  tail.push('- 派发口径 `D:\\xiangmu\\templates\\dispatch-template.md`｜域文档 `KNOWLEDGE\\<域>.md`');
  tail.push('- 工具 `D:\\xiangmu\\tools\\`：session-registry.mjs（本索引）/ mission.mjs（declare·complete）/ domain-owner.mjs');
  tail.push('');
  tail.push('> 本页由脚本一次生成，同输入除时间戳外逐字节一致；**它是 `handoff.json` 的一页渲染，不另立台账**。');

  // -- §三: newest + unfinished first (see readNextSteps). When the page is full, items are dropped
  //    from the LOWEST-priority end first -- the last source (the system root is first, so projects
  //    come after it) and, inside it, its LAST entry. Before 2.8.0 this used `shift()`, i.e. it
  //    deleted the HIGHEST-priority entry of the lowest-priority source: the one item that must
  //    never be the first to go (A01, 2026-10-15; named by the 2026-10-14 independent check).
  //    The caps below (project count, per-source max, clip, line budget) are MD-ONLY: handoff.json
  //    keeps every candidate, every item, in full. `items` is a fresh array from readNextSteps, and
  //    the spread makes that explicit -- this loop mutates it, and must never touch the JSON's copy.
  const sections = handoffNextStepSources(opts, ctx, scope).slice(0, HANDOFF_MAX_PROJECTS)
    .map((s) => ({ label: s.label, items: [...readNextSteps(s.dir, s.max)] }));
  const mined = sections.reduce((n, s) => n + s.items.length, 0);
  let budget = HANDOFF_MAX_LINES - L.length - 2 - tail.length; // §三 = heading + items + blank
  // The omission note is itself a line. When one will be needed, reserve its line UP FRONT --
  // otherwise the note would push the page one line past the very cap it just reported
  // (measured: cap 61 -> page 62, caught only by the stderr WARN below).
  if (mined > budget) budget -= 1;
  let kept = mined;
  for (let i = sections.length - 1; i >= 0 && kept > budget; i -= 1) {
    while (sections[i].items.length && kept > budget) { sections[i].items.pop(); kept -= 1; }
  }
  const dropped = mined - kept;
  const stepLines = [];
  for (const s of sections) for (const item of s.items) stepLines.push(`- [${s.label}] ${clip(item, 96)}`);
  L.push(`## 三、下一步 / 待办（解析自 PROJECT.md 的「下一步」节；\`[x]\` 开头跳过；**只取顶层条目**——缩进子项算父项的一部分、不单独占名额（A03）；**取头**——该节混有缩进子项时按列表顺序从上往下取，只有"整节纯编号且递增"才取尾＝最新）`);
  if (stepLines.length) L.push(...stepLines);
  else if (mined) L.push(`- ⚠️ 本页行数已满（上限 ${HANDOFF_MAX_LINES} 行），待办一条也没列出。`);
  else L.push('- 未取到：候选 PROJECT.md 里没有可解析的「下一步 / 待办」小标题（或文件本身不存在）。');
  // A01: an overflowed section used to be silent -- the page simply showed fewer items and the
  // reader could not tell "the list is short" from "the list was cut". Always state the count.
  if (dropped > 0) {
    L.push(`- ⚠️ 因 ${HANDOFF_MAX_LINES} 行预算/名额，本节**省略了 ${dropped} 条**（源计 ${mined} 条）：**完整条目见各源 \`PROJECT.md\` 的「下一步 / 待办」节**（\`handoff.json\` 不设名额、存全文）。`);
  }
  L.push('');
  L.push(...tail);

  // The cap holds by construction (only §三 shrinks). If it ever does not, say so on stderr rather
  // than repeating the old tail-truncation, which cut §五 off the bottom of the page.
  if (L.length > HANDOFF_MAX_LINES) {
    process.stderr.write(`WARN: handoff is ${L.length} lines, cap ${HANDOFF_MAX_LINES}\n`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- main

/**
 * A01 (2026-10-15): which handoff LAYER this run serves -- "one file per handoff party" instead of
 * one mixed page (体系根 + 最多 6 个项目 mixed into a single file).
 * Returns null when --scope was not given, and null is a *deliberate* backward-compatibility
 * promise: with no new flag the old mixed page is produced at the old paths, byte for byte. The
 * documented command (`node …session-registry.mjs --handoff-md`) is quoted in living docs
 * (`templates\dispatch-template.md`、`会话开场提示词.md`、`README.md`), so making layering the
 * default would silently move every handoff those docs point at. Layering is opt-in.
 *   system  => 体系根 only; artifacts stay in --out-dir (which IS the system's own directory)
 *   <name>  => that project only; artifacts go to <project>\<HANDOFF_SCOPE_SUBDIR>\
 *   auto    => derived from cwd; must resolve unambiguously, otherwise we FAIL LOUDLY. Guessing a
 *              layer would hand the successor the wrong todo list, which is exactly what A01 is for.
 * Deliberately resolved from --projects-root (a few readdirs) BEFORE collect(): a typo in --scope
 * should not cost a 30-second archive scan, and it must write nothing.
 */
function resolveHandoffScope(opts) {
  if (opts.scope == null) return null;
  const want = opts.scope.trim();
  const system = { kind: 'system', label: '体系', dir: opts.projectsRoot, outDir: opts.outDir };
  if (want === 'system' || want === '体系') return system;
  const roots = discoverProjectRoots(opts.projectsRoot);
  const proj = (dir) => ({
    kind: 'project',
    label: path.relative(opts.projectsRoot, dir) || path.basename(dir),
    dir,
    outDir: path.join(dir, HANDOFF_SCOPE_SUBDIR),
  });
  const rel = (d) => path.relative(opts.projectsRoot, d);
  if (want === 'auto') {
    const cwd = process.cwd();
    if (normKey(cwd) === normKey(opts.projectsRoot)) return system;
    const inside = roots
      .filter((d) => normKey(cwd) === normKey(d) || normKey(cwd).startsWith(normKey(d) + path.sep))
      .sort((a, b) => normKey(b).length - normKey(a).length);
    if (inside.length) return proj(inside[0]);
    throw new Error(`--scope auto: cwd ${cwd} is neither --projects-root (${opts.projectsRoot}) nor inside a project root of it; pass --scope system | <项目名> explicitly`);
  }
  // A project layer: accept a project name, a relative path, or an absolute path. Case- and
  // separator-insensitive via normKey (Windows paths arrive in both shapes).
  const wantKey = normKey(want);
  const matches = roots.filter((d) => normKey(d) === normKey(path.resolve(opts.projectsRoot, want))
    || normKey(rel(d)) === wantKey || normKey(path.basename(d)) === wantKey);
  if (matches.length === 1) return proj(matches[0]);
  const list = roots.map(rel).join(' | ');
  if (!matches.length) throw new Error(`--scope ${want}: no project root under ${opts.projectsRoot} matches. 候选：${list}`);
  throw new Error(`--scope ${want}: ambiguous — matches ${matches.map(rel).join(' | ')}`);
}

/**
 * The two handoff artifact paths. Split out of parseArgs because the SCOPED default is that layer's
 * own directory. An explicit `--handoff <file>` / `--handoff-md <file>` always wins, so a caller who
 * wants a different location is never overridden by a scope.
 */
function resolveHandoffPaths(opts, scope) {
  const dir = scope ? scope.outDir : opts.outDir;
  if (opts.handoff && !opts.handoffPath) opts.handoffPath = path.join(dir, HANDOFF_JSON_NAME);
  if (opts.handoffMd && !opts.handoffMdPath) opts.handoffMdPath = path.join(dir, HANDOFF_NAME);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP + '\n'); return 0; }

  const scope = resolveHandoffScope(opts);
  resolveHandoffPaths(opts, scope);

  const now = Date.now();
  const ctx = collect(opts);
  // generatedAt = **既有 INDEX.md 的 mtime ＝ 上一次刷新时刻**。它只用来算"刷新间隔"这个诊断值；
  // 文件头部印的"生成于"用**本次渲染时刻**（renderSummary 里的 builtAt），不用它。
  const existingIndexPath = path.join(opts.outDir, INDEX_NAME);
  try {
    ctx.generatedAt = fs.statSync(existingIndexPath).mtimeMs;
    ctx.hadPrevious = true;
  } catch {
    ctx.generatedAt = now; // 第一次生成：还没有旧文件
    ctx.hadPrevious = false;
  }

  if (opts.fileQuery) {
    process.stdout.write(renderFileQuery(ctx.files, opts) + '\n');
    return 0;
  }

  const summary = renderSummary(opts, ctx, now);
  if (opts.summaryOnly) {
    process.stdout.write(summary + '\n');
    return 0;
  }

  // --handoff (v2.7.0): the artifact is the JSON; --handoff-md adds the one-page rendering on top.
  // Both are derived from the same ctx and each builds its own arrays (see the note in renderHandoff).
  // With --dry-run / --json they are PRINTED instead of written, keeping those flags' "write nothing"
  // promise intact: --handoff prints the JSON, and --handoff-md (if given) prints the MD right after.
  const handoffDoc = opts.handoff ? buildHandoffJson(opts, ctx, now, scope) : null;
  const handoffMd = opts.handoffMd ? renderHandoff(opts, ctx, now, scope) : null;
  if (handoffDoc && (opts.dryRun || opts.jsonOut)) {
    process.stdout.write(JSON.stringify(handoffDoc, null, 2) + '\n');
    if (handoffMd) process.stdout.write(handoffMd + '\n');
    return 0;
  }

  const indexMd = renderIndex(opts, ctx, now);
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'session-registry',
    version: TOOL_VERSION,
    snapshot: SNAPSHOT,
    generatedAt: new Date(now).toISOString(),
    window: { days: opts.days, since: new Date(ctx.windowCutoff).toISOString() },
    thresholds: { staleMinutes: opts.staleMinutes, l3Minutes: opts.l3Minutes },
    counts: {
      missions: ctx.rows.length,
      missionsActive: ctx.rows.filter((r) => r.status === 'active').length,
      // 只统计"本来有会话、但存档已不在"的；无 sessionId 的使命另计（它们不是"已删"）
      missionsArchiveGone: ctx.rows.filter((r) => r.sessionId && !r.sessionExists).length,
      missionsNoSession: ctx.rows.filter((r) => !r.sessionId).length,
      missionsUngrouped: ctx.rows.filter((r) => r.groupedBy === 'unknown').length,
      sessions: ctx.allSessions.length,
      sessionFiles: ctx.archiveFiles,
      archiveSuperseded: ctx.archivesSuperseded,
      realSessions: ctx.allSessions.filter((s) => !s.isSubagent).length,
      domainOwners: ctx.domainOwners.count, // 在任声明条数（读不到域名册 = 0，不是错误）
      ...gradeSummary(ctx.files),
    },
    projectRoots: ctx.projectRoots.map((p) => p),
    // 域名册原样转发 + 逐条校验结果（契约 §3）。顶层字段**恒存在**，读不到时 count=0、state 说明原因，
    // 这样 json 的形状不会随文件在不在而变（只增不改）。
    domainOwners: {
      file: ctx.domainOwners.file,
      state: ctx.domainOwners.state,
      fileExisted: ctx.domainOwners.fileExisted,
      readError: ctx.domainOwners.readError,
      parseError: ctx.domainOwners.parseError,
      sourceSchemaVersion: ctx.domainOwners.sourceSchemaVersion,
      sourceUpdatedAt: ctx.domainOwners.sourceUpdatedAt,
      count: ctx.domainOwners.count,
      owners: ctx.domainOwners.owners,
    },
    warnings: ctx.warnings,
    missions: ctx.rows,
    files: ctx.files,
  };

  if (opts.jsonOut) {
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
    return 0;
  }

  if (opts.dryRun) {
    process.stdout.write(indexMd + '\n');
    return 0;
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  // A01: a project layer writes into <project>\_registry\, which may not exist yet. Only the
  // SCOPE-derived directory is created -- an explicit --handoff <file> with a missing parent keeps
  // its pre-2.8.0 behaviour (a FATAL, known debt, not introduced here).
  if (scope) fs.mkdirSync(scope.outDir, { recursive: true });
  const indexPath = path.join(opts.outDir, INDEX_NAME);
  const jsonPath = path.join(opts.outDir, JSON_NAME);
  // 只写 JSON 时，磁盘上那份 HANDOFF.md 不会被本次运行刷新 —— 它是旧快照，必须说出来（见下 written）。
  // With --scope this line must follow the LAYER's md path, or the note would name the wrong file.
  const mdOnDiskPath = opts.handoffMdPath || path.join(opts.outDir, HANDOFF_NAME);
  const notes = [];

  // ---- 防覆盖：三份产物的签名校验**全部前置**，任何一处判不过就整体不写（v2.7.0 起；此前
  //      HANDOFF 的校验排在 INDEX/registry 落盘之后，REFUSED 时 out-dir 已经被改掉一半）。
  if (fs.existsSync(indexPath)) {
    let head = '';
    try { head = fs.readFileSync(indexPath, 'utf8').slice(0, 200); } catch { /* treat as foreign */ }
    if (!head.includes(INDEX_SIGNATURE)) {
      process.stderr.write(`REFUSED: ${indexPath} exists but does not carry this tool's signature; not overwriting.\n`);
      return 1;
    }
  }
  // handoff.json 的签名：能 JSON.parse 且 doc.tool === 'session-registry'。判不过＝外来文件，绝不覆盖。
  if (handoffDoc && fs.existsSync(opts.handoffPath)) {
    let foreign = true;
    try {
      const prev = JSON.parse(fs.readFileSync(opts.handoffPath, 'utf8'));
      foreign = !(prev && typeof prev === 'object' && !Array.isArray(prev) && prev.tool === 'session-registry');
    } catch { /* 读不到或不是 JSON => 外来文件 */ }
    if (foreign) {
      process.stderr.write(`REFUSED: ${opts.handoffPath} exists but is not this tool's handoff JSON (signature: parseable JSON with tool="session-registry"); not overwriting.\n`);
      return 1;
    }
  }
  // MD 沿用首行签名 HANDOFF_SIGNATURE（候选文件位置＝--handoff-md 的路径，默认 <out-dir>\HANDOFF.md）。
  if (handoffMd && fs.existsSync(opts.handoffMdPath)) {
    let head = '';
    try { head = fs.readFileSync(opts.handoffMdPath, 'utf8').slice(0, 200); } catch { /* treat as foreign */ }
    if (!head.includes(HANDOFF_SIGNATURE)) {
      process.stderr.write(`REFUSED: ${opts.handoffMdPath} exists but does not carry this tool's signature; not overwriting.\n`);
      return 1;
    }
  }

  fs.writeFileSync(indexPath, indexMd, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const written = [indexPath, jsonPath];
  if (handoffDoc) {
    fs.writeFileSync(opts.handoffPath, JSON.stringify(handoffDoc, null, 2) + '\n', 'utf8');
    written.push(opts.handoffPath);
  }
  if (handoffMd) {
    fs.writeFileSync(opts.handoffMdPath, handoffMd, 'utf8');
    written.push(opts.handoffMdPath);
  }
  // 本次只写了 JSON、磁盘上却躺着一份 HANDOFF.md ⇒ 明说那句"旧快照"，免得有人读到过期 MD 而不自知。
  if (handoffDoc && !handoffMd && fs.existsSync(mdOnDiskPath)) {
    const note = `NOTE: 本次只写了 handoff.json，未刷新磁盘上的 ${mdOnDiskPath} —— 那份 HANDOFF.md 是**旧快照**，新鲜真值见 ${opts.handoffPath}；要重渲染 MD 就加 --handoff-md。`;
    notes.push(note);
    process.stderr.write(note + '\n');
  }

  // 落盘后给调用方一份**刷新后**的摘要（窗口年龄按"现在"算）。
  // 注意**不要**把 ctx.generatedAt 改成新文件的 mtime：它代表"上一份的生成时刻"，头部那行刷新间隔要用它；
  // 本份的生成时刻由 renderSummary 里的 builtAt 决定。
  const writtenSummary = renderSummary(opts, ctx, Date.now());

  process.stdout.write(JSON.stringify({
    tool: 'session-registry', version: TOOL_VERSION, snapshot: SNAPSHOT,
    days: opts.days, written,
    // A01: report the layer only when one was asked for -- an unscoped receipt keeps its old keys.
    ...(scope ? { scope: { kind: scope.kind, label: scope.label, dir: scope.dir, outDir: scope.outDir } } : {}),
    counts: doc.counts, warnings: doc.warnings, notes,
    summary: writtenSummary,
  }, null, 2) + '\n');
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`FATAL: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
}
