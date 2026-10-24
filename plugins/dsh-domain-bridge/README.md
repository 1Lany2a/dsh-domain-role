# dsh-domain-bridge

**域可达层 v0.8.14**（v0.7.0 起新增**斜杠命令**（v0.8.5 起七条：加了 `/resume`）、v0.8 起带**弹窗菜单**、v0.8.7 起换届可**逐项设置**；模型分派：`list_models` 看目录、`set_model` 改单个会话的模型并**自动恢复**全局默认、`set_default_model` 显式改全局默认且**不恢复**）**——给"顶层会话之间互相看得见、发得到"补一段基础能力，让域会话能**自己认领/释放在任声明**，并让任一宿主侧会话能**直接开一个真顶层域会话**（`create_domain_session`）把开工任务排进去。v0.4 起还能把目标**按成「已暂停」**：插件介导的投递不再硬投，而是**落盘入队（可撤回）**，恢复时按原样重投；v0.4.1 修掉了「插件把离线会话拉活之后，它一跑回合就崩」那个 bug（`{{model}}` 唤醒 bug）；**v0.4.2 把「暂停」从域级推广到四级**（域 / 主＝单会话 / 项目 / 全局），判定＝**OR 叠加**、**两端都查**、`global` 要 `confirm`、恢复时**重评 OR**。

> v0.4.2 一句话：**任一级被按下就拦，拦的时候把「是哪几级按的」全部说出来；解一级不够——得把压着目标的那几级都解开，才会重投。**

> v0.5.0 一句话：**插件包里不写任何机器路径、也不存运行期数据——`<home>/config.json` 管本机路径，`<home>/state/` 管暂停记录与落盘队列，首次加载把包内历史 `state/` 复制过去（源文件不动）。**

> v0.6.0 一句话：**`list_models` 只读目录，`set_model` 只改一个会话的模型；因为宿主改会话会顺手把选择写成全局默认，本插件一律「先记 → 改 → 恢复」，并把 `globalDefault:{before, after, restored}` 如实写进回执。**

> v0.6.1 一句话：**首次真机验证暴露两个缺陷——`modelCatalog()` 是 async（v0.6.0 少了 `await`，目录恒空）与会话投影把"会话 id 字符串"喂给了只要 Session 对象的 `stateOf`（必抛）——本版都修了，并补上"统一改模型入口"的全局那一半 `set_default_model`（显式改全局默认、**永不恢复**）。**

## 它解决什么

现状（dsh 0.2.1-rc.2 实测）：模型侧 `send_message` / `list_agents` **只认自己的子树**（直系父子）⇒ 用户手开的顶层会话（我们的"域会话"）之间**互相看不见、也发不到**，只能靠人当信使搬运。

本插件补上这一段：

| 工具 | 作用 |
| --- | --- |
| `list_domain_sessions` | 列出**当前进程里在线的顶层会话**，每个都带：索引域标注 + **是否持有在任声明**（`onDuty` / `dutyDomain` / `dutyDomainKey`）＋ **派生状态**（`state` / `paused` / `pausedDomains` / `pausedScopes` / `pausedByScopes`——**四级 OR**；`在线·已暂停` 不等于被禁言，读法见「四级」一节）；并返回**本会话自己的身份**（id/域/onDuty）。另有 `declarations` 段＝域名册全量在任声明（每条标出会话 `online: true/false` 与派生状态）与 `domainState` 段（五态字典 + 四级作用域 + 被按下记录 + 「已终结」墓碑 + 判不成的级别）。只读，不唤醒任何会话。 |
| `send_to_domain` | 把一条消息投递给某个在线会话：`target` 可填**域**（`asr` / `misas:asr`）或**会话 id**。默认 `followup`（＝对方窗口里来了一条普通消息，唤醒它开一轮）；`mode:"steer"` 用于对方正在跑时的中途纠偏；`mode:"inject"` 只塞上下文不唤醒（对方要等"下一次有人用到它"那轮才读到）；`dryRun:true` 只看会发给谁、不真发。`wake` 见「唤醒」一节。**该域已暂停**时不再硬投，而是**落盘入队**（`reason:"domain-paused"`、`queued:true`、可撤回），`force:true` 才显式放行。 |
| `claim_domain` | **本会话认领一个域**（写入域名册）。`domain` 可写短名 `asr`（项目取 `project` 参数，没给就取**本会话 cwd 的目录名小写**）或 `misas:asr`。已有人持有 ⇒ 不覆盖、报 `conflict`；`force:true` 才强制交接，旧负责人写进 `note` 留痕并**收到一条 inject 停机通知**（`standDown`）。**交接 ≠ 解暂停**：该域仍处已暂停就在回执里明说。 |
| `release_domain` | **本会话释放它自己持有**的域。不是自己在任的域不会被删。`note` 只回显、不落盘（CLI 的 `release` 无 note 字段）。**释放＝生命周期终结**：插件会写一条墓碑（`terminatedAt`），派生状态变「已终结」。 |
| `list_domain_owners` | **只读**列出全部在任声明 + 每条声明的会话当前是否在线 + 派生状态；并带 `domainState` 段（五态字典 + 已终结墓碑 + 读不懂的状态/队列文件清单）。 |
| `create_domain_session` | **开一个新的顶层会话并把开工任务排进去**。`domain` + `task` 必填；`cwd` 缺省用调用方会话的 cwd；`project` 缺省用本会话 cwd 的目录名小写；`claim:true` 时建完把该域的**在任声明指向新会话**（已有别的负责人 ⇒ **不覆盖**，回报冲突并给出换人办法）；`dryRun:true` 只回报"将会建哪个 cwd 的会话、排什么任务"，**绝不真建**。**v0.3.2 起它还会把新会话挂进已存在的工作区分组并置顶到该组最上方**（`pin:false` 可跳过）；**该域已暂停 ⇒ 直接拒绝**（`reason:"domain-paused"`，`dryRun` 也一样、宿主 `create` 一次都不调）。 |
| `set_domain_state` | **（v0.4 新增；v0.4.2 推广到四级）把某一级（域 / 主 / 项目 / 全局）的政策轴设成「已暂停」或「活动」**。`scope` 取 `domain`（默认）/ `session`（主＝单会话）/ `project` / `global`；键：域＝`项目:域`（**仍要求已有在任声明**）、会话＝完整会话 id（短号只唯一命中时接受）、项目＝项目名小写、全局＝保留键 `*`（**按/解都要 `confirm:true`**）。`state:"paused"` ＝ 按下（可逆）；`state:"active"` ＝ **人手动唤起**：解开这一级后**重评 OR**——只重投「现在不再被任何一级压着」的 pending，仍被别的级压着的**保持 pending** 并报 `drain.stillPausedBy`（离线时允许尝试唤醒，见「恢复」一节）。`note` ＝ 为什么按下。`dryRun:true` 只回报会怎么改。 |
| `withdraw_domain_message` | **（v0.4 新增）撤回一条还在队列里的域间消息**。`id` 就是 `send_to_domain` 被暂停拦下时回执里的 `queue.id`；**v0.8.14 起可省 `id`**——只给 `domain` 就撤该队列**最新一条 pending**（默认只认自己发的，`force:true` 才看别人的）。默认**只允许撤回自己发的**；只有 `pending` 能撤（`delivered`/`failed`/`withdrawn` 一律回 `not-pending`，不假装收回）；撤回后该条变 `withdrawn` **留在文件里当留痕**（不删行）。 |
| `list_domain_queue` | **（v0.8.14 新增，只读）列出插件落盘队列里的消息**：`<stateDir>/inbox/<key>.jsonl` 里每条给 `id` / `status` / `mode` / `from`（＋短号）/ `at` / 正文摘要。`status` 取 `pending`（默认）/ `delivering` / `delivered` / `failed` / `withdrawn` / `all`；`domain` 可写域短名、`项目:域` 或会话 id（短号也行）；`mine:true` 只看本会话发的；`limit` 默认 50（上限 200）。另给 `totals`、每个队列一行（`pending` / `total` / `lastAt`）与 `latestId` / `latestMineId`（配 `withdraw_domain_message` 用）。**边界**：只管插件自己的队列——宿主 composer 里的「N 条排队消息」不在里面，插件看不见也撤不回。 |
| `list_models` | **（v0.6.0 新增，只读；v0.6.1 修目录来源与会话投影）列出宿主可路由的模型目录**：首选 `await ctx.sessionController.modelCatalog()`（**它是 async**），**`groups` 为空或形状不认识就退 `ctx.llm.listProviders()` / `listModels(provider)`**；`source` 如实写实际用了哪个（`sessionController.modelCatalog` / `llm` / `empty`）。两个来源都空 ⇒ 如实回 `{ok:true, source:"empty", groups:[], rawKeys:[…], note:"catalog-empty"}`（**不假装有内容**）。可选 `session`（会话 id / 域键）⇒ 额外读该会话的 `modelSelection` 投影，回执带 `session:{target,lastUsed,pending,source}`；读不到就**不给 `session`**、改报 `sessionRead:{ok:false,reason,tried,failures?}`。 |
| `set_model` | **（v0.6.0 新增）改一个会话的模型，下一轮请求生效**。`target` 缺省＝调用者自己，可写会话 id 或域键；执行顺序固定：**记全局默认 → `selectModel` → 恢复全局默认**，回执 `{ok, sessionId, target, applied:"next-request", previous, globalDefault:{before, after, restored}}`。宿主失败码原样带回；恢复失败如实写 `restored:false` + error。 |
| `set_default_model` | **（v0.6.1 新增）显式改宿主的全局默认模型，且永不恢复**（与 `set_model` 相反）。`{provider, model, reasoningEffort?}`；实现＝读 `before` → `ctx.agentDefaultModel.saveSelection(next)` → 读 `after`。影响面：**之后新建的、且尚无会话级选择的 Agent**；回执 `{ok, before, after, source:"agentDefaultModel", note, saved, verified, applied}`——宿主在没有部署配置入口/`configEditor` 时 `saveSelection` 是**静默 no-op**，所以读回来不一致就如实报 `verified:false` / `applied:"not-observed"`，绝不假装成功。服务不可用 ⇒ `api-unavailable`，参数非法 ⇒ `invalid-model`。 |

## 斜杠命令（v0.7.0 起；v0.8.0 起带弹窗菜单；v0.8.5 起菜单**零键入**、二三级选项由宿主侧状态算出；v0.8.7 起交接可**逐项设置**、v0.8.10 起该项改在**应用内面板**里做）

七条宿主命令，命令体**只做编排**（转调上面的工具定义，没有第二套实现、也不经过模型）：

| 命令 | 作用 |
| --- | --- |
| `/register` | 把本会话注册为**体系主会话** / **项目主会话** / **域会话**（`domain <域> [takeover]` 转调 `claim_domain`）；不带参数＝只看当前身份与可选项 |
| `/initialize [check]` | 生成 / 补全项目骨架：`PROJECT.md`、`KNOWLEDGE.md`、`KNOWLEDGE\`、`提案\`、`projectlog\`、`.gitignore` 标准条目——**只补缺失、绝不覆盖**；带 `check` 只报告、一个字节都不写 |
| `/handoff [wizard]` | 开一个接班会话并转移职责（默认参数表：体系 `cordis` / 项目 `standard` / 域 `standard`；模型与权限档取自部署配置）。`wizard` 打开**本地分步表单**逐项改参数；`target=<会话id>` 把在任身份交给**已经开着的**会话（不新建、不唤醒）；`key=<键>` 只能在你真持有的身份里选；`retire=now`＝建成功后当场退役自己 |
| `/retire` | 结束自己的任职：撤注册 + 释放域 + **session 级暂停** + 会话自我改名「（已退役）」；不删历史 |
| `/pause` | 暂停自己 / 一条**会话**（`session <会话id>`）/ 一个域 / 本项目 / 全局（按身份闸；判不出身份就拒绝）；裸跑＝列出当前所有暂停记录（只读） |
| `/resume` | **反向开关**：恢复自己 / 一条会话 / 一个域 / 本项目 / 全局（与 `/pause` 同一套授权）；恢复时重新评估 OR，只重投不再被压着的排队消息 |
| `/pause-all` | 紧急通道：强制暂停（必填原因；`project`/`global` 要**在 60 秒内**补 `--confirm`——服务端记待确认，超时或层级不符一律拒绝），写 `stateDir/audit.jsonl` |

**换届的逐项设置（v0.8.10 起：应用内面板）**：宿主弹窗壳选中一行后必定关闭、没有链式多级的入口（`popupSelect` 只有单层），所以 v0.8.10 改成 `commandUi.decorate` 的 `action` + 把面板渲染进根级 `shell.overlay`：五段手风琴（身份 / 模式 / 模型 / 权限档 / 标题与开工任务）+ 搜索 + 手填模型，选完自动收起，**不再打开浏览器页面**。数据与提交仍走 `POST /api/dsh-domain-bridge/handoff-wizard/data|run`（同一条 `/handoff` 实现，`invocation.params` 直传，**不是第二套**）。旧的本地面板页保留为兜底（面板右上「旧版网页设置」，覆盖层不可用或 600ms 内宿主没挂上时自动退回）。**v0.8.11 起默认开工任务换成 219 字短模板 + 自动生成 ≤2KB 交接卡**，接任者第一轮只读那张卡。

**顺序约定：注册在前、初始化在后。** 注册键就是 cwd 目录名，初始化的产出**不参与**推导——所以空目录（新建项目 / 新体系根）也能先注册，`/initialize` 随后把骨架建起来。只有 `/register system` 在目录里没有 `SYSTEM-OVERVIEW.md` 时要一次显式确认（`--confirm`）：自封体系主会拿到 `/pause global` 权限，值得按一下。

**弹窗菜单**：浏览器半边（`lib/client.js`）用 `commandUi.decorate` 给这七条命令挂 `popupSelect`——输入 `/`、选中命令就能点选参数，不用背语法。菜单**在宿主侧按真实状态算**：每条命令的选项按分组列出（身份／体系层／项目层／域层／参数／紧急），需要再确认的动作走宿主原生确认浮层 ⇒ **人只用点，不用打字**（唯一例外是"开一个全新的域"要给它一个名字）（`POST /api/dsh-domain-bridge/{health,menu,run}`，仅本机可访问），危险动作（接管域、退役、强停、全盘写交接）带二次确认；选完走 `ctx.commands.execute`，回执作为命令流转节点留在会话里。

**注册册**：写在 `_registry/domains.json` 的平行节 `registrations`（`owners` 一字不动，域声明仍在 `owners`）。写盘全程持 `wx` 独占锁 + 唯一临时文件——固定名 `.tmp` 且无锁时，两进程并发各写 30 键最终只剩 2~12 个（静默丢写）。

## 两个轴 + 生命周期：v0.4 的状态模型

**「暂停」不塞进「在线/离线」同一个枚举**——它们是两条独立的轴，外加一条本来就有的生命周期：

| 轴 | 谁给 | 取值 | 存在哪 |
| --- | --- | --- | --- |
| **事实轴** | 宿主给，**只读** | **在线 / 离线** ＝ 有没有活 Agent | 不落盘，每次现算（`ctx.agents.get()`） |
| **政策轴** | **人给，可逆** | **活动 / 已暂停** ＝ 字段 `paused` | 运行期主目录的 state 目录（见「落盘」） |
| **生命周期** | 本插件的 `release_domain` | **在用 / 已终结** | 同一个状态记录里的 `terminatedAt` 墓碑 |

对外一律给**派生状态**（派生、不落盘），就是五种：

| 派生状态 | 含义 |
| --- | --- |
| `在线·活动` | 有活 Agent，也没被按下（正常） |
| `在线·已暂停` | 有活 Agent，但**某一级**被按下（暂停不改在任身份，也拦不住已经活着的它，见「边界」）。⚠️ **这不等于"被禁言"**——看 `pausedByScopes[].via`：是它自己/它的项目/全局被按才发不出去；只是"持有被按下的域"照样发得出去（见「四级」一节） |
| `离线·活动` | 没有活 Agent，政策上是活动的（窗口没开／重启后没加载） |
| `离线·已暂停` | 没有活 Agent，而且被按下了 |
| `已终结` | 已经 `release_domain` 退役（墓碑；域名册里那条声明已经被删） |

**作用域（v0.4.2：四级全部实现）**：`scope` 可取 `domain`（默认，＝域名册里的一个 key，如 `tixiweihu:docs`）/ `session`（＝中文的「主（单会话暂停）」，键＝完整会话 id）/ `project`（键＝项目名小写）/ `global`（键＝保留键 `*`）。四级**互不覆盖**，判定**OR 叠加**——详见下一节。

## 四级「已暂停」（v0.4.2）：OR 叠加 + 两端都查 + 恢复重评

**四级（机器面字面量，只有这四个）**：

| `scope` | 键 | 中文说法 | 要不要有在任声明 |
| --- | --- | --- | --- |
| `domain` | `项目:域`（如 `misas:asr`） | 域 | **要**（用户拍板的「承认现状」＝域级暂停挂在声明册的一个 key 上；v0.4.0 语义一字不改） |
| `session` | 完整会话 id（`session-<uuid>`；短号 `sess-xxxxxxxx` 只在该短号**唯一命中**一条已知会话时接受） | **主（单会话暂停）** | 不要 |
| `project` | 项目名小写（某会话 cwd 的目录名小写，与 `claim_domain` 短名补全同一约定） | 项目 | 不要 |
| `global` | 保留键 `*`（唯一） | 全局 | 不要；**按/解都要 `confirm:true`**（缺 ⇒ 拒绝，`reason:"global-needs-confirm"`，**一个文件都不写**） |

**判定＝OR 叠加（安全闸）**：任一级 `paused:true` ⇒ 拦。回执必须列出**全部**命中级别：

```json
"pausedScopes": ["domain", "project"],
"pausedByScopes": [ { "scope": "domain",  "key": "misas:asr", "via": "target-domain", "side": "target", "pausedAt": "…", "pausedBy": "session-…" },
                    { "scope": "project", "key": "misas",     "via": "target-project","side": "target", "pausedAt": "…", "pausedBy": "session-…" } ]
```

`via` 让人一眼看出是**接收端**还是**发送端**：接收端＝`target-domain` / `target-session` / `target-project` / `global`；发送端＝`self-session` / `self-project` / `global`（`side` 字段同时给 `target` / `self` / `both` / `global`）；列表里由"它持有的域"命中的那条，`via` 写作 `held-domain`。

**怎么读 `在线·已暂停`（很重要）**：它只说「**跟这条会话相关的某一级被按下了**」，**不等于"它被禁言"**。是否真发不出去，看 `pausedByScopes[].via`：

| `via` | 含义 | 这条会话还发得出去吗 |
| --- | --- | --- |
| `self-session` | **它自己**被 session 级按下 | ❌ 发不出去 |
| `self-project` | **它的项目**被 project 级按下 | ❌ 发不出去 |
| `global` | 全局被按下 | ❌ 发不出去 |
| `held-domain`（列表行）/ `target-domain`（拦截回执） | 它只是**持有一个被按下的域**（或目标就是那个域） | ✅ **照样发得出去**——域级暂停只关那扇门 |

这正是「域级暂停**不禁言整个会话**」那条边界在列表上的样子；`在线·已暂停` 与 `离线·已暂停` 都按同一套读法。

**两端都查**：

| 端 | 查哪几级 |
| --- | --- |
| **接收端**（target） | ① 目标域键 ② 目标会话 id（能解析出时） ③ 目标会话所属项目 ④ `global` |
| **发送端**（本会话） | ① 本会话 id ② 本会话所属项目 ③ `global` |
| **刻意不含** | 「本会话**自己持有**的域被暂停」——域级暂停只关那扇门，**不禁言整个会话**（这条边界是为了让域级行为与 v0.4.1 逐字一致） |

**降级不静默、也不误拦**（S7）：状态文件读不懂 ⇒ 当「没有这条记录」（不拦），但文件名进 `unreadableStateFiles`；级联里哪一步拿不到信息（如某会话 id 查不到 cwd ⇒ 推不出项目）⇒ 该级**不拦**，但回执标出 `unresolved`（写明哪一级没判成）。**`unresolved` / `unreadableStateFiles` 只在非空时出现**——所以"什么都没坏"的普通投递回执，键集仍与 v0.3.6 **逐字一致**。

**F2 停机通知是唯一的例外（四级都一样）**：`claim_domain(force:true)` 给前任发的那条 inject 停机通知**不走暂停闸**，四级都不走——它是止损信，理由见下「边界」。

## 「已暂停」：三档拦截 + 落盘队列 + 可撤回

人在没有 GUI 的时候靠 `set_domain_state(scope?, domain?, state:"paused", note?)` 按下。按下的那一刻起，**插件介导的路径**分成三档：

| 路径 | 暂停期间的行为 |
| --- | --- |
| `send_to_domain` | **不投递、也不替你找人顶上**：消息**落盘入队**，回执 `reason:"domain-paused"`（**冻结的历史字面量**，四级都一样）、`queued:true`、`queue.id`（撤回要用它）、`paused/derivedState/pausedAt/pausedBy/pauseNote/pausedScopes/pausedByScopes` 全给（**绝不**笼统报 `unreachable`）。**入队键＝被投递目标自身的键**：目标是域 ⇒ 域键；目标是会话 id ⇒ 会话 id。`wake` 也一并被拦（`wakeBlocked:"domain-paused"`，连 `probe` 都不去拉活）。想硬投：`force:true`（回执带 `pausedOverride:true`，**暂停本身不变**；这道 force **不看**拉活接线那道安全门）。 |
| `create_domain_session` | **直接拒绝**：`created:false` / `reason:"domain-paused"` / `scope` / `derivedState` / `pausedScopes`，**宿主 `create` 一次都不调**（`dryRun:true` 也一样，且不给 `wouldCreate`）。拦的是**接收端**（将新建的域 / 它的项目 / 它的负责人会话 / global）＋**发送端**（本会话 / 本会话的项目 / global）。 |
| `claim_domain` / `release_domain` | **照常允许**（换人 / 退役 ≠ 解暂停），但回执**明说**「仍处已暂停（谁在何时按下的）」＋**全部命中级别**＋恢复办法。`release` 还会写下生命周期墓碑 ⇒ 派生状态变「已终结」，并在回执里给出终结那一刻还按着它的级别。 |

**队列**：`<stateDir>/inbox/<safe-key>.jsonl`，**一行一条**，`status` 走 `pending → delivered / failed / withdrawn`；`mode` 与信封正文在**入队时冻结**（恢复时按原 mode 原样重投，不会因为后来改了默认值而变形）；记录里的 `scope` 是**目标自身的 scope**（域键 ⇒ `domain`、会话 id ⇒ `session`），被哪几级按下另存在 `pausedByScopes`（纯取证，**不参与判定**）。dsh 重启**不丢**（对比之下 `mode:"inject"` 的未读注入在退出时会被整体取消）。

**撤回**：`withdraw_domain_message(id, domain?, force?)` —— 默认只允许撤回**自己发的**（`from` 必须等于本会话 id，否则回 `not-owner`）；`force:true` 才动别人的（回执 `forced:true`）；只有 `pending` 能撤，撤完变 `withdrawn` 并**留在文件里当留痕**（不删行）。它管不了"人已经在对方窗口里看到的那条"。

**状态文件读不懂就一律不写**（`state-file-unreadable`，绝不覆盖别人的记录）；读不懂的坏文件**不拦投递**（失败方向刻意选"当作活动"），但会在 `list_*` 的 `domainState` 里如实列出来（`unreadableStateFiles` / `degradedQueueFiles`）——**降级不静默**。

## 恢复（人手动唤起）：重评 OR + 重投，以及 v0.4.1 之后的「尝试唤醒」

`set_domain_state(scope?, domain?, state:"active")` 是**人的显式动作**，它做两件事：把**这一级**的政策轴设回活动 + **重新评估 OR**，只把「现在不再被任何一级压着」的 pending 按**原 mode** 重投（`drain` 段如实回报 `delivered` / `failed` / `stillPending` / `stillPausedBy` / `statusWriteFailures`）。

- **解一级不够**：域恢复了、但项目 / 全局还压着 ⇒ 那条 pending **保持 pending**，`drain.reason === "still-pressed"`、`drain.stillPausedBy` 给出还被谁压着。**这正是"OR 叠加"的必然后果**，也是 drain 的唯一正确性来源：一条 pending 能不能投，只看它目标**当下**的判定，与当初被哪一级拦下无关。
- **扫哪些队列只是优化**：`global` ⇒ inbox 目录全量；`project:P` ⇒ `P:*` 域键 ＋ 属于项目 P 的会话键（判不出归属的进 `drain.skipped`，**不投、不乱投**）；`session:sid` ⇒ 该会话键 ＋ **它持有的域键**；`domain:k` ⇒ 该键。多条队列时 `drain.multi:true`，`delivered`/`failed`/`stillPending` 是聚合，逐队列明细在 `drain.queues`。

目标当前没有活 Agent 时：

- **v0.4.0**：一律**不碰**——保留 `pending` 并如实回报。（当时的理由是真机发现的 bug，见下节。）
- **v0.4.1 起**：**允许尝试唤醒**（走 `.agents.resume` 并把接线一起接好）：**唤得起来 ⇒ 按队列重投**；**唤不起来**（没接线 / resume 抛错 / 拉起来也没 Agent）⇒ **消息原样保留 `pending`** 并如实回报，结果就在 `drain.wake` 里（`ok` / `reason` / `error` / `wakeWiring`）。
- ⚠️ **只有人显式调 `active` 才尝试唤醒**：「暂停的域不会被**别人**自动叫醒」这条没变——别人发消息仍然只会入队。
- ⚠️ 队列里只要有**一条要跑回合的**（mode 不是 `inject`），唤醒就必须带接线，否则**拒绝裸拉**（见下节的安全门）：这时 `drain.wake.reason === "no-wake-wiring"`。

## 唤醒（`wake`）与 `{{model}}` 唤醒 bug 的修复（v0.4.1）

`wake` 的作用是"把一条**存档里有、但当前没加载**的会话拉活"（＝ GUI 里"点一下才活"那个动作）。**只认完整 session id**（短号 `sess-xxxxxxxx` 拉不活，回 `no-wake-candidate`）。

| `wake` | 做什么 |
| --- | --- |
| `''` / `'false'`（默认） | 不叫醒。离线就是离线（不排队，回 `unreachable` / `declared-owner-offline`）。 |
| `'probe'` | **只拉活 + 回报**：不投递任何消息、不跑任何一轮（真机验证用）。 |
| `'true'` | 先拉活再投。投完发生什么**取决于 `mode`**：`inject` ⇒ 零成本入队（不跑回合）；`followup` / `steer` ⇒ **真唤醒并跑一轮**。 |

**v0.4.1 修的那个 bug（真机，2026-10-13）**：插件以前调 `ctx.agents.resume` 时**裸传** `{resumeSessionId}`——既没 `agentOptions`（provider/model），也没 `setup`。于是那个 Agent 的 `options.model` 是 `undefined`，而本部署的 deployment persona 段文本里写着 `{{model}}` ⇒ **第一次组装系统提示就抛错**：`prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`，`turn/start` 后 **100 ms 内** `turn/end{kind:"error"}`、零产出。宿主/GUI 那条路没事，因为它在 resume **之前**先 `composeAgent()` 把这两样补上了。**是插件漏传，不是核心不给**（`ResumeAgentOptions` 本来就声明了 `agentOptions?` 和 `setup?`）。

现在拉活时：

1. **provider/model 分级取源**（取不到就**不传，绝不猜**）：① 宿主全局默认模型 `ctx.agentDefaultModel.currentSelection()` ⇒ ② **该会话存档**里最近一条 `request/header` 的 `config`（走 `ctx.sessionQuery.readSession(id)`）⇒ ③ 都没有 ⇒ 空。
2. **`setup` best-effort**：能挂就挂——装模型选择（复刻宿主的 `installModelSelection` 两条 waterfall：系统提示组装时补 `provider`/`model` 变量、请求路由时覆盖）+ 用 `ctx.get("agentPresets")` `resolve`→`mount` 把该会话的 `agentPreset` 挂回去。**整段 try/catch，失败只记不抛**（这一步炸了不会把 resume 一起炸掉）。
3. **回执如实报明用了哪条路**（新增字段，`probe` 也带）：

```json
"wakeWiring": { "agentOptions": "ctx.agentDefaultModel | session-header | none",
                "setup": "applied | skipped | failed", "setupError": null }
```

4. **取不到接线时绝不裸拉**（安全门）：要真跑回合的档（`followup` / `steer`，即 `mode≠inject`）**一律拒绝拉活**，回 `reason:"no-wake-wiring"` + hint 指替代路（`create_domain_session`，或让人在 GUI 点开那条会话）。`mode:"inject"`（不跑回合）与 `wake:"probe"`（只探测）**不受影响**。理由很直白：**拉起来 100 ms 后崩，比明确不拉更糟**——还会把那条会话变成"看起来在线、其实跑不动"。这道安全门**不看 `force`**（`force` 放行的是「暂停」这条政策，不是它）。同理，插件侧的第二个候选入口 `sessionController.resume(sessionId)` **收不下**接线，所以只要这次要跑回合，走它也一律拒绝。

## 边界：插件只管「插件介导的」那条路

- **拦不住人**：人自己在 GUI 点开那条会话、或宿主自己 resume——插件拦不住，**那正是「人工手动唤起」**，也是暂停语义里刻意留的口子。
- **「在线·已暂停」是真实的**：暂停不改在任身份、也不会去关掉一个已经活着的会话；所以一个已经跑着的域会话在暂停期间照样能改文件。插件能做的只是"不再往里递新活"。
- **停机通知是例外，故意不拦（v0.4.2 对四级重新论证）**：`claim_domain(force:true)` 给**前任**发的那条 inject 停机通知**不走暂停闸——四级都不走**。理由：① 前任是"单条会话"，它被 `session` 级按下、或它的项目被按下、或全局被按下，**都不改变**「它已经不再是这个域的负责人」这个事实，那句话照样得送到；② 四级暂停**都拦不住人/宿主已经让它活着在跑**，所以"前任正握着这个域在改文件"这个最危险的场景，**会不会发生与按了哪几级无关**；③ 它只 inject、不跑模型 ⇒ 四级下也不会把任何一个被按下的级别"叫活"。拦掉它比放过它危险得多（这正是 v0.3.6 那起"双活会话并发覆盖"的成因）。
- **「已终结」的墓碑只有本插件写的才有**：只有经本插件 `release_domain` 退役的域才在状态目录里留 `terminatedAt`；用 `ownerCli` 指向的外部 CLI 直接 release 的域不会留墓碑（不新造台账）。

## 落盘：`stateDir` 与两个状态文件的格式

政策轴 + 生命周期 + 队列落在**运行期主目录的 state 目录**（配置键 `stateDir`，默认 `<home>/state/`，**不写进插件包、也不写进 `_registry` 树**）。`home` ＝ `DSH_DOMAIN_BRIDGE_HOME`，没设就是 `<homedir>/.dsh/dsh-domain-bridge`。这里**不是第二本台账**：在任身份仍然只有域名册一份，状态目录里没有任何「谁在任」的记录。

```yaml
config:
  stateDir: '<你的目录>'   # 不给＝<home>/state；写 '' 也退回默认
```

```text
<stateDir>/domains/<safe-file>.json    状态记录（一个 (scope,key) 一个文件，原子替换：写 .tmp 再 rename）
  { scope:"domain|session|project|global", key:"misas:asr"|"session-<uuid>"|"misas"|"*",
    paused:true, pausedAt, pausedBy, note, resumedAt, resumedBy,
    terminatedAt, terminatedBy, updatedAt }
  ⚠️ 记录里的 scope 一律是**真实 scope**（v0.4.0 那两处硬编码 domain 已逐个改掉）
  读不到 / 格式坏掉 ⇒ 写入中止（绝不覆盖），读取按"活动"降级但不静默

<stateDir>/inbox/<safe-file>.jsonl     队列（**一行一条** JSON，dsh 重启不丢）
  { id, at, from, key, scope:"domain|session", mode, content, replyTo, pausedByScopes:[…],
    status:"pending|delivered|failed|withdrawn",
    deliveredAt, deliveredBy, failedReason, failedAt, withdrawnAt, withdrawnBy }
  ⚠️ `scope` 是**目标自身的 scope**（域键 ⇒ domain、会话 id ⇒ session）；队列**不按 scope 分片**
  坏行只跳过并记账（degradedQueueFiles），好行照用；撤回只改 status、**不删行**
```

**文件名＝一 scope 一键一文件（v0.4.2）**：`<safe-file>` 的基座是「key 小写 → 把非 `[a-z0-9_.-]` 压成 `_` → 截 60 字符 → 加 `-` + 该 key 的 sha1 前 8 位」。

- **域级沿用 v0.4.1 的 `k-<flat>-<sha1>`**（历史状态文件不能因为升级而失联）；
- 其余三级加 scope 前缀：`session-k-…` / `project-k-…` / `global-k-…` ⇒ 同一个 key 字符串出现在两个 scope 下也**结构上不可能**互相覆盖；顺带把「记录里的 scope 与文件所属 scope 不一致」变成可检测的（写入时拒绝，`reason:"scope-conflict"`）。

## 建会话：`create_domain_session`（v0.3 新增；v0.3.2 起会入组 + 置顶）

调的是宿主服务 `ctx.sessionController.create(request)`，**最小合法请求只要给 `cwd`**：

| 字段 | 必填？ | 证据 |
| --- | --- | --- |
| `cwd` | 可选（不给就用宿主默认 cwd） | `dsh-api-session-controller/lib/index.js:694` `const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd` |
| `sessionId` | **可选**，不给时宿主自己生成 `session-<uuid>` | 同文件 `:688` `const sessionId = request.sessionId ?? brandString(\`session-${randomUUID()}\`)` |
| `agentPreset` | 可选（不给＝宿主的默认 preset） | 同文件 `:697` 第四个实参 / `:363` `presets.resolve(presetId)` |
| `workspaceId` | 可选，但**与 `cwd` 互斥** | 同文件 `:687` 两者都出现就抛 `gateway/bad-request` |

因此本工具**不自己造 sessionId**（让宿主当唯一身份来源），请求就是 `{ cwd }`（给了 `agentPreset` 才多一个键）。⚠️ 参数名是 **`agentPreset`**，**没有** `preset` 这个字段。真实实现最终落到 `ctx.agents.create({sessionId, meta:{cwd, agentPreset?}, ...})`（同文件 `:450-458`）。

建完**紧接着**用与 `send_to_domain` **完全相同**的一份 v4 用户消息（同一个构造函数，不复制第二份）把 `task` 排进新会话的 inbox 并唤醒它。抬头上写明"这是域会话的开工任务"，页脚写明回话方式（`send_to_domain`，`target` = 创建者会话 id）。

**建完怎么用**：新会话带 `running` 状态出现在左侧列表（运行中的行免折叠），并且 v0.3.2 起它已经被**挂进对应工作区分组 + 置顶到该组第 1 行**。**请人到左侧会话列表点开 `sess-xxxxxxxx` 那一条**——本工具翻不了前台，原因见下节。

## 模型分派（v0.6.0 起，v0.6.1 修正）：`list_models` / `set_model` / `set_default_model`

宿主给插件这几个相关能力（dsh 0.2.1-rc.2 **读 asar 定案**；`set_model` 与 `agentDefaultModel` 已真机验证，`list_models` 的目录来源与会话投影按下面的真接口改写）：

- `ctx.sessionController.selectModel({sessionId, provider, model, reasoningEffort?})`：改该会话模型，**下一轮请求生效**（正在跑的 step 不换）。失败码：`session/not-found` / `session/writer-held` / `session/model-unavailable`。
- **`ctx.sessionController.modelCatalog()` 是 `async`**（`dsh-api-session-controller/lib/index.js:3121` `return buildModelCatalog(this.ctx)`；实现 `lib/types/catalog.js:10` `export async function buildModelCatalog(ctx, …)`）⇒ **必须 `await`**。返回 `{default, routableProviders, groups:[{id,name,models}], failures}`；它自己就是用 `ctx.llm.listProviders()`（同步）+ `await ctx.llm.listModels(provider.id)` + `resolveModelInfo` 组装的，并且**只保留有模型的 provider 分组**。退路 `ctx.llm.listProviders()` / `listModels(provider)`。
  - **v0.6.1 修的真机 bug**：v0.6.0 少了 `await`，拿到的是一个 Promise ⇒ 真机回执 `groups:[]`、`routableProviders:null`（而 `default` 其实是退到全局默认读出来的），于是"列不出任何 provider/model"。现在 `await`，且 **`groups` 为空（或形状不认识）就自动退 llm 目录**；两个来源都空时**如实报空**：`{ok:true, source:"empty", groups:[], rawKeys:[…], note:"catalog-empty", attempts:[…]}`（`rawKeys` 是 modelCatalog 原始返回的键名，`attempts` 是每个来源逐步的 state，专为下次诊断）。
- `ctx.agentDefaultModel.currentSelection()` / `saveSelection(next)`（`dsh-agent-default-model/lib/index.js`）：读/写**全局默认模型**。

| 工具 | 参数 | 做什么 |
| --- | --- | --- |
| `list_models` | 无，或 `session`（会话 id / 域键） | 只读列目录：`{ok, source, default, routableProviders, groups:[{provider,name,models:[{id,name,reasoning?}]}], failures?, session?}`。`source` 如实写实际来源（`sessionController.modelCatalog` / `llm` / `empty`）。给了 `session` 就读该会话的 `modelSelection` 投影，回执带 `session:{target,matchedBy,lastUsed,pending,source}`；读不到就**不给 `session`**、改报 `sessionRead:{ok:false,reason,tried,failures?}`。两个目录来源都空 ⇒ `{ok:true, source:"empty", groups:[], rawKeys:[…], note:"catalog-empty"}`。 |
| `set_model` | `{target?, provider, model, reasoningEffort?}` | 改**一个**会话的模型。`target` 缺省＝调用者自己（拿不到调用者会话就报 `target-unknown`，要求显式传）；可写会话 id（`session-…` / 短号 `sess-…`）或域键（`项目:域` / 短名 ⇒ 走域名册解析成负责人会话）。`reasoningEffort` 传了才一起传（不发明默认值）。 |
| `set_default_model` | `{provider, model, reasoningEffort?}` | 改**宿主的全局默认模型**（`agentDefaultModel.saveSelection`），**永不恢复**。影响面＝**之后新建的、且尚无会话级选择的 Agent**；改正在跑的会话请用 `set_model`。 |

### `session` 那一半是怎么读的（v0.6.1：换成真接口）

`list_models` 给 `session` 时，按"够得着"的顺序读两个**真**接口：

1. **`ctx.sessionController.projections({sessionId}, signal)`**（`dsh-api-session-controller/lib/index.js:3280`，`@Remote('projections')` 在 `:2698`）⇒ `{kind:'sequenced', asOfSeq, values}`，其中 `values.modelSelection` 是**wire 视图** `{lastUsed, next}`（`next` ＝ 宿主内部的 `pending ?? lastUsed`；见 `lib/types/model-selection-projection.js:42-52`）。**它吃会话 id**，所以**活会话和已存档会话都能读**（内部先看活会话，再退 `sessionQuery.observeSession`）。
2. 退路：拿**活 Session 对象**（`ctx.sessions.get(id)`——`@deepseek-ai/dsh-session/lib/index.js:1739/1980` 注册的服务，返回 `store.get(id)?.session`；或 `ctx.agents.get(id).session`——宿主自己就这么用，`dsh-api-session-controller/lib/index.js:366`）再喂给 `ctx.sessionProjections.stateOf(session, 'modelSelection')`（`dsh-session-projection/lib/types/index.js:132`）⇒ 宿主状态 `{lastUsed, pending}`。

- **v0.6.1 修的真机 bug**：v0.6.0 把**会话 id 字符串**直接喂给了 `stateOf`。`stateOf(session, key)` 内部要用 `session.header` / `session.snapshotEvents()`（活会话/存档会话的日志折叠），字符串进去**必抛** TypeError ⇒ 被兜底吞掉 ⇒ 真机回执里 `session` 字段整个缺失。现在 id 走接口 ①，接口 ② 只喂 Session 对象。
- 读法 ① 的 `pending` 是宿主 wire 视图的 `next`（＝`pending ?? lastUsed`）；读法 ② 的 `pending` 是宿主原生的 `pending`。回执里的 `session.source` 会写明用的是哪一个。
- 两条路都读不到 ⇒ **不再静默省略**：回执改给 `sessionRead:{target, matchedBy?, ok:false, reason, tried:[…], failures:[{source, reason}]}`，把"试了哪几种、为什么不成"摆到台面上。

### `set_model` 的回执形状

```json
{ "ok": true, "sessionId": "session-…", "target": "misas:asr",
  "matchedBy": "declaration", "applied": "next-request",
  "previous": { "provider": "commandcode", "model": "deepseek/deepseek-v4-flash", "reasoningEffort": "off" },
  "globalDefault": { "before": { … }, "after": { … }, "restored": true } }
```

### `set_default_model` 的回执形状（**不恢复**，与 `set_model` 相反）

```json
{ "ok": true,
  "before": { "provider": "commandcode", "model": "deepseek/deepseek-v4-flash", "reasoningEffort": "off" },
  "after":  { "provider": "commandcode", "model": "deepseek/deepseek-v4-flash", "reasoningEffort": "high" },
  "saved":  { "provider": "commandcode", "model": "deepseek/deepseek-v4-flash", "reasoningEffort": "high" },
  "source": "agentDefaultModel",
  "note": "影响之后新建的、且尚无会话级选择的 Agent；改正在跑的会话要用 set_model",
  "verified": true, "applied": "global-default" }
```

⚠️ **"调成功"不等于"真写进去了"**：宿主的 `saveSelection` 在**没有部署配置入口**（`fiber.entry === undefined`）或**没有 `configEditor`** 时是**静默 no-op**——返回 fulfilled `undefined`，什么也没改。所以本工具写完会把 `currentSelection()` **读回来**逐字比对：一致 ⇒ `verified:true` / `applied:"global-default"`；不一致 ⇒ `verified:false` / `applied:"not-observed"`、`after` 如实是旧值、hint 明说"不能确认真的写进去了"；完全读不回（没有 `currentSelection`）⇒ `applied:"readback-unavailable"`。三种情况都**不抛错**。

### ⚠️ 改会话会顺手改全局默认——`set_model` 会自动恢复

`selectModel` 的实现会在**后台把这个选择写成全局默认**（`saveSelection`）。所以本插件对每一次模型改动都固定三步：

1. 先读 `ctx.agentDefaultModel.currentSelection()`（失败就记 null）；
2. 调 `selectModel(...)`；
3. 把全局默认**恢复成刚记下的值**（`saveSelection(prev)`，仅当 prev 为真且与这次选择不同）。

回执里的 `globalDefault:{before, after, restored}` 如实说明这件事：恢复失败也照写 `restored:false` + `error`，**绝不假装成功**；`applied:"next-request"` 表示正在跑的这一 step 不会换模型，下一轮才生效。宿主没有 `selectModel` ⇒ `{ok:false, reason:"api-unavailable"}`，不抛错。**要"改完就留着"（改全局默认）请用 `set_default_model`，它绝不会写回旧值。**

### `create_domain_session` 建完铺模型

宿主的 `create()` **不接受模型参数**，所以只能「建完再改」。`create_domain_session` 新增可选 `model:{provider, model, reasoningEffort?}`：

- 传了 `model` ⇒ 建成功后立刻对**新会话**调一次 `selectModel`（同一套「记 → 改 → 恢复」），回执多一个 `modelApplied:{ok, provider, model, source:"explicit", error?}`；
- 没传 ⇒ 读配置 `domainSessionModel`（`source:"config"`）；
- 两者都没有 ⇒ 保持旧行为（继承全局默认），回执里**不出现** `modelApplied`；
- **建会话本身失败时一个模型都不改**（`create` 之前不碰模型）。

配置示例（部署配置或 `<home>/config.json` 都行；非法/缺字段一律当"没有"，永不抛）：

```yaml
config:
  domainSessionModel:
    provider: commandcode
    model: deepseek/deepseek-v4-flash
    reasoningEffort: off        # 可选
```

```json
{ "domainSessionModel": { "provider": "commandcode", "model": "deepseek/deepseek-v4-flash", "reasoningEffort": "off" } }
```

### 限制：子代理没有独立模型

子代理（subagent）**不持有独立模型选择**，它继承父会话的实时路由——插件侧改不了它，`set_model` 只作用于**顶层会话**的会话级选择。这是宿主模型，不是本插件的缺口。

## v0.3.2：入组 + 置顶（让新会话在侧栏抬眼可见）

**为什么要加**（真机追查：`projectlog/2026-10-11-列表可见性-追查.md`）：`create({cwd})` 只给 cwd 时宿主**不会**把会话挂进任何工作区（`dsh-api-session-controller/lib/index.js:694-708` 只在给了 `workspaceId` 时才调 `workspace.attachSession()`）⇒ 它掉进侧栏「**未分组**」桶、在手工排序里被追加到已保存顺序的**最末**（本机实测该桶有 732 条）；而每个分组对**空闲**行只渲染 **5 条**、其余折进「更多」（`dsh-client-ui-workspace/lib/client.js:2119-2134`）⇒ 会话真的建出来了、真的在跑，人在侧栏里找不到。

**v0.3.2 的两步**（都在宿主侧；**零新增顶层 import**）：

| 步 | 调用 | 依据 | 失败 ⇒ 降级 |
| --- | --- | --- | --- |
| ① 入组 | `ctx.get('workspaceRegistry')` → `resolveByPath(cwd)`（**纯读，绝不 `create`**：那会凭空多一个分组并改动用户的分组顺序）→ 命中就传 `{workspaceId}` 而不是 `{cwd}` | `dsh-tool-cordis/lib/types/api-catalog.js:3616`（key）/ `:3681`（`resolveByPath`）；`dsh-workspace/lib/index.js:635-638`；`create` 的 `workspaceId`/`cwd` 互斥在 `dsh-api-session-controller/lib/index.js:687`，传 `workspaceId` 时 cwd 取自 `workspace.path`（`:694`）⇒ attach 的 realpath 校验必然通过（`dsh-workspace/lib/index.js:111-129`） | 注册表拿不到 / 没命中 / resolve 抛错 ⇒ **退回 v0.3.1 的 `{cwd}`**（请求逐字相同）；`workspaceId` 版 create 抛错（如 `workspace/not-found`）⇒ **自动退回 `{cwd}` 重试一次**，再失败才 `{created:false, reason:"create-failed"}` |
| ② 置顶 | `registry.pinSession(sessionId)` | `dsh-workspace/lib/index.js:576-587`（幂等、`Promise<void>`、写 `~/.dsh/storages/workspace.json` 的 `global.pinnedSessionIds`、**不要求会话已 attach**）；写盘后 `dsh-api-workspace-controller` 推 `{type:'pinned'}` 给已打开的侧栏 ⇒ **即时生效，不用刷新** | 拿不到注册表 / 抛错 ⇒ `pinned:{ok:false, reason}` 如实回报，**不影响 `created:true`**；兜底提示链：那个分组若**折叠**就先点组名展开（折叠组一行都不渲染），再不行用**侧栏搜索框输 cwd 的目录名**（无标题会话按 cwd 尾目录名也能命中），或把排序方式切成「最近更新」 |

### ⚠️ `create` 失败 ≠ attach 失败（本版最关键的区分）

宿主 `create()` **先建会话、后 attach**（`dsh-api-session-controller/lib/index.js:697` → `:701-708`），attach 失败抛 `RemoteError("session/workspace-attach-failed", ..., {sessionId, workspaceId})`——**这时会话已经存在**。所以本插件：

- **认出这个标记就绝不重建**（重建会多出第二条孤儿会话）：从 `error.details.sessionId` 取回 id（退一步从错误文本 `session "<id>" was created` 解析，再退一步如实报 `{created:true, reason:"created-but-workspace-attach-failed"}` 且不置顶），按「**已创建但未入组**」如实回报，并**继续走置顶**（pin 不要求已 attach，所以它照样能被顶到「未分组」最上方）。
- 严格按 `error.code` 判别（**不用 instanceof**，跨 realm 会失效；`dsh-typert-protocol/lib/types/remote-error.js:7` 明说"Discrimination is always by `code`"）。
- 其它错误（如 `workspace/not-found`，此时什么都没建出来）才允许走「退回 `{cwd}` 重试一次」。

### 返回体新增

`workspace`（`lookup` / `lookupError` / `id` / `title` / `requested` / `attached` / `createFallback` / `createFallbackError` / `attachError`——**每个键恒在**，值为 `null`/布尔，绝不含 `undefined`）、`pinned`（`{ok, reason}`）、`session.workspaceId` / `session.workspaceTitle` / `session.attachedToWorkspace`，以及 `dryRun:true` 时的 `wouldPin`。

`lookup` 取值：`resolved-by-path` / `resolved-from-list` / `no-workspace-for-path` / `resolve-failed` / `workspaceRegistry-unavailable`。

### 降级链（一句话）

**拿不到 `workspaceRegistry` ⇒ 行为与 v0.3.1 完全一致**（请求逐字相同，只多一段 `pinned.reason:"workspaceRegistry-unavailable"` 的提示）；**置顶不可用 ⇒ 提示搜索框 / 切「最近更新」排序**；**attach 失败 ⇒ 不重建**，如实说"已创建但未入组"。

### 代价（用户可见）

每建一个域会话就多一条**置顶行**，并且该会话被挂进对应分组（都写同一个 `workspace.json`，**不改**浏览器本地的手工顺序，也不会重排别的行）。不想多这条行就传 `pin:false`；撤销置顶由用户点该行「…」→「取消置顶」（或宿主 `unpinSession`）。若某个分组是**折叠**的，置顶了也一行都不渲染——宿主侧没有任何通道能改客户端本地的折叠状态，所以只能在回复里点名分组并让人点一下展开。

## 为什么不能自动翻到前台（无 Host→Renderer 通道，人点一下）

- **"出现"可以自动**：`session/created` → `api-session/added` 被白名单转发到渲染层，侧边栏读全局 `useSessions`，所以新行会自己冒出来（`dsh-api-session-controller/lib/index.js:2873-2875` → `dsh-api-remotes/lib/index.js:31-33` → `lib/client.js:3615`）。
- **"切到前台"不行**：三处外部可编程入口**全都没有导航语义**——① Remote 方法表 21 项里没有 open/select/reveal/focus；② 被转发事件白名单里没有任何导航事件；③ 桌面 IPC 全表里没有"打开某会话"。
- **不是权限问题，是架构上没有这条路**：宿主跑在独立子进程（拿不到 Electron / `BrowserWindow`），渲染层"当前选中会话"是浏览器本地存储（`dsh.sessions.current`），宿主够不着。能开前台视图的只有渲染层自己：**人点一下**，或一个 `dsh.client: { platform: 'web' }` **客户端插件**订阅 `api-session/added` 后调 `ctx.uiWorkspace.openSession(id)`。
- 所以本工具把话说明白：**列表里可点 + 已在跑**，由人点开那一条接上。


## 域解析顺序（v0.2 新增「声明优先」）

`send_to_domain(target)` 的解析顺序：

| # | 情形 | 结果 |
| --- | --- | --- |
| ① | `target` 命中某个**会话 id**（长/short/包含） | 投递，`matchedBy: "session-id"`（行为与 v0.1 一致，未改） |
| ② | `target` 命中某域的**在任声明**，且声明会话**在线** | 投给声明人，`matchedBy: "declaration"` |
| ③ | 命中声明但**声明会话不在线** | **不投递**，`reason: "declared-owner-offline"`，回报 `declaredOwner`（sessionId/key/note/since/updatedAt）+ `otherOnlineWithIndexLabel`（索引标注恰好是这个域、当前在线的会话），由调用者决定 |
| ④ | 该域**没有声明** | 退回索引标注逻辑，`matchedBy: "index-label"`，并在回执里加提示「该域无在任声明，本次按索引标注解析，建议补声明」 |
| ⑤ | 索引标注也不止一个在线 | 保持 v0.1 口径：报警（`multiple-online-for-domain`），**不擅自挑一个** |
| ⑥ | 同名短名命中**多条**声明（如两个项目都叫 `asr`） | 不猜：`ambiguous-declarations`，请用「项目:域」完整写法 |

## 配置（`cordis.patch.yml` + 每台机器的 `config.json`）

插件包里**没有任何本机绝对路径**：所有路径在加载时解析，前一层非空即胜出。

| 键 | 1. 部署配置（`cordis.patch.yml`） | 2. `<home>/config.json` | 3. 环境变量 | 4. 默认 |
| --- | --- | --- | --- | --- |
| `indexFile`（只读：会话 id → 域 标注） | `indexFile:` | `indexFile` | `DSH_DOMAIN_BRIDGE_INDEX` | `<home>/registry.json` |
| `domainsFile`（在任声明册） | `domainsFile:` | `domainsFile` | `DSH_DOMAIN_BRIDGE_DOMAINS` | `<home>/domains.json` |
| `ownerCli`（外部 CLI 的写法提示，可空） | `ownerCli:` | `ownerCli` | `DSH_DOMAIN_BRIDGE_OWNER_CLI` | 空 ⇒ 文案只写裸脚本名 `domain-owner.mjs` |
| `domainSessionModel`（v0.6.0：新建域会话建完铺的模型） | `domainSessionModel:` | `domainSessionModel` | —（无环境变量） | 空/非法 ⇒ 不铺，继承全局默认 |

`home` ＝ `DSH_DOMAIN_BRIDGE_HOME`，没设就是 `<homedir>/.dsh/dsh-domain-bridge`。要在一台机器上钉死路径，写 `<home>/config.json` 就行，不用改 `cordis.patch.yml`（可选；JSON 里反斜杠要写两个）：

```json
{ "indexFile": "<你的索引>.json", "domainsFile": "<你的域名册>.json", "ownerCli": "<你的路径>/domain-owner.mjs" }
```

```yaml
config:
  stateDir: '<你的目录>'                            # v0.4.0：政策轴「已暂停」+ 落盘队列；不给＝<home>/state，写 '' 也退回默认
  domainSessionPreset: 'danger-full-access'        # v0.3.3：create_domain_session 建完设的权限档
```

`indexFile` / `domainsFile` / `stateDir` **读不到或格式坏掉一律静默降级**（当成"没有域标注 / 没有人认领 / 没有暂停"），不抛错、不影响投递；`domainSessionPreset` 写 `''` / `none` 即关掉那一步（保持宿主默认档）。`<home>` 全空（没有 config、两个默认文件也不存在）时插件照常加载，只是报「0 个域」。

## 在别的机器上安装

1. 把包目录放到任意位置，`dsh plugin --profile <profile> add link:<这个目录>`（或从 npm 装）；dsh 会应用包内的 `cordis.patch.yml`。
2. 可选：写 `<home>/config.json`（字段 `indexFile` / `domainsFile` / `ownerCli`）；不写就用 `<home>/registry.json` 与 `<home>/domains.json`——`home` 是空的也能正常加载，报「0 个域」而不是报错。
3. 重启 dsh（或重开窗口）。运行期数据（暂停记录 + 队列）自动落在 `<home>/state`；插件包目录里的 `state/` **不再被读取**（一次性复制迁移已删除——包内早已没有旧版本留下的数据）。

## 与 `domain-owner.mjs` 的互通

`claim_domain` / `release_domain` 与 `ownerCli` 指向的 `domain-owner.mjs`（`claim` / `release` / `list` / `check`）写同一份文件、同一 schema、同一冲突语义、同一**原子替换**写法（写 `<file>.tmp` 再 `rename`，绝不先删原文件；写失败自己清理 tmp）。两边互相读得懂、看得见。

- 字段：`{schemaVersion, updatedAt, owners:{ "<项目>:<域>": {project, domain, sessionId, since, by, note} }}`
- 文件不存在＝正常状态（"还没人认领"），任何读者都不当成错误
- 文件存在但 JSON 坏掉 ⇒ **写操作中止**（避免覆盖别人的声明），**读操作静默降级**
- 插件端的 `by` 与 CLI 不给 `--by` 时一致为 `null`；要留痕请用 `note`

## 事实依据（不是猜，逐条来自 dsh 0.2.0-rc.2 / 0.2.1-rc.2 源码或 asar 里的发行代码）

- `ctx.agents.list()` / `get(id)` 返回**裸 Agent，无归属过滤** —— `dsh-agent/lib/index.js:594` `get(id){ return this.store.get(id)?.agent }`
- 两个 `roots()` / `list()` 是全局注册表，`isOwnedBy` 判的是**运行时创建者**，与持久化谱系无关
- `steer` / `followup` / `inject` 在 loop 里**零授权检查** —— `dsh-agent-loop/lib/index.js:809` `steer(input){ this.send(input,'next-step',true) }`
- 门禁只有两处，**都不拦顶层会话**：① `dsh-subagent` 自己的邻接门（只治 `send_message` 通道）② `dsh-api-session-controller` 对 **subagent 会话**的路由门
- 官方自己就有先例：`dsh-experimental-agent-team/lib/types/mailbox.js:204/216` 用 `ctx.agents.get(targetId)` + 裸 `steer`
- **窗口关闭 ⇒ `get()` 返回 `undefined`** ⇒ 天然满足"离线不排队、报不可达"，不需要自己造死亡语义
- `ctx.sessionController` 是**宿主侧普通 Cordis 服务**，并被写进插件可见的 ctx API 目录 —— `dsh-tool-cordis/lib/types/api-catalog.js:1838` `key: 'sessionController'`；`create(request)` 的公开转发在 `dsh-api-session-controller/lib/index.js:2971`，真实实现在 `:686-714`
- 新会话**一定会宣告** `session/created`（`dsh-session/lib/index.js:1782-1799`）⇒ 自动推进 GUI 列表
- **`ctx.workspaceRegistry` 也是宿主侧普通 Cordis 服务**，同样写进插件可见目录 —— `dsh-tool-cordis/lib/types/api-catalog.js:3616` `key: 'workspaceRegistry'`（与 `:1838` 的 `sessionController` 同一张表）；同类先例是同一 profile 的第三方插件 `dsh-mnemon/lib/index.js:10142-10147`：`const current = () => ctx.get("workspaceRegistry")`（可选 + 调用期取 + 拿不到不抛）
- `workspaceRegistry.pinSession(sessionId): Promise<void>` 定义在 `dsh-workspace/lib/index.js:576-587`（幂等；已归档抛 `WorkspaceArchivedSessionPinError`、会话不存在抛 `WorkspaceUnknownSessionError`；**不要求已 attach**）；`resolveByPath(path)` 定义在 `:635-638`（纯读：路径不存在时 `realpath` 直接 reject，目录没归属则返回 `undefined`）
- `create({workspaceId})` 时宿主调 `workspace.attachSession(sessionId)`（`dsh-api-session-controller/lib/index.js:701-708`），失败抛 `RemoteError("session/workspace-attach-failed", ..., {sessionId, workspaceId})`；`RemoteError` 的判别字段是 `code`/`details`（`dsh-typert-protocol/lib/types/remote-error.js:9-26`，`lib/index.js:2971` 的公开 `create` 是直通转发，错误原样穿透）
- **v0.4.1 拉活接线（`{{model}}` 唤醒 bug）**：`ResumeAgentOptions` 本来就声明了 `agentOptions?` 与 `setup?`（`dsh-tool-cordis/lib/types/api-catalog.js:6191-6192`，`AgentOptions` 在 `:4412`、`AgentSetup` 在 `:4440`）；宿主自己的 resume 就是这么调的 —— `resumeObserved` 里 `agentOptions: this.agentOptions()` + `setup: composition.setup`（`dsh-api-session-controller/lib/index.js:399-411`），`agentOptions()` 取自 `ctx.agentDefaultModel.currentSelection()`（`:460-466`），`composeAgent()` 的 setup 装模型选择 + `presets.mount`（`:358-371`）；`{{model}}` 变量由 `ctx.systemPrompt.variable("model", (context) => context.agent?.options.model)` 注册（`dsh-agent-loop/lib/index.js:1565`），而报错点确认"变量已注册但这一轮值是 `undefined`"（`dsh-system-prompt/lib/index.js:167-172`）；`setup` 里装的那两条 waterfall 是 `system-prompt/assemble` 覆盖 `provider/model` 变量 + `agent/request` 覆盖路由（`dsh-agent/lib/index.js:166-192`，本插件用公开的 `agentCtx.on` 复刻，**不 import 核心内部**）
- **存档读取口径**：`ctx.sessionQuery.readSession(id)` 返回 `{session, inheritedEventCount, events}`（`dsh-session-query/lib/index.js:1079-1087`）；`request/header` 事件由 agent-loop 以 `session.append("request/header", {header, reason})` 写下（`dsh-agent-loop/lib/index.js:1214-1228`），消费端就从 `event.data.header.config` 取 provider/model（宿主的 `modelSelection` 投影：`dsh-api-session-controller/lib/index.js:2077-2082`）；`SessionHeader.agentPreset?: string` 是公开可选字段（`dsh-agent-preset-registry/lib/typert.host.js:655`）
- **v0.6.1 模型分派（dsh 0.2.1-rc.2，全部读 asar 的发行代码）**：
  - `modelCatalog()` **返回 Promise** —— `dsh-api-session-controller/lib/index.js:3121` `modelCatalog(){ return buildModelCatalog(this.ctx) }`；`lib/types/catalog.js:10` `export async function buildModelCatalog(ctx, defaultSelection = ctx.agentDefaultModel.currentSelection())`，内部 `:11` `ctx.llm.listProviders()`（同步）、`:14` `await ctx.llm.listModels(provider.id)`、`:16` `await ctx.llm.resolveModelInfo(...)`，`:52-53` `groups = …filter(group => group.models.length > 0)`、`:56` `routableProviders = groups.map(group => group.id)`、`:58` `failures`。**v0.6.0 漏了 `await`，所以真机 `groups:[]` / `routableProviders:null`。**
  - 按 id 读投影的真接口：`dsh-api-session-controller/lib/index.js:3280` `async projections(request, signal)`（装饰器 `@Remote("projections")` 在 `:2698`）；`:3281` `const { sessionId } = request`；`:3291` 先试活会话 `liveProjections(sessionId)`（`:3322-3330`，用 `this.ctx.sessions.get(sessionId)` + `sessionProjections.snapshot(session)`）；`:3293` 再试 `sessionPersistence.stat`；`:3302` 最后 `sessionQuery.observeSession(sessionId)` ⇒ 返回 `{kind:'sequenced', asOfSeq, values}` / `{kind:'migration-required', values}` / `null`。**必须有 signal**（`:3290` `signal.throwIfAborted()`）。
  - `sessionProjections.stateOf(session, key)`（`dsh-session-projection/lib/types/index.js:132`，实现 `lib/index.js:126`）**只认 Session 对象**：`:136 materializeCells(session)` → `lib/index.js:377-383 cellFor` 要用 `session.header` / `session.inheritedEventCount` / `session.snapshotEvents()`；传 id 字符串**必抛**。注册处 `dsh-api-session-controller/lib/index.js:2198` `ctx.sessionProjections.register(modelSelectionProjection)`。
  - `modelSelection` 投影的形状：`dsh-api-session-controller/lib/types/model-selection-projection.js:45` `init: () => ({lastUsed: null, pending: null})`、`:47-50` `wire.view: state => ({lastUsed, next: state.pending ?? state.lastUsed})`。
  - `sessions` 服务＝`dsh-session/lib/index.js:1739` `super(ctx, "sessions")`、`:1980-1982` `get(id){ return this.store.get(id)?.session }`（**活会话才有**）；`agents` 服务＝`dsh-agent/lib/index.js:594` `get(id){ return this.store.get(id)?.agent }`；宿主自己读会话就是这样取的（`dsh-api-session-controller/lib/index.js:366` / `:3323`）。
  - 全局默认：`dsh-agent-default-model/lib/index.js` 的 `agentDefaultModel` 服务 —— `currentSelection()` 读 Config 引用、`async saveSelection(next)` 里 **`:entry === undefined` 直接 return**、**`ctx.get("configEditor") === undefined` 也直接 return** ⇒ **静默 no-op**（这就是 `set_default_model` 必须读回校验的原因）。

## 技术栈（选型结论）

- **形态**：静态 Cordis 插件包（`export default { name, inject, apply }`）
- **语言/构建**：纯 JS ESM，**零构建**（无 tsdown/tsconfig）
- **依赖**：只 `node:fs` / `node:path` / `node:crypto` 内置；`inject: ['tools','agents']`（`sessionController`、`workspaceRegistry`、`agentDefaultModel`、`sessionQuery`、`agentPresets` **都故意不写进 inject**：本部署没挂它们时必须还能加载、如实回报 `{created:false, reason:"sessionController-unavailable"}` / `pinned:{ok:false,reason:"workspaceRegistry-unavailable"}` / `wakeWiring:{agentOptions:"none",...}`，而不是让加载器硬失败；都用 `ctx.get(...)` 可选取用。v0.4.1 也**没有新增任何顶层 import**——`setup` 里那条"装模型选择"是靠**公开的 `agentCtx.on(...)`** 复刻宿主语义，而不是 import 核心内部。静态包里新增 import 一旦解析失败是在模块加载期抛，`apply` 的 try/catch 兜不住）
- **安装**：`link:` 本地安装，不上 npm、不进 git
- **为什么**：这套路径本机已跑通 6 次（`~/.dsh/dsh-plugins`），踩平了最致命的坑——**静态包里没有 `harness` 全局**，且 `apply` 抛错会让加载器硬失败（`AggregateError: loader entries failed to apply`，宿主起不来）。因此本插件的 `apply` **永不抛错**，工具注册走"harness 优先 + `ctx.tools.register` 兜底 + try/catch"两 realm 兼容写法。

## 硬边界

- **不建第二本台账**：真值仍是使命库 + 索引；域标注只**读**索引（`indexFile`）与在任声明册（`domainsFile`），读不到也不影响投递。写只发生在声明册，且与 `domain-owner.mjs` 逐字段一致。v0.4 新增的 `stateDir` 里只有**政策轴 + 生命周期 + 队列**，**没有任何"谁在任"的记录**。
- **不做网状直连**：只做"主会话 ↔ 域会话"这一段；跨域仍应经主会话。
- **离线默认不排队**（行为没变）：窗口不在线就该报不可达；**唯一例外是「该域已暂停」**——那时消息**落盘入队**（可撤回、可重投），因为那是人显式按下的政策，不是"发不出去"。
- **绝不替调用者挑人**：声明会话离线、同域多在线、同名域多条声明——一律如实报警并把候选列出来。
- **绝不裸拉活**（v0.4.1）：没有 provider/model 接线时，要跑回合的唤醒一律拒绝；探路用 `wake:"probe"`。

## 返回契约（v0.3.1 起，硬契约）

- **所有工具输出保证无损 JSON：任何位置都不含 `undefined`**（也不含 `NaN`/`±Infinity`/`-0`/`bigint`/`Date`/`Map`/`Set`/函数/循环引用）。宿主按"`JSON.parse(JSON.stringify(v))` 必须与原值相等"来校验；`JSON.stringify` 会**静默丢掉 `undefined` 键**，往返即有损 ⇒ 宿主整次拒收，报 `tool "<名字>" returned invalid output: value is not lossless JSON`，**且不指向具体字段**。
- 实现：`lib/bridge.js` 里的 `pruneUndefined()` 在 `tool()` 工厂统一过一遍（**一个卡点覆盖 12 个工具的全部返回路径**，不逐分支打补丁）：删掉 `undefined`/函数/symbol 的键（数组里换成 `null`），并归一 `NaN`/`±Infinity`→`null`、`-0`→`0`、`bigint`→十进制字符串、`Date`→ISO 字符串、`Map`/`Set`→普通对象/数组、循环引用→`null`。
- **回归护栏**：`npm test`（= `node test/run-all.mjs`，0.8.10 起串全部 8 个套件、每个套件独立临时 `DSH_DOMAIN_BRIDGE_HOME`）对 12 个工具**每条可达分支**做深度扫描 + 无损往返断言，并冻结 envelope 文案、`list_domain_sessions` 顶层键集与 `VERSION == package.json version`。当前基线：**8/8 套件、626 用例、smoke 301 / 59,101 分支断言**。新增分支请一并补例，别只断言某一个字段。
- **v0.3.2 新增第 7 节**：入组 + 置顶的整条阶梯都用**假 registry + `create()` 探针**驱动（不真建会话、不真调 `pinSession`、不碰真 `workspace.json`）：命中/未命中、`workspaceId` 失败自动重试、两次都失败、**attach 失败不重建**（含只有错误文本 / 完全拿不到 id 两种退化）、`pinSession` 抛错、`pin:false` 不调 pin、拿不到 registry 时请求与 v0.3.1 **逐字相同**，以及 `list()` 兜底 / resolve 抛错 / 没有 `pinSession` / 经 `ctx.get` 取值 / `ctx.get` 抛错回落属性读取。
- **v0.4.0 新增第 11 节**：域级「已暂停」的整条政策轴（按下/幂等/非法 state/没声明/短名解析、投递拦截与落盘队列、`dryRun`、按会话 id 直投也拦、`create_domain_session` 拒绝、`wake` 被拦与 `force` 放行、`claim`/`release` 照常允许、撤回的四种结局、恢复重投的四条路、五种派生状态一次列全、未暂停域的**键集逐字回归**、状态文件坏掉/写不动/队列坏行的降级）。全部跑在**每个 mount 自己的临时 `stateDir`**，绝不碰真实的运行期 `state/`。
- **v0.4.1 新增第 12 节**：`{{model}}` 唤醒 bug 的修复——每条用例都让**真的 resume 调用**穿过一个"像宿主一样真的会回调 `setup`"的假 agents 服务：取源① `ctx.agentDefaultModel`、取源② 存档里那条 `request/header`、存档读不懂时**降级成 `none` 且绝不猜**、两条都空时**拒绝裸拉**（`no-wake-wiring`，一次 resume 都不调；`probe` / `mode:"inject"` 放行、`force` 也越不过）、`setup` 抛错**只记不抛**（回执 `failed` + `setupError`）、旧入口 `sessionController.resume` 带不了接线时一并拒绝，以及 F2 停机通知对**已暂停**的域**照发**（且不进队列）。
- **v0.4.2 新增第 13 节（四级暂停）**：① 项目级压着域级 ⇒ 投递被拦且**报出两级**（`pausedScopes` / `pausedByScopes`）；② 只解域级 ⇒ `drain.reason:"still-pressed"` + `stillPausedBy`，pending **保持**；再解项目级才重投；③ `global` 缺 `confirm` ⇒ `global-needs-confirm` 且**连状态目录都不建**（一个文件不写），带 `confirm` 才生效，且全局压着时域目标/会话目标/create 全拦；④ **两端都查**：本会话 session 级 / project 级被按 ⇒ 发不出去（0.4.1 完全没有这道门），而"**自己持有的域被暂停**"**不禁言**整个会话（刻意边界）；⑤ session 键：完整 id 不要求在线、短号唯一命中才收、片段歧义 ⇒ `session-ambiguous`、非法 `scope`（含 `master`）⇒ `invalid-scope`；⑥ **降级不静默**：坏状态文件 ⇒ 投得出去但回执带 `unreadableStateFiles`，推不出项目 ⇒ 不拦但带 `unresolved`；⑦ 列表：项目级按着 ⇒ 该项目里**所有**在线会话显示 `在线·已暂停`，session 级只标那一条，`domainState.pausedRecords` / `unresolved` 如实列；⑧ drain 的**驱动范围**（session ⇒ 会话键 + 它持有的域键；project ⇒ `P:*` + 属于 P 的会话键；global ⇒ 全量）；⑨ 向后兼容：不带 `scope` ⇒ domain 级、域级文件名与旧字段语义不变、**未暂停时的投递回执键集与 v0.3.6 逐字一致**。
- **v0.6.0 新增第 14 节（模型分派，26 个分支用例）**：`list_models` 的 modelCatalog 正常/抛错退 llm/两者都没有、session 投影（会话 id 与域键两条路）；`set_model` 的**调用顺序断言**（`currentSelection → selectModel → saveSelection`，且 `saveSelection` 收到**旧值**）、`session/writer-held` 原样回传但**仍恢复全局默认**、恢复失败如实 `restored:false`+error、域键/短号 target 解析、`api-unavailable` 时**一次服务调用都没有且不抛**、空参数/拿不到调用者会话、选的就是当前默认时不写回；`create_domain_session` 的显式 model / 配置默认 / `<home>/config.json` 三层来源、显式优先于配置、两者都没有时**不调 selectModel**、建会话失败时**一个模型都不改**、dryRun 只报告 `wouldSetModel`。全部 mock 驱动，不真改会话、不真写全局默认。
- **v0.6.1 新增第 15 节（首次真机的两个缺陷 + 全局那一半）**：假服务的 `modelCatalog()` **改成 async**（与宿主一致），另有一条故意返回**裸 Promise** ⇒ 少了 `await` 就会当场露馅（真机 bug 回归）；`groups` 空/形状认识但空/provider 没有模型三条都退 `llm.listProviders()`+`listModels()`，**两个来源都空** ⇒ `{ok:true, source:'empty', groups:[], rawKeys:[…], note:'catalog-empty'}`（含 `attempts` 逐步 state）；`listModels` 的**字符串数组**与 `{id,name,reasoning?}` 两种形状都归一；会话投影三条路都测——① `sessionController.projections({sessionId}, signal)`（断言请求形状、**必须带 AbortSignal**、wire 视图 `{lastUsed,next}` 的映射）② **`stateOf` 必须收到 Session 对象**（断言 `asked[0][0] === agent.session`，即 v0.6.0 真机必抛的那个点）③ 两条都失败 ⇒ 如实 `sessionRead:{ok:false,reason,tried,failures}`（不再静默省略）；`set_default_model` 的**正常改（`saveSelection` 只准被调用一次、收到的必须是新值——"不恢复"的硬断言）**、没传 `reasoningEffort` 就不写、服务不可用（ctx 上没有 / 只有 `currentSelection`）⇒ `api-unavailable` 且零调用、参数非法 ⇒ `invalid-model` 且零调用、宿主保存抛错 ⇒ 原样回传错误码、**静默 no-op 宿主 ⇒ `verified:false` / `applied:'not-observed'`**、读不回 ⇒ `readback-unavailable`、读回抛错 ⇒ `beforeError`/`afterError` 但写入照旧。全部 mock 驱动，不真改会话、不真写全局默认。

## 生效方式

静态 Cordis 插件包，改动 `lib/bridge.js` / `cordis.patch.yml` 后**需要重启 dsh（或重开窗口）**才会被加载；插件未重启前，`create_domain_session` / `claim_domain` 等新工具在模型侧不存在（**运行期效果**——入组与置顶本身是即时的：宿主写盘后推给已打开的侧栏，不用刷新）。

**重启后第一件该做的事**（挑一个**已存在、且当前是展开的**工作区分组来做，验完方便清理）：

```text
create_domain_session(
  domain: "probe:smoke",
  task: "这是一次性探针：收到即回复「探针收到」，然后什么都不用做。",
  cwd: "<你的路径>",   # 换成你界面上某个已展开分组的目录
  claim: false
)
```

**期望看到**：① 返回 `created:true`、`workspace.attached:true`、`pinned.ok:true`，`workspace.id` 就是该目录对应的工作区 id；② 界面上那个**分组的最上方**多出一行无标题新会话（不用刷新、不用切排序）——**若那个分组本来是折叠的，先点一下组名展开**；③ 它自己开始跑并回「探针收到」。找不到就用侧栏**搜索框输 `tixiweihu`**（或把排序切成「最近更新」）。验完把那条会话归档，别删文件。

## 回滚

```powershell
dsh plugin --profile desktop remove dsh-domain-bridge
```

或把 `~/.dsh/profiles/desktop/package.json` 里对应依赖与 `dsh.profile.bundles` 条目删掉。
