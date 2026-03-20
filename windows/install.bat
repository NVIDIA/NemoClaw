@echo off
:: NemoClaw Windows Installer
:: Double-click this file to begin installation.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if %ERRORLEVEL% neq 0 pause
pause
