// v0.7.0 slash commands — argument parsing, authority gates, confirmation, audit.
// Self-contained: fake ctx + fake tool definitions; no Host, no real session.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCommandDefs } from '../lib/core/commands.js'
import { upsertRegistration, readRegistrations } from '../lib/core/registrations.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmd-'))
const domainsFile = path.join(root, 'domains.json')
const stateDir = path.join(root, 'state')
const cwd = path.join(root, 'tixiweihu')
fs.mkdirSync(cwd, { recursive: true })
fs.writeFileSync(domainsFile, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), owners: {} }, null, 2) + '\n', 'utf8')

const calls = []
const defs = {
  claim: { async execute(args) { calls.push(['claim', args]); return { ok: true, action: 'claim', domain: args.domain } } },
  release: { async execute(args) { calls.push(['release', args]); return { ok: true, outcome: 'released' } } },
  pause: { async execute(args) { calls.push(['pause', args]); return { ok: true, state: 'paused', key: args.domain } } },
  create: { async execute(args) { calls.push(['create', args]); return { created: true, sessionId: 'session-new' } } },
}
const runInitialize = async (args) => ({ existed: [], created: [], manual: [], wouldCreate: [], system: { ok: true, missing: [] }, hint: 'ok', check: args.check })
const ctx = { get: (name) => (name === 'workingDirectory' ? { get: () => cwd } : undefined) }
const config = { domainsFile, stateDir }
const agent = { id: 'session-test', session: {} }
const defsOut = buildCommandDefs(ctx, { config, defs, runInitialize })
const byName = Object.fromEntries(defsOut.map((d) => [d.name, d]))
const run = (name, rawInput = '') => byName[name].handler({ agent, rawInput })

let passed = 0
const caseOk = (cond, message) => { assert.ok(cond, message); passed++ }

// 1. bare /register = read-only identity report
{
  const out = await run('register')
  caseOk(out.kind === 'success' && out.text.includes('当前身份'), 'bare /register 应回报当前身份')
  caseOk(out.text.includes('你现在能做什么'), 'bare /register 应列出可执行动作')
}

// 2. /register domain -> reuses claim (no second implementation)
{
  calls.length = 0
  const out = await run('register', 'domain asr')
  caseOk(out.kind === 'success', '/register domain 应成功')
  caseOk(calls.length === 1 && calls[0][0] === 'claim' && calls[0][1].domain === 'asr' && calls[0][1].force === false, '应转调 claim(force=false)')
}

// 3. takeover -> force true
{
  calls.length = 0
  await run('register', 'domain asr takeover')
  caseOk(calls[0][1].force === true, 'takeover 应传 force=true')
}

// 4. /register system 缺 SYSTEM-OVERVIEW.md ⇒ 先要一次确认（不再硬拒，注册先于初始化）
{
  const out = await run('register', 'system')
  caseOk(out.kind === 'error' && out.text.includes('SYSTEM-OVERVIEW'), '缺体系口径源时应先要确认')
  caseOk(out.text.includes('--confirm'), '提示里要给出 --confirm 用法')
}

// 5. 注册先行：项目根没有 PROJECT.md 也能注册（项目名特意不匹配 cwd，避免影响后面的权限断言）
{
  const out = await run('register', 'project other')
  caseOk(out.kind === 'success', '缺 PROJECT.md 不应再拒绝注册')
  const doc = readRegistrations(domainsFile).doc
  caseOk(doc.registrations['other:main'] && doc.registrations['other:main'].sessionId === 'session-test', '应落账 other:main')
  caseOk(out.text.includes('/initialize'), '回执应把 /initialize 指为下一步')
}

// 6. /pause self works for anybody
{
  calls.length = 0
  const out = await run('pause', 'self 先停一下')
  caseOk(out.kind === 'success', '/pause self 应成功')
  caseOk(calls[0][1].scope === 'session' && calls[0][1].domain === 'session-test', '/pause self 应暂停调用者会话')
  caseOk(out.text.includes('正在跑的回合不会被打断'), '暂停回执必须写明不中断回合')
}

// 7. /pause project without authority is refused
{
  const out = await run('pause', 'project')
  caseOk(out.kind === 'error' && out.text.includes('不是项目'), '无身份时 /pause project 应拒绝')
}

// 8. /pause-all without --confirm writes nothing
{
  calls.length = 0
  const out = await run('pause-all', 'global 注入风险')
  caseOk(out.kind === 'success' && out.text.includes('--confirm'), '/pause-all 首次应先要确认')
  caseOk(calls.length === 0, '未确认时不得调用暂停')
}

// 9. /pause-all requires a reason
{
  const out = await run('pause-all', 'global')
  caseOk(out.kind === 'error' && out.text.includes('必须写原因'), '/pause-all 缺原因应拒绝')
}

// 10. /pause-all --confirm executes and audits
{
  calls.length = 0
  const out = await run('pause-all', 'global 注入风险 --confirm')
  caseOk(out.kind === 'success', '/pause-all 确认后应执行')
  caseOk(calls[0][1].scope === 'global' && calls[0][1].domain === '*' && calls[0][1].confirm === true, '强停全局应带 confirm')
  const audit = path.join(stateDir, 'audit.jsonl')
  caseOk(fs.existsSync(audit) && fs.readFileSync(audit, 'utf8').includes('pause-all'), '审计必须落盘')
}

// 11. /handoff defaults follow the frozen parameter table
{
  calls.length = 0
  const out = await run('handoff', '')
  caseOk(out.kind === 'success', '/handoff 应成功')
  const args = calls.find((c) => c[0] === 'create')?.[1]
  caseOk(args && args.model.provider === 'wb' && args.model.model === 'cn:deepseek-v4.1-flash', '默认模型应为 wb/cn:deepseek-v4.1-flash')
  caseOk(args.agentPreset === 'standard', '无注册身份时按项目档 standard')
  caseOk(args.permissionPreset === 'workspace-write', '项目档权限应为 workspace-write')
}

// 12. /retire drops own registration and pauses the session
{
  upsertRegistration(domainsFile, { key: 'tixiweihu:main', layer: 'project', project: 'tixiweihu', domain: 'main', sessionId: 'session-test', since: new Date().toISOString(), by: 'session-test', title: '', note: '' })
  calls.length = 0
  const out = await run('retire', '换人')
  caseOk(out.kind === 'success' && out.text.includes('退役完成'), '/retire 应成功')
  const doc = readRegistrations(domainsFile).doc
  caseOk(!doc.registrations['tixiweihu:main'], '退役后注册条目应被移除')
  caseOk(out.text.includes('退役≠删除'), '退役回执必须写明不删除历史')
}

// 13. 体系主：带 --confirm 即可在缺骨架的目录注册；有 SYSTEM-OVERVIEW.md 后不再要确认
{
  const after = await run('register', 'system --confirm')
  caseOk(after.kind === 'success', '带 --confirm 应能注册体系主')
  const doc = readRegistrations(domainsFile).doc
  caseOk(doc.registrations['tixiweihu:system'] && doc.registrations['tixiweihu:system'].sessionId === 'session-test', '应落账 tixiweihu:system')
  caseOk(after.text.includes('/initialize'), '回执应把 /initialize 指为下一步')
  fs.writeFileSync(path.join(cwd, 'SYSTEM-OVERVIEW.md'), '# marker\n', 'utf8')
  const again = await run('register', 'system')
  caseOk(again.kind === 'success', '有体系口径源后应免确认注册')
}

console.log(`[commands] 用例 ${passed} 条全部通过`)
