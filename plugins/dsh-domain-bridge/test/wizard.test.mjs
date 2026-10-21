// v0.8.7 handoff wizard — page data contract + the "same implementation" rule.
// Self-contained: fake ctx + a stub handoff definition; no Host, no browser, no network.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { wizardData, wizardHtml, runWizard } from '../lib/core/wizard.js'
import { upsertRegistration } from '../lib/core/registrations.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wizard-'))
const domainsFile = path.join(root, 'domains.json')
const cwd = path.join(root, 'tixiweihu')
fs.mkdirSync(cwd, { recursive: true })
fs.writeFileSync(domainsFile, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), owners: {}, registrations: {} }, null, 2) + '\n', 'utf8')

const sessionId = 'session-wizard0001'
const live = new Set([sessionId])
const ctx = {
  get: (name) => {
    if (name === 'workingDirectory') return { get: () => cwd }
    if (name === 'agents') return { get: (id) => (live.has(id) ? { id } : null), roots: () => [] }
    return undefined
  },
}
const config = { domainsFile, stateDir: path.join(root, 'state'), domainSessionPreset: 'workspace-write', domainSessionModel: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' } }
const deps = { config, commandDefs: [] }

let passed = 0
const ok = (cond, message) => { assert.ok(cond, message); passed++ }

// 1. 没有注册身份时，层级按 cwd 兜底并如实说明
{
  const data = await wizardData(ctx, deps, { sessionId, cwd })
  ok(data.ok === true, 'wizardData 应成功')
  ok(data.layers.length === 1 && data.layers[0].key === 'tixiweihu:main', '无身份时按 cwd 给默认键')
  ok(data.layers[0].detail.includes('按 cwd 推出来'), '兜底层级必须说明来由')
  ok(data.defaultPreset === 'standard', '无身份默认 project 层 ⇒ standard')
  ok(data.defaults.permission === 'workspace-write', '权限档默认取部署配置')
  ok(data.defaults.model === 'commandcode/deepseek/deepseek-v4.1-flash', '模型默认取部署配置')
}

// 2. 注册后按真实身份出层级，体系层默认 cordis
{
  upsertRegistration(domainsFile, { key: 'tixiweihu:system', layer: 'system', project: 'tixiweihu', domain: 'system', sessionId, title: '', note: '' })
  const data = await wizardData(ctx, deps, { sessionId, cwd })
  ok(data.defaultLayer.layer === 'system', '应按注册身份识别为体系层')
  ok(data.defaultLayer.key === 'tixiweihu:system', '键应来自注册册')
  ok(data.defaultPreset === 'cordis', '体系层默认 cordis')
  ok(data.defaults.title.startsWith('【体系】'), '标题默认带【体系】前缀')
  ok(data.defaults.task.includes('PROJECT.md'), '开工任务默认文案应指向 PROJECT.md')
  ok(Array.isArray(data.models.groups) && data.models.empty === true, '没有模型服务时应如实报空目录')
  ok(data.permissions.some((row) => row.value === 'danger-full-access'), '权限档要列出全盘写这一档')
  ok(data.permissions.some((row) => row.value === ''), '权限档要有「部署默认」这一档')
}

// 3. 页面本身：自包含、带数据、不能把 </script> 漏进 HTML
{
  const data = await wizardData(ctx, deps, { sessionId, cwd })
  data.defaults.task = data.defaults.task + ' </script><script>alert(1)</script>'
  const html = wizardHtml(data)
  ok(html.startsWith('<!doctype html>'), '应是完整 HTML')
  ok(html.includes('const DATA ='), '数据应内联进页面')
  ok(!html.includes('</script><script>alert(1)'), '内联 JSON 必须转义 < 防止提前闭合 script')
  ok(html.includes('\\u003c/script'), '应把 < 转成 \\u003c')
  ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(html), '页面不应引用任何外部资源（不联网）')
  ok(html.includes('确认并建会话'), '最后一屏要有明确的执行按钮')
  ok(html.includes('handoff-wizard/run'), '提交地址应是同源的 run 路由')
}

// 4. runWizard：会话离线 ⇒ 不执行
{
  const out = await runWizard(ctx, deps, { sessionId: 'session-gone', params: {} })
  ok(out.ok === false && out.text.includes('没有活 Agent'), '离线会话必须拒绝')
}

// 5. runWizard：走的是同一条 /handoff 定义（params 直传，不拼命令行）
{
  const seen = []
  const withDefs = {
    ...deps,
    commandDefs: [
      {
        name: 'handoff',
        async handler(invocation) {
          seen.push(invocation)
          return { kind: 'success', text: '交接回执' }
        },
      },
    ],
  }
  const out = await runWizard(ctx, withDefs, {
    sessionId,
    params: { key: 'tixiweihu:system', preset: 'cordis', model: 'wb/cn:deepseek-v4.1-flash', perm: 'read-only', title: '【体系】测试', task: '带 空格 的 任务', retireNow: true },
  })
  ok(out.ok === true && out.text === '交接回执', '应返回交接回执')
  const call = seen[0]
  ok(call && call.agent && call.agent.id === sessionId, '必须带上调用者 agent')
  ok(call.params.key === 'tixiweihu:system' && call.params.preset === 'cordis', '参数应结构化直传')
  ok(call.params.model === 'wb/cn:deepseek-v4.1-flash' && call.params.perm === 'read-only', '模型与权限档应直传')
  ok(call.params.task === '带 空格 的 任务', '带空格的任务文本不能被命令行切坏')
  ok(call.params.retire === 'now', 'retireNow 应映射成 retire=now')
  ok(call.params.target === 'new', '向导目前只建新会话')
  ok(call.rawInput === '', '不该再拼一条命令行去解析')
}

// 6. 命令定义缺失时如实拒绝（不偷偷走别的路）
{
  const out = await runWizard(ctx, deps, { sessionId, params: {} })
  ok(out.ok === false && out.text.includes('交接命令不可用'), '缺定义时应如实拒绝')
}

console.log(`[wizard] 用例 ${passed} 条全部通过`)
