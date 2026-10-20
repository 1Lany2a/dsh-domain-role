/**
 * dsh-domain-bridge — 注册册（`domains.json` 的平行节 `registrations`）＋ 本插件唯一的
 * 「进程间锁 + 唯一名 tmp」写盘通道（`declaration.js` 也复用它）。
 *
 * 契约（**冻结**，函数名/签名/返回键逐字照做）：`D:\dsh\Generated\2026-10-19\spec\commands-v1.md` §2.2 / §2.3。
 * 口径按 spec（不是调研稿）：
 *   ① `owners`（域在任）一字不动；**域层不写这里** —— 域负责人仍写在 `owners`（不造第二本台账）；
 *   ② 键规则：体系 `"<project>:system"`、项目 `"<project>:main"`、域 `"<project>:<域>"`（在 owners）；
 *   ③ `registrations` 读不懂 ⇒ 一律当空册并回报 `error`，**绝不覆盖写**。
 *
 * 写盘为什么这么写（2026-10-19 调研实测：research/C-注册数据模型.md §4）：
 *   · 固定名 `<file>.tmp` 在并发下会**静默丢写**（A 报成功、内容却被 B 冲掉，已复现）；
 *   · `wx` 独占锁文件是 Windows 上实测可用的原子获取（第二次必 EEXIST）；
 *   · `renameSync` 在 Windows 上会被杀软/索引器干扰（EACCES/EBUSY/EPERM）⇒ 必须重试。
 *
 * **永不抛**：所有导出函数都回 `{ok, ...}` 形状的中文回执。唯一例外是 `writeAtomicUnique()`——
 * 它是字节级写入器，故意抛错，让两个写盘器各自决定怎么回报（declaration.js 保持"抛错"语义不变）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { messageOf } from './shared.js'
import { warn } from './tools.js'

/** 本模块的审计 traceId（项目规则 vibe-audit-logger-lite）：冲突/换人/抢锁接管/写失败共用它。 */
const TRACE_ID = 'bridge-s04-1019'

/** 三层字面量（数据面只用这三个词；中文只在回执里出现）。 */
const LAYERS = ['system', 'project', 'domain']
/** 排序口径：体系 → 项目 → 域（`listRegistrations` 的"按 layer 排序"就按它）。 */
const LAYER_RANK = { system: 0, project: 1, domain: 2 }

/** §2.3 锁参数：最多重试 15 次 × 20ms；rename 失败最多重试 10 次 × 10ms。 */
const LOCK_RETRIES = 15
const LOCK_WAIT_MS = 20
const RENAME_RETRIES = 10
const RENAME_WAIT_MS = 10

/** 体系根的标志文件（`projectOfCwd` 用它判 isSystemRoot，见该函数注释）。 */
const SYSTEM_ROOT_MARKER = 'SYSTEM-OVERVIEW.md'

// ------------------------------------------------------------------ 小工具

/** 纯对象（不是 null / 数组）。 */
function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 锁里的 pid 还活着吗？`process.kill(pid, 0)` 抛 `ESRCH` = 死锁（可接管）。
 * pid 读不出 / 非正数（如 0 = 进程组）⇒ 一律当作"活着"：**读不懂的锁绝不接管**，
 * 宁可如实报 locked 让人来处理，也不去删一把不认识的锁。
 */
function pidIsDead(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

let sleepView = null

/**
 * 同步睡眠。**必须是同步的**：declaration.js 的读-改-写（claim/release/appendNoteLine）全在
 * 同步路径里（没有 await），把锁改成 async 会把所有调用方一起改掉 —— 契约只允许改那两点。
 * 优先 Atomics.wait（不烧 CPU）；SharedArrayBuffer/Atomics 不可用时退化为忙等兜底。
 */
function sleepSync(ms) {
  if (!(ms > 0)) return
  try {
    if (!sleepView) sleepView = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(sleepView, 0, 0, ms)
    return
  } catch {
    /* 兜底：下面的忙等 */
  }
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* 兜底忙等：正常路径不会走到这里 */
  }
}

/** 空册（文件不存在＝正常状态，不是错误）。 */
function emptyDoc() {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), owners: {}, registrations: {} }
}

/** 唯一名 tmp：`<file>.<pid>.<rand>.tmp`（固定名会被并发写踩，实测已复现）。 */
function tmpNameFor(file) {
  let rand
  try {
    rand = randomBytes(4).toString('hex')
  } catch {
    rand = Math.random().toString(16).slice(2, 10)
  }
  return `${file}.${process.pid}.${rand}.tmp`
}

/** 键里的项目段（`项目:域` / `项目:main` / `项目:system`）。 */
function projectOfKey(key) {
  const text = String(key ?? '')
  const colon = text.indexOf(':')
  return colon === -1 ? text : text.slice(0, colon)
}

/** 键里的槽位段。 */
function slotOfKey(key) {
  const text = String(key ?? '')
  const colon = text.indexOf(':')
  return colon === -1 ? '' : text.slice(colon + 1)
}

/** 项目名/域名的合法性（与 declaration.js 的 checkName 同一口径；这里本地实现以避开循环 import）。 */
function badName(value, label) {
  if (!value) return `${label}不能为空。`
  if (value.includes(':')) return `${label}里不能包含英文冒号（冒号是「项目:域」的分隔符）。`
  if (value.includes('/') || value.includes('\\')) return `${label}里不能包含斜杠。`
  return null
}

/** 从键推层（容错：手改的记录缺 layer 时用得上）。 */
function layerFromKey(key) {
  const slot = slotOfKey(key).toLowerCase()
  if (slot === 'system') return 'system'
  if (slot === 'main') return 'project'
  return slot ? 'domain' : null
}

/** 一条注册记录的对外形状（已知字段归一化 + 未知字段一律保住）。 */
function registrationRow(key, record) {
  const row = plainObject(record) ? record : {}
  const layer = LAYERS.includes(row.layer) ? row.layer : layerFromKey(key)
  const slot = layer === 'system' ? 'system' : layer === 'project' ? 'main' : slotOfKey(key)
  return {
    ...row,
    key: String(row.key ?? key),
    layer: layer ?? null,
    project: row.project ?? projectOfKey(key) ?? null,
    domain: row.domain ?? slot ?? null,
    sessionId: row.sessionId ?? null,
    since: row.since ?? null,
    by: row.by ?? null,
    title: typeof row.title === 'string' ? row.title : '',
    note: typeof row.note === 'string' ? row.note : '',
  }
}

/** 层序比较（system → project → domain → 未知殿后），层内按键。 */
function compareRows(a, b) {
  const ra = LAYER_RANK[a.layer] ?? 9
  const rb = LAYER_RANK[b.layer] ?? 9
  if (ra !== rb) return ra - rb
  return String(a.key).localeCompare(String(b.key))
}

// ------------------------------------------------------------------ §2.3 锁

/**
 * 独占锁：锁文件 `<domainsFile>.lock`，`fs.writeFileSync(lock, JSON.stringify({pid, at}), {flag:'wx'})`。
 * `EEXIST` ⇒ 最多重试 15 次 × 20ms；**超时未获锁**时若锁内 pid 已死 ⇒ 删锁重试一次，否则
 * `{ok:false, reason:'locked'}`（绝不硬写）。
 *
 * 可重入性：**不可重入**（同一进程对同一个文件嵌套调用会等到超时；本模块自己不会嵌套）。
 * `fn` 抛错 ⇒ 如实回 `{ok:false, error}`，锁照样在 `finally` 里释放。
 */
export function withDomainsLock(domainsFile, fn) {
  const file = String(domainsFile ?? '')
  if (!file) return { ok: false, value: null, reason: 'no-file', error: '域名册路径为空，无法加锁。' }
  if (typeof fn !== 'function') {
    return { ok: false, value: null, reason: 'no-function', error: 'withDomainsLock 需要一个要执行的函数。' }
  }
  const lockFile = file + '.lock'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch (error) {
    return { ok: false, value: null, reason: 'lock-failed', error: messageOf(error) }
  }

  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
  let acquired = false
  let lastError = null
  for (let attempt = 0; attempt <= LOCK_RETRIES && !acquired; attempt++) {
    if (attempt > 0) sleepSync(LOCK_WAIT_MS)
    try {
      fs.writeFileSync(lockFile, payload, { flag: 'wx' })
      acquired = true
    } catch (error) {
      if (!lockContention(error, lockFile)) {
        return { ok: false, value: null, reason: 'lock-failed', error: messageOf(error) }
      }
      lastError = error
    }
  }

  if (!acquired) {
    const holder = readLockHolder(lockFile)
    if (holder && pidIsDead(holder.pid)) {
      // 死锁接管：**只重试一次**（spec §2.3）。接管前先按内容确认：拿到的还是刚才那把锁。
      warn(`${`[${TRACE_ID}] `}域名册锁：锁内 pid ${holder.pid} 已死 ⇒ 删锁重试一次（${lockFile}）`)
      try {
        const again = readLockHolder(lockFile)
        if (again && String(again.pid) === String(holder.pid) && pidIsDead(again.pid)) fs.unlinkSync(lockFile)
      } catch {
        /* 已经没了/删不掉：下面那次 wx 会如实失败 */
      }
      try {
        fs.writeFileSync(lockFile, payload, { flag: 'wx' })
        acquired = true
      } catch (error) {
        lastError = error
      }
    }
    if (!acquired) {
      return {
        ok: false,
        value: null,
        reason: 'locked',
        error:
          `等待锁超时（${LOCK_RETRIES} 次 × ${LOCK_WAIT_MS}ms），锁内 pid ${holder?.pid ?? '（读不出）'} 仍活着：` +
          `${messageOf(lastError)}（${lockFile}）`,
      }
    }
  }

  try {
    const value = fn()
    return { ok: true, value: value === undefined ? null : value, error: null }
  } catch (error) {
    return { ok: false, value: null, reason: 'function-threw', error: messageOf(error) }
  } finally {
    releaseLock(lockFile, payload)
  }
}

/** Windows 特例 + 正常争用：只有"确认锁在那儿"才当成抢不到，其它 IO 错误一律如实失败。 */
function lockContention(error, lockFile) {
  if (!error) return false
  if (error.code === 'EEXIST') return true
  // 宿主的 dsh-atomic-write 同样处理这条：Windows 上 `wx` 撞上别人持有的锁可能报 EPERM/EACCES。
  if (error.code === 'EPERM' || error.code === 'EACCES') {
    try {
      return fs.existsSync(lockFile)
    } catch {
      return false
    }
  }
  return false
}

function readLockHolder(lockFile) {
  try {
    const json = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    return plainObject(json) ? json : null
  } catch {
    return null
  }
}

/** 只删自己的锁：内容已经变了 ⇒ 说明锁被（接管后）别人重新持有，绝不删别人的。 */
function releaseLock(lockFile, payload) {
  try {
    if (fs.readFileSync(lockFile, 'utf8') !== payload) return
    fs.unlinkSync(lockFile)
  } catch {
    /* 锁已经不在了：正常路径 */
  }
}

// ------------------------------------------------------------------ 写盘（唯一名 tmp）

/**
 * 字节级原子写入：唯一名 tmp + `rename` 重试（≤10 次 × 10ms）+ `finally` 删自己的 tmp。
 * **故意抛错**（成功回 `{bytes}`），调用方负责转成自己的回执形状。
 * 调用约定：**必须在 `withDomainsLock()` 里调用**（本函数自己不加锁）。
 */
export function writeAtomicUnique(file, body) {
  const target = String(file ?? '')
  if (!target) throw new Error('写入路径为空。')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = tmpNameFor(target)
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8', flag: 'wx' })
    let lastError = null
    let renamed = false
    for (let attempt = 0; attempt <= RENAME_RETRIES && !renamed; attempt++) {
      if (attempt > 0) sleepSync(RENAME_WAIT_MS)
      try {
        fs.renameSync(tmp, target)
        renamed = true
      } catch (error) {
        lastError = error
      }
    }
    if (!renamed) throw lastError
    return { bytes: Buffer.byteLength(body, 'utf8') }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 已经 rename 走了 / 清理失败都不掩盖原始错误 */
    }
  }
}

/**
 * 写整本域名册（唯一名 tmp + rename 重试）。**不加锁**：锁归读-改-写路径那一层
 * （`upsertRegistration` / `removeRegistration` / declaration.js 的 `writeDeclarationsAtomic`）。
 *
 * 会刷新 `updatedAt`（任一节变更都要刷新，沿用现有语义）；某个节**存在但不是对象** ⇒
 * 拒绝写（绝不把读不懂的节覆盖成空的）。
 */
export function writeDomainsAtomic(domainsFile, doc) {
  try {
    const data = plainObject(doc) ? doc : {}
    for (const section of ['owners', 'registrations']) {
      if (data[section] !== undefined && !plainObject(data[section])) {
        return {
          ok: false,
          bytes: null,
          error: `域名册的 ${section} 节不是对象：拒绝覆盖写（避免吃掉别人的数据）。`,
        }
      }
    }
    if (data.schemaVersion === undefined) data.schemaVersion = 1
    data.updatedAt = new Date().toISOString()
    if (!plainObject(data.owners)) data.owners = {}
    if (!plainObject(data.registrations)) data.registrations = {}
    const body = JSON.stringify(data, null, 2) + '\n'
    const written = writeAtomicUnique(domainsFile, body)
    return { ok: true, bytes: written.bytes, error: null }
  } catch (error) {
    return { ok: false, bytes: null, error: messageOf(error) }
  }
}

// ------------------------------------------------------------------ 读

/**
 * 写前读（**坏文件 ⇒ 禁写**）：文件不存在＝空册（正常状态）；JSON 读不懂、顶层不是对象、
 * 某个节存在但不是对象 ⇒ `ok:false`（调用方必须放弃这次写入，绝不覆盖别人的数据）。
 */
export function readRegistrationsForWrite(domainsFile) {
  const file = String(domainsFile ?? '')
  if (!file) return { ok: false, doc: null, error: '域名册路径为空。' }
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, doc: emptyDoc(), error: null }
    return { ok: false, doc: null, error: messageOf(error) }
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return { ok: false, doc: null, error: `域名册读不懂（JSON 解析失败）：${messageOf(error)}` }
  }
  if (!plainObject(json)) return { ok: false, doc: null, error: '域名册顶层不是对象：拒绝覆盖写。' }
  for (const section of ['owners', 'registrations']) {
    if (json[section] !== undefined && !plainObject(json[section])) {
      return {
        ok: false,
        doc: null,
        error: `域名册的 ${section} 节不是对象：拒绝覆盖写（避免吃掉别人的数据）。`,
      }
    }
  }
  const doc = json
  if (doc.schemaVersion === undefined) doc.schemaVersion = 1
  if (!doc.updatedAt) doc.updatedAt = new Date().toISOString()
  if (!plainObject(doc.owners)) doc.owners = {}
  if (!plainObject(doc.registrations)) doc.registrations = {}
  return { ok: true, doc, error: null }
}

/**
 * 只读读注册册：`{ ok, doc, registrations, error }`。
 * 文件不存在 ⇒ `ok:true` + 空册（正常状态）；`registrations` 读不懂 ⇒ `ok:false` + 空册 + `error`。
 */
export function readRegistrations(domainsFile) {
  const read = readRegistrationsForWrite(domainsFile)
  if (!read.ok) return { ok: false, doc: null, registrations: {}, error: read.error }
  return { ok: true, doc: read.doc, registrations: read.doc.registrations, error: null }
}

// ------------------------------------------------------------------ 注册册读写

/**
 * 注册册条目归一化（只认 system / project 两层；域层请走 `claim_domain`）。
 * 键一律由 layer + project 推出来（spec §2.1 的键规则），传了不一致的 key ⇒ 如实拒绝（不猜）。
 */
function normalizeEntry(entry, opts) {
  const source = plainObject(entry) ? entry : {}
  const options = plainObject(opts) ? opts : {}
  const rawLayer = String(source.layer ?? '').trim().toLowerCase()
  const layer = rawLayer || layerFromKey(source.key)

  if (layer === 'domain') {
    return {
      error:
        '域层不写注册节：域负责人仍写在 owners（不造第二本台账）。' +
        '要认领/交接一个域请用 claim_domain（命令行是 /register domain <域>）。',
    }
  }
  if (layer !== 'system' && layer !== 'project') {
    return { error: `layer 只能是 system / project（收到「${rawLayer || '（空）'}」）。` }
  }

  const project = String(source.project ?? '').trim().toLowerCase()
  const badProject = badName(project, '项目')
  if (badProject) return { error: badProject }

  const sessionId = String(source.sessionId ?? '').trim()
  if (!sessionId) return { error: 'sessionId 不能为空（注册册记的是"哪个会话现在在任"）。' }

  const domain = layer === 'system' ? 'system' : 'main'
  const key = `${project}:${domain}`
  const givenKey = String(source.key ?? '').trim()
  if (givenKey && givenKey.toLowerCase() !== key.toLowerCase()) {
    return {
      error: `key（${givenKey}）与 layer=${layer} + project=${project} 推出来的键（${key}）不一致。`,
      hint: '键规则是：体系 `<项目>:system`、项目 `<项目>:main`；别手写 key，给 layer + project 即可。',
    }
  }

  return {
    key,
    layer,
    project,
    domain,
    sessionId,
    force: options.force === true,
    by: source.by ?? options.by ?? null,
    title: typeof source.title === 'string' ? source.title : '',
    note: typeof source.note === 'string' ? source.note : '',
  }
}

/**
 * 写一条注册（体系 / 项目两层）。**整体在读-改-写的锁里做完**（锁外读＝必丢并发写）。
 *   · 同一个人重复注册＝刷新在岗起算时间（幂等，`written:true`）；
 *   · 别人持有且没传 `opts.force` ⇒ `conflict:true` / `written:false` / `owner` = 在任那条，**一个字都不写**；
 *   · `force:true` ⇒ 强制接手，旧会话 id 写进 `note`（`接手自 …` 留痕，沿用 claim_domain 的习惯）。
 */
export function upsertRegistration(domainsFile, entry, opts) {
  const file = String(domainsFile ?? '')
  if (!file) return { ok: false, written: false, conflict: false, owner: null, error: '域名册路径为空。' }
  const normalized = normalizeEntry(entry, opts)
  if (normalized.error) {
    return {
      ok: false,
      written: false,
      conflict: false,
      owner: null,
      reason: 'invalid-entry',
      error: normalized.error,
      ...(normalized.hint ? { hint: normalized.hint } : {}),
    }
  }
  const { key, layer, project, domain, sessionId, force, title, note } = normalized

  // 审计（入口）：要干什么、关键输入（照 vibe-audit-logger-lite 的三段式）。
  warn(
    `${`[${TRACE_ID}] `}注册请求：layer=${layer} key=${key} sessionId=${sessionId}` +
      `${force ? ' force=强制接手' : ''}（读-改-写全程在这把锁里）`,
  )

  const locked = withDomainsLock(file, () => {
    const read = readRegistrationsForWrite(file)
    if (!read.ok) return { status: 'unreadable', error: read.error }
    const doc = read.doc
    const existing = plainObject(doc.registrations[key]) ? doc.registrations[key] : null
    const holder = existing ? registrationRow(key, existing) : null

    if (existing && String(existing.sessionId ?? '') !== sessionId && !force) {
      return { status: 'conflict', holder }
    }

    const handoverFrom = existing && String(existing.sessionId ?? '') !== sessionId ? String(existing.sessionId) : null
    const nextNote = handoverFrom
      ? note
        ? `接手自 ${handoverFrom}；${note}`
        : `接手自 ${handoverFrom}`
      : note
    const record = {
      // 先铺旧记录：未知字段（别的版本写进去的）一律不丢。
      ...(existing || {}),
      key,
      layer,
      project,
      domain,
      sessionId,
      since: new Date().toISOString(),
      by: normalized.by,
      title: title || (typeof existing?.title === 'string' ? existing.title : ''),
      note: nextNote,
    }
    doc.registrations[key] = record
    const write = writeDomainsAtomic(file, doc)
    if (!write.ok) return { status: 'write-failed', error: write.error }
    return { status: 'written', record, holder, handoverFrom, refreshed: Boolean(existing && !handoverFrom) }
  })

  if (!locked.ok) {
    warn(`${`[${TRACE_ID}] `}写入注册 ${key} 失败：${locked.reason}（${locked.error}）`)
    return {
      ok: false,
      written: false,
      conflict: false,
      owner: null,
      key,
      reason: locked.reason || 'write-failed',
      error: locked.error,
    }
  }

  const value = plainObject(locked.value) ? locked.value : {}
  if (value.status === 'unreadable') {
    warn(`${`[${TRACE_ID}] `}写入注册 ${key} 中止：域名册读不懂（${value.error}）`)
    return {
      ok: false,
      written: false,
      conflict: false,
      owner: null,
      key,
      reason: 'domains-file-unreadable',
      error: value.error,
      hint: '域名册已存在但读不懂，为避免覆盖别人的登记，本次没有写入任何文件。',
    }
  }
  if (value.status === 'write-failed') {
    warn(`${`[${TRACE_ID}] `}写入注册 ${key} 失败：${value.error}`)
    return {
      ok: false,
      written: false,
      conflict: false,
      owner: null,
      key,
      reason: 'write-failed',
      error: value.error,
      hint: '写盘失败（原文件未被动过），请检查磁盘/权限后重试。',
    }
  }
  if (value.status === 'conflict') {
    const holder = value.holder || null
    warn(
      `${`[${TRACE_ID}] `}注册 ${key} 冲突：在任 ${holder?.sessionId ?? '（未知）'} ≠ 本次 ${sessionId}，未写入一个字`,
    )
    return {
      ok: false,
      written: false,
      conflict: true,
      owner: holder,
      key,
      reason: 'conflict',
      error: null,
      hint:
        `「${key}」已有注册者 ${holder?.sessionId ?? '（未知）'}（自 ${holder?.since ?? '（未记录）'} 起），本次没有覆盖它。` +
        '下一步三选一：① 要换人 ⇒ 让在任方先 /retire 或由人显式交接（force）；' +
        '② 取消这次注册；③ 让在任方自己退下来（/retire）之后你再注册。',
    }
  }

  const record = value.record || null
  if (value.handoverFrom) {
    warn(`${`[${TRACE_ID}] `}注册 ${key} 强制接手：${value.handoverFrom} ⇒ ${sessionId}（旧会话已写进 note 留痕）`)
  }
  // 审计（结果）：落盘结果 + 影响面（只增改了 registrations 这一节）。
  warn(
    `${`[${TRACE_ID}] `}注册结果：${key} ⇒ ${sessionId}（${
      value.handoverFrom ? `强制接手，前 ${value.handoverFrom}` : value.refreshed ? '同人刷新在岗时间' : '新建'
    }）；owners 一节未改动`,
  )
  return {
    ok: true,
    written: true,
    conflict: false,
    owner: record,
    key,
    handoverFrom: value.handoverFrom ?? null,
    refreshed: value.refreshed === true,
    error: null,
    hint: value.handoverFrom
      ? `已强制接手「${key}」（旧注册者 ${value.handoverFrom} 写进 note 留痕）。`
      : value.refreshed
        ? `「${key}」本来就是你在任，已刷新在岗起算时间（幂等，不算冲突）。`
        : `已注册「${key}」：从现在起你在任（同人重复注册＝刷新在岗起算时间）。`,
  }
}

/**
 * 删一条注册：**只删自己的**（`entries.sessionId !== sessionId` ⇒ `not-owner`，一个字都不写）。
 * 返回 `{ ok, removed, reason? }`：没有这条 ⇒ `{ok:true, removed:false, reason:'absent'}`（幂等）。
 */
export function removeRegistration(domainsFile, key, sessionId) {
  const file = String(domainsFile ?? '')
  const wanted = String(key ?? '').trim()
  const id = String(sessionId ?? '').trim()
  if (!file) return { ok: false, removed: false, reason: 'no-file', error: '域名册路径为空。' }
  if (!wanted) return { ok: false, removed: false, reason: 'missing-key', error: 'key 不能为空。' }
  if (!id) {
    return {
      ok: false,
      removed: false,
      reason: 'missing-session-id',
      error: '必须给出 sessionId：注册册只允许删自己的条目。',
    }
  }

  // 审计（入口）：要干什么、关键输入。
  warn(`${`[${TRACE_ID}] `}注销请求：key=${wanted} sessionId=${id}（只删自己的；读-改-写全程在这把锁里）`)

  const locked = withDomainsLock(file, () => {
    const read = readRegistrationsForWrite(file)
    if (!read.ok) return { status: 'unreadable', error: read.error }
    const doc = read.doc
    const hit = Object.keys(doc.registrations).find((k) => String(k).toLowerCase() === wanted.toLowerCase()) || null
    if (!hit) return { status: 'absent' }
    const record = plainObject(doc.registrations[hit]) ? doc.registrations[hit] : {}
    if (String(record.sessionId ?? '') !== id) return { status: 'not-owner', owner: registrationRow(hit, record) }
    delete doc.registrations[hit]
    const write = writeDomainsAtomic(file, doc)
    if (!write.ok) return { status: 'write-failed', error: write.error }
    return { status: 'removed', key: hit, entry: registrationRow(hit, record) }
  })

  if (!locked.ok) {
    return { ok: false, removed: false, reason: locked.reason || 'write-failed', error: locked.error }
  }
  const value = plainObject(locked.value) ? locked.value : {}
  if (value.status === 'unreadable') {
    return {
      ok: false,
      removed: false,
      reason: 'domains-file-unreadable',
      error: value.error,
      hint: '域名册已存在但读不懂，为避免误删，本次没有写入任何文件。',
    }
  }
  if (value.status === 'write-failed') {
    return { ok: false, removed: false, reason: 'write-failed', error: value.error }
  }
  if (value.status === 'not-owner') {
    return {
      ok: false,
      removed: false,
      reason: 'not-owner',
      owner: value.owner || null,
      hint: '这条注册不是你的：只有注册者本人能删（换人请走强制交接）。',
    }
  }
  if (value.status === 'absent') {
    warn(`${`[${TRACE_ID}] `}注销结果：${wanted} 本来就没有这条注册，无需删除（幂等）`)
    return { ok: true, removed: false, reason: 'absent' }
  }
  // 审计（结果）：删掉了哪一条 + 影响面（只改了 registrations 这一节）。
  warn(`${`[${TRACE_ID}] `}注销结果：${value.key} 已从注册节删掉（sessionId=${id}）；owners 一节未改动`)
  return { ok: true, removed: true, reason: null, key: value.key, entry: value.entry || null }
}

/**
 * 只读列出注册册（`registrations` 节，**不**含 owners 里的域声明）。
 * 排序：体系 → 项目 → 域，层内按 key。`doc` 读不懂 ⇒ 空数组（永不抛）。
 */
export function listRegistrations(doc) {
  try {
    const section = plainObject(doc) && plainObject(doc.registrations) ? doc.registrations : {}
    return Object.keys(section)
      .map((key) => registrationRow(key, section[key]))
      .sort(compareRows)
  } catch {
    return []
  }
}

/**
 * 这个会话现在的身份（**三层**都看）：
 *   · `registrations` 节 ⇒ 体系（`layer:'system'`）与项目（`layer:'project'`）两条任命；
 *   · `owners` 节 ⇒ 域层（`layer:'domain'`，即它持有哪些域的在任声明）。
 * 回 `{ roles, systemMain, projectMains }`：
 *   · `roles` 按 体系→项目→域 排序，每条 `{layer, key, project, domain}`；
 *   · `systemMain`＝有没有体系那一条；
 *   · `projectMains`＝它是 main 的那些**项目名**（小写，去重）——权限闸直接 `includes()` 用。
 * 永不抛：`doc` 不是册子 / 没有这个人 ⇒ 空身份。
 */
export function identityOf(doc, sessionId) {
  const id = String(sessionId ?? '').trim()
  const roles = []
  if (id) {
    for (const row of listRegistrations(doc)) {
      if (String(row.sessionId ?? '') !== id) continue
      roles.push({ layer: row.layer, key: row.key, project: row.project ?? null, domain: row.domain ?? null })
    }
    const owners = plainObject(doc) && plainObject(doc.owners) ? doc.owners : {}
    for (const key of Object.keys(owners)) {
      const record = plainObject(owners[key]) ? owners[key] : {}
      if (String(record.sessionId ?? '') !== id) continue
      roles.push({
        layer: 'domain',
        key: String(record.key ?? key),
        project: record.project ?? projectOfKey(key) ?? null,
        domain: record.domain ?? slotOfKey(key) ?? null,
      })
    }
  }
  roles.sort(compareRows)
  const projectMains = []
  for (const role of roles) {
    if (role.layer !== 'project') continue
    const project = String(role.project ?? '').trim().toLowerCase()
    if (project && !projectMains.includes(project)) projectMains.push(project)
  }
  return { roles, systemMain: roles.some((role) => role.layer === 'system'), projectMains }
}

/**
 * cwd ⇒ `{ project, isSystemRoot }`。项目短名沿用全体系同一口径：目录名小写（`projectFromCwd`）。
 *
 * `isSystemRoot` 的判据＝**cwd 里放着体系口径的唯一源 `SYSTEM-OVERVIEW.md`**（spec §4 的体系层清单
 * 第一项）。刻意不硬编码 `D:\xiangmu`：插件是 portable 的，机器相关的路径不许进代码。
 * 永不抛：cwd 拿不到 ⇒ `{project:null, isSystemRoot:false}`。
 */
export function projectOfCwd(cwd) {
  try {
    // 只认非空字符串：cwd 拿不到（null / undefined / 数字等）时如实回"推不出项目"，
    // 绝不把一个可疑值 String() 成项目名 —— 那会凭空造出 `<12345>:system` 这种键。
    if (typeof cwd !== 'string') return { project: null, isSystemRoot: false }
    const dir = cwd.trim()
    if (!dir) return { project: null, isSystemRoot: false }
    const base = path.basename(dir)
    const project = !base || base === '.' || base === path.sep ? null : base.toLowerCase()
    let isSystemRoot = false
    try {
      isSystemRoot = fs.existsSync(path.join(dir, SYSTEM_ROOT_MARKER))
    } catch {
      isSystemRoot = false
    }
    return { project, isSystemRoot }
  } catch {
    return { project: null, isSystemRoot: false }
  }
}
