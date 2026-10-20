/**
 * dsh-domain-bridge — shared constants, portable runtime paths and the small generic helpers.
 *
 * Split out of the single-file lib/bridge.js in v0.6.3 (pure move: no behaviour change).
 * The package entry point stays lib/bridge.js, which re-exports this module.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const PLUGIN = 'dsh-domain-bridge'
export const VERSION = '0.8.4'
/**
 * v0.3.6 审计 traceId（项目规则 vibe-audit-logger-lite）：本次三处行为日志共用它，
 * 完整故事线落在 projectlog/2026-10-12-域桥v0.3.6-F1F2F4交接防混乱.md。
 */
export const TRACE_ID = 'bridge-v036-1012'
/** v0.4.0 审计 traceId（同上规则）：暂停/入队/恢复重投/撤回的行为日志共用它。 */
export const TRACE_ID_V040 = 'bridge-v040-1013'
/** v0.4.1 审计 traceId（同上规则）：拉活接线解析/拒绝拉活/恢复时尝试唤醒共用它。 */
export const TRACE_ID_V041 = 'bridge-v041-1013'
/** v0.4.2 审计 traceId（同上规则）：四级暂停的 OR 判定/global 防误触/恢复重评共用它。 */
export const TRACE_ID_V042 = 'bridge-v042-1014'
/** v0.6.1 审计 traceId（同上规则）：全局默认模型的读写（set_default_model 入口/结果）共用它。 */
export const TRACE_ID_V061 = 'bridge-v061-1017'
/**
 * portable install (v0.4.2) — everything machine-specific is resolved at load time, never baked
 * into this file:
 *   home        = DSH_DOMAIN_BRIDGE_HOME  ||  <os.homedir()>/.dsh/dsh-domain-bridge
 *   indexFile   = deployment config → <home>/config.json → DSH_DOMAIN_BRIDGE_INDEX → <home>/registry.json
 *   domainsFile = deployment config → <home>/config.json → DSH_DOMAIN_BRIDGE_DOMAINS → <home>/domains.json
 *   ownerCli    = deployment config → <home>/config.json → DSH_DOMAIN_BRIDGE_OWNER_CLI → '' (generic wording)
 * The two defaults live in the runtime home (which starts out empty ⇒ 0 domains, no throw), and the
 * package directory is never written to. `stateDir` defaults to <home>/state.
 */
export const HOME_ENV = 'DSH_DOMAIN_BRIDGE_HOME'
export const INDEX_ENV = 'DSH_DOMAIN_BRIDGE_INDEX'
export const DOMAINS_ENV = 'DSH_DOMAIN_BRIDGE_DOMAINS'
export const OWNER_CLI_ENV = 'DSH_DOMAIN_BRIDGE_OWNER_CLI'
/** Name of the optional per-machine file inside `home`. */
export const HOME_CONFIG_NAME = 'config.json'
/** Default filenames inside `home` (self-sufficient: an absent/empty file is a normal "no data"). */
export const HOME_INDEX_NAME = 'registry.json'
export const HOME_DOMAINS_NAME = 'domains.json'


// --------------------------------------------------------------- v0.4.0/v0.4.2: two axes + lifecycle + scopes

/**
 * 政策轴的**四级作用域**（v0.4.2）：
 *   `domain`  ＝「项目:域」——域名册里的一个 key（**要求已有一条在任声明**，v0.4.0 的语义一字不改）
 *   `session` ＝ 完整会话 id（`session-<uuid>`）＝中文说的「主（单会话暂停）」
 *   `project` ＝ 项目名小写（某会话 cwd 的目录名小写，与 claim_domain 短名补全同一约定）
 *   `global`  ＝ 保留键 `*`（唯一）
 * 机器面字面量**只能**是这四个（中文只在文档/回执里出现）。
 */
export const SCOPE_DOMAIN = 'domain'
export const SCOPE_SESSION = 'session'
export const SCOPE_PROJECT = 'project'
export const SCOPE_GLOBAL = 'global'
export const PAUSE_SCOPES = [SCOPE_DOMAIN, SCOPE_SESSION, SCOPE_PROJECT, SCOPE_GLOBAL]
/** global 的保留键（唯一）。 */
export const GLOBAL_KEY = '*'
/** 工具参数 `scope` 接受的中文别名（机器面仍归一到上面四个字面量）。 */
export const SCOPE_ALIASES = {
  domain: SCOPE_DOMAIN,
  域: SCOPE_DOMAIN,
  session: SCOPE_SESSION,
  主: SCOPE_SESSION,
  会话: SCOPE_SESSION,
  project: SCOPE_PROJECT,
  项目: SCOPE_PROJECT,
  global: SCOPE_GLOBAL,
  全局: SCOPE_GLOBAL,
}
/** 政策轴上"这个 scope 没有「在线/离线」这回事"时用的两个词（project / global 的对外状态）。 */
export const STATE_POLICY_PAUSED = '已暂停'
export const STATE_POLICY_ACTIVE = '活动'

/**
 * 派生状态（**算出来**的，永不落盘、永不当作事实来源）。见 CHANGELOG.md v0.4.0 段：
 *   两个轴（在线/离线 × 活动/已暂停）+ 生命周期（在用/已终结）。
 * 判据（`deriveDomainState`）：
 *   · 域名册里还有这条声明 ⇒ 「在线|离线 · 活动|已暂停」（按 isSessionOnline + paused）
 *   · 声明没了 且 有墓碑（terminatedAt） ⇒ 「已终结」
 *   · 声明没了 也没墓碑 ⇒ null＝"不在册"，**不猜**
 */
export const STATE_ONLINE_ACTIVE = '在线·活动'
export const STATE_ONLINE_PAUSED = '在线·已暂停'
export const STATE_OFFLINE_ACTIVE = '离线·活动'
export const STATE_OFFLINE_PAUSED = '离线·已暂停'
export const STATE_TERMINATED = '已终结'
export const DERIVED_STATE_NAMES = [
  STATE_ONLINE_ACTIVE,
  STATE_ONLINE_PAUSED,
  STATE_OFFLINE_ACTIVE,
  STATE_OFFLINE_PAUSED,
  STATE_TERMINATED,
]
/** list_* 里展示的**五态字典**（让五个派生状态在任何一次 list 调用里都抬眼可见）。 */
export const DERIVED_STATE_LEGEND = [
  { name: STATE_ONLINE_ACTIVE, axes: { online: true, paused: false }, meaning: '有活 Agent，政策轴上活动：正常在岗。' },
  { name: STATE_ONLINE_PAUSED, axes: { online: true, paused: true }, meaning: '有活 Agent，但该域已被按下暂停：插件介导的投递被拦、消息入队。' },
  { name: STATE_OFFLINE_ACTIVE, axes: { online: false, paused: false }, meaning: '没有活 Agent，政策轴上活动：窗口已关/没加载，离线不排队（除非显式 wake）。' },
  { name: STATE_OFFLINE_PAUSED, axes: { online: false, paused: true }, meaning: '没有活 Agent，且该域已被按下暂停：消息入队，等人手动唤起。' },
  { name: STATE_TERMINATED, axes: { online: null, paused: null }, meaning: '在任声明已释放（生命周期终结）：域名册里不再有它；只有经本插件 release_domain 终结的域才有这条墓碑。' },
]


export function loadIndex(indexFile) {
  const empty = { generatedAt: null, bySession: new Map(), error: null }
  try {
    const text = fs.readFileSync(indexFile, 'utf8')
    const json = JSON.parse(text)
    const bySession = new Map()
    for (const mission of json.missions || []) {
      const sid = mission.sessionId
      if (!sid) continue
      const entry = bySession.get(sid) || { domains: new Set(), missions: [] }
      if (mission.domain) entry.domains.add(String(mission.domain))
      entry.missions.push({
        number: mission.number ?? null,
        status: mission.status ?? null,
        feature: mission.feature ?? null,
      })
      bySession.set(sid, entry)
    }
    return { generatedAt: json.generatedAt ?? null, bySession, error: null }
  } catch (error) {
    return { ...empty, error: error?.message || String(error) }
  }
}

export function emptyIndex() {
  return { generatedAt: null, bySession: new Map(), error: null }
}

/** 索引里的短名口径：session-<uuid> → sess-<uuid 前 8 位>（与 _registry\INDEX.md 一致）。 */
export function shortId(id) {
  if (typeof id !== 'string') return null
  const stripped = id.replace(/^session-/, '')
  return `sess-${stripped.slice(0, 8)}`
}

/** One row per live top-level session: index labels + whether it holds an on-duty declaration. */
export function describe(agent, index, duties) {
  try {
    const header = agent?.session?.header || {}
    const idx = index || emptyIndex()
    const entry = idx.bySession ? idx.bySession.get(agent?.id) : null
    const dutyList = duties && agent?.id ? duties.get(agent.id) : null
    const duty = dutyList && dutyList.length ? dutyList[0] : null
    return {
      id: agent?.id ?? null,
      shortId: shortId(agent?.id),
      domains: entry ? [...entry.domains] : [],
      missions: entry ? entry.missions.map((m) => m.number).filter(Boolean) : [],
      onDuty: Boolean(duty),
      dutyDomain: duty ? (duty.domain ?? null) : null,
      dutyDomainKey: duty ? (duty.key ?? null) : null,
      dutyDomainKeys: dutyList ? dutyList.map((item) => item.key) : [],
      cwd: header.cwd ?? null,
      preset: header.agentPreset ?? null,
      topLevel: header.parentSession === undefined,
      origin: header.origin ?? null,
      seeded: header.isSeeded ?? null,
    }
  } catch (error) {
    return { id: agent?.id ?? null, shortId: shortId(agent?.id), error: error?.message || String(error) }
  }
}

export function liveTopLevel(ctx, index, duties) {
  const agents = ctx?.agents?.list?.() ?? []
  return agents
    .map((agent) => ({ agent, info: describe(agent, index, duties) }))
    .filter((row) => row.info.topLevel === true)
}

// --------------------------------------------------------------- declaration book (domains.json)

/**
 * Read-only load of the declaration book. Missing file, unreadable file, malformed JSON and
 * wrong shapes all degrade to "no declaration" without throwing (the CLI treats a missing
 * file the same way: "nobody claimed anything", not an error).
 */
export function dutyMap(declarations) {
  const map = new Map()
  for (const entry of declarations?.entries || []) {
    const sid = entry.sessionId
    if (!sid) continue
    const list = map.get(sid) || []
    list.push(entry)
    map.set(sid, list)
  }
  return map
}

/** Is that session id currently live? Rows first, then agents.get(), then agents.list(). Never throws. */
export function isSessionOnline(ctx, id, rows) {
  if (!id) return false
  if (Array.isArray(rows) && rows.some((row) => row?.info?.id === id)) return true
  try {
    const getter = ctx?.agents?.get
    if (typeof getter === 'function') return Boolean(getter.call(ctx.agents, id))
    const list = ctx?.agents?.list?.() ?? []
    return list.some((agent) => agent?.id === id)
  } catch {
    return false
  }
}

export function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function envText(name) {
  try {
    return textOf(process.env && process.env[name])
  } catch {
    return ''
  }
}

/**
 * Runtime home for per-machine data: `DSH_DOMAIN_BRIDGE_HOME` wins, else `<homedir>/.dsh/<plugin>`.
 * Returning '' (no homedir at all) is a degraded state, never an exception: readers treat an empty
 * path as "no file", which is exactly the "0 domains, no throw" behaviour the loader needs.
 */
export function bridgeHome() {
  const fromEnv = envText(HOME_ENV)
  if (fromEnv) return fromEnv
  try {
    const home = os.homedir()
    return home ? path.join(home, '.dsh', PLUGIN) : ''
  } catch {
    return ''
  }
}

/**
 * Optional per-machine config `<home>/config.json` with `indexFile` / `domainsFile` / `ownerCli`.
 * Missing file = normal. Unreadable/malformed file degrades to "no file config" (env + defaults
 * still apply) and is reported in the loaded log line - it must never stop plugin loading.
 */
export function readHomeConfig(home) {
  const file = home ? path.join(home, HOME_CONFIG_NAME) : ''
  const out = { file, fileExisted: false, error: null, values: {} }
  if (!file) return out
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) out.error = error?.message || String(error)
    return out
  }
  out.fileExisted = true
  try {
    const json = JSON.parse(raw)
    if (json && typeof json === 'object' && !Array.isArray(json)) out.values = json
    else out.error = 'config.json 顶层不是对象'
  } catch (error) {
    out.error = error?.message || String(error)
  }
  return out
}

/**
 * v0.6.0 `domainSessionModel` normalization: `{provider, model, reasoningEffort?}` with two
 * non-empty strings required. Anything else (wrong type, array, missing half, blank strings) is
 * treated as "not configured" - this function never throws, because config is not allowed to stop
 * the plugin from loading.
 */
export function normalizeModelConfig(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const provider = textOf(value.provider)
    const model = textOf(value.model)
    if (!provider || !model) return null
    const reasoningEffort = textOf(value.reasoningEffort)
    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
  } catch {
    return null
  }
}

/**
 * Effective runtime settings. Resolution order per key:
 *   1. explicit deployment config (cordis.patch.yml / apply(rawConfig)) when non-empty
 *   2. `<home>/config.json`
 *   3. environment variable
 *   4. default inside `<home>` (ownerCli defaults to '' = generic wording, no invented path)
 * Step 1 stays first so an existing deployment's explicit paths keep winning and so the test
 * harness can mount the plugin with its own fixtures without reading the machine's config.json.
 * Never throws: a broken layer simply falls through to the next one.
 *
 * v0.6.0 adds `domainSessionModel` (an OBJECT, not a path): deployment config wins, then
 * `<home>/config.json`, then "not configured". Invalid shapes are silently absent, never an error.
 */
export function resolveRuntime(rawConfig) {
  const home = bridgeHome()
  const homeConfig = readHomeConfig(home)
  const deployment = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const pick = (key, envName, fallback) => {
    const fromDeployment = textOf(deployment[key])
    if (fromDeployment) return { value: fromDeployment, source: 'deployment-config' }
    const fromHome = textOf(homeConfig.values[key])
    if (fromHome) return { value: fromHome, source: homeConfig.file }
    const fromEnv = envText(envName)
    if (fromEnv) return { value: fromEnv, source: `env:${envName}` }
    return { value: fallback, source: 'default' }
  }
  const index = pick('indexFile', INDEX_ENV, home ? path.join(home, HOME_INDEX_NAME) : '')
  const domains = pick('domainsFile', DOMAINS_ENV, home ? path.join(home, HOME_DOMAINS_NAME) : '')
  const ownerCli = pick('ownerCli', OWNER_CLI_ENV, '')
  const model = (() => {
    const fromDeployment = normalizeModelConfig(deployment.domainSessionModel)
    if (fromDeployment) return { value: fromDeployment, source: 'deployment-config' }
    const fromHome = normalizeModelConfig(homeConfig.values.domainSessionModel)
    if (fromHome) return { value: fromHome, source: homeConfig.file }
    return { value: null, source: 'default' }
  })()
  return {
    home,
    configFile: homeConfig.file,
    configFileExisted: homeConfig.fileExisted,
    configError: homeConfig.error,
    indexFile: index.value,
    indexFileSource: index.source,
    domainsFile: domains.value,
    domainsFileSource: domains.source,
    ownerCli: ownerCli.value,
    ownerCliSource: ownerCli.source,
    // v0.6.0：create_domain_session 建完给新会话铺的模型；null = 不铺（继承全局默认）。
    domainSessionModel: model.value,
    domainSessionModelSource: model.source,
  }
}

/** Human-facing reference to the external CLI: the configured path, else the bare script name. */
export function ownerCliRef(config) {
  return textOf(config && config.ownerCli) || 'domain-owner.mjs'
}

// ------------------------------- v0.4.0 domain state store (policy axis) + persisted inbox (queue)

/**
 * Default state directory: `<home>/state`. Runtime data must not live inside the package directory
 * (a reinstall/upgrade would drop it, and one shared copy cannot serve two machines). It is still
 * deliberately NOT inside the project's `_registry` tree - that is human-owned data. `stateDir`
 * remains a config key, so a deployment can point it anywhere.
 */
export function defaultStateDir() {
  try {
    const home = bridgeHome()
    return home ? path.join(home, 'state') : null
  } catch {
    return null
  }
}

export function stateRoot(stateDir) {
  const given = String(stateDir ?? '').trim()
  return given || defaultStateDir() || ''
}

export function stateDirs(stateDir) {
  const base = stateRoot(stateDir)
  return { base, domains: path.join(base, 'domains'), inbox: path.join(base, 'inbox') }
}

/**
 * `项目:域` -> one safe FILE NAME. Windows forbids `:` in file names, and a raw key could carry
 * separators or a `..` climb, so: keep [a-z0-9_.-], drop leading dots, cap at 60 chars, and append
 * a short sha1 of the raw key so two different keys can never collide on the same file.
 */
export function safeKeyName(key) {
  const raw = String(key ?? '').toLowerCase().trim()
  const flat = raw.replace(/[^a-z0-9_.-]+/g, '_').replace(/^[._-]+/, '').slice(0, 60)
  let hash = 'hashless'
  try {
    hash = createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 8)
  } catch {
    hash = 'hashless'
  }
  return 'k-' + (flat || 'domain') + '-' + hash
}

export function stateFileFor(stateDir, key, scope) {
  return path.join(stateDirs(stateDir).domains, stateFileName(key, scope) + '.json')
}

/**
 * 一个 key 属于哪个 scope？**只按键形状判**（用来给落盘文件分命名空间）：
 *   `session-<uuid>` ⇒ session；其余（含 `项目:域` 与保留键 `*`）⇒ domain。
 * 可判的依据：键的唯一产地——session 键是从宿主拿到的完整会话 id（一律 `session-` 开头），
 * 域键一律 `项目:域`；队列只按这两类**被投递目标自身的键**分片（v0.4.2 冻结口径），
 * 所以"键形状 ⇒ scope"在本插件里是单向可判的。显式给 scope 的地方一律以显式值为准。
 */
export function queueScopeOf(key) {
  return /^session-/.test(String(key ?? '').trim().toLowerCase()) ? SCOPE_SESSION : SCOPE_DOMAIN
}

/**
 * 落盘文件名：**一 scope 一键一文件**（v0.4.2）。
 *   · domain 级**沿用 v0.4.1 的 `k-<flat>-<sha1>`**（历史状态文件不能因为升级失联）；
 *   · 其余三级加 scope 前缀（`session-k-…` / `project-k-…` / `global-k-…`）
 *     ⇒ 同一个 key 字符串出现在两个 scope 下也**结构上不可能**互相覆盖。
 *   （这条是刻意的加强：数量级上几乎不会撞，但"撞了会静默覆盖别人的记录"是不该留的失败模式。）
 */
export function stateFileName(key, scope) {
  const base = safeKeyName(key)
  const real = String(scope ?? '').trim().toLowerCase() || SCOPE_DOMAIN
  return real === SCOPE_DOMAIN ? base : `${real}-${base}`
}

export function inboxFileFor(stateDir, key, scope) {
  const real = String(scope ?? '').trim().toLowerCase() || queueScopeOf(key)
  return path.join(stateDirs(stateDir).inbox, stateFileName(key, real) + '.jsonl')
}

/** The empty/unknown state record: every key always present, so results stay lossless JSON. */
export function isFullSessionId(value) {
  return /^session-[0-9a-z-]+$/i.test(String(value ?? '').trim())
}

/** 看起来是在说会话（`sess-…` / `session-…`）——用来决定"这里要不要报 unresolved"。 */
export function isSessionIdLike(value) {
  return /^sess/i.test(String(value ?? '').trim())
}

/**
 * session 键解析（只读、不猜）：
 *   · 完整会话 id（`session-<uuid>`）⇒ **原样接受**（**不要求它现在在线**：这正是"按下的会话
 *     重启之后还能解开"的前提）；
 *   · 短号 / 片段 ⇒ 只在**唯一命中**一条已知会话时接受（已知＝在线顶层会话 ∪ 域名册里的声明会话）。
 */
export function messageOf(error) {
  try {
    return error?.message || String(error)
  } catch {
    return 'unknown error'
  }
}

/**
 * The one and only envelope builder for everything this plugin delivers.
 * send_to_domain and create_domain_session BOTH go through here - never paste a second copy,
 * because the footer is the receiver's only built-in reply instruction.
 */
export function dirLabelOf(value) {
  try {
    const text = String(value ?? '').replace(/[\\/]+$/, '')
    return path.basename(text) || text
  } catch {
    return String(value ?? '')
  }
}

/**
 * Point one domain's on-duty declaration at a freshly created session.
 * Same file schema, same atomic replace and same "never overwrite somebody else" rule as
 * claim_domain / domain-owner.mjs - it only takes the owner session id as a parameter instead
 * of assuming the caller. `force` is deliberately NOT exposed here: a brand new session must
 * never silently displace a sitting owner.
 */
