/**
 * dsh-domain-bridge — `/initialize` bootstrap test (spec §6 第三条)。
 *
 * 冻结的三条验收（逐条对着契约 §4 / §6 写）：
 *   1. `check` 档**不写盘**（临时项目目录里连一个字节都不许变）；
 *   2. 补全档**只建缺失**（已有的一个都不重建、不重复）；
 *   3. 已有文件**内容一字不改**（字节级比对；.gitignore 只允许「追加缺失条目」这一种加法）。
 * 另加护栏：回执必须永远是无损 JSON、工具**永不抛**（不存在的体系根 / 项目根是普通文件 / 相对路径都得活着回话）。
 *
 * 跑法：node test/bootstrap.test.mjs（自成进程，退出码 0/1）。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 直接测实现模块（bootstrap.js 只 import Node 内置模块，自成进程可跑）。
// 不 import lib/bridge.js：它的 export * from './core/bootstrap.js' 属于契约 §5 的集成动作（Lead 负责），
// 本测试不该因为集成还没做而变红；集成完成后这里只多一个「桥里也导出了」的护栏（见文件末尾）。
const mod = await import(new URL('../lib/core/bootstrap.js', import.meta.url).href)

const stats = { cases: 0, branches: 0 }
const ok = (cond, message) => {
  stats.branches++
  assert.ok(cond, message)
}
const eq = (actual, expected, message) => {
  stats.branches++
  assert.deepStrictEqual(actual, expected, message)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-bridge-init-'))
const readBytes = (file) => fs.readFileSync(file)
const readText = (file) => fs.readFileSync(file, 'utf8')
const existsOf = (file) => fs.existsSync(file)

/** 假 ctx：本模块用的是 `tool` 的直接包装，ctx 只为与 apply() 同一形状存在。 */
const fakeCtx = { get: () => undefined }

/** 直接构建并调用工具本体（不 import tool()，最小假 ctx 就能跑）。 */
async function run({ config = {}, args = {}, cwd } = {}) {
  const definition = mod.buildInitializeTool(fakeCtx, config)
  return definition.execute(args, { agent: { id: 'session-init-test', cwd } })
}

/** 无损 JSON 断言：宿主拒收 undefined / 函数 / 循环 / -0 / NaN 这类值。 */
function assertLossless(value, label) {
  const round = JSON.parse(JSON.stringify(value))
  eq(round, value, `${label}: 回执必须是无损 JSON（JSON.parse(JSON.stringify(v)) 与原值深等）`)
}

// ---------------------------------------------------------------- 1. 空项目根：check 只读
{
  const caseRoot = path.join(root, 'c1')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })

  const before = fs.readdirSync(projectRoot)
  const out = await run({ config: { systemRoot }, args: { check: true }, cwd: projectRoot })

  eq(out.ok, true, 'check 档应成功')
  eq(out.mode, 'check', 'mode 应为 check')
  eq(out.changed, false, 'check 档不应声明有任何写盘')
  eq(fs.readdirSync(projectRoot), before, 'check 档绝不能在项目根建任何东西')
  eq(readdirRecursive(projectRoot), [], 'check 档后项目根必须还是空的（连子目录都不许有）')
  eq(out.created.length, 0, 'check 档的 created 栏必须为空')
  eq(out.wouldCreate.map((entry) => entry.path).sort(), ['.gitignore', 'KNOWLEDGE', 'KNOWLEDGE.md', 'PROJECT.md', 'projectlog', '提案'].sort(), 'check 档应报告全部缺失项')
  eq(out.manual.length, 0, '缺失项不是「需人工」，只是「待创建」')
  ok(typeof out.hint === 'string' && out.hint.includes('只读'), 'check 档 hint 应说清本次只读')
  assertLossless(out, 'c1')
  stats.cases++
}

// ---------------------------------------------------------------- 2. 空项目根：补全只建缺失
{
  const caseRoot = path.join(root, 'c2')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })

  const out = await run({ config: { systemRoot }, args: {}, cwd: projectRoot })

  eq(out.ok, true, '补全档应成功')
  eq(out.mode, 'apply', 'mode 应为 apply')
  eq(out.changed, true, '补全档建了东西 ⇒ changed:true')
  eq(out.project, 'misas', '项目名 = 项目根目录名（小写）')
  eq(out.existed.length, 0, '全新项目里没有「已存在」项')
  eq(out.created.length, 6, '应建 6 项（PROJECT.md / KNOWLEDGE.md / KNOWLEDGE / 提案 / projectlog / .gitignore）')
  for (const dir of ['KNOWLEDGE', '提案', 'projectlog']) {
    ok(fs.statSync(path.join(projectRoot, dir)).isDirectory(), `${dir}/ 应已建成目录`)
  }
  for (const file of ['PROJECT.md', 'KNOWLEDGE.md', '.gitignore']) {
    ok(readBytes(path.join(projectRoot, file))[0] !== 0xef, `${file} 必须无 BOM`)
  }
  ok(readText(path.join(projectRoot, '.gitignore')).includes('.main-writer-flag'), '.gitignore 应含标准条目')
  eq(fs.readdirSync(systemRoot), [], '补全档绝不能碰体系根（体系层只检查、不创建）')
  assertLossless(out, 'c2')
  stats.cases++
}

// ---------------------------------------------------------------- 3. 已有文件内容一字不改（字节级）
{
  const caseRoot = path.join(root, 'c3')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })

  const existing = {
    'PROJECT.md': '# misas\n\n## Current State\n\n人工写过的内容，绝不能被覆盖。\n',
    'KNOWLEDGE.md': '# misas — Project Knowledge\n\n人工内容\n',
    '.gitignore': '# 人工注释\nnode_modules/\n*.tmp\nlogs/\nprojectlog/\n.main-writer-flag\n*.bak*\n',
  }
  for (const [rel, text] of Object.entries(existing)) {
    fs.writeFileSync(path.join(projectRoot, rel), text, 'utf8')
  }
  const before = new Map(Object.keys(existing).map((rel) => [rel, readBytes(path.join(projectRoot, rel))]))

  const out = await run({ config: { systemRoot }, args: {}, cwd: projectRoot })

  eq(out.existed.map((entry) => entry.path).sort(), ['KNOWLEDGE.md', 'PROJECT.md', '.gitignore'].sort(), '已有项应进「已存在」栏')
  eq(out.created.map((entry) => entry.path).sort(), ['KNOWLEDGE', '提案', 'projectlog'].sort(), '只建缺失的目录')
  eq(out.manual.length, 0, '无失败项')
  for (const rel of Object.keys(existing)) {
    eq(readBytes(path.join(projectRoot, rel)), before.get(rel), `${rel} 内容必须一字不改（字节级）`)
  }
  eq(readText(path.join(projectRoot, '.gitignore')), existing['.gitignore'], '标准条目已齐 ⇒ 连追加都不许发生')
  assertLossless(out, 'c3')
  stats.cases++
}

// ---------------------------------------------------------------- 4. 已有 .gitignore 缺条目 ⇒ 只追加、不重写
{
  const caseRoot = path.join(root, 'c4')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })

  const original = '# 我的忽略清单\nnode_modules/\n.dist/\n'
  const gi = path.join(projectRoot, '.gitignore')
  fs.writeFileSync(gi, original, 'utf8')

  const out = await run({ config: { systemRoot }, args: {}, cwd: projectRoot })

  const after = readText(gi)
  ok(after.startsWith(original), '原内容必须原样打头（只追加，不重写）')
  for (const entry of mod.STANDARD_GITIGNORE_ENTRIES) {
    ok(after.includes(entry), `.gitignore 应补上标准条目 ${entry}`)
  }
  const giEntry = out.created.find((entry) => entry.path === '.gitignore')
  ok(Boolean(giEntry), '.gitignore 补条目后应进「已创建 / 已补全」栏')
  ok(typeof giEntry.statusNote === 'string' && giEntry.statusNote.includes('追加'), '应说明只是追加了缺失条目')
  eq(out.existed.some((entry) => entry.path === '.gitignore'), false, '补过条目的 .gitignore 不该再声称「一字未改」')
  assertLossless(out, 'c4')
  stats.cases++
}

// ---------------------------------------------------------------- 5. check 档：已有 / 已有 .gitignore 缺条目 都不许写盘
{
  const caseRoot = path.join(root, 'c5')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })

  const original = '# 人工\nnode_modules/\n'
  const gi = path.join(projectRoot, '.gitignore')
  fs.writeFileSync(gi, original, 'utf8')

  const out = await run({ config: { systemRoot }, args: { check: true }, cwd: projectRoot })

  eq(readText(gi), original, 'check 档绝不能追加 .gitignore')
  eq(fs.readdirSync(projectRoot), ['.gitignore'], 'check 档后项目根除了原有的 .gitignore 不能有任何新东西')
  const giEntry = out.manual.find((entry) => entry.path === '.gitignore')
  ok(Boolean(giEntry), 'check 档应把「缺条目的 .gitignore」报成待处理（放到需人工栏，而不是已创建）')
  eq(out.created.length, 0, 'check 档 created 必须为空')
  eq(out.changed, false, 'check 档 changed 必须是 false')
  assertLossless(out, 'c5')
  stats.cases++
}

// ---------------------------------------------------------------- 6. 模板缺失 ⇒ 最小骨架 + 需人工
{
  const caseRoot = path.join(root, 'c6')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })

  const out = await run({ config: { systemRoot }, args: {}, cwd: projectRoot })

  const projectEntry = out.created.find((entry) => entry.path === 'PROJECT.md')
  ok(Boolean(projectEntry), 'PROJECT.md 应被创建')
  ok(projectEntry.statusNote.includes('最小骨架'), '模板缺失 ⇒ statusNote 应标明用了最小骨架')
  ok(projectEntry.statusNote.includes('人工'), '最小骨架 ⇒ 应标「内容仍需人工补全」')
  eq(readText(path.join(projectRoot, 'PROJECT.md')).split('\n')[0], '# misas', '骨架标题应为项目名')
  eq(out.existed.length, 0, '空项目里没有已存在项')
  assertLossless(out, 'c6')
  stats.cases++
}

// ---------------------------------------------------------------- 7. 模板存在 ⇒ 整份复制（不重写模板正文）
{
  const caseRoot = path.join(root, 'c7')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  const templatesDir = path.join(systemRoot, 'templates')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(templatesDir, { recursive: true })

  const templateBody = '# 模板 PROJECT\n\n> 这份正文来自 templates\\PROJECT-模板.md，必须原样落地。\n'
  fs.writeFileSync(path.join(templatesDir, 'PROJECT-模板.md'), templateBody, 'utf8')

  const out = await run({ config: { systemRoot }, args: {}, cwd: projectRoot })

  eq(readText(path.join(projectRoot, 'PROJECT.md')), templateBody, '模板正文必须逐字复制（不改写）')
  const entry = out.created.find((item) => item.path === 'PROJECT.md')
  ok(entry.statusNote.includes('PROJECT-模板.md'), 'statusNote 应写明复制自哪份模板')
  eq(entry.statusNote.includes('人工补全'), false, '模板齐备时不该报「仍需人工补全」')
  assertLossless(out, 'c7')
  stats.cases++
}

// ---------------------------------------------------------------- 8. 幂等：再跑一次什么都不建
{
  const caseRoot = path.join(root, 'c8')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })

  const first = await run({ config: { systemRoot }, args: {}, cwd: projectRoot })
  eq(first.created.length, 6, '第一次应建 6 项')

  const snapshot = readdirRecursive(projectRoot)
  const bytes = new Map(snapshot.map((rel) => [rel, readBytes(path.join(projectRoot, rel))]))

  const second = await run({ config: { systemRoot }, args: {}, cwd: projectRoot })

  eq(second.created.length, 0, '第二次不应再建任何东西（幂等）')
  eq(second.changed, false, '第二次 changed 应为 false')
  eq(second.existed.length, 6, '第二次 6 项都应报「已存在」')
  eq(readdirRecursive(projectRoot), snapshot, '第二次不得增删任何文件')
  for (const rel of snapshot) {
    eq(readBytes(path.join(projectRoot, rel)), bytes.get(rel), `${rel} 第二次跑必须一字不改`)
  }
  assertLossless(second, 'c8')
  stats.cases++
}

// ---------------------------------------------------------------- 9. 体系层：只检查、不创建、缺什么报什么
{
  const caseRoot = path.join(root, 'c9')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })
  fs.writeFileSync(path.join(systemRoot, 'SYSTEM-OVERVIEW.md'), '# overview\n', 'utf8')
  fs.mkdirSync(path.join(systemRoot, 'templates'))
  fs.mkdirSync(path.join(systemRoot, '_registry'))

  const out = await run({ config: { systemRoot }, args: {}, cwd: projectRoot })

  eq(out.system.missing.sort(), ['PROJECT.md', 'tools'].sort(), '体系层应报出缺的那两项')
  eq(out.system.google, undefined, '回执不带没定义过的键')
  for (const entry of out.system.entries) {
    if (entry.status === 'exists') {
      continue
    }
    ok(entry.statusNote.includes('只检查、不创建'), '体系层的缺失项必须写明「只检查、不创建」')
  }
  eq(fs.readdirSync(systemRoot).sort(), ['SYSTEM-OVERVIEW.md', '_registry', 'templates'].sort(), '体系根绝不能被新建任何东西')
  ok(out.hint.includes('体系层缺'), 'hint 应把体系层缺项说出来')
  assertLossless(out, 'c9')
  stats.cases++
}

// ---------------------------------------------------------------- 10. 体系根不存在 ⇒ 如实回报，不抛
{
  const caseRoot = path.join(root, 'c10')
  const projectRoot = path.join(caseRoot, 'misas')
  fs.mkdirSync(projectRoot, { recursive: true })

  const out = await run({ config: { systemRoot: path.join(caseRoot, 'not-there') }, args: {}, cwd: projectRoot })

  eq(out.ok, true, '体系根缺失不该让项目层补全失败')
  eq(out.system.exists, false, 'system.exists 应为 false')
  eq(out.system.reason, 'system-root-unavailable', 'system.reason 应说明体系根不可用')
  eq(out.created.length, 6, '体系根缺失不影响项目层补全')
  assertLossless(out, 'c10')
  stats.cases++
}

// ---------------------------------------------------------------- 11. 拿不到项目根 ⇒ ok:false + 三栏形状仍在
{
  const out = await run({ config: { systemRoot: path.join(root, 'c11-sys') }, args: {} })

  eq(out.ok, false, '拿不到项目根应 ok:false')
  eq(out.error, 'project-root-unknown', 'error 应说明是项目根问题')
  eq(out.projectRoot, null, 'projectRoot 应为 null')
  ok(out.manual.length > 0, '需人工栏仍应给出清单形状')
  ok(typeof out.hint === 'string' && out.hint.length > 0, '必须给下一步可执行的提示')
  eq(out.changed, false, '没写盘 ⇒ changed:false')
  assertLossless(out, 'c11')
  stats.cases++
}

// ---------------------------------------------------------------- 12. 项目根是普通文件 ⇒ 如实回报，不抛
{
  const caseRoot = path.join(root, 'c12')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(caseRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })
  fs.writeFileSync(projectRoot, 'not a directory\n', 'utf8')

  const out = await run({ config: { systemRoot }, args: {}, cwd: projectRoot })

  eq(out.ok, false, '项目根是文件 ⇒ 该失败但仍活着回话')
  eq(out.error, 'project-root-not-a-directory', 'error 应说清是「同名路径是文件、不是目录」')
  eq(out.manual.length, 6, '6 项都应落「需人工」')
  for (const entry of out.manual) {
    ok(entry.statusNote.includes('不是目录'), `${entry.path} 应带上具体原因`)
  }
  eq(readText(projectRoot), 'not a directory\n', '不能覆盖那个同名文件')
  assertLossless(out, 'c12')
  stats.cases++
}

// ---------------------------------------------------------------- 13. 显式 projectRoot + 相对传入也安全
{
  // 相对路径按「进程 cwd」解析——正是 bootstrap 的实现口径。把进程 cwd 临时挪进临时目录，
  // 这样这个用例既能验证相对路径，又绝不会在仓库里留下任何东西。
  const caseRoot = path.join(root, 'c13')
  fs.mkdirSync(caseRoot, { recursive: true })
  const origin = process.cwd()
  process.chdir(caseRoot)
  let out
  try {
    out = await run({ config: { systemRoot: path.join(caseRoot, 'sys') }, args: { projectRoot: 'relative-project' }, cwd: caseRoot })
  } finally {
    process.chdir(origin)
  }

  const expectedRoot = path.resolve(caseRoot, 'relative-project')
  eq(out.ok, true, '显式 projectRoot 应被接受（相对路径按进程 cwd 解析）')
  eq(out.projectRoot, expectedRoot, 'projectRoot 应绝对化')
  ok(existsOf(path.join(expectedRoot, 'PROJECT.md')), '应真的建在解析出来的绝对路径下')
  eq(existsOf(path.join(origin, 'relative-project')), false, '绝不能污染进程原来的 cwd')
  assertLossless(out, 'c13')
  stats.cases++
}

// ---------------------------------------------------------------- 14. check 传字符串 'check' 也算 check
{
  const caseRoot = path.join(root, 'c14')
  const projectRoot = path.join(caseRoot, 'misas')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })

  const out = await run({ config: { systemRoot }, args: { check: 'check' }, cwd: projectRoot })

  eq(out.mode, 'check', "check:'check' 应等价于 check:true")
  eq(fs.readdirSync(projectRoot), [], '仍不许写盘')
  assertLossless(out, 'c14')
  stats.cases++
}

// ---------------------------------------------------------------- 15. 桥集成护栏（软检查，不因集成未做而红）
{
  const bridge = await import(new URL('../lib/bridge.js', import.meta.url).href)
  const wired = typeof bridge.buildInitializeTool === 'function'
  if (!wired) {
    console.log('[bootstrap] 提示：lib/bridge.js 还没 export * from "./core/bootstrap.js"（契约 §5 集成动作，Lead 负责）；本文件直连实现模块，不受影响。')
  }
  ok(typeof mod.buildInitializeTool === 'function', '实现模块必须导出 buildInitializeTool')
  ok(typeof mod.runInitialize === 'function', '实现模块必须导出 runInitialize（命令层复用）')
  eq(mod.buildBootstrapTool, mod.buildInitializeTool, 'buildBootstrapTool 必须是同一实现的别名（防集成时 import 名不一致）')
  stats.cases++
}

// ------------------------------- 9. 真机形状：Agent 上没有 cwd，只靠 projectRoot/cwd 传入
// 真机 bug（0.8.2）：命令层从 workingDirectory 服务解析 cwd 后只放进 `args.cwd`，而实现只认
// `exec.agent.cwd`（宿主 Agent 对象不带这个字段）⇒ 整份清单退化成「需人工」，一个文件都不建。
{
  const caseRoot = path.join(root, 'c9')
  const projectRoot = path.join(caseRoot, 'xinxiangmu')
  const systemRoot = path.join(caseRoot, 'sys')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(systemRoot, { recursive: true })

  const definition = mod.buildInitializeTool(fakeCtx, { systemRoot })
  // 只给 args.projectRoot / args.cwd，`agent` 上**没有 cwd**（与宿主一致）。
  const viaProjectRoot = await definition.execute({ projectRoot }, { agent: { id: 'session-real-shape' } })
  eq(viaProjectRoot.ok, true, '只给 projectRoot 时也应开工（不得退回「拿不到项目根」）')
  eq(viaProjectRoot.projectRoot, projectRoot, 'projectRoot 应原样落到回执里')
  ok(viaProjectRoot.created.length > 0, '只给 projectRoot 时必须真的建出文件，而不是全报需人工')
  ok(existsOf(path.join(projectRoot, 'PROJECT.md')), 'PROJECT.md 应被自动生成')
  ok(existsOf(path.join(projectRoot, 'KNOWLEDGE.md')), 'KNOWLEDGE.md 应被自动生成')
  ok(existsOf(path.join(projectRoot, 'projectlog')), 'projectlog 目录应被自动创建')
  eq(viaProjectRoot.manual.length, 0, '自动生成成功时不应再报需人工')

  const viaCwd = await definition.execute({ cwd: projectRoot }, { agent: { id: 'session-real-shape' } })
  eq(viaCwd.projectRoot, projectRoot, '只给 args.cwd 时也应认成项目根')
  eq(viaCwd.ok, true, '只给 args.cwd 时应开工')

  const bare = await definition.execute({}, { agent: { id: 'session-real-shape' } })
  eq(bare.ok, false, '真的拿不到 cwd 时才允许报错')
  eq(bare.source, 'no-project-root', '拿不到根应如实标 no-project-root')
  ok(bare.hint.includes('/initialize') || bare.hint.length > 0, '拿不到根也要给下一步')
  stats.cases++
}

// ------------------------------------------------------------------ summary
console.log(
  `[bootstrap] 用例 ${stats.cases} | 分支断言 ${stats.branches} | ` +
    `check 只读 ✓ 补全只建缺失 ✓ 已有内容一字不改 ✓ 回执无损 JSON ✓ 永不抛 ✓`,
)
fs.rmSync(root, { recursive: true, force: true })

/** 递归列目录下的相对文件（目录不列，只列文件；用于「什么都没多」这类断言）。 */
function readdirRecursive(dir) {
  const out = []
  const walk = (current, prefix) => {
    for (const name of fs.readdirSync(current).sort()) {
      const abs = path.join(current, name)
      const rel = prefix ? prefix + '/' + name : name
      if (fs.statSync(abs).isDirectory()) walk(abs, rel)
      else out.push(rel)
    }
  }
  walk(dir, '')
  return out
}
