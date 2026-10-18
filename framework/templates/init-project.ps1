<#
.SYNOPSIS
  Idempotent project initializer for the {体系根}\ project family.
  New project: full init. Existing project: only fills missing pieces.

.DESCRIPTION
  What it does (each step is guarded — skips if already present):
  1. Create project directory (if not exists)
  2. git init (if .git missing)
  3. Install pre-commit hook (from {体系根}\templates\pre-commit)
  4. Create/append .gitignore (standard entries: logs/, projectlog/, .main-writer-flag, *.tmp, *.bak*)
  5. Create empty PROJECT.md (if missing)
  6. Create empty KNOWLEDGE.md (if missing)
  7. Create projectlog/ directory (if missing)
  8. Configure local git identity (if not set)
  9. Create 提案/ directory for proposals (if missing)

.PARAMETER Name
  Project name (folder under {体系根}\). Required.

.EXAMPLE
  .\init-project.ps1 -Name 项目丁
  .\init-project.ps1 -Name 项目甲   # existing project: fills gaps only
#>
param(
  [Parameter(Mandatory=$true)]
  [string]$Name
)

$ErrorActionPreference = "Stop"
$ProjectRoot = "{体系根}\$Name"
$TemplateDir = "{体系根}\templates"
$HookSource  = Join-Path $TemplateDir "pre-commit"

function Write-Step($msg) { Write-Host "[init] $msg" -ForegroundColor Cyan }
function Write-Skip($msg) { Write-Host "[skip] $msg - already present" -ForegroundColor Yellow }
function Write-Done($msg) { Write-Host "[ok]   $msg" -ForegroundColor Green }

# --- 1. Project directory ---
if (Test-Path $ProjectRoot) {
  Write-Skip "Directory $ProjectRoot"
} else {
  New-Item -ItemType Directory -Path $ProjectRoot | Out-Null
  Write-Done "Created $ProjectRoot"
}

Set-Location $ProjectRoot

# --- 2. git init ---
if (Test-Path ".git") {
  Write-Skip "git repository"
} else {
  git init 2>&1 | Out-Null
  # Set default branch to main
  git symbolic-ref HEAD refs/heads/main 2>&1 | Out-Null
  Write-Done "git initialized (branch: main)"
}

# --- 3. pre-commit hook ---
$HookDest = ".git\hooks\pre-commit"
if (Test-Path $HookDest) {
  Write-Skip "pre-commit hook"
} else {
  if (Test-Path $HookSource) {
    Copy-Item $HookSource $HookDest -Force
    Write-Done "Installed pre-commit hook"
  } else {
    Write-Host "[warn] Hook source not found: $HookSource — skip" -ForegroundColor Red
  }
}

# --- 4. .gitignore (merge missing entries) ---
# Check by pattern (non-comment, non-empty lines) to avoid duplicates
$StandardEntries = @(
  "logs/",
  "projectlog/",
  ".main-writer-flag",
  "*.tmp",
  "*.bak*"
)
# 绝对路径：下面用 .NET 的 [System.IO.File] 写文件，它按"进程当前目录"解析相对路径，
# 不跟随 PowerShell 的 Set-Location —— 用相对路径会把内容写到脚本的启动目录（2026-09-11 实测踩坑）
$GiPath = Join-Path $ProjectRoot ".gitignore"
if (Test-Path $GiPath) {
  # Read as UTF-8 explicitly (PowerShell 5.x defaults to system codepage)
  $existing = [System.IO.File]::ReadAllLines($GiPath, [System.Text.Encoding]::UTF8)
  # Strip comments/blank, trim whitespace for exact string matching
  $existingEntries = $existing | Where-Object { $_ -and -not $_.StartsWith("#") } | ForEach-Object { $_.Trim() }
  $missing = $StandardEntries | Where-Object { $existingEntries -notcontains $_ }
  if ($missing) {
    # 无 BOM 写入：PS5.1 的 Add-Content（默认 ANSI）/ Set-Content -Encoding UTF8（写 BOM）都不合格
    [System.IO.File]::AppendAllText($GiPath, "`r`n# --- added by init-project.ps1 ---`r`n", (New-Object System.Text.UTF8Encoding($false)))
    foreach ($m in $missing) { [System.IO.File]::AppendAllText($GiPath, $m + "`r`n", (New-Object System.Text.UTF8Encoding($false))) }
    Write-Done "Appended $($missing.Count) entries to .gitignore"
  } else {
    Write-Skip ".gitignore (all entries present)"
  }
} else {
  $GiContent = @(
    "# logs",
    "logs/",
    "",
    "# AI audit logs (separate from runtime logs/)",
    "projectlog/",
    "",
    "# main-session commit flag (auto-consumed by pre-commit hook)",
    ".main-writer-flag",
    "",
    "# temp files",
    "*.tmp",
    "*.bak*"
  )
  # 无 BOM 写入（PS5.1 的 Set-Content -Encoding UTF8 必然带 BOM；-Encoding utf8NoBOM 是 PS7 才有）
  [System.IO.File]::WriteAllText($GiPath, (($GiContent -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Done "Created .gitignore"
}

# --- 5. PROJECT.md ---
if (Test-Path "PROJECT.md") {
  Write-Skip "PROJECT.md"
} else {
  $projContent = @"
# ${Name}

> Project status doc. Only the main session writes this file (唯一写者规则).

## Current State

(empty — fill in as project progresses)

## Recent Changes

(empty)

## Next Steps

(empty)

## Known Pitfalls

(empty)
"@
  [System.IO.File]::WriteAllText((Join-Path $ProjectRoot "PROJECT.md"), $projContent, (New-Object System.Text.UTF8Encoding($false)))
  Write-Done "Created PROJECT.md"
}

# --- 6. KNOWLEDGE.md (总纲/索引) ---
if (Test-Path "KNOWLEDGE.md") {
  Write-Skip "KNOWLEDGE.md"
} else {
  $knowContent = @"
# ${Name} — Project Knowledge (总纲/索引)

> 2026-10-01 起为**总纲 + 域文档**两层：本文件是指引/索引，只由主会话写。
> 各域文档放 KNOWLEDGE\<域>.md，由负责该域的会话自己写（模板见 {体系根}\templates\KNOWLEDGE-域文档.template.md）。
> 没拆域时照旧在本文件里写；两种布局并存，不必强行迁移。

## 一、域清单（谁负责哪块、往哪个文件写）

| 域 | 负责窗口 | 域文档 | 最后更新 |
|---|---|---|---|
| (待拆域时填) | — | KNOWLEDGE/<域>.md | — |

## 二、跨域通用条目

(empty)

## 三、判重 / 合并记录

(empty)

## 四、分发记录

(empty)

## 五、待提炼（[可复用]）

(empty)

---
（旧内容若有，直接留在本文件下方即可，不必迁移）
"@
  [System.IO.File]::WriteAllText((Join-Path $ProjectRoot "KNOWLEDGE.md"), $knowContent, (New-Object System.Text.UTF8Encoding($false)))
  Write-Done "Created KNOWLEDGE.md"
}

# --- 6b. KNOWLEDGE\ 域文档目录（2026-10-01 加） ---
$knowDir = Join-Path $ProjectRoot "KNOWLEDGE"
if (Test-Path $knowDir) {
  Write-Skip "KNOWLEDGE/"
} else {
  New-Item -ItemType Directory -Force -Path $knowDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $knowDir ".gitkeep"), "", (New-Object System.Text.UTF8Encoding($false)))
  Write-Done "Created KNOWLEDGE/ (域文档目录)"
}

# --- 7. projectlog/ ---
if (Test-Path "projectlog") {
  Write-Skip "projectlog/"
} else {
  New-Item -ItemType Directory -Path "projectlog" | Out-Null
  Write-Done "Created projectlog/"
}

# --- 8. git identity ---
$email = git config user.email 2>$null
$name_ = git config user.name 2>$null
if (-not $email) {
  git config user.email "main-session@local"
  git config user.name "Main Session"
  Write-Done "Set local git identity"
} else {
  Write-Skip "git identity ($email)"
}

# --- 9. 提案/ (proposals directory, used by the proposal mechanism) ---
if (Test-Path "提案") {
  Write-Skip "提案/"
} else {
  New-Item -ItemType Directory -Path "提案" | Out-Null
  Write-Done "Created 提案/"
}

# --- 10. Encoding self-check (2026-09-11) ---
# 背景：本脚本曾在 PS5.1 下产出乱码目录名与带 BOM 的文件（脚本自身无 BOM + Set-Content 写 BOM），
# 这类缺陷静默、难察觉，故在收尾处当场自检。
# 关键：判断一律用「Unicode 码点 + 文件字节」，不引用中文字面量 ——
# 否则脚本编码一旦损坏，自检会跟着一起坏，形同虚设。
$problems = New-Object System.Collections.ArrayList

# 10.1 proposals 目录名必须是 U+63D0 U+6848
$expectedProposal = ([string][char]0x63D0) + ([string][char]0x6848)
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $expectedProposal))) {
  [void]$problems.Add("proposals 目录名不正确（期望 U+63D0 U+6848，实际缺失）——多为脚本丢失 UTF-8 BOM 所致")
}

# 10.2 三个产出文件必须无 BOM
foreach ($f in @(".gitignore", "PROJECT.md", "KNOWLEDGE.md")) {
  $fp = Join-Path $ProjectRoot $f
  if (Test-Path $fp) {
    $bytes = [System.IO.File]::ReadAllBytes($fp)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      [void]$problems.Add("$f 带 UTF-8 BOM（应无 BOM）")
    }
  }
}

# 10.3 脚本自身必须带 UTF-8 BOM（含中文的 .ps1 在 PS5.1 下必需）
if ($PSCommandPath -and (Test-Path $PSCommandPath)) {
  $self = [System.IO.File]::ReadAllBytes($PSCommandPath)
  if (-not ($self.Length -ge 3 -and $self[0] -eq 0xEF -and $self[1] -eq 0xBB -and $self[2] -eq 0xBF)) {
    [void]$problems.Add("脚本自身缺少 UTF-8 BOM（含中文的 .ps1 必须带 BOM，否则 PS5.1 按 GBK 误解码）")
  }
}

if ($problems.Count -gt 0) {
  Write-Host ""
  Write-Host "!! SELF-CHECK FAILED ($($problems.Count)) !!" -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "   - $p" -ForegroundColor Red }
  Write-Host "   产物可能损坏，修复后请重跑本脚本。" -ForegroundColor Red
} else {
  Write-Host "[ok]   Self-check passed" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Project $Name ready ===" -ForegroundColor Green
Write-Host "Location: $ProjectRoot"
