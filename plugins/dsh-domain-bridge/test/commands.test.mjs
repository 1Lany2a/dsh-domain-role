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
  caseOk(!out.text.includes('会补上 SYSTEM-OVERVIEW'), '不会再声称 /initialize 会补体系口径源（它只建项目骨架）')
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

// 11. /handoff：按层建会话、显式 claim，模型与权限档交给部署配置（不再硬编码）
{
  calls.length = 0
  const out = await run('handoff', '')
  caseOk(out.kind === 'success', '/handoff 应成功')
  const args = calls.find((c) => c[0] === 'create')?.[1]
  caseOk(args && args.layer === 'project', '无注册身份时应按项目层建会话')
  caseOk(args && args.claim === true, '交接必须显式 claim（把在任身份转给新会话）')
  caseOk(args && args.model === undefined, '默认不再硬编码模型（交给 domainSessionModel 配置）')
  caseOk(args && args.permissionPreset === undefined, '默认不再硬编码权限档（交给 domainSessionPreset 配置）')
  caseOk(args.agentPreset === 'standard', '项目层默认 preset 仍为 standard')
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

// 12.5 /pause domain：不存在的域必须被拒；域负责人可按下（按域暂停是 v0.8.5 新增的层级）
{
  const missing = await run('pause', 'domain nope:asr')
  caseOk(missing.kind === 'error' && missing.text.includes('没有可暂停的域'), '不存在的域应被拒绝')

  const doc = readRegistrations(domainsFile).doc || {}
  doc.owners = doc.owners || {}
  doc.owners['other:asr'] = { project: 'other', domain: 'asr', sessionId: 'session-other', since: new Date().toISOString(), note: '' }
  fs.writeFileSync(domainsFile, JSON.stringify(doc, null, 2) + '\n', 'utf8')

  const denied = await run('pause', 'domain other:asr')
  caseOk(denied.kind === 'error' && denied.text.includes('拒绝暂停这个域'), '不是负责人/项目主时应被拒绝')

  calls.length = 0
  doc.owners['other:asr'].sessionId = 'session-test'
  fs.writeFileSync(domainsFile, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  const allowed = await run('pause', 'domain other:asr')
  caseOk(allowed.kind === 'success', '域负责人应能按下自己那个域')
  caseOk(calls[0][1].scope === 'domain' && calls[0][1].domain === 'other:asr', '应按 domain 级暂停该键')
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

// 14. 体系主身份下 /handoff 必须按体系层建会话（这是主会话换届的根因修复）
{
  calls.length = 0
  const out = await run('handoff', '')
  caseOk(out.kind === 'success', '体系主交接应成功')
  const args = calls.find((c) => c[0] === 'create')?.[1]
  caseOk(args.layer === 'system', '体系主交接应按 system 层建会话')
  caseOk(args.domain === 'tixiweihu:system', '体系主交接应指向该体系的注册键')
  caseOk(args.claim === true, '体系主交接必须 claim（写注册册，不是 owners）')
  caseOk(String(args.title).startsWith('【体系】'), '体系主接任标题应带【体系】前缀')
}

// 15. /register project --takeover：真的强制接手（旧文案承诺过、代码没实现）
{
  upsertRegistration(domainsFile, { key: 'other:main', layer: 'project', project: 'other', domain: 'main', sessionId: 'session-other', since: new Date().toISOString(), by: 'session-other', title: '', note: '' })
  const refused = await run('register', 'project other')
  caseOk(refused.kind === 'error' && refused.text.includes('--takeover'), '冲突时应指出 --takeover 这条路')
  const forced = await run('register', 'project other --takeover')
  caseOk(forced.kind === 'success', '--takeover 应真的覆盖')
  const doc = readRegistrations(domainsFile).doc
  caseOk(doc.registrations['other:main'].sessionId === 'session-test', '覆盖后应指向本人')
  caseOk(String(doc.registrations['other:main'].note).includes('session-other'), '前任必须写进 note 留痕')
  caseOk(!doc.registrations['--takeover:main'], '--takeover 不能被当成项目名写成脏键')
}

// 16. /resume 存在，且把 state=active 传给同一个 set_domain_state 定义
{
  calls.length = 0
  const out = await run('resume', 'self')
  caseOk(out.kind === 'success', '/resume 应成功')
  caseOk(calls[0][1].state === 'active' && calls[0][1].scope === 'session', '恢复应传 state=active / scope=session')
}

// 17. 裸跑 /pause 与 /resume 是只读的一屏：列出真的被按下的，且零写操作
{
  const { writeDomainStateAtomic } = await import('../lib/core/pause.js')
  writeDomainStateAtomic(stateDir, 'session-test', { paused: true, pausedAt: new Date().toISOString(), pausedBy: 'session-test', pauseNote: '测试用' }, 'session')
  calls.length = 0
  const out = await run('resume', '')
  caseOk(out.kind === 'success' && out.text.includes('当前的暂停记录'), '裸跑 /resume 应列出暂停记录')
  caseOk(out.text.includes('session-test'), '记录里应列出被按下的键')
  caseOk(out.text.includes('就是你'), '自己那一级被按下时要标出来')
  caseOk(calls.length === 0, '裸跑 /resume 不能触发任何写操作')
}

// 18. /handoff 默认任务文案：不能假设有体系交接包，也不能说"交接参数由 /handoff 写入"
{
  calls.length = 0
  await run('handoff', '')
  const args = calls.find((c) => c[0] === 'create')?.[1]
  caseOk(!args.task.includes('交接参数由 /handoff 写入'), '不能再说"交接参数由 /handoff 写入"（它不写任何文件）')
  caseOk(args.task.includes('_registry\\handoff.json') && args.task.includes('不用去找'), '这个 cwd 没有交接包时应明确说不用去找')
  caseOk(args.task.includes('注册册'), '应说明在任身份只在注册册里')
}

// 19. /handoff retire=now：建成功后当场退役（复用 /retire 同一份实现）
{
  calls.length = 0
  const out = await run('handoff', 'retire=now')
  caseOk(out.kind === 'success', 'retire=now 应成功')
  caseOk(out.text.includes('前任退役（当场执行）'), '回执应说明当场退役')
  caseOk(out.text.includes('退役≠删除') || out.text.includes('已按 session 级暂停'), '退役实现应真的跑过')
}
// 20. v0.8.7：`--confirm` 必须对得上次确认（以前第一次只是回一句话、服务端零状态）
{
  calls.length = 0
  const freshAgent = { id: 'session-fresh0001', session: {} }
  const out = await byName['pause-all'].handler({ agent: freshAgent, rawInput: 'global 注入风险 --confirm' })
  caseOk(out.kind === 'error' && out.text.includes('没有待确认'), '没有先发一次时 --confirm 必须被拒')
  caseOk(calls.length === 0, '被拒时不得调用暂停')
}

// 21. 待确认过期（>60 秒）必须拒，并清掉待确认
{
  const pendingFile = path.join(stateDir, 'pause-all-pending', 'session-test.json')
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true })
  fs.writeFileSync(pendingFile, JSON.stringify({ scope: 'global', reason: '旧确认', at: new Date(Date.now() - 120000).toISOString() }), 'utf8')
  calls.length = 0
  const out = await run('pause-all', 'global 旧确认 --confirm')
  caseOk(out.kind === 'error' && out.text.includes('已过期'), '超过 60 秒的确认必须被拒')
  caseOk(calls.length === 0, '过期时不得执行')
  caseOk(!fs.existsSync(pendingFile), '过期后应清掉待确认')
}

// 22. 待确认的层级对不上 ⇒ 拒（防"确认了 A 却执行 B"）
{
  const pendingFile = path.join(stateDir, 'pause-all-pending', 'session-test.json')
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true })
  fs.writeFileSync(pendingFile, JSON.stringify({ scope: 'project', reason: 'x', at: new Date().toISOString() }), 'utf8')
  calls.length = 0
  const out = await run('pause-all', 'global x --confirm')
  caseOk(out.kind === 'error' && out.text.includes('待确认的是'), '层级不一致必须拒')
  caseOk(calls.length === 0, '层级不一致时不得执行')
}

// ---------------------------------------------------------------------------
// v0.8.7 第二组：需要 agents / webServer 的入口（短号解析、向导链接）
// 前面的 defsOut 用的是极简 ctx，这里另建一套更接近真机的 ctx。
const ctx2 = {
  get: (name) => {
    if (name === 'workingDirectory') return { get: () => cwd }
    if (name === 'agents') {
      return {
        get: (id) => (id === 'session-known1' ? { id } : null),
        roots: () => [{ id: 'session-known1' }, { id: 'session-known2' }],
      }
    }
    if (name === 'webServer') return { getOrigin: () => 'http://127.0.0.1:6707' }
    return undefined
  },
}
const defs2 = Object.fromEntries(buildCommandDefs(ctx2, { config, defs, runInitialize }).map((d) => [d.name, d]))
const run2 = (name, rawInput = '', extra = {}) => defs2[name].handler({ agent, rawInput, ...extra })

// 23. /handoff target=<现存会话>：v1 以前直接拒绝，现在真的写注册册
{
  upsertRegistration(domainsFile, { key: 'proj:main', layer: 'project', project: 'proj', domain: 'main', sessionId: 'session-test', title: '', note: '' })
  const out = await run2('handoff', 'target=session-known1')
  caseOk(out.kind === 'success' && out.text.includes('交接完成'), 'target=<现存会话> 应成功')
  const doc = readRegistrations(domainsFile).doc
  caseOk(doc.registrations['proj:main'].sessionId === 'session-known1', '注册册应指向目标会话')
  caseOk(String(doc.registrations['proj:main'].note).includes('session-test'), '前任必须写进 note 留痕')
  caseOk(out.text.includes('还在任'), '默认必须提醒前任还活着（退役不会自己发生）')
}

// 24. 短号只在唯一命中时接受；命中多条必须拒（不猜人）
{
  const ambiguous = await run2('handoff', 'target=sess-known')
  caseOk(ambiguous.kind === 'error' && ambiguous.text.includes('命中 2 条'), '多条命中时必须拒绝并报数量')
  caseOk(ambiguous.text.includes('session-known1') && ambiguous.text.includes('session-known2'), '拒绝时应给出候选')
}

// 25. target 形状不对 / 就是自己 ⇒ 拒
{
  const bad = await run2('handoff', 'target=abc')
  caseOk(bad.kind === 'error', '不是会话 id 形状的 target 应被拒')
  const self = await run2('handoff', 'target=session-test')
  caseOk(self.kind === 'error' && self.text.includes('你自己'), 'target=自己 应被拒')
}

// 26. key= 只能在自己真持有的身份里选
{
  const out = await run2('handoff', 'key=someone:system')
  caseOk(out.kind === 'error' && out.text.includes('并不持有'), '不持有的键必须拒')
  upsertRegistration(domainsFile, { key: 'tixiweihu:system', layer: 'system', project: 'tixiweihu', domain: 'system', sessionId: 'session-test', title: '', note: '' })
  calls.length = 0
  const ok = await run2('handoff', 'key=tixiweihu:system')
  caseOk(ok.kind === 'success', '持有该身份时应能按它交接')
  const args = calls.find((c) => c[0] === 'create')?.[1]
  caseOk(args && args.layer === 'system', '应按所选身份建会话')
}

// 27. /handoff wizard：只回本地表单地址，不建任何东西
{
  calls.length = 0
  const out = await run2('handoff', 'wizard')
  caseOk(out.kind === 'success' && out.text.includes('http://127.0.0.1:6707/api/dsh-domain-bridge/handoff-wizard'), '应回本地向导地址')
  caseOk(out.text.includes(encodeURIComponent('session-test')), '地址里要带调用者会话 id')
  caseOk(calls.length === 0, '打开表单不得建任何会话')
}

// 28. /pause session <别人的会话>：没权时拒；体系主可以
{
  calls.length = 0
  const outsider = { id: 'session-outsider', session: {} }
  const denied = await defs2.pause.handler({ agent: outsider, rawInput: 'session session-known1' })
  caseOk(denied.kind === 'error' && denied.text.includes('拒绝动它'), '无身份时动别人的单会话应被拒')
  caseOk(calls.length === 0, '被拒时不得写')
  const allowed = await run2('pause', 'session session-known2')
  caseOk(allowed.kind === 'success', '体系主应能动别人的单会话')
  caseOk(calls[0][1].scope === 'session' && calls[0][1].domain === 'session-known2', '应按 session 级暂停那条会话')
}

// 29. /resume session <id> 走同一份实现，传 state=active
{
  calls.length = 0
  const out = await run2('resume', 'session session-known2 放开了')
  caseOk(out.kind === 'success', '/resume session 应成功')
  caseOk(calls[0][1].state === 'active' && calls[0][1].scope === 'session' && calls[0][1].domain === 'session-known2', '恢复应传 active + scope=session')
}
console.log(`[commands] 用例 ${passed} 条全部通过`)




