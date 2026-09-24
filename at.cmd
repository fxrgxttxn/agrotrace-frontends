@echo off
rem `at <command>` for cmd.exe (R88 M6): runs at.ps1, which resolves Git Bash from git (R85) and runs at.sh.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0at.ps1" %*
exit /b %ERRORLEVEL%
