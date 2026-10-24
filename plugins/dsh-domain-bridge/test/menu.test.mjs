// v0.8.0 popup menus — host-side option building and the "no live agent" guard.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildMenuOptions, runMenuChoice, registerMenuRoutes } from '../lib/core/menu.js'
import { upsertRegistration } from '../lib/core/registrations.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-menu-'))
const domainsFile = path.join(root, 'domains.json')
const cwd = path.join(root, 'tixiweihu')
fs.mkdirSync(cwd, { recursive: true })
fs.writeFileSync(
  domainsFile,
  JSON.stringify(
    {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      owners: { 'qidongchengxu:asr': { project: 'qidongchengxu', domain: 'asr', sessionId: 'session-owner0001', since: new Date().toISOString(), by: null, note: '' } },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

const config = { domainsFile, stateDir: path.join(root, 'state') }
const deps = { config, commandDefs: [] }
const ctx = { get: () => undefined, agents: { get: () => null } }
const sessionId = 'session-menu0001'
let passed = 0
const ok = (cond, message) => { assert.ok(cond, message); passed++ }

// 1. register menu carries all three layers plus existing domains
{
  const out = buildMenuOptions(ctx, deps, { command: 'register', sessionId, cwd })
  ok(out.ok === true, 'register menu 应成功')
  const ids = out.options.map((o) => o.id)
  const system = out.options.find((o) => o.id.startsWith('system'))
  ok(!!system, 'register 菜单应有 system')
  ok(system.id === 'system --confirm' && system.confirmation, '缺体系口径源时体系主选项应带一次确认')
  ok(ids.includes('project'), 'register 菜单应有 project')
  ok(ids.includes('domain qidongchengxu:asr takeover'), 'register 菜单应列出可继承的域')
  const takeover = out.options.find((o) => o.id === 'domain qidongchengxu:asr takeover')
  ok(takeover.confirmation && takeover.confirmation.confirmLabel, '接管域必须带二次确认')
  ok(out.options.every((o) => typeof o.label === 'string' && o.label.length > 0), '每个选项都要有 label')
}

// 2. pause menu reflects missing authority instead of hiding it（v0.8.5 起多了「按域」一组）
{
  const out = buildMenuOptions(ctx, deps, { command: 'pause', sessionId, cwd })
  const ids = out.options.map((o) => o.id)
  ok(ids.includes('domain qidongchengxu:asr'), 'pause 菜单应列出可暂停的域')
  ok(ids.includes('self') && ids.includes('project') && ids.includes('global'), 'pause 菜单仍要有 self/project/global')
  const project = out.options.find((o) => o.id === 'project')
  ok(project && project.detail.includes('会被拒绝'), '无身份时项目档应如实说明会被拒绝')
  const domainRow = out.options.find((o) => o.id === 'domain qidongchengxu:asr')
  ok(!domainRow.confirmation, '按域暂停是可逆动作，不需要确认')
}

// 2b. v0.8.5（菜单 A）：所有行都要带分组标题，且除「新域」那条提示外都是可直接执行的动作
{
  for (const command of ['register', 'initialize', 'handoff', 'retire', 'pause', 'pause-all']) {
    const out = buildMenuOptions(ctx, deps, { command, sessionId, cwd })
    ok(out.ok === true, `${command} 菜单应成功`)
    ok(out.options.length > 0, `${command} 菜单不能为空`)
    ok(out.options.every((o) => o.group && typeof o.group.label === 'string'), `${command} 每一行都要有分组标题`)
  }
}

// 3. pause-all asks for confirmation on project/global
{
  const out = buildMenuOptions(ctx, deps, { command: 'pause-all', sessionId, cwd })
  const project = out.options.find((o) => o.id.startsWith('project'))
  const global = out.options.find((o) => o.id.startsWith('global'))
  ok(project.confirmation && global.confirmation, '强制暂停项目/全局都必须带确认')
  ok(!out.options.find((o) => o.id.startsWith('self')).confirmation, '暂停自己不需要确认')
}

// 4. retire is confirmable and initialize/handoff expose their choices
{
  ok(buildMenuOptions(ctx, deps, { command: 'retire', sessionId, cwd }).options[0].confirmation, '退役必须带确认')
  ok(buildMenuOptions(ctx, deps, { command: 'initialize', sessionId, cwd }).options.some((o) => o.id === 'check'), 'initialize 应有 check')
  ok(buildMenuOptions(ctx, deps, { command: 'handoff', sessionId, cwd }).options.length >= 2, 'handoff 应给出两档以上')
}

// 5. identity-aware details come from the registration book
{
  upsertRegistration(domainsFile, { key: 'tixiweihu:system', layer: 'system', project: 'tixiweihu', domain: 'system', sessionId, since: new Date().toISOString(), by: sessionId, title: '', note: '' })
  const out = buildMenuOptions(ctx, deps, { command: 'pause', sessionId, cwd })
  ok(out.options.find((o) => o.id === 'global').detail.includes('有权'), '体系主会话应看到 global 有权')
}

// 6. unknown command and offline session
{
  ok(buildMenuOptions(ctx, deps, { command: 'nope', sessionId, cwd }).ok === false, '未知命令应报错')
  const withDef = { ...deps, commandDefs: [{ name: 'register', async handler() { return { kind: 'success', text: 'should-not-run' } } }] }
  const run = await runMenuChoice(ctx, withDef, { command: 'register', sessionId, input: '' })
  ok(run.ok === false && run.text.includes('没有活 Agent'), '会话离线时菜单动作应拒绝')
}

// 7. 有体系口径源后，体系主选项不再要确认（id 回到 system）
{
  fs.writeFileSync(path.join(cwd, 'SYSTEM-OVERVIEW.md'), '# marker\n', 'utf8')
  const out = buildMenuOptions(ctx, deps, { command: 'register', sessionId, cwd })
  const system = out.options.find((o) => o.id === 'system')
  ok(!!system && !system.confirmation, '有 SYSTEM-OVERVIEW.md 时不需要二次确认')
  ok(system.active === true, '自己已在任应标 active')
}

// 8. resume 菜单只列**真的被按下的**那些，并按层级给出恢复行
{
  const { writeDomainStateAtomic } = await import('../lib/core/pause.js')
  writeDomainStateAtomic(config.stateDir, 'qidongchengxu:asr', { paused: true, pausedAt: new Date().toISOString(), pausedBy: 'sess-presser', note: '注入风险，先停住' }, 'domain')
  writeDomainStateAtomic(config.stateDir, sessionId, { paused: true, pausedAt: new Date().toISOString(), pausedBy: sessionId, note: '自己这一级' }, 'session')
  const out = buildMenuOptions(ctx, deps, { command: 'resume', sessionId, cwd })
  const ids = out.options.map((o) => o.id)
  ok(ids.includes('domain qidongchengxu:asr'), 'resume 应列出被按下的域')
  ok(ids.includes('self'), '自己那一级被按下时应给出 self')
  ok(out.options.find((o) => o.id === '').detail.includes('2'), '只读行应报告被按下的条数')
  ok(out.options.find((o) => o.id === 'domain qidongchengxu:asr').detail.includes('注入风险'), '恢复行应带暂停备注')
  ok(ids.every((id) => typeof id === 'string'), '恢复行的 id 必须能直接当命令参数')
}

// 9. handoff 菜单把"前任要不要当场退役"变成一次显式选择
{
  const out = buildMenuOptions(ctx, deps, { command: 'handoff', sessionId, cwd })
  const row = out.options.find((o) => o.id === 'retire=now')
  ok(!!row, 'handoff 应有「建完立刻退役我」那一行')
  ok(row.confirmation && row.confirmation.confirmLabel, '一步到位必须带确认')
  ok(out.options.some((o) => o.group.name === 'then'), '它应落在「建完之后」分组里')
}
// 10. v0.8.6：别人在任时，"接手"那一行必须真的带 takeover（以前弹了确认却执行 /register → 必撞冲突）
{
  upsertRegistration(domainsFile, { key: 'tixiweihu:system', layer: 'system', project: 'tixiweihu', domain: 'system', sessionId: 'session-other0001', since: new Date().toISOString(), by: 'session-other0001', title: '', note: '' }, { force: true })
  const out = buildMenuOptions(ctx, deps, { command: 'register', sessionId, cwd })
  const sys = out.options.find((o) => o.id.startsWith('system'))
  ok(!!sys, 'register 菜单应有体系层那一行')
  ok(sys.id.includes('takeover'), `接手行的 id 必须带 takeover（实际 ${sys.id}）`)
  ok(sys.confirmation && sys.confirmation.confirmLabel, '接手仍要带确认浮层')
  const proj = out.options.find((o) => o.id.startsWith('project'))
  ok(!proj.id.includes('takeover'), '项目层没人占时不该带 takeover')
}

// 11. F-11 / F-12：真跑 registerMenuRoutes 注册的 handler —— Host 闸（IPv6 本机）与请求体上限
{
  const routes = new Map()
  const fakeServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const routeCtx = {
    get(name) {
      if (name === 'webServer') return fakeServer
      if (name === 'agents') return { get: () => null }
      return undefined
    },
  }
  const dispose = registerMenuRoutes(routeCtx, deps)
  ok(typeof dispose === 'function', 'registerMenuRoutes 应返回 disposer')
  ok(routes.has('/api/dsh-domain-bridge/menu') && routes.has('/api/dsh-domain-bridge/run'), '菜单路由应挂上 menu/run')

  const makeReq = (host, chunks) => {
    const handlers = {}
    const req = {
      headers: { host },
      url: '/',
      on(event, fn) {
        handlers[event] = fn
        return req
      },
    }
    // 像真的流一样：订阅完成后才吐数据。
    setTimeout(() => {
      for (const chunk of chunks) handlers.data?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
      handlers.end?.()
    }, 0)
    return req
  }
  const makeRes = () => {
    const res = { status: null, body: '' }
    res.writeHead = (status) => {
      res.status = status
    }
    res.end = (body) => {
      res.body = String(body ?? '')
    }
    return res
  }
  const post = async (path, host, bodyText) => {
    const res = makeRes()
    await routes.get(path)(makeReq(host, [bodyText]), res)
    return res
  }

  const small = JSON.stringify({ command: 'pause', sessionId })
  for (const host of ['127.0.0.1:8652', 'localhost:8652', '[::1]:8652', '[::1]']) {
    const res = await post('/api/dsh-domain-bridge/menu', host, small)
    ok(res.status === 200, `F-11：本机 Host「${host}」应放行（实际 ${res.status}）`)
  }
  for (const host of ['evil.example:8652', '192.168.1.5:8652', 'localhost.attacker.example:8652', '']) {
    const res = await post('/api/dsh-domain-bridge/menu', host, small)
    ok(res.status === 403, `F-11：非本机 Host「${host}」必须拒绝（实际 ${res.status}）`)
  }

  const big = JSON.stringify({ command: 'pause', sessionId, pad: 'x'.repeat(70000) })
  const tooLarge = await post('/api/dsh-domain-bridge/menu', '127.0.0.1:8652', big)
  ok(tooLarge.status === 413, `F-12：>64KB 请求体应回 413（实际 ${tooLarge.status}）`)
  let rejected = null
  try {
    rejected = JSON.parse(tooLarge.body)
  } catch {
    rejected = null
  }
  ok(
    rejected && rejected.ok === false && rejected.reason === 'body-too-large',
    'F-12：应明确回 ok:false + reason:body-too-large',
  )
  ok(!String(tooLarge.body).includes('unknown-command'), 'F-12：不能把截断内容当命令解析成「未知命令」')

  const runTooLarge = await post('/api/dsh-domain-bridge/run', '127.0.0.1:8652', big)
  ok(runTooLarge.status === 413, '/run 也必须回 413（三条读 body 的路由同一口径）')

  // 正常大小的请求体不受影响（别把上限做成"一律拒绝"）。
  const nearLimit = JSON.stringify({ command: 'pause', sessionId, pad: '' })
  const nearRes = await post('/api/dsh-domain-bridge/menu', '127.0.0.1:8652', nearLimit)
  ok(nearRes.status === 200, '正常大小的请求体不受影响')

  dispose()
  ok(!routes.has('/api/dsh-domain-bridge/menu'), 'disposer 应摘掉路由')
}

console.log(`[menu] 用例 ${passed} 条全部通过`)