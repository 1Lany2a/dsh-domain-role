// v0.8.5 生命期与诊断——/run 与 /health 在坏掉时（失效实例／重复路由）必须**不静默**、也不自己崩。
// 这一组是「六条命令点了没反应」那个真机故障的回归护栏。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerMenuRoutes, runMenuChoice } from '../lib/core/menu.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-life-'))
const domainsFile = path.join(root, 'domains.json')
fs.writeFileSync(domainsFile, JSON.stringify({ schemaVersion: 1, owners: {}, registrations: {} }, null, 2) + '\n', 'utf8')
const config = { domainsFile, stateDir: path.join(root, 'state') }

let passed = 0
const ok = (cond, message) => { assert.ok(cond, message); passed++ }

/** Minimal response double: collect what the handler wrote. */
function fakeRes() {
  const out = {}
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(body) { out.body = body },
    destroy() { out.destroyed = true },
  }
}

/** Minimal request double: local-only + a JSON body. */
function fakeReq(body) {
  const listeners = {}
  return {
    headers: { host: '127.0.0.1:11860' },
    on(event, fn) { listeners[event] = fn },
    async run() {
      if (listeners.data && body !== undefined) listeners.data(JSON.stringify(body))
      if (listeners.end) listeners.end()
    },
  }
}

function fakeServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

const warnings = []
const realWarn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))

// 1. 三个路由都挂上，并且返回一个能把它们全撤掉的 disposer
{
  const server = fakeServer()
  const dispose = registerMenuRoutes({ get: (name) => (name === 'webServer' ? server : undefined) }, { config, commandDefs: [] })
  ok(server.routes.has('/api/dsh-domain-bridge/health'), 'health 路由应挂上')
  ok(server.routes.has('/api/dsh-domain-bridge/menu'), 'menu 路由应挂上')
  ok(server.routes.has('/api/dsh-domain-bridge/run'), 'run 路由应挂上')
  ok(typeof dispose === 'function', '必须返回 disposer（以前丢掉了 ⇒ 重载后旧死路由永远占位）')
  dispose()
  ok(server.routes.size === 0, 'disposer 必须把路由全撤掉')
}

// 2. 重复路由必须**响亮失败**，不许静默吞掉
{
  warnings.length = 0
  const server = fakeServer()
  const deps = { config, commandDefs: [] }
  registerMenuRoutes({ get: (name) => (name === 'webServer' ? server : undefined) }, deps)
  const second = registerMenuRoutes({ get: (name) => (name === 'webServer' ? server : undefined) }, deps)
  ok(typeof second === 'function', '重复注册也不许抛（插件加载不能被一条坏路由拖死）')
  ok(warnings.some((line) => line.includes('NOT registered')), '重复路由必须留下警告，而不是静默')
}

// 3. /health 在「属性访问会抛」的失效 ctx 上仍要回 200（诊断端点不能自己先崩）
{
  const server = fakeServer()
  registerMenuRoutes(
    {
      get(name) {
        if (name === 'webServer') return server
        if (name === 'commands') return undefined
        if (name === 'agents') return { roots: () => [] }
        return undefined
      },
      // 失效 fiber 上的属性读会直接抛——这正是 /health 以前变空体 400 的原因
      get commands() { throw new Error('cannot get required service "commands" in inactive context') },
      get tools() { throw new Error('cannot get required service "tools" in inactive context') },
    },
    { config, commandDefs: [] },
  )
  const res = fakeRes()
  await server.routes.get('/api/dsh-domain-bridge/health').handler(fakeReq({}), res)
  ok(res.out.status === 200, `health 必须回 200（实际 ${res.out.status}）`)
  const body = JSON.parse(res.out.body)
  ok(body.ok === true, 'health 仍应回报 ok:true')
  ok(body.commandsRegistered === false, '拿不到 commands 时如实报 false')
  ok(body.toolsRegistered === false, '拿不到 tools 时如实报 false')
}

// 4. /run 找不到 commands 服务时，**回落到 in-process handler** 而不是报 inactive context
{
  const definition = { name: 'register', async handler() { return { kind: 'success', text: 'fallback-ok' } } }
  const agent = { id: 'session-life0001' }
  const out = await runMenuChoice(
    { get: (name) => (name === 'agents' ? { get: () => agent } : undefined) },
    { config, commandDefs: [definition] },
    { command: 'register', sessionId: agent.id, input: '' },
  )
  ok(out.ok === true && out.text === 'fallback-ok', '没有 commands 服务时应回落执行，而不是失败')
}

// 5. commands.execute 抛错（失效实例）同样回落，且不把错误当成用户回执
{
  warnings.length = 0
  const definition = { name: 'register', async handler() { return { kind: 'success', text: 'fallback-ok-2' } } }
  const agent = { id: 'session-life0002' }
  const out = await runMenuChoice(
    {
      get(name) {
        if (name === 'agents') return { get: () => agent }
        if (name === 'commands') return { execute: async () => { throw new Error('inactive context') } }
        return undefined
      },
    },
    { config, commandDefs: [definition] },
    { command: 'register', sessionId: agent.id, input: '' },
  )
  ok(out.ok === true && out.text === 'fallback-ok-2', 'execute 抛错时应回落，不能让整条命令失败')
  ok(warnings.some((line) => line.includes('commands.execute failed')), '回落时必须留下警告')
}

// 6. 会话离线时菜单动作明确拒绝（不假装成功）
{
  const out = await runMenuChoice(
    { get: (name) => (name === 'agents' ? { get: () => null } : undefined) },
    { config, commandDefs: [{ name: 'register', async handler() { return { kind: 'success', text: 'x' } } }] },
    { command: 'register', sessionId: 'session-gone', input: '' },
  )
  ok(out.ok === false && out.text.includes('没有活 Agent'), '离线会话必须明确拒绝')
}

console.warn = realWarn
console.log(`[lifecycle] 用例 ${passed} 条全部通过`)
fs.rmSync(root, { recursive: true, force: true })
