# 变更日志

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循语义化版本。
0.x 阶段：次版本号变化＝行为变化，修订号＝缺陷修复与内部瘦身。

## [0.8.4] — 2026-10-20

**降摩擦：身份摘要随开工任务一起去。** `create_domain_session` 以前只把 `task` 原文排给新会话——而域身份只存在域名册（`owners`）里，新会话**自己看不见**，第一轮要么先猜"我是不是负责人"，要么等人点一次 `/register` 才知道。现在建会话时在 `task` 前面自动加一句身份摘要（原文一字不改，放在 `---` 分隔线之后）：

- 本次认领且此前无主 ⇒「你是 `<项目>:<域>` 的负责人（域会话）。本次建会话时已认领…裸跑 `/register` 可核对。」
- 已有别人在任 ⇒「你要接手的是 `<项目>:<域>`；该域当前在任 `<会话>`，本次**没有**认领它。先裸跑 `/register` 核对身份，要正式接任就 `/register domain <项目>:<域> takeover`。」（所以 claim 命中冲突时也不会谎称"你是负责人"）
- 没传 claim 且无主 ⇒「你被指派到 `<项目>:<域>`。本次**没有**认领它在任声明…」

摘要的判定只用**建会话之前**就能拿到的信息（`existingOwner` + `claim` 请求），所以 `dryRun` 预览的正文与实际发出的一致；回执新增 `taskIdentity` 字段（就是发出去的那一句，调用方不用猜）。标题仍按 `task` 原文首行算，不受影响。

零新增机制：不新增会话事件、不新增台账，只是把"它该知道的那一句"放进它本来就要收到的第一条消息里。`smoke` 282 / 54,749 断言全过（新增 5 条断言覆盖三种身份文案与原文保真）。

## [0.8.3] — 2026-10-20

**真机 `/initialize` 一个文件都没建，还把整份清单报成「待人工」**，外加两条回执显示问题。根因只有一层：`runInitialize` 取 cwd 只认 `exec.agent.cwd`，而**宿主 Agent 对象不带 cwd**（cwd 只由 `workingDirectory` 服务给，命令层其实已经解析好了）⇒ 永远拿不到项目根 ⇒ 走 `no-project-root` 分支，把清单原样投影成「需人工：PROJECT.md、KNOWLEDGE.md…」并提示"拿不到项目根"。

- **修**：cwd 来源改成 `args.projectRoot` > `args.cwd` > `exec.cwd` > `exec.agent.cwd`；`/initialize` 命令把已解析好的 cwd 显式当 `projectRoot` 传进去。现在**自动建** PROJECT.md / KNOWLEDGE.md / KNOWLEDGE\ / 提案\ / projectlog\ / .gitignore（模板能整份复制就复制，缺失退最小骨架）。
- **修**：`待人工: [object Object]、[object Object]…`——回执条目是对象，命令层直接 `join` 就拼成了 `[object Object]`；改成只取 `path`。
- **修**：正文重复一遍——`hint` 原来是 `lines.join('') + 下一步`，命令层又把 `hint` 显示一次；现在 `hint` 只放「只读 / 下一步 / 身份提示 / 体系层缺项」几句，正文段落另给 `notes` 字段。
- **补护栏**：bootstrap 测试新增「真机形状」用例——`agent` 上**没有 cwd**、只给 `projectRoot` / `args.cwd` 时必须真建出文件（原先测试用 `agent.cwd` 模拟，正好绕过了这个 bug）。

`smoke` 282 / `bootstrap` 16 用例 121 断言 / `commands` 31 / `menu` 19 全过。

## [0.8.2] — 2026-10-19

**顺序纠正：注册在前、初始化在后**（用户判断，采纳）。0.8.1 及以前把「目录里得有骨架标志文件」当成注册的**前置条件**：`/register system` 缺 `SYSTEM-OVERVIEW.md` 就拒绝，`/register project` 缺 `PROJECT.md` 就拒绝并让人先跑 `/initialize`。这个前置站不住——

- 注册键就是 cwd 目录名（`projectOfCwd`），初始化的产出**不参与**推导，技术上是零依赖；
- 标志文件自己就能造，它不是安全边界、只是仪式；
- 全新目录（新建项目 / 新体系根）默认是空的，最自然的意图「我是这个项目的主会话」会被直接拒，正是弹窗要消灭的「记流程」；
- 语义上「初始化」是执行、「注册」是声明：声明在先，后续每一笔骨架写入才能落在在任身份上（可归责）。

改法（三处小改）：

- `/register project`：去掉 `PROJECT.md` 预检，注册成功回执把 `/initialize` 指为下一步；保留「把 cwd 规整到项目根」（防子目录注册）。
- `/register system`：缺 `SYSTEM-OVERVIEW.md` 时不再拒绝，改为**要一次显式确认**（`/register system --confirm`；菜单里是带二次确认的「注册为体系主会话（新体系根）」）——自封体系主仍是高权限动作，值得按一下，但不值得卡住流程。
- `/initialize` 回执：「下一步 `/register project`」改为「若还没身份，先 `/register project`（注册不要求骨架先存在）」。

`smoke` 282 / `menu` 18 / `commands` 28 全过。

## [0.8.1] — 2026-10-19

**真机 0.8.0 的两个症状是同一个根因**：`ctx.get('commands')` / `ctx.get('webServer')` 在**未注入**的服务上返回 undefined，于是 ① 六条宿主命令**从来没注册上**（用户输入 `/register` 没反应）② 菜单路由**没挂载**（点命令弹出菜单后报 `bridge menu 404`）。

修法：两件事都放进**同一个** `ctx.inject(['commands','webServer'], child => …)` 子作用域（与 free-search 用 webServer 的姿势一致），服务查找改为「先取注入属性、再退 ctx.get」；注册结果写 warn 日志，下次一眼能看出有没有挂上。`smoke` 282 / `menu` 16 / `commands` 24 全过。

## [0.8.0] — 2026-10-19

**斜杠命令改成弹窗菜单**（与 `/free-search-engine` 同款：输入 `/` → 选中 → 弹菜单 → 点一下执行），并补三处真机问题。

### 新增

- `lib/client.js`（浏览器半边）：用 `commandUi.decorate` 给六条宿主命令挂 `popupSelect`。**为什么用 decorate 而不是 register**：同名贡献项会与宿主命令撞名报错；decorate 保留目录行与参数声明，只把「裸调用」换成一个弹窗。
- `lib/core/menu.js`：三个宿主端点 `POST /api/dsh-domain-bridge/{health,menu,run}`。菜单**在宿主侧按真实状态算**（注册册 / 在任声明 / cwd），不在前端编；选项里的危险动作带 `confirmation`（接管域、退役、强停项目/全局、全盘写交接）。
- 选择执行走 `ctx.commands.execute(agent, '/register system', …)` —— 复用宿主的命令执行器，所以回执会作为**命令流转节点**出现在会话里，草稿里不会留下脏 `/token`。
- `/retire` 现在调 `markRetired`：**会话自己把标题加上（已退役）**（宿主已开启会话自改名）。
- `package.json`：新增 `./client` 导出与 `dsh.client`（`platform: web`、`immediately`、注入 `@deepseek-ai/dsh-client-ui-commands`）。

### 修复

- `commands.js` / `menu.js` 读在任声明时用了不存在的字段（`declarations`），实际是 `entries` ⇒ `/register` 无参回执与 `/retire` 的域释放原先看不到自己持有的域，已修。

### 验证

`test/menu.test.mjs` 16 条；`test/commands.test.mjs` 24 条；`smoke` 282 用例 / 54,624 断言全过。**host 侧新增路由，需重启一次 dsh**；重启后 `GET/POST /api/dsh-domain-bridge/health` 可直接确认六条命令是否真注册。

## [0.7.0] — 2026-10-19

**六条宿主斜杠命令**（`/register` `/initialize` `/handoff` `/retire` `/pause` `/pause-all`）＋ 让它们能安全落账的**注册册**。命令是**编排器**：参数解析、身份校验、转调同一批工具定义（`claim` / `release` / `set_domain_state` / `create_domain_session`），**没有第二套治理实现**；命令由宿主执行，**不经过模型**。

### 新增

- `lib/core/registrations.js`：`domains.json` 新增**平行节** `registrations`（`owners` 一字不动，域负责人仍只在 `owners`），键规则 `"<项目>:system"` / `"<项目>:main"`；`identityOf` 三层身份；`projectOfCwd` 以 `SYSTEM-OVERVIEW.md` 判体系根（不硬编码 `D:\xiangmu`）。
- `lib/core/commands.js`：六条命令 + **权限闸**（`self` 任何人；`project` 需项目主或体系主；`global` 需体系主；**判不出身份就拒绝**）＋ `/pause-all` 二次确认（`--confirm`）＋ 必填原因 ＋ `stateDir/audit.jsonl` 审计。命令重名只 warn 跳过，不覆盖别的插件。
- `lib/core/bootstrap.js`：`/initialize [check]`，默认**只补不改**；复用 `init-project.ps1` 的清单与 `templates/` 下的模板文件（不调 PowerShell、不重写模板正文）；体系层只检查不创建。
- 测试：`test/registrations.test.mjs`（13 用例 / 175 断言）、`test/bootstrap.test.mjs`（15 / 109）、`test/commands.test.mjs`（24）。

### 修复（并发写）

三个写盘器原来都用**固定名** `<file>.tmp` 且不加锁。实测两个子进程并发写 60 个键：改动前**只剩 2~12 个键（永久丢 48~58 个）**，改动后 **60/60 一个不少**。现在 `writeDeclarationsAtomic` 与注册册共用一把 `wx` 独占锁（`<file>.lock`，死锁按 PID 接管），tmp 名带 pid+随机后缀，rename 失败重试。

### 验证

`node test/smoke.mjs` **282 用例 / 54,624 断言全过**（3 处过期字面量同步到 0.7.0 / `workspace-write`，`blockedBook` 补占住新锁路径）；三个新测试文件全过；新/改文件 `node --check` 通过。

### 已知限制

- **需重启一次 dsh** 才生效（host 侧代码）。
- v1 **没有客户端弹窗**：多级选择用文本参数（实测多级链式弹窗依赖未文档化字段，且会留下 `/reg` 脏文本被当提示词发给模型）。
- `/handoff` 只能 `target=new`（交给现存会话需要对方自己 `/register`）；`/register system|project` 冲突时**不能强制接管**（域层可以 `takeover`）。
- `D:\xiangmu\tools\domain-owner.mjs` 仍是固定名 tmp、不加锁 ⇒ CLI 的读-改-写仍可能覆盖插件的写入。

## [0.6.3] — 2026-10-18

仅结构拆分，对外行为不变 —— 把单文件 `lib/bridge.js`（6,407 行 / 318,551 B）拆成 6 个模块，**入口仍是 `lib/bridge.js`**（只做汇总再导出：头部说明 + 12 行 `import` + 6 行 `export *` + `apply` 入口，共 107 行；`test/smoke.mjs` 的 import 路径一个字未改）：

| 模块 | 行数 | 负责 |
| --- | --- | --- |
| `lib/core/shared.js` | 468 | 常量 / traceId、portable 路径与配置解析、JSON 与字节小工具、会话索引行 |
| `lib/core/tools.js` | 142 | 11 个工具的注册入口与 handler 壳（无损输出唯一收口） |
| `lib/core/messaging.js` | 706 | `send_to_domain` 投递、inbox 队列读写、暂停闸判定 |
| `lib/core/pause.js` | 1,908 | 四级暂停、状态记录、队列 drain/withdraw |
| `lib/core/declaration.js` | 1,123 | claim/release/list 在任声明、域名册读写、目标解析 |
| `lib/core/session-factory.js` | 2,042 | `create_domain_session`、wake 接线、模型分派三工具 |

拆分只做「搬代码 + 补 `export`/`import`」：没有任何函数被改写、改名或重排，工具名、参数与回执形状一律未变；未新增依赖（模块间只用相对 `import`；messaging / pause / declaration / session-factory 之间互相引用＝循环，靠函数声明的提升在调用期解析，模块求值期不存在跨模块的 `const` 依赖）。7 个文件共 6,496 行，多出的 89 行全部是新增的文件头注释与 `import`/`export` 语句。

验证：`node test/smoke.mjs` 仍是 **282 用例 / 54,624 断言**全通过（改前＝改后）；7 个 .js 逐个 `node --check` 通过；`package.json` / `VERSION` / README 的版本串同步为 0.6.3，`test/smoke.mjs` 里唯一随版本走的字面量（`'0.6.2'`→`'0.6.3'`）一并同步，断言条数不变。

## [0.6.2] — 2026-10-18

仅瘦身，对外行为不变 —— ① lib/bridge.js 头注释与变更史外移（6,834 → 6,407 行；355,039 → 318,551 B）② package.json description 精简（8,383 → 891 B）、cordis.patch.yml 只删纯注释行（非注释 7 行逐字未变）③ 删除一次性 legacy 迁移 migratePackageState() 及其调用点与 5 个仅它使用的 helper（约 120 行；test/smoke.mjs 零覆盖，默认落盘仍为 <home>/state）。验证：smoke 282 用例 / 54,624 断言全过；node --check lib/bridge.js 通过。

## [Unreleased]

### 变更

- 源码瘦身（**不改任何行为**）：`lib/bridge.js` 的文件头只留一句话定位 + 11 个工具签名 + 指向本文件的链接，
  变更史全部外移到本文件（头部 340 行 / 33,349 B → 19 行）。
- `package.json` 的 `description` 从 7,688 B 压到 74 字符（工具清单与口径指向 `README.md` / 本文件）；
  `cordis.patch.yml` 只删纯 `#` 注释行（13,384 B → 1,704 B），loader 需要的结构键一字未动。
- 删除一次性 legacy 迁移 `migratePackageState()` 及调用点、以及只被它使用的工具函数（包内早已没有旧
  `state/` 数据）；默认落盘目录仍是 `<home>/state`，没有迁移发生时的正常加载路径不变。
  回归：`node test/smoke.mjs` 仍是 **282 用例 / 54,624 断言**全通过（改前＝改后）。

## [0.6.1] - 2026-10-17

首次真机验证暴露的两个缺陷修复，外加一个补上的全局入口（依据 dsh 0.2.1-rc.2 读码定案）。

### 修复

- **`sessionController.modelCatalog()` 是 async**（`dsh-api-session-controller/lib/index.js:3121` 的
  `modelCatalog() { return buildModelCatalog(this.ctx) }`，而 `lib/types/catalog.js:10` 是
  `export async function buildModelCatalog(ctx, …)`）。v0.6.0 少了 `await`，拿到的是一个 Promise：
  `groups` 恒空、`routableProviders` 恒 `null`、`default` 恒 `undefined`（真机回执就是这样）。
  现在 `await` 它；并且 **`groups` 为空（或形状不认识）就退 `ctx.llm.listProviders()` +
  `listModels(provider)`**。两个来源都空 ⇒ `{ok:true, source:'empty', groups:[], rawKeys:[…],
  note:'catalog-empty'}`——如实报空，不假装有内容。
- **会话模型投影要传 Session 对象**。`ctx.sessionProjections.stateOf(session, key)`
  （`dsh-session-projection/lib/types/index.js:132`）要的是 **Session 对象**（内部要用
  `session.header` / `session.snapshotEvents()`），传 session id **字符串必抛**（WeakMap 查不到 ⇒
  当新会话 fold 历史 ⇒ TypeError）。真接口是 `ctx.sessionController.projections({sessionId}, signal)`
  （`lib/index.js:3280`，`@Remote('projections')` 在 `:2698`；返回
  `{kind:'sequenced', asOfSeq, values}`，`values.modelSelection` 是 wire 视图 `{lastUsed, next}`；
  活会话与存档会话都能读）；退路是**活 Session 对象**（`ctx.agents.get(id).session`——宿主自己就这么用，
  `lib/index.js:366`；或 `ctx.sessions.get(id)`，`lib/index.js:3323`）再
  `stateOf(session,'modelSelection')`（宿主状态 `{lastUsed, pending}`）。

### 新增

- **`set_default_model`**：显式改全局默认模型、**不恢复**（`ctx.agentDefaultModel.saveSelection(next)`）。
  这与 `set_model`（先记 → 改 → 恢复）**语义相反**：改一个会话用 `set_model`，改"以后新建的、
  且尚无会话级选择的会话"的默认用 `set_default_model`。

## [0.6.0] - 2026-10-17

模型分派。事实依据为 dsh 0.2.1-rc.2 读码（插件侧**当时尚未真机验证**）。

### 新增

- `list_models`：只读模型目录。`await ctx.sessionController.modelCatalog()` →
  `{default, routableProviders, groups:[{id,name,models}], failures}`（v0.6.1 修正：它返回 Promise，
  必须 await；`groups` 只含**有模型**的 provider，`routableProviders` ＝这些 provider id）；
  退路 `ctx.llm.listProviders()` / `listModels(provider)`。可选 `session` ⇒ 额外读该会话的
  `modelSelection` 投影。
- `set_model`：改**一个**会话的模型，**下一轮请求生效**（跑着的 step 不换）。依据
  `ctx.sessionController.selectModel({sessionId, provider, model, reasoningEffort?})`；失败码
  `session/not-found` / `session/writer-held` / `session/model-unavailable`。**副作用**：宿主实现里会
  在后台把该选择写成**全局默认**，所以本插件一律「**先记全局默认 → `selectModel` → 恢复全局默认**」，
  回执如实写 `globalDefault:{before, after, restored}`（恢复失败也照写 `restored:false` + error）。
- `set_default_model` 的前半（`ctx.agentDefaultModel.currentSelection()` / `saveSelection(next)` 之可见性）。
- 新配置键 `domainSessionModel`（`{provider, model, reasoningEffort?}`）＝ create_domain_session 建完
  自动给新会话铺的模型；工具参数 `model` 可逐个覆盖。`create(request)` **不接受模型参数** ⇒ 建完再改。
- 子代理没有独立模型（继承父会话实时路由），插件侧改不了。

### 变更

- 所有宿主 API 都**先 `typeof` 探测**，拿不到就回 `{ok:false, reason:'api-unavailable'}`
  （绝不让 apply 或工具抛错）。

## [0.5.0] - 2026-10-17

可移植化：插件包里不写任何机器路径、也不存运行期数据。

### 变更

- 运行期主目录在加载时解析，不再硬编码（`DSH_DOMAIN_BRIDGE_HOME` 或
  `<os.homedir()>/.dsh/dsh-domain-bridge`）。
- **四层配置解析**（部署配置 → `<home>/config.json` → 环境变量 → `<home>` 默认文件名）：
  `indexFile`（`DSH_DOMAIN_BRIDGE_INDEX` / `registry.json`）、
  `domainsFile`（`DSH_DOMAIN_BRIDGE_DOMAINS` / `domains.json`）、
  `ownerCli`（`DSH_DOMAIN_BRIDGE_OWNER_CLI` / 通用措辞）。
- `stateDir` 默认 `<home>/state`；插件包内的 `state/` 只在"首次加载且 `<home>/state` 还没有内容"时
  作为一次性复制的**源**被读取（源文件保留不动）。
- 缺文件/空文件都是正常的「没有数据」（0 个域、不抛错），包目录永不写入。

## [0.4.2] - 2026-10-14

「暂停」从域级推广到四级：域 / **主（单会话）** / 项目 / 全局。

### 变更

- 机器面字面量只有四个：`domain | session | project | global`（中文文档/回执里把 `session` 叫
  「主（单会话暂停）」）。键：域＝`项目:域`（**仍要求已有在任声明**，用户拍板的 D2=A「承认现状」，
  v0.4.0 语义一字不改）；session＝**完整会话 id**（`session-<uuid>`；短号只在**唯一命中**一条已知会话时
  接受）；project＝项目名小写（cwd 目录名小写，与 claim_domain 短名补全同一约定）；global＝保留键 `*`。
  **后三级不要求有在任声明**（否则永久不可用）。
- **OR 叠加（安全闸）**：任一级 `paused:true` ⇒ 拦；回执必须列出**全部**命中级别
  （`pausedScopes` / `pausedByScopes`），不许只报一个。
- **两端都查**：接收端＝目标域键 / 目标会话 / 目标会话的项目 / global；发送端（本会话）＝本会话 id /
  本会话的项目 / global。**刻意不含**「本会话自己持有的域被暂停」——域级暂停只关那扇门，不禁言整个会话。
- **global 防误触**：`confirm:true`；缺 ⇒ 拒绝（`reason:'global-needs-confirm'`），**一个文件都不写**。
  其余 scope 不要求。
- **入队键＝被投递目标自身的键**（目标是域 ⇒ 域键；目标是会话 ⇒ 会话 id）。队列**不按 scope 分片**；
  一条 pending 能不能投只看它目标**当下**的 OR 判定 ⇒ **drain 逐条重评 OR**（`pausePressersOfQueueKey`）。
- **恢复（`state='active'`）＝重评 OR**：只重投"现在不再被任何一级压着"的 pending；仍被别的级压着的
  **保持 pending** 并给 `drain.stillPausedBy`。驱动范围：global ⇒ 扫 inbox 全量；project:P ⇒ `P:*` 域键
  ＋属于 P 的会话键；session:sid ⇒ 该会话键＋它持有的域键；domain:k ⇒ 该键。
- **降级不静默、也不误拦**：状态文件读不懂 ⇒ 当"没有这条记录"（不拦）但进 `unreadableStateFiles`；
  级联判不成的那一级（例如会话 id 查不到 cwd ⇒ 推不出项目）⇒ **不拦** + 回执给 `unresolved`。
- **存储**：仍「一 scope 一键一文件」。**域级沿用 v0.4.1 的 `k-<flat>-<sha1>.json`**（历史状态文件不能
  因为升级失联）；其余三级加 scope 前缀（`session-…` / `project-…` / `global-…`）⇒ 同一个 key 字符串
  出现在两个 scope 下也结构上不可能互相覆盖。记录里的 `scope` 一律写真实 scope。

### 兼容性

- `set_domain_state(domain=…)` 不带 `scope` ⇒ 仍走 domain 级，旧字段语义逐字不变（新字段只新增）。
- `send_to_domain` 被暂停时的 `reason` **字面量仍是 `'domain-paused'`**（冻结历史字段名，真相放在新增的
  `pausedScopes` / `pausedByScopes`）；未暂停时的投递回执**一个键都不多**（`unresolved` 只在非空时出现）。
- F2 停机通知（`notifyPredecessor`）对四级一律照旧绕开暂停闸（它是止损信，理由见该函数注释；核验者
  B5/H3 点名要求"显式重新论证"，已补在函数头上）。

## [0.4.1] - 2026-10-13

**修「唤醒 bug」**：补上 resume 的接线（agentOptions / setup），并把「取不到接线就不许拉活」定成硬规矩。

### 修复

- **根因（已定性）**：插件调 `ctx.agents.resume` 时**裸传 `{resumeSessionId}`**——既没有 `agentOptions`
  （provider/model），也没有 `setup` ⇒ `agent.options.model` 是 `undefined`，而本部署的 deployment
  persona 段文本写着 `{{model}}`（`dsh-web-app/cordis.patch.yml:16-20`）⇒ **首次组装系统提示就抛错**：
  `prompt variable "{{model}}" has no value for this assembly (section: deployment:persona-prefix)`，
  `turn/start` 后 **100ms 内** `turn/end{kind:"error"}`、零产出（另一条独立硬约束：agent-loop 的路由
  也要求 `options.provider/model`，缺了就抛）。宿主/GUI 那条路没事，因为
  `dsh-api-session-controller` 在 resume **之前**先 `composeAgent()`，把这两个字段补上了
  （`lib/index.js:402` / `:406-410` / `:358-371` / `:460-466`）。`ResumeAgentOptions` 本来就声明了
  `agentOptions?` 与 `setup?`（api-catalog.js:6191-6192）——所以这是**插件漏传**，不是核心不给。

### 新增

- provider/model **分级取源**：① `ctx.agentDefaultModel?.currentSelection?.()`（可选链探测，取不到别炸）
  ⇒ ② 该目标会话**存档**里最近一条 `request/header` 的 config（走 `ctx.sessionQuery.readSession(id)`，
  事件形如 `{type:'request/header', data:{header:{config}}}`——与宿主 `modelSelection` 投影同一处取值，
  api-session-controller:2077-2082）⇒ ③ 两条都空就**不传**（**绝不猜**一个模型出来）。
- `setup` **best-effort**：能挂就挂，两头都挂——(a) 复刻宿主 `installModelSelection` 的两条 waterfall
  （`system-prompt/assemble` 补 provider/model 变量、`agent/request` 覆盖路由；只用公开的 `agentCtx.on`，
  **不 import 核心内部**，也不写 model-switch notice）；(b) `ctx.get('agentPresets')` → `resolve` →
  `mount(agentCtx, presetId)` 把该会话的 preset 挂回去（presetId 取自存档 header 的 `agentPreset`）。
  **整段 try/catch，失败只记不抛**（这一步绝不能把 resume 整个搞失败）。
- 回执新字段 `wakeWiring:{agentOptions:'ctx.agentDefaultModel'|'session-header'|'none',
  setup:'applied'|'skipped'|'failed', setupError:string|null}`；`wake:'probe'` 也带（probe 不跑回合，
  纯回报「真拉活会用哪条路」）。

### 变更

- **失败方向**：取不到 agentOptions 时——`wake:'probe'` 照旧允许（不跑回合）；**要真跑回合的档
  （`followup`/`steer`，即 mode≠`inject`）一律拒绝拉活**，回 `reason:'no-wake-wiring'` + hint 指替代路
  （`create_domain_session` / 人在 GUI 点开）。理由：**拉起来 100ms 后崩，比明确不拉更糟**。这条安全门
  **不看 `force`**（`force` 放行的是「暂停」这条政策，不是这个安全门）。
- **顺带解锁**：`set_domain_state(state='active')` 是**人的显式动作** ⇒ 恢复时**允许尝试唤醒**离线目标，
  唤得起来就按队列原 mode 重投，唤不起来**保留 pending** 并如实回报（`drain.wake`）。这不改变
  「暂停的域不会被别人自动叫醒」——只有人显式调 `active` 才尝试唤醒。

### 已知限制

- 本轮**没有真机重启验证**（派单禁止重启 dsh）：接线按代码级依据实现 + 假 ctx 单测覆盖，
  `ctx.sessionQuery` / `ctx.agentDefaultModel` / `ctx.agentPresets` 在插件 ctx 上的可见性仍是「代码级推断」；
  取不到只降级成 `none`（并因此拒绝要跑回合的拉活，不会裸拉）。

## [0.4.0] - 2026-10-13

「已暂停」中间态，**本轮只做域级**（用户当天拍板的模型；v0.4.2 已推广到四级，本段保留为**当时的决策记录**）。

### 变更

- 模型＝**两个轴 + 生命周期**，**绝不把「暂停」塞进"在线/离线"同一个枚举**：
  事实轴（宿主给、只读）＝**在线 / 离线**（有没有活 Agent，`isSessionOnline`）；政策轴（人给、可逆）＝
  **活动 / 已暂停**（字段 `paused`）；生命周期（已有）＝在用 / **已终结**（`release_domain` 删掉那条声明）。
  对外一律给**派生状态**（派生、不落盘）：`在线·活动` / `在线·已暂停` / `离线·活动` / `离线·已暂停` / `已终结`。
- 作用域本轮只落 `scope:'domain'`（＝域名册里的一个 key，如 `tixiweihu:docs`）。用户明确四级＝域 / 主 /
  项目 / 全局，但**域级先跑通、验过再推广** ⇒ 状态记录里已经带 `scope` 字段、派生状态与拦截判定都走同一套
  函数，后面三级只需补「哪些 key 归到这个 scope」的解析，**不重写这套语义**。
- 存储（两个轴 → 两个文件，各管一条轴，互不覆盖）：事实轴继续只在域名册 `domains.json`
  （domain-owner.mjs 的同一份、同一 schema）——本版**一个字节都没改它**。政策轴 + 生命周期 + 队列落在
  **运行期主目录的 state 目录**（默认 `<home>/state/`，配置键 `stateDir`）：
  `<state>/domains/<safe-key>.json` 状态记录（`{scope,key,paused,pausedAt,pausedBy,note,terminatedAt,
  terminatedBy,updatedAt}`）、`<state>/inbox/<safe-key>.jsonl` 队列（**一行一条**）。这是 v0.4 强制要求的
  落盘数据（`inject` 不持久：dsh 一退出，未读注入会被整体取消——2026-10-12 真机，三个不同会话的待读注入
  在同一秒全部 `canceled`），**不是第二本台账**：在任身份仍只有域名册一份。

### 新增

- `set_domain_state(domain, state:'active'|'paused', note?)`：无 GUI 时的人工控制入口。
  **人手动唤起＝把 state 设回 `active`**，恢复时把队列里的 pending 按**原 mode** 重新投递。
- `withdraw_domain_message(id, domain?, force?)`：撤回一条还在队列里的消息（默认只允许撤回自己发的）。
- 暂停期间**所有插件介导的路径都拦**：`send_to_domain` ⇒ 不投递，**入落盘队列**（排队但可撤回），回执
  **明说**"该域已暂停（谁在何时按下的）＋ 消息已入队（可撤回）"，**绝不**再笼统报 `unreachable`，
  **绝不**静默降级找人顶上；`create_domain_session` ⇒ 拒绝（`reason:'domain-paused'`）；
  `wake` ⇒ 不许把已暂停的域拉活（除非显式 `force:true`）；`claim_domain` / `release_domain` ⇒ **允许**
  （换人 / 退役 ≠ 解暂停），但回执提示"该域仍处已暂停"。

### 已知边界

- 暂停**不改在任身份**（域名册里 sessionId 一个字节不动）。
- 恢复重投**绝不自己去 resume/wake 一个离线会话**（当时是因为裸 resume 必崩才这么定；v0.4.1 补上接线后
  改成「允许**尝试**唤醒」）。2026-10-13 真机：插件 `ctx.agents.resume` 拉活的会话**跑回合会立刻崩**
  （`prompt variable "{{model}}" has no value for this assembly`，`turn/start` 后 100ms 内
  `turn/end{kind:"error"}`）；离线 ⇒ 消息**保留 pending** 并如实回报。
- 插件**只管插件介导的路径**：人自己点开那条会话、或宿主自己 resume，插件拦不住——那也正是用户要的
  「人工手动唤起」。「已终结」只有经**本插件** `release_domain` 终结的域才有墓碑（状态文件里留
  `terminatedAt`）；用 CLI 直接 release 的域不会留墓碑（不新造台账）。

## [0.3.6] - 2026-10-12

三件事，全部来自当天那起「docs 域双活会话」事故。

### 新增

- **建会话不许「静默换届」（F1）**：根因＝同一天给 docs 域开了**第二条活会话**，`create_domain_session`
  回执 `created:true`、**零冲突提示**，两条会话各改各的文档；而只有 `claim:true` 才读域名册。
  现在**无论 claim 与否都先读域名册**，回执常带 `existingOwner`（domain/sessionId/since/by/note/live/
  inArchive；`live` 复用 `isSessionOnline()`，`inArchive` 复用 list_domain_sessions 已经在用的那套索引
  读取，拿不到就是 null + 说明，不新造接口）。该域已有负责人、又没传 `claim:true`、也没传
  `allowExistingOwner:true` ⇒ **不建会话**，回 `created:false` / `reason:'domain-already-owned'` +
  大白话 hint（`dryRun:true` 同样报「会被拒绝」，绝不真建）。传 `allowExistingOwner:true` ⇒ 照建，但带
  `existingOwner` + `warning:'domain-already-owned'`。既有语义不动：`claim:true` 撞在别人身上仍是
  「只回报冲突、不覆盖」；该域空闲、或压根没有声明 ⇒ 与 v0.3.5 逐字一致。
- **交接时给前任发「停机通知」（F2）**：`claim_domain` 的 `force:true`（＝接手别人的域）会自动通知前任：
  **在线** ⇒ 走 `send_to_domain` `mode='inject'` **同一条投递路径**（domainEnvelope + domainMessage，
  `source.kind` 是本插件名、**绝不是 'plugin'**；只塞上下文、**不唤醒**、不跑模型、零成本）；
  **离线或投递失败** ⇒ 往新声明的 note **追加**一行大白话留痕（含时间与未送达原因）。回执新增
  `standDown:{delivered:'inject'|'note-only'|'failed', predecessorSessionId, reason}`。默认不叫醒前任
  （不花成本）；「标题加（已退役）」继续保留；**自己 release 不发停机通知**。
- **`wake='true'` 正式启用（F4）**：探测已通过（`ctx.agents.resume` 69ms 拉活、不跑一轮、存档一条没多）。
  `'probe'` 只拉活不投递（真机验证用）；`'true'` ＝先拉活再投，**投后行为取决于 `mode`**：`inject` ⇒
  **零成本入队**（消息落在对方 `agent/inbox/spliced`、**不跑回合**，要等对方**下一次有人用到它**的那一轮
  才会被读到——也就可能一直没人读；2026-10-12 真机：注入 study 会话后对方毫无反应，直到用户自己给它发了
  一句话触发下一轮，它才「看到」那条域间消息）；`followup`/`steer` ⇒ 真唤醒并跑一轮（有成本、当场就动）。
  **默认仍是关**（`''`＝保持「离线不排队」），只有显式传才生效；且 **wake 只认完整 session id**
  （短号返回 `no-wake-candidate` / `not-a-full-session-id`）。

## [0.3.5] - 2026-10-12

**探测第一跑就抓到自己选错了入口**（真机价值）。

### 修复

- 跑 `wake='probe'` 得到 `resume-unsupported`——插件侧拿到的 `sessionController` **没有** `resume`
  方法（它有 `create`）。真正的入口是 **`ctx.agents.resume({resumeSessionId})`**
  （api-catalog.js:196-200 + ResumeAgentOptions :6191-6192；真机范本 dsh-acp/lib/index.js:714-723）。
  `sessionController.resume(sessionId)`（dsh-api-session-controller/lib/index.js:377）是**宿主内部/客户端侧**
  的东西，插件这一层的 façade 上不暴露。⇒ 候选顺序：`agents.resume` 优先，`sessionController.resume`
  兜底，两个都没有才报 `no-resume-api`，并在回执里写明**用的是哪个入口**（`api` 字段）。
- 教训（与知识库那条"静态链路全通 ≠ 真机上会发生"同族）：**"源码里有这个方法"不等于"插件这一侧拿得到"**，
  判据必须是真机 `typeof service.method === 'function'`，别只看源码行号。

## [0.3.4] - 2026-10-12

「重启后域会话看不见、也投不进」这个缺口的**探测档**。

### 新增

- `send_to_domain` 的 `wake='probe'`：只 resume + 回报，**不投递任何消息**、不跑任何一轮，用来在真机上
  验证「插件能不能把没窗口的会话拉活」「拉活会不会顺带跑一轮」。`wake='true'` 代码已就位，当时**先别用**
  ＝等探测结论（v0.3.6 起正式启用）。默认仍是 `wake` 关＝v0.3.3 行为逐字不变。

### 背景

- 重启后只有被"用到"的会话才有活 Agent（实测：重启前在线的 session-c3e33193 重启后不在在线列表里、存档
  也不再被写；而旧 docs 会话在 13:41:31 被加载 ⇒「点一下才活」）。没加载的会话 = `agents.list()` 里没有
  = 投递拿不到 Agent = 报不可达（离线不排队）。而且 online 是**二元**的，分不清「还在、只是没开机」和
  「彻底没了」。核心早就有把会话拉活的 API：`ctx.sessionController.resume(sessionId)`
  （dsh-api-session-controller/lib/index.js:377-398，GUI 打开会话走的就是它）。

## [0.3.3] - 2026-10-12

建出来的会话要「能读、能跑」，两件都是**建完立刻写事件**，都不改全局默认。

### 新增

- **标题**：`ctx.sessionTitle.rename(agent.session, '[域] 2026-10-12 23:30 · 任务首句')`
  （api-catalog.js:2405-2410）。它会 **pin** 标题：在飞的自动生成被顶掉、之后不再自动命名。对域会话这是
  净赚——宿主建的会话首条消息是**插件投递**的，本来就不触发自动命名（dsh-session-title/lib/index.js:378-403
  只认根会话的第一条「人类」消息）。注意时间戳**前置**：标题被规范化并截到 maxTitleBytes = 80
  （dsh-base/cordis.patch.yml:60），超长时裁的是尾部，时间戳放末尾会被整段裁没；简介只吃剩下的字节预算。
- **权限档**：`ctx.permissionPresets.set(agent.session, name)`（dsh-permission-presets/lib/index.js:344-348，
  resolve 未知名字会抛，apply 追加 permission/preset 事件并落定 sandbox/approval 两个开关）。新会话被部署
  默认钉成 workspace-write + ask（cordis.patch.yml:232,248 + pinInitialPermission :377-383），而 `create()`
  的 SessionCreateRequest 里根本没有这个字段 ⇒ 后台无人值守的域会话会卡在「等一个人点同意」，比放宽更糟。
  官方自己的解法就是「建完立刻写事件」：dsh-webhook/lib/index.js:156（resolve）/182（set）。默认给
  danger-full-access（配置键 domainSessionPreset，工具参数 permissionPreset 可逐个覆盖，可关）。
  注意：这一档的 approval 必然是 never ⇒「被拦再申请升级」那条兜底同时失效；且事件来源字段不允许记录是谁
  改的（只允许 delegation）⇒ 事后无法审计是谁放宽的。
- **退役标记**：release_domain / 交接时把标题标成「（已退役）」（标记同样**前置**）。硬限制：rename 要求
  目标会话仍 **live**，窗口已关或 dsh 重启过就改不了 ⇒ 如实回报，**绝不为了改个标题去 resume/唤醒一个
  会话**。
- 两个服务都按 v0.3.2 的同一套契约取用：不注入、调用时解析、缺失即降级、永不抛错；每一步都能用工具参数
  单独关掉（title / permissionPreset），失败只影响那一步，不影响 created。

## [0.3.2] - 2026-10-11

create_domain_session 必须产生一行人**真能看见**的会话。

### 变更

- 真机事实（`projectlog/2026-10-11-列表可见性-追查.md`）：`create({cwd})` 从不挂进工作区
  （dsh-api-session-controller/lib/index.js:694-708 只有给了 workspaceId 才 `workspace.attachSession()`），
  新会话落到侧栏 "Ungrouped"、被追加到 732 条人工排序行的**最后**，而每个分组只渲染 5 条 idle 行就把
  其余折进 "more"（dsh-client-ui-workspace/lib/client.js:2119-2134）——真存在、真在跑的会话就是看不见。
- 1) 按 cwd 解析**已存在**的工作区（`workspaceRegistry.resolveByPath`，纯读——**绝不**用
  `workspaceRegistry.create`：那会往用户自己的分组顺序最前面插一个新组）并传 `{workspaceId}` 而不是 `{cwd}`
  （两者互斥，:687），宿主于是会挂上去（`workspaceId => cwd = workspace.path`，:694，这让
  dsh-workspace/lib/index.js:111-129 的 realpath 检查按构造成立）。
- 2) 置顶它（`workspaceRegistry.pinSession(sessionId)`，dsh-workspace/lib/index.js:576-587）⇒ 排到本组第 1 行
  ——5 行折叠只切第 6 条 idle 行往后。
- 两个服务都可选、都在**调用时**读（与 getSessionController 同一契约，同一模式 dsh-mnemon/lib/index.js:10142-10147
  已在本 profile 用过），没有它们的部署行为与 v0.3.1 完全一致。成功 create **之后**才发生的挂载失败如实
  回报，**绝不重试**（重试会留下两个会话）。

## [0.3.1] - 2026-10-11

工具输出必须是 LOSSLESS JSON。

### 修复

- 真机：调 `list_domain_owners` 时宿主拒绝整次调用，报
  `tool "list_domain_owners" returned invalid output: value is not lossless JSON`，而错误从不指名是哪个字段。
  根因：结果里带了 `hint: undefined`；`JSON.stringify` 会丢掉 `undefined` 键，于是
  `JSON.parse(JSON.stringify(v))` 不再等于 v。
- 现在每个工具结果都在一个地方过 `pruneUndefined()`（`tool()` 工厂里），递归丢掉
  `undefined`/function/symbol 键（数组位置补 `null`），并归一化所有其它 JSON-lossy 值
  （NaN / ±Infinity → null，-0 → 0，bigint → 十进制字符串，Date → ISO 字符串，Map/Set → 普通对象/数组，
  循环引用 → null）。**修隘口，不修分支。**
- 回归护栏：`node test/smoke.mjs` 深度扫描全部 6 个工具的每条可达分支（当时 6 个）。

## [0.3.0] - 2026-10-11

create_domain_session：从宿主插件里开一个**真顶层会话**，并把一条开工任务排进去。
事实依据（dsh 0.2.0-rc.2 源码，只读）：

- `ctx.sessionController` 是普通宿主服务，列在插件可见的 API 目录里
  （dsh-tool-cordis/lib/types/api-catalog.js:1838 key: 'sessionController'）。
- `SessionCommandController.create(request)` → dsh-api-session-controller/lib/index.js:686-714：
  `:687` workspaceId 与 cwd 互斥、都可不给；`:688` `sessionId = request.sessionId ?? brandString('session-'+randomUUID())`；
  `:694` `cwd = workspace?.path ?? request.cwd ?? this.defaultCwd`；
  `:697` `agents.ensureSession(sessionId, cwd, request.sessionId !== void 0, request.agentPreset)`；
  `:710` 返回 `{ sessionId, ...agentPreset === void 0 ? {} : { agentPreset } }`。
  ⇒ 最小合法请求只有 `{ cwd }`；sessionId 可选（宿主生成 `session-<uuid>`），agentPreset 可选，
  workspaceId 绝不能与 cwd 同时出现。我们**刻意不给 sessionId**，让宿主保持身份唯一来源。
- typert.host.js:192-197 的 request schema：`{ workspaceId?, cwd?, sessionId?, agentPreset? }`
  （spec 里的占位名 "preset" 实际是 `agentPreset`）。
- 建出来的会话会自动通过 `api-session/added` 到达 GUI 侧栏（dsh-api-session-controller/lib/index.js:2873-2875
  → dsh-api-remotes 白名单模式 'emit' → client.js:3615 handleSessionAdded），但**没有 Host→Renderer 导航
  通道** ⇒ 无法把它翻到前台：要么人点一下，要么渲染层客户端插件代点。每次回执都说明这一点。

## [0.2.0] - 2026-10-11

在任声明册（`domainsFile`，由 `ownerCli` 指定的外部 domain-owner CLI 维护）成为**裸域名寻址时的第一事实来源**；
系统索引退为兜底。

- send_to_domain 的解析顺序：
  1) target 命中会话 id（长/短/包含）→ `matchedBy='session-id'`（未变）；
  2) target 命中一条声明且其会话在线 → `matchedBy='declaration'`；
  3) 命中声明但那个会话离线 → 不投递，`reason='declared-owner-offline'`，回报 declaredOwner +
     其它带该索引标注的在线会话（由调用者决定；本插件**从不**自己挑替身）；
  4) 该域没有声明 → 索引标注，`matchedBy='index-label'` + 建议补声明的 hint；
  5) 多个活会话都带该索引标注 → 报警，**绝不挑一个**。
- 声明写入（claim_domain / release_domain）逐字段照抄 domain-owner.mjs：同一 schema、同一键名、同一时间
  字段、同一冲突语义（已被持有 ⇒ 不覆盖、报 conflict；force=true ⇒ 交接并把前任写进 `note`），以及同一套
  原子替换（写 `<file>.tmp` 再 rename）。

## 设计不变量（跨版本保留）

- **没有第二本台账**：本插件只**读**系统索引与声明册；只有 claim_domain/release_domain 写声明册，且与
  domain-owner.mjs 同一套原子语义。文件缺失或损坏一律静默降级——读取永不抛错，也永不阻断投递。
- **静态包里没有 `harness` 全局，且 apply 抛错会让加载器硬失败**（宿主起不来）：本文件所有注册与执行路径
  都不得抛错（体系 P15 红线）。
- 事实依据（dsh 0.2.0-rc.2 源码实测，别按旧版本改）：`ctx.agents.list()` / `get(id)` 返回裸 Agent、无归属
  过滤（dsh-agent/lib/index.js:594）；`Agent.followup({content, source})` 排一条普通下一轮 prompt 并唤醒、
  `steer` 插到最近 step 边界、`inject` 只塞上下文不唤醒（dsh-agent-loop/lib/index.js:800-814，零授权检查）；
  窗口不在线 ⇒ `get()` 返回 undefined ⇒ 报「不可达」，不排队。
- 各历史版本的 [domain-bridge] 行为日志共用对应版本的 traceId（`bridge-v036-1012` / `bridge-v040-1013` /
  `bridge-v041-1013` / `bridge-v042-1014` / `bridge-portable-1017` / `bridge-v060-1017` / `bridge-v061-1017`），
  故事线落在仓库外的 `projectlog/` 记录里。
