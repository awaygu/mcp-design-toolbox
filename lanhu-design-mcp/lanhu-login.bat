@echo off
REM Lanhu Login Helper - launches lanhu-login.mjs to export cookie to .mcp-local\lanhu.cookie
REM Double-click to run. No command-line knowledge needed.

REM Compute repo root (two levels up from this bat) and set absolute cookie output path.
REM This must happen BEFORE cd, while %~dp0 still points at this script's dir.
set "REPO_ROOT=%~dp0..\.."
set "COOKIE_OUT=%~dp0..\..\.mcp-local\lanhu.cookie"
set "LANHU_COOKIE_OUT=%COOKIE_OUT%"

cd /d "%~dp0"

echo.
echo ============================================================
echo   Lanhu Login Helper
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node
echo [1/4] Node.js detected:
node -v
echo.

echo [2/4] Installing dependencies (first run downloads, please wait)...
call npm install --no-audit --no-fund
if errorlevel 1 goto npm_fail
echo.

echo [3/4] Installing playwright browser (first run ~120MB, please wait)...
call npx playwright install chromium
echo.

echo [4/4] Launching login...
echo A browser will open. Log in to Lanhu there, then come back here and press Enter.
echo.

if not exist "%COOKIE_OUT%\.." mkdir "%COOKIE_OUT%\.."
node "%~dp0lanhu-login.mjs"
if errorlevel 1 goto login_fail

echo.
echo ============================================================
echo   Login OK! cookie written to:
echo   %COOKIE_OUT%
echo ============================================================
echo.
echo  Next: back to Claude Code, AI will auto-use the new cookie.
echo  (the cookie file is gitignored, safe.)
echo.
pause
exit /b 0

:no_node
echo [ERROR] Node.js not found. Please install Node.js 18+ first.
echo Website: https://nodejs.org/
echo.
pause
exit /b 1

:npm_fail
echo [ERROR] npm install failed. Check network or run "npm install" manually.
echo.
pause
exit /b 1

:login_fail
echo.
echo [ERROR] Login failed. See hints above.
echo.
pause
exit /b 1
