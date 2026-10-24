/**
 * dsh-domain-bridge — domain reachability layer v0.8.0
 *   (declaration-first + session factory + four-level pause + wake wiring + model dispatch
 *    + slash commands)
 *
 * Commands (6, Host-side; a command is a thin orchestrator over the tools below):
 *   /register [system|project [名称]|domain <域> [takeover]]   register this session's role
 *   /initialize [check]                                        complete the run skeleton (never overwrite)
 *   /handoff [model=…][preset=…][perm=…][target=new]           create a successor and transfer duty
 *   /retire [原因]                                              end this session's duty (keeps history)
 *   /pause self|project|global [原因]                           pause by authority
 *   /pause-all <self|project|global> <原因> [--confirm]         emergency pause (confirm + audit)
 *
 * Tools (11):
 *   list_domain_sessions()                         online top-level sessions + onDuty flags + every declaration
 *   send_to_domain(target, message, mode, ...)     deliver by domain (declaration first) or by session id
 *   claim_domain(domain, project?, note?, force?)  this session claims a domain seat (on-duty declaration)
 *   release_domain(domain, note?)                  this session releases its own declaration
 *   list_domain_owners()                           read-only view of every on-duty declaration
 *   create_domain_session(domain, task, ...)       open a real top-level session and enqueue a startup task
 *   set_domain_state(domain, state, scope?, ...)   pause / resume ONE of four scopes (policy axis)
 *   withdraw_domain_message(id, domain?, force?)   withdraw one queued message of a paused target
 *   list_models(session?)                          host model catalog (+ one session's selection)
 *   set_model(target?, provider, model, ...)       change ONE session's model for the next request
 *   set_default_model(provider, model, ...)        change the HOST GLOBAL DEFAULT (never restored)
 *
 * 变更史与设计依据（v0.2 → v0.6.1：每个版本的读码结论、真机踩坑、决策记录）见 CHANGELOG.md。
 */

import { VERSION, resolveRuntime, stateRoot } from './core/shared.js'
import { warn, registerTool } from './core/tools.js'
import { buildSendTool } from './core/messaging.js'
import { buildSetDomainStateTool, buildWithdrawMessageTool, buildListDomainQueueTool } from './core/pause.js'
import { buildListTool, buildClaimTool, buildReleaseTool, buildListOwnersTool } from './core/declaration.js'
import { buildListModelsTool, buildSetModelTool, buildSetDefaultModelTool, buildCreateSessionTool } from './core/session-factory.js'
import { runInitialize } from './core/bootstrap.js'
import { buildCommandDefs, registerCommandDefinitions } from './core/commands.js'
import { registerMenuRoutes } from './core/menu.js'

export * from './core/shared.js'
export * from './core/tools.js'
export * from './core/messaging.js'
export * from './core/pause.js'
export * from './core/declaration.js'
export * from './core/session-factory.js'
export * from './core/registrations.js'
export * from './core/bootstrap.js'
export * from './core/commands.js'
export * from './core/menu.js'

export default {
  name: 'domain-bridge',
  // sessionController / workspaceRegistry are deliberately NOT injected: a missing service must
  // degrade into an honest {created:false, reason} + pinned report, never into a loader failure.
  // See getSessionController() and getWorkspaceRegistry().
  inject: ['tools', 'agents'],
  apply(ctx, rawConfig) {
    try {
      // portable: every machine-specific path comes from the portable runtime layer
      // (deployment config > <home>/config.json > env > <home> defaults). A missing/broken home or
      // config degrades to empty/candidate paths that the readers already treat as "no data", so
      // apply still registers all 11 tools and reports "0 domains" instead of throwing.
      const runtime = resolveRuntime(rawConfig)
      const config = {
        home: runtime.home,
        configFile: runtime.configFile,
        indexFile: runtime.indexFile,
        domainsFile: runtime.domainsFile,
        ownerCli: runtime.ownerCli,
        // v0.3.3: 新建域会话建完立刻设的权限档名（部署里可用 read-only / workspace-write /
        // danger-full-access；'' / 'none' / 'keep' / 'skip' ＝ 不动，保持宿主默认）。
        // 写成 !== undefined 而不是 ||，这样配置里显式写 '' 才算「关掉」，不会被默认值顶掉。
        // v0.6.4（安全默认）：缺省值由 danger-full-access 收窄为 workspace-write。后台域会话无人值守
        // 仍不会卡在「等人点同意」，但不再默认拿到全盘写权限；要 danger-full-access 必须自己显式配置。
        domainSessionPreset:
          rawConfig && rawConfig.domainSessionPreset !== undefined
            ? rawConfig.domainSessionPreset
            : 'workspace-write',
        // v0.6.0：新建域会话建完铺的模型（部署配置 > <home>/config.json > null＝不铺）。
        // 非法值在 resolveRuntime 里归一成 null，永不抛错。
        domainSessionModel: runtime.domainSessionModel,
        // v0.4.0：政策轴（暂停）＋ 队列的落盘目录。默认＝`<home>/state`（见 defaultStateDir：
        // 运行期数据不写进插件包目录，也不写进项目的 _registry 树）。写成 !== undefined 而不是 ||，
        // 这样配置里显式写 '' 才会退回默认值。
        stateDir: rawConfig && rawConfig.stateDir !== undefined ? rawConfig.stateDir : '',
      }

      // v0.7.0: build each definition ONCE, register it, and hand the SAME object to the command
      // layer — so /register, /handoff, /retire, /pause call the exact governance code the model
      // calls. A command is an orchestrator, never a second implementation.
      const defs = {
        list: buildListTool(ctx, config),
        send: buildSendTool(ctx, config),
        claim: buildClaimTool(ctx, config),
        release: buildReleaseTool(ctx, config),
        owners: buildListOwnersTool(ctx, config),
        create: buildCreateSessionTool(ctx, config),
        pause: buildSetDomainStateTool(ctx, config),
        withdraw: buildWithdrawMessageTool(ctx, config),
        listQueue: buildListDomainQueueTool(ctx, config),
        listModels: buildListModelsTool(ctx, config),
        setModel: buildSetModelTool(ctx, config),
        setDefaultModel: buildSetDefaultModelTool(ctx),
      }
      // v0.4.0：「已暂停」的人工控制入口 + 队列撤回入口；v0.6.0 模型分派；v0.6.1 全局默认模型入口。
      // 宿主没有对应 API 时工具照常注册、如实回 api-unavailable —— 注册本身永不抛。
      for (const definition of Object.values(defs)) registerTool(ctx, definition)
      // v0.7.0：六条宿主斜杠命令（/register /initialize /handoff /retire /pause /pause-all）。
      // v0.8.0：同一批定义既注册成命令，也挂到 popup 菜单路由上——一个实现，两个入口。
      // ⚠️ 0.8.1 修复：`ctx.get('commands')` / `ctx.get('webServer')` 在**未注入**时拿不到服务，
      // 于是命令没注册上（输入 /register 无反应）、菜单路由没挂上（弹出菜单后 404）。
      // 正确姿势是 `ctx.inject([...], child => ...)`，与 free-search 的 webServer 用法一致。
      const commandDefs = buildCommandDefs(ctx, { config, defs, runInitialize })
      // 两个服务必须注入在**同一个子作用域**里：菜单路由的执行阶段还要用 commands（执行命令）
      // 与 agents（拿调用者），跨作用域取不到。
      // v0.8.5 修根因：**这个回调必须 return 一个 disposer**。宿主只会收集 apply 的返回值；
      // 以前两个 register* 的 disposer 全被丢掉 ⇒ 插件在同一个进程里重载（HMR/停用再启用/装新版）
      // 时旧路由留在 webServer 的 exact 表里、新路由注册抛 duplicate 又被空 catch 吞掉，
      // 结果是 /run 与 /health 永远打到**已经失效的旧实例**上（真机症状：/run 报
      // `cannot get required service "commands" in inactive context`、/health 空体 400），
      // 六条命令的弹窗点了什么都不发生，直到重启 dsh。
      ctx.inject(['commands', 'webServer'], (bridgeCtx) => {
        const disposers = []
        try {
          const dispose = registerCommandDefinitions(bridgeCtx, commandDefs)
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          warn(`command registration failed: ${error?.message || String(error)}`)
        }
        try {
          const dispose = registerMenuRoutes(bridgeCtx, { config, defs, runInitialize, commandDefs })
          if (typeof dispose === 'function') disposers.push(dispose)
          warn('command menu routes registered (/api/dsh-domain-bridge/{health,menu,run})')
        } catch (error) {
          warn(`menu routes failed: ${error?.message || String(error)}`)
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* a dispose failure must never block the rest */
            }
          }
        }
      })
      warn(
        `loaded v${VERSION} (tools: list_domain_sessions, send_to_domain, claim_domain, release_domain, ` +
          `list_domain_owners, create_domain_session, set_domain_state, withdraw_domain_message, ` +
          `list_domain_queue, ` +
          `list_models, set_model, set_default_model; ` +
          `home: ${config.home || '(none)'}; ` +
          `config: ${runtime.configFile || '(none)'}${runtime.configError ? ` [read failed: ${runtime.configError}]` : ''}; ` +
          `indexFile: ${config.indexFile} [${runtime.indexFileSource}]; ` +
          `domainsFile: ${config.domainsFile} [${runtime.domainsFileSource}]; ` +
          `ownerCli: ${config.ownerCli || '(none)'} [${runtime.ownerCliSource}]; ` +
          `domainSessionModel: ` +
          (config.domainSessionModel
            ? `${config.domainSessionModel.provider}/${config.domainSessionModel.model}` +
              (config.domainSessionModel.reasoningEffort ? ` (effort=${config.domainSessionModel.reasoningEffort})` : '') +
              ` [${runtime.domainSessionModelSource}]`
            : `(none) [${runtime.domainSessionModelSource}]`) +
          `; ` +
          `stateDir: ${stateRoot(config.stateDir)})`,
      )
    } catch (error) {
      // apply 永不抛错：宁可少几个工具，也不能让加载器硬失败。
      warn(`apply failed: ${error?.message || String(error)}`)
    }
  },
}