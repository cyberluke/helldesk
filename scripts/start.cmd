@echo off
setlocal
where pwsh >nul 2>nul
if errorlevel 1 (
  echo HELLDESK requires PowerShell 7 ^(pwsh^).
  echo Install it from https://aka.ms/powershell and run this again.
  echo.
  pause
  exit /b 1
)
set "NOPAUSE="
for %%A in (%*) do if /I "%%A"=="-NoPause" set "NOPAUSE=1"
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if not defined NOPAUSE pause
exit /b %CODE%
