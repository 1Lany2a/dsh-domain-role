// v0.8.8 read-only state snapshot — the sidebar block's single data source.
// No host, no network: fixtures on disk + fake ctx.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildStateSnapshot } from '../lib/core/state.js'
import { upsertRegistration } from '../lib/core/registrations.js'
import { writeDomainStateAtomic } from '../lib/core/pause.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-state-'))
const registryDir = path.join(root, '_registry')
const stateDir = path.join(root, 'state')
const indexFile = path.join(registryDir, 'registry.json')
const domainsFile = path.join(registryDir, 'domains.json')
fs.mkdirSync(registryDir, { recursive: true })
fs.mkdirSync(path.join(stateDir, 'inbox'), { recursive: true })
fs.writeFileSync(domainsFile, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), owners: {}, registrations: {} }, null, 2) + '\n', 'utf8')

const config = { domainsFile, stateDir, indexFile }
const deps = { config }
const liveId = 'session-live0001'
const ctx = { get: (name) => (name === 'agents' ? { roots: () => [{ id: liveId }] } : undefined) }

let passed = 0
const ok = (cond, message) => { assert.ok(cond, message); passed++ }

// 1. 什么都没有的时候也要 ok：不给异常、给空表 + 不留假数据
{
  const snap = buildStateSnapshot(ctx, deps, {})
  ok(snap.ok === true, '空环境也要 ok:true')
  ok(snap.systems.length === 0 && snap.projects.length === 0, '空环境没有体系/项目')
  ok(snap.totals.live === 1, '在线数按活 Agent 算')
  ok(snap.totals.paused === 0 && snap.totals.pending === 0, '暂停/队列都从 0 开始')
  ok(snap.records.handoff === null, '不存在的记录入口必须是 null，不能给死链')
  ok(Array.isArray(snap.warnings), 'warnings 必须是数组（降级要能看见）')
}

// 2. 注册册 + 域声明 + 暂停 + 队列 拼成同一个快照
{
  upsertRegistration(domainsFile, { key: 'tixiweihu:system', layer: 'system', project: 'tixiweihu', domain: 'system', sessionId: liveId, title: '', note: '在任' })
  upsertRegistration(domainsFile, { key: 'other:main', layer: 'project', project: 'other', domain: 'main', sessionId: 'session-offline01', title: '', note: '' })
  const doc = JSON.parse(fs.readFileSync(domainsFile, 'utf8'))
  doc.owners['other:asr'] = { project: 'other', domain: 'asr', sessionId: 'session-offline02', since: new Date().toISOString(), by: null, note: '六件 asr 使命' }
  fs.writeFileSync(domainsFile, JSON.stringify(doc, null, 2) + '\n', 'utf8')

  writeDomainStateAtomic(stateDir, 'session-gone01', { paused: true, pausedAt: '2026-10-20T09:03:06.341Z', pausedBy: 'session-gone01', note: '退役：人工退役' }, 'session')
  fs.writeFileSync(
    path.join(stateDir, 'inbox', 'k-other-main.jsonl'),
    JSON.stringify({ id: 'm1', key: 'other:main', status: 'pending', mode: 'followup', at: new Date().toISOString() }) + '\n' +
      JSON.stringify({ id: 'm2', key: 'other:main', status: 'delivered', mode: 'followup', at: new Date().toISOString() }) + '\n',
    'utf8',
  )

  const snap = buildStateSnapshot(ctx, deps, { cwd: 'D:\\xiangmu\\tixiweihu' })
  ok(snap.systems.length === 1 && snap.systems[0].key === 'tixiweihu:system', '体系行来自注册册')
  ok(snap.systems[0].online === true && snap.systems[0].state === '在线·活动', '在线状态按活 Agent 判')
  const other = snap.projects.find((row) => row.name === 'other')
  ok(!!other, '项目来自注册册/域声明')
  ok(other.adoption === 'adopted-offline', '有主会话但离线 ⇒ adopted-offline')
  ok(other.domains.length === 1 && other.domains[0].domain === 'asr', '域会话挂在项目下')
  ok(other.main.pending === 1, 'pending 只数 pending 行（delivered 不算）')
  ok(snap.totals.pending === 1, '总数与明细一致')
  ok(snap.history.length === 1 && snap.history[0].short === 'sess-gone01', 'session 级暂停就是历史留痕')
  ok(snap.history[0].note.includes('退役'), '历史里要带退役原因')
}

// 3. 索引里"被发现但没接入"的项目必须出现（老项目就是靠这条被看见）
{
  const bareRoot = path.join(root, 'freshproj')
  const withMd = path.join(root, 'hasmd')
  fs.mkdirSync(bareRoot, { recursive: true })
  fs.mkdirSync(withMd, { recursive: true })
  fs.writeFileSync(path.join(withMd, 'PROJECT.md'), '# x\n', 'utf8')
  fs.writeFileSync(
    indexFile,
    JSON.stringify({
      generatedAt: '2026-10-20T09:01:13.060Z',
      counts: { missions: 112 },
      projectRoots: [bareRoot, withMd, 'D:\\xiangmu\\other', 'D:\\xiangmu\\study\\cpp-learning'],
      missions: [
        { sessionId: 'session-old0001', lastActivity: 1791463962435 },
        { sessionId: 'session-old0001', lastActivity: 1791460000000 },
        { sessionId: liveId, lastActivity: 1791463962435 },
      ],
    }),
    'utf8',
  )
  const snap = buildStateSnapshot(ctx, deps, {})
  const fresh = snap.projects.find((row) => row.name === 'freshproj')
  ok(!!fresh, '索引里的项目根即便没接入也要列出来')
  ok(fresh.adoption === 'unregistered' && fresh.main === null, '没注册 <项目>:main ⇒ unregistered')
  ok(fresh.sources.includes('index'), '来源要标清楚是索引发现的')
  ok(fresh.hasProjectFile === false, '没有 PROJECT.md 时要如实报 false')
  ok(snap.projects.find((row) => row.name === 'hasmd').hasProjectFile === true, '有 PROJECT.md 时报 true')
  ok(snap.projects.find((row) => row.name === 'cpp-learning').nested === true, '嵌套项目根要标 nested')
  ok(snap.totals.missions === 112, '使命总数透传自索引')
  const live = snap.sessions.find((row) => row.id === liveId)
  ok(live && live.lastActivity === 1791463962435, '最近活动取该会话所有使命的最大值')
  ok(live && live.missions === 1, '使命条数按会话聚合')
  ok(snap.freshness.indexAt === '2026-10-20T09:01:13.060Z', '新鲜度必须带索引生成时间')
}

// 4. 纯只读：连续两次快照不改任何文件（mtime + 大小）
{
  const before = fs.readdirSync(registryDir).sort().map((name) => {
    const stat = fs.statSync(path.join(registryDir, name))
    return `${name}:${stat.size}:${stat.mtimeMs}`
  })
  buildStateSnapshot(ctx, deps, {})
  buildStateSnapshot(ctx, deps, {})
  const after = fs.readdirSync(registryDir).sort().map((name) => {
    const stat = fs.statSync(path.join(registryDir, name))
    return `${name}:${stat.size}:${stat.mtimeMs}`
  })
  ok(JSON.stringify(before) === JSON.stringify(after), '两次快照不得改动注册目录里的任何文件')
}

// 5. 坏文件不炸：注册册写坏 ⇒ ok:true + 一条 warning
{
  const broken = path.join(root, 'broken', 'domains.json')
  fs.mkdirSync(path.dirname(broken), { recursive: true })
  fs.writeFileSync(broken, '{ not json', 'utf8')
  const snap = buildStateSnapshot(ctx, { config: { domainsFile: broken, stateDir, indexFile } }, {})
  ok(snap.ok === true, '注册册坏掉也要返回可渲染的空快照')
  ok(snap.warnings.some((line) => line.includes('注册册')), '坏文件必须进 warnings，不许静默')
}

// 6. F-08：坏队列行 / 不可读文件不许静默丢 —— 进 warnings 并说明 pending 只数能读的行
{
  const inboxDir = path.join(stateDir, 'inbox')
  fs.writeFileSync(
    path.join(inboxDir, 'k-broken-queue.jsonl'),
    '{ this is not json\n' +
      JSON.stringify({ id: 'm9', key: 'brokenqueue:dom', status: 'pending', mode: 'followup', at: new Date().toISOString() }) +
      '\n',
    'utf8',
  )
  // 整个文件读不动（目录冒充 .jsonl）：loadInboxes 的 degraded 必须把它也列出来。
  fs.mkdirSync(path.join(inboxDir, 'k-unreadable.jsonl'), { recursive: true })

  const snap = buildStateSnapshot(ctx, deps, {})
  ok(
    snap.warnings.some((line) => line.includes('队列文件') && line.includes('没有') && line.includes('pending')),
    'F-08：坏行必须并进 warnings，并说明坏行没有计入 pending',
  )
  ok(
    snap.warnings.some((line) => line.includes('k-unreadable.jsonl')),
    'F-08：读不动的队列文件也必须进 warnings（不许静默）',
  )
  ok(snap.totals.pending === 2, `F-08：pending 只数能读的行（期望 2：other:main 1 + brokenqueue 1，实际 ${snap.totals.pending}）`)
}

// 7. F-09：project / global 暂停必须体现在会话行上（与 list_domain_* 同口径，四级 OR 叠加）
{
  writeDomainStateAtomic(
    stateDir,
    'other',
    { paused: true, pausedAt: '2026-10-21T00:00:00.000Z', pausedBy: 'session-presser', note: '项目级暂停' },
    'project',
  )
  writeDomainStateAtomic(
    stateDir,
    '*',
    { paused: true, pausedAt: '2026-10-21T00:00:01.000Z', pausedBy: 'session-boss', note: '全局暂停' },
    'global',
  )
  const snap = buildStateSnapshot(ctx, deps, {})
  ok(
    snap.totals.paused === 3,
    `F-09：totals.paused 应数到三级（session 历史 1 + project 1 + global 1，实际 ${snap.totals.paused}）`,
  )

  const offlineMain = snap.sessions.find((row) => row.id === 'session-offline01')
  ok(!!offlineMain, 'F-09：项目主会话行应存在')
  ok(offlineMain.paused === true, 'F-09：project 暂停必须把该项目的会话行标成 paused（以前只看 session 级）')
  ok(offlineMain.state === '离线·已暂停', `F-09：离线行派生状态应为 离线·已暂停（实际 ${offlineMain.state}）`)
  ok(
    offlineMain.pausedScopes.includes('project') && offlineMain.pausedScopes.includes('global'),
    'F-09：pausedScopes 要如实标出是哪几级按着（project + global）',
  )
  ok(
    Array.isArray(offlineMain.pausedByScopes) && offlineMain.pausedByScopes.some((hit) => hit.scope === 'global'),
    'F-09：pausedByScopes 要给到具体是哪一级、谁按的',
  )

  const liveRow = snap.sessions.find((row) => row.id === liveId)
  ok(liveRow && liveRow.paused === true && liveRow.state === '在线·已暂停', 'F-09：global 暂停必须把在线会话行标成 在线·已暂停')
  ok(liveRow.pausedScopes.includes('global'), 'F-09：在线行也要标出 global')

  // 清理：把这两级恢复，别影响后面的用例。
  writeDomainStateAtomic(stateDir, 'other', { paused: false }, 'project')
  writeDomainStateAtomic(stateDir, '*', { paused: false }, 'global')
}

// 8. F-10：reads.stateDir 必须是真正读盘用的目录（不是恒 null）
{
  const snap = buildStateSnapshot(ctx, deps, {})
  ok(snap.reads.stateDir === stateDir, `F-10：显式配置时 reads.stateDir 应是配置的真实路径（实际 ${snap.reads.stateDir}）`)
  ok(snap.reads.stateDir !== null, 'F-10：reads.stateDir 不许是 null')

  const previousHome = process.env.DSH_DOMAIN_BRIDGE_HOME
  const fakeHome = path.join(root, 'fake-home')
  process.env.DSH_DOMAIN_BRIDGE_HOME = fakeHome
  try {
    const expected = path.join(fakeHome, 'state')
    const defaultSnap = buildStateSnapshot(ctx, { config: { domainsFile, stateDir: '', indexFile } }, {})
    ok(
      defaultSnap.reads.stateDir === expected,
      `F-10：没配 stateDir 时应报解析出来的默认目录（期望 ${expected}，实际 ${defaultSnap.reads.stateDir}）`,
    )
    // 与真正读盘用的目录一致：往同一个默认目录写一条暂停记录，快照必须看得见。
    writeDomainStateAtomic(
      '',
      'defaultdir:probe',
      { paused: true, pausedAt: '2026-10-22T00:00:00.000Z', pausedBy: 'session-probe', note: '默认状态目录探针' },
      'domain',
    )
    const seen = buildStateSnapshot(ctx, { config: { domainsFile, stateDir: '', indexFile } }, {})
    ok(
      seen.totals.paused === 1 && seen.reads.stateDir === expected,
      'F-10：reads.stateDir 必须就是真正读盘用的那个目录（写进去的暂停记录要能看见）',
    )
  } finally {
    if (previousHome === undefined) delete process.env.DSH_DOMAIN_BRIDGE_HOME
    else process.env.DSH_DOMAIN_BRIDGE_HOME = previousHome
  }
}

console.log(`[state] 用例 ${passed} 条全部通过`)
