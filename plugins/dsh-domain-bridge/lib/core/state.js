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
import { VERSION, shortId, textOf } from './shared.js'
import { readRegistrations, listRegistrations, projectOfCwd } from './registrations.js'
import { loadDeclarations } from './declaration.js'
import { loadDomainStates } from './pause.js'
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

/**
 * One session row. `pending` counts queue records whose key matches either the domain key or the
 * session id (the queue keys by *the target's own key*, so a domain session can be counted twice).
 */
function sessionRow({ sessionId, projects, layer, key, project, domain, live, pausedBySession, lastActivity, missionCount, pendingByKey }) {
  const id = String(sessionId || '')
  const online = live.has(id)
  const paused = pausedBySession.get(id) || null
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
    paused: Boolean(paused),
    state: paused ? (online ? STATE_ONLINE_PAUSED : STATE_OFFLINE_PAUSED) : online ? STATE_ONLINE_ACTIVE : STATE_OFFLINE_ACTIVE,
    pausedAt: paused?.pausedAt || null,
    pausedBy: paused?.pausedBy || null,
    pausedNote: paused?.note || paused?.pauseNote || null,
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

  let pausedEntries = []
  try {
    const states = loadDomainStates(config.stateDir)
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
          pausedBySession,
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
          pausedBySession,
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
        pausedBySession,
        lastActivity,
        missionCount,
        pendingByKey,
      }),
    )

  const sessions = [...bySession.values()]
  return {
    ok: true,
    plugin: VERSION,
    generatedAt: new Date().toISOString(),
    reads: { domainsFile: config.domainsFile || null, stateDir: config.stateDir || null, indexFile: config.indexFile || null },
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
