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

console.log(`[state] 用例 ${passed} 条全部通过`)
