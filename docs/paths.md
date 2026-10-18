# 路径与占位符

> 文档、模板、角色任务书里出现的路径**一律写占位符**，不写本机绝对路径。这一页说明为什么、有哪些占位符、换机怎么替换、以及**必须存在**的外部依赖。
> 注意：占位符是**给人读、给人替换的约定**，不是插件会去解析的模板引擎——插件自己的路径走的是四层配置解析（见 `03-plugin.md`）。

## 1. 为什么用占位符

- **实测教训：搬目录会打断引用，而引用是真成本。** 一次体系级资产搬迁造成 **25 条引用失效、跨 6 个项目**，其中 **51% 被写的文件在任何 git 仓库之外**（既没有版本历史、也没有编译器帮你发现断裂）。
- 后来对"整体搬目录"做过统计：要改 **135 处、43 个文件**，而且其中 **5 处在项目本体里、从体系侧根本改不到**。⇒ 结论不是"搬之前多想"，而是**一开始就别把本机前缀写进正文**。
- 因此定下的规则：路径写 `{体系根}` 这类占位符，**换机只替换一个前缀**；被测出的代价是"阅读时多一层替换"——这个代价由配套的安装／替换动作摊掉。

**出处**：`{体系根}/_registry/DOMAIN-JUDGMENTS.md`（资产落位与搬迁造成引用失效的判断记录）；`{体系根}/_pages/插件自动化与GUI准备-2026-10-18.data.js` §九（135 处 / 43 文件 / 5 处改不到）；`docs/04-design-decisions.md` §7。

## 2. 占位符表

| 占位符 | 指什么 | 典型用法（写成这样） | 出处 |
|---|---|---|---|
| `{体系根}` | **体系根目录**：体系侧文档与模板、`tools/`、`_registry/` 所在的那一层主体目录（在本仓里对应仓库 README「目录」节的 `framework/`，**以仓内实际为准**） | `{体系根}/SYSTEM-OVERVIEW.md`、`{体系根}/templates/dispatch-template.md`、`{体系根}/tools/session-registry.mjs` | `{体系根}/templates/roles/README.md`「维护」节；`plugins/dsh-domain-bridge/README.md` 的硬边界 |
| `~/.dsh` | **宿主家庭目录**：dsh 自己的数据与配置（profile、插件 home、运行期状态） | `~/.dsh/profiles/<profile>/package.json`、`~/.dsh/dsh-domain-bridge/state` | 插件 README「配置」「回滚」节；`lib/core/shared.js` 的 `bridgeHome()` |
| `plugins/dsh-domain-bridge` | **域桥插件目录**（仓库内相对路径，安装时指向它） | `dsh plugin --profile <profile> add link:plugins/dsh-domain-bridge` | `README.md`「目录」节；`plugins/dsh-domain-bridge/README.md`「在别的机器上安装」 |
| `{项目名}` | **一个项目的名字**；同时也是 **project 级暂停的键**（项目名小写） | 使命名 `S##-{域}-<slug>`；`set_domain_state(scope='project', domain='{项目名}')`；在任声明 key＝`{项目名}:{域}` | `plugins/dsh-domain-bridge/README.md` §四级「已暂停」（键＝项目名小写）；`{体系根}/templates/roles/domain.md` |
| `{域}` | **一块长期职责的短名**（英文小写短词）；跨窗口存续，不是目录 | `KNOWLEDGE/{域}.md`、`S##-{域}-<slug>`、在任声明 key＝`{项目名}:{域}` | `{体系根}/templates/roles/domain.md`；`{体系根}/templates/dispatch-template.md`「会话编号规则」；`{体系根}/templates/术语表.md` |

- 角色任务书里还有**角色自己的槽位**（如 `{使命名}`、`{调研问题}`、`{提案路径}`），由该文件的头块 `SLOTS:` 声明；它们**不是路径占位符**，规则见 `templates/roles/README.md` 的「解析约定」。
- **不放进 `{体系根}` 的东西**：知识库（坑与经验）在**宿主侧另放**，按固定路径写、不做槽位化——别把它改写成 `{体系根}/../...`。按发布拍板 **O8＝C，知识库不随本仓公开**，所以本仓里只出现这个概念、不给具体路径。
- 本页只登记这 5 个已经成文、跨文件复用的占位符；新增一个就回 `templates/roles/README.md` 与本文同步一行（**一个口径只写一处**）。

**不是占位符、但也别当成"本机路径"写死**——下面这些是**固定标识符**或**由配置解析决定的值**，在正文里按字面写、不要改写成 `{...}`：

| 名字 | 类型 | 说明 |
|---|---|---|
| `DSH_DOMAIN_BRIDGE_HOME` | 环境变量 | 换掉整个插件 `home`（默认＝`~/.dsh/dsh-domain-bridge`） |
| `DSH_DOMAIN_BRIDGE_INDEX` / `DSH_DOMAIN_BRIDGE_DOMAINS` / `DSH_DOMAIN_BRIDGE_OWNER_CLI` | 环境变量 | 四层解析的第 3 层；第 4 层是 `<home>` 下的默认文件名 |
| `indexFile` / `domainsFile` / `ownerCli` / `stateDir` / `domainSessionPreset` | 配置键 | 部署配置（`cordis.patch.yml`）与 `<home>/config.json` 的键名 |

## 3. 换机怎么替换

- **只替换一个前缀**：把所有正文里的 `{体系根}` 换成本机的体系根目录；`~/.dsh` 按该机器上 dsh 的实际家庭目录展开。

| 要找的串 | 处理 | 换不换 |
|---|---|---|
| `{体系根}` | 换成本机体系根目录 | **换**（唯一需要机械替换的前缀） |
| `~/.dsh` | 需要写具体路径时展开成本机 dsh 家庭目录 | 展开，不"翻译"成体系根 |
| `plugins/dsh-domain-bridge` | 保持原样（仓库内相对路径） | 不换 |
| `{项目名}` / `{域}` | 换成本项目的实际名字 / 域短词 | 按**项目**换，不按机器换 |

- **不要逐条改路径**：逐条改既会漏，也会把"引用"重新变成"写死的本机路径"——下一台机器还得再来一遍。
- **不要动这些**：`plugins/dsh-domain-bridge`（仓库内相对路径）、`{项目名}` / `{域}`（业务标识，本来就该按项目替换，不是机器相关）。
- **替换后自查**：正文里搜 `{体系根}` 应为 0 处残留；搜 `~/.dsh` 只应出现在宿主侧（profile、插件 home、状态目录）的描述里，不应出现在体系文档路径里。
- **注意边界**：`{体系根}` 与 `~/.dsh` **不是一个目录的两级**——一个是体系资产、一个是宿主数据；不要用相对路径在两者之间穿（例如"从体系根爬回宿主目录"）。

## 4. 必须存在的外部依赖

| 依赖 | 为什么必须 | 版本／来源 | 出处 |
|---|---|---|---|
| **dsh 宿主** | 域桥是**宿主插件**：会话生命周期、权限、面板、模型路由都归 dsh（本框架不重造）；插件靠宿主注入的 `tools` / `agents` 服务注册工具 | 插件声明 `engines.dsh: ">=0.2.0-rc.0 <0.3.0"`；peer 依赖 `@deepseek-ai/cordis ^4.0.1`（由宿主提供） | `plugins/dsh-domain-bridge/package.json`；`docs/04-design-decisions.md` §11 |
| **Node.js** | 插件是**纯 ESM**（`"type": "module"`），零构建；仓库里的只读脚本是 `.mjs`，直接用 `node <脚本>` 跑 | 无版本下限写在仓里，按宿主的要求为准 | `plugins/dsh-domain-bridge/package.json`（`type` / `scripts` / `main`）；`{体系根}/templates/roles/project-main.md`（`node {体系根}/tools/session-registry.mjs`） |

- **不是"能跑"前提、但工作流会用到**：`git`（一使命一分支、达成报告随分支走）。插件加载本身不依赖它。
- **插件不读环境变量以外的机器状态**：本机路径全部来自四层解析（部署配置 > `<home>/config.json` > 环境变量 > `<home>` 默认），`<home>` 为空时插件照常加载、报「0 个域」。

## 5. 从零到能跑：最小步骤

```text
1. 装 dsh 宿主（本框架只做宿主没有的那层：跨会话治理 + 项目模板）
2. 把 plugins/dsh-domain-bridge 挂进 profile 的 dependencies（link:）与 bundles
3. （可选）写 ~/.dsh/dsh-domain-bridge/config.json 钉死 indexFile / domainsFile / ownerCli
4. 重启 dsh —— 宿主插件不热重载，加载器「全有或全无」
5. 在任一会话里调 list_domain_sessions：回「0 个域」也算装对了（home 为空是正常状态，不是错误）
6. 要建项目骨架：当前只能手工或脚本（bootstrap_project 仍未实现）
7. 开局读两样东西：
   node {体系根}/tools/session-registry.mjs --handoff      # 交接包（机器读）
   node {体系根}/tools/session-registry.mjs --handoff-md   # 需要人读时现渲一页
```

- **不承诺自动化**：第 2 步的安装与第 6 步的建骨架都要**人工一步**，没有安装器；`bootstrap_project` 只有规格、代码一行未写（见 `06-limitations.md` A1）。
- **验证装对了**：`node plugins/dsh-domain-bridge/test/smoke.mjs`；以及在一个会话里调一次 `list_domain_sessions`。
- **验证插件真的加载了**：插件加载时会 warn 一行（版本、`home`／`config`、`indexFile`／`domainsFile` 各自来自哪一层、`stateDir`），照它核对四层解析结果最快。

## 出处

- `{体系根}/templates/roles/README.md`（`{体系根}` 约定、"换机只替换一个前缀"、知识库唯一例外、槽位与 `SLOTS` 契约）
- `{体系根}/templates/roles/domain.md` 与其余 `roles/*.md`（`{项目名}` / `{域}` / `{使命名}` 的实际用法）
- `{体系根}/templates/术语表.md`（域、在任声明、`<项目>:<域>` 的 key 口径）
- `{体系根}/templates/dispatch-template.md`「会话编号规则」（`S##-{域}-<slug>`）
- `{体系根}/_registry/DOMAIN-JUDGMENTS.md`（搬迁造成引用失效的实测记录）
- `{体系根}/_pages/插件自动化与GUI准备-2026-10-18.data.js`（§四 P4 的坑：尖括号改 `{占位符}`；§九 135 处 / 43 文件）
- `plugins/dsh-domain-bridge/package.json`（`type` / `main` / `engines.dsh` / `peerDependencies` / `scripts`）
- `plugins/dsh-domain-bridge/README.md`（`home` 与四层解析、`<home>/config.json`、安装与回滚）
- `plugins/dsh-domain-bridge/lib/core/shared.js`（`bridgeHome()` / `resolveRuntime()` / `defaultStateDir()`）
- `README.md`（目录节、快速开始的设计目标）
- `docs/04-design-decisions.md`（§7 占位符取舍、§11 只做宿主没有的那层）
