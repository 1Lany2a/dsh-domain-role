/**
 * dsh-domain-bridge — v0.8.8 read-only state snapshot (the GUI block's one data source).
 *
 * Why this file exists: the sidebar block wants "体系 / 项目 / 主会话 / 域会话 / 历史 / 记录" in one
 * payload. Every piece already exists in some book (registrations, owners, pause states, inbox
 * queues, the index snapshot) but nothing joins them. This module joins them **read-only**:
 *   · it never writes a file, never calls a model, never wakes a session;
 *   · every missing input degrades to an empty list + a `warnings` line, never to an exception;
 *   · the GUI is a shell: it renders this, it does not re-derive state (same rule as `_pages`).
 *
 * Contract (frozen): `GET /api/dsh-domain-bridge/state` -> buildStateSnapshot(ctx, deps)
 */

import fs from 'node:fs'
import path from 'node:path'
import { VERSION, shortId, textOf, stateRoot } from './shared.js'
import { readRegistrations, listRegistrations, projectOfCwd } from './registrations.js'
import { loadDeclarations } from './declaration.js'
import {
  loadDomainStates,
  pauseCandidatesForSession,
  pauseCandidatesGlobal,
  pauseHitsOfMap,
  pausedScopesOf,
  pausedByScopesOf,
  projectOfSessionDeclarations,
} from './pause.js'
import { loadInboxes } from './messaging.js'

const STATE_ONLINE_ACTIVE = '在线·活动'
const STATE_ONLINE_PAUSED = '在线·已暂停'
const STATE_OFFLINE_ACTIVE = '离线·活动'
const STATE_OFFLINE_PAUSED = '离线·已暂停'

/** Index snapshot is ~600 KB; re-parsing it per request would be silly. Cache by (mtime, size). */
let indexCache = { file: null, mtimeMs: 0, size: 0, doc: null }

function readIndex(file) {
  const target = textOf(file)
  if (!target) return null
  try {
    const stat = fs.statSync(target)
    if (indexCache.file === target && indexCache.mtimeMs === stat.mtimeMs && indexCache.size === stat.size) {
      return indexCache.doc
    }
    const doc = JSON.parse(fs.readFileSync(target, 'utf8'))
    indexCache = { file: target, mtimeMs: stat.mtimeMs, size: stat.size, doc }
    return doc
  } catch {
    return null
  }
}

/** Live agents by session id (the only truthful "online" signal: an in-process Agent exists). */
function liveAgents(ctx) {
  const out = new Map()
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : ctx && ctx.agents
    const roots = agents && typeof agents.roots === 'function' ? agents.roots() : []
    for (const agent of Array.isArray(roots) ? roots : []) {
      if (agent && agent.id) out.set(String(agent.id), agent)
    }
  } catch {
    /* no agents service: everything reads as offline, which is honest */
  }
  return out
}

function existsSyncSafe(file) {
  try {
    return Boolean(file) && fs.existsSync(file)
  } catch {
    return false
  }
}

function cleanProjectName(value) {
  const name = textOf(value).toLowerCase()
  if (!name || name === '.' || name === '..') return null
  // 目录名里出现路径分隔符或盘符 ⇒ 不是项目名，别拿它当键。
  if (/[\\/]/.test(name) || /^[a-z]:$/.test(name)) return null
  return name
}

/** 活 Agent 的 cwd（拿不到就是 null；绝不猜）。只有在线会话才有活 Agent。 */
function cwdOfAgent(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null
  } catch {
    return null
  }
}

/**
 * 一条会话在**四级政策轴**上的有效状态（F-09：与 `list_domain_*` 同一套判定，OR 叠加）。
 *   ① 它自己的 session 级；② 它所在项目；③ 它持有的域级（held-domain）；④ global。
 *
 * 为什么不直接用 `sessionPauseFields()`：那份只从**活 Agent 的 cwd** 推项目，而 /state 的行
 * 常常是**离线**会话（没有活 Agent）；它们的项目只能从注册册/域名册拿。所以这里用同一批
 * 导出的积木自己拼候选键——判定（`pauseHitsOfMap` → `lookupPauseRecord`）与 list_* 逐字同一套，
 * 而不是第二套规则。
 */
function sessionPauseState({ id, project, cwd, states, declarations, ctx }) {
  // 项目口径与 list_domain_* 一致：域名册声明里的项目优先，其次才是"册子里登记的项目"，
  // 最后交给 pauseCandidatesForSession 用活 Agent 的 cwd 兜底。
  const fromDeclarations = projectOfSessionDeclarations(declarations, id)?.project || null
  const fromRow = textOf(project) ? textOf(project).toLowerCase() : null
  const projectHint = fromDeclarations || fromRow || (cwd ? projectOfCwd(cwd).project : null)
  const { candidates } = pauseCandidatesForSession(declarations, ctx, id, {
    viaSession: 'self-session',
    viaProject: 'self-project',
    viaDomainFromSession: 'held-domain',
    side: 'self',
    projectHint,
    projectFrom: fromDeclarations
      ? '域名册里该会话持有的声明'
      : fromRow
        ? '这条会话在册子里登记的项目名（小写）'
        : '这条会话活 Agent 的 cwd 目录名（小写）',
  })
  candidates.push(...pauseCandidatesGlobal())
  const { hits } = pauseHitsOfMap(states, candidates)
  return {
    paused: hits.length > 0,
    pausedScopes: pausedScopesOf(hits),
    pausedByScopes: pausedByScopesOf(hits),
    pausedDomains: hits
      .filter((hit) => hit.scope === 'domain')
      .map((hit) => String(hit.key))
      .sort(),
  }
}

/**
 * One session row. `pending` counts queue records whose key matches either the domain key or the
 * session id (the queue keys by *the target's own key*, so a domain session can be counted twice).
 *
 * F-09：`paused` / `state` 与 `list_domain_*` **同口径**——四级 OR（会话自己 / 它所在项目 /
 * 它持有的域 / global），而不是只看 session 级；`pausedScopes` / `pausedByScopes` 把
 * "到底是哪几级按着、谁按的"原样带出去。
 */
function sessionRow({ sessionId, projects, layer, key, project, domain, live, states, book, ctx, lastActivity, missionCount, pendingByKey }) {
  const id = String(sessionId || '')
  const online = live.has(id)
  const pause = sessionPauseState({ id, project, cwd: cwdOfAgent(live.get(id)), states, declarations: book, ctx })
  const hits = Array.isArray(pause.pausedByScopes) ? pause.pausedByScopes : []
  // 旧字段（pausedAt/pausedBy/pausedNote）语义不变：优先给「这条会话自己那一级」的记录，
  // 没有就退回第一条命中——总比"被项目/全局按着、却报成没人按"诚实。
  const own = hits.find((hit) => hit.scope === 'session') || hits[0] || null
  const paused = pause.paused === true
  const domainKey = domain && project ? `${project}:${domain}` : null
  const pending =
    (pendingByKey.get(id.toLowerCase()) || 0) + (domainKey ? pendingByKey.get(domainKey.toLowerCase()) || 0 : 0)
  return {
    id,
    short: shortId(id),
    layer,
    key: key || domainKey || null,
    project: project || null,
    domain: domain || null,
    role:
      layer === 'system'
        ? '体系主会话'
        : layer === 'project'
          ? '项目主会话'
          : domain
            ? `域会话 · ${domain}`
            : '会话',
    online,
    paused,
    state: paused ? (online ? STATE_ONLINE_PAUSED : STATE_OFFLINE_PAUSED) : online ? STATE_ONLINE_ACTIVE : STATE_OFFLINE_ACTIVE,
    pausedAt: own?.pausedAt || null,
    pausedBy: own?.pausedBy || null,
    pausedNote: own?.pauseNote || null,
    // F-09：哪几级按着（全量，不只报一个）；`pausedDomains` 是该会话持有的、被按下的域键。
    pausedScopes: Array.isArray(pause.pausedScopes) ? pause.pausedScopes : [],
    pausedByScopes: hits,
    pausedDomains: Array.isArray(pause.pausedDomains) ? pause.pausedDomains : [],
    pending,
    lastActivity: lastActivity.get(id) || null,
    missions: missionCount.get(id) || 0,
    // 只读投影：模型不在索引里，这里如实给 null（GUI 不许编）
    model: null,
    preset: null,
    projects,
  }
}

/**
 * 嵌套项目根分组：`study\cpp-learning` 属于 `study`。
 * 判据＝另一条项目根是本条的前缀路径（逐段比、忽略大小写），取**最长**的那个当父。
 * 找不到父 ⇒ null（顶层项目）。GUI 靠这个把「学科」折进「study」下面，别把 20+ 张卡一次铺开。
 */
function groupOfRow(row, projectNames) {
  if (!row || !row.root) return null
  const parts = String(row.root).split(/[\\/]+/).filter(Boolean)
  let best = null
  for (const other of projectNames.values()) {
    if (!other || other === row || !other.root) continue
    const prefix = String(other.root).split(/[\\/]+/).filter(Boolean)
    if (prefix.length >= parts.length) continue
    const matches = prefix.every((part, index) => String(part).toLowerCase() === String(parts[index] || '').toLowerCase())
    if (matches && (!best || prefix.length > best.length)) best = { name: other.name, length: prefix.length }
  }
  return best ? best.name : null
}

/**
 * The whole snapshot. Pure read: no writes, no host mutation, no model call.
 * `opts.cwd` is the caller's working directory (used to mark "this project" in the GUI).
 */
export function buildStateSnapshot(ctx, deps, opts = {}) {
  const config = (deps && deps.config) || {}
  const warnings = []

  const read = readRegistrations(config.domainsFile)
  if (read.error) warnings.push(`注册册读不懂（${read.error}）⇒ 复核身份前先修它`)
  const doc = read.doc || { registrations: {}, owners: {} }
  const registrations = listRegistrations(doc)

  const loaded = loadDeclarations(config.domainsFile)
  const declarations = (loaded && Array.isArray(loaded.entries) ? loaded.entries : []).slice()
  if (loaded && loaded.error) warnings.push(`域声明读不懂（${loaded.error}）`)

  let states = null
  let pausedEntries = []
  try {
    states = loadDomainStates(config.stateDir)
    pausedEntries = (states && Array.isArray(states.entries) ? states.entries : []).filter((row) => row && row.paused === true)
    if (states && states.error) warnings.push(`暂停状态读不懂（${states.error}）`)
  } catch (error) {
    warnings.push(`暂停状态读取失败（${error?.message || String(error)}）`)
  }
  const pausedBySession = new Map()
  const pausedByDomain = new Map()
  for (const row of pausedEntries) {
    if (row.scope === 'session') pausedBySession.set(String(row.key), row)
    else if (row.scope === 'domain') pausedByDomain.set(String(row.key).toLowerCase(), row)
  }

  const pendingByKey = new Map()
  try {
    const inbox = loadInboxes(config.stateDir)
    for (const [key, rows] of inbox.byKey) {
      const count = rows.filter((row) => row && row.status === 'pending').length
      if (count) pendingByKey.set(key, count)
    }
    if (inbox.error) warnings.push(`队列目录读不懂（${inbox.error}）`)
    // F-08：坏行 / 不可读文件以前被静默丢掉（totals.pending 少计、warnings 空）。
    // 这里复用 loadInboxes() 已有的 degraded 信息，一行一条进 warnings；
    // pending 仍只统计能读的行（坏行没有状态可依，硬凑数字就是编），这句说明跟着一起给。
    for (const item of Array.isArray(inbox.degraded) ? inbox.degraded : []) {
      warnings.push(
        `队列文件 ${item.file} 有读不懂的行或读不动（${item.error}）⇒ 能读的行照常统计，` +
          '坏行/整个文件**没有**计入 pending（pending 只数能读的行）；请人工看一眼这个文件',
      )
    }
  } catch (error) {
    warnings.push(`队列读取失败（${error?.message || String(error)}）`)
  }

  const index = readIndex(config.indexFile)
  const lastActivity = new Map()
  const missionCount = new Map()
  for (const mission of (index && Array.isArray(index.missions) ? index.missions : [])) {
    const sid = textOf(mission && mission.sessionId)
    if (!sid) continue
    missionCount.set(sid, (missionCount.get(sid) || 0) + 1)
    const at = Number(mission && mission.lastActivity)
    if (Number.isFinite(at) && at > (lastActivity.get(sid) || 0)) lastActivity.set(sid, at)
  }

  const live = liveAgents(ctx)
  const callerCwd = textOf(opts.cwd) || null
  const callerProject = callerCwd ? (projectOfCwd(callerCwd).project || null) : null

  // ── 会话行：先放注册册（体系/项目），再放 owners（域），同一 sessionId 合并成一条
  const bySession = new Map()
  const addProjects = (id, value) => {
    const row = bySession.get(id)
    if (!row) return
    if (value && !row.projects.includes(value)) row.projects.push(value)
  }
  for (const row of registrations) {
    const id = String(row.sessionId || '')
    if (!id) continue
    if (!bySession.has(id)) {
      bySession.set(
        id,
        sessionRow({
          sessionId: id,
          projects: row.project ? [row.project] : [],
          layer: row.layer,
          key: row.key,
          project: row.project,
          domain: row.domain,
          live,
          states,
          book: loaded,
          ctx,
          lastActivity,
          missionCount,
          pendingByKey,
        }),
      )
    }
  }
  for (const row of declarations) {
    const id = String(row.sessionId || '')
    if (!id) continue
    if (!bySession.has(id)) {
      bySession.set(
        id,
        sessionRow({
          sessionId: id,
          projects: row.project ? [row.project] : [],
          layer: 'domain',
          key: row.key,
          project: row.project,
          domain: row.domain,
          live,
          states,
          book: loaded,
          ctx,
          lastActivity,
          missionCount,
          pendingByKey,
        }),
      )
    } else {
      addProjects(id, row.project)
    }
  }

  // ── 项目：注册册 ∪ 域声明 ∪ 索引项目根（索引才是"老项目"被发现的地方）
  const projectNames = new Map()
  const touch = (name, source) => {
    const clean = cleanProjectName(name)
    if (!clean) return
    const row = projectNames.get(clean) || { name: clean, sources: [], root: null, nested: false }
    if (!row.sources.includes(source)) row.sources.push(source)
    projectNames.set(clean, row)
  }
  for (const row of registrations) touch(row.project, 'registration')
  for (const row of declarations) touch(row.project, 'declaration')
  const roots = index && Array.isArray(index.projectRoots) ? index.projectRoots : []
  const rootDepth = (value) => String(value).split(/[\\/]+/).filter(Boolean).length
  for (const root of roots) {
    const name = path.basename(String(root))
    touch(name, 'index')
    const row = projectNames.get(String(name).toLowerCase())
    if (row && !row.root) row.root = String(root)
  }
  for (const row of projectNames.values()) {
    row.nested = Boolean(row.root) && rootDepth(row.root) > 2
  }

  const projects = [...projectNames.values()]
    .map((row) => {
      const mainKey = `${row.name}:main`
      const systemKey = `${row.name}:system`
      const mainReg = registrations.find((item) => String(item.key).toLowerCase() === mainKey) || null
      const systemReg = registrations.find((item) => String(item.key).toLowerCase() === systemKey) || null
      const domains = declarations
        .filter((item) => String(item.project || '').toLowerCase() === row.name)
        .map((item) => {
          const id = String(item.sessionId || '')
          return {
            key: item.key,
            domain: item.domain,
            sessionId: id,
            short: shortId(id),
            online: live.has(id),
            paused: pausedByDomain.has(String(item.key).toLowerCase()) || pausedBySession.has(id),
            pending: pendingByKey.get(String(item.key).toLowerCase()) || 0,
            since: item.since || null,
            note: item.note || '',
            lastActivity: lastActivity.get(id) || null,
          }
        })
        .sort((a, b) => String(a.key).localeCompare(String(b.key)))
      const main = mainReg
        ? {
            key: mainReg.key,
            sessionId: String(mainReg.sessionId || ''),
            short: shortId(mainReg.sessionId),
            online: live.has(String(mainReg.sessionId || '')),
            paused: pausedBySession.has(String(mainReg.sessionId || '')),
            since: mainReg.since || null,
            note: mainReg.note || '',
            pending: pendingByKey.get(String(mainReg.key).toLowerCase()) || 0,
          }
        : null
      const root = row.root || null
      return {
        name: row.name,
        isSystem: Boolean(systemReg),
        system: systemReg
          ? { key: systemReg.key, sessionId: String(systemReg.sessionId || ''), short: shortId(systemReg.sessionId) }
          : null,
        main,
        domains,
        // 接入状态：这条判断和 /adopt 的 adoptStatus() 是同一个口径（有 <项目>:main 才算接入）
        adoption: systemReg ? 'system' : main ? (main.online ? 'adopted' : 'adopted-offline') : 'unregistered',
        group: groupOfRow(row, projectNames),
        root,
        hasProjectFile: root ? existsSyncSafe(path.join(root, 'PROJECT.md')) : null,
        sources: row.sources,
        nested: row.nested,
        current: callerProject ? callerProject === row.name : false,
      }
    })
    .sort((a, b) => {
      // 当前项目 → 体系 → 已接入 → 未接入；同组按名字
      const rank = (row) => (row.current ? 0 : row.adoption === 'system' || row.isSystem ? 1 : row.adoption.startsWith('adopted') ? 2 : 3)
      const diff = rank(a) - rank(b)
      return diff !== 0 ? diff : a.name.localeCompare(b.name)
    })

  // ── 历史：session 级暂停记录就是"退役留痕"（不另造台账）
  const history = pausedEntries
    .filter((row) => row.scope === 'session')
    .map((row) => ({
      sessionId: String(row.key),
      short: shortId(row.key),
      retiredAt: row.pausedAt || null,
      by: row.pausedBy || null,
      note: row.note || row.pauseNote || '',
      online: live.has(String(row.key)),
    }))
    .sort((a, b) => String(b.retiredAt || '').localeCompare(String(a.retiredAt || '')))

  // ── 记录入口：只给存在的路径，不存在就是 null（GUI 不显示死链）
  const registryDir = textOf(config.domainsFile) ? path.dirname(textOf(config.domainsFile)) : null
  const systemRoot = registryDir ? path.dirname(registryDir) : null
  const records = {
    handoff: registryDir && existsSyncSafe(path.join(registryDir, 'handoff.json')) ? path.join(registryDir, 'handoff.json') : null,
    changelog:
      systemRoot && existsSyncSafe(path.join(systemRoot, 'templates', 'SYSTEM-changelog.md'))
        ? path.join(systemRoot, 'templates', 'SYSTEM-changelog.md')
        : null,
    projectlog:
      systemRoot && existsSyncSafe(path.join(systemRoot, 'tixiweihu', 'projectlog'))
        ? path.join(systemRoot, 'tixiweihu', 'projectlog')
        : null,
    index: index && existsSyncSafe(config.indexFile) ? config.indexFile : null,
    domains: existsSyncSafe(config.domainsFile) ? config.domainsFile : null,
  }

  const systemRows = registrations
    .filter((row) => row.layer === 'system')
    .map((row) =>
      sessionRow({
        sessionId: row.sessionId,
        projects: [row.project],
        layer: 'system',
        key: row.key,
        project: row.project,
        domain: row.domain,
        live,
        states,
        book: loaded,
        ctx,
        lastActivity,
        missionCount,
        pendingByKey,
      }),
    )

  const sessions = [...bySession.values()]
  // F-10：`reads.stateDir` 以前是 `config.stateDir || null`，而配置里通常**不写** stateDir
  // （默认值 `<home>/state` 由 stateRoot() 解析）⇒ 字段恒为 null。这里报**真正读盘用的那个目录**
  // （与 loadDomainStates/loadInboxes 内部同一口径）；真解析不出来就省略该字段，不拿 null 冒充。
  const resolvedStateDir = stateRoot(config.stateDir)
  const reads = { domainsFile: config.domainsFile || null }
  if (resolvedStateDir) reads.stateDir = resolvedStateDir
  reads.indexFile = config.indexFile || null
  return {
    ok: true,
    plugin: VERSION,
    generatedAt: new Date().toISOString(),
    reads,
    freshness: {
      indexAt: index && index.generatedAt ? index.generatedAt : null,
      domainsMtime: (() => {
        try {
          return fs.statSync(config.domainsFile).mtime.toISOString()
        } catch {
          return null
        }
      })(),
    },
    totals: {
      sessions: sessions.length,
      live: live.size,
      domains: declarations.length,
      paused: pausedEntries.length,
      projects: projects.length,
      unregistered: projects.filter((row) => row.adoption === 'unregistered').length,
      pending: [...pendingByKey.values()].reduce((sum, value) => sum + value, 0),
      missions: index && index.counts && Number(index.counts.missions) ? Number(index.counts.missions) : null,
    },
    systems: systemRows,
    projects,
    sessions,
    history,
    records,
    caller: { cwd: callerCwd, project: callerProject },
    warnings,
  }
}
