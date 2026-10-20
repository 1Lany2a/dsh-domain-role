/**
 * dsh-domain-bridge — registrations.test.mjs（spec `commands-v1.md` §6 第一条）
 *
 * 覆盖：首次写 / 平行节保留（owners + 未知顶层键一字不动）/ 坏文件禁写 / **并发（两个子进程同时
 * upsert，最终两个键都在）** / 锁超时 + 死锁接管 / `identityOf` 三种层 / `removeRegistration` 只删
 * 自己的 / `listRegistrations` 排序 / `writeDomainsAtomic` 的 rename 重试与坏节拒绝 / `projectOfCwd`。
 *
 * 纯本地：全部写在 `os.tmpdir()` 的临时目录里，不碰机器上任何真文件，也不碰插件的 state/。
 * 跑法：`node test/registrations.test.mjs`（自成进程，退出码 0/1）。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const MODULE_URL = new URL('../lib/core/registrations.js', import.meta.url).href
const mod = await import(MODULE_URL)
const {
  readRegistrations,
  readRegistrationsForWrite,
  writeDomainsAtomic,
  withDomainsLock,
  upsertRegistration,
  removeRegistration,
  listRegistrations,
  identityOf,
  projectOfCwd,
} = mod

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-bridge-registrations-'))
/** 本模块的审计日志（warn）在测试里静音：只影响本进程的可见输出，不影响断言。 */
const realWarn = console.warn
console.warn = () => {}

const SID = {
  A: 'session-11111111-1111-4111-8111-111111111111',
  B: 'session-22222222-2222-4222-8222-222222222222',
  C: 'session-33333333-3333-4333-8333-333333333333',
}

const stats = { cases: 0, checks: 0 }
function ok(cond, message) {
  stats.checks++
  assert.ok(cond, message)
}
function eq(actual, expected, message) {
  stats.checks++
  assert.deepStrictEqual(actual, expected, message)
}
/** 开一个用例（只为记数与报错时能看出跑到哪一例）。 */
function useCase(name) {
  stats.cases++
  return name
}
function bookPath(name) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'domains.json')
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}
function readRaw(file) {
  return fs.readFileSync(file, 'utf8')
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function ownerRecord(project, domain, sessionId) {
  return { project, domain, sessionId, since: '2026-10-10T00:00:00.000Z', by: null, note: '先到' }
}

/** 起一个子进程、等它结束，并读回它写在 resultFile 里的回执（不走 stdout 管道，避免环境差异）。 */
function runChild(args, resultFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* 已经退出了 */
      }
      reject(new Error('子进程 60s 未结束（并发用例卡住了）'))
    }, 60000)
    child.on('error', (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      let payload = null
      try {
        payload = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      } catch {
        payload = null
      }
      resolve({ code, signal, payload })
    })
  })
}

async function waitFor(predicate, ms, label) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`等待超时：${label}`)
}

/**
 * 子进程脚本：两种写法各跑一遍同一个并发场景 ——
 *   · `lock`   ＝**本次实现**（唯一名 tmp + 进程间锁）；
 *   · `legacy` ＝改动前的写法（固定名 `<file>.tmp`、无锁），只用来**诊断**这把锁到底防住了什么
 *                （它不由断言守着，所以不会因为机器快慢而变成 flaky）。
 * 两个子进程先各自写 ready 文件，再忙等同一个 go 文件（屏障），保证真同时开跑。
 */
const CHILD_SOURCE = `
import fs from 'node:fs'
import { upsertRegistration } from ${JSON.stringify(MODULE_URL)}

const [mode, file, layer, project, sessionId, roundsText, keyMode, readyFile, goFile, resultFile] = process.argv.slice(2)
const rounds = Number(roundsText)
const slot = layer === 'system' ? ':system' : ':main'

// same = 每轮都写同一个键（spec §6 要的"两个键都在"）；per-round = 每轮一个不同的键
// （更强的形态：任何一次丢写都会在最终键集合里永久少一个键，躲不掉）。
function projectFor(i) {
  return keyMode === 'per-round' ? project + 'r' + i : project
}

function writeLegacy(i) {
  const doc = (() => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return { schemaVersion: 1, owners: {}, registrations: {} }
    }
  })()
  if (!doc.registrations) doc.registrations = {}
  const projectName = projectFor(i)
  const key = projectName + slot
  doc.registrations[key] = {
    key,
    layer,
    project: projectName,
    domain: layer === 'system' ? 'system' : 'main',
    sessionId,
    since: new Date().toISOString(),
    by: sessionId,
    title: '',
    note: '',
  }
  doc.updatedAt = new Date().toISOString()
  const body = JSON.stringify(doc, null, 2) + '\\n'
  const tmp = file + '.tmp'
  try {
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch {}
    return false
  }
}

fs.writeFileSync(readyFile, '1')
const deadline = Date.now() + 20000
while (!fs.existsSync(goFile)) {
  if (Date.now() > deadline) {
    fs.writeFileSync(resultFile, JSON.stringify({ failed: -1, reason: 'barrier-timeout' }), 'utf8')
    process.exit(0)
  }
}

let failed = 0
let last = ''
for (let i = 0; i < rounds; i++) {
  if (mode === 'legacy') {
    if (!writeLegacy(i)) { failed++; last = 'legacy-write-failed' }
  } else {
    const res = upsertRegistration(file, { layer, project: projectFor(i), sessionId, by: sessionId }, {})
    if (!res.ok || !res.written) { failed++; last = String(res.reason || res.error || 'unknown') }
  }
}
fs.writeFileSync(resultFile, JSON.stringify({ failed, last, rounds }), 'utf8')
`

/** 真并发跑一轮：两个子进程、不同键、同一个文件、同一个屏障。
 *  `extraOwners` 只用来把"读-改-写"的窗口撑大（诊断用）：书越大，两边读到同一份旧状态的
 *  机会越多，改动前那套固定名 tmp 的丢写就越容易复现。 */
async function race(tag, mode, rounds, extraOwners = 0, keyMode = 'same') {
  const file = bookPath(`race-${tag}`)
  const owners = { 'misas:asr': ownerRecord('misas', 'asr', SID.C) }
  for (let i = 0; i < extraOwners; i++) {
    owners[`seed${i}:dom`] = ownerRecord(`seed${i}`, 'dom', SID.C)
  }
  writeJson(file, {
    schemaVersion: 1,
    updatedAt: '2026-10-11T00:00:00.000Z',
    owners,
    custom: { keep: 'me' },
  })
  const before = JSON.parse(readRaw(file))
  const dir = path.join(root, `race-${tag}`)
  const script = path.join(dir, 'child.mjs')
  fs.writeFileSync(script, CHILD_SOURCE, 'utf8')
  const goFile = path.join(dir, 'go')
  const plan = [
    { layer: 'system', project: 'racer', sessionId: SID.A, ready: path.join(dir, 'a.ready') },
    { layer: 'project', project: 'racer', sessionId: SID.B, ready: path.join(dir, 'b.ready') },
  ]
  const runs = plan.map((item, index) =>
    runChild(
      [
        script,
        mode,
        file,
        item.layer,
        item.project,
        item.sessionId,
        String(rounds),
        keyMode,
        item.ready,
        goFile,
        path.join(dir, `result-${index}.json`),
      ],
      path.join(dir, `result-${index}.json`),
    ),
  )
  await waitFor(() => plan.every((item) => fs.existsSync(item.ready)), 20000, `${tag}: 两个子进程都就绪`)
  fs.writeFileSync(goFile, 'go', 'utf8')
  const finished = await Promise.all(runs)
  const after = JSON.parse(readRaw(file))
  return { file, before, after, finished }
}

try {
  // ------------------------------------------------------------------ 1. 首次写 + 平行节保留
  useCase('首次写 + 平行节保留')
  {
    const file = bookPath('first-write')
    writeJson(file, {
      schemaVersion: 1,
      updatedAt: '2026-10-11T00:00:00.000Z',
      owners: { 'misas:asr': ownerRecord('misas', 'asr', SID.C) },
      custom: { keep: 'me' },
    })
    const before = JSON.parse(readRaw(file))
    const res = upsertRegistration(
      file,
      { layer: 'system', project: 'xiangmu', sessionId: SID.A, by: SID.A, title: '体系主会话' },
      {},
    )
    eq(res.ok, true, '首次写应 ok:true')
    eq(res.written, true, '首次写应 written:true')
    eq(res.conflict, false, '首次写不该是冲突')
    eq(res.key, 'xiangmu:system', '体系键应为 <项目>:system')
    eq(res.error, null, '成功时 error 应为显式 null')
    eq(res.owner.layer, 'system', 'owner.layer 应为 system')
    eq(res.owner.domain, 'system', '体系那条的 domain 槽位应为 system（spec §2.1 样例）')
    eq(res.owner.project, 'xiangmu', 'owner.project 应为 xiangmu')
    eq(res.owner.sessionId, SID.A, 'owner.sessionId 应为本次会话')
    eq(res.owner.title, '体系主会话', 'title 应原样落盘')
    ok(typeof res.owner.since === 'string' && !Number.isNaN(Date.parse(res.owner.since)), 'since 应是 ISO 时间')
    const after = JSON.parse(readRaw(file))
    eq(after.owners, before.owners, 'owners 必须一字不动')
    eq(after.custom, { keep: 'me' }, '未知顶层键必须保住')
    eq(Object.keys(after.registrations), ['xiangmu:system'], 'registrations 应只有这一条')
    eq(after.registrations['xiangmu:system'].sessionId, SID.A, '落盘的 sessionId 不对')
    ok(after.updatedAt !== before.updatedAt, 'updatedAt 必须刷新')
    eq(
      fs.readdirSync(path.dirname(file)).filter((name) => name !== 'domains.json'),
      [],
      '写完之后目录里不许留 tmp / lock 残留',
    )
  }

  // ------------------------------------------------------------------ 2. 文件不存在＝空册（正常态，不是错误）
  useCase('文件不存在＝空册')
  {
    const file = path.join(root, 'no-such-book', 'domains.json')
    const read = readRegistrations(file)
    eq(read.ok, true, '文件不存在应 ok:true（正常态）')
    eq(read.error, null, '文件不存在不该有 error')
    eq(read.registrations, {}, '文件不存在应回空注册册')
    eq(read.doc.owners, {}, '空册的 owners 应是 {}')
    const wr = readRegistrationsForWrite(file)
    eq(wr.ok, true, '写前读文件不存在应 ok:true')
    eq(wr.doc.registrations, {}, '写前读应给空 registrations 节')
    eq(fs.existsSync(file), false, '只读调用不许建出文件')
  }

  // ------------------------------------------------------------------ 3. 幂等刷新 + 项目层 + listRegistrations 排序
  useCase('幂等刷新 + 排序')
  {
    const file = bookPath('refresh')
    const first = upsertRegistration(file, { layer: 'project', project: 'TixiWeihu', sessionId: SID.A }, {})
    eq(first.ok, true, '项目层首次写应成功')
    eq(first.key, 'tixiweihu:main', '项目键应为 <项目小写>:main')
    eq(first.owner.project, 'tixiweihu', '项目名应归一化为小写')
    eq(first.owner.domain, 'main', '项目那条的 domain 槽位应为 main（spec §2.1 样例）')
    eq(first.refreshed, false, '首次写不是刷新')
    await sleep(5)
    const again = upsertRegistration(file, { layer: 'project', project: 'tixiweihu', sessionId: SID.A }, {})
    eq(again.ok, true, '同人重复注册应成功（幂等）')
    eq(again.written, true, '同人重复注册也应写盘（刷新在岗起算时间）')
    eq(again.refreshed, true, '同人重复注册应报 refreshed:true')
    eq(again.conflict, false, '同人不算冲突')
    ok(again.owner.since >= first.owner.since, 'since 应被刷新')
    eq(upsertRegistration(file, { layer: 'system', project: 'xiangmu', sessionId: SID.A }, {}).ok, true, '体系层应成功')

    const doc = readRegistrations(file).doc
    const list = listRegistrations(doc)
    eq(
      list.map((row) => row.key),
      ['xiangmu:system', 'tixiweihu:main'],
      'listRegistrations 必须按 layer 排序（体系 → 项目）',
    )
    eq(list.map((row) => row.layer), ['system', 'project'], 'layer 顺序不对')
    eq(listRegistrations(null), [], 'doc 读不懂 ⇒ 空数组（永不抛）')
    eq(listRegistrations({ registrations: { 'a:system': null } })[0].layer, 'system', '容错：空记录也应按键判层')
  }

  // ------------------------------------------------------------------ 4. 冲突不写 + force 接手
  useCase('冲突不写 + force 接手')
  {
    const file = bookPath('conflict')
    upsertRegistration(file, { layer: 'project', project: 'tixiweihu', sessionId: SID.B, by: SID.B, note: '先到' }, {})
    const before = readRaw(file)
    const res = upsertRegistration(file, { layer: 'project', project: 'tixiweihu', sessionId: SID.A, by: SID.A }, {})
    eq(res.ok, false, '别人持有且没 force ⇒ ok:false')
    eq(res.written, false, '冲突时不许写')
    eq(res.conflict, true, '冲突应带 conflict:true')
    eq(res.owner.sessionId, SID.B, 'owner 应是在任那一位（好让回执点名）')
    eq(res.error, null, '冲突不是异常：error 应为 null')
    eq(readRaw(file), before, '冲突时文件一个字都不能变')
    ok(typeof res.hint === 'string' && res.hint.includes('没有覆盖'), '冲突必须给可执行的 hint')

    const forced = upsertRegistration(
      file,
      { layer: 'project', project: 'tixiweihu', sessionId: SID.A, by: SID.A, note: '换人' },
      { force: true },
    )
    eq(forced.ok, true, 'force 应成功')
    eq(forced.handoverFrom, SID.B, 'force 应回报前任')
    eq(forced.owner.sessionId, SID.A, 'force 后应换成新会话')
    ok(forced.owner.note.startsWith(`接手自 ${SID.B}；换人`), `接手留痕不对：${forced.owner.note}`)
  }

  // ------------------------------------------------------------------ 5. 拒绝不合法/不该走这条路的 entry
  useCase('拒绝域层与坏 entry')
  {
    const file = bookPath('reject')
    const dom = upsertRegistration(file, { layer: 'domain', project: 'misas', domain: 'asr', sessionId: SID.A }, {})
    eq(dom.ok, false, '域层不该写注册节')
    eq(dom.written, false, '被拒的调用一个字都不许写')
    eq(dom.reason, 'invalid-entry', 'reason 应为 invalid-entry')
    ok(dom.error.includes('owners'), '错误里要指出去哪写（owners / claim_domain）')
    eq(upsertRegistration(file, { layer: 'system', sessionId: SID.A }, {}).ok, false, 'project 为空应拒')
    const noSid = upsertRegistration(file, { layer: 'system', project: 'xiangmu' }, {})
    eq(noSid.ok, false, 'sessionId 为空应拒')
    ok(noSid.error.includes('sessionId'), '错误里要点名 sessionId')
    const badKey = upsertRegistration(file, { layer: 'project', project: 'misas', key: 'other:main', sessionId: SID.A }, {})
    eq(badKey.ok, false, 'key 与 layer+project 不一致应拒（不猜）')
    ok(badKey.error.includes('不一致'), '错误里要说明键规则')
    eq(upsertRegistration(file, { layer: 'nope', project: 'misas', sessionId: SID.A }, {}).ok, false, 'layer 非法应拒')
    eq(fs.existsSync(file), false, '全被拒的调用不该留下文件')
  }

  // ------------------------------------------------------------------ 6. 坏文件禁写（绝不覆盖别人的数据）
  useCase('坏文件禁写')
  {
    const bad = [
      ['garbled-json', '{{'],
      ['top-not-object', '["a"]'],
      ['owners-not-object', JSON.stringify({ schemaVersion: 1, owners: [], registrations: {} })],
      ['registrations-not-object', JSON.stringify({ schemaVersion: 1, owners: {}, registrations: 'nope' })],
    ]
    for (const [label, raw] of bad) {
      const file = bookPath(`bad-${label}`)
      fs.writeFileSync(file, raw, 'utf8')
      const before = readRaw(file)
      const read = readRegistrations(file)
      eq(read.ok, false, `${label}: readRegistrations 应 ok:false`)
      eq(read.registrations, {}, `${label}: 读不懂的 registrations 一律当空册`)
      ok(typeof read.error === 'string' && read.error.length > 0, `${label}: 应回报 error`)
      const wr = readRegistrationsForWrite(file)
      eq(wr.ok, false, `${label}: 写前读应 ok:false（禁写）`)
      eq(wr.doc, null, `${label}: 禁写时不该给 doc`)
      const res = upsertRegistration(file, { layer: 'system', project: 'xiangmu', sessionId: SID.A }, {})
      eq(res.ok, false, `${label}: 坏文件必须禁写`)
      eq(res.written, false, `${label}: 坏文件不许写`)
      eq(readRaw(file), before, `${label}: 文件必须一字不动`)
    }
    const refuse = writeDomainsAtomic(bookPath('write-refuse'), { owners: [] })
    eq(refuse.ok, false, 'writeDomainsAtomic 遇到坏节应拒绝')
    ok(refuse.error.includes('owners'), '拒绝原因要点名是哪个节')
  }

  // ------------------------------------------------------------------ 7. removeRegistration：只删自己的
  useCase('removeRegistration 只删自己的')
  {
    const file = bookPath('remove')
    upsertRegistration(file, { layer: 'system', project: 'xiangmu', sessionId: SID.A }, {})
    upsertRegistration(file, { layer: 'project', project: 'tixiweihu', sessionId: SID.B }, {})
    const notMine = removeRegistration(file, 'tixiweihu:main', SID.A)
    eq(notMine.ok, false, '删别人的条目应 ok:false')
    eq(notMine.removed, false, '删别人的条目不许删')
    eq(notMine.reason, 'not-owner', "reason 应为 not-owner")
    ok('tixiweihu:main' in JSON.parse(readRaw(file)).registrations, '别人的条目必须还在')

    const mine = removeRegistration(file, 'xiangmu:system', SID.A)
    eq(mine.ok, true, '删自己的条目应成功')
    eq(mine.removed, true, 'own 应 removed:true')
    eq(mine.key, 'xiangmu:system', '应回报删掉的是哪个键')
    eq(mine.entry.sessionId, SID.A, '应回报删掉的那条记录')
    ok(!('xiangmu:system' in JSON.parse(readRaw(file)).registrations), '自己的条目应已删掉')

    const absent = removeRegistration(file, 'xiangmu:system', SID.A)
    eq(absent.ok, true, '本来没有 ⇒ 幂等成功')
    eq(absent.removed, false, '本来没有 ⇒ removed:false')
    eq(absent.reason, 'absent', "reason 应为 absent")
    eq(removeRegistration(file, '', SID.A).reason, 'missing-key', '空 key 应拒')
    eq(removeRegistration(file, 'xiangmu:system', '').reason, 'missing-session-id', '不给 sessionId 应拒（只删自己的）')
  }

  // ------------------------------------------------------------------ 8. identityOf 三种层
  useCase('identityOf 三种层')
  {
    const file = bookPath('identity')
    upsertRegistration(file, { layer: 'system', project: 'xiangmu', sessionId: SID.A }, {})
    upsertRegistration(file, { layer: 'project', project: 'tixiweihu', sessionId: SID.A }, {})
    upsertRegistration(file, { layer: 'project', project: 'other', sessionId: SID.B }, {})
    const doc = readRegistrations(file).doc
    doc.owners['misas:asr'] = ownerRecord('misas', 'asr', SID.A)
    writeJson(file, doc)

    const me = identityOf(doc, SID.A)
    eq(me.roles.map((role) => role.layer), ['system', 'project', 'domain'], '三层都要看得见（体系 → 项目 → 域）')
    eq(me.roles.map((role) => role.key), ['xiangmu:system', 'tixiweihu:main', 'misas:asr'], '三种层的 key 不对')
    eq(me.roles[2].project, 'misas', '域层的 project 应取自 owners')
    eq(me.roles[2].domain, 'asr', '域层的 domain 应取自 owners')
    eq(me.systemMain, true, 'SID.A 是体系主会话')
    eq(me.projectMains, ['tixiweihu'], 'projectMains 应只列 layer=project 的项目名')

    const other = identityOf(doc, SID.B)
    eq(other.roles.length, 1, 'SID.B 只有一条项目任命')
    eq(other.systemMain, false, 'SID.B 不是体系主会话')
    eq(other.projectMains, ['other'], 'SID.B 的项目主身份不对')

    const none = identityOf(doc, SID.C)
    eq(none.roles, [], '查无此人的身份应为空')
    eq(none.systemMain, false, '查无此人 systemMain 应为 false')
    eq(none.projectMains, [], '查无此人 projectMains 应为空数组')
    eq(identityOf(null, SID.A).roles, [], 'doc 读不懂 ⇒ 空身份（永不抛）')
    eq(listRegistrations(doc).map((row) => row.key), ['xiangmu:system', 'other:main', 'tixiweihu:main'], 'listRegistrations 只看 registrations 节（域在 owners，不造第二本台账）；层内按键排')
  }

  // ------------------------------------------------------------------ 9. 锁：超时 / 释放 / fn 抛错 / 死锁接管 / 读不懂不接管
  useCase('锁超时与死锁接管')
  {
    const file = bookPath('lock')
    const lockFile = file + '.lock'

    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8')
    let called = false
    const t0 = Date.now()
    const res = withDomainsLock(file, () => {
      called = true
      return 1
    })
    const elapsed = Date.now() - t0
    eq(res.ok, false, '锁被别人占着应 ok:false')
    eq(res.reason, 'locked', "reason 应为 'locked'")
    eq(res.value, null, '没拿到锁时 value 应为 null')
    eq(called, false, '没拿到锁就绝不该执行 fn（绝不硬写）')
    ok(elapsed >= 250, `应重试到 ~300ms 才放弃（实测 ${elapsed}ms）`)
    ok(fs.existsSync(lockFile), '别人的锁不许被删')

    fs.unlinkSync(lockFile)
    const good = withDomainsLock(file, () => 'done')
    eq(good.ok, true, '空锁应能拿到')
    eq(good.value, 'done', 'value 应回 fn 的返回值')
    eq(good.error, null, '成功时 error 应为 null')
    eq(fs.existsSync(lockFile), false, '正常路径必须把锁释放掉')

    const boom = withDomainsLock(file, () => {
      throw new Error('boom')
    })
    eq(boom.ok, false, 'fn 抛错应 ok:false')
    ok(boom.error.includes('boom'), 'fn 的错要如实带出来')
    eq(fs.existsSync(lockFile), false, 'fn 抛错也必须释放锁')
    eq(withDomainsLock('', () => 1).ok, false, '空路径应拒')
    eq(withDomainsLock(file, 'not-a-function').reason, 'no-function', 'fn 不是函数应拒')

    // 死锁接管：锁内 pid 已死 ⇒ 删锁重试一次
    const dead = await (async () => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
      const pid = child.pid
      await new Promise((resolve) => child.on('exit', resolve))
      return pid
    })()
    let esrch = false
    try {
      process.kill(dead, 0)
    } catch (error) {
      esrch = error?.code === 'ESRCH'
    }
    ok(esrch, '测试前置：刚退出的子进程 pid 应已死（ESRCH）')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: dead, at: new Date().toISOString() }), 'utf8')
    const taken = withDomainsLock(file, () => 'taken')
    eq(taken.ok, true, '锁内 pid 已死 ⇒ 应删锁重试一次并成功')
    eq(taken.value, 'taken', '接管后应正常执行 fn')
    eq(fs.existsSync(lockFile), false, '接管后也要释放锁')

    // 读不懂的锁（没有 pid）⇒ 不接管，如实报 locked
    fs.writeFileSync(lockFile, 'not-json', 'utf8')
    const blind = withDomainsLock(file, () => 1)
    eq(blind.ok, false, '读不懂的锁绝不接管')
    eq(blind.reason, 'locked', '读不懂的锁应报 locked')
    fs.unlinkSync(lockFile)

    // 锁路径被目录占住 ⇒ 抢锁失败要如实回报，绝不硬写
    const dirBook = bookPath('lock-is-dir')
    fs.mkdirSync(dirBook + '.lock')
    const blocked = withDomainsLock(dirBook, () => 1)
    eq(blocked.ok, false, '锁文件被目录占住应 ok:false')
    ok(
      blocked.reason === 'lock-failed' || blocked.reason === 'locked',
      `抢锁失败应如实回报（实测 reason=${blocked.reason}）`,
    )
  }

  // ------------------------------------------------------------------ 10. writeDomainsAtomic：目标被目录占住 ⇒ rename 重试后如实失败，且不留 tmp
  useCase('rename 失败重试 + 清 tmp')
  {
    const target = bookPath('target-is-dir')
    fs.mkdirSync(target)
    const t0 = Date.now()
    const res = writeDomainsAtomic(target, { owners: {}, registrations: {} })
    eq(res.ok, false, '目标被目录占住 ⇒ 写盘必须如实失败')
    ok(typeof res.error === 'string' && res.error.length > 0, '失败要带 error 文本')
    ok(Date.now() - t0 >= 80, 'rename 应重试（≤10 次 × 10ms）后才放弃')
    eq(
      fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith('.tmp')),
      [],
      '失败的写盘必须删掉自己的 tmp（不许留垃圾）',
    )
  }

  // ------------------------------------------------------------------ 11. 并发：两个子进程同时 upsert，最终两个键都在
  useCase('并发：两个子进程同时 upsert')
  {
    const { after, finished } = await race('locked', 'lock', 20)
    for (const [index, run] of finished.entries()) {
      eq(run.code, 0, `并发子进程 #${index + 1} 应正常退出（code=${run.code}）`)
      ok(run.payload, `并发子进程 #${index + 1} 应写出回执`)
      eq(run.payload.failed, 0, `并发子进程 #${index + 1} 每一轮写盘都该成功：${JSON.stringify(run.payload)}`)
      eq(run.payload.rounds, 20, '并发子进程轮数不对')
    }
    eq(
      Object.keys(after.registrations).sort(),
      ['racer:main', 'racer:system'],
      '并发下**两个键必须都在**（唯一名 tmp + 进程间锁）',
    )
    eq(after.registrations['racer:system'].sessionId, SID.A, 'racer:system 的会话不对')
    eq(after.registrations['racer:main'].sessionId, SID.B, 'racer:main 的会话不对')
    eq(
      after.owners,
      { 'misas:asr': ownerRecord('misas', 'asr', SID.C) },
      '并发也不许吃掉 owners 里的域声明',
    )
    eq(after.custom, { keep: 'me' }, '并发也不许吃掉未知顶层键')
  }

  // ------------------------------------------------------------------ 11b. 并发（更强形态）：两个子进程各写 30 个**不同**的键 ⇒ 最终 60 个键一个都不能少
  useCase('并发：每轮一个不同键 ⇒ 一个都不能少')
  {
    const { after, finished } = await race('locked-many', 'lock', 30, 0, 'per-round')
    for (const [index, run] of finished.entries()) {
      eq(run.code, 0, `并发子进程 #${index + 1} 应正常退出（code=${run.code}）`)
      eq(run.payload?.failed, 0, `并发子进程 #${index + 1} 每一轮写盘都该成功：${JSON.stringify(run.payload)}`)
    }
    const keys = Object.keys(after.registrations)
    eq(keys.length, 60, '两个子进程各 30 个不同键 ⇒ 最终必须一个不少（丢一个就是读-改-写没互斥）')
    eq(keys.filter((key) => key.endsWith(':system')).length, 30, '体系侧键数不对')
    eq(keys.filter((key) => key.endsWith(':main')).length, 30, '项目侧键数不对')
  }

  // ------------------------------------------------------------------ 12. 诊断（不算断言）：同一场景用"改动前的写法"跑一遍，看这把锁到底防住了什么
  {
    let note
    try {
      const rounds = 30
      const expect = rounds * 2
      const legacy = await race('legacy', 'legacy', rounds, 60, 'per-round')
      const keys = Object.keys(legacy.after.registrations)
      const failed = legacy.finished.map((run) => run.payload?.failed ?? 'no-result').join('/')
      const lost = expect - keys.length
      note =
        `改动前（固定名 tmp + 无锁）跑同一场景（两个子进程各 ${rounds} 个不同键，共 ${expect} 个键）：` +
        `最终只剩 ${keys.length}/${expect} 个键${lost > 0 ? `（**永久丢了 ${lost} 个**）` : '（本轮没丢）'}；` +
        `两个子进程报出的写失败轮数=${failed}`
    } catch (error) {
      note = `旧写法的诊断没跑完（${error?.message || error}）`
    }
    console.log(`[registrations] 并发诊断：${note}`)
  }

  // ------------------------------------------------------------------ 13. projectOfCwd
  useCase('projectOfCwd')
  {
    const sysRoot = path.join(root, 'roots', 'xiangmu')
    fs.mkdirSync(sysRoot, { recursive: true })
    fs.writeFileSync(path.join(sysRoot, 'SYSTEM-OVERVIEW.md'), '# 体系口径\n', 'utf8')
    eq(projectOfCwd(sysRoot), { project: 'xiangmu', isSystemRoot: true }, '体系根应认出来')
    const projectRoot = path.join(root, 'roots', 'Misas')
    fs.mkdirSync(projectRoot, { recursive: true })
    eq(projectOfCwd(projectRoot), { project: 'misas', isSystemRoot: false }, '项目目录名应小写')
    eq(projectOfCwd(''), { project: null, isSystemRoot: false }, '空 cwd 应给 null/false')
    eq(projectOfCwd(null), { project: null, isSystemRoot: false }, 'null cwd 应给 null/false（永不抛）')
    eq(projectOfCwd(12345), { project: null, isSystemRoot: false }, '非字符串 cwd 应给 null/false（永不抛）')
  }
} finally {
  console.warn = realWarn
}

console.log(`[registrations] 用例 ${stats.cases} | 断言 ${stats.checks} | 全部通过`)
