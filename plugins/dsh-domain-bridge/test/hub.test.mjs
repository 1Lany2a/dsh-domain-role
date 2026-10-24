// v0.8.15 工作台（hub）静态页服务 —— 白名单、本机限制、缺文件时的诚实空态。
// 不起服务器：直接拿 route handler 喂假的 req/res。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hubFileDef, hubDirOf, hubRouteDefs, registerHubRoutes } from '../lib/core/hub.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-'))
let passed = 0
const ok = (cond, message) => {
  assert.ok(cond, message)
  passed += 1
}

/** 假 res：把 status / headers / body 收起来，供断言。 */
function fakeRes() {
  const out = { status: null, headers: null, body: null }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers || {}
    },
    end(body) {
      out.body = body === undefined ? '' : body
    },
  }
}

const LOCAL = { headers: { host: '127.0.0.1:3048' }, method: 'GET' }
const remote = (host) => ({ headers: { host }, method: 'GET' })

// 1. 白名单：只认那六个名字，别的一律 null（目录穿越在结构上不可能）
{
  for (const name of ['hub', 'network', 'topology', 'space.data.js', 'space.json', 'state.json']) {
    ok(hubFileDef(name) !== null, `${name} 应在白名单里`)
  }
  for (const name of ['', '../hub.html', 'hub/../secret', 'hub.html', 'HUB', null]) {
    ok(hubFileDef(name) === null, `${String(name)} 不该在白名单里`)
  }
  ok(hubFileDef('hub').type.startsWith('text/html'), 'hub 的 content-type 应是 html')
  ok(hubFileDef('space.json').type.startsWith('application/json'), 'space.json 的 content-type 应是 json')
}

// 2. 目录优先级：显式 spaceDir > <home>/space > ''（拿不到就不猜路径）
{
  ok(hubDirOf({ spaceDir: 'D:\\x\\y', home: 'D:\\x' }) === 'D:\\x\\y', '显式 spaceDir 优先')
  ok(hubDirOf({ home: path.join(root, 'home') }) === path.join(root, 'home', 'space'), '缺省 <home>/space')
  ok(hubDirOf({}) === '', '既没 spaceDir 也没 home ⇒ 空串（不猜）')
}

// 3. 路由表：6 条 exact，路径固定（不接子路径）
{
  const routes = hubRouteDefs({ spaceDir: path.join(root, 'empty') })
  ok(routes.length === 6, `应有 6 条路由（实际 ${routes.length}）`)
  ok(
    routes.every((route) => route.kind === 'exact' && typeof route.handler === 'function'),
    '每条都必须 exact + 有 handler',
  )
  const paths = routes.map((route) => route.path).sort()
  ok(paths.includes('/api/dsh-domain-bridge/hub'), '要有 /hub')
  ok(paths.includes('/api/dsh-domain-bridge/hub/view/network'), '要有 /hub/view/network')
  ok(paths.includes('/api/dsh-domain-bridge/hub/view/topology'), '要有 /hub/view/topology')
  ok(paths.includes('/api/dsh-domain-bridge/hub/view/space.data.js'), '要有 space.data.js')
  ok(paths.includes('/api/dsh-domain-bridge/hub/view/space.json'), '要有 space.json')
  ok(!paths.some((item) => item.includes('..')), '路径里不许出现 ..')
}

const dir = path.join(root, 'space')
fs.mkdirSync(dir, { recursive: true })
const routes = hubRouteDefs({ spaceDir: dir })
const routeOf = (name) => routes.find((route) => route.path.endsWith(name === 'hub' ? '/hub' : `/view/${name}`))

// 4. 空目录：hub 回**可执行空态**（200 + 说清放什么），其它文件 404
{
  const res = fakeRes()
  await routeOf('hub').handler({ ...LOCAL }, res)
  ok(res.out.status === 200, '缺 hub.html 时仍是 200（要给人看得懂的空态）')
  ok(String(res.out.body).includes('待部署'), '空态要说明还没部署')
  ok(String(res.out.body).includes('hub.html'), '空态要点名需要哪些文件')
  ok(res.out.headers['cache-control'] === 'no-store', '一律 no-store（不然改完看不到）')

  const miss = fakeRes()
  await routeOf('network').handler({ ...LOCAL }, miss)
  ok(miss.out.status === 404, 'network.html 缺席应是 404（不是假页面）')
}

// 5. 文件就位：按白名单发出去，content-type 正确
{
  fs.writeFileSync(path.join(dir, 'hub.html'), '<!doctype html><title>hub</title>', 'utf8')
  fs.writeFileSync(path.join(dir, 'network.html'), '<!doctype html><title>net</title>', 'utf8')
  fs.writeFileSync(path.join(dir, 'space.data.js'), 'window.SPACE={}', 'utf8')
  fs.writeFileSync(path.join(dir, 'space.json'), '{"nodes":[]}', 'utf8')
  const hub = fakeRes()
  await routeOf('hub').handler({ ...LOCAL }, hub)
  ok(hub.out.status === 200 && String(hub.out.body).includes('<title>hub</title>'), '已有 hub.html 要原样发出')
  ok(String(hub.out.headers['content-type']).includes('text/html'), 'content-type 应是 html')

  const js = fakeRes()
  await routeOf('space.data.js').handler({ ...LOCAL }, js)
  ok(String(js.out.headers['content-type']).includes('javascript'), 'space.data.js 应是 javascript')
  const json = fakeRes()
  await routeOf('space.json').handler({ ...LOCAL }, json)
  ok(String(json.out.headers['content-type']).includes('application/json'), 'space.json 应是 json')
}

// 6. 本机限制 + 方法限制：跨站 / 非本机 / 非 GET 都不给文件
{
  const evil = fakeRes()
  await routeOf('hub').handler(remote('evil.example.com'), evil)
  ok(evil.out.status === 403, 'Host 不是本机 ⇒ 403')

  const post = fakeRes()
  await routeOf('hub').handler({ headers: { host: 'localhost:3048' }, method: 'POST' }, post)
  ok(post.out.status === 405, '非 GET ⇒ 405')

  const v6 = fakeRes()
  await routeOf('hub').handler(remote('[::1]:3048'), v6)
  ok(v6.out.status === 200, '[::1] 应放行（与其它路由同一口径）')
}

// 7. 没有 webServer 也不能抛（插件照常加载，只是没有工作台）
{
  const dispose = registerHubRoutes({ get: () => undefined }, { spaceDir: dir })
  ok(typeof dispose === 'function', '拿不到 webServer 也要回一个可调用的 disposer')
  const registered = []
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (route) => (registered.push(route), () => {}) } : undefined),
  }
  const dispose2 = registerHubRoutes(ctx, { spaceDir: dir })
  ok(registered.length === 6, `应注册 6 条路由（实际 ${registered.length}）`)
  dispose2()
  ok(true, 'disposer 可调用且不抛')
}

console.log(`[hub] 用例 ${passed} 条全部通过`)
fs.rmSync(root, { recursive: true, force: true })
