/**
 * dsh-domain-bridge — run EVERY test suite with one command.
 *
 * 为什么要有它：`package.json` 的 `scripts.test` 以前只串 `smoke.mjs`，其余 7 个套件
 * （bootstrap / commands / lifecycle / menu / registrations / state / wizard）在 `npm test` 里
 * **根本不跑**——它们的绿是"手动跑过一次"，不是"每次提交都验证"。这里把八个套件串起来，
 * 一条命令给全量结论。
 *
 * 隔离纪律（这条比跑通更重要）：**每个套件一个独立的临时 `DSH_DOMAIN_BRIDGE_HOME`**，
 * 跑完整棵临时目录删掉。绝不允许任何套件落到真实的 `~/.dsh/dsh-domain-bridge`（真机状态目录）
 * 或体系索引 `D:\xiangmu\_registry\domains.json`——那是用户的数据，测试只许碰自己的临时副本。
 * （`smoke.mjs` 自己还会再 mkdtemp 一层并覆盖这个变量，两层都指向临时目录，不冲突。）
 *
 * 用法：
 *   node test/run-all.mjs             # 全部套件
 *   node test/run-all.mjs --no-smoke   # 快速档（跳过最慢的 smoke，供 scripts.test:fast 用）
 *
 * 退出码：全绿 0；任一失败 1（并打印失败套件的输出尾部，一条命令就能看出断言是什么）。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.dirname(here)
const flags = new Set(process.argv.slice(2))
const withSmoke = !flags.has('--no-smoke')

/** 固定顺序（不靠文件名字典序）：先快后慢，smoke 放最后，坏了也能先把快的结论拿到。 */
const ALL_SUITES = [
  'bootstrap.test.mjs',
  'commands.test.mjs',
  'lifecycle.test.mjs',
  'menu.test.mjs',
  'registrations.test.mjs',
  'state.test.mjs',
  'wizard.test.mjs',
  'smoke.mjs',
]
const suites = ALL_SUITES.filter((name) => withSmoke || name !== 'smoke.mjs')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-domain-bridge-runall-'))
const rows = []
let failed = 0

for (const suite of suites) {
  const home = path.join(base, suite.replace(/\.m?js$/, ''))
  fs.mkdirSync(home, { recursive: true })
  const started = Date.now()
  const run = spawnSync(process.execPath, [path.join(here, suite)], {
    cwd: pluginDir,
    env: { ...process.env, DSH_DOMAIN_BRIDGE_HOME: home },
    encoding: 'utf8',
    // smoke 会打上万行分支日志，默认 1MB 的缓冲会被撑爆（ENOBUFS 看起来像测试挂了）。
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const code = run.status === null ? 1 : run.status
  const cases = /用例\s*(\d+)/.exec(output)
  const lines = output.trim().split(/\r?\n/).filter((line) => line.trim())
  rows.push({
    suite,
    code,
    cases: cases ? Number(cases[1]) : null,
    ms: Date.now() - started,
    last: lines.length ? lines[lines.length - 1].trim() : '(no output)',
    tail: lines.slice(-25).join('\n'),
  })
  if (code !== 0) failed += 1
}

fs.rmSync(base, { recursive: true, force: true })

console.log('')
console.log(`=== dsh-domain-bridge test suites (${suites.length}${withSmoke ? '' : '，已跳过 smoke'}) ===`)
for (const row of rows) {
  const count = row.cases === null ? '用例 ?' : `用例 ${row.cases}`
  const status = row.code === 0 ? 'PASS' : `FAIL(${row.code})`
  console.log(`${status.padEnd(9)} ${row.suite.padEnd(22)} ${count.padEnd(10)} ${String(row.ms).padStart(6)}ms  ${row.last}`)
}
const total = rows.reduce((sum, row) => sum + (row.cases ?? 0), 0)
console.log(`=== ${rows.length - failed}/${rows.length} 套件通过 | 用例合计 ${total} ===`)

for (const row of rows.filter((item) => item.code !== 0)) {
  console.log('')
  console.log(`--- ${row.suite} 输出尾部 ---`)
  console.log(row.tail)
}

process.exit(failed ? 1 : 0)
