@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0at.ps1" %*
exit /b %ERRORLEVEL%
