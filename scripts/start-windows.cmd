@echo off
rem SwarmCast - install, update and start on Windows. Double-click this file.
rem Runs start-windows.ps1 with the execution policy bypassed for this process only.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1" %*
set "SC_EXIT=%ERRORLEVEL%"
if "%SC_EXIT%"=="0" goto done
echo.
echo SwarmCast setup stopped with an error (exit code %SC_EXIT%). Read the messages above.
if not defined SWARMCAST_NO_PAUSE pause
:done
exit /b %SC_EXIT%
