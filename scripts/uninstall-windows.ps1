# SwarmCast - uninstall on Windows 10/11.
#
# Double-click uninstall-windows.cmd, or run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-windows.ps1 [options]
#
# Options (PowerShell or GNU spelling): -KeepSettings / --keep-settings, -Ask / --ask,
# -Yes / --yes (accepted; nothing is asked by default), -Help / --help.
#
# It stops SwarmCast if it is running, removes a router port that a crash may have
# left open (Direct mode), then deletes the SwarmCast data folder. It never touches
# OBS or anything outside the SwarmCast data folder, and writes nothing to disk.
#
# Compatible with Windows PowerShell 5.1. This file is ASCII-only on purpose
# (PowerShell 5.1 reads BOM-less files as ANSI); symbols are built from char codes.
#
# Development aid: it also runs with pwsh on Linux/macOS (the Windows-only parts,
# such as the Ctrl+C sent to SwarmCast's console, are skipped there).

$ScriptArgs = @($args)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SC_IssuesUrl = 'https://github.com/Lucas-Angelo/swarmcast/issues'
$SC_ObsNote = 'Your OBS settings were not changed. Remove the SwarmCast target/server from OBS yourself if you want.'
# Entries the app creates in its data folder; at least one must be present before
# anything is deleted (protects against a wrong SWARMCAST_HOME).
$SC_Markers = @('app', 'config.json', 'secrets.json', 'state.json', 'logs', 'run', 'bin', 'tools', 'cache', 'blocklists', 'system-check.json')
$SC_Keep = @('config.json', 'secrets.json')
$SC_CleanupTimeout = 60
# SWARMCAST_STOP_GRACE / SWARMCAST_DELETE_DELAYS: shorter waits for the tests.
$SC_StopGrace = 10
if ("$env:SWARMCAST_STOP_GRACE" -match '^\d+$') { $SC_StopGrace = [int]$env:SWARMCAST_STOP_GRACE }
$SC_DeleteDelays = @(1, 2, 3, 4)
if ("$env:SWARMCAST_DELETE_DELAYS" -match '^[\d ]+$') { $SC_DeleteDelays = @(("$env:SWARMCAST_DELETE_DELAYS" -split ' ') | Where-Object { $_ } | ForEach-Object { [int]$_ }) }

$script:OnWindows = ($env:OS -eq 'Windows_NT')
$script:Opt = @{ KeepSettings = $false; Ask = $false; Help = $false }
$script:ExitCode = 0
$script:Result = ''

function Show-Usage {
  Write-Host @'
SwarmCast uninstaller for Windows: stops SwarmCast, removes a router port a crash
may have left open, and deletes the SwarmCast data folder.

Usage: uninstall-windows.cmd [options]
       powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-windows.ps1 [options]

Options:
  --keep-settings  (-KeepSettings)  Keep your settings and stream key (config.json,
                                    secrets.json); reinstalling later gives you the
                                    same stream key
  --ask            (-Ask)           Ask for confirmation before removing anything
  --yes            (-Yes)           Accepted for compatibility (nothing is asked by default)
  --help           (-Help)          Show this help

Environment:
  SWARMCAST_HOME   Data folder (default: %LOCALAPPDATA%\SwarmCast)

OBS and its settings are never changed. Nothing outside the data folder is deleted.
'@
}

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

function Initialize-Console {
  $unicode = $false
  try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    # Windows Terminal, VS Code and redirected output render these fine; the classic
    # console font on Windows 10 does not, so fall back to ASCII there.
    if ($env:WT_SESSION -or $env:TERM_PROGRAM -or [Console]::IsOutputRedirected) { $unicode = $true }
  } catch {
    $unicode = $false
  }
  if ($unicode) {
    $script:SymOk = [string][char]0x2713
    $script:SymWarn = [string][char]0x26A0
    $script:SymBad = [string][char]0x2717
  } else {
    $script:SymOk = '[OK]'
    $script:SymWarn = '[!]'
    $script:SymBad = '[X]'
  }
}

function Say([string]$Message, [string]$Color) {
  if ($Color) { Write-Host $Message -ForegroundColor $Color } else { Write-Host $Message }
}
function Say-Ok([string]$Message) { Write-Host "$($script:SymOk) $Message" -ForegroundColor Green }
function Say-Warn([string]$Message) { Write-Host "$($script:SymWarn) $Message" -ForegroundColor Yellow }
function Say-Err([string]$Message) { Write-Host "$($script:SymBad) $Message" -ForegroundColor Red }
function Say-Heading([string]$Message) { Write-Host ''; Write-Host $Message -ForegroundColor Cyan }

# The only line meant for logs: one summary line on stdout. Nothing is written to disk.
function Complete-Uninstall {
  Write-Host ''
  Write-Host ('[{0}] SwarmCast uninstall finished: {1} (exit code {2})' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $script:Result, $script:ExitCode)
  exit $script:ExitCode
}

function Confirm-Step([string]$Question) {
  if ([Console]::IsInputRedirected) {
    Say "$Question (y/N) -> no console to ask, assuming `"no`"."
    return $false
  }
  $answer = Read-Host "$Question (y/N)"
  return ($answer -match '^\s*(y|yes)\s*$')
}

# Runs a program with a timeout and returns @{ Code; Out; TimedOut }.
function Invoke-Captured([string]$Exe, [string]$Arguments, [int]$TimeoutSec) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = $Arguments
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
  $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $stdout = $p.StandardOutput.ReadToEndAsync()
  $stderr = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    try { $p.Kill() } catch { }
    return @{ Code = -1; Out = ''; TimedOut = $true }
  }
  $p.WaitForExit()
  return @{ Code = $p.ExitCode; Out = ($stdout.Result + $stderr.Result); TimedOut = $false }
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

function Read-Options {
  foreach ($raw in $ScriptArgs) {
    $a = ([string]$raw).Trim()
    $key = $a.ToLowerInvariant().TrimStart('-', '/').Replace('-', '').Replace('_', '')
    switch ($key) {
      'keepsettings' { $script:Opt.KeepSettings = $true }
      'keepconfig' { $script:Opt.KeepSettings = $true }
      'ask' { $script:Opt.Ask = $true }
      'yes' { }
      'y' { }
      'help' { $script:Opt.Help = $true }
      'h' { $script:Opt.Help = $true }
      '?' { $script:Opt.Help = $true }
      default {
        Write-Host "Unknown option: $a"
        Write-Host ''
        Show-Usage
        exit 2
      }
    }
  }
}

function Get-NormalPath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\', '/') }
  return $full
}

function Initialize-Paths {
  if ($env:SWARMCAST_HOME) {
    $script:DataDir = Get-NormalPath $env:SWARMCAST_HOME
  } else {
    $local = $env:LOCALAPPDATA
    if (-not $local) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
    $script:DataDir = Get-NormalPath (Join-Path $local 'SwarmCast')
  }
}

function Test-SamePath([string]$A, [string]$B) {
  if (-not $A -or -not $B) { return $false }
  return [string]::Equals((Get-NormalPath $A), (Get-NormalPath $B), [StringComparison]::OrdinalIgnoreCase)
}

# Refuses folders that can never be a SwarmCast data folder (a wrong SWARMCAST_HOME).
function Test-SafeTarget {
  $d = $script:DataDir
  if ($d -eq [System.IO.Path]::GetPathRoot($d)) { return $false }
  $never = @($env:USERPROFILE, $env:HOME, $env:LOCALAPPDATA, $env:APPDATA, $env:WINDIR, $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:TEMP, $env:TMP, $env:PUBLIC)
  if ($env:SystemDrive) { $never += (Join-Path "$($env:SystemDrive)\" 'Users') }
  foreach ($n in $never) {
    if (Test-SamePath $d $n) { return $false }
  }
  # An ancestor of the home folder.
  foreach ($h in @($env:USERPROFILE, $env:HOME)) {
    if (-not $h) { continue }
    $hn = (Get-NormalPath $h) + [System.IO.Path]::DirectorySeparatorChar
    if ($hn.StartsWith($d + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  }
  return $true
}

function Test-LooksLikeSwarmCast {
  foreach ($m in $SC_Markers) {
    if (Test-Path -LiteralPath (Join-Path $script:DataDir $m)) { return $true }
  }
  return $false
}

# Processes whose executable lives inside the data folder (swarmcast, its reaper,
# mediamtx, cloudflared, swarmcast-tray, ffmpeg...). Nothing else is ever touched.
function Get-SwarmCastProcesses {
  $prefix = $script:DataDir + [System.IO.Path]::DirectorySeparatorChar
  $all = @()
  $listed = $false
  if ($script:OnWindows) {
    try {
      foreach ($p in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
        if ($p.ExecutablePath) { $all += [pscustomobject]@{ Id = [int]$p.ProcessId; Path = [string]$p.ExecutablePath } }
      }
      $listed = $true
    } catch {
      $listed = $false
    }
  }
  if (-not $listed) {
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
      $path = $null
      try { $path = $p.Path } catch { $path = $null }
      if ($path) { $all += [pscustomobject]@{ Id = [int]$p.Id; Path = [string]$path } }
    }
  }
  return @($all | Where-Object { $_.Id -ne $PID -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

# Ctrl+C to the console SwarmCast runs in: the same as pressing Ctrl+C in its window,
# so it stops everything by itself. Runs in a helper process (attaching to another
# console would detach this one), and skips a console this uninstaller shares.
$SC_CtrlCSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SwarmCastConsoleStop {
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetConsoleProcessList(uint[] list, uint count);
  public static string Send(uint[] pids, uint self) {
    System.Collections.Generic.List<uint> done = new System.Collections.Generic.List<uint>();
    StringBuilder sb = new StringBuilder();
    foreach (uint pid in pids) {
      if (done.Contains(pid)) continue;
      FreeConsole();
      if (!AttachConsole(pid)) { sb.Append("no-console:" + pid + " "); continue; }
      SetConsoleCtrlHandler(IntPtr.Zero, true);
      uint[] list = new uint[512];
      uint n = GetConsoleProcessList(list, 512);
      bool shared = false;
      for (uint i = 0; i < n && i < 512; i++) { done.Add(list[i]); if (list[i] == self) shared = true; }
      if (shared) { sb.Append("shared:" + pid + " "); FreeConsole(); continue; }
      GenerateConsoleCtrlEvent(0, 0);
      System.Threading.Thread.Sleep(200);
      FreeConsole();
      sb.Append("sent:" + pid + " ");
    }
    return sb.ToString();
  }
}
'@

function Send-GracefulStop([int[]]$Ids) {
  if (-not $script:OnWindows) {
    foreach ($id in $Ids) { try { & /usr/bin/env kill -TERM $id 2>$null } catch { } }
    return
  }
  $src = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($SC_CtrlCSource))
  $cmd = "`$s = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$src')); Add-Type -TypeDefinition `$s; [SwarmCastConsoleStop]::Send([uint32[]]@($($Ids -join ',')), [uint32]$PID)"
  $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd))
  $ps = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path -LiteralPath $ps)) { $ps = 'powershell.exe' }
  try {
    $r = Invoke-Captured $ps "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $enc" 30
    if ($env:SWARMCAST_DEBUG) { Say "  (graceful stop: $($r.Out.Trim()))" }
  } catch {
    if ($env:SWARMCAST_DEBUG) { Say "  (graceful stop failed: $($_.Exception.Message))" }
  }
}

function Wait-NoSwarmCast([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  $left = @(Get-SwarmCastProcesses)
  while ($left.Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $left = @(Get-SwarmCastProcesses)
  }
  return $left
}

function Stop-SwarmCast {
  $procs = @(Get-SwarmCastProcesses)
  if ($procs.Count -eq 0) {
    Say-Ok 'SwarmCast is not running.'
    return
  }
  Say-Heading 'Stopping SwarmCast'
  foreach ($p in $procs) { Say "  $(Split-Path -Leaf $p.Path) (PID $($p.Id))" }
  Send-GracefulStop @($procs | ForEach-Object { $_.Id })
  $left = @(Wait-NoSwarmCast $SC_StopGrace)
  if ($left.Count -gt 0) {
    Say "  Still running after $SC_StopGrace s; forcing it to stop..."
    # Only what still runs from the data folder right now (never a reused PID).
    foreach ($p in $left) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { } }
    $left = @(Wait-NoSwarmCast 5)
  }
  if ($left.Count -gt 0) {
    Say-Warn "Could not stop these processes: $(($left | ForEach-Object { "$(Split-Path -Leaf $_.Path) (PID $($_.Id))" }) -join ', '). Restart the computer and run this again if files remain."
    return
  }
  Say-Ok 'SwarmCast stopped.'
}

# Removes a router port left open by a crash (Direct mode), using SwarmCast itself.
function Invoke-RouterCleanup {
  $exe = $null
  foreach ($dir in @('current', 'previous')) {
    $candidate = Join-Path (Join-Path (Join-Path $script:DataDir 'app') $dir) 'swarmcast.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $exe = $candidate; break }
  }
  if (-not $exe) { return }
  Say 'Checking the router for a port SwarmCast left open...'
  $env:SWARMCAST_DATA_DIR = $script:DataDir
  $r = $null
  try {
    $r = Invoke-Captured $exe "--cleanup --data-dir `"$($script:DataDir)`"" $SC_CleanupTimeout
  } catch {
    $r = @{ Code = -1; Out = "$($_.Exception.Message)"; TimedOut = $false }
  }
  $ok = [string][char]0x2713
  $bad = [string][char]0x2717
  foreach ($line in ($r.Out -split "`r?`n")) {
    $t = $line.Trim()
    if (-not $t) { continue }
    if ($t.StartsWith($ok)) { Write-Host "  $($script:SymOk) $($t.Substring(1).Trim())" }
    elseif ($t.StartsWith($bad)) { Write-Host "  $($script:SymBad) $($t.Substring(1).Trim())" }
    else { Write-Host "  $t" }
  }
  if ($r.TimedOut -or $r.Code -ne 0) {
    $why = "exit code $($r.Code)"
    if ($r.TimedOut) { $why = "no answer after $SC_CleanupTimeout s" }
    Say-Warn "Note: the router port cleanup did not finish ($why). This only matters if you used Direct mode: then check your router's port forwarding list for a `"SwarmCast`" entry. Continuing."
  }
}

function Remove-PathOnce([string]$Path, [bool]$ClearReadOnly) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }
  $isLink = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  if ($item.PSIsContainer -and -not $isLink) {
    if ($ClearReadOnly) {
      Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
        try {
          if ($_.Attributes -band [System.IO.FileAttributes]::ReadOnly) { $_.Attributes = $_.Attributes -bxor [System.IO.FileAttributes]::ReadOnly }
        } catch { }
      }
    }
    [System.IO.Directory]::Delete($Path, $true)
  } elseif ($item.PSIsContainer) {
    [System.IO.Directory]::Delete($Path, $false)
  } else {
    if ($item.Attributes -band [System.IO.FileAttributes]::ReadOnly) { $item.Attributes = $item.Attributes -bxor [System.IO.FileAttributes]::ReadOnly }
    [System.IO.File]::Delete($Path)
  }
}

# Deletes a file or folder, retrying: antivirus scanners and Windows itself can keep
# files busy for a moment after a program stops.
function Remove-WithRetry([string]$Path) {
  $attempt = 0
  while ($true) {
    try { Remove-PathOnce $Path ($attempt -gt 0) } catch { }
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    if ($attempt -ge $SC_DeleteDelays.Count) { return $false }
    $d = $SC_DeleteDelays[$attempt]
    $attempt++
    Say "  Some files are still busy; trying again in $d s..."
    Start-Sleep -Seconds $d
  }
}

function Show-Leftovers([string]$Path) {
  $items = @()
  if (Test-Path -LiteralPath $Path -PathType Container) {
    $items = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  }
  $items += $Path
  $n = 0
  foreach ($i in $items) {
    $n++
    if ($n -le 20) { Write-Host "    $i" }
  }
  if ($n -gt 20) { Write-Host "    ... and $($n - 20) more" }
}

function Remove-Data {
  Say-Heading 'Deleting SwarmCast files'
  # Never stand inside the folder being deleted.
  try {
    $safe = [System.IO.Path]::GetTempPath()
    Set-Location -LiteralPath $safe
    [System.IO.Directory]::SetCurrentDirectory($safe)
  } catch { }
  $failed = @()
  if ($script:Opt.KeepSettings) {
    foreach ($e in @(Get-ChildItem -LiteralPath $script:DataDir -Force -ErrorAction SilentlyContinue)) {
      if ($SC_Keep -contains $e.Name) { continue }
      if (-not (Remove-WithRetry $e.FullName)) { $failed += $e.FullName }
    }
  } else {
    if (-not (Remove-WithRetry $script:DataDir)) { $failed += $script:DataDir }
  }
  if ($failed.Count -gt 0) {
    Say-Err 'Some files could not be removed:'
    foreach ($f in $failed) { Show-Leftovers $f }
    Say '  Close any program that may be using them (or restart the computer) and run this again.'
    return $false
  }
  return $true
}

function Invoke-Main {
  Read-Options
  Initialize-Console
  if ($script:Opt.Help) {
    Show-Usage
    exit 0
  }
  Initialize-Paths
  Say 'SwarmCast uninstaller for Windows' 'Cyan'
  Say "Data folder: $($script:DataDir)"

  if (-not (Test-Path -LiteralPath $script:DataDir)) {
    Say-Ok 'SwarmCast is not installed on this computer (no data folder). Nothing to do.'
    Say $SC_ObsNote
    $script:Result = 'not installed'
    Complete-Uninstall
  }
  if (-not (Test-SafeTarget)) {
    Say-Err "$($script:DataDir) is not a SwarmCast data folder (check SWARMCAST_HOME). Nothing was deleted."
    $script:ExitCode = 1
    $script:Result = "refused: unsafe folder $($script:DataDir)"
    Complete-Uninstall
  }
  if (-not (Test-Path -LiteralPath $script:DataDir -PathType Container) -or -not (Test-LooksLikeSwarmCast)) {
    if ((Test-Path -LiteralPath $script:DataDir -PathType Container) -and @(Get-ChildItem -LiteralPath $script:DataDir -Force -ErrorAction SilentlyContinue).Count -eq 0) {
      try { [System.IO.Directory]::Delete($script:DataDir, $false) } catch { }
      Say-Ok 'SwarmCast is not installed on this computer (the data folder was empty and has been removed).'
      Say $SC_ObsNote
      $script:Result = 'not installed'
      Complete-Uninstall
    }
    Say-Err "$($script:DataDir) does not look like a SwarmCast data folder (check SWARMCAST_HOME). Nothing was deleted."
    $script:ExitCode = 1
    $script:Result = 'refused: not a SwarmCast folder'
    Complete-Uninstall
  }

  if ($script:Opt.KeepSettings) {
    Say 'Your settings and stream key (config.json, secrets.json) will be kept (--keep-settings).'
  }
  if ($script:Opt.Ask) {
    $q = 'Remove SwarmCast and all its files from this computer?'
    if ($script:Opt.KeepSettings) { $q = 'Remove SwarmCast from this computer (keeping your settings and stream key)?' }
    if (-not (Confirm-Step $q)) {
      Say 'Uninstall cancelled. Nothing was changed.'
      $script:ExitCode = 1
      $script:Result = 'cancelled'
      Complete-Uninstall
    }
  }

  Stop-SwarmCast
  Invoke-RouterCleanup
  if (Remove-Data) {
    Say-Heading 'Done'
    if ($script:Opt.KeepSettings) {
      Say-Ok "SwarmCast was removed. Your settings and stream key were kept in: $($script:DataDir)"
      Say '  Run the start script again to reinstall with the same stream key, or delete that folder to remove them too.'
      $script:Result = "removed (settings kept in $($script:DataDir))"
    } else {
      Say-Ok 'SwarmCast was removed from this computer.'
      $script:Result = "removed $($script:DataDir)"
    }
    Say $SC_ObsNote
    Say 'You can also delete the folder with the installer files (the extracted zip) yourself.'
  } else {
    $script:ExitCode = 1
    $script:Result = 'some files could not be removed'
    Say $SC_ObsNote
  }
  Complete-Uninstall
}

try {
  Invoke-Main
} catch {
  $msg = $_.Exception.Message
  Say-Err "Unexpected error: $msg"
  Say "  Run this again; if it keeps happening, report it at $SC_IssuesUrl"
  $script:ExitCode = 1
  $script:Result = "unexpected error: $msg"
  Complete-Uninstall
}
