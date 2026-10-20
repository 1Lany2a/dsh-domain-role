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
import { sessionOf, markRetired } from './session-factory.js'
import { stateRoot } from './shared.js'
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
            '· `/register system --confirm`　（随后 `/initialize` 会补上 SYSTEM-OVERVIEW.md）',
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

function handoffCommand(ctx, deps) {
  return {
    name: 'handoff',
    description: '开一个接班会话并转移职责（默认按参数表：体系 cordis / 项目 standard / 域 standard）',
    input: { hint: '[model=provider/id] [preset=<id>] [perm=<档>] [target=new|<sessionId>] [task=文字]' },
    async handler(invocation) {
      const agent = invocation && invocation.agent
      const sessionId = callerId(agent)
      if (!sessionId) return reply(false, ['拿不到调用者会话 id，无法交接。'])
      const cwd = callerCwd(ctx, agent)
      const parsed = parseFlags(words(invocation.rawInput))
      const read = readRegistrations(deps.config.domainsFile)
      const doc = read.doc || { registrations: {}, owners: [] }
      const identity = identityOf(doc, sessionId)
      const layer = identity.roles.length ? identity.roles[0].layer : 'project'
      const key = identity.roles.length ? identity.roles[0].key : `${projectNameOf(cwd) || 'unknown'}:main`

      const modelValue = parsed.values.get('model') || null
      let model = null
      if (modelValue) {
        const slash = modelValue.indexOf('/')
        if (slash <= 0) return reply(false, [`model 要写成 provider/model，例如 \`wb/cn:deepseek-v4.1-flash\`；收到：${modelValue}`])
        model = { provider: modelValue.slice(0, slash), model: modelValue.slice(slash + 1) }
      }
      const preset = parsed.values.get('preset') || HANDOFF_DEFAULTS.presets[layer] || 'standard'
      // v0.8.5：权限档**默认跟随部署配置**（config.domainSessionPreset），不再在这里硬编码
      // danger-full-access —— 硬编码会悄悄盖掉 v0.6.4 把默认收窄到 workspace-write 的安全意图。
      const perm = parsed.values.get('perm') || null
      const target = parsed.values.get('target') || 'new'

      if (target !== 'new') {
        return reply(false, [
          `v1 只支持「新建会话」交接（收到 target=${target}）。`,
          '把职责交给一个**现存会话**还没做：`create_domain_session` 只能新建。',
          '你可以先 `retire`，再让对方会话自己 `/register`；或直接 `create_domain_session` 新建。',
        ])
      }
      if (!deps.defs || !deps.defs.create) return reply(false, ['create 工具不可用（插件未完整加载），无法新建接班会话。'])

      const task = parsed.values.get('task') ||
        `（换届接任）你接手 **${key}**。先读 _registry\\handoff.json 与 PROJECT.md §当前状态，再按 §下一步 开工；交接参数由 /handoff 写入。`
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
          title: `【${layer === 'system' ? '体系' : layer === 'project' ? '项目' : '域'}】${key} 接任`,
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
          ? `· 在任身份已转给新会话（${created.claim.outcome}）——**前任不会自动退役**：先确认接班会话真的建对了，再执行 \`/retire\`。`
          : '· ⚠️ 在任身份**没有**转成（见回执 claim），先看回执再决定。',
        '· 新窗口要你自己在左侧栏点开：宿主没有 Host→前台 的导航通道。',
      )
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
          pauseNote: `退役：${reason}`,
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

function resolveGate(deps, sessionId, cwd) {
  const read = readRegistrations(deps.config.domainsFile)
  const doc = read.doc || { registrations: {}, owners: [] }
  const identity = identityOf(doc, sessionId)
  const project = projectNameOf(cwd)
  return { read, identity, project }
}

function pauseCommand(ctx, deps) {
  return {
    name: 'pause',
    description: '按授权范围暂停协作活动（self/domain 任何人；project 需项目主或体系主；global 需体系主）',
    input: { hint: 'self|domain <项目:域>|project|global [原因]' },
    async handler(invocation) {
      const agent = invocation && invocation.agent
      const sessionId = callerId(agent)
      if (!sessionId) return reply(false, ['拿不到调用者会话 id。'])
      const tokens = words(invocation.rawInput)
      const level = (tokens[0] || '').toLowerCase()
      // v0.8.5：加上 `domain <键>`——菜单里「按域暂停」一行要有个能真跑的命令接住它。
      const domainKey = level === 'domain' ? (tokens[1] || '') : ''
      const reason = (level === 'domain' ? tokens.slice(2) : tokens.slice(1)).join(' ')
      if (!['self', 'domain', 'project', 'global'].includes(level)) {
        return reply(false, ['用法：`/pause self|domain <项目:域>|project|global [原因]`', '· self＝只暂停自己（任何会话都能按）', '· domain＝暂停一个域（该域负责人、项目主或体系主可按下）', '· project＝暂停整个项目（需项目主会话或体系主会话）', '· global＝暂停全局（需体系主会话）'])
      }
      if (level === 'domain' && !domainKey) {
        return reply(false, ['用法：`/pause domain <项目:域> [原因]`（例如 `/pause domain tixiweihu:docs`）', '菜单里有按域的现成选项，不用手打。'])
      }
      const cwd = callerCwd(ctx, agent)
      const gate = resolveGate(deps, sessionId, cwd)
      const check = checkAuthority(gate, level, sessionId, { deps, domainKey })
      if (!check.ok) return reply(false, check.lines)
      const target = level === 'self'
        ? { scope: 'session', key: sessionId }
        : level === 'domain'
          ? { scope: 'domain', key: check.key }
          : { scope: level, key: level === 'global' ? '*' : check.project }
      if (!deps.defs || !deps.defs.pause) return reply(false, ['set_domain_state 不可用（插件未完整加载）。'])
      const result = await deps.defs.pause.execute(
        { domain: target.key, scope: target.scope, state: 'paused', note: reason || '人工暂停（/pause）', confirm: target.scope === 'global' ? true : undefined },
        { agent },
      )
      return reply(true, [
        `**暂停已设置**：${level}${level === 'global' ? '' : `（${target.key}）`}`,
        '· 政策轴＝已暂停：新的插件介导投递/新建会话会被拦下并落盘入队。',
        '· ⚠️ **正在跑的回合不会被打断**——暂停是政策闸，不是中断器。',
        '',
        '```json', JSON.stringify(result, null, 2), '```',
        '恢复：`/pause` 的反向操作目前请用 `set_domain_state(scope=…, domain=…, state=active)`（v1 没做 /resume，避免命令膨胀）。',
      ])
    },
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
        return reply(true, [
          `这是**强制暂停 ${level}**，还没有执行。`,
          `确认请在 60 秒内再发一次：\`/pause-all ${level} ${reason} --confirm\``,
          '（任意已注册会话都可以发起；确认与原因会写审计。）',
        ])
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

/** Build the six command definitions (pure; no host calls). */
export function buildCommandDefs(ctx, deps) {
  return [
    registerCommand(ctx, deps),
    initializeCommand(ctx, deps),
    handoffCommand(ctx, deps),
    retireCommand(ctx, deps),
    pauseCommand(ctx, deps),
    pauseAllCommand(ctx, deps),
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
