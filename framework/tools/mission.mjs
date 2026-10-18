#!/usr/bin/env node
/**
 * mission.mjs —— 使命登记/结项（替代停更的 project-map 插件）
 *
 * WHY THIS EXISTS
 *   原 `project_map` 插件（v0.1.0）没有随 dsh 桌面端迁移，桌面 profile 里
 *   package.json / cordis.yml 全无它。插件停更 → 使命库自 2026-09-27 起冻结。
 *   使命库是体系索引 `_registry\INDEX.md` 表一的主键来源（编号 → 使命 →
 *   会话/分支/报告）。没有写入端，索引的使命表就永远停在那一天。
 *
 *   本脚本**只做写入**，格式与旧插件**逐字段一致**（同一目录、同一 JSON 形状），
 *   所以：① 索引零改动即可读；② 已登记的 82 条无缝衔接；
 *        ③ 将来若插件恢复或换任何工具，双方仍能互读。
 *
 * 只复刻两个动作 + 一个查看（其余不抄，见下）
 *   declare  登记一条使命
 *   complete 结项：改状态 + 贴达成报告
 *   list     查看（顺带能按 --file 回答"谁在碰这个文件"）
 *
 * **故意不复刻**：`missions`（旧实现把全部使命原文拉进上下文，实测 ≥256KB，很贵）
 *   → 改用「索引 `session-registry.mjs --file "<路径>"`」回答同类问题；
 *     `structure` / `changes` / `status` / `configure` 亦不复刻。
 *
 * 用法
 *   node mission.mjs declare --name S04-fix-x --feature "一句话" \
 *        --files "a.cs,b.cs" --acceptance "怎么算完成" [--untouched "..."] \
 *        [--affected "..."] [--session session-<uuid>] [--dry-run]
 *   node mission.mjs complete --name S04-fix-x --report-file report.md [--status completed]
 *   node mission.mjs complete --id m-xxxx --report "..." 
 *   node mission.mjs list [--status active] [--file <路径>] [--limit 20]
 *
 * 连带动作（v1.1.0 加）
 *   declare 成功后**自动跑一次** tools\session-registry.mjs 刷新索引（约 25s，同步等它跑完），
 *   让"派发前索引是新的"从"靠人记"变成"机械发生"（提案 2026-10-09 §2.3）。
 *   失败只警告，不影响登记；跳过用 --no-refresh 或 MISSION_NO_REFRESH=1。
 *
 * 坑（写代码时踩到/防到的）
 *   - `--session` 必须带 `session-` 前缀（存档目录就是这个名字）；不带会自己补
 *   - **漏传 --session 不会报错**，但索引会只能靠 cwd 兜底 → 可能把这条归到别的项目，
 *     且是**静默**的。所以 declare 结束一定打印"我写进了哪个项目根"，让人肉眼能看见。
 *   - 文件一律 UTF-8 **无 BOM**（PS5.1 的 json 消费者不剥 BOM）
 *   - 写前查重名，撞了就换 id（不覆盖别人的使命）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const KIT = path.join(os.homedir(), '.dsh', 'project-map-kit')
const MISSIONS = path.join(KIT, 'missions')
// 索引生成器就在本文件旁边（tools\）。declare 成功后**连带**跑它一次（提案 2026-10-09 §2.3）。
const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REGISTRY = path.join(TOOLS_DIR, 'session-registry.mjs')
const REGISTRY_TIMEOUT_MS = 120000 // 实测一次全量刷新约 25s；超时就放弃，只警告
const TOOL_VERSION = '1.1.0'

const HELP = `mission.mjs v${TOOL_VERSION} — 使命登记/结项（替代 project-map 插件）

  declare   登记一条使命
    --name <S##-slug>      使命名（必填，与分支 feature/<name> 一致）
    --feature <一句话>      这条使命要做什么（必填）
    --files <a,b>          本次会改的文件（逗号分隔；必填）
    --acceptance <文字>     验收标准（必填）
    --untouched <文字>     明确不动什么
    --affected <文字>      会影响什么
    --session <session-id> 登记它的会话（强烈建议；不带则索引只能靠 cwd 兜底）
    --no-refresh           登记后不连带刷新索引（默认会刷，见下）
    --dry-run              只打印，不落盘

  declare 成功后默认**连带刷新索引**（跑同目录的 session-registry.mjs，约 25 秒）：
  这样"派发前索引是新的"不再靠人记，而是机械发生。刷新失败**只警告、不影响登记结果**；
  想跳过用 --no-refresh 或设 MISSION_NO_REFRESH=1。

  complete  结项
    --id <m-xxx> | --name <使命名>   定位（二选一）
    --report-file <路径>             达成报告正文（5 段格式）
    --report <文字>                  或直接给正文
    --status <completed|active|...>  默认 completed

  list      列出（默认按更新时间倒序，只读）
    --status <s> / --file <路径> / --limit <n> / --json

使命库：${MISSIONS}
`

function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const o = { cmd, files: [], affected: [] }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    const next = () => rest[++i]
    switch (a) {
      case '--name': o.name = next(); break
      case '--feature': o.feature = next(); break
      case '--files': o.files = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break
      case '--acceptance': o.acceptance = next(); break
      case '--untouched': o.untouched = next(); break
      case '--affected': o.affected = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break
      case '--session': o.session = next(); break
      case '--id': o.id = next(); break
      case '--report': o.report = next(); break
      case '--report-file': o.reportFile = next(); break
      case '--status': o.status = next(); break
      case '--file': o.fileQuery = next(); break
      case '--limit': o.limit = Number(next()); break
      case '--json': o.json = true; break
      case '--no-refresh': o.noRefresh = true; break
      case '--dry-run': o.dry = true; break
      case '-h': case '--help': o.help = true; break
      default:
        if (a.startsWith('--')) die(`未知参数 ${a}`)
    }
  }
  // 守卫（2026-10-08 加）：值的正文里若冒出另一个参数名，说明**引号没闭合**。
  // 实测踩到：`--untouched` 的值以反斜杠结尾（…\{数据根}\Generated\）时，紧跟的那个 `"` 被当成
  // **转义引号** → ` --session session-xxxxxxxx-…` 被整个吞进 untouched 的值里，sessionId 静默丢失
  // （项目乙 gui 域 4 条使命就是这么从"窗口"掉进索引的"（无会话）"组的）。
  // 这类错必须**报错退出**，不能让工具帮着写出坏数据。report 正文允许含参数名，故跳过。
  for (const [k, v] of Object.entries(o)) {
    if (k === 'report') continue
    for (const s of Array.isArray(v) ? v : [v]) {
      if (typeof s !== 'string') continue
      const m = s.match(/(?:^|\s)(--[A-Za-z][\w-]*)/)
      if (m) die(`${k} 的值里出现了另一个参数名「${m[1]}」——多半是**引号没闭合**（值以反斜杠结尾时，紧跟的 " 会被当作转义引号）。把该值末尾的反斜杠去掉或写双反斜杠，再重跑。`)
    }
  }
  return o
}

function die(msg) { process.stderr.write(`mission.mjs: ${msg}\n`); process.exit(1) }

// 旧插件的 id 形态：m-<紧凑时间戳>-<随机>。沿用同形状，便于同目录共存。
function newId() {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 7)
  return `m-${t}-${r}`
}

/**
 * 派发前刷新索引（提案 2026-10-09 §2.3「机械连带」）。
 * 同步跑：declare 一返回，索引里就已经有这条使命 —— 子代理开局读到的不会是旧表。
 * 脚本不在 / 退出码非 0 / 超时，一律只打印警告，**绝不改 declare 的退出码**。
 */
function refreshIndex(o, why) {
  if (o.dry || o.noRefresh || process.env.MISSION_NO_REFRESH === '1') return
  if (!fs.existsSync(REGISTRY)) {
    process.stdout.write(`     索引刷新  ⚠️ 跳过：找不到 ${REGISTRY}（登记已成功）\n`)
    return
  }
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [REGISTRY], { stdio: 'ignore', timeout: REGISTRY_TIMEOUT_MS })
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  if (r.error || r.status !== 0) {
    const reason = r.error ? r.error.message : `退出码 ${r.status}`
    process.stdout.write(`     索引刷新  ⚠️ 失败（${reason}，${sec}s）——本次登记已成功、不受影响；请手工跑：node ${REGISTRY}\n`)
    return
  }
  process.stdout.write(`     索引刷新  ✅ ${sec}s（${why}）→ INDEX.md / registry.json 已带上本条\n`)
}

function normSession(s) {
  if (!s) return undefined
  return s.startsWith('session-') ? s : `session-${s}`
}

function readMissions() {
  if (!fs.existsSync(MISSIONS)) return []
  const out = []
  for (const f of fs.readdirSync(MISSIONS)) {
    if (!f.endsWith('.json')) continue
    try {
      const j = JSON.parse(fs.readFileSync(path.join(MISSIONS, f), 'utf8'))
      out.push({ file: f, ...j })
    } catch { /* 坏文件跳过，不当数据丢失 */ }
  }
  return out
}

function writeMission(obj) {
  fs.mkdirSync(MISSIONS, { recursive: true })
  let id = obj.id
  for (let i = 0; i < 5; i++) {
    const p = path.join(MISSIONS, `${id}.json`)
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(obj, null, 2), { encoding: 'utf8' })
      return p
    }
    id = newId() // 撞名就换，绝不覆盖别人的使命
  }
  die('连续 5 次 id 撞名，放弃（使命库异常？）')
}

/** 使命归属哪个项目：会话存档第一条记录的 cwd → projcache 兜底 → 未知 */
function resolveProjectRoot(sessionId) {
  if (!sessionId) return { root: '(未提供 --session：索引只能靠 cwd 兜底)', how: 'none' }
  const roots = [
    path.join(os.homedir(), '.dsh', 'sessions'),
  ]
  for (const base of roots) {
    if (!fs.existsSync(base)) continue
    for (const ws of fs.readdirSync(base)) {
      const d = path.join(base, ws, sessionId)
      if (!fs.existsSync(d)) continue
      const files = fs.readdirSync(d).filter((f) => f.endsWith('.zstd'))
      const best = files.map((f) => ({ f, size: fs.statSync(path.join(d, f)).size })).sort((a, b) => b.size - a.size)[0]
      if (!best) continue
      try {
        const raw = fs.readFileSync(path.join(d, best.f))
        const text = raw.includes(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
          ? tryZstd(path.join(d, best.f))
          : raw.toString('utf8')
        const first = JSON.parse(text.split('\n')[0])
        const cwd = first?.data?.header?.cwd ?? first?.cwd
        if (cwd) return { root: cwd, how: 'archive' }
      } catch { /* 继续兜底 */ }
    }
  }
  // projcache 兜底（存档已删时仍保留）
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'storages', 'session_projcache.json'), 'utf8'))
    const cwd = pj?.tables?.sessions?.[sessionId]?.identity?.cwd
    if (cwd) return { root: cwd, how: 'projcache' }
  } catch { /* ignore */ }
  return { root: '(查不到：会话存档已删且 projcache 无记录)', how: 'unknown' }
}

/** 只解全部帧（存档是多帧追加 zstd；首条 session 记录在第一帧，但整文件解更稳）。 */
function tryZstd(file) {
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const idx = []
  let p = 0
  while ((p = buf.indexOf(magic, p)) !== -1) { idx.push(p); p += 4 }
  const parts = []
  for (let i = 0; i < idx.length; i++) {
    const s = idx[i]
    const e = i + 1 < idx.length ? idx[i + 1] : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.slice(s, e))) } catch { /* partial */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

function cmdDeclare(o) {
  for (const k of ['name', 'feature', 'acceptance']) if (!o[k]) die(`declare 缺 --${k}`)
  if (!o.files.length) die('declare 缺 --files')
  const sessionId = normSession(o.session)
  const now = Date.now()
  const id = newId()
  const obj = {
    id,
    ...(sessionId ? { sessionId } : {}),
    name: o.name,
    feature: o.feature,
    files: o.files,
    ...(o.affected.length ? { affected: o.affected } : {}),
    acceptance: o.acceptance,
    ...(o.untouched ? { untouched: o.untouched } : {}),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  // 同名去重（2026-10-08 加）：同名且**未结算**的记录已存在 ⇒ 复用/更新那一条，不再新建。
  // 实测踩到：同一窗口对 S20 连发两次 declare（原版 + rev2）⇒ 使命库出现两条同名记录，
  // 而 complete 只结算其中一条 ⇒ 另一条永远是 active，索引"进行中"因此虚高一条。
  const dup = readMissions().filter((m) => m.name === o.name && m.status !== 'completed')
  if (dup.length) {
    const t = dup.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    const merged = { ...t, ...obj, id: t.id, createdAt: t.createdAt }
    delete merged.file
    if (o.dry) {
      process.stdout.write(`[dry-run] 同名未结算已存在 → 将**更新** ${MISSIONS}\\${t.file}\n${JSON.stringify(merged, null, 2)}\n`)
      return 0
    }
    fs.writeFileSync(path.join(MISSIONS, t.file), JSON.stringify(merged, null, 2), { encoding: 'utf8' })
    const r = resolveProjectRoot(sessionId)
    process.stdout.write('[ok] 同名未结算使命已存在 → **复用更新**（不新建记录）\n')
    process.stdout.write(`     使命      ${o.name}（${t.id}，createdAt 保留）\n`)
    process.stdout.write(`     会话      ${sessionId ?? '(未提供)'}\n`)
    process.stdout.write(`     归属项目  ${r.root}   (依据: ${r.how})\n`)
    process.stdout.write(`     文件      ${path.join(MISSIONS, t.file)}\n`)
    process.stdout.write(`     下一步    切到既有分支继续：git checkout feature/${o.name}\n`)
    refreshIndex(o, '复用更新')
    return 0
  }
  if (o.dry) { process.stdout.write(`[dry-run] 将写入 ${MISSIONS}\\${id}.json\n${JSON.stringify(obj, null, 2)}\n`); return 0 }
  const p = writeMission(obj)
  const { root, how } = resolveProjectRoot(sessionId)
  process.stdout.write(`[ok] 已登记使命 ${o.name}\n`)
  process.stdout.write(`     id        ${id}\n`)
  process.stdout.write(`     会话      ${sessionId ?? '(未提供)'}\n`)
  process.stdout.write(`     归属项目  ${root}   (依据: ${how})\n`)
  process.stdout.write(`     文件      ${p}\n`)
  if (how !== 'archive') {
    process.stdout.write(`     ⚠️ 归属没有从会话存档确认。若上面这行不是你要的项目，请核对 --session。\n`)
  }
  process.stdout.write(`     下一步    git checkout -b feature/${o.name}\n`)
  refreshIndex(o, '新建')
  return 0
}

function cmdComplete(o) {
  if (!o.id && !o.name) die('complete 需要 --id 或 --name')
  const all = readMissions()
  const byKey = (m) => (o.id ? m.id === o.id : m.name === o.name)
  const matched = all.filter(byKey)
  if (!matched.length) die(`找不到使命（${o.id ?? o.name}）`)
  // 同名**未结算**的一次全结算（2026-10-08 修）：旧实现只结算 updatedAt 最新的一条，
  // 于是重复 declare 留下的同名记录永远是 active（实测 项目乙 S20 就是这样成了幽灵，
  // 让索引"进行中"虚高一条）。没有未结算的就退回"更新最新那条"（同一使命 rev2 补报告的场景）。
  const open = matched.filter((m) => m.status !== 'completed')
  const targets = open.length ? open : [matched.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]]
  let report = o.report ?? ''
  if (o.reportFile) {
    if (!fs.existsSync(o.reportFile)) die(`报告文件不存在：${o.reportFile}`)
    report = fs.readFileSync(o.reportFile, 'utf8')
  }
  if (!report) die('complete 需要 --report 或 --report-file')
  const ts = Date.now()
  const st = o.status ?? 'completed'
  if (o.dry) { process.stdout.write(`[dry-run] 将更新 ${targets.map((t) => t.file).join('、')}\n`); return 0 }
  for (const target of targets) {
    const obj = { ...target, status: st, report, updatedAt: ts }
    delete obj.file
    fs.writeFileSync(path.join(MISSIONS, target.file), JSON.stringify(obj, null, 2), { encoding: 'utf8' })
  }
  process.stdout.write(`[ok] ${targets[0].name} → ${st}${targets.length > 1 ? `（同名 **${targets.length}** 条未结算记录一并结算）` : ''}\n`)
  process.stdout.write(`     报告 ${report.length} 字符已写入\n`)
  process.stdout.write(`     文件 ${targets.map((t) => path.join(MISSIONS, t.file)).join('、')}\n`)
  const miss = ['[文件清单]', '[依赖新增]', '[未处理异常]', '[自测用例]'].filter((k) => !report.includes(k))
  if (miss.length) process.stdout.write(`     ⚠️ 达成报告缺字段：${miss.join(' ')}（会被退回补齐）\n`)
  return 0
}

function cmdList(o) {
  let all = readMissions()
  if (o.status) all = all.filter((m) => m.status === o.status)
  if (o.fileQuery) {
    const needle = o.fileQuery.replace(/\\/g, '/').toLowerCase()
    all = all.filter((m) => (m.files ?? []).some((f) => f.replace(/\\/g, '/').toLowerCase().includes(needle)))
  }
  all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const lim = Number.isFinite(o.limit) ? o.limit : (o.fileQuery ? 50 : 20)
  const rows = all.slice(0, lim)
  if (o.json) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return 0 }
  process.stdout.write(`使命库共 ${all.length} 条${o.status ? `（status=${o.status}）` : ''}，列 ${rows.length} 条：\n\n`)
  for (const m of rows) {
    const t = m.updatedAt ? new Date(m.updatedAt).toISOString().slice(0, 10) : '----------'
    process.stdout.write(`  ${t}  ${String(m.status ?? '?').padEnd(10)} ${String(m.name ?? '?').padEnd(42)} ${m.id}\n`)
    if (o.fileQuery) process.stdout.write(`        files: ${(m.files ?? []).join(', ')}\n`)
  }
  return 0
}

function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.help || !o.cmd) { process.stdout.write(HELP); return o.cmd ? 0 : 1 }
  switch (o.cmd) {
    case 'declare': return cmdDeclare(o)
    case 'complete': return cmdComplete(o)
    case 'list': return cmdList(o)
    default: die(`未知子命令 ${o.cmd}（可用：declare / complete / list）`)
  }
}

try {
  process.exit(main())
} catch (err) {
  process.stderr.write(`mission.mjs FATAL: ${err?.message ?? err}\n`)
  process.exit(1)
}
