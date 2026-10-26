# Opens a new console window running -Launcher (a .cmd), like a double-click from Explorer.
# GitHub's runner starts job steps in their own process group, which disables Ctrl+C for
# every descendant (the flag is inherited); a user's Explorer never does that. Re-enable
# Ctrl+C here first so the new console behaves like the user's.
param([Parameter(Mandatory = $true)][string]$Launcher, [string]$Title = 'SwarmCast')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ScLaunch {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
}
'@
$ok = [ScLaunch]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)
$p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/d', '/c', "title $Title & `"$Launcher`"" -PassThru
Write-Output ("Ctrl+C re-enabled: {0}; console cmd.exe pid {1}" -f $ok, $p.Id)
