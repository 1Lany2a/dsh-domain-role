// v0.7.0 slash commands — argument parsing, authority gates, confirmation, audit.
// Self-contained: fake ctx + fake tool definitions; no Host, no real session.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCommandDefs, defaultHandoffTask } from '../lib/core/commands.js'
import { upsertRegistration, readRegistrations } from '../lib/core/registrations.js'
import {
  buildHandoffCard,
  cardFromBrief,
  handoffTaskText,
  HANDOFF_CARD_RULES,
  HANDOFF_CARD_MAX_BYTES,
} from '../lib/core/handoff-card.js'

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
  caseOk(/^【体系】\d{4}-\d{2}-\d{2} \d{2}:\d{2} · /.test(String(args.title)), '体系主接任标题应带时间戳（v0.8.9 修回：v0.8.5 把它丢了）')
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

// 18. /handoff 默认任务：**没有** PROJECT.md 时退回老文案，并在开头如实写清卡为什么没生成
{
  calls.length = 0
  await run('handoff', '')
  const args = calls.find((c) => c[0] === 'create')?.[1]
  caseOk(
    args.task.startsWith('（交接卡生成失败：project-file-missing'),
    '没有 PROJECT.md 时必须在开头如实写"卡生成失败"的原因',
  )
  caseOk(args.task.includes('不用去找'), '回退文案仍要说明这个目录没有体系交接包（不用去找）')
  caseOk(args.task.includes('注册册'), '回退文案应说明在任身份只在注册册里')
  caseOk(!args.task.includes('交接参数由 /handoff 写入'), '不能再说"交接参数由 /handoff 写入"')
}

// 18.1 交接卡：只取 §当前状态 / §下一步 各前 3 条顶层条目，整卡 ≤2048 B，含 4 条第一轮硬规则
{
  const md = [
    '# PROJECT.md — 测试用',
    '',
    '## 当前状态',
    '',
    '- 状态一：已把换届按层拆开。',
    '- 状态二：首轮耗时几乎全是模型时延。',
    '- 状态三：这第三条不该被截掉。',
    '- 状态四：第四条必须被丢掉（只取前 3 条）。',
    '  - 缩进子项：不属于顶层条目，卡片里不该单独出现。',
    '',
    '## 下一步',
    '',
    '1. 下一步一：移植卡生成器。',
    '2. 下一步二：加 brief 参数。',
    '3. 下一步三：跑隔离 8 套。',
    '',
    '## 别的节',
    '',
    '- 别的节里的这一条不该出现在卡片上。',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(cwd, 'PROJECT.md'), md, 'utf8')
  const card = buildHandoffCard({ stateDir, cwd, key: 'tixiweihu:system', layer: 'system', previousSessionId: 'session-test' })
  caseOk(card.ok === true, `有 PROJECT.md 时应生成交接卡（${card.reason || ''}）`)
  caseOk(card.bytes === Buffer.byteLength(card.markdown, 'utf8'), '回报的字节数必须等于卡的实际 UTF-8 字节数')
  caseOk(card.bytes <= HANDOFF_CARD_MAX_BYTES, `整卡必须 ≤${HANDOFF_CARD_MAX_BYTES} B（实际 ${card.bytes}）`)
  caseOk(card.status.length === 3 && card.next.length === 3, '§当前状态/§下一步 应各取 3 条')
  caseOk(card.markdown.includes('状态三') && !card.markdown.includes('状态四'), '只取前 3 条：第 4 条不得进卡')
  caseOk(!card.markdown.includes('缩进子项'), '缩进子项不算顶层条目')
  caseOk(!card.markdown.includes('别的节里的这一条'), '别的节的条目不得进卡')
  caseOk(HANDOFF_CARD_RULES.every((rule) => card.markdown.includes(rule)), '4 条第一轮硬规则必须全部在卡上')
  caseOk(card.markdown.includes('session-test') && card.markdown.includes('tixiweihu:system'), '卡上要有在任键与上一任会话 id')
  caseOk(fs.existsSync(card.path) && fs.existsSync(card.jsonPath), '卡的 .md 与 .json 都必须真的落盘')
  caseOk(
    path.dirname(card.path) === path.join(stateDir, 'handoff'),
    '卡只许写在 <stateDir>/handoff/（不碰 _registry、不碰域名册）',
  )
  const cardJson = JSON.parse(fs.readFileSync(card.jsonPath, 'utf8'))
  caseOk(cardJson.schema === 'dsh-domain-bridge/handoff-card@1' && cardJson.status.length === 3, '机器读那份要能被解析且带同一份事实')
  caseOk(!card.markdown.includes('_registry'), '卡片里不该出现 _registry（它没写那里）')
}

// 18.2 超长条目也不能超预算（按字节往下压，中文 1 字≈3 字节）
{
  const longDir = path.join(root, 'longcard')
  fs.mkdirSync(longDir, { recursive: true })
  const item = '这一条特别长'.repeat(40)
  fs.writeFileSync(
    path.join(longDir, 'PROJECT.md'),
    `## 当前状态\n\n- ${item}\n- ${item}\n- ${item}\n\n## 下一步\n\n- ${item}\n- ${item}\n- ${item}\n`,
    'utf8',
  )
  const card = buildHandoffCard({ stateDir, cwd: longDir, key: 'other:long8k', layer: 'domain', previousSessionId: 'session-x' })
  caseOk(card.ok === true && card.bytes <= HANDOFF_CARD_MAX_BYTES, `超长条目也必须压到 ≤2048 B（实际 ${card.bytes}）`)
  caseOk(HANDOFF_CARD_RULES.every((rule) => card.markdown.includes(rule)), '压短条目时不得把硬规则挤掉')
}

// 18.3 PROJECT.md 缺失 / 不可读 / 没有那两节：都不许抛，都要如实回报
{
  const emptyDir = path.join(root, 'noproject')
  fs.mkdirSync(emptyDir, { recursive: true })
  const missing = buildHandoffCard({ stateDir, cwd: emptyDir, key: 'x:none', layer: 'domain' })
  caseOk(missing.ok === false && missing.reason === 'project-file-missing', '缺 PROJECT.md 应返回 project-file-missing（不抛）')
  caseOk(missing.markdown === '' && missing.path === null, '缺文件时不给假路径')

  const oddDir = path.join(root, 'oddshape')
  fs.mkdirSync(oddDir, { recursive: true })
  fs.writeFileSync(path.join(oddDir, 'PROJECT.md'), '# 只有标题，没有那两节\n', 'utf8')
  const odd = buildHandoffCard({ stateDir, cwd: oddDir, key: 'x:odd', layer: 'domain' })
  caseOk(odd.ok === true, '结构变了也要出一张卡（身份 + 规则仍在），不能因此失败')
  caseOk(odd.sectionsMissing.length === 2, '拿不到那两节时应如实报 sectionsMissing')

  const noCwd = buildHandoffCard({ stateDir, key: 'x:nocwd', layer: 'domain' })
  caseOk(noCwd.ok === false && noCwd.reason === 'cwd-unknown', '既没 cwd 也没 projectFile 时应返回 cwd-unknown')

  const briefCard = cardFromBrief({ brief: 'x'.repeat(5000), stateDir, key: 'x:brief', layer: 'domain' })
  caseOk(briefCard.ok === true && briefCard.bytes <= HANDOFF_CARD_MAX_BYTES, 'brief 超预算时要按字节截断到 ≤2048 B')
  caseOk(cardFromBrief({ brief: '   ', stateDir, key: 'x:emptybrief' }).reason === 'brief-empty', '空 brief 应被拒')
}

// 18.4 短模板：有卡就只做四件事；模板固定文案 ≤300 字（实例化后多出来的只是路径与会话 id）
{
  const withCard = handoffTaskText({
    layer: 'system',
    key: 'tixiweihu:system',
    cardPath: path.join(stateDir, 'handoff', 'tixiweihu-system.md'),
    previousSessionId: 'session-test',
  })
  caseOk(withCard.includes('本轮只做四件事'), '短模板必须限定"本轮只做四件事"')
  caseOk(withCard.includes('只读这张交接卡'), '短模板必须点名只读那张卡')
  caseOk(withCard.includes('PROJECT.md/changelog/INDEX.md/handoff.json/projectlog'), '短模板必须点名不要读那几份大文件')
  caseOk(withCard.includes('target=session-test'), '短模板必须给出回报目标（上一任会话 id）')
  caseOk(withCard.includes('本轮不改任何文件、不开工'), '短模板必须写明本轮不改文件')
  caseOk(!withCard.includes('注册册'), '短模板不再让人去翻注册册（核身份只要裸跑 /register）')
  // 固定文案 = 去掉卡路径与会话 id 这两个必须给全的标识符之后的部分
  const prose = withCard.split(path.join(stateDir, 'handoff', 'tixiweihu-system.md')).join('').split('session-test').join('')
  caseOk([...prose].length <= 300, `固定文案必须 ≤300 字（实际 ${[...prose].length} 字）`)
  const fallback = defaultHandoffTask({ layer: 'project', key: 'p:main', cwd, cardError: 'project-file-missing' })
  caseOk(fallback.startsWith('（交接卡生成失败：project-file-missing'), '没卡时 defaultHandoffTask 要退回老文案并说明原因')
}

// 18.5 /handoff 默认走卡：任务里带卡的绝对路径，回执点名卡与字节数
{
  calls.length = 0
  const out = await run('handoff', '')
  const args = calls.find((c) => c[0] === 'create')?.[1]
  const expectedPath = path.join(stateDir, 'handoff', 'tixiweihu-system.md')
  caseOk(args.task.includes(expectedPath), '默认任务必须把卡的绝对路径填进去')
  caseOk(args.task.includes('本轮只做四件事') && !args.task.includes('交接卡生成失败'), '默认任务应是短模板（不是回退文案）')
  caseOk(out.text.includes(`交接卡：${expectedPath}`), `回执必须带一行 交接卡：<path>（实际回执片段：${out.text.slice(0, 80)}…）`)
  caseOk(/（\d+ B）/.test(out.text), '回执必须带卡的字节数')
  caseOk(out.text.includes('只读+回报，不会自己开工'), '回执必须说明点开后它只读+回报、不会自己开工')
  caseOk(fs.existsSync(expectedPath), '回执里给的卡路径必须真的存在')
}

// 18.6 显式 task= 时以用户给的为准（卡照生成，但绝不覆盖任务文本）
{
  calls.length = 0
  const out = await run('handoff', 'task=我自己写的开工任务')
  const args = calls.find((c) => c[0] === 'create')?.[1]
  caseOk(args.task === '我自己写的开工任务', `显式 task 必须原样使用（实际：${args.task}）`)
  caseOk(out.text.includes('交接卡：'), '即使显式 task，回执也要报卡（卡是给接任者读的材料）')
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




