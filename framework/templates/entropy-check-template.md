# 熵体检清单模板（项目健康度检查）

> 用途：项目主会话做"熵体检"时照本文件跑，量化项目是否走向失控（巨型单文件、文件疯涨、僵尸堆积、分支堆积）。
> 机制：熵体检=定期量体温，不是治病。跑完出报告 + 判级；**红灯只触发"派域会话评估"**，不自动定死处理方案（巨型文件有时是合理聚合，评估后可拆可不拆）。
> 节奏：每月或里程碑（如每 5 个项目/大功能完成后）；纳入各项目主会话的月度审查。
> 建立：2026-09-03。

## 0. 关键口径（先读）

- **只统计自家代码，排除第三方/vendored**：`node_modules`、`py-tools\`（项目甲 的 vendored 库）、`bin\obj` 等目录一律不算——第三方生成的 2 万行文件不是你的熵。
- 排除运行产物与日志：`logs`、`projectlog`、`.git`。
- 自家代码文件类型按项目定：C# 项目数 `.cs .xaml`，脚本项目数 `.ps1 .py .bat`。
- 判级阈值是**参考软标准**：绿/黄/红只是触发讨论的档位，不是硬指标。

## 1. 指标与命令（PowerShell 只读，照抄即可）

### 指标 A：最大文件行数（巨型单文件）
```powershell
$root='<项目根>'; $exclude='\\(bin|obj|node_modules|\.git|logs|projectlog|py-tools)\\'
Get-ChildItem -Path $root -Recurse -Include *.cs,*.xaml,*.ps1,*.py -File |
  Where-Object { $_.FullName -notmatch $exclude } |
  ForEach-Object { [PSCustomObject]@{ Lines=(Get-Content $_.FullName | Measure-Object -Line).Lines; File=$_.FullName.Replace($root,'') } } |
  Sort-Object Lines -Descending | Select-Object -First 5 | Format-Table -AutoSize
```
判级：最大 <500 绿 / 500–1500 黄 / >1500 红。
红灯动作：派域会话评估——是"职责边界确实该拆"还是"巨型但职责单一"；拆类时机看**职责边界，不按时间轴**（经验见 `{知识库}\aspects\general.md` 巨型类条目）。

### 指标 B：文件增长（相对上次体检快照）
先取总行数基线：
```powershell
$root='<项目根>'; $exclude='\\(bin|obj|node_modules|\.git|logs|projectlog|py-tools)\\'
(Get-ChildItem -Path $root -Recurse -Include *.cs,*.xaml,*.ps1,*.py -File |
  Where-Object { $_.FullName -notmatch $exclude } |
  Get-Content | Measure-Object -Line).Lines
```
对比上次报告里记录的总行数：月增幅 =（本次−上次）/上次。
判级：<30% 绿 / 30–100% 黄 / >100% 红。
红灯动作：查是否有重复造轮子/功能越滚越大，考虑拆项目或归档旧模块。

### 指标 C：僵尸文件（git 跟踪但长期未动）
> 口径修正（2026-09-03 首轮试跑发现）：**只统计自家代码文件**，排除 `docs\` 文档、
> `config\` 配置、vendored 库——文档/手册本来就不该经常动，不算僵尸。
> 中文文件名需 `-c core.quotepath=false`，否则 git 输出带引号+转义导致路径报错。
```powershell
git -c core.quotepath=false ls-files | Where-Object { $_ -match '\.(cs|ps1|py|xaml)$' } | ForEach-Object {
  $f = Get-Item $_ -ErrorAction SilentlyContinue
  if ($f -and $f.LastWriteTime -lt (Get-Date).AddDays(-90)) { $_ }
}
```
判级：僵尸代码占比（僵尸代码数/代码文件总数）<10% 绿 / 10–20% 黄 / >20% 红。
红灯动作：归档或删除前由用户确认（如 项目甲 `docs\archive\` 的归档先例）；**严禁主会话/域会话自行批量删**。

### 指标 D：未合并分支 + 陈旧已合并分支
```powershell
# 1) 真正未合并的分支（可能有未合入 main 的提交）：
git branch --no-merged main
# 2) 全部本地分支与最近提交时间（看有没有"已合并但没删"的陈旧分支）：
git for-each-ref refs/heads --sort=-committerdate --format='%(refname:short)|%(committerdate:relative)'
# 3) 确认某个分支是否已合并：git branch --merged main | Select-String '<分支名>'
```
判级：未合并分支数 <3 绿 / 3–10 黄 / >10 红；**并查**是否有 `git branch --merged main` 之下
已合并却残留 >2 个月的陈旧分支（本轮两项目真实情况：S18–S21、Z01–Z06 全属此类——使命完成了，
分支没删，纯属流程尾巴，不是真未合并）。
红灯动作：已合并的陈旧分支 → `git branch -d <名>` 直接删（安全，改动已在 main）；
真未合并的 → 确认使命是否完成，完成就合并，未完成写清状态。

## 2. 报告格式（照此写，存项目自己的 projectlog\）

存：`<项目根>\projectlog\entropy-YYYY-MM.md`（和 AI 审计日志同目录，随项目走；体系侧只汇总红灯）。

```
[体检日期]：YYYY-MM-DD
[项目]：<项目名>（git 当前分支：xxx）
[4 项快照]：
- 最大文件：<路径> <行数> → <绿/黄/红>
- 总行数：<本次>（上次 <N>，增幅 <x%>）→ <绿/黄/红>
- 僵尸文件：<n>/<total>（<x%>）→ <绿/黄/红>
- 未合并分支：<n> 个，最老 <x> → <绿/黄/红>
[会话层 think 丢失]：<n> 块（可选，见第 4 节；不参与上面 4 项判级）
[红灯项处理建议]：<每条红灯一句话建议，如：派 S## 评估拆 CollectorGuiApp.cs>
[快照留存]：本次总行数基线已记录于本报告，下次对比用
```

## 3. 跑完怎么办

- 全绿 → 报告留档即可，收工。
- 有黄/红 → **红灯项派域会话评估**（走三段式，使命名如 `S##-entropy-xxx`），评估结论（拆/不拆/合并/归档）由域会话达成报告带回，主会话按结论更新项目 PROJECT.md 待办。
- 主会话角色不变：只跑只读命令出报告 + 派发，不自己动手改代码。

## 4. 附：会话级体检（think 丢失，可选，**不参与上面 4 项判级**）

> 层次不同：指标 A~D 量的是**项目代码**的熵，这一条量的是**聊天记录层**的损失——
> 某段思考因"流式中断"（想到一半按停止/插话）被永久丢弃，dsh 之后**不再把它发给模型**。
> 只读、离线、免费；不改配置、不重启 dsh。工具：`{体系根}\tools\think-loss-scan.mjs`（体系侧维护）。

```powershell
# 只算真会话（自动子代理已过滤）、近 3 天全盘
node {体系根}\tools\think-loss-scan.mjs --all --days 3 --top-level-only
# 只看当前会话（最近活跃的那个）
node {体系根}\tools\think-loss-scan.mjs
```

判级：真会话丢失块数 **0 绿 / 1–3 黄 / >3 红**。
红灯动作 = 提醒用户"那几轮被中断的思考已无法回放，需要时让它重想一遍"——
**不要把旧思考塞回上下文当正文**（语义会变，等于把思考当事实喂回）。
口径：**`--all` 必须带 `--top-level-only`**，否则 Mnemon 空闲自动子代理会虚高计数
（2026-09-12 实测：121 个会话里 75 个是子代理）；会话类型只认存档第一条 `session` 记录。
判据边界：本工具只回答"某段思考是否已不可能被回放"（存档事实），
**不能**回答"中转站是否还在剥 reasoning 字段"（那是另一支裸调 API 的脚本，须用户自己在终端跑）。

## 5. Generated 边界扫描（跨项目，顺跑；**不参与上面 4 项判级**。2026-10-08 按"产物落位约定"加）

> **判据一句话**：**被活文档引用的东西，不许留在 `{数据根}\Generated\`**。
> 命中 ⇒ 按约定落位（备份/交付物/原型 → `{数据根}\backups\{skills,templates,tools}\`；脚本 → `{数据根}\tools\`；项目资产 → 该项目目录内），**旧目录留 `MOVED-TO.md` + 改活文档里的路径**，历史叙述不动。
> 为什么机械扫：这套边界**已经漏过两次**（2026-10-08 交接前才发现第 9 条；同日复核又发现 5 类），根因＝当时只按**人工清单**搬、没有可机械判定的标准。

**先替换占位符再跑**：把下面代码里的 `{体系根}` / `{知识库}` / `{数据根}` 换成你机器上的真实目录（例如 `$env:DSH_SYSTEM_ROOT`、`$env:DSH_DATA_ROOT`，或直接写绝对路径）。**不替换就跑，A/B 两次扫描都会静默返回 0 条、且不报错**——别把"没输出"当成"没问题"。

```powershell
# A) 活文档里引用的 Generated 路径：滤掉模板占位符/通配符，再标"在/缺"
#    缺 = 断链（该补"已迁至"指针）；在 = 仍留在 Generated 的候选（按落位约定该搬走）
$docs = Get-ChildItem '{体系根}','{知识库}',"$env:USERPROFILE\.dsh\skills" -Recurse -File -Include *.md,*.txt,*.mjs -ErrorAction SilentlyContinue
$refs = $docs | Select-String -Pattern '{数据根}\\Generated\\[^`\s"''）)]+' -AllMatches -Encoding utf8 |
        ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Sort-Object -Unique |
        Where-Object { $_ -notmatch '[<>*?…{}（）]' -and $_ -notmatch 'Generated\\?$' }
$refs | ForEach-Object { $st='?'; try { $st = @('缺','在')[[int](Test-Path -LiteralPath $_)] } catch {}; "$st  $_" } | Sort-Object

# B) Generated 里"长得像体系级东西"的文件（关键词粗筛，命中人工复核）
Get-ChildItem '{数据根}\Generated' -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'session-registry|dispatch-template|mission\.mjs|SYSTEM-|init-project|dsh-knowledge-base|call-local|vision-desc' } |
  Select-Object @{n='路径';e={$_.FullName.Replace('{数据根}\Generated\','')}}, @{n='KB';e={[math]::Round($_.Length/1KB,1)}} | Sort-Object 路径
```

**口径**：A 的路径抽取是**粗筛**（正则截到分隔符/引号），`?` ＝路径含非法字符或抽取有误，命中后人工看一眼；B 的关键词表**刻意不含 `.bak`**（会把各项目自己的配置备份一起捞进来，那是项目侧的事）。

## 6. 示例（2026-09-03 首轮试跑，见各项目 projectlog\entropy-2026-09.md）
