/**
 * dsh-domain-bridge — v0.8.0 command menu bridge.
 *
 * Why this file exists: the six slash commands work as typed lines, but a typed line is hard to
 * remember. This module serves the two popup endpoints the client half needs:
 *   POST /api/dsh-domain-bridge/menu  {command, sessionId} -> {ok, options:[...]}
 *   POST /api/dsh-domain-bridge/run   {command, sessionId, input} -> {ok, kind, text}
 *
 * The menu is computed HOST-side from the same governance data the commands read (registrations /
 * owners / cwd), so the popup never invents state. A choice is executed by calling the very same
 * command definition — one implementation, two entry points.
 */

import { readRegistrations, identityOf, projectOfCwd } from './registrations.js'
import { loadDeclarations } from './declaration.js'
import { callerCwd } from './commands.js'

const ROUTE_PREFIX = '/api/dsh-domain-bridge'

function shortId(value) {
  const text = String(value || '')
  return text.startsWith('session-') ? `sess-${text.slice(8, 16)}` : text || '(未知)'
}

function ownerOfKey(declarations, key) {
  const rows = Array.isArray(declarations) ? declarations : []
  const row = rows.find((item) => item && item.key === key)
  return row ? row.sessionId : null
}

function declarationRows(domainsFile) {
  const loaded = loadDeclarations(domainsFile)
  return loaded && Array.isArray(loaded.entries) ? loaded.entries : []
}

/** One menu: {ok, options:[{id,label,detail,badge,active,group,confirmation}]} */
export function buildMenuOptions(ctx, deps, { command, sessionId, cwd }) {
  const config = deps.config
  const read = readRegistrations(config.domainsFile)
  const doc = read.doc || { registrations: {}, owners: {} }
  const identity = identityOf(doc, sessionId)
  const project = projectOfCwd(cwd)
  const projectName = project && project.project ? project.project : null
  const domains = declarationRows(config.domainsFile)
  const registrations = doc.registrations || {}

  const group = (name, label) => ({ name, label })
  const option = (id, label, detail, extra = {}) => ({ id, label, ...(detail ? { detail } : {}), ...extra })

  if (command === 'register') {
    const systemKey = projectName ? `${projectName}:system` : null
    const isSystemRoot = !!(project && project.isSystemRoot)
    const systemOwner = systemKey && registrations[systemKey] ? registrations[systemKey].sessionId : null
    const projectKey = projectName ? `${projectName}:main` : null
    const projectOwner = projectKey && registrations[projectKey] ? registrations[projectKey].sessionId : null
    // 顺序约定：注册在前、初始化在后。目录里没有 SYSTEM-OVERVIEW.md 时不再拒绝，
    // 改成走一次确认（id 带 --confirm），用于"新体系根还没建骨架"的引导期。
    const systemOption = isSystemRoot
      ? option('system', '注册为体系主会话', systemOwner ? `${shortId(systemOwner)} 在任` : '当前无主', {
        group: group('system', '体系层'),
        active: systemOwner === sessionId,
      })
      : option('system --confirm', '注册为体系主会话（新体系根）', systemOwner ? `${shortId(systemOwner)} 在任` : '目录缺 SYSTEM-OVERVIEW.md，确认后注册，`/initialize` 会补', {
        group: group('system', '体系层'),
        active: systemOwner === sessionId,
        confirmation: {
          title: '确认注册为体系主会话？',
          description: `${cwd || '(cwd 未知)'} 里没有体系口径源 SYSTEM-OVERVIEW.md。若这不是体系根，注册后你会拿到 /pause global 权限。`,
          confirmLabel: '确认注册',
          cancelLabel: '取消',
          acknowledgeLabel: '我知道该目录还不是体系根',
        },
      })
    const options = [
      systemOption,
      option('project', '注册为项目主会话', `${projectName || '推不出项目'}${projectOwner ? `：${shortId(projectOwner)} 在任` : '：当前无主'}`, {
        group: group('project', '项目层'),
        active: projectOwner === sessionId,
      }),
    ]
    for (const row of domains) {
      options.push(
        option(`domain ${row.key} takeover`, `继承 ${row.key}`, `交接给当前会话（${shortId(row.sessionId)} 卸任）`, {
          group: group('domain', '域层 · 继承已有'),
          confirmation: {
            title: `确认接管 ${row.key}？`,
            description: `当前负责人 ${shortId(row.sessionId)} 会收到交接留痕；它正在跑的回合不会被打断。`,
            confirmLabel: '确认接管',
            cancelLabel: '取消',
            acknowledgeLabel: '我知道前任可能仍在工作',
          },
        }),
      )
    }
    options.push(
      option('domain-help', '注册一个新域', '新域要输入域名：用文本命令 `/register domain <域名>`', {
        group: group('domain-new', '域层 · 新域'),
      }),
    )
    return { ok: true, options }
  }

  if (command === 'initialize') {
    return {
      ok: true,
      options: [
        option('check', '检查（只报告，不写盘）', cwd || ''),
        option('', '补全骨架（只补不改）', '缺什么建什么；已有文件一字不动'),
      ],
    }
  }

  if (command === 'handoff') {
    return {
      ok: true,
      options: [
        option('', '建接班会话（默认参数）', '体系 cordis／项目 standard／域 standard；模型 wb/cn:deepseek-v4.1-flash'),
        option('preset=cordis', '建接班会话 · 创造模式(cordis)', '复杂/创造类交接用'),
        option('preset=standard', '建接班会话 · 标准模式(standard)', '日常执行类交接用'),
        option('preset=cordis perm=danger-full-access', '建接班会话 · 创造模式 + 全盘写', '无人值守且要写工作区外时用', {
          confirmation: {
            title: '确认给接班会话全盘写权限？',
            description: 'danger-full-access ＝ 该会话可写本机任意路径。前任不会自动退役，请建完先核对再接任。',
            confirmLabel: '确认创建',
            cancelLabel: '取消',
            acknowledgeLabel: '我知道这是最高权限',
          },
        }),
      ],
    }
  }

  if (command === 'retire') {
    return {
      ok: true,
      options: [
        option('', '退役当前会话', '撤注册 + 释放域 + 按 session 暂停 + 标题加（已退役）；不删历史', {
          confirmation: {
            title: '确认退役？',
            description: '退役后插件介导的投递会被拦下；要找回这个窗口需要人工点开。',
            confirmLabel: '确认退役',
            cancelLabel: '取消',
            acknowledgeLabel: '我知道退役≠删除，历史仍在',
          },
        }),
      ],
    }
  }

  if (command === 'pause') {
    const isProjectMain = identity.projectMains.includes(projectName) || identity.roles.some((role) => role.layer === 'project' && role.project === projectName)
    const canProject = identity.systemMain || isProjectMain
    return {
      ok: true,
      options: [
        option('self', '暂停自己（当前会话）', '任何会话都能按；正在跑的回合不会被打断'),
        option('project', '暂停整个项目', canProject ? `项目 ${projectName || '?'}：你有权按` : '需要项目主会话或体系主会话——你会被拒绝'),
        option('global', '暂停全局', identity.systemMain ? '你是体系主会话：有权按' : '只有体系主会话能按——你会被拒绝'),
      ],
    }
  }

  if (command === 'pause-all') {
    return {
      ok: true,
      options: [
        option('self 紧急暂停（菜单）', '强制暂停自己', '任何会话都能按'),
        option('project 紧急暂停（菜单） --confirm', '强制暂停本项目', '任意会话可发起；会写原因与审计', {
          confirmation: {
            title: '确认强制暂停本项目？',
            description: '会写审计（原因：紧急暂停（菜单））。正在跑的回合不会被打断。',
            confirmLabel: '确认强制暂停',
            cancelLabel: '取消',
            acknowledgeLabel: '我知道这是紧急通道',
          },
        }),
        option('global 紧急暂停（菜单） --confirm', '强制暂停全局', '任意会话可发起；会写原因与审计', {
          confirmation: {
            title: '确认强制暂停全局？',
            description: '整个体系的新投递会被拦下，并写审计。正在跑的回合不会被打断。',
            confirmLabel: '确认强制暂停全局',
            cancelLabel: '取消',
            acknowledgeLabel: '我知道这会让整个体系停下来',
          },
        }),
      ],
    }
  }

  return { ok: false, error: `unknown-command: ${command}`, options: [] }
}

/** Execute one menu choice through the very same command definition the typed line uses. */
export async function runMenuChoice(ctx, deps, { command, sessionId, input }) {
  const definition = (deps.commandDefs || []).find((item) => item.name === command)
  if (!definition) return { ok: false, kind: 'error', text: `未知命令：${command}` }
  let agent = null
  try {
    agent = ctx && typeof ctx.get === 'function' ? (ctx.get('agents') && ctx.get('agents').get(sessionId)) : null
  } catch {
    agent = null
  }
  if (!agent && ctx && ctx.agents && typeof ctx.agents.get === 'function') agent = ctx.agents.get(sessionId)
  if (!agent) {
    return { ok: false, kind: 'error', text: '这条会话现在没有活 Agent（窗口已关或刚重启过）⇒ 菜单动作不执行。请在自己的窗口里操作。' }
  }

  const line = `/${command}${input ? ` ${input}` : ''}`
  // Preferred path: the Host command executor. It logs command/run + command/done, so the receipt
  // renders as a persistent flow node in this session — the popup needs no display surface of its own.
  const commands = (ctx && ctx.commands) || (ctx && typeof ctx.get === 'function' ? ctx.get('commands') : null)
  if (commands && typeof commands.execute === 'function') {
    try {
      const execution = await commands.execute(agent, line, [], new AbortController().signal)
      if (execution && execution.result) {
        return {
          ok: execution.result.kind === 'success',
          kind: execution.result.kind,
          text: execution.result.text || '',
        }
      }
    } catch (error) {
      return { ok: false, kind: 'error', text: `执行失败：${error?.message || String(error)}` }
    }
  }
  // Fallback: run the definition in-process (no flow node, but the action still happens).
  const result = await definition.handler({ agent, rawInput: String(input ?? ''), commandId: 'menu' })
  return { ok: result.kind === 'success', kind: result.kind, text: result.text }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 65536) raw = raw.slice(0, 65536)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function writeJson(res, status, value) {
  try {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    try {
      res.end('{}')
    } catch {
      /* nothing left to do */
    }
  }
}

function localOnly(req) {
  const host = String(req.headers.host || '').toLowerCase()
  return host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host === '127.0.0.1' || host === 'localhost'
}

/** Register the two routes; a missing webServer degrades to "no popup transport" (typed commands still work). */
export function registerMenuRoutes(ctx, deps) {
  const server = (ctx && ctx.webServer) || (ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null)
  if (!server || typeof server.register !== 'function') {
    return () => {}
  }
  const disposers = []
  const register = (route) => {
    try {
      const dispose = server.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch {
      /* a broken route must not take the plugin down */
    }
  }
  register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/health`,
    handler: async (req, res) => {
      if (!localOnly(req)) return writeJson(res, 403, { ok: false, error: 'local-only' })
      const commands = (ctx && ctx.commands) || (ctx && typeof ctx.get === 'function' ? ctx.get('commands') : null)
      const agentsService = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
      let agent = null
      try {
        const roots = agentsService && typeof agentsService.roots === 'function' ? agentsService.roots() : []
        agent = Array.isArray(roots) && roots.length ? roots[0] : null
      } catch {
        agent = null
      }
      const names = ['register', 'initialize', 'handoff', 'retire', 'pause', 'pause-all']
      const present = {}
      for (const name of names) {
        try {
          present[name] = Boolean(agent && commands && typeof commands.find === 'function' && commands.find(agent, name))
        } catch {
          present[name] = false
        }
      }
      const tools = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null
      writeJson(res, 200, {
        ok: true,
        plugin: 'dsh-domain-bridge',
        commandsRegistered: typeof commands?.register === 'function',
        hostCommandsPresent: present,
        toolsRegistered: Boolean(tools),
        definitions: Array.isArray(deps.commandDefs) ? deps.commandDefs.map((d) => d.name) : [],
      })
    },
  })
  register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/menu`,
    handler: async (req, res) => {
      if (!localOnly(req)) return writeJson(res, 403, { ok: false, error: 'local-only' })
      const body = await readBody(req)
      const sessionId = String(body.sessionId || '')
      let cwd = null
      try {
        const agentsService = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
        const agent = agentsService && typeof agentsService.get === 'function' ? agentsService.get(sessionId) : null
        cwd = agent ? callerCwd(ctx, agent) : null
      } catch {
        cwd = null
      }
      const built = buildMenuOptions(ctx, deps, { command: String(body.command || ''), sessionId, cwd })
      writeJson(res, 200, built)
    },
  })
  register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/run`,
    handler: async (req, res) => {
      if (!localOnly(req)) return writeJson(res, 403, { ok: false, error: 'local-only' })
      const body = await readBody(req)
      try {
        const out = await runMenuChoice(ctx, deps, {
          command: String(body.command || ''),
          sessionId: String(body.sessionId || ''),
          input: body.input ?? '',
        })
        writeJson(res, 200, out)
      } catch (error) {
        writeJson(res, 200, { ok: false, kind: 'error', text: error?.message || String(error) })
      }
    },
  })
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* keep disposing the rest */
      }
    }
  }
}
