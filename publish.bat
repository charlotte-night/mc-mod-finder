@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  MC Mod Finder - local git setup, then push to GitHub.
rem
rem  ASCII only on purpose: this project already documents (for the .vbs launchers)
rem  that cmd.exe/PowerShell 5.1 read these files with the system code page.
rem
rem  Why a commit-message FILE instead of -m "text": PowerShell 5.1 splits a
rem  multi-line variable into several arguments when calling a native program, so
rem  git saw the message words as pathspecs and the commit never happened.
rem ---------------------------------------------------------------------------

cd /d "%~dp0.."

where git >nul 2>nul
if errorlevel 1 (
  echo [X] git not found. Install Git for Windows: https://git-scm.com/download/win
  pause
  exit /b 1
)

set REMOTE=https://github.com/charlotte-night/mc-mod-finder.git
set BRANCH=main
set MSGFILE=%TEMP%\mmf-commit-message.txt

echo === 1/6 repository ===
if exist ".git" (
  echo     .git already exists, skipping init
) else (
  git init -b %BRANCH% || goto :failed
)

rem repository-local identity only; your global git config is not touched
git config user.name "mc-mod-finder"
git config user.email "noreply@example.com"

echo === 2/6 commit message ===
> "%MSGFILE%" echo MC Mod Finder: static browser edition for GitHub Pages
>>"%MSGFILE%" echo.
>>"%MSGFILE%" echo - web/: search, cache, rate limiting, scoring and real download speed sampling all run
>>"%MSGFILE%" echo   in the visitor's browser; no build step, no dependencies, no backend
>>"%MSGFILE%" echo - sources: Modrinth (search/tags/direct links/speed test) and CurseForge (bring your
>>"%MSGFILE%" echo   own key; its CDN forbids cross-origin reads, so those entries say "cannot be measured")
>>"%MSGFILE%" echo - community panel: Bilibili/Tieba query translation, one-click fan-out, mirror switch,
>>"%MSGFILE%" echo   optional self-hosted RSS relay for Bilibili entries (off by default)
>>"%MSGFILE%" echo - publishing: 404.html, .nojekyll, web manifest, GitHub Actions workflow, preview server
>>"%MSGFILE%" echo - tests: 65 offline (scoring, cache, limiters, community translation, static site and
>>"%MSGFILE%" echo   DOM contract) plus 14 live integration checks

echo === 3/6 staging files ===
git add -A || goto :failed

git diff --cached --name-only | findstr /x /c:".env" >nul
if not errorlevel 1 (
  echo [X] .env is staged. It may contain CURSEFORGE_API_KEY.
  echo     Run: git reset .env    then try again.
  goto :failed
)

echo === 4/6 commit ===
git commit -F "%MSGFILE%" || goto :failed

echo === 5/6 remote ===
git remote | findstr /x /c:"origin" >nul
if errorlevel 1 (
  git remote add origin %REMOTE% || goto :failed
) else (
  git remote set-url origin %REMOTE% || goto :failed
)

echo === 6/6 done ===
git --no-pager log --oneline -1
echo.
echo NEXT: push (GitHub will ask you to sign in):
echo     git push -u origin %BRANCH%
echo.
echo If the push is rejected because the remote already has commits:
echo     git pull --rebase origin %BRANCH%
echo     git push -u origin %BRANCH%
echo.
echo Then: repository Settings -^> Pages -^> Source -^> "GitHub Actions".
echo Site: https://charlotte-night.github.io/mc-mod-finder/
echo.
pause
exit /b 0

:failed
echo.
echo [X] Something failed above. Nothing was pushed. Copy the last lines back to the agent.
pause
exit /b 1
