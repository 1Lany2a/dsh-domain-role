/**
 * dsh-domain-bridge — the four-level pause policy, its persisted state records and queue drain/withdraw.
 *
 * Split out of the single-file lib/bridge.js in v0.6.3 (pure move: no behaviour change).
 * The package entry point stays lib/bridge.js, which re-exports this module.
 */

import fs from 'node:fs'
import path from 'node:path'
import { TRACE_ID_V040, TRACE_ID_V041, TRACE_ID_V042, SCOPE_DOMAIN, SCOPE_SESSION, SCOPE_PROJECT, SCOPE_GLOBAL, PAUSE_SCOPES, GLOBAL_KEY, SCOPE_ALIASES, STATE_POLICY_PAUSED, STATE_POLICY_ACTIVE, STATE_ONLINE_ACTIVE, STATE_ONLINE_PAUSED, STATE_OFFLINE_ACTIVE, STATE_OFFLINE_PAUSED, STATE_TERMINATED, DERIVED_STATE_LEGEND, loadIndex, emptyIndex, shortId, describe, liveTopLevel, dutyMap, isSessionOnline, stateDirs, stateFileFor, queueScopeOf, isFullSessionId, isSessionIdLike, messageOf } from './shared.js'
import { warn, tool } from './tools.js'
// 唯一名 tmp + rename 重试的写盘通道：**复用 registrations.js 的那一份**（勿在本模块另写一套）。
// 固定名 `<file>.tmp` 在两进程并发写同一状态文件时会静默丢写（审计 P1-02 已复现：期望 120 实际 70）。
import { writeAtomicUnique } from './registrations.js'
import { INBOX_PENDING, INBOX_DELIVERED, INBOX_FAILED, INBOX_WITHDRAWN, loadInbox, updateInboxStatus, loadInboxes, domainMessage, deliverToAgent, withFileLock } from './messaging.js'
import { loadDeclarations, readDeclarationsForWrite, checkName, projectFromCwd, resolveDomainKeyForState, matchDeclaration, resolveTarget } from './declaration.js'
import { clipToBytes, liveAgentOf, resolveWakeWiring, resumeSession } from './session-factory.js'

export function emptyDomainState(file) {
  return {
    scope: null,
    key: null,
    paused: false,
    pausedAt: null,
    pausedBy: null,
    note: null,
    resumedAt: null,
    resumedBy: null,
    terminatedAt: null,
    terminatedBy: null,
    updatedAt: null,
    file: file ?? null,
    existed: false,
    error: null,
  }
}

export function normalizeDomainState(raw, file) {
  const out = emptyDomainState(file)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  out.scope = typeof raw.scope === 'string' && raw.scope ? raw.scope : null
  out.key = typeof raw.key === 'string' && raw.key ? raw.key : null
  out.paused = raw.paused === true
  out.pausedAt = typeof raw.pausedAt === 'string' ? raw.pausedAt : null
  out.pausedBy = typeof raw.pausedBy === 'string' ? raw.pausedBy : null
  out.note = typeof raw.note === 'string' ? raw.note : null
  out.resumedAt = typeof raw.resumedAt === 'string' ? raw.resumedAt : null
  out.resumedBy = typeof raw.resumedBy === 'string' ? raw.resumedBy : null
  out.terminatedAt = typeof raw.terminatedAt === 'string' ? raw.terminatedAt : null
  out.terminatedBy = typeof raw.terminatedBy === 'string' ? raw.terminatedBy : null
  out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null
  out.existed = true
  return out
}

/**
 * Read-only load of ONE domain's state record. Missing file / unreadable / malformed all degrade to
 * "no state record" (paused:false) **without throwing** - a broken optional store must never block
 * delivery. `error` is reported so a caller can tell "never stored" from "store is broken".
 */
/**
 * Read-only load of ONE state record, for one (key, scope) pair. Missing file / unreadable /
 * malformed all degrade to "no state record" (paused:false) **without throwing** - a broken
 * optional store must never block delivery. `error` is reported so a caller can tell "never
 * stored" from "store is broken".
 * `scope` 缺省＝按键形状判（见 queueScopeOf）；显式 scope 一律优先（global 的键 `*` 必须显式给）。
 */
export function loadDomainState(stateDir, key, scope) {
  const real = String(scope ?? '').trim().toLowerCase() || queueScopeOf(key)
  const file = stateFileFor(stateDir, key, real)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyDomainState(file)
    return { ...emptyDomainState(file), error: error?.message || String(error) }
  }
  try {
    const parsed = JSON.parse(raw)
    const record = normalizeDomainState(parsed, file)
    record.key = record.key ?? String(key ?? '')
    record.scope = record.scope ?? real
    return record
  } catch (error) {
    return { ...emptyDomainState(file), existed: true, error: error?.message || String(error) }
  }
}

/** 状态记录里的**真实** scope：缺字段＝v0.4.0/v0.4.1 写下的域级记录（那时只有域级）。 */
export function scopeOfRecord(record) {
  const raw = String(record?.scope ?? '').trim().toLowerCase()
  return PAUSE_SCOPES.includes(raw) ? raw : SCOPE_DOMAIN
}

/** Every state record in the store, keyed by lower-cased key (legacy readers) + (scope,key) 精确表. */
export function loadDomainStates(stateDir) {
  const out = {
    dir: stateDirs(stateDir).domains,
    byKey: new Map(),
    // v0.4.2：`<scope>\u0000<key 小写>` -> 记录。跨 scope 的**同名字符串**必须能分开取，
    // 否则"哪个 scope 被按下"会被另一级的记录顶掉。
    byScopeKey: new Map(),
    entries: [],
    error: null,
    unreadable: [],
  }
  let names = []
  try {
    names = fs.readdirSync(out.dir)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') out.error = error?.message || String(error)
    return out
  }
  for (const name of names.sort()) {
    if (!String(name).endsWith('.json')) continue
    const file = path.join(out.dir, name)
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      // 一份读不懂的状态文件不该让整店崩掉，但**也不能静默**：如实列进 unreadable，
      // 由 list_* 的 domainState.unreadableDegraded 暴露出来（降级不静默，是这插件的一贯口径）。
      out.unreadable.push(String(name))
      continue
    }
    const record = normalizeDomainState(parsed, file)
    if (!record.key) {
      out.unreadable.push(String(name))
      continue
    }
    const scope = scopeOfRecord(record)
    record.scope = scope
    out.entries.push(record)
    const lower = String(record.key).toLowerCase()
    if (!out.byKey.has(lower)) out.byKey.set(lower, record)
    out.byScopeKey.set(scope + '\u0000' + lower, record)
  }
  return out
}

/**
 * 只为这批候选键读记录（**不扫全目录**）：send / create / set / drain 这些热路径用。
 * 返回的形状与 loadDomainStates 一致（byKey / byScopeKey / entries / unreadable），
 * 这样 OR 判定与 list 路径共用同一套查找（lookupPauseRecord）。
 */
export function loadPauseStateMap(config, candidates) {
  const byKey = new Map()
  const byScopeKey = new Map()
  const entries = []
  const unreadable = []
  const seen = new Set()
  for (const candidate of candidates || []) {
    if (!candidate || !candidate.key) continue
    const scope = String(candidate.scope ?? '').trim().toLowerCase() || SCOPE_DOMAIN
    const lower = String(candidate.key).toLowerCase()
    const cursor = scope + '\u0000' + lower
    if (seen.has(cursor)) continue
    seen.add(cursor)
    const record = loadDomainState(config.stateDir, candidate.key, scope)
    // 记录里的 scope 与它所属的 scope 不一致（手改过文件）⇒ 不当命中，也不静默。
    if (record.existed && record.scope && String(record.scope).toLowerCase() !== scope) {
      unreadable.push({
        scope,
        key: candidate.key,
        file: record.file,
        error: `记录里的 scope（${record.scope}）与它所属的 scope（${scope}）不一致（按"不是这条记录"处理）`,
      })
      continue
    }
    if (record.error) unreadable.push({ scope, key: candidate.key, file: record.file, error: record.error })
    byScopeKey.set(cursor, record)
    if (!byKey.has(lower)) byKey.set(lower, record)
    if (record.existed) entries.push(record)
  }
  return { byKey, byScopeKey, entries, unreadable, error: null }
}

/**
 * Read-modify-write one state record under BOTH guarantees:
 *   ① 跨进程互斥：整段"读旧记录 → 合并 patch → 写新记录"在 `withFileLock(<file>.lock)` 里
 *      （锁粒度＝每个状态文件一把；`withFileLock` 就是 registrations.js 的 `withDomainsLock`，
 *      不重造）。⚠️ 锁**不可重入**——临界区里不要再取同一把锁。
 *   ② 原子落盘：UNIQUE tmp name (`<file>.<pid>.<rand>.tmp`) + rename with retries, through
 *      `writeAtomicUnique()` from registrations.js (one implementation, not a second copy).
 * A file that exists but cannot be parsed ABORTS the write - never overwrite somebody's state
 * blindly. `patch` keys are merged over the existing record（合并发生在锁内 ⇒ 看到的是最新记录）。
 */
export function writeDomainStateAtomic(stateDir, key, patch, scope) {
  const real = String(scope ?? '').trim().toLowerCase() || queueScopeOf(key)
  const file = stateFileFor(stateDir, key, real)
  // 锁粒度＝**每个状态文件一把**（`<file>.lock`），包住"读旧记录 → 合并 patch → 写新记录"整段。
  // 只锁写那一步没用：两进程都拿旧记录打底、后写覆盖先写 ⇒ 静默丢字段（审计 P1-02 第二半：
  // 2×60 次只落到 73，两边各自都回 ok:60/failed:0）。
  // 锁＝messaging.js 的 withFileLock（与 registrations.js 同一份实现）；**不可重入**，
  // 所以临界区本体 applyDomainStateWrite() 里不得再取锁。
  const locked = withFileLock(file, () => applyDomainStateWrite({ file, real, key, patch }))
  if (locked.ok) return locked.value
  return { ok: false, reason: locked.reason === 'locked' ? 'locked' : 'lock-failed', error: locked.error, file }
}

/** `writeDomainStateAtomic()` 的临界区本体：**只许在持锁时调用**（它自己不加锁）。 */
function applyDomainStateWrite({ file, real, key, patch }) {
  let existing = new emptyDomainState(file)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      return { ok: false, reason: 'state-read-failed', error: error?.message || String(error), file }
    }
  }
  if (raw !== undefined) {
    try {
      existing = normalizeDomainState(JSON.parse(raw), file)
    } catch (error) {
      return { ok: false, reason: 'state-file-unreadable', error: error?.message || String(error), file }
    }
    // 防御：文件里的 scope 与本次要写的 scope 不一致 ⇒ **绝不用别人的记录打底**。
    // （v0.4.2 起非域级记录各有自己的文件名，正常路径撞不上；这条只挡手改/旧命名残留。）
    if (existing.existed && existing.scope && String(existing.scope).toLowerCase() !== real) {
      return {
        ok: false,
        reason: 'scope-conflict',
        error: `记录里的 scope（${existing.scope}）与本次要写的 scope（${real}）不一致`,
        file,
      }
    }
  }
  const next = {
    ...existing,
    schemaVersion: 1,
    scope: real,
    key: String(key),
    ...patch,
    // 运行期字段一律不落盘（lossless 输出用的，不是数据）。
    file: undefined,
    existed: undefined,
    error: undefined,
    updatedAt: new Date().toISOString(),
  }
  const body = JSON.stringify(next, null, 2) + '\n'
  try {
    // 唯一名 tmp（`<file>.<pid>.<rand>.tmp`）+ rename 重试 ≤10 次 × 10ms：与
    // registrations.js:281-308 的 writeAtomicUnique **同款，勿各写一套**。
    // 旧写法（固定名 `<file>.tmp` + 单次 rename）在两进程并发写同一状态文件时会 ENOENT 或
    // 静默覆盖别人的写（审计 P1-02/P2-01 已复现：120 次自增只落到 70）。
    const written = writeAtomicUnique(file, body)
    return { ok: true, file, bytes: written.bytes, record: normalizeDomainState(next, file) }
  } catch (error) {
    return { ok: false, reason: 'write-failed', error: messageOf(error), file }
  }
}

// --- persisted inbox (the queue that makes "paused but queued" survive a dsh restart) ---

export function deriveDomainState({ hasDeclaration, online, paused, terminated }) {
  if (hasDeclaration) {
    if (online) return paused ? STATE_ONLINE_PAUSED : STATE_ONLINE_ACTIVE
    return paused ? STATE_OFFLINE_PAUSED : STATE_OFFLINE_ACTIVE
  }
  if (terminated) return STATE_TERMINATED
  return null
}

/**
 * 一个 `项目:域` 的完整快照（只读；域名册 + 状态目录 + 队列，三处都降级）。
 * 派生状态只在这里算，调用方只管展示。
 *
 * v0.4.2：`paused` / `state` 变成**有效暂停**（OR 叠加：域级 / 它负责人的会话级 / 它的项目级 / global
 * 任一级按下都算）——这正是「会话行/声明行的派生状态必须体现所有级命中」那条硬要求。
 * 四级里只有域级记录时，结果与 v0.4.1 **逐字相同**（所以旧用例一个字节都不用改）。
 * `pausedAt/pausedBy/pauseNote` 优先给**域级自己那条记录**（旧字段语义不变），域级没记录时退回
 * 第一条命中记录，让"谁按下的"永远有人可指；**全部**命中在 `pausedScopes` / `pausedByScopes` 里。
 */
export function domainSnapshot({ declarations, states, inboxes, ctx, rows, key, inbox, hits }) {
  const lower = String(key ?? '').toLowerCase()
  const entry = declarations?.byKey?.get(lower) || null
  const evaluated = Array.isArray(hits)
    ? { hits }
    : pauseHitsOfMap(states, pauseCandidatesForDomain(declarations, key, {}).concat(pauseCandidatesGlobal()))
  const hitList = evaluated.hits || []
  const own = lookupPauseRecord(states, SCOPE_DOMAIN, key) || null
  const spokes = own && own.existed ? own : hitList[0]?.record ?? own
  const queueRaw = inbox || (inboxes ? inboxes.byKey.get(lower) : null) || []
  const queue = Array.isArray(queueRaw) ? queueRaw : queueRaw.records || []
  const pending = queue.filter((item) => item.status === INBOX_PENDING).length
  const sessionId = entry?.sessionId ?? null
  const online = entry ? isSessionOnline(ctx, sessionId, rows) : false
  const paused = hitList.length > 0
  const terminatedAt = own?.terminatedAt ?? spokes?.terminatedAt ?? null
  return {
    key: entry?.key ?? own?.key ?? String(key ?? ''),
    scope: SCOPE_DOMAIN,
    inBook: Boolean(entry),
    sessionId,
    online,
    paused,
    // 该域**自己那一级**（scope=domain）的记录是否被按下（"我这一级现在是什么"）。
    scopePaused: Boolean(own?.paused),
    pausedAt: spokes?.pausedAt ?? null,
    pausedBy: spokes?.pausedBy ?? null,
    pauseNote: spokes?.note ?? null,
    resumedAt: own?.resumedAt ?? null,
    terminatedAt,
    terminatedBy: own?.terminatedBy ?? null,
    state: entry
      ? deriveDomainState({ hasDeclaration: true, online, paused, terminated: Boolean(terminatedAt) })
      : own || spokes
        ? deriveDomainState({ hasDeclaration: false, online: false, paused, terminated: Boolean(terminatedAt) })
        : null,
    pending,
    queuedTotal: queue.length,
    // v0.4.2：四级命中全量（OR）——"是哪几级按下的"必须一眼看得出（不许只报一个）。
    pausedScopes: pausedScopesOf(hitList),
    pausedByScopes: pausedByScopesOf(hitList),
  }
}

/** 命中集合 ⇒ scope 名（排序去重）——对外一律用这个表达"哪几级按着"。 */
export function pausedScopesOf(hits) {
  return [...new Set((hits || []).map((hit) => String(hit.scope)))].sort()
}

/** 命中集合 ⇒ 逐条"谁在何时按下"（含 via / 发送端还是接收端），**全量**、不许只报一个。 */
export function pausedByScopesOf(hits) {
  return (hits || []).map((hit) => ({
    scope: hit.scope,
    key: String(hit.key ?? ''),
    via: hit.via ?? null,
    side: hit.side ?? null,
    pausedAt: hit.record?.pausedAt ?? null,
    pausedBy: hit.record?.pausedBy ?? null,
    pauseNote: hit.record?.note ?? null,
  }))
}

/** 一句话说清"被哪几级按着"（回执/hint 共用）。 */
export function pausedScopesWords(hits) {
  return (hits || [])
    .map((hit) => {
      const who = shortId(hit.record?.pausedBy) || hit.record?.pausedBy || '（未记录是谁按下的）'
      const at = hit.record?.pausedAt ?? '（未记录时间）'
      return `${scopeWords(hit.scope)}「${hit.key}」（${hit.via ?? 'unknown'}；${who} 于 ${at} 按下）`
    })
    .join('；')
}

/** scope 的中文说法（机器面一律四个英文字面量）。 */
export function scopeWords(scope) {
  if (scope === SCOPE_SESSION) return '主（单会话暂停）'
  if (scope === SCOPE_PROJECT) return '项目'
  if (scope === SCOPE_GLOBAL) return '全局'
  return '域'
}

/** 大白话：谁、在什么时候按下的（"其他会话知道它的状态"就靠这个）。 */
export function pausedWhoWords(snapshot) {
  const who = shortId(snapshot?.pausedBy) || snapshot?.pausedBy || '（未记录是谁按下的）'
  const at = snapshot?.pausedAt ?? '（未记录时间）'
  const note = String(snapshot?.pauseNote ?? '').trim()
  return `${who} 于 ${at} 按下${note ? `（note：「${clipToBytes(note, 60)}」）` : ''}`
}

/** list_* 共用的 `domainState` 段：四级作用域 + 五态字典 + 已终结（墓碑）清单 + 四级在案记录。 */
export function domainStateSection(config, declarations, states, inboxes, opts) {
  const dirs = stateDirs(config.stateDir)
  const declared = new Set((declarations?.entries || []).map((entry) => String(entry.key).toLowerCase()))
  const terminated = (states?.entries || [])
    .filter(
      (record) =>
        record.terminatedAt &&
        scopeOfRecord(record) === SCOPE_DOMAIN &&
        !declared.has(String(record.key).toLowerCase()),
    )
    .map((record) => ({
      key: record.key,
      scope: scopeOfRecord(record),
      terminatedAt: record.terminatedAt,
      terminatedBy: record.terminatedBy,
      pausedWhenTerminated: Boolean(record.paused),
      pending: (inboxes?.byKey.get(String(record.key).toLowerCase()) || []).filter((item) => item.status === INBOX_PENDING).length,
      state: STATE_TERMINATED,
    }))
  // 四级里**所有被按下的记录**（含非域级）——这样"有哪几级被按下"不用翻目录就能看见。
  const pausedRecords = (states?.entries || [])
    .filter((record) => record.paused)
    .map((record) => ({
      scope: scopeOfRecord(record),
      key: record.key,
      paused: true,
      pausedAt: record.pausedAt ?? null,
      pausedBy: record.pausedBy ?? null,
      pauseNote: record.note ?? null,
      state:
        scopeOfRecord(record) === SCOPE_DOMAIN || scopeOfRecord(record) === SCOPE_SESSION
          ? deriveDomainState({ hasDeclaration: true, online: false, paused: true, terminated: false })
          : STATE_POLICY_PAUSED,
      updatedAt: record.updatedAt ?? null,
    }))
  // 被按下的**会话级**记录里，有几条推不出项目（拿不到 cwd、域名册里也没有它的声明）
  // ⇒ 那一级这次判不成。**不拦**是刻意的失败方向，但必须说出来（降级不静默）。
  const unresolved = []
  for (const record of states?.entries || []) {
    if (scopeOfRecord(record) !== SCOPE_SESSION || !record.paused) continue
    const missed = pauseCandidatesForSession(declarations, opts?.ctx || null, record.key, {}).unresolved
    for (const item of missed) unresolved.push({ ...item, scope: SCOPE_SESSION, key: record.key })
  }
  return {
    // 兼容：这一段仍然是"以域级行为主键"的段（旧字段语义不变）；四级在 `scopes` / `pausedRecords` 里。
    scope: SCOPE_DOMAIN,
    scopes: PAUSE_SCOPES,
    scopeHint:
      'v0.4.2：暂停支持**四级**（`domain` 域 / `session` 主＝单会话 / `project` 项目 / `global` 全局）。' +
      '判定是 **OR 叠加**：任一级被按下就拦，回执给出**全部**命中级别（`pausedScopes` / `pausedByScopes`）。' +
      '两端都查——接收端（目标域键 / 目标会话 / 目标会话的项目 / global）与发送端（本会话 / 本会话的项目 / global）；' +
      '**刻意不含**"本会话自己持有的域被暂停"（域级暂停只关那扇门，不禁言整个会话）。' +
      'global 是保留键 `*`（唯一），按/解都要求 `confirm:true` 防误触。' +
      '状态文件"一 scope 一键一文件"：域级沿用 `k-<flat>-<sha1>`，其余三级是 `<scope>-k-…`。',
    scopeImplemented: [...PAUSE_SCOPES],
    scopePlanned: [],
    scopeNote:
      '`在线·已暂停` / `离线·已暂停` 说不出"是哪一级按下的"——所以每条命中都另给 `pausedScopes`（级别名）' +
      '与 `pausedByScopes`（逐条的 scope/key/via/side/谁在何时按下）。project / global 两级没有单个会话，' +
      '所以它们的对外状态就是政策轴的两个词「已暂停」/「活动」（`STATE_POLICY_*`）。',
    dir: dirs.base,
    domainsDir: dirs.domains,
    inboxDir: dirs.inbox,
    error: states?.error ?? null,
    count: states?.entries?.length ?? 0,
    derivedStates: DERIVED_STATE_LEGEND,
    terminated,
    pausedRecords,
    pausedRecordCount: pausedRecords.length,
    // 降级**不静默**：状态文件/队列行读不懂时如实暴露（但绝不因此拦住投递）。
    unreadableStateFiles: states?.unreadable ?? [],
    degradedQueueFiles: inboxes?.degraded ?? [],
    // v0.4.2：级联里判不成的那几级（例如会话 id 查不到 cwd ⇒ 推不出项目）——**不拦，但必须说出来**。
    unresolved,
    degradeNote:
      '读不懂的状态文件按「没有这条记录」处理（＝政策轴上当作活动，**不拦投递**）：这是刻意的失败方向——' +
      '一份坏文件不能让整个域永久排不上队。但降级不静默，读不懂的文件名列在上面两份清单里，请人工看一眼。',
  }
}

/**
 * 会话行上的政策轴标注（v0.4.2：四级全查）。
 * 会话行本身的"在线"是既定事实（它就在在线列表里）⇒ 派生状态只可能是 `在线·活动` / `在线·已暂停`。
 * 查的级别：① 它**自己**的会话级 ② 它所在项目级 ③ 它持有的域级 ④ global。
 * `pausedDomains`（它持有的、被按下的域键）是 v0.4.0 就有的字段，语义不变；新增
 * `pausedScopes` / `pausedByScopes` 把"到底是哪几级按着"说全（会话行不许骗人）。
 */
export function sessionPauseFields(info, duties, states, opts) {
  const o = opts || {}
  const sessionId = info?.id ?? null
  const candidates = []
  if (sessionId) {
    candidates.push(
      ...pauseCandidatesForSession(o.declarations || null, o.ctx || null, sessionId, {
        viaSession: 'self-session',
        viaProject: 'self-project',
        viaDomainFromSession: 'held-domain',
        side: 'self',
        projectHint: projectFromCwd(info?.cwd),
        projectFrom: '这条会话活 Agent 的 cwd 目录名（小写）',
      }).candidates,
    )
  }
  candidates.push(...pauseCandidatesGlobal())
  const { hits } = pauseHitsOfMap(states, candidates)
  const pausedDomains = hits
    .filter((hit) => hit.scope === SCOPE_DOMAIN)
    .map((hit) => String(hit.key))
    .sort()
  return {
    paused: hits.length > 0,
    state: hits.length > 0 ? STATE_ONLINE_PAUSED : STATE_ONLINE_ACTIVE,
    pausedDomains,
    pausedScopes: pausedScopesOf(hits),
    pausedByScopes: pausedByScopesOf(hits),
  }
}

// --- v0.4.0/v0.4.2 interception: 「暂停 OR」的唯一判定入口 ---

/** 完整会话 id 的形状（宿主自建的会话一律 `session-<uuid>`）。 */
export function resolveSessionKeyForState(declarations, rows, rawSession) {
  const text = String(rawSession ?? '').trim()
  if (!text) return { error: 'session 键不能为空（完整会话 id，或唯一命中的短号）。' }
  if (isFullSessionId(text)) return { id: text, from: '完整会话 id（原样使用，不要求它现在在线）' }
  const known = new Map()
  for (const row of rows || []) if (row?.info?.id) known.set(row.info.id, '在线顶层会话')
  for (const entry of declarations?.entries || []) {
    if (entry?.sessionId && !known.has(entry.sessionId)) known.set(entry.sessionId, '在任声明')
  }
  const needle = text.toLowerCase()
  const hits = [...known.keys()].filter((id) => {
    const lower = String(id).toLowerCase()
    return lower === needle || lower.includes(needle) || String(shortId(id) || '').toLowerCase() === needle
  })
  if (hits.length === 1) return { id: hits[0], from: `短号/片段唯一命中（${known.get(hits[0])}）` }
  if (hits.length === 0) {
    return {
      error: `没有已知会话能和「${text}」对上（在线顶层会话与域名册声明里都没有）⇒ 请写**完整**会话 id（session-<uuid>）。`,
      reason: 'session-not-found',
      candidates: [],
    }
  }
  return {
    error: `「${text}」命中 ${hits.length} 条会话，本工具不替你猜 ⇒ 请写**完整**会话 id。`,
    reason: 'session-ambiguous',
    candidates: hits.sort(),
  }
}

/** 一个域键的项目名：域名册里的 `project` 优先，其次从键本体切（`项目:域`）。 */
export function projectOfDomainKey(declarations, key) {
  const entry = declarations?.byKey?.get(String(key ?? '').toLowerCase()) || null
  const fromEntry = String(entry?.project ?? '').trim()
  if (fromEntry) return fromEntry.toLowerCase()
  const raw = String(key ?? '')
  if (!raw.includes(':')) return null
  const project = raw.slice(0, raw.indexOf(':')).trim().toLowerCase()
  return project || null
}

/** 一条会话在域名册里持有的声明能推出哪个项目（离线也能推——这就是它比 cwd 更可靠的地方）。 */
export function projectOfSessionDeclarations(declarations, sessionId) {
  const list = dutyMap(declarations).get(sessionId) || []
  for (const entry of list) {
    const project = String(entry.project ?? '').trim()
    if (project) return { project: project.toLowerCase(), from: `域名册里该会话持有的声明（${entry.key}）` }
    const key = String(entry.key ?? '')
    if (key.includes(':')) {
      return { project: key.slice(0, key.indexOf(':')).trim().toLowerCase(), from: `域名册里该会话持有的声明键（${key}）` }
    }
  }
  return null
}

/** 活 Agent 的 cwd（拿不到就是 null——**绝不猜**；查不到 cwd ⇒ 项目级不拦 + 标 unresolved）。 */
export function sessionCwdOf(ctx, sessionId) {
  try {
    const agent = ctx?.agents?.get?.(sessionId)
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.trim()) return cwd.trim()
  } catch {
    /* 取不到就返回 null（降级不拦），不抛。 */
  }
  return null
}

/** 接收端：一个**域键**归到的级别（域级本身 + 它的项目 + 它负责人的会话）。global 由调用方补。 */
export function pauseCandidatesForDomain(declarations, key, opts) {
  const o = opts || {}
  const side = o.side || 'target'
  const out = [
    {
      scope: SCOPE_DOMAIN,
      key: String(key ?? ''),
      via: o.via || 'target-domain',
      legacyVia: o.legacyVia || 'declaration',
      side,
    },
  ]
  const project = projectOfDomainKey(declarations, key)
  if (project) out.push({ scope: SCOPE_PROJECT, key: project, via: o.viaProject || 'target-project', side })
  const entry = declarations?.byKey?.get(String(key ?? '').toLowerCase()) || null
  if (entry?.sessionId) out.push({ scope: SCOPE_SESSION, key: entry.sessionId, via: o.viaSession || 'target-session', side })
  return out
}

/**
 * 一条**会话**归到的级别：它自己的会话级 + 它所在的项目 + （可选）它在域名册里持有的域。
 * `includeHeldDomains:false` 用于**发送端**——S3 明确：本会话自己持有的域被暂停，**不禁言整个会话**
 * （域级暂停只关那扇门）。
 * 项目推不出来的失败方向：**不拦 + 记 unresolved**（S7：降级不静默、也不误拦）。
 */
export function pauseCandidatesForSession(declarations, ctx, sessionId, opts) {
  const o = opts || {}
  const side = o.side || 'target'
  const candidates = [
    { scope: SCOPE_SESSION, key: String(sessionId ?? ''), via: o.viaSession || 'target-session', side },
  ]
  const unresolved = []
  let project = o.projectHint ? String(o.projectHint).trim().toLowerCase() : null
  let projectFrom = project ? o.projectFrom || '调用方给的目录名（小写）' : null
  if (!project) {
    const fromDecl = projectOfSessionDeclarations(declarations, sessionId)
    if (fromDecl) {
      project = fromDecl.project
      projectFrom = fromDecl.from
    }
  }
  if (!project) {
    const fromCwd = projectFromCwd(sessionCwdOf(ctx, sessionId))
    if (fromCwd) {
      project = fromCwd
      projectFrom = '这条会话活 Agent 的 cwd 目录名（小写）'
    }
  }
  if (project) {
    candidates.push({ scope: SCOPE_PROJECT, key: project, via: o.viaProject || 'target-project', side, projectFrom })
  } else {
    unresolved.push({
      level: 'project',
      scope: SCOPE_PROJECT,
      via: o.viaProject || 'target-project',
      key: String(sessionId ?? ''),
      reason: 'project-unresolved',
      detail:
        '这条会话现在没有活 Agent 的 cwd、域名册里也没有它的声明 ⇒ **项目级这次判不成（按"不拦"处理）**；' +
        '要严格判项目级，请先把它的 cwd 变得可见，或改用「项目:域」完整写法走域级。',
    })
  }
  if (o.includeHeldDomains !== false) {
    for (const entry of dutyMap(declarations).get(sessionId) || []) {
      candidates.push({
        scope: SCOPE_DOMAIN,
        key: entry.key,
        via: o.viaDomainFromSession || 'target-domain',
        legacyVia: 'session-id',
        side,
      })
    }
  }
  return { candidates, unresolved }
}

/** global 是唯一键 `*`（第四级）。 */
export function pauseCandidatesGlobal(side) {
  return [{ scope: SCOPE_GLOBAL, key: GLOBAL_KEY, via: 'global', side: side || 'global' }]
}

/** 同一 (scope,key) 只留一条（`via` 合成 `vias`，并把 side 升成 both）——不许重复报一个级别。 */
export function dedupePauseHits(hits) {
  const out = []
  const index = new Map()
  for (const hit of hits || []) {
    const cursor = String(hit.scope) + '\u0000' + String(hit.key).toLowerCase()
    const prior = index.get(cursor)
    if (!prior) {
      const copy = { ...hit, vias: [hit.via] }
      index.set(cursor, copy)
      out.push(copy)
      continue
    }
    if (!prior.vias.includes(hit.via)) prior.vias.push(hit.via)
    if (prior.side !== hit.side) prior.side = 'both'
  }
  return out
}

/**
 * 按 (scope, key) 精确取一条状态记录：
 *   ① 优先用 `byScopeKey`（v0.4.2 起 list 路径与按需读共用同一套精确查找）；
 *   ② 没有精确表时退回 `byKey`，并**校验 scope**（跨 scope 的同名字符串不许互相顶掉）。
 */
export function lookupPauseRecord(states, scope, key) {
  const lower = String(key ?? '').toLowerCase()
  const real = String(scope ?? '').trim().toLowerCase() || SCOPE_DOMAIN
  const exact = states?.byScopeKey?.get(real + '\u0000' + lower)
  if (exact) return exact
  const loose = states?.byKey?.get(lower)
  if (!loose) return null
  return scopeOfRecord(loose) === real ? loose : null
}

/**
 * 一组候选键 → 命中（**OR 叠加**）。数据源是已经读进来的 states（list 路径）。
 * `lookupPauseRecord` 按 (scope,key) 精确取 ⇒ 跨 scope 同名字符串也不会互相顶掉。
 */
export function pauseHitsOfMap(states, candidates) {
  const hits = []
  for (const candidate of candidates || []) {
    if (!candidate || !candidate.key) continue
    const record = lookupPauseRecord(states, candidate.scope, candidate.key)
    if (record && record.paused === true) hits.push({ ...candidate, record })
  }
  return { hits: dedupePauseHits(hits), unreadable: [] }
}

/** 一组候选键 → 命中（OR）。数据源是**磁盘**（按需逐键读，不扫全目录）。 */
export function pauseHitsOfDisk(config, candidates) {
  const hits = []
  const unreadable = []
  const seen = new Set()
  for (const candidate of candidates || []) {
    if (!candidate || !candidate.key) continue
    const scope = String(candidate.scope ?? '').trim().toLowerCase() || SCOPE_DOMAIN
    const cursor = scope + '\u0000' + String(candidate.key).toLowerCase()
    if (seen.has(cursor)) continue
    seen.add(cursor)
    const record = loadDomainState(config.stateDir, candidate.key, scope)
    if (record.existed && record.scope && String(record.scope).toLowerCase() !== scope) {
      unreadable.push({
        scope,
        key: candidate.key,
        file: record.file,
        error: `记录里的 scope（${record.scope}）与它所属的 scope（${scope}）不一致（按"不是这条记录"处理）`,
      })
      continue
    }
    if (record.error) {
      unreadable.push({ scope, key: candidate.key, file: record.file, error: record.error })
      continue
    }
    if (record.paused === true) hits.push({ ...candidate, record })
  }
  return { hits: dedupePauseHits(hits), unreadable }
}

/**
 * 暂停拦截的**唯一**判定入口（v0.4.2：四级 + OR + 两端）。
 *
 * 接收端（target 能归到的所有级别）：
 *   ① target 就是那个域（短名 / 「项目:域」）⇒ 域键；② target 是会话 id / 短号 ⇒ 那条会话
 *   （它自己 + 它的项目 + 它在域名册里持有的域——v0.4.1「按会话 id 直投也绕不开域级暂停」的语义保留）；
 *   ③ 目标会话所属项目；④ global。
 * 发送端（本会话）：① 本会话 id ② 本会话所属项目 ③ global。
 *   **刻意不含**「本会话自己持有的域被暂停」——域级暂停只关那扇门，不禁言整个会话
 *   （这条边界是为了让域级行为与 v0.4.1 逐字一致）。
 *
 * 返回**永远**是对象：`hits` 为空＝没被任何一级按下（`unresolved` / `unreadable` 仍要如实带出去）。
 * `queueKey` ＝ S5 的入队键（**被投递目标自身的键**：target 是域 ⇒ 域键；target 是会话 ⇒ 会话 id）。
 */
export function pausedTargetOf(config, declarations, rawTarget, opts) {
  const o = opts || {}
  const rows = Array.isArray(o.rows) ? o.rows : []
  const ctx = o.ctx || null
  const self = o.self || null
  const index = o.index || null
  const target = String(rawTarget ?? '').trim()
  const candidates = []
  const unresolved = []
  let domainKey = null
  let domainFromDeclaration = false
  let targetSessionId = null
  if (target) {
    const colon = target.indexOf(':')
    const domainPart = (colon === -1 ? target : target.slice(colon + 1)).trim()
    const declared = matchDeclaration(declarations, target, domainPart)
    if (declared.status === 'declared') {
      domainKey = declared.entry.key
      domainFromDeclaration = true
      if (declared.entry.sessionId) targetSessionId = declared.entry.sessionId
      candidates.push(
        ...pauseCandidatesForDomain(declarations, domainKey, { via: 'target-domain', legacyVia: 'declaration' }),
      )
    } else if (colon !== -1) {
      // 「项目:域」完整写法：即使册子里没有这条声明，也认这个 key（状态记录可能还在）。
      domainKey = target
      candidates.push(
        ...pauseCandidatesForDomain(declarations, domainKey, { via: 'target-domain', legacyVia: 'declaration' }),
      )
    } else if (declared.status === 'ambiguous') {
      unresolved.push({
        level: 'domain',
        scope: SCOPE_DOMAIN,
        via: 'target-domain',
        key: target,
        reason: 'ambiguous-declarations',
        detail: `同名域有 ${declared.entries.length} 条在任声明 ⇒ 域级这次判不成（不猜、按"不拦"处理）。`,
        candidates: declared.entries.map((entry) => entry.key).sort(),
      })
    }
    const asSession = resolveSessionKeyForState(declarations, rows, target)
    if (asSession.id) {
      if (!targetSessionId) targetSessionId = asSession.id
      const forSession = pauseCandidatesForSession(declarations, ctx, asSession.id, {
        viaSession: 'target-session',
        side: 'target',
      })
      candidates.push(...forSession.candidates)
      unresolved.push(...forSession.unresolved)
    } else if (asSession.error && !targetSessionId) {
      // ── v0.4.2 修 F1：**裸短名 / 册子里没有声明**的 target —— 先按 `send_to_domain` 将来那套
      // 解析（会话 id 片段 / **索引标注**）试着把目标落到**一条在线会话**上：
      //   · 解析得到 ⇒ 用这条会话算 ②会话级 ③它的项目 ④global，**命中即拦**
      //     （与"直接写会话 id"完全一致；否则"项目被按下 + 裸短名"就能绕过暂停）；
      //   · 解析不到 ⇒ **不拦**，但**必须** push `unresolved`（写明哪几级判不成）——
      //     「判不出 ⇒ 不拦但必须标」这条对两条路径一致（会话侧原先就有，裸短名这条原先没有）。
      const viaIndex =
        declared.status === 'none' ? resolveTarget(rows, target, declarations, ctx, index) : null
      if (viaIndex && viaIndex.ok && viaIndex.row?.info?.id) {
        targetSessionId = viaIndex.row.info.id
        const forSession = pauseCandidatesForSession(declarations, ctx, targetSessionId, {
          viaSession: 'target-session',
          side: 'target',
        })
        candidates.push(...forSession.candidates)
        unresolved.push(...forSession.unresolved)
      } else {
        const resolveReason = viaIndex && !viaIndex.ok ? viaIndex.reason : null
        const looksLikeSession = isSessionIdLike(target)
        unresolved.push({
          level: 'session',
          scope: SCOPE_SESSION,
          via: 'target-session',
          key: target,
          reason: resolveReason || asSession.reason || 'session-not-found',
          detail:
            `「${target}」${looksLikeSession ? '看起来是在说会话' : '既不在域名册里'}，也没能按会话 id 片段或` +
            `索引标注解析成**一条**在线会话（解析结果=${resolveReason || asSession.reason || 'not-found'}）` +
            `⇒ **会话级这一级判不成（按"不拦"处理）**。`,
        })
        unresolved.push({
          level: 'project',
          scope: SCOPE_PROJECT,
          via: 'target-project',
          key: target,
          reason: 'project-unresolved',
          detail:
            '同上：目标会话没定下来 ⇒ 推不出它属于哪个项目（按"不拦"处理）。' +
            '要严格判项目级，请先补 claim_domain，或改用**完整会话 id** / 「项目:域」完整写法。',
        })
      }
    }
    candidates.push(...pauseCandidatesGlobal())
  }
  if (self && self.id) {
    const forSelf = pauseCandidatesForSession(declarations, ctx, self.id, {
      side: 'self',
      viaSession: 'self-session',
      viaProject: 'self-project',
      includeHeldDomains: false,
      projectHint: projectFromCwd(self.cwd),
      projectFrom: '本会话 cwd 的目录名（小写）',
    })
    candidates.push(...forSelf.candidates)
    unresolved.push(...forSelf.unresolved)
  } else if (self) {
    unresolved.push({
      level: 'session',
      scope: SCOPE_SESSION,
      via: 'self-session',
      key: null,
      reason: 'self-session-id-missing',
      detail: '本会话拿不到 id ⇒ 发送端这一级判不成（按"不拦"处理）。',
    })
  }
  const evaluated = pauseHitsOfDisk(config, candidates)
  // S5：入队键＝**被投递目标自身的键**（域 ⇒ 域键；会话 ⇒ 会话 id）。
  const targetIsSessionOnly = Boolean(targetSessionId) && !domainFromDeclaration && !target.includes(':')
  return {
    hits: evaluated.hits,
    unreadable: evaluated.unreadable,
    unresolved,
    candidates,
    domainKey,
    domainFromDeclaration,
    targetSessionId,
    queueKey: targetIsSessionOnly ? targetSessionId : domainKey || targetSessionId || target,
  }
}

/**
 * 一个 (scope, key) 记录**自身那一级**连同"会压着它"的其它级别（OR 全量）。
 *   domain  ⇒ 域级 + 该域的项目 + 该域负责人的会话 + global
 *   session ⇒ 会话级 + 该会话的项目 + 该会话持有的域 + global
 *   project ⇒ 项目级 + global
 *   global  ⇒ global
 */
export function pauseCandidatesForScopeKey(declarations, ctx, scope, key) {
  if (scope === SCOPE_SESSION) {
    return pauseCandidatesForSession(declarations, ctx, key, { side: 'target' }).candidates.concat(
      pauseCandidatesGlobal(),
    )
  }
  if (scope === SCOPE_PROJECT) {
    return [{ scope: SCOPE_PROJECT, key: String(key ?? ''), via: 'target-project', side: 'target' }].concat(
      pauseCandidatesGlobal(),
    )
  }
  if (scope === SCOPE_GLOBAL) return pauseCandidatesGlobal()
  return pauseCandidatesForDomain(declarations, key, {}).concat(pauseCandidatesGlobal())
}

/** 该 (scope,key) 在队列目录里**自己那个键**的 pending 条数（project/global 没有自己的队列 ⇒ 0）。 */
export function pendingOfOwnQueue(config, scope, key) {
  if (scope !== SCOPE_DOMAIN && scope !== SCOPE_SESSION) return 0
  return loadInbox(config.stateDir, key).pending
}

/** 同上，但给总行数（pending + delivered + failed + withdrawn）。 */
export function recordsOfOwnQueue(config, scope, key) {
  if (scope !== SCOPE_DOMAIN && scope !== SCOPE_SESSION) return 0
  return loadInbox(config.stateDir, key).total
}

/**
 * 现在被**这一级**压着、因而投不出去的 pending 总条数（逐条重评 OR）。
 * 这是恢复时真正要看的数（project/global 没有"自己的队列"，所以不能用 loadInbox(key)）。
 */
export function pendingPressedByScope(config, declarations, ctx, scope, key) {
  const wanted = String(key ?? '').toLowerCase()
  const inboxes = loadInboxes(config.stateDir)
  let pending = 0
  const queues = []
  for (const [queueKey, records] of inboxes.byKey) {
    const press = pausePressersOfQueueKey(config, declarations, ctx, queueKey)
    const hit = press.hits.some((item) => item.scope === scope && String(item.key).toLowerCase() === wanted)
    if (!hit) continue
    const count = records.filter((record) => record.status === INBOX_PENDING).length
    if (count > 0) {
      pending += count
      queues.push(queueKey)
    }
  }
  return { pending, queues: queues.sort() }
}

/** 命中块里"主命中"（报兼容字段用）：优先级 域 > 会话 > 项目 > global。 */
export function primaryPauseHit(hits) {
  for (const scope of [SCOPE_DOMAIN, SCOPE_SESSION, SCOPE_PROJECT, SCOPE_GLOBAL]) {
    const hit = (hits || []).find((item) => item.scope === scope)
    if (hit) return hit
  }
  return (hits || [])[0] || null
}

/**
 * 被暂停时的**公共事实块**（send / create / probe / dryRun 共用）：
 * 旧字段（`scope` / `derivedState` / `paused*` / `matchedBy` / `domain` / `sessionId`）逐字保留，
 * 另给四级全量（`pausedScopes` / `pausedByScopes` / `pausedNotice`）——**不许只报一个级别**。
 */
export function pausedFactsOf({ config, declarations, ctx, rows, evaluated, domainKey, fallbackKey }) {
  const hits = evaluated.hits || []
  const primary = primaryPauseHit(hits)
  const key = domainKey ?? (primary && primary.scope === SCOPE_DOMAIN ? primary.key : fallbackKey ?? null)
  let snapshot = null
  if (key && !String(key).toLowerCase().startsWith('session-')) {
    snapshot = domainSnapshot({
      declarations,
      states: loadPauseStateMap(
        config,
        pauseCandidatesForDomain(declarations, key, {}).concat(pauseCandidatesGlobal()),
      ),
      ctx,
      rows,
      key,
      inbox: loadInbox(config.stateDir, key),
      hits,
    })
  }
  const online = snapshot?.online ?? (primary?.scope === SCOPE_SESSION ? isSessionOnline(ctx, primary.key, rows) : null)
  const state =
    snapshot?.state ??
    (online === null
      ? hits.length
        ? STATE_POLICY_PAUSED
        : STATE_POLICY_ACTIVE
      : deriveDomainState({ hasDeclaration: true, online, paused: hits.length > 0, terminated: false }))
  return {
    scope: primary?.scope ?? SCOPE_DOMAIN,
    domain: snapshot?.key ?? (primary?.scope === SCOPE_DOMAIN ? primary?.key ?? null : null),
    derivedState: state,
    online,
    paused: hits.length > 0,
    pausedAt: primary?.record?.pausedAt ?? null,
    pausedBy: primary?.record?.pausedBy ?? null,
    pauseNote: primary?.record?.note ?? null,
    matchedBy:
      primary?.scope === SCOPE_DOMAIN && primary?.legacyVia === 'session-id'
        ? 'session-id-holds-paused-domain'
        : 'declaration',
    sessionId: snapshot?.sessionId ?? evaluated.targetSessionId ?? null,
    pausedScopes: pausedScopesOf(hits),
    pausedByScopes: pausedByScopesOf(hits),
    pausedNotice: `当前被按下的是：${pausedScopesWords(hits)}。`,
  }
}

/**
 * 被暂停时的大白话 hint（send_to_domain 用）：现状 + 消息在哪 + 怎么恢复 + 怎么撤回。
 * v0.4.2：现状要说出**全部**命中级别（OR），恢复入口按 scope 给（域 / 会话 / 项目 / 全局）。
 */
export function pausedSendHint(snapshot, queueId) {
  const hits = snapshot.pausedHits || []
  const releaseLines = (hits.length ? hits : [{ scope: SCOPE_DOMAIN, key: snapshot.key }]).map((hit) =>
    hit.scope === SCOPE_GLOBAL
      ? `set_domain_state(scope='global', state='active', confirm=true)`
      : `set_domain_state(scope='${hit.scope}', domain='${hit.key}', state='active')`,
  )
  return (
    `「${snapshot.queueKey ?? snapshot.key}」这次**发不出去**（该目标**已暂停**）：按着它的是 ${pausedScopesWords(hits)}` +
    `——**本工具没有投递，也没有替你找人顶上**：消息已经落盘入队（id=${queueId}，pending=${snapshot.pending}），` +
    `dsh 重启也不会丢（注入式入队不持久：dsh 一退出，未读的注入会被整体取消，所以这里必须落盘）。` +
    `可撤回：withdraw_domain_message(id='${queueId}')。要恢复投递：人手动唤起 ⇒ ` +
    `把**按着它的每一级**都解开（${[...new Set(releaseLines)].join('、')}）——` +
    `恢复时会**重新评估 OR**：只有**不再被任何一级压着**的 pending 才会按原 mode 重投。` +
    `插件只管插件介导的路径：人自己点开那条会话、或宿主自己 resume，插件拦不住——那正是「人工手动唤起」。`
  )
}

/** 被暂停时的 hint（create_domain_session 用）。 */
export function pausedCreateHint(facts) {
  const hits = facts.pausedHits || []
  const releaseLines = (hits.length ? hits : [{ scope: SCOPE_DOMAIN, key: facts.key }]).map((hit) =>
    hit.scope === SCOPE_GLOBAL
      ? `set_domain_state(scope='global', state='active', confirm=true)`
      : `set_domain_state(scope='${hit.scope}', domain='${hit.key}', state='active')`,
  )
  return (
    `这次**没有新建任何会话**：被按下的是 ${pausedScopesWords(hits)}` +
    `（对外状态＝${facts.state}）——暂停期间不新开、也不唤醒这个域，这正是"暂停"的意义。` +
    `要开工二选一：① 先把**按着它的每一级**解开（${[...new Set(releaseLines)].join('、')}），再重跑本工具；` +
    `② 换一个域/项目（不要往一个已被按下的域里再塞会话）。`
  )
}

/**
 * claim_domain / release_domain 共用的「该域仍处已暂停」提示（v0.4.2：四级 OR）。
 * **未暂停时返回空对象**——一个键都不多，保证「非暂停域行为与 v0.3.6 逐字一致」。
 * 依据（用户拍板）：换人（claim force）/ 退役（release）**都不等于解暂停**。
 */
export function pausedNoticeOf(config, key, declarations) {
  const candidates = pauseCandidatesForDomain(declarations, key, {}).concat(pauseCandidatesGlobal())
  const { hits } = pauseHitsOfDisk(config, candidates)
  if (hits.length === 0) return {}
  const domainHit = hits.find((hit) => hit.scope === SCOPE_DOMAIN) || null
  const who = pausedWhoWords({
    pausedBy: domainHit?.record?.pausedBy,
    pausedAt: domainHit?.record?.pausedAt,
    pauseNote: domainHit?.record?.note,
  })
  const releaseLines = hits.map((hit) =>
    hit.scope === SCOPE_GLOBAL
      ? `set_domain_state(scope='global', state='active', confirm=true)`
      : `set_domain_state(scope='${hit.scope}', domain='${hit.key}', state='active')`,
  )
  return {
    paused: true,
    pausedAt: domainHit?.record?.pausedAt ?? null,
    pausedBy: domainHit?.record?.pausedBy ?? null,
    pauseNote: domainHit?.record?.note ?? null,
    pausedScopes: pausedScopesOf(hits),
    pausedByScopes: pausedByScopesOf(hits),
    pausedNotice:
      `注意：该域**仍处已暂停**（${who}）——认领 / 交接 / 退役都**不会**解除暂停（换人 ≠ 解暂停）。` +
      `按着它的级别：${pausedScopesWords(hits)}。`,
    pausedHint: `要恢复活动：${[...new Set(releaseLines)].join('、')}（恢复时会把队列里的 pending 按原 mode 重新投递）。`,
  }
}

// --------------------------------------------------------------- argument helpers

/** Same name rules as the CLI's assertName. Returns an error string, or null when valid. */
export async function drainInbox(ctx, config, key, self) {
  const inbox = loadInbox(config.stateDir, key)
  const pending = inbox.records.filter((record) => record.status === INBOX_PENDING)
  const out = {
    attempted: true,
    // v0.4.2：队列 key 的**目标自身 scope**（域键 ⇒ domain；会话 id ⇒ session）——S5 的入队键口径。
    scope: queueScopeOf(key),
    key: String(key),
    file: inbox.file,
    ownerSessionId: null,
    ownerOnline: false,
    wake: null,
    pendingBefore: pending.length,
    delivered: [],
    failed: [],
    stillPending: [],
    stillPausedBy: [],
    statusWriteFailures: [],
    reason: null,
    error: null,
    hint: null,
  }
  if (pending.length === 0) {
    out.attempted = false
    out.reason = 'nothing-pending'
    out.hint = '这个域的队列里没有待投消息，无需重投。'
    return out
  }
  const declarations = loadDeclarations(config.domainsFile)
  // ── v0.4.2：**重评 OR**（drain 的正确性来源）。一条 pending 能不能投，只看它目标**当下**的判定，
  // 与当初被哪一级拦下无关；仍被任何一级压着 ⇒ **保持 pending**，并说清是被谁压着。
  const press = pausePressersOfQueueKey(config, declarations, ctx, key)
  // 降级不静默：这条队列目标的状态文件读不懂 ⇒ 不拦（照常投），但把文件名带出来。
  if (press.unreadable.length) out.unreadableStateFiles = press.unreadable
  if (press.hits.length > 0) {
    out.attempted = false
    out.reason = 'still-pressed'
    out.stillPending = pending.map((record) => record.id)
    out.stillPausedBy = press.hits.map((hit) => ({
      scope: hit.scope,
      key: String(hit.key ?? ''),
      via: hit.via ?? null,
      side: hit.side ?? null,
      pausedAt: hit.record?.pausedAt ?? null,
      pausedBy: hit.record?.pausedBy ?? null,
    }))
    if (press.unreadable.length) out.unreadableStateFiles = press.unreadable
    out.hint =
      `这 ${pending.length} 条消息**仍被压着，没有投出去**（原样保留 pending）：` +
      `${pausedScopesWords(press.hits)}。` +
      `要投它们，得把**所有**压着它目标的那几级都解开（解一级不够——判定是 OR 叠加）；` +
      `解开任意一级后再调一次 set_domain_state(state='active')，它会**重新评估**。`
    warn(
      `[${TRACE_ID_V042}] 恢复重评：${key} 仍被 ${pausedScopesOf(press.hits).join('+')} 压着 ⇒ ` +
        `${pending.length} 条保持 pending（不投）。`,
    )
    return out
  }
  // 队列 key 就是目标自身的键：会话键的"负责人"就是这条会话；域键才去域名册里找负责人。
  const entry = queueScopeOf(key) === SCOPE_SESSION ? null : declarations.byKey.get(String(key).toLowerCase()) || null
  const ownerSessionId = queueScopeOf(key) === SCOPE_SESSION ? String(key) : entry?.sessionId ?? null
  out.ownerSessionId = ownerSessionId
  let agent = liveAgentOf(ctx, ownerSessionId)
  out.ownerOnline = Boolean(agent)
  if (!agent) {
    // v0.4.1：**允许尝试唤醒**（人的显式动作）。只要队列里有任何一条是"真会跑回合"的档
    // （mode≠inject），拉活就必须带接线 —— 没接线就不裸拉（安全门在 resumeSession 里）。
    const wakeRunsTurn = pending.some((record) => String(record.mode ?? 'followup').toLowerCase() !== 'inject')
    const wiring = ownerSessionId ? await resolveWakeWiring(ctx, ownerSessionId) : null
    out.wake = ownerSessionId
      ? await resumeSession(ctx, ownerSessionId, wiring, { requireWiring: wakeRunsTurn })
      : null
    if (out.wake && out.wake.ok) agent = liveAgentOf(ctx, ownerSessionId)
    out.ownerOnline = Boolean(agent)
    warn(
      `[${TRACE_ID_V041}] 恢复时尝试唤醒 ${key}：候选=${shortId(ownerSessionId) || '（无）'}，` +
        `结果=${out.wake ? (out.wake.ok ? '已拉活' : out.wake.reason) : 'no-owner-declared'}，` +
        `接线=agentOptions:${out.wake?.wakeWiring?.agentOptions ?? 'none'}/setup:${out.wake?.wakeWiring?.setup ?? 'skipped'}。`,
    )
  }
  if (!agent) {
    out.reason = 'owner-offline'
    out.stillPending = pending.map((record) => record.id)
    const wakeReason = out.wake ? out.wake.reason : 'no-owner-declared'
    out.hint =
      `目标会话 ${shortId(ownerSessionId) || ownerSessionId || '（无在任负责人）'} 当前没有活 Agent ⇒ ` +
      `这 ${pending.length} 条消息**原样保留 pending**（没有假装投成功）。` +
      `恢复时**已经试过拉活**（结果=${wakeReason}` +
      `${out.wake && out.wake.error ? '：' + out.wake.error : ''}）⇒ ` +
      (wakeReason === 'no-wake-wiring'
        ? `拉活要先接好 provider/model，这次两条取源都空（agentOptions:none）⇒ **没有裸拉**：` +
          `裸 resume 起来的会话 100ms 内就崩（prompt variable "{{model}}" has no value …persona-prefix）。`
        : `它没被拉起来。`) +
      `要真派活，请用 create_domain_session，或人在 GUI 点开那条会话；它一活过来，` +
      `再调一次 set_domain_state(state='active') 就能把这批消息投出去。`
    return out
  }
  for (const record of pending) {
    const mode = String(record.mode ?? 'followup').toLowerCase()
    let attempt
    try {
      const envelope = String(record.content ?? '')
      const payload = domainMessage({ self: { id: record.from ?? null, domains: [] }, envelope })
      attempt = deliverToAgent(agent, mode, payload)
    } catch (error) {
      attempt = { ok: false, reason: 'deliver-threw', error: messageOf(error) }
    }
    if (attempt.ok) {
      const wrote = updateInboxStatus(config.stateDir, key, record.id, INBOX_DELIVERED, {
        deliveredAt: new Date().toISOString(),
        deliveredBy: self?.id ?? null,
      })
      out.delivered.push(record.id)
      // 消息**确实投出去了**，但状态没写进去 ⇒ 如实记账（下次恢复可能重投一次，重复优于丢消息）。
      if (!wrote.ok) out.statusWriteFailures.push({ id: record.id, status: INBOX_DELIVERED, error: wrote.error ?? wrote.reason })
    } else {
      const wrote = updateInboxStatus(config.stateDir, key, record.id, INBOX_FAILED, {
        failedReason: attempt.reason,
        failedAt: new Date().toISOString(),
      })
      out.failed.push({ id: record.id, mode, reason: attempt.reason ?? 'unknown' })
      if (!wrote.ok) out.statusWriteFailures.push({ id: record.id, status: INBOX_FAILED, error: wrote.error ?? wrote.reason })
    }
  }
  out.reason = out.failed.length ? (out.delivered.length ? 'partial' : 'all-failed') : 'delivered'
  out.hint = out.failed.length
    ? `恢复了 ${out.delivered.length} 条，${out.failed.length} 条**投递失败**（已标 failed，不会自动重试；原因见 failed）。`
    : `队列里 ${out.delivered.length} 条 pending 已按原 mode 全部投出去（已标 delivered）。`
  if (out.statusWriteFailures.length) {
    out.hint +=
      `⚠️ 另有 ${out.statusWriteFailures.length} 条**投出去了但状态没写进队列文件**（原因见 statusWriteFailures）⇒` +
      `下次恢复可能重复投一次（重复优于丢消息），请人工看一眼队列文件。`
  }
  if (out.failed.length) {
    warn(
      `[${TRACE_ID_V040}] 恢复重投 ${key}：delivered=${out.delivered.length}，failed=${out.failed.length}` +
        `（${out.failed.map((item) => item.reason).join('/')}）。`,
    )
  }
  return out
}

/**
 * 一条队列 key 现在还被哪些级别压着（v0.4.2 的**逐条重评 OR**，drain 的正确性来源）。
 * 队列 key 只有两种（S5：**被投递目标自身的键**）：域键（`项目:域`）或完整会话 id。
 */
export function pausePressersOfQueueKey(config, declarations, ctx, key) {
  const text = String(key ?? '').trim()
  const candidates =
    queueScopeOf(text) === SCOPE_SESSION
      ? pauseCandidatesForSession(declarations, ctx, text, { viaSession: 'target-session', side: 'target' }).candidates
      : pauseCandidatesForDomain(declarations, text, { via: 'target-domain', side: 'target' })
  return pauseHitsOfDisk(config, candidates.concat(pauseCandidatesGlobal()))
}

/** 把若干条队列的 drain 结果聚成一个 `drain` 段（单条时**逐字**返回那一条，兼容旧回执）。 */
export function aggregateDrains({ scope, key, allKeys, selected, skipped, results }) {
  const flat = (field) => results.flatMap((item) => item[field] || [])
  const delivered = flat('delivered')
  const failed = flat('failed')
  const stillPending = flat('stillPending')
  const statusWriteFailures = flat('statusWriteFailures')
  const stillPausedBy = results.flatMap((item) =>
    (item.stillPausedBy || []).map((hit) => ({ ...hit, queueKey: item.key })),
  )
  if (results.length === 0) {
    return {
      attempted: false,
      resumedScope: scope,
      resumedKey: String(key ?? ''),
      multi: false,
      keys: selected,
      skipped,
      allKeys,
      delivered,
      failed,
      stillPending,
      statusWriteFailures,
      stillPausedBy,
      deliveredCount: 0,
      failedCount: 0,
      stillPendingCount: 0,
      wake: null,
      reason: 'nothing-in-scope',
      error: null,
      hint: `恢复 ${scopeWords(scope)}「${key}」：队列目录里没有任何属于它的队列文件，无需重投。`,
    }
  }
  if (results.length === 1) {
    return {
      ...results[0],
      resumedScope: scope,
      resumedKey: String(key ?? ''),
      multi: false,
      keys: selected,
      skipped,
      allKeys,
    }
  }
  const pressedWords = [...new Set(stillPausedBy.map((hit) => `${scopeWords(hit.scope)}「${hit.key}」`))].join('、')
  return {
    attempted: results.some((item) => item.attempted),
    resumedScope: scope,
    resumedKey: String(key ?? ''),
    multi: true,
    keys: selected,
    skipped,
    allKeys,
    queues: results.map((item) => ({
      key: item.key,
      scope: item.scope,
      reason: item.reason,
      delivered: item.delivered.length,
      failed: item.failed.length,
      stillPending: item.stillPending.length,
      stillPausedBy: item.stillPausedBy || [],
    })),
    delivered,
    failed,
    stillPending,
    statusWriteFailures,
    stillPausedBy,
    deliveredCount: delivered.length,
    failedCount: failed.length,
    stillPendingCount: stillPending.length,
    wake: results.find((item) => item.wake)?.wake ?? null,
    reason: failed.length ? 'partial' : stillPending.length ? 'still-pending' : delivered.length ? 'delivered' : 'nothing-pending',
    error: null,
    hint:
      `恢复 ${scopeWords(scope)}「${key}」：队列目录里 ${allKeys.length} 个队列，选中 ${selected.length} 个 ⇒ ` +
      `**投出 ${delivered.length} 条 / 失败 ${failed.length} 条 / 仍被压着保留 pending ${stillPending.length} 条**` +
      `${pressedWords ? `（压着它们的还是：${pressedWords}）` : ''}` +
      `${skipped.length ? `；另有 ${skipped.length} 个队列判不出归属（见 skipped，按"不投、不乱投"处理）` : ''}。`,
  }
}

/**
 * v0.4.2：按**恢复动作的 scope**决定扫哪些队列（扫哪些只是优化，正确性来自逐条重评 OR）：
 *   · `global`       ⇒ inbox 目录**全量**
 *   · `project:P`    ⇒ `P:*` 域键 ＋ 属于项目 P 的会话键（判不出归属的记进 `skipped`，不投）
 *   · `session:sid`  ⇒ 该会话键 ＋ **该会话持有的域键**
 *   · `domain:k`     ⇒ 该键
 * 每条都再过一遍 drainInbox 的"重评 OR"闸：仍被别的级压着 ⇒ 保持 pending 并给 `stillPausedBy`。
 */
export async function drainScopeQueues(ctx, config, scope, key, self) {
  const declarations = loadDeclarations(config.domainsFile)
  const inboxes = loadInboxes(config.stateDir)
  const allKeys = [...inboxes.byKey.keys()].sort()
  const wanted = String(key ?? '').toLowerCase()
  const selected = []
  const skipped = []
  if (scope === SCOPE_GLOBAL) {
    selected.push(...allKeys)
  } else if (scope === SCOPE_PROJECT) {
    for (const queueKey of allKeys) {
      if (queueScopeOf(queueKey) === SCOPE_DOMAIN) {
        if (queueKey.startsWith(wanted + ':')) selected.push(queueKey)
        continue
      }
      const forSession = pauseCandidatesForSession(declarations, ctx, queueKey, {})
      const projectHit = forSession.candidates.find((candidate) => candidate.scope === SCOPE_PROJECT)
      if (projectHit && projectHit.key.toLowerCase() === wanted) selected.push(queueKey)
      else if (!projectHit) skipped.push({ key: queueKey, reason: 'project-unresolved' })
    }
  } else if (scope === SCOPE_SESSION) {
    const held = (dutyMap(declarations).get(String(key)) || []).map((entry) => String(entry.key).toLowerCase())
    selected.push(wanted)
    for (const heldKey of held) if (!selected.includes(heldKey)) selected.push(heldKey)
  } else {
    selected.push(wanted)
  }
  const results = []
  for (const queueKey of selected) results.push(await drainInbox(ctx, config, queueKey, self))
  return aggregateDrains({ scope, key, allKeys, selected, skipped, results })
}

// --------------------------------------------------------------- session factory helpers

/**
 * Optional lookup of the host session factory. The service is NEVER hard-injected: if this
 * deployment does not mount it, the plugin must still load and the tool must still answer.
 * `ctx.get(name)` is the optional accessor used by dsh's own code; the property read is a
 * fallback for realms whose ctx proxy resolves services directly.
 */
export function buildSetDomainStateTool(ctx, config) {
  return tool(
    'set_domain_state',
    '**把某一级（域 / 主 / 项目 / 全局）的政策轴设成「已暂停」或「活动」**（v0.4.2：四级；v0.4.0 只有域级）。模型是**两个轴 + 生命周期**：事实轴＝**在线/离线**（宿主给、只读）；政策轴＝**活动/已暂停**（人给、可逆，字段 `paused`）；生命周期＝在用/**已终结**（`release_domain`）。对外给**派生状态**（`在线·活动` / `在线·已暂停` / `离线·活动` / `离线·已暂停` / `已终结`；project / global 没有单个会话，所以它们的对外状态就是政策轴的两个词「已暂停」/「活动」）。**四级与键**：`scope=\'domain\'`（默认）键＝`项目:域`，**要求域名册里已有一条在任声明**（用户拍板的「承认现状」，v0.4.0 语义一字不改）；`scope=\'session\'`（＝中文的「主（单会话暂停）」）键＝**完整会话 id**（`session-<uuid>`；短号 `sess-xxxxxxxx` 只在唯一命中一条已知会话时接受）；`scope=\'project\'` 键＝**项目名小写**（某会话 cwd 的目录名小写）；`scope=\'global\'` 键＝保留键 `*`（唯一）。后三级**不要求**有在任声明。**判定是 OR 叠加**：任一级被按下就拦，回执给出**全部**命中级别（`pausedScopes` / `pausedByScopes`）。**两端都查**：接收端（目标域键 / 目标会话 / 目标会话的项目 / global）＋发送端（本会话 / 本会话的项目 / global）；**刻意不含**「本会话自己持有的域被暂停」——域级暂停只关那扇门，不禁言整个会话。**global 防误触**：`scope=\'global\'` 必须带 `confirm:true`，缺了直接拒绝（`reason:\'global-needs-confirm\'`）且**一个文件都不写**。**暂停不改在任身份**（域名册一个字节不动）；暂停期间所有**插件介导**的路径都被拦——`send_to_domain` 不投递、消息**落盘入队**（可撤回；入队键＝被投递目标**自身**的键），`create_domain_session` 被拒（`reason=domain-paused`），`wake` 不许把目标拉活（除非显式 `force`）；`claim_domain` / `release_domain` **照常允许**（换人 / 退役 ≠ 解暂停）。`state=\'active\'` ＝ **人手动唤起**：解开这一级后**重新评估 OR**——只重投"现在不再被任何一级压着"的 pending，**仍被别的级压着的保持 pending** 并如实报（`drain.stillPausedBy`）；驱动范围：global 扫 inbox 全量、project 扫 `P:*` 与属于 P 的会话键、session 扫该会话键＋它持有的域键、domain 扫该键。目标离线时**允许尝试唤醒**（拉活带接线：provider/model 分级取源 + best-effort setup），唤得起来就按原 mode 重投、唤不起来保留 pending（见回执 `drain.wake`）。只有队列里有 mode≠inject 的 pending 时，唤醒才要求接线（否则拒绝裸拉）。⚠️ 只有人显式调 `active` 才尝试唤醒——**被按下的目标不会被别人自动叫醒**。**向后兼容**：不传 `scope` ⇒ 走 `domain` 级，旧字段（`key` / `domain` / `state` / `paused` / `pausedAt` / `pausedBy` / `pauseNote` / `drain` …）语义不变，新字段只新增。**边界**：本工具只管插件介导的路径——人自己点开那条会话、或宿主自己 resume，插件拦不住，那正是「人工手动唤起」。',
    {
      domain: { type: 'string', description: "要动的那个**键**（按 scope 解释）：scope='domain'（默认）⇒ 域短名（asr）或「项目:域」（misas:asr），短名优先用域名册里唯一的那条同名声明；scope='session' ⇒ 完整会话 id（session-<uuid>）或唯一命中的短号（sess-xxxxxxxx）；scope='project' ⇒ 项目名（小写，如 misas）；scope='global' ⇒ 不要给（键固定是 *）。" },
      scope: { type: 'string', description: "'domain'（默认，域＝域名册里的一个 key）| 'session'（主＝单会话暂停，键＝完整会话 id）| 'project'（项目，键＝项目名小写）| 'global'（全局，键＝*，需要 confirm）。中文别名：域 / 主 / 会话 / 项目 / 全局。**不传＝domain**（旧调用语义逐字不变）。" },
      confirm: { type: 'boolean', description: "只有 scope='global' 需要它：必须显式 true 才真的按/解全局（防误触）。缺了 ⇒ 拒绝，reason='global-needs-confirm'，**一个文件都不写**。其余 scope 不要求。" },
      state: { type: 'string', description: "'paused' ＝ 按下暂停（政策轴，可逆）；'active' ＝ 恢复活动（＝人手动唤起：恢复时**重新评估 OR**，只把「现在不再被任何一级压着」的 pending 按原 mode 重投）。" },
      note: { type: 'string', description: '可选：为什么按下（写进状态记录；回执与 list_* 里都会显示「谁、何时按下」＋这条 note）。恢复时不清除它（保留为历史）。' },
      dryRun: { type: 'boolean', description: 'true = 只回报将会怎么改（含"会重投几条"、"现在被哪几级压着"），不写任何文件、也不重投（默认 false）。' },
    },
    async (args, exec) => {
      const index = loadIndex(config.indexFile)
      const declarations = loadDeclarations(config.domainsFile)
      const duties = dutyMap(declarations)
      const self = describe(exec?.agent, index, duties)
      const rawState = String(args.state ?? '').trim().toLowerCase()
      const wanted = ['paused', 'pause', '暂停'].includes(rawState)
        ? 'paused'
        : ['active', 'resume', 'resumed', '活动', '恢复'].includes(rawState)
          ? 'active'
          : null
      if (!wanted) {
        return {
          action: 'set_domain_state',
          outcome: 'invalid',
          reason: 'invalid-state',
          self,
          hint: `state 只能是 'paused'（按下暂停）或 'active'（恢复活动＝人手动唤起）；收到的是 ${JSON.stringify(String(args.state ?? ''))}。`,
        }
      }
      // ── v0.4.2 入口：先定 scope（缺省＝domain ⇒ 旧调用语义逐字不变）。
      const rawScope = String(args.scope ?? '').trim().toLowerCase()
      const scope = rawScope ? SCOPE_ALIASES[rawScope] ?? null : SCOPE_DOMAIN
      if (!scope) {
        return {
          action: 'set_domain_state',
          outcome: 'invalid',
          reason: 'invalid-scope',
          scope: rawScope || null,
          accepted: PAUSE_SCOPES,
          self,
          hint:
            `scope 只能是 ${PAUSE_SCOPES.join(' | ')}（中文别名：域 / 主 / 会话 / 项目 / 全局）；` +
            `收到的是 ${JSON.stringify(String(args.scope ?? ''))}。不给 scope ＝ domain（旧语义）。`,
        }
      }
      // ── S4：global 是"整台机器"级开关，防误触 ⇒ **必须 confirm:true**；缺了就拒绝，**一个文件都不写**。
      if (scope === SCOPE_GLOBAL && args.confirm !== true) {
        return {
          action: 'set_domain_state',
          outcome: 'invalid',
          reason: 'global-needs-confirm',
          scope,
          key: GLOBAL_KEY,
          wanted,
          wrote: false,
          wroteNothing: true,
          file: null,
          self,
          hint:
            `global（全局）是唯一键 \`${GLOBAL_KEY}\` 的**整台机器**级开关：按/解都要求显式 \`confirm:true\` 防误触。` +
            `本次**没有写任何文件、也没有重投任何消息**。确实要动全局，请重发一次并带上 confirm:true。`,
        }
      }

      // ── 按键解析（按 scope 分叉）。⚠️ **只有 domain 级要求域名册里有这个 key**（用户拍板的
      // D2=A「承认现状」，v0.4.0 起的语义一字不改）；session / project / global 三级**不受它约束**，
      // 它们本来就不挂在声明册上。
      let key = null
      let resolution = { domain: null, project: null, projectFrom: null, sessionFrom: null }
      if (scope === SCOPE_DOMAIN) {
        const resolvedKey = resolveDomainKeyForState(declarations, args.domain, self.cwd)
        if (resolvedKey.error) {
          return {
            action: 'set_domain_state',
            outcome: 'invalid',
            reason: resolvedKey.error,
            candidates: resolvedKey.candidates ?? null,
            self,
          }
        }
        key = resolvedKey.key
        resolution = {
          domain: resolvedKey.domain,
          project: resolvedKey.project ?? null,
          projectFrom: resolvedKey.projectFrom,
          sessionFrom: null,
        }
        const read = readDeclarationsForWrite(config.domainsFile)
        if (read.parseError) {
          return {
            action: 'set_domain_state',
            outcome: 'aborted',
            reason: 'declarations-file-unreadable',
            error: read.parseError,
            key,
            file: config.domainsFile,
            self,
            hint: '声明文件已存在但读不懂：为了不误判「这个域到底有没有在任负责人」，本次没有写任何文件。请先人工看一眼那份文件。',
          }
        }
        const entry = Object.prototype.hasOwnProperty.call(read.data.owners, key) ? read.data.owners[key] : null
        if (!entry) {
          return {
            action: 'set_domain_state',
            outcome: 'no-declaration',
            key,
            scope: SCOPE_DOMAIN,
            file: config.domainsFile,
            writableKeys: Object.keys(read.data.owners).sort(),
            self,
            hint:
              `域名册里没有「${key}」这条在任声明 ⇒ **没有可暂停的域**（域级暂停挂在声明册的一个 key 上，` +
              `它不是"整台机器"或"某个项目"级别的开关）。先 claim_domain 认领，或改用「项目:域」的完整写法。` +
              `（要按"整台机器"或"某个项目"，请用 scope='global' 或 scope='project'——那两级不要求有在任声明。）`,
          }
        }
      } else if (scope === SCOPE_GLOBAL) {
        const given = String(args.domain ?? '').trim()
        if (given && given !== GLOBAL_KEY) {
          return {
            action: 'set_domain_state',
            outcome: 'invalid',
            reason: 'global-key-is-star',
            scope,
            key: GLOBAL_KEY,
            self,
            hint: `global 是唯一键 \`${GLOBAL_KEY}\`（给 domain 参数没有意义）：请写 scope='global' 且**不要**给 domain（或给 '${GLOBAL_KEY}'）。`,
          }
        }
        key = GLOBAL_KEY
        resolution = { projectFrom: `global 的保留键 ${GLOBAL_KEY}（唯一）` }
      } else if (scope === SCOPE_PROJECT) {
        const raw = String(args.domain ?? '').trim()
        const problems = [checkName(raw, '项目')].filter(Boolean)
        if (problems.length) {
          return { action: 'set_domain_state', outcome: 'invalid', reason: problems.join('；'), scope, self }
        }
        if (raw === GLOBAL_KEY) {
          return {
            action: 'set_domain_state',
            outcome: 'invalid',
            reason: 'project-key-reserved',
            scope,
            self,
            hint: `项目名不能是 \`${GLOBAL_KEY}\`（那是 global 的保留键）。`,
          }
        }
        key = raw.toLowerCase()
        resolution = { project: key, projectFrom: '调用方写的项目名（小写化）' }
      } else {
        const rowsForSession = liveTopLevel(ctx, index, duties)
        const resolvedSession = resolveSessionKeyForState(declarations, rowsForSession, args.domain)
        if (resolvedSession.error) {
          return {
            action: 'set_domain_state',
            outcome: 'invalid',
            reason: resolvedSession.reason ?? resolvedSession.error,
            candidates: resolvedSession.candidates ?? null,
            scope,
            self,
            hint: resolvedSession.error,
          }
        }
        key = resolvedSession.id
        resolution = { sessionFrom: resolvedSession.from }
      }

      const rowsBefore = liveTopLevel(ctx, index, duties)
      const ownBefore = loadDomainState(config.stateDir, key, scope)
      const candidatesOf = () => pauseCandidatesForScopeKey(declarations, ctx, scope, key)
      const unresolvedOf = () =>
        scope === SCOPE_SESSION
          ? pauseCandidatesForSession(declarations, ctx, key, { side: 'target' }).unresolved
          : []
      const snapshotOf = (record, rowsNow) => {
        const rowsForSnapshot = Array.isArray(rowsNow) ? rowsNow : rowsBefore
        if (scope === SCOPE_DOMAIN) {
          return domainSnapshot({
            declarations,
            states: loadPauseStateMap(config, candidatesOf()),
            inbox: loadInbox(config.stateDir, key),
            ctx,
            rows: rowsForSnapshot,
            key,
          })
        }
        const press = pauseHitsOfDisk(config, candidatesOf())
        const online = scope === SCOPE_SESSION ? isSessionOnline(ctx, key, rowsForSnapshot) : null
        return {
          scope,
          key,
          online,
          paused: press.hits.length > 0,
          scopePaused: Boolean(record?.paused),
          pausedAt: record?.pausedAt ?? press.hits[0]?.record?.pausedAt ?? null,
          pausedBy: record?.pausedBy ?? press.hits[0]?.record?.pausedBy ?? null,
          pauseNote: record?.note ?? press.hits[0]?.record?.note ?? null,
          state:
            scope === SCOPE_SESSION
              ? deriveDomainState({ hasDeclaration: true, online, paused: press.hits.length > 0, terminated: false })
              : press.hits.length > 0
                ? STATE_POLICY_PAUSED
                : STATE_POLICY_ACTIVE,
          pausedScopes: pausedScopesOf(press.hits),
          pausedByScopes: pausedByScopesOf(press.hits),
          pending: pendingOfOwnQueue(config, scope, key),
          queuedTotal: recordsOfOwnQueue(config, scope, key),
        }
      }
      const beforeSnapshot = snapshotOf(ownBefore)
      const at = new Date().toISOString()
      const note = typeof args.note === 'string' ? args.note : ownBefore.note ?? null
      const patch =
        wanted === 'paused'
          ? { paused: true, pausedAt: at, pausedBy: self.id ?? null, note }
          : { paused: false, resumedAt: at, resumedBy: self.id ?? null }
      const scenario = {
        action: 'set_domain_state',
        key,
        scope,
        wanted,
        domain: resolution.domain ?? null,
        project: resolution.project ?? null,
        projectFrom: resolution.projectFrom ?? null,
        sessionFrom: resolution.sessionFrom ?? null,
      }
      const pressSummary = () => {
        const press = pauseHitsOfDisk(config, candidatesOf())
        const missed = unresolvedOf()
        return {
          pausedScopes: pausedScopesOf(press.hits),
          pausedByScopes: pausedByScopesOf(press.hits),
          ...(missed.length ? { unresolved: missed } : {}),
          ...(press.unreadable.length ? { unreadableStateFiles: press.unreadable } : {}),
        }
      }
      warn(
        `[${TRACE_ID_V042}] 入口：set_domain_state scope=${scope} key=${key} wanted=${wanted} 按人=${self.id ?? '（未知会话）'}；` +
          `当前命中=${pressSummary().pausedScopes.join('+') || '（无）'}${args.dryRun === true ? '，dryRun' : ''}。`,
      )

      if (args.dryRun === true) {
        return {
          ...scenario,
          outcome: wanted === 'paused' ? 'would-pause' : 'would-resume',
          dryRun: true,
          alreadyInThatState: wanted === 'paused' ? ownBefore.paused : !ownBefore.paused,
          state: beforeSnapshot.state,
          scopePaused: ownBefore.paused,
          paused: beforeSnapshot.paused,
          pausedAt: ownBefore.pausedAt,
          pausedBy: ownBefore.pausedBy,
          pauseNote: ownBefore.pauseNote,
          ...pressSummary(),
          wouldWrite: patch,
          file: ownBefore.file,
          pending: beforeSnapshot.pending,
          pendingPressedByThisScope: pendingPressedByScope(config, declarations, ctx, scope, key),
          self,
          hint:
            wanted === 'paused'
              ? `演练：会把 ${scopeWords(scope)}「${key}」按成**已暂停**（当前 ${beforeSnapshot.state}），写进 ${ownBefore.file}。`
              : `演练：会把 ${scopeWords(scope)}「${key}」恢复成**活动**（当前 ${beforeSnapshot.state}），` +
                `并**重新评估 OR**：只重投"现在不再被任何一级压着"的 pending（${beforeSnapshot.pending} 条在同名队列里）。` +
                `**没有写文件、也没有投递**。`,
        }
      }

      // 幂等：本来就是这个状态 ⇒ 不重复写。恢复档仍走"重评 OR + 重投"（可能是上次没投完的遗留）。
      if (wanted === 'paused' && ownBefore.paused) {
        return {
          ...scenario,
          outcome: 'already-paused',
          state: beforeSnapshot.state,
          scopePaused: true,
          paused: true,
          pausedAt: ownBefore.pausedAt,
          pausedBy: ownBefore.pausedBy,
          pauseNote: ownBefore.pauseNote,
          ...pressSummary(),
          pending: beforeSnapshot.pending,
          pendingPressedByThisScope: pendingPressedByScope(config, declarations, ctx, scope, key),
          file: ownBefore.file,
          wrote: false,
          self,
          hint:
            `${scopeWords(scope)}「${key}」本来就是**已暂停**（${pausedWhoWords(ownBefore)}），本次没有改动。` +
            `要恢复：set_domain_state(scope='${scope}', domain='${key}', state='active')。`,
        }
      }
      if (wanted === 'active' && !ownBefore.paused) {
        const drain = await drainScopeQueues(ctx, config, scope, key, self)
        return {
          ...scenario,
          outcome: 'already-active',
          state: beforeSnapshot.state,
          scopePaused: false,
          paused: beforeSnapshot.paused,
          pausedAt: ownBefore.pausedAt,
          pausedBy: ownBefore.pausedBy,
          pauseNote: ownBefore.pauseNote,
          ...pressSummary(),
          pending: beforeSnapshot.pending,
          pendingPressedByThisScope: pendingPressedByScope(config, declarations, ctx, scope, key),
          file: ownBefore.file,
          wrote: false,
          drain,
          self,
          hint: `${scopeWords(scope)}「${key}」本来就是活动状态（${beforeSnapshot.state}），没有改动。${drain.hint ?? ''}`,
        }
      }

      const written = writeDomainStateAtomic(config.stateDir, key, patch, scope)
      if (!written.ok) {
        return {
          ...scenario,
          outcome: 'write-failed',
          reason: written.reason,
          error: written.error ?? null,
          file: written.file,
          wrote: false,
          self,
          hint:
            written.reason === 'state-file-unreadable'
              ? `状态文件已存在但读不懂（${written.error}）：为避免覆盖它，本次**没有写任何文件**。请先人工看一眼 ${written.file}。`
              : written.reason === 'scope-conflict'
                ? `这份状态记录里的 scope 与本次要写的 scope 不一致（${written.error}）：为避免覆盖别人的记录，本次**没有写任何文件**。请先人工看一眼 ${written.file}。`
                : `写状态记录失败（${written.error}）：政策轴**没有变**，一切照旧。`,
        }
      }
      const after = written.record
      // ── S6：恢复＝**重评 OR**（只重投"现在不再被任何一级压着"的 pending）；驱动范围按 scope 定。
      const drain = wanted === 'active' ? await drainScopeQueues(ctx, config, scope, key, self) : null
      const ownAfter = loadDomainState(config.stateDir, key, scope)
      // v0.4.1 同款：恢复可能刚拉活过目标 ⇒ 重取在线行再算派生状态（这里只读、不写）。
      const afterSnapshot = snapshotOf(
        ownAfter,
        liveTopLevel(ctx, index, dutyMap(loadDeclarations(config.domainsFile))),
      )
      const pressedAfter = pendingPressedByScope(config, declarations, ctx, scope, key)
      warn(
        `[${TRACE_ID_V042}] 结果：${wanted === 'paused' ? '按下暂停' : '恢复活动'} scope=${scope} key=${key}：` +
          `${beforeSnapshot.state} ⇒ ${afterSnapshot.state}；本 scope 记录 paused=${ownAfter.paused}；` +
          `命中级别=${afterSnapshot.pausedScopes.join('+') || '（无）'}；` +
          `被本 scope 压着的 pending=${pressedAfter.pending}` +
          `${drain ? `；重投 delivered=${drain.delivered.length}，failed=${drain.failed.length}，stillPending=${drain.stillPending.length}` : ''}。`,
      )
      const pauseHint =
        `已按下暂停：${scopeWords(scope)}「${key}」现在**本级别=已暂停**，对外状态＝**${afterSnapshot.state}**` +
        `（${pausedWhoWords({ pausedBy: afterSnapshot.pausedBy, pausedAt: afterSnapshot.pausedAt, pauseNote: afterSnapshot.pauseNote })}` +
        `${afterSnapshot.pausedScopes.length > 1 ? `；同时被 ${afterSnapshot.pausedScopes.join('+')} 压着` : ''}）。` +
        `从现在起：send_to_domain 会把消息**落盘入队**（可撤回）、create_domain_session **被拒**、` +
        `wake **被拦**（除非显式 force）；claim_domain / release_domain 仍允许（换人 / 退役 ≠ 解暂停）。` +
        `恢复：set_domain_state(scope='${scope}', domain='${key}', state='active')。` +
        `⚠️ 插件只管插件介导的路径：人自己点开那条会话、或宿主自己 resume，插件拦不住——那正是「人工手动唤起」。`
      const resumeHint =
        `已恢复活动：${scopeWords(scope)}「${key}」现在**本级别=活动**，对外状态＝**${afterSnapshot.state}**` +
        `${afterSnapshot.pausedScopes.length ? `（仍被 ${afterSnapshot.pausedScopes.join('+')} 压着）` : ''}。` +
        (drain ? drain.hint ?? '' : '')
      return {
        ...scenario,
        outcome: wanted === 'paused' ? 'paused' : 'resumed',
        previousState: beforeSnapshot.state,
        state: afterSnapshot.state,
        scopePaused: ownAfter.paused,
        paused: afterSnapshot.paused,
        online: afterSnapshot.online,
        pausedAt: afterSnapshot.pausedAt,
        pausedBy: afterSnapshot.pausedBy,
        pauseNote: afterSnapshot.pauseNote,
        pausedScopes: afterSnapshot.pausedScopes,
        pausedByScopes: afterSnapshot.pausedByScopes,
        ...(unresolvedOf().length ? { unresolved: unresolvedOf() } : {}),
        resumedAt: after.resumedAt,
        resumedBy: after.resumedBy,
        wrote: true,
        bytes: written.bytes,
        file: written.file,
        pending: afterSnapshot.pending,
        queuedTotal: afterSnapshot.queuedTotal,
        pendingPressedByThisScope: pressedAfter,
        drain,
        self,
        hint: wanted === 'paused' ? pauseHint : resumeHint,
      }
    },
  )
}

/**
 * v0.4.0：把**自己发的**一条队列消息撤回（默认只允许撤回自己发的；`force:true` 才动别人的）。
 * 只对 `status:'pending'` 的消息生效——已 delivered / failed / withdrawn 的不动（不假装收回）。
 */
export function buildWithdrawMessageTool(ctx, config) {
  return tool(
    'withdraw_domain_message',
    '**撤回一条还在队列里的域间消息**（v0.4.0）。`send_to_domain` 被「已暂停」拦下时，回执里的 `queue.id` 就是这里要的 `id`；消息在 `<stateDir>/inbox/<key>.jsonl` 里，一行一条、`status:pending`。默认**只允许撤回自己发的**（`from` 必须等于本会话 id）；`force:true` 才允许动别人发的（回执会标 `forced:true`）。只有 `pending` 能撤：已经 `delivered` / `failed` / `withdrawn` 的**不动**（如实回 `not-pending`，不假装收回）。撤回后该条变成 `status=withdrawn` 并留在文件里当留痕（不删行）。**边界**：这管不了"人已经在对方窗口里看到的那条"——它只管插件自己的落盘队列。',
    {
      id: { type: 'string', description: '要撤回的队列消息 id（send_to_domain 被暂停拦下时的回执里 queue.id）' },
      domain: { type: 'string', description: '可选：按**队列 key** 过滤（更快、更明确）。v0.4.2 起队列按“被投递目标自身的键”分片，所以这里两种写法都认：域键（短名或「项目:域」）或**会话 id**（完整 id，或唯一命中的短号 sess-xxxxxxxx）。不给就扫全部队列文件。' },
      force: { type: 'boolean', description: '默认 false ＝ 只允许撤回**自己发的**（from == 本会话 id）。true ＝ 也允许撤回别人发的（回执带 forced:true）。' },
    },
    async (args, exec) => {
      const self = describe(exec?.agent, emptyIndex())
      const id = String(args.id ?? '').trim()
      if (!id) {
        return {
          action: 'withdraw',
          outcome: 'invalid',
          reason: 'missing-id',
          self,
          hint: 'id 必填：send_to_domain 被暂停拦下时，回执里的 queue.id 就是它（想先看看有哪些，用 list_domain_owners 的 domainState 段 / 直接看队列文件）。',
        }
      }
      const inboxes = loadInboxes(config.stateDir)
      let keys = [...inboxes.byKey.keys()]
      const domainArg = args.domain === undefined || args.domain === null ? '' : String(args.domain).trim()
      if (domainArg) {
        // v0.4.2：队列按「被投递目标自身的键」分片 ⇒ `domain` 过滤要同时认两种键形状：
        //   ① 域键（域短名 / `项目:域`）⇒ 走 v0.4.0 的域解析；
        //   ② 会话键（完整 id 或短号，队列按会话 id 分片）⇒ 直接按队列 key 匹配。
        // 撤回**不受 scope 影响**（它只改 status，不看政策轴）。
        const rawWanted = domainArg.toLowerCase()
        let wanted = null
        if (queueScopeOf(domainArg) === SCOPE_SESSION || rawWanted.startsWith('sess')) {
        // 本工具只按会话 id 找队列 key，不需要体系索引（用空索引即可，别在这里读盘）。
        const rowsForWithdraw = liveTopLevel(ctx, emptyIndex())
          const resolvedSession = resolveSessionKeyForState(loadDeclarations(config.domainsFile), rowsForWithdraw, domainArg)
          if (resolvedSession.error) {
            return {
              action: 'withdraw',
              outcome: 'invalid',
              reason: resolvedSession.reason ?? resolvedSession.error,
              candidates: resolvedSession.candidates ?? null,
              self,
              hint: resolvedSession.error,
            }
          }
          wanted = String(resolvedSession.id).toLowerCase()
        } else {
          const declarations = loadDeclarations(config.domainsFile)
          const resolved = resolveDomainKeyForState(declarations, domainArg, self.cwd)
          if (resolved.error) {
            return {
              action: 'withdraw',
              outcome: 'invalid',
              reason: resolved.error,
              candidates: resolved.candidates ?? null,
              self,
            }
          }
          wanted = String(resolved.key).toLowerCase()
        }
        keys = keys.filter((key) => key === wanted)
      }
      const hits = []
      for (const key of keys) {
        for (const record of inboxes.byKey.get(key) || []) {
          if (record.id === id) hits.push({ key, record })
        }
      }
      if (hits.length === 0) {
        return {
          action: 'withdraw',
          outcome: 'not-found',
          id,
          domain: domainArg || null,
          inboxDir: inboxes.dir,
          inboxesError: inboxes.error,
          queuedKeys: [...inboxes.byKey.keys()].sort(),
          self,
          hint: `队列里没有 id=${id} 这条消息${domainArg ? `（已按域 ${domainArg} 过滤）` : ''}。可能 id 抄错了，或它已经被 delivered / withdrawn（撤回只对 pending 生效）。`,
        }
      }
      if (hits.length > 1) {
        return {
          action: 'withdraw',
          outcome: 'ambiguous-id',
          id,
          keys: hits.map((hit) => hit.key).sort(),
          self,
          hint: '这个 id 在多个域的队列里都出现了（同一个 id 不该跨域重复）：请加 domain 参数指明是哪一个。',
        }
      }
      const { key, record } = hits[0]
      const from = record.from ?? null
      const forced = args.force === true
      const mine = Boolean(self.id) && from !== null && from === self.id
      const fromShort = shortId(from) || from || '（未记录发件人）'
      if (!mine && !forced) {
        return {
          action: 'withdraw',
          outcome: 'not-owner',
          id,
          key,
          scope: queueScopeOf(key),
          status: record.status ?? null,
          from,
          fromShort,
          self,
          hint:
            `这条不是本会话发的（发件人是 ${fromShort}）⇒ **没有撤回**。默认只允许撤回自己发的；` +
            `确实要替它撤回：force=true（回执会标注 forced）。`,
        }
      }
      if (record.status !== INBOX_PENDING) {
        return {
          action: 'withdraw',
          outcome: 'not-pending',
          id,
          key,
          scope: queueScopeOf(key),
          status: record.status ?? null,
          from,
          fromShort,
          deliveredAt: record.deliveredAt ?? null,
          failedReason: record.failedReason ?? null,
          self,
          hint: `这条已经是 ${record.status}，**没有动它**（撤回只对 pending 生效）。`,
        }
      }
      const at = new Date().toISOString()
      const updated = updateInboxStatus(config.stateDir, key, id, INBOX_WITHDRAWN, {
        withdrawnAt: at,
        withdrawnBy: self.id ?? null,
      })
      if (!updated.ok) {
        return {
          action: 'withdraw',
          outcome: 'write-failed',
          id,
          key,
          scope: queueScopeOf(key),
          reason: updated.reason,
          error: updated.error ?? null,
          file: updated.file,
          self,
          hint: `写队列失败（${updated.error ?? updated.reason}）：这条**没有被撤回**，仍是 pending。`,
        }
      }
      const inbox = loadInbox(config.stateDir, key)
      if (forced && !mine) {
        warn(`[${TRACE_ID_V040}] 强制撤回（别人的消息）：${key} id=${id}，发件人=${fromShort}，操作人=${self.id ?? '（未知）'}。`)
      }
      return {
        action: 'withdraw',
        outcome: 'withdrawn',
        id,
        key,
        scope: queueScopeOf(key),
        status: INBOX_WITHDRAWN,
        forced: forced && !mine,
        from,
        fromShort,
        mode: record.mode ?? null,
        queuedAt: record.at ?? null,
        withdrawnAt: at,
        withdrawnBy: self.id ?? null,
        messagePreview: clipToBytes(record.message ?? '', 80),
        pending: inbox.pending,
        queuedTotal: inbox.total,
        file: inbox.file,
        wrote: true,
        self,
        hint:
          `已撤回 id=${id}（「${key}」的队列，status=withdrawn；记录留在文件里当留痕）。` +
          `这个域现在还有 ${inbox.pending} 条 pending。` +
          (forced && !mine ? '（这次是 force 撤回**别人发的**消息。）' : ''),
      }
    },
  )
}

// ------------------------------------------------- v0.6.0/v0.6.1 model dispatch (list_models / set_model / set_default_model)
//
// 事实依据（dsh 0.2.1-rc.2 读 asar 定案；v0.6.0 首次真机验证后的修正见下）：
//   selectModel({sessionId, provider, model, reasoningEffort?}) 改该会话模型，**下一轮请求生效**；
//   失败码 session/not-found | session/writer-held | session/model-unavailable。副作用：它会在后台
//   把该选择写成**全局默认** ⇒ 本插件一律「先记 → 改 → 恢复」，并把 before/after/restored 如实回报。
//   modelCatalog() **async**（lib/index.js:3121 → lib/types/catalog.js:10 buildModelCatalog）→
//   {default, routableProviders, groups:[{id,name,models}], failures}；groups 空 ⇒ 退
//   ctx.llm.listProviders() / listModels(provider)（catalog.js:11/14 自己就是这么组装的）。
//   会话级模型选择投影：sessionController.projections({sessionId}, signal)（lib/index.js:3280，
//   返回 {kind:'sequenced', asOfSeq, values}，values.modelSelection ＝ wire 视图 {lastUsed, next}）；
//   退路 sessionProjections.stateOf(sessionObject, 'modelSelection')（宿主状态 {lastUsed, pending}）
//   —— 注意它要 Session **对象**，传 id 字符串必抛。
//   全局默认：agentDefaultModel.currentSelection() / saveSelection(next)（catalog.js:10 默认参数就在用它）。
// 所有宿主 API 都在调用点做 `typeof` 探测：拿不到就回 {ok:false, reason:'api-unavailable'}，绝不抛。

/** Normalize a {provider, model, reasoningEffort?} selection; null when it is not a usable pair. */
