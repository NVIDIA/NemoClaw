@echo off
setlocal
if "%~1"=="" (
    echo Usage: run-hsb.cmd ^<profile^>
    echo.
    echo Available profiles:
    powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ". '%~dp0set-hsb-env.ps1'"
    exit /b 1
)
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ". '%~dp0set-hsb-env.ps1' -Profile '%~1'; claude"
endlocal
