#!/usr/bin/env node
/**
 * proposal-index.mjs —— 提案总索引生成器（2026-10-01 加）
 *
 * 解决的实际问题（有实测数字）：
 *   提案共 **28 份 / 散在 12+ 个目录**；体系侧 7 份**全部"未决策"**（只进不出，没有"结案"环节）。
 *   目前**没有任何单一入口**能看到全局状态——而这正是 Obsidian 图谱的前提（一个库一个图、跨库不可见）。
 *
 * 本脚本**不改任何一个提案文件**，只读 + 生成一张表：
 *   - 扫描所有 `<项目>\提案\`（含体系根 `提案\`、study 各学科）与统一库 `各项目提案\`
 *   - 自动识别 **worktree 副本**（同名 + 同字节数 → 标 dup）
 *   - 从正文头部的 `> 状态：...` 与文件名提取**状态**和**日期**
 *   - 产出：`各项目提案\提案总索引.md`（人看/Obsidian）+ 同名 `.json`（机器读）
 *
 * 为什么先不做"物理搬迁"：实测搬迁会打断 **59 处体系侧引用 + 8 处项目本体 + 9 处历史叙述**，
 *   其中 projectlog 属"不该改的历史"、worktree 副本体系侧改不到（要各项目主会话同步）。
 *   → 先用**零风险的总索引**拿到"全局可见"这个主要收益；搬迁另案、需要任务卡配合。
 *
 * 用法
 *   node {体系根}\tools\proposal-index.mjs            # 生成（写进各项目提案\）
 *   node {体系根}\tools\proposal-index.mjs --dry-run  # 只打印
 *   node {体系根}\tools\proposal-index.mjs --json     # 只输出 json
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:\\xiangmu'
const UNIFIED = path.join(ROOT, '各项目提案')
const OUT_MD = path.join(UNIFIED, '提案总索引.md')
const OUT_JSON = path.join(UNIFIED, '提案总索引.json')
const SIGNATURE = '# 提案总索引'
const TOOL_VERSION = '1.0.0'

const HELP = `proposal-index.mjs v${TOOL_VERSION}

  （无参数）      生成 各项目提案\\提案总索引.md + .json
  --dry-run       只打印，不落盘
  --json          只输出 json
  --root <路径>   覆盖项目根，默认 ${ROOT}
`

function parseArgs(argv) {
  const o = { root: ROOT }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dry = true
    else if (a === '--json') o.jsonOnly = true
    else if (a === '--root') o.root = argv[++i]
    else if (a === '-h' || a === '--help') o.help = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return o
}

/** 找一个项目的"提案目录"：`<根>\提案`、各子项目 `<项目>\提案`、`study\<学科>\提案`，以及统一库 `各项目提案` */
function findProposalDirs(root) {
  const dirs = []
  if (!fs.existsSync(root)) return dirs
  // ⚠️ 根自己那份 `{体系根}\提案\`（体系侧提案）不在任何子目录下——漏了它就会少扫 7 份（2026-10-01 实测踩到）
  const rootProp = path.join(root, '提案')
  if (fs.existsSync(rootProp) && fs.statSync(rootProp).isDirectory()) dirs.push({ project: '体系根', dir: rootProp })
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name)
    if (!fs.statSync(p).isDirectory()) continue
    const prop = path.join(p, '提案')
    if (fs.existsSync(prop) && fs.statSync(prop).isDirectory()) dirs.push({ project: name, dir: prop })
    // study\<学科>\提案
    if (name === 'study') {
      for (const sub of fs.readdirSync(p)) {
        const sp = path.join(p, sub)
        try { if (!fs.statSync(sp).isDirectory()) continue } catch { continue }
        const spp = path.join(sp, '提案')
        if (fs.existsSync(spp) && fs.statSync(spp).isDirectory()) dirs.push({ project: `study/${sub}`, dir: spp })
      }
    }
  }
  const unified = path.join(root, '各项目提案')
  if (fs.existsSync(unified)) dirs.push({ project: '(统一库)', dir: unified })
  return dirs
}

/** 从正文提取状态行；取不到就按文件名/正文关键词猜，并标注来源 */
function readStatus(text, file) {
  const m = text.match(/^>\s*状态[：:]\s*(.+)$/m)
  if (m) {
    const raw = m[1].trim()
    const s = raw.replace(/[*`]/g, '')
    if (/决策[：:]\s*实施/.test(s)) return { status: '决策:实施', src: 'header' }
    if (/决策[：:]\s*放弃/.test(s)) return { status: '决策:放弃', src: 'header' }
    if (/实施中/.test(s)) return { status: '实施中', src: 'header' }
    if (/已完成/.test(s)) return { status: '已完成', src: 'header' }
    if (/未决策/.test(s)) return { status: '未决策', src: 'header' }
    return { status: s.slice(0, 24), src: 'header' }
  }
  if (/状态：\s*决策/.test(text)) return { status: '决策', src: 'body' }
  return { status: '(无状态行)', src: 'none' }
}

function readDate(name, text) {
  const f = name.match(/(20\d{2}-\d{2}-\d{2})/)
  if (f) return f[1]
  const b = text.match(/(20\d{2}-\d{2}-\d{2})/)
  return b ? b[1] : ''
}

function readTitle(text, name) {
  const m = text.match(/^#\s+(.+)$/m)
  return m ? m[1].replace(/^提案\s*/, '').trim() : name.replace(/\.md$/, '')
}

/** 主体：抽"证伪闸门"状态（体系提案特有） */
function readGate(text) {
  const m = text.match(/证伪闸门[：:]\s*([✅⏳❌])/)
  return m ? m[1] : ''
}

function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.help) { process.stdout.write(HELP); return 0 }

  const dirs = findProposalDirs(o.root)
  const items = []
  for (const { project, dir } of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      if (f.startsWith('提案总索引')) continue // 别把自己算进去
      const full = path.join(dir, f)
      const st = fs.statSync(full)
      let text = ''
      try { text = fs.readFileSync(full, 'utf8') } catch { continue }
      const { status, src } = readStatus(text, f)
      items.push({
        project,
        file: f,
        abs: full,
        bytes: st.size,
        mtime: st.mtime.toISOString().slice(0, 10),
        date: readDate(f, text),
        status,
        statusSrc: src,
        gate: readGate(text),
        title: readTitle(text, f),
      })
    }
  }
  // worktree 副本：同名 + 同字节数 → 标 dup（保留一份主、其余记 dupOf）
  const byName = new Map()
  for (const it of items) {
    if (!byName.has(it.file)) byName.set(it.file, [])
    byName.get(it.file).push(it)
  }
  for (const [file, group] of byName) {
    if (group.length < 2) continue
    const same = group.every((g) => g.bytes === group[0].bytes)
    group.sort((a, b) => (a.project.includes('zcode') ? 1 : 0) - (b.project.includes('zcode') ? 1 : 0))
    group[0].dupRole = 'main'
    for (const g of group.slice(1)) {
      g.dupRole = same ? 'dup-exact' : 'dup-differs'
      g.dupOf = group[0].project
      if (!same) g.note = `字节数不同（${group[0].bytes} vs ${g.bytes}）——**不是纯副本，迁移前需比对**`
    }
  }
  items.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.file.localeCompare(b.file))

  const uniq = items.filter((i) => i.dupRole !== 'dup-exact')
  const dupExact = items.filter((i) => i.dupRole === 'dup-exact')
  const undecided = items.filter((i) => i.status.includes('未决策') && i.dupRole !== 'dup-exact')
  const diffs = items.filter((i) => i.dupRole === 'dup-differs')

  const lines = []
  lines.push(SIGNATURE)
  lines.push('')
  lines.push(`> 生成于 ${new Date().toLocaleString('sv-SE').replace('T', ' ')}（本机时区）｜工具 \`D:\\xiangmu\\tools\\proposal-index.mjs\` v${TOOL_VERSION}`)
  lines.push(`> **扫到 ${items.length} 份文件**：唯一提案 **${uniq.length - diffs.length}** 份；worktree **字节完全相同**的副本 **${dupExact.length}** 份（下表不列为独立行）；**同名但内容不同**的 **${diffs.length}** 份（下表保留并标 ⚠️）`)
  lines.push(`> **未决策 ${undecided.length} 份** —— 这就是"只进不出"的规模`)
  lines.push(`> ⚠️ 那 ${diffs.length} 份"同名内容不同"是**真分叉**（worktree 与主工作区各改各的），迁移前要逐对比对，**别当成重复删掉**。`)
  lines.push('> 状态取自各提案头部的 `> 状态：…` 行；取不到标 `(无状态行)`。**本文件由脚本生成，手改会被覆盖。**')
  lines.push('')
  lines.push('## 全部提案')
  lines.push('')
  lines.push('| 日期 | 项目 | 提案 | 状态 | 闸门 | 大小 | 备注 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const it of items) {
    const mark = it.dupRole === 'dup-exact' ? `↩ 副本于 ${it.dupOf}` : (it.dupRole === 'dup-differs' ? `⚠️ 副本但内容不同（${it.dupOf}）` : '')
    lines.push(`| ${it.date || it.mtime} | ${it.project} | ${it.title.replace(/\|/g, '\\|')} | ${it.status} | ${it.gate} | ${(it.bytes / 1024).toFixed(1)}KB | ${mark} |`)
  }
  lines.push('')
  lines.push('## 未决策清单（就是这张表在回答"哪些还躺着"）')
  lines.push('')
  if (!undecided.length) lines.push('_（无）_')
  for (const it of undecided) lines.push(`- ${it.date || it.mtime}｜${it.project}｜**${it.title}**`)
  lines.push('')
  const md = lines.join('\n')
  const json = JSON.stringify({
    tool: 'proposal-index', version: TOOL_VERSION, generatedAt: new Date().toISOString(),
    counts: { total: items.length, unique: uniq.length, dupExact: items.length - uniq.length - diffs.length, dupDiffers: diffs.length, undecided: undecided.length },
    items,
  }, null, 2)

  if (o.jsonOnly) { process.stdout.write(json + '\n'); return 0 }
  if (o.dry) { process.stdout.write(md + '\n'); return 0 }

  if (!fs.existsSync(UNIFIED)) fs.mkdirSync(UNIFIED, { recursive: true })
  if (fs.existsSync(OUT_MD)) {
    const head = fs.readFileSync(OUT_MD, 'utf8').slice(0, 200)
    if (!head.includes(SIGNATURE)) {
      process.stderr.write(`REFUSED: ${OUT_MD} 已存在但不带本工具签名，不覆盖。\n`)
      return 1
    }
  }
  fs.writeFileSync(OUT_MD, md + '\n', 'utf8')
  fs.writeFileSync(OUT_JSON, json + '\n', 'utf8')
  process.stdout.write(JSON.stringify({
    tool: 'proposal-index', version: TOOL_VERSION,
    written: [OUT_MD, OUT_JSON],
    counts: { total: items.length, unique: uniq.length, dupDiffers: diffs.length, undecided: undecided.length },
  }, null, 2) + '\n')
  return 0
}

try {
  process.exit(main())
} catch (err) {
  process.stderr.write(`proposal-index.mjs FATAL: ${err?.message ?? err}\n`)
  process.exit(1)
}
