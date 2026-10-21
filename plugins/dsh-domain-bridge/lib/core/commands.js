/**
 * dsh-domain-bridge — v0.7.0 slash commands (thin orchestrators over the governance layer).
 *
 * Design rule (frozen contract: D:\dsh\Generated\2026-10-19\spec\commands-v1.md §3):
 *   a command only parses the typed line, checks the caller's identity, calls ONE existing tool
 *   definition (claim / release / pause / create) or one registry write, and returns a Chinese
 *   receipt. It never reads state to make a model call and never re-implements governance.
 *
 * Registered commands: /register /initialize /handoff /retire /pause /pause-all
 * All six are HOST commands (ctx.commands.register): the line is executed by the Host, never sent
 * to the model, and the invocation carries the calling Agent (§3.1).
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  readRegistrations,
  readRegistrationsForWrite,
  upsertRegistration,
  removeRegistration,
  identityOf,
  projectOfCwd,
  listRegistrations,
} from './registrations.js'
import { loadDeclarations } from './declaration.js'
import { loadDomainStates } from './pause.js'
import { sessionOf, markRetired } from './session-factory.js'
import { stateRoot, webOrigin, isFullSessionId, isSessionIdLike } from './shared.js'
import { warn } from './tools.js'

const HANDOFF_DEFAULTS = {
  model: { provider: 'wb', model: 'cn:deepseek-v4.1-flash' },
  presets: { system: 'cordis', project: 'standard', domain: 'standard' },
  permission: { system: 'danger-full-access', project: 'workspace-write', domain: 'danger-full-access' },
}

/** One-line receipt text. Everything user-facing is Chinese and states the next step. */
function reply(ok, lines) {
  const body = Array.isArray(lines) ? lines.join('\n') : String(lines)
  return { kind: ok ? 'success' : 'error', text: body }
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Split a command tail into whitespace-separated words (no quoting support needed here). */
function words(rawInput) {
  return textOf(rawInput).split(/\s+/).filter(Boolean)
}

/** Parse `key=value` pairs; returns { flags:Set, values:Map, rest:[] }. */
function parseFlags(tokens) {
  const flags = new Set()
  const values = new Map()
  const rest = []
  for (const token of tokens) {
    if (token.startsWith('--')) {
      flags.add(token.slice(2))
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 0) {
      values.set(token.slice(0, eq), token.slice(eq + 1))
      continue
    }
    rest.push(token)
  }
  return { flags, values, rest }
}

/** The caller's cwd without throwing when the host service is absent. */
export function callerCwd(ctx, agent) {
  try {
    const wd = ctx && typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx && ctx.workingDirectory
    if (!wd || typeof wd.get !== 'function') return null
    const session = sessionOf(agent)
    if (!session) return null
    const cwd = wd.get(session)
    return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null
  } catch {
    return null
  }
}

function callerId(agent) {
  const id = agent && agent.id ? String(agent.id) : ''
  return id || null
}

/** A stable, comparable project name for a path (basename, lower-case). */
function projectNameOf(cwd) {
  const resolved = projectOfCwd(cwd)
  return resolved && resolved.project ? resolved.project : null
}

/** Read owners from the declarations file (domains live there; not duplicated in registrations). */
function ownedDomains(domainsFile, sessionId) {
  const declarations = loadDeclarations(domainsFile)
  const rows = declarations && Array.isArray(declarations.entries) ? declarations.entries : []
  return rows.filter((row) => row && row.sessionId === sessionId)
}

function identitySummary(doc, domainsFile, sessionId, cwd) {
  const identity = identityOf(doc, sessionId)
  const domains = ownedDomains(domainsFile, sessionId)
  const project = projectNameOf(cwd)
  const systemRoot = projectOfCwd(cwd).isSystemRoot
  const layerWords = {
    system: '体系主会话',
    project: '项目主会话',
    domain: '域会话',
  }
  const roles = identity.roles.map((role) => `${layerWords[role.layer] || role.layer}（${role.key}）`)
  for (const row of domains) roles.push(`域负责人（${row.key}）`)
  return { identity, domains, project, systemRoot, roles }
}

/* ------------------------------------------------------------------ /register */

function registerCommand(ctx, deps) {
  const { config, defs } = deps
  return {
    name: 'register',
    description: '把当前会话注册为体系主会话 / 项目主会话 / 域会话（不带参数＝只看当前身份与可选项）',
    input: { hint: 'system | project [项目名] | domain <域> [takeover]' },
    async handler(invocation) {
      const agent = invocation && invocation.agent
      const sessionId = callerId(agent)
      if (!sessionId) return reply(false, ['拿不到调用者会话 id，无法注册。请在会话窗口里直接执行这条命令。'])

      const cwd = callerCwd(ctx, agent)
      const tokens = words(invocation.rawInput)
      const read = readRegistrations(config.domainsFile)
      const doc = read.doc || { schemaVersion: 1, owners: [], registrations: {} }
      const summary = identitySummary(doc, config.domainsFile, sessionId, cwd)

      if (tokens.length === 0) {
        const lines = []
        lines.push(`**当前身份**：${summary.roles.length ? summary.roles.join('、') : '未注册任何身份'}`)
        lines.push(`**cwd**：${cwd || '(取不到)'}　**项目名**：${summary.project || '(推不出)'}`)
        if (!cwd) lines.push('⚠️ 拿不到 cwd ⇒ 注册会失败。请确认这条命令是在一个有工作目录的会话里执行。')
        lines.push(ownedDomains(config.domainsFile, sessionId).length
          ? `**持有的域**：${ownedDomains(config.domainsFile, sessionId).map((row) => row.key).join('、')}`
          : '**持有的域**：无')
        lines.push('')
        lines.push('**你现在能做什么**：')
        lines.push('· `/register system`　注册为**体系主会话**（cwd 应含体系口径源 SYSTEM-OVERVIEW.md；新建体系根时加 `--confirm`）')
        lines.push('· `/register project [项目名]`　注册为**项目主会话**（默认用 cwd 目录名；骨架还没建也能先注册，之后再 `/initialize`）')
        lines.push('· `/register domain <域> [takeover]`　注册/接任**域会话**（`takeover`＝强制交接，会通知前任）')
        lines.push('· `/handoff`　把职责交给新建会话　·　`/retire`　结束自己的任职')
        if (read.error) lines.push('', `⚠️ 注册册读不懂（${read.error}）⇒ 现在只读；修好文件再注册，我不会覆盖它。`)
        return reply(true, lines)
      }

      const layer = tokens[0].toLowerCase()
      if (layer === 'system') {
        if (!cwd) return reply(false, ['拿不到 cwd，无法判断体系根。'])
        const project = projectNameOf(cwd)
        if (!project) return reply(false, ['推不出项目名（cwd 是盘根或取不到）⇒ 生成不了注册键。请在有目录名的会话里执行。'])
        // 顺序约定：注册在前、初始化在后。缺 SYSTEM-OVERVIEW.md 时不再拒绝（那正是"新体系根还没建骨架"
        // 的正常状态），改成要一次显式确认——自封体系主是高权限动作，值得按一下；但卡住流程不值得。
        const isSystemRoot = projectOfCwd(cwd).isSystemRoot
        const takeover = tokens.slice(1).some((token) => token === 'takeover' || token === '--takeover')
        const confirm = tokens.slice(1).some((token) => token === '--confirm' || token === 'confirm')
        if (!isSystemRoot && !confirm && !takeover) {
          return reply(false, [
            `cwd 里没有体系口径源 SYSTEM-OVERVIEW.md：${cwd}`,
            '若这就是新建的体系根（骨架还没建），确认一次即可注册：',
            '· `/register system --confirm`　（该文件**不会**被自动创建：`/initialize` 只建项目骨架，体系层文件要人手补或从模板拷）',
            '若走错目录了，请到体系根目录下的会话里执行，或改用 `/register project`。',
          ])
        }
        return writeRegistration(config, sessionId, {
          key: `${project}:system`,
          layer: 'system',
          project,
          domain: 'system',
          cwd,
        }, { skeletonMissing: !isSystemRoot }, { force: takeover })
      }

      if (layer === 'project') {
        // v0.8.5：`--takeover` 以前会被当成项目名（键落成 `--takeover:main` 的脏数据）。
        const takeover = tokens.slice(1).some((token) => token === 'takeover' || token === '--takeover')
        const positional = tokens.slice(1).filter((token) => !token.startsWith('--') && token !== 'takeover' && token !== 'confirm')
        const project = (positional[0] || projectNameOf(cwd) || '').toLowerCase()
        if (!project) return reply(false, ['推不出项目名：cwd 拿不到，也没传项目名。用法：`/register project <项目名>`。'])
        // 注册在前、初始化在后：不再要求项目根先有 PROJECT.md（新目录默认是空的）。
        // 仍保留「把 cwd 规整到项目根」——防止在子目录里注册，键必须落在项目根目录名下。
        const root = (cwd && path.basename(cwd).toLowerCase() === project ? cwd : maybeProjectRoot(cwd, project)) || cwd
        return writeRegistration(config, sessionId, {
          key: `${project}:main`,
          layer: 'project',
          project,
          domain: 'main',
          cwd: root,
        }, { skeletonMissing: !root || !fs.existsSync(path.join(root, 'PROJECT.md')) }, { force: takeover })
      }

      if (layer === 'domain') {
        const target = tokens[1]
        if (!target) {
          return reply(false, ['用法：`/register domain <域>` 或 `/register domain <项目:域> [takeover]`。',
            '想看现有域：打开 `_registry\\domains.json`，或在会话里问一句「列出在任声明」。'])
        }
        const takeover = tokens.slice(2).some((token) => token === 'takeover' || token === '--takeover')
        if (!defs || !defs.claim) return reply(false, ['claim 工具不可用（插件未完整加载），域注册暂不可用。'])
        const result = await defs.claim.execute(
          { domain: target, force: takeover === true, note: takeover ? 'takeover via /register domain' : '' },
          { agent },
        )
        return reply(true, [`**域注册回执**（原样来自 claim_domain）`, '```json', JSON.stringify(result, null, 2), '```'])
      }

      return reply(false, [`不认识的层级：\`${layer}\``, '可选：`system` / `project` / `domain`。不带参数执行 `/register` 看当前身份。'])
    },
  }
}

function maybeProjectRoot(cwd, project) {
  if (!cwd) return null
  const candidate = path.join(path.dirname(cwd), project)
  return fs.existsSync(candidate) ? candidate : null
}

function writeRegistration(config, sessionId, entry, extra = {}, opts = {}) {
  const written = upsertRegistration(config.domainsFile, {
    ...entry,
    sessionId,
    since: new Date().toISOString(),
    by: sessionId,
    title: '',
    note: opts.force ? 'takeover via /register' : '',
  }, { force: opts.force === true, by: sessionId })
  if (written.ok) {
    const fromHandover = written.handoverFrom || null
    return reply(true, [
      `✅ 已注册：**${entry.key}**（${layerWord(entry.layer)}）`,
      `· 会话：${sessionId}`,
      ...(fromHandover ? [`· 接手自：${fromHandover}（已写进 note 留痕；它不是被停掉，需要的话让它自己 \`/retire\`）`] : []),
      `· 落账：${config.domainsFile} 的 \`registrations\` 节（owners 没动）`,
      // 顺序约定：注册先行，骨架后补。缺骨架不是失败，只是下一件事还没做。
      extra.skeletonMissing
        ? '· 下一步：这个目录还没有骨架 ⇒ `/initialize`（只补不改；已有文件一字不动）'
        : entry.layer === 'system'
          ? '· 下一步：`/pause global` 现在有权限了；骨架可用 `/initialize check` 复查'
          : '· 下一步：骨架已在，可随时 `/initialize check` 复查',
    ])
  }
  if (written.conflict) {
    const owner = written.owner
    return reply(false, [
      `❌ \`${entry.key}\` 已经有负责人：${owner && owner.sessionId ? owner.sessionId : '(读不到)'}（自 ${owner && owner.since ? owner.since : '?'}）`,
      '三条出路：',
      `· **强制接手**：\`/register ${entry.layer} --takeover\`（会把对方写进 note 留痕；它不会被停掉）`,
      '· **对方自己退**：让在任会话执行 `/retire`，你再重跑这条注册',
      '· **取消**：什么都不做',
    ])
  }
  return reply(false, [`注册失败：${written.error || written.reason || 'unknown'}`, `文件：${config.domainsFile}`])
}

function layerWord(layer) {
  return layer === 'system' ? '体系主会话' : layer === 'project' ? '项目主会话' : '域'
}

/* --------------------------------------------------------------- /initialize */

function initializeCommand(ctx, deps) {
  return {
    name: 'initialize',
    description: '生成或补全运行骨架（默认只补不改；加 check＝只报告不写盘）',
    input: { hint: 'check' },
    async handler(invocation) {
      const agent = invocation && invocation.agent
      const cwd = callerCwd(ctx, agent)
      const check = words(invocation.rawInput).includes('check')
      if (!cwd) return reply(false, ['拿不到 cwd，无法判断要初始化哪个目录。'])
      let runInitialize = deps.runInitialize
      if (typeof runInitialize !== 'function') {
        return reply(false, ['初始化器未加载（bootstrap.js 不可用）。'])
      }
      // cwd 是本命令从 workingDirectory 服务解析出来的（**Agent 对象不带 cwd**）⇒ 必须显式传进去，
      // 否则初始化器认为「拿不到项目根」，把整份清单都报成需人工（真机症状：`待人工: [object Object]`×6）。
      const result = await runInitialize({ check, projectRoot: cwd, cwd }, { agent }, deps.config)
      const target = result.projectRoot || cwd
      const lines = [`**${check ? '检查' : '补全'}结果**：${target}`]
      // 回执条目是对象（{path,kind,status,statusNote}）：只取 path，直接 join 对象会变成 [object Object]。
      const namesOf = (rows) => (Array.isArray(rows) ? rows : [])
        .map((row) => (row && typeof row === 'object' ? String(row.path ?? '') : String(row)))
        .filter(Boolean)
      const push = (label, rows) => {
        const names = namesOf(rows)
        if (names.length) lines.push(`· ${label}：${names.join('、')}`)
      }
      push('已存在', result.existed)
      push('已创建', result.created)
      push('待人工', result.manual)
      if (result.system) lines.push(`· 体系层：${result.system.ok ? '齐全' : `缺 ${(result.system.missing || []).join('、')}`}`)
      if (check) push('将会创建', result.wouldCreate)
      if (!result.ok) {
        lines.push(
          result.error === 'project-root-unknown'
            ? `⚠️ 没能开工：拿不到可用的项目根目录（cwd=${cwd}）`
            : `⚠️ 没能开工：${result.error || '未知原因'}`,
        )
      }
      if (result.hint) lines.push('', result.hint)
      return reply(true, lines)
    },
  }
}

/* ----------------------------------------------------------------- /handoff */

/**
 * 交接默认任务文案（v0.8.5 修两处不成立的说法）：
 *   ① `_registry\` 只有**体系根**才有；独立项目根（例如 E:\test）是 `/initialize` 建的骨架，
 *      只有 PROJECT.md / KNOWLEDGE.md / KNOWLEDGE\ / 提案\ / projectlog\ / .gitignore ⇒ 不能一律让人去找交接包；
 *   ② 交接**不写任何文件**（只调 create_domain_session 并写注册册）⇒ 不能写"交接参数由 /handoff 写入"。
 */
export function defaultHandoffTask({ layer, key, cwd }) {
  const layerWord = layer === 'system' ? '体系主会话' : layer === 'project' ? '项目主会话' : '域会话'
  const hasPack = Boolean(cwd) && fs.existsSync(path.join(cwd, '_registry', 'handoff.json'))
  const readLine = hasPack
    ? '先读 `_registry\\handoff.json`（体系交接包）与 `PROJECT.md` §当前状态，再按 §下一步 开工。'
    : '先读 `PROJECT.md` §当前状态 与 §下一步 开工（这个目录**没有**体系交接包 `_registry\\handoff.json`，不用去找）。'
  return (
    `（换届接任）你接手 **${key}**（${layerWord}）。` +
    readLine +
    '本会话的 preset／权限档／模型已在建会话时设置好，不需要你再配；' +
    '交接**没有**写任何交接文件——在任身份只在注册册（registrations）里，裸跑 `/register` 可核对。'
  )
}

/** 已知的会话 id（在线顶层会话 ∪ 注册册 ∪ 在任声明）——短号解析只在**唯一命中**时接受。 */
function knownSessionIds(ctx, deps) {
  const ids = new Set()
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : ctx && ctx.agents
    const roots = agents && typeof agents.roots === 'function' ? agents.roots() : []
    for (const row of Array.isArray(roots) ? roots : []) if (row && row.id) ids.add(String(row.id))
  } catch {
    /* agents unavailable: the books below still answer */
  }
  try {
    const read = readRegistrations(deps.config.domainsFile)
    for (const row of listRegistrations(read.doc)) if (row.sessionId) ids.add(String(row.sessionId))
  } catch {
    /* ignore */
  }
  try {
    const loaded = loadDeclarations(deps.config.domainsFile)
    for (const row of (loaded && loaded.entries) || []) if (row && row.sessionId) ids.add(String(row.sessionId))
  } catch {
    /* ignore */
  }
  return [...ids]
}

/**
 * 会话目标解析（v0.8.7 `target=<现存会话>` 用）：
 *   · 完整 id（`session-<uuid>`）⇒ 原样接受，**不要求它现在在线**（离线会话也能接身份，只是拿不到活 Agent）；
 *   · 短号 `sess-xxxxxxxx` / 片段 ⇒ 只在**唯一命中**一条已知会话时接受（宁可拒绝，也不猜错人）。
 */
function resolveSessionTarget(ctx, deps, raw) {
  const value = textOf(raw)
  if (!value) return { ok: false, text: 'target 为空：要么 `target=new`（新建），要么给一个会话 id。' }
  if (isFullSessionId(value)) return { ok: true, id: value.trim() }
  if (isSessionIdLike(value)) {
    const prefix = `session-${value.trim().toLowerCase().replace(/^sess-?/, '')}`
    const hits = knownSessionIds(ctx, deps).filter((id) => id.toLowerCase().startsWith(prefix))
    if (hits.length === 1) return { ok: true, id: hits[0] }
    if (hits.length === 0) return { ok: false, text: `没有已知会话匹配 \`${value}\`（在线顶层会话、注册册、在任声明三处都查过了）。`, candidates: [] }
    return { ok: false, text: `短号 \`${value}\` 命中 ${hits.length} 条会话 ⇒ 不给猜，请给完整 id。`, candidates: hits }
  }
  return {
    ok: false,
    text: `target 要么是 \`new\`，要么是会话 id（\`session-<uuid>\` 或 \`sess-xxxxxxxx\`）；收到：\`${value}\``,
  }
}

/** 某个会话属于哪个项目（注册册 → 在线 cwd；推不出就 null）。权限闸用它判"项目主能不能动这个会话"。 */
function projectOfSession(ctx, deps, sessionId) {
  try {
    const read = readRegistrations(deps.config.domainsFile)
    const doc = read.doc || { registrations: {}, owners: {} }
    const role = identityOf(doc, sessionId).roles.find((row) => row.project)
    if (role) return String(role.project).toLowerCase()
  } catch {
    /* fall through to cwd */
  }
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : ctx && ctx.agents
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
    if (agent) {
      const project = projectNameOf(callerCwd(ctx, agent))
      if (project) return project
    }
  } catch {
    /* treat as unknown */
  }
  return null
}

/** 这个会话现在有没有活 Agent（不看声明、不看索引）。 */
function hasLiveAgent(ctx, sessionId) {
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : ctx && ctx.agents
    return Boolean(agents && typeof agents.get === 'function' && agents.get(sessionId))
  } catch {
    return false
  }
}

/**
 * `/handoff target=<会话id>`：把**在任身份**交给一个已经存在的会话。
 * 只写注册册（体系/项目两层）；域层归 owners，注册册不碰（不造第二本台账）。
 * 刻意**不唤醒**目标会话：唤醒语义属于 send_to_domain(wake=…)，交接不该顺手叫醒别人。
 */
async function handoffToExisting({ ctx, deps, agent, sessionId, identity, role, layer, key, target, retireNow, title }) {
  const resolved = resolveSessionTarget(ctx, deps, target)
  if (!resolved.ok) {
    const lines = [resolved.text]
    if (resolved.candidates && resolved.candidates.length) {
      lines.push(`· 候选：${resolved.candidates.slice(0, 8).map((id) => `\`${id}\``).join('、')}`)
    }
    lines.push('· 也可以 `target=new` 新建一条接班会话。')
    return reply(false, lines)
  }
  const targetId = resolved.id
  if (targetId === sessionId) {
    return reply(false, ['target 就是你自己 ⇒ 不用交接。要刷新在岗时间请裸跑 `/register`。'])
  }
  if (layer === 'domain') {
    return reply(false, [
      `域层（\`${key}\`）的负责人写在**在任声明**（owners）里，注册册只管体系/项目两层 ⇒ 这里不能直接转给别的会话。`,
      `· 让对方窗口自己执行 \`/register domain ${key} takeover\`（它会写 owners 并留痕）。`,
      '· 体系主 / 项目主的交接用 `target=<会话id>` 可以。',
    ])
  }
  if (targetId === sessionId) {
    return reply(false, ['target 就是你自己 ⇒ 不用交接。要刷新在岗时间请裸跑 `/register`。'])
  }

  const project = role && role.project ? role.project : String(key).split(':')[0]
  const written = upsertRegistration(
    deps.config.domainsFile,
    {
      layer,
      project,
      sessionId: targetId,
      by: sessionId,
      title,
      note: `由 ${sessionId} 用 /handoff target= 交接`,
    },
    { force: true, by: sessionId },
  )
  if (!written.ok || !written.written) {
    return reply(false, [
      `交接失败：${written.error || written.reason || '未知原因'}`,
      ...(written.hint ? [written.hint] : []),
      '· 一个字都没写：在任身份还在你身上，可以重试或改用 `target=new`。',
    ])
  }
  const owned = ownedDomains(deps.config.domainsFile, sessionId)
  const live = hasLiveAgent(ctx, targetId)
  const lines = [
    `**交接完成**：\`${key}\` 的在任身份已转给 ${targetId}`,
    `· 注册册已写：${(written.record && written.record.note) || '(已写入)'}`,
    live
      ? '· 那个窗口现在开着：切过去让它裸跑 `/register` 确认身份。'
      : '· 那个窗口现在**没开**（离线会话没有活 Agent）⇒ 先人工点开它，再让它 `/register`。',
    '· 没有走 create_domain_session：插件**不会**主动唤醒一个已存在的会话。',
  ]
  if (owned.length) {
    lines.push(`· ⚠️ 你名下还有 ${owned.length} 个域的在任声明（${owned.map((row) => row.key).join('、')}），这次没有动它们。`)
  }
  if (retireNow) {
    if (typeof deps.retireSelf === 'function') {
      const retired = await deps.retireSelf({ agent, rawInput: '交接后立即退役（/handoff target=… retire=now）' })
      lines.push('', '**前任退役（当场执行）**：', retired && retired.text ? retired.text : '（退役没有回执）')
    } else {
      lines.push('', '⚠️ retire=now 没有执行：退役实现不可用（插件未完整加载）⇒ 请手动 `/retire`。')
    }
  } else {
    lines.push('', '⚠️ 你**还在任**：注册册是强制覆盖，但退役不会自己发生——确认对方接住了，就在本窗口 `/retire`。')
  }
  return reply(true, lines)
}

function handoffCommand(ctx, deps) {
  return {
    name: 'handoff',
    description: '开一个接班会话并转移职责（默认按参数表：体系 cordis / 项目 standard / 域 standard）',
    input: { hint: '[wizard] | [key=<你持有的身份键>] [model=provider/id] [preset=<id>] [perm=<档>] [target=new|<会话id>] [title=文字] [task=文字] [retire=now]' },
    async handler(invocation) {
      const agent = invocation && invocation.agent
      const sessionId = callerId(agent)
      if (!sessionId) return reply(false, ['拿不到调用者会话 id，无法交接。'])
      const cwd = callerCwd(ctx, agent)
      const parsed = parseFlags(words(invocation && invocation.rawInput))
      // v0.8.7：分步表单（`/handoff wizard` 打开的本地页面）把结构化参数直接交进来，
      // 与命令行**共用这一份实现**——不写第二套建会话逻辑。
      const given = (invocation && invocation.params) || {}
      const param = (name) =>
        given[name] !== undefined && given[name] !== null ? given[name] : parsed.values.get(name)

      // 分步表单入口：只回一个本地页面地址，不建任何东西（宿主弹窗壳不支持链式多级，所以"多级"落在这里）。
      if (parsed.rest[0] === 'wizard' || parsed.flags.has('wizard')) {
        const origin = webOrigin(ctx)
        if (!origin) {
          return reply(false, [
            '拿不到宿主 Web 端口 ⇒ 打不开分步表单。',
            '可以直接用命令行参数：`/handoff model=provider/id preset=<id> perm=<档>`。',
          ])
        }
        const url = `${origin}/api/dsh-domain-bridge/handoff-wizard?sessionId=${encodeURIComponent(sessionId)}`
        return reply(true, [
          '**分步设置交接参数**（一步步选，最后确认才建）：',
          '',
          url,
          '',
          '· 页面上能改：层级（只能在你**真持有**的身份里选）、模式、模型、权限档、标题、开工任务、建完是否顺手退役你。',
          '· 表单只在 127.0.0.1 上可访问；它调的还是同一条交接实现，不是第二套。',
        ])
      }

      const read = readRegistrations(deps.config.domainsFile)
      const doc = read.doc || { registrations: {}, owners: [] }
      const identity = identityOf(doc, sessionId)
      // 层与键：默认按当前身份的第一条；`key=` 只允许在**你真持有**的身份里选（不许替别人的键做主）。
      // 优先取**非域层**（体系/项目）——一个会话可能同时持有域声明，而域交接不走注册册（见下方拒绝分支）。
      const mainRoles = identity.roles.filter((row) => row.layer !== 'domain')
      const wantedKey = textOf(param('key'))
      let role = mainRoles.length ? mainRoles[0] : identity.roles.length ? identity.roles[0] : null
      if (wantedKey) {
        role = identity.roles.find((row) => String(row.key).toLowerCase() === wantedKey.toLowerCase()) || null
        if (!role) {
          return reply(false, [
            `你并不持有 \`${wantedKey}\` 这个身份 ⇒ 不能拿它去交接。`,
            `· 你现在持有：${identity.roles.map((row) => row.key).join('、') || '（没有任何注册身份）'}`,
          ])
        }
      }
      const layer = role ? role.layer : 'project'
      const key = role ? role.key : `${projectNameOf(cwd) || 'unknown'}:main`

      const modelValue = textOf(param('model')) || null
      let model = null
      if (modelValue) {
        const slash = modelValue.indexOf('/')
        if (slash <= 0) return reply(false, [`model 要写成 provider/model，例如 \`wb/cn:deepseek-v4.1-flash\`；收到：${modelValue}`])
        model = { provider: modelValue.slice(0, slash), model: modelValue.slice(slash + 1) }
      }
      const preset = textOf(param('preset')) || HANDOFF_DEFAULTS.presets[layer] || 'standard'
      // v0.8.5：权限档**默认跟随部署配置**（config.domainSessionPreset），不再在这里硬编码
      // danger-full-access —— 硬编码会悄悄盖掉 v0.6.4 把默认收窄到 workspace-write 的安全意图。
      const perm = textOf(param('perm')) || null
      const target = textOf(param('target')) || 'new'
      const retireNow = String(param('retire') ?? '') === 'now' || parsed.flags.has('retire-now')
      const title =
        textOf(param('title')) ||
        `【${layer === 'system' ? '体系' : layer === 'project' ? '项目' : '域'}】${key} 接任`

      // v0.8.7：**交给一个已经开着的会话**。v1 以前这里直接拒绝（"只能新建"），
      // 于是"换届给已存在的窗口"这条最自然的路被堵死——只能先 retire 再让对方自己 /register。
      if (!/^new$/i.test(target)) {
        return handoffToExisting({ ctx, deps, agent, sessionId, identity, role, layer, key, target, retireNow, title })
      }
      if (!deps.defs || !deps.defs.create) return reply(false, ['create 工具不可用（插件未完整加载），无法新建接班会话。'])

      const task = textOf(param('task')) || defaultHandoffTask({ layer, key, cwd })
      const created = await deps.defs.create.execute(
        {
          // v0.8.5：**按层建会话**。以前这里把体系/项目键当域塞进 domain 参数、又不传 claim，
          // 于是新会话收到的身份摘要是「你被指派到 X，要接任就 /register domain X」——
          // 主会话换届被当成了域会话换届。layer 让工厂按层选账本、按层出文案。
          layer,
          domain: key,
          task,
          agentPreset: preset,
          ...(perm ? { permissionPreset: perm } : {}),
          ...(model ? { model } : {}),
          title,
          claim: true,
          allowExistingOwner: true,
        },
        { agent },
      )
      const lines = ['**交接回执**（来自 create_domain_session）', '```json', JSON.stringify(created, null, 2), '```']
      const ownerChanged = created && created.claim && created.claim.outcome && created.claim.outcome !== 'conflict'
      lines.push(
        '',
        ownerChanged
          ? `· 在任身份已转给新会话（${created.claim.outcome}）。`
          : '· ⚠️ 在任身份**没有**转成（见回执 claim），先看回执再决定。',
        '· 新窗口要你自己在左侧栏点开：宿主没有 Host→前台 的导航通道。',
      )
      // v0.8.5：**「前任不会自己退役」是真的**——没有任何机制会因为"新会话收到了回执"就把旧会话停掉。
      // 所以把这件事变成一次显式选择：默认不动（S4-A：先确认接任者没建错），或当场退役（retire=now）。
      if (created && created.created === true) {
        if (retireNow) {
          if (typeof deps.retireSelf === 'function') {
            const retired = await deps.retireSelf({ agent, rawInput: '交接后立即退役（/handoff retire=now）' })
            lines.push('', '**前任退役（当场执行）**：', retired && retired.text ? retired.text : '（退役没有回执）')
          } else {
            lines.push('', '⚠️ retire=now 没有执行：退役实现不可用（插件未完整加载）⇒ 请手动 `/retire`。')
          }
        } else {
          lines.push(
            '',
            '⚠️ **本会话还在任**：退役不会自己发生。确认新窗口真的建对了，就在**本窗口**执行 `/retire`；',
            '   想一步到位的话，下次直接选菜单里那条「建完立刻退役我」。',
          )
        }
      }
      return reply(true, lines)
    },
  }
}

/* ------------------------------------------------------------------ /retire */

function retireCommand(ctx, deps) {
  return {
    name: 'retire',
    description: '结束当前会话的任职：释放自己持有的域 + 撤掉注册 + 按 session 级暂停（不删任何历史）',
    input: { hint: '[原因]' },
    async handler(invocation) {
      const agent = invocation && invocation.agent
      const sessionId = callerId(agent)
      if (!sessionId) return reply(false, ['拿不到调用者会话 id，无法退役。'])
      const reason = textOf(invocation.rawInput) || '人工退役（/retire）'
      const lines = []

      const read = readRegistrations(deps.config.domainsFile)
      if (read.error) return reply(false, [`域名册读不懂（${read.error}）⇒ 中止退役，避免误删。`])
      const doc = read.doc
      const mine = listRegistrations(doc).filter((row) => row.sessionId === sessionId)
      for (const row of mine) {
        const removed = removeRegistration(deps.config.domainsFile, row.key, sessionId)
        lines.push(removed.ok && removed.removed ? `· 已撤注册：${row.key}（${layerWord(row.layer)}）` : `· 撤注册失败：${row.key}（${removed.reason || removed.error || '?'}）`)
      }

      const domains = ownedDomains(deps.config.domainsFile, sessionId)
      if (domains.length && deps.defs && deps.defs.release) {
        for (const row of domains) {
          const released = await deps.defs.release.execute({ domain: row.key, note: reason }, { agent })
          lines.push(`· 域 ${row.key}：${released && released.outcome ? released.outcome : JSON.stringify(released).slice(0, 200)}`)
        }
      } else if (!domains.length) {
        lines.push('· 你没有持有任何域（不需要释放）')
      }

      try {
        const { writeDomainStateAtomic } = await import('./pause.js')
        const st = writeDomainStateAtomic(deps.config.stateDir, sessionId, {
          paused: true,
          pausedAt: new Date().toISOString(),
          pausedBy: sessionId,
          // 落盘字段名是 `note`（normalizeDomainState 只认它）；写成 pauseNote 会**读不回来**——
          // 那是输出名。v0.8.5 修：以前 /retire 写的退役原因在 list_* 里一直是空的。
          note: `退役：${reason}`,
        }, 'session')
        lines.push(st && st.ok ? '· 已按 session 级暂停（退役标记）' : `· session 级暂停失败：${(st && st.error) || '?'}`)
      } catch (error) {
        lines.push(`· session 级暂停失败：${error?.message || String(error)}`)
      }

      // 宿主现已支持会话自己改标题：退役时把自己标成（已退役），下一个窗口一眼能认出来。
      try {
        const retired = markRetired(ctx, agent, 'retire-command')
        lines.push(retired && retired.ok ? '· 标题已加「（已退役）」' : `· 标题未改：${(retired && (retired.reason || retired.hint)) || '未知原因'}`)
      } catch (error) {
        lines.push(`· 标题未改：${error?.message || String(error)}`)
      }

      lines.unshift(`**退役完成**：${sessionId}`)
      lines.push('', '⚠️ 退役≠删除：域墓碑、注册历史、会话存档都还在；要找回这个窗口需要人工点开。')
      return reply(true, lines)
    },
  }
}

/* ------------------------------------------------------------- /pause family */

/**
 * 只读一屏：现在**真的被按下的**每一级（来自 state 目录，不猜、不缓存）。
 * `/pause` 与 `/resume` 裸跑都走这里——恢复功能有了，就得能一眼看出"按过什么、谁按的、什么时候"。
 */
function pausedLines(deps, sessionId, name) {
  const scopeWord = { domain: '域', session: '单会话', project: '项目', global: '全局' }
  const lines = []
  let entries = []
  try {
    const states = loadDomainStates(deps?.config?.stateDir)
    entries = (states && Array.isArray(states.entries) ? states.entries : []).filter((row) => row && row.paused === true)
  } catch {
    entries = []
  }
  lines.push(`**当前的暂停记录**：${entries.length ? `${entries.length} 条` : '没有'}`)
  for (const row of entries) {
    const who = row.pausedBy ? `由 ${row.pausedBy}` : '（未记录谁按的）'
    const when = row.pausedAt ? new Date(row.pausedAt).toLocaleString('zh-CN') : '（未记录时间）'
    const mine = row.scope === 'session' && String(row.key) === sessionId ? '　← 就是你' : ''
    lines.push(`· [${scopeWord[row.scope] || row.scope}] \`${row.key}\`　${who}，${when}${mine}`)
    const reason = row.note || row.pauseNote
    if (reason) lines.push(`  · 备注：${reason}`)
  }
  const sessionPaused = entries.some((row) => row.scope === 'session' && String(row.key) === sessionId)
  lines.push(
    '',
    sessionPaused
      ? '⚠️ **你自己这一级被按着** ⇒ `/resume self` 才能恢复（别的层级解开也还压着你）。'
      : `用法：\`/${name} self|domain <项目:域>|session <会话id>|project|global\`（弹窗菜单里直接点，不用打）。`,
  )
  return lines
}

function resolveGate(deps, sessionId, cwd) {  const read = readRegistrations(deps.config.domainsFile)
  const doc = read.doc || { registrations: {}, owners: [] }
  const identity = identityOf(doc, sessionId)
  const project = projectNameOf(cwd)
  return { read, identity, project }
}

/**
 * `/pause` 与 `/resume` 是同一个开关的两头（v0.8.5 补上恢复：以前只有"按下去"、没有"抬起来"，
 * 恢复只能记 `set_domain_state(state=active)` 那条工具调用）。**一份实现两个命令**，避免口径漂移。
 */
function stateCommand(ctx, deps, mode) {
  const isPause = mode === 'pause'
  const name = isPause ? 'pause' : 'resume'
  const targetState = isPause ? 'paused' : 'active'
  return {
    name,
    description: isPause
      ? '按授权范围暂停协作活动（self/domain/session 任何人；project 需项目主或体系主；global 需体系主）'
      : '按授权范围恢复协作活动（与 pause 同一套授权；按了几级就要抬几级）',
    input: { hint: 'self|domain <项目:域>|session <会话id>|project|global [原因]' },
    async handler(invocation) {
      const agent = invocation && invocation.agent
      const sessionId = callerId(agent)
      if (!sessionId) return reply(false, ['拿不到调用者会话 id。'])
      const tokens = words(invocation.rawInput)
      const level = (tokens[0] || '').toLowerCase()
      // 裸跑 `/pause` 或 `/resume`＝只读：列出**现在真的被按下的**每一级（v0.8.5 加的恢复面，
      // 没有这一屏的话"我到底按过什么"只能去翻 state 目录）。
      if (tokens.length === 0) return reply(true, pausedLines(deps, sessionId, name))
      // v0.8.5：加上 `domain <键>`——菜单里「按域」那一组要有个能真跑的命令接住它。
      // v0.8.7：加上 `session <会话id>`——"别人的单会话暂停"以前只能靠 set_domain_state 工具，没有命令入口。
      const takesKey = level === 'domain' || level === 'session'
      const rawKey = takesKey ? tokens[1] || '' : ''
      const reason = tokens.slice(takesKey ? 2 : 1).join(' ')
      if (!['self', 'domain', 'session', 'project', 'global'].includes(level)) {
        return reply(false, [
          `用法：\`/${name} self|domain <项目:域>|session <会话id>|project|global [原因]\``,
          '· self＝只动自己（任何会话都能按）',
          '· domain＝动一个域（该域负责人、项目主或体系主可按下）',
          '· session＝动某一条会话（自己 / 体系主 / 该会话所属项目的主会话）',
          '· project＝动整个项目（需项目主会话或体系主会话）',
          '· global＝动全局（需体系主会话）',
        ])
      }
      if (level === 'domain' && !rawKey) {
        return reply(false, [`用法：\`/${name} domain <项目:域> [原因]\`（例如 \`/${name} domain tixiweihu:docs\`）`, '菜单里有按域的现成选项，不用手打。'])
      }
      let sessionKey = ''
      if (level === 'session') {
        if (!rawKey) {
          return reply(false, [
            `用法：\`/${name} session <会话id> [原因]\``,
            '· 自己用 `self` 更短；动别人要给完整 id（`session-<uuid>`）或唯一短号（`sess-xxxxxxxx`）。',
          ])
        }
        const resolved = resolveSessionTarget(ctx, deps, rawKey)
        if (!resolved.ok) {
          const lines = [resolved.text]
          if (resolved.candidates && resolved.candidates.length) {
            lines.push(`· 候选：${resolved.candidates.slice(0, 8).map((id) => `\`${id}\``).join('、')}`)
          }
          return reply(false, lines)
        }
        sessionKey = resolved.id
      }
      const cwd = callerCwd(ctx, agent)
      const gate = resolveGate(deps, sessionId, cwd)
      const check = checkAuthority(gate, level, sessionId, {
        deps,
        domainKey: rawKey,
        sessionKey,
        sessionProject: sessionKey ? projectOfSession(ctx, deps, sessionKey) : null,
      })
      if (!check.ok) return reply(false, check.lines)
      const target = level === 'self'
        ? { scope: 'session', key: sessionId }
        : level === 'session'
          ? { scope: 'session', key: check.key || sessionKey }
          : level === 'domain'
            ? { scope: 'domain', key: check.key }
            : { scope: level, key: level === 'global' ? '*' : check.project }
      if (!deps.defs || !deps.defs.pause) return reply(false, ['set_domain_state 不可用（插件未完整加载）。'])
      const result = await deps.defs.pause.execute(
        {
          domain: target.key,
          scope: target.scope,
          state: targetState,
          note: reason || (isPause ? '人工暂停（/pause）' : '人工恢复（/resume）'),
          confirm: target.scope === 'global' ? true : undefined,
        },
        { agent },
      )
      if (!isPause) {
        return reply(true, [
          `**恢复已执行**：${level}${level === 'global' ? '' : `（${target.key}）`}`,
          '· 政策轴＝活动。恢复时**重新评估 OR**：只重投「现在不再被任何一级压着」的排队消息，',
          '  仍被别的级压着的保持 pending（回执里 drain.stillPausedBy 会列出来）。',
          '· ⚠️ 恢复不会自己唤醒离线会话——被按下的目标不会被别人自动叫醒。',
          '',
          '```json', JSON.stringify(result, null, 2), '```',
        ])
      }
      return reply(true, [
        `**暂停已设置**：${level}${level === 'global' ? '' : `（${target.key}）`}`,
        '· 政策轴＝已暂停：新的插件介导投递/新建会话会被拦下并落盘入队。',
        '· ⚠️ **正在跑的回合不会被打断**——暂停是政策闸，不是中断器。',
        '',
        '```json', JSON.stringify(result, null, 2), '```',
        '恢复：`/resume <同一层级>`（菜单里有），不用再记工具调用。',
      ])
    },
  }
}

function pauseCommand(ctx, deps) {
  return stateCommand(ctx, deps, 'pause')
}

function resumeCommand(ctx, deps) {
  return stateCommand(ctx, deps, 'resume')
}

/* --------------------------------------------------- pause-all 的二次确认（v0.8.7 真做） */

/**
 * 二次确认的时效：60 秒。
 * v0.8.0~0.8.6 这里只有文案——第一次调用只是回一句"请在 60 秒内再发一次"，服务端**不记任何状态**，
 * 于是 `--confirm` 一次就能过、60 秒也从来没被检查过。现在把待确认落盘（一会话一文件）：
 * 首次写、带 --confirm 时校验（同一层级 + 未超时）后再删。
 */
const PAUSE_ALL_TTL_MS = 60 * 1000

function pauseAllPendingFile(config, sessionId) {
  return path.join(stateRoot(config.stateDir), 'pause-all-pending', `${sessionId}.json`)
}

function writePauseAllPending(config, sessionId, payload) {
  try {
    const file = pauseAllPendingFile(config, sessionId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, file }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}

function readPauseAllPending(config, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pauseAllPendingFile(config, sessionId), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function clearPauseAllPending(config, sessionId) {
  try {
    fs.rmSync(pauseAllPendingFile(config, sessionId), { force: true })
    return true
  } catch {
    return false
  }
}

function pauseAllCommand(ctx, deps) {
  return {
    name: 'pause-all',
    description: '紧急暂停入口：self 随时；project/global 需一次确认 + 必填原因 + 审计留痕',
    input: { hint: '<self|project|global> <原因> [--confirm]' },
    async handler(invocation) {
      const agent = invocation && invocation.agent
      const sessionId = callerId(agent)
      if (!sessionId) return reply(false, ['拿不到调用者会话 id。'])
      const parsed = parseFlags(words(invocation.rawInput))
      const level = (parsed.rest[0] || '').toLowerCase()
      const reason = parsed.rest.slice(1).join(' ')
      if (!['self', 'project', 'global'].includes(level)) {
        return reply(false, ['用法：`/pause-all <self|project|global> <原因> [--confirm]`', '· 必须写原因；project/global 第一次只会返回确认命令，带 `--confirm` 才真的执行。'])
      }
      if (!reason) return reply(false, ['`/pause-all` 必须写原因（会进审计）。例如：`/pause-all global 注入风险，先停住 原因`。'])
      if (level !== 'self' && !parsed.flags.has('confirm')) {
        const wrote = writePauseAllPending(deps.config, sessionId, { scope: level, reason, at: new Date().toISOString() })
        return reply(true, [
          `这是**强制暂停 ${level}**，还没有执行。`,
          `确认请在 60 秒内再发一次：\`/pause-all ${level} ${reason} --confirm\``,
          wrote.ok
            ? '· 已记下这次待确认（60 秒后自动失效，且只认发起的这条会话）。'
            : `· ⚠️ 待确认没落盘（${wrote.error}）⇒ 下一步的 --confirm 一定会被拒。`,
          '（任意已注册会话都可以发起；确认与原因会写审计。）',
        ])
      }
      if (level !== 'self') {
        // v0.8.7：--confirm 必须**对得上刚才那次待确认**——不再"一次 --confirm 就能过"。
        const pending = readPauseAllPending(deps.config, sessionId)
        if (!pending) {
          return reply(false, [
            '没有待确认的强制暂停：`--confirm` 不能一步到位。',
            `先发一次不带 --confirm 的：\`/pause-all ${level} ${reason}\``,
          ])
        }
        if (String(pending.scope) !== level) {
          return reply(false, [
            `待确认的是 **${pending.scope}**，不是 ${level} ⇒ 拒执行（防"确认了 A 却执行 B"）。`,
            `先发一次 \`/pause-all ${level} ${reason}\` 重新确认。`,
          ])
        }
        const ageMs = Date.now() - Date.parse(pending.at)
        if (!Number.isFinite(ageMs) || ageMs > PAUSE_ALL_TTL_MS) {
          clearPauseAllPending(deps.config, sessionId)
          return reply(false, [
            '确认已过期（超过 60 秒）⇒ 没有执行。',
            `重新来一次：先 \`/pause-all ${level} ${reason}\`，再在 60 秒内带 --confirm 发。`,
          ])
        }
        clearPauseAllPending(deps.config, sessionId)
      }
      const cwd = callerCwd(ctx, agent)
      const gate = resolveGate(deps, sessionId, cwd)
      const target = level === 'self' ? { scope: 'session', key: sessionId } : { scope: level, key: level === 'global' ? '*' : gate.project }
      if (target.scope !== 'session' && !target.key) return reply(false, ['推不出项目名（cwd 拿不到）⇒ 无法强制暂停项目。'])
      if (!deps.defs || !deps.defs.pause) return reply(false, ['set_domain_state 不可用（插件未完整加载）。'])
      const result = await deps.defs.pause.execute(
        { domain: target.key, scope: target.scope, state: 'paused', note: `强制暂停：${reason}`, confirm: target.scope === 'global' ? true : undefined },
        { agent },
      )
      const audit = appendAudit(deps.config, { action: 'pause-all', scope: target.scope, key: target.key, by: sessionId, reason })
      return reply(true, [
        `**强制暂停已执行**：${level}（${target.key}）`,
        audit.ok ? `· 审计已落盘：${audit.file}` : `· ⚠️ 审计写入失败：${audit.error}`,
        '· ⚠️ 正在跑的回合不会被打断；恢复要人显式按 active。',
        '```json', JSON.stringify(result, null, 2), '```',
      ])
    },
  }
}

function checkAuthority(gate, level, sessionId, extra = {}) {
  if (level === 'self') return { ok: true }
  if (gate.read.error) {
    return { ok: false, lines: [`注册册读不懂（${gate.read.error}）⇒ 判不出身份，按规则拒绝。`, '先修好 _registry\\domains.json 再暂停。'] }
  }
  const { identity, project } = gate
  if (level === 'session') {
    // v0.8.7：单会话这一级支持**指定 id**（以前只能 `self`，别人的单会话暂停没有命令入口）。
    // 授权：自己 ∪ 体系主 ∪ 该会话所属项目的主会话。
    const key = String(extra.sessionKey || '').trim()
    if (!key) return { ok: false, lines: ['要动哪一条会话？写法：`/pause session <会话id>`。'] }
    if (key === sessionId) return { ok: true, key }
    if (identity.systemMain) return { ok: true, key }
    const projectOfTarget = String(extra.sessionProject || '').trim().toLowerCase()
    if (projectOfTarget && identity.projectMains.includes(projectOfTarget)) return { ok: true, key }
    return {
      ok: false,
      lines: [
        `你（${sessionId}）既不是这条会话本身，也不是它的项目主或体系主 ⇒ 拒绝动它。`,
        `· 目标：${key}${projectOfTarget ? `（项目 ${projectOfTarget}）` : '（推不出属于哪个项目）'}`,
        '· 出路：让它自己 `/pause self`；或由体系主 / 该项目的项目主来按。',
      ],
    }
  }
  if (level === 'domain') {
    // 域级暂停：**要求这个域真的存在**（域级暂停挂在声明册的一个 key 上，它不是"整台机器"或
    // "某个项目"级别的开关）；按下的人要么是该域负责人，要么是项目主 / 体系主。
    const key = String(extra.domainKey || '').trim()
    if (!key) return { ok: false, lines: ['要暂停哪个域？写法：`/pause domain <项目:域>`。'] }
    const loaded = loadDeclarations(extra.deps?.config?.domainsFile)
    const entry = loaded?.byKey?.get(key.toLowerCase()) || null
    if (!entry) {
      return {
        ok: false,
        lines: [
          `域名册里没有「${key}」这条在任声明 ⇒ 没有可暂停的域。`,
          '· 先看现有域：`/register`（或问一句"列出在任声明"）',
          '· 要暂停整个项目用 `/pause project`；只停自己用 `/pause self`',
        ],
      }
    }
    const isProjectMain = identity.projectMains.includes(entry.project) || identity.roles.some((role) => role.layer === 'project' && role.project === entry.project)
    if (entry.sessionId === sessionId || identity.systemMain || isProjectMain) return { ok: true, key: entry.key, project: entry.project }
    return {
      ok: false,
      lines: [
        `你（${sessionId}）既不是「${entry.key}」的负责人，也不是它所在项目的主会话 ⇒ 拒绝暂停这个域。`,
        `· 该域负责人：${entry.sessionId}`,
        '· 出路：让负责人自己按；或由项目主/体系主按；只停自己用 `/pause self`。',
      ],
    }
  }
  if (level === 'project') {
    const isProjectMain = identity.projectMains.includes(project) || identity.roles.some((role) => role.layer === 'project' && role.project === project)
    if (identity.systemMain || isProjectMain) return { ok: true, project }
    return {
      ok: false,
      lines: [
        `你（${sessionId}）不是项目 \`${project || '(推不出)'}\` 的主会话，也不是体系主会话 ⇒ 拒绝暂停整个项目。`,
        `· 本项目主会话：${identity.roles.filter((role) => role.layer === 'project').map((role) => role.key).join('、') || '（没有注册记录）'}`,
        '· 出路：让项目主会话执行；或先 `/register project`（若确实没有主会话）；或只暂停你自己：`/pause self`。',
      ],
    }
  }
  if (level === 'global') {
    if (identity.systemMain) return { ok: true, project }
    return {
      ok: false,
      lines: [
        `你（${sessionId}）不是体系主会话 ⇒ 拒绝暂停全局。`,
        '· 出路：由体系主会话执行；或只暂停你自己：`/pause self`；紧急情况用 `/pause-all global <原因> --confirm`（会留审计）。',
      ],
    }
  }
  return { ok: false, lines: ['未知层级。'] }
}

function appendAudit(config, record) {
  try {
    const dir = stateRoot(config.stateDir)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'audit.jsonl')
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', 'utf8')
    return { ok: true, file }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}

/* ---------------------------------------------------------------- registration */

/** Build the seven command definitions (pure; no host calls). */
export function buildCommandDefs(ctx, deps) {
  // retire 先建：handoff 的「交接后立刻退役我」要**复用同一份退役实现**，不能再写一份。
  const retire = retireCommand(ctx, deps)
  const shared = { ...deps, retireSelf: retire.handler }
  return [
    registerCommand(ctx, shared),
    initializeCommand(ctx, shared),
    handoffCommand(ctx, shared),
    retire,
    pauseCommand(ctx, shared),
    resumeCommand(ctx, shared),
    pauseAllCommand(ctx, shared),
  ]
}

/**
 * Register every command on the Host command surface.
 * A missing `commands` service degrades to "not registered" (never fails the plugin load),
 * and a name collision is reported and skipped instead of overwriting somebody else's command.
 */
export function registerCommandDefinitions(ctx, definitions) {
  const service = (ctx && ctx.commands) || (ctx && typeof ctx.get === 'function' ? ctx.get('commands') : null)
  if (!service || typeof service.register !== 'function') {
    warn('commands service unavailable: slash commands not registered (tools only)')
    return () => {}
  }
  const disposers = []
  for (const definition of definitions) {
    try {
      const dispose = service.register({
        name: definition.name,
        description: definition.description,
        ...(definition.input ? { input: definition.input } : {}),
        async handler(invocation) {
          try {
            return await definition.handler(invocation)
          } catch (error) {
            warn(`/${definition.name} failed: ${error?.message || String(error)}`)
            return { kind: 'error', text: `/${definition.name} 执行失败：${error?.message || String(error)}` }
          }
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
      warn(`registered command /${definition.name}`)
    } catch (error) {
      warn(`command /${definition.name} not registered (name collision?): ${error?.message || String(error)}`)
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* a dispose failure must never block the others */
      }
    }
  }
}

/** Backwards-compatible entry: build the six definitions and register them. */
export function registerCommands(ctx, deps) {
  return registerCommandDefinitions(ctx, buildCommandDefs(ctx, deps))
}
