/**
 * dsh-domain-bridge — 会话工作台（hub）的**静态页服务**。
 *
 * 为什么单独一个模块、为什么这么薄（2026-10-24，用户拍板「保持轻耦合，因为体系还会变动」）：
 *   · GUI 本体（工作台 hub、拓扑、三维网络）由 GUI 域独立维护，是**纯 HTML/CSS/JS**，只读 HTTP 数据；
 *   · 插件这一侧只做三件事：按**固定路径**把文件发出去、只允许本机、白名单里没有的一律 404；
 *   · 数据面不在这里——页面自己 `fetch('/api/dsh-domain-bridge/state')`（同一个 webServer），
 *     所以插件改内部结构时页面不用跟着改；反过来页面改视觉时插件也不用动。
 *
 * 目录：`config.spaceDir`（缺省 `<home>/space`）。文件缺了就是**诚实的空态**（告诉人放哪几个文件），
 * 不是 500、也不是假页面——部署没完成时最需要的是"看得懂为什么没东西"。
 */
import fs from 'node:fs'
import path from 'node:path'

const PREFIX = '/api/dsh-domain-bridge'

/**
 * 白名单：名字 → 文件 + content-type。**只认这几个名字**（不接目录、不猜扩展名、不拼用户输入），
 * 这样"目录穿越"在结构上就不可能发生，而不是靠一层一层清洗。
 */
const HUB_FILES = {
  hub: { file: 'hub.html', type: 'text/html; charset=utf-8' },
  network: { file: 'network.html', type: 'text/html; charset=utf-8' },
  topology: { file: 'topology.html', type: 'text/html; charset=utf-8' },
  'space.data.js': { file: 'space.data.js', type: 'text/javascript; charset=utf-8' },
  'space.json': { file: 'space.json', type: 'application/json; charset=utf-8' },
  'state.json': { file: 'state.json', type: 'application/json; charset=utf-8' },
  // v0.8.16：GUI 共用的视觉资产（v9 token / 卡片皮肤）外置成一份 CSS。
  // 必须按 text/css 发：浏览器对 `rel=stylesheet` 的响应做严格 MIME 检查，
  // 发成 application/octet-stream 会**整份样式被丢掉**（实测 cssRules=0，页面看着"没穿衣服"）。
  'v9-tokens.css': { file: 'v9-tokens.css', type: 'text/css; charset=utf-8' },
}

/** 白名单查表（导出给测试用；未知名字 ⇒ null）。 */
export function hubFileDef(name) {
  const key = String(name ?? '').trim()
  return Object.prototype.hasOwnProperty.call(HUB_FILES, key) ? HUB_FILES[key] : null
}

/** 工作台资源目录：显式配置优先，否则 `<home>/space`；都没有 ⇒ ''（调用方回空态）。 */
export function hubDirOf(config) {
  const explicit = config && config.spaceDir ? String(config.spaceDir).trim() : ''
  if (explicit) return explicit
  const home = config && config.home ? String(config.home).trim() : ''
  if (!home) return ''
  return path.join(home, 'space')
}

/** 与 menu.js 同一口径的本机判定（Host 头，挡住跨站 / 非本机访问）。 */
function localOnly(req) {
  const host = String(req?.headers?.host || '').trim().toLowerCase()
  if (!host) return false
  if (host === '[::1]' || host.startsWith('[::1]:')) return true
  return host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host === '127.0.0.1' || host === 'localhost'
}

function send(res, status, body, type) {
  try {
    res.writeHead(status, {
      'content-type': type || 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  } catch {
    try {
      res.end('')
    } catch {
      /* nothing left to do */
    }
  }
}

/** 目录里还没放 GUI 交付物时给的**可执行空态**：说清放哪、放什么、怎么配。 */
function placeholderHtml(dir) {
  const where = dir || '（未配置 spaceDir，且拿不到 <home>）'
  return [
    '<!doctype html><meta charset="utf-8"><title>体系工作台 · 待部署</title>',
    '<style>body{font:14px/1.7 "Microsoft YaHei UI","Segoe UI",system-ui;margin:0;background:#141416;color:#d9dfe2;',
    'display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:640px;padding:32px 28px;',
    'background:#1b1d1f;border:1px solid rgba(255,255,255,.06);border-radius:16px;box-shadow:0 24px 60px -30px #000}',
    'code{background:rgba(255,255,255,.06);padding:1px 5px;border-radius:4px;font:12.5px ui-monospace,Consolas,monospace}',
    'h1{font-size:17px;margin:0 0 10px}p{margin:8px 0;color:#9aa5aa}</style>',
    '<main><h1>工作台还没部署</h1>',
    `<p>插件只负责把文件发出去，GUI 本体在：<code>${where.replace(/[<&]/g, '')}</code></p>`,
    '<p>需要这几个文件（GUI 域交付）：<code>hub.html</code> <code>network.html</code> <code>topology.html</code> ',
    '<code>space.data.js</code> <code>space.json</code></p>',
    '<p>想换目录：在插件配置里写 <code>spaceDir</code>，或把文件放进 <code>&lt;home&gt;/space/</code>。</p>',
    '</main>',
  ].join('')
}

/**
 * 路由表（`kind:'exact'` × 6）。固定名字，**不接受子路径**：
 *   GET /api/dsh-domain-bridge/hub                  → hub.html
 *   GET /api/dsh-domain-bridge/hub/view/network     → network.html
 *   GET /api/dsh-domain-bridge/hub/view/topology    → topology.html
 *   GET /api/dsh-domain-bridge/hub/view/space.data.js
 *   GET /api/dsh-domain-bridge/hub/view/space.json
 *   GET /api/dsh-domain-bridge/hub/view/state.json
 */
export function hubRouteDefs(config) {
  const dir = hubDirOf(config)
  const defs = []
  for (const name of Object.keys(HUB_FILES)) {
    const def = HUB_FILES[name]
    const isHub = name === 'hub'
    defs.push({
      kind: 'exact',
      path: isHub ? `${PREFIX}/hub` : `${PREFIX}/hub/view/${name}`,
      handler: async (req, res) => {
        if (!localOnly(req)) return send(res, 403, 'local-only')
        if (req.method && req.method !== 'GET') return send(res, 405, 'method-not-allowed')
        if (!dir) return send(res, 200, placeholderHtml(dir), 'text/html; charset=utf-8')
        const file = path.join(dir, def.file)
        try {
          const body = fs.readFileSync(file)
          return send(res, 200, body, def.type)
        } catch (error) {
          if (error && error.code === 'ENOENT') {
            if (isHub) return send(res, 200, placeholderHtml(dir), 'text/html; charset=utf-8')
            return send(res, 404, `missing: ${def.file}`)
          }
          return send(res, 500, `unreadable: ${String((error && error.message) || error).replace(/[<&]/g, '')}`)
        }
      },
    })
  }
  return defs
}

/** 把上面 6 条路由挂到 host 的 webServer 上；拿不到服务就安静退化成"没有工作台"。 */
export function registerHubRoutes(ctx, config) {
  const server = typeof ctx?.get === 'function' ? ctx.get('webServer') : null
  if (!server || typeof server.register !== 'function') return () => {}
  const disposers = []
  for (const route of hubRouteDefs(config)) {
    try {
      const dispose = server.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      // 重复路由＝上一次插件实例的路由还占着；重启可清。**不抛**（宿主起不来更糟）。
      console.warn(`[dsh-domain-bridge] hub route "${route.path}" NOT registered: ${error?.message || String(error)}`)
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* keep disposing the rest */
      }
    }
  }
}
