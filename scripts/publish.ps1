#requires -Version 5.1
<#
.SYNOPSIS
  Commit MC Mod Finder into a fresh git repository and set its origin remote.

.DESCRIPTION
  Local operations only: git init / add / commit / remote. No credentials are stored and
  nothing is pushed - the final `git push` is yours, because it needs your GitHub login.

  NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads .ps1 files
  using the system ANSI code page unless they carry a UTF-8 BOM, so non-ASCII characters
  here would be mangled into parse errors (the same trap the project's .vbs launchers
  document).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 -RemoteUrl https://github.com/you/mc-mod-finder.git
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$RemoteUrl,

  # Used only for the local commit record. GitHub will still attribute the commit to your
  # account once you push with your own credentials.
  [string]$Name = 'mc-mod-finder',
  [string]$Email = 'noreply@example.com',

  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'git not found. Install Git for Windows first: https://git-scm.com/download/win'
}

if ($RemoteUrl -notmatch '^https://github\.com/.+/.+$') {
  Write-Host "WARNING: RemoteUrl does not look like https://github.com/<user>/<repo>.git" -ForegroundColor Yellow
}

if (Test-Path (Join-Path $repoRoot '.git')) {
  Write-Host "[1/5] .git already exists - skipping init." -ForegroundColor Yellow
} else {
  Write-Host "[1/5] git init (branch $Branch)" -ForegroundColor Cyan
  git init -b $Branch | Out-Null
}

# Repository-local identity only; your global git config is left untouched.
git config user.name $Name
git config user.email $Email

Write-Host '[2/5] staging files' -ForegroundColor Cyan
git add -A

$staged = @(git diff --cached --name-only)
if ($staged -contains '.env') {
  throw 'ABORT: .env is staged. It may contain CURSEFORGE_API_KEY. Remove it from the index first (git reset .env).'
}

if ($staged.Count -eq 0) {
  Write-Host '[3/5] nothing to commit' -ForegroundColor Yellow
} else {
  Write-Host "[3/5] committing $($staged.Count) files" -ForegroundColor Cyan
  $commitMessage = @'
MC Mod Finder: static browser edition for GitHub Pages

- web/: search, cache, rate limiting, scoring and real download speed sampling all run in
  the visitor's browser; no build step, no dependencies, no backend
- sources: Modrinth (search/tags/direct links/speed test) and CurseForge (bring your own
  key; its CDN forbids cross-origin reads, so those entries say "cannot be measured")
- community panel: Bilibili/Tieba query translation, one-click fan-out, mirror switch,
  optional self-hosted RSS relay for Bilibili entries (off by default)
- publishing: 404.html, .nojekyll, web manifest, GitHub Actions workflow, local preview server
- tests: 65 offline (scoring, cache, limiters, community translation, static site and DOM
  contract) plus 14 live integration checks
'@
  git commit -m $commitMessage | Out-Null
}

$originExists = @(git remote) -contains 'origin'
if ($originExists) {
  Write-Host "[4/5] updating origin -> $RemoteUrl" -ForegroundColor Cyan
  git remote set-url origin $RemoteUrl
} else {
  Write-Host "[4/5] adding origin -> $RemoteUrl" -ForegroundColor Cyan
  git remote add origin $RemoteUrl
}

Write-Host '[5/5] local repository ready.' -ForegroundColor Green
git --no-pager log --oneline -1
Write-Host ''
Write-Host 'NEXT - push (this is where GitHub asks you to sign in):' -ForegroundColor Green
Write-Host "  git push -u origin $Branch" -ForegroundColor White
Write-Host ''
Write-Host 'If the push is rejected because the remote already has commits, run:' -ForegroundColor Gray
Write-Host "  git pull --rebase origin $Branch" -ForegroundColor Gray
Write-Host "  git push -u origin $Branch" -ForegroundColor Gray
Write-Host ''
Write-Host 'Then enable Pages: repository Settings -> Pages -> Source -> "GitHub Actions".' -ForegroundColor Gray
Write-Host "Site URL: https://<user>.github.io/<repo>/" -ForegroundColor Gray
