@echo off
rem SwarmCast - uninstall on Windows. Double-click this file.
rem Runs uninstall-windows.ps1 with the execution policy bypassed for this process only,
rem then waits for a key so the result can be read (set SWARMCAST_NO_PAUSE to skip).
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-windows.ps1" %*
set "SC_EXIT=%ERRORLEVEL%"
echo.
if not "%SC_EXIT%"=="0" echo The SwarmCast uninstaller stopped with an error (exit code %SC_EXIT%). Read the messages above.
if not defined SWARMCAST_NO_PAUSE pause
exit /b %SC_EXIT%
