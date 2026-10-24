/**
 * dsh-domain-bridge — 交接卡（「换届交接瘦身」的宿主侧那一半）。
 *
 * 为什么有它（实测，不是猜）：
 *   · 换届首轮的慢与贵**全在步数**上——94~100% 的时间是模型时延（每步 8~9 秒），每一步固定
 *     30~40k token 是工具 schema 的钱；而首条 prompt 其实只有 549 字符。
 *   · 同样的交接，**有「开局只读、先别改文件」禁令的两次首轮只有 3 / 11 步**，没有禁令的那次
 *     66 步 / 585 秒 / cacheRead 6.5M。接任者一上来读 PROJECT.md（27KB）、changelog（156KB）、
 *     handoff.json（40KB，而且会过时），步数就被"读 + 消化"撑大了。
 *   · 所以：把禁令写进**固定模板**，并且让它**只读一张小卡**（≤2KB）。
 *
 * 这张卡只做三件事：说清"你是谁/接谁的行"，给 §当前状态 与 §下一步 各**最前 3 条**，再把
 * 四条第一轮硬规则钉在末尾。别的一律不搬。
 *
 * 落盘纪律（**只写这里**，不碰 `_registry`、不碰域名册、不碰 projectlog）：
 *   `<stateDir>/handoff/<flat-key>.md`   人/模型读的那一份（字节预算 ≤2048）
 *   `<stateDir>/handoff/<flat-key>.json` 同一份事实的机器读版本（给回执/排障用）
 *   `stateDir` 走与其余状态文件同一个口径（`shared.js` 的 `stateRoot()`）。
 *
 * 失败一律**不抛**：调用方（`/handoff`、`create_domain_session`）拿到 `{ok:false, reason}`
 * 就退回老文案，并把这个 reason 如实写进回执。
 */
import fs from 'node:fs'
import path from 'node:path'

import { stateRoot } from './shared.js'

/** 整卡字节预算（按 UTF-8 字节算：中文 1 字≈3 字节）。 */
export const HANDOFF_CARD_MAX_BYTES = 2048
/** 机器读那份的自描述标签。 */
export const HANDOFF_CARD_SCHEMA = 'dsh-domain-bridge/handoff-card@1'

/** 每条摘要的字符上限（先按字符截，最后再按整卡字节预算往下压）。 */
const MAX_ITEM_CHARS = 90
/** 压到底线：再短就没有信息量了，剩下的交给"整卡硬截断"兜底。 */
const MIN_ITEM_CHARS = 24
const ITEM_SHRINK_STEP = 5
/** 只认这两个二级标题（与 PROJECT.md 的既有写法一致，不改别人的文档格式）。 */
const STATUS_HEADING = '## 当前状态'
const NEXT_HEADING = '## 下一步'

/**
 * 四条第一轮硬规则。这四条**就是**瘦身的全部机制：实测有禁令的首轮 3~11 步，没禁令的 66 步。
 * 它们同时出现在这里（卡上）与短模板（开工任务）里——两处都看得见，不靠记性。
 */
export const HANDOFF_CARD_RULES = [
  '第一轮只核身份 + 读本卡 + 回报，**不改任何文件、不开工**',
  '不要读整份 PROJECT.md / changelog / INDEX.md / handoff.json / projectlog（需要哪段再定向读）',
  '回报三行：我核到的身份 / 本卡里的下一步 / 需要人拍板的点',
  '本卡超过 24 小时就先问人，不要直接按它开工',
]

const LAYER_WORDS = { system: '体系主会话', project: '项目主会话' }

/** `domain` / `project` / `system` → 中文层名（与 commands.js 的老文案保持同一套词）。 */
export function layerWordOf(layer) {
  const value = String(layer ?? '').trim().toLowerCase()
  return LAYER_WORDS[value] || '域会话'
}

function messageOf(error) {
  if (!error) return 'unknown-error'
  if (typeof error === 'string') return error
  return String(error.message || error.code || error)
}

function byteLengthOf(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/** 按**字符**截断（用于摘要条目）：超了就用一个省略号收口。 */
function clipChars(text, maxChars) {
  const chars = [...String(text ?? '')]
  if (chars.length <= maxChars) return chars.join('')
  return chars.slice(0, Math.max(1, maxChars - 1)).join('') + '…'
}

/** 按**字节**截断（最后一道兜底）：逐码点累加，绝不在多字节字符中间切。 */
function truncateToBytes(text, maxBytes) {
  const value = String(text ?? '')
  if (byteLengthOf(value) <= maxBytes) return value
  let out = ''
  let used = 0
  for (const ch of value) {
    const size = byteLengthOf(ch)
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return out
}

/** 去掉列表符号/加粗/行内代码/链接，压成一行——卡上要的是事实，不是原文档的排版。 */
function stripMarkdown(line) {
  return String(line ?? '')
    .replace(/^(?:-|\d+\.)\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取某个二级标题下的正文行（遇到下一个 `#`/`##`/`###` 就停）。 */
function sectionLines(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim().startsWith(heading))
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^#{1,3}\s/.test(line)) break
    out.push(line)
  }
  return out
}

/** **顶层**条目：`- ` 或 `N. ` 开头，且不是缩进子项（子项属于上一条的细节，卡上不搬）。 */
function topLevelItems(lines) {
  return lines.filter((line) => /^(?:-|\d+\.)\s+/.test(line) && !/^\s{2,}/.test(line))
}

/**
 * 解析 PROJECT.md 的两个小节：§当前状态 与 §下一步 各取最前 3 条顶层条目。
 * 结构变了（没有这两个标题 / 标题变了 / 条目写法变了）**不抛**——只是拿不到条目，
 * 由 `sectionsMissing` 如实报出来，卡仍可用（身份 + 规则还在）。
 */
export function parseProjectMarkdown(text) {
  const status = topLevelItems(sectionLines(text, STATUS_HEADING))
    .slice(0, 3)
    .map(stripMarkdown)
    .filter(Boolean)
  const next = topLevelItems(sectionLines(text, NEXT_HEADING))
    .slice(0, 3)
    .map(stripMarkdown)
    .filter(Boolean)
  const sectionsMissing = [...(status.length ? [] : ['当前状态']), ...(next.length ? [] : ['下一步'])]
  return { status, next, sectionsMissing }
}

/**
 * `项目:域` → 一个安全的文件名主干。只把 `:` 换成 `-`（Windows 文件名禁用冒号），
 * 顺手挡掉路径穿越与文件名里的非法字符；其余字符（含中文）原样保留。
 */
export function flatKeyOf(key) {
  const raw = String(key ?? '').trim() || 'unknown'
  const flat = raw
    .replace(/[:\\/]+/g, '-')
    .replace(/\.{2,}/g, '_')
    .replace(/[\u0000-\u001f<>|"?*]+/g, '_')
    .replace(/^[.\s-]+/, '')
    .slice(0, 80)
  return flat || 'handoff'
}

/** 卡的两个落盘路径（`stateDir` 与其余状态文件同一口径；拿不到 stateDir 时返回空串）。 */
export function handoffCardPaths(stateDir, key) {
  const base = stateRoot(stateDir)
  const dir = base ? path.join(base, 'handoff') : ''
  const flatKey = flatKeyOf(key)
  return {
    dir,
    flatKey,
    md: dir ? path.join(dir, `${flatKey}.md`) : '',
    json: dir ? path.join(dir, `${flatKey}.json`) : '',
  }
}

/** 渲染整张卡（`cap` = 每条摘要的字符上限，字节预算压不动时会一轮轮往下调）。 */
function renderCard({ key, layer, previousSessionId, cwd, generatedAt, status, next, cap }) {
  const line = (value) => `- ${clipChars(value, cap)}`
  return (
    [
      `# 交接卡 · ${key}`,
      '',
      `- 生成时间：${generatedAt}`,
      `- 在任键：${key}`,
      `- 层：${layerWordOf(layer)}`,
      `- 上一任：${previousSessionId || '（未知）'}`,
      `- 工作目录：${cwd || '（未知）'}`,
      '',
      '## 现状（PROJECT.md §当前状态 最前 3 条，已截断）',
      ...(status.length ? status.map(line) : ['- （PROJECT.md 里没有这一节，或这一节没有顶层条目）']),
      '',
      '## 下一步（§下一步 最前 3 条，已截断）',
      ...(next.length ? next.map(line) : ['- （PROJECT.md 里没有这一节，或这一节没有顶层条目）']),
      '',
      '## 第一轮硬规则',
      ...HANDOFF_CARD_RULES.map((rule, index) => `${index + 1}. ${rule}`),
      '',
    ].join('\n')
  )
}

/** 按整卡字节预算逐轮压摘要（先 90 字，压到 24 字；还不够就硬截断兜底）。 */
function renderWithinBudget(facts) {
  let cap = MAX_ITEM_CHARS
  let markdown = renderCard({ ...facts, cap })
  while (byteLengthOf(markdown) > HANDOFF_CARD_MAX_BYTES && cap > MIN_ITEM_CHARS) {
    cap = Math.max(MIN_ITEM_CHARS, cap - ITEM_SHRINK_STEP)
    markdown = renderCard({ ...facts, cap })
  }
  const hardTrimmed = byteLengthOf(markdown) > HANDOFF_CARD_MAX_BYTES
  if (hardTrimmed) markdown = truncateToBytes(markdown, HANDOFF_CARD_MAX_BYTES)
  return { markdown, itemChars: cap, truncated: hardTrimmed }
}

/** 落盘（md + json）。`write:false` = 只算不写（dryRun 那种"绝不产生副作用"的演练）。 */
function writeCard({ stateDir, key, markdown, card, write }) {
  const paths = handoffCardPaths(stateDir, key)
  const bytes = byteLengthOf(markdown)
  const jsonText = JSON.stringify(card, null, 2) + '\n'
  const base = { markdown, json: jsonText, path: paths.md, jsonPath: paths.json, bytes }
  if (write === false) return { ok: true, written: false, ...base }
  if (!paths.dir) return { ok: false, reason: 'state-dir-unknown', ...base }
  try {
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(paths.md, markdown, 'utf8')
    fs.writeFileSync(paths.json, jsonText, 'utf8')
    return { ok: true, written: true, ...base }
  } catch (error) {
    return { ok: false, reason: 'card-write-failed', error: messageOf(error), ...base }
  }
}

/**
 * 从 `PROJECT.md` 生成交接卡并落盘。
 *
 * @param {object} input
 * @param {string} input.cwd            接任者的工作目录（`projectFile` 缺省时从这里找 PROJECT.md）
 * @param {string} [input.projectFile]  显式指定 PROJECT.md 路径
 * @param {string} input.key            在任键（`项目:域` / `项目:system` / `项目:main`）
 * @param {string} input.layer          domain / project / system
 * @param {string} [input.previousSessionId] 上一任会话 id（写卡上，也是回报目标）
 * @param {string} [input.stateDir]     状态目录（缺省走 `stateRoot()` 的口径）
 * @param {number|Date} [input.now]     生成时间（测试可注入，默认 now）
 * @param {boolean} [input.write]       false = 只算不写（dryRun）
 * @returns {{ok:boolean, reason?:string, markdown?:string, json?:string, path?:string|null, bytes?:number}}
 */
export function buildHandoffCard({
  cwd,
  projectFile,
  key,
  layer,
  previousSessionId,
  stateDir,
  now,
  write,
} = {}) {
  const workdir = String(cwd ?? '').trim()
  const file =
    projectFile && String(projectFile).trim()
      ? String(projectFile).trim()
      : workdir
        ? path.join(workdir, 'PROJECT.md')
        : ''
  if (!file) {
    return { ok: false, reason: 'cwd-unknown', projectFile: null, markdown: '', bytes: 0, path: null, jsonPath: null }
  }

  let text = null
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = error && error.code ? String(error.code) : ''
    return {
      ok: false,
      reason: code === 'ENOENT' ? 'project-file-missing' : 'project-file-unreadable',
      ...(code === 'ENOENT' ? {} : { error: messageOf(error) }),
      projectFile: file,
      markdown: '',
      bytes: 0,
      path: null,
      jsonPath: null,
    }
  }

  const parsed = parseProjectMarkdown(text)
  const generatedAt = new Date(now === undefined ? Date.now() : now).toISOString()
  const resolvedKey = String(key ?? '').trim() || 'unknown'
  const rendered = renderWithinBudget({
    key: resolvedKey,
    layer,
    previousSessionId: previousSessionId ? String(previousSessionId) : '',
    cwd: workdir,
    generatedAt,
    status: parsed.status,
    next: parsed.next,
  })

  const card = {
    schema: HANDOFF_CARD_SCHEMA,
    source: 'project-md',
    generatedAt,
    key: resolvedKey,
    layer: String(layer ?? '').trim() || 'domain',
    layerWord: layerWordOf(layer),
    previousSessionId: previousSessionId ? String(previousSessionId) : null,
    cwd: workdir || null,
    projectFile: file,
    status: parsed.status,
    next: parsed.next,
    rules: HANDOFF_CARD_RULES,
    sectionsMissing: parsed.sectionsMissing,
    itemChars: rendered.itemChars,
    truncated: rendered.truncated,
    bytes: byteLengthOf(rendered.markdown),
  }

  const written = writeCard({ stateDir, key: resolvedKey, markdown: rendered.markdown, card, write })
  return { ...written, status: parsed.status, next: parsed.next, sectionsMissing: parsed.sectionsMissing }
}

/**
 * 用调用方给的 `brief` 当卡内容（`create_domain_session` 的 `brief` 参数走这条路）。
 * 给字符串就原样用；给对象就 JSON 化。超过字节预算就**按字节截断**（绝不在多字节字符中间切）。
 */
export function cardFromBrief({
  brief,
  cwd,
  projectFile,
  key,
  layer,
  previousSessionId,
  stateDir,
  now,
  write,
} = {}) {
  const raw =
    typeof brief === 'string'
      ? brief.trim()
      : brief === undefined || brief === null
        ? ''
        : JSON.stringify(brief, null, 2)
  if (!raw || !raw.trim()) {
    return { ok: false, reason: 'brief-empty', markdown: '', bytes: 0, path: null, jsonPath: null }
  }

  const generatedAt = new Date(now === undefined ? Date.now() : now).toISOString()
  const resolvedKey = String(key ?? '').trim() || 'unknown'
  const workdir = String(cwd ?? '').trim()
  const file =
    projectFile && String(projectFile).trim()
      ? String(projectFile).trim()
      : workdir
        ? path.join(workdir, 'PROJECT.md')
        : ''
  const full = String(raw)
  const truncated = byteLengthOf(full) > HANDOFF_CARD_MAX_BYTES
  const markdown = truncated ? truncateToBytes(full, HANDOFF_CARD_MAX_BYTES) : full
  const card = {
    schema: HANDOFF_CARD_SCHEMA,
    source: 'brief',
    generatedAt,
    key: resolvedKey,
    layer: String(layer ?? '').trim() || 'domain',
    layerWord: layerWordOf(layer),
    previousSessionId: previousSessionId ? String(previousSessionId) : null,
    cwd: workdir || null,
    projectFile: file || null,
    rules: HANDOFF_CARD_RULES,
    truncated,
    bytes: byteLengthOf(markdown),
    markdown,
  }
  return writeCard({ stateDir, key: resolvedKey, markdown, card, write })
}

/** 老文案（没有卡的时候用）：读 PROJECT.md §当前状态/§下一步，别去找不存在的体系交接包。 */
function legacyHandoffTaskText({ layer, key, cwd }) {
  const hasPack = Boolean(cwd) && fs.existsSync(path.join(String(cwd), '_registry', 'handoff.json'))
  const readLine = hasPack
    ? '先读 `_registry\\handoff.json`（体系交接包）与 `PROJECT.md` §当前状态，再按 §下一步 开工。'
    : '先读 `PROJECT.md` §当前状态 与 §下一步 开工（这个目录**没有**体系交接包 `_registry\\handoff.json`，不用去找）。'
  return (
    `（换届接任）你接手 **${key}**（${layerWordOf(layer)}）。` +
    readLine +
    '本会话的 preset／权限档／模型已在建会话时设置好，不需要你再配；' +
    '交接**没有**写任何交接文件——在任身份只在注册册（registrations）里，裸跑 `/register` 可核对。'
  )
}

/**
 * 接任者的第一轮开工任务文本（**固定短模板**：文案本身 215 字，远低于「≤300 字」的口径；
 * 实例化后多出来的长度全是卡路径与会话 id 这两个必须给全的标识符）。
 *
 * 有卡：只说四件事——核身份 / 只读这张卡（并点名不要读那几份大文件）/ 回报三行 / 本轮不改文件。
 * 没卡：退回老文案，并在**开头**如实写卡为什么没生成（不藏事）。
 */
export function handoffTaskText({ layer, key, cwd, cardPath, previousSessionId, cardError } = {}) {
  const resolvedKey = String(key ?? '').trim() || '（未知键）'
  const target = String(previousSessionId ?? '').trim() || '（上一任会话 id）'
  if (!cardPath) {
    return (
      `（交接卡生成失败：${cardError || 'unknown-reason'}，请只读 PROJECT.md 的 §当前状态/§下一步 各前 3 条）\n` +
      legacyHandoffTaskText({ layer, key: resolvedKey, cwd })
    )
  }
  return (
    `你接手了 ${resolvedKey}（${layerWordOf(layer)}）。本轮只做四件事：` +
    '① 裸跑 `/register` 核对在任身份；' +
    `② **只读这张交接卡**：${cardPath}（不要读整份 PROJECT.md/changelog/INDEX.md/handoff.json/projectlog）；` +
    `③ 用 \`send_to_domain target=${target}\` 回报三行：我核到的身份/卡里的下一步/需要人拍板的点；` +
    '④ **本轮不改任何文件、不开工**，等指示后再动。'
  )
}
