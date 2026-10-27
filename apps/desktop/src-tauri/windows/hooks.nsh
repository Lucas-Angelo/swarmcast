; SwarmCast hooks for Tauri's NSIS installer template (tauri.conf.json:
; bundle > windows > nsis > installerHooks). See docs/DESKTOP.md, "Installers".
;
; This file is included near the top of the template, before PRODUCTNAME and friends are
; defined, so names are written out here. LogicLib (${If}) and the template's utils.nsh
; (CheckIfAppIsRunning) are already included.

!define SC_DATA_DIR "$LOCALAPPDATA\SwarmCast"
!define SC_INSTALL_DIR "$LOCALAPPDATA\Programs\SwarmCast"

; Install folder: the template's per-user default is $LOCALAPPDATA\<product>, which is
; SwarmCast's data folder (settings, secrets, logs). Programs go to $LOCALAPPDATA\Programs
; like other per-user apps. MUI calls this after .onInit has set $INSTDIR (and restored a
; previous install location), before the first page is shown.
!define MUI_CUSTOMFUNCTION_GUIINIT SwarmCastGuiInit
Function SwarmCastGuiInit
  ${If} $INSTDIR == "${SC_DATA_DIR}"
    StrCpy $INSTDIR "${SC_INSTALL_DIR}"
  ${EndIf}
FunctionEnd

; Stops everything still running from the install folder (the server, MediaMTX,
; cloudflared). Normally nothing is left: closing SwarmCast.exe closes its Job object, which
; ends the server and every process it started (ffmpeg included).
; Never the uninstaller itself: run in place (`uninstall.exe /S _?=<dir>`, as
; scripts/uninstall-windows.ps1 does) it lives in the install folder too, and killing it ended
; every such uninstall with exit code -1 before its own steps ran.
!macro SwarmCastStopProcesses
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$dir = '$INSTDIR\'; Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$dir, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($$_.Path) -ne 'uninstall.exe' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Silent installs (/S) never show the GUI, so SwarmCastGuiInit did not run: still never
  ; install into the data folder.
  ${If} $INSTDIR == "${SC_DATA_DIR}"
    StrCpy $INSTDIR "${SC_INSTALL_DIR}"
    SetOutPath $INSTDIR
  ${EndIf}
  ; Ask to close a running SwarmCast (the template's own prompt; automatic in passive and
  ; update mode), then stop whatever it left running from this folder.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\SwarmCast.exe" "SwarmCast"
  !insertmacro SwarmCastStopProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\SwarmCast.exe" "SwarmCast"
  !insertmacro SwarmCastStopProcesses
  ${If} $UpdateMode <> 1
    ; Remove a router port mapping left open by a crash (Direct mode).
    ${If} ${FileExists} "$INSTDIR\swarmcast-server.exe"
      DetailPrint "swarmcast-server --cleanup"
      nsExec::Exec `"$INSTDIR\swarmcast-server.exe" --cleanup`
      Pop $0
    ${EndIf}
    ; "Start with the computer" (written by the server, apps/server/src/desktop/autostart.ts).
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SwarmCast"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The data folder (settings, secrets, logs, ffmpeg) is kept unless the user ticked
  ; "delete the application data", and never on updates. Script mode uses the same folder.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "${SC_DATA_DIR}"
  ${EndIf}
!macroend
