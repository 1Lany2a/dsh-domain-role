# 域桥插件

> 这一页只讲一件事：dsh 宿主插件 `dsh-domain-bridge`（下文简称「域桥」）——它是什么、有哪 12 个工具、配置与状态落在哪、怎么装、怎么测，以及三条它**做不到**的边界。
> 代码在 `plugins/dsh-domain-bridge/`。概念侧（域／负责人／在任声明）见 `01-concepts.md`，判断理由见 `04-design-decisions.md`。

## 1. 它是什么

- **dsh 宿主插件**：静态 Cordis 包（`export default { name, inject, apply }`），纯 JS ESM、**零构建**（无 tsdown／tsconfig），`link:` 本地安装。
- **不调模型**：只做**确定性动作**——建会话、投递、读写声明与状态。判断"该不该这么做"是 agent 的事（见设计取舍 §9）。
- **不建第二本台账**：真值仍是使命库 + 索引；域标注只**读** `indexFile`，写入只发生在 `domainsFile`（与外部 CLI 同 schema、同原子替换写法）。
- **不做网状直连**：只补"主会话 ↔ 域会话"这一段；跨域仍应经主会话。
- `inject: ['tools', 'agents']`；`sessionController` / `workspaceRegistry` / `agentDefaultModel` / `sessionQuery` / `agentPresets` **故意不写进 inject**，一律 `ctx.get(...)` 可选取用 ⇒ 本部署没挂这些服务时插件**照常加载**，并如实回报 `{created:false, reason:"sessionController-unavailable"}`，而不是让加载器硬失败。
- `apply()` **永不抛错**（顶层 try/catch + `warn()`）：宁可少注册几个工具，也不能让宿主起不来。

## 2. 12 个工具

顺序＝`lib/bridge.js` 里 `apply()` 的注册顺序（与包内 README 的工具表逐条对应）：

| # | 工具 | 干什么 | 读／写 |
|---|---|---|---|
| 1 | `list_domain_sessions` | 列出**当前进程里在线的顶层会话**：索引域标注 + 是否持有在任声明（`onDuty` / `dutyDomain`）＋ 派生状态（`state` / `paused` / `pausedScopes`）；并返回**本会话自己的身份**、`declarations` 段（全量在任声明 + 每条在线与否）与 `domainState` 段（五态字典／四级作用域／已终结墓碑／`unresolved`）。不唤醒任何会话。 | 只读 |
| 2 | `send_to_domain` | 按**域**（`声明优先`：命中声明且在线才投）或按**会话 id** 投递；`mode` 取 `followup`（默认，唤醒对方开一轮）／`steer`（中途纠偏）／`inject`（只塞上下文、不跑回合）；`dryRun` 只看会发给谁。目标已暂停 ⇒ **不硬投、落盘入队**（`reason:"domain-paused"` + `queue.id`）。 | 写入（投递／入队） |
| 3 | `claim_domain` | **本会话**认领一个域，写入域名册；已有人持有 ⇒ 不覆盖、报 `conflict`，`force:true` 才强制交接（前任收一条 inject 停机通知）。 | 写入（`domainsFile`） |
| 4 | `release_domain` | 释放**本会话自己持有**的域；写 `terminatedAt` 墓碑 ⇒ 派生状态变「已终结」。不是在任的域不会被删。 | 写入 |
| 5 | `list_domain_owners` | 只读列出全部在任声明 + 每条声明的会话当前是否在线 + 派生状态，并带 `domainState` 段（含读不懂的状态／队列文件清单）。 | 只读 |
| 6 | `create_domain_session` | 开一个**真顶层会话**并把开工任务排进去（最小合法请求只需要 `cwd`）；`claim:true` 时把该域的在任声明指向新会话（已有负责人则不覆盖）。v0.3.2 起还会挂进已存在的工作区分组并置顶。该域已暂停 ⇒ **直接拒绝**，宿主 `create` 一次都不调。 | 写入（建会话） |
| 7 | `set_domain_state` | 把四级之一（`domain` / `session` / `project` / `global`）的**政策轴**设成 `paused` 或 `active`；`active` ＝ **人手动唤起**：重评 OR、只重投现在不再被压着的 pending。`global` 按／解都要 `confirm:true`。 | 写入（状态记录） |
| 8 | `withdraw_domain_message` | 撤回一条还在队列里的域间消息（默认只允许撤自己发的，`force:true` 才动别人的）；只有 `pending` 能撤，撤后变 `withdrawn` **仍留在文件里当留痕**。 | 写入（队列） |
| 9 | `list_models` | 列出宿主可路由的模型目录；首选 `await ctx.sessionController.modelCatalog()`，目录为空或形状不认识就退 `ctx.llm.listProviders()` / `listModels()`；可选 `session` ⇒ 额外读该会话的 `modelSelection` 投影。 | 只读 |
| 10 | `set_model` | 改**一个会话**的模型（下一轮请求生效）。执行顺序固定：记全局默认 → `selectModel` → **恢复全局默认**，回执给 `globalDefault:{before, after, restored}`。 | 写入（会话级选择） |
| 11 | `set_default_model` | **显式**改宿主全局默认模型，且**永不恢复**（与 `set_model` 相反）。宿主在没有部署配置入口／`configEditor` 时 `saveSelection` 是静默 no-op，所以读回不一致就如实报 `verified:false` / `applied:"not-observed"`。 | 写入（全局默认） |

## 3. 配置与路径：四层解析

插件包里**没有任何本机绝对路径**：所有路径在加载时解析，**前一层非空即胜出**（`resolveRuntime`）。

| 键 | 1 部署配置（`cordis.patch.yml`） | 2 `<home>/config.json` | 3 环境变量 | 4 默认 |
|---|---|---|---|---|
| `indexFile`（只读：会话 id → 域 标注） | `indexFile:` | `indexFile` | `DSH_DOMAIN_BRIDGE_INDEX` | `<home>/registry.json` |
| `domainsFile`（在任声明册） | `domainsFile:` | `domainsFile` | `DSH_DOMAIN_BRIDGE_DOMAINS` | `<home>/domains.json` |
| `ownerCli`（外部 CLI 的写法提示，可空） | `ownerCli:` | `ownerCli` | `DSH_DOMAIN_BRIDGE_OWNER_CLI` | 空 ⇒ 文案只写裸脚本名 |
| `domainSessionModel`（新建域会话建完铺的模型） | `domainSessionModel:` | `domainSessionModel` | —（无环境变量） | 空／非法 ⇒ 不铺，继承全局默认 |

`home` ＝ `DSH_DOMAIN_BRIDGE_HOME`，没设就是宿主家庭目录下的 `~/.dsh/dsh-domain-bridge`。要在一台机器上钉死路径，写 `<home>/config.json` 就行，**不用改** `cordis.patch.yml`。

`cordis.patch.yml` 里另有两个**只在部署配置生效**的键：

- `stateDir`：政策轴（暂停）＋ 落盘队列的目录；不给＝`<home>/state`，写 `''` 也退回默认。
- `domainSessionPreset`：`create_domain_session` 建完给新会话设的权限档；写 `''` / `none` 即关掉这一步。

**读不到或格式坏掉一律静默降级**（当成"没有域标注／没有人认领／没有暂停"），不抛错、不影响投递；`<home>` 全空时插件照常加载，只是报「0 个域」。

**运行期状态一律外置**：暂停记录与队列落在 `~/.dsh/dsh-domain-bridge/state`（配置键 `stateDir`），**不写进插件包目录、也不写进 `_registry` 树**（那是人拥有的数据）。这里的目录只是运行数据，**不是第二本台账**——里面没有任何「谁在任」的记录。

## 4. 状态目录结构

```text
<home>/state/                     # 默认 ~/.dsh/dsh-domain-bridge/state
  domains/<safe-file>.json        # 一个 (scope, key) 一个文件，原子替换（写 .tmp 再 rename）
  inbox/<safe-file>.jsonl         # 一行一条 JSON，dsh 重启不丢，可撤回
```

- **`state/domains/`（一 scope 一键一文件）**：记录形状 `{ scope, key, paused, pausedAt, pausedBy, note, resumedAt, resumedBy, terminatedAt, terminatedBy, updatedAt }`。读不懂／格式坏 ⇒ **写入中止**（`state-file-unreadable`，绝不覆盖别人的记录），**读取按"活动"降级但不静默**（坏文件名进 `unreadableStateFiles`）。
- **`state/inbox/`（一行一条 JSONL）**：记录形状 `{ id, at, from, key, scope, mode, content, replyTo, pausedByScopes, status, … }`，`status` 走 `pending → delivered / failed / withdrawn`。`mode` 与信封正文在**入队时冻结**，恢复时按原 mode 原样重投；坏行只跳过并记账（`degradedQueueFiles`），好行照用；撤回**只改 status、不删行**。
- **文件名规则**：key 小写 → 非 `[a-z0-9_.-]` 压成 `_` → 截 60 字符 → 加 `-` + 该 key 的 sha1 前 8 位。域级沿用 `k-<flat>-<sha1>`（历史状态文件不能因升级失联），其余三级加 scope 前缀（`session-k-…` / `project-k-…` / `global-k-…`）⇒ 同一 key 字符串出现在两个 scope 下也结构上不可能互相覆盖。

## 5. 安装与重启口径

1. 把包目录放到任意位置，`dsh plugin --profile <profile> add link:<这个目录>`（或从 npm 装）；dsh 会应用包内的 `cordis.patch.yml`。
2. 可选：写 `<home>/config.json`（`indexFile` / `domainsFile` / `ownerCli`）；不写就用 `<home>/registry.json` 与 `<home>/domains.json`。`home` 是空的也能正常加载，报「0 个域」而不是报错。
3. **重启 dsh**（或重开窗口）。运行期数据自动落在 `<home>/state`，插件包目录**不再被写入**。

- **改宿主代码必须重启 dsh**：改动 `lib/*.js` / `cordis.patch.yml` 后要重启（或重开窗口）才会被加载；插件未重启前，新工具在模型侧**不存在**。
- **加载器「全有或全无」**：`apply` 抛错 ⇒ 加载器硬失败（`AggregateError: loader entries failed to apply`），**宿主起不来**。这正是 `apply` 永不抛错、且工具注册走「harness 优先 + `ctx.tools.register` 兜底 + try/catch」两 realm 兼容写法的原因。
- 回滚：`dsh plugin --profile <profile> remove dsh-domain-bridge`（或删 profile 里对应依赖与 `dsh.profile.bundles` 条目）。

## 6. 测试

跑 `node test/smoke.mjs`（或 `npm test`）。它对 12 个工具**每条可达分支**做深度扫描 + 无损往返断言，并按版本追加分组：

| 节 | 覆盖 |
|---|---|
| 0 | `apply()` 永不抛错 |
| 1–5 | `list_domain_sessions` / `list_domain_owners` / `send_to_domain` / `claim_domain` / `release_domain` |
| 6 | `create_domain_session` |
| 7 | v0.3.2 入组 + 置顶（假 registry + `create()` 探针，不真建会话） |
| 8 | v0.3.3 自动标题 + 权限档 + 退役标记 |
| 9 | v0.3.4 `wake` 探测档 |
| 10 | v0.3.6 F1 防静默换届 + F2 停机通知 |
| 11 / 11b | v0.4.0 域级「已暂停」／v0.4.1 拉活接线的假服务 |
| 12 | v0.4.1 拉活接线（`{{model}}` 唤醒 bug 的回归） |
| 13 | v0.4.2 四级「已暂停」 |
| 14 | v0.6.0 模型分派 |
| 15 | v0.6.1 全局默认模型 + 真机修正 |
| summary | 打印基线数字（**不是断言**，见下） |

- 冻结项：envelope 文案、`list_domain_sessions` 顶层键集、工具集**逐字相等**（`test/smoke.mjs:320`）、`VERSION == package.json version`。
- **基线（2026-10-24，0.8.15）**：9/9 套件、**666 用例**、smoke 301 / 59,101 分支断言。⚠️ summary 仍只**打印**这些数字、不断言，所以新增/删除用例时仍需人眼比对（这也是每次改插件前先跑一遍基线的原因）。
- `npm test` 从 0.8.10 起是 `node test/run-all.mjs`，串起全部 9 个套件（此前只跑 smoke）。
- ⚠️ **再加第 13 个工具会打断 3 处断言**：工具集逐字相等、`registered.size === 12`、版本字面量 ⇒ 加工具必须**同一批**改测试。

## 7. 三条边界（它做不到什么）

1. **只管「插件介导」的那条路**：人自己在 GUI 点开那条会话、或宿主自己 resume——插件拦不住，那正是「人工手动唤起」。停机通知 `notifyPredecessor` 刻意**绕开暂停闸**（止损优先），四级都不走。
2. **暂停不拦「人工唤起」**：暂停不改在任身份，也不会去关掉一个已经活着的会话 ⇒ 一个已跑着的域会话在暂停期间**照样能改文件**；插件能做的只是"不再往里递新活"。暂停**只拦插件介导的路径**。
3. **声明只有 `declareNewOwner` 能替新会话写**：`claim_domain` 写的是**调用者自己**；替新会话写声明只能走 `declareNewOwner(file, { key, project, domain, ownerSessionId, note })`（`lib/core/declaration.js:354`）。`create_domain_session(claim:true)` 走的正是它，且**不暴露 `force`**——一个刚建出来的新会话绝不能静默顶掉在任负责人。

## 出处

- `plugins/dsh-domain-bridge/README.md`（工具表、两个轴 + 生命周期、四级「已暂停」、配置、落盘格式、安装、硬边界、返回契约）
- `plugins/dsh-domain-bridge/CHANGELOG.md`（版本行为变化与各版本测试基线）
- `plugins/dsh-domain-bridge/package.json`（name／version／type／main／engines／peerDependencies／scripts）
- `plugins/dsh-domain-bridge/cordis.patch.yml`（部署配置键与四层解析注释）
- `plugins/dsh-domain-bridge/lib/bridge.js`（12 个工具的注册顺序、`inject`、`apply` 永不抛错）
- `plugins/dsh-domain-bridge/lib/core/shared.js`（`resolveRuntime` 四层解析、`stateRoot` / `stateDirs` / `stateFileName` 文件名规则）
- `plugins/dsh-domain-bridge/lib/core/tools.js`（`registerTool` 两 realm 兼容、`pruneUndefined` 无损输出唯一收口）
- `plugins/dsh-domain-bridge/lib/core/declaration.js`（`declareNewOwner`）
- `plugins/dsh-domain-bridge/test/smoke.mjs`（断言分组、`:320` / `:391` / `:398` 三处断言、summary 打印）
- `{体系根}/_pages/插件自动化与GUI准备-2026-10-18.data.js`（重启口径表 §七⑩、smoke 数字无断言、三处断言、声明不能写错人 §八）
- `docs/04-design-decisions.md`（§9 插件不调模型、§11 只做宿主没有的那层）
