/**
 * dsh-domain-bridge — create_domain_session, wake wiring and the three model-dispatch tools.
 *
 * Split out of the single-file lib/bridge.js in v0.6.3 (pure move: no behaviour change).
 * The package entry point stays lib/bridge.js, which re-exports this module.
 */

import fs from 'node:fs'
import path from 'node:path'
import { TRACE_ID, TRACE_ID_V042, TRACE_ID_V061, loadIndex, emptyIndex, shortId, describe, liveTopLevel, dutyMap, textOf, normalizeModelConfig, ownerCliRef, isFullSessionId, messageOf, dirLabelOf } from './shared.js'
import { warn, tool } from './tools.js'
import { loadInbox, domainEnvelope, domainMessage } from './messaging.js'
import { pausedScopesWords, pausedTargetOf, pausedFactsOf, pausedCreateHint } from './pause.js'
import { loadDeclarations, declarationInfo, splitDomainTarget, projectFromCwd, matchDeclaration, labelMatches, declareNewOwner, existingOwnerInfo, domainAlreadyOwnedHint, domainOwnedOverrideHint } from './declaration.js'
import { readRegistrations, upsertRegistration } from './registrations.js'

export function getSessionController(ctx) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined
    if (viaGet && typeof viaGet.create === 'function') return viaGet
  } catch {
    /* fall through to the property read */
  }
  try {
    const direct = ctx?.sessionController
    if (direct && typeof direct.create === 'function') return direct
  } catch {
    /* treat as unavailable */
  }
  return null
}

/**
 * Optional lookup of the host Workspace registry. Exactly the same contract as
 * getSessionController: NEVER hard-injected (a deployment without the service must still load),
 * resolved at call time, and a missing service degrades into an honest report.
 *
 * Evidence (dsh 0.2.0-rc.2 source, read-only):
 *   - dsh-tool-cordis/lib/types/api-catalog.js:3616 key:'workspaceRegistry' - same catalog that
 *     already lists sessionController (:1838); pinSession signature at :3669, resolveByPath at
 *     :3681.
 *   - dsh-workspace/lib/index.js:576-587 pinSession(sessionId): Promise<void> (idempotent,
 *     durable, rejects an archived or unknown session).
 *   - dsh-workspace/lib/index.js:635-638 async resolveByPath(path): Promise<Workspace|undefined>
 *     (pure read: a missing path rejects during realpath, an unowned directory returns undefined).
 * Precedent in this very profile: dsh-mnemon/lib/index.js:10142-10147 resolves it at call time
 * through `ctx.get("workspaceRegistry")` and never throws when it is absent.
 */
export function getWorkspaceRegistry(ctx) {
  const usable = (service) =>
    Boolean(service) &&
    (typeof service.pinSession === 'function' ||
      typeof service.resolveByPath === 'function' ||
      typeof service.list === 'function')
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (usable(viaGet)) return viaGet
  } catch {
    /* fall through to the property read */
  }
  try {
    const direct = ctx?.workspaceRegistry
    if (usable(direct)) return direct
  } catch {
    /* treat as unavailable */
  }
  return null
}

/**
 * Find the Workspace that ALREADY owns this directory. Pure read - this never calls
 * workspaceRegistry.create(), because a new workspace is prepended to the user's durable group
 * order and we are not allowed to invent a project group out of a cwd.
 *
 * `lookup` is a stable token the caller reports verbatim:
 *   resolved-by-path | resolved-from-list | no-workspace-for-path | resolve-failed |
 *   workspaceRegistry-unavailable
 */
export async function findWorkspaceFor(ctx, cwd) {
  const registry = getWorkspaceRegistry(ctx)
  if (!registry) {
    return { registry: null, workspace: null, lookup: 'workspaceRegistry-unavailable', lookupError: null }
  }
  try {
    if (typeof registry.resolveByPath === 'function') {
      const hit = await registry.resolveByPath(cwd)
      return {
        registry,
        workspace: hit || null,
        lookup: hit ? 'resolved-by-path' : 'no-workspace-for-path',
        lookupError: null,
      }
    }
    // Fallback for a build without resolveByPath: match the canonical path against list().
    let want
    try {
      want =
        typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(cwd) : fs.realpathSync(cwd)
    } catch {
      want = path.resolve(cwd)
    }
    const rows = typeof registry.list === 'function' ? registry.list() : []
    const hit = (Array.isArray(rows) ? rows : []).find((row) => row && String(row.path) === want) || null
    return {
      registry,
      workspace: hit,
      lookup: hit ? 'resolved-from-list' : 'no-workspace-for-path',
      lookupError: null,
    }
  } catch (error) {
    return { registry, workspace: null, lookup: 'resolve-failed', lookupError: messageOf(error) }
  }
}

/**
 * Tell apart the two halves of `sessionController.create()` when it throws.
 *
 * create() runs agents.ensureSession() first and workspace.attachSession() second
 * (dsh-api-session-controller/lib/index.js:697 then :701-708). The attach half throws
 * RemoteError("session/workspace-attach-failed", ...) carrying {sessionId, workspaceId} - and by
 * then the session ALREADY EXISTS. So the normal "workspaceId failed => retry with cwd" degrade
 * must NOT fire here: retrying would leave a second, orphan session behind. Detect the marker and
 * hand back whatever identity the host reported so the caller keeps the session, skips the retry
 * and reports "created but not grouped".
 *
 * Discrimination is by `code`, never by instanceof (dsh-typert-protocol/lib/types/remote-error.js:7):
 * RemoteError carries {code, details, isDSHRemoteError}. The message test is a last-resort
 * fallback for a realm that only preserved the text.
 */
export function attachFailureOf(error) {
  try {
    const code = typeof error?.code === 'string' ? error.code : ''
    const message = messageOf(error)
    const marked = code === 'session/workspace-attach-failed' || /\/workspace-attach-failed$/.test(code)
    if (!marked && !/was created but could not attach to workspace/.test(message)) return null
    const fromDetails =
      typeof error?.details?.sessionId === 'string' && error.details.sessionId ? error.details.sessionId : ''
    const fromMessage = (message.match(/session "([^"]+)" was created/) || [])[1] || ''
    return {
      sessionId: fromDetails || fromMessage || null,
      code: code || 'session/workspace-attach-failed',
      error: message,
    }
  } catch {
    return null
  }
}

/** Last path segment of a directory, for the "type it in the sidebar search box" fallback. */
export const TITLE_MAX_BYTES = 80
export const RETIRED_PREFIX = '（已退役）'
/** 「关掉这一步」的统一写法（工具参数 / 配置都认这几个词）。 */
export const OFF_SWITCHES = ['none', 'keep', 'skip']

export function offSwitch(value) {
  const text = value === undefined || value === null ? '' : String(value).trim()
  return text === '' || OFF_SWITCHES.includes(text.toLowerCase())
}

export function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/** 压成标题能用的单行：换行折成空格、连续空白压成一个，再按字节预算截断（不切开多字节字符）。 */
export function clipToBytes(text, maxBytes) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!(maxBytes > 0)) return ''
  let out = ''
  let used = 0
  for (const ch of flat) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return out
}

/** 本地时间戳 `2026-10-12 23:30`（不带秒：80 字节的标题里每一字节都要花在信息上）。 */
export function minuteStamp(date) {
  const two = (n) => String(n).padStart(2, '0')
  return (
    date.getFullYear() +
    '-' +
    two(date.getMonth() + 1) +
    '-' +
    two(date.getDate()) +
    ' ' +
    two(date.getHours()) +
    ':' +
    two(date.getMinutes())
  )
}

/** 形如 `[docs] 2026-10-12 23:30 · 一句话简介`：时间戳前置，简介吃剩下的字节预算。 */
export function domainSessionTitle(domain, summary, date) {
  const prefix = '[' + String(domain ?? '域') + '] ' + minuteStamp(date) + ' · '
  const budget = TITLE_MAX_BYTES - utf8Bytes(prefix)
  return prefix + clipToBytes(summary, budget > 4 ? budget : 0)
}

/** 主会话层的标题：`【体系】2026-10-20 23:30 · 一句话` / `【项目】…`（不写成域的 `[system]` 形状）。 */
export function mainLayerTitle(layer, summary, date) {
  const prefix = (layer === 'system' ? '【体系】' : '【项目】') + minuteStamp(date) + ' · '
  const budget = TITLE_MAX_BYTES - utf8Bytes(prefix)
  return prefix + clipToBytes(summary, budget > 4 ? budget : 0)
}

/** 退役/交接用的标题：标记**前置**，原标题被顶到后面（真被裁也是裁尾巴）。 */
export function retiredTitle(existing) {
  const base = clipToBytes(existing, TITLE_MAX_BYTES)
  return clipToBytes(RETIRED_PREFIX + (base ? ' ' + base : ''), TITLE_MAX_BYTES)
}

/** 从 Agent 取它背后的 Session 对象：rename/set 这些服务要的是 Session，不是 sessionId。 */
export function sessionOf(agent) {
  try {
    const session = agent?.session
    return session && typeof session === 'object' ? session : null
  } catch {
    return null
  }
}

/** 把目标解析成「仍 live 的 Agent」：给 Agent 直接用，给 id 就查（查不到 / 窗口已关 ＝ null）。 */
export function liveAgentOf(ctx, target) {
  if (target && sessionOf(target)) return target
  if (typeof target === 'string' && target) {
    try {
      const agent = ctx?.agents?.get?.(target) ?? null
      return sessionOf(agent) ? agent : null
    } catch {
      return null
    }
  }
  return null
}

/** 可选：权限档服务。契约同 getSessionController —— 不注入、调用时解析、缺失即降级。 */
export function getPermissionPresets(ctx) {
  const usable = (service) =>
    Boolean(service) && typeof service.set === 'function' && typeof service.resolve === 'function'
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('permissionPresets') : undefined
    if (usable(viaGet)) return viaGet
  } catch {
    /* fall through to the property read */
  }
  try {
    const direct = ctx?.permissionPresets
    if (usable(direct)) return direct
  } catch {
    /* treat as unavailable */
  }
  return null
}

/** 可选：标题服务（rename 要求目标会话仍 live；调用点必须兜住它的抛错，本函数只管取服务）。 */
export function getSessionTitle(ctx) {
  const usable = (service) => Boolean(service) && typeof service.rename === 'function'
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get('sessionTitle') : undefined
    if (usable(viaGet)) return viaGet
  } catch {
    /* fall through to the property read */
  }
  try {
    const direct = ctx?.sessionTitle
    if (usable(direct)) return direct
  } catch {
    /* treat as unavailable */
  }
  return null
}

/**
 * 把某个**仍 live** 的会话标题标成「（已退役）」。硬限制：sessionTitle.rename 要求会话仍 live
 * （api-catalog.js:2409），窗口已关或 dsh 重启过就改不了 ⇒ 如实回报，**绝不为了改个标题去
 * resume/唤醒一个会话**。标记前置，超 80 字节时被裁的是尾部。本函数永不抛错。
 */
export function markRetired(ctx, target, trigger) {
  const out = { attempted: true, trigger: trigger ?? null }
  try {
    const agent = liveAgentOf(ctx, target)
    const session = sessionOf(agent)
    if (!session) {
      return {
        ...out,
        ok: false,
        reason: 'not-live',
        hint: '会话不在线（窗口已关 / dsh 重启过），不为了改标题把它唤醒。',
      }
    }
    const titles = getSessionTitle(ctx)
    if (!titles) return { ...out, ok: false, reason: 'sessionTitle-unavailable' }
    let existing = ''
    try {
      const snapshot = typeof titles.get === 'function' ? titles.get(session) : null
      existing = snapshot && typeof snapshot.title === 'string' ? snapshot.title : ''
    } catch {
      existing = ''
    }
    if (existing.includes(RETIRED_PREFIX)) {
      return { ...out, ok: true, skipped: 'already-retired', title: existing }
    }
    const next = retiredTitle(existing)
    titles.rename(session, next)
    return { ...out, ok: true, previousTitle: existing || null, title: next }
  } catch (error) {
    return { ...out, ok: false, reason: 'rename-failed', error: messageOf(error) }
  }
}

/**
 * 找出"调用者其实想投、但它现在没有活 Agent"的那个会话 id（只给叫醒用）。
 * 只在这两种情况下给 id，其余一律 null —— 叫醒不做任何猜测：
 *   ① target 命中**唯一一条在任声明** ⇒ 用声明里的 sessionId（活不活都行，resumeSession 自己会判
 *      already-live）；② target 本身就是**完整会话 id**（`session-<uuid>` 或裸 uuid）⇒ 原样返回。
 * ⚠️ 短号（sess-xxxxxxxx）**不能**直接 resume：`sessionController.resume` 要完整 id，喂短号会抛
 *    ApiSessionNotFound。这里**故意不猜、也不去索引里反查前缀**（避免猜错把别的会话拉起来）。
 */
export function offlineCandidateId(rawTarget, declarations) {
  const target = String(rawTarget ?? '').trim()
  if (!target) return { id: null, why: 'missing-target' }
  const colon = target.indexOf(':')
  const domainPart = (colon === -1 ? target : target.slice(colon + 1)).trim()
  const declared = matchDeclaration(declarations, target, domainPart)
  if (declared.status === 'declared') return { id: declared.entry.sessionId || null, why: 'declaration' }
  if (declared.status === 'ambiguous') return { id: null, why: 'ambiguous-declarations' }
  if (/^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) {
    return { id: target, why: 'session-id' }
  }
  return { id: null, why: 'not-a-full-session-id' }
}

// --------------------------------------------------- v0.4.1 wake wiring (the {{model}} fix)

/**
 * 可选取用一个宿主服务。与 getSessionController / getWorkspaceRegistry 同一套契约：
 * **不注入**、调用时解析、`ctx.get(name)` 优先、属性读取兜底、拿不到就是 null（绝不抛）。
 * `usable` 是「这个服务真的能用吗」的判据（判据必须是 `typeof x.method === 'function'`，
 * 不是"源码里有这个方法"——v0.3.5 的教训）。
 */
export function optionalService(ctx, name, usable) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    if (usable(viaGet)) return viaGet
  } catch {
    /* fall through to the property read */
  }
  try {
    const direct = ctx?.[name]
    if (usable(direct)) return direct
  } catch {
    /* treat as unavailable */
  }
  return null
}

/** 存档读取服务（`ctx.sessionQuery.readSession(id)` → `{session, inheritedEventCount, events}`）。 */
export function getSessionQuery(ctx) {
  return optionalService(ctx, 'sessionQuery', (service) => Boolean(service) && typeof service.readSession === 'function')
}

/** agent preset 服务（宿主在 resume 前就是用它 `resolve` + `mount` 把 preset 挂回去的）。 */
export function getAgentPresets(ctx) {
  return optionalService(ctx, 'agentPresets', (service) => Boolean(service) && typeof service.mount === 'function')
}

/**
 * 从**存档**里读这次拉活需要的两样东西（只读、永不抛）：
 *   - `config`：最近一条 `request/header` 事件的 `data.header.config`（provider/model[/reasoningEffort]）。
 *     形状依据：agent-loop 写事件时是 `session.append("request/header", {header, reason})`
 *     （dsh-agent-loop/lib/index.js:1214-1228，header 由 canonicalHeader() 造），而宿主的
 *     `modelSelection` 投影就是从 `event.data.header.config` 里取 provider/model 的
 *     （dsh-api-session-controller/lib/index.js:2077-2082）——同一处取值，不另造口径。
 *   - `presetId`：存档 header 的 `agentPreset`（SessionHeader 的公开可选字段）。
 * 读不到（服务没挂 / 会话不存在 / 读失败）⇒ 一律 `source:'none'`，**不是错误**。
 */
export async function archivedWakeSources(ctx, sessionId) {
  const out = { config: null, presetId: null, source: 'none', error: null }
  const query = getSessionQuery(ctx)
  if (!query) return out
  try {
    const read = await query.readSession(sessionId)
    const events = Array.isArray(read?.events) ? read.events : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'request/header') continue
      const config = event?.data?.header?.config
      if (config && config.provider && config.model) {
        out.config = {
          provider: String(config.provider),
          model: String(config.model),
          // 用 `in` 判断而不是 `!== undefined`：这里只搬事实，不替它决定"要不要带 effort"。
          ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        }
        out.source = 'session-header'
      }
      break
    }
    const preset = read?.session?.agentPreset
    if (typeof preset === 'string' && preset.trim()) out.presetId = preset.trim()
  } catch (error) {
    out.error = messageOf(error)
  }
  return out
}

/**
 * 解析一次「拉活接线」。**分级取源，取不到就不传，绝不猜**：
 *   - `agentOptions`（必需的那半）：① `ctx.agentDefaultModel.currentSelection()` ⇒
 *     ② 存档里最近一条 `request/header` 的 config ⇒ ③ 空（`source:'none'`）。
 *   - `selection`（`setup` 里装的那半）：**② 优先于 ①** —— 与宿主的 `selectionFor()` 对齐
 *     （api-session-controller:286-298：pending → 上次请求头 → 默认选择）。这样"该会话自己上次用的
 *     模型"赢过"全局默认模型"，不会因为拉活而静默换模型。
 *   - `presetId`：存档 header 的 `agentPreset`（挂回 preset 用）。
 * 全部失败方向都是 `null`/`'none'`——本函数**永不抛错**。
 */
export async function resolveWakeWiring(ctx, sessionId) {
  let defaultSelection = null
  try {
    const picked = ctx?.agentDefaultModel?.currentSelection?.()
    if (picked && picked.provider && picked.model) {
      defaultSelection = {
        provider: String(picked.provider),
        model: String(picked.model),
        ...(picked.reasoningEffort === undefined ? {} : { reasoningEffort: picked.reasoningEffort }),
      }
    }
  } catch {
    defaultSelection = null
  }
  const archived = await archivedWakeSources(ctx, sessionId)
  const wiring = {
    agentOptions: null,
    agentOptionsSource: 'none',
    selection: archived.config ?? defaultSelection,
    presetId: archived.presetId,
    archiveError: archived.error,
  }
  if (defaultSelection) {
    wiring.agentOptions = { provider: defaultSelection.provider, model: defaultSelection.model }
    wiring.agentOptionsSource = 'ctx.agentDefaultModel'
  } else if (archived.config) {
    wiring.agentOptions = { provider: archived.config.provider, model: archived.config.model }
    wiring.agentOptionsSource = 'session-header'
  }
  return wiring
}

/**
 * 复刻宿主 `installModelSelection` 的两条 waterfall（dsh-agent/lib/index.js:166-192）——
 * 只用**公开的** `agentCtx.on`，不 import 核心内部（静态包新增 import 一旦解析失败是在模块加载期抛，
 * 兜不住）。它管两件事：① 系统提示组装时把 `provider`/`model` 两个变量补上（`{{model}}` 的兜底）；
 * ② 请求路由时用选中的 provider/model 覆盖。
 * 与宿主版本的差别（刻意简化）：不装第三条 `agent/pre-step` 的「换模型通知」
 * 持久事件，也不用 assembled 快照——我们的 selection 在会话存活期内是常量，不存在并发切换。
 */
export function installWakeSelection(agentCtx, selection) {
  agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection
    const assembled = await next()
    if (selected === null || selected === undefined) return assembled
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    }
  })
  agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    if (selection === null || selection === undefined) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  })
}

/**
 * 造 `resume` 的 `setup`（best-effort，**整段 try/catch，失败只记不抛**）：
 *   ① 装模型选择（`installWakeSelection`）；② 把该会话的 preset 挂回去（`resolve` 再 `mount`）。
 * 没有可挂的东西 ⇒ 返回 `null`（回执报 `setup:'skipped'`，绝不让宿主白跑一次空回调）。
 * 抛错 ⇒ 回执报 `setup:'failed'` + `setupError`，**resume 本身照常成立**（agentOptions 那半已经够
 * 把 100ms 崩溃解掉；这一步只是"装配更完整"）。
 */
export function buildWakeSetup(ctx, wiring, setupState) {
  const wantsSelection = Boolean(wiring?.selection)
  const wantsPreset = Boolean(wiring?.presetId)
  if (!wantsSelection && !wantsPreset) return null
  return async (agentCtx) => {
    try {
      if (wantsSelection && agentCtx && typeof agentCtx.on === 'function') {
        installWakeSelection(agentCtx, wiring.selection)
        setupState.selection = true
      }
      const presets = getAgentPresets(ctx)
      if (wantsPreset && presets) {
        let presetId = wiring.presetId
        if (typeof presets.resolve === 'function') {
          const resolved = await presets.resolve(presetId)
          if (resolved && resolved.id) presetId = resolved.id
        }
        await presets.mount(agentCtx, presetId)
        setupState.preset = true
      }
      setupState.status = 'applied'
    } catch (error) {
      setupState.status = 'failed'
      setupState.error = messageOf(error)
    }
  }
}

/**
 * 把一条**已存在但当前没有活 Agent** 的会话从存档里拉起来（= GUI 里"点一下才活"的那个动作）。
 *
 * 依据（dsh 0.2.0-rc.2 只读实测）：
 *   - `ctx.sessionController.resume(sessionId)`（dsh-api-session-controller/lib/index.js:377-398）：
 *     不给第二个参数时它会 `sessionQuery.observeSession(sessionId)` 读存档、再 `resumeObserved`
 *     重新组装 Agent（:399-402，要求 header.cwd 存在）；**子代理会话会被拒**
 *     （hasApiSessionSubagentOwner ⇒ ApiSessionSubagentOwnership，:401）；会话不存在抛
 *     ApiSessionNotFound（:395）；同一会话的并发 resume 有去重（:226）。
 * ⚠️ resume 只构造 Agent，**不会自己跑一轮**；但它会不会顺带处理 inbox 里堆着的待办，需要真机确认
 *     —— 探测档就是为这一条存在的。本函数只管拉活，永不抛错。
 *
 * **v0.4.1（关键）**：`wiring`（`resolveWakeWiring` 的结果）里的 `agentOptions`/`selection`/`presetId`
 *   必须一起传下去——v0.4.0 及以前这里是**裸传 `{resumeSessionId}`**，于是拉起来的会话
 *   `agent.options.model` 是 `undefined`、persona 段里的 `{{model}}` 没值 ⇒ `turn/start` 后 100ms 内
 *   `turn/end{kind:'error'}`。`gate.requireWiring=true`（＝"这次真会跑回合"）而接线又取不到时，
 *   **本函数直接拒绝拉活**（`reason:'no-wake-wiring'`，一次 `resume` 都不调）：拉起来也是 100ms 后崩，
 *   比明确不拉更糟。回执里的 `wakeWiring` 如实报「用的哪条取源 + setup 走到哪一步」。
 */
export async function resumeSession(ctx, sessionId, wiring, gate) {
  const started = Date.now()
  const setupState = { status: 'skipped', error: null, selection: false, preset: false }
  const out = {
    attempted: true,
    sessionId: sessionId ?? null,
    ok: false,
    reason: null,
    error: null,
    api: null,
    controllerFound: null,
    ms: 0,
    liveBefore: false,
    liveAfter: false,
    wakeWiring: null,
  }
  // 语义：`agentOptions` = provider/model 是**从哪条取源**来的（none = 两条都空）；
  //       `setup` = 我们真的传了那个 setup 回调、它又走到哪一步（applied/skipped/failed）。
  const wiringReceipt = () => ({
    agentOptions: wiring?.agentOptionsSource ?? 'none',
    setup: setupState.status,
    setupError: setupState.error,
  })
  if (!sessionId) {
    out.reason = 'missing-session-id'
    out.wakeWiring = wiringReceipt()
    return out
  }
  try {
    try {
      out.liveBefore = Boolean(ctx?.agents?.get?.(sessionId))
    } catch {
      out.liveBefore = false
    }
    if (out.liveBefore) {
      out.ok = true
      out.reason = 'already-live'
    } else if (!wiring?.agentOptions && gate?.requireWiring) {
      // ── v0.4.1 安全门：这次真会跑回合，可我们拼不出 provider/model ⇒ **一次都不拉**。
      out.reason = 'no-wake-wiring'
    } else {
      // ⚠️ v0.3.5 更正入口：**`ctx.agents.resume({resumeSessionId})` 才是插件这一侧可用的那个**。
      // 2026-10-12 真机探测实测：v0.3.4 用的 `sessionController.resume(sessionId)` 在插件侧**不存在**
      //（`getSessionController()` 拿到的是 `create` 可用的那个 façade，`typeof resume !== 'function'`
      // ⇒ 探测回 `resume-unsupported`）。权威依据：
      //   - api-catalog.js:196-200 `agents.resume(options: ResumeAgentOptions)`＝"Load a persisted
      //     session and resume an agent on it through the registered factory"；
      //   - ResumeAgentOptions（:6191-6192）＝ `{resumeSessionId, parentAgent?, agentOptions?, signal?, setup?}`；
      //   - 真机范本 dsh-acp/lib/index.js:714-723：`ctx.agents.resume({ resumeSessionId, agentOptions, signal, setup })`
      //     —— v0.4.0 以前这里注释写的是"不传也能拉起来"，**那句是错的**（真机 100ms 崩，见 CHANGELOG.md v0.4.1）。
      // 旧的 `sessionController.resume` 保留作第二候选（别的构建可能暴露），失败时如实回报是哪个入口。
      const agents = ctx?.agents
      if (agents && typeof agents.resume === 'function') {
        const request = { resumeSessionId: sessionId }
        if (wiring?.agentOptions) request.agentOptions = { ...wiring.agentOptions }
        const setup = buildWakeSetup(ctx, wiring, setupState)
        if (setup) request.setup = setup
        await agents.resume(request)
        out.ok = true
        out.api = 'agents.resume'
      } else {
        const controller = getSessionController(ctx)
        out.controllerFound = Boolean(controller)
        if (controller && typeof controller.resume === 'function') {
          // 这条入口**收不下** agentOptions/setup（它的签名只有 sessionId）⇒ 要跑回合时一样拒绝，
          // 不然就是"从另一个门裸拉活"，同样 100ms 崩。
          if (gate?.requireWiring) {
            out.reason = 'no-wake-wiring'
          } else {
            await controller.resume(sessionId)
            out.ok = true
            out.api = 'sessionController.resume'
          }
        } else {
          // 两个入口都不存在：**不要含糊其辞**——直接说"这台机器上没有能叫醒会话的 API"。
          out.reason = 'no-resume-api'
        }
      }
    }
  } catch (error) {
    out.ok = false
    out.reason = 'resume-failed'
    out.error = messageOf(error)
  }
  try {
    out.liveAfter = Boolean(ctx?.agents?.get?.(sessionId))
  } catch {
    out.liveAfter = false
  }
  if (out.ok && !out.liveAfter) {
    out.ok = false
    out.reason = 'resumed-but-no-agent'
  }
  out.ms = Date.now() - started
  out.wakeWiring = wiringReceipt()
  return out
}

export function modelSelectionOf(value) {
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

/** Optional service with selectModel (the model-dispatch half of sessionController). */
export function getModelDispatchService(ctx) {
  return optionalService(ctx, 'sessionController', (service) => Boolean(service) && typeof service.selectModel === 'function')
}

/** Optional service with modelCatalog (preferred catalog source). */
export function getModelCatalogService(ctx) {
  return optionalService(ctx, 'sessionController', (service) => Boolean(service) && typeof service.modelCatalog === 'function')
}

/** Optional host global default model (read before selectModel, restored afterwards). */
export function getDefaultModelService(ctx) {
  return optionalService(
    ctx,
    'agentDefaultModel',
    (service) =>
      Boolean(service) &&
      (typeof service.currentSelection === 'function' || typeof service.saveSelection === 'function'),
  )
}

/** Optional session projections service (the `stateOf` reader; it needs a live Session OBJECT). */
export function getSessionProjections(ctx) {
  return optionalService(ctx, 'sessionProjections', (service) => Boolean(service) && typeof service.stateOf === 'function')
}

/** v0.6.1: optional per-session projection reader that takes a session ID (archived sessions included). */
export function getSessionProjectionsById(ctx) {
  return optionalService(ctx, 'sessionController', (service) => Boolean(service) && typeof service.projections === 'function')
}

/** v0.6.1: optional live-Session registry (`ctx.sessions.get(id)` - the host reads it the same way). */
export function getLiveSessions(ctx) {
  return optionalService(ctx, 'sessions', (service) => Boolean(service) && typeof service.get === 'function')
}

/** v0.6.1: the live Session OBJECT for a session id (ctx.sessions first, then the live Agent). Never throws. */
export function liveSessionObject(ctx, sessionId) {
  const id = textOf(sessionId)
  if (!id) return null
  const sessions = getLiveSessions(ctx)
  if (sessions) {
    try {
      const session = sessions.get(id)
      if (session && typeof session === 'object') return session
    } catch {
      /* fall through to the agent path */
    }
  }
  try {
    const agent = ctx?.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(id) : undefined
    const session = agent?.session
    if (session && typeof session === 'object') return session
  } catch {
    /* no live Session object for this id */
  }
  return null
}

/** Is `current` already the same choice we are about to apply (provider+model, optional effort)? */
export function sameModelChoice(current, wanted) {
  try {
    if (!current || typeof current !== 'object') return false
    if (textOf(current.provider) !== textOf(wanted.provider)) return false
    if (textOf(current.model) !== textOf(wanted.model)) return false
    const effort = textOf(wanted.reasoningEffort)
    return !effort || textOf(current.reasoningEffort) === effort
  } catch {
    return false
  }
}

/**
 * v0.6.1: strict equality of two normalized selections (`{provider, model, reasoningEffort?}`), used
 * to check what `saveSelection` actually left behind. Unlike `sameModelChoice` an ABSENT
 * reasoningEffort must match an absent one - a read-back with an extra effort is NOT the same write.
 */
export function exactModelChoice(left, right) {
  if (!left || !right) return false
  return (
    textOf(left.provider) === textOf(right.provider) &&
    textOf(left.model) === textOf(right.model) &&
    (textOf(left.reasoningEffort) || null) === (textOf(right.reasoningEffort) || null)
  )
}

/** Read the host global default once; a throw degrades to "no previous selection". */
export function currentGlobalDefault(defaults) {
  if (!defaults || typeof defaults.currentSelection !== 'function') return { raw: null, error: null }
  try {
    return { raw: defaults.currentSelection() ?? null, error: null }
  } catch (error) {
    return { raw: null, error: messageOf(error) }
  }
}

/**
 * The ONE implementation behind set_model and create_domain_session:
 *   record global default → selectModel → restore global default (only when it really differs).
 * Never throws. On host failure the host's own code (`session/writer-held`, ...) is preserved in
 * `reason`; the restore is still attempted and reported honestly in globalDefault.
 */
export async function applySessionModel(ctx, sessionId, wanted) {
  const provider = textOf(wanted?.provider)
  const model = textOf(wanted?.model)
  const reasoningEffort = textOf(wanted?.reasoningEffort)
  const out = {
    ok: false,
    sessionId: sessionId ?? null,
    applied: null,
    previous: null,
    globalDefault: { before: null, after: null, restored: false },
  }
  const dispatch = getModelDispatchService(ctx)
  if (!dispatch) {
    out.reason = 'api-unavailable'
    return out
  }
  if (!provider || !model) {
    out.reason = 'invalid-model'
    return out
  }
  const defaults = getDefaultModelService(ctx)
  const before = currentGlobalDefault(defaults)
  out.previous = modelSelectionOf(before.raw)
  out.globalDefault.before = out.previous
  if (before.error) out.globalDefault.beforeError = before.error

  const request = { sessionId, provider, model }
  if (reasoningEffort) request.reasoningEffort = reasoningEffort
  try {
    await dispatch.selectModel(request)
    out.ok = true
    out.applied = 'next-request'
  } catch (error) {
    // Keep the host failure code verbatim (`session/writer-held`, `session/not-found`, ...).
    out.reason = typeof error?.code === 'string' && error.code ? error.code : messageOf(error)
    out.error = messageOf(error)
  }

  // selectModel's background side effect (saveSelection of the new choice) is undone here.
  const mustRestore = Boolean(before.raw) && !sameModelChoice(before.raw, { provider, model, reasoningEffort })
  const chosen = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
  if (!mustRestore) {
    out.globalDefault.after = out.previous
    out.globalDefault.afterSource = before.raw ? 'unchanged' : 'no-previous'
  } else if (!defaults || typeof defaults.saveSelection !== 'function') {
    out.globalDefault.after = chosen
    out.globalDefault.afterSource = 'assumed-selected'
    out.globalDefault.error = before.error || 'agentDefaultModel-unavailable'
  } else {
    try {
      await defaults.saveSelection(before.raw)
      out.globalDefault.restored = true
      out.globalDefault.after = out.previous
      out.globalDefault.afterSource = 'restored-previous'
    } catch (error) {
      // Never pretend the restore worked: selectModel most likely left the choice as global default.
      out.globalDefault.after = chosen
      out.globalDefault.afterSource = 'assumed-selected'
      out.globalDefault.error = messageOf(error)
    }
  }
  return out
}

/**
 * Resolve a set_model / list_models target to ONE session id: full session id | short/partial
 * session id (live rows) | declaration key (owner session, online or not) | index label.
 * Read-only and never guesses between candidates.
 */
export function resolveModelSessionTarget(ctx, config, rawTarget) {
  const target = textOf(rawTarget)
  if (!target) return { ok: false, reason: 'missing-target' }
  if (isFullSessionId(target)) return { ok: true, sessionId: target, matchedBy: 'session-id', target }

  const index = loadIndex(config.indexFile)
  const declarations = loadDeclarations(config.domainsFile)
  const duties = dutyMap(declarations)
  let rows = []
  try {
    rows = liveTopLevel(ctx, index, duties)
  } catch {
    rows = []
  }
  const colon = target.indexOf(':')
  const domainPart = (colon === -1 ? target : target.slice(colon + 1)).trim()
  const declared = matchDeclaration(declarations, target, domainPart)
  if (declared.status === 'ambiguous') {
    return {
      ok: false,
      reason: 'ambiguous-declarations',
      declarations: declared.entries.map((entry) => declarationInfo(entry, declarations)),
    }
  }
  if (declared.status === 'declared') {
    const info = declarationInfo(declared.entry, declarations)
    if (!info.sessionId) return { ok: false, reason: 'declaration-without-session', declaration: info }
    return {
      ok: true,
      sessionId: info.sessionId,
      matchedBy: 'declaration',
      target: info.key ?? target,
      declaration: info,
      online: rows.some((row) => row.info.id === info.sessionId),
    }
  }

  const needle = target.toLowerCase()
  const byId = rows.filter((row) => {
    const id = String(row.info.id ?? '').toLowerCase()
    const short = String(row.info.shortId ?? '').toLowerCase()
    return (id && (id === needle || id.includes(needle))) || (short && short === needle)
  })
  if (byId.length === 1) return { ok: true, sessionId: byId[0].info.id, matchedBy: 'session-id', target }
  if (byId.length > 1) {
    return { ok: false, reason: 'ambiguous-session-id', candidates: byId.map((row) => row.info) }
  }

  const byDomain = rows.filter((row) => labelMatches(row, domainPart, target))
  if (byDomain.length === 1) {
    return {
      ok: true,
      sessionId: byDomain[0].info.id,
      matchedBy: 'index-label',
      target,
      hint: '该域无在任声明，本次按索引标注解析，建议补声明（claim_domain）。',
    }
  }
  if (byDomain.length > 1) {
    return { ok: false, reason: 'multiple-online-for-domain', candidates: byDomain.map((row) => row.info) }
  }
  return {
    ok: false,
    reason: 'target-unresolved',
    candidates: rows.map((row) => row.info),
    hint:
      `「${target}」既不是完整会话 id，也没有命中在任声明 / 在线会话。` +
      `可写会话 id（session-<uuid> / sess-xxxxxxxx）或域键（项目:域 / 短名）。`,
  }
}

/** Array|map|single object -> [{id, name}] without inventing providers; junk entries are skipped. */
export function normalizeProviderRows(raw) {
  const list = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.providers)
      ? raw.providers
      : raw && typeof raw === 'object' && (raw.id || raw.name)
        ? [raw]
        : raw && typeof raw === 'object'
          ? Object.values(raw)
          : []
  const out = []
  for (const item of list) {
    if (typeof item === 'string') {
      const id = textOf(item)
      if (id) out.push({ id, name: id })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const id = textOf(item.id) || textOf(item.provider) || textOf(item.name)
    if (!id) continue
    out.push({ id, name: textOf(item.name) || id })
  }
  return out
}

/** Array|{models}|single model -> [{id, name, reasoning?}] preserving a JSON-safe reasoning flag. */
export function normalizeModelRows(raw) {
  const list = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.models)
      ? raw.models
      : raw && typeof raw === 'object' && (raw.id || raw.model || raw.name)
        ? [raw]
        : []
  const out = []
  for (const item of list) {
    if (typeof item === 'string') {
      const id = textOf(item)
      if (id) out.push({ id, name: id })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const id = textOf(item.id) || textOf(item.model) || textOf(item.name)
    if (!id) continue
    const row = { id, name: textOf(item.name) || id }
    if (item.reasoning !== undefined && item.reasoning !== null) {
      row.reasoning =
        typeof item.reasoning === 'boolean' || typeof item.reasoning === 'string'
          ? item.reasoning
          : Boolean(item.reasoning)
    }
    out.push(row)
  }
  return out
}

/** "object" / "array" / "promise" / "null" / "string" ... - only for the diagnostic trail. */
export function rawShapeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value && typeof value === 'object') return typeof value.then === 'function' ? 'promise' : 'object'
  return typeof value
}

/** One diagnostic line per catalog source attempt (pruned: the whole receipt must stay JSON-safe). */
export function catalogAttempt(attempts, source, state, extra) {
  const entry = { source, state }
  const note = textOf(extra)
  if (note) entry.note = note
  attempts.push(entry)
}

/**
 * Preferred source: `await ctx.sessionController.modelCatalog()`. v0.6.1 fixes the two things the
 * first real-machine run exposed:
 *   - it is ASYNC (`lib/index.js:3121` → `lib/types/catalog.js:10 buildModelCatalog`), so v0.6.0
 *     read a bare Promise and always reported `groups: []` / `routableProviders: null`;
 *   - an empty/unrecognized `groups` is NOT a usable catalog: `null` is returned so the caller can
 *     fall back to ctx.llm. A recognized-but-empty return still carries its `rawKeys` for diagnosis.
 */
export async function catalogFromController(ctx, attempts) {
  const source = 'sessionController.modelCatalog'
  const service = getModelCatalogService(ctx)
  if (!service) {
    catalogAttempt(attempts, source, 'no-service')
    return null
  }
  let raw
  try {
    raw = await service.modelCatalog()
  } catch (error) {
    catalogAttempt(attempts, source, 'threw', messageOf(error))
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    catalogAttempt(attempts, source, 'shape', rawShapeOf(raw))
    return null
  }
  const rawKeys = Object.keys(raw)
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).map((group, index) => {
    const provider = textOf(group?.id) || textOf(group?.provider) || `group-${index + 1}`
    return {
      provider,
      name: textOf(group?.name) || provider,
      models: normalizeModelRows(group?.models),
    }
  })
  const failures = Array.isArray(raw.failures) ? raw.failures : null
  if (groups.length === 0) {
    catalogAttempt(attempts, source, 'empty-groups', `rawKeys=${rawKeys.join(',') || '(none)'}`)
    return {
      source,
      default: modelSelectionOf(raw.default),
      routableProviders: Array.isArray(raw.routableProviders) ? raw.routableProviders : null,
      groups: [],
      failures,
      rawKeys,
      empty: true,
    }
  }
  catalogAttempt(attempts, source, 'ok', `rawKeys=${rawKeys.join(',') || '(none)'}`)
  return {
    source,
    default: modelSelectionOf(raw.default),
    routableProviders: Array.isArray(raw.routableProviders)
      ? raw.routableProviders
      : groups.map((group) => group.provider),
    groups,
    failures,
    rawKeys,
    empty: false,
  }
}

/**
 * Fallback catalog: ctx.llm.listProviders() + listModels(provider), assembled exactly the way the
 * host's own buildModelCatalog does it (`catalog.js:11/14`) - including dropping providers that
 * expose no model at all. `listProviders()` is synchronous in the host and `listModels` is awaited;
 * both are accepted either way, and a model row may be `{id,name,reasoning?}` or a bare string.
 */
export async function catalogFromLlm(ctx, attempts) {
  const source = 'llm'
  const llm = optionalService(ctx, 'llm', (service) => Boolean(service) && typeof service.listProviders === 'function')
  if (!llm) {
    catalogAttempt(attempts, source, 'no-service')
    return null
  }
  try {
    const providers = normalizeProviderRows(await llm.listProviders())
    const groups = []
    const skipped = []
    for (const provider of providers) {
      let rawModels = []
      if (typeof llm.listModels === 'function') {
        try {
          rawModels = await llm.listModels(provider.id)
        } catch {
          rawModels = []
        }
      }
      const models = normalizeModelRows(rawModels)
      if (models.length === 0) {
        skipped.push(provider.id)
        continue
      }
      groups.push({ provider: provider.id, name: provider.name, models })
    }
    catalogAttempt(
      attempts,
      source,
      groups.length === 0 ? 'empty-groups' : 'ok',
      `providers=${providers.map((provider) => provider.id).join(',') || '(none)'}` +
        (skipped.length ? `;no-models=${skipped.join(',')}` : ''),
    )
    return {
      source,
      default: null,
      routableProviders: groups.map((group) => group.provider),
      groups,
      failures: null,
      rawKeys: providers.map((provider) => provider.id),
      empty: groups.length === 0,
    }
  } catch (error) {
    catalogAttempt(attempts, source, 'threw', messageOf(error))
    return null
  }
}

/**
 * The `session` half of list_models. v0.6.1 reads the REAL host interfaces, in order of reach:
 *   ① `ctx.sessionController.projections({sessionId}, signal)` (`lib/index.js:3280`,
 *      `@Remote('projections')` at `:2698`) → `{kind:'sequenced', asOfSeq, values}`, where
 *      `values.modelSelection` is the wire view `{lastUsed, next}` (`next` = pending ?? lastUsed).
 *      This takes a session ID and works for archived sessions too.
 *   ② the live Session OBJECT (`ctx.sessions.get(id)` - `lib/index.js:3323`; or
 *      `ctx.agents.get(id).session` - `lib/index.js:366`) + `ctx.sessionProjections.stateOf(session,
 *      'modelSelection')` → the host state `{lastUsed, pending}`. v0.6.0 passed the ID STRING here,
 *      which always threw: stateOf needs `session.header` / `session.snapshotEvents()`.
 * A resolution / read failure never turns list_models into an error - it comes back as `read`
 * (reported by the caller as `sessionRead`), so the failure mode is visible instead of silent.
 */
export async function sessionModelState(ctx, config, rawSession) {
  const target = textOf(rawSession)
  if (!target) return null
  const resolved = resolveModelSessionTarget(ctx, config, target)
  if (!resolved.ok || !resolved.sessionId) {
    return {
      read: {
        target,
        ok: false,
        reason: textOf(resolved.reason) || 'target-unresolved',
        tried: [],
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      },
    }
  }
  const sessionId = resolved.sessionId
  const tried = []
  const failures = []

  // ① by-id projections: live AND archived sessions, no live Session object needed.
  const byId = getSessionProjectionsById(ctx)
  if (byId) {
    tried.push('sessionController.projections')
    const signal = typeof AbortController === 'function' ? new AbortController().signal : undefined
    if (!signal) {
      failures.push({ source: 'sessionController.projections', reason: 'no-abort-signal' })
    } else {
      try {
        const raw = await byId.projections({ sessionId }, signal)
        const wire = raw?.values?.modelSelection
        if (wire && typeof wire === 'object' && !Array.isArray(wire)) {
          return {
            session: {
              target: sessionId,
              matchedBy: resolved.matchedBy,
              lastUsed: modelSelectionOf(wire.lastUsed),
              // The wire view's `next` is the host's `pending ?? lastUsed`.
              pending: modelSelectionOf(wire.next),
              source: 'sessionController.projections',
              kind: raw.kind === 'migration-required' ? 'migration-required' : 'sequenced',
              ...(Number.isFinite(raw.asOfSeq) ? { asOfSeq: raw.asOfSeq } : {}),
            },
          }
        }
        failures.push({
          source: 'sessionController.projections',
          reason: raw === null ? 'session-not-found' : `no-modelSelection:${rawShapeOf(raw?.values?.modelSelection)}`,
        })
      } catch (error) {
        failures.push({ source: 'sessionController.projections', reason: messageOf(error) })
      }
    }
  }

  // ② a live Session object + the host projection registry.
  const projections = getSessionProjections(ctx)
  if (projections) {
    const session = liveSessionObject(ctx, sessionId)
    if (!session) {
      failures.push({ source: 'sessionProjections.stateOf', reason: 'no-live-session' })
    } else {
      tried.push('sessionProjections.stateOf')
      try {
        const state = projections.stateOf(session, 'modelSelection')
        if (state && typeof state === 'object' && !Array.isArray(state)) {
          const envelope =
            Object.prototype.hasOwnProperty.call(state, 'lastUsed') ||
            Object.prototype.hasOwnProperty.call(state, 'pending')
          return {
            session: {
              target: sessionId,
              matchedBy: resolved.matchedBy,
              lastUsed: modelSelectionOf(envelope ? state.lastUsed : state),
              pending: envelope ? modelSelectionOf(state.pending) : null,
              source: 'sessionProjections.stateOf',
            },
          }
        }
        failures.push({ source: 'sessionProjections.stateOf', reason: 'no-state' })
      } catch (error) {
        failures.push({ source: 'sessionProjections.stateOf', reason: messageOf(error) })
      }
    }
  }

  return {
    read: {
      target: sessionId,
      matchedBy: resolved.matchedBy,
      ok: false,
      reason: 'projection-unavailable',
      tried,
      ...(failures.length ? { failures } : {}),
    },
  }
}

export function buildListModelsTool(ctx, config) {
  return tool(
    'list_models',
    '**列出宿主当前可路由的模型目录**（v0.6.1 模型分派）。首选 `await ctx.sessionController.modelCatalog()`（**它是 async**；v0.6.1 修掉了 v0.6.0 少 await 导致 groups 恒空的 bug）；**groups 为空（或形状不认识）就退 `ctx.llm.listProviders()` + `listModels(provider)`**；两个来源都空 ⇒ 如实回 `{ok:true, source:"empty", groups:[], rawKeys:[…], note:"catalog-empty"}`（**不假装有内容**，rawKeys/attempts 供诊断）。`source` 如实写实际用了哪个来源（`sessionController.modelCatalog` / `llm` / `empty`）。可选 `session`：会话 id（`session-…` / `sess-…`）或域键（`项目:域` / 短名）——给了就额外读该会话的 `modelSelection` 投影（① `sessionController.projections({sessionId}, signal)`，活会话与存档会话都能读；② 退路＝活 Session 对象 + `sessionProjections.stateOf(session,"modelSelection")`），回执带 `session:{target,lastUsed,pending,source}`（`source:"sessionController.projections"` 那条路的 `pending` 是宿主 wire 视图的 `next`＝`pending ?? lastUsed`）；读不到就**不给 `session`**、改成如实报 `sessionRead:{ok:false,reason,tried,failures?}`，不报错。纯读：不改任何会话、不改全局默认。',
    {
      session: {
        type: 'string',
        description: '可选：想看它当前模型选择的会话 id（session-… / sess-…，可短号）或域键（项目:域 / 短名）。不给＝只列目录。',
      },
    },
    async (args, exec) => {
      try {
        const self = describe(exec?.agent, emptyIndex())
        const attempts = []
        const controller = await catalogFromController(ctx, attempts)
        let catalog = controller && !controller.empty ? controller : null
        if (!catalog) {
          const fallback = await catalogFromLlm(ctx, attempts)
          if (fallback && !fallback.empty) catalog = fallback
        }
        const defaults = getDefaultModelService(ctx)
        const globalDefault = modelSelectionOf(currentGlobalDefault(defaults).raw)
        const state = await sessionModelState(ctx, config, args.session)
        const sessionFields = {
          ...(state?.session ? { session: state.session } : {}),
          ...(state?.read ? { sessionRead: state.read } : {}),
        }
        // One source is the normal case; more than one means a fallback happened and the trail is
        // worth showing. Either way the empty case always carries it (that is its whole point).
        const rawKeys = controller?.rawKeys ?? []
        const showTrail = attempts.length > 1 || !catalog
        const diagnostic = showTrail ? { rawKeys, attempts } : {}
        if (!catalog) {
          return {
            ok: true,
            source: 'empty',
            default: globalDefault,
            routableProviders: null,
            groups: [],
            ...diagnostic,
            note: 'catalog-empty',
            ...sessionFields,
            self,
            hint:
              '两个目录来源都没给出可用分组：`sessionController.modelCatalog()` ' +
              '(rawKeys=' +
              (rawKeys.join(',') || '(none)') +
              ') 与 `llm.listProviders()`/`listModels()`（看 attempts 里每一步的 state）。' +
              '没有读到任何目录、也没有改任何模型。',
          }
        }
        return {
          ok: true,
          source: catalog.source,
          default: catalog.default || globalDefault,
          routableProviders: catalog.routableProviders,
          groups: catalog.groups,
          ...diagnostic,
          ...(catalog.failures && catalog.failures.length ? { failures: catalog.failures } : {}),
          ...sessionFields,
          self,
        }
      } catch (error) {
        return { ok: false, reason: 'unexpected-error', error: messageOf(error) }
      }
    },
  )
}

export function buildSetModelTool(ctx, config) {
  return tool(
    'set_model',
    '**改某个会话的模型（下一轮请求生效；跑着的 step 不换）**（v0.6.0 模型分派）。`target` 缺省＝调用者自己（拿不到调用者会话就报错要求显式传）；`target` 可写会话 id（`session-…` / `sess-…`）或域键（`项目:域` / 短名 ⇒ 走域名册解析成负责人会话）。执行顺序固定：**先记下宿主全局默认 → `selectModel` → 把全局默认恢复成刚记下的值**（`selectModel` 的副作用是在后台把这个选择写成全局默认）。回执如实写 `{ok, sessionId, target, applied:"next-request", previous, globalDefault:{before, after, restored}}`；恢复失败也照写 `restored:false` + 错误原因，绝不假装成功。传了 `reasoningEffort` 才一起传（不发明默认值）。`selectModel` 抛错时把宿主失败码原样带回（如 `session/writer-held`）。**子代理没有独立模型**（继承父会话实时路由），这里改不了它；本工具能改的只有会话级选择。宿主没有 `selectModel` ⇒ `{ok:false, reason:"api-unavailable"}`，不抛错。**目标是调用者自己时必须显式传 `allowSelf: true`**（否则回 `{ok:false, reason:"self-target-needs-allowSelf"}` 且一次服务都不调用）——改自己的模型会打断前缀缓存、让上下文重算，代价高，不默认允许。',
    {
      target: {
        type: 'string',
        description: '可选：会话 id（session-… / sess-…，可短号）或域键（项目:域 / 短名，解析到负责人会话）。不给＝调用者自己。',
      },
      provider: { type: 'string', description: '必填：provider id（见 list_models 的 groups[].provider）。' },
      model: { type: 'string', description: '必填：model id（见 list_models 的 groups[].models[].id）。' },
      reasoningEffort: { type: 'string', description: '可选：原样透传给 selectModel；不给就不传（不发明默认值）。' },
      allowSelf: {
        type: 'boolean',
        description:
          '可选，默认 false。当解析出来的目标是**调用者自己**时必须显式传 true 才放行——改自己的模型会打断前缀缓存、让上下文重算，属于高代价操作，不默认允许。',
      },
    },
    async (args, exec) => {
      try {
        const self = describe(exec?.agent, emptyIndex())
        const provider = textOf(args.provider)
        const model = textOf(args.model)
        const reasoningEffort = textOf(args.reasoningEffort)
        const requested = { provider, model, reasoningEffort: reasoningEffort || null }
        if (!provider || !model) {
          return {
            ok: false,
            reason: 'invalid-model',
            requested,
            self,
            hint: 'provider 与 model 都必填（都是非空字符串）。先用 list_models 看可用目录。',
          }
        }
        const rawTarget = textOf(args.target)
        let sessionId
        let targetLabel
        let matchedBy
        if (!rawTarget) {
          sessionId = self.id ?? null
          targetLabel = sessionId
          matchedBy = 'caller'
          if (!sessionId) {
            return {
              ok: false,
              reason: 'target-unknown',
              requested,
              self,
              hint: '没有传 target，也拿不到调用者自己的会话 id（exec.agent 缺失）⇒ 请显式传 target（会话 id 或域键）。',
            }
          }
        } else {
          const resolved = resolveModelSessionTarget(ctx, config, rawTarget)
          if (!resolved.ok) {
            return {
              ok: false,
              reason: resolved.reason,
              requested,
              ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
              ...(resolved.declarations ? { declarations: resolved.declarations } : {}),
              ...(resolved.hint ? { hint: resolved.hint } : {}),
              self,
            }
          }
          sessionId = resolved.sessionId
          targetLabel = resolved.target ?? rawTarget
          matchedBy = resolved.matchedBy
        }
        // v0.6.1 硬护栏：目标是调用者自己 ⇒ 必须显式 allowSelf:true。
        // 理由（真实事故 2026-10-17）：一次"顺手验证"把主会话切到了别的模型，前缀缓存被
        // 打断、上下文要重算，代价全落在用户身上。改自己的模型永远不是顺手的事。
        if (self.id && sessionId === self.id && args.allowSelf !== true) {
          return {
            ok: false,
            reason: 'self-target-needs-allowSelf',
            sessionId,
            target: targetLabel,
            matchedBy,
            requested,
            self,
            hint: '这次要改的是**调用者自己**的会话 ⇒ 必须显式传 `allowSelf: true` 才放行（改自己的模型会打断前缀缓存、重算上下文）。要改别人的会话请显式传 target。',
          }
        }
        const applied = await applySessionModel(ctx, sessionId, { provider, model, reasoningEffort })
        const restored = applied.globalDefault?.restored === true
        const restoreNote = restored
          ? '宿主全局默认已恢复成改之前的值。'
          : applied.reason === 'api-unavailable' || applied.reason === 'invalid-model'
            ? '本次没有执行任何模型改动，全局默认没动。'
            : applied.globalDefault?.error
              ? `全局默认没能恢复（${applied.globalDefault.error}）。`
              : '全局默认本来就和这次选择相同（或没有记录到旧值），本次没有额外恢复。'
        return {
          ok: applied.ok,
          sessionId,
          target: targetLabel,
          matchedBy,
          applied: applied.ok ? 'next-request' : null,
          requested,
          previous: applied.previous,
          globalDefault: applied.globalDefault,
          self,
          ...(applied.reason ? { reason: applied.reason } : {}),
          ...(applied.error ? { error: applied.error } : {}),
          hint: applied.ok
            ? `已把 ${sessionId} 的模型改成 ${provider}/${model}：**下一轮请求生效**（正在跑的这一 step 不会换模型）。` + restoreNote
            : `模型没改成（${applied.reason}）。` + restoreNote,
        }
      } catch (error) {
        return { ok: false, reason: 'unexpected-error', error: messageOf(error) }
      }
    },
  )
}

export function buildSetDefaultModelTool(ctx) {
  return tool(
    'set_default_model',
    '**显式改宿主的全局默认模型（永不恢复）**（v0.6.1 模型分派）。这是"统一改模型入口"的**全局那一半**：语义＝`ctx.agentDefaultModel.saveSelection(next)` —— 与 `set_model`（先记 → 改 → **恢复**）**相反**，本工具就是要让新选择**留下来**。影响面：**之后新建的、且尚无会话级选择的 Agent**（新建会话，或拉活一个还没记录过模型选择的会话）；**改正在跑的会话要用 `set_model`**。实现：`typeof` 探测 `ctx.agentDefaultModel.currentSelection` / `saveSelection` → 读 `before` → `saveSelection(next)` → 读 `after`；回执 `{ok:true, before, after, source:"agentDefaultModel", note:"影响之后新建的、且尚无会话级选择的 Agent；改正在跑的会话要用 set_model"}`，并额外给 `saved`（本次请求写入的选择）、`verified`（读回来的 `after` 是否**逐字**等于 `saved`）、`applied`（`global-default` / `not-observed` / `readback-unavailable`）——因为宿主的 `saveSelection` 在没有部署配置入口（`fiber.entry === undefined`）或没有 `configEditor` 时是**静默 no-op**，所以"调成功"不等于"真写进去了"。服务不可用 ⇒ `{ok:false, reason:"api-unavailable"}`；provider/model 非法 ⇒ `{ok:false, reason:"invalid-model"}`；`saveSelection` 抛错 ⇒ 原样带回 `reason`（宿主错误码优先）+ `error`。**永不抛**。传了 `reasoningEffort` 才一起写（不发明默认值）。',
    {
      provider: { type: 'string', description: '必填：provider id（见 list_models 的 groups[].provider）。' },
      model: { type: 'string', description: '必填：model id（见 list_models 的 groups[].models[].id）。' },
      reasoningEffort: { type: 'string', description: '可选：原样透传给 saveSelection；不给就不写（不发明默认值）。' },
    },
    async (args, exec) => {
      try {
        const self = describe(exec?.agent, emptyIndex())
        const provider = textOf(args.provider)
        const model = textOf(args.model)
        const reasoningEffort = textOf(args.reasoningEffort)
        const requested = { provider, model, reasoningEffort: reasoningEffort || null }
        // 三段式审计日志（规则 vibe-audit-logger-lite）：① 入口
        warn(
          `[${TRACE_ID_V061}] 入口：set_default_model 想改全局默认为 ${provider || '(空)'}/${model || '(空)'}` +
            `${reasoningEffort ? ` (effort=${reasoningEffort})` : ''}，操作人=${self.id ?? '（未知会话）'}。`,
        )
        if (!provider || !model) {
          return {
            ok: false,
            reason: 'invalid-model',
            requested,
            self,
            hint: 'provider 与 model 都必填（都是非空字符串）。先用 list_models 看可用目录。',
          }
        }
        const defaults = optionalService(
          ctx,
          'agentDefaultModel',
          (service) => Boolean(service) && typeof service.saveSelection === 'function',
        )
        if (!defaults) {
          // ② 关键分支：服务不可用 ⇒ 一个字节都不写
          warn(`[${TRACE_ID_V061}] 分支：本进程 ctx 上没有可写的 ctx.agentDefaultModel.saveSelection() ⇒ 全局默认未改。`)
          return {
            ok: false,
            reason: 'api-unavailable',
            requested,
            self,
            hint:
              '本进程的 ctx 上没有可用的 `ctx.agentDefaultModel.saveSelection()`（这一半需要"能写"）。' +
              '没有改任何模型、也没有碰任何会话。',
          }
        }
        const before = currentGlobalDefault(defaults)
        const previous = modelSelectionOf(before.raw)
        const saved = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
        // 写入（**故意不恢复**：留下新值正是本工具的全部意义）
        await defaults.saveSelection(saved)
        const after = currentGlobalDefault(defaults)
        const current = modelSelectionOf(after.raw)
        const verified = exactModelChoice(current, saved)
        const applied = !current && !after.raw ? 'readback-unavailable' : verified ? 'global-default' : 'not-observed'
        // ③ 结果（含"写进去了没"的如实判断）
        warn(
          `[${TRACE_ID_V061}] 结果：全局默认 before=${previous ? `${previous.provider}/${previous.model}` : '（无）'}` +
            ` → after=${current ? `${current.provider}/${current.model}` : '（读不到）'}；` +
            `本次要求 ${saved.provider}/${saved.model}，verified=${verified}，applied=${applied}` +
            (before.error || after.error ? `；读回警告=${before.error || after.error}` : '') +
            (verified ? '。' : '。⚠️ 没读到与请求一致的值：宿主的 saveSelection 在无部署配置入口/无 configEditor 时是静默 no-op。'),
        )
        return {
          ok: true,
          before: previous,
          after: current,
          source: 'agentDefaultModel',
          note: '影响之后新建的、且尚无会话级选择的 Agent；改正在跑的会话要用 set_model',
          saved,
          verified,
          applied,
          ...(before.error ? { beforeError: before.error } : {}),
          ...(after.error ? { afterError: after.error } : {}),
          requested,
          self,
          hint: verified
            ? `全局默认已改成 ${saved.provider}/${saved.model}：**之后新建的、且尚无会话级选择的 Agent** 会用它；` +
              `已经在跑的会话请用 set_model。`
            : `已调用宿主 saveSelection(${saved.provider}/${saved.model})（没有抛错），但读回来的 after 与它不一致 ⇒ ` +
              `**不能确认真的写进去了**（宿主在无部署配置入口 / 无 configEditor 时会静默 no-op）。` +
              `改正在跑的会话用 set_model。`,
        }
      } catch (error) {
        // ④ 异常也要留痕
        warn(`[${TRACE_ID_V061}] 异常：set_default_model 失败=${messageOf(error)}（全局默认可能没改）。`)
        return {
          ok: false,
          reason: typeof error?.code === 'string' && error.code ? error.code : messageOf(error),
          error: messageOf(error),
        }
      }
    },
  )
}

export function buildCreateSessionTool(ctx, config) {
  return tool(
    'create_domain_session',
    '**开一个新的顶层会话（域会话）并把一条开工任务排进去**。走宿主服务 `ctx.sessionController.create()`（dsh-api-session-controller/lib/index.js:686-714：**只要给 cwd 就够**；不给 sessionId 时宿主自己生成 `session-<uuid>`）。v0.3.2 起让这条会话**抬眼可见**：① 先按 cwd 在宿主 Workspace 注册表里找一个**已存在**的工作区（`resolveByPath`，纯读、**绝不新建分组**），命中就传 `{workspaceId}`（宿主会把它挂进那个分组），未命中或拿不到注册表就退回 v0.3.1 的 `{cwd}`；② 建完再 `pinSession(sessionId)` 把它**置顶**到它所属分组最上方。找不到的排障顺序：那个分组若**折叠**就先点组名展开（折叠组一行都不渲染），再不行用左侧栏**搜索框输 cwd 的目录名**，或把排序方式切成「最近更新」。**本工具仍不能把它翻到前台**——宿主侧根本没有 Host→Renderer 导航通道，只能由人点一下那一条（或由渲染层客户端插件代点）。**v0.3.3 起建完还会顺手做两件事**（都能单独关掉，失败只影响那一步、不影响 `created`）：① 把沙箱/审批档设成 `permissionPreset`（不给＝用配置 `domainSessionPreset`，缺省 `workspace-write`——后台域会话无人值守不该卡在「等人点同意」，但要全盘写权限必须自己显式配 `danger-full-access`）；② 把标题设成 `title`（不给＝自动生成「[域] 2026-10-12 23:30 · 任务首句」，时间戳前置、≤80 字节；命名会 pin 标题、之后不再有 LLM 自动标题，对域会话无损失——它的首条消息是插件投递的，本来就不触发自动命名）。参数：`domain`（必填，`asr` 或 `项目:域`）、`task`（必填，要排给新会话的纯文本任务）、`project?`（短名 domain 时补项目；缺省用本会话 cwd 的目录名小写）、`cwd?`（新会话的工作目录；缺省用调用方会话的 cwd；相对路径会被宿主进程按自身 cwd 解析，建议给绝对路径）、`claim?`（默认 false；true = 建完把该域的「在任声明」指向新会话；**该域已有别的负责人时不覆盖**，如实回报冲突并给出换人办法）、`allowExistingOwner?`（默认 false；**v0.3.6 起：无论 claim 与否，本工具都会先读域名册**，回执常带 `existingOwner`（谁在任 / 是否在线 / 是否还在会话索引里）。该域**已有负责人**、你又没传 `claim:true`、也没传 `allowExistingOwner:true` ⇒ **不建会话**，回 `{created:false, reason=domain-already-owned, existingOwner, hint}`——这是为了防止同一个域起两条活会话并发改同一批文档（2026-10-12 docs 域事故）；传 `true` ＝ 明知已有负责人仍要再开一条，回执会带 `warning=domain-already-owned`，风险自负）、`pin?`（默认 **true**；`false` = 跳过置顶）、`permissionPreset?`（可选：建完立刻给这个会话设的权限档名，`read-only`／`workspace-write`／`danger-full-access`；`none`/`keep`/`skip`/空 ＝ 不动）、`title?`（可选：标题原文；`none`/`keep`/`skip`/空 ＝ 不命名）、`dryRun?`（默认 false；true 只回报"将会建哪个 cwd 的会话、排什么任务"、将设什么标题与权限档，**绝不真建**）、`agentPreset?`（可选，逐字透传给宿主的 `agentPreset`）。**v0.6.0 模型分派**：`model?`（`{provider, model, reasoningEffort?}`）＝建完立刻给新会话铺的模型（宿主 `create` 不收模型参数 ⇒ 建完调 `selectModel`）；不给＝用配置 `domainSessionModel`；都没有＝继承全局默认（保持旧行为）。铺模型同样是「先记全局默认 → 改 → 恢复」，回执带 `modelApplied:{ok, provider, model, source, error?}`；建会话本身失败时**一个模型都不改**。任何一步失败都**不抛错**，一律回报 `{created:false, reason}`。****v0.4.0 起「已暂停」｜v0.4.2 推广到四级**：目标被**任一级**按下（`scope` 取 `domain` / `session`（主＝单会话）/ `project` / `global`，**OR 叠加**）时**直接拒绝**：`created:false` / `reason=domain-paused`（冻结的历史字面量）/ `pausedScopes` / `pausedByScopes` / `scope` / `derivedState`，并且**绝不调用宿主 create**（`dryRun` 也一样，只报告"会被拒绝"）——暂停期间不新开、也不唤醒，这正是"暂停"的意义。判定**两端都查**：接收端（将新建的那个域键 / 它的项目 / 它的负责人会话 / global）＋发送端（本会话 / 本会话的项目 / global）。恢复后再建：`set_domain_state(scope=…, domain=…, state=active)`。暂停**不改在任身份**（声明册里 sessionId 不动），它与下面 F1 的「已有负责人」是两条**独立**的闸，本工具**先判暂停、再判负责人**。',
    {
      layer: {
        type: 'string',
        description:
          "可选（v0.8.5）：这条会话属于哪一层 —— `domain`（默认，域会话）/ `project`（项目主会话）/ `system`（体系主会话）。" +
          '**主会话换届必须显式传 layer**：域层写 owners、主会话层写 registrations，两本账不同。' +
          '不传＝`domain`，行为与以前逐字一致。',
      },
      domain: { type: 'string', description: '域短名（asr）或「项目:域」（misas:asr）。layer=system 时用「项目:system」，layer=project 时用「项目:main」（都给短名也行，按层规整）。' },
      task: { type: 'string', description: '要排给新会话的纯文本开工任务（以完整 v4 用户消息排进它的 inbox 并唤醒它开一轮）。v0.8.4 起插件会在它前面自动加一句**身份摘要**（「你是 `<项目>:<域>` 的负责人」或「你要接手它、当前在任 X」），原文一字不改跟在分隔线之后——新会话第一轮就知道自己是谁，不必先点 `/register`。' },
      model: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: 'provider id（见 list_models）' },
          model: { type: 'string', description: 'model id（见 list_models）' },
          reasoningEffort: { type: 'string', description: '可选，原样透传给 selectModel' },
        },
        description:
          '可选（v0.6.0）：建完立刻给新会话铺的模型（宿主 create 不收模型参数 ⇒ 建完调 selectModel）。不给＝用配置 domainSessionModel；都没有＝继承全局默认（保持旧行为）。',
      },
      project: { type: 'string', description: '可选：domain 为短名时用它补成「项目:域」；不给则取本会话 cwd 的目录名小写' },
      cwd: { type: 'string', description: '可选：新会话的工作目录；不给则用调用方会话的 cwd（建议绝对路径）' },
      claim: { type: 'boolean', description: 'true = 建完把该域的在任声明指向新会话（已有别的负责人时不覆盖，只回报冲突）' },
      allowExistingOwner: { type: 'boolean', description: '默认 false：该域已有负责人、又没传 claim:true 时**拒绝新建**（created:false / reason:domain-already-owned），避免同一个域起两条活会话互相覆盖。true = 明知已有负责人仍要再开一条（回执带 warning:domain-already-owned 与 existingOwner；风险：两条会话可能同时改同一批文档）。' },
      pin: { type: 'boolean', description: '默认 true = 建完把新会话置顶到它所属分组的最上方（左侧栏抬眼可见）；false = 跳过置顶（不想多一条置顶行时用；用户可点该行「…」→取消置顶来撤销）。置顶失败不影响 created:true。' },
      dryRun: { type: 'boolean', description: 'true = 只回报将会建哪个 cwd 的会话、排什么任务，绝不真建（默认 false）' },
      agentPreset: { type: 'string', description: '可选：透传给宿主 sessionController.create 的 agentPreset（真实字段名就是 agentPreset，没有 preset 这个参数；不给则由宿主的默认 preset 决定）' },
      permissionPreset: { type: 'string', description: "可选：建完立刻把这个会话的权限档设成它（部署里可用 read-only / workspace-write / danger-full-access）。不给＝用配置 domainSessionPreset（缺省 workspace-write；要全权须自己显式配置 danger-full-access）；给 ''/none/keep/skip ＝ 不动，保持宿主默认的 workspace-write+ask。" },
      title: { type: 'string', description: '可选：新会话的标题原文（会被压成单行并截到 80 字节）。不给＝自动生成「[域] 2026-10-12 23:30 · 任务首句」（时间戳前置）；给 \'\'/none/keep/skip ＝ 不命名，保持宿主行为。' },
    },
    async (args, exec) => {
      try {
        const self = describe(exec?.agent, emptyIndex())
        const rawDomain = String(args.domain ?? '').trim()
        if (!rawDomain) {
          return { created: false, reason: 'missing-domain', hint: 'domain 必填：短名（asr）或「项目:域」（misas:asr）。', self }
        }
        const task = String(args.task ?? '')
        if (!task.trim()) {
          return { created: false, reason: 'missing-task', hint: 'task 必填：要排给新会话的纯文本任务。', self }
        }

        // ── v0.6.0: which model should the NEW session get? explicit `model` wins, then the
        // `domainSessionModel` config, then "none" (inherit the host global default = old behaviour).
        // An explicitly malformed `model` is refused BEFORE creating anything.
        let modelWanted = null
        let modelSource = null
        if (args.model !== undefined && args.model !== null) {
          modelWanted = normalizeModelConfig(args.model)
          if (!modelWanted) {
            return {
              created: false,
              reason: 'invalid-model',
              self,
              hint: 'model 需要 {provider, model} 两个非空字符串（reasoningEffort 可选）；先用 list_models 看可用目录。',
            }
          }
          modelSource = 'explicit'
        } else if (config.domainSessionModel) {
          modelWanted = config.domainSessionModel
          modelSource = 'config'
        }

        // ── v0.8.5：**层**。以前这个工具从骨子里只认「域」：参数表没有层、身份摘要说
        // "你是 X 的负责人（域会话）"、认领只写 owners ⇒ 拿它做体系主换届时，新会话被告知去
        // `/register domain tixiweihu:system`，也就永远拿不到 layer:'system'（拿不到 /pause global）。
        // 现在三层：domain（默认，行为不变）/ project / system（主会话层写 registrations）。
        const rawLayer = String(args.layer ?? '').trim().toLowerCase()
        const layer = rawLayer === '' ? 'domain' : rawLayer
        if (!['domain', 'project', 'system'].includes(layer)) {
          return {
            created: false,
            reason: 'invalid-layer',
            self,
            hint: 'layer 只能是 domain / project / system（不传＝domain）。',
          }
        }
        const isMainLayer = layer !== 'domain'

        const split = splitDomainTarget(rawDomain, args.project)
        if (split.error) return { created: false, reason: 'invalid-domain', error: split.error, self }
        // 主会话层的键由层决定：体系 `<项目>:system`、项目 `<项目>:main`。
        if (isMainLayer) split.domain = layer === 'system' ? 'system' : 'main'

        let project = split.project
        let projectFrom = '参数 / 「项目:域」完整写法'
        if (!project) {
          // Same short-name rule as v0.2.0 claim_domain: basename of this session's cwd, lower-cased.
          project = projectFromCwd(self.cwd)
          projectFrom = '本会话 cwd 的目录名（小写）'
          if (!project) {
            return {
              created: false,
              reason: 'project-unknown',
              hint: '域是短名，又推不出项目名（本会话 cwd 拿不到），请显式给 project 参数（或写「项目:域」）。',
              self,
            }
          }
        }
        const key = project + ':' + split.domain

        // ── v0.3.6 F1：**无论 claim 与否，先读域名册**——「这个域已经有负责人」必须摆到台面上。
        // 依据：2026-10-12 给 docs 域开了第二条活会话，回执 created:true、零冲突提示，两条会话
        // 各改各的文档。旧行为只有 claim:true 才读域名册 ⇒ 不读就等于「根本不知情」。
        // 全部是既有读取：loadIndex（= list_domain_sessions 用的那套会话索引）、loadDeclarations、
        // isSessionOnline、liveTopLevel。不新建任何台账/接口。
        const index = loadIndex(config.indexFile)
        const declarations = loadDeclarations(config.domainsFile)
        const duties = dutyMap(declarations)
        let rows = []
        try {
          rows = liveTopLevel(ctx, index, duties)
        } catch {
          rows = []
        }
        // ── v0.8.5：主会话层的「已有负责人」在**注册册**里，不在 owners 里。
        // 只查 owners 的话，体系主换届这道 F1 闸形同虚设（同域能静默开第二条主会话）。
        let existingOwner = existingOwnerInfo(ctx, index, declarations, key, rows)
        if (isMainLayer) {
          const regRead = readRegistrations(config.domainsFile)
          const regDoc = regRead && regRead.doc ? regRead.doc : null
          const regEntry = regDoc && regDoc.registrations ? regDoc.registrations[key] : null
          const regOwner = regEntry && regEntry.sessionId ? String(regEntry.sessionId) : null
          existingOwner = regOwner
            ? {
                sessionId: regOwner,
                key,
                layer,
                since: regEntry.since ?? null,
                note: regEntry.note ?? null,
                live: rows.some((row) => row && row.sessionId === regOwner),
                inArchive: true,
                source: 'registrations',
              }
            : null
        }

        // ── v0.4.0/v0.4.2：暂停拦截，**排在 F1 之前**——「暂停期间不新开、也不唤醒这个域」是更强的政策；
        // 而且"目标已被按下"这个事实，比"这个域已经有负责人"更该挡在建会话前面。
        // v0.4.2：查的是**四级 OR**——① 将新建的那个域键 ② 它的项目 ③ 它的负责人会话 ④ global，
        // 再加上**发送端**（本会话 / 本会话的项目 / global）。只有经本插件按下（set_domain_state）才算；
        // 状态文件读不到/读不懂一律当"没暂停"（降级，不拦，但会进 unresolved）。
        const pauseEval = pausedTargetOf(config, declarations, key, { ctx, rows, self, index })
        if (pauseEval.hits.length > 0) {
          const facts = pausedFactsOf({
            config,
            declarations,
            ctx,
            rows,
            evaluated: pauseEval,
            domainKey: key,
            fallbackKey: key,
          })
          warn(
            `[${TRACE_ID_V042}] 拒绝为 ${key} 新建会话：被 ${facts.pausedScopes.join('+')} 压着` +
              `（${pausedScopesWords(pauseEval.hits)}）⇒ 本次建会话数=0。`,
          )
          const refusal = {
            created: false,
            reason: 'domain-paused',
            domain: facts.domain ?? key,
            scope: facts.scope,
            key,
            derivedState: facts.derivedState,
            online: facts.online,
            paused: true,
            pausedAt: facts.pausedAt,
            pausedBy: facts.pausedBy,
            pauseNote: facts.pauseNote,
            matchedBy: facts.matchedBy,
            pausedScopes: facts.pausedScopes,
            pausedByScopes: facts.pausedByScopes,
            pausedNotice: facts.pausedNotice,
            ...(pauseEval.unresolved.length ? { unresolved: pauseEval.unresolved } : {}),
            existingOwner,
            pending: loadInbox(config.stateDir, key).pending,
            hint: pausedCreateHint({ ...facts, key, state: facts.derivedState, pausedHits: pauseEval.hits }),
            self,
          }
          return args.dryRun === true ? { ...refusal, dryRun: true, refused: true } : refusal
        }

        const claimRequested = args.claim === true
        const allowExistingOwner = args.allowExistingOwner === true
        const overrideWarning = existingOwner && allowExistingOwner ? 'domain-already-owned' : null

        if (existingOwner && !claimRequested && !allowExistingOwner) {
          // 拒绝「静默换届」：**绝不建会话**（dryRun 也一样，只报告「会被拒绝」）。
          warn(
            `[${TRACE_ID}] 拒绝为 ${key} 新建会话：该域已有负责人 ${existingOwner.sessionId}` +
              `（在线=${existingOwner.live}，在档=${existingOwner.inArchive}）；` +
              `调用方没传 claim / allowExistingOwner ⇒ 本次建会话数=0。`,
          )
          const refusal = {
            created: false,
            reason: 'domain-already-owned',
            existingOwner,
            hint: domainAlreadyOwnedHint(key, existingOwner),
            self,
          }
          return args.dryRun === true ? { ...refusal, dryRun: true, refused: true } : refusal
        }
        if (overrideWarning) {
          warn(
            `[${TRACE_ID}] 放行覆盖：${key} 已有负责人 ${existingOwner.sessionId}` +
              `（在线=${existingOwner.live}），调用方传了 allowExistingOwner=true ⇒ 照建（不接管声明）。`,
          )
        }
        const ownership = { existingOwner, ...(overrideWarning ? { warning: overrideWarning } : {}) }
        const cwd = String(args.cwd ?? self.cwd ?? '').trim()
        if (!cwd) {
          return {
            created: false,
            reason: 'cwd-unknown',
            hint: '既没给 cwd，也拿不到调用方会话的 cwd；请显式给 cwd（绝对路径）。',
            self,
          }
        }

        // The real request field is `agentPreset` (typert.host.js:192-197) - there is no `preset`.
        const agentPreset =
          args.agentPreset === undefined || args.agentPreset === null || String(args.agentPreset).trim() === ''
            ? undefined
            : String(args.agentPreset).trim()
        const presetPart = agentPreset === undefined ? {} : { agentPreset }
        const cwdRequest = { cwd, ...presetPart }

        const replyKey = self.id ?? ''
        // ── v0.8.4：身份随开工任务一起去。新会话的域身份只存在域名册里，它自己看不见——
        // 不带这一句，它第一轮就得先猜"我是不是负责人"，或者等人点一次 `/register`。
        // 这一句在**建会话之前**就定（只用 existingOwner + claim 请求），所以 dryRun 预览的也是真实文本；
        // 原文 task 一字不动放在分隔线之后（标题仍按原文首行算，调用点在本段之前）。
        const layerWordOf = (value) => (value === 'system' ? '体系主会话' : value === 'project' ? '项目主会话' : '域会话')
        const identityHeader = isMainLayer
          ? args.claim === true && !(existingOwner && existingOwner.sessionId)
            ? `你是 \`${key}\` 的**${layerWordOf(layer)}**。本次建会话时已写入注册册的 \`registrations\` 节；裸跑 \`/register\` 可核对。`
            : existingOwner && existingOwner.sessionId
              ? `你是 \`${key}\` 的**${layerWordOf(layer)}**；本次建会话时接手自 ${existingOwner.sessionId}（已写进 note 留痕）。` +
                `裸跑 \`/register\` 可核对。⚠️ 前任不会自动退役：要它退下来，需要人在它窗口里执行 \`/retire\`。`
              : `你是 \`${key}\` 的**${layerWordOf(layer)}**。本次建会话时**没有**写注册册（调用方没传 claim）；` +
                `裸跑 \`/register\` 看身份，要登记就 \`/register ${layer}\`。`
          : args.claim === true && !(existingOwner && existingOwner.sessionId)
            ? `你是 \`${key}\` 的负责人（域会话）。本次建会话时已认领，域名册会把该域指向本会话；裸跑 \`/register\` 可核对。`
            : existingOwner && existingOwner.sessionId
              ? `你要接手的是 \`${key}\`；该域当前在任 ${existingOwner.sessionId}，本次**没有**认领它。先裸跑 \`/register\` 核对身份，要正式接任就 \`/register domain ${key} takeover\`。`
              : `你被指派到 \`${key}\`。本次**没有**认领它的在任声明；先裸跑 \`/register\` 看身份，要接任就 \`/register domain ${key}\`。`
        const envelope = domainEnvelope({
          self,
          text: `${identityHeader}\n\n---\n\n${task}`,
          replyKey,
          mode: 'followup',
          label: isMainLayer ? `${layerWordOf(layer)}交接任务` : '域会话开工任务',
        })
        const claimNote = `由 ${self.id ?? '未知会话'} 建会话时认领`

        // ── v0.3.2 step 1: which EXISTING workspace owns this cwd? Pure read, zero side effects.
        // A miss (or no registry at all) is the normal v0.3.1 path, not an error.
        const wsLookup = await findWorkspaceFor(ctx, cwd)
        const workspaceId =
          wsLookup.workspace && wsLookup.workspace.id !== undefined && wsLookup.workspace.id !== null
            ? String(wsLookup.workspace.id)
            : null
        const workspaceTitle =
          wsLookup.workspace && wsLookup.workspace.title !== undefined && wsLookup.workspace.title !== null
            ? String(wsLookup.workspace.title)
            : null

        // ── v0.3.2 step 2: workspaceId and cwd are MUTUALLY EXCLUSIVE (index.js:687) - pick one.
        // With workspaceId the host derives cwd from workspace.path (:694), which also makes the
        // attach realpath validation pass by construction (dsh-workspace/lib/index.js:111-129).
        const request = workspaceId === null ? cwdRequest : { workspaceId, ...presetPart }

        // Reported verbatim so a caller can see exactly which rung of the degrade ladder fired.
        // Every key is always present (null/boolean), so the result stays lossless JSON.
        const workspaceInfo = {
          lookup: wsLookup.lookup,
          lookupError: wsLookup.lookupError,
          id: workspaceId,
          title: workspaceTitle,
          requested: workspaceId !== null,
          attached: null,
          createFallback: false,
          createFallbackError: null,
          attachError: null,
        }
        const searchHint = `在左侧栏搜索框输入 ${dirLabelOf(cwd)}（或把排序方式切成「最近更新」）`

        // ── v0.3.3: 建完之后要做的两件事，先纯计算出「想要什么」，dryRun 也报同一份值。
        const rawPreset =
          args.permissionPreset === undefined || args.permissionPreset === null
            ? config.domainSessionPreset
            : args.permissionPreset
        const presetWanted = offSwitch(rawPreset) ? null : String(rawPreset).trim()
        const titleWanted =
          args.title === undefined || args.title === null
            ? isMainLayer
              // 主会话层的默认标题不写「[system]」——那是域的形状，侧栏里看不出它是体系主/项目主。
              ? mainLayerTitle(layer, task, new Date())
              : domainSessionTitle(split.domain, task, new Date())
            : offSwitch(args.title)
              ? null
              : clipToBytes(args.title, TITLE_MAX_BYTES)

        if (args.dryRun === true) {
          // Rehearsal: never touches sessionController, never writes the declaration book.
          const sitting = declarations.byKey.get(key.toLowerCase()) || null
          return {
            created: false,
            dryRun: true,
            ...ownership,
            wouldCreate: {
              cwd,
              project,
              projectFrom,
              domain: split.domain,
              key,
              request,
              workspace:
                workspaceId === null
                  ? { requested: false, lookup: wsLookup.lookup }
                  : { requested: true, id: workspaceId, title: workspaceTitle, lookup: wsLookup.lookup },
              sessionId: '（由宿主自动生成：session-<uuid>）',
            },
            wouldPin: args.pin === false ? { requested: false } : { requested: true },
            wouldDeliver: { mode: 'followup', envelope },
            wouldClaim:
              args.claim === true
                ? { requested: true, key, ownerSessionId: '（新会话）', sittingOwner: sitting ? declarationInfo(sitting, declarations) : null }
                : { requested: false },
            wouldSetPermission: { requested: presetWanted !== null, preset: presetWanted },
            wouldSetModel: {
              requested: modelWanted !== null,
              source: modelSource,
              provider: modelWanted ? modelWanted.provider : null,
              model: modelWanted ? modelWanted.model : null,
              reasoningEffort: modelWanted?.reasoningEffort ?? null,
            },
            wouldTitle: { requested: titleWanted !== null, title: titleWanted },
            self,
            note: '演练：没有建会话、没有排任务、没有动域名册。',
          }
        }

        const controller = getSessionController(ctx)
        if (!controller) {
          return {
            created: false,
            reason: 'sessionController-unavailable',
            hint: '本进程 ctx 上没有可用的 sessionController 服务（或它没有 create 方法），无法建会话。没有建任何东西、也没有写任何文件。',
            request,
            workspace: workspaceInfo,
            ...ownership,
            self,
          }
        }

        let created
        try {
          created = await controller.create(request)
          if (workspaceId !== null) workspaceInfo.attached = true // create() ran attachSession() and returned OK
        } catch (error) {
          // ── v0.3.2 step 3/4: two failure shapes, two DIFFERENT reactions.
          // (a) The attach half failed AFTER the session was created => retrying would leave a
          //     second orphan session. Keep the identity the host reported and report honestly.
          const attachFailure = workspaceId === null ? null : attachFailureOf(error)
          if (attachFailure) {
            workspaceInfo.attached = false
            workspaceInfo.attachError = attachFailure.error
            created = attachFailure.sessionId === null ? {} : { sessionId: attachFailure.sessionId }
          } else if (workspaceId !== null) {
            // (b) The workspaceId request failed outright (e.g. workspace/not-found) => degrade to
            //     the byte-identical v0.3.1 {cwd} request, ONCE. A second failure is final.
            workspaceInfo.attached = false
            workspaceInfo.createFallback = true
            workspaceInfo.createFallbackError = messageOf(error)
            try {
              created = await controller.create(cwdRequest)
            } catch (second) {
              return {
                created: false,
                reason: 'create-failed',
                error: messageOf(second),
                firstError: workspaceInfo.createFallbackError,
                request: cwdRequest,
                workspace: workspaceInfo,
                self,
              }
            }
          } else {
            return { created: false, reason: 'create-failed', error: messageOf(error), request, workspace: workspaceInfo, self }
          }
        }

        const sessionId =
          created && typeof created.sessionId === 'string' && created.sessionId ? created.sessionId : null
        if (!sessionId) {
          if (workspaceInfo.attachError !== null) {
            // The session exists and the host said so, but no id came back: report, NEVER rebuild.
            return {
              created: true,
              session: null,
              reason: 'created-but-workspace-attach-failed',
              error: workspaceInfo.attachError,
              request,
              workspace: workspaceInfo,
              pinned: { ok: false, reason: 'session-id-unknown' },
              self,
              hint:
                `会话已经建出来了，但宿主把它挂进工作区时失败、且错误里没带出会话 id，所以这里拿不到那一条。` +
                `它大概率落在左侧栏「未分组」里：${searchHint}。本工具不会重建会话，也不会把它翻到前台（宿主侧没有 Host→Renderer 导航通道）。`,
            }
          }
          return {
            created: false,
            reason: 'create-returned-no-session-id',
            returned: created && typeof created === 'object' ? { keys: Object.keys(created) } : { type: typeof created },
            request,
            workspace: workspaceInfo,
            self,
          }
        }

        // ── v0.6.0: 建完立刻铺模型（同一套「先记全局默认 → selectModel → 恢复」）。创建本身
        // 失败时根本走不到这里；这一步失败只影响 modelApplied，不影响 created。
        let modelApplied = null
        if (modelWanted) {
          const applied = await applySessionModel(ctx, sessionId, modelWanted)
          modelApplied = {
            ok: applied.ok,
            provider: modelWanted.provider,
            model: modelWanted.model,
            source: modelSource,
            ...(modelWanted.reasoningEffort ? { reasoningEffort: modelWanted.reasoningEffort } : {}),
            ...(applied.ok ? {} : { error: applied.reason || applied.error || 'model-not-applied' }),
            ...(applied.error && applied.reason ? { detail: applied.error } : {}),
            previous: applied.previous,
            globalDefault: applied.globalDefault,
          }
        }

        let agent = null
        try {
          agent = ctx?.agents?.get?.(sessionId) ?? null
        } catch {
          agent = null
        }
        const short = shortId(sessionId)

        // ── v0.3.2 step 5: pin the new session so a human actually SEES the row.
        // pinSession(sessionId): Promise<void> - idempotent, durable (workspace.json
        // global.pinnedSessionIds) and it pushes {type:'pinned'} to every open sidebar, so the
        // pinned row appears without a refresh. It does NOT require the session to be attached to
        // a workspace (dsh-workspace/lib/index.js:576-587), which is why this also runs on the
        // ungrouped fallback path. A failure here NEVER downgrades created:true - it only changes
        // the hint, honoring the "created is created" contract.
        const pinRequested = args.pin !== false
        let pinned
        if (!pinRequested) {
          pinned = { ok: false, reason: 'skipped-by-request' }
        } else if (!wsLookup.registry) {
          pinned = { ok: false, reason: 'workspaceRegistry-unavailable' }
        } else if (typeof wsLookup.registry.pinSession !== 'function') {
          pinned = { ok: false, reason: 'pinSession-unsupported' }
        } else {
          try {
            await wsLookup.registry.pinSession(sessionId)
            pinned = { ok: true, reason: null }
          } catch (error) {
            // WorkspaceUnknownSessionError / WorkspaceArchivedSessionPinError land here.
            pinned = { ok: false, reason: messageOf(error) }
          }
        }

        // ── v0.3.3 step 6: 放开权限档。后台域会话无人值守，留在部署默认的 workspace-write + ask
        // 会卡在「等一个人点同意」；set() 只写这个会话的一条 permission/preset 事件并把
        // sandbox/approval 两个开关一起落定，**不动用户的全局默认**。resolve 先跑一次：未知名字
        // 在写任何东西之前就抛，不会留下半套开关。
        const liveSession = sessionOf(agent)
        const permission = { requested: presetWanted !== null, preset: presetWanted }
        if (presetWanted === null) {
          permission.reason = 'skipped-by-request'
        } else if (!liveSession) {
          permission.ok = false
          permission.reason = 'agent-session-unavailable'
          permission.hint = '拿不到这个会话的 Session 对象，权限档没动（它仍留在宿主默认档）。'
        } else {
          const presets = getPermissionPresets(ctx)
          if (!presets) {
            permission.ok = false
            permission.reason = 'permissionPresets-unavailable'
          } else {
            try {
              presets.resolve(presetWanted)
              presets.set(liveSession, presetWanted)
              permission.ok = true
            } catch (error) {
              permission.ok = false
              permission.reason = 'set-failed'
              permission.error = messageOf(error)
            }
          }
        }

        // ── v0.3.3 step 7: 给它一个能读的标题（时间戳前置；会 pin 标题、之后不再自动命名——见 CHANGELOG.md v0.3.3）。
        const titled = { requested: titleWanted !== null, title: titleWanted }
        if (titleWanted === null) {
          titled.reason = 'skipped-by-request'
        } else if (!liveSession) {
          titled.ok = false
          titled.reason = 'agent-session-unavailable'
        } else {
          const titles = getSessionTitle(ctx)
          if (!titles) {
            titled.ok = false
            titled.reason = 'sessionTitle-unavailable'
          } else {
            try {
              titles.rename(liveSession, titleWanted)
              titled.ok = true
            } catch (error) {
              titled.ok = false
              titled.reason = 'rename-failed'
              titled.error = messageOf(error)
            }
          }
        }

        // Enqueue the startup task with the SAME v4 shape send_to_domain uses (one builder only).
        let scheduled
        if (!agent) {
          scheduled = {
            ok: false,
            reason: 'agent-not-found-after-create',
            hint: '会话建好了，但拿不到它的 Agent，任务没排进去（那条会话是空的，人可以打开后自己说第一句）。',
          }
        } else if (typeof agent.followup !== 'function') {
          scheduled = { ok: false, reason: 'followup-unsupported' }
        } else {
          try {
            const payload = domainMessage({ self, envelope })
            agent.followup(payload)
            scheduled = { ok: true, mode: 'followup', messageId: payload.id }
          } catch (error) {
            scheduled = { ok: false, reason: 'followup-failed', error: messageOf(error) }
          }
        }

        let claim = { requested: args.claim === true, performed: false }
        if (args.claim === true && isMainLayer) {
          // 主会话层写**注册册**（不写 owners）——这是 identityOf 判定 layer:'system'/'project' 的唯一来源。
          // 只有调用方明确 allowExistingOwner（＝`/handoff` 那种"明知有人在任仍要交接"）才覆盖，
          // 覆盖时 upsertRegistration 会把前任写进 note 留痕。
          const written = upsertRegistration(
            config.domainsFile,
            { key, layer, project, sessionId, note: claimNote },
            { force: allowExistingOwner === true, by: self.id ?? null },
          )
          claim = { requested: true, layer, ...written }
          if (written.conflict) {
            const holderShort = shortId(written.owner?.sessionId) || written.owner?.sessionId || '（未记录）'
            claim.hint =
              `该键已有在任负责人 ${holderShort}，本次没有覆盖。要让**新会话 ${short}** 接手：` +
              `① 让在任方自己在窗口里执行 \`/retire\`，再重跑本工具；② 或重跑时传 allowExistingOwner:true（＝强制接手，前任写进 note 留痕）。`
          }
        } else if (args.claim === true) {
          const result = declareNewOwner(config.domainsFile, {
            key,
            project,
            domain: split.domain,
            ownerSessionId: sessionId,
            note: claimNote,
          })
          claim = { requested: true, ...result }
          if (result.outcome === 'conflict') {
            const holderShort = shortId(result.holder?.sessionId) || result.holder?.sessionId || '（未记录）'
            claim.hint =
              `该域已有在任负责人 ${holderShort}，本次没有覆盖任何东西。要让**新会话 ${short}** 当负责人：` +
              `① 让在任方自己 release_domain，然后重跑本工具（claim:true）；` +
              `② 或直接用 CLI 指向新会话：node ${ownerCliRef(config)} claim ${split.domain} --session ${sessionId} --project ${project} --force` +
              `（--force 才交接，旧负责人会写进 note 留痕）。`
          }
        }

        const observed = agent ? describe(agent, emptyIndex()) : null
        const taskLine = scheduled.ok
          ? `开工任务已排进去（将被唤醒开始干活）；它回话用 send_to_domain，target=${replyKey}。`
          : `但开工任务没排进去（见 scheduled.reason）。`
        const groupLine = workspaceTitle === null ? '未分组' : workspaceTitle
        const workspaceLine =
          workspaceInfo.attached === true
            ? `已挂进工作区分组《${groupLine}》（workspaceId=${workspaceId}）：它的工作目录就是该工作区的目录，所以这次它「属于某个项目」。`
            : workspaceInfo.attachError !== null
              ? `⚠️ 会话已经建出来了，但宿主把它挂进工作区《${workspaceTitle ?? workspaceId}》时失败：${workspaceInfo.attachError} ⇒ 它这次落在左侧栏「未分组」里（按「已创建但未入组」如实回报，没有重建会话）。`
              : workspaceInfo.createFallback
                ? `⚠️ 按 workspaceId 建被宿主拒绝：${workspaceInfo.createFallbackError} ⇒ 已自动退回「只给 cwd」重试一次并成功，本次没有入组（行为回到 v0.3.1）。`
                : `这条 cwd 没有已存在的工作区分组（lookup=${workspaceInfo.lookup}），按 v0.3.1 的行为只给 cwd 建，没有入组。`
        const pinLine = pinned.ok
          ? `已把它置顶到《${groupLine}》的最上方（置顶会即时推给已打开的侧栏，不用刷新）。⚠️ 若那个分组是**折叠**的，请先点一下组名展开——折叠的分组一行都不渲染；展开后它在第 1 行（每个分组只渲染 5 条空闲行，砍的是第 6 条往后，砍不到它）。`
          : `置顶没做成（${pinned.reason}）⇒ 它不会排在分组最上方；找不到时${searchHint}。`
        const permissionLine =
          permission.ok === true
            ? `权限档已设成 ${permission.preset}（只写这个会话的档，没动你的全局默认）。`
            : permission.requested
              ? `⚠️ 权限档没设成（${permission.reason}）⇒ 它仍留在宿主默认档（workspace-write + ask）；后台无人值守时被拦可能卡住或失败关闭。`
              : `权限档按要求没动（保持宿主默认）。`
        const titledLine =
          titled.ok === true
            ? `标题已设为「${titled.title}」。`
            : titled.requested
              ? `⚠️ 标题没设成（${titled.reason}）。`
              : `标题按要求没动。`
        const modelLine = modelApplied
          ? modelApplied.ok
            ? `模型已铺成 ${modelApplied.provider}/${modelApplied.model}（来源：${modelApplied.source}；**下一轮请求生效**）。`
            : `⚠️ 模型没铺成（${modelApplied.error}；来源：${modelApplied.source}）⇒ 它仍用全局默认。`
          : ''
        return {
          created: true,
          session: {
            id: sessionId,
            shortId: short,
            cwd,
            project,
            projectFrom,
            layer,
            domain: split.domain,
            key,
            agentPreset: created?.agentPreset ?? agentPreset ?? null,
            topLevel: observed ? (observed.topLevel ?? null) : null,
            observedPreset: observed ? (observed.preset ?? null) : null,
            workspaceId,
            workspaceTitle,
            attachedToWorkspace: workspaceInfo.attached,
          },
          workspace: workspaceInfo,
          pinned,
          permission,
          titled,
          ...(modelApplied ? { modelApplied } : {}),
          scheduled,
          // v0.8.4：随开工任务一起发出去的身份摘要（原文 task 在它之后，一字未改）。
          taskIdentity: identityHeader,
          claim,
          ...ownership,
          self,
          hint:
            `新会话 ${sessionId}（短号 ${short}）已建好，工作目录 ${cwd}，域 ${key}。` +
            workspaceLine +
            pinLine +
            permissionLine +
            titledLine +
            modelLine +
            (overrideWarning ? domainOwnedOverrideHint(key, existingOwner) : '') +
            `请到左侧会话列表点开 ${short} 那一条（本工具不会把它翻到前台：宿主侧没有 Host→Renderer 导航通道，只能人点一下，或由渲染层客户端插件代点）。` +
            taskLine,
        }
      } catch (error) {
        // Tool execution must never hard-fail the host either (P15).
        return { created: false, reason: 'unexpected-error', error: messageOf(error) }
      }
    },
  )
}

