/**
 * dsh-domain-bridge — browser half.
 *
 * Seven Host commands keep the `/free-search-engine` style popup menu. `/handoff` is special:
 * a popup cannot hold a multi-level form (the Host popup closes on the first pick), so the
 * bare `/handoff` token now runs an `action` that mounts a full-screen panel inside the
 * `shell.overlay` slot. The panel is an accordion — identity / preset / model / permission /
 * title+task — reads its initial values from `POST /handoff-wizard/data`, and submits through
 * the SAME handler as the typed command (`POST /handoff-wizard/run` → `invocation.params`).
 * The old local HTML page remains as a fallback link (“用旧版网页设置”).
 *
 * Contract notes (checked against the Host packages, 2026-10-23):
 *   · commandUi.decorate({ name, available, ui:{ kind:'action', run(session) } })
 *     → ui-commands `invoke()` consumes the token and calls `ui.run(session)`.
 *   · ctx.slots.inject('shell.overlay', () => ctx.slots.register({...}, Component))
 *     → the layout renders `renderSlot("shell.overlay", {})` in a pointer-events:none layer.
 */
window.__ModuleLoader__.load({
  id: 'dsh-domain-bridge',
  factory(require) {
    const PREFIX = '/api/dsh-domain-bridge'

    const SPECS = [
      { name: 'register' },
      { name: 'initialize' },
      { name: 'handoff' },
      { name: 'retire' },
      { name: 'pause' },
      { name: 'resume' },
      { name: 'pause-all' },
    ]

    async function post(path, payload) {
      const response = await fetch(`${PREFIX}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(`bridge ${path} ${response.status}`)
      return response.json()
    }

    /**
     * v0.8.9：「打开分步表单」必须由**客户端**自己开窗，不能指望回执。
     *
     * 宿主弹窗壳把 `onSelect` 的返回值**整个丢掉**（ui-commands 的 `PopupSelectController.settle`
     * 只看它抛不抛错，然后关壳、把焦点还给输入框）⇒ 回执里只有一句话/一个地址的动作，在界面上
     * 等于"点了没反应"（用户 2026-10-22 报的就是这条：点「逐项设置参数」什么都不出）。
     *
     * 两点讲究：
     *   ① 地址由客户端按同一份路由拼（`<origin>/api/dsh-domain-bridge/handoff-wizard?sessionId=…`），
     *      不去解析回执文本——回执在这个壳里根本显示不出来。
     *   ② **必须在任何 await 之前**调 `window.open`：用户手势一过期，浏览器就当 popup 拦掉。
     * 桌面端主窗口对 http(s) 的 `window.open` 是 `shell.openExternal`（app.asar 的
     * setWindowOpenHandler），所以这一下＝用系统默认浏览器打开表单。
     *
     * 现在它是面板里的「用旧版网页设置」入口，也是 `shell.overlay` 不可用时的退路。
     */
    function openHandoffWizard(sessionId) {
      const url = `${location.origin}${PREFIX}/handoff-wizard?sessionId=${encodeURIComponent(sessionId)}`
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch (error) {
        console.warn('[dsh-domain-bridge] 打不开分步表单：', error)
      }
      return url
    }

    function sessionIdOf(session) {
      return session && session.sessionId ? String(session.sessionId) : ''
    }

    /* @handoff-panel:start — 纯 DOM 面板（预览页会原样抽走这一段，所以别在里面依赖 React） */

    const PANEL_CSS = `
.dbhp-host{position:fixed;inset:0;z-index:40;pointer-events:none;--dbhp-sans:-apple-system,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif;--dbhp-mono:ui-monospace,"Cascadia Mono",Consolas,"SF Mono","Liberation Mono",monospace;--dbhp-r:10px;--dbhp-bg:#faf6ee;--dbhp-card:#fffdf8;--dbhp-well:#f3ecdf;--dbhp-well-hover:#efe6d6;--dbhp-line:#ded4bf;--dbhp-line-soft:rgba(72,60,45,.10);--dbhp-fg:#2b2620;--dbhp-dim:#766d5f;--dbhp-dim2:#9d9384;--dbhp-accent:#4e7461;--dbhp-accent-soft:rgba(78,116,97,.08);--dbhp-accent-line:rgba(78,116,97,.35);--dbhp-on-accent:#fffdf8;--dbhp-danger:#9c3f2e;--dbhp-mask:rgba(58,48,36,.30);--dbhp-shadow:0 30px 74px -46px rgba(92,76,54,.5),0 0 0 1px rgba(255,255,255,.55) inset}
body[data-ds-dark-theme] .dbhp-host{--dbhp-r:6px;--dbhp-bg:#161a1c;--dbhp-card:#131716;--dbhp-well:rgba(20,24,23,.62);--dbhp-well-hover:rgba(28,33,32,.72);--dbhp-line:#242b28;--dbhp-line-soft:rgba(216,226,222,.075);--dbhp-fg:#d7dfe0;--dbhp-dim:#879396;--dbhp-dim2:#5f6d72;--dbhp-accent:#6ea79a;--dbhp-accent-soft:rgba(110,167,154,.07);--dbhp-accent-line:rgba(110,167,154,.30);--dbhp-on-accent:#0c1210;--dbhp-danger:#c56b5a;--dbhp-mask:rgba(5,7,7,.58);--dbhp-shadow:0 34px 80px -46px rgba(0,0,0,.98),0 0 0 1px rgba(255,255,255,.015) inset}
.dbhp-backdrop{position:fixed;inset:0;pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dbhp-mask);-webkit-backdrop-filter:blur(10px) saturate(.92);backdrop-filter:blur(10px) saturate(.92);animation:dbhp-fade .16s ease-out}
.dbhp-backdrop[hidden]{display:none}
.dbhp-panel{box-sizing:border-box;width:min(760px,100%);max-height:min(86vh,780px);display:flex;flex-direction:column;background:var(--dbhp-card);color:var(--dbhp-fg);border:1px solid var(--dbhp-line);border-radius:var(--dbhp-r);box-shadow:var(--dbhp-shadow);font-family:var(--dbhp-sans);font-size:12.5px;line-height:1.5;overflow:hidden;user-select:text;animation:dbhp-rise .18s cubic-bezier(.2,.7,.3,1)}
.dbhp-panel:focus{outline:none}
.dbhp-head{display:flex;align-items:flex-start;gap:10px;padding:14px 14px 10px}
.dbhp-head-text{min-width:0;flex:1}
.dbhp-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.02em;line-height:1.3}
.dbhp-sub{margin:3px 0 0;font-size:11.5px;color:var(--dbhp-dim2);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbhp-head-actions{flex:none;display:flex;align-items:center;gap:8px;margin-left:auto}
.dbhp-x{flex:none;width:26px;height:26px;padding:0;display:flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:5px;background:none;color:var(--dbhp-dim);font:inherit;font-size:18px;line-height:1;cursor:pointer}
.dbhp-x:hover{color:var(--dbhp-fg);border-color:var(--dbhp-line);background:var(--dbhp-well)}
.dbhp-search{display:flex;align-items:center;gap:8px;padding:0 14px 10px;border-bottom:1px solid var(--dbhp-line-soft)}
.dbhp-search-input{flex:1;min-width:0;box-sizing:border-box;padding:7px 10px;border:1px solid var(--dbhp-line-soft);border-radius:5px;background:var(--dbhp-well);color:var(--dbhp-fg);font:inherit;font-size:12.5px;outline:none}
.dbhp-search-input::placeholder{color:var(--dbhp-dim2)}
.dbhp-search-input::-webkit-search-cancel-button,.dbhp-search-input::-webkit-search-decoration{-webkit-appearance:none;appearance:none;display:none}
.dbhp-search-input:focus{border-color:var(--dbhp-accent-line)}
.dbhp-search-input:disabled{opacity:.45;cursor:not-allowed}
.dbhp-search-count{min-width:58px;text-align:right;font-size:11px;color:var(--dbhp-dim2);font-variant-numeric:tabular-nums;white-space:nowrap}
.dbhp-search-clear{padding:2px 7px;border:1px solid var(--dbhp-line);border-radius:4px;background:none;color:var(--dbhp-dim);font:inherit;font-size:11px;cursor:pointer}
.dbhp-search-clear:hover{color:var(--dbhp-fg);background:var(--dbhp-well)}
.dbhp-search-clear[hidden]{display:none}
.dbhp-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dbhp-line2,var(--dbhp-line)) transparent}
.dbhp-body::-webkit-scrollbar{width:9px}
.dbhp-body::-webkit-scrollbar-thumb{background:var(--dbhp-line);border-radius:8px;border:3px solid var(--dbhp-card)}
.dbhp-state{margin:0;padding:34px 18px;text-align:center;color:var(--dbhp-dim);font-size:12.5px}
.dbhp-state-error{padding:22px 18px;color:var(--dbhp-danger);text-align:left;line-height:1.65}
.dbhp-state-error[hidden],.dbhp-state[hidden],.dbhp-rows[hidden]{display:none}
.dbhp-retry{margin-top:10px;padding:5px 12px;border:1px solid var(--dbhp-line);border-radius:5px;background:none;color:var(--dbhp-fg);font:inherit;font-size:12px;cursor:pointer}
.dbhp-retry:hover{background:var(--dbhp-well)}
.dbhp-rows{display:flex;flex-direction:column}
.dbhp-row{border-bottom:1px solid var(--dbhp-line-soft)}
.dbhp-row:last-child{border-bottom:0}
.dbhp-row-head{box-sizing:border-box;width:100%;display:grid;grid-template-columns:20px minmax(96px,auto) minmax(0,1fr) 14px;align-items:center;gap:10px;height:44px;padding:0 14px;border:0;background:none;color:var(--dbhp-fg);font:inherit;text-align:left;cursor:pointer}
.dbhp-row-head:hover{background:var(--dbhp-well)}
.dbhp-row-head:focus-visible{outline:none;box-shadow:inset 0 0 0 1px var(--dbhp-accent-line)}
.dbhp-row-no{font-size:11px;color:var(--dbhp-dim2);font-variant-numeric:tabular-nums}
.dbhp-row-title{font-size:13px;font-weight:500;letter-spacing:.01em;white-space:nowrap}
.dbhp-row-summary{min-width:0;text-align:right;color:var(--dbhp-dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbhp-caret{width:6px;height:6px;border-right:1px solid var(--dbhp-dim);border-bottom:1px solid var(--dbhp-dim);transform:rotate(45deg) translate(-1px,-1px);transition:transform .16s ease}
.dbhp-row.is-open .dbhp-caret{transform:rotate(225deg) translate(-1px,-1px)}
.dbhp-row.is-open .dbhp-row-head{background:var(--dbhp-well)}
.dbhp-row-body{padding:2px 14px 12px}
.dbhp-row-body[hidden]{display:none}
.dbhp-opts{display:flex;flex-direction:column;gap:2px}
.dbhp-opt{box-sizing:border-box;width:100%;display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border:1px solid transparent;border-radius:4px;background:none;color:var(--dbhp-fg);font:inherit;text-align:left;cursor:pointer}
.dbhp-opt:hover{background:var(--dbhp-well-hover)}
.dbhp-opt.is-sel{border-color:var(--dbhp-accent-line);background:var(--dbhp-accent-soft)}
.dbhp-tick{flex:none;width:13px;margin-top:1px;color:var(--dbhp-accent);font-size:11px;font-weight:700;line-height:1.45}
.dbhp-opt-text{min-width:0;display:flex;flex-direction:column;gap:1px}
.dbhp-opt-label{font-size:12.5px;line-height:1.45;overflow-wrap:anywhere}
.dbhp-opt-detail{font-size:11.5px;line-height:1.45;color:var(--dbhp-dim);overflow-wrap:anywhere}
.dbhp-empty{padding:8px 9px;color:var(--dbhp-dim2);font-size:12px}
.dbhp-hint{margin-top:7px;color:var(--dbhp-dim2);font-size:11.5px;line-height:1.6}
.dbhp-manual{display:flex;align-items:center;gap:6px;margin-top:8px}
.dbhp-manual-input{flex:1;min-width:0;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dbhp-line-soft);border-radius:4px;background:var(--dbhp-well);color:var(--dbhp-fg);font:inherit;font-size:12px;outline:none}
.dbhp-manual-input::placeholder{color:var(--dbhp-dim2)}
.dbhp-manual-input:focus{border-color:var(--dbhp-accent-line)}
.dbhp-manual-btn{flex:none;padding:5px 10px;border:1px solid var(--dbhp-line);border-radius:4px;background:none;color:var(--dbhp-dim);font:inherit;font-size:11.5px;cursor:pointer}
.dbhp-manual-btn:hover{color:var(--dbhp-fg);background:var(--dbhp-well-hover)}
.dbhp-label{display:block;margin:10px 0 5px;color:var(--dbhp-dim);font-size:11.5px}
.dbhp-label:first-child{margin-top:2px}
.dbhp-input,.dbhp-textarea{box-sizing:border-box;width:100%;padding:7px 9px;border:1px solid var(--dbhp-line-soft);border-radius:4px;background:var(--dbhp-well);color:var(--dbhp-fg);font:inherit;font-size:12.5px;outline:none}
.dbhp-input:focus,.dbhp-textarea:focus{border-color:var(--dbhp-accent-line)}
.dbhp-textarea{min-height:100px;line-height:1.6;resize:vertical;font-size:12px}
.dbhp-counter{display:block;margin-top:4px;text-align:right;color:var(--dbhp-dim2);font-size:11px;font-variant-numeric:tabular-nums}
.dbhp-collapse{margin-top:10px;padding:5px 12px;border:1px solid var(--dbhp-line);border-radius:4px;background:none;color:var(--dbhp-dim);font:inherit;font-size:11.5px;cursor:pointer}
.dbhp-collapse:hover{color:var(--dbhp-fg);background:var(--dbhp-well)}
.dbhp-foot{display:flex;align-items:flex-end;gap:12px;padding:11px 14px 12px;border-top:1px solid var(--dbhp-line-soft);background:var(--dbhp-card)}
.dbhp-foot-left{min-width:0;flex:1;display:flex;flex-direction:column;gap:4px}
.dbhp-status{min-width:0;max-height:78px;overflow-y:auto;color:var(--dbhp-dim);font-size:11.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;scrollbar-width:thin}
.dbhp-status[hidden]{display:none}
.dbhp-status-line{white-space:pre-wrap;overflow-wrap:anywhere}
.dbhp-status.is-ok .dbhp-status-line{color:var(--dbhp-accent);font-weight:500}
.dbhp-status.is-err .dbhp-status-line{color:var(--dbhp-danger)}
.dbhp-status.is-busy .dbhp-status-line{color:var(--dbhp-dim2)}
.dbhp-receipt{margin-top:5px}
.dbhp-receipt summary{cursor:pointer;color:var(--dbhp-dim2);font-size:11px;list-style:none}
.dbhp-receipt summary::-webkit-details-marker{display:none}
.dbhp-receipt summary:before{content:"› ";display:inline-block;transition:transform .15s ease}
.dbhp-receipt[open] summary:before{transform:rotate(90deg)}
.dbhp-receipt pre{max-height:120px;margin:5px 0 0;padding:7px 8px;border:1px solid var(--dbhp-line-soft);border-radius:4px;background:var(--dbhp-well);color:var(--dbhp-dim);font-family:var(--dbhp-mono);font-size:10.5px;line-height:1.5;white-space:pre-wrap;overflow:auto}
.dbhp-legacy{padding:0;border:0;background:none;color:var(--dbhp-dim2);font:inherit;font-size:11px;text-decoration:underline dotted;text-underline-offset:2px;cursor:pointer;white-space:nowrap}
.dbhp-legacy:hover{color:var(--dbhp-fg)}
.dbhp-primary{flex:none;padding:8px 16px;border:1px solid var(--dbhp-accent);border-radius:5px;background:var(--dbhp-accent);color:var(--dbhp-on-accent);font:inherit;font-size:12.5px;font-weight:600;letter-spacing:.01em;cursor:pointer}
.dbhp-primary:hover{filter:brightness(1.06)}
.dbhp-primary:focus-visible{outline:2px solid var(--dbhp-accent-line);outline-offset:2px}
.dbhp-primary:disabled{opacity:.45;cursor:not-allowed;filter:none}
@keyframes dbhp-fade{from{opacity:0}to{opacity:1}}
@keyframes dbhp-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){.dbhp-backdrop,.dbhp-panel{animation:none}.dbhp-caret{transition:none}}
@media (max-width:720px){.dbhp-backdrop{padding:10px}.dbhp-panel{max-height:92vh}.dbhp-head{padding:12px 12px 9px}.dbhp-search{padding:0 12px 9px}.dbhp-row-head{grid-template-columns:18px minmax(78px,auto) minmax(0,1fr) 12px;padding:0 12px}.dbhp-row-body{padding:2px 12px 12px}.dbhp-foot{padding:10px 12px 11px}}
`

    function escapeHtml(value) {
      return String(value === undefined || value === null ? '' : value).replace(
        /[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
      )
    }

    function shortSessionIdOf(value) {
      const match = String(value || '').match(
        /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      )
      if (!match) return ''
      return `sess-${match[0].slice('session-'.length, 'session-'.length + 8).toLowerCase()}`
    }

    function shortCreatedOf(text) {
      const raw = String(text || '')
      const fenced = raw.match(/```json\s*([\s\S]*?)```/)
      if (fenced) {
        try {
          const parsed = JSON.parse(fenced[1])
          const id = parsed && (parsed.sessionId || parsed.session || parsed.id)
          if (typeof id === 'string' && id) return shortSessionIdOf(id)
        } catch {
          /* the receipt is not JSON: fall through to the generic scan */
        }
      }
      return shortSessionIdOf(raw)
    }

    /**
     * 第一轮禁开工：面板里「标题与开工任务」的默认文案（固定短模板，≤300 字）。
     * 只把尖括号里的两个占位（键、上一任 sessionId）换成实际值，其余原文不动。
     */
    function buildHandoffTask(key, sessionId) {
      return (
        '你接手了 ' +
        key +
        '。本轮只做四件事：① 裸跑 `/register` 核对在任身份；② 只读 `D:\\xiangmu\\PROJECT.md` 的 §当前状态 与 §下一步 各前 3 条' +
        '（**不要读整份、不要读 changelog/INDEX/handoff.json/projectlog**）；③ 用 `send_to_domain target=' +
        sessionId +
        '` 回报三行：我核到的身份 / 卡里的下一步 / 需要人拍板的点；④ **本轮不改任何文件、不开工**，等指示后再动。'
      )
    }

    const PANEL_SECTIONS = [
      { id: 'identity', no: '①', title: '交接身份' },
      { id: 'preset', no: '②', title: '模式 agentPreset' },
      { id: 'model', no: '③', title: '模型' },
      { id: 'perm', no: '④', title: '权限档' },
      { id: 'details', no: '⑤', title: '标题与开工任务' },
    ]

    const PANEL_STYLE_ID = 'dsh-domain-bridge-handoff-panel-css'

    /**
     * 纯 DOM 面板（不依赖 React / 宿主组件库），这样预览页能把这一段原样抽走、用假数据跑。
     * 宿主侧只负责把一个空的 div 交进来；React 那一层不碰这个 div 的子节点。
     */
    function createHandoffPanel(options) {
      const opts = options || {}
      const post = opts.post
      const openLegacy = typeof opts.openLegacy === 'function' ? opts.openLegacy : () => ''
      const log = typeof opts.log === 'function' ? opts.log : () => {}

      const state = {
        open: false,
        sessionId: '',
        data: null,
        draft: null,
        expanded: null,
        filter: '',
        loading: false,
        submitting: false,
        created: false,
        taskTouched: false,
        fetchSeq: 0,
      }

      let hostEl = null
      let backdrop = null
      let panelEl = null
      let subEl = null
      let searchEl = null
      let searchClearEl = null
      let countEl = null
      let loadingEl = null
      let errorEl = null
      let rowsEl = null
      let statusEl = null
      let submitBtn = null
      let mounted = false
      let traceSeed = 0

      function nextTrace() {
        traceSeed += 1
        return `hp${Date.now().toString(36).slice(-4)}${traceSeed}`
      }

      function ensureStyle() {
        let node = document.getElementById(PANEL_STYLE_ID)
        if (!node) {
          node = document.createElement('style')
          node.id = PANEL_STYLE_ID
          document.head.append(node)
        }
        node.textContent = PANEL_CSS
      }

      function el(tag, className, text) {
        const node = document.createElement(tag)
        if (className) node.className = className
        if (text !== undefined) node.textContent = String(text)
        return node
      }

      function activeElementOf(event) {
        const target = event && event.target
        if (!target || typeof target.closest !== 'function') return null
        return target
      }

      /* ── 骨架 ─────────────────────────────────────────────── */

      function buildSkeleton() {
        hostEl.classList.add('dbhp-host')
        hostEl.textContent = ''

        backdrop = el('div', 'dbhp-backdrop')
        backdrop.hidden = true
        backdrop.addEventListener('mousedown', (event) => {
          if (event.target === backdrop) close()
        })

        panelEl = el('section', 'dbhp-panel')
        panelEl.setAttribute('role', 'dialog')
        panelEl.setAttribute('aria-modal', 'true')
        panelEl.setAttribute('aria-label', '换届 · 逐项设置')

        const head = el('header', 'dbhp-head')
        const headText = el('div', 'dbhp-head-text')
        headText.append(el('h2', 'dbhp-title', '换届 · 逐项设置'))
        subEl = el('p', 'dbhp-sub', '')
        headText.append(subEl)
        const headActions = el('div', 'dbhp-head-actions')
        const legacy = el('button', 'dbhp-legacy', '旧版网页设置 ↗')
        legacy.type = 'button'
        legacy.title = '用系统浏览器打开旧版分步表单'
        legacy.dataset.act = 'legacy'
        const closeBtn = el('button', 'dbhp-x', '×')
        closeBtn.type = 'button'
        closeBtn.setAttribute('aria-label', '关闭')
        closeBtn.dataset.act = 'close'
        headActions.append(legacy, closeBtn)
        head.append(headText, headActions)

        const searchBar = el('div', 'dbhp-search')
        searchEl = el('input', 'dbhp-search-input')
        searchEl.type = 'search'
        searchEl.placeholder = '搜索候选（身份 / 模式 / 模型 / 权限）…'
        searchEl.setAttribute('aria-label', '搜索候选')
        searchEl.disabled = true
        searchEl.addEventListener('input', () => {
          state.filter = searchEl.value
          updateSearch()
        })
        countEl = el('span', 'dbhp-search-count', '')
        searchClearEl = el('button', 'dbhp-search-clear', '清除')
        searchClearEl.type = 'button'
        searchClearEl.dataset.act = 'clear-search'
        searchClearEl.hidden = true
        searchBar.append(searchEl, countEl, searchClearEl)

        const body = el('div', 'dbhp-body')
        loadingEl = el('div', 'dbhp-state', '正在读取向导数据…')
        loadingEl.hidden = true
        errorEl = el('div', 'dbhp-state dbhp-state-error')
        errorEl.hidden = true
        rowsEl = el('div', 'dbhp-rows')
        rowsEl.hidden = true
        body.append(loadingEl, errorEl, rowsEl)

        const foot = el('footer', 'dbhp-foot')
        const footLeft = el('div', 'dbhp-foot-left')
        statusEl = el('div', 'dbhp-status')
        statusEl.hidden = true
        footLeft.append(statusEl)
        submitBtn = el('button', 'dbhp-primary', '创建接任会话')
        submitBtn.type = 'button'
        submitBtn.dataset.act = 'submit'
        foot.append(footLeft, submitBtn)

        panelEl.append(head, searchBar, body, foot)
        backdrop.append(panelEl)
        hostEl.append(backdrop)

        panelEl.addEventListener('click', onPanelClick)
        rowsEl.addEventListener('click', onRowsClick)
        rowsEl.addEventListener('input', onRowsInput)
        rowsEl.addEventListener('keydown', onRowsKey)
      }

      /* ── 打开 / 关闭 ─────────────────────────────────────── */

      function open(sessionId) {
        if (!mounted || !sessionId) return
        state.open = true
        state.sessionId = String(sessionId)
        state.data = null
        state.draft = null
        state.expanded = null
        state.filter = ''
        state.loading = true
        state.submitting = false
        state.created = false
        state.taskTouched = false
        state.fetchSeq += 1
        const seq = state.fetchSeq

        searchEl.value = ''
        searchEl.disabled = true
        searchClearEl.hidden = true
        countEl.textContent = ''
        subEl.textContent = `当前会话 ${shortSessionIdOf(state.sessionId) || state.sessionId}`
        loadingEl.hidden = false
        errorEl.hidden = true
        errorEl.textContent = ''
        rowsEl.hidden = true
        rowsEl.textContent = ''
        statusEl.hidden = true
        statusEl.textContent = ''
        statusEl.className = 'dbhp-status'
        submitBtn.textContent = '创建接任会话'
        submitBtn.disabled = true
        backdrop.hidden = false

        const trace = nextTrace()
        panelEl.dataset.trace = trace
        log(`[入口] trace=${trace} 打开换届面板（逐项设置） session=${state.sessionId}`)
        void fetchData(trace, seq)
      }

      function close() {
        if (!state.open) return
        const trace = panelEl.dataset.trace || '-'
        state.open = false
        state.fetchSeq += 1
        state.data = null
        state.draft = null
        state.expanded = null
        state.filter = ''
        state.submitting = false
        state.created = false
        backdrop.hidden = true
        if (rowsEl) rowsEl.textContent = ''
        if (searchEl) searchEl.value = ''
        log(`[结果] trace=${trace} 关闭换届面板`)
      }

      async function fetchData(trace, seq) {
        try {
          const data = await post(
            `handoff-wizard/data?sessionId=${encodeURIComponent(state.sessionId)}`,
            {},
          )
          if (!state.open || seq !== state.fetchSeq) return
          if (!data || data.ok === false) {
            const reason =
              data && data.error === 'no-live-agent'
                ? '这条会话现在没有活 Agent（窗口已关或刚重启过）⇒ 不能从面板建会话。'
                : (data && (data.error || data.text)) || '后端没有返回数据'
            showLoadError(`拉取向导数据失败：${reason}`)
            log(`[异常] trace=${trace} 拉取数据失败：${reason}`)
            return
          }
          state.data = data
          state.loading = false
          state.draft = initialDraft(data)
          if (data.version) subEl.textContent = `当前会话 ${shortSessionIdOf(state.sessionId) || state.sessionId} · 插件 v${data.version}`
          buildRows()
          loadingEl.hidden = true
          errorEl.hidden = true
          errorEl.textContent = ''
          rowsEl.hidden = false
          searchEl.disabled = false
          submitBtn.disabled = false
          updateSummaries()
          updateSearch()
          const groups = (data.models && data.models.groups) || []
          const modelCount = groups.reduce((sum, group) => sum + ((group && group.models) || []).length, 0)
          log(
            `[结果] trace=${trace} 数据就绪：身份 ${((data.layers && data.layers.length) || 0)} 个 / 模型 ${modelCount} 个 / 默认模式 ${data.defaultPreset || 'standard'}`,
          )
        } catch (error) {
          if (!state.open || seq !== state.fetchSeq) return
          const reason = error && error.message ? error.message : String(error)
          showLoadError(`拉取向导数据失败：${reason}`)
          log(`[异常] trace=${trace} 拉取数据异常：${reason}`)
        }
      }

      function showLoadError(message) {
        state.loading = false
        loadingEl.hidden = true
        rowsEl.hidden = true
        errorEl.hidden = false
        errorEl.textContent = ''
        errorEl.append(el('p', '', message))
        const retry = el('button', 'dbhp-retry', '重试')
        retry.type = 'button'
        retry.dataset.act = 'retry'
        errorEl.append(retry)
        submitBtn.disabled = true
        searchEl.disabled = true
      }

      function initialDraft(data) {
        const defaults = (data && data.defaults) || {}
        const layerRow = data && data.defaultLayer ? data.defaultLayer : {}
        const key = layerRow.key || ((data.layers && data.layers[0] && data.layers[0].key) || '')
        return {
          key,
          preset: data.defaultPreset || 'standard',
          model: '',
          perm: typeof defaults.permission === 'string' ? defaults.permission : '',
          title: defaults.title || '',
          task: buildHandoffTask(key, state.sessionId),
        }
      }

      /* ── 行与候选 ─────────────────────────────────────────── */

      function buildRows() {
        rowsEl.innerHTML = PANEL_SECTIONS.map(
          (section) =>
            `<div class="dbhp-row" data-row="${section.id}">` +
            `<button type="button" class="dbhp-row-head" data-act="toggle" data-row="${section.id}" aria-expanded="false">` +
            `<span class="dbhp-row-no">${section.no}</span>` +
            `<span class="dbhp-row-title">${escapeHtml(section.title)}</span>` +
            `<span class="dbhp-row-summary"></span>` +
            `<span class="dbhp-caret" aria-hidden="true"></span>` +
            `</button>` +
            `<div class="dbhp-row-body" hidden></div>` +
            `</div>`,
        ).join('')
        applyRowState()
      }

      function candidatesFor(sectionId) {
        const data = state.data
        if (!data) return []
        if (sectionId === 'identity') {
          return ((data.layers || [])).map((row) => ({
            value: String(row.key || ''),
            label: row.label || row.layer || row.key,
            detail: row.detail || row.key,
          }))
        }
        if (sectionId === 'preset') {
          return ((data.presets || [])).map((id) => ({
            value: String(id),
            label: String(id),
            detail: id === 'cordis' ? '创造模式：复杂 / 创造类交接' : '标准模式：日常执行',
          }))
        }
        if (sectionId === 'model') {
          const rows = [{ value: '', label: '不指定（跟随宿主全局默认）', detail: '不给新会话铺模型' }]
          const defaults = data.defaults || {}
          if (defaults.model) {
            rows.push({ value: String(defaults.model), label: '部署配置 domainSessionModel', detail: defaults.model })
          }
          for (const group of (data.models && data.models.groups) || []) {
            for (const model of (group && group.models) || []) {
              rows.push({
                value: `${group.provider}/${model.id}`,
                label: model.name || model.id,
                detail: `${group.name || group.provider} · ${group.provider}`,
              })
            }
          }
          return rows
        }
        if (sectionId === 'perm') {
          return ((data.permissions || [])).map((row) => ({
            value: String(row.value === undefined || row.value === null ? '' : row.value),
            label: row.label || row.value || '部署默认',
            detail: row.detail || '',
          }))
        }
        return []
      }

      function filterItems(items) {
        const query = state.filter.trim().toLowerCase()
        if (!query) return items
        return items.filter((item) =>
          `${item.label || ''} ${item.detail || ''} ${item.value || ''}`.toLowerCase().includes(query),
        )
      }

      function emptyTextFor(sectionId) {
        if (sectionId === 'identity') return '没有可用身份（注册册里没有你的键）⇒ 先在原窗口 /register。'
        if (sectionId === 'preset') return '宿主没有给出 preset 列表 ⇒ 在下面手填。'
        if (sectionId === 'model') return '宿主没有给出可路由的模型目录 ⇒ 在下面手填 provider/model。'
        return '没有可用选项。'
      }

      function notesFor(sectionId) {
        const data = state.data || {}
        if (sectionId === 'identity') return '只能在你真持有的身份里选；没列出来的键不能拿去交接。'
        if (sectionId === 'preset') return '默认按层：体系 cordis，项目 / 域 standard。'
        if (sectionId === 'model') {
          const models = data.models || {}
          const notes = (data.notes || []).filter(Boolean)
          const head = models.empty
            ? '模型目录为空 ⇒ 手填 provider/model。'
            : `目录来源：${models.source || 'unknown'}。`
          return notes.length ? `${head} ${notes.join(' / ')}` : head
        }
        if (sectionId === 'perm') return '留空＝不覆盖部署配置（config.domainSessionPreset）。'
        return ''
      }

      function summaryText(sectionId, data, draft) {
        if (sectionId === 'identity') {
          const row = ((data.layers || [])).find((item) => item.key === draft.key)
          return `${(row && (row.label || row.layer)) || '身份'} · ${draft.key}`
        }
        if (sectionId === 'preset') return draft.preset || 'standard'
        if (sectionId === 'model') return draft.model || '跟随宿主全局默认'
        if (sectionId === 'perm') {
          if (!draft.perm) return '部署默认'
          const row = ((data.permissions || [])).find((item) => String(item.value ?? '') === draft.perm)
          return (row && row.label) || draft.perm
        }
        if (sectionId === 'details') {
          const title = draft.title || '（未填标题）'
          return `${title} · 任务 ${String(draft.task || '').length} 字`
        }
        return ''
      }

      function updateSummaries() {
        if (!rowsEl || !state.data || !state.draft) return
        for (const section of PANEL_SECTIONS) {
          const row = rowsEl.querySelector(`[data-row="${section.id}"]`)
          if (!row) continue
          const summary = row.querySelector('.dbhp-row-summary')
          if (summary) summary.textContent = summaryText(section.id, state.data, state.draft)
        }
      }

      function applyRowState() {
        if (!rowsEl) return
        for (const row of rowsEl.querySelectorAll('.dbhp-row')) {
          const isOpen = state.expanded === row.dataset.row
          row.classList.toggle('is-open', isOpen)
          const head = row.querySelector('.dbhp-row-head')
          if (head) head.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
          const body = row.querySelector('.dbhp-row-body')
          if (body) body.hidden = !isOpen
        }
      }

      function toggleRow(sectionId) {
        const next = state.expanded === sectionId ? null : sectionId
        state.expanded = next
        applyRowState()
        if (next) {
          renderBody(next)
          const row = rowsEl.querySelector(`[data-row="${next}"]`)
          if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
          const section = PANEL_SECTIONS.find((item) => item.id === next)
          log(`[分支] trace=${panelEl.dataset.trace || '-'} 展开「${section ? section.title : next}」`)
        }
        updateSearch()
      }

      function draftFieldOf(sectionId) {
        // 身份行的草稿字段叫 `key`（与 /handoff 的参数名一致），其余行与段 id 同名。
        return sectionId === 'identity' ? 'key' : sectionId
      }

      function optionEl(field, item) {
        const draftField = draftFieldOf(field)
        const selected = String((state.draft && state.draft[draftField]) ?? '') === String(item.value ?? '')
        const button = el('button', 'dbhp-opt' + (selected ? ' is-sel' : ''))
        button.type = 'button'
        button.dataset.act = 'pick'
        button.dataset.field = field
        button.dataset.value = String(item.value ?? '')
        button.setAttribute('aria-pressed', selected ? 'true' : 'false')
        const tick = el('span', 'dbhp-tick', selected ? '✓' : '')
        const text = el('span', 'dbhp-opt-text')
        text.append(el('span', 'dbhp-opt-label', item.label || item.value || '（默认）'))
        if (item.detail) text.append(el('span', 'dbhp-opt-detail', item.detail))
        button.append(tick, text)
        return button
      }

      function manualRow(field) {
        const wrap = el('div', 'dbhp-manual')
        const input = el('input', 'dbhp-manual-input')
        input.type = 'text'
        input.dataset.manual = field
        input.placeholder =
          field === 'model' ? '或手填 provider/model，例如 deepseek/deepseek-v4.1-flash' : '或手填 preset id，例如 cordis'
        const apply = el('button', 'dbhp-manual-btn', '用这个')
        apply.type = 'button'
        apply.dataset.act = 'apply-manual'
        apply.dataset.field = field
        wrap.append(input, apply)
        return wrap
      }

      function renderBody(sectionId) {
        const row = rowsEl.querySelector(`[data-row="${sectionId}"]`)
        if (!row) return
        const body = row.querySelector('.dbhp-row-body')
        if (!body) return
        body.textContent = ''

        if (sectionId === 'details') {
          renderDetails(body)
          return
        }

        const items = candidatesFor(sectionId)
        const shown = filterItems(items)
        const list = el('div', 'dbhp-opts')
        if (!items.length) list.append(el('div', 'dbhp-empty', emptyTextFor(sectionId)))
        else if (!shown.length) list.append(el('div', 'dbhp-empty', '没有匹配项'))
        else for (const item of shown) list.append(optionEl(sectionId, item))
        body.append(list)

        const note = notesFor(sectionId)
        if (note) body.append(el('div', 'dbhp-hint', note))
        if (sectionId === 'preset' || sectionId === 'model') body.append(manualRow(sectionId))
      }

      function taskCounterText() {
        return `任务 ${String((state.draft && state.draft.task) || '').length} 字（≤300）`
      }

      function renderDetails(body) {
        const titleLabel = el('label', 'dbhp-label', '接任者标题（≤80 字节）')
        const titleInput = el('input', 'dbhp-input')
        titleInput.type = 'text'
        titleInput.maxLength = 80
        titleInput.value = (state.draft && state.draft.title) || ''
        titleInput.dataset.field = 'title'

        const taskLabel = el('label', 'dbhp-label', '开工任务（≤300 字，默认固定短模板）')
        const taskArea = el('textarea', 'dbhp-textarea')
        taskArea.rows = 7
        taskArea.spellcheck = false
        taskArea.value = (state.draft && state.draft.task) || ''
        taskArea.dataset.field = 'task'
        const counter = el('span', 'dbhp-counter', taskCounterText())
        counter.dataset.counter = 'task'

        const hint = el(
          'div',
          'dbhp-hint',
          '默认模板只让接任者做四件事：核对身份、只读 PROJECT.md 两节、回报三行、不开工。可以直接改。',
        )

        const collapse = el('button', 'dbhp-collapse', '收起')
        collapse.type = 'button'
        collapse.dataset.act = 'collapse'

        body.append(titleLabel, titleInput, taskLabel, taskArea, counter, hint, collapse)
      }

      /* ── 选择与提交 ───────────────────────────────────────── */

      function updateSearch() {
        const query = state.filter.trim()
        if (searchClearEl) searchClearEl.hidden = !query
        if (countEl) {
          if (!query || !state.expanded || state.expanded === 'details') countEl.textContent = ''
          else {
            const total = candidatesFor(state.expanded).length
            const shown = filterItems(candidatesFor(state.expanded)).length
            countEl.textContent = `匹配 ${shown}/${total}`
          }
        }
        if (state.expanded && state.expanded !== 'details') renderBody(state.expanded)
      }

      function pick(field, value) {
        if (!state.draft) return
        const next = String(value === undefined || value === null ? '' : value)
        if (field === 'identity') {
          if (!next) return
          const row = ((state.data && state.data.layers) || []).find((item) => item.key === next)
          state.draft.key = next
          state.draft.preset = row && row.layer === 'system' ? 'cordis' : 'standard'
          if (!state.taskTouched) state.draft.task = buildHandoffTask(next, state.sessionId)
        } else if (field === 'preset') {
          if (!next.trim()) return
          state.draft.preset = next.trim()
        } else if (field === 'model') {
          state.draft.model = next.trim()
        } else if (field === 'perm') {
          state.draft.perm = next
        } else {
          return
        }
        state.expanded = null
        applyRowState()
        updateSummaries()
        updateSearch()
        log(`[分支] trace=${panelEl.dataset.trace || '-'} 选择 ${field}=${next || '(默认)'}`)
      }

      function applyManual(field, input) {
        const value = String((input && input.value) || '').trim()
        if (!value) return
        if (field === 'model' && value.indexOf('/') <= 0) {
          setStatus('模型要写成 provider/model，例如 deepseek/deepseek-v4.1-flash', 'err')
          log(`[异常] trace=${panelEl.dataset.trace || '-'} 手填模型格式不对：${value}`)
          return
        }
        if (statusEl.classList.contains('is-err')) {
          statusEl.hidden = true
          statusEl.className = 'dbhp-status'
          statusEl.textContent = ''
        }
        pick(field, value)
      }

      function setStatus(text, kind, detailText) {
        statusEl.hidden = false
        statusEl.className = `dbhp-status is-${kind || 'info'}`
        statusEl.textContent = ''
        statusEl.append(el('div', 'dbhp-status-line', text))
        if (kind === 'ok' && detailText) {
          const details = document.createElement('details')
          details.className = 'dbhp-receipt'
          const summary = document.createElement('summary')
          summary.textContent = '完整回执'
          const pre = document.createElement('pre')
          pre.textContent = String(detailText)
          details.append(summary, pre)
          statusEl.append(details)
        }
      }

      async function submit() {
        if (state.created) {
          close()
          return
        }
        if (!state.draft || state.submitting) return
        if (!state.draft.key) {
          setStatus('没有交接身份 ⇒ 先展开①选一个身份。', 'err')
          return
        }
        const trace = panelEl.dataset.trace || nextTrace()
        const payload = {
          sessionId: state.sessionId,
          key: state.draft.key,
          preset: state.draft.preset,
          model: state.draft.model,
          perm: state.draft.perm,
          title: state.draft.title,
          task: state.draft.task,
          retireNow: false,
        }
        state.submitting = true
        submitBtn.disabled = true
        submitBtn.textContent = '正在创建…'
        setStatus('正在创建接任会话…', 'busy')
        log(
          `[入口] trace=${trace} 提交换届：key=${payload.key} preset=${payload.preset} model=${payload.model || '(默认)'} perm=${payload.perm || '(部署默认)'} title=${payload.title}`,
        )
        try {
          const outcome = await post('handoff-wizard/run', payload)
          if (outcome && outcome.ok === true) {
            state.created = true
            state.submitting = false
            const short = shortCreatedOf(outcome.text)
            setStatus(
              short
                ? `已创建接任会话 · ${short}（新窗口要你自己在左侧栏点开）`
                : '已创建接任会话（新窗口要你自己在左侧栏点开）',
              'ok',
              outcome.text,
            )
            submitBtn.textContent = '关闭'
            submitBtn.disabled = false
            log(`[结果] trace=${trace} 创建成功${short ? ` short=${short}` : ''}`)
          } else {
            state.submitting = false
            const text =
              (outcome && (outcome.text || outcome.error)) || '创建失败（后端没有给出原因）'
            setStatus(text, 'err')
            submitBtn.textContent = '重试创建'
            submitBtn.disabled = false
            log(`[异常] trace=${trace} 创建失败：${text}`)
          }
        } catch (error) {
          state.submitting = false
          const text = `请求失败：${error && error.message ? error.message : String(error)}`
          setStatus(text, 'err')
          submitBtn.textContent = '重试创建'
          submitBtn.disabled = false
          log(`[异常] trace=${trace} 提交异常：${text}`)
        }
      }

      /* ── 事件 ─────────────────────────────────────────────── */

      function onPanelClick(event) {
        const target = activeElementOf(event)
        if (!target) return
        const button = target.closest('[data-act]')
        if (!button) return
        const act = button.dataset.act
        if (act === 'close') {
          close()
          return
        }
        if (act === 'clear-search') {
          state.filter = ''
          searchEl.value = ''
          updateSearch()
          return
        }
        if (act === 'legacy') {
          log(`[入口] trace=${panelEl.dataset.trace || '-'} 打开旧版网页设置 session=${state.sessionId}`)
          openLegacy(state.sessionId)
          return
        }
        if (act === 'submit') {
          void submit()
          return
        }
        if (act === 'retry') {
          const trace = nextTrace()
          panelEl.dataset.trace = trace
          state.loading = true
          loadingEl.hidden = false
          errorEl.hidden = true
          log(`[入口] trace=${trace} 重试拉取向导数据 session=${state.sessionId}`)
          state.fetchSeq += 1
          void fetchData(trace, state.fetchSeq)
        }
      }

      function onRowsClick(event) {
        const target = activeElementOf(event)
        if (!target) return
        const button = target.closest('[data-act]')
        if (!button) return
        const act = button.dataset.act
        if (act === 'toggle') {
          toggleRow(button.dataset.row)
          return
        }
        if (act === 'pick') {
          pick(button.dataset.field, button.dataset.value)
          return
        }
        if (act === 'apply-manual') {
          const wrap = button.parentElement
          const input = wrap ? wrap.querySelector('[data-manual]') : null
          applyManual(button.dataset.field, input)
          return
        }
        if (act === 'collapse') {
          state.expanded = null
          applyRowState()
          updateSearch()
        }
      }

      function onRowsInput(event) {
        const target = event.target
        if (!target || !target.dataset) return
        const field = target.dataset.field
        if (!state.draft) return
        if (field === 'title') {
          state.draft.title = target.value
          updateSummaries()
        } else if (field === 'task') {
          state.draft.task = target.value
          state.taskTouched = true
          const counter = target.parentElement
            ? target.parentElement.querySelector('[data-counter="task"]')
            : null
          if (counter) counter.textContent = taskCounterText()
          updateSummaries()
        }
      }

      function onRowsKey(event) {
        if (event.key !== 'Enter') return
        const target = event.target
        if (!target || !target.dataset || !target.dataset.manual) return
        event.preventDefault()
        applyManual(target.dataset.manual, target)
      }

      function onDocumentKey(event) {
        if (event.key !== 'Escape' || !state.open) return
        event.preventDefault()
        event.stopPropagation()
        close()
      }

      /* ── 生命周期 ─────────────────────────────────────────── */

      function mount(container) {
        if (!container) return
        hostEl = container
        ensureStyle()
        buildSkeleton()
        document.addEventListener('keydown', onDocumentKey, true)
        mounted = true
      }

      function destroy() {
        document.removeEventListener('keydown', onDocumentKey, true)
        if (hostEl) hostEl.textContent = ''
        state.open = false
        state.fetchSeq += 1
        mounted = false
      }

      return {
        mount,
        open,
        close,
        destroy,
        isOpen: () => state.open,
      }
    }

    /* @handoff-panel:end */

    let react = null
    try {
      // The Host module registry provides React to client plugins (same as dsh-pet).
      react = require('react')
    } catch (error) {
      console.warn('[dsh-domain-bridge] React 不可用 ⇒ 逐项设置面板退回旧版网页：', error)
    }

    return {
      inject: ['commandUi'],
      apply(ctx) {
        // 面板宿主的状态：action 可能在 slot 挂载前就触发，所以留一个 pending 接力位。
        const overlay = { host: null, pending: '', unavailable: false }

        function openPanelOrFallback(sessionId) {
          if (!sessionId) {
            console.warn('[dsh-domain-bridge] 换届面板：拿不到当前会话 id，无法打开')
            return
          }
          if (overlay.host) {
            overlay.host.open(sessionId)
            return
          }
          if (overlay.unavailable) {
            openHandoffWizard(sessionId)
            return
          }
          overlay.pending = sessionId
          setTimeout(() => {
            if (overlay.host) return
            if (overlay.unavailable || overlay.pending !== sessionId) return
            overlay.pending = ''
            console.warn('[dsh-domain-bridge] shell.overlay 未就绪 ⇒ 退回旧版网页设置')
            openHandoffWizard(sessionId)
          }, 600)
        }

        ctx.inject(['commandUi'], (sctx) => {
          const command = sctx.get('commandUi')
          sctx.effect(() => {
            const disposers = []
            for (const spec of SPECS) {
              try {
                // `/handoff` 裸命令走 action（应用内多级面板）；带参数时仍由宿主命令处理。
                const ui =
                  spec.name === 'handoff'
                    ? {
                        kind: 'action',
                        run(session) {
                          openPanelOrFallback(sessionIdOf(session))
                        },
                      }
                    : {
                        kind: 'popupSelect',
                        searchLabels: () => ({
                          placeholder: '搜索…',
                          empty: '没有可用选项',
                          noResults: '没有匹配项',
                        }),
                        async options(session) {
                          const result = await post('menu', {
                            command: spec.name,
                            sessionId: sessionIdOf(session),
                          })
                          return Array.isArray(result.options) ? result.options : []
                        },
                        async onSelect(option, session) {
                          const sessionId = sessionIdOf(session)
                          const choiceId = option && option.id != null ? String(option.id) : ''
                          // v0.8.5：**回执不再被丢掉**。以前这里 `await post(...)` 就当完了，/run 失败
                          // （例如插件实例失效时返回 kind:'error'）在界面上一个字都不显示——用户只看到
                          // "点了没反应"。现在失败就抛出去，让弹窗自己的错误态/重试按钮接住。
                          const outcome = await post('run', {
                            command: spec.name,
                            sessionId,
                            input: choiceId,
                          })
                          if (outcome && outcome.ok === false) {
                            throw new Error(outcome.text || `${spec.name}: 执行失败`)
                          }
                          return outcome
                        },
                      }
                const dispose = command.decorate({ name: spec.name, available: () => true, ui })
                if (typeof dispose === 'function') disposers.push(dispose)
              } catch (error) {
                // A name collision must not take the other decorations down with it.
                console.warn(`[dsh-domain-bridge] decorate /${spec.name} failed:`, error)
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
          }, 'domain-bridge: slash command popups')
        })

        // `shell.overlay` 是 layout 在 AppFrame 里 renderSlot 的那一层（absolute inset:0，
        // pointer-events:none）；面板自己负责 pointer-events:auto。
        ctx.inject(['slots'], (sctx) => {
          const slots = sctx.get('slots')
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
            overlay.unavailable = true
            console.warn('[dsh-domain-bridge] slots 服务不可用 ⇒ /handoff 退回旧版网页设置')
            return
          }
          if (!react || typeof react.useEffect !== 'function' || typeof react.createElement !== 'function') {
            overlay.unavailable = true
            console.warn('[dsh-domain-bridge] React 不可用 ⇒ /handoff 退回旧版网页设置')
            return
          }

          const OverlayHost = function DomainBridgeHandoffOverlay() {
            const ref = react.useRef(null)
            react.useEffect(() => {
              const node = ref.current
              if (!node) return undefined
              const host = createHandoffPanel({
                post,
                openLegacy: (sessionId) => {
                  const url = openHandoffWizard(sessionId)
                  console.log(`[domain-bridge][handoff-panel] 旧版网页设置已打开：${url}`)
                },
                log: (...args) => console.log('[domain-bridge][handoff-panel]', ...args),
              })
              host.mount(node)
              overlay.host = host
              const pending = overlay.pending
              overlay.pending = ''
              if (pending) host.open(pending)
              return () => {
                host.destroy()
                if (overlay.host === host) overlay.host = null
              }
            }, [])
            return react.createElement('div', { className: 'dbhp-host', ref })
          }

          try {
            sctx.effect(
              () =>
                slots.inject('shell.overlay', () =>
                  slots.register(
                    { name: 'shell.overlay', id: 'domain-bridge-handoff', order: 1200 },
                    OverlayHost,
                  ),
                ),
              'domain-bridge: handoff panel overlay',
            )
          } catch (error) {
            overlay.unavailable = true
            console.warn('[dsh-domain-bridge] 挂载换届面板失败 ⇒ 退回旧版网页设置：', error)
          }
        })
      },
    }
  },
})
