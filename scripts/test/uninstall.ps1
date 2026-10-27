# Tests for scripts/uninstall-windows.ps1 / uninstall-windows.cmd. Run with Windows
# PowerShell 5.1 (the version the script targets):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test\uninstall.ps1
# Needs node in PATH. ASCII-only on purpose (PowerShell 5.1 reads files as ANSI).
#
# Development aid: it also runs with pwsh on Linux/macOS. There the fake executables
# are shell scripts / a copied `sleep`, the scripts are called directly with pwsh (no
# .cmd), and the Windows-only cases (file locks, Ctrl+C) are skipped.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OnWindows = ($env:OS -eq 'Windows_NT')
if (-not $OnWindows -and -not $env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE = 'AMD64' }

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$TestDir = Join-Path $Root 'scripts\test'
$Script = Join-Path $Root 'scripts\uninstall-windows.ps1'
$Cmd = Join-Path $Root 'scripts\uninstall-windows.cmd'
$StartPs = Join-Path $Root 'scripts\start-windows.ps1'
$StartCmd = Join-Path $Root 'scripts\start-windows.cmd'
$Arch = 'x64'

# The long form of the temp folder (CI runners use C:\Users\RUNNER~1\...): shortcut
# targets and process paths read back in long form.
$TempRoot = [IO.Path]::GetTempPath()
if ($OnWindows) {
  try {
    Add-Type -Namespace SwarmCastTest -Name Paths -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetLongPathName(string s, System.Text.StringBuilder l, uint n);'
    $sb = New-Object System.Text.StringBuilder 1024
    if ([SwarmCastTest.Paths]::GetLongPathName($TempRoot, $sb, 1024) -gt 0) { $TempRoot = $sb.ToString() }
  } catch { }
}
$Work = Join-Path $TempRoot ('swarmcast-uninstall-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Data = Join-Path $Work 'swarm home'       # a space on purpose: quoting must hold
$ExeDir = Join-Path $Work 'exe'
$ScriptTmp = Join-Path $Work 'tmp'
New-Item -ItemType Directory -Force -Path $ExeDir, $ScriptTmp | Out-Null

# Never the real Run / Uninstall registry keys, Start menu, desktop or app folders:
# the uninstaller runs with fake LOCALAPPDATA / APPDATA / USERPROFILE and a registry
# sandbox of its own (SWARMCAST_TEST_SANDBOX), removed at the end.
$AppId = 'io.github.lucas-angelo.swarmcast'
$Sandbox = 'T' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$RegBase = "HKCU:\Software\SwarmCastTestSandbox\$Sandbox"
$RegBaseRel = "Software\SwarmCastTestSandbox\$Sandbox"
$SavedEnv = @{ LOCALAPPDATA = $env:LOCALAPPDATA; APPDATA = $env:APPDATA; USERPROFILE = $env:USERPROFILE }
$FakeLocal = Join-Path $Work 'local app data'
$FakeRoaming = Join-Path $Work 'roaming app data'
$FakeProfile = Join-Path $Work 'profile'
New-Item -ItemType Directory -Force -Path $FakeLocal, $FakeRoaming, $FakeProfile | Out-Null
$env:SWARMCAST_TEST_SANDBOX = $Sandbox
$env:LOCALAPPDATA = $FakeLocal
$env:APPDATA = $FakeRoaming
$env:USERPROFILE = $FakeProfile

$script:Pass = 0
$script:Fail = 0
$script:FailedNames = @()
$script:Case = ''
$script:CaseFailed = $false
$script:Out = ''
$script:Rc = 0
$script:Started = @()    # processes started by the tests (killed at the end)

function Begin-Case([string]$Name) {
  $script:Case = $Name
  $script:CaseFailed = $false
  $script:Out = ''
  Write-Host ''
  Write-Host "=== $Name"
}
function Pass([string]$Msg) { Write-Host "  ok: $Msg" }
function Fail([string]$Msg) { Write-Host "  FAIL: $Msg" -ForegroundColor Red; $script:CaseFailed = $true }
function Skip([string]$Msg) { Write-Host "  (skipped: $Msg)" }
function End-Case {
  if (-not $script:CaseFailed) {
    $script:Pass++
    Write-Host "PASS $($script:Case)" -ForegroundColor Green
  } else {
    $script:Fail++
    $script:FailedNames += $script:Case
    Write-Host '--- output of the script ---'
    Write-Host $script:Out
    Write-Host '--- end of output ---'
    Write-Host "FAIL $($script:Case)" -ForegroundColor Red
  }
}
function Assert-Eq($Actual, $Expected, [string]$Msg) {
  if ("$Actual" -eq "$Expected") { Pass $Msg } else { Fail "$Msg (expected '$Expected', got '$Actual')" }
}
function Assert-Exists([string]$Path) {
  if (Test-Path -LiteralPath $Path) { Pass "exists: $($Path.Substring($Work.Length + 1))" } else { Fail "missing: $($Path.Substring($Work.Length + 1))" }
}
function Assert-Absent([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { Pass "absent: $($Path.Substring($Work.Length + 1))" } else { Fail "should not exist: $($Path.Substring($Work.Length + 1))" }
}
function Assert-Contains([string]$Text, [string]$Needle, [string]$Msg) {
  if (-not $Msg) { $Msg = "contains '$Needle'" }
  if ($Text.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Pass $Msg } else { Fail "$Msg ('$Needle' not found)" }
}
function Assert-NotContains([string]$Text, [string]$Needle, [string]$Msg) {
  if (-not $Msg) { $Msg = "does not contain '$Needle'" }
  if ($Text.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { Pass $Msg } else { Fail $Msg }
}
function Test-Running([int]$Id) {
  $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
  return [bool]($p -and -not $p.HasExited)
}
function Assert-Running([int]$Id, [string]$What) { if (Test-Running $Id) { Pass "$What is running" } else { Fail "$What should still run" } }
function Assert-Stopped([int]$Id, [string]$What) { if (Test-Running $Id) { Fail "$What is still running" } else { Pass "$What was stopped" } }
function Read-Text([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $content = Get-Content -LiteralPath $Path -Raw
  if ($null -eq $content) { return '' }
  return "$content".Trim()
}

# Runs the uninstaller. -ViaPs runs the .ps1 directly (PowerShell-style flags),
# otherwise the .cmd (GNU-style flags, like a user would pass them). -PipeInput gives
# it a redirected stdin (no console to ask).
function Invoke-Uninstall([string[]]$Arguments, [switch]$ViaPs, [switch]$PipeInput, [string]$Dir) {
  $ps1 = $Script; $cmd1 = $Cmd
  if ($Dir) { $ps1 = Join-Path $Dir 'uninstall-windows.ps1'; $cmd1 = Join-Path $Dir 'uninstall-windows.cmd' }
  $env:SWARMCAST_HOME = $Data
  $env:SWARMCAST_NO_PAUSE = '1'
  if (-not $env:SWARMCAST_DELETE_DELAYS) { $env:SWARMCAST_DELETE_DELAYS = '1 1' }
  $env:SWARMCAST_STOP_GRACE = '3'
  if (-not $Arguments) { $Arguments = @() }
  $ErrorActionPreference = 'Continue'
  try {
    if (-not $OnWindows) {
      if ($PipeInput) { $lines = 'n' | & pwsh -NoProfile -File $ps1 @Arguments 2>&1 } else { $lines = & pwsh -NoProfile -File $ps1 @Arguments 2>&1 }
    } elseif ($ViaPs) {
      if ($PipeInput) { $lines = 'n' | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1 @Arguments 2>&1 } else { $lines = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1 @Arguments 2>&1 }
    } else {
      if ($PipeInput) { $lines = 'n' | & $cmd1 @Arguments 2>&1 } else { $lines = & $cmd1 @Arguments 2>&1 }
    }
    $script:Rc = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = 'Stop'
  }
  $script:Out = (@($lines) | ForEach-Object { "$_" }) -join "`n"
  Write-Host "  (exit code $($script:Rc))"
}

# One fake program for everything: swarmcast.exe (--version, --cleanup) and a sleeper
# (--sleep N [--ignore-ctrl-c]) copied under other names.
function New-FakeExe([string]$Version) {
  $out = Join-Path $ExeDir "swarmcast-$Version.exe"
  if (Test-Path -LiteralPath $out) { return $out }
  if (-not $OnWindows) {
    $sh = @"
#!/bin/sh
V="$Version"
case " `$* " in
  *" --version "*) echo "`$V"; exit 0 ;;
  *" --cleanup "*)
    [ -n "`$FAKE_CLEANUP_LOG" ] && { printf '%s\n' "`$*" >> "`$FAKE_CLEANUP_LOG"; printf 'SWARMCAST_DATA_DIR=%s\n' "`$SWARMCAST_DATA_DIR" >> "`$FAKE_CLEANUP_LOG"; }
    echo "fake cleanup output line"
    exit "`${FAKE_CLEANUP_EXIT:-0}" ;;
  *) echo "fake swarmcast `$V started with: `$*"; exit 0 ;;
esac
"@
    [IO.File]::WriteAllText($out, $sh.Replace("`r`n", "`n"))
    & chmod 755 $out
    return $out
  }
  $cls = 'FakeSwarmCastU' + ($Version -replace '\.', '_')
  $src = @"
using System;
using System.IO;
using System.Threading;
public static class $cls {
  public static int Main(string[] args) {
    string version = "$Version";
    int i = Array.IndexOf(args, "--sleep");
    if (i >= 0) {
      if (Array.IndexOf(args, "--ignore-ctrl-c") >= 0) { Console.CancelKeyPress += delegate(object s, ConsoleCancelEventArgs e) { e.Cancel = true; }; }
      Thread.Sleep(int.Parse(args[i + 1]) * 1000);
      return 0;
    }
    if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine(version); return 0; }
    if (Array.IndexOf(args, "--cleanup") >= 0) {
      string log = Environment.GetEnvironmentVariable("FAKE_CLEANUP_LOG");
      if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, String.Join(" ", args) + "\nSWARMCAST_DATA_DIR=" + Environment.GetEnvironmentVariable("SWARMCAST_DATA_DIR") + "\n");
      Console.WriteLine("fake cleanup output line");
      string code = Environment.GetEnvironmentVariable("FAKE_CLEANUP_EXIT");
      return String.IsNullOrEmpty(code) ? 0 : int.Parse(code);
    }
    Console.WriteLine("fake swarmcast " + version + " started with: " + String.Join(" ", args));
    return 0;
  }
}
"@
  $srcFile = Join-Path $ExeDir "$cls.cs"
  [IO.File]::WriteAllText($srcFile, $src)
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  if (Test-Path -LiteralPath $csc) {
    $ErrorActionPreference = 'Continue'
    $log = & $csc /nologo /target:exe "/out:$out" $srcFile 2>&1
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw "csc failed: $log" }
  } else {
    Add-Type -TypeDefinition $src -OutputAssembly $out -OutputType ConsoleApplication
  }
  return $out
}

# A real executable that sleeps, for the running-process cases.
function Get-Sleeper {
  if ($OnWindows) { return (New-FakeExe '0.0.1') }
  $s = Join-Path $ExeDir 'sleeper'
  if (Test-Path -LiteralPath $s) { return $s }
  # A copied system `sleep` is killed by macOS code signing; build one when possible.
  if (Get-Command cc -ErrorAction SilentlyContinue) {
    $c = Join-Path $ExeDir 'sleeper.c'
    [IO.File]::WriteAllText($c, "#include <stdlib.h>`n#include <unistd.h>`nint main(int c, char **v) { sleep(c > 1 ? atoi(v[1]) : 300); return 0; }`n")
    & cc -o $s $c
  }
  if (-not (Test-Path -LiteralPath $s)) { Copy-Item -LiteralPath (& sh -c 'command -v sleep').Trim() -Destination $s }
  return $s
}

function Start-Sleeper([string]$Exe, [switch]$IgnoreCtrlC) {
  if ($OnWindows) {
    $a = @('--sleep', '300')
    if ($IgnoreCtrlC) { $a += '--ignore-ctrl-c' }
    $p = Start-Process -FilePath $Exe -ArgumentList $a -PassThru -WindowStyle Hidden
  } else {
    $p = Start-Process -FilePath $Exe -ArgumentList @('300') -PassThru
  }
  $script:Started += $p
  return $p
}

# Keeps $File open with no sharing for $Seconds in another process (like an antivirus
# scanner or an editor would). Returns once the file is locked.
function Start-LockHolder([string]$File, [int]$Seconds) {
  $ready = Join-Path $Work ('lock-ready-' + [guid]::NewGuid().ToString('N'))
  $code = "`$f = [IO.File]::Open('$File', 'Open', 'ReadWrite', 'None'); [IO.File]::WriteAllText('$ready', 'x'); Start-Sleep -Seconds $Seconds; `$f.Close()"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-EncodedCommand', $enc) -PassThru -WindowStyle Hidden
  $script:Started += $p
  for ($i = 0; $i -lt 150 -and -not (Test-Path -LiteralPath $ready); $i++) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path -LiteralPath $ready)) { throw 'lock holder did not start' }
  return $p
}

# A minimal installed tree like the start script and the app leave behind.
function New-Tree {
  if (Test-Path -LiteralPath $Data) { Remove-Item -LiteralPath $Data -Recurse -Force }
  foreach ($d in @('app\current\bin', 'app\previous', 'logs', 'run\icons', 'blocklists', 'bin\ffmpeg-7.1', 'tools', 'cache')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Data $d) | Out-Null
  }
  Set-Content -LiteralPath (Join-Path $Data 'app\current\VERSION') -Value '0.0.1'
  Set-Content -LiteralPath (Join-Path $Data 'app\previous\VERSION') -Value '0.0.0'
  Set-Content -LiteralPath (Join-Path $Data 'logs\install.log') -Value 'log'
  Set-Content -LiteralPath (Join-Path $Data 'config.json') -Value '{"ports":{"rtmp":1935}}'
  Set-Content -LiteralPath (Join-Path $Data 'secrets.json') -Value '{"streamKey":"keep-me"}'
  Set-Content -LiteralPath (Join-Path $Data 'state.json') -Value '{}'
  Set-Content -LiteralPath (Join-Path $Data 'system-check.json') -Value '{}'
  Set-Content -LiteralPath (Join-Path $Data 'blocklists\list.txt') -Value 'x'
  if ($OnWindows) {
    $ro = Join-Path $Data 'run\readonly.txt'
    Set-Content -LiteralPath $ro -Value 'x'
    (Get-Item -LiteralPath $ro).Attributes = 'ReadOnly'
  }
}

# Compiles C# into an exe (csc of .NET Framework, else Add-Type).
function Build-Exe([string]$Source, [string]$Out) {
  $srcFile = $Out + '.cs'
  [IO.File]::WriteAllText($srcFile, $Source)
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  if (Test-Path -LiteralPath $csc) {
    $ErrorActionPreference = 'Continue'
    $log = & $csc /nologo /target:exe "/out:$Out" $srcFile 2>&1
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw "csc failed: $log" }
  } else {
    Add-Type -TypeDefinition $Source -OutputAssembly $Out -OutputType ConsoleApplication
  }
}

# A fake NSIS uninstaller (Windows): records how it was called, then, like the real
# one run with "/S _?=<dir>", deletes everything in <dir> but itself and its
# Uninstall registry key (FAKE_UNINSTALL_KEY, relative to HKCU).
function New-FakeUninstaller {
  $out = Join-Path $ExeDir 'fake-uninstall.exe'
  if (Test-Path -LiteralPath $out) { return $out }
  $src = @"
using System;
using System.IO;
using Microsoft.Win32;
public static class FakeNsisUninstaller {
  public static int Main(string[] args) {
    string self = Path.GetFullPath(System.Reflection.Assembly.GetExecutingAssembly().Location);
    string cl = Environment.CommandLine;
    int at = cl.IndexOf("_?=");
    string dir = at >= 0 ? cl.Substring(at + 3).Trim() : Path.GetDirectoryName(self);
    bool silent = Array.IndexOf(args, "/S") >= 0;
    string log = Environment.GetEnvironmentVariable("FAKE_UNINSTALL_LOG");
    if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, "exe=" + self + "\nsilent=" + silent + "\ndir=" + dir + "\n");
    if (!silent) return 2;
    foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) {
      if (!String.Equals(Path.GetFullPath(f), self, StringComparison.OrdinalIgnoreCase)) File.Delete(f);
    }
    foreach (string d in Directory.GetDirectories(dir)) Directory.Delete(d, true);
    string key = Environment.GetEnvironmentVariable("FAKE_UNINSTALL_KEY");
    if (!String.IsNullOrEmpty(key)) Registry.CurrentUser.DeleteSubKeyTree(key, false);
    return 0;
  }
}
"@
  Build-Exe $src $out
  return $out
}

# An Uninstall entry in the registry sandbox; returns its path relative to HKCU.
function New-FakeUninstallEntry([string]$Name, [string]$DisplayName, [string]$Exe, [string]$Dir) {
  $k = "$RegBase\Uninstall\$Name"
  New-Item -Path $k -Force | Out-Null
  New-ItemProperty -LiteralPath $k -Name 'DisplayName' -Value $DisplayName -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $k -Name 'UninstallString' -Value "`"$Exe`"" -PropertyType String -Force | Out-Null
  New-ItemProperty -LiteralPath $k -Name 'QuietUninstallString' -Value "`"$Exe`" /S" -PropertyType String -Force | Out-Null
  if ($Dir) { New-ItemProperty -LiteralPath $k -Name 'InstallLocation' -Value $Dir -PropertyType String -Force | Out-Null }
  return "$RegBaseRel\Uninstall\$Name"
}

function Set-FakeRunValue([string]$Name, [string]$Value) {
  New-Item -Path "$RegBase\Run" -Force | Out-Null
  New-ItemProperty -LiteralPath "$RegBase\Run" -Name $Name -Value $Value -PropertyType String -Force | Out-Null
}

function Test-RunValue([string]$Name) {
  try { return ($null -ne (Get-ItemProperty -LiteralPath "$RegBase\Run" -Name $Name -ErrorAction Stop)) } catch { return $false }
}

function New-Shortcut([string]$Lnk, [string]$Target) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Lnk) | Out-Null
  $sh = New-Object -ComObject WScript.Shell
  $l = $sh.CreateShortcut($Lnk)
  $l.TargetPath = $Target
  $l.Save()
}

function Install-FakeSwarmCast {
  Copy-Item -LiteralPath (New-FakeExe '0.0.1') -Destination (Join-Path $Data 'app\current\swarmcast.exe')
}

try {
  # --- static analysis ------------------------------------------------------
  Begin-Case 'syntax check'
  foreach ($f in @($Script, $PSCommandPath)) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)
    if ($errors.Count -eq 0) { Pass "parses: $(Split-Path -Leaf $f)" } else { Fail "parse errors in $(Split-Path -Leaf $f): $($errors[0].Message) (line $($errors[0].Extent.StartLineNumber))" }
  }
  # The C# helper that sends Ctrl+C to SwarmCast's console must compile (it only runs on Windows).
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$null)
  $assign = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$SC_CtrlCSource' }, $true)
  try {
    Add-Type -TypeDefinition $assign.Right.Expression.Value
    Pass 'the Ctrl+C helper (C#) compiles'
  } catch {
    Fail "the Ctrl+C helper (C#) does not compile: $($_.Exception.Message)"
  }
  foreach ($f in @($Script, $Cmd, $PSCommandPath)) {
    $bytes = [IO.File]::ReadAllBytes($f)
    Assert-Eq (@($bytes | Where-Object { $_ -gt 127 }).Count) 0 "$(Split-Path -Leaf $f) is ASCII-only"
    $text = [Text.Encoding]::ASCII.GetString($bytes)
    $bareLf = ([regex]::Matches($text, "(?<!`r)`n")).Count
    Assert-Eq $bareLf 0 "$(Split-Path -Leaf $f) has CRLF line endings"
  }
  End-Case

  # --- 1. not installed --------------------------------------------------------
  Begin-Case '1. nothing installed'
  $savedData = $Data
  $Data = Join-Path $Work 'never installed'
  Invoke-Uninstall @()
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'not installed'
  Assert-Contains $script:Out 'Your OBS settings were not changed'
  Assert-Absent $Data
  End-Case

  Begin-Case '1b. empty data folder is removed and reported as not installed'
  New-Item -ItemType Directory -Force -Path $Data | Out-Null
  Invoke-Uninstall @()
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'not installed'
  Assert-Absent $Data
  End-Case
  $Data = $savedData

  # --- 2. real install with the start script, then uninstall -------------------
  Begin-Case '2. install with the start script (local bundle), then uninstall from the bundle folder'
  $bundle = Join-Path $Work 'installer folder'
  $freePort = (& node (Join-Path $TestDir 'serve.mjs') --free-port | Out-String).Trim()
  $closedUrl = "http://127.0.0.1:$freePort"
  $exe = New-FakeExe '0.0.1'
  & node (Join-Path $TestDir 'make-fake-release.mjs') --dir $bundle --version '0.0.1' --os windows --arch $Arch --exe $exe | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'make-fake-release failed' }
  $pkg = "SwarmCast-v0.0.1-windows-$Arch.zip"
  $sums = Join-Path $bundle 'SHA256SUMS.txt'
  $line = @([IO.File]::ReadAllLines($sums) | Where-Object { $_.EndsWith("  $pkg") })
  [IO.File]::WriteAllText($sums, ($line -join "`n") + "`n")
  $ps = [IO.File]::ReadAllText($StartPs)
  $ps = (($ps -split "`n") | ForEach-Object { if ($_.StartsWith('$SC_DefaultReleaseUrl = ')) { "`$SC_DefaultReleaseUrl = '$closedUrl'`r" } else { $_ } }) -join "`n"
  [IO.File]::WriteAllText((Join-Path $bundle 'start-windows.ps1'), $ps, (New-Object System.Text.ASCIIEncoding))
  foreach ($f in @($StartCmd, $Script, $Cmd)) { Copy-Item -LiteralPath $f -Destination $bundle }
  $env:SWARMCAST_HOME = $Data
  $env:SWARMCAST_NO_PAUSE = '1'
  Remove-Item Env:SWARMCAST_RELEASE_URL -ErrorAction SilentlyContinue
  $oldTemp = $env:TEMP; $oldTmp = $env:TMP
  $env:TEMP = $ScriptTmp; $env:TMP = $ScriptTmp
  $ErrorActionPreference = 'Continue'
  if ($OnWindows) {
    $installOut = & (Join-Path $bundle 'start-windows.cmd') --yes --skip-speedtest --install-only 2>&1
  } else {
    $installOut = & pwsh -NoProfile -File (Join-Path $bundle 'start-windows.ps1') --yes --skip-speedtest --install-only 2>&1
  }
  $installRc = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  $env:TEMP = $oldTemp; $env:TMP = $oldTmp
  Remove-Item Env:SWARMCAST_DATA_DIR -ErrorAction SilentlyContinue
  if ($installRc -ne 0) { Write-Host ((@($installOut) | ForEach-Object { "$_" }) -join "`n") }
  Assert-Eq $installRc 0 'start script installed v0.0.1'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.0.1' 'current\VERSION is 0.0.1'
  $cleanupLog = Join-Path $Work 'cleanup.log'
  $env:FAKE_CLEANUP_LOG = $cleanupLog
  Invoke-Uninstall @() -Dir $bundle
  Remove-Item Env:FAKE_CLEANUP_LOG
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Absent $Data
  Assert-Contains $script:Out 'SwarmCast was removed from this computer'
  Assert-Contains $script:Out 'Your OBS settings were not changed. Remove the SwarmCast target/server from OBS yourself if you want.'
  Assert-Contains $script:Out 'fake cleanup output line' 'the output of swarmcast --cleanup is shown'
  $logLines = @(Get-Content -LiteralPath $cleanupLog)
  Assert-Eq $logLines[0] "--cleanup --data-dir $Data" 'swarmcast --cleanup was run with the data folder'
  Assert-Eq $logLines[1] "SWARMCAST_DATA_DIR=$Data" 'SWARMCAST_DATA_DIR set'
  Assert-Contains $script:Out 'SwarmCast uninstall finished: removed' 'final summary line'
  Assert-Exists (Join-Path $bundle 'uninstall-windows.cmd')
  Assert-Exists (Join-Path $bundle $pkg)
  End-Case

  # --- 3. keep settings --------------------------------------------------------
  Begin-Case '3. -KeepSettings keeps only config.json and secrets.json'
  New-Tree
  $cfg = Read-Text (Join-Path $Data 'config.json')
  $sec = Read-Text (Join-Path $Data 'secrets.json')
  Invoke-Uninstall @('-KeepSettings') -ViaPs
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Eq ((@(Get-ChildItem -LiteralPath $Data -Force | ForEach-Object { $_.Name }) | Sort-Object) -join ' ') 'config.json secrets.json' 'only config.json and secrets.json are left'
  Assert-Eq (Read-Text (Join-Path $Data 'config.json')) $cfg 'config.json unchanged'
  Assert-Eq (Read-Text (Join-Path $Data 'secrets.json')) $sec 'secrets.json unchanged'
  Assert-Contains $script:Out 'settings and stream key were kept'
  End-Case

  Begin-Case '3b. --keep-settings (GNU spelling), then a full uninstall with --yes'
  New-Tree
  Invoke-Uninstall @('--keep-settings')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Exists (Join-Path $Data 'secrets.json')
  Assert-Absent (Join-Path $Data 'app')
  Invoke-Uninstall @('--yes')
  Assert-Eq $script:Rc 0 'exit code 0 (--yes accepted)'
  Assert-Absent $Data
  End-Case

  # --- 4. running processes ----------------------------------------------------
  Begin-Case '4. stops processes running from the data folder, never others'
  New-Tree
  $sleeper = Get-Sleeper
  $x = ''
  if ($OnWindows) { $x = '.exe' }
  $inside = Join-Path $Data "app\current\bin\mediamtx$x"
  $inside2 = Join-Path $Data "tools\ffmpeg$x"
  $outsideDir = Join-Path $Work 'outside'
  New-Item -ItemType Directory -Force -Path $outsideDir | Out-Null
  $outside = Join-Path $outsideDir "mediamtx$x"
  foreach ($t in @($inside, $inside2, $outside)) { Copy-Item -LiteralPath $sleeper -Destination $t }
  $p1 = Start-Sleeper $inside
  $p2 = $null
  if ($OnWindows) { $p2 = Start-Sleeper $inside2 -IgnoreCtrlC } else { $p2 = Start-Sleeper $inside2 }
  $p3 = Start-Sleeper $outside
  Start-Sleep -Milliseconds 800
  Assert-Running $p1.Id 'mediamtx (inside)'
  Assert-Running $p3.Id 'mediamtx (outside)'
  $env:SWARMCAST_DEBUG = '1'
  Invoke-Uninstall @()
  Remove-Item Env:SWARMCAST_DEBUG
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Stopping SwarmCast'
  if ($OnWindows) {
    # Informational: whether Ctrl+C reached the console (the force fallback covers a miss).
    if ($script:Out.IndexOf("sent:$($p1.Id)") -ge 0) { Write-Host '  note: graceful Ctrl+C was sent' } else { Write-Host '  note: graceful Ctrl+C was NOT sent (forced instead)' -ForegroundColor Yellow }
  }
  Assert-Contains $script:Out "(PID $($p1.Id))" 'the inside process is listed'
  Assert-NotContains $script:Out "(PID $($p3.Id))" 'the outside process is not listed'
  Assert-Contains $script:Out 'SwarmCast stopped'
  if ($OnWindows) { Assert-Contains $script:Out 'forcing it to stop' 'a process ignoring Ctrl+C is forced' }
  Assert-Stopped $p1.Id 'mediamtx (inside)'
  Assert-Stopped $p2.Id 'ffmpeg (inside)'
  Assert-Running $p3.Id 'mediamtx outside the data folder'
  Assert-Absent $Data
  Stop-Process -Id $p3.Id -Force -ErrorAction SilentlyContinue
  End-Case

  # --- 5. swarmcast --cleanup --------------------------------------------------
  Begin-Case '5. a failing swarmcast --cleanup is only a note'
  New-Tree
  Install-FakeSwarmCast
  $env:FAKE_CLEANUP_EXIT = '1'
  Invoke-Uninstall @()
  Remove-Item Env:FAKE_CLEANUP_EXIT
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'fake cleanup output line'
  Assert-Contains $script:Out 'router port cleanup did not finish'
  Assert-Absent $Data
  End-Case

  Begin-Case '5b. no swarmcast.exe: cleanup is skipped'
  New-Tree
  Invoke-Uninstall @()
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-NotContains $script:Out 'Checking the router'
  Assert-Absent $Data
  End-Case

  # --- 6. locked files (Windows) -----------------------------------------------
  Begin-Case '6. a file locked for a moment is retried'
  if (-not $OnWindows) {
    Skip 'file locks only block deletion on Windows'
  } else {
    New-Tree
    $env:SWARMCAST_DELETE_DELAYS = '1 2 3'
    $h = Start-LockHolder (Join-Path $Data 'logs\install.log') 2
    Invoke-Uninstall @()
    Remove-Item Env:SWARMCAST_DELETE_DELAYS
    Assert-Eq $script:Rc 0 'exit code 0'
    Assert-Contains $script:Out 'trying again'
    Assert-Absent $Data
    $h.WaitForExit(10000) | Out-Null
  }
  End-Case

  Begin-Case '6b. a file that stays locked is reported with its path'
  if (-not $OnWindows) {
    Skip 'file locks only block deletion on Windows'
  } else {
    New-Tree
    $locked = Join-Path $Data 'logs\install.log'
    $h = Start-LockHolder $locked 120
    Invoke-Uninstall @()
    Assert-Eq $script:Rc 1 'exit code 1'
    Assert-Contains $script:Out 'could not be removed'
    Assert-Contains $script:Out $locked 'the locked file is listed'
    Assert-Contains $script:Out 'finished: some files could not be removed'
    Assert-Absent (Join-Path $Data 'app')
    Stop-Process -Id $h.Id -Force -ErrorAction SilentlyContinue
    $h.WaitForExit(10000) | Out-Null
    Invoke-Uninstall @()
    Assert-Eq $script:Rc 0 'second run finishes the job'
    Assert-Absent $Data
  }
  End-Case

  # --- 7. safety ------------------------------------------------------------------
  Begin-Case '7. refuses a folder that is not SwarmCast''s'
  $savedData = $Data
  $Data = Join-Path $Work 'my documents'
  New-Item -ItemType Directory -Force -Path $Data | Out-Null
  Set-Content -LiteralPath (Join-Path $Data 'thesis.txt') -Value 'precious'
  Invoke-Uninstall @()
  Assert-Eq $script:Rc 1 'exit code 1'
  Assert-Contains $script:Out 'does not look like a SwarmCast data folder'
  Assert-Eq (Read-Text (Join-Path $Data 'thesis.txt')) 'precious' 'file untouched'
  End-Case

  Begin-Case '7b. refuses the home folder even with SwarmCast files in it'
  $fakeHome = Join-Path $Work 'fake home'
  New-Item -ItemType Directory -Force -Path $fakeHome | Out-Null
  Set-Content -LiteralPath (Join-Path $fakeHome 'config.json') -Value '{}'
  Set-Content -LiteralPath (Join-Path $fakeHome 'notes.txt') -Value 'mine'
  $oldProfile = $env:USERPROFILE; $oldHome = $env:HOME
  $env:USERPROFILE = $fakeHome; $env:HOME = $fakeHome
  $Data = $fakeHome
  try { Invoke-Uninstall @() } finally { $env:USERPROFILE = $oldProfile; $env:HOME = $oldHome }
  Assert-Eq $script:Rc 1 'exit code 1'
  Assert-Contains $script:Out 'is not a SwarmCast data folder'
  Assert-Exists (Join-Path $fakeHome 'notes.txt')
  Assert-Exists (Join-Path $fakeHome 'config.json')
  $Data = $savedData
  End-Case

  Begin-Case '7c. -Ask without a console cancels and changes nothing'
  New-Tree
  Invoke-Uninstall @('-Ask') -ViaPs -PipeInput
  Assert-Eq $script:Rc 1 'exit code 1'
  Assert-Contains $script:Out 'cancelled'
  Assert-Exists (Join-Path $Data 'app\current\VERSION')
  Assert-Exists (Join-Path $Data 'secrets.json')
  End-Case

  # --- 9. desktop app ------------------------------------------------------------
  Begin-Case '9. desktop app: silent uninstaller, leftovers, shortcuts, autostart and WebView2 data; others kept'
  New-Tree
  $x = ''
  if ($OnWindows) { $x = '.exe' }
  $sleeper = Get-Sleeper
  $inst = Join-Path $env:LOCALAPPDATA 'Programs\SwarmCast'
  New-Item -ItemType Directory -Force -Path (Join-Path $inst 'resources\bin') | Out-Null
  $appExe = Join-Path $inst 'SwarmCast.exe'
  $mtx = Join-Path $inst "resources\bin\mediamtx$x"
  Copy-Item -LiteralPath $sleeper -Destination $appExe
  Copy-Item -LiteralPath $sleeper -Destination $mtx
  Copy-Item -LiteralPath (New-FakeExe '0.0.1') -Destination (Join-Path $inst 'swarmcast-server.exe')
  Set-Content -LiteralPath (Join-Path $inst 'resources\leftover.txt') -Value 'x'
  $web1 = Join-Path $env:LOCALAPPDATA $AppId
  $web2 = Join-Path $env:APPDATA $AppId
  New-Item -ItemType Directory -Force -Path (Join-Path $web1 'EBWebView\Default'), $web2 | Out-Null
  Set-Content -LiteralPath (Join-Path $web1 'EBWebView\Default\x.txt') -Value 'x'
  Set-Content -LiteralPath (Join-Path $web2 'x.txt') -Value 'x'
  $keepLocal = Join-Path $env:LOCALAPPDATA 'Other\keep.txt'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $keepLocal) | Out-Null
  Set-Content -LiteralPath $keepLocal -Value 'x'
  # Same name, outside SwarmCast folders: must keep running.
  $outsideApp = Join-Path $Work 'outside app\SwarmCast.exe'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outsideApp) | Out-Null
  Copy-Item -LiteralPath $sleeper -Destination $outsideApp
  $uninstLog = Join-Path $Work 'uninstall-calls.log'
  if ($OnWindows) {
    $uninst = Join-Path $inst 'uninstall.exe'
    Copy-Item -LiteralPath (New-FakeUninstaller) -Destination $uninst
    # Tauri names the key after the product, but it is found by DisplayName.
    $keyRel = New-FakeUninstallEntry 'NotTheProductName_1234' 'SwarmCast' $uninst $inst
    $otherDir = Join-Path $Work 'other app'
    New-Item -ItemType Directory -Force -Path $otherDir | Out-Null
    $otherUninst = Join-Path $otherDir 'uninstall.exe'
    Copy-Item -LiteralPath (New-FakeUninstaller) -Destination $otherUninst
    New-FakeUninstallEntry 'OtherApp' 'Other App' $otherUninst $otherDir | Out-Null
    Set-FakeRunValue 'SwarmCast' "`"$appExe`" --background"
    Set-FakeRunValue 'OtherApp' "`"$otherDir\other.exe`""
    $sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $desk = Join-Path $env:USERPROFILE 'Desktop'
    New-Shortcut (Join-Path $sm 'SwarmCast.lnk') $appExe
    New-Shortcut (Join-Path $desk 'SwarmCast.lnk') $appExe
    New-Shortcut (Join-Path $desk 'Other.lnk') (Join-Path $env:WINDIR 'notepad.exe')
    New-Shortcut (Join-Path $sm 'SwarmCast\SwarmCast.lnk') (Join-Path $env:WINDIR 'notepad.exe')
    $env:FAKE_UNINSTALL_LOG = $uninstLog
    $env:FAKE_UNINSTALL_KEY = $keyRel
  }
  $p1 = Start-Sleeper $appExe
  $p2 = Start-Sleeper $mtx
  $p3 = Start-Sleeper $outsideApp
  Start-Sleep -Milliseconds 800
  Assert-Running $p1.Id 'SwarmCast.exe (desktop app)'
  $cleanupLog = Join-Path $Work 'cleanup-desktop.log'
  $env:FAKE_CLEANUP_LOG = $cleanupLog
  Invoke-Uninstall @()
  Remove-Item Env:FAKE_CLEANUP_LOG, Env:FAKE_UNINSTALL_LOG, Env:FAKE_UNINSTALL_KEY -ErrorAction SilentlyContinue
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out "Desktop app: $inst"
  Assert-Stopped $p1.Id 'SwarmCast.exe (desktop app)'
  Assert-Stopped $p2.Id 'mediamtx (desktop app)'
  Assert-Running $p3.Id 'SwarmCast.exe outside SwarmCast folders'
  Assert-Absent $inst
  Assert-Eq (@(Get-Content -LiteralPath $cleanupLog -ErrorAction SilentlyContinue))[0] "--cleanup --data-dir $Data" 'the desktop app''s swarmcast-server ran --cleanup'
  Assert-Absent $web1
  Assert-Absent $web2
  Assert-Exists $keepLocal
  Assert-Absent $Data
  Assert-Contains $script:Out 'SwarmCast was removed from this computer'
  if ($OnWindows) {
    $calls = Read-Text $uninstLog
    Assert-Contains $calls "exe=$uninst" 'the SwarmCast uninstaller was run'
    Assert-Contains $calls 'silent=True' 'it was run with /S'
    Assert-Contains $calls "dir=$inst" 'it was run in place (_?=<install folder>)'
    Assert-NotContains $calls $otherUninst 'the other app''s uninstaller was not run'
    Assert-Eq (Test-Path -LiteralPath "$RegBase\Uninstall\NotTheProductName_1234") $false 'the SwarmCast Uninstall key is gone'
    Assert-Eq (Test-Path -LiteralPath "$RegBase\Uninstall\OtherApp") $true 'the other Uninstall key is kept'
    Assert-Eq (Test-RunValue 'SwarmCast') $false 'the SwarmCast Run value is gone'
    Assert-Eq (Test-RunValue 'OtherApp') $true 'the other Run value is kept'
    Assert-Absent (Join-Path $sm 'SwarmCast.lnk')
    Assert-Absent (Join-Path $desk 'SwarmCast.lnk')
    Assert-Exists (Join-Path $desk 'Other.lnk')
    Assert-Exists (Join-Path $sm 'SwarmCast\SwarmCast.lnk')
    Assert-Exists $otherUninst
  } else {
    Skip 'registry, shortcuts and the NSIS uninstaller only exist on Windows'
  }
  Stop-Process -Id $p3.Id -Force -ErrorAction SilentlyContinue
  End-Case

  Begin-Case '9b. desktop app only, its uninstaller missing: files and the registry entry are removed anyway'
  if (Test-Path -LiteralPath $Data) { Remove-Item -LiteralPath $Data -Recurse -Force }
  $inst = Join-Path $env:LOCALAPPDATA 'Programs\SwarmCast'
  New-Item -ItemType Directory -Force -Path $inst | Out-Null
  Set-Content -LiteralPath (Join-Path $inst 'SwarmCast.exe') -Value 'x'
  if ($OnWindows) { New-FakeUninstallEntry 'SwarmCast' 'SwarmCast' (Join-Path $inst 'uninstall.exe') $null | Out-Null }
  Invoke-Uninstall @()
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Absent $inst
  Assert-Contains $script:Out 'SwarmCast uninstall finished: removed the desktop app'
  Assert-NotContains $script:Out 'not installed'
  if ($OnWindows) { Assert-Eq (Test-Path -LiteralPath "$RegBase\Uninstall\SwarmCast") $false 'the Uninstall key is gone' }
  End-Case

  Begin-Case '9c. an Uninstall entry pointing at a folder that is not SwarmCast''s: the folder is kept'
  if (-not $OnWindows) {
    Skip 'the registry only exists on Windows'
  } else {
    New-Tree
    $precious = Join-Path $Work 'precious'
    New-Item -ItemType Directory -Force -Path $precious | Out-Null
    Set-Content -LiteralPath (Join-Path $precious 'thesis.txt') -Value 'precious'
    New-FakeUninstallEntry 'SwarmCastOdd' 'SwarmCast' (Join-Path $precious 'missing-uninstall.exe') $precious | Out-Null
    Invoke-Uninstall @()
    Assert-Eq $script:Rc 0 'exit code 0'
    Assert-Eq (Read-Text (Join-Path $precious 'thesis.txt')) 'precious' 'file untouched'
    Assert-Absent $Data
    Assert-Eq (Test-Path -LiteralPath "$RegBase\Uninstall\SwarmCastOdd") $true 'its registry entry is kept while the folder exists'
    Remove-Item -LiteralPath "$RegBase\Uninstall\SwarmCastOdd" -Recurse -Force
  }
  End-Case

  # --- 8. usage -------------------------------------------------------------------
  Begin-Case '8. --help and unknown options'
  Invoke-Uninstall @('--help')
  Assert-Eq $script:Rc 0 '--help exits 0'
  Assert-Contains $script:Out '--keep-settings'
  Invoke-Uninstall @('--bogus')
  Assert-Eq $script:Rc 2 'unknown option exits 2'
  End-Case
} finally {
  foreach ($p in $script:Started) { try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch { } }
  Remove-Item Env:SWARMCAST_HOME, Env:SWARMCAST_NO_PAUSE, Env:SWARMCAST_DATA_DIR, Env:SWARMCAST_STOP_GRACE, Env:SWARMCAST_DELETE_DELAYS, Env:FAKE_CLEANUP_LOG, Env:FAKE_CLEANUP_EXIT -ErrorAction SilentlyContinue
  Remove-Item Env:SWARMCAST_TEST_SANDBOX, Env:FAKE_UNINSTALL_LOG, Env:FAKE_UNINSTALL_KEY -ErrorAction SilentlyContinue
  $env:LOCALAPPDATA = $SavedEnv.LOCALAPPDATA
  $env:APPDATA = $SavedEnv.APPDATA
  $env:USERPROFILE = $SavedEnv.USERPROFILE
  if ($OnWindows) {
    Remove-Item -LiteralPath $RegBase -Recurse -Force -ErrorAction SilentlyContinue
    $parentKey = 'HKCU:\Software\SwarmCastTestSandbox'
    if ((Test-Path -LiteralPath $parentKey) -and @(Get-ChildItem -LiteralPath $parentKey -ErrorAction SilentlyContinue).Count -eq 0) {
      Remove-Item -LiteralPath $parentKey -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 500
  if ($env:KEEP_WORK -eq '1') { Write-Host "Work dir kept: $Work" } else { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host '=============================='
Write-Host ("Uninstaller tests (windows-{0}): {1} passed, {2} failed" -f $Arch, $script:Pass, $script:Fail)
if ($script:Fail -gt 0) {
  Write-Host 'Failed:'
  $script:FailedNames | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
exit 0
