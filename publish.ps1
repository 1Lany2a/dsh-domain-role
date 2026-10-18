# 一次性发布脚本（首次推 GitHub）。凭证只从环境变量读，不落盘。
# 用法（PowerShell）：
#   $env:GITHUB_USER = "你的 GitHub 用户名"
#   $env:GITHUB_TOKEN = "生成的 PAT（repo 权限）"
#   $env:GITHUB_REPO = "https://github.com/<user>/dsh-domain-role.git"
#   .\publish.ps1
$ErrorActionPreference = "Stop"
if (-not $env:GITHUB_USER -or -not $env:GITHUB_TOKEN -or -not $env:GITHUB_REPO) {
  throw "缺环境变量：GITHUB_USER / GITHUB_TOKEN / GITHUB_REPO 三个都要有（PAT 只进环境变量，别写进文件）"
}
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
if (-not (Test-Path .git)) {
  git init | Out-Null
  git checkout -b main 2>$null | Out-Null
}
git config user.name  "$env:GITHUB_USER"
git config user.email "$env:GITHUB_USER@users.noreply.github.com"
git add -A
if (git status --porcelain) { git commit -m "chore: v0.1.0 — initial public release" }
git remote remove origin 2>$null
git remote add origin "https://$($env:GITHUB_USER):$($env:GITHUB_TOKEN)@$($env:GITHUB_REPO -replace '^https://','')"
git tag -f v0.1.0
git push -u origin main
git push origin v0.1.0
git remote set-url origin $env:GITHUB_REPO   # 推完把 token 从 remote URL 里去掉
Write-Host "已推送。仓库地址：$env:GITHUB_REPO"
