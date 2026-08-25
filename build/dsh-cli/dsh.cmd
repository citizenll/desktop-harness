@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh.ps1" %*
exit /b %ERRORLEVEL%
