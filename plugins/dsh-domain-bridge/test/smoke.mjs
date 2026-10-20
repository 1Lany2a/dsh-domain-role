/**
 * dsh-domain-bridge smoke test (v0.6.1)
 *
 * What it guards, in one sentence: EVERY reachable branch of ALL 11 tools must return a value the
 * host can accept as LOSSLESS JSON - i.e. no `undefined` / function / symbol / bigint / NaN /
 * +-Infinity / -0 / Date / Map / Set / typed array / circular reference anywhere in the tree, and
 * `JSON.parse(JSON.stringify(v))` must deep-equal v.
 *
 * Why this shape: the real-machine failure (2026-10-11, v0.3.0) was
 *   tool "list_domain_owners" returned invalid output: value is not lossless JSON
 * caused by one top-level `hint: undefined`; the error never names the field, and local
 * JSON.stringify looked perfectly healthy. Asserting one field would not have caught it, so the
 * check below deep-scans every tool result instead of spot-checking keys.
 *
 * Also frozen here (regression): the send_to_domain envelope text + the v4 message shape, the
 * list_domain_sessions top-level key set, the 11 tool names, and VERSION == package.json version.
 *
 * v0.3.2 adds section 7: the whole workspace-attach + pin ladder of create_domain_session,
 * driven by a FAKE registry and a create() spy -
 *   1 hit => {workspaceId} request (never cwd), pinSession called once
 *   2 miss => v0.3.1 {cwd} request, pin still attempted
 *   3 workspaceId create fails => auto-retry the {cwd} request ONCE, created:true
 *   4 both attempts fail => created:false / reason:'create-failed'
 *   5 attach failure after a successful create => NEVER rebuilt, created:true, reported unattached
 *   6 pinSession throws => created:true + pinned.ok:false
 *   7 pin:false => pinSession NOT called
 *   8 no registry => request byte-identical to v0.3.1
 *   plus the lookup fallbacks (list(), resolve throws, no pinSession, ctx.get throws).
 * Pure local: fake ctx, temp fixture files, no real session, no real pin, no registry touched.
 *
 * v0.3.6 adds section 10 (11 cases): the F1 ownership gate of create_domain_session
 * (refuse / allowExistingOwner / claim / free-domain regression / dry-run refusal, and both
 * `existingOwner.inArchive` shapes) and the F2 stand-down notice of claim_domain(force:true)
 * (inject delivered / note-only when the predecessor is offline / failed when inject throws),
 * asserting every time that the host `create` was or was not called.
 *
 * v0.4.0 adds section 11: the domain-level「已暂停」policy axis (two axes + lifecycle, scope=domain).
 * Every case runs against a per-mount TEMP state dir (`stateDir`), so the plugin's real state/
 * directory is never touched by this suite.
 *   1 pause writes the state record and the receipt carries the derived state (谁在何时按下)
 *   2 send_to_domain on a paused domain => NOT delivered, persisted to the queue, reason
 *     'domain-paused' / queued:true, receipt names the pauser + the withdraw id (never a vague
 *     'unreachable', never a stand-in), and a non-paused domain stays byte-identical (regression)
 *   3 create_domain_session on a paused domain => refused, host create NEVER called (dryRun too)
 *   4 wake on a paused domain => blocked, resume NEVER called; force:true => resumed + delivered
 *   5 claim_domain / release_domain stay ALLOWED while paused, but the receipt says "still paused"
 *     (release also writes the lifecycle tombstone => derived state 已终结)
 *   6 withdraw_domain_message: own pending => withdrawn; someone else's => not-owner (force => ok);
 *     already delivered => not-pending; unknown id => not-found
 *   7 resume replays the queue: owner online => delivered (v4 shape + original mode preserved);
 *     owner offline => STILL PENDING and resume is NEVER called (the {{model}} crash pitfall)
 *   8 list_domain_sessions / list_domain_owners show all five derived states (4 on live rows +
 *     the 已终结 tombstone section + the five-name legend)
 *   9 paused+force is the ONLY override, and it is reported as such
 *
 * v0.4.1 adds section 12 (the {{model}} wake fix). Every case drives the REAL resume call through a
 * fake agents service that - like the host - actually invokes `request.setup(agentCtx, agent)`:
 *   1 provider/model comes from ctx.agentDefaultModel (source ①), setup installs BOTH host
 *     waterfalls AND mounts the session's agentPreset (resolve -> mount)
 *   2 ...or from the archived last `request/header` config (source ②), reported as 'session-header'
 *   3 an unreadable/absent archive degrades to 'none' and NEVER guesses a provider/model
 *   4 both sources empty + a turn-running mode => REFUSED, resume is NEVER called
 *     (reason 'no-wake-wiring'), while probe and mode:'inject' are still allowed, and force does
 *     NOT bypass this safety gate
 *   5 a throwing setup degrades to 'failed' + setupError while the resume itself still succeeds
 *   6 the legacy sessionController.resume entry cannot carry wiring => refused too unless the
 *     delivery does not run a turn
 *   7 the F2 stand-down notice still reaches a predecessor that holds a PAUSED domain (it never
 *     goes through the pause queue)
 *
 * v0.6.1 adds section 15 (the first real-machine defects + the global-half tool). The host facts the
 * cases are built on come straight from the shipped asar (dsh 0.2.1-rc.2):
 *   a `sessionController.modelCatalog()` is ASYNC (`lib/index.js:3121` -> `lib/types/catalog.js:10`),
 *     so a fake that returns a sync value can never catch the v0.6.0 "forgot await" bug - the fakes
 *     are async now, and one case returns a bare Promise on purpose
 *   b an empty/unrecognized `groups` is NOT a catalog => fall back to `llm.listProviders()` +
 *     `listModels(provider)`; when BOTH are empty the receipt is {ok:true, source:'empty',
 *     groups:[], rawKeys:[...], note:'catalog-empty'} - never a fake success, never ok:false
 *   c `listModels` may answer with `{id,name,reasoning?}` rows or bare strings (both normalized)
 *   d the session half uses the REAL interfaces: ① `sessionController.projections({sessionId},
 *     signal)` (wire view `{lastUsed, next}`, archived sessions included), ② the live Session
 *     OBJECT + `sessionProjections.stateOf(session,'modelSelection')` (host state
 *     `{lastUsed, pending}`) - v0.6.0 passed the id STRING and therefore always threw
 *   e when neither reader works the receipt carries `sessionRead:{ok:false,reason,tried,failures}`
 *     instead of silently omitting `session`
 *   f `set_default_model` writes the GLOBAL default and NEVER restores (the opposite of set_model);
 *     a silent no-op host (no deployment config entry / no configEditor) is reported as
 *     verified:false / applied:'not-observed' rather than a fake ok
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const mod = await import(new URL('../lib/bridge.js', import.meta.url).href)

const EXPECTED_TOOLS = [
  'claim_domain',
  'create_domain_session',
  'list_domain_owners',
  'list_domain_sessions',
  'list_models',
  'release_domain',
  'send_to_domain',
  'set_default_model',
  'set_domain_state',
  'set_model',
  'withdraw_domain_message',
]

// v0.3.0 top-level shape of list_domain_sessions - must not change (except undefined keys going away).
// v0.4.0 adds exactly one key: `domainState` (scope + the five-name legend + the 已终结 tombstones).
const LIST_SESSIONS_KEYS = [
  'plugin',
  'self',
  'onlineTopLevelCount',
  'onlineTopLevel',
  'declarationsFile',
  'declarationsUpdatedAt',
  'declarationsError',
  'declarationCount',
  'declarations',
  'domainState',
  'declarationsHint',
  'index',
]

const ID = {
  A: 'session-11111111-1111-4111-8111-111111111111',
  B: 'session-22222222-2222-4222-8222-222222222222',
  C: 'session-33333333-3333-4333-8333-333333333333',
  S: 'session-99999999-9999-4999-8999-999999999999',
  X1: 'session-aaa11111-1111-4111-8111-aaaaaaaaaaaa',
  X2: 'session-aaa22222-2222-4222-8222-aaaaaaaaaaaa',
}

/** 短号口径（与 bridge.js 的 shortId 一致）：大白话回执里写的是短号，不是完整 id。 */
const SHORT = { A: 'sess-11111111', B: 'sess-22222222', C: 'sess-33333333', S: 'sess-99999999' }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-bridge-smoke-'))
/** v0.6.0: isolate the optional `<home>/config.json` (the only layer mount() cannot pass explicitly,
 * because `domainSessionModel` lives there). All paths the cases care about are still per-mount. */
const SUITE_HOME = path.join(root, 'home')
process.env.DSH_DOMAIN_BRIDGE_HOME = SUITE_HOME
/**
 * Fixture project root. Fake session cwds live under the temp root so the suite never depends on a
 * machine-specific absolute path; only the LAST segment matters (the plugin derives the project name
 * from `path.basename(cwd).toLowerCase()`), so `misas` still yields the `misas` project used below.
 */
const FIXTURE_PROJECTS = path.join(root, 'projects')
const FIXTURE_CWD = path.join(FIXTURE_PROJECTS, 'misas')
const indexFile = path.join(root, 'registry.json')
const domainsFile = path.join(root, 'domains.json')

fs.writeFileSync(
  indexFile,
  JSON.stringify({
    generatedAt: '2026-10-11T00:00:00.000Z',
    missions: [
      { sessionId: ID.A, domain: 'asr', number: 'S01', status: 'active', feature: 'asr work' },
      { sessionId: ID.B, domain: 'gui', number: 'S02', status: 'active', feature: 'gui work' },
    ],
  }),
  'utf8',
)

const stats = { cases: 0, nodes: 0, roundTrips: 0, branchChecks: 0 }

function ok(cond, message) {
  stats.branchChecks++
  assert.ok(cond, message)
}

function eq(actual, expected, message) {
  stats.branchChecks++
  assert.deepStrictEqual(actual, expected, message)
}

/** Deep scan: no undefined / function / symbol / bigint / exotic container / non-finite / -0 / cycle. */
function deepScan(value, label, trail, ancestors) {
  const at = trail || '$'
  const stack = ancestors || []
  stats.nodes++
  const type = typeof value
  ok(type !== 'undefined', `${label}: ${at} 是 undefined（宿主会整次拒收 invalid output）`)
  ok(
    type !== 'function' && type !== 'symbol' && type !== 'bigint',
    `${label}: ${at} 是 ${type}（JSON 无损化不了）`,
  )
  ok(
    !(value instanceof Map) &&
      !(value instanceof Set) &&
      !(value instanceof Date) &&
      !ArrayBuffer.isView(value) &&
      !(value instanceof Error),
    `${label}: ${at} 是 JSON 不可逆容器/对象`,
  )
  if (type === 'number') {
    ok(
      Number.isFinite(value) && !Object.is(value, -0),
      `${label}: ${at} 是非有限数或 -0（${Object.is(value, -0) ? '-0' : String(value)}）`,
    )
  }
  if (value !== null && type === 'object') {
    ok(!stack.includes(value), `${label}: ${at} 命中循环引用`)
    ok(
      Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
      `${label}: ${at} 原型不是普通对象/数组（JSON 往返会变形）`,
    )
    stack.push(value)
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) deepScan(value[i], label, `${at}[${i}]`, stack)
    } else {
      for (const key of Object.keys(value)) deepScan(value[key], label, `${at}.${key}`, stack)
    }
    stack.pop()
  }
}

/** The generic regression assertion: deep scan + exact JSON round trip. */
function assertLossless(value, label) {
  deepScan(value, label, '$', [])
  stats.roundTrips++
  let round
  try {
    round = JSON.parse(JSON.stringify(value))
  } catch (error) {
    assert.fail(`${label}: JSON.stringify 抛错（${error?.message}）`)
  }
  assert.deepStrictEqual(round, value, `${label}: JSON.parse(JSON.stringify(v)) 与原值不深等 = 往返有损`)
  return value
}

// ------------------------------------------------------------------ fakes

function makeAgent(id, options = {}) {
  const sent = []
  const header = {
    cwd: options.cwd === undefined ? FIXTURE_CWD : options.cwd,
    parentSession: options.parentSession,
    agentPreset: options.agentPreset === undefined ? 'preset-x' : options.agentPreset,
    origin: options.origin === undefined ? 'human' : options.origin,
    isSeeded: options.isSeeded === undefined ? false : options.isSeeded,
  }
  const agent = { id, session: { header }, sent }
  const methods = options.methods === undefined ? ['followup', 'steer', 'inject'] : options.methods
  for (const name of methods) {
    agent[name] = (payload) => {
      sent.push({ mode: name, payload })
      if (options.throwOn === name) throw new Error('smoke: followup exploded')
    }
  }
  return agent
}

function mount(options = {}) {
  const registered = new Map()
  const agents = options.agents || []
  // v0.3.4: a full agents-service override (needed for the wake tests: `list()` must change
  // after `resume` makes a session live).
  const agentsService = options.agentsService || {
    list: () => agents,
    get: (id) => (options.get ? options.get(id) : agents.find((agent) => agent.id === id)),
  }
  const ctx = {
    tools: { register: (definition) => registered.set(definition.name, definition) },
    agents: agentsService,
  }
  if ('controller' in options) ctx.sessionController = options.controller
  // v0.3.3: the two optional services (same contract as sessionController/workspaceRegistry:
  // absent => honest downgrade). `*Via:'get'` exercises the ctx.get('name') accessor path.
  const viaGet = new Map()
  if ('permissionPresets' in options) {
    if (options.permissionPresetsVia === 'get') viaGet.set('permissionPresets', options.permissionPresets)
    else ctx.permissionPresets = options.permissionPresets
  }
  if ('sessionTitle' in options) {
    if (options.sessionTitleVia === 'get') viaGet.set('sessionTitle', options.sessionTitle)
    else ctx.sessionTitle = options.sessionTitle
  }
  // v0.4.1: the three optional services the wake wiring reads (exactly the same contract:
  // absent => the wiring degrades to 'none', which must refuse a turn-running wake instead of
  // bare-resuming). `*Via:'get'` exercises the ctx.get('name') accessor path.
  for (const name of ['agentDefaultModel', 'sessionQuery', 'agentPresets', 'sessionProjections', 'llm']) {
    if (!(name in options)) continue
    if (options[`${name}Via`] === 'get') viaGet.set(name, options[name])
    else ctx[name] = options[name]
  }
  if (viaGet.size > 0) {
    const prior = ctx.get
    ctx.get = (name) => (viaGet.has(name) ? viaGet.get(name) : typeof prior === 'function' ? prior(name) : undefined)
  }
  if ('registry' in options) {
    if (options.registryVia === 'get') {
      ctx.get = (name) => (name === 'workspaceRegistry' ? options.registry : undefined)
    } else if (options.registryVia === 'get-throws') {
      ctx.get = () => {
        throw new Error('smoke: ctx.get exploded')
      }
      ctx.workspaceRegistry = options.registry
    } else {
      ctx.workspaceRegistry = options.registry
    }
  }
  mod.default.apply(ctx, {
    indexFile: options.indexFile === undefined ? indexFile : options.indexFile,
    domainsFile: options.domainsFile === undefined ? domainsFile : options.domainsFile,
    // v0.4.0: the policy axis (paused) + the persisted queue live under `stateDir`. Every mount gets
    // its OWN temp state dir unless the case asks for a shared one - the suite must never touch the
    // plugin's real state/ directory.
    stateDir: options.stateDir === undefined ? path.join(root, `state-${++stateSeq}`) : options.stateDir,
    // portable: the external CLI reference only affects prose in tool descriptions/hints. Pinned to a
    // temp fixture so the suite never reads the machine's <home>/config.json.
    ownerCli: options.ownerCli === undefined ? path.join(root, 'tools', 'domain-owner.mjs') : options.ownerCli,
    // v0.6.0: deployment-config layer of `domainSessionModel` (undefined = fall through to config.json).
    ...(options.domainSessionModel !== undefined ? { domainSessionModel: options.domainSessionModel } : {}),
  })
  eq([...registered.keys()].sort(), EXPECTED_TOOLS, `apply 后注册的工具集不是 11 个: ${[...registered.keys()]}`)
  return { ctx, registered }
}

async function call(m, toolName, args, exec, label) {
  stats.cases++
  const definition = m.registered.get(toolName)
  ok(Boolean(definition), `${label}: 工具 ${toolName} 没注册`)
  const out = await definition.execute(args ?? {}, exec ?? {})
  assertLossless(out, label)
  return out
}

// ------------------------------------------------------------------ fixture books

let bookSeq = 0
/** v0.4.0: monotonic counter for the per-mount temp state dirs (see mount()). */
let stateSeq = 0
/** v0.4.0: a shared state dir, for cases that must span two mounts (pause here => send there). */
const sharedStateDir = path.join(root, 'state-shared')

function owner(project, domain, sessionId, extra) {
  return { project, domain, sessionId, since: '2026-10-10T00:00:00.000Z', by: null, note: '', ...(extra || {}) }
}

function bookFile(name, owners, raw) {
  const dir = path.join(root, `book-${++bookSeq}-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'domains.json')
  if (raw !== undefined) fs.writeFileSync(file, raw, 'utf8')
  else if (owners)
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, updatedAt: '2026-10-11T00:00:00.000Z', owners }, null, 2) + '\n',
      'utf8',
    )
  return file
}

/** A book whose write MUST fail: `<file>.tmp` already exists as a directory. */
function blockedBook(name) {
  const dir = path.join(root, `blocked-${++bookSeq}-${name}`)
  fs.mkdirSync(path.join(dir, 'domains.json.tmp'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'domains.json.lock'), { recursive: true })
  return path.join(dir, 'domains.json')
}

/** v0.4.2（F1）：写一份自定义体系索引（只用来给在线会话打**域标注**）。 */
function indexFileWith(name, missions) {
  const dir = path.join(root, `index-${++bookSeq}-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'registry.json')
  fs.writeFileSync(
    file,
    JSON.stringify({ generatedAt: '2026-10-14T00:00:00.000Z', missions }, null, 2) + '\n',
    'utf8',
  )
  return file
}

// The caller session: cwd basename is the project short name (same rule as domain-owner.mjs).
const sender = makeAgent(ID.S, { cwd: FIXTURE_CWD })

const realWarn = console.warn
console.warn = () => {}

// ------------------------------------------------------------------ 0. apply() never throws

for (const cfg of [undefined, null]) {
  const registered = new Map()
  const ctx = { tools: { register: (d) => registered.set(d.name, d) }, agents: { list: () => [], get: () => undefined } }
  mod.default.apply(ctx, cfg)
  eq(registered.size, 11, `apply(ctx, ${String(cfg)}) 后工具数不是 11`)
  eq(mod.default.name, 'domain-bridge', '插件名变了')
}

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const versionProbe = await call(mount(), 'list_domain_owners', {}, {}, 'version-probe')
eq(versionProbe.plugin.version, pkg.version, `VERSION(${versionProbe.plugin.version}) 与 package.json(${pkg.version}) 不一致`)
eq(pkg.version, '0.8.3', `package.json 版本不是 0.7.0（实际 ${pkg.version}）`)

// ------------------------------------------------------------------ 1. list_domain_sessions

{
  const agentA = makeAgent(ID.A)
  const agentB = makeAgent(ID.B)
  const sub = makeAgent(ID.C, { parentSession: ID.B })
  const book = bookFile('list-sessions', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const out = await call(
    mount({ agents: [agentA, agentB, sub], domainsFile: book }),
    'list_domain_sessions',
    {},
    { agent: agentA },
    'list_domain_sessions/normal',
  )
  eq(Object.keys(out).sort(), [...LIST_SESSIONS_KEYS].sort(), 'list_domain_sessions 顶层键集变了')
  eq(out.onlineTopLevelCount, 2, '子代理/非顶层会话没被过滤')
  eq(out.self.onDuty, true, 'self.onDuty 应为 true')
  eq(out.self.dutyDomainKey, 'misas:asr', 'self.dutyDomainKey 不对')
  eq(out.declarations[0].online, true, '声明会话在线判定不对')
  eq(out.index.error, null, 'index.error 应为 null')
}

{
  const out = await call(
    mount({ agents: [], indexFile: path.join(root, 'no-such-index.json'), domainsFile: path.join(root, 'no-such-book.json') }),
    'list_domain_sessions',
    {},
    { agent: sender },
    'list_domain_sessions/files-missing',
  )
  ok(typeof out.index.error === 'string', '索引读不到时应回报 error 字符串')
  // A missing declaration book is the normal state, not an error: it must stay error:null.
  eq(out.declarationsError, null, '声明文件不存在不应算错误')
  eq(out.declarationCount, 0, '声明文件不存在应为 0 条')
}

{
  // describe() catch branch + every JSON-hostile value forced through a REAL tool result.
  const cyc = { name: 'cycle' }
  cyc.self = cyc
  const exotic = makeAgent(ID.A, {
    cwd: new Date('2026-10-11T00:00:00.000Z'),
    agentPreset: new Map([['k', undefined]]),
    origin: cyc,
    isSeeded: new Set(['a', undefined]),
  })
  const nanAgent = makeAgent(ID.B, { cwd: -0, agentPreset: Infinity, isSeeded: 10n, origin: () => {} })
  const nan2 = makeAgent(ID.C, { cwd: NaN, agentPreset: 'p' })
  const out = await call(
    mount({ agents: [exotic, nanAgent, nan2] }),
    'list_domain_sessions',
    {},
    { agent: sender },
    'list_domain_sessions/hostile-values',
  )
  const row = (id) => out.onlineTopLevel.find((item) => item.id === id)
  eq(row(ID.A).cwd, '2026-10-11T00:00:00.000Z', 'Date 没归一成 ISO 字符串')
  eq(row(ID.A).preset, { k: null }, 'Map 没归一成普通对象（值 undefined → null）')
  eq(row(ID.A).origin, { name: 'cycle', self: null }, '循环引用没归一成 null')
  eq(row(ID.A).seeded, ['a', null], 'Set 没归一成数组')
  eq(row(ID.B).cwd, 0, '-0 没归一成 0')
  eq(row(ID.B).preset, null, 'Infinity 没归一成 null')
  eq(row(ID.B).seeded, '10', 'bigint 没归一成十进制字符串')
  ok(!('origin' in row(ID.B)), 'function 值应被删键')
  eq(row(ID.C).cwd, null, 'NaN 没归一成 null')
}

{
  // describe() catch path: a header that throws must degrade, not blow up the tool.
  const broken = { id: ID.A, get session() { throw new Error('smoke: header exploded') } }
  const out = await call(
    mount({ agents: [broken] }),
    'list_domain_sessions',
    {},
    { agent: broken },
    'list_domain_sessions/describe-throws',
  )
  eq(out.onlineTopLevelCount, 0, 'header 抛错的会话不应算作在线顶层')
  ok(typeof out.self.error === 'string', 'describe 兜底应回报 error 字符串')
}

// ------------------------------------------------------------------ 2. list_domain_owners

{
  const out = await call(
    mount({ agents: [], domainsFile: path.join(root, 'absent-book.json') }),
    'list_domain_owners',
    {},
    { agent: sender },
    'list_domain_owners/file-missing',
  )
  eq(out.fileExisted, false, 'fileExisted 应为 false')
  ok(typeof out.hint === 'string', '文件不存在时应给 hint 字符串')
  eq(out.error, null, '文件不存在不是错误')
}

{
  // THE v0.3.0 bug: file exists, no error -> hint used to be `undefined` => whole call rejected.
  const book = bookFile('list-owners-ok', {
    'misas:asr': owner('misas', 'asr', ID.A),
    'other:gui': owner('other', 'gui', ID.B),
  })
  const out = await call(mount({ agents: [makeAgent(ID.A)], domainsFile: book }), 'list_domain_owners', {}, { agent: sender }, 'list_domain_owners/normal')
  eq(out.count, 2, '声明条数不对')
  ok(!('hint' in out), '正常路径不应再有 hint 键（v0.3.0 的 undefined 就是这里）')
  eq(out.declarations.map((d) => d.online), [true, false], '在线标记不对')
}

{
  const out = await call(
    mount({ domainsFile: bookFile('list-owners-garbled', null, 'not json {') }),
    'list_domain_owners',
    {},
    { agent: sender },
    'list_domain_owners/garbled',
  )
  ok(typeof out.error === 'string', '坏文件应回报 error')
  ok(typeof out.hint === 'string', '坏文件应给降级 hint')
}

{
  const out = await call(
    mount({ domainsFile: root }),
    'list_domain_owners',
    {},
    { agent: sender },
    'list_domain_owners/read-error',
  )
  ok(typeof out.error === 'string', '读不动（目录）应回报 error')
}

// ------------------------------------------------------------------ 3. send_to_domain

const resolutionRows = [makeAgent(ID.A), makeAgent(ID.B)]
const sendExec = { agent: sender }

{
  const out = await call(mount({ agents: resolutionRows }), 'send_to_domain', { target: '   ', message: 'x' }, sendExec, 'send_to_domain/missing-target')
  eq(out.delivered, false, '缺 target 不该投递')
  eq(out.reason, 'missing-target', 'reason 应为 missing-target')
  ok(typeof out.hint === 'string', 'missing-target 必须有 hint（v0.3.0 这里是 undefined ⇒ 整次拒收）')
}

{
  const rows = [makeAgent(ID.X1), makeAgent(ID.X2)]
  const out = await call(mount({ agents: rows }), 'send_to_domain', { target: 'session-aaa', message: 'x' }, sendExec, 'send_to_domain/ambiguous-session-id')
  eq(out.reason, 'ambiguous-session-id', 'reason 应为 ambiguous-session-id')
  ok(typeof out.hint === 'string', 'ambiguous-session-id 必须有 hint')
  eq(out.onlineTopLevel.length, 2, '应回报两个候选')
}

{
  const book = bookFile('send-owner-offline', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const out = await call(mount({ agents: [makeAgent(ID.A)], domainsFile: book }), 'send_to_domain', { target: 'asr', message: 'x' }, sendExec, 'send_to_domain/declared-owner-offline')
  eq(out.reason, 'declared-owner-offline', 'reason 应为 declared-owner-offline')
  eq(out.declaredOwner.sessionId, ID.B, 'declaredOwner 不对')
  eq(out.otherOnlineWithIndexLabel.length, 1, '应回报索引标注为该域且在线的人')
}

{
  const book = bookFile('send-ambiguous-decl', { 'misas:asr': owner('misas', 'asr', ID.A), 'other:asr': owner('other', 'asr', ID.B) })
  const out = await call(mount({ agents: resolutionRows, domainsFile: book }), 'send_to_domain', { target: 'asr', message: 'x' }, sendExec, 'send_to_domain/ambiguous-declarations')
  eq(out.reason, 'ambiguous-declarations', 'reason 应为 ambiguous-declarations')
  eq(out.declarations.length, 2, '应回报两条同名声明')
}

{
  const out = await call(mount({ agents: resolutionRows }), 'send_to_domain', { target: 'asr', message: 'hello', replyTo: 'target-key', dryRun: true }, sendExec, 'send_to_domain/dry-run-index-label')
  eq(out.dryRun, true, 'dryRun 应回显')
  eq(out.matchedBy, 'index-label', 'matchedBy 应为 index-label')
  eq(out.wouldDeliverTo.id, ID.A, 'dryRun 目标不对')
  ok(!('delivered' in out) || out.delivered === false, 'dryRun 不该真的投递')
}

{
  const target = makeAgent(ID.A)
  const out = await call(mount({ agents: [target] }), 'send_to_domain', { target: 'asr', message: 'hello', replyTo: 'target-key' }, sendExec, 'send_to_domain/deliver-followup')
  eq(out.delivered, true, '应投递成功')
  eq(out.mode, 'followup', 'mode 应为 followup')
  eq(target.sent.length, 1, 'followup 应被调用一次')
  const envelope = target.sent[0].payload
  eq(envelope.role, 'user', 'v4 消息 role 应为 user')
  eq(Object.keys(envelope).sort(), ['content', 'id', 'role', 'source'], 'v4 消息形状变了')
  eq(
    envelope.content,
    [
      {
        type: 'text',
        text:
          `【域间消息 · 来自 ${ID.S}】\n` +
          'hello\n' +
          '\n' +
          '（投递方式：dsh-domain-bridge followup｜回复请用 send_to_domain，target=target-key）',
      },
    ],
    'envelope 与 v0.3.0 不再逐字一致',
  )
  eq(envelope.source, { kind: 'dsh-domain-bridge', senderSessionId: ID.S }, 'source 形状变了')
  ok(/^[0-9a-f-]{36}$/.test(envelope.id), '消息 id 应是 uuid')
}

for (const mode of ['steer', 'inject']) {
  const target = makeAgent(ID.A)
  const out = await call(mount({ agents: [target] }), 'send_to_domain', { target: 'asr', message: 'm', replyTo: 'k', mode }, sendExec, `send_to_domain/deliver-${mode}`)
  eq(out.delivered, true, `${mode} 应投递成功`)
  eq(target.sent[0].mode, mode, `${mode} 调错了 Agent 方法`)
}

{
  const out = await call(mount({ agents: resolutionRows }), 'send_to_domain', { target: 'no-such-domain', message: 'x' }, sendExec, 'send_to_domain/unreachable')
  eq(out.reason, 'unreachable', 'reason 应为 unreachable')
  ok(typeof out.hint === 'string', 'unreachable 必须有 hint')
}

{
  const multi = [makeAgent(ID.A), makeAgent(ID.X2, { cwd: FIXTURE_CWD })]
  // Two live rows carrying the SAME index label: force both to match 'asr' via the index.
  const book = bookFile('send-multi-online', null, undefined)
  const index = path.join(root, 'index-multi.json')
  fs.writeFileSync(
    index,
    JSON.stringify({ generatedAt: null, missions: [{ sessionId: ID.A, domain: 'asr' }, { sessionId: ID.X2, domain: 'asr' }] }),
    'utf8',
  )
  const out = await call(mount({ agents: multi, indexFile: index, domainsFile: book }), 'send_to_domain', { target: 'asr', message: 'x' }, sendExec, 'send_to_domain/multiple-online-for-domain')
  eq(out.reason, 'multiple-online-for-domain', 'reason 应为 multiple-online-for-domain')
  ok(typeof out.hint === 'string', 'multiple-online-for-domain 必须有 hint')
}

{
  const target = makeAgent(ID.A)
  const out = await call(mount({ agents: [target], get: () => undefined }), 'send_to_domain', { target: 'asr', message: 'x' }, sendExec, 'send_to_domain/unreachable-race')
  eq(out.reason, 'unreachable-race', 'reason 应为 unreachable-race')
  ok(typeof out.hint === 'string', 'unreachable-race 必须有 hint')
}

for (const [methods, expected, mode] of [
  [['followup', 'inject'], 'steer-unsupported', 'steer'],
  [['followup', 'steer'], 'inject-unsupported', 'inject'],
  [[], 'followup-unsupported', 'followup'],
]) {
  const target = makeAgent(ID.A, { methods })
  const out = await call(mount({ agents: [target] }), 'send_to_domain', { target: 'asr', message: 'x', mode }, sendExec, `send_to_domain/${expected}`)
  eq(out.reason, expected, `reason 应为 ${expected}`)
}

// ------------------------------------------------------------------ 4. claim_domain

{
  const out = await call(mount(), 'claim_domain', { domain: 'asr' }, {}, 'claim_domain/no-self-session')
  eq(out.reason, 'no-self-session', 'reason 应为 no-self-session')
  ok(typeof out.hint === 'string', 'no-self-session 必须有 hint')
}

{
  const out = await call(mount(), 'claim_domain', { domain: 'a:b:c' }, { agent: sender }, 'claim_domain/invalid-domain')
  ok(typeof out.reason === 'string' && out.reason.includes('冒号'), 'reason 应是冒号校验错误')
}

{
  const out = await call(mount(), 'claim_domain', { domain: 'asr' }, { agent: makeAgent(ID.A, { cwd: null }) }, 'claim_domain/project-unknown')
  eq(out.reason, 'project-unknown', 'reason 应为 project-unknown')
  ok(typeof out.hint === 'string', 'project-unknown 必须有 hint')
}

{
  const out = await call(mount({ domainsFile: bookFile('claim-garbled', null, '{{') }), 'claim_domain', { domain: 'asr', project: 'misas' }, { agent: sender }, 'claim_domain/unreadable')
  eq(out.outcome, 'aborted', 'outcome 应为 aborted')
  eq(out.reason, 'declarations-file-unreadable', 'reason 应为 declarations-file-unreadable')
}

{
  const book = bookFile('claim-new')
  const m = mount({ domainsFile: book })
  const out = await call(m, 'claim_domain', { domain: 'asr' }, { agent: sender }, 'claim_domain/created')
  eq(out.outcome, 'created', 'outcome 应为 created')
  eq(out.key, 'misas:asr', 'key 应为 misas:asr（cwd 目录名小写）')
  eq(out.hint, '已认领该域：从现在起你是在任负责人（同人重复认领＝刷新在岗起算时间）。', 'created 的 hint 变了')
  eq(JSON.parse(fs.readFileSync(book, 'utf8')).owners['misas:asr'].sessionId, ID.S, '域名册没写进本次会话')

  const again = await call(m, 'claim_domain', { domain: 'asr' }, { agent: sender }, 'claim_domain/refreshed')
  eq(again.outcome, 'refreshed', '同人重复认领应为 refreshed')
  eq(again.wrote, true, 'refresh 也应写入')
}

{
  const book = bookFile('claim-conflict', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const out = await call(mount({ agents: [makeAgent(ID.B)], domainsFile: book }), 'claim_domain', { domain: 'asr' }, { agent: sender }, 'claim_domain/conflict')
  eq(out.outcome, 'conflict', '别人持有且无 force 应 conflict')
  eq(out.wrote, false, 'conflict 不该写')
  eq(out.holder.sessionId, ID.B, 'holder 不对')
  eq(out.holder.online, true, 'holder.online 不对')
}

{
  const book = bookFile('claim-handover', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const out = await call(mount({ domainsFile: book }), 'claim_domain', { domain: 'asr', force: true, note: 'hand me' }, { agent: sender }, 'claim_domain/handover')
  eq(out.outcome, 'handover', 'force 应交接')
  eq(out.handoverFrom, ID.B, 'handoverFrom 不对')
  // v0.3.6 F2: 前任离线（这里 agents 列表为空）⇒ 停机通知没送达，note 里追加一行留痕。
  ok(out.owner.note.startsWith(`接手自 ${ID.B}；hand me`), `note 里的交接留痕被改坏了: ${out.owner.note}`)
  ok(out.owner.note.includes('[停机通知未送达]'), 'note 里应追加停机通知留痕（v0.3.6 F2）')
  ok(out.hint.includes('强制交接'), 'handover 的 hint 不对')
}

{
  const out = await call(mount({ domainsFile: blockedBook('claim') }), 'claim_domain', { domain: 'asr' }, { agent: sender }, 'claim_domain/write-failed')
  eq(out.outcome, 'write-failed', '写入失败应 write-failed')
  ok(typeof out.error === 'string' && out.error.length > 0, 'write-failed 应带 error 文本')
}

// ------------------------------------------------------------------ 5. release_domain

{
  const out = await call(mount(), 'release_domain', { domain: 'asr' }, {}, 'release_domain/no-self-session')
  eq(out.reason, 'no-self-session', 'reason 应为 no-self-session')
}

{
  const out = await call(mount(), 'release_domain', { domain: '' }, { agent: sender }, 'release_domain/invalid-domain')
  ok(typeof out.reason === 'string' && out.reason.includes('不能为空'), 'reason 应是空域错误')
}

{
  const out = await call(mount({ domainsFile: bookFile('release-garbled', null, '#') }), 'release_domain', { domain: 'asr' }, { agent: sender }, 'release_domain/unreadable')
  eq(out.outcome, 'aborted', 'outcome 应为 aborted')
}

{
  const out = await call(mount({ domainsFile: bookFile('release-absent', { 'other:gui': owner('other', 'gui', ID.B) }) }), 'release_domain', { domain: 'asr' }, { agent: sender }, 'release_domain/absent')
  eq(out.outcome, 'absent', 'outcome 应为 absent')
  eq(out.noteEcho, null, '没给 note 时 noteEcho 应为 null')
}

{
  const book = bookFile('release-not-owner', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const out = await call(mount({ domainsFile: book }), 'release_domain', { domain: 'asr' }, { agent: sender }, 'release_domain/not-owner')
  eq(out.outcome, 'not-owner', 'outcome 应为 not-owner')
  eq(out.holders.length, 1, 'holders 不对')
}

{
  const book = bookFile('release-ambiguous', {
    'misas:asr': owner('misas', 'asr', ID.S),
    'other:asr': owner('other', 'asr', ID.S),
  })
  const out = await call(mount({ domainsFile: book }), 'release_domain', { domain: 'asr' }, { agent: sender }, 'release_domain/ambiguous-own')
  eq(out.outcome, 'ambiguous-own-declarations', 'outcome 应为 ambiguous-own-declarations')
  eq(out.keys.length, 2, 'keys 不对')
}

{
  const book = bookFile('release-ok', { 'misas:asr': owner('misas', 'asr', ID.S) })
  const out = await call(mount({ domainsFile: book }), 'release_domain', { domain: 'asr', note: 'bye' }, { agent: sender }, 'release_domain/released-with-note')
  eq(out.outcome, 'released', 'outcome 应为 released')
  eq(out.noteEcho, 'bye', 'noteEcho 不对')
  eq(out.noteNotPersisted, true, '带 note 时 noteNotPersisted 应为 true')
  ok(typeof out.hint === 'string', '带 note 时应回显 hint')
  eq(JSON.parse(fs.readFileSync(book, 'utf8')).owners, {}, 'release 后应为空账本')
}

{
  const book = bookFile('release-ok-silent', { 'misas:asr': owner('misas', 'asr', ID.S) })
  const out = await call(mount({ domainsFile: book }), 'release_domain', { domain: 'asr' }, { agent: sender }, 'release_domain/released-no-note')
  eq(out.outcome, 'released', 'outcome 应为 released')
  eq(out.noteEcho, null, '没给 note 时 noteEcho 应为 null（显式 null，不是 undefined）')
  eq(out.noteNotPersisted, false, 'noteNotPersisted 应为 false')
  // v0.3.3: 没给 note 时 hint 只剩「退役改标题」那一步的说明（必须是显式字符串，不得 undefined）。
  eq(out.hint, '标题没标成「（已退役）」（sessionTitle-unavailable）。', 'hint 应只剩退役那一步的说明')
  eq(out.retired.reason, 'sessionTitle-unavailable', '没有标题服务时应如实回报')
}

{
  const out = await call(mount({ domainsFile: blockedBook('release') }), 'release_domain', { domain: 'asr' }, { agent: sender }, 'release_domain/write-failed')
  // No declaration exists in the blocked book -> `absent`; force a release by pre-seeding the file.
  eq(out.outcome, 'absent', 'blocked 账本无声明时应 absent')
  const book = blockedBook('release2')
  fs.writeFileSync(
    book,
    JSON.stringify({ schemaVersion: 1, owners: { 'misas:asr': owner('misas', 'asr', ID.S) } }),
    'utf8',
  )
  const out2 = await call(mount({ domainsFile: book }), 'release_domain', { domain: 'asr' }, { agent: sender }, 'release_domain/write-failed-seeded')
  eq(out2.outcome, 'write-failed', '写入失败应 write-failed')
}

// ------------------------------------------------------------------ 6. create_domain_session

const createExec = { agent: sender }

{
  const out = await call(mount(), 'create_domain_session', { task: 'x' }, createExec, 'create/missing-domain')
  eq(out.reason, 'missing-domain', 'reason 应为 missing-domain')
  ok(typeof out.hint === 'string', 'missing-domain 必须有 hint')
}

{
  const out = await call(mount(), 'create_domain_session', { domain: 'asr', task: '  ' }, createExec, 'create/missing-task')
  eq(out.reason, 'missing-task', 'reason 应为 missing-task')
}

{
  const out = await call(mount(), 'create_domain_session', { domain: 'a:b:c', task: 'x' }, createExec, 'create/invalid-domain')
  eq(out.reason, 'invalid-domain', 'reason 应为 invalid-domain')
}

{
  const out = await call(mount(), 'create_domain_session', { domain: 'asr', task: 'x' }, { agent: makeAgent(ID.A, { cwd: null }) }, 'create/project-unknown')
  eq(out.reason, 'project-unknown', 'reason 应为 project-unknown')
}

{
  const out = await call(mount(), 'create_domain_session', { domain: 'asr', project: 'misas', task: 'x' }, { agent: makeAgent(ID.A, { cwd: null }) }, 'create/cwd-unknown')
  eq(out.reason, 'cwd-unknown', 'reason 应为 cwd-unknown')
}

{
  const out = await call(mount(), 'create_domain_session', { domain: 'misas:asr', task: 'do it', dryRun: true }, createExec, 'create/dry-run')
  eq(out.created, false, 'dryRun 不该真建')
  eq(out.dryRun, true, 'dryRun 应回显')
  eq(out.wouldCreate.request.cwd, FIXTURE_CWD, 'dryRun 的 cwd 不对')
  eq(out.wouldClaim, { requested: false }, 'dryRun 不该认领')
  eq(Object.keys(out.wouldDeliver.envelope).length > 0, true, 'dryRun 应给 envelope')
}

{
  const book = bookFile('create-dry-sitting', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const out = await call(mount({ domainsFile: book }), 'create_domain_session', { domain: 'asr', task: 'x', dryRun: true, claim: true }, createExec, 'create/dry-run-claim-sitting')
  eq(out.wouldClaim.requested, true, 'wouldClaim.requested 应为 true')
  eq(out.wouldClaim.sittingOwner.sessionId, ID.B, 'sittingOwner 不对')
}

{
  const out = await call(mount(), 'create_domain_session', { domain: 'asr', task: 'x' }, createExec, 'create/controller-unavailable')
  eq(out.reason, 'sessionController-unavailable', 'reason 应为 sessionController-unavailable')
}

{
  const controller = { create: async () => { throw new Error('smoke: create exploded') } }
  const out = await call(mount({ controller }), 'create_domain_session', { domain: 'asr', task: 'x' }, createExec, 'create/create-failed')
  eq(out.reason, 'create-failed', 'reason 应为 create-failed')
  ok(typeof out.error === 'string', 'create-failed 应带 error')
}

{
  const controller = { create: async () => 'nonsense' }
  const out = await call(mount({ controller }), 'create_domain_session', { domain: 'asr', task: 'x' }, createExec, 'create/no-session-id')
  eq(out.reason, 'create-returned-no-session-id', 'reason 应为 create-returned-no-session-id')
  eq(out.returned, { type: 'string' }, 'returned 诊断不对')
}

{
  const created = makeAgent(ID.C)
  const controller = { create: async () => ({ sessionId: ID.C, agentPreset: 'preset-x' }) }
  const out = await call(
    mount({ controller, get: (id) => (id === ID.C ? created : undefined) }),
    'create_domain_session',
    { domain: 'asr', task: 'do it' },
    createExec,
    'create/success',
  )
  eq(out.created, true, '应建成功')
  eq(out.session.shortId, 'sess-33333333', '短号不对')
  eq(out.session.projectFrom, '本会话 cwd 的目录名（小写）', 'projectFrom 不对')
  eq(out.scheduled, { ok: true, mode: 'followup', messageId: created.sent[0].payload.id }, 'scheduled 不对')
  eq(out.claim, { requested: false, performed: false }, 'claim 回执不对')
  ok(out.hint.includes('不会把它翻到前台'), '成功 hint 里必须说明不能翻到前台')
  eq(created.sent.length, 1, '开工任务应排进去')
}

{
  const controller = { create: async () => ({ sessionId: ID.C }) }
  const out = await call(mount({ controller, get: () => undefined }), 'create_domain_session', { domain: 'asr', task: 'x' }, createExec, 'create/agent-not-found')
  eq(out.created, true, '会话建好了就该 created:true')
  eq(out.scheduled.reason, 'agent-not-found-after-create', 'scheduled.reason 不对')
  eq(out.session.topLevel, null, '拿不到 agent 时 topLevel 应为 null')
}

{
  const created = makeAgent(ID.C, { methods: [] })
  const controller = { create: async () => ({ sessionId: ID.C }) }
  const out = await call(mount({ controller, get: () => created }), 'create_domain_session', { domain: 'asr', task: 'x' }, createExec, 'create/followup-unsupported')
  eq(out.scheduled.reason, 'followup-unsupported', 'scheduled.reason 不对')
}

{
  const created = makeAgent(ID.C, { throwOn: 'followup' })
  const controller = { create: async () => ({ sessionId: ID.C }) }
  const out = await call(mount({ controller, get: () => created }), 'create_domain_session', { domain: 'asr', task: 'x' }, createExec, 'create/followup-failed')
  eq(out.scheduled.reason, 'followup-failed', 'scheduled.reason 不对')
  eq(out.created, true, '排任务失败不等于建会话失败')
}

{
  const created = makeAgent(ID.C)
  const book = bookFile('create-claim-new')
  const controller = { create: async () => ({ sessionId: ID.C }) }
  const out = await call(
    mount({ controller, get: () => created, domainsFile: book }),
    'create_domain_session',
    { domain: 'asr', task: 'x', claim: true },
    createExec,
    'create/claim-created',
  )
  eq(out.claim.outcome, 'claimed', 'claim.outcome 应为 claimed')
  eq(out.claim.owner.sessionId, ID.C, '新会话应成为负责人')
  eq(JSON.parse(fs.readFileSync(book, 'utf8')).owners['misas:asr'].sessionId, ID.C, '域名册没指向新会话')
}

{
  const created = makeAgent(ID.C)
  const book = bookFile('create-claim-conflict', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const controller = { create: async () => ({ sessionId: ID.C }) }
  const out = await call(
    mount({ controller, get: () => created, domainsFile: book }),
    'create_domain_session',
    { domain: 'asr', task: 'x', claim: true },
    createExec,
    'create/claim-conflict',
  )
  eq(out.claim.outcome, 'conflict', 'claim.outcome 应为 conflict')
  ok(typeof out.claim.hint === 'string', 'claim 冲突必须给换人办法 hint')
  eq(out.claim.holder.sessionId, ID.B, 'claim.holder 不对')
}

{
  // Outer catch: a throwing `exec.agent` getter must degrade into an honest report.
  const boom = {}
  Object.defineProperty(boom, 'agent', { get() { throw new Error('smoke: exec.agent exploded') } })
  const out = await call(mount(), 'create_domain_session', { domain: 'asr', task: 'x' }, boom, 'create/unexpected-error')
  eq(out.reason, 'unexpected-error', 'reason 应为 unexpected-error')
  eq(out.created, false, '意外错误应 created:false')
}

// ------------------------------------------------- 7. create_domain_session: attach + pin (v0.3.2)

// Real-machine instance: the fixture cwd is a real workspace in the host registry.
const WS = { id: '4005ec84-fce4-4cd6-9354-88b13349d1f0', title: 'tixiwehu' }
const CWD = FIXTURE_CWD

/** Fake workspace registry: records every resolveByPath / pinSession call, never touches disk. */
function reg(options = {}) {
  const calls = { resolveByPath: [], pinSession: [] }
  const registry = {
    calls,
    async resolveByPath(p) {
      calls.resolveByPath.push(p)
      if (options.resolveThrows) throw new Error('smoke: resolve exploded')
      return options.workspace === undefined ? WS : options.workspace
    },
    async pinSession(id) {
      calls.pinSession.push(id)
      if (options.pinThrows) {
        throw new Error('cannot pin session: live sessions and session persistence hold no such session')
      }
    },
  }
  if (options.noResolve) delete registry.resolveByPath
  if (options.noPin) delete registry.pinSession
  if (options.list) registry.list = () => options.list
  return registry
}

/** create() spy: `steps[i]` is a result object, or a function(request) that may throw. */
function createSpy(steps) {
  const requests = []
  return {
    requests,
    create: async (request) => {
      requests.push(request)
      const step = steps[requests.length - 1]
      if (typeof step === 'function') return step(request)
      return step === undefined ? { sessionId: ID.C } : step
    },
  }
}

/** The exact throw shape of dsh-api-session-controller/lib/index.js:704 after a successful create. */
function attachThrew(sessionId, workspaceId) {
  const error = new Error(
    `session "${sessionId}" was created but could not attach to workspace "${workspaceId}": smoke: attach exploded`,
  )
  error.code = 'session/workspace-attach-failed'
  error.details = { sessionId, workspaceId }
  error.isDSHRemoteError = true
  return error
}

{
  // ① registry up + resolveByPath HIT => {workspaceId} request (never cwd) + pinSession once.
  const registry = reg()
  const controller = createSpy([{ sessionId: ID.C }])
  const created = makeAgent(ID.C)
  const out = await call(
    mount({ controller, registry, get: () => created }),
    'create_domain_session',
    { domain: 'asr', task: 'do it' },
    createExec,
    'v032/workspace-hit',
  )
  eq(registry.calls.resolveByPath, [CWD], 'resolveByPath 应拿到 cwd 原件')
  eq(controller.requests.length, 1, '命中工作区时只该调一次 create')
  eq(controller.requests[0].workspaceId, WS.id, '请求应带 workspaceId')
  ok(!('cwd' in controller.requests[0]), 'workspaceId 版请求不得同时带 cwd（宿主会 bad-request）')
  eq(registry.calls.pinSession, [ID.C], 'pinSession 应被调用一次')
  eq(out.pinned, { ok: true, reason: null }, 'pinned 回执不对')
  eq(out.workspace.attached, true, 'workspace.attached 应为 true')
  eq(out.workspace.id, WS.id, 'workspace.id 不对')
  eq(out.session.attachedToWorkspace, true, 'session.attachedToWorkspace 应为 true')
  eq(out.session.workspaceId, WS.id, 'session.workspaceId 不对')
  eq(created.sent.length, 1, '入组 + 置顶后开工任务仍应排进去')
  ok(out.hint.includes('已挂进工作区分组'), 'hint 应说明已入组')
  ok(out.hint.includes('已把它置顶到'), 'hint 应说明已置顶')
  ok(out.hint.includes('折叠'), 'hint 应提示折叠分组要先展开')
  ok(out.hint.includes('不会把它翻到前台'), 'v0.3.1 的「不能翻到前台」说明必须保留')
}

{
  // ② resolveByPath MISS => byte-identical v0.3.1 {cwd} request, pin STILL attempted.
  const registry = reg({ workspace: null })
  const controller = createSpy([{ sessionId: ID.C }])
  const out = await call(
    mount({ controller, registry, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/workspace-miss',
  )
  eq(controller.requests[0], { cwd: CWD }, '未命中工作区应退回逐字 {cwd} 请求')
  eq(registry.calls.pinSession, [ID.C], '没入组也要尝试置顶（pin 不要求已 attach）')
  eq(out.workspace.lookup, 'no-workspace-for-path', 'lookup 应为 no-workspace-for-path')
  eq(out.workspace.attached, null, '没入组时 attached 应为 null')
  eq(out.workspace.requested, false, '没入组时 requested 应为 false')
  eq(out.pinned.ok, true, '置顶应成功')
  eq(out.created, true, '仍应建成功')
}

{
  // ③ workspaceId create throws => auto-retry the {cwd} request ONCE, final created:true.
  const registry = reg()
  const notFound = Object.assign(new Error(`workspace "${WS.id}" not found`), {
    code: 'workspace/not-found',
    details: { workspaceId: WS.id },
  })
  const controller = createSpy([
    () => {
      throw notFound
    },
    { sessionId: ID.C },
  ])
  const out = await call(
    mount({ controller, registry, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/workspace-create-fails-retry-cwd',
  )
  eq(controller.requests.length, 2, 'workspaceId 版失败应自动重试一次')
  eq(controller.requests[0].workspaceId, WS.id, '第一次应走 workspaceId')
  eq(controller.requests[1], { cwd: CWD }, '第二次应退回逐字 {cwd}')
  eq(out.created, true, '重试成功应 created:true')
  eq(out.workspace.createFallback, true, '应标注发生了降级重试')
  eq(out.workspace.attached, false, '降级后没有入组')
  ok(typeof out.workspace.createFallbackError === 'string', '应保留首次错误文本')
  eq(registry.calls.pinSession, [ID.C], '降级成功后仍应置顶')
}

{
  // ④ both attempts fail => created:false / create-failed (and nothing is pinned).
  const registry = reg()
  const controller = createSpy([
    () => {
      throw new Error('first exploded')
    },
    () => {
      throw new Error('second exploded')
    },
  ])
  const out = await call(
    mount({ controller, registry }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/both-creates-fail',
  )
  eq(controller.requests.length, 2, '只允许重试一次')
  eq(out.created, false, '两次都失败应 created:false')
  eq(out.reason, 'create-failed', 'reason 应为 create-failed')
  eq(out.error, 'second exploded', 'error 应是第二次的错误')
  eq(out.firstError, 'first exploded', 'firstError 应是第一次的错误')
  eq(registry.calls.pinSession, [], '什么都没建出来时不得置顶')
}

{
  // ⑤ attach failed AFTER the session was created => NEVER rebuild; created:true, not attached.
  const registry = reg()
  const controller = createSpy([
    () => {
      throw attachThrew(ID.C, WS.id)
    },
  ])
  const out = await call(
    mount({ controller, registry, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/attach-failed-after-create',
  )
  eq(controller.requests.length, 1, 'attach 失败绝不能重建会话（会多出第二条）')
  eq(out.created, true, 'attach 失败时会话已经建出来了 => created:true')
  eq(out.session.id, ID.C, 'session.id 应从宿主错误里取回')
  eq(out.workspace.attached, false, 'attached 应为 false')
  eq(out.workspace.createFallback, false, 'attach 失败不是 create 失败，不得标成降级重试')
  ok(typeof out.workspace.attachError === 'string', '应如实回报 attach 失败原因')
  eq(registry.calls.pinSession, [ID.C], 'attach 失败后仍应继续置顶')
  ok(out.hint.includes('未入组'), 'hint 应如实说未入组')
  // The riskiest branch for the lossless-JSON contract: every workspace key must be defined.
  ok(
    Object.keys(out.workspace).every((k) => out.workspace[k] !== undefined),
    'workspace 段不得出现 undefined 键',
  )
}

{
  // ⑤b same thing, but the realm only kept the TEXT (no code / no details) => still no rebuild.
  const registry = reg()
  const controller = createSpy([
    () => {
      throw new Error(`session "${ID.C}" was created but could not attach to workspace "${WS.id}": only text`)
    },
  ])
  const out = await call(
    mount({ controller, registry, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/attach-failed-text-only',
  )
  eq(controller.requests.length, 1, '只有文本也要认出 attach 失败，不得重建')
  eq(out.session.id, ID.C, '会话 id 应从错误文本里解析出来')
  eq(out.workspace.attached, false, 'attached 应为 false')
}

{
  // ⑤c attach failed and NO id is recoverable => still created:true, still no rebuild, no pin.
  const registry = reg()
  const controller = createSpy([
    () => {
      throw Object.assign(new Error('session/workspace-attach-failed'), { code: 'session/workspace-attach-failed' })
    },
  ])
  const out = await call(
    mount({ controller, registry }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/attach-failed-no-id',
  )
  eq(controller.requests.length, 1, '拿不到 id 也不得重建')
  eq(out.created, true, '会话已经建出来 => created:true')
  eq(out.session, null, '拿不到 id 时 session 应为 null')
  eq(out.reason, 'created-but-workspace-attach-failed', 'reason 应如实标注')
  eq(registry.calls.pinSession, [], '没有 id 就不能置顶')
  eq(out.pinned.ok, false, '没有 id 时 pinned.ok 应为 false')
  ok(out.hint.includes('不会重建会话'), 'hint 必须说明不会重建')
}

{
  // ⑥ pinSession throws => created:true + pinned.ok:false (pin failure never kills the create).
  const registry = reg({ pinThrows: true })
  const controller = createSpy([{ sessionId: ID.C }])
  const out = await call(
    mount({ controller, registry, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/pin-throws',
  )
  eq(out.created, true, 'pin 失败不影响 created:true')
  eq(out.workspace.attached, true, '入组仍应成功')
  eq(out.pinned.ok, false, 'pinned.ok 应为 false')
  ok(out.pinned.reason.includes('cannot pin session'), 'pinned.reason 应带宿主错误原文')
  ok(out.hint.includes('置顶没做成'), 'hint 应如实说置顶没做成')
  ok(out.hint.includes('搜索框'), '置顶失败时应给搜索框兜底提示')
}

{
  // ⑦ pin:false => pinSession is NOT called at all.
  const registry = reg()
  const controller = createSpy([{ sessionId: ID.C }])
  const out = await call(
    mount({ controller, registry, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x', pin: false },
    createExec,
    'v032/pin-false',
  )
  eq(registry.calls.pinSession, [], 'pin:false 不得调 pinSession')
  eq(out.pinned, { ok: false, reason: 'skipped-by-request' }, 'pin:false 回执不对')
  eq(out.created, true, 'pin:false 仍应建会话')
  eq(out.workspace.attached, true, 'pin:false 不影响入组')
}

{
  // ⑧ no registry at all => the request is byte-identical to v0.3.1, in both preset shapes.
  for (const preset of [undefined, 'preset-x']) {
    const controller = createSpy([{ sessionId: ID.C }])
    const out = await call(
      mount({ controller, get: () => makeAgent(ID.C) }),
      'create_domain_session',
      preset === undefined ? { domain: 'asr', task: 'x' } : { domain: 'asr', task: 'x', agentPreset: preset },
      createExec,
      `v032/no-registry${preset ? '-preset' : ''}`,
    )
    eq(
      controller.requests[0],
      preset === undefined ? { cwd: CWD } : { cwd: CWD, agentPreset: preset },
      'registry 取不到时请求必须与 v0.3.1 逐字相同（含 agentPreset 位）',
    )
    eq(out.workspace.lookup, 'workspaceRegistry-unavailable', 'lookup 应为 workspaceRegistry-unavailable')
    eq(out.pinned, { ok: false, reason: 'workspaceRegistry-unavailable' }, '置顶不可用应如实回报')
    eq(out.created, true, '拿不到 registry 也必须照常建会话')
    eq(out.workspace.attached, null, '拿不到 registry 时 attached 应为 null')
  }
}

{
  // ⑨ lookup fallbacks + how the registry is reached.
  // a) no resolveByPath (and no list) => no-workspace-for-path, still attempts pin.
  const bare = { calls: { pinSession: [] }, async pinSession(id) { bare.calls.pinSession.push(id) } }
  const c1 = createSpy([{ sessionId: ID.C }])
  const o1 = await call(
    mount({ controller: c1, registry: bare, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/no-resolve-by-path',
  )
  eq(o1.workspace.lookup, 'no-workspace-for-path', '没有 resolveByPath 时应降级为未命中')
  eq(c1.requests[0], { cwd: CWD }, '应退回 cwd 请求')
  eq(bare.calls.pinSession, [ID.C], '仍应置顶')

  // b) list() fallback matches the realpath spelling.
  const lister = reg({ noResolve: true, list: [{ id: WS.id, path: CWD, title: WS.title }] })
  const c2 = createSpy([{ sessionId: ID.C }])
  const o2 = await call(
    mount({ controller: c2, registry: lister, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/list-fallback',
  )
  eq(o2.workspace.lookup, 'resolved-from-list', 'list 兜底命中时 lookup 应为 resolved-from-list')
  eq(c2.requests[0].workspaceId, WS.id, 'list 兜底命中应带 workspaceId')

  // c) resolveByPath throws (e.g. the directory is gone) => degrade, never throw.
  const thrower = reg({ resolveThrows: true })
  const c3 = createSpy([{ sessionId: ID.C }])
  const o3 = await call(
    mount({ controller: c3, registry: thrower, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/resolve-throws',
  )
  eq(o3.workspace.lookup, 'resolve-failed', 'resolve 抛错应回报 resolve-failed')
  ok(typeof o3.workspace.lookupError === 'string', 'resolve 抛错应保留 error 文本')
  eq(c3.requests[0], { cwd: CWD }, 'resolve 抛错应退回 cwd 请求')
  eq(o3.workspace.attached, null, 'resolve 失败时 attached 应为 null')

  // d) a registry without pinSession => honest pinned-not-attempted report.
  const noPin = reg({ noPin: true })
  const c4 = createSpy([{ sessionId: ID.C }])
  const o4 = await call(
    mount({ controller: c4, registry: noPin, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/pin-unsupported',
  )
  eq(o4.pinned, { ok: false, reason: 'pinSession-unsupported' }, '没有 pinSession 时应如实回报')
  eq(o4.workspace.attached, true, '入组与置顶是两件事，入组仍应成功')

  // e) reached through ctx.get() (the documented accessor) ...
  const viaGet = reg()
  const c5 = createSpy([{ sessionId: ID.C }])
  const o5 = await call(
    mount({ controller: c5, registry: viaGet, registryVia: 'get', get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/registry-via-ctx-get',
  )
  eq(o5.pinned.ok, true, 'ctx.get 取到的 registry 也应能置顶')
  // ... and f) a throwing ctx.get() falls through to the property read.
  const viaProp = reg()
  const c6 = createSpy([{ sessionId: ID.C }])
  const o6 = await call(
    mount({ controller: c6, registry: viaProp, registryVia: 'get-throws', get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v032/registry-fallback-property',
  )
  eq(o6.pinned.ok, true, 'ctx.get 抛错时应回落到属性读取')
  eq(c6.requests[0].workspaceId, WS.id, '回落路径也应带 workspaceId')
}

{
  // dryRun must rehearse the workspace half too, and still never touch anything.
  const registry = reg()
  const out = await call(
    mount({ registry }),
    'create_domain_session',
    { domain: 'asr', task: 'x', dryRun: true },
    createExec,
    'v032/dry-run-workspace',
  )
  eq(out.dryRun, true, 'dryRun 应回显')
  eq(out.created, false, 'dryRun 绝不真建')
  eq(out.wouldCreate.request, { workspaceId: WS.id }, 'dryRun 应展示 workspaceId 版请求')
  eq(out.wouldCreate.workspace.title, WS.title, 'dryRun 应展示命中的工作区标题')
  eq(out.wouldPin, { requested: true }, 'dryRun 应展示会置顶')
  eq(registry.calls.pinSession, [], 'dryRun 不得真置顶')
  eq(registry.calls.resolveByPath.length, 1, 'dryRun 只做一次只读 resolve')
}

// ------------------------------------- 8. v0.3.3: 自动标题 + 权限档 + 退役标记

/** Fake PermissionPresetService: records resolve/set, can throw exactly like the real one does. */
function presetService(options = {}) {
  const calls = { resolve: [], set: [] }
  return {
    calls,
    resolve(name) {
      calls.resolve.push(name)
      if (options.unknown) throw new Error(`permission: unknown preset "${name}"`)
      return { sandbox: 'danger-full-access', approval: 'never' }
    },
    set(session, name) {
      calls.set.push({ session, name })
      if (options.setThrows) throw new Error('smoke: permissionPresets.set exploded')
    },
  }
}

/** Fake SessionTitleService: get/rename with a remembered current title (the real one is a fold). */
function titleService(options = {}) {
  const calls = { get: [], rename: [] }
  let current = options.initial
  const snapshot = (title) => ({ title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 1, updatedAt: 0 })
  return {
    calls,
    get(session) {
      calls.get.push(session)
      return current === undefined ? undefined : snapshot(current)
    },
    rename(session, title) {
      calls.rename.push({ session, title })
      if (options.renameThrows) throw new Error('smoke: sessionTitle.rename exploded')
      current = title
      return snapshot(title)
    },
  }
}

const TITLE_RE = /^\[docs\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} · /

{
  // ① 自动标题 + 默认权限档：两个服务都必须拿到 Session 对象（不是 sessionId），且不影响排任务。
  const controller = createSpy([{ sessionId: ID.C }])
  const created = makeAgent(ID.C)
  const presets = presetService()
  const titles = titleService()
  const out = await call(
    mount({ controller, permissionPresets: presets, sessionTitle: titles, get: () => created }),
    'create_domain_session',
    { domain: 'docs', task: '第一行\n第二行 ' + '很长'.repeat(60) },
    createExec,
    'v033/title-and-preset',
  )
  eq(presets.calls.resolve, ['workspace-write'], '默认应 resolve 配置里的档名（v0.6.4 起缺省 workspace-write）')
  eq(presets.calls.set.length, 1, 'set 应被调用一次')
  eq(presets.calls.set[0].session, created.session, 'set 必须拿到 Session 对象（不是 id）')
  eq(presets.calls.set[0].name, 'workspace-write', 'set 的档名不对（v0.6.4 起缺省 workspace-write）')
  eq(out.permission, { requested: true, preset: 'workspace-write', ok: true }, 'permission 回执不对')
  eq(titles.calls.rename.length, 1, 'rename 应被调用一次')
  eq(titles.calls.rename[0].session, created.session, 'rename 必须拿到 Session 对象（不是 id）')
  const title = titles.calls.rename[0].title
  ok(TITLE_RE.test(title), `标题时间戳必须前置且带日期: ${title}`)
  ok(Buffer.byteLength(title, 'utf8') <= 80, `标题不得超过 80 字节: ${Buffer.byteLength(title, 'utf8')}`)
  ok(title.includes('· 第一行'), `简介应取任务开头: ${title}`)
  ok(!title.includes('\n'), '标题必须是单行')
  eq(out.titled.ok, true, 'titled.ok 应为 true')
  eq(created.sent.length, 1, '设档 + 命名不得影响排队开工任务')
  ok(out.hint.includes('权限档已设成 workspace-write'), 'hint 应说明权限档')
  ok(out.hint.includes('标题已设为'), 'hint 应说明标题')
}

{
  // ② 显式覆盖：permissionPreset / title 都按参数走。
  const controller = createSpy([{ sessionId: ID.C }])
  const presets = presetService()
  const titles = titleService()
  const out = await call(
    mount({ controller, permissionPresets: presets, sessionTitle: titles, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'docs', task: 'x', permissionPreset: 'workspace-write', title: '自定义 · 标题' },
    createExec,
    'v033/explicit-overrides',
  )
  eq(presets.calls.resolve, ['workspace-write'], '参数应覆盖配置档名')
  eq(out.permission.preset, 'workspace-write', 'permission.preset 不对')
  eq(titles.calls.rename[0].title, '自定义 · 标题', '标题应按参数原文')
  eq(out.titled.title, '自定义 · 标题', 'titled.title 不对')
}

{
  // ③ 关掉这两步：一个服务都不该被调用，且回执不留 undefined。
  const controller = createSpy([{ sessionId: ID.C }])
  const presets = presetService()
  const titles = titleService()
  const out = await call(
    mount({ controller, permissionPresets: presets, sessionTitle: titles, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'docs', task: 'x', permissionPreset: 'none', title: ' keep ' },
    createExec,
    'v033/off-switches',
  )
  eq(presets.calls.resolve, [], '关掉时不该 resolve')
  eq(presets.calls.set, [], '关掉时不该 set')
  eq(titles.calls.rename, [], '关掉时不该 rename')
  eq(out.permission, { requested: false, preset: null, reason: 'skipped-by-request' }, 'permission 回执不对')
  eq(out.titled, { requested: false, title: null, reason: 'skipped-by-request' }, 'titled 回执不对')
}

{
  // ④ 未知档名 / rename 抛错：只坏那一步，created 与排任务照旧。
  const controller = createSpy([{ sessionId: ID.C }])
  const created = makeAgent(ID.C)
  const out = await call(
    mount({
      controller,
      permissionPresets: presetService({ unknown: true }),
      sessionTitle: titleService({ renameThrows: true }),
      get: () => created,
    }),
    'create_domain_session',
    { domain: 'docs', task: 'x' },
    createExec,
    'v033/service-throws',
  )
  eq(out.created, true, '服务抛错不得影响 created')
  eq(out.permission.ok, false, '未知名档应如实报失败')
  eq(out.permission.reason, 'set-failed', 'reason 应为 set-failed')
  ok(out.permission.error.includes('unknown preset'), 'error 应带上服务原话')
  eq(out.titled.ok, false, 'rename 抛错应如实报失败')
  eq(out.titled.reason, 'rename-failed', 'reason 应为 rename-failed')
  eq(created.sent.length, 1, '两步失败后开工任务仍要排进去')
}

{
  // ⑤ 两个服务都缺失 => 如实降级（老部署行为不变）。
  const controller = createSpy([{ sessionId: ID.C }])
  const out = await call(
    mount({ controller, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'docs', task: 'x' },
    createExec,
    'v033/services-absent',
  )
  eq(out.permission.ok, false, '缺权限服务应如实回报')
  eq(out.permission.reason, 'permissionPresets-unavailable', 'reason 不对')
  eq(out.titled.ok, false, '缺标题服务应如实回报')
  eq(out.titled.reason, 'sessionTitle-unavailable', 'reason 不对')
}

{
  // ⑥ 两个服务走 ctx.get() 也能取到（文档化取法）。
  const controller = createSpy([{ sessionId: ID.C }])
  const presets = presetService()
  const titles = titleService()
  const out = await call(
    mount({
      controller,
      permissionPresets: presets,
      permissionPresetsVia: 'get',
      sessionTitle: titles,
      sessionTitleVia: 'get',
      get: () => makeAgent(ID.C),
    }),
    'create_domain_session',
    { domain: 'docs', task: 'x' },
    createExec,
    'v033/services-via-get',
  )
  eq(out.permission.ok, true, 'ctx.get 路径应能设档')
  eq(out.titled.ok, true, 'ctx.get 路径应能命名')
}

{
  // ⑦ release_domain 退役：标记前置、原标题保留在后、≤80 字节。
  const book = bookFile('release-retire', { 'misas:asr': owner('misas', 'asr', ID.S) })
  const titles = titleService({ initial: '[asr] 2026-10-11 21:00 · 旧标题' })
  const out = await call(
    mount({ domainsFile: book, sessionTitle: titles }),
    'release_domain',
    { domain: 'asr' },
    { agent: sender },
    'v033/release-retire',
  )
  eq(out.outcome, 'released', 'outcome 应为 released')
  eq(out.retired.ok, true, 'retired.ok 应为 true')
  eq(titles.calls.rename.length, 1, 'rename 应被调用一次')
  eq(titles.calls.rename[0].session, sender.session, '必须改的是调用方那个会话的标题')
  const next = titles.calls.rename[0].title
  ok(next.startsWith('（已退役）'), `退役标记必须前置: ${next}`)
  ok(next.includes('[asr] 2026-10-11 21:00 · 旧标题'), `原标题应保留: ${next}`)
  ok(Buffer.byteLength(next, 'utf8') <= 80, '退役标题不得超过 80 字节')
  ok(out.hint.includes('标题已标为'), 'hint 应说明已标退役')
}

{
  // ⑧ release 时拿不到会话（窗口已关 / 重启过）=> 只如实回报，绝不去唤醒它。
  const book = bookFile('release-not-live', { 'misas:asr': owner('misas', 'asr', ID.S) })
  const titles = titleService({ initial: 'x' })
  const out = await call(
    mount({ domainsFile: book, sessionTitle: titles }),
    'release_domain',
    { domain: 'asr' },
    { agent: { id: ID.S } },
    'v033/release-not-live',
  )
  eq(out.outcome, 'released', '释放本身仍应成功')
  eq(out.retired.reason, 'not-live', 'reason 应为 not-live')
  eq(titles.calls.rename, [], '拿不到会话时不得尝试改名')
}

{
  // ⑨ 交接（claim force）：顺手把**前任**的标题标退役（前任仍 live 时）。
  const book = bookFile('claim-retire', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const prev = makeAgent(ID.A)
  const titles = titleService({ initial: '旧任标题' })
  const out = await call(
    mount({ domainsFile: book, sessionTitle: titles, get: (id) => (id === ID.A ? prev : sender) }),
    'claim_domain',
    { domain: 'asr', force: true },
    { agent: sender },
    'v033/claim-handover-retire',
  )
  eq(out.outcome, 'handover', 'outcome 应为 handover')
  eq(out.retired.ok, true, 'retired.ok 应为 true')
  eq(titles.calls.rename[0].session, prev.session, '必须改的是前任那个会话的标题')
  ok(out.hint.includes('前任标题已标为'), 'hint 应说明前任标题')
}

{
  // ⑩ 前任已离线 => not-live；标题已经是「（已退役）」=> 不重复加标记。
  const book = bookFile('claim-retire-offline', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const titles = titleService()
  const out = await call(
    mount({ domainsFile: book, sessionTitle: titles, get: () => undefined }),
    'claim_domain',
    { domain: 'asr', force: true },
    { agent: sender },
    'v033/claim-handover-offline',
  )
  eq(out.retired.reason, 'not-live', '前任离线应报 not-live')
  eq(titles.calls.rename, [], '前任离线时不得改名')

  const book2 = bookFile('claim-retire-again', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const prev = makeAgent(ID.A)
  const titles2 = titleService({ initial: '（已退役）旧任标题' })
  const out2 = await call(
    mount({ domainsFile: book2, sessionTitle: titles2, get: () => prev }),
    'claim_domain',
    { domain: 'asr', force: true },
    { agent: sender },
    'v033/claim-handover-already',
  )
  eq(out2.retired.skipped, 'already-retired', '已退役的标题不该重复加标记')
  eq(titles2.calls.rename, [], '已退役时不该再 rename')
}

// ------------------------------------- 9. v0.3.4: send_to_domain 的「叫醒」探测档

{
  // ① 默认（不叫醒）：离线目标仍是 unreachable，且返回体里**不许出现 woke**
  //    （默认路径必须与 v0.3.3 逐字一致）。
  const out = await call(mount(), 'send_to_domain', { target: ID.X1, message: 'hi' }, { agent: sender }, 'v034/no-wake')
  eq(out.delivered, false, '不叫醒时不该投递')
  eq(out.reason, 'unreachable', '不叫醒时离线目标应报 unreachable')
  ok(!('woke' in out), '不叫醒时返回体不得多出 woke 键')
}

{
  // ② wake:'probe'：只把它从存档拉活 + 回报；不投递、不跑 turn。
  const live = []
  const resumed = []
  const agentsService = {
    list: () => live.slice(),
    get: (id) => live.find((agent) => agent.id === id),
  }
  const controller = {
    // getSessionController 的"可用"判据要求 create（真实 service 同时有 create 与 resume）。
    async create() {
      return { sessionId: ID.C }
    },
    async resume(id) {
      resumed.push(id)
      live.push(makeAgent(id))
    },
  }
  const out = await call(
    mount({ agentsService, controller }),
    'send_to_domain',
    { target: ID.X1, message: 'hi', wake: 'probe' },
    { agent: sender },
    'v034/probe-ok',
  )
  eq(out.probe, true, 'probe 应回显')
  eq(out.delivered, false, '探测档绝不投递')
  eq(resumed, [ID.X1], 'resume 应被调用一次，且拿到完整会话 id')
  eq(out.woke.ok, true, 'woke.ok 应为 true')
  eq(out.woke.liveBefore, false, '拉活前不应在线')
  eq(out.woke.liveAfter, true, '拉活后应在线')
  eq(out.woke.via, 'session-id', '判定依据应为 session-id')
  eq(out.woke.api, 'sessionController.resume', 'agents.resume 缺席时应回落到 sessionController.resume')
  eq(out.liveAfter, true, 'liveAfter 应为 true')
  eq(out.resolved && out.resolved.id, ID.X1, '拉活后应能解析到它')
  eq(out.onlineTopLevel.length, 1, 'onlineTopLevel 应含刚拉活那条')
  eq(live[0].sent.length, 0, '探测档不得给它投任何消息')
}

{
  // ③ wake:'probe' 但 resume 抛错 => 如实回报，仍不投递。
  const agentsService = { list: () => [], get: () => undefined }
  const controller = {
    async create() {
      return { sessionId: ID.C }
    },
    async resume() {
      throw new Error('smoke: resume exploded')
    },
  }
  const out = await call(
    mount({ agentsService, controller }),
    'send_to_domain',
    { target: ID.X1, message: 'hi', wake: 'probe' },
    { agent: sender },
    'v034/probe-throws',
  )
  eq(out.probe, true, '仍是探测档回报')
  eq(out.woke.ok, false, 'woke.ok 应为 false')
  eq(out.woke.reason, 'resume-failed', 'reason 应为 resume-failed')
  ok(out.woke.error.includes('resume exploded'), 'error 应带上服务原话')
  eq(out.delivered, false, '失败也不许投递')
}

{
  // ④ 短号不能 resume => 明确不猜（no-wake-candidate）。
  const out = await call(
    mount({ agentsService: { list: () => [], get: () => undefined } }),
    'send_to_domain',
    { target: 'sess-aaa11111', message: 'hi', wake: 'probe' },
    { agent: sender },
    'v034/probe-short-id',
  )
  eq(out.woke.attempted, false, '短号不应尝试 resume')
  eq(out.woke.reason, 'no-wake-candidate', 'reason 应为 no-wake-candidate')
  eq(out.woke.via, 'not-a-full-session-id', '判定依据不对')
}

{
  // ⑤ 声明负责人离线时，叫醒用的是**声明里的 sessionId**；拉活后正常投递。
  //    v0.4.1：这条走的是**第二候选** `sessionController.resume(sessionId)`（它的签名收不下
  //    agentOptions/setup）⇒ 只有"不跑回合"的档还能走它，所以这里用 mode='inject'。
  //    "要跑回合却收不下接线"必须被拒 —— 见第 12 段 ⑤。
  const book = bookFile('wake-declared', { 'misas:asr': owner('misas', 'asr', ID.X2) })
  const live = []
  const resumed = []
  const agentsService = { list: () => live.slice(), get: (id) => live.find((agent) => agent.id === id) }
  const controller = {
    // getSessionController 的"可用"判据要求 create（真实 service 同时有 create 与 resume）。
    async create() {
      return { sessionId: ID.C }
    },
    async resume(id) {
      resumed.push(id)
      live.push(makeAgent(id))
    },
  }
  const out = await call(
    mount({ domainsFile: book, agentsService, controller }),
    'send_to_domain',
    { target: 'misas:asr', message: 'hi', wake: 'true', mode: 'inject' },
    { agent: sender },
    'v034/wake-then-deliver',
  )
  eq(resumed, [ID.X2], '叫醒的必须是声明里那个 sessionId')
  eq(out.delivered, true, '拉活后应正常投递')
  eq(out.matchedBy, 'declaration', '应按声明解析')
  eq(live[0].sent.length, 1, '且正好投了一条')
  eq(live[0].sent[0].mode, 'inject', '按原 mode 投')
}

{
  // ⑥ v0.3.5：**主入口** `ctx.agents.resume({resumeSessionId})` —— 真机探测第一跑就卡在旧入口上
  //    （插件侧的 sessionController 没有 resume），所以这条才是"能力真的存在"的主判据。
  const live = []
  const resumed = []
  const agentsService = {
    list: () => live.slice(),
    get: (id) => live.find((agent) => agent.id === id),
    async resume(options) {
      resumed.push(options)
      live.push(makeAgent(options.resumeSessionId))
    },
  }
  const out = await call(
    mount({ agentsService }),
    'send_to_domain',
    { target: ID.X1, message: 'hi', wake: 'probe' },
    { agent: sender },
    'v035/agents-resume',
  )
  eq(resumed.length, 1, 'agents.resume 应被调用一次')
  eq(resumed[0], { resumeSessionId: ID.X1 }, 'agents.resume 必须收到 {resumeSessionId}（ResumeAgentOptions）')
  eq(out.woke.api, 'agents.resume', 'api 应记为 agents.resume')
  eq(out.woke.ok, true, 'woke.ok 应为 true')
  eq(out.liveAfter, true, 'liveAfter 应为 true')
  eq(out.resolved && out.resolved.id, ID.X1, '拉活后应能解析到它')
  eq(live[0].sent.length, 0, '探测档不得给它投任何消息')
}

{
  // ⑦ 两个入口都没有 => 如实报 no-resume-api（不猜、不假装成功）。
  const out = await call(
    mount({ agentsService: { list: () => [], get: () => undefined } }),
    'send_to_domain',
    { target: ID.X1, message: 'hi', wake: 'probe' },
    { agent: sender },
    'v035/no-resume-api',
  )
  eq(out.woke.attempted, true, '应尝试过叫醒')
  eq(out.woke.reason, 'no-resume-api', '两个入口都没有时应报 no-resume-api')
  eq(out.woke.api, null, '没有可用入口时 api 应为 null')
  eq(out.delivered, false, '不得投递')
}

// ---------------- 10. v0.3.6: F1 防静默换届（existingOwner/拒绝/放行）+ F2 停机通知
//
// 依据：2026-10-12 docs 域起了第二条活会话（回执 created:true、零冲突提示），两条会话并发覆盖
// 同一批文档；以及 `ctx.agents.resume` 真机探测通过（26ms 拉活、不跑一轮 ⇒ wake='true' 正式启用）。
// 本段全部是本地假 ctx + 临时账本文件：不建真实会话、不碰真注册表。

{
  // ① 该域已有负责人、没传 claim / allowExistingOwner => created:false / domain-already-owned，
  //    existingOwner 给全，且**宿主 create 一次都没被调用**（这是本版的核心护栏）。
  const book = bookFile('v036-own-refuse', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const controller = createSpy([{ sessionId: ID.C }])
  const out = await call(
    mount({ controller, agents: [makeAgent(ID.B)], domainsFile: book }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x' },
    createExec,
    'v036/refuse-existing-owner',
  )
  eq(controller.requests.length, 0, '拒绝静默换届时不得调用宿主 create')
  eq(out.created, false, '该域已有负责人时应 created:false')
  eq(out.reason, 'domain-already-owned', 'reason 应为 domain-already-owned')
  ok(!('dryRun' in out), '非 dryRun 的拒绝回执不该有 dryRun 键')
  eq(out.existingOwner, {
    key: 'misas:asr',
    domain: 'asr',
    sessionId: ID.B,
    since: '2026-10-10T00:00:00.000Z',
    by: null,
    note: '',
    live: true,
    inArchive: true,
    inArchiveSource: 'index',
    inArchiveReason: null,
  }, 'existingOwner 不对')
  ok(out.hint.includes('已经有负责人'), 'hint 应说清「已经有负责人」')
  ok(out.hint.includes('没有新建任何会话'), 'hint 应说清「没有建会话」')
  ok(out.hint.includes(`claim_domain(domain='misas:asr', force=true)`), 'hint 应给出换人办法')
  ok(out.hint.includes('allowExistingOwner=true'), 'hint 应给出「确实要再开一条」的办法')
  eq(JSON.parse(fs.readFileSync(book, 'utf8')).owners['misas:asr'].sessionId, ID.B, '拒绝时域名册不得被改')
}

{
  // ② 同样场景 + allowExistingOwner:true => 照建，回执带 warning + existingOwner。
  const book = bookFile('v036-own-allow', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const controller = createSpy([{ sessionId: ID.C }])
  const out = await call(
    mount({ controller, agents: [makeAgent(ID.B)], domainsFile: book, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x', allowExistingOwner: true },
    createExec,
    'v036/allow-existing-owner',
  )
  eq(controller.requests.length, 1, 'allowExistingOwner:true 应照建（create 调一次）')
  eq(out.created, true, '应建成功')
  eq(out.warning, 'domain-already-owned', 'throwaway warning 应为 domain-already-owned')
  eq(out.existingOwner.sessionId, ID.B, 'existingOwner 应指向原负责人')
  eq(out.existingOwner.live, true, 'existingOwner.live 应为 true')
  ok(out.hint.includes('allowExistingOwner=true'), 'hint 应点明是你自己放行的')
  eq(JSON.parse(fs.readFileSync(book, 'utf8')).owners['misas:asr'].sessionId, ID.B, '没传 claim 就不该动声明')
}

{
  // ③ 同样场景 + claim:true => 仍是「建会话 + 只回报冲突、不覆盖」的旧语义（不拒绝）。
  const book = bookFile('v036-own-claim', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const controller = createSpy([{ sessionId: ID.C }])
  const out = await call(
    mount({ controller, agents: [makeAgent(ID.B)], domainsFile: book, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x', claim: true },
    createExec,
    'v036/claim-existing-owner',
  )
  eq(controller.requests.length, 1, 'claim:true 是既有语义，仍应建会话')
  eq(out.created, true, 'claim:true 撞在别人身上不改变 created')
  eq(out.claim.outcome, 'conflict', 'claim.outcome 应为 conflict（不覆盖）')
  eq(out.claim.holder.sessionId, ID.B, 'holder 应还是原负责人')
  ok(!('warning' in out), 'claim:true 未放行时不该有 warning（冲突已在 claim 段说明）')
  eq(JSON.parse(fs.readFileSync(book, 'utf8')).owners['misas:asr'].sessionId, ID.B, '冲突时不得覆盖声明')
}

{
  // ④ 空闲域 => 与 v0.3.5 行为一致（回归）：照建、existingOwner 为 null、无 warning。
  const book = bookFile('v036-free', {})
  const controller = createSpy([{ sessionId: ID.C }])
  const out = await call(
    mount({ controller, domainsFile: book, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x' },
    createExec,
    'v036/free-domain-regression',
  )
  eq(controller.requests.length, 1, '空闲域应照建')
  eq(out.created, true, '空闲域应 created:true')
  eq(out.existingOwner, null, '没有声明时 existingOwner 应为显式 null')
  ok(!('warning' in out), '空闲域不得有 warning')
  ok(out.hint.includes('已建好'), '成功 hint 应保持原样')

  // ④b 空闲域 + allowExistingOwner:true => 照建且不产生 warning（这个参数只对「已有负责人」生效）。
  const out2 = await call(
    mount({ controller: createSpy([{ sessionId: ID.C }]), domainsFile: book, get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x', allowExistingOwner: true },
    createExec,
    'v036/free-domain-allow-noop',
  )
  eq(out2.created, true, '空闲域 + allowExistingOwner 仍应建')
  eq(out2.existingOwner, null, '空闲域 existingOwner 仍为 null')
  ok(!('warning' in out2), '空闲域不该凭空冒出 warning')
}

{
  // ⑤ 同样场景 + dryRun:true => 报告「会被拒绝」，仍**不建**（create 零调用）。
  const book = bookFile('v036-own-dry', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const controller = createSpy([{ sessionId: ID.C }])
  const out = await call(
    mount({ controller, agents: [makeAgent(ID.B)], domainsFile: book }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x', dryRun: true },
    createExec,
    'v036/dry-run-refused',
  )
  eq(controller.requests.length, 0, 'dryRun 拒绝路径也不得调 create')
  eq(out.created, false, 'dryRun 绝不真建')
  eq(out.dryRun, true, 'dryRun 应回显')
  eq(out.refused, true, 'dryRun 应报告「会被拒绝」')
  eq(out.reason, 'domain-already-owned', 'reason 应为 domain-already-owned')
  eq(out.existingOwner.sessionId, ID.B, 'dryRun 也要给出 existingOwner')
  ok(!('wouldCreate' in out), '被拒绝的 dryRun 不该给 wouldCreate（什么都没打算建）')
}

{
  // ⑥ force 交接 + 前任在线 => 前任收到 inject 停机通知；标题仍加「（已退役）」；不叫醒前任。
  const book = bookFile('v036-handover-online', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const prev = makeAgent(ID.A)
  const titles = titleService({ initial: '旧任标题' })
  const out = await call(
    mount({ domainsFile: book, sessionTitle: titles, get: (id) => (id === ID.A ? prev : sender) }),
    'claim_domain',
    { domain: 'asr', force: true },
    { agent: sender },
    'v036/handover-predecessor-online',
  )
  eq(out.outcome, 'handover', 'outcome 应为 handover')
  eq(out.standDown.delivered, 'inject', '前任在线时应走 inject')
  eq(out.standDown.predecessorSessionId, ID.A, 'predecessorSessionId 不对')
  eq(out.standDown.reason, null, 'inject 成功时 reason 应为 null')
  eq(out.standDown.noteAppended, false, 'inject 送达时不该再往 note 追加')
  eq(prev.sent.length, 1, '前任应正好收到一条 inject')
  eq(prev.sent[0].mode, 'inject', '必须走 inject（只塞上下文、不唤醒、不跑模型）')
  const notice = prev.sent[0].payload.content[0].text
  ok(notice.includes('域交接通知'), `停机通知应带「域交接通知」标题: ${notice}`)
  ok(notice.includes('你已不再是'), `停机通知应说清「你已经不是负责人了」: ${notice}`)
  ok(notice.includes('misas:asr'), '停机通知应写明是哪个域')
  eq(prev.sent[0].payload.source.kind, 'dsh-domain-bridge', "source.kind 不能是 'plugin'（会让接收方下一轮直接失败）")
  eq(prev.sent[0].payload.role, 'user', '停机通知必须是完整 v4 用户消息')
  eq(titles.calls.rename.length, 1, '标题仍要标退役')
  ok(titles.calls.rename[0].title.startsWith('（已退役）'), '退役标记必须前置')
  ok(out.hint.includes('停机通知'), 'hint 应说明停机通知已发')
  ok(!JSON.parse(fs.readFileSync(book, 'utf8')).owners['misas:asr'].note.includes('[停机通知未送达]'), 'inject 送达时 note 不该有未送达留痕')
}

{
  // ⑦ force 交接 + 前任离线 => note 里留下停机通知记录，standDown.delivered='note-only'。
  const book = bookFile('v036-handover-offline', { 'misas:asr': owner('misas', 'asr', ID.A, { note: '老账' }) })
  const out = await call(
    mount({ domainsFile: book, get: () => undefined }),
    'claim_domain',
    { domain: 'asr', force: true },
    { agent: sender },
    'v036/handover-predecessor-offline',
  )
  eq(out.standDown.delivered, 'note-only', '前任离线时应 note-only')
  eq(out.standDown.reason, 'predecessor-offline', 'reason 应为 predecessor-offline')
  eq(out.standDown.noteAppended, true, '应把留痕写进新声明 note')
  ok(out.owner.note.includes('[停机通知未送达]'), '回执 owner.note 应含停机通知留痕')
  ok(out.owner.note.includes('前任当前不在线'), '留痕应写清未送达原因')
  const written = JSON.parse(fs.readFileSync(book, 'utf8')).owners['misas:asr'].note
  ok(written.includes(`接手自 ${ID.A}`), '原交接留痕应保留（追加而不是覆盖）')
  ok(written.includes('[停机通知未送达]'), '文件里的 note 应含停机通知留痕')
  ok(written.indexOf(`接手自 ${ID.A}`) < written.indexOf('[停机通知未送达]'), '停机通知留痕应追加在交接留痕之后')
}

{
  // ⑧ inArchive：索引读得到 => 给布尔；读不到 => 给 null 并说明（两种 fake 各测一次）。
  const book = bookFile('v036-in-archive', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const known = await call(
    mount({ domainsFile: book }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x', dryRun: true },
    createExec,
    'v036/in-archive-known',
  )
  eq(known.existingOwner.inArchive, true, 'ID.B 在索引里 => inArchive 应为 true')
  eq(known.existingOwner.inArchiveSource, 'index', 'inArchiveSource 应为 index')

  const other = bookFile('v036-in-archive-miss', { 'misas:asr': owner('misas', 'asr', ID.C) })
  const missing = await call(
    mount({ domainsFile: other, indexFile: path.join(root, 'no-such-dir', 'registry.json') }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x', dryRun: true },
    createExec,
    'v036/in-archive-unreadable',
  )
  eq(missing.existingOwner.inArchive, null, '索引读不到时 inArchive 应为 null（不知道，不猜）')
  eq(missing.existingOwner.inArchiveSource, 'index-unavailable', 'inArchiveSource 应标注不可用')
  ok(typeof missing.existingOwner.inArchiveReason === 'string', '拿不到时必须在回执里说明')
}

{
  // ⑦b force 交接 + 前任在线但 inject 抛错 => delivered='failed'，仍写 note 留痕（降级不静默）。
  const book = bookFile('v036-handover-inject-throws', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const prev = makeAgent(ID.A, { throwOn: 'inject' })
  const out = await call(
    mount({ domainsFile: book, get: (id) => (id === ID.A ? prev : sender) }),
    'claim_domain',
    { domain: 'asr', force: true },
    { agent: sender },
    'v036/handover-inject-throws',
  )
  eq(prev.sent.length, 1, 'inject 被尝试过一次')
  eq(out.standDown.delivered, 'failed', 'inject 抛错应报 failed')
  eq(out.standDown.reason, 'inject-failed', 'reason 应为 inject-failed')
  ok(out.standDown.error.includes('exploded'), 'error 应带服务原话')
  eq(out.standDown.noteAppended, true, 'failed 也要写 note 留痕')
  ok(out.hint.includes('发停机通知失败'), 'hint 应如实说停机通知失败')
}

// ---------------- 11. v0.4.0: 域级「已暂停」（两个轴 + 生命周期，scope=domain）
//
// 模型：事实轴（在线/离线，宿主给）+ 政策轴（活动/已暂停，人给，字段 paused）+ 生命周期（在用/已终结）。
// 对外一律派生状态：在线·活动 / 在线·已暂停 / 离线·活动 / 离线·已暂停 / 已终结。
// 本段全部用**每个 mount 自己的临时 stateDir**：绝不碰插件真实的 state/ 目录。

/**
 * bridge.js 里 safeKeyName()/stateFileName() 的镜像：把 (key, scope) 变成落盘文件名。
 * v0.4.2：域级沿用 `k-<flat>-<sha1>`；其余三级加 scope 前缀（一 scope 一键一文件）。
 * scope 不给时按键形状判（与 bridge.js 的 queueScopeOf 同一口径）：`session-…` ⇒ session。
 */
function safeName(key, scope) {
  const raw = String(key).toLowerCase().trim()
  const flat = raw
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 60)
  const base = 'k-' + (flat || 'domain') + '-' + createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 8)
  const real = scope === undefined ? (/^session-/.test(raw) ? 'session' : 'domain') : scope
  return real === 'domain' ? base : `${real}-${base}`
}

function statePath(stateDir, key, scope) {
  return path.join(stateDir, 'domains', safeName(key, scope) + '.json')
}

function queuePath(stateDir, key, scope) {
  return path.join(stateDir, 'inbox', safeName(key, scope) + '.jsonl')
}

/** 读状态记录（不存在 => null）。 */
function readState(stateDir, key, scope) {
  const file = statePath(stateDir, key, scope)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

/** 读队列（JSONL，一行一条）。 */
function readQueue(stateDir, key, scope) {
  const file = queuePath(stateDir, key, scope)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

/** 被暂停的域：册子里有在任声明 + 状态记录 paused:true（一律经 set_domain_state 落下，不打洞）。 */
async function pauseDomain(book, stateDir, key, label, agents) {
  return call(
    mount({ domainsFile: book, stateDir, agents: agents || [] }),
    'set_domain_state',
    { domain: key, state: 'paused', note: `${label} 按下` },
    { agent: sender },
    `${label}/pause`,
  )
}

// ---------------- 11b. v0.4.1: 拉活接线的假服务（agentDefaultModel / sessionQuery / agentPresets）

/** 假的 agentCtx：只记录 setup 里按事件名注册了哪些 waterfall（真实核心会在 resume 时回调 setup）。 */
function wakeAgentCtx() {
  const listeners = []
  return {
    listeners,
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
  }
}

/**
 * 假的 agents 服务：与宿主一样 —— **真的调用 `request.setup(agentCtx, agent)`**，然后把会话标成 live。
 * `state` 就是各用例自己的记账本：`{live, resumed, agentCtx, failResume, stayOffline}`。
 */
function wakeAgentsService(state) {
  return {
    list: () => state.live.slice(),
    get: (id) => state.live.find((agent) => agent.id === id),
    async resume(request) {
      state.resumed.push(request)
      if (state.failResume) throw new Error(state.failResume)
      if (typeof request.setup === 'function') {
        state.agentCtx = wakeAgentCtx()
        await request.setup(state.agentCtx, makeAgent(request.resumeSessionId))
      }
      // stayOffline: 拉活"看起来成功"但会话根本没进 agents.get（模拟 resumed-but-no-agent）。
      if (state.stayOffline !== true) state.live.push(makeAgent(request.resumeSessionId))
    },
  }
}

/** 假的全局默认模型服务（`ctx.agentDefaultModel.currentSelection()`）。 */
function fakeDefaultModel(provider, model) {
  return { currentSelection: () => ({ provider, model }) }
}

/** 假的存档服务：只实现 `readSession`，事件形状与 agent-loop 写的 `request/header` 一致。 */
function fakeSessionQuery({ config, presetId, raw }) {
  const events = raw !== undefined ? raw : config ? [{ type: 'request/header', data: { header: { config } } }] : []
  return {
    async readSession() {
      return { session: { id: 'archived', agentPreset: presetId }, inheritedEventCount: 0, events }
    },
  }
}

/** 假的 agent preset 服务：记下 resolve/mount 的调用（宿主在 resume 前就是这么挂回去的）。 */
function fakeAgentPresets(resolvedId) {
  const calls = { resolve: [], mount: [] }
  return {
    calls,
    async resolve(presetId) {
      calls.resolve.push(presetId)
      return { id: resolvedId ?? presetId }
    },
    async mount(ctx, presetId) {
      calls.mount.push({ ctx, presetId })
    },
  }
}

{
  // ① 按下暂停：写状态记录 + 回执给派生状态与「谁在何时按下的」；幂等；非法 state；没声明；短名解析。
  const book = bookFile('v040-pause', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const stateDir = path.join(root, 'state-v040-pause')
  const out = await call(
    mount({ domainsFile: book, stateDir, agents: [] }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'paused', note: '用户在 2026-10-13 拍板暂停' },
    { agent: sender },
    'v040/pause',
  )
  eq(out.action, 'set_domain_state', 'action 不对')
  eq(out.outcome, 'paused', 'outcome 应为 paused')
  eq(out.wanted, 'paused', 'wanted 不对')
  eq(out.key, 'misas:asr', 'key 不对')
  eq(out.scope, 'domain', '本轮作用域必须是 domain')
  eq(out.paused, true, 'paused 应为 true')
  eq(out.state, '离线·已暂停', '派生状态应为 离线·已暂停（负责人 ID.A 不在线）')
  eq(out.previousState, '离线·活动', 'previousState 应为 离线·活动')
  eq(out.pausedBy, ID.S, 'pausedBy 应是按下的人')
  ok(typeof out.pausedAt === 'string' && out.pausedAt.length > 0, 'pausedAt 必须记下时间')
  eq(out.pauseNote, '用户在 2026-10-13 拍板暂停', 'pauseNote 应原样落盘')
  eq(out.wrote, true, '应写盘')
  eq(out.drain, null, '暂停不该触发重投')
  ok(out.hint.includes('已按下暂停'), 'hint 应说清已按下暂停')
  ok(out.hint.includes(SHORT.S), 'hint 应写明是谁按下的')
  ok(out.hint.includes('插件拦不住'), 'hint 必须写明边界：插件只管插件介导的路径')
  const rec = readState(stateDir, 'misas:asr')
  eq(rec.scope, 'domain', '状态记录的 scope 必须是 domain')
  eq(rec.key, 'misas:asr', '状态记录应带 key')
  eq(rec.paused, true, '状态记录 paused 应为 true')
  eq(rec.pausedBy, ID.S, '状态记录应记 pausedBy')
  eq(rec.note, '用户在 2026-10-13 拍板暂停', '状态记录应记 note')

  // 幂等：本来就是这个状态 ⇒ 不重复写。
  const again = await call(
    mount({ domainsFile: book, stateDir }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'paused' },
    { agent: sender },
    'v040/pause-again',
  )
  eq(again.outcome, 'already-paused', '重复暂停应 already-paused（幂等）')
  eq(again.wrote, false, 'already-paused 不该再写盘')

  // 非法 state：明确报错，不猜。
  const bad = await call(
    mount({ domainsFile: book, stateDir }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'wat' },
    { agent: sender },
    'v040/pause-invalid-state',
  )
  eq(bad.outcome, 'invalid', '非法 state 应 invalid')
  eq(bad.reason, 'invalid-state', 'reason 应为 invalid-state')
  ok(bad.hint.includes('paused'), 'hint 应说明合法取值')

  // dryRun：只回报、不写。
  const dry = await call(
    mount({ domainsFile: book, stateDir }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'paused', dryRun: true },
    { agent: sender },
    'v040/pause-dry-run',
  )
  eq(dry.outcome, 'would-pause', 'dryRun 应报 would-pause')
  eq(dry.dryRun, true, 'dryRun 应回显')
  eq(dry.alreadyInThatState, true, 'dryRun 应指出"本来就是这个状态"')

  // 没有在任声明 ⇒ 没有可暂停的域（域级暂停挂在声明册的一个 key 上）。
  const empty = await call(
    mount({ domainsFile: bookFile('v040-pause-freed', {}), stateDir: path.join(root, 'state-v040-pause-free') }),
    'set_domain_state',
    { domain: 'misas:nope', state: 'paused' },
    { agent: sender },
    'v040/pause-no-declaration',
  )
  eq(empty.outcome, 'no-declaration', '没有在任声明应 no-declaration')
  ok(empty.hint.includes('claim_domain'), 'hint 应给出补救办法')

  // 短名解析：唯一同名声明 ⇒ 用册子里的那个 key（**不**按本会话 cwd 猜项目）。
  const shortBook = bookFile('v040-pause-short', { 'other:docs': owner('other', 'docs', ID.A) })
  const byShort = await call(
    mount({ domainsFile: shortBook, stateDir: path.join(root, 'state-v040-pause-short') }),
    'set_domain_state',
    { domain: 'docs', state: 'paused' },
    { agent: makeAgent(ID.C, { cwd: path.join(FIXTURE_PROJECTS, 'somewhere-else') }) },
    'v040/pause-by-short-name',
  )
  eq(byShort.key, 'other:docs', '短名应命中册子里唯一的那条声明，而不是拿 cwd 拼一个 key')
  eq(byShort.projectFrom, '域名册里的唯一同名声明', 'projectFrom 应说明来源')

  // 同名多条 ⇒ 不猜，要求完整写法。
  const ambBook = bookFile('v040-pause-amb', {
    'a:asr': owner('a', 'asr', ID.A),
    'b:asr': owner('b', 'asr', ID.B),
  })
  const amb = await call(
    mount({ domainsFile: ambBook, stateDir: path.join(root, 'state-v040-pause-amb') }),
    'set_domain_state',
    { domain: 'asr', state: 'paused' },
    { agent: sender },
    'v040/pause-ambiguous-short-name',
  )
  eq(amb.outcome, 'invalid', '同名多条应 invalid')
  ok(amb.reason.includes('同名域'), 'reason 应说清同名域')
  eq(amb.candidates, ['a:asr', 'b:asr'], '应列出候选 key')
}

{
  // ② 暂停期间 send_to_domain：**不投递**、落盘入队、回执明说"已暂停（谁何时按下）+ 已入队可撤回"；
  //    **绝不**笼统报 unreachable，**绝不**静默降级有人顶上；会话 id 寻址也绕不开。
  const book = bookFile('v040-send', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const stateDir = path.join(root, 'state-v040-send')
  await pauseDomain(book, stateDir, 'misas:asr', 'v040-send', [])

  const bystander = makeAgent(ID.C) // 索引标注恰好是这个域、且在线的人（暂停时绝不能"顶上"）
  const out = await call(
    mount({ domainsFile: book, stateDir, agents: [bystander] }),
    'send_to_domain',
    { target: 'misas:asr', message: '你好，这是被暂停期间的消息', replyTo: 'r1' },
    { agent: sender },
    'v040/send-paused-queued',
  )
  eq(out.delivered, false, '暂停期间绝不投递')
  eq(out.queued, true, '应落盘入队')
  eq(out.reason, 'domain-paused', 'reason 应是固定枚举 domain-paused')
  eq(out.domain, 'misas:asr', '应写清是哪个域被暂停')
  eq(out.scope, 'domain', '作用域应为 domain')
  eq(out.derivedState, '离线·已暂停', '回执必须带派生状态')
  eq(out.paused, true, '回执应明说已暂停')
  eq(out.pausedBy, ID.S, '回执应写明是谁按下的')
  ok(typeof out.pausedAt === 'string', '回执应写明何时按下的')
  eq(out.matchedBy, 'declaration', '应按声明解析')
  eq(out.queue.status, 'pending', '队列记录应为 pending')
  eq(out.queue.pending, 1, 'pending 计数应为 1')
  eq(out.queue.withdrawable, true, '应标明可撤回')
  eq(out.queue.withdrawTool, 'withdraw_domain_message', '应给出撤回入口')
  ok(typeof out.queue.id === 'string' && out.queue.id.length > 0, '应给出队列 id')
  ok(out.hint.includes('已暂停'), 'hint 应说清"该域已暂停"')
  ok(out.hint.includes('没有投递'), 'hint 应说清"没有投递"')
  ok(out.hint.includes('入队'), 'hint 应说清"已入队"')
  ok(out.hint.includes('可撤回'), 'hint 应说清"可撤回"')
  ok(out.hint.includes('找人顶上'), 'hint 应说清"没有替你找人顶上"')
  ok(out.hint.includes(SHORT.S) && out.hint.includes(out.pausedAt), 'hint 应含"谁在何时按下的"')
  eq(bystander.sent.length, 0, '暂停期间绝不能给任何会话投任何东西（不许静默找人顶上）')

  const queue = readQueue(stateDir, 'misas:asr')
  eq(queue.length, 1, '队列文件应有一条')
  eq(queue[0].id, out.queue.id, '队列 id 应与回执一致')
  eq(queue[0].status, 'pending', '队列记录状态应为 pending')
  eq(queue[0].from, ID.S, '队列记录应记发件会话')
  eq(queue[0].mode, 'followup', '队列记录应冻结当时的 mode')
  eq(queue[0].key, 'misas:asr', '队列记录应带域 key')
  ok(queue[0].content.includes('你好，这是被暂停期间的消息'), '队列应冻结完整信封正文')
  ok(queue[0].content.includes('target=r1'), '信封里的 replyTo 也应被冻结')

  // 第二次发送（换 mode）⇒ pending 累加，mode 各自冻结。
  const second = await call(
    mount({ domainsFile: book, stateDir, agents: [bystander] }),
    'send_to_domain',
    { target: 'asr', message: '第二条', mode: 'inject' },
    { agent: sender },
    'v040/send-paused-second',
  )
  eq(second.queued, true, '第二条也应入队')
  eq(second.queue.pending, 2, 'pending 应累加到 2')
  eq(second.queue.mode, 'inject', '第二条的 mode 应记 inject')
  eq(bystander.sent.length, 0, '第二条也不许投递')

  // dryRun：只回报，不写队列。
  const dry = await call(
    mount({ domainsFile: book, stateDir, agents: [bystander] }),
    'send_to_domain',
    { target: 'misas:asr', message: '演练', dryRun: true },
    { agent: sender },
    'v040/send-paused-dry-run',
  )
  eq(dry.dryRun, true, 'dryRun 应回显')
  eq(dry.queued, false, 'dryRun 绝不入队')
  eq(dry.wouldQueue.mode, 'followup', 'dryRun 应展示会入队的 mode')
  eq(dry.wouldQueue.withdrawable, true, 'dryRun 应展示可撤回')
  eq(readQueue(stateDir, 'misas:asr').length, 2, 'dryRun 不得写队列')

  // 用**会话 id** 直投这个被暂停域的负责人：一样拦（否则就是绕开暂停）。
  const bySessionId = await call(
    mount({ domainsFile: book, stateDir, agents: [makeAgent(ID.A)] }),
    'send_to_domain',
    { target: ID.A, message: '绕过试试' },
    { agent: sender },
    'v040/send-paused-by-session-id',
  )
  eq(bySessionId.queued, true, '按会话 id 也要拦住')
  eq(bySessionId.reason, 'domain-paused', 'reason 仍应是 domain-paused')
  eq(bySessionId.matchedBy, 'session-id-holds-paused-domain', '应标明"这条会话持有被暂停的域"')
  eq(bySessionId.derivedState, '在线·已暂停', '负责人这次在线 ⇒ 派生状态应为 在线·已暂停')
  // v0.4.2（S5 冻结口径）：入队键＝**被投递目标自身的键** ⇒ 这条按会话 id 投的，落在会话键自己的队列里；
  // 原来的域键队列（2 条 pending）**不许被顺手塞进来**。
  eq(bySessionId.queue.key, ID.A, '按会话 id 投 ⇒ 入队键应是被投递目标自身（会话 id）')
  eq(bySessionId.queue.scope, 'session', '会话键的队列 scope 应为 session')
  eq(bySessionId.queue.pending, 1, '会话键队列里应只有这一条 pending')
  eq(readQueue(stateDir, ID.A).length, 1, '会话键的队列文件应真的写好一条')
  eq(readQueue(stateDir, 'misas:asr').filter((r) => r.status === 'pending').length, 2, '域键队列仍是原来那 2 条（S5：不按 scope 混装）')
}

{
  // ③ 暂停期间 create_domain_session：直接拒绝，**宿主 create 一次都不许调**（dryRun 也一样）。
  const book = bookFile('v040-create', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const stateDir = path.join(root, 'state-v040-create')
  await pauseDomain(book, stateDir, 'misas:asr', 'v040-create', [])

  const controller = createSpy([{ sessionId: ID.C }])
  const out = await call(
    mount({ domainsFile: book, stateDir, controller, agents: [makeAgent(ID.A)] }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x' },
    createExec,
    'v040/create-refused',
  )
  eq(controller.requests.length, 0, '暂停时绝不能调用宿主 create')
  eq(out.created, false, 'created 应为 false')
  eq(out.reason, 'domain-paused', 'reason 应是固定枚举 domain-paused')
  eq(out.domain, 'misas:asr', '应写清是哪个域')
  eq(out.scope, 'domain', '作用域应为 domain')
  eq(out.derivedState, '在线·已暂停', '应给派生状态')
  eq(out.paused, true, '应明说已暂停')
  eq(out.pausedBy, ID.S, '应写明是谁按下的')
  ok(out.hint.includes('没有新建任何会话'), 'hint 应说清"没有新建任何会话"')
  ok(out.hint.includes('set_domain_state'), 'hint 应给出恢复办法')

  const dry = await call(
    mount({ domainsFile: book, stateDir, controller, agents: [makeAgent(ID.A)] }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x', dryRun: true },
    createExec,
    'v040/create-refused-dry-run',
  )
  eq(controller.requests.length, 0, 'dryRun 拒绝路径也不得调 create')
  eq(dry.refused, true, 'dryRun 应报告"会被拒绝"')
  eq(dry.dryRun, true, 'dryRun 应回显')
  ok(!('wouldCreate' in dry), '被暂停拒绝的 dryRun 不该给 wouldCreate')

  // 恢复之后可以正常建（回归：暂停一解除，v0.3.6 的闸就回到原样）。
  const resumed = await call(
    mount({ domainsFile: book, stateDir, agents: [makeAgent(ID.A)] }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'active' },
    { agent: sender },
    'v040/create-resume-before-build',
  )
  eq(resumed.outcome, 'resumed', '应恢复成功')
  const after = await call(
    mount({ domainsFile: book, stateDir, controller, agents: [makeAgent(ID.A)], get: () => makeAgent(ID.C) }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x', allowExistingOwner: true },
    createExec,
    'v040/create-after-resume',
  )
  eq(controller.requests.length, 1, '恢复后应照常建会话')
  eq(after.created, true, '恢复后应 created:true')
}

{
  // ④ wake：暂停期间不许把该域拉活（probe 档也不许）；显式 force=true 才放行。
  //    v0.4.1：force 放行的是「暂停」这条政策，**不是**「拉活接线」那道安全门 —— 放行之后照样
  //    得把线接好（这里给假 agentDefaultModel），并如实报 wakeWiring。
  const book = bookFile('v040-wake', { 'misas:asr': owner('misas', 'asr', ID.X2) })
  const stateDir = path.join(root, 'state-v040-wake')
  await pauseDomain(book, stateDir, 'misas:asr', 'v040-wake', [])

  const wake = { live: [], resumed: [] }
  const agentsService = wakeAgentsService(wake)
  const mountWake = () =>
    mount({
      domainsFile: book,
      stateDir,
      agentsService,
      agentDefaultModel: fakeDefaultModel('commandcode', 'deepseek/deepseek-v4.1-flash'),
    })
  const blocked = await call(
    mountWake(),
    'send_to_domain',
    { target: 'misas:asr', message: 'hi', wake: 'true' },
    { agent: sender },
    'v040/wake-blocked',
  )
  eq(wake.resumed.length, 0, '暂停期间绝不许拉活')
  eq(blocked.wakeBlocked, 'domain-paused', 'wakeBlocked 应标 domain-paused')
  eq(blocked.delivered, false, '也不许投递')
  eq(blocked.queued, true, '仍然入队')
  eq(blocked.derivedState, '离线·已暂停', '派生状态应为 离线·已暂停')

  const probe = await call(
    mountWake(),
    'send_to_domain',
    { target: 'misas:asr', message: 'hi', wake: 'probe' },
    { agent: sender },
    'v040/wake-blocked-probe',
  )
  eq(probe.probe, true, '仍是探测档回报')
  eq(probe.queued, false, '探测档从不投递/入队')
  eq(probe.wakeBlocked, 'domain-paused', '探测档也要标明被暂停拦住')
  eq(probe.woke.attempted, false, '探测档不得尝试 resume')
  eq(probe.woke.reason, 'domain-paused', 'woke.reason 应如实说被暂停拦住')
  eq(wake.resumed.length, 0, '探测档也不许拉活')
  eq(
    probe.wakeWiring,
    { agentOptions: 'none', setup: 'skipped', setupError: null },
    'v0.4.1：probe 回执也必须带 wakeWiring（这次一个都没接）',
  )

  const forced = await call(
    mountWake(),
    'send_to_domain',
    { target: 'misas:asr', message: 'hi', wake: 'true', force: true },
    { agent: sender },
    'v040/wake-forced',
  )
  eq(wake.resumed.length, 1, 'force=true 才允许拉活')
  eq(wake.resumed[0].resumeSessionId, ID.X2, '拉活的必须是声明里的 sessionId')
  eq(
    wake.resumed[0].agentOptions,
    { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
    'v0.4.1：拉活必须带上 agentOptions（裸 resume 就是 {{model}} 那个坑）',
  )
  ok(typeof wake.resumed[0].setup === 'function', 'v0.4.1：拉活应带上 setup（装模型选择 + 挂 preset）')
  eq(
    forced.woke.wakeWiring,
    { agentOptions: 'ctx.agentDefaultModel', setup: 'applied', setupError: null },
    '回执必须报明用了哪条路（agentOptions 取源 + setup 走到哪一步）',
  )
  eq(
    wake.agentCtx.listeners.map((item) => item.event).sort(),
    ['agent/request', 'system-prompt/assemble'],
    'setup 装模型选择＝复刻宿主那两条 waterfall',
  )
  eq(forced.delivered, true, 'force 后应照常投递')
  eq(forced.pausedOverride, true, '回执必须标注这是一次显式放行')
  eq(forced.pausedOverrideDomain, 'misas:asr', '应写明是哪个域的放行')
  ok(!('queued' in forced), 'force 放行不得再入队')
  eq(readQueue(stateDir, 'misas:asr').filter((r) => r.status === 'pending').length, 1, '只有前面被拦下的那条还在队列里')
}

{
  // ⑤ 暂停期间 claim / release **照常允许**（换人 / 退役 ≠ 解暂停），回执提示"仍处已暂停"；
  //    release 还写下生命周期墓碑 ⇒ 派生状态 已终结。
  const book = bookFile('v040-claim', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const stateDir = path.join(root, 'state-v040-claim')
  await pauseDomain(book, stateDir, 'misas:asr', 'v040-claim', [makeAgent(ID.B)])

  const out = await call(
    mount({ domainsFile: book, stateDir, agents: [makeAgent(ID.B)] }),
    'claim_domain',
    { domain: 'asr', force: true },
    { agent: sender },
    'v040/claim-while-paused',
  )
  eq(out.outcome, 'handover', '暂停不影响交接')
  eq(out.paused, true, '回执应带 paused')
  eq(out.pausedBy, ID.S, '回执应写明是谁按下的')
  ok(out.hint.includes('仍处已暂停'), 'hint 必须提示"该域仍处已暂停"')
  ok(out.hint.includes('解暂停'), 'hint 应说清换人 ≠ 解暂停')
  ok(out.hint.includes('set_domain_state'), 'hint 应给出恢复办法')
  eq(readState(stateDir, 'misas:asr').paused, true, '交接不得解除暂停')
  eq(JSON.parse(fs.readFileSync(book, 'utf8')).owners['misas:asr'].sessionId, ID.S, '交接后负责人应是本会话')

  const rel = await call(
    mount({ domainsFile: book, stateDir, agents: [makeAgent(ID.S)] }),
    'release_domain',
    { domain: 'asr' },
    { agent: sender },
    'v040/release-while-paused',
  )
  eq(rel.outcome, 'released', '暂停不影响释放')
  eq(rel.derivedState, '已终结', '释放即生命周期终结')
  eq(rel.scope, 'domain', '作用域应为 domain')
  eq(rel.lifecycle.ok, true, '应写下生命周期墓碑')
  eq(rel.lifecycle.terminatedBy, ID.S, '墓碑应记谁终结的')
  ok(rel.lifecycle.terminatedAt.length > 0, '墓碑应记终结时间')
  ok(rel.hint.includes('已终结'), 'hint 应说明派生状态')
  ok(rel.hint.includes('已暂停'), 'hint 应保留"终结时仍处已暂停"这一笔')
  eq(readState(stateDir, 'misas:asr').terminatedAt, rel.lifecycle.terminatedAt, '墓碑时间应与回执一致')
  eq(JSON.parse(fs.readFileSync(book, 'utf8')).owners, {}, '域名册应被释放')
}

{
  // ⑥ 撤回：自己发的可撤；别人的不可撤（force 才可）；已 delivered 的不可撤；未知 id 报 not-found。
  const book = bookFile('v040-withdraw', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const stateDir = path.join(root, 'state-v040-withdraw')
  await pauseDomain(book, stateDir, 'misas:asr', 'v040-withdraw', [])

  const mine = await call(
    mount({ domainsFile: book, stateDir }),
    'send_to_domain',
    { target: 'misas:asr', message: '我自己发的' },
    { agent: sender },
    'v040/withdraw-send-mine',
  )
  const other = makeAgent(ID.C)
  const theirs = await call(
    mount({ domainsFile: book, stateDir }),
    'send_to_domain',
    { target: 'misas:asr', message: '别人发的' },
    { agent: other },
    'v040/withdraw-send-theirs',
  )

  const invalid = await call(
    mount({ domainsFile: book, stateDir }),
    'withdraw_domain_message',
    {},
    { agent: sender },
    'v040/withdraw-missing-id',
  )
  eq(invalid.action, 'withdraw', 'action 不对')
  eq(invalid.outcome, 'invalid', '缺 id 应 invalid')
  eq(invalid.reason, 'missing-id', 'reason 应为 missing-id')

  const notFound = await call(
    mount({ domainsFile: book, stateDir }),
    'withdraw_domain_message',
    { id: 'no-such-id' },
    { agent: sender },
    'v040/withdraw-not-found',
  )
  eq(notFound.outcome, 'not-found', '未知 id 应 not-found')
  eq(notFound.queuedKeys, ['misas:asr'], '应回报扫到的队列 key')

  const notOwner = await call(
    mount({ domainsFile: book, stateDir }),
    'withdraw_domain_message',
    { id: theirs.queue.id },
    { agent: sender },
    'v040/withdraw-not-owner',
  )
  eq(notOwner.outcome, 'not-owner', '别人发的不许撤（默认）')
  eq(notOwner.from, ID.C, '应回报真正的发件人')
  eq(notOwner.status, 'pending', '原记录应仍是 pending')
  ok(notOwner.hint.includes('force=true'), 'hint 应给出强制撤回的办法')
  eq(readQueue(stateDir, 'misas:asr').find((r) => r.id === theirs.queue.id).status, 'pending', '没撤回就不得改状态')

  const forced = await call(
    mount({ domainsFile: book, stateDir }),
    'withdraw_domain_message',
    { id: theirs.queue.id, force: true },
    { agent: sender },
    'v040/withdraw-forced',
  )
  eq(forced.outcome, 'withdrawn', 'force 应能撤回别人的')
  eq(forced.forced, true, '回执必须标注这是一次强制撤回')
  eq(forced.status, 'withdrawn', 'status 应为 withdrawn')
  eq(forced.withdrawnBy, ID.S, '应记谁撤的')

  const own = await call(
    mount({ domainsFile: book, stateDir }),
    'withdraw_domain_message',
    { id: mine.queue.id, domain: 'misas:asr' },
    { agent: sender },
    'v040/withdraw-own',
  )
  eq(own.outcome, 'withdrawn', '自己发的默认可撤')
  eq(own.forced, false, '自己发的不算强制')
  eq(own.key, 'misas:asr', 'key 不对')
  eq(own.scope, 'domain', '作用域应为 domain')
  eq(own.pending, 0, '撤完 pending 应为 0')
  eq(own.queuedTotal, 2, '两条都应留在文件里当留痕（不删行）')
  ok(typeof own.messagePreview === 'string', '应给消息预览')

  const repeated = await call(
    mount({ domainsFile: book, stateDir }),
    'withdraw_domain_message',
    { id: mine.queue.id },
    { agent: sender },
    'v040/withdraw-already-withdrawn',
  )
  eq(repeated.outcome, 'not-pending', '已撤回的不许再撤')
  eq(repeated.status, 'withdrawn', '应如实回报当前状态')

  const filtered = await call(
    mount({ domainsFile: book, stateDir }),
    'withdraw_domain_message',
    { id: mine.queue.id, domain: 'other:gui' },
    { agent: sender },
    'v040/withdraw-other-domain-filter',
  )
  eq(filtered.outcome, 'not-found', 'domain 过滤到别的域应是 not-found')

  const queue = readQueue(stateDir, 'misas:asr')
  eq(queue.length, 2, '撤回不得删行')
  eq(queue.map((r) => r.status), ['withdrawn', 'withdrawn'], '两条都应是 withdrawn')
  ok(queue.every((r) => r.withdrawnAt !== null), '应记撤回时间')
}

{
  // ⑦ 恢复（人手动唤起）：把队列里的 pending 按**原 mode** 重投。三条路径：
  //    a) 目标在线 ⇒ delivered（v4 形状 + 原 mode 一律保留）
  //    b) 目标离线 ⇒ **保留 pending**，且**绝不自己去 resume**（{{model}} 坑）
  //    c) 投递出口失败（无该方法）⇒ failed（不假装成功）
  const stateDir = path.join(root, 'state-v040-drain')

  // (a) 在线
  const bookA = bookFile('v040-drain-online', { 'misas:asr': owner('misas', 'asr', ID.A) })
  await pauseDomain(bookA, stateDir, 'misas:asr', 'v040-drain-online', [])
  await call(
    mount({ domainsFile: bookA, stateDir }),
    'send_to_domain',
    { target: 'misas:asr', message: '甲（inject）', mode: 'inject', replyTo: 'rk' },
    { agent: sender },
    'v040/drain-queue-inject',
  )
  await call(
    mount({ domainsFile: bookA, stateDir }),
    'send_to_domain',
    { target: 'misas:asr', message: '乙（followup）' },
    { agent: sender },
    'v040/drain-queue-followup',
  )
  eq(readQueue(stateDir, 'misas:asr').length, 2, '应入队两条')

  const ownerAgent = makeAgent(ID.A)
  const resumed = await call(
    mount({ domainsFile: bookA, stateDir, agents: [ownerAgent], get: (id) => (id === ID.A ? ownerAgent : undefined) }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'active' },
    { agent: sender },
    'v040/drain-owner-online',
  )
  eq(resumed.outcome, 'resumed', '应恢复成功')
  eq(resumed.state, '在线·活动', '派生状态应回到 在线·活动')
  eq(resumed.previousState, '在线·已暂停', '应记下恢复前的派生状态')
  eq(resumed.paused, false, 'paused 应为 false')
  eq(resumed.pausedBy, ID.S, 'pausedBy 保留为历史（谁按下的）')
  eq(resumed.drain.reason, 'delivered', '重投应全部成功')
  eq(resumed.drain.delivered.length, 2, '应投出两条')
  eq(resumed.drain.stillPending.length, 0, '不该有残留 pending')
  eq(ownerAgent.sent.length, 2, '在线目标应收到两条')
  eq(ownerAgent.sent.map((s) => s.mode), ['inject', 'followup'], '必须按**原 mode** 重投')
  const payload = ownerAgent.sent[1].payload
  eq(Object.keys(payload).sort(), ['content', 'id', 'role', 'source'], '重投的 v4 消息形状不得变')
  eq(payload.role, 'user', 'role 应为 user')
  eq(payload.source, { kind: 'dsh-domain-bridge', senderSessionId: ID.S }, 'source.kind 必须仍是本插件名（绝不能是 plugin）')
  ok(payload.content[0].text.includes('乙（followup）'), '正文应是入队时冻结的那一份')
  ok(payload.content[0].text.includes('【域间消息'), '应保留信封标题栏')
  ok(
    ownerAgent.sent[0].payload.content[0].text.includes('target=rk'),
    'replyTo 也应逐字重放（第一条入队时冻结过 rk）',
  )
  const drained = readQueue(stateDir, 'misas:asr')
  eq(drained.map((r) => r.status), ['delivered', 'delivered'], '两条都应标 delivered')
  ok(drained.every((r) => typeof r.deliveredAt === 'string'), '应记投递时间')

  const again = await call(
    mount({ domainsFile: bookA, stateDir, agents: [owner] }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'active' },
    { agent: sender },
    'v040/drain-again',
  )
  eq(again.outcome, 'already-active', '本来就是活动应 already-active')
  eq(again.wrote, false, 'already-active 不该写状态')
  eq(again.drain.reason, 'nothing-pending', '没有 pending 时重投应报 nothing-pending')

  // (b) 离线 ⇒ **允许尝试唤醒**（v0.4.1 起）。四条路：
  //     b1 唤得起来 ⇒ 按队列原 mode 重投（delivered）
  //     b2 唤不起来（resume 抛错）⇒ **保留 pending** 并如实回报
  //     b3 没接线 + 队列里有要跑回合的档 ⇒ **拒绝裸拉**（no-wake-wiring，一次 resume 都不调）
  //     b4 队列里只有 inject + 没接线 ⇒ 放行拉活（不跑回合，不会碰到 {{model}} 那个坑）
  const offlineStateDir = path.join(root, 'state-v040-drain-offline')
  const bookB = bookFile('v040-drain-offline', { 'misas:asr': owner('misas', 'asr', ID.X2) })
  await pauseDomain(bookB, offlineStateDir, 'misas:asr', 'v040-drain-offline', [])
  await call(
    mount({ domainsFile: bookB, stateDir: offlineStateDir }),
    'send_to_domain',
    { target: 'misas:asr', message: '给离线的' },
    { agent: sender },
    'v040/drain-offline-queue',
  )
  const offlineQueue = readQueue(offlineStateDir, 'misas:asr')
  eq(offlineQueue[0].status, 'pending', '入队时应是 pending')

  // b1 唤得起来 ⇒ 重投
  const wakeOk = { live: [], resumed: [] }
  const offline = await call(
    mount({
      domainsFile: bookB,
      stateDir: offlineStateDir,
      agentsService: wakeAgentsService(wakeOk),
      agentDefaultModel: fakeDefaultModel('pc', 'm-1'),
    }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'active' },
    { agent: sender },
    'v040/drain-owner-offline-wakeable',
  )
  eq(offline.outcome, 'resumed', '恢复动作本身应成功')
  eq(offline.state, '在线·活动', '人显式恢复 + 拉活成功 ⇒ 派生状态 在线·活动')
  eq(wakeOk.resumed.length, 1, 'v0.4.1：恢复时应尝试唤醒离线目标')
  eq(wakeOk.resumed[0].resumeSessionId, ID.X2, '唤醒的应是声明里的负责人')
  eq(wakeOk.resumed[0].agentOptions, { provider: 'pc', model: 'm-1' }, '唤醒必须带上接线')
  eq(offline.drain.wake.ok, true, 'drain.wake 应如实回报拉活结果')
  eq(offline.drain.reason, 'delivered', '唤起来之后就按队列重投')
  eq(offline.drain.delivered.length, 1, '应把那条 pending 投出去')
  eq(offline.drain.stillPending.length, 0, '唤起来就不该再有残留 pending')
  eq(readQueue(offlineStateDir, 'misas:asr')[0].status, 'delivered', '队列记录应标 delivered')

  // b2 唤不起来（resume 抛错）⇒ 保留 pending
  const offlineStateDir2 = path.join(root, 'state-v040-drain-offline-2')
  const bookB2 = bookFile('v040-drain-offline-2', { 'misas:asr': owner('misas', 'asr', ID.X2) })
  await pauseDomain(bookB2, offlineStateDir2, 'misas:asr', 'v040-drain-offline-2', [])
  await call(
    mount({ domainsFile: bookB2, stateDir: offlineStateDir2 }),
    'send_to_domain',
    { target: 'misas:asr', message: '给离线的（拉不起来）' },
    { agent: sender },
    'v040/drain-offline2-queue',
  )
  const wakeFail = { live: [], resumed: [], failResume: 'smoke: resume exploded' }
  const offline2 = await call(
    mount({
      domainsFile: bookB2,
      stateDir: offlineStateDir2,
      agentsService: wakeAgentsService(wakeFail),
      agentDefaultModel: fakeDefaultModel('pc', 'm-1'),
    }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'active' },
    { agent: sender },
    'v040/drain-owner-offline-unwakeable',
  )
  eq(offline2.outcome, 'resumed', '恢复动作本身仍应成功（政策轴确实变了）')
  eq(offline2.state, '离线·活动', '拉不起来仍是 离线·活动')
  eq(wakeFail.resumed.length, 1, '确实尝试过拉活')
  eq(offline2.drain.wake.ok, false, 'drain.wake 应如实报"没拉起来"')
  eq(offline2.drain.wake.reason, 'resume-failed', '原因应如实转述')
  eq(offline2.drain.reason, 'owner-offline', '拉不起来 ⇒ reason=owner-offline')
  eq(offline2.drain.stillPending.length, 1, '离线时必须保留 pending')
  eq(offline2.drain.delivered.length, 0, '不许假装投成功')
  ok(offline2.drain.hint.includes('已经试过拉活'), 'hint 应说清"试过了、没拉起来"')
  ok(offline2.drain.hint.includes('create_domain_session'), 'hint 应给出正确的派活办法')
  ok(offline2.hint.includes('保留 pending'), 'hint 应说清"保留 pending"')
  eq(readQueue(offlineStateDir2, 'misas:asr')[0].status, 'pending', '队列里仍是 pending')

  // b3 没接线 + 要跑回合的档 ⇒ 拒绝裸拉（安全门）
  const offlineStateDir3 = path.join(root, 'state-v040-drain-offline-3')
  const bookB3 = bookFile('v040-drain-offline-3', { 'misas:asr': owner('misas', 'asr', ID.X2) })
  await pauseDomain(bookB3, offlineStateDir3, 'misas:asr', 'v040-drain-offline-3', [])
  await call(
    mount({ domainsFile: bookB3, stateDir: offlineStateDir3 }),
    'send_to_domain',
    { target: 'misas:asr', message: '没接线的 followup' },
    { agent: sender },
    'v040/drain-offline3-queue',
  )
  const wakeNone = { live: [], resumed: [] }
  const offline3 = await call(
    mount({ domainsFile: bookB3, stateDir: offlineStateDir3, agentsService: wakeAgentsService(wakeNone) }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'active' },
    { agent: sender },
    'v040/drain-offline3-no-wiring',
  )
  eq(wakeNone.resumed.length, 0, '没接线 + 要跑回合 ⇒ 一次都不许裸拉')
  eq(offline3.drain.wake.reason, 'no-wake-wiring', '应如实报 no-wake-wiring')
  eq(offline3.drain.wake.wakeWiring.agentOptions, 'none', '回执应报取源 none')
  eq(offline3.drain.reason, 'owner-offline', '仍是 owner-offline')
  eq(offline3.drain.stillPending.length, 1, '保留 pending')
  ok(offline3.drain.hint.includes('{{model}}'), 'hint 必须点明 {{model}} 那个真机坑')

  // b4 只有 inject + 没接线 ⇒ 放行（不跑回合，不碰 {{model}} 坑）
  const offlineStateDir4 = path.join(root, 'state-v040-drain-offline-4')
  const bookB4 = bookFile('v040-drain-offline-4', { 'misas:asr': owner('misas', 'asr', ID.X2) })
  await pauseDomain(bookB4, offlineStateDir4, 'misas:asr', 'v040-drain-offline-4', [])
  await call(
    mount({ domainsFile: bookB4, stateDir: offlineStateDir4 }),
    'send_to_domain',
    { target: 'misas:asr', message: '只入队的 inject', mode: 'inject' },
    { agent: sender },
    'v040/drain-offline4-queue',
  )
  const wakeInject = { live: [], resumed: [] }
  const offline4 = await call(
    mount({ domainsFile: bookB4, stateDir: offlineStateDir4, agentsService: wakeAgentsService(wakeInject) }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'active' },
    { agent: sender },
    'v040/drain-offline4-inject-only',
  )
  eq(wakeInject.resumed.length, 1, '只有 inject 时允许拉活（不跑回合）')
  ok(!('agentOptions' in wakeInject.resumed[0]), '没接线时**绝不**凭空补一个 agentOptions')
  ok(!('setup' in wakeInject.resumed[0]), '没接线时也不传 setup')
  eq(offline4.drain.wake.wakeWiring, { agentOptions: 'none', setup: 'skipped', setupError: null }, '回执如实报 none/skipped')
  eq(offline4.drain.reason, 'delivered', '拉起来之后按原 mode（inject）重投')

  // (c) 投递出口失败 ⇒ failed（带原因），不留在 pending 假装还能投
  const failStateDir = path.join(root, 'state-v040-drain-failed')
  const bookC = bookFile('v040-drain-failed', { 'misas:asr': owner('misas', 'asr', ID.A) })
  await pauseDomain(bookC, failStateDir, 'misas:asr', 'v040-drain-failed', [])
  await call(
    mount({ domainsFile: bookC, stateDir: failStateDir }),
    'send_to_domain',
    { target: 'misas:asr', message: '投不出去的那条' },
    { agent: sender },
    'v040/drain-failed-queue',
  )
  const noMethods = makeAgent(ID.A, { methods: [] })
  const failed = await call(
    mount({ domainsFile: bookC, stateDir: failStateDir, agents: [noMethods], get: () => noMethods }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'active' },
    { agent: sender },
    'v040/drain-deliver-failed',
  )
  eq(failed.drain.reason, 'all-failed', '全失败应报 all-failed')
  eq(failed.drain.failed.length, 1, '应记一条失败')
  eq(failed.drain.failed[0].reason, 'followup-unsupported', '应如实记下失败原因')
  eq(failed.drain.delivered.length, 0, '不许假装成功')
  ok(failed.hint.includes('投递失败'), 'hint 应如实说投递失败')
  const failedQueue = readQueue(failStateDir, 'misas:asr')
  eq(failedQueue[0].status, 'failed', '失败应标 failed')
  eq(failedQueue[0].failedReason, 'followup-unsupported', '应记失败原因')
}

{
  // ⑧ list_* 显示**五种派生状态**：四条活的行（两轴四种组合）+ 一条墓碑（已终结）+ 五态字典。
  const book = bookFile('v040-list-states', {
    'misas:on': owner('misas', 'on', ID.A),
    'misas:onp': owner('misas', 'onp', ID.B),
    'misas:off': owner('misas', 'off', ID.X1),
    'misas:offp': owner('misas', 'offp', ID.X2),
    'misas:dead': owner('misas', 'dead', ID.S),
  })
  const stateDir = path.join(root, 'state-v040-list-states')
  const agents = [makeAgent(ID.A), makeAgent(ID.B)]
  await pauseDomain(book, stateDir, 'misas:onp', 'v040-list', agents)
  await pauseDomain(book, stateDir, 'misas:offp', 'v040-list', agents)
  const released = await call(
    mount({ domainsFile: book, stateDir, agents }),
    'release_domain',
    { domain: 'misas:dead' },
    { agent: sender },
    'v040/list-release-tombstone',
  )
  eq(released.derivedState, '已终结', '释放应给 已终结')

  const sessions = await call(
    mount({ domainsFile: book, stateDir, agents }),
    'list_domain_sessions',
    {},
    { agent: sender },
    'v040/list-sessions-derived-states',
  )
  const byKey = Object.fromEntries(sessions.declarations.map((d) => [d.key, d]))
  eq(byKey['misas:on'].state, '在线·活动', '在线 + 活动')
  eq(byKey['misas:onp'].state, '在线·已暂停', '在线 + 已暂停')
  eq(byKey['misas:off'].state, '离线·活动', '离线 + 活动')
  eq(byKey['misas:offp'].state, '离线·已暂停', '离线 + 已暂停')
  eq(byKey['misas:onp'].paused, true, '应带 paused')
  eq(byKey['misas:onp'].pausedBy, ID.S, '应带"谁按下的"')
  eq(byKey['misas:on'].paused, false, '未暂停的域 paused 应为 false')
  eq(byKey['misas:on'].scope, 'domain', '每条应带 scope=domain')
  ok(!('misas:dead' in byKey), '已释放的域不该还出现在声明段')

  const rowA = sessions.onlineTopLevel.find((row) => row.id === ID.A)
  const rowB = sessions.onlineTopLevel.find((row) => row.id === ID.B)
  eq(rowA.state, '在线·活动', '在线会话行应是 在线·活动')
  eq(rowA.paused, false, '在线会话行 paused 应为 false')
  eq(rowB.state, '在线·已暂停', '持有暂停域的在线会话应是 在线·已暂停')
  eq(rowB.paused, true, '应标明这条会话持有暂停域')
  eq(rowB.pausedDomains, ['misas:onp'], '应列出它持有的暂停域')

  eq(sessions.domainState.scope, 'domain', '这一段仍以域级为主键（兼容旧字段）')
  eq(
    sessions.domainState.scopeImplemented,
    ['domain', 'session', 'project', 'global'],
    'v0.4.2：四级全部实现（scopeImplemented 必须写全）',
  )
  eq(sessions.domainState.scopePlanned, [], '四级都实现了 ⇒ scopePlanned 应为空')
  eq(sessions.domainState.scopes, ['domain', 'session', 'project', 'global'], 'scopes 应列出四级')
  ok(sessions.domainState.scopeHint.includes('OR'), 'scopeHint 应说清 OR 叠加')
  eq(rowB.pausedScopes, ['domain'], '会话行应给出命中级别（这里是它持有的域级）')
  eq(rowB.pausedByScopes[0].scope, 'domain', 'pausedByScopes 应逐条给 scope')
  eq(rowB.pausedByScopes[0].key, 'misas:onp', 'pausedByScopes 应逐条给 key')
  eq(
    sessions.domainState.derivedStates.map((s) => s.name),
    ['在线·活动', '在线·已暂停', '离线·活动', '离线·已暂停', '已终结'],
    '五态字典应齐五个派生状态',
  )
  eq(sessions.domainState.terminated.map((t) => t.key), ['misas:dead'], '墓碑段应列出已终结的域')
  eq(sessions.domainState.terminated[0].state, '已终结', '墓碑项的 state 应是 已终结')
  eq(sessions.domainState.terminated[0].terminatedBy, ID.S, '墓碑应记谁终结的')
  eq(sessions.domainState.terminated[0].pausedWhenTerminated, false, '未暂停就终结 ⇒ 该标记为 false')

  // 「一次 list 调用就把五种派生状态都显示出来」——这是本版对 list_* 的硬要求。
  const seen = new Set([
    ...sessions.declarations.map((d) => d.state),
    ...sessions.domainState.terminated.map((t) => t.state),
    ...sessions.onlineTopLevel.map((row) => row.state),
  ])
  eq(
    [...seen].sort(),
    ['在线·活动', '在线·已暂停', '离线·活动', '离线·已暂停', '已终结'].sort(),
    '一次 list_domain_sessions 应显示全部五种派生状态',
  )

  // list_domain_owners 同一套口径。
  const owners = await call(
    mount({ domainsFile: book, stateDir, agents }),
    'list_domain_owners',
    {},
    { agent: sender },
    'v040/list-owners-derived-states',
  )
  const ownerByKey = Object.fromEntries(owners.declarations.map((d) => [d.key, d]))
  eq(ownerByKey['misas:on'].state, '在线·活动', 'list_domain_owners 也应给派生状态')
  eq(ownerByKey['misas:onp'].state, '在线·已暂停', 'list_domain_owners：在线 + 已暂停')
  eq(ownerByKey['misas:off'].state, '离线·活动', 'list_domain_owners：离线 + 活动')
  eq(ownerByKey['misas:offp'].state, '离线·已暂停', 'list_domain_owners：离线 + 已暂停')
  eq(owners.domainState.derivedStates.length, 5, 'list_domain_owners 也应带五态字典')
  eq(owners.domainState.terminated.map((t) => t.state), ['已终结'], 'list_domain_owners 应显示 已终结')
  const ownerSeen = new Set([
    ...owners.declarations.map((d) => d.state),
    ...owners.domainState.terminated.map((t) => t.state),
  ])
  eq(
    [...ownerSeen].sort(),
    ['在线·活动', '在线·已暂停', '离线·活动', '离线·已暂停', '已终结'].sort(),
    '一次 list_domain_owners 应显示全部五种派生状态',
  )
}

{
  // ⑨ 回归：**没被暂停**的域，send_to_domain 的回执键集/行为与 v0.3.6 逐字一致（不多键、不写状态文件）。
  const book = bookFile('v040-regression', {
    'misas:asr': owner('misas', 'asr', ID.A),
    'misas:gui': owner('misas', 'gui', ID.B),
  })
  const stateDir = path.join(root, 'state-v040-regression')
  const target = makeAgent(ID.A)
  const out = await call(
    mount({ domainsFile: book, stateDir, agents: [target] }),
    'send_to_domain',
    { target: 'asr', message: 'hello', replyTo: 'k' },
    { agent: sender },
    'v040/regression-send-not-paused',
  )
  eq(out.delivered, true, '未暂停的域应照常投递')
  eq(out.matchedBy, 'declaration', 'matchedBy 不变')
  eq(
    Object.keys(out).sort(),
    ['declaration', 'delivered', 'matchedBy', 'mode', 'note', 'self', 'target'].sort(),
    '未暂停域的投递回执键集必须与 v0.3.6 一致（暂停与 force 一个键都不许冒出来）',
  )
  eq(target.sent.length, 1, '应投一条')

  // force 对未暂停的域必须是**无害空操作**（不产生 pausedOverride 之类的键）。
  const forced = await call(
    mount({ domainsFile: book, stateDir, agents: [target] }),
    'send_to_domain',
    { target: 'asr', message: 'x', force: true },
    { agent: sender },
    'v040/regression-force-noop',
  )
  eq(forced.delivered, true, 'force 在未暂停域照样投')
  ok(!('pausedOverride' in forced), '未暂停域传 force 不得凭空冒出 pausedOverride')

  const stateDomainsDir = path.join(stateDir, 'domains')
  const stateInboxDir = path.join(stateDir, 'inbox')
  ok(
    !fs.existsSync(stateDomainsDir) || fs.readdirSync(stateDomainsDir).length === 0,
    '未暂停的域不得写任何状态记录',
  )
  ok(
    !fs.existsSync(stateInboxDir) || fs.readdirSync(stateInboxDir).length === 0,
    '未暂停的域不得写任何队列文件',
  )
}

{
  // ⑩ 降级不静默：状态文件写不动 / 读不懂时如实回报且**绝不误判**；坏队列行只跳过不炸。
  const book = bookFile('v040-degrade', { 'misas:asr': owner('misas', 'asr', ID.A) })

  // (a) 状态文件存在但读不懂 ⇒ 中止写入（绝不覆盖别人的记录），且**不**当成"已暂停"。
  const garbledDir = path.join(root, 'state-v040-garbled')
  fs.mkdirSync(path.join(garbledDir, 'domains'), { recursive: true })
  fs.writeFileSync(path.join(garbledDir, 'domains', safeName('misas:asr') + '.json'), '{oops', 'utf8')
  const garbled = await call(
    mount({ domainsFile: book, stateDir: garbledDir }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'paused' },
    { agent: sender },
    'v040/degrade-state-unreadable',
  )
  eq(garbled.outcome, 'write-failed', '状态文件读不懂应中止写入')
  eq(garbled.reason, 'state-file-unreadable', 'reason 应为 state-file-unreadable')
  eq(garbled.wrote, false, '绝不许覆盖别人的状态记录')
  eq(fs.readFileSync(path.join(garbledDir, 'domains', safeName('misas:asr') + '.json'), 'utf8'), '{oops', '原文件必须原封不动')
  // 坏状态文件**不拦投递**（失败方向刻意选"当作活动"，但降级不静默，list_* 里列出来）。
  const target = makeAgent(ID.A)
  const stillDelivers = await call(
    mount({ domainsFile: book, stateDir: garbledDir, agents: [target] }),
    'send_to_domain',
    { target: 'misas:asr', message: '坏文件不该把整个域永久堵死' },
    { agent: sender },
    'v040/degrade-send-not-blocked',
  )
  eq(stillDelivers.delivered, true, '状态文件读不懂时不得拦住投递（失败方向＝当活动）')
  const listed = await call(
    mount({ domainsFile: book, stateDir: garbledDir, agents: [target] }),
    'list_domain_owners',
    {},
    { agent: sender },
    'v040/degrade-list-exposes-unreadable',
  )
  eq(listed.domainState.unreadableStateFiles.length, 1, '读不懂的状态文件必须列出来（降级不静默）')
  ok(listed.domainState.degradeNote.includes('不拦投递'), '应说明这个失败方向')

  // (b) 写不进去（.tmp 被目录占位）⇒ write-failed，且如实说"政策轴没变"。
  const blockedDir = path.join(root, 'state-v040-blocked')
  fs.mkdirSync(path.join(blockedDir, 'domains', safeName('misas:asr') + '.json.tmp'), { recursive: true })
  const blocked = await call(
    mount({ domainsFile: book, stateDir: blockedDir }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'paused' },
    { agent: sender },
    'v040/degrade-write-failed',
  )
  eq(blocked.outcome, 'write-failed', '写不进去应 write-failed')
  eq(blocked.reason, 'write-failed', 'reason 应为 write-failed')
  ok(typeof blocked.error === 'string' && blocked.error.length > 0, '应带上真实错误文本')
  ok(blocked.hint.includes('没有变') || blocked.hint.includes('照旧'), '应说清政策轴没有变')

  // (c) 队列文件里混进坏行 ⇒ 好行照用、坏行只记账不炸。
  const dirtyDir = path.join(root, 'state-v040-dirty')
  await pauseDomain(book, dirtyDir, 'misas:asr', 'v040-degrade-dirty', [])
  await call(
    mount({ domainsFile: book, stateDir: dirtyDir }),
    'send_to_domain',
    { target: 'misas:asr', message: '好行' },
    { agent: sender },
    'v040/degrade-dirty-send',
  )
  fs.appendFileSync(queuePath(dirtyDir, 'misas:asr'), 'not json at all\n', 'utf8')
  const dirty = await call(
    mount({ domainsFile: book, stateDir: dirtyDir }),
    'list_domain_owners',
    {},
    { agent: sender },
    'v040/degrade-dirty-list',
  )
  eq(dirty.declarations[0].pending, 1, '好行仍应被数出来')
  eq(dirty.domainState.degradedQueueFiles.length, 1, '坏行必须如实记账（降级不静默）')
  ok(dirty.domainState.degradedQueueFiles[0].error.includes('读不懂'), '应说明有几行读不懂')
}

// ---------------- 12. v0.4.1: 拉活接线（{{model}} 唤醒 bug 的修复）
//
// 真机根因（只读深查，projectlog/2026-10-13-唤醒bug-model-只读深查.md）：插件以前**裸传**
// `{resumeSessionId}` 调 `ctx.agents.resume` ⇒ 拉起来的会话 `agent.options.model` 是 undefined，
// 而 deployment persona 段写着 `{{model}}` ⇒ `turn/start` 后 100ms 内 `turn/end{kind:'error'}`。
// 本段把「补接线 / 分级取源 / 取不到就拒绝裸拉 / setup 可失败降级 / 停机通知不受暂停拦截」
// 全部用假 ctx 钉死。

const WAKE_MODEL = { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }

{
  // ① 取源＝宿主全局默认模型 + setup 全挂上（模型选择两条 waterfall + preset resolve/mount）。
  const book = bookFile('v041-wake-default', { 'misas:asr': owner('misas', 'asr', ID.X1) })
  const state = { live: [], resumed: [] }
  const presets = fakeAgentPresets('resolved-preset-x')
  const out = await call(
    mount({
      domainsFile: book,
      agentsService: wakeAgentsService(state),
      agentDefaultModel: fakeDefaultModel(WAKE_MODEL.provider, WAKE_MODEL.model),
      agentPresets: presets,
      sessionQuery: fakeSessionQuery({ presetId: 'preset-x' }),
    }),
    'send_to_domain',
    { target: 'asr', message: '醒一醒', wake: 'true' },
    { agent: sender },
    'v041/wake-default-sector',
  )
  eq(state.resumed.length, 1, '应拉活一次')
  eq(state.resumed[0].resumeSessionId, ID.X1, '拉的应是声明里的负责人')
  eq(state.resumed[0].agentOptions, WAKE_MODEL, '取源①：agentOptions 来自 ctx.agentDefaultModel')
  ok(typeof state.resumed[0].setup === 'function', '应把 setup 一起传下去')
  eq(
    state.agentCtx.listeners.map((item) => item.event).sort(),
    ['agent/request', 'system-prompt/assemble'],
    'setup 应复刻宿主 installModelSelection 的两条 waterfall',
  )
  eq(presets.calls.resolve, ['preset-x'], '应拿存档 header 的 agentPreset 去 resolve')
  eq(presets.calls.mount.length, 1, '应把 preset 挂回去')
  eq(presets.calls.mount[0].presetId, 'resolved-preset-x', '挂的应是 resolve 之后的 id')
  eq(presets.calls.mount[0].ctx, state.agentCtx, 'mount 应挂在同一个 agentCtx 上')
  eq(out.delivered, true, '接线接好之后应照常投递')
  eq(
    out.woke.wakeWiring,
    { agentOptions: 'ctx.agentDefaultModel', setup: 'applied', setupError: null },
    '回执必须报明用了哪条路',
  )
  eq(state.live.length, 1, '拉活后目标应在线')
}

{
  // ② 取源＝该会话存档里最近一条 request/header 的 config（全局默认模型取不到时才走这条）。
  const book = bookFile('v041-wake-header', { 'misas:asr': owner('misas', 'asr', ID.X1) })
  const state = { live: [], resumed: [] }
  const out = await call(
    mount({
      domainsFile: book,
      agentsService: wakeAgentsService(state),
      sessionQuery: fakeSessionQuery({
        config: { provider: 'pc-arch', model: 'm-arch', reasoningEffort: 'high', tools: [{ name: 'x' }] },
      }),
    }),
    'send_to_domain',
    { target: 'asr', message: '用你上次那个模型醒过来', wake: 'true' },
    { agent: sender },
    'v041/wake-session-header',
  )
  eq(state.resumed.length, 1, '应拉活一次')
  eq(
    state.resumed[0].agentOptions,
    { provider: 'pc-arch', model: 'm-arch' },
    '取源②：agentOptions 来自存档里那条 request/header',
  )
  eq(
    out.woke.wakeWiring.agentOptions,
    'session-header',
    '回执应标明取源是 session-header',
  )
  eq(out.woke.wakeWiring.setup, 'applied', '存档里有 config ⇒ 装得上模型选择')
  eq(out.delivered, true, '照常投递')
}

{
  // ②b 存档里读不懂 / 没有 request/header ⇒ 与"没有存档"一样降级成 none，**绝不猜**。
  const book = bookFile('v041-wake-header-garbage', { 'misas:asr': owner('misas', 'asr', ID.X1) })
  const state = { live: [], resumed: [] }
  const out = await call(
    mount({
      domainsFile: book,
      agentsService: wakeAgentsService(state),
      sessionQuery: fakeSessionQuery({ raw: [{ type: 'turn/start', data: { turn: 1 } }, { nope: true }] }),
    }),
    'send_to_domain',
    { target: 'asr', message: 'x', wake: 'probe' },
    { agent: sender },
    'v041/wake-probe-no-wiring',
  )
  eq(state.resumed.length, 1, 'probe 档不需要接线 ⇒ 照旧放行')
  ok(!('agentOptions' in state.resumed[0]), '取不到就**不传**，绝不凭猜补一个模型')
  ok(!('setup' in state.resumed[0]), '没有可挂的东西就不传 setup')
  eq(out.probe, true, 'probe 回报')
  eq(
    out.wakeWiring,
    { agentOptions: 'none', setup: 'skipped', setupError: null },
    'probe 回执也必须带 wakeWiring（如实报 none/skipped）',
  )
  eq(out.woke.wakeWiring.agentOptions, 'none', 'woke 里同一份口径')
  eq(out.woke.ok, true, 'probe 仍然把人拉起来了（它自己没跑回合，所以不碰 {{model}}）')
  ok(out.hint.includes('接线取源 agentOptions=none'), 'probe hint 应把取源讲出来')
}

{
  // ③ 两条取源都空 + 要真跑回合 ⇒ **拒绝拉活**：一次 resume 都不调。
  const book = bookFile('v041-no-wiring', { 'misas:asr': owner('misas', 'asr', ID.X1) })
  const state = { live: [], resumed: [] }
  const out = await call(
    mount({ domainsFile: book, agentsService: wakeAgentsService(state) }),
    'send_to_domain',
    { target: 'asr', message: '这一发拉不起来', wake: 'true' },
    { agent: sender },
    'v041/no-wiring-followup-refused',
  )
  eq(state.resumed.length, 0, '没接线时**一次都不许**裸拉（裸拉起来 100ms 内就崩）')
  eq(out.delivered, false, '不该投递')
  eq(out.reason, 'no-wake-wiring', 'reason 必须是固定的 no-wake-wiring')
  eq(out.mode, 'followup', '应回显当时那个"要跑回合"的档')
  eq(out.woke.attempted, true, '记录里要说明"尝试过，但被安全门挡下"')
  eq(out.woke.reason, 'no-wake-wiring', 'woke.reason 同一口径')
  eq(
    out.wakeWiring,
    { agentOptions: 'none', setup: 'skipped', setupError: null },
    '回执应报 none/skipped',
  )
  ok(!('queued' in out), '这不是暂停入队那条路：不排队')
  ok(out.hint.includes('没有拉活'), 'hint 应一句话说清"没有拉活"')
  ok(out.hint.includes('{{model}}'), 'hint 应点明真机那个 {{model}} 报错')
  ok(out.hint.includes('create_domain_session'), 'hint 应给替代路')
  ok(out.hint.includes("mode='inject'"), 'hint 应说明 inject 档不受影响')
  ok(out.hint.includes('wake=\'probe\''), 'hint 应说明 probe 档不受影响')

  // ③b 同一台机器上，mode='inject'（不跑回合）**放行** —— 拉活本身不再被安全门拦。
  const injectState = { live: [], resumed: [] }
  const injected = await call(
    mount({ domainsFile: book, agentsService: wakeAgentsService(injectState) }),
    'send_to_domain',
    { target: 'asr', message: '零成本入队', wake: 'true', mode: 'inject' },
    { agent: sender },
    'v041/no-wiring-inject-allowed',
  )
  eq(injectState.resumed.length, 1, 'inject 不跑回合 ⇒ 允许拉活')
  ok(!('agentOptions' in injectState.resumed[0]), '没接线就绝不硬凑一个')
  eq(injected.delivered, true, '拉起来之后按 inject 投递')
  eq(injected.mode, 'inject', 'mode 应如实回显')

  // ③c 安全门不看 force：force 放行的是「暂停」这条政策，不是这道安全门。
  const forcedState = { live: [], resumed: [] }
  const forced = await call(
    mount({ domainsFile: book, agentsService: wakeAgentsService(forcedState) }),
    'send_to_domain',
    { target: 'asr', message: '我想强行拉', wake: 'true', force: true },
    { agent: sender },
    'v041/no-wiring-force-still-refused',
  )
  eq(forcedState.resumed.length, 0, 'force 不得越过安全门')
  eq(forced.reason, 'no-wake-wiring', 'reason 仍是 no-wake-wiring')
  ok(!('pausedOverride' in forced), '未暂停的域不该冒出 pausedOverride')
}

{
  // ④ setup 抛错 ⇒ **只记不抛**：resume 照样成立（agentOptions 那半已经解掉 100ms 崩溃），
  //    回执如实报 setup:'failed' + setupError。
  const book = bookFile('v041-setup-fail', { 'misas:asr': owner('misas', 'asr', ID.X1) })
  const state = { live: [], resumed: [] }
  const exploding = {
    async resolve(presetId) {
      return { id: presetId }
    },
    async mount() {
      throw new Error('smoke: preset mount exploded')
    },
  }
  const out = await call(
    mount({
      domainsFile: book,
      agentsService: wakeAgentsService(state),
      agentDefaultModel: fakeDefaultModel(WAKE_MODEL.provider, WAKE_MODEL.model),
      agentPresets: exploding,
      sessionQuery: fakeSessionQuery({ presetId: 'preset-x' }),
    }),
    'send_to_domain',
    { target: 'asr', message: 'setup 会炸', wake: 'true' },
    { agent: sender },
    'v041/setup-failed-degrades',
  )
  eq(state.resumed.length, 1, 'setup 归 setup，resume 该发还是发')
  eq(out.delivered, true, 'setup 失败不影响投递（降级成"只有接线"）')
  eq(out.woke.ok, true, 'resume 本身成功')
  eq(out.woke.wakeWiring.setup, 'failed', '回执必须如实报 failed')
  ok(
    typeof out.woke.wakeWiring.setupError === 'string' && out.woke.wakeWiring.setupError.includes('preset mount exploded'),
    '应带真实错误文本',
  )
  eq(
    out.woke.wakeWiring.agentOptions,
    'ctx.agentDefaultModel',
    'agentOptions 那半不受影响',
  )
  eq(
    state.agentCtx.listeners.map((item) => item.event).sort(),
    ['agent/request', 'system-prompt/assemble'],
    '模型选择在 preset 之前就装好了（部分降级也如实）',
  )
}

{
  // ⑤ 第二候选入口（sessionController.resume）**收不下接线**（签名只有 sessionId）⇒ 要跑回合时
  //    一样拒绝，不许"从另一个门裸拉活"。
  const book = bookFile('v041-legacy-controller', { 'misas:asr': owner('misas', 'asr', ID.X1) })
  const legacy = {
    calls: [],
    async create() {
      return { sessionId: ID.C }
    },
    async resume(sessionId) {
      legacy.calls.push(sessionId)
    },
  }
  const out = await call(
    mount({
      domainsFile: book,
      controller: legacy,
      agentDefaultModel: fakeDefaultModel(WAKE_MODEL.provider, WAKE_MODEL.model),
    }),
    'send_to_domain',
    { target: 'asr', message: '走旧入口', wake: 'true' },
    { agent: sender },
    'v041/legacy-controller-refused',
  )
  eq(legacy.calls.length, 0, '旧入口带不了接线 ⇒ 要跑回合时也得拒绝')
  eq(out.reason, 'no-wake-wiring', 'reason 同一口径')
  eq(out.woke.reason, 'no-wake-wiring', 'woke.reason 同一口径')

  // ⑤b 不跑回合（inject）⇒ 旧入口可以用（保持 v0.3.6 的"第二候选"语义）。
  const legacy2 = {
    calls: [],
    async create() {
      return { sessionId: ID.C }
    },
    async resume(sessionId) {
      legacy2.calls.push(sessionId)
    },
  }
  await call(
    mount({
      domainsFile: book,
      controller: legacy2,
      agentDefaultModel: fakeDefaultModel(WAKE_MODEL.provider, WAKE_MODEL.model),
    }),
    'send_to_domain',
    { target: 'asr', message: '只入队', wake: 'true', mode: 'inject' },
    { agent: sender },
    'v041/legacy-controller-inject',
  )
  eq(legacy2.calls, [ID.X1], '不跑回合时旧入口照旧可用')
}

{
  // ⑥ F2 停机通知**不受「已暂停」拦截**：前任可能正握着被暂停的域在改文件，停机通知是止损。
  const book = bookFile('v041-standdown-paused', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const stateDir = path.join(root, 'state-v041-standdown')
  const predecessor = makeAgent(ID.B)
  await pauseDomain(book, stateDir, 'misas:asr', 'v041-standdown', [predecessor])
  eq(readState(stateDir, 'misas:asr').paused, true, '前置条件：该域已暂停')

  const out = await call(
    mount({ domainsFile: book, stateDir, agents: [predecessor] }),
    'claim_domain',
    { domain: 'asr', force: true },
    { agent: sender },
    'v041/standdown-notice-while-paused',
  )
  eq(out.outcome, 'handover', '交接本身照常允许（换人 ≠ 解暂停）')
  eq(out.paused, true, '交接不得解除暂停')
  eq(out.standDown.delivered, 'inject', '停机通知必须照发（inject，零成本）')
  eq(predecessor.sent.length, 1, '前任应真的收到那一条')
  eq(predecessor.sent[0].mode, 'inject', '只塞上下文、不唤醒')
  ok(
    predecessor.sent[0].payload.content[0].text.includes('你已不再是'),
    '正文应说清"你已不再是这个域的负责人"',
  )
  eq(readQueue(stateDir, 'misas:asr').length, 0, '停机通知**不许**走暂停入队那条路（它就是止损信）')
}

// ------------------------------------- 13. v0.4.2 四级「已暂停」（域 / 主＝session / 项目 / 全局）
//
// 冻结口径（用户拍板，本段逐条钉死）：
//   · scope 字面量只有四个：domain | session（主＝单会话暂停）| project | global；代码里出现
//     master/main 一律算偏离。
//   · 键：域＝项目:域（**仍要求已有在任声明**）；session＝完整会话 id（短号只在唯一命中时接受）；
//     project＝项目名小写；global＝唯一键 *（按/解都要 confirm）。
//   · 判定＝OR 叠加（任一级按下就拦，回执列**全部**命中级别）；两端都查（接收端 + 发送端），
//     但**不含**「本会话自己持有的域被暂停」。
//   · 入队键＝被投递目标自身的键（域⇒域键，会话⇒会话 id），队列不按 scope 分片。
//   · 恢复＝重评 OR（逐条）：仍被别的级压着 ⇒ 保持 pending 并给 stillPausedBy。
//   · 降级不静默：坏状态文件 ⇒ 不拦但进 unreadableStateFiles；判不成的那一级 ⇒ 不拦但进 unresolved。

const SENDER_CWD_PROJECT = 'misas' // sender 的 cwd 末段是 misas ⇒ 项目名 misas

/** 按下某一级（四级统一入口，convenience wrapper）。 */
async function pauseScope(book, stateDir, args, label, agents, exec) {
  return call(
    mount({ domainsFile: book, stateDir, agents: agents || [] }),
    'set_domain_state',
    { ...args, state: 'paused' },
    exec || { agent: sender },
    `${label}/pause`,
  )
}

{
  // ① 键解析 + OR 叠加：项目级压着域级 ⇒ 投递被拦且**报出两级**；恢复时**重评 OR**（解一级不够）。
  const book = bookFile('v042-or', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const stateDir = path.join(root, 'state-v042-or')

  const domPause = await pauseScope(book, stateDir, { domain: 'misas:asr', note: '域级按下' }, 'v042/or/domain', [], {
    agent: sender,
  })
  eq(domPause.outcome, 'paused', '域级按下应成功')
  eq(domPause.scope, 'domain', '不带 scope ⇒ 仍走 domain 级（向后兼容）')
  eq(domPause.scopePaused, true, '本级别已暂停')
  eq(domPause.pausedScopes, ['domain'], '只按了域级 ⇒ 命中级别只有 domain')

  const projPause = await pauseScope(
    book,
    stateDir,
    { scope: 'project', domain: SENDER_CWD_PROJECT, note: '项目级按下' },
    'v042/or/project',
    [],
  )
  eq(projPause.outcome, 'paused', '项目级按下应成功（**不要求**有在任声明）')
  eq(projPause.scope, 'project', 'scope 应回显 project')
  eq(projPause.key, SENDER_CWD_PROJECT, '项目级键＝项目名小写')
  eq(projPause.scopePaused, true, '本级别已暂停')
  eq(projPause.pausedScopes, ['project'], '这一级自己按下了 ⇒ 命中集合里至少要有 project（域键是**另一个 key**，不算"压着 project"）')
  eq(projPause.state, '已暂停', 'project 级没有单会话的在线轴 ⇒ 对外状态就是政策轴的词')
  eq(projPause.pausedByScopes.length, 1, 'pausedByScopes 应逐条给命中级别')
  eq(readState(stateDir, SENDER_CWD_PROJECT, 'project').scope, 'project', '项目级记录里的 scope 必须是 project')
  eq(
    fs.existsSync(statePath(stateDir, SENDER_CWD_PROJECT, 'project')),
    true,
    '非域级记录的文件名应带 scope 前缀（一 scope 一键一文件）',
  )
  eq(
    fs.existsSync(statePath(stateDir, SENDER_CWD_PROJECT)),
    false,
    '不得落到域级的同名文件名上（跨 scope 结构上不撞）',
  )

  const owner13 = makeAgent(ID.A)
  const blocked = await call(
    mount({ domainsFile: book, stateDir, agents: [owner13] }),
    'send_to_domain',
    { target: 'misas:asr', message: '被两级压着', mode: 'inject' },
    { agent: sender },
    'v042/or/send-blocked',
  )
  eq(blocked.delivered, false, '被任一级按下 ⇒ 不投递')
  eq(blocked.queued, true, '应落盘入队')
  eq(blocked.reason, 'domain-paused', "reason 字面量仍是冻结的 'domain-paused'")
  eq(blocked.pausedScopes, ['domain', 'project'], '拦截回执必须列出全部命中级别')
  eq(
    blocked.pausedByScopes.map((hit) => hit.scope),
    ['domain', 'project'],
    'pausedByScopes 应逐条给全是哪几级',
  )
  eq(blocked.queue.key, 'misas:asr', '目标是域 ⇒ 入队键＝域键（S5）')
  eq(owner13.sent.length, 0, '绝不许偷投')
  const pendingId = blocked.queue.id

  // 解开**域级**：项目级还压着 ⇒ pending 必须保持（drain 之前重评 OR）。
  const onlyDomainResumed = await call(
    mount({ domainsFile: book, stateDir, agents: [owner13] }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'active' },
    { agent: sender },
    'v042/or/resume-domain-only',
  )
  eq(onlyDomainResumed.outcome, 'resumed', '解域级应成功')
  eq(onlyDomainResumed.scopePaused, false, '本级别（域级）已恢复活动')
  eq(onlyDomainResumed.paused, true, 'OR：仍被项目级压着 ⇒ 有效暂停仍为 true')
  eq(onlyDomainResumed.state, '在线·已暂停', '派生状态体现 OR（负责人在线）')
  eq(onlyDomainResumed.pausedScopes, ['project'], '命中级别应只剩 project')
  eq(onlyDomainResumed.drain.reason, 'still-pressed', '重评 OR ⇒ 仍被压着，不改 pending')
  eq(onlyDomainResumed.drain.delivered.length, 0, '不许投出去')
  eq(onlyDomainResumed.drain.stillPending, [pendingId], '那条 pending 原样保留')
  eq(onlyDomainResumed.drain.stillPausedBy[0].scope, 'project', 'stillPausedBy 要说清是被哪一级压着')
  eq(onlyDomainResumed.drain.stillPausedBy[0].key, SENDER_CWD_PROJECT, 'stillPausedBy 要给键')
  eq(readQueue(stateDir, 'misas:asr')[0].status, 'pending', '队列里仍是 pending')
  eq(owner13.sent.length, 0, '仍不许投')

  // 再解开项目级 ⇒ 现在没有一级压着了 ⇒ 才重投。
  const projectResumed = await call(
    mount({ domainsFile: book, stateDir, agents: [owner13] }),
    'set_domain_state',
    { scope: 'project', domain: SENDER_CWD_PROJECT, state: 'active' },
    { agent: sender },
    'v042/or/resume-project',
  )
  eq(projectResumed.outcome, 'resumed', '解项目级应成功')
  eq(projectResumed.state, '活动', 'project 级的对外状态回到「活动」')
  eq(projectResumed.pausedScopes, [], '没有一级压着了')
  eq(projectResumed.drain.reason, 'delivered', '现在才该重投')
  eq(projectResumed.drain.delivered.length, 1, '那条 pending 应投出去')
  eq(owner13.sent.length, 1, '在线负责人应收到一条')
  eq(owner13.sent[0].mode, 'inject', '按**原 mode** 重投')
  eq(readQueue(stateDir, 'misas:asr')[0].status, 'delivered', '队列记录应标 delivered')
}

{
  // ② global：缺 confirm ⇒ 拒绝且**一个文件都不写**；带 confirm ⇒ 生效；被全局压着时**任何**目标都拦。
  const book = bookFile('v042-global', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const stateDir = path.join(root, 'state-v042-global')

  const refused = await call(
    mount({ domainsFile: book, stateDir }),
    'set_domain_state',
    { scope: 'global', state: 'paused' },
    { agent: sender },
    'v042/global/missing-confirm',
  )
  eq(refused.outcome, 'invalid', '缺 confirm 应拒绝')
  eq(refused.reason, 'global-needs-confirm', "reason 应为 'global-needs-confirm'")
  eq(refused.key, '*', 'global 的键是保留键 *')
  eq(refused.wrote, false, '不许写')
  eq(refused.wroteNothing, true, '必须明说"一个文件都没写"')
  eq(fs.existsSync(path.join(stateDir, 'domains')), false, '缺 confirm ⇒ 连状态目录都不该建')

  const badKey = await call(
    mount({ domainsFile: book, stateDir }),
    'set_domain_state',
    { scope: 'global', domain: 'misas', state: 'paused', confirm: true },
    { agent: sender },
    'v042/global/wrong-key',
  )
  eq(badKey.outcome, 'invalid', 'global 只认 * ⇒ 给别的键应拒绝')
  eq(badKey.reason, 'global-key-is-star', 'reason 应为 global-key-is-star')
  eq(fs.existsSync(path.join(stateDir, 'domains')), false, '拒绝路径仍不写文件')

  const paused = await call(
    mount({ domainsFile: book, stateDir }),
    'set_domain_state',
    { scope: 'global', state: 'paused', confirm: true, note: '全局停一轮' },
    { agent: sender },
    'v042/global/confirmed',
  )
  eq(paused.outcome, 'paused', '带 confirm 应成功')
  eq(paused.scope, 'global', 'scope 应为 global')
  eq(paused.key, '*', 'global 键固定 *')
  eq(paused.scopePaused, true, '本级别已暂停')
  eq(paused.state, '已暂停', '全局没有单会话的在线轴 ⇒ 对外状态＝已暂停')
  const globalRec = readState(stateDir, '*', 'global')
  eq(globalRec.scope, 'global', '状态记录里的 scope 必须是 global')
  eq(globalRec.key, '*', '状态记录里的 key 必须是 *')
  eq(globalRec.paused, true, '状态记录应 paused:true')
  eq(globalRec.note, '全局停一轮', 'note 应原样落盘')

  // 全局压着 ⇒ 域目标 / 会话目标都拦。
  const owner13 = makeAgent(ID.A)
  const byDomain = await call(
    mount({ domainsFile: book, stateDir, agents: [owner13] }),
    'send_to_domain',
    { target: 'misas:asr', message: '全局压着（域目标）' },
    { agent: sender },
    'v042/global/block-domain',
  )
  eq(byDomain.queued, true, '全局压着 ⇒ 域目标也拦')
  eq(byDomain.pausedScopes, ['global'], '命中级别应为 global')
  eq(byDomain.pausedByScopes[0].via, 'global', 'via 应标明是 global 那条')
  const bySession = await call(
    mount({ domainsFile: book, stateDir, agents: [owner13] }),
    'send_to_domain',
    { target: ID.A, message: '全局压着（会话目标）' },
    { agent: sender },
    'v042/global/block-session',
  )
  eq(bySession.queued, true, '全局压着 ⇒ 会话目标也拦')
  eq(bySession.queue.key, ID.A, '目标是会话 ⇒ 入队键＝会话 id（S5）')
  eq(bySession.queue.scope, 'session', '会话键队列的 scope 应为 session')

  // 建会话：全局压着也一律拒绝。
  const controller = createSpy([{ sessionId: ID.C }])
  const createBlocked = await call(
    mount({ domainsFile: book, stateDir, controller, agents: [owner13] }),
    'create_domain_session',
    { domain: 'misas:asr', task: 'x' },
    createExec,
    'v042/global/create-refused',
  )
  eq(controller.requests.length, 0, '全局压着 ⇒ 宿主 create 一次都不许调')
  eq(createBlocked.created, false, 'created 应为 false')
  eq(createBlocked.reason, 'domain-paused', "reason 仍是冻结的 'domain-paused'")
  eq(createBlocked.pausedScopes, ['global'], '拒绝回执也要列出命中级别')

  // 全局恢复 ⇒ 扫 inbox 全量，把两条队列都重评（一条域键、一条会话键）。
  const resumed = await call(
    mount({ domainsFile: book, stateDir, agents: [owner13] }),
    'set_domain_state',
    { scope: 'global', state: 'active', confirm: true },
    { agent: sender },
    'v042/global/resumed',
  )
  eq(resumed.outcome, 'resumed', '带 confirm 解全局应成功')
  eq(resumed.drain.multi, true, 'global 恢复要扫 inbox 全量 ⇒ 多队列聚合')
  eq(resumed.drain.keys.length, 2, '应选中两条队列（域键 + 会话键）')
  eq(resumed.drain.delivered.length, 2, '两条 pending 都该投出去')
  eq(owner13.sent.length, 2, '负责人应收到两条')
}

{
  // ③ 两端都查：发送端自己（session / project）被按下 ⇒ 一样发不出去；
  //    但**刻意不含**「本会话自己持有的域被暂停」——域级暂停只关那扇门，不禁言整个会话。
  const book = bookFile('v042-self', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const stateDir = path.join(root, 'state-v042-self')
  const other = makeAgent(ID.B, { cwd: path.join(FIXTURE_PROJECTS, 'other') })

  // (a) 发送端 session 级被按下 ⇒ 发不出去（0.4.1 里**没有**这道门）。
  await pauseScope(book, stateDir, { scope: 'session', domain: ID.S, note: '本会话被按' }, 'v042/self/session', [other])
  const selfBlocked = await call(
    mount({ domainsFile: book, stateDir, agents: [other] }),
    'send_to_domain',
    { target: ID.B, message: '我自己被按着' },
    { agent: sender },
    'v042/self/session-blocked',
  )
  eq(selfBlocked.delivered, false, '本会话被按下 ⇒ 不许再往外发')
  eq(selfBlocked.queued, true, '仍要落盘入队（不是丢消息）')
  eq(selfBlocked.pausedScopes, ['session'], '命中级别应为 session')
  eq(selfBlocked.pausedByScopes[0].key, ID.S, '命中的是**本会话**的键')
  eq(selfBlocked.pausedByScopes[0].via, 'self-session', 'via 应标明是发送端（self-session）')
  eq(selfBlocked.pausedByScopes[0].side, 'self', 'side 应标明 self')
  eq(other.sent.length, 0, '绝不偷投')

  // (b) 发送端 project 级被按下（sender 的 cwd 是 misas）⇒ 发不出去；目标是**别的项目**的会话，
  //     所以这一发只能被"发送端项目级"拦住（接收端项目是 other，没被按）。
  const stateDir2 = path.join(root, 'state-v042-self-project')
  await pauseScope(book, stateDir2, { scope: 'project', domain: SENDER_CWD_PROJECT }, 'v042/self/project', [other])
  const selfProjectBlocked = await call(
    mount({ domainsFile: book, stateDir: stateDir2, agents: [other] }),
    'send_to_domain',
    { target: ID.B, message: '我的项目被按着' },
    { agent: sender },
    'v042/self/project-blocked',
  )
  eq(selfProjectBlocked.delivered, false, '本会话所属项目被按下 ⇒ 不许发')
  eq(selfProjectBlocked.pausedScopes, ['project'], '命中级别应为 project')
  eq(selfProjectBlocked.pausedByScopes[0].via, 'self-project', 'via 应标明 self-project')
  eq(selfProjectBlocked.queue.key, ID.B, '入队键＝被投递目标自身的键（会话 id）')

  // (c) 边界：sender **自己持有** 'misas:asr' 且它被域级按下 ⇒ 发**别的**目标照样投得出去。
  const holdBook = bookFile('v042-self-holds-domain', { 'misas:asr': owner('misas', 'asr', ID.S) })
  const stateDir3 = path.join(root, 'state-v042-self-holds')
  await pauseScope(holdBook, stateDir3, { domain: 'misas:asr', note: '本会话持有的域被按' }, 'v042/self/held-domain', [
    other,
  ])
  const stillSends = await call(
    mount({ domainsFile: holdBook, stateDir: stateDir3, agents: [other] }),
    'send_to_domain',
    { target: ID.B, message: '我持有的域被按，但这不该禁言我' },
    { agent: sender },
    'v042/self/held-domain-not-silencing',
  )
  eq(stillSends.delivered, true, '“本会话自己持有的域被暂停”**不禁言整个会话**（刻意边界）')
  eq(other.sent.length, 1, '应真的投出去')
}

{
  // ④ session 键：完整 id（**不要求在线**）原样接受；短号只在唯一命中时接受；片段歧义 ⇒ 拒绝；非法 scope ⇒ 拒绝。
  const book = bookFile('v042-session-key', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const stateDir = path.join(root, 'state-v042-session-key')

  const offlineId = await call(
    mount({ domainsFile: book, stateDir, agents: [] }),
    'set_domain_state',
    { scope: 'session', domain: ID.X1, state: 'paused', note: '完整 id，人还没开窗口' },
    { agent: sender },
    'v042/session/full-id-offline',
  )
  eq(offlineId.outcome, 'paused', '完整会话 id 应被原样接受（**不要求它现在在线**）')
  eq(offlineId.key, ID.X1, '键就是完整会话 id')
  eq(offlineId.scope, 'session', 'scope 应为 session')
  eq(offlineId.sessionFrom, '完整会话 id（原样使用，不要求它现在在线）', 'sessionFrom 应说清来源')
  eq(readState(stateDir, ID.X1, 'session').scope, 'session', '状态记录 scope 必须是 session')

  const shortUnique = await call(
    mount({ domainsFile: book, stateDir, agents: [makeAgent(ID.A)] }),
    'set_domain_state',
    { scope: 'session', domain: SHORT.A, state: 'paused' },
    { agent: sender },
    'v042/session/short-unique',
  )
  eq(shortUnique.outcome, 'paused', '短号唯一命中应被接受')
  eq(shortUnique.key, ID.A, '应解析成完整会话 id')
  ok(shortUnique.sessionFrom.includes('短号/片段唯一命中'), 'sessionFrom 应说明是唯一命中')

  const ambiguous = await call(
    mount({ domainsFile: book, stateDir, agents: [makeAgent(ID.X1), makeAgent(ID.X2)] }),
    'set_domain_state',
    { scope: 'session', domain: 'aaa', state: 'paused' },
    { agent: sender },
    'v042/session/ambiguous-fragment',
  )
  eq(ambiguous.outcome, 'invalid', '片段命中多条 ⇒ 拒绝，不猜')
  eq(ambiguous.reason, 'session-ambiguous', 'reason 应为 session-ambiguous')
  eq(ambiguous.candidates.length, 2, '应列出两条候选')

  const notFound = await call(
    mount({ domainsFile: book, stateDir }),
    'set_domain_state',
    { scope: 'session', domain: 'sess-ffffffff', state: 'paused' },
    { agent: sender },
    'v042/session/not-found',
  )
  eq(notFound.outcome, 'invalid', '查不到的短号 ⇒ 拒绝')
  eq(notFound.reason, 'session-not-found', 'reason 应为 session-not-found')

  const badScope = await call(
    mount({ domainsFile: book, stateDir }),
    'set_domain_state',
    { scope: 'master', domain: 'x', state: 'paused' },
    { agent: sender },
    'v042/scope/invalid',
  )
  eq(badScope.outcome, 'invalid', '非法 scope ⇒ 拒绝')
  eq(badScope.reason, 'invalid-scope', 'reason 应为 invalid-scope')
  eq(badScope.accepted, ['domain', 'session', 'project', 'global'], '应给出可接受的四个字面量')

  // domain 级的「承认现状」**不许**被顺手删掉：域级仍要求声明册里有这个 key。
  const noDecl = await call(
    mount({ domainsFile: bookFile('v042-no-decl', {}), stateDir: path.join(root, 'state-v042-no-decl') }),
    'set_domain_state',
    { domain: 'misas:nope', state: 'paused' },
    { agent: sender },
    'v042/domain/still-needs-declaration',
  )
  eq(noDecl.outcome, 'no-declaration', 'domain 级仍要求有在任声明（用户拍板的 D2=A）')
  ok(noDecl.hint.includes('claim_domain'), '应给出补救办法')
}

{
  // ⑤ 向后兼容：不带 scope ⇒ domain 级、旧字段语义不变、**文件名仍是 v0.4.1 的 `k-<flat>-<sha1>`**；
  //    未暂停时的投递回执**一个键都不多**（unresolved/unreadableStateFiles 只在非空时出现）。
  const book = bookFile('v042-compat', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const stateDir = path.join(root, 'state-v042-compat')
  const out = await call(
    mount({ domainsFile: book, stateDir }),
    'set_domain_state',
    { domain: 'misas:asr', state: 'paused', note: '旧调用' },
    { agent: sender },
    'v042/compat/old-call',
  )
  eq(out.scope, 'domain', '不带 scope ⇒ 仍是 domain 级')
  eq(out.key, 'misas:asr', 'key 不变')
  eq(out.domain, 'asr', 'domain 兼容字段＝短的域部分（v0.4.1 语义：这里是 asr，不是完整 key）')
  eq(out.project, 'misas', 'project 兼容字段仍在')
  eq(out.paused, true, 'paused 字段语义不变（只有域级记录时 OR 就等于它）')
  eq(out.scopePaused, true, 'scopePaused 是新增字段（本级别）')
  eq(out.wrote, true, 'wrote 不变')
  eq(typeof out.file, 'string', 'file 不变')
  eq(
    fs.existsSync(statePath(stateDir, 'misas:asr')),
    true,
    '域级记录**必须**沿用 v0.4.1 的文件名（否则历史状态文件会失联）',
  )
  eq(readState(stateDir, 'misas:asr').scope, 'domain', '域级记录 scope=domain')

  const clean = path.join(root, 'state-v042-compat-clean')
  await pauseScope(book, clean, { scope: 'session', domain: ID.X1 }, 'v042/compat/other-session', [], {
    agent: sender,
  })
  const target = makeAgent(ID.A)
  const delivered = await call(
    mount({ domainsFile: book, stateDir: clean, agents: [target] }),
    'send_to_domain',
    { target: 'asr', message: 'hello', replyTo: 'k' },
    { agent: sender },
    'v042/compat/delivered-key-set',
  )
  eq(delivered.delivered, true, '别的会话被按下不影响这一发')
  eq(
    Object.keys(delivered).sort(),
    ['declaration', 'delivered', 'matchedBy', 'mode', 'note', 'self', 'target'].sort(),
    '未暂停时的投递回执键集必须与 v0.3.6 逐字一致（新字段只在非空时出现）',
  )
}

{
  // ⑥ 降级不静默：状态文件读不懂 ⇒ **不拦**但回执带 unreadableStateFiles；
  //    判不成项目的那一级 ⇒ **不拦**但带 unresolved。
  const book = bookFile('v042-degrade', {})
  const stateDir = path.join(root, 'state-v042-degrade-live')
  fs.mkdirSync(path.join(stateDir, 'domains'), { recursive: true })
  fs.writeFileSync(statePath(stateDir, ID.A, 'session'), '{oops', 'utf8')
  const live = makeAgent(ID.A)
  const out = await call(
    mount({ domainsFile: book, stateDir, agents: [live] }),
    'send_to_domain',
    { target: ID.A, message: '坏文件不该把这条会话永久堵死' },
    { agent: sender },
    'v042/degrade/unreadable-session-state',
  )
  eq(out.delivered, true, '状态文件读不懂时不得拦住投递（失败方向＝当活动）')
  eq(out.unreadableStateFiles.length, 1, '读不懂的文件必须如实带出来（降级不静默）')
  eq(out.unreadableStateFiles[0].scope, 'session', '应标明是哪个 scope 的文件')
  eq(live.sent.length, 1, '应真的投出去')

  const noCwd = makeAgent(ID.X2, { cwd: '' })
  const cantTell = await call(
    mount({ domainsFile: book, stateDir: path.join(root, 'state-v042-degrade-nocwd'), agents: [noCwd] }),
    'send_to_domain',
    { target: ID.X2, message: '推不出项目' },
    { agent: sender },
    'v042/degrade/project-unresolved',
  )
  eq(cantTell.delivered, true, '项目级判不成 ⇒ **不拦**（不误拦）')
  eq(cantTell.unresolved.length, 1, '但必须标出哪一级没判成（降级不静默）')
  eq(cantTell.unresolved[0].level, 'project', 'unresolved 应写明是 project 级')
  eq(cantTell.unresolved[0].reason, 'project-unresolved', 'reason 应为 project-unresolved')
}

{
  // ⑦ 列表 / 会话行体现四级：项目级压着 ⇒ 那个项目里**所有**在线会话都显示 在线·已暂停；
  //    session 级压着 ⇒ 只有那条会话被标；domainState 里四级作用域 + 被按下记录 + 判不成的级别。
  const book = bookFile('v042-list', {
    'misas:on': owner('misas', 'on', ID.A),
    'misas:onp': owner('misas', 'onp', ID.B),
  })
  const agents = [makeAgent(ID.A), makeAgent(ID.B)]

  // (a) 项目级按下 ⇒ 两条都在 misas 项目里，都该显示 在线·已暂停。
  const dirProject = path.join(root, 'state-v042-list-project')
  await pauseScope(book, dirProject, { scope: 'project', domain: SENDER_CWD_PROJECT }, 'v042/list/project', agents)
  const projList = await call(
    mount({ domainsFile: book, stateDir: dirProject, agents }),
    'list_domain_sessions',
    {},
    { agent: sender },
    'v042/list/project-pressed',
  )
  const projRows = projList.onlineTopLevel
  eq(projRows.length, 2, '两条在线会话')
  eq(projRows[0].state, '在线·已暂停', '项目级压着 ⇒ 项目里的会话行必须显示 在线·已暂停')
  eq(projRows[1].state, '在线·已暂停', '同项目的另一条会话也一样')
  eq(projRows[0].pausedScopes, ['project'], '会话行要给出命中级别')
  eq(projRows[0].pausedByScopes[0].via, 'self-project', '会话行给出的 via 是它自己视角的那条')
  const projDecl = Object.fromEntries(projList.declarations.map((d) => [d.key, d]))
  eq(projDecl['misas:on'].paused, true, '声明行的 paused 是**有效暂停**（OR）')
  eq(projDecl['misas:on'].pausedScopes, ['project'], '声明行要给出命中级别')
  eq(projDecl['misas:on'].state, '在线·已暂停', '声明行派生状态体现四级命中')

  // (b) 只按 session 级（ID.B）⇒ 只有 B 那条被标；A 仍是活动。
  const dirSession = path.join(root, 'state-v042-list-session')
  await pauseScope(book, dirSession, { scope: 'session', domain: ID.B }, 'v042/list/session', agents)
  const sessList = await call(
    mount({ domainsFile: book, stateDir: dirSession, agents }),
    'list_domain_sessions',
    {},
    { agent: sender },
    'v042/list/session-pressed',
  )
  const rowA = sessList.onlineTopLevel.find((row) => row.id === ID.A)
  const rowB = sessList.onlineTopLevel.find((row) => row.id === ID.B)
  eq(rowA.state, '在线·活动', '没被任何一级按到的会话仍是 在线·活动')
  eq(rowB.state, '在线·已暂停', '被 session 级按到的会话必须显示 在线·已暂停')
  eq(rowB.pausedScopes, ['session'], '命中级别应为 session')
  eq(rowB.pausedByScopes[0].key, ID.B, 'pausedByScopes 应给出会话键')
  const sessDecl = Object.fromEntries(sessList.declarations.map((d) => [d.key, d]))
  eq(sessDecl['misas:onp'].paused, true, 'B 持有的声明也被 OR 命中')
  eq(sessDecl['misas:onp'].pausedScopes, ['session'], '命中级别应为 session')
  eq(sessDecl['misas:on'].paused, false, 'A 持有的声明不该被牵连')
  eq(sessList.domainState.pausedRecords.length, 1, 'pausedRecords 应列出被按下的记录')
  eq(sessList.domainState.pausedRecords[0].scope, 'session', '记录里的 scope 应为 session')
  eq(sessList.domainState.pausedRecords[0].key, ID.B, '记录里的 key 应为会话 id')
  eq(sessList.domainState.scopes, ['domain', 'session', 'project', 'global'], '作用域段应列出四级')

  // (c) 被按下、但推不出项目的会话 ⇒ domainState.unresolved 里要有一笔。
  const dirBlind = path.join(root, 'state-v042-list-blind')
  await pauseScope(book, dirBlind, { scope: 'session', domain: ID.X1 }, 'v042/list/blind', [], { agent: sender })
  const blindList = await call(
    mount({ domainsFile: book, stateDir: dirBlind, agents }),
    'list_domain_sessions',
    {},
    { agent: sender },
    'v042/list/blind-session-unresolved',
  )
  ok(
    blindList.domainState.unresolved.some((item) => item.level === 'project' && item.key === ID.X1),
    '被按下但推不出项目的会话 ⇒ unresolved 必须列出来',
  )
  const ownerList = await call(
    mount({ domainsFile: book, stateDir: dirBlind, agents }),
    'list_domain_owners',
    {},
    { agent: sender },
    'v042/list/owners-four-levels',
  )
  eq(ownerList.domainState.scopeImplemented, ['domain', 'session', 'project', 'global'], 'list_domain_owners 同样报四级')
  eq(ownerList.domainState.pausedRecords.length, 1, 'list_domain_owners 也要列出被按下的记录')
}

{
  // ⑧ drain 的**驱动范围**：session 恢复扫"该会话键 + 它持有的域键"；project 恢复扫 `P:*` + 属于 P 的会话键。
  const book = bookFile('v042-drain-scope', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const stateDir = path.join(root, 'state-v042-drain-scope')
  const owner13 = makeAgent(ID.A)
  const agents = [owner13]

  // 只按 session 级（ID.A）⇒ 目标是域名 或 会话名 两条都会被拦（域名那条经由"负责人会话"命中）。
  await pauseScope(book, stateDir, { scope: 'session', domain: ID.A }, 'v042/drain-scope/session', agents)
  const toDomain = await call(
    mount({ domainsFile: book, stateDir, agents }),
    'send_to_domain',
    { target: 'misas:asr', message: '目标是域（负责人会话被按）' },
    { agent: sender },
    'v042/drain-scope/queue-domain-key',
  )
  const toSession = await call(
    mount({ domainsFile: book, stateDir, agents }),
    'send_to_domain',
    { target: ID.A, message: '目标是会话' },
    { agent: sender },
    'v042/drain-scope/queue-session-key',
  )
  eq(toDomain.pausedScopes, ['session'], '域目标经由"负责人会话"命中 session 级')
  eq(toDomain.queue.key, 'misas:asr', '域目标 ⇒ 域键队列')
  eq(toSession.queue.key, ID.A, '会话目标 ⇒ 会话键队列')
  eq(readQueue(stateDir, 'misas:asr').filter((r) => r.status === 'pending').length, 1, '域键队列 1 条 pending')
  eq(readQueue(stateDir, ID.A, 'session').filter((r) => r.status === 'pending').length, 1, '会话键队列 1 条 pending')

  const resumed = await call(
    mount({ domainsFile: book, stateDir, agents }),
    'set_domain_state',
    { scope: 'session', domain: ID.A, state: 'active' },
    { agent: sender },
    'v042/drain-scope/resume-session',
  )
  eq(resumed.outcome, 'resumed', '解 session 级应成功')
  eq(resumed.drain.multi, true, 'session 恢复要扫两个键 ⇒ 多队列聚合')
  eq(resumed.drain.keys.sort(), [ID.A, 'misas:asr'].sort(), 'session 恢复＝该会话键 + 它持有的域键')
  eq(resumed.drain.delivered.length, 2, '两条 pending 都应重投')
  eq(owner13.sent.length, 2, '负责人应收到两条')
  eq(readQueue(stateDir, 'misas:asr')[0].status, 'delivered', '域键队列应标 delivered')
  eq(readQueue(stateDir, ID.A, 'session')[0].status, 'delivered', '会话键队列应标 delivered')

  // project 恢复：扫 `P:*` 域键 + 属于 P 的会话键。
  const dir2 = path.join(root, 'state-v042-drain-project')
  await pauseScope(book, dir2, { scope: 'project', domain: SENDER_CWD_PROJECT }, 'v042/drain-scope/project', agents)
  await call(
    mount({ domainsFile: book, stateDir: dir2, agents }),
    'send_to_domain',
    { target: 'misas:asr', message: '甲' },
    { agent: sender },
    'v042/drain-scope/project-queue-domain',
  )
  await call(
    mount({ domainsFile: book, stateDir: dir2, agents }),
    'send_to_domain',
    { target: ID.A, message: '乙' },
    { agent: sender },
    'v042/drain-scope/project-queue-session',
  )
  const projResume = await call(
    mount({ domainsFile: book, stateDir: dir2, agents: [makeAgent(ID.A)] }),
    'set_domain_state',
    { scope: 'project', domain: SENDER_CWD_PROJECT, state: 'active' },
    { agent: sender },
    'v042/drain-scope/resume-project',
  )
  eq(projResume.drain.multi, true, 'project 恢复要扫它覆盖的所有队列')
  ok(projResume.drain.keys.includes('misas:asr'), '应覆盖 `P:*` 域键')
  ok(projResume.drain.keys.includes(ID.A), '应覆盖属于 P 的会话键')
  eq(projResume.drain.delivered.length, 2, '两条 pending 都应重投')
  eq(projResume.drain.skipped.length, 0, '这两个队列的归属都判得出 ⇒ drain.skipped 应为空')

  // 撤回：队列按会话 id 分片 ⇒ `domain=<会话 id>` 过滤也必须找得到（E7/E8）。
  const dir3 = path.join(root, 'state-v042-withdraw-session')
  await pauseScope(book, dir3, { domain: 'misas:asr' }, 'v042/withdraw/pause-domain', agents)
  const queued = await call(
    mount({ domainsFile: book, stateDir: dir3, agents }),
    'send_to_domain',
    { target: ID.A, message: '按会话键入队，待撤回' },
    { agent: sender },
    'v042/withdraw/queue-session-key',
  )
  eq(queued.queue.scope, 'session', '应按会话键入队')
  const withdrawn = await call(
    mount({ domainsFile: book, stateDir: dir3, agents }),
    'withdraw_domain_message',
    { id: queued.queue.id, domain: ID.A },
    { agent: sender },
    'v042/withdraw/by-session-key',
  )
  eq(withdrawn.outcome, 'withdrawn', 'domain=<完整会话 id> 过滤应能撤回会话键队列里的那条')
  eq(withdrawn.key, ID.A, '命中队列的 key 应是会话 id')
  eq(withdrawn.scope, 'session', '回执里的 scope 必须是队列目标自身的 scope（会话 ⇒ session）')
  eq(withdrawn.status, 'withdrawn', '状态应改成 withdrawn')
  const byShort = await call(
    mount({ domainsFile: book, stateDir: dir3, agents }),
    'send_to_domain',
    { target: ID.A, message: '再来一条' },
    { agent: sender },
    'v042/withdraw/queue-session-key-2',
  )
  const withdrawnByShort = await call(
    mount({ domainsFile: book, stateDir: dir3, agents }),
    'withdraw_domain_message',
    { id: byShort.queue.id, domain: SHORT.A },
    { agent: sender },
    'v042/withdraw/by-session-short',
  )
  eq(withdrawnByShort.outcome, 'withdrawn', 'domain=<唯一短号> 过滤也应能找到会话键队列')
  eq(withdrawnByShort.key, ID.A, '短号应被解析成完整会话 id')
}

{
  // ⑨ F1（核验者阶段二抓到、主会话裁决"要真拦"）：**裸短名 + 域名册里没有声明**的目标，
  //    也要先按 send_to_domain 那套解析（会话 id 片段 / **索引标注**）落到一条在线会话上——
  //    落到了就按 ②会话级 ③它的项目 ④global 判，**命中即拦**；落不到才"不拦 + unresolved"。
  const book = bookFile('v042-f1-label', {}) // 域名册里**没有** asr2 的声明
  const stateDir = path.join(root, 'state-v042-f1-label')
  const labeled = makeAgent(ID.A) // cwd 默认 FIXTURE_CWD ⇒ 项目 misas
  const agents = [labeled]
  const idx = indexFileWith('f1-label', [
    { sessionId: ID.A, domain: 'asr2', number: 'S1', status: 'active', feature: 'labeled asr2' },
  ])
  // 把项目 misas 按下
  await pauseScope(book, stateDir, { scope: 'project', domain: SENDER_CWD_PROJECT }, 'v042/f1/project', agents)

  // 发送方**不在** misas 项目里（隔离出"接收端项目级"这一条，避免 self 侧混进来）
  const outsider = makeAgent(ID.S, { cwd: path.join(FIXTURE_PROJECTS, 'elsewhere') })
  const blocked = await call(
    mount({ domainsFile: book, stateDir, agents, indexFile: idx }),
    'send_to_domain',
    { target: 'asr2', message: '裸短名 + 项目被按下（F1）' },
    { agent: outsider },
    'v042/f1/bare-shortname-blocked',
  )
  eq(
    blocked.delivered,
    false,
    'F1：裸短名解析出的会话属于被按下的项目 ⇒ **必须拦**（改前是静默投出去、一个提示都没有）',
  )
  eq(blocked.queued, true, '应落盘入队（不是丢消息）')
  eq(blocked.reason, 'domain-paused', "reason 仍是冻结的 'domain-paused'")
  eq(blocked.pausedScopes, ['project'], '命中级别应为 project（接收端）')
  eq(blocked.pausedByScopes[0].via, 'target-project', '应标明是**接收端**项目级命中')
  eq(blocked.pausedByScopes[0].key, SENDER_CWD_PROJECT, '命中键应为 misas')
  eq(blocked.pausedByScopes[0].side, 'target', 'side 应为 target（发送方不在这个项目里）')
  eq(blocked.queue.key, ID.A, '入队键＝解析出来的那条会话 id（S5：目标自身的键）')
  eq(labeled.sent.length, 0, '绝不许偷投')

  // 解析不到任何会话 ⇒ **不拦**（照旧 unreachable），但**必须** unresolved 非空、写明哪几级判不成。
  const lost = await call(
    mount({
      domainsFile: bookFile('v042-f1-lost', {}),
      stateDir: path.join(root, 'state-v042-f1-lost'),
      agents: [],
    }),
    'send_to_domain',
    { target: 'asr9', message: '谁也解析不到' },
    { agent: outsider },
    'v042/f1/bare-shortname-unresolved',
  )
  eq(lost.delivered, false, '解析不到 ⇒ 照旧不投（unreachable）')
  eq(lost.reason, 'unreachable', 'reason 应为 unreachable')
  ok(
    Array.isArray(lost.unresolved) && lost.unresolved.length >= 2,
    'F1：判不出 ⇒ **必须** push unresolved（会话级 + 项目级），不许一个提示都没有',
  )
  eq(
    lost.unresolved.map((item) => item.level).sort(),
    ['project', 'session'],
    'unresolved 应写明哪两级判不成',
  )
  ok(
    lost.unresolved.every((item) => typeof item.detail === 'string' && item.detail.includes('不拦')),
    '每条 unresolved 都要说清"按不拦处理"（降级不静默）',
  )

  // 同一台机器上，**完整会话 id** 的那条路早就是对的（回归：两条路径行为一致）。
  const byId = await call(
    mount({ domainsFile: book, stateDir, agents, indexFile: idx }),
    'send_to_domain',
    { target: ID.A, message: '直接写会话 id' },
    { agent: outsider },
    'v042/f1/by-session-id-same-as-label',
  )
  eq(byId.delivered, false, '直接写会话 id 也要被同一条项目级命中拦住')
  eq(byId.pausedScopes, ['project'], '两条路径的命中级别必须一致')
  eq(byId.pausedByScopes[0].via, 'target-project', '两条路径的 via 也要一致')
}

// ------------------------------------------------------------------ 14. v0.6.0 模型分派
//
// 全部走 mock：selectModel / modelCatalog / agentDefaultModel / sessionProjections 都是假服务，
// 不真改任何会话、不真写全局默认。重点断言三件事：
//   ① 改会话模型一定是 currentSelection → selectModel → saveSelection，且 saveSelection 收到**旧值**；
//   ② 宿主抛错（session/writer-held）原样回传，但全局默认**仍然恢复**；
//   ③ create_domain_session 只在 create 成功之后才铺模型（失败时一次 selectModel 都不调）。

const MODEL_PREV = { provider: 'commandcode', model: 'deepseek/deepseek-v4-flash', reasoningEffort: 'off' }
const MODEL_CATALOG = {
  default: MODEL_PREV,
  routableProviders: ['commandcode'],
  groups: [
    {
      id: 'commandcode',
      name: 'Command Code',
      models: [
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true },
        'deepseek/deepseek-v4.1-flash',
      ],
    },
  ],
  failures: [],
}

/** sessionController-shaped fake: modelCatalog + selectModel (+ optional by-id projections), shared call log. */
function dispatchFixture(options = {}) {
  const calls = []
  const state = { saved: 'not-called' }
  const service = {
    calls,
    // The host's `modelCatalog()` is `return buildModelCatalog(this.ctx)` => a PROMISE
    // (dsh-api-session-controller/lib/index.js:3121 + lib/types/catalog.js:10). The fake must be async
    // too, otherwise the v0.6.0 "forgot await" bug could never be caught by this suite.
    async modelCatalog() {
      calls.push({ kind: 'modelCatalog' })
      if (options.catalogThrows) throw new Error('smoke: catalog exploded')
      return options.catalog === undefined ? MODEL_CATALOG : options.catalog
    },
    async selectModel(request) {
      calls.push({ kind: 'selectModel', request })
      if (options.selectError) throw options.selectError
      return { ok: true }
    },
  }
  if (options.noSelectModel) delete service.selectModel
  if (options.noCatalog) delete service.modelCatalog
  // v0.6.1: the real by-id projection reader (`@Remote('projections')`, takes a sessionId + signal).
  if (options.projections !== undefined || options.projectionsThrows === true) {
    service.projections = async (request, signal) => {
      calls.push({ kind: 'projections', request, signal })
      if (options.projectionsThrows) throw new Error('smoke: projections exploded')
      return options.projections
    }
  }
  const defaults = {
    currentSelection() {
      calls.push({ kind: 'currentSelection' })
      return 'previous' in options ? options.previous : MODEL_PREV
    },
    async saveSelection(value) {
      calls.push({ kind: 'saveSelection', value })
      if (options.saveError) throw options.saveError
      state.saved = value
    },
  }
  return { service, defaults, calls, state }
}

/** create() + selectModel() on ONE service, to assert "create first, model second". */
function modelCreateFixture(options = {}) {
  const calls = []
  const state = { saved: 'not-called' }
  const service = {
    calls,
    create: async (request) => {
      calls.push({ kind: 'create', request })
      if (options.createError) throw options.createError
      return { sessionId: options.sessionId ?? ID.C }
    },
    async selectModel(request) {
      calls.push({ kind: 'selectModel', request })
      if (options.selectError) throw options.selectError
      return { ok: true }
    },
  }
  if (options.noSelectModel) delete service.selectModel
  const defaults = {
    currentSelection() {
      calls.push({ kind: 'currentSelection' })
      return MODEL_PREV
    },
    async saveSelection(value) {
      calls.push({ kind: 'saveSelection', value })
      state.saved = value
    },
  }
  return { service, defaults, calls, state }
}

{
  // list_models ①：首选 modelCatalog（groups/models 归一化），默认值来自目录本身。
  // v0.6.1：fake 的 modelCatalog 是 async（与宿主一致）⇒ 这一条同时是"必须 await"的回归断言。
  const fixture = dispatchFixture()
  const out = await call(mount({ controller: fixture.service, agentDefaultModel: fixture.defaults }), 'list_models', {}, {}, 'v060/list-models/catalog')
  eq(out.ok, true, 'catalog 可用时应 ok:true')
  eq(out.source, 'sessionController.modelCatalog', '首选来源应是 modelCatalog')
  eq(out.default, MODEL_PREV, 'default 应从目录里取')
  eq(out.groups.length, 1, 'groups 数量不对')
  eq(out.groups[0].provider, 'commandcode', 'groups[].provider 不对')
  eq(out.groups[0].name, 'Command Code', 'groups[].name 不对')
  eq(
    out.groups[0].models,
    [
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: true },
      { id: 'deepseek/deepseek-v4.1-flash', name: 'deepseek/deepseek-v4.1-flash' },
    ],
    'models 归一化不对（字符串模型应补 name=id）',
  )
  ok(!('session' in out), '没给 session 时不应有 session 字段')
  ok(!('failures' in out), '空的 failures 不该出现在回执里')
  ok(!('attempts' in out), '只有一个来源、又不是空目录时不该带 attempts 诊断')
  ok(out.routableProviders.length === 1 && out.routableProviders[0] === 'commandcode', 'routableProviders 应来自目录')
}

{
  // list_models ①b（v0.6.1 真机 bug 回归）：modelCatalog 返回的是**裸 Promise**（老实现在这里少 await，
  // 结果 groups 恒空、routableProviders 恒 null）。现在必须 await 出真目录。
  const service = {
    modelCatalog: () => Promise.resolve(MODEL_CATALOG),
    async selectModel() {
      return { ok: true }
    },
  }
  const out = await call(mount({ controller: service }), 'list_models', {}, {}, 'v061/list-models/async-catalog')
  eq(out.ok, true, 'Promise 形状的目录也要 ok:true')
  eq(out.source, 'sessionController.modelCatalog', 'await 之后应走 modelCatalog 来源')
  eq(out.groups.length, 1, 'await 之后 groups 不应为空（v0.6.0 的真机 bug）')
  eq(out.default, MODEL_PREV, 'Promise 解析出来的 default 也要读到')
  eq(out.routableProviders, ['commandcode'], 'Promise 解析出来的 routableProviders 也要读到')
}

{
  // list_models ②：catalog 不可用 ⇒ 退 llm.listProviders()/listModels()，default 来自全局默认。
  const fixture = dispatchFixture({ noCatalog: true })
  const llm = {
    listProviders: () => ['p1'],
    listModels: (provider) => (provider === 'p1' ? ['m1', { id: 'm2', name: 'M2' }] : []),
  }
  const out = await call(
    mount({ controller: fixture.service, llm, agentDefaultModel: fixture.defaults }),
    'list_models',
    {},
    {},
    'v060/list-models/llm',
  )
  eq(out.ok, true, 'llm 退路应 ok:true')
  eq(out.source, 'llm', '来源应为 llm')
  eq(out.default, MODEL_PREV, 'catalog 没有 default 时应退全局默认')
  eq(
    out.groups,
    [{ provider: 'p1', name: 'p1', models: [{ id: 'm1', name: 'm1' }, { id: 'm2', name: 'M2' }] }],
    'llm 目录归一化不对',
  )
  // v0.6.1：发生过回退 ⇒ 回执带诊断trail（rawKeys 来自 modelCatalog，attempts 逐步记 state）。
  eq(out.rawKeys, [], 'modelCatalog 没有服务时应给空 rawKeys')
  eq(
    out.attempts.map((item) => [item.source, item.state]),
    [
      ['sessionController.modelCatalog', 'no-service'],
      ['llm', 'ok'],
    ],
    'attempts 应逐步记下两个来源的 state',
  )
}

{
  // list_models ②b（v0.6.1）：modelCatalog 形状认识、但 groups 是空数组 ⇒ **必须退 llm**，不许假装有内容。
  const fixture = dispatchFixture({ catalog: { default: MODEL_PREV, routableProviders: ['p1'], groups: [], failures: [] } })
  const llm = { listProviders: () => [{ id: 'p1', name: 'P1' }], listModels: () => [{ id: 'm1', name: 'M1' }] }
  const out = await call(
    mount({ controller: fixture.service, llm, agentDefaultModel: fixture.defaults }),
    'list_models',
    {},
    {},
    'v061/list-models/empty-catalog-falls-back',
  )
  eq(out.source, 'llm', 'modelCatalog 的 groups 为空时必须退 llm')
  eq(out.groups, [{ provider: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }], '退路目录不对')
  eq(out.rawKeys, ['default', 'routableProviders', 'groups', 'failures'], 'rawKeys 应是 modelCatalog 原始返回的键名')
  eq(
    out.attempts.map((item) => [item.source, item.state]),
    [
      ['sessionController.modelCatalog', 'empty-groups'],
      ['llm', 'ok'],
    ],
    '空目录也要留下 empty-groups 的痕迹',
  )
}

{
  // list_models ③：modelCatalog 抛错也退 llm（降级不抛）。
  const fixture = dispatchFixture({ catalogThrows: true })
  const llm = { listProviders: () => [{ id: 'p1', name: 'P1' }], listModels: () => [{ id: 'm1', name: 'M1' }] }
  const out = await call(
    mount({ controller: fixture.service, llm, agentDefaultModel: fixture.defaults }),
    'list_models',
    {},
    {},
    'v060/list-models/catalog-throws-llm',
  )
  eq(out.source, 'llm', 'modelCatalog 抛错应退 llm')
  eq(out.groups[0].provider, 'p1', '退路 provider 不对')
  eq(out.attempts[0].state, 'threw', '抛错也要如实记为 threw')
  ok(typeof out.attempts[0].note === 'string', 'threw 应带原始错误文本')
}

{
  // list_models ④（v0.6.1 改契约）：两个目录来源都拿不到东西 ⇒ **ok:true + source:'empty'**，
  // 带 rawKeys/attempts/note 便于诊断 —— 不再回 ok:false（也绝不把空目录包装成有内容）。
  const out = await call(mount({}), 'list_models', {}, {}, 'v061/list-models/empty')
  eq(out.ok, true, '空目录也应 ok:true（如实报空，不是错误）')
  eq(out.source, 'empty', '来源应为 empty')
  eq(out.groups, [], '空目录的 groups 必须是空数组')
  eq(out.routableProviders, null, '空目录没有可路由 provider')
  eq(out.rawKeys, [], '没有任何目录服务时 rawKeys 是空数组（字段必须在）')
  eq(out.note, 'catalog-empty', 'note 应为 catalog-empty')
  eq(out.default, null, '没有 agentDefaultModel 时 default 为 null')
  eq(
    out.attempts.map((item) => [item.source, item.state]),
    [
      ['sessionController.modelCatalog', 'no-service'],
      ['llm', 'no-service'],
    ],
    'attempts 应记下两个来源都不可用',
  )
  ok(typeof out.hint === 'string', '空目录应有 hint')
}

{
  // list_models ④b（v0.6.1）：llm 有 provider 但一个模型都没有 ⇒ 每个来源都是空 ⇒ source:'empty'。
  const fixture = dispatchFixture({ catalog: { default: null, routableProviders: [], groups: [], failures: [] } })
  const llm = { listProviders: () => ['p1', 'p2'], listModels: () => [] }
  const out = await call(
    mount({ controller: fixture.service, llm, agentDefaultModel: fixture.defaults }),
    'list_models',
    {},
    {},
    'v061/list-models/all-empty',
  )
  eq(out.source, 'empty', 'provider 没有模型也应算空')
  eq(out.groups, [], '没有模型的 provider 不该出现在 groups 里')
  eq(out.default, MODEL_PREV, 'default 仍然从全局默认读（这是真值，不是编的）')
  eq(out.rawKeys, ['default', 'routableProviders', 'groups', 'failures'], 'rawKeys 应为 modelCatalog 的键名')
  eq(
    out.attempts[1].note,
    'providers=p1,p2;no-models=p1,p2',
    'llm 那一步应记下 provider 与"没有模型的 provider"',
  )
}

{
  // list_models ⑤（v0.6.1）：真接口 ① —— sessionController.projections({sessionId}, signal)。
  // wire 视图是 {lastUsed, next}（next = pending ?? lastUsed）。
  const fixture = dispatchFixture({
    projections: {
      kind: 'sequenced',
      asOfSeq: 7,
      values: { modelSelection: { lastUsed: { provider: 'p9', model: 'm9' }, next: { provider: 'p10', model: 'm10' } } },
    },
  })
  const out = await call(
    mount({ controller: fixture.service }),
    'list_models',
    { session: ID.A },
    {},
    'v061/list-models/by-id-projections',
  )
  eq(
    out.session,
    {
      target: ID.A,
      matchedBy: 'session-id',
      lastUsed: { provider: 'p9', model: 'm9' },
      pending: { provider: 'p10', model: 'm10' },
      source: 'sessionController.projections',
      kind: 'sequenced',
      asOfSeq: 7,
    },
    'session 段应从 projections 的 wire 视图映射过来',
  )
  ok(!('sessionRead' in out), '读到了就不该出现 sessionRead')
  const projectionsCall = fixture.calls.find((call) => call.kind === 'projections')
  eq(projectionsCall.request, { sessionId: ID.A }, 'projections 必须以 {sessionId} 调用')
  ok(typeof projectionsCall.signal === 'object' && projectionsCall.signal !== null, '必须传 AbortSignal')
}

{
  // list_models ⑤b（v0.6.1 真机 bug 回归）：只能走退路时，stateOf 必须收到**Session 对象**——v0.6.0 传的是
  // id 字符串，宿主 stateOf 会当场抛（它要用 session.header / session.snapshotEvents()）。
  const agent = makeAgent(ID.A)
  const asked = []
  const projections = {
    stateOf(session, kind) {
      asked.push([session, kind])
      return { lastUsed: { provider: 'p9', model: 'm9' }, pending: { provider: 'p10', model: 'm10' } }
    },
  }
  const out = await call(
    mount({ controller: dispatchFixture().service, sessionProjections: projections, agents: [agent] }),
    'list_models',
    { session: ID.A },
    {},
    'v061/list-models/live-session-state',
  )
  eq(asked.length, 1, 'stateOf 应被调用一次')
  ok(asked[0][0] === agent.session, 'stateOf 必须收到 Session 对象（不是 id 字符串）')
  eq(asked[0][1], 'modelSelection', 'stateOf 的 key 应是 modelSelection')
  eq(
    out.session,
    {
      target: ID.A,
      matchedBy: 'session-id',
      lastUsed: { provider: 'p9', model: 'm9' },
      pending: { provider: 'p10', model: 'm10' },
      source: 'sessionProjections.stateOf',
    },
    'session 段应来自宿主 state（{lastUsed, pending}）',
  )
}

{
  // list_models ⑤c（v0.6.1）：target 传域键 ⇒ 先解析成负责人会话，再读投影。
  const book = bookFile('v061-list-models-domain', { 'misas:asr': owner('misas', 'asr', ID.B) })
  const fixture = dispatchFixture({
    projections: { kind: 'sequenced', asOfSeq: 3, values: { modelSelection: { lastUsed: null, next: null } } },
  })
  const byDomain = await call(
    mount({ controller: fixture.service, domainsFile: book }),
    'list_models',
    { session: 'misas:asr' },
    {},
    'v061/list-models/session-domain',
  )
  eq(byDomain.session.target, ID.B, '域键应解析到负责人会话再读投影')
  eq(byDomain.session.matchedBy, 'declaration', 'matchedBy 应记下解析方式')
  eq(byDomain.session.lastUsed, null, '宿主说没有 lastUsed 就如实报 null')
  const projectionsCall = fixture.calls.find((call) => call.kind === 'projections')
  eq(projectionsCall.request.sessionId, ID.B, 'projections 应问负责人会话')
}

{
  // list_models ⑤d（v0.6.1）：两个读法都失败 ⇒ **不给 session**，改成如实报 sessionRead（不再静默省略）。
  const out = await call(
    mount({ controller: dispatchFixture({ projectionsThrows: true }).service }),
    'list_models',
    { session: ID.A },
    {},
    'v061/list-models/session-read-failed',
  )
  ok(!('session' in out), '读不到就不该给 session 字段')
  eq(out.sessionRead.ok, false, 'sessionRead.ok 应为 false')
  eq(out.sessionRead.reason, 'projection-unavailable', 'reason 应为 projection-unavailable')
  eq(out.sessionRead.target, ID.A, 'sessionRead 也要带回目标会话')
  eq(out.sessionRead.tried, ['sessionController.projections'], 'tried 应记下试过的读法')
  eq(out.sessionRead.failures[0].source, 'sessionController.projections', 'failures 要指名道姓')
  ok(typeof out.sessionRead.failures[0].reason === 'string', 'failures 要带原因')

  const unresolved = await call(
    mount({ controller: dispatchFixture().service }),
    'list_models',
    { session: 'misas:nope' },
    {},
    'v061/list-models/session-unresolved',
  )
  ok(!('session' in unresolved), '目标解析不了也不该给 session 字段')
  eq(unresolved.sessionRead.ok, false, '解析失败也要如实报')
  eq(unresolved.sessionRead.reason, 'target-unresolved', 'reason 应是解析失败原因')
}

{
  // set_model ①：正常改 + 先记后恢复；调用顺序与 saveSelection 收到的旧值都要对上。
  const fixture = dispatchFixture()
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults }),
    'set_model',
    { provider: 'commandcode', model: 'deepseek/new', reasoningEffort: 'high', allowSelf: true },
    { agent: sender },
    'v060/set-model/ok',
  )
  eq(out.ok, true, '正常改应 ok:true')
  eq(out.sessionId, ID.S, '不带 target 应改调用者自己')
  eq(out.target, ID.S, 'target 回执不对')
  eq(out.matchedBy, 'caller', 'matchedBy 应为 caller')
  eq(out.applied, 'next-request', 'applied 应为 next-request')
  eq(out.previous, MODEL_PREV, 'previous 应是改之前的全局默认')
  eq(out.globalDefault.before, MODEL_PREV, 'globalDefault.before 不对')
  eq(out.globalDefault.after, MODEL_PREV, 'globalDefault.after 应恢复成旧值')
  eq(out.globalDefault.restored, true, '应恢复全局默认')
  eq(
    fixture.calls.map((call) => call.kind),
    ['currentSelection', 'selectModel', 'saveSelection'],
    '调用顺序必须是 currentSelection → selectModel → saveSelection',
  )
  eq(
    fixture.calls[1].request,
    { sessionId: ID.S, provider: 'commandcode', model: 'deepseek/new', reasoningEffort: 'high' },
    'selectModel 请求不对（reasoningEffort 应一起传）',
  )
  eq(fixture.calls[2].value, MODEL_PREV, 'saveSelection 必须收到**旧值**')
  eq(fixture.state.saved, MODEL_PREV, '全局默认应恢复成旧值')
}

{
  // set_model ②：没传 reasoningEffort ⇒ 请求里不能有它（不发明默认值）。
  const fixture = dispatchFixture()
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults }),
    'set_model',
    { provider: 'p', model: 'm', allowSelf: true },
    { agent: sender },
    'v060/set-model/no-effort',
  )
  eq(out.ok, true, '应成功')
  ok(!('reasoningEffort' in fixture.calls[1].request), '没传 reasoningEffort 时不得出现在请求里')
}

{
  // set_model ③：宿主抛 session/writer-held ⇒ 原样回传 + 仍然恢复全局默认。
  const error = Object.assign(new Error('session is held by a writer'), { code: 'session/writer-held' })
  const fixture = dispatchFixture({ selectError: error })
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults }),
    'set_model',
    { provider: 'p', model: 'm', allowSelf: true },
    { agent: sender },
    'v060/set-model/writer-held',
  )
  eq(out.ok, false, '宿主失败应 ok:false')
  eq(out.reason, 'session/writer-held', '宿主失败码应原样带回')
  eq(out.error, 'session is held by a writer', 'error 应是宿主原文')
  eq(out.globalDefault.restored, true, '即使 selectModel 失败也要恢复全局默认')
  eq(
    fixture.calls.map((call) => call.kind),
    ['currentSelection', 'selectModel', 'saveSelection'],
    '失败路径的调用顺序也应含恢复',
  )
  eq(fixture.state.saved, MODEL_PREV, '失败路径也必须把旧值写回去')
}

{
  // set_model ④：恢复失败 ⇒ 如实 restored:false + error，不许假装成功。
  const fixture = dispatchFixture({ saveError: new Error('smoke: save exploded') })
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults }),
    'set_model',
    { provider: 'p', model: 'm', allowSelf: true },
    { agent: sender },
    'v060/set-model/restore-fails',
  )
  eq(out.ok, true, '会话模型本身改成功了')
  eq(out.globalDefault.restored, false, '恢复失败必须 restored:false')
  eq(out.globalDefault.error, 'smoke: save exploded', '恢复失败必须带错误原因')
  eq(out.globalDefault.after, { provider: 'p', model: 'm' }, '恢复失败后全局默认大概率已变成新选择')
}

{
  // set_model ⑤：target 传域键 ⇒ 解析到域名册里的负责人会话。
  const book = bookFile('v060-set-model-domain', { 'misas:asr': owner('misas', 'asr', ID.A) })
  const fixture = dispatchFixture()
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults, domainsFile: book }),
    'set_model',
    { target: 'misas:asr', provider: 'p', model: 'm' },
    {},
    'v060/set-model/domain',
  )
  eq(out.ok, true, '域键目标应成功')
  eq(out.sessionId, ID.A, '应解析到负责人会话')
  eq(out.matchedBy, 'declaration', 'matchedBy 应为 declaration')
  eq(out.target, 'misas:asr', 'target 回执应是域键')
  eq(fixture.calls[1].request.sessionId, ID.A, 'selectModel 应作用于负责人会话')
}

{
  // set_model ⑥：target 传短号 ⇒ 解析到在线会话。
  const fixture = dispatchFixture()
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults, agents: [makeAgent(ID.A)] }),
    'set_model',
    { target: 'sess-11111111', provider: 'p', model: 'm' },
    {},
    'v060/set-model/short-id',
  )
  eq(out.sessionId, ID.A, '短号应解析到完整会话 id')
  eq(out.matchedBy, 'session-id', 'matchedBy 应为 session-id')
}

{
  // set_model ⑦：ctx 上没有 selectModel ⇒ api-unavailable，不抛、也不碰全局默认。
  const fixture = dispatchFixture({ noSelectModel: true })
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults }),
    'set_model',
    { provider: 'p', model: 'm', allowSelf: true },
    { agent: sender },
    'v060/set-model/api-unavailable',
  )
  eq(out.ok, false, '没有 selectModel 应 ok:false')
  eq(out.reason, 'api-unavailable', 'reason 应为 api-unavailable')
  eq(out.globalDefault.restored, false, 'api-unavailable 时不应恢复（一次都没改）')
  eq(fixture.calls.length, 0, 'api-unavailable 时不应调用 currentSelection/selectModel/saveSelection')
}

{
  // set_model ⑧：provider/model 空、以及拿不到调用者会话 ⇒ 明确报错。
  const invalid = await call(mount({}), 'set_model', { provider: 'p', model: '  ' }, { agent: sender }, 'v060/set-model/invalid-model')
  eq(invalid.reason, 'invalid-model', '空 model 应 invalid-model')
  const unknown = await call(mount({}), 'set_model', { provider: 'p', model: 'm' }, {}, 'v060/set-model/target-unknown')
  eq(unknown.reason, 'target-unknown', '拿不到调用者会话应 target-unknown')
  ok(typeof unknown.hint === 'string', 'target-unknown 应提示显式传 target')
}

{
  // set_model ⑨：选的就是当前默认 ⇒ 不需要也不应该再写全局默认。
  const fixture = dispatchFixture()
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults }),
    'set_model',
    { provider: MODEL_PREV.provider, model: MODEL_PREV.model, reasoningEffort: MODEL_PREV.reasoningEffort, allowSelf: true },
    { agent: sender },
    'v060/set-model/same-as-default',
  )
  eq(out.globalDefault.restored, false, '没有变化时不应恢复')
  eq(out.globalDefault.afterSource, 'unchanged', 'afterSource 应说明"没变"')
  eq(
    fixture.calls.map((call) => call.kind),
    ['currentSelection', 'selectModel'],
    '没有变化时不应调用 saveSelection',
  )
}

{
  // set_model ⑩：目标是调用者自己 ⇒ 必须显式 allowSelf:true（2026-10-17 真实事故的硬护栏）。
  const denied = dispatchFixture()
  const out = await call(
    mount({ controller: denied.service, agentDefaultModel: denied.defaults }),
    'set_model',
    { provider: 'p', model: 'm' },
    { agent: sender },
    'v060/set-model/self-guard',
  )
  eq(out.ok, false, '改自己且没传 allowSelf 应被拒绝')
  eq(out.reason, 'self-target-needs-allowSelf', 'reason 应为 self-target-needs-allowSelf')
  eq(denied.calls.length, 0, '被护栏拒绝时一次服务都不该调用（不记默认、不改会话、不写全局）')
  ok(typeof out.hint === 'string', '护栏拒绝应给出怎么放行的提示')

  const allowedFixture = dispatchFixture()
  const allowed = await call(
    mount({ controller: allowedFixture.service, agentDefaultModel: allowedFixture.defaults }),
    'set_model',
    { provider: 'p', model: 'm', allowSelf: true },
    { agent: sender },
    'v060/set-model/self-allow',
  )
  eq(allowed.ok, true, '显式 allowSelf:true 时应放行')
  eq(allowed.sessionId, ID.S, '放行后仍应作用于调用者自己')
}

{
  // create_domain_session ①：显式 model ⇒ 创建成功后立刻 selectModel（顺序 create → 记 → 改 → 恢复）。
  const fixture = modelCreateFixture()
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults, agents: [makeAgent(ID.C)] }),
    'create_domain_session',
    { domain: 'asr', task: 'x', model: { provider: 'commandcode', model: 'deepseek/new', reasoningEffort: 'off' } },
    createExec,
    'v060/create-model/explicit',
  )
  eq(out.created, true, '应建成功')
  eq(out.modelApplied.ok, true, '模型应铺成功')
  eq(out.modelApplied.source, 'explicit', '来源应为 explicit')
  eq(out.modelApplied.provider, 'commandcode', 'provider 回执不对')
  eq(
    fixture.calls.map((call) => call.kind),
    ['create', 'currentSelection', 'selectModel', 'saveSelection'],
    '必须是先创建、再记/改/恢复模型',
  )
  eq(
    fixture.calls[2].request,
    { sessionId: ID.C, provider: 'commandcode', model: 'deepseek/new', reasoningEffort: 'off' },
    'selectModel 应作用于新建的会话',
  )
}

{
  // create_domain_session ②：显式 model 优先于配置。
  const fixture = modelCreateFixture()
  const out = await call(
    mount({
      controller: fixture.service,
      agentDefaultModel: fixture.defaults,
      agents: [makeAgent(ID.C)],
      domainSessionModel: { provider: 'cfg-provider', model: 'cfg-model' },
    }),
    'create_domain_session',
    { domain: 'asr', task: 'x', model: { provider: 'explicit-provider', model: 'explicit-model' } },
    createExec,
    'v060/create-model/explicit-wins',
  )
  eq(out.modelApplied.source, 'explicit', '显式参数应优先')
  eq(fixture.calls[2].request.provider, 'explicit-provider', 'selectModel 应用显式 model')
}

{
  // create_domain_session ③：没传 model ⇒ 读部署配置 domainSessionModel。
  const fixture = modelCreateFixture()
  const out = await call(
    mount({
      controller: fixture.service,
      agentDefaultModel: fixture.defaults,
      agents: [makeAgent(ID.C)],
      domainSessionModel: { provider: 'cfg-provider', model: 'cfg-model' },
    }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v060/create-model/config',
  )
  eq(out.modelApplied.source, 'config', '来源应为 config')
  eq(fixture.calls[2].request.provider, 'cfg-provider', 'selectModel 应用配置里的 model')
}

{
  // create_domain_session ④：既没传 model、也没有配置 ⇒ 一次 selectModel 都不调（旧行为不变）。
  const fixture = modelCreateFixture()
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults, agents: [makeAgent(ID.C)] }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v060/create-model/none',
  )
  eq(out.created, true, '应建成功')
  ok(!('modelApplied' in out), '没有模型要求时不应出现 modelApplied')
  eq(fixture.calls.filter((call) => call.kind === 'selectModel').length, 0, '没有模型要求时不得调 selectModel')
}

{
  // create_domain_session ⑤：非法配置 = 当没有（永不抛）；非法显式 model ⇒ 建之前就拒绝。
  const fixture = modelCreateFixture()
  const badConfig = await call(
    mount({
      controller: fixture.service,
      agentDefaultModel: fixture.defaults,
      agents: [makeAgent(ID.C)],
      domainSessionModel: { provider: 'only-provider' },
    }),
    'create_domain_session',
    { domain: 'asr', task: 'x' },
    createExec,
    'v060/create-model/invalid-config',
  )
  eq(badConfig.created, true, '非法配置不应阻止建会话')
  ok(!('modelApplied' in badConfig), '非法配置应被当成"没有"')
  eq(fixture.calls.filter((call) => call.kind === 'selectModel').length, 0, '非法配置不得调 selectModel')

  const explicitBad = await call(
    mount({}),
    'create_domain_session',
    { domain: 'asr', task: 'x', model: { provider: 'p' } },
    createExec,
    'v060/create-model/invalid-explicit',
  )
  eq(explicitBad.created, false, '非法显式 model 不应建会话')
  eq(explicitBad.reason, 'invalid-model', 'reason 应为 invalid-model')
}

{
  // create_domain_session ⑥：create 本身失败 ⇒ 一个模型都不改。
  const fixture = modelCreateFixture({ createError: new Error('smoke: create exploded') })
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults }),
    'create_domain_session',
    { domain: 'asr', task: 'x', model: { provider: 'p', model: 'm' } },
    createExec,
    'v060/create-model/create-fails',
  )
  eq(out.created, false, '应 created:false')
  eq(out.reason, 'create-failed', 'reason 应为 create-failed')
  eq(fixture.calls.filter((call) => call.kind === 'selectModel').length, 0, '创建失败时绝不能调 selectModel')
  eq(fixture.calls.filter((call) => call.kind === 'saveSelection').length, 0, '创建失败时绝不能写全局默认')
}

{
  // create_domain_session ⑦：宿主没有 selectModel ⇒ created:true + modelApplied.ok:false（不抛）。
  const fixture = modelCreateFixture({ noSelectModel: true })
  const out = await call(
    mount({ controller: fixture.service, agentDefaultModel: fixture.defaults, agents: [makeAgent(ID.C)] }),
    'create_domain_session',
    { domain: 'asr', task: 'x', model: { provider: 'p', model: 'm' } },
    createExec,
    'v060/create-model/api-unavailable',
  )
  eq(out.created, true, '建会话本身应成功')
  eq(out.modelApplied.ok, false, '没有 selectModel 时 modelApplied.ok 应为 false')
  eq(out.modelApplied.error, 'api-unavailable', 'error 应为 api-unavailable')
}

{
  // create_domain_session ⑧：dryRun 只报告将会铺什么模型，不真建、不真改。
  const out = await call(
    mount({ domainSessionModel: { provider: 'cfg-provider', model: 'cfg-model' } }),
    'create_domain_session',
    { domain: 'asr', task: 'x', dryRun: true },
    createExec,
    'v060/create-model/dry-run',
  )
  eq(out.created, false, 'dryRun 不建会话')
  eq(out.wouldSetModel.requested, true, 'wouldSetModel.requested 应为 true')
  eq(out.wouldSetModel.source, 'config', 'wouldSetModel.source 应为 config')
  eq(out.wouldSetModel.provider, 'cfg-provider', 'wouldSetModel.provider 不对')
}

{
  // create_domain_session ⑨：<home>/config.json 里的 domainSessionModel 也能读到（第二层配置）。
  const home = path.join(root, 'home-config-model')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ domainSessionModel: { provider: 'home-provider', model: 'home-model', reasoningEffort: 'off' } }),
    'utf8',
  )
  process.env.DSH_DOMAIN_BRIDGE_HOME = home
  try {
    const fixture = modelCreateFixture()
    const out = await call(
      mount({ controller: fixture.service, agentDefaultModel: fixture.defaults, agents: [makeAgent(ID.C)] }),
      'create_domain_session',
      { domain: 'asr', task: 'x' },
      createExec,
      'v060/create-model/home-config',
    )
    eq(out.modelApplied.source, 'config', '来源应为 config（<home>/config.json）')
    eq(fixture.calls[2].request.provider, 'home-provider', '应读到 home config 里的 provider')
    eq(fixture.calls[2].request.reasoningEffort, 'off', 'home config 的 reasoningEffort 也应透传')
  } finally {
    process.env.DSH_DOMAIN_BRIDGE_HOME = SUITE_HOME
  }
}

// ------------------------------------------------------------------ 15. v0.6.1 全局默认模型 + 真机修正
//
// 全部 mock：不真改任何会话、不真写全局默认、不读本机 config.json。重点断言：
//   ① set_default_model **不恢复**（saveSelection 只收到一次、就是新值；没有第二次写回旧值）；
//   ② 宿主的 saveSelection 可能是静默 no-op（无部署配置入口 / 无 configEditor）⇒ 如实报
//      verified:false / applied:'not-observed'，绝不假装成功；
//   ③ 服务不可用 / 参数非法 / 保存抛错三条错误路径都不抛错、且一次都不写。

/** agentDefaultModel-shaped fake: `currentSelection()` reflects whatever `saveSelection()` wrote. */
function defaultModelFixture(options = {}) {
  const calls = []
  let current = 'current' in options ? options.current : MODEL_PREV
  const service = {
    calls,
    currentSelection() {
      calls.push({ kind: 'currentSelection' })
      if (options.currentThrows) throw new Error('smoke: currentSelection exploded')
      return current
    },
    async saveSelection(value) {
      calls.push({ kind: 'saveSelection', value })
      if (options.saveError) throw options.saveError
      // silentNoop: the host's saveSelection returns fulfilled undefined when there is no deployment
      // config entry / no configEditor (dsh-agent-default-model/lib/index.js:saveSelection).
      if (options.silentNoop !== true) current = value
    },
  }
  if (options.noCurrentSelection) delete service.currentSelection
  if (options.noSaveSelection) delete service.saveSelection
  return { service, calls }
}

const SET_DEFAULT_NOTE = '影响之后新建的、且尚无会话级选择的 Agent；改正在跑的会话要用 set_model'

{
  // set_default_model ①：正常改 —— 写入新值、**不恢复**（与 set_model 相反），并逐字校验读回。
  const fixture = defaultModelFixture()
  const wanted = { provider: 'commandcode', model: 'deepseek/new', reasoningEffort: 'high' }
  const out = await call(
    mount({ agentDefaultModel: fixture.service }),
    'set_default_model',
    wanted,
    { agent: sender },
    'v061/set-default-model/ok',
  )
  eq(out.ok, true, '正常改应 ok:true')
  eq(out.source, 'agentDefaultModel', 'source 应为 agentDefaultModel')
  eq(out.note, SET_DEFAULT_NOTE, 'note 文案应是约定的那一句')
  eq(out.before, MODEL_PREV, 'before 应是改之前的全局默认')
  eq(out.after, wanted, 'after 应是改之后（新值留下的）')
  eq(out.saved, wanted, 'saved 应是本次请求写入的选择')
  eq(out.verified, true, '读回来与写入逐字一致 ⇒ verified:true')
  eq(out.applied, 'global-default', 'applied 应为 global-default')
  eq(
    fixture.calls.map((item) => item.kind),
    ['currentSelection', 'saveSelection', 'currentSelection'],
    '调用顺序必须是 读 before → saveSelection → 读 after',
  )
  eq(fixture.calls[1].value, wanted, 'saveSelection 必须收到**新值**')
  eq(
    fixture.calls.filter((item) => item.kind === 'saveSelection').length,
    1,
    '本工具**不恢复**：saveSelection 只允许被调用一次（绝不能有写回旧值的第二次）',
  )
}

{
  // set_default_model ②：没传 reasoningEffort ⇒ 写下去的请求里不能有它（不发明默认值）。
  const fixture = defaultModelFixture()
  const out = await call(
    mount({ agentDefaultModel: fixture.service }),
    'set_default_model',
    { provider: 'p', model: 'm' },
    {},
    'v061/set-default-model/no-effort',
  )
  eq(out.ok, true, '应成功')
  eq(out.saved, { provider: 'p', model: 'm' }, 'saved 不该有 reasoningEffort')
  ok(!('reasoningEffort' in fixture.calls[1].value), '没传 reasoningEffort 时不得出现在 saveSelection 请求里')
}

{
  // set_default_model ③：服务不可用（ctx 上没有 / 只有 currentSelection 没有 saveSelection）⇒
  // api-unavailable，一次都不写、不抛。
  const bare = await call(mount({}), 'set_default_model', { provider: 'p', model: 'm' }, {}, 'v061/set-default-model/no-service')
  eq(bare.ok, false, '没有 agentDefaultModel 应 ok:false')
  eq(bare.reason, 'api-unavailable', 'reason 应为 api-unavailable')
  ok(typeof bare.hint === 'string', 'api-unavailable 应有 hint')

  const readOnlyFixture = defaultModelFixture({ noSaveSelection: true })
  const readOnly = await call(
    mount({ agentDefaultModel: readOnlyFixture.service }),
    'set_default_model',
    { provider: 'p', model: 'm' },
    {},
    'v061/set-default-model/read-only-service',
  )
  eq(readOnly.reason, 'api-unavailable', '只有 currentSelection 时也算不可用（这一半需要"能写"）')
  eq(readOnlyFixture.calls.length, 0, 'api-unavailable 时不应调用任何服务方法')
}

{
  // set_default_model ④：参数非法 ⇒ invalid-model，一次都不写、不抛。
  const fixture = defaultModelFixture()
  const noProvider = await call(
    mount({ agentDefaultModel: fixture.service }),
    'set_default_model',
    { model: 'm' },
    {},
    'v061/set-default-model/missing-provider',
  )
  eq(noProvider.ok, false, '缺 provider 应 ok:false')
  eq(noProvider.reason, 'invalid-model', 'reason 应为 invalid-model')
  eq(noProvider.requested, { provider: '', model: 'm', reasoningEffort: null }, 'requested 应如实回显（空就是空字符串，不是 undefined）')

  const blankModel = await call(
    mount({ agentDefaultModel: fixture.service }),
    'set_default_model',
    { provider: 'p', model: '   ' },
    {},
    'v061/set-default-model/blank-model',
  )
  eq(blankModel.reason, 'invalid-model', '全空白的 model 应 invalid-model')
  eq(fixture.calls.length, 0, 'invalid-model 时一次服务调用都不该有')
}

{
  // set_default_model ⑤：宿主保存抛错 ⇒ ok:false + 原样带回宿主错误码 + error（不抛）。
  const error = Object.assign(new Error('smoke: save exploded'), { code: 'settings/denied' })
  const fixture = defaultModelFixture({ saveError: error })
  const out = await call(
    mount({ agentDefaultModel: fixture.service }),
    'set_default_model',
    { provider: 'p', model: 'm' },
    {},
    'v061/set-default-model/save-fails',
  )
  eq(out.ok, false, '保存失败应 ok:false')
  eq(out.reason, 'settings/denied', '宿主错误码应原样带回')
  eq(out.error, 'smoke: save exploded', 'error 应是宿主原文')
}

{
  // set_default_model ⑥（本版关键）：宿主的 saveSelection **静默 no-op**（回 fulfilled undefined 但没写进去）
  // ⇒ 不许假装成功：verified:false / applied:'not-observed'，hint 明说"不能确认真的写进去了"。
  const fixture = defaultModelFixture({ silentNoop: true })
  const out = await call(
    mount({ agentDefaultModel: fixture.service }),
    'set_default_model',
    { provider: 'p', model: 'm' },
    {},
    'v061/set-default-model/silent-noop',
  )
  eq(out.ok, true, '宿主没抛错 ⇒ ok:true（调用本身成功）')
  eq(out.after, MODEL_PREV, 'after 应如实是"没变"的旧值')
  eq(out.verified, false, '读回来与写入不一致 ⇒ verified:false')
  eq(out.applied, 'not-observed', 'applied 应为 not-observed')
  ok(out.hint.includes('不能确认真的写进去了'), 'hint 必须点破"静默 no-op"这个坑')
}

{
  // set_default_model ⑦：宿主不能读回（没有 currentSelection）⇒ before/after 都是 null，
  // applied:'readback-unavailable'，但写入本身照样发生、不抛。
  const fixture = defaultModelFixture({ noCurrentSelection: true })
  const out = await call(
    mount({ agentDefaultModel: fixture.service }),
    'set_default_model',
    { provider: 'p', model: 'm' },
    {},
    'v061/set-default-model/no-readback',
  )
  eq(out.ok, true, '没有读回能力也应能写')
  eq(out.before, null, '读不回 before 就如实报 null')
  eq(out.after, null, '读不回 after 就如实报 null')
  eq(out.verified, false, '读不回来就不能说 verified')
  eq(out.applied, 'readback-unavailable', 'applied 应为 readback-unavailable')
  eq(fixture.calls.filter((item) => item.kind === 'saveSelection').length, 1, '写入仍应发生')
}

{
  // set_default_model ⑧：currentSelection 抛错 ⇒ 降级成 before/after:null + beforeError/afterError，不抛。
  const fixture = defaultModelFixture({ currentThrows: true })
  const out = await call(
    mount({ agentDefaultModel: fixture.service }),
    'set_default_model',
    { provider: 'p', model: 'm' },
    {},
    'v061/set-default-model/read-throws',
  )
  eq(out.ok, true, '读回抛错不该让写入失败')
  eq(out.before, null, 'before 应降级成 null')
  eq(out.beforeError, 'smoke: currentSelection exploded', 'beforeError 应如实带原因')
  eq(out.afterError, 'smoke: currentSelection exploded', 'afterError 也应如实带原因')
  eq(fixture.calls.filter((item) => item.kind === 'saveSelection').length, 1, '写入仍应发生')
}

console.warn = realWarn
// ------------------------------------------------------------------ summary

console.log(
  `[smoke] v${pkg.version} | 工具 ${EXPECTED_TOOLS.length}/${EXPECTED_TOOLS.length} 全注册 | 分支用例 ${stats.cases} | ` +
    `深度扫描节点 ${stats.nodes} | 无损往返断言 ${stats.roundTrips}/${stats.roundTrips} | 分支断言 ${stats.branchChecks} | 全部通过`,
)
fs.rmSync(root, { recursive: true, force: true })
