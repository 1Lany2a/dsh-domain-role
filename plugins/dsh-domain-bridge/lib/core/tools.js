/**
 * dsh-domain-bridge — tool registration plumbing: the handler shell shared by all 11 tools and its lossless-output choke point.
 *
 * Split out of the single-file lib/bridge.js in v0.6.3 (pure move: no behaviour change).
 * The package entry point stays lib/bridge.js, which re-exports this module.
 */

import { PLUGIN } from './shared.js'

export function warn(message) {
  try {
    console.warn(`[${PLUGIN}] ${message}`)
  } catch {
    /* 连 console 都不该成为失败点 */
  }
}

/** 两 realm 兼容注册：harness 优先（动态沙箱），否则走静态包的 ctx.tools.register。永不抛。 */
export function registerTool(ctx, definition) {
  try {
    if (
      typeof harness !== 'undefined' &&
      harness &&
      typeof harness.defineTool === 'function' &&
      typeof harness.registerTool === 'function'
    ) {
      return harness.registerTool(ctx, harness.defineTool(definition))
    }
    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      return ctx.tools.register(definition)
    }
    warn(`no tool registration API available; "${definition.name}" not registered`)
  } catch (error) {
    warn(`tool registration failed for "${definition.name}": ${error?.message || String(error)}`)
  }
  return () => {}
}

/** Internal sentinel: "this value must be DELETED by its parent" (never leaves the plugin). */
export const DROP = Symbol('dsh-domain-bridge.drop')

/**
 * Tool outputs must survive `JSON.parse(JSON.stringify(v))` unchanged.
 *
 * Real-machine evidence (2026-10-11, v0.3.0): list_domain_owners returned a top-level
 * `hint: undefined`, the host rejected the WHOLE call with
 * `tool "list_domain_owners" returned invalid output: value is not lossless JSON`
 * and never named the offending field. `JSON.stringify` drops `undefined` keys, so the
 * normalized round trip is lossy - the host validates exactly that.
 *
 * `undefined` is not the only lossy value, so normalize every JSON-hostile one here:
 *   undefined / function / symbol  -> key deleted (arrays: null)
 *   NaN / +-Infinity               -> null      (stringify also writes null, but the round trip must EQUAL)
 *   -0                             -> 0         (stringify writes 0, and -0 !== 0 in a strict deep compare)
 *   bigint                         -> decimal string (stringify THROWS on bigint)
 *   Date                           -> ISO string, invalid Date -> null
 *   Map / Set                      -> plain object (string keys) / array
 *   circular reference             -> null      (stringify THROWS on cycles)
 */
export function losslessValue(value, stack) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return DROP
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  // Only an ANCESTOR can be a cycle; a plain shared object is duplicated, exactly like stringify.
  if (stack.includes(value)) return null
  stack.push(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const next = losslessValue(item, stack)
        // Sparse slots, undefined, functions and symbols all become null, exactly like stringify.
        return next === DROP ? null : next
      })
    }
    if (value instanceof Map) {
      const out = {}
      for (const [key, item] of value) {
        const next = losslessValue(item, stack)
        out[String(key)] = next === DROP ? null : next
      }
      return out
    }
    if (value instanceof Set) {
      return [...value].map((item) => {
        const next = losslessValue(item, stack)
        return next === DROP ? null : next
      })
    }
    const out = {}
    for (const key of Object.keys(value)) {
      let next
      try {
        next = losslessValue(value[key], stack)
      } catch {
        // An exotic getter threw: losing one field beats killing the whole tool call.
        next = null
      }
      if (next !== DROP) out[key] = next
    }
    return out
  } finally {
    stack.pop()
  }
}

/** Recursively drop/normalize every value JSON cannot round-trip losslessly. Never throws. */
export function pruneUndefined(value) {
  try {
    const next = losslessValue(value, [])
    return next === DROP ? null : next
  } catch {
    // A last-resort guard: an unprunable value must still not break the host contract.
    return null
  }
}

export function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    // 函数调用要求 object-rooted schema；这里统一包装。
    parameters: { type: 'object', properties: parameters },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    // Single choke point for lossless output: EVERY tool goes through pruneUndefined() on the way
    // out, so no individual branch (now or later) can make the host reject a whole call.
    async execute(args, exec) {
      return pruneUndefined(await execute.call(this, args, exec))
    },
  }
}

/** 会话 id → 域/使命 的只读映射。索引缺失、格式变了都不抛，只降级为"无域标注"。 */
