/**
 * dsh-domain-bridge — send_to_domain delivery, the persisted inbox queue and the pause-gate reading.
 *
 * Split out of the single-file lib/bridge.js in v0.6.3 (pure move: no behaviour change).
 * The package entry point stays lib/bridge.js, which re-exports this module.
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLUGIN, TRACE_ID, TRACE_ID_V041, TRACE_ID_V042, loadIndex, shortId, describe, liveTopLevel, dutyMap, stateDirs, queueScopeOf, inboxFileFor, isSessionIdLike, messageOf } from './shared.js'
import { warn, tool } from './tools.js'
// 唯一名 tmp + rename 重试的写盘通道：**复用 registrations.js 的那一份**（勿在本模块另写一套）。
// 固定名 `<file>.tmp` 在两进程并发重写同一队列时会静默丢写（审计 P1-02 已复现）。
// withDomainsLock：同一个模块里的跨进程 `.lock` 通道，本模块把它改名成 withFileLock 复用（见下）。
import { writeAtomicUnique, withDomainsLock } from './registrations.js'
import { pausedScopesOf, pausedScopesWords, pausedTargetOf, primaryPauseHit, pausedFactsOf, pausedSendHint } from './pause.js'
import { loadDeclarations, readOwnersBook, resolveTarget } from './declaration.js'
import { offlineCandidateId, resolveWakeWiring, resumeSession } from './session-factory.js'

export const INBOX_PENDING = 'pending'
export const INBOX_DELIVERED = 'delivered'
export const INBOX_FAILED = 'failed'
export const INBOX_WITHDRAWN = 'withdrawn'

/**
 * 跨进程 `.lock` 通道（读-改-写用）。**与 registrations.js:171-238 同一份实现，不复制**：
 * `withDomainsLock(domainsFile, fn)` 的语义本来就只是"给一个文件路径，按 `<file>.lock` 用 `wx`
 * 独占（已存在必 EEXIST）+ 锁内 pid 判死接管 + `finally` 释放"，与"域名册"无关，所以这里只做
 * 一次改名导出（照抄 65 行锁逻辑会分叉——同源注释挡不住分叉）。
 *
 * 契约（与 withDomainsLock 逐字相同）：回 `{ok, value, reason, error}`，**永不抛**；
 * `fn` 抛错 ⇒ `{ok:false, reason:'function-threw'}`，锁照样在 finally 释放。
 * **不可重入**：同一进程对同一个文件嵌套取锁会等到超时（15 次 × 20ms ⇒ `reason:'locked'`），
 * 所以处理函数体内**绝不允许**再取同一把锁（见 updateInboxStatus / writeDomainStateAtomic）。
 * 遗留：竞争告警文案沿用 registrations.js 的「域名册锁」字样（同一个函数；改文案要动
 * registrations.js，本次任务不允许）。
 */
export function withFileLock(file, fn) {
  let locked = withDomainsLock(file, fn)
  // Windows 实测补丁：`wx` 撞上"对方**刚**删掉的那把锁"时报 EPERM/EACCES，而 registrations.js 的
  // lockContention() 只在"此刻还看得见锁文件"时才算争用 ⇒ 极小概率把一次正常争用误判成
  // `lock-failed`（2×20 条队列实测遇到 1/40：EPERM … open '<inbox>.lock'）。这里只对**这一类
  // 瞬时 IO 错**做有界重试（≤3 次 × 25ms）；锁的实现/语义仍是 registrations.js 那一份，没有第二套。
  for (let attempt = 0; attempt < 3 && !locked.ok && locked.reason === 'lock-failed' && transientLockError(locked.error); attempt++) {
    sleepMs(25)
    locked = withDomainsLock(file, fn)
  }
  return locked
}

/** 只认 Windows 上"抢锁时目录项正在变"这一类瞬时错误（EPERM/EACCES/EBUSY）；别的错照实回。 */
function transientLockError(error) {
  return /EPERM|EACCES|EBUSY/i.test(String(error ?? ''))
}

/** 同步小睡（不烧 CPU）：与 registrations.js 的 sleepSync 同款，只有几行，不构成第二套锁。 */
function sleepMs(ms) {
  if (!(ms > 0)) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* 兜底忙等：正常路径不会走到这里 */
    }
  }
}

/** JSONL read: one object per line; a broken line is skipped, never fatal. */
export function readInboxLines(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { records: [], existed: false, error: error && error.code === 'ENOENT' ? null : error?.message || String(error) }
  }
  const records = []
  let broken = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed)
      else broken++
    } catch {
      broken++
    }
  }
  return { records, existed: true, error: broken ? `${broken} 行读不懂（已跳过）` : null }
}

export function loadInbox(stateDir, key) {
  const file = inboxFileFor(stateDir, key)
  const read = readInboxLines(file)
  const records = read.records.map((record) => ({ ...record, key: record.key ?? String(key) }))
  return {
    file,
    existed: read.existed,
    error: read.error,
    records,
    total: records.length,
    pending: records.filter((record) => record.status === INBOX_PENDING).length,
  }
}

/** Append ONE message line. O_APPEND keeps concurrent enqueues from clobbering each other. */
export function appendInboxRecord(stateDir, key, record) {
  const file = inboxFileFor(stateDir, key)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
    return { ok: true, file, error: null }
  } catch (error) {
    return { ok: false, file, error: messageOf(error) }
  }
}

/**
 * Rewrite the whole queue atomically (status changes only; append stays the hot path).
 * **自己不加锁**：整表替换必须与调用方的"先读"处在同一个临界区里，所以只由
 * `updateInboxStatus()` 在 `withFileLock(<inbox file>)` 内调用。裸调本函数 = 丢更新（已复现）。
 */
export function rewriteInbox(stateDir, key, records) {
  const file = inboxFileFor(stateDir, key)
  const body = records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')
  try {
    // 唯一名 tmp（`<file>.<pid>.<rand>.tmp`）+ rename 重试 ≤10 次 × 10ms：与
    // registrations.js:281-308 的 writeAtomicUnique **同款，勿各写一套**。
    // 旧写法（固定名 `<file>.tmp` + 单次 rename）在并发重写同一队列时会 ENOENT 或
    // 静默覆盖别人的整表（审计 P1-02 已复现）。
    const written = writeAtomicUnique(file, body)
    return { ok: true, file, bytes: written.bytes }
  } catch (error) {
    return { ok: false, file, error: messageOf(error) }
  }
}

/**
 * pending -> delivered|failed|withdrawn, in place. Returns the updated record (or a reason).
 *
 * **锁包住整段 read-modify-write**（load → 改 status → rewrite），锁粒度＝**每个队列文件一把**
 * （`<inbox>.lock`，不搞全局一把锁：多会话互不拖慢）。只锁 rewrite 无效——两个进程各拿一份旧
 * 快照、后写覆盖先写（审计 P1-02 第二半实测：40 条只落到 31，两进程各自都回 ok:20/failed:0）。
 * 拿不到锁 ⇒ 如实回 `reason:'locked'`，**绝不绕过锁裸写**。
 */
export function updateInboxStatus(stateDir, key, id, status, extra) {
  const file = inboxFileFor(stateDir, key)
  const locked = withFileLock(file, () => {
    const inbox = loadInbox(stateDir, key)
    const index = inbox.records.findIndex((record) => record.id === id)
    if (index === -1) return { ok: false, reason: 'not-found', file: inbox.file }
    const before = inbox.records[index]
    const next = { ...before, ...(extra || {}), status }
    inbox.records[index] = next
    const written = rewriteInbox(stateDir, key, inbox.records)
    if (!written.ok) return { ok: false, reason: 'write-failed', error: written.error, file: inbox.file }
    return { ok: true, file: inbox.file, before, record: next }
  })
  if (locked.ok) return locked.value
  return { ok: false, reason: locked.reason === 'locked' ? 'locked' : 'lock-failed', error: locked.error, file }
}

/** Every queue file in the store, keyed by lower-cased domain key (dir read, degrades). */
export function loadInboxes(stateDir) {
  const dir = stateDirs(stateDir).inbox
  const out = { dir, byKey: new Map(), error: null, degraded: [] }
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') out.error = error?.message || String(error)
    return out
  }
  for (const name of names.sort()) {
    if (!String(name).endsWith('.jsonl')) continue
    const read = readInboxLines(path.join(dir, name))
    // 有读不懂的行 ⇒ 如实列出来（降级不静默），但能读的行照样用。
    if (read.error) out.degraded.push({ file: String(name), error: read.error })
    for (const record of read.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue
      const key = typeof record.key === 'string' && record.key ? record.key : null
      if (!key) continue
      const bucket = out.byKey.get(key.toLowerCase()) || []
      bucket.push(record)
      out.byKey.set(key.toLowerCase(), bucket)
    }
  }
  return out
}

/**
 * 一条被暂停拦下的消息 → 队列记录。**冻结**当时的 mode 与信封正文：恢复重投时逐字重放，
 * 不在恢复那一刻重新组信封（否则接收方看到的正文会随当天的措辞漂移）。
 * ⚠️ `content` 存的是**完整信封**（domainEnvelope 的产物），`source.kind` 由 domainMessage()
 *    在重投时重新组装为本插件名——**绝不是 'plugin'**（那会让接收方下一轮直接失败）。
 */
export function queuedRecord({ self, key, mode, envelope, text, replyTo, at, pausedByScopes }) {
  return {
    id: randomUUID(),
    at: at ?? new Date().toISOString(),
    key: String(key ?? ''),
    // v0.4.2：`scope` 记的是**这条队列所属目标自身的 scope**（域键 ⇒ domain；会话 id ⇒ session），
    // **不是**"当初被哪一级拦下"——能不能投只看它目标当下的 OR 判定（与由谁拦下无关）。
    // 当初的拦截级别另存 `pausedByScopes`（纯取证，不参与判定）。
    scope: queueScopeOf(key),
    from: self?.id ?? null,
    mode,
    replyTo: replyTo ?? null,
    content: String(envelope ?? ''),
    message: String(text ?? ''),
    status: INBOX_PENDING,
    pausedByScopes: Array.isArray(pausedByScopes) ? pausedByScopes : [],
    deliveredAt: null,
    failedReason: null,
    withdrawnAt: null,
    withdrawnBy: null,
  }
}

// --- derived state (算出来的；永不落盘) ---

/**
 * 派生状态：**两个轴 + 生命周期**。见 CHANGELOG.md v0.4.0 段。
 * 这是全插件**唯一**一处把两个轴揉成一个对外字符串的地方——拦截判定、list 展示、
 * 回执文案都从这里取值，避免"各处各写一套"。
 */
export function domainEnvelope({ self, text, replyKey, mode, label }) {
  const who = self?.id ?? '未知会话'
  const domains = self?.domains?.length ? `（域 ${self.domains.join('/')}）` : ''
  return [
    `【${label} · 来自 ${who}${domains}】`,
    String(text ?? ''),
    '',
    `（投递方式：${PLUGIN} ${mode}｜回复请用 send_to_domain，target=${replyKey}）`,
  ].join('\n')
}

/**
 * Build the outbound v4 user message. The ONLY construction site in this plugin.
 *
 * ⚠️ v4 格式**拒收** `kind:'plugin'`（退役的包装形态）。用它会让**接收方会话**在下一轮
 *    直接失败："format v4 message requires a producer-owned source kind"
 *    （2026-10-10 实测踩到：发送方返回 delivered:true，接收方却连续两轮"本轮运行失败"，
 *     且因拒收发生在追加写入之前 ⇒ 接收方日志里**不留残骸**，事后极难定位）。
 *    v4 接纳规则（dsh-session-format-v3-to-v4 → message-sources.js → source()）：
 *    `kind` 必须是非空字符串、且不等于 'plugin'。这里用自己的生产者名做"直接来源"，
 *    并附结构化发件人，接收方可据此分辨"会话投的"与"人敲的"。
 * ⚠️ 必须交一条**完整的 v4 用户消息**：`id` + `role` + `content` + `source`，四个都要。
 *    官方入口（dsh-api-session-controller）是 `createUserMessage({content, source})`，
 *    来源 `@deepseek-ai/dsh-llm`：`{...input, role:'user', id: randomUUID()}` 再 deepFreeze。
 *    ⚠️ v0.1.1 只传了 `{content, source}` ⇒ **延期损坏**：当场能跑（内存里的消息不校验），
 *    但只要该会话被**重新加载**（重启 dsh / 重开窗口），核心 `adoptSessionEvent`
 *    就会拒收整条会话：「session event at seq N lacks an identified message」，
 *    表现为**会话打不开**（2026-10-10 实测污染 2 个会话：cc70bb51 seq 949/1019、
 *    817a3969 seq 42；2026-10-11 已按本形状修复这两个存档）。
 *    不 import `createUserMessage`：静态包新增顶层 import 一旦解析失败会让**宿主起不来**
 *    （体系 P15 红线：apply 抛错会让加载器硬失败）；改用 `node:crypto` 自造 id，产物与它逐字段一致。
 */
export function domainMessage({ self, envelope }) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: envelope }],
    source: { kind: PLUGIN, senderSessionId: self?.id ?? null },
  }
}

// --------------------------------------------------------------- delivery (single exit)

/**
 * 唯一的投递出口：send_to_domain 与 v0.3.6 的「停机通知」都走这里，**不另造一套**。
 * `mode` 三选一（其余一律按 followup 处理，与 v0.3.3 的 else 分支一致）：
 *   steer  = 插到最近 step 边界（会唤醒）
 *   inject = 只塞上下文，不唤醒、不跑模型、零成本
 *   followup = 排一条普通下一轮 prompt 并唤醒
 * payload 必须是 domainMessage() 造出的**完整 v4 用户消息**（形状警示见 domainMessage 的注释）。
 * 本函数**不吞异常**：send_to_domain 的抛错行为与 v0.3.3 逐字一致；需要降级的调用方自己包 try。
 */
export function deliverToAgent(agent, mode, payload) {
  if (mode === 'steer') {
    if (typeof agent?.steer !== 'function') return { ok: false, reason: 'steer-unsupported' }
    agent.steer(payload)
    return { ok: true, reason: null }
  }
  if (mode === 'inject') {
    if (typeof agent?.inject !== 'function') return { ok: false, reason: 'inject-unsupported' }
    agent.inject(payload)
    return { ok: true, reason: null }
  }
  if (typeof agent?.followup !== 'function') return { ok: false, reason: 'followup-unsupported' }
  agent.followup(payload)
  return { ok: true, reason: null }
}

// ------------------------------------------- v0.4.0 resume: replay the queue of a paused domain

/**
 * 恢复（`set_domain_state(state='active')`）时把队列里 pending 的消息按**原 mode** 重新投递。
 *
 * 三条硬规矩：
 *  ① **唤醒是"允许尝试"，不是"绝不碰"**（v0.4.1 改）：目标没有活 Agent 时先**尝试**拉活，
 *     但拉活必须**带接线**（`resolveWakeWiring` + `resumeSession`）。v0.4.0 之所以写成"绝不 resume"，
 *     是因为当时裸 resume（只有 `{resumeSessionId}`）拉起来的会话跑回合 100ms 内就崩
 *     （`prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`）——
 *     那是**权宜之计**，v0.4.1 把接线补上后改成：**人显式调 active 时允许尝试唤醒**；
 *     唤不起来（没接线 / resume 失败 / 拉起来也没有 Agent）⇒ 消息**保留 pending** 并如实回报。
 *     ⚠️ 这不改变「暂停的域不会被**别人**自动叫醒」：只有人显式把域设回 `active` 才走这条。
 *  ② 信封用的是**入队时冻结**的那一份，v4 形状统一由 domainMessage() 组装（source.kind 是本插件名，
 *     绝不是 'plugin'）；投递出口复用 deliverToAgent()，不另造一套。
 *  ③ 每条只落一次状态：成功 ⇒ delivered；没有对应方法/抛错 ⇒ failed（带原因）；离线 ⇒ 保持 pending。
 */
export const RESOLVE_FAILURE_HINTS = {
  'missing-target': 'target 必填：域（asr / misas:asr）或会话 id（sess-xxxxxxxx 或完整 id）。',
  'ambiguous-session-id': '这个 id 片段命中多个在线会话，本工具不猜：请改用**完整** session id 再发一次。',
  'multiple-online-for-domain':
    '同一域有多个在线会话：按体系口径这是违规状态，请人工裁决（并回一个负责人），本工具不擅自挑一个。',
  unreachable: '该域/会话当前没有在线窗口（离线不排队）。可先用 list_domain_sessions 看谁在线。',
}

export function buildSendTool(ctx, config) {
  return tool(
    'send_to_domain',
    '把一条消息**投递**给一个在线会话。target 填**域**（如 asr）或**会话 id**（sess-xxxxxxxx 或完整 id）。解析顺序：① 会话 id 直接寻址；② **在任声明优先**——该域有声明且声明会话在线就投给它（matchedBy="declaration"）；③ 命中声明但声明会话离线 ⇒ **不投递**，reason="declared-owner-offline"，回报声明人 + 索引标注为该域且在线的人，由调用者决定；④ 该域没有声明 ⇒ 退回索引标注（matchedBy="index-label"，并提示补声明）；⑤ 索引标注有多个在线 ⇒ 报警，不擅自挑一个。默认 mode="followup"：等于往对方窗口里放一条普通消息，会唤醒对方开一轮；对方正在跑时用 mode="steer" 做中途纠偏；mode="inject" 只塞上下文不唤醒（**＝入队：不跑回合；对方要等到"下一次有人用到它"的那一轮才会看到**）。**目标离线不排队、明确报不可达**；要走通离线目标必须显式传 wake，且 **wake 只认完整 session id（短号 sess-xxxxxxxx 拉不活）**。dryRun=true 只解析与回报，不真投递。wake（v0.3.4 起，**默认关**＝保持「离线不排队」）：wake 传 probe 只把目标从「存档里有、但没加载」拉活并回报结果，**不投递任何消息、不跑任何一轮**（用于真机验证）；wake 传 true **已启用（v0.3.6）**＝先拉活再投，**投下去之后发生什么取决于 mode**：mode=inject ⇒ **零成本入队**（进对方 inbox、**不跑回合**，等它下一次有人用到的那一轮才被读到，可能一直没人读）；mode=followup/steer ⇒ **真唤醒并跑一轮**（有成本、当场就动）。只有显式传 wake 才生效。⚠️ **入队不持久**：未读的 inject 消息在 **dsh 退出/重启时会被整体取消**（2026-10-12 真机：三个不同会话的待读注入在同一秒全部 `canceled`、当时没有任何 turn 启动）⇒ 要保证对方真的处理，请用 `mode=followup`。⚠️⚠️ **v0.4.1 起这个坑已修（`{{model}}` 唤醒 bug）**：v0.3.4~v0.4.0 拉活时**裸传** `{resumeSessionId}`，拉起来的会话 `agent.options.model` 是 `undefined`，而 deployment persona 段写着 `{{model}}` ⇒ `turn/start` 后 **100 ms 内** `turn/end{kind:"error"}`、什么都没干。现在拉活会把接线一起接好：**provider/model 分级取源**（① 宿主全局默认模型 `ctx.agentDefaultModel.currentSelection()` ⇒ ② 该会话存档里最近一条 `request/header` 的 config ⇒ ③ 都没有就**不传、绝不猜**），并 best-effort 装 `setup`（模型选择 + 把该会话的 agentPreset 挂回去）。**回执如实报明用了哪条路**：`wakeWiring:{agentOptions:"ctx.agentDefaultModel"|"session-header"|"none", setup:"applied"|"skipped"|"failed", setupError}`（`wake:"probe"` 也带这个字段，用来预览"真拉活会用哪条路"）。**取不到接线时绝不裸拉**：要真跑回合的档（`followup`/`steer`，即 mode≠`inject`）**一律拒绝拉活**，回 `reason:"no-wake-wiring"` + hint 指替代路（`create_domain_session`，或让人在 GUI 点开那条会话）；`mode:"inject"` 不跑回合、`wake:"probe"` 只探测，两者不受这道安全门影响。这道安全门**不看 `force`**（`force` 放行的是「暂停」这条政策，不是它）。`probe` 档本来就不跑回合，所以以前也发现不了那个坑。注意：重启后「列表里有」≠「在线」，只有被「用到」的会话才有活 Agent。**v0.4.0 起「已暂停」｜v0.4.2 推广到四级**：暂停是**政策轴**（人给、可逆），`set_domain_state` 支持 `scope` 取 domain / session（主＝单会话暂停）/ project / global——域级键＝`项目:域`（**要求已有在任声明**），会话级键＝完整会话 id，项目级键＝项目名小写，全局＝唯一键 `*`（按/解都要 `confirm:true` 防误触）。判定是 **OR 叠加**：任一级被按下就拦，回执给出**全部**命中级别（`pausedScopes` / `pausedByScopes`）；**两端都查**（接收端：目标域键 / 目标会话 / 目标会话的项目 / global；发送端：本会话 / 本会话的项目 / global），**刻意不含**「本会话自己持有的域被暂停」。暂停**不改在任身份**（声明册里 sessionId 一个字节不动）。暂停期间本工具**不投递、也不替你找人顶上**：消息**落到插件自己的落盘队列**（`<stateDir>/inbox/<key>.jsonl`，一行一条，dsh 重启不丢；**入队键＝被投递目标自身的键**——目标是域就落域键、是会话 id 就落会话键），回执明说「被谁在何时按下 ＋ 已入队（可撤回）」，`reason=domain-paused`、`queued=true`（**绝不会**再笼统报 `unreachable`，也**绝不会**静默降级换人）。`wake` 也一并被拦（`wakeBlocked=domain-paused`：把已按下的目标拉活正是暂停要禁止的事）。要撤回：`withdraw_domain_message(id=…)`；要恢复：`set_domain_state(scope=…, domain=…, state=active)`——恢复时**重新评估 OR**：只重投「现在不再被任何一级压着」的 pending，仍被别的级压着的**保持 pending** 并如实报（`drain.stillPausedBy`）。真要越过暂停：传 `force=true`（回执带 `pausedOverride`，暂停状态本身不变；这道 force **不看**拉活接线那道安全门）。**边界**：插件只管插件介导的路径——人自己点开那条会话、或宿主自己 resume，插件拦不住，那正是「人工手动唤起」。',
    {
      target: { type: 'string', description: '域（asr / misas:asr / …）或会话 id（sess-xxxxxxxx 或完整 session id）' },
      message: { type: 'string', description: '要投递的正文（纯文本）' },
      mode: { type: 'string', description: 'followup（默认，普通下一轮，会唤醒对方开一轮）| steer（对方正在跑时中途纠偏）| inject（＝入队：不跑回合，消息进对方 inbox，对方"下次有人用到它"的那一轮才读到）' },
      dryRun: { type: 'boolean', description: 'true = 只解析目标并回报，不真投递（默认 false）' },
      wake: { type: 'string', description: "v0.3.4 起可选：'' / 'false' ＝ 不叫醒（默认，保持「离线不排队」）｜'probe' ＝ 只把目标从存档拉活并回报（不投递、不跑模型；真机验证用）｜'true' ＝ **已启用（v0.3.6）**：先拉活再投；**投后行为看 mode**——inject＝零成本入队（不跑回合，对方「下次有人用到它」的那一轮才读到，可能一直没人读），followup/steer＝真唤醒跑一轮（有成本、当场就动）。**v0.4.1**：拉活会带上接线（provider/model 分级取源 + best-effort setup），回执带 `wakeWiring` 说明用的是哪条路；**取不到接线时，会真跑回合的档一律拒绝拉活**（`reason:'no-wake-wiring'`，不会裸拉——裸拉起来 100ms 内就崩），`mode:'inject'` 与 `wake:'probe'` 不受影响。另：**wake 只认完整 session id**，短号拉不活（回 no-wake-candidate）。只有显式传才生效。" },
      replyTo: { type: 'string', description: '可选：希望对方回复时使用的寻址键（默认自动填入本会话 id）' },
      force: { type: 'boolean', description: 'v0.4.0 可选：默认 false。目标被**任一级**（域/主/项目/全局，OR 叠加）按下时，投递会被拦下并**入落盘队列**；显式传 force=true ＝ 明知已暂停仍要放行（照常投递、不入队，wake 也一并放行）。对**未暂停**的目标是个无害的空操作（行为与 v0.3.6 逐字一致）。' },
    },
    async (args, exec) => {
      const index = loadIndex(config.indexFile)
      // ── F-04（鲁棒性审计 2026-10-23）：**所有权敏感路径必须 fail-closed**。
      // 旧行为：域名册读不懂时 loadDeclarations 把它折成"空册" ⇒ 下面的「声明优先」解析退化成
      // matchedBy=index-label（或 unreachable），干跑/真投都照走 —— 等于册子坏了当没人在任。
      // 现在：target 是**域名/项目形态**（要查"谁在任"）⇒ 一律拒绝并说明原因；`sess-…` / `session-…`
      // 形态的 target 直接按会话 id 寻址、不做所有权判断，因此不受这条限制（否则会误伤正常直投）。
      const ownersBook = readOwnersBook(config.domainsFile)
      const wantedTarget = String(args.target ?? '').trim()
      if (!ownersBook.ok && wantedTarget && !isSessionIdLike(wantedTarget)) {
        warn(
          `[${TRACE_ID}] 拒绝投递：域名册读不懂（${ownersBook.file}）：${ownersBook.detail}` +
            ` ⇒ 不做所有权判断，target=${wantedTarget} 按 fail-closed 拒绝。`,
        )
        return {
          delivered: false,
          queued: false,
          ...(args.dryRun === true ? { dryRun: true } : {}),
          reason: 'domains-unreadable',
          detail: ownersBook.detail,
          target: wantedTarget,
          declarationsFile: config.domainsFile,
          self: describe(exec?.agent, index),
          hint:
            '域名册读不懂（' + ownersBook.detail + '）⇒ 本次**不做所有权判断、不投递**（旧行为会在册子坏掉时按索引标注照投，绕过在任声明）。' +
            '请先人工修好 ' + config.domainsFile + ' 再发。文件不存在＝正常空册，不会被这条拦住；按会话 id 直投（sess-… / session-…）也不受影响。',
        }
      }
      const declarations = ownersBook.ok ? ownersBook.book : loadDeclarations(config.domainsFile)
      const duties = dutyMap(declarations)
      const self = describe(exec?.agent, index, duties)

      // ── v0.4.0/v0.4.2：暂停拦截必须发生在**叫醒之前**。wake 的用途是把离线目标拉活，而"已暂停"
      // 的语义正是"不许把它拉活"；写在投递点就等于绕过了这条政策。
      // v0.4.2：这里是**唯一的 OR 判定入口**，而且**两端都查**——接收端（目标域键/目标会话/
      // 目标会话的项目/global）与发送端（本会话/本会话的项目/global）。
      const rowsEarly = liveTopLevel(ctx, index, duties)
      const pauseEval = pausedTargetOf(config, declarations, args.target, { ctx, rows: rowsEarly, self, index })
      const pausedOverride = pauseEval.hits.length > 0 && args.force === true
      const unresolvedNote = pauseEval.unresolved.length ? { unresolved: pauseEval.unresolved } : {}
      // v0.4.2（降级不静默）：状态文件读不懂 ⇒ 不拦，但**必须**把文件名带出来（只在非空时出现，
      // 这样"什么都没坏"的投递回执仍是 v0.3.6 的键集）。
      const unreadableNote = pauseEval.unreadable.length
        ? { unreadableStateFiles: pauseEval.unreadable }
        : {}
      if (pauseEval.hits.length > 0 && !pausedOverride) {
        const pausedRows = rowsEarly
        const queueKey = pauseEval.queueKey
        const inbox = loadInbox(config.stateDir, queueKey)
        const facts = pausedFactsOf({
          config,
          declarations,
          ctx,
          rows: pausedRows,
          evaluated: pauseEval,
          domainKey: pauseEval.domainKey,
          fallbackKey: queueKey,
        })
        const wakeRawEarly = String(args.wake ?? '').trim().toLowerCase()
        const wakeEarly =
          wakeRawEarly === 'probe' ? 'probe' : ['true', 'yes', 'wake', 'on', '1'].includes(wakeRawEarly) ? 'on' : 'off'
        const pausedFacts = {
          scope: facts.scope,
          domain: facts.domain,
          queueKey,
          queueScope: queueScopeOf(queueKey),
          derivedState: facts.derivedState,
          online: facts.online,
          paused: true,
          pausedAt: facts.pausedAt,
          pausedBy: facts.pausedBy,
          pauseNote: facts.pauseNote,
          matchedBy: facts.matchedBy,
          sessionId: facts.sessionId,
          pending: inbox.pending,
          pausedScopes: facts.pausedScopes,
          pausedByScopes: facts.pausedByScopes,
          pausedNotice: facts.pausedNotice,
        }
        warn(
          `[${TRACE_ID_V042}] 拦截投递：target=${String(args.target ?? '')} 被 ${facts.pausedScopes.join('+')} 压着` +
            `（${pausedScopesWords(pauseEval.hits)}）；入队键=${queueKey}，mode=${String(args.mode ?? 'followup')}，` +
            `wake=${wakeEarly} ⇒ 不投递、不找人顶上。`,
        )
        // 探测档：只回答"能不能拉活"。已暂停 ⇒ **不拉**（要拉得显式 force），也不入队（probe 从不投递）。
        if (wakeEarly === 'probe') {
          return {
            delivered: false,
            probe: true,
            queued: false,
            reason: 'domain-paused',
            target: String(args.target ?? ''),
            ...pausedFacts,
            ...unresolvedNote,
          ...unreadableNote,
            wakeBlocked: 'domain-paused',
            // v0.4.1：probe 回执恒带 wakeWiring（这里一个都没接 ⇒ 如实报 none/skipped）。
            wakeWiring: { agentOptions: 'none', setup: 'skipped', setupError: null },
            woke: {
              attempted: false,
              sessionId: null,
              via: 'domain-paused',
              ok: false,
              reason: 'domain-paused',
              error: null,
              ms: 0,
              liveBefore: false,
              liveAfter: false,
              wakeWiring: { agentOptions: 'none', setup: 'skipped', setupError: null },
            },
            onlineTopLevel: pausedRows.map((row) => row.info),
            declarationsFile: config.domainsFile,
            self,
            hint:
              `探测档 + 已暂停：target 被 ${pausedScopesWords(pauseEval.hits)} 压着，` +
              `所以**没有去拉活**——把已被按下的目标拉活正是暂停要禁止的事。要强行拉活：force=true（同时也会照常投递）。`,
          }
        }
        const mode = String(args.mode ?? 'followup').toLowerCase()
        const text = String(args.message ?? '')
        const replyKey = String(args.replyTo ?? self.id ?? '')
        const envelope = domainEnvelope({ self, text, replyKey, mode, label: '域间消息' })
        const record = queuedRecord({
          self,
          key: queueKey,
          mode,
          envelope,
          text,
          replyTo: replyKey,
          pausedByScopes: facts.pausedByScopes,
        })
        if (args.dryRun === true) {
          return {
            delivered: false,
            dryRun: true,
            queued: false,
            reason: 'domain-paused',
            target: String(args.target ?? ''),
            ...pausedFacts,
            ...unresolvedNote,
          ...unreadableNote,
            wakeBlocked: wakeEarly === 'off' ? null : 'domain-paused',
            wouldQueue: {
              key: queueKey,
              scope: queueScopeOf(queueKey),
              domain: facts.domain,
              mode,
              envelope,
              from: self.id ?? null,
              withdrawable: true,
              file: inbox.file,
            },
            declarationsFile: config.domainsFile,
            self,
            hint:
              `演练：**没有投递、也没有写队列**。真跑的话这条消息会以 pending 落进 ${inbox.file}（入队键＝${queueKey}），` +
              `可用 withdraw_domain_message 撤回；恢复要先解开**按着它的每一级**（见 pausedByScopes），` +
              `恢复时会重新评估 OR。`,
          }
        }
        const enqueued = appendInboxRecord(config.stateDir, queueKey, record)
        if (!enqueued.ok) {
          return {
            delivered: false,
            queued: false,
            reason: 'queue-write-failed',
            error: enqueued.error,
            target: String(args.target ?? ''),
            ...pausedFacts,
            ...unresolvedNote,
          ...unreadableNote,
            wakeBlocked: wakeEarly === 'off' ? null : 'domain-paused',
            queueFile: enqueued.file,
            declarationsFile: config.domainsFile,
            self,
            hint:
              `target 已被按下（${pausedScopesWords(pauseEval.hits)}），本该把这条消息落盘入队，` +
              `但**写队列失败**（${enqueued.error}）⇒ 消息**没有入队、也没有投递**。请修好磁盘权限后重试；` +
              `本次什么都没落地，别以为它排上了。`,
          }
        }
        return {
          delivered: false,
          queued: true,
          reason: 'domain-paused',
          target: String(args.target ?? ''),
          ...pausedFacts,
          ...unresolvedNote,
          ...unreadableNote,
          wakeBlocked: wakeEarly === 'off' ? null : 'domain-paused',
          queue: {
            id: record.id,
            at: record.at,
            mode,
            key: queueKey,
            scope: queueScopeOf(queueKey),
            domain: facts.domain,
            status: INBOX_PENDING,
            pending: inbox.pending + 1,
            total: inbox.total + 1,
            file: enqueued.file,
            withdrawable: true,
            withdrawTool: 'withdraw_domain_message',
          },
          declarationsFile: config.domainsFile,
          self,
          hint: pausedSendHint(
            { ...facts, key: facts.domain ?? queueKey, queueKey, pending: inbox.pending + 1, pausedHits: pauseEval.hits },
            record.id,
          ),
        }
      }

      // ── v0.4.0：force=true + 已暂停 ＝ 显式放行。只在此时出现；未暂停的域是空对象
      // （保证「非暂停域行为与 v0.3.6 逐字一致」——连一个键都不多）。
      const overrideNote = pausedOverride
        ? {
            pausedOverride: true,
            pausedOverrideDomain: primaryPauseHit(pauseEval.hits)?.key ?? pauseEval.queueKey,
            pausedOverrideScopes: pausedScopesOf(pauseEval.hits),
            pausedOverrideHint:
              `⚠️ 明知目标被 ${pausedScopesWords(pauseEval.hits)} 压着，你传了 force=true ⇒ 本次按你的意思**放行**` +
              `（照常投递/拉活，**不入队**）。暂停本身没有被解除：要恢复请把**按着它的每一级**都解开` +
              `（见 pausedByScopes；域级＝set_domain_state(domain=…, state='active')，global＝` +
              `set_domain_state(scope='global', state='active', confirm=true)）。`,
          }
        : {}

      // ── v0.3.4：叫醒必须发生在**解析之前**。原因：resolveTarget 只在"在线行"里找目标，
      // 离线会话连"目标"都算不上（直接 unreachable），声明负责人离线也直接
      // declared-owner-offline —— 把叫醒写在投递点等于死代码。
      const wakeRaw = String(args.wake ?? '').trim().toLowerCase()
      const wakeMode = wakeRaw === 'probe' ? 'probe' : ['true', 'yes', 'wake', 'on', '1'].includes(wakeRaw) ? 'on' : 'off'
      // v0.4.1 安全门：只有「真会跑回合」的档才强制要接线（inject 不跑回合、probe 不投递）。
      // mode 的归一化口径与 deliverToAgent 一致：steer=steer、inject=inject、其余一律 followup（跑回合）。
      const modeEarly = String(args.mode ?? 'followup').toLowerCase()
      const wakeRunsTurn = modeEarly !== 'inject'
      // v0.4.2：复用暂停判定那一刻的在线行（同一轮里没有任何东西会改变"谁在线"，
      // 除非下面真的拉活成功——那时会重取）。
      let rows = rowsEarly
      let woke = null
      if (wakeMode !== 'off') {
        const candidate = offlineCandidateId(args.target, declarations)
        if (candidate.id) {
          const wiring = await resolveWakeWiring(ctx, candidate.id)
          woke = await resumeSession(ctx, candidate.id, wiring, {
            requireWiring: wakeMode === 'on' && wakeRunsTurn,
          })
          woke.via = candidate.why
          // 拉活成功才值得重取在线列表（重取本身是只读但会创建对象）。
          if (woke.ok && !woke.liveBefore) rows = liveTopLevel(ctx, index, duties)
        } else {
          woke = {
            attempted: false,
            sessionId: null,
            via: candidate.why,
            ok: false,
            reason: 'no-wake-candidate',
            error: null,
            ms: 0,
            liveBefore: false,
            liveAfter: false,
            wakeWiring: { agentOptions: 'none', setup: 'skipped', setupError: null },
          }
        }
      }

      // ── v0.4.1：要真跑回合、却拼不出 provider/model ⇒ **明确拒绝拉活**，一次 resume 都不调。
      // （`force` 放行的是「暂停」这条政策，不是这道安全门：裸拉起来 100ms 后就崩，放行等于骗人。）
      if (wakeMode === 'on' && woke && woke.reason === 'no-wake-wiring') {
        warn(
          `[${TRACE_ID_V041}] 拒绝拉活：${String(args.target ?? '')} ⇒ 候选=${woke.sessionId}，mode=${modeEarly}，` +
            `接线取源=agentOptions:none；裸 resume 会在 100ms 内崩（{{model}} 无值），所以不拉。`,
        )
        return {
          delivered: false,
          reason: 'no-wake-wiring',
          target: String(args.target ?? ''),
          mode: modeEarly,
          woke,
          wakeWiring: woke.wakeWiring,
          onlineTopLevel: rows.map((row) => row.info),
          declarationsFile: config.domainsFile,
          ...overrideNote,
          ...unresolvedNote,
          ...unreadableNote,
          self,
          hint:
            `**没有拉活**：这次 mode='${modeEarly}' 真会跑回合，而拉活必须先接好 provider/model —— ` +
            `否则裸 resume 起来的会话 100 ms 内就会崩（真机错误一字不差：prompt variable "{{model}}" has no ` +
            `value for this assembly (section "deployment:persona-prefix")）。这次两条取源都是空的：` +
            `① 宿主全局默认模型（ctx.agentDefaultModel.currentSelection）取不到；` +
            `② 该会话存档里也读不到最近一条 request/header 的 config。` +
            `**不能猜一个模型硬按上去** ⇒ 按规矩拒绝（拉起来也是白拉，还会把那条会话搞成"看起来在线、其实跑不动"）。` +
            `仍然可用的两条路：mode='inject'（只入队、不跑回合，可以拉）、wake='probe'（只探测、不投递）。` +
            `要真派活请改用 create_domain_session（宿主建的会话装配完整），或让人在 GUI 点开 ` +
            `${shortId(woke.sessionId) || woke.sessionId || '那条会话'}。`,
        }
      }

      const resolved = resolveTarget(rows, args.target, declarations, ctx, index)

      if (wakeMode === 'probe') {
        // 探测档：只回报"能不能把它从存档拉活"，**不投递任何消息、不跑任何一轮**。
        // v0.4.1：probe **不需要接线**（不跑回合）⇒ 安全门对它不生效；但仍然如实报出
        // `wakeWiring` —— 这正是"真拉活那天会用哪条路"的预览。
        const probeWiring = woke?.wakeWiring ?? { agentOptions: 'none', setup: 'skipped', setupError: null }
        return {
          delivered: false,
          probe: true,
          target: String(args.target ?? ''),
          woke,
          wakeWiring: probeWiring,
          liveAfter: Boolean(woke && woke.liveAfter),
          resolved: resolved.ok ? resolved.row.info : null,
          resolveReason: resolved.ok ? null : resolved.reason,
          onlineTopLevel: rows.map((row) => row.info),
          declarationsFile: config.domainsFile,
          ...overrideNote,
          ...unresolvedNote,
          ...unreadableNote,
          self,
          hint:
            woke && woke.ok
              ? `探测档：已从存档把 ${woke.sessionId} 拉活（**没有投递任何消息、没有跑任何一轮**）。` +
                `接线取源 agentOptions=${probeWiring.agentOptions}、setup=${probeWiring.setup}。` +
                `接着看：它是否出现在 onlineTopLevel 里、它的存档有没有新增 turn（新增＝拉活会自己干活，那样就得改成"拉活后再投"的策略）。`
              : `探测档：没能拉活（${woke ? woke.reason : 'unknown'}${woke && woke.via ? '，判定依据=' + woke.via : ''}）。常见原因：这条不是顶层会话（子代理会话会被核心直接拒：ApiSessionSubagentOwnership）、target 不是完整会话 id（短号无法直接 resume）、或它真的不存在。`,
        }
      }

      if (!resolved.ok) {
        const base = {
          delivered: false,
          reason: resolved.reason,
          ...overrideNote,
          ...unresolvedNote,
          ...unreadableNote,
          self,
        }
        if (resolved.reason === 'declared-owner-offline') {
          return {
            ...base,
            declaredOwner: resolved.declaredOwner,
            otherOnlineWithIndexLabel: resolved.otherOnlineWithIndexLabel,
            onlineTopLevel: resolved.candidates ?? [],
            declarationsFile: config.domainsFile,
            hint:
              '该域的在任声明负责人当前不在线（离线不排队，本工具不替你挑人）。这里只回报「谁在任」+「索引标注恰好是这个域、当前在线的人」：要投给谁由你决定——可用 send_to_domain(target=<会话id>) 直投，或先 claim_domain(force:true) 交接。',
          }
        }
        if (resolved.reason === 'ambiguous-declarations') {
          return {
            ...base,
            declarations: resolved.declarations,
            onlineTopLevel: resolved.candidates ?? [],
            declarationsFile: config.domainsFile,
            hint: '同名域有多条在任声明：请用「项目:域」的完整写法指定是哪一个（本工具不猜）。',
          }
        }
        return {
          ...base,
          onlineTopLevel: resolved.candidates ?? [],
          hint: RESOLVE_FAILURE_HINTS[resolved.reason] ?? null,
        }
      }

      const targetInfo = resolved.row.info
      const text = String(args.message ?? '')
      const replyKey = String(args.replyTo ?? self.id ?? '')
      const mode = String(args.mode ?? 'followup').toLowerCase()
      // Shared builder (v0.3): create_domain_session builds its startup message the same way.
      const envelope = domainEnvelope({ self, text, replyKey, mode, label: '域间消息' })
      const resolution = { matchedBy: resolved.matchedBy }
      if (resolved.declaration) resolution.declaration = resolved.declaration
      if (resolved.hint) resolution.hint = resolved.hint

      if (args.dryRun === true) {
        return {
          delivered: false,
          dryRun: true,
          wouldDeliverTo: targetInfo,
          ...resolution,
          mode,
          ...overrideNote,
          ...unresolvedNote,
          ...unreadableNote,
          self,
          envelope,
        }
      }

      // 竞态兜底：解析时在线、投递那一刻已关。开了叫醒（wake='true'）就再拉一次。
      let agent = ctx?.agents?.get?.(targetInfo.id) ?? null
      let wokeAtDelivery = null
      if (!agent && wakeMode === 'on') {
        // v0.4.1：这条兜底路也要接线（否则同样裸拉 ⇒ 100ms 崩），并且同样过安全门。
        const wiringAtRace = await resolveWakeWiring(ctx, targetInfo.id)
        wokeAtDelivery = await resumeSession(ctx, targetInfo.id, wiringAtRace, { requireWiring: wakeRunsTurn })
        if (wokeAtDelivery.ok) agent = ctx?.agents?.get?.(targetInfo.id) ?? null
      }
      if (!agent) {
        // ⚠️ 没开叫醒时返回体必须与 v0.3.3 逐字一致（`woke` 只在开了叫醒时才出现）。
        return {
          delivered: false,
          reason: 'unreachable-race',
          target: targetInfo,
          ...(wokeAtDelivery ? { woke: wokeAtDelivery } : {}),
          ...overrideNote,
          ...unresolvedNote,
          ...unreadableNote,
          self,
          hint: wokeAtDelivery
            ? wokeAtDelivery.reason === 'no-wake-wiring'
              ? '解析时它还在线，投递那一刻已经没了；本来要拉活，但**拼不出 provider/model**（接线取源 none）⇒ 按规矩没有裸拉（裸拉起来 100 ms 内就崩）。离线不排队：mode=inject 可以拉、或改用 create_domain_session / 让人在 GUI 点开那条会话。'
              : '解析时它还在线，投递那一刻已经没了，再拉一次也没拉起来（原因见 woke）；离线不排队，请重试或换人。'
            : '解析时它还在线，真正投递那一刻窗口已关（竞态）；离线不排队，请重试或换人。',
        }
      }

      // Shape lives in exactly one place - see the v4 warnings on domainMessage().
      const payload = domainMessage({ self, envelope })

      // v0.3.6: 投递出口抽成共享 helper（deliverToAgent），停机通知走同一个 inject 分支。
      const attempt = deliverToAgent(agent, mode, payload)
      if (!attempt.ok) {
        return {
          delivered: false,
          reason: attempt.reason,
          target: targetInfo,
          ...overrideNote,
          ...unresolvedNote,
          ...unreadableNote,
          self,
        }
      }

      return {
        delivered: true,
        mode,
        ...resolution,
        target: targetInfo,
        // v0.4.1: 只在这一轮**真的拉过活**（liveBefore=false 且成功）时才多这个键 ——
        // 目标本来就在线时，回执与 v0.3.6 逐字一致（一个键都不多）。
        ...(woke && woke.attempted && !woke.liveBefore ? { woke } : {}),
        ...(wokeAtDelivery ? { wokeAtDelivery } : {}),
        ...overrideNote,
        ...unresolvedNote,
          ...unreadableNote,
        self,
        note: '已接受进对方 inbox（本调用只返回"已送达"，不会返回对方的回复；对方会另发一条消息回来）。',
      }
    },
  )
}

// ── v0.3.3 helpers: 标题 + 权限档（两个服务都按 v0.3.2 的同一套契约取用：不注入、调用时解析、
//    缺失即降级、永不抛错。依据见 CHANGELOG.md v0.3.3 段）。
