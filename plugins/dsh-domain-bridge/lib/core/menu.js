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
import { warn } from './tools.js'

const ROUTE_PREFIX = '/api/dsh-domain-bridge'

/**
 * 取服务：**先 ctx.get 再属性读**，且两条路都不许抛。
 * 属性读（`ctx.commands`）在失效的 fiber 上会直接抛 `cannot get required service … in inactive context`，
 * 而 `||` 右侧的兜底永远轮不到——v0.8.0~0.8.4 的 /run 与 /health 就是这么整个失败成 500/400 的。
 */
function serviceOf(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet) return viaGet
    }
  } catch {
    /* fall through to the property read */
  }
  try {
    return ctx ? ctx[name] ?? null : null
  } catch {
    return null
  }
}

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

  // ── v0.8.5（菜单 A）：每条命令**零键入**——参数全部由宿主侧按真实状态算成行；
  // 需要"再问一次"的地方用宿主原生的 confirmation 浮层（第二级），不再要求人打参数。
  if (command === 'register') {
    const systemKey = projectName ? `${projectName}:system` : null
    const isSystemRoot = !!(project && project.isSystemRoot)
    const systemOwner = systemKey && registrations[systemKey] ? registrations[systemKey].sessionId : null
    const projectKey = projectName ? `${projectName}:main` : null
    const projectOwner = projectKey && registrations[projectKey] ? registrations[projectKey].sessionId : null
    const myDomains = domains.filter((row) => row.sessionId === sessionId)

    const options = [
      option('', '看我现在是谁', identity.roles.length || myDomains.length ? `已注册：${identity.roles.length} 个身份 / ${myDomains.length} 个域` : '还没注册任何身份', {
        group: group('identity', '身份 · 只读'),
      }),
    ]

    // 顺序约定：注册在前、初始化在后。目录里没有 SYSTEM-OVERVIEW.md 时不再拒绝，
    // 改成走一次确认（id 带 --confirm），用于"新体系根还没建骨架"的引导期。
    const systemOption = isSystemRoot
      ? option('system', systemOwner === sessionId ? '我已是体系主会话' : systemOwner ? `成为体系主（接手 ${shortId(systemOwner)}）` : '成为体系主会话', systemOwner ? `${shortId(systemOwner)} 在任` : '当前无主', {
        group: group('system', '体系层'),
        active: systemOwner === sessionId,
        ...(systemOwner && systemOwner !== sessionId
          ? {
              confirmation: {
                title: `确认由你接任 ${systemKey}？`,
                description: `现在是 ${shortId(systemOwner)} 在任。接手会把它写进注册册的 note 留痕；它不会收到停机通知，也不会被打断。`,
                confirmLabel: '确认接任',
                cancelLabel: '取消',
                acknowledgeLabel: '我知道交接后应让对方 /retire',
              },
            }
          : {}),
      })
      : option('system --confirm', '成为体系主会话（新体系根）', systemOwner ? `${shortId(systemOwner)} 在任` : '目录缺 SYSTEM-OVERVIEW.md，确认后注册，`/initialize` 会补', {
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
    options.push(systemOption)
    options.push(
      option('project', projectOwner === sessionId ? '我已是项目主会话' : projectOwner ? `成为项目主（接手 ${shortId(projectOwner)}）` : '成为项目主会话', `${projectName || '推不出项目'}${projectOwner ? `：${shortId(projectOwner)} 在任` : '：当前无主'}`, {
        group: group('project', '项目层'),
        active: projectOwner === sessionId,
        ...(projectOwner && projectOwner !== sessionId
          ? {
              confirmation: {
                title: `确认由你接任 ${projectKey}？`,
                description: `现在是 ${shortId(projectOwner)} 在任。接手会在 note 里留痕。`,
                confirmLabel: '确认接任',
                cancelLabel: '取消',
                acknowledgeLabel: '我知道交接后应让对方 /retire',
              },
            }
          : {}),
      }),
    )

    for (const row of domains) {
      const mine = row.sessionId === sessionId
      options.push(
        option(mine ? `domain ${row.key}` : `domain ${row.key} takeover`, mine ? `刷新我在 ${row.key} 的在任时间` : `接手 ${row.key}`, mine ? '你就是在任负责人' : `交接给当前会话（${shortId(row.sessionId)} 卸任）`, {
          group: group('domain', '域层 · 已有域'),
          active: mine,
          ...(mine
            ? {}
            : {
                confirmation: {
                  title: `确认接管 ${row.key}？`,
                  description: `当前负责人 ${shortId(row.sessionId)} 会收到交接留痕；它正在跑的回合不会被打断。`,
                  confirmLabel: '确认接管',
                  cancelLabel: '取消',
                  acknowledgeLabel: '我知道前任可能仍在工作',
                },
              }),
        }),
      )
    }
    options.push(
      option('domain-help', '开一个新域', '新域必须有一个名字：在输入框里补一句 `/register domain <域名>`（这是唯一还需要打字的一步）', {
        group: group('domain-new', '域层 · 新域'),
      }),
    )
    return { ok: true, options }
  }

  if (command === 'initialize') {
    return {
      ok: true,
      options: [
        option('check', '先检查（只报告，不写盘）', cwd || '', { group: group('check', '第一步 · 只读') }),
        option('', '补全骨架（只补不改）', '缺什么建什么；已有文件一字不动', {
          group: group('build', '第二步 · 写盘'),
          confirmation: {
            title: '确认在这个目录补全骨架？',
            description: `${cwd || '(cwd 未知)'}：会补齐 PROJECT.md / KNOWLEDGE.md / KNOWLEDGE\\ / 提案\\ / projectlog\\ / .gitignore。已有文件一个字都不改。`,
            confirmLabel: '确认补全',
            cancelLabel: '取消',
            acknowledgeLabel: '我知道缺什么建什么',
          },
        }),
      ],
    }
  }

  if (command === 'handoff') {
    const layer = identity.roles.length ? identity.roles[0].layer : 'project'
    const layerWord = layer === 'system' ? '体系主' : layer === 'project' ? '项目主' : '域'
    return {
      ok: true,
      options: [
        option('', `建接班会话 · ${layerWord}（默认参数）`, '按参数表：体系 cordis／其余 standard；权限与模型取自部署配置', {
          group: group('who', `交给谁 · 按你现在的身份（${layerWord}）`),
          confirmation: {
            title: '确认新建接班会话？',
            description: '会新建一条会话、把交接任务排进去、并把在任身份转给它。前任不会自动退役——建完先核对，再 /retire。',
            confirmLabel: '确认新建',
            cancelLabel: '取消',
            acknowledgeLabel: '我知道前任仍在任，需要我手动退役',
          },
        }),
        option('preset=cordis', '建接班会话 · 创造模式(cordis)', '复杂/创造类交接用', { group: group('params', '参数 · 覆盖默认') }),
        option('preset=standard', '建接班会话 · 标准模式(standard)', '日常执行类交接用', { group: group('params', '参数 · 覆盖默认') }),
        option('preset=cordis perm=danger-full-access', '建接班会话 · 创造模式 + 全盘写', '无人值守且要写工作区外时用', {
          group: group('params', '参数 · 覆盖默认'),
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
    const mine = domains.filter((row) => row.sessionId === sessionId)
    return {
      ok: true,
      options: [
        option('', '退役当前会话', `撤注册（${identity.roles.length} 条）+ 释放 ${mine.length} 个域 + 按 session 暂停 + 标题加（已退役）；不删历史`, {
          group: group('retire', '退役'),
          confirmation: {
            title: '确认退役？',
            description: '退役后插件介导的投递会被拦下；要找回这个窗口需要人工点开。退役≠删除，历史仍在。',
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
    const options = []
    for (const row of domains) {
      options.push(
        option(`domain ${row.key}`, `暂停 ${row.key}`, row.sessionId === sessionId ? '你就是这个域的负责人' : `负责人 ${shortId(row.sessionId)}`, {
          group: group('domain', '按域'),
        }),
      )
    }
    options.push(
      option('self', '暂停自己（当前会话）', '任何会话都能按；正在跑的回合不会被打断', { group: group('self', '按会话') }),
      option('project', '暂停整个项目', canProject ? `项目 ${projectName || '?'}：你有权按` : '需要项目主会话或体系主会话——你会被拒绝', {
        group: group('project', '按项目'),
        ...(canProject
          ? {
              confirmation: {
                title: `确认暂停项目 ${projectName || '?'}？`,
                description: '该项目下所有会话的新投递会被拦下并入队；正在跑的回合不会被打断。',
                confirmLabel: '确认暂停项目',
                cancelLabel: '取消',
                acknowledgeLabel: '我知道这会影响整个项目',
              },
            }
          : {}),
      }),
      option('global', '暂停全局', identity.systemMain ? '你是体系主会话：有权按' : '只有体系主会话能按——你会被拒绝', {
        group: group('global', '全局'),
        ...(identity.systemMain
          ? {
              confirmation: {
                title: '确认暂停全局？',
                description: '整个体系的新投递会被拦下并入队；正在跑的回合不会被打断。',
                confirmLabel: '确认暂停全局',
                cancelLabel: '取消',
                acknowledgeLabel: '我知道这会让整个体系停下来',
              },
            }
          : {}),
      }),
    )
    return { ok: true, options }
  }

  if (command === 'pause-all') {
    return {
      ok: true,
      options: [
        option('self 紧急暂停（菜单）', '强制暂停自己', '任何会话都能按', { group: group('self', '紧急 · 单会话') }),
        option('project 紧急暂停（菜单） --confirm', '强制暂停本项目', '任意会话可发起；会写原因与审计', {
          group: group('project', '紧急 · 项目'),
          confirmation: {
            title: '确认强制暂停本项目？',
            description: '会写审计（原因：紧急暂停（菜单））。正在跑的回合不会被打断。',
            confirmLabel: '确认强制暂停',
            cancelLabel: '取消',
            acknowledgeLabel: '我知道这是紧急通道',
          },
        }),
        option('global 紧急暂停（菜单） --confirm', '强制暂停全局', '任意会话可发起；会写原因与审计', {
          group: group('global', '紧急 · 全局'),
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
  const agentsService = serviceOf(ctx, 'agents')
  try {
    agent = agentsService && typeof agentsService.get === 'function' ? agentsService.get(sessionId) : null
  } catch {
    agent = null
  }
  if (!agent) {
    return { ok: false, kind: 'error', text: '这条会话现在没有活 Agent（窗口已关或刚重启过）⇒ 菜单动作不执行。请在自己的窗口里操作。' }
  }

  const line = `/${command}${input ? ` ${input}` : ''}`
  // Preferred path: the Host command executor. It logs command/run + command/done, so the receipt
  // renders as a persistent flow node in this session — the popup needs no display surface of its own.
  const commands = serviceOf(ctx, 'commands')
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
      // 宿主执行器不可用（例如插件实例已失效）⇒ 不吞掉，继续走 in-process 兜底，并把原因带进回执。
      warn(`menu: commands.execute failed for ${line}: ${error?.message || String(error)}`)
    }
  }
  // Fallback: run the definition in-process (no flow node, but the action still happens).
  try {
    const result = await definition.handler({ agent, rawInput: String(input ?? ''), commandId: 'menu' })
    return { ok: result.kind === 'success', kind: result.kind, text: result.text }
  } catch (error) {
    return { ok: false, kind: 'error', text: `菜单动作执行失败：${error?.message || String(error)}` }
  }
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
  const server = serviceOf(ctx, 'webServer')
  if (!server || typeof server.register !== 'function') {
    return () => {}
  }
  const disposers = []
  const register = (route) => {
    try {
      const dispose = server.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      // v0.8.5：**不再静默吞掉**。重复路由＝上一次插件实例的路由还挂在表里（旧 handler 属于失效
      // fiber），这时新路由必然挂不上，而失败是静默的——正是 /run 与 /health 长期坏掉却没人知道的原因。
      warn(
        `menu route "${route.path}" NOT registered: ${error?.message || String(error)}` +
          `（多半是上一次插件实例的同名路由还占着；那一路请求会打到旧实例上，重启 dsh 可清）`,
      )
    }
  }
  register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/health`,
    handler: async (req, res) => {
      // 诊断端点**必须自证健康**：自己先抛错就等于没有诊断（真机症状是空体 400）。
      try {
        if (!localOnly(req)) return writeJson(res, 403, { ok: false, error: 'local-only' })
        const commands = serviceOf(ctx, 'commands')
        const agentsService = serviceOf(ctx, 'agents')
        const names = ['register', 'initialize', 'handoff', 'retire', 'pause', 'pause-all']
        const present = {}
        for (const name of names) present[name] = false
        let checked = 0
        try {
          const roots = agentsService && typeof agentsService.roots === 'function' ? agentsService.roots() : []
          for (const agent of Array.isArray(roots) ? roots : []) {
            if (!agent) continue
            checked += 1
            for (const name of names) {
              try {
                const found = commands && typeof commands.find === 'function' && commands.find(agent, name)
                if (found) present[name] = true
              } catch {
                /* one agent's scope failing must not hide the others */
              }
            }
          }
        } catch {
          /* agents unavailable: report the rest honestly */
        }
        const tools = serviceOf(ctx, 'tools')
        writeJson(res, 200, {
          ok: true,
          plugin: 'dsh-domain-bridge',
          commandsRegistered: typeof commands?.register === 'function',
          hostCommandsPresent: present,
          agentsChecked: checked,
          toolsRegistered: Boolean(tools),
          definitions: Array.isArray(deps.commandDefs) ? deps.commandDefs.map((d) => d.name) : [],
        })
      } catch (error) {
        writeJson(res, 200, { ok: false, error: error?.message || String(error) })
      }
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
        const agentsService = serviceOf(ctx, 'agents')
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
