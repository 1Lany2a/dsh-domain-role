/**
 * dsh-domain-bridge — domain reachability layer v0.6.4
 *   (declaration-first + session factory + four-level pause + wake wiring + model dispatch)
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
import { buildSetDomainStateTool, buildWithdrawMessageTool } from './core/pause.js'
import { buildListTool, buildClaimTool, buildReleaseTool, buildListOwnersTool } from './core/declaration.js'
import { buildListModelsTool, buildSetModelTool, buildSetDefaultModelTool, buildCreateSessionTool } from './core/session-factory.js'

export * from './core/shared.js'
export * from './core/tools.js'
export * from './core/messaging.js'
export * from './core/pause.js'
export * from './core/declaration.js'
export * from './core/session-factory.js'

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

      registerTool(ctx, buildListTool(ctx, config))
      registerTool(ctx, buildSendTool(ctx, config))
      registerTool(ctx, buildClaimTool(ctx, config))
      registerTool(ctx, buildReleaseTool(ctx, config))
      registerTool(ctx, buildListOwnersTool(ctx, config))
      registerTool(ctx, buildCreateSessionTool(ctx, config))
      // v0.4.0：「已暂停」的人工控制入口 + 队列撤回入口。
      registerTool(ctx, buildSetDomainStateTool(ctx, config))
      registerTool(ctx, buildWithdrawMessageTool(ctx, config))
      // v0.6.0：模型分派（只读目录 + 单会话模型选择）。宿主没有对应 API 时工具照常注册、如实回
      // api-unavailable / source:'empty' —— 注册本身永不抛。v0.6.1 补 set_default_model（全局那一半）。
      registerTool(ctx, buildListModelsTool(ctx, config))
      registerTool(ctx, buildSetModelTool(ctx, config))
      // v0.6.1：全局默认模型的**唯一**写入入口（显式改、不恢复）。改会话级选择用 set_model。
      registerTool(ctx, buildSetDefaultModelTool(ctx))
      warn(
        `loaded v${VERSION} (tools: list_domain_sessions, send_to_domain, claim_domain, release_domain, ` +
          `list_domain_owners, create_domain_session, set_domain_state, withdraw_domain_message, ` +
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