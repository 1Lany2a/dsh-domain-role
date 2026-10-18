/**
 * dsh-domain-bridge — the declaration book (domains.json): claim / release / list and target resolution.
 *
 * Split out of the single-file lib/bridge.js in v0.6.3 (pure move: no behaviour change).
 * The package entry point stays lib/bridge.js, which re-exports this module.
 */

import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN, VERSION, TRACE_ID, TRACE_ID_V040, SCOPE_DOMAIN, STATE_TERMINATED, loadIndex, emptyIndex, shortId, describe, liveTopLevel, dutyMap, isSessionOnline, ownerCliRef, messageOf } from './shared.js'
import { warn, tool } from './tools.js'
import { INBOX_DELIVERED, loadInbox, loadInboxes, domainEnvelope, domainMessage, deliverToAgent } from './messaging.js'
import { loadDomainStates, writeDomainStateAtomic, domainSnapshot, pausedScopesOf, pausedByScopesOf, pausedScopesWords, pausedWhoWords, domainStateSection, sessionPauseFields, pauseCandidatesForDomain, pauseCandidatesGlobal, pauseHitsOfDisk, pausedNoticeOf } from './pause.js'
import { clipToBytes, liveAgentOf, markRetired } from './session-factory.js'

export function loadDeclarations(file) {
  const base = {
    file,
    fileExisted: false,
    updatedAt: null,
    entries: [],
    byKey: new Map(),
    byDomain: new Map(),
    error: null,
  }
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return base
    return { ...base, error: error?.message || String(error) }
  }
  try {
    const json = JSON.parse(raw)
    const ownersRaw =
      json && typeof json.owners === 'object' && json.owners && !Array.isArray(json.owners) ? json.owners : {}
    const byKey = new Map()
    const byDomain = new Map()
    const entries = []
    for (const key of Object.keys(ownersRaw).sort()) {
      const record = ownersRaw[key] && typeof ownersRaw[key] === 'object' ? ownersRaw[key] : {}
      // Spread first: unknown fields are never dropped on the read path.
      const entry = { key, ...record }
      entries.push(entry)
      byKey.set(String(key).toLowerCase(), entry)
      const shortDomain = String(
        entry.domain !== undefined && entry.domain !== null && entry.domain !== ''
          ? entry.domain
          : String(key).split(':').slice(1).join(':'),
      ).toLowerCase()
      if (shortDomain) {
        const list = byDomain.get(shortDomain) || []
        list.push(entry)
        byDomain.set(shortDomain, list)
      }
    }
    return { file, fileExisted: true, updatedAt: json?.updatedAt ?? null, entries, byKey, byDomain, error: null }
  } catch (error) {
    return { ...base, fileExisted: true, error: error?.message || String(error) }
  }
}

/** sessionId -> every declaration entry that session holds (sorted by key). */
export function declarationInfo(entry, declarations) {
  return {
    key: entry.key,
    project: entry.project ?? null,
    domain: entry.domain ?? null,
    sessionId: entry.sessionId ?? null,
    since: entry.since ?? null,
    by: entry.by ?? null,
    note: entry.note ?? null,
    updatedAt: declarations?.updatedAt ?? null,
  }
}

// --- write path: byte-for-byte the same semantics as domain-owner.mjs (see `ownerCli`) ---

export function seedDeclarations() {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), owners: {} }
}

export function normalizeDeclarations(data) {
  const out = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  if (out.schemaVersion === undefined) out.schemaVersion = 1
  if (!out.updatedAt) out.updatedAt = new Date().toISOString()
  if (!out.owners || typeof out.owners !== 'object' || Array.isArray(out.owners)) out.owners = {}
  return out
}

/**
 * Read for writing. A missing file seeds an empty book (normal state); a file that exists but
 * cannot be parsed ABORTS the write - never overwrite other people's declarations blindly.
 */
export function readDeclarationsForWrite(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { data: seedDeclarations(), fileExisted: false, parseError: null }
    }
    return { data: null, fileExisted: true, parseError: error?.message || String(error) }
  }
  try {
    return { data: normalizeDeclarations(JSON.parse(raw)), fileExisted: true, parseError: null }
  } catch (error) {
    return { data: null, fileExisted: true, parseError: error?.message || String(error) }
  }
}

/**
 * Read-modify-write with atomic replace, exactly like the CLI: write "<file>.tmp" first, then
 * rename over the original. The original file is never deleted first, and a failed write
 * cleans up its own temp file without masking the original error.
 */
export function writeDeclarationsAtomic(file, data) {
  data.updatedAt = new Date().toISOString()
  const body = JSON.stringify(data, null, 2) + '\n'
  const tmp = file + '.tmp'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error
  }
  return { bytes: Buffer.byteLength(body, 'utf8') }
}

// ------------------------------- portable runtime home (home / config.json / env / defaults)

/** Trimmed string or '' - never throws, never coerces a non-string into a path. */
export function checkName(value, label) {
  if (!value) return label + '不能为空。'
  if (value.includes(':')) return label + '里不能包含英文冒号（冒号是「项目:域」的分隔符）。'
  if (value.includes('/') || value.includes('\\')) return label + '里不能包含斜杠。'
  return null
}

/**
 * Split "asr" / "misas:asr" into { project, domain, key }.
 * A bare domain borrows `projectArg`; when that is missing too, the caller must infer it.
 */
export function splitDomainTarget(rawDomain, projectArg) {
  const raw = String(rawDomain ?? '').trim()
  if (!raw) return { error: '域不能为空。' }
  const colon = raw.indexOf(':')
  if (colon !== -1) {
    const project = raw.slice(0, colon).trim()
    const domain = raw.slice(colon + 1).trim()
    const problems = [checkName(project, '项目'), checkName(domain, '域')].filter(Boolean)
    if (problems.length) return { error: problems.join('；') }
    return {
      project,
      domain,
      key: project + ':' + domain,
      projectArgIgnored: Boolean(String(projectArg ?? '').trim()),
    }
  }
  const domain = raw
  const project = String(projectArg ?? '').trim()
  // Filter BEFORE the length check: an unfiltered `null` from checkName would produce
  // `{ error: '' }` - a falsy error the callers would happily ignore.
  const problems = [checkName(domain, '域'), project ? checkName(project, '项目') : null].filter(Boolean)
  if (problems.length) return { error: problems.join('；') }
  if (!project) return { project: null, domain, key: null }
  return { project, domain, key: project + ':' + domain }
}

/**
 * Keep it simple: the project short name is the lower-cased basename of this session's cwd.
 * No clever inference (no archive digging here - that stays the CLI's job).
 */
export function projectFromCwd(cwd) {
  try {
    const base = path.basename(String(cwd ?? '').trim())
    if (!base || base === '.' || base === path.sep) return null
    return base.toLowerCase()
  } catch {
    return null
  }
}

/**
 * `set_domain_state` / `withdraw_domain_message` 共用的**只读**域参数解析（不写、不猜）。
 *   ① 「项目:域」⇒ 原样用这个 key（册子里有没有交给调用方自己判）；
 *   ② 短名 ⇒ 域名册里**短名唯一**的那一条 ⇒ 用它（不用靠 cwd 推项目）；
 *   ③ 短名 + 多条同名 ⇒ `ambiguous`，列出来让调用者写「项目:域」，本工具不挑；
 *   ④ 短名 + 册子里没有 ⇒ 用本会话 cwd 推的项目拼一个 key（只为给出精确的「这个域没有在任声明」）。
 * 与 claim_domain 的区别：这里**永不写**、也永不把"推出来的项目"当成既有事实。
 */
export function resolveDomainKeyForState(declarations, rawDomain, selfCwd) {
  const split = splitDomainTarget(rawDomain, null)
  if (split.error) return { error: split.error, candidates: null }
  if (split.key) {
    return {
      key: split.key,
      domain: split.domain,
      project: split.project,
      projectFrom: '「项目:域」完整写法',
      candidates: null,
    }
  }
  const wanted = String(split.domain).toLowerCase()
  const hits = (declarations?.entries || []).filter((entry) => {
    const raw =
      entry.domain !== undefined && entry.domain !== null && entry.domain !== ''
        ? entry.domain
        : String(entry.key).split(':').slice(1).join(':')
    return String(raw).toLowerCase() === wanted
  })
  if (hits.length === 1) {
    return {
      key: hits[0].key,
      domain: hits[0].domain ?? split.domain,
      project: hits[0].project ?? null,
      projectFrom: '域名册里的唯一同名声明',
      candidates: null,
    }
  }
  if (hits.length > 1) {
    return {
      error: `同名域有 ${hits.length} 条在任声明，本工具不替你猜是哪一个：请用「项目:域」完整写法指定。`,
      candidates: hits.map((entry) => entry.key),
    }
  }
  const project = projectFromCwd(selfCwd)
  if (!project) {
    return {
      error: '域是短名，域名册里也没有同名声明，又推不出项目名（本会话 cwd 拿不到）⇒ 请用「项目:域」完整写法。',
      candidates: null,
    }
  }
  return {
    key: project + ':' + split.domain,
    domain: split.domain,
    project,
    projectFrom: '本会话 cwd 的目录名（小写）',
    candidates: null,
  }
}

// --------------------------------------------------------------- target resolution

/** Which on-duty declaration, if any, does this target address? Never guesses between several. */
export function matchDeclaration(declarations, rawTarget, domainPart) {
  const source = declarations || { byKey: new Map(), byDomain: new Map(), entries: [] }
  if (rawTarget.includes(':')) {
    const hit = source.byKey.get(rawTarget.toLowerCase())
    return hit ? { status: 'declared', entry: hit } : { status: 'none' }
  }
  const list = source.byDomain.get(String(domainPart ?? '').toLowerCase()) || []
  if (list.length === 1) return { status: 'declared', entry: list[0] }
  if (list.length > 1) return { status: 'ambiguous', entries: list }
  return { status: 'none' }
}

/** Does this live session carry an index label equal to the addressed domain? */
export function labelMatches(row, domainPart, rawTarget) {
  const labels = (row?.info?.domains || []).map((domain) => String(domain).toLowerCase())
  const a = String(domainPart ?? '').toLowerCase()
  const b = String(rawTarget ?? '').toLowerCase()
  return labels.some((label) => label === a || label === b)
}

/**
 * target 解析顺序（v0.2）：① 会话 id（行为与 v0.1 一致）② 在任声明（在线 ⇒ 投；离线 ⇒ 只回报）
 * ③ 无声明 ⇒ 退回索引标注 ④ 索引标注多在线 ⇒ 报警，不挑一个投。
 */
export function resolveTarget(rows, rawTarget, declarations, ctx, index) {
  const target = String(rawTarget ?? '').trim()
  if (!target) return { ok: false, reason: 'missing-target' }
  const needle = target.toLowerCase()
  const colon = target.indexOf(':')
  const domainPart = (colon === -1 ? target : target.slice(colon + 1)).trim()

  const byId = rows.filter((row) => {
    const id = (row.info.id || '').toLowerCase()
    const short = (row.info.shortId || '').toLowerCase()
    return (id && (id === needle || id.includes(needle))) || (short && short === needle)
  })
  if (byId.length === 1) return { ok: true, row: byId[0], matchedBy: 'session-id' }
  if (byId.length > 1) return { ok: false, reason: 'ambiguous-session-id', candidates: byId.map((r) => r.info) }

  const declared = matchDeclaration(declarations, target, domainPart)

  if (declared.status === 'ambiguous') {
    return {
      ok: false,
      reason: 'ambiguous-declarations',
      declarations: declared.entries.map((entry) => declarationInfo(entry, declarations)),
      candidates: rows.map((r) => r.info),
    }
  }

  if (declared.status === 'declared') {
    const owner = declared.entry
    const ownerId = owner.sessionId || null
    const ownerRow = ownerId ? rows.find((row) => row.info.id === ownerId) : null
    let ownerAgent = null
    if (!ownerRow && ownerId) {
      try {
        const getter = ctx?.agents?.get
        ownerAgent = typeof getter === 'function' ? getter.call(ctx.agents, ownerId) : null
      } catch {
        ownerAgent = null
      }
    }
    const info = declarationInfo(owner, declarations)

    if (ownerRow || ownerAgent) {
      const row = ownerRow || { agent: ownerAgent, info: describe(ownerAgent, index) }
      return { ok: true, row, matchedBy: 'declaration', declaration: info }
    }

    // Declared owner is offline: report, do not deliver, do not pick a stand-in.
    return {
      ok: false,
      reason: 'declared-owner-offline',
      declaredOwner: { sessionId: info.sessionId, key: info.key, note: info.note, since: info.since, updatedAt: info.updatedAt },
      otherOnlineWithIndexLabel: rows
        .filter((row) => labelMatches(row, domainPart, target))
        .map((row) => row.info),
      candidates: rows.map((r) => r.info),
    }
  }

  const byDomain = rows.filter((row) => labelMatches(row, domainPart, target))
  if (byDomain.length === 1) {
    return {
      ok: true,
      row: byDomain[0],
      matchedBy: 'index-label',
      hint: '该域无在任声明，本次按索引标注解析，建议补声明（claim_domain）。',
    }
  }
  if (byDomain.length > 1) {
    // 框架口径：同域多在线＝违规状态，发现就报警，不"挑一个投"。
    return { ok: false, reason: 'multiple-online-for-domain', candidates: byDomain.map((r) => r.info) }
  }

  return { ok: false, reason: 'unreachable', candidates: rows.map((r) => r.info) }
}

// --------------------------------------------------------------- outbound message (single builder)

/** Never let an exotic throwable break a tool result. */
export function declareNewOwner(file, { key, project, domain, ownerSessionId, note }) {
  const read = readDeclarationsForWrite(file)
  if (read.parseError) {
    return { outcome: 'aborted', reason: 'declarations-file-unreadable', error: read.parseError, file }
  }
  const data = read.data
  const existing = Object.prototype.hasOwnProperty.call(data.owners, key) ? data.owners[key] : null
  // Read-only report of who is sitting there, so a conflict reply can name the blocking owner.
  const holder = existing
    ? {
        key,
        sessionId: existing.sessionId ?? null,
        since: existing.since ?? null,
        by: existing.by ?? null,
        note: existing.note ?? null,
      }
    : null

  if (existing && existing.sessionId !== ownerSessionId) {
    return { outcome: 'conflict', conflict: true, wrote: false, key, file, holder }
  }

  const owner = {
    ...(existing || {}),
    project,
    domain,
    sessionId: ownerSessionId,
    since: new Date().toISOString(),
    by: null,
    note: note || '',
  }
  data.owners[key] = owner
  try {
    const result = writeDeclarationsAtomic(file, data)
    return { outcome: 'claimed', wrote: true, key, file, owner, heldBefore: holder, bytes: result.bytes }
  } catch (error) {
    return { outcome: 'write-failed', wrote: false, key, file, error: messageOf(error) }
  }
}

// --------------------------------------------------------------- v0.3.6 ownership gate (F1)

/**
 * 只读快照：这个**完整域名**现在是谁在任？没有声明 ⇒ null。
 *
 * `live` 复用 isSessionOnline()（与 list_domain_sessions 同一判据）；`inArchive` 复用
 * list_domain_sessions 已经在用的那套读取（loadIndex → registry.json 的 missions），**没有新接口**；
 * 索引读不到 / 格式坏掉 ⇒ `inArchive` 给 null（＝"不知道"），绝不当成 false 去猜。
 *
 * 依据（2026-10-12 docs 域双活会话事故）：旧行为只有 claim:true 才读域名册，不读就等于
 * 「这个域已经有负责人」这件事根本不告诉调用者，于是同一个域起了第二条活会话、两条并发改同一批文档。
 */
export function existingOwnerInfo(ctx, index, declarations, key, rows) {
  const entry = key ? declarations?.byKey?.get(String(key).toLowerCase()) || null : null
  if (!entry) return null
  const info = declarationInfo(entry, declarations)
  const sessionId = info.sessionId ?? null
  const indexReadable = Boolean(index) && !index.error && index.bySession instanceof Map
  return {
    key: info.key,
    domain: entry.domain ?? null,
    sessionId,
    since: info.since,
    by: info.by,
    note: info.note,
    live: isSessionOnline(ctx, sessionId, rows),
    inArchive: indexReadable && sessionId ? index.bySession.has(sessionId) : null,
    inArchiveSource: indexReadable ? 'index' : 'index-unavailable',
    inArchiveReason: indexReadable
      ? null
      : '会话索引（registry.json）读不到或格式坏掉，无法确认这条会话是否还在档里。',
  }
}

/** 大白话：这个负责人现在是什么状态（在线 / 只是没开机 / 档里也没有 / 不知道）。 */
export function ownerPresenceWords(owner) {
  if (!owner) return '状态未知'
  if (owner.live) return '当前在线'
  if (owner.inArchive === true) return '不在线（窗口已关，但会话存档里还有它）'
  if (owner.inArchive === false) return '不在线（会话索引里也查不到它）'
  return '不在线（会话索引读不到，无法确认它是否还在）'
}

/** 负责人的短号（拿不到短号就退回原 id）。 */
export function ownerWhoWords(owner) {
  return shortId(owner?.sessionId) || owner?.sessionId || '（未记录）'
}

/** note 太长时截断（标题/提示里的 note 只是佐证，不占满输出）。 */
export function ownerNoteWords(owner) {
  const note = String(owner?.note ?? '').trim()
  if (!note) return ''
  return `，note：「${clipToBytes(note, 60)}」`
}

/** F1 拒绝静默新建时的大白话 hint：发生了什么 / 现在谁负责 / 下一步怎么做。 */
export function domainAlreadyOwnedHint(key, owner) {
  return (
    `这个域已经有负责人了，所以本次**没有新建任何会话**（同一个域起两条活会话会各改各的文档、互相覆盖）。` +
    `现在负责「${key}」的是 ${ownerWhoWords(owner)}（${ownerPresenceWords(owner)}，自 ${owner.since ?? '（未记录）'} 起${ownerNoteWords(owner)}）。` +
    `下一步二选一：① 要换人 ⇒ claim_domain(domain='${key}', force=true) 显式交接（会自动给前任发停机通知）；` +
    `② 确实要再开一条会话 ⇒ 传 allowExistingOwner=true（风险：两条会话可能同时改同一批文档，请自己盯着）。`
  )
}

/** F1 放行覆盖（allowExistingOwner:true）时的提示。 */
export function domainOwnedOverrideHint(key, owner) {
  return (
    `⚠️ 这个域已经有负责人 ${ownerWhoWords(owner)}（${ownerPresenceWords(owner)}）——你传了 allowExistingOwner=true，所以照建了。` +
    `两条会话现在都可能改「${key}」的资产/文档：建议尽快 claim_domain(domain='${key}', force=true) 交接，或让其中一条停下。`
  )
}

// --------------------------------------------------------------- v0.3.6 stand-down notice (F2)

/**
 * 停机通知正文。外面还会套 domainEnvelope（唯一的信封 builder），所以这里不再重复加标题栏。
 * 依据（F2）：声明册原子换人了，前任还带着旧使命和旧的 domains 标注，没人告诉它，它会继续改
 * 同一批文档 ⇒ 两条活会话并发覆盖。
 */
export function standDownText({ domain, successorSessionId, at }) {
  return (
    `你已不再是「${domain}」的负责人：${successorSessionId ?? '（未知会话）'} 已于 ${at} 接手。` +
    `请不要再修改该域的资产或文档；若你正在改，请停在安全边界并说明进度。`
  )
}

/** 前任没收到 inject 时，往新声明的 note 里追加的这一行（含时间与未送达原因）。 */
export function standDownNoteLine(standDown) {
  const who = ownerWhoWords({ sessionId: standDown?.predecessorSessionId })
  const why =
    standDown?.reason === 'predecessor-offline'
      ? '前任当前不在线（默认不叫醒它，零成本）'
      : `停机通知没送达（${standDown?.reason || 'unknown'}${standDown?.error ? '：' + standDown.error : ''}）`
  return `[停机通知未送达] ${standDown?.at ?? ''} 前任 ${who}：${why} ⇒ 它可能不知道这次交接，请人工确认它已停手。`
}

/**
 * 强制交接后给**前任**发一条停机通知。永不抛错。
 *
 * 只走 inject（= send_to_domain 的 `mode='inject'` **同一条投递路径**）：塞上下文、**不唤醒**、
 * 不跑模型、零成本。复用同一个信封 builder（domainEnvelope）与同一个 v4 消息 builder
 * （domainMessage —— `source.kind` 是本插件名，**绝不是 'plugin'**，否则接收方会话下一轮会直接失败），
 * Agent 取用也复用 liveAgentOf()。
 *
 * delivered: 'inject'（在线且送达，不叫醒）| 'note-only'（不在线，没叫醒，只写 note）
 *          | 'failed'（在线但 inject 抛错/无此方法，写 note + 如实回报）
 *
 * ⚠️ **为什么这条 F2 停机通知不受「已暂停」拦截（v0.4.1 补记，核验者打的落差）**：
 *   暂停拦截（send_to_domain 里那道 `pausedTargetOf` 闸）的适用对象是**普通域间消息**——它拦的是
 *   "往一个被人按下的域里再塞活"，那时把消息入队等恢复，语义是对的。停机通知不一样：
 *   它讲的是「**你已不再是这个域的负责人，停手**」。而**前任完全可能正握着那个被暂停的域在改文件**
 *   （暂停只拦"插件介导的投递"，拦不住人/宿主已经让它活着在跑，见 README 的边界那条）——
 *   这正是最需要它听见这句话的时刻。停手通知是**止损**：拦掉它，就等于让一个以为自己还在任的会话
 *   继续改同一批文件（v0.3.6 那起双活覆盖事故的成因），而"暂停期间不得投递"只是**流程规矩**。
 *   两害相权，**拦掉比放过危险得多** ⇒ 这里**故意**绕开暂停闸，直接走 inject（零成本、不唤醒）。
 *   代价与边界：它只塞上下文、不跑模型，所以不会把暂停的域"叫活"；若前任不在线，仍然只写 note 留痕。
 *
 * ⚠️ **v0.4.2 对四级（域/主/项目/全局）重新论证同一条边界**（核验者阶段一 B5/H3 点名要的）：
 *   暂停闸现在会查四级，那这条停机通知要不要跟着查？**结论：仍然一律绕开，四级都绕。**
 *   理由在四级下**更强**，不是更弱：① 前任是"**单条会话**"，它被 session 级按下、或它的项目被按下、
 *   或全局被按下，**都不改变**「它已经不再是这个域的负责人」这个事实——那句话照样得送到；
 *   ② 四级暂停**都拦不住人/宿主已经让它活着在跑**（插件只管插件介导的路径），所以"前任正握着
 *   这个域在改文件"这个最危险的场景，**会不会发生与按了哪几级无关**；
 *   ③ 停手通知只 inject、不跑模型 ⇒ 四级下也**不会**把任何被按下的级别"叫活"。
 *   ⇒ 唯一正确的方向仍是"送止损信"，把它按四级拦下只会让并发覆盖更容易发生。
 */
export function notifyPredecessor(ctx, { predecessorSessionId, domain, successorSessionId }) {
  const at = new Date().toISOString()
  const text = standDownText({ domain, successorSessionId, at })
  const base = {
    predecessorSessionId: predecessorSessionId ?? null,
    successorSessionId: successorSessionId ?? null,
    domain: domain ?? null,
    at,
    text,
    reason: null,
    error: null,
    noteAppended: false,
    noteAppendError: null,
    noteLine: null,
    payloadId: null,
  }
  const agent = liveAgentOf(ctx, predecessorSessionId)
  if (!agent) return { ...base, delivered: 'note-only', reason: 'predecessor-offline' }
  try {
    const self = { id: successorSessionId ?? null, domains: [] }
    const envelope = domainEnvelope({
      self,
      text,
      replyKey: successorSessionId ?? '',
      mode: 'inject',
      label: '域交接通知',
    })
    const payload = domainMessage({ self, envelope })
    // 与 send_to_domain 的 mode='inject' 走**同一个**出口（不另造一套投递）。
    const attempt = deliverToAgent(agent, 'inject', payload)
    if (!attempt.ok) return { ...base, delivered: 'failed', reason: attempt.reason }
    return { ...base, delivered: 'inject', payloadId: payload.id }
  } catch (error) {
    return { ...base, delivered: 'failed', reason: 'inject-failed', error: messageOf(error) }
  }
}

/**
 * 往某条声明的 note 里**追加**一行（第二次原子替换：读不懂就中止，绝不覆盖别人的声明）。
 * 追加而不是覆盖：note 里原有的「接手自 …」留痕必须保住。
 */
export function appendNoteLine(file, key, line) {
  const read = readDeclarationsForWrite(file)
  if (read.parseError) return { ok: false, reason: 'declarations-file-unreadable', error: read.parseError }
  const data = read.data
  if (!Object.prototype.hasOwnProperty.call(data.owners, key)) return { ok: false, reason: 'declaration-vanished' }
  const existing = data.owners[key] && typeof data.owners[key] === 'object' ? data.owners[key] : {}
  const before = typeof existing.note === 'string' ? existing.note : ''
  const note = before ? before + '\n' + line : line
  data.owners[key] = { ...existing, note }
  try {
    const result = writeDeclarationsAtomic(file, data)
    return { ok: true, note, previousNote: before, bytes: result.bytes }
  } catch (error) {
    return { ok: false, reason: 'write-failed', error: messageOf(error) }
  }
}

// --------------------------------------------------------------- tools

export function buildListTool(ctx, config) {
  return tool(
    'list_domain_sessions',
    '列出**当前 dsh 进程里在线的顶层会话**（本体系称之为"域会话"），并带上：① 从体系索引只读推导的域标注；② **是否持有在任声明**（onDuty / dutyDomain）；同时返回**本会话自己的身份**（id / 域 / onDuty）——回复时用它当 target 寻址；另附 `declarations` 段＝域名册全量在任声明（每条都标出声明会话当前是否在线）。**v0.4.0**：行上多一个**派生状态** `state`（游标两轴 + 生命周期：`在线·活动` / `在线·已暂停` / `离线·活动` / `离线·已暂停` / `已终结`，会话行只可能是前两个），并新增 `domainState` 段＝作用域（**v0.4.2 起四级全部实现**：`domain|session|project|global`，`scopes` / `scopeImplemented` / `scopePlanned:[]`）＋**五态字典** `derivedStates` ＋**已终结**清单 `terminated`（在任声明已释放、状态记录留了墓碑的域）＋**四级被按下记录** `pausedRecords` ＋**判不成的级别** `unresolved`。**v0.4.2**：会话行/声明行的 `state`/`paused` 是**有效暂停（四级 OR 叠加）**——某条在线会话被 session（它自己）/ project（它的项目）/ global 任一级按着，就显示 `在线·已暂停`，并给出 `pausedScopes` / `pausedByScopes`。⚠️ **`在线·已暂停` 不等于"它被禁言"**：看 `pausedByScopes[].via`——`via ∈ {self-session, self-project, global}` ⇒ 它自己/它的项目/全局被按下，**发不出去**；`via` 取 `held-domain` ⇒ 它只是**持有一个被按下的域**，域级暂停只关那扇门，**它照样发得出去**（这正是"域级暂停不禁言整个会话"那条边界在列表上的样子）。只读，不唤醒任何会话。窗口已关的会话不在列表里（＝离线，不可达）。索引/声明文件读不到或坏掉一律静默降级，不报错。',
    {},
    async (_args, exec) => {
      const index = loadIndex(config.indexFile)
      const declarations = loadDeclarations(config.domainsFile)
      const duties = dutyMap(declarations)
      const rows = liveTopLevel(ctx, index, duties)
      const states = loadDomainStates(config.stateDir)
      const inboxes = loadInboxes(config.stateDir)
      return {
        plugin: { name: PLUGIN, version: VERSION },
        self: describe(exec?.agent, index, duties),
        onlineTopLevelCount: rows.length,
        onlineTopLevel: rows.map((row) => ({
          ...row.info,
          ...sessionPauseFields(row.info, duties, states, { declarations, ctx, rows }),
        })),
        declarationsFile: config.domainsFile,
        declarationsUpdatedAt: declarations.updatedAt,
        declarationsError: declarations.error,
        declarationCount: declarations.entries.length,
        declarations: declarations.entries.map((entry) => {
          const snapshot = domainSnapshot({
            declarations,
            states,
            inboxes,
            ctx,
            rows,
            key: entry.key,
          })
          return {
            key: entry.key,
            project: entry.project ?? null,
            domain: entry.domain ?? null,
            sessionId: entry.sessionId ?? null,
            since: entry.since ?? null,
            by: entry.by ?? null,
            note: entry.note ?? null,
            online: snapshot.online,
            scope: SCOPE_DOMAIN,
            state: snapshot.state,
            paused: snapshot.paused,
            pausedAt: snapshot.pausedAt,
            pausedBy: snapshot.pausedBy,
            pauseNote: snapshot.pauseNote,
            pausedScopes: snapshot.pausedScopes,
            pausedByScopes: snapshot.pausedByScopes,
            pending: snapshot.pending,
          }
        }),
        domainState: domainStateSection(config, declarations, states, inboxes, { ctx, rows }),
        declarationsHint:
          'onDuty=true 表示这个在线会话就是在任声明里的负责人（dutyDomain / dutyDomainKey）；declarations 段是在任声明全量，含已离线的。rows 上的 state 是**派生状态**（= 事实轴「在线/离线」+ 政策轴「活动/已暂停」+ 生命周期「已终结」，五态字典见 domainState.derivedStates）。',
        index: {
          file: config.indexFile,
          generatedAt: index.generatedAt,
          error: index.error,
          staleNote: '域标注来自体系索引快照（可能滞后 30 分钟内）；窗口在线与否以本列表为准。',
        },
      }
    },
  )
}

/**
 * One human hint per resolveTarget() failure reason that has no branch of its own.
 *
 * v0.3.0 used a ternary chain that covered only `multiple-online-for-domain` and `unreachable`;
 * every other reason (`missing-target`, `ambiguous-session-id`, ...) produced `hint: undefined`,
 * which made the host reject the ENTIRE call ("value is not lossless JSON") and hid the real
 * reason from the user. Keep this table exhaustive; pruneUndefined() is the safety net, not the fix.
 */
export function buildClaimTool(ctx, config) {
  return tool(
    'claim_domain',
    '**本会话认领一个域的在任声明**（写入域名册 domainsFile；语义与 ' +
      ownerCliRef(config) +
      ' claim 逐字段一致：同一 schema、同样的 since / note / by 字段、同样的原子替换）。domain 可写**短名**（asr）或「项目:域」（misas:asr）；短名时项目取 project 参数，没给就取**本会话 cwd 的目录名（小写）**。该域已被别人持有 ⇒ **不覆盖**，回报 conflict（加 force=true 才强制交接，旧负责人写进 note 留痕）。同一个人重复认领＝刷新在岗起算时间（幂等，不算冲突）。声明文件存在但读不懂 ⇒ 中止不写，避免覆盖别人的声明。**v0.4.0**：认领 / 强制交接**不是解暂停**——该域处于「已暂停」（政策轴）时**照常允许**认领（换人就是换人），但回执会带上 `paused` / `pausedAt` / `pausedBy` 与「该域仍处已暂停（谁在何时按下的）」提示；要恢复活动用 `set_domain_state(domain, state=active)`。未暂停的域回执与 v0.3.6 逐字一致（不多任何键）。',
    {
      domain: { type: 'string', description: '域短名（asr）或「项目:域」（misas:asr）' },
      project: { type: 'string', description: '可选：domain 为短名时用它补成「项目:域」；不给则取本会话 cwd 的目录名小写' },
      note: { type: 'string', description: '可选：写进声明的说明（强制交接时前任会一并记进 note）' },
      force: { type: 'boolean', description: 'true = 该域已有他人持有时强制交接（旧负责人写进 note 留痕）' },
    },
    async (args, exec) => {
      const self = describe(exec?.agent, emptyIndex())
      const userNote = typeof args.note === 'string' ? args.note : ''

      if (!self.id) {
        return { action: 'claim', outcome: 'invalid', reason: 'no-self-session', hint: '拿不到本会话 id，无法认领。', self }
      }
      const split = splitDomainTarget(args.domain, args.project)
      if (split.error) return { action: 'claim', outcome: 'invalid', reason: split.error, self }

      let project = split.project
      if (!project) {
        project = projectFromCwd(self.cwd)
        if (!project) {
          return {
            action: 'claim',
            outcome: 'invalid',
            reason: 'project-unknown',
            hint: '域是短名，又推不出项目名（本会话 cwd 拿不到），请显式给 project 参数（或写「项目:域」）。',
            self,
          }
        }
      }
      const key = project + ':' + split.domain

      const read = readDeclarationsForWrite(config.domainsFile)
      if (read.parseError) {
        return {
          action: 'claim',
          outcome: 'aborted',
          reason: 'declarations-file-unreadable',
          error: read.parseError,
          file: config.domainsFile,
          hint: '声明文件已存在但读不懂，为避免覆盖别人的声明，本次没有写入任何文件。',
          self,
        }
      }
      const data = read.data
      const existing = Object.prototype.hasOwnProperty.call(data.owners, key) ? data.owners[key] : null

      try {
        // Idempotent: the same session claiming again just refreshes the on-duty clock.
        if (existing && existing.sessionId === self.id) {
          const refreshed = {
            ...existing,
            project,
            domain: split.domain,
            since: new Date().toISOString(),
            by: existing.by || null,
            note: userNote || existing.note || '',
          }
          data.owners[key] = refreshed
          const result = writeDeclarationsAtomic(config.domainsFile, data)
          // ── v0.4.0/v0.4.2：刷新在岗时间**不动**政策轴；该域仍有任一级按着就如实提示（未暂停＝空对象）。
          const pause = pausedNoticeOf(config, key, loadDeclarations(config.domainsFile))
          return {
            action: 'claim',
            outcome: 'refreshed',
            key,
            owner: refreshed,
            wrote: true,
            bytes: result.bytes,
            file: config.domainsFile,
            ...pause,
            self,
            hint:
              '该域本来就是你在任，已刷新在岗起算时间（幂等，不算冲突）。' +
              (pause.pausedNotice ? pause.pausedNotice + pause.pausedHint : ''),
          }
        }

        // Conflict: somebody else holds it and force was not requested.
        if (existing && existing.sessionId !== self.id && args.force !== true) {
          return {
            action: 'claim',
            outcome: 'conflict',
            conflict: true,
            key,
            wrote: false,
            file: config.domainsFile,
            holder: {
              sessionId: existing.sessionId ?? null,
              since: existing.since ?? null,
              by: existing.by ?? null,
              note: existing.note ?? null,
              online: isSessionOnline(ctx, existing.sessionId),
            },
            self,
            hint:
              '该域已有在任负责人，本次没有覆盖任何东西。要换人：加 force=true 强制交接（旧负责人会写进 note 留痕），或先让在任方自己 release_domain。',
          }
        }

        // Force handover, or a brand new claim.
        const handoverFrom = existing && existing.sessionId !== self.id ? existing.sessionId : null
        const note = handoverFrom
          ? userNote
            ? '接手自 ' + handoverFrom + '；' + userNote
            : '接手自 ' + handoverFrom
          : userNote
        // Spread the previous record first so unknown fields are never dropped.
        let owner = {
          ...(existing || {}),
          project,
          domain: split.domain,
          sessionId: self.id,
          since: new Date().toISOString(),
          by: null,
          note,
        }
        data.owners[key] = owner
        const result = writeDeclarationsAtomic(config.domainsFile, data)
        // ── v0.3.3: 交接时给**前任**的标题标「（已退役）」——但它多半已经离线；离线只如实回报，
        // 绝不为了改个标题去唤醒一个会话。
        const retired = handoverFrom ? markRetired(ctx, handoverFrom, 'handover') : null
        // ── v0.3.6 F2: **强制交接**（接手别人的域）时给前任发一条停机通知。
        // 在线 ⇒ inject（只塞上下文、不唤醒、不跑模型、零成本）；离线/送达失败 ⇒ 往（新声明的）
        // note **追加**一行留痕。声明册**先写**再通知：前任看到「谁接手」时新负责人已经在册。
        // v0.4.1：这条通知**故意不走** send_to_domain 的「已暂停」拦截——前任可能正握着被暂停的域
        // 在改文件，停机通知是**止损**（理由全文见 notifyPredecessor 的 JSDoc）。
        let standDown = null
        if (handoverFrom) {
          standDown = notifyPredecessor(ctx, {
            predecessorSessionId: handoverFrom,
            domain: key,
            successorSessionId: self.id,
          })
          if (standDown.delivered !== 'inject') {
            const line = standDownNoteLine(standDown)
            const appended = appendNoteLine(config.domainsFile, key, line)
            standDown.noteAppended = appended.ok
            if (appended.ok) {
              standDown.noteLine = line
              owner = { ...owner, note: appended.note }
            } else {
              standDown.noteAppendError = appended.error || appended.reason
            }
          }
          warn(
            `[${TRACE_ID}] 交接 ${key}：停机通知 delivered=${standDown.delivered}` +
              `（${standDown.reason ?? 'ok'}）前任=${handoverFrom}` +
              `${standDown.noteAppended ? '，已写进新声明 note 留痕' : ''}`,
          )
        }
        const handoverLine = handoverFrom
          ? '已强制交接：旧负责人 ' + handoverFrom + ' 已写进 note 留痕。'
          : '已认领该域：从现在起你是在任负责人（同人重复认领＝刷新在岗起算时间）。'
        const standDownLine = standDown
          ? standDown.delivered === 'inject'
            ? `已给前任 ${handoverFrom} 发**停机通知**（inject：只塞上下文、不唤醒、不跑模型、零成本），让它别再改这个域。`
            : standDown.delivered === 'note-only'
              ? `前任 ${handoverFrom} 当前不在线（默认不叫醒它）：停机通知只写进了新声明的 note 留痕，建议人工确认它已停手。`
              : `⚠️ 给前任 ${handoverFrom} 发停机通知失败（${standDown.reason}）：已把这次交接写进新声明的 note 留痕。`
          : ''
        const retiredLine = retired
          ? retired.ok
            ? '前任标题已标为「' + retired.title + '」。'
            : '前任标题没标成「（已退役）」（' +
              retired.reason +
              (retired.reason === 'not-live' ? '：它已离线，不为了改标题唤醒它' : '') +
              '）。'
          : ''
        // ── v0.4.0：交接/新认领**不动**政策轴。该域仍处已暂停就如实提示（未暂停＝空对象，
        // 一个键都不多 ⇒ 与 v0.3.6 逐字一致）。
        const pause = pausedNoticeOf(config, key, loadDeclarations(config.domainsFile))
        const pauseLine = pause.pausedNotice ? pause.pausedNotice + pause.pausedHint : ''
        return {
          action: 'claim',
          outcome: handoverFrom ? 'handover' : 'created',
          key,
          owner,
          handoverFrom,
          wrote: true,
          bytes: result.bytes,
          file: config.domainsFile,
          retired,
          ...(standDown ? { standDown } : {}),
          ...pause,
          self,
          hint: handoverLine + standDownLine + retiredLine + pauseLine,
        }
      } catch (error) {
        return {
          action: 'claim',
          outcome: 'write-failed',
          key,
          wrote: false,
          file: config.domainsFile,
          error: error?.message || String(error),
          self,
        }
      }
    },
  )
}

export function buildReleaseTool(ctx, config) {
  return tool(
    'release_domain',
    '**本会话释放它自己持有的某个域**的在任声明（从域名册 domainsFile 删掉那一条；语义与 ' +
      ownerCliRef(config) +
      ' release 一致）。domain 可写短名（asr）或「项目:域」（misas:asr）。**不是你在任的域不会被删**（换人请用 claim_domain(force:true) 交接）；同名域你同时持有多个时请用「项目:域」完整写法指定。声明文件存在但读不懂 ⇒ 中止不删，避免误删。注意：note 只在回执里回显，不落盘（CLI 的 release 没有 note 字段）。**v0.4.0**：退役**不是解暂停**——该域处于「已暂停」时**照常允许释放**，回执给 `derivedState=已终结`，并在 `lifecycle` 段写下一笔生命周期墓碑（`<stateDir>/domains/<key>.json` 的 `terminatedAt/terminatedBy`，**这是 list_* 能显示「已终结」的唯一依据**）；域里还留着 pending 消息时提示"它们不会再投出去"，可用 `withdraw_domain_message` 逐条撤回。插件只改插件介导的路径：用 CLI 直接 release 的域**不会**留下墓碑。',
    {
      domain: { type: 'string', description: '域短名（asr）或「项目:域」（misas:asr）' },
      note: { type: 'string', description: '可选：只在回执里回显，不写入文件' },
    },
    async (args, exec) => {
      const self = describe(exec?.agent, emptyIndex())
      const userNote = typeof args.note === 'string' ? args.note : ''

      if (!self.id) {
        return { action: 'release', outcome: 'invalid', reason: 'no-self-session', hint: '拿不到本会话 id，无法释放。', self }
      }
      const raw = String(args.domain ?? '').trim()
      const split = splitDomainTarget(raw, null)
      if (split.error) return { action: 'release', outcome: 'invalid', reason: split.error, self }

      const read = readDeclarationsForWrite(config.domainsFile)
      if (read.parseError) {
        return {
          action: 'release',
          outcome: 'aborted',
          reason: 'declarations-file-unreadable',
          error: read.parseError,
          file: config.domainsFile,
          hint: '声明文件已存在但读不懂，为避免误删，本次没有写入任何文件。',
          self,
        }
      }
      const data = read.data
      const keys = Object.keys(data.owners)
      let matches = []
      if (raw.includes(':')) {
        const hit = keys.find((key) => key.toLowerCase() === String(split.key).toLowerCase())
        if (hit) matches = [hit]
      } else {
        const wanted = split.domain.toLowerCase()
        matches = keys.filter((key) => {
          const record = data.owners[key] || {}
          const short = String(
            record.domain !== undefined && record.domain !== null && record.domain !== ''
              ? record.domain
              : key.split(':').slice(1).join(':'),
          ).toLowerCase()
          return short === wanted
        })
      }

      const holderList = () => matches.map((key) => ({ key, ...(data.owners[key] || {}) }))

      if (matches.length === 0) {
        return {
          action: 'release',
          outcome: 'absent',
          wrote: false,
          file: config.domainsFile,
          noteEcho: userNote || null,
          self,
          hint: '本来就没有这个在任声明，无需释放。',
        }
      }

      const mine = matches.filter((key) => data.owners[key] && data.owners[key].sessionId === self.id)
      if (mine.length === 0) {
        return {
          action: 'release',
          outcome: 'not-owner',
          wrote: false,
          file: config.domainsFile,
          holders: holderList(),
          self,
          hint: '该域不是你在任，只有负责人本人能释放。换人请用 claim_domain(force:true) 交接。',
        }
      }
      if (mine.length > 1) {
        return {
          action: 'release',
          outcome: 'ambiguous-own-declarations',
          wrote: false,
          file: config.domainsFile,
          keys: mine,
          self,
          hint: '你同时持有多个同名声明，请用「项目:域」完整写法指定要释放哪一个（本次没有写入任何文件）。',
        }
      }

      const key = mine[0]
      const removed = data.owners[key] || {}
      delete data.owners[key]
      try {
        const result = writeDeclarationsAtomic(config.domainsFile, data)
        // ── v0.3.3: 退役即改标题。正在执行本工具 ⇒ 调用方会话必然 live；拿不到它的 Session 对象
        // 就如实回报（绝不为了改个标题去唤醒/重建一个会话）。
        const retired = markRetired(ctx, exec?.agent, 'release')

        // ── v0.4.0：生命周期落到状态目录（**墓碑**）。删掉的是**在任身份**（域名册，一个字节都不多），
        // 政策轴/生命周期记录留在 `<state>/domains/<key>.json` 里，这样 list_* 才能把「已终结」显示出来。
        // 写失败只如实回报，**绝不影响释放本身**（释放已经成功写盘了）。
        const terminatedAt = new Date().toISOString()
        const tombstone = writeDomainStateAtomic(config.stateDir, key, {
          terminatedAt,
          terminatedBy: self.id,
        })
        const queue = loadInbox(config.stateDir, key)
        const lifecycle = tombstone.ok
          ? {
              ok: true,
              reason: null,
              terminatedAt,
              terminatedBy: self.id,
              file: tombstone.file,
              bytes: tombstone.bytes,
            }
          : {
              ok: false,
              reason: tombstone.reason,
              error: tombstone.error ?? null,
              terminatedAt: null,
              terminatedBy: null,
              file: tombstone.file,
              bytes: null,
            }
        // 「已终结」是**派生状态**（声明没了 + 有墓碑），这里正好是它诞生的那一刻。
        const derivedState = STATE_TERMINATED
        const disposeLine =
          queue.pending > 0
            ? `⚠️ 这个域的队列里还留着 ${queue.pending} 条 pending 消息（${queue.file}）：域已终结 ⇒ 它们**不会再投出去**了（本工具不代投）。要清理：withdraw_domain_message(id=…) 逐条撤回。`
            : ''
        // v0.4.2：终止那一刻，把**四级 OR** 里还按着这个域键的级别一并说清（不只是域级自己那条记录）；
        // 但墓碑仍然只落在**域级**记录上（release 是域级生命周期动作，别的 scope 的键不归它管）。
        const pausePress = pauseHitsOfDisk(
          config,
          pauseCandidatesForDomain(loadDeclarations(config.domainsFile), key, {}).concat(pauseCandidatesGlobal()),
        )
        const pauseLine =
          tombstone.ok && tombstone.record?.paused
            ? `（该域终结时仍处于「已暂停」：${pausedWhoWords({ pausedBy: tombstone.record.pausedBy, pausedAt: tombstone.record.pausedAt, pauseNote: tombstone.record.note })}；墓碑里留了这一笔。` +
              `${
                pausePress.hits.filter((hit) => hit.scope !== SCOPE_DOMAIN).length
                  ? `同时被 ${pauseScopesOf(pausePress.hits.filter((hit) => hit.scope !== SCOPE_DOMAIN)).join('+')} 压着。`
                  : ''
              }）`
            : pausePress.hits.length
              ? `（该域自己那一级没被按下，但它终结时被 ${pausedScopesWords(pausePress.hits)} 压着——那些级别的记录**不归这次 release 管**，仍留在状态目录里。）`
              : ''
        const releaseLines = [
          userNote ? 'note 只在回执里回显，没有落盘（CLI 的 release 无 note 字段）。' : null,
          retired.ok
            ? `标题已标为「${retired.title}」。`
            : retired.reason === 'not-live'
              ? '标题没标成「（已退役）」：拿不到本会话的 Session 对象（不影响释放）。'
              : `标题没标成「（已退役）」（${retired.reason}）。`,
          // ⚠️ 只有**本来就有额外故事**（已暂停 / 队列还有遗留）时才往 hint 里加话：
          // 「非暂停域行为与 v0.3.6 逐字一致」包括这条 hint；派生状态本身在 `derivedState` 字段里。
          pauseLine || disposeLine ? `派生状态＝${derivedState}${pauseLine}` : null,
          disposeLine || null,
        ]
        if (queue.pending > 0) {
          warn(
            `[${TRACE_ID_V040}] 终结 ${key}：队列里还有 ${queue.pending} 条 pending 消息（域已终结，不会再投）。`,
          )
        }
        return {
          action: 'release',
          outcome: 'released',
          key,
          scope: SCOPE_DOMAIN,
          derivedState,
          // v0.4.2：终结那一刻还按着它的级别（四级 OR 全量）——退役 ≠ 解暂停。
          pausedScopes: pausedScopesOf(pausePress.hits),
          pausedByScopes: pausedByScopesOf(pausePress.hits),
          lifecycle,
          queue: { file: queue.file, pending: queue.pending, total: queue.total, delivered: queue.records.filter((r) => r.status === INBOX_DELIVERED).length },
          removedSessionId: removed.sessionId ?? null,
          wrote: true,
          bytes: result.bytes,
          file: config.domainsFile,
          noteEcho: userNote || null,
          noteNotPersisted: userNote ? true : false,
          retired,
          self,
          hint: releaseLines.filter((line) => line !== null).join(' '),
        }
      } catch (error) {
        return {
          action: 'release',
          outcome: 'write-failed',
          key,
          wrote: false,
          file: config.domainsFile,
          error: error?.message || String(error),
          self,
        }
      }
    },
  )
}

export function buildListOwnersTool(ctx, config) {
  return tool(
    'list_domain_owners',
    '**只读**列出域名册（domainsFile，由 domain-owner.mjs / claim_domain 维护）里的**全部在任声明**，并标出每条声明的会话当前是否在线（online: true/false）。**v0.4.0**：每条还带**派生状态** `state`（＝事实轴「在线/离线」+ 政策轴「活动/已暂停」+ 生命周期），取值 `在线·活动` / `在线·已暂停` / `离线·活动` / `离线·已暂停` / `已终结`；`paused` / `pausedAt` / `pausedBy`（**谁、何时按下的**）/ `pauseNote` / `pending`（队列里还有几条待投）逐条给全。另有 `domainState` 段：**v0.4.2 起四级全部实现**（`scopes` / `scopeImplemented` = `domain|session|project|global`；`scope` 字段仍以域级为主键，兼容旧读法），`derivedStates` 是**五态字典**（五种派生状态各自的含义），`pausedRecords` 列出**四级里所有被按下的记录**（级别 + 键 + 谁在何时按下），`terminated` 列出**已终结**（在任声明已释放、状态记录里留了墓碑）的域；`unresolved` 列出"判不成的那几级"（例如某条被按下的会话查不到 cwd ⇒ 推不出项目，按"不拦"处理但要照实说）。每条声明的 `state` / `paused` 是**有效暂停（OR 叠加）**，另给 `pausedScopes` / `pausedByScopes` 说明是哪几级。⚠️ `在线·已暂停`/`离线·已暂停` **不等于"被禁言"**：`pausedByScopes[].via ∈ {self-session, self-project, global}` 才是"这一级自己（或它的项目/全局）被按下"；域级经由"它持有的声明"命中时 `via` 是 `target-domain`/`held-domain`，那只是**关掉那扇门**。不改任何文件、不唤醒任何会话。文件不存在＝还没人认领（正常状态，不是错误）；读不到或格式坏掉一律静默降级，不报错。',
    {},
    async (_args, exec) => {
      const declarations = loadDeclarations(config.domainsFile)
      const self = describe(exec?.agent, emptyIndex())
      const rows = liveTopLevel(ctx, emptyIndex())
      const states = loadDomainStates(config.stateDir)
      const inboxes = loadInboxes(config.stateDir)
      return {
        plugin: { name: PLUGIN, version: VERSION },
        self,
        file: config.domainsFile,
        fileExisted: declarations.fileExisted,
        updatedAt: declarations.updatedAt,
        error: declarations.error,
        count: declarations.entries.length,
        declarations: declarations.entries.map((entry) => {
          const snapshot = domainSnapshot({ declarations, states, inboxes, ctx, rows, key: entry.key })
          return {
            key: entry.key,
            project: entry.project ?? null,
            domain: entry.domain ?? null,
            sessionId: entry.sessionId ?? null,
            since: entry.since ?? null,
            by: entry.by ?? null,
            note: entry.note ?? null,
            online: snapshot.online,
            scope: SCOPE_DOMAIN,
            state: snapshot.state,
            paused: snapshot.paused,
            pausedAt: snapshot.pausedAt,
            pausedBy: snapshot.pausedBy,
            pauseNote: snapshot.pauseNote,
            pausedScopes: snapshot.pausedScopes,
            pausedByScopes: snapshot.pausedByScopes,
            pending: snapshot.pending,
          }
        }),
        domainState: domainStateSection(config, declarations, states, inboxes, { ctx, rows }),
        onlineTopLevelCount: rows.length,
        hint: declarations.error
          ? '声明文件读不懂（或读不到），这里按「没有任何在任声明」降级展示，不抛错。'
          : declarations.fileExisted
            ? undefined
            : '声明文件还没建立（等同「没人认领」，这不是错误）。',
      }
    },
  )
}

/**
 * v0.4.0：无 GUI 时的**人工控制入口**。「已暂停」是**政策轴**（人给、可逆），与事实轴
 * （在线/离线，宿主给）分开：本工具**只动政策轴**，一个字节都不碰域名册（在任身份不变）。
 * `state='active'` ＝ 用户说的「人手动唤起」：恢复活动，并把队列里的 pending 按**原 mode** 重投。
 */
