/**
 * dsh-domain-bridge — the `/initialize` bootstrap layer (spec §4 of commands-v1.md): check the
 * system layer, fill in the project layer, and report a three-column receipt (已存在 / 已创建 / 需人工).
 *
 * 设计要点（逐条对着冻结契约 §4 写）：
 *   - 默认「补全」（apply）＝**只补缺失，绝不覆盖已有文件**；`check` ＝ 只报告、**一个字节都不写**。
 *   - 项目层清单只复用 `D:\xiangmu\templates\init-project.ps1` 已经确立的那几项
 *     （PROJECT.md / KNOWLEDGE.md / KNOWLEDGE\ / 提案\ / projectlog\ / .gitignore 标准条目），
 *     **不调用 powershell**、**不重写模板正文**：模板能复制就整份复制，模板缺失才退到最小骨架并标「需人工」。
 *   - 体系层（SYSTEM-OVERVIEW.md / PROJECT.md / templates\ / _registry\ / tools\）**只检查、不创建**。
 *   - 写盘一律绝对路径（path.resolve(root, rel)），绝不依赖进程 cwd；读模板先做存在性检查，缺失不许抛。
 *   - apply 的每个分支都 try/catch：本模块**永不抛**，回执永远是 {ok, ...payload}。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 体系根缺省值：与 init-project.ps1 的 $ProjectRoot 前缀、契约 §4 的模板绝对路径同一处。 */
export const DEFAULT_SYSTEM_ROOT = 'D:\\xiangmu'

/** .gitignore 的标准条目（逐字照抄 init-project.ps1 的 $StandardEntries，不改一字）。 */
export const STANDARD_GITIGNORE_ENTRIES = ['logs/', 'projectlog/', '.main-writer-flag', '*.tmp', '*.bak*']

/** 项目层清单的固定顺序（回执三栏也按这个顺序排）。 */
export const PROJECT_INVENTORY_PATHS = ['PROJECT.md', 'KNOWLEDGE.md', 'KNOWLEDGE', '提案', 'projectlog']

/** 体系层清单：**只检查**（spec §4），缺什么报什么，一个都不创建。 */
export const SYSTEM_INVENTORY = [
  { path: 'SYSTEM-OVERVIEW.md', kind: 'file', note: '三级会话协作 / 并发协议 / 防熵守则的口径唯一源' },
  { path: 'PROJECT.md', kind: 'file', note: '体系总纲' },
  { path: 'templates', kind: 'dir', note: '模板目录（PROJECT / KNOWLEDGE / 提案 等）' },
  { path: '_registry', kind: 'dir', note: '体系索引 / 域名册落点' },
  { path: 'tools', kind: 'dir', note: '体系工具脚本' },
]

/** 薄包装：本模块不 import shared.js 的 messageOf（避免多带一个导出），语义逐字一致。 */
function messageOf(error) {
  return error?.message || String(error)
}

/** 绝对化并去尾斜杠：空值/非法值返回 ''（调用方按「拿不到根」如实回报，不猜）。 */
export function resolveRoot(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  try {
    return path.resolve(raw).replace(/[\\/]+$/, '') || path.resolve(raw)
  } catch {
    return ''
  }
}

/** 项目层根：显式 projectRoot > 体系根下的项目名（小写目录名）> 本会话 cwd。 */
export function resolveProjectRoot({ projectRoot, systemRoot, project, cwd } = {}) {
  const explicit = resolveRoot(projectRoot)
  if (explicit) return explicit
  const name = String(project ?? '').trim()
  if (name && systemRoot) {
    try {
      return path.resolve(systemRoot, name)
    } catch {
      /* fall through to cwd */
    }
  }
  return resolveRoot(cwd)
}

/** 体系根：显式配置 > 契约缺省 D:\xiangmu。 */
export function resolveSystemRoot(config) {
  return resolveRoot(config?.systemRoot) || DEFAULT_SYSTEM_ROOT
}

/** 模板目录：显式配置 > <体系根>\templates。 */
export function templatesDirOf(config, systemRoot) {
  const explicit = resolveRoot(config?.templatesDir)
  if (explicit) return explicit
  if (!systemRoot) return ''
  try {
    return path.join(systemRoot, 'templates')
  } catch {
    return ''
  }
}

/** 存在性检查：一律返回 boolean，任何异常都当「不存在」（绝不抛）。 */
function exists(file) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

/** 读 UTF-8 文本：不存在 ⇒ { missing:true }；读失败 ⇒ { error }（调用方如实回报，不抛）。 */
function readText(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), missing: false, error: null }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { text: null, missing: true, error: null }
    return { text: null, missing: false, error: messageOf(error) }
  }
}

/** 无 BOM 的 UTF-8 写入（契约 §0：文件编码 UTF-8 无 BOM）。 */
function writeText(file, text) {
  fs.writeFileSync(file, text, { encoding: 'utf8' })
}

/** 逐字照抄 init-project.ps1 的骨架正文（模板缺失时的兜底；用了就标「需人工」）。 */
function projectSkeleton(name) {
  return `# ${name}\n\n> Project status doc. Only the main session writes this file (唯一写者规则).\n\n## Current State\n\n(empty — fill in as project progresses)\n\n## Recent Changes\n\n(empty)\n\n## Next Steps\n\n(empty)\n\n## Known Pitfalls\n\n(empty)\n`
}

function knowledgeSkeleton(name) {
  return `# ${name} — Project Knowledge (总纲/索引)\n\n> 本文件是指引/索引，只由主会话写。各域文档放 KNOWLEDGE\\<域>.md，由负责该域的会话自己写\n> （模板见 templates\\KNOWLEDGE-域文档.template.md）。没拆域时照旧在本文件里写；两种布局并存，不必强行迁移。\n\n## 一、域清单（谁负责哪块、往哪个文件写）\n\n| 域 | 负责窗口 | 域文档 | 最后更新 |\n|---|---|---|---|\n| (待拆域时填) | — | KNOWLEDGE/<域>.md | — |\n\n## 二、跨域通用条目\n\n(empty)\n\n## 三、判重 / 合并记录\n\n(empty)\n\n## 四、分发记录\n\n(empty)\n\n## 五、待提炼（[可复用]）\n\n(empty)\n`
}

/**
 * PROJECT.md / KNOWLEDGE.md 的「建法」：模板能整份复制就复制（**不改写模板正文**），
 * 模板缺失才退到最小骨架并标 `manual:true`（＝回执里那一栏写「内容仍需人工补全」）。
 * 模板搜索顺序固定、全部绝对路径 + 存在性检查，缺失绝不抛。
 */
function templateFirstBuild(templatesDir, candidates, skeleton) {
  return ({ name }) => {
    for (const candidate of candidates) {
      const sourcePath = templatesDir ? path.join(templatesDir, candidate) : ''
      if (sourcePath && exists(sourcePath) && !isDirectory(sourcePath)) {
        const read = readText(sourcePath)
        if (read.error) throw new Error(`模板读不动（${candidate}）：${read.error}`)
        if (read.missing) continue
        return { text: read.text, source: 'template', sourcePath, manual: false }
      }
    }
    return { text: skeleton(name), source: 'skeleton', sourcePath: null, manual: true }
  }
}

/**
 * 项目层清单（相对项目根；顺序＝回执三栏的排布顺序）。
 * 只复用 init-project.ps1 的清单：每个条目一份「检查＋补全」，.gitignore 因为多一步「追加缺失条目」
 * 单独走 ensureGitignore()，所以不放进这张表。
 */
export function buildProjectInventory(templatesDir) {
  return [
    {
      path: 'PROJECT.md',
      kind: 'file',
      note: '主会话唯一写者的项目状态文档',
      build: templateFirstBuild(templatesDir, ['PROJECT-模板.md', 'PROJECT.md', 'PROJECT.template.md'], projectSkeleton),
    },
    {
      path: 'KNOWLEDGE.md',
      kind: 'file',
      note: '项目知识总纲 / 索引',
      build: templateFirstBuild(templatesDir, ['KNOWLEDGE-模板.md', 'KNOWLEDGE.md'], knowledgeSkeleton),
    },
    { path: 'KNOWLEDGE', kind: 'dir', note: '域文档目录（KNOWLEDGE-域文档.template.md 的落地处）' },
    { path: '提案', kind: 'dir', note: '提案机制目录' },
    { path: 'projectlog', kind: 'dir', note: 'AI 开发审计日志（三段式日志 + TraceID）落盘处' },
  ]
}

/** 每轮检查的唯一时间源（同一份回执里所有 missingSince/createdAt 用同一个时刻）。 */
function nowIso() {
  return new Date().toISOString()
}

/**
 * 通用「检查 + 补全」。
 *   existed / created：项目根（或体系根）下某一项的最终状态；
 *   check 档：只回答「在不在 / 会做什么」，不落盘，`statusNote` 用「待处理」口径。
 */
function inspectEntry(root, entry, { check, at, name }) {
  const abs = path.resolve(root, entry.path)
  const base = { path: entry.path, kind: entry.kind, note: entry.note, createdAt: null }
  if (exists(abs)) {
    return {
      ...base,
      status: 'exists',
      statusNote: entry.kind === 'dir' ? '目录已存在' : '文件已存在（一字未改）',
    }
  }
  if (check) {
    return {
      ...base,
      status: 'missing',
      statusNote: entry.kind === 'dir' ? '缺失，补全档会建这个目录' : '缺失，补全档会建这个文件',
    }
  }
  try {
    if (entry.kind === 'dir') {
      fs.mkdirSync(abs, { recursive: true })
      return { ...base, status: 'created', createdAt: at, statusNote: '已创建目录' }
    }
    const built = entry.build({ name })
    writeText(abs, built.text)
    return {
      ...base,
      status: 'created',
      createdAt: at,
      statusNote: built.manual
        ? `已创建（${built.source === 'template' ? '复制自 ' + built.sourcePath : '最小骨架'}）——内容仍需人工补全`
        : `已创建（复制自 ${built.sourcePath}）`,
    }
  } catch (error) {
    return { ...base, status: 'manual', createdAt: null, statusNote: `创建失败：${messageOf(error)}` }
  }
}

/**
 * .gitignore 单独一路：**只追加缺失的标准条目，绝不重写已有内容**（init-project.ps1 第 4 步的语义）。
 * 文件不存在 ⇒ 整份建（标准条目那份，与 init-project.ps1 的首次写法一致）；
 * 已存在且齐 ⇒ 'exists'；已存在但缺 ⇒ check 档报 'would-append'、apply 档只在末尾追加缺失条目。
 */
function ensureGitignore(root, { check, at }) {
  const rel = '.gitignore'
  const abs = path.resolve(root, rel)
  const base = {
    path: rel,
    kind: 'file',
    note: 'git 忽略清单（logs/ projectlog/ .main-writer-flag *.tmp *.bak*）',
    createdAt: null,
  }
  if (!exists(abs)) {
    if (check) {
      return { ...base, status: 'missing', statusNote: '缺失，补全档会按标准条目建一份' }
    }
    try {
      writeText(
        abs,
        '# logs\nlogs/\n\n# AI audit logs (separate from runtime logs/)\nprojectlog/\n\n# main-session commit flag (auto-consumed by pre-commit hook)\n.main-writer-flag\n\n# temp files\n*.tmp\n*.bak*\n',
      )
      return { ...base, status: 'created', createdAt: at, statusNote: '已按标准条目创建' }
    } catch (error) {
      return { ...base, status: 'manual', statusNote: `创建失败：${messageOf(error)}` }
    }
  }
  const read = readText(abs)
  if (read.error) return { ...base, status: 'manual', statusNote: `读不动，未改动：${read.error}` }
  const lines = String(read.text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => line.trim())
  const missing = STANDARD_GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry))
  if (missing.length === 0) {
    return { ...base, status: 'exists', statusNote: '标准条目齐全（一字未改）' }
  }
  if (check) {
    return {
      ...base,
      status: 'would-append',
      statusNote: `缺 ${missing.join(' ')}（补全档只追加这几行，不动已有内容）`,
    }
  }
  try {
    fs.appendFileSync(abs, '\r\n# --- added by /initialize ---\r\n' + missing.map((line) => line + '\r\n').join(''), 'utf8')
    return {
      ...base,
      status: 'appended',
      createdAt: at,
      statusNote: `已追加缺失条目：${missing.join(' ')}（已有内容一字未改）`,
    }
  } catch (error) {
    return { ...base, status: 'manual', statusNote: `追加失败：${messageOf(error)}` }
  }
}

/** 把内部条目投影成回执条目（只给相对路径 + 说明，不给绝对路径噪音）。 */
function summarize(entries) {
  return entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    status: entry.status,
    note: entry.note ?? null,
    statusNote: entry.statusNote ?? null,
    createdAt: entry.createdAt ?? null,
  }))
}

/** 体系层：只检查，不创建（check 档与补全档行为完全一致，都是只读）。 */
function inspectSystem(systemRoot) {
  if (!systemRoot || !exists(systemRoot) || !isDirectory(systemRoot)) {
    return {
      ok: false,
      root: systemRoot || null,
      exists: false,
      entries: SYSTEM_INVENTORY.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        note: entry.note,
        status: 'missing',
        statusNote: `体系根${systemRoot ? '不存在或不是目录' : '未配置'}，判不出这一项`,
      })),
      missing: SYSTEM_INVENTORY.map((entry) => entry.path),
      reason: 'system-root-unavailable',
    }
  }
  const entries = SYSTEM_INVENTORY.map((entry) => {
    const present = exists(path.resolve(systemRoot, entry.path))
    return {
      path: entry.path,
      kind: entry.kind,
      note: entry.note,
      status: present ? 'exists' : 'missing',
      statusNote: present ? null : '体系层只检查、不创建——请人工补齐',
    }
  })
  const missing = entries.filter((entry) => entry.status === 'missing').map((entry) => entry.path)
  return {
    ok: missing.length === 0,
    root: systemRoot,
    exists: true,
    entries,
    missing,
    reason: missing.length === 0 ? null : 'system-items-missing',
  }
}

/** 三栏回执的单一构造点：保证「已存在 / 已创建 / 需人工」与 hint 同步，格式永远一致。 */
function receipt({ check, projectRoot, project, systemRoot, templatesDir, projectEntries, system, source, error }) {
  const existed = summarize(projectEntries.filter((entry) => entry.status === 'exists'))
  const created = summarize(projectEntries.filter((entry) => entry.status === 'created' || entry.status === 'appended'))
  const manual = summarize(projectEntries.filter((entry) => entry.status === 'manual' || entry.status === 'would-append'))
  const wouldCreate = summarize(projectEntries.filter((entry) => entry.status === 'missing'))

  const lines = []
  if (check) {
    lines.push(
      wouldCreate.length === 0
        ? '检查结果：项目层该有的都在（只读检查，没有写任何文件）。'
        : `检查结果：缺 ${wouldCreate.length} 项，补全档（不带 check）会建这些；**本次只读、一个字节都没写**。`,
    )
  } else if (error) {
    lines.push('这次没能开工：拿不到可用的项目根目录（本会话 cwd 拿不到，也没传 projectRoot）。')
  } else if (created.length === 0) {
    lines.push('检查并补全完毕：没有缺项，**已有文件一个字节都没改**。')
  } else {
    lines.push(`检查并补全完毕：新建 / 补全了 ${created.length} 项，**已有文件一个字节都没改**。`)
  }
  if (manual.length > 0) {
    lines.push(`需人工：${manual.map((entry) => entry.path).join('、')}。`)
  }
  if (!system?.ok) {
    lines.push(
      system?.exists
        ? `体系层缺：${system.missing.join('、')}（体系层只检查、不创建）。`
        : '体系层：拿不到体系根，判不出齐不齐（请确认 systemRoot 配置）。',
    )
  }
  // hint 只放一两句下一步（不再把整段正文拼进来：命令层会把 hint 显示一遍，
  // 早先 `lines.join('')` 的写法让同一条信息在回执里出现两次）。
  const nextStep = check
    ? '确认无误就再跑 `/initialize`（不带 check）执行补全。'
    : manual.length > 0
      ? '先补「需人工」栏里的内容。'
      : '骨架已齐。'
  const systemStep = !system?.ok
    ? system?.exists
      ? `体系层缺 ${(system.missing || []).join('、')}（体系层只检查、不创建）。`
      : '拿不到体系根，判不出体系层齐不齐。'
    : ''
  const hint = [
    check ? '本轮只读：一个字节都没写。' : '',
    nextStep,
    '若本会话还没身份，用 `/register project` 注册（注册不要求骨架先存在）。',
    systemStep,
  ].filter(Boolean).join(' ')

  return {
    ok: !error,
    mode: check ? 'check' : 'apply',
    projectRoot: projectRoot || null,
    project: project || null,
    systemRoot: systemRoot || null,
    templatesDir: templatesDir || null,
    source: source ?? null,
    existed,
    created,
    manual,
    wouldCreate,
    counts: { existed: existed.length, created: created.length, manual: manual.length, wouldCreate: wouldCreate.length },
    system: system ?? null,
    changed: check ? false : created.length > 0,
    error: error ?? null,
    hint,
    // 正文段落（结构化回执之外的人话摘要）；命令层按需引用，不再往 hint 里拼。
    notes: lines,
  }
}

/** 「项目根都拿不到」时也要给三栏形状：把清单原样投影成待人工项。 */
function placeholderInventory() {
  return buildProjectInventory('')
    .concat([{ path: '.gitignore', kind: 'file', note: 'git 忽略清单' }])
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      note: entry.note,
      status: 'manual',
      statusNote: '拿不到项目根目录，无法检查（请确认本会话 cwd，或显式传 projectRoot）',
      createdAt: null,
    }))
}

/**
 * `/initialize` 的主逻辑（工具层与命令层共用一个实现）。
 *
 * @param {object} args        { check?, projectRoot? }（projectRoot 只是测试 / 脚本便利）
 * @param {object} exec        { agent }，agent.cwd 是本会话工作目录
 * @param {object} config      { systemRoot?, templatesDir?, project? }
 * @returns {Promise<object>}  三栏回执；**永不抛**。
 */
export async function runInitialize(args, exec, config = {}) {
  const at = nowIso()
  const check = args?.check === true || String(args?.check ?? '').trim().toLowerCase() === 'check'
  const systemRoot = resolveSystemRoot(config)
  const templatesDir = templatesDirOf(config, systemRoot)
  // cwd 来源优先级：命令层解析好的（`args.projectRoot` / `args.cwd`）> 执行器给的 `exec.cwd` >
  // Agent 上的 cwd。**真机实测 Agent 对象不带 cwd**（cwd 只由 workingDirectory 服务提供），
  // 所以只认 `exec.agent.cwd` 会静默退成「拿不到项目根」、把整份清单都报成需人工。
  const selfCwd = (() => {
    const direct = resolveRoot(args?.projectRoot) || resolveRoot(args?.cwd) || resolveRoot(exec?.cwd)
    if (direct) return direct
    try {
      return resolveRoot(exec?.agent?.cwd) || null
    } catch {
      return null
    }
  })()

  try {
    const projectRoot = resolveProjectRoot({
      projectRoot: args?.projectRoot,
      systemRoot,
      project: config?.project,
      cwd: selfCwd,
    })
    const system = inspectSystem(systemRoot)

    if (!projectRoot) {
      return receipt({
        check,
        projectRoot: null,
        project: null,
        systemRoot,
        templatesDir,
        projectEntries: placeholderInventory(),
        system,
        source: 'no-project-root',
        error: 'project-root-unknown',
      })
    }

    const name = projectNameOf(projectRoot, config?.project)
    const inventory = buildProjectInventory(templatesDir)

    // 同名路径存在但不是目录（是个普通文件）：绝不能当「项目根已在」，更不能往里写。
    if (exists(projectRoot) && !isDirectory(projectRoot)) {
      const entries = inventory
        .concat([{ path: '.gitignore', kind: 'file', note: 'git 忽略清单' }])
        .map((entry) => ({ ...entry, status: 'manual', statusNote: '项目根位置上是个普通文件，不是目录——请人工处理' }))
      return receipt({
        check,
        projectRoot,
        project: name,
        systemRoot,
        templatesDir,
        projectEntries: entries,
        system,
        source: 'project-root-not-a-directory',
        error: 'project-root-not-a-directory',
      })
    }

    if (!exists(projectRoot)) {
      if (check) {
        const entries = inventory
          .concat([{ path: '.gitignore', kind: 'file', note: 'git 忽略清单' }])
          .map((entry) => ({ ...entry, status: 'missing', statusNote: '项目根还不存在，补全档会先建它' }))
        return receipt({ check, projectRoot, project: name, systemRoot, templatesDir, projectEntries: entries, system, source: 'ready' })
      }
      try {
        fs.mkdirSync(projectRoot, { recursive: true })
      } catch (error) {
        const entries = inventory
          .concat([{ path: '.gitignore', kind: 'file', note: 'git 忽略清单' }])
          .map((entry) => ({ ...entry, status: 'manual', statusNote: `项目根建不出来：${messageOf(error)}` }))
        return receipt({
          check,
          projectRoot,
          project: name,
          systemRoot,
          templatesDir,
          projectEntries: entries,
          system,
          source: 'project-root-unavailable',
          error: messageOf(error),
        })
      }
    }

    const plans = inventory.map((entry) => inspectEntry(projectRoot, entry, { check, at, name }))
    plans.push(ensureGitignore(projectRoot, { check, at }))

    return receipt({
      check,
      projectRoot,
      project: name,
      systemRoot,
      templatesDir,
      projectEntries: plans,
      system,
      source: 'ready',
    })
  } catch (error) {
    // 永不抛：任何意外都折成一条 ok:false 的三栏回执。
    return {
      ok: false,
      mode: check ? 'check' : 'apply',
      projectRoot: null,
      project: null,
      systemRoot,
      templatesDir,
      source: 'crash-guard',
      existed: [],
      created: [],
      manual: [],
      wouldCreate: [],
      counts: { existed: 0, created: 0, manual: 0, wouldCreate: 0 },
      system: null,
      changed: false,
      error: messageOf(error),
      hint: `检查过程出了意外（${messageOf(error)}），本次没有可用的结果；修好权限 / 路径后重试。`,
    }
  }
}

/** 项目短名：显式 project > 项目根目录名；都拿不到就回 'project'（骨架标题里用）。 */
function projectNameOf(projectRoot, project) {
  const explicit = String(project ?? '').trim()
  if (explicit) return explicit
  try {
    return path.basename(projectRoot) || 'project'
  } catch {
    return 'project'
  }
}

/**
 * 工具定义：`initialize_project`（宿主斜杠命令 `/initialize` 的执行体）。
 * 形状与 tools.js 的 tool() 完全一致，但**不 import tool()**——本模块要在最小假 ctx 下也能单测。
 */
export function buildInitializeTool(ctx, config = {}) {
  void ctx
  // 与 runInitialize 用同一套解析：回执里报的 templatesDir / 清单必须和真正读的一致。
  const systemRoot = resolveSystemRoot(config)
  const templatesDir = templatesDirOf(config, systemRoot)
  const inventory = buildProjectInventory(templatesDir)

  return {
    name: 'initialize_project',
    description:
      '**按契约 §4 检查 / 补全一个项目的初始化清单**（宿主斜杠命令 `/initialize` 的执行体）。默认「补全」：' +
      'PROJECT.md、KNOWLEDGE.md、KNOWLEDGE\\、提案\\、projectlog\\、.gitignore 标准条目，**只补缺失、绝不覆盖已有文件**' +
      '（.gitignore 只追加缺失的标准条目，不动已有内容）。`check:true` ＝ 只报告、**一个字节都不写**。' +
      '体系层（SYSTEM-OVERVIEW.md / PROJECT.md / templates\\ / _registry\\ / tools\\）**只检查、不创建**，缺什么报什么。' +
      '回执固定三栏：existed（已存在，一字未改）/ created（已创建）/ manual（需人工）。' +
      '模板一律按绝对路径复制（`<systemRoot>\\templates\\...`），模板缺失退最小骨架并标「需人工」；本工具**永不抛**。',
    parameters: {
      type: 'object',
      properties: {
        check: {
          type: 'boolean',
          description: 'true = 只报告不写盘（等价于 `/initialize check`）；缺省 / false = 只补缺失，绝不覆盖已有文件。',
        },
        projectRoot: {
          type: 'string',
          description: '可选：项目根目录（绝对路径优先）。不给则按「体系根\\项目名」或本会话 cwd 推。',
        },
      },
    },
    async execute(args, exec) {
      const plan = await runInitialize(args || {}, exec, config)
      // 附上本轮真正用的清单（只读信息，方便命令层/人工核对按哪份清单查的）。
      return { ...plan, inventory: [...inventory.map((entry) => entry.path), '.gitignore'] }
    },
  }
}

/**
 * 同一实现的别名：契约 §5 的集成只写了「import 新模块、export * from」，
 * 没冻死这个 builder 叫什么；两个名字都给，Lead 用哪个都不会 import 失败。
 */
export const buildBootstrapTool = buildInitializeTool
