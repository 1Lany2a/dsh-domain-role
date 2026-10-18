# 一次性发布脚本（推 GitHub）。
#
# 凭证只从环境变量读，**绝不写进 remote URL、也绝不落进 .git/config**：
# 推的时候用 GIT_ASKPASS 把 token 交给 git，推完删掉临时脚本。
#
# 用法（PowerShell）：
#   $env:GITHUB_USER  = "你的 GitHub 用户名"
#   $env:GITHUB_TOKEN = "PAT（repo 权限）"
#   $env:GITHUB_REPO  = "https://github.com/<user>/dsh-domain-role.git"
#   .\publish.ps1
#
# 可选：
#   $env:GITHUB_TAG        = "v0.1.1"            # 不给就 v0.1.0
#   $env:GITHUB_COMMIT_MSG = "chore: release"    # 不给就默认那句
#
# 想在提交前先看看会提交什么：先自己跑 `git add -A; git status`，确认完再跑本脚本。

$ErrorActionPreference = "Stop"

foreach ($k in @('GITHUB_USER', 'GITHUB_TOKEN', 'GITHUB_REPO')) {
  if (-not (Get-Item "env:$k" -ErrorAction SilentlyContinue)) {
    throw "缺环境变量 $k（PAT 只进环境变量，别写进文件、别写进命令行参数）"
  }
}

# 远端地址里带凭据（https://user:token@github.com/...）一律拒绝，**不要**替用户悄悄抹掉再推：
# 那种写法会把 token 留在命令行历史与进程列表里，而本脚本的用意就是凭据不进 URL。
if ($env:GITHUB_REPO -match '://[^@/]+@') {
  throw "GITHUB_REPO 里带了凭据，已中止。只给 https://github.com/<user>/<repo>.git，token 走 GITHUB_TOKEN"
}
$repoUrl = $env:GITHUB_REPO.Trim().TrimEnd('/')
if ($repoUrl -notmatch '^https://') {
  throw "GITHUB_REPO 必须是 https:// 开头的地址（实际：$repoUrl）"
}

$tag = if ($env:GITHUB_TAG) { $env:GITHUB_TAG } else { 'v0.1.0' }
$commitMsg = if ($env:GITHUB_COMMIT_MSG) { $env:GITHUB_COMMIT_MSG } else { 'chore: release' }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
if (-not (Test-Path .git)) {
  git init | Out-Null
  git checkout -b main 2>$null | Out-Null
}

# ---- 1) 发布前体检：暂存区只能有白名单里的顶层路径 ----------------------------
# `git add -A` 会把当前目录下所有未跟踪文件都加进来（临时配置、日志、私钥、导出的凭据…
# 都可能混进来）。所以加完立刻核对，超出白名单就中止、不提交。
$allowed = @('README.md', 'LICENSE', 'SECURITY.md', '.gitignore', 'publish.ps1', 'docs/', 'framework/', 'plugins/')

git add -A
if ($LASTEXITCODE -ne 0) { throw "git add -A 失败（退出码 $LASTEXITCODE）" }

$staged = @(git diff --cached --name-only)
if ($staged.Count -eq 0) { throw "暂存区是空的：没有可提交的改动" }

$outside = @($staged | Where-Object {
    $p = $_
    -not ($allowed | Where-Object { $p -eq $_ -or $p.StartsWith($_) })
  })
if ($outside.Count -gt 0) {
  throw ("暂存区里有白名单之外的文件，先确认它们不该被发布：`n  " + ($outside -join "`n  ") +
    "`n（确属有意，就把对应路径加进本脚本的白名单；不要反过来放宽成全部放行）")
}

# ---- 2) 发布前体检：暂存内容里不许有「凭据形状」的字符串 ----------------------
$secretPatterns = @(
  'ghp_[A-Za-z0-9]{20,}'
  'gho_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'sk-[A-Za-z0-9]{20,}'
  'AKIA[0-9A-Z]{16}'
  '-----BEGIN [A-Z ]*PRIVATE KEY'
)
$hits = @()
foreach ($f in $staged) {
  $full = Join-Path (Get-Location).Path $f
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
  $txt = [System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8)
  foreach ($p in $secretPatterns) {
    if ($txt -match $p) { $hits += "$f  <- /$p/" }
  }
}
if ($hits.Count -gt 0) {
  throw ("暂存内容里像是含凭据，已中止（什么都没提交、没推送）：`n  " + ($hits -join "`n  "))
}

# ---- 3) 身份与提交 ------------------------------------------------------------
git config user.name  "$env:GITHUB_USER"
git config user.email "$env:GITHUB_USER@users.noreply.github.com"
git commit -m $commitMsg | Out-Null
if ($LASTEXITCODE -ne 0) { throw "git commit 失败（退出码 $LASTEXITCODE）" }

# ---- 4) 打标签（已存在同名标签就不动它） --------------------------------------
if (-not (git tag -l $tag)) {
  git tag $tag
  if ($LASTEXITCODE -ne 0) { throw "git tag $tag 失败（退出码 $LASTEXITCODE）" }
}

# ---- 5) 推送：token 只经 GIT_ASKPASS 临时脚本交给 git，URL 全程干净 ----------
$askpass = Join-Path ([System.IO.Path]::GetTempPath()) ("gh-askpass-" + [guid]::NewGuid().ToString('N') + ".cmd")
$oldAskpass = $env:GIT_ASKPASS
try {
  Set-Content -LiteralPath $askpass -Encoding ascii -Value @('@echo off', 'echo %GITHUB_TOKEN%')
  $env:GIT_ASKPASS = $askpass
  $env:GIT_TERMINAL_PROMPT = '0'   # 不许交互式提示卡住
  $env:GCM_INTERACTIVE = 'never'   # 不许弹凭据管理器的窗口

  git remote remove origin 2>$null
  git remote add origin $repoUrl   # 干净 URL：没有 user、没有 token

  # `-c credential.helper=` 停掉系统凭据管理器，确保这次只走 askpass、不顺手把 token 存进凭据库
  git -c credential.helper= push -u origin main
  if ($LASTEXITCODE -ne 0) { throw "推 main 失败（退出码 $LASTEXITCODE）；remote URL 里没有凭据，也没留下任何文件" }

  git -c credential.helper= push origin $tag
  if ($LASTEXITCODE -ne 0) { throw "推 tag $tag 失败（退出码 $LASTEXITCODE）" }

  # 推完核验：远端真有这个提交才算成功。**别把"命令没报错"当成推成功。**
  $headSha = (git rev-parse HEAD).Trim()
  $remoteRef = (git ls-remote origin refs/heads/main) -join ''
  if (-not $remoteRef -or -not $remoteRef.StartsWith($headSha)) {
    throw "推完核验失败：远端 refs/heads/main 不是本地 HEAD。本地=$headSha 远端=$remoteRef"
  }
}
finally {
  Remove-Item -LiteralPath $askpass -Force -ErrorAction SilentlyContinue
  if ($oldAskpass) { $env:GIT_ASKPASS = $oldAskpass } else { Remove-Item Env:\GIT_ASKPASS -ErrorAction SilentlyContinue }
  # 兜底：无论上面怎么结束，remote URL 里都不许留凭据
  $u = (git remote get-url origin 2>$null)
  if ($u -and $u -match '://[^@/]*@') { git remote set-url origin $repoUrl }
}

$finalUrl = (git remote get-url origin)
if ($finalUrl -match '://[^@/]*@') { throw "推送结束了但 remote URL 里还有凭据，请立刻手工检查 .git/config" }

Write-Host "已推送并核验：$repoUrl  （tag=$tag，HEAD=$headSha）"
Write-Host "remote URL 干净（不含凭据）；token 只在本进程的环境变量里，脚本没写任何文件。"
