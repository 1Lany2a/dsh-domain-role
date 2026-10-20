/**
 * dsh-domain-bridge — browser half (v0.8.0).
 *
 * Decorates the six Host commands with a popupSelect surface, exactly like `/free-search-engine`:
 * typing `/` lists the command, picking it opens a menu, one click runs the action. The menu is
 * built HOST-side from real state, and a choice is executed by the Host command executor — so the
 * receipt renders as a normal command flow node and the draft never carries a dirty `/token`.
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

    function sessionIdOf(session) {
      return session && session.sessionId ? String(session.sessionId) : ''
    }

    return {
      inject: ['commandUi'],
      apply(ctx) {
        ctx.inject(['commandUi'], (sctx) => {
          const command = sctx.get('commandUi')
          sctx.effect(() => {
            const disposers = []
            for (const spec of SPECS) {
              try {
                const dispose = command.decorate({
                  name: spec.name,
                  available: () => true,
                  ui: {
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
                      await post('run', {
                        command: spec.name,
                        sessionId: sessionIdOf(session),
                        input: option && option.id != null ? String(option.id) : '',
                      })
                    },
                  },
                })
                if (typeof dispose === 'function') disposers.push(dispose)
              } catch (error) {
                // A name collision must not take the other five decorations down with it.
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
      },
    }
  },
})
