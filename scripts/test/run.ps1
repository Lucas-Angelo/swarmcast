# Tests for scripts/start-windows.ps1 / start-windows.cmd against a fake release
# served from 127.0.0.1. Run with Windows PowerShell 5.1 (the version the script
# targets):  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test\run.ps1
# Needs node in PATH. ASCII-only on purpose (PowerShell 5.1 reads files as ANSI).
#
# Development aid: it also runs with pwsh on Linux/macOS. There the fake swarmcast.exe
# is a shell script and start-windows.ps1 is called directly with pwsh (no .cmd), which
# exercises the script's logic but not the Windows-only parts.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OnWindows = ($env:OS -eq 'Windows_NT')
if (-not $OnWindows -and -not $env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE = 'AMD64' }

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$TestDir = Join-Path $Root 'scripts\test'
$Script = Join-Path $Root 'scripts\start-windows.ps1'
$Cmd = Join-Path $Root 'scripts\start-windows.cmd'
$Arch = 'x64'   # the script always uses the x64 build on Windows (ARM64 runs it emulated)

$Work = Join-Path ([IO.Path]::GetTempPath()) ('swarmcast-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Release = Join-Path $Work 'release'
$Data = Join-Path $Work 'swarm home'       # a space on purpose: quoting must hold
$ScriptTmp = Join-Path $Work 'tmp'         # TEMP/TMP for the script under test
$ReqLog = Join-Path $Work 'requests.log'
$ExeDir = Join-Path $Work 'exe'
New-Item -ItemType Directory -Force -Path $Release, $ScriptTmp, $ExeDir | Out-Null
Set-Content -LiteralPath $ReqLog -Value '' -NoNewline

$script:Pass = 0
$script:Fail = 0
$script:FailedNames = @()
$script:Case = ''
$script:CaseFailed = $false
$script:Out = ''
$script:Rc = 0

function Begin-Case([string]$Name) {
  $script:Case = $Name
  $script:CaseFailed = $false
  $script:Out = ''
  Write-Host ''
  Write-Host "=== $Name"
}
function Pass([string]$Msg) { Write-Host "  ok: $Msg" }
function Fail([string]$Msg) { Write-Host "  FAIL: $Msg" -ForegroundColor Red; $script:CaseFailed = $true }
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
function Assert-Ne($Actual, $NotExpected, [string]$Msg) {
  if ("$Actual" -ne "$NotExpected") { Pass $Msg } else { Fail "$Msg (did not expect '$NotExpected')" }
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
function Read-Text([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $content = Get-Content -LiteralPath $Path -Raw
  if ($null -eq $content) { return '' }
  return "$content".Trim()
}
function Assert-NoStaging {
  $left = @(Get-ChildItem -LiteralPath (Join-Path $Data 'app') -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '.staging-*' })
  if ($left.Count -eq 0) { Pass 'no staging folder left' } else { Fail "staging folder left: $($left[0].Name)" }
}
function Assert-TmpEmpty {
  # Only the script's own temp folders: PowerShell itself may drop policy-test files in TEMP.
  $left = @(Get-ChildItem -LiteralPath $ScriptTmp -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'swarmcast-*' })
  if ($left.Count -eq 0) { Pass 'temporary files cleaned up' } else { Fail "temporary files left: $(($left | ForEach-Object { $_.Name }) -join ', ')" }
}

# Runs the installer. -ViaPs runs start-windows.ps1 directly (PowerShell-style flags),
# otherwise start-windows.cmd (GNU-style flags, like a user would pass them).
function Invoke-Installer([string]$Url, [string[]]$Arguments, [switch]$ViaPs) {
  $env:SWARMCAST_HOME = $Data
  $env:SWARMCAST_RELEASE_URL = $Url
  $env:SWARMCAST_NO_PAUSE = '1'
  $oldTemp = $env:TEMP; $oldTmp = $env:TMP
  $env:TEMP = $ScriptTmp; $env:TMP = $ScriptTmp
  $ErrorActionPreference = 'Continue'
  try {
    if (-not $OnWindows) {
      $lines = & pwsh -NoProfile -File $Script @Arguments 2>&1
    } elseif ($ViaPs) {
      $lines = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script @Arguments 2>&1
    } else {
      $lines = & $Cmd @Arguments 2>&1
    }
    $script:Rc = $LASTEXITCODE
  } finally {
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp
    $ErrorActionPreference = 'Stop'
  }
  $script:Out = (@($lines) | ForEach-Object { "$_" }) -join "`n"
  Write-Host "  (exit code $($script:Rc))"
}

# Compiles a fake swarmcast.exe that prints $Version for --version.
function New-FakeExe([string]$Version) {
  $out = Join-Path $ExeDir "swarmcast-$Version.exe"
  if (Test-Path -LiteralPath $out) { return $out }
  if (-not $OnWindows) {
    $sh = @"
#!/bin/sh
V="$Version"
case " `$* " in
  *" --version "*) echo "`$V"; exit 0 ;;
  *" --smoke-test "*) echo "fake swarmcast `$V: smoke test"; [ -n "`$SWARMCAST_DATA_DIR" ] && printf '%s' "`$V" > "`$SWARMCAST_DATA_DIR/fake-smoke-ran"; echo "smoke test passed"; exit 0 ;;
  *) if [ "`$FAKE_CRASH_VERSION" = "`$V" ]; then echo "crashed"; exit 3; fi; echo "fake swarmcast `$V started with: `$*"; [ -n "`$SWARMCAST_DATA_DIR" ] && printf '%s' "`$V `$*" > "`$SWARMCAST_DATA_DIR/fake-started"; exit 0 ;;
esac
"@
    [IO.File]::WriteAllText($out, $sh.Replace("`r`n", "`n"))
    & chmod 755 $out
    return $out
  }
  $cls = 'FakeSwarmCast' + ($Version -replace '\.', '_')
  $src = @"
using System;
using System.IO;
public static class $cls {
  public static int Main(string[] args) {
    string version = "$Version";
    string data = Environment.GetEnvironmentVariable("SWARMCAST_DATA_DIR");
    if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine(version); return 0; }
    if (Array.IndexOf(args, "--smoke-test") >= 0) {
      Console.WriteLine("fake swarmcast " + version + ": smoke test");
      if (!String.IsNullOrEmpty(data)) File.WriteAllText(Path.Combine(data, "fake-smoke-ran"), version);
      Console.WriteLine("smoke test passed");
      return 0;
    }
    if (Environment.GetEnvironmentVariable("FAKE_CRASH_VERSION") == version) { Console.WriteLine("crashed on start"); return 3; }
    Console.WriteLine("fake swarmcast " + version + " started with: " + String.Join(" ", args));
    if (!String.IsNullOrEmpty(data)) File.WriteAllText(Path.Combine(data, "fake-started"), (version + " " + String.Join(" ", args)).Trim());
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

# Compiles a fake ffmpeg.exe that prints "ffmpeg version $Version" for -version.
function New-FakeFfmpeg([string]$Version) {
  $out = Join-Path $ExeDir "ffmpeg-$Version.exe"
  if (Test-Path -LiteralPath $out) { return $out }
  if (-not $OnWindows) {
    [IO.File]::WriteAllText($out, "#!/bin/sh`necho `"ffmpeg version $Version Copyright (c) fake`"`n")
    & chmod 755 $out
    return $out
  }
  $cls = 'FakeFfmpeg' + ($Version -replace '[^A-Za-z0-9]', '_')
  $src = "public static class $cls { public static int Main(string[] args) { System.Console.WriteLine(`"ffmpeg version $Version Copyright (c) fake`"); return 0; } }"
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

function Get-FfAsset([string]$Version) { return "ffmpeg-fake-$Version-win64.zip" }

# Every fake release also publishes binaries.json + a fake ffmpeg archive served by the local
# server ("the publisher"). -NoFfmpegPins leaves them out; -FfmpegBase points them elsewhere.
function New-Release([string]$Version, [switch]$Corrupt, [string]$Dir = $Release, [string]$FfmpegVersion = '9.0.2-fake', [switch]$FfmpegBadSha, [switch]$NoFfmpegPins, [string]$FfmpegBase = $Url) {
  $exe = New-FakeExe $Version
  $nodeArgs = @((Join-Path $TestDir 'make-fake-release.mjs'), '--dir', $Dir, '--version', $Version, '--os', 'windows', '--arch', $Arch, '--exe', $exe)
  if (-not $NoFfmpegPins) { $nodeArgs += @('--ffmpeg-base', $FfmpegBase, '--ffmpeg-version', $FfmpegVersion, '--ffmpeg-exe', (New-FakeFfmpeg $FfmpegVersion)) }
  if ($FfmpegBadSha) { $nodeArgs += '--ffmpeg-bad-sha' }
  if ($Corrupt) { $nodeArgs += '--corrupt' }
  & node @nodeArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'make-fake-release failed' }
}

function Get-Pkg([string]$Version) { return "SwarmCast-v$Version-windows-$Arch.zip" }

# Local bundle (extracted installer zip): start scripts + package + one-line SHA256SUMS.txt.
# The default release URL of the copied .ps1 is rewritten to $DefaultUrl.
$Bundle = Join-Path $Work 'installer folder'   # a space on purpose
function New-Bundle([string]$Version, [string]$DefaultUrl, [switch]$Corrupt, [string]$FfmpegBase = $Url) {
  if (Test-Path -LiteralPath $Bundle) { Remove-Item -LiteralPath $Bundle -Recurse -Force }
  New-Release $Version -Corrupt:$Corrupt -Dir $Bundle -FfmpegBase $FfmpegBase
  # The ffmpeg URL in binaries.json points at the local server: serve the archive there.
  Get-ChildItem -LiteralPath $Bundle -Filter 'ffmpeg-fake-*' | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $Release $_.Name) -Force }
  $sums = Join-Path $Bundle 'SHA256SUMS.txt'
  # Like the release workflow: the package and binaries.json (ffmpeg pins) are listed.
  $line = @([IO.File]::ReadAllLines($sums) | Where-Object { $_.EndsWith("  $(Get-Pkg $Version)") -or $_.EndsWith('  binaries.json') })
  [IO.File]::WriteAllText($sums, ($line -join "`n") + "`n")
  $ps = [IO.File]::ReadAllText($Script)
  $ps = (($ps -split "`n") | ForEach-Object { if ($_.StartsWith('$SC_DefaultReleaseUrl = ')) { "`$SC_DefaultReleaseUrl = '$DefaultUrl'`r" } else { $_ } }) -join "`n"
  if ($ps.IndexOf("`$SC_DefaultReleaseUrl = '$DefaultUrl'") -lt 0) { throw 'could not rewrite the default release URL' }
  [IO.File]::WriteAllText((Join-Path $Bundle 'start-windows.ps1'), $ps, (New-Object System.Text.ASCIIEncoding))
  Copy-Item -LiteralPath $Cmd -Destination (Join-Path $Bundle 'start-windows.cmd')
}

# Runs the bundle's script like a user would (double-clicking start-windows.cmd), with
# SWARMCAST_RELEASE_URL unset unless -EnvUrl is given.
function Invoke-Bundle([string[]]$Arguments, [string]$EnvUrl) {
  $env:SWARMCAST_HOME = $Data
  if ($EnvUrl) { $env:SWARMCAST_RELEASE_URL = $EnvUrl } else { Remove-Item Env:SWARMCAST_RELEASE_URL -ErrorAction SilentlyContinue }
  $env:SWARMCAST_NO_PAUSE = '1'
  $oldTemp = $env:TEMP; $oldTmp = $env:TMP
  $env:TEMP = $ScriptTmp; $env:TMP = $ScriptTmp
  $ErrorActionPreference = 'Continue'
  try {
    if (-not $OnWindows) {
      $lines = & pwsh -NoProfile -File (Join-Path $Bundle 'start-windows.ps1') @Arguments 2>&1
    } else {
      $lines = & (Join-Path $Bundle 'start-windows.cmd') @Arguments 2>&1
    }
    $script:Rc = $LASTEXITCODE
  } finally {
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp
    $ErrorActionPreference = 'Stop'
  }
  $script:Out = (@($lines) | ForEach-Object { "$_" }) -join "`n"
  Write-Host "  (exit code $($script:Rc))"
}

$server = $null
try {
  # --- static analysis ------------------------------------------------------
  Begin-Case 'syntax check'
  foreach ($f in @($Script, $PSCommandPath)) {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)
    if ($errors.Count -eq 0) { Pass "parses: $(Split-Path -Leaf $f)" } else { Fail "parse errors in $(Split-Path -Leaf $f): $($errors[0].Message) (line $($errors[0].Extent.StartLineNumber))" }
  }
  $nonAscii = @([IO.File]::ReadAllBytes($Script) | Where-Object { $_ -gt 127 }).Count
  Assert-Eq $nonAscii 0 'start-windows.ps1 is ASCII-only (PowerShell 5.1 reads BOM-less files as ANSI)'
  End-Case

  # --- server ----------------------------------------------------------------
  $portFile = Join-Path $Work 'port'
  $server = Start-Process -FilePath 'node' -ArgumentList @("`"$(Join-Path $TestDir 'serve.mjs')`"", "`"$Release`"", "`"$portFile`"", "`"$ReqLog`"") -PassThru -NoNewWindow
  for ($i = 0; $i -lt 100 -and -not (Test-Path -LiteralPath $portFile); $i++) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path -LiteralPath $portFile)) { throw 'static server did not start' }
  Start-Sleep -Milliseconds 200
  $Url = "http://127.0.0.1:$((Get-Content -LiteralPath $portFile -Raw).Trim())"
  $freePort = (& node (Join-Path $TestDir 'serve.mjs') --free-port | Out-String).Trim()
  $ClosedUrl = "http://127.0.0.1:$freePort"
  Write-Host "Fake release server: $Url  (platform windows-$Arch)"

  $Common = @('--yes', '--no-tunnel', '--skip-speedtest')

  # --- 1. clean install --------------------------------------------------------
  Begin-Case '1. clean install + smoke test'
  New-Release '0.0.1'
  Invoke-Installer $Url ($Common + '--smoke-test')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.0.1' 'current\VERSION is 0.0.1'
  Assert-Eq (Read-Text (Join-Path $Data 'fake-smoke-ran')) '0.0.1' 'smoke test ran v0.0.1 with SWARMCAST_DATA_DIR exported'
  Assert-Exists (Join-Path $Data 'app\current\bin\mediamtx.exe')
  Assert-Absent (Join-Path $Data 'app\previous')
  $log = Read-Text (Join-Path $Data 'logs\install.log')
  Assert-Contains $log 'smoke test passed' 'install.log has the smoke test output'
  Assert-Contains $log 'Installed SwarmCast v0.0.1' 'install.log has the install'
  Assert-Contains (Read-Text $ReqLog) "GET /$(Get-Pkg '0.0.1') 200" 'package was downloaded'
  Assert-Contains (Read-Text $ReqLog) 'GET /binaries.json 200' 'binaries.json (ffmpeg pins) fetched'
  Assert-Contains (Read-Text $ReqLog) "GET /$(Get-FfAsset '9.0.2-fake') 200" 'ffmpeg downloaded from the URL in binaries.json'
  Assert-Exists (Join-Path $Data 'tools\ffmpeg\ffmpeg.exe')
  Assert-Contains (Read-Text (Join-Path $Data 'tools\ffmpeg\PIN')) '9.0.2-fake' 'pin stamp written'
  Assert-Contains $script:Out 'Installed ffmpeg 9.0.2-fake'
  Assert-NoStaging
  Assert-TmpEmpty
  End-Case

  # --- 2. second run (PowerShell-style flags) --------------------------------
  Begin-Case '2. second run is already up to date (PowerShell-style flags)'
  Remove-Item -LiteralPath (Join-Path $Data 'fake-smoke-ran') -Force -ErrorAction SilentlyContinue
  Set-Content -LiteralPath $ReqLog -Value '' -NoNewline
  Invoke-Installer $Url @('-Yes', '-NoTunnel', '-SkipSpeedtest', '-SmokeTest') -ViaPs
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Already up to date (v0.0.1)'
  Assert-Contains (Read-Text (Join-Path $Data 'logs\install.log')) 'Already up to date (v0.0.1)' 'install.log says already up to date'
  Assert-NotContains (Read-Text $ReqLog) '.zip' 'no package download'
  Assert-Contains (Read-Text $ReqLog) 'GET /SHA256SUMS.txt 200' 'checksum list fetched'
  Assert-NotContains (Read-Text $ReqLog) 'ffmpeg-fake' 'no ffmpeg download (same pin)'
  Assert-Contains $script:Out 'Video converter (ffmpeg 9.0.2-fake) already installed'
  Assert-NotContains $script:Out 'Saving the system check failed' 'system-check.json replaced on a second run (no retries)'
  Assert-Eq (Read-Text (Join-Path $Data 'fake-smoke-ran')) '0.0.1' 'smoke test ran'
  Assert-TmpEmpty
  End-Case

  # --- 2c. normal start ------------------------------------------------------
  Begin-Case '2c. normal start passes --no-tunnel; --install-only does not start'
  Invoke-Installer $Url @('--yes', '--skip-speedtest', '--install-only')
  Assert-Eq $script:Rc 0 '--install-only exit code 0'
  Assert-Absent (Join-Path $Data 'fake-started')
  Invoke-Installer $Url $Common
  Assert-Eq $script:Rc 0 'start exit code 0 (the fake app exits 0)'
  Assert-Contains $script:Out 'rtmp://127.0.0.1:1935/live' 'OBS hint printed'
  Assert-Eq (Read-Text (Join-Path $Data 'fake-started')) '0.0.1 --no-tunnel' 'app started with --no-tunnel'
  Assert-TmpEmpty
  End-Case

  # --- 3. update ---------------------------------------------------------------
  Begin-Case '3. update to 0.0.2 keeps config and secrets'
  $refs = @{}
  foreach ($n in @('config', 'secrets', 'state')) {
    $p = Join-Path $Data "$n.json"
    [IO.File]::WriteAllText($p, "{`"$n`":`"do-not-touch`"}`n")
    $refs[$n] = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash
  }
  New-Release '0.0.2'
  Remove-Item -LiteralPath (Join-Path $Data 'fake-smoke-ran') -Force -ErrorAction SilentlyContinue
  Invoke-Installer $Url ($Common + '--smoke-test')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.0.2' 'current\VERSION is 0.0.2'
  Assert-Eq (Read-Text (Join-Path $Data 'app\previous\VERSION')) '0.0.1' 'previous\VERSION is 0.0.1'
  Assert-Eq (Read-Text (Join-Path $Data 'fake-smoke-ran')) '0.0.2' 'smoke test ran v0.0.2'
  foreach ($n in @('config', 'secrets', 'state')) {
    Assert-Eq (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Data "$n.json")).Hash $refs[$n] "$n.json untouched"
  }
  Assert-Contains $script:Out 'Updating SwarmCast v0.0.1 -> v0.0.2'
  Assert-Exists (Join-Path $Data 'tools\ffmpeg\ffmpeg.exe')
  Assert-NoStaging
  Assert-TmpEmpty
  End-Case

  # --- 4. checksum failure -------------------------------------------------------
  Begin-Case '4. corrupted 0.0.3 download is rejected'
  New-Release '0.0.3' -Corrupt
  Remove-Item -LiteralPath (Join-Path $Data 'fake-smoke-ran') -Force -ErrorAction SilentlyContinue
  Invoke-Installer $Url ($Common + '--smoke-test')
  Assert-Ne $script:Rc 0 'non-zero exit code'
  Assert-Contains $script:Out 'Checksum mismatch'
  Assert-Contains (Read-Text (Join-Path $Data 'logs\install.log')) 'Checksum mismatch' 'install.log has the checksum error'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.0.2' 'current is still 0.0.2'
  Assert-Eq (Read-Text (Join-Path $Data 'app\previous\VERSION')) '0.0.1' 'previous is still 0.0.1'
  Assert-Absent (Join-Path $Data 'fake-smoke-ran')
  Assert-NoStaging
  Assert-TmpEmpty
  End-Case

  # --- 5. offline with an existing install -----------------------------------
  Begin-Case '5. offline starts the installed version'
  Invoke-Installer $ClosedUrl ($Common + '--smoke-test')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Could not check for updates'
  Assert-Eq (Read-Text (Join-Path $Data 'fake-smoke-ran')) '0.0.2' 'smoke test ran the installed v0.0.2'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.0.2' 'current is still 0.0.2'
  Assert-TmpEmpty
  End-Case

  # --- 6. offline with nothing installed -------------------------------------
  Begin-Case '6. offline with nothing installed fails clearly'
  $savedData = $Data
  $Data = Join-Path $Work 'empty home'
  Invoke-Installer $ClosedUrl ($Common + '--smoke-test')
  Assert-Ne $script:Rc 0 'non-zero exit code'
  Assert-Contains $script:Out 'release server is unreachable'
  Assert-Absent (Join-Path $Data 'app\current')
  Assert-TmpEmpty
  $Data = $savedData
  End-Case

  # --- 9. video converter (ffmpeg) ---------------------------------------------
  $savedData = $Data
  Begin-Case '9a. ffmpeg checksum mismatch: skipped with a warning, the install still succeeds'
  $Data = Join-Path $Work 'ffmpeg bad sha home'
  New-Release '0.0.4' -FfmpegBadSha
  Invoke-Installer $Url ($Common + '--smoke-test')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'checksum mismatch for the ffmpeg download'
  Assert-Contains $script:Out 'still works without it'
  Assert-Absent (Join-Path $Data 'tools\ffmpeg\ffmpeg.exe')
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.0.4' 'SwarmCast itself was installed'
  Assert-Eq (Read-Text (Join-Path $Data 'fake-smoke-ran')) '0.0.4' 'smoke test ran'
  Assert-TmpEmpty
  End-Case

  Begin-Case '9b. -NoFfmpeg skips the download'
  $Data = Join-Path $Work 'no ffmpeg home'
  New-Release '0.0.4'
  Set-Content -LiteralPath $ReqLog -Value '' -NoNewline
  Invoke-Installer $Url @('-Yes', '-SkipSpeedtest', '-InstallOnly', '-NoFfmpeg') -ViaPs
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Skipped (--no-ffmpeg)'
  Assert-NotContains (Read-Text $ReqLog) 'ffmpeg-fake' 'no ffmpeg download'
  Assert-Absent (Join-Path $Data 'tools\ffmpeg\ffmpeg.exe')
  Assert-TmpEmpty
  End-Case

  Begin-Case '9c. a new ffmpeg pin is downloaded once, even when SwarmCast is already up to date'
  $Data = $savedData
  New-Release '0.0.2' -FfmpegVersion '9.0.3-fake'
  Set-Content -LiteralPath $ReqLog -Value '' -NoNewline
  Invoke-Installer $Url ($Common + '--install-only')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Already up to date (v0.0.2)'
  Assert-Contains (Read-Text $ReqLog) "GET /$(Get-FfAsset '9.0.3-fake') 200" 'new ffmpeg downloaded'
  Assert-Contains (Read-Text (Join-Path $Data 'tools\ffmpeg\PIN')) '9.0.3-fake' 'pin stamp updated'
  Assert-TmpEmpty
  End-Case
  $Data = $savedData

  # --- 11. resilience -----------------------------------------------------------
  Begin-Case '11a. a transient unpacking failure recovers on retry'
  $Data = Join-Path $Work 'retry home'
  New-Release '0.0.4'
  $env:SWARMCAST_TEST_FAIL_ONCE = 'extract'
  try { Invoke-Installer $Url @('--no-tunnel', '--skip-speedtest', '--no-ffmpeg', '--install-only') } finally { Remove-Item Env:SWARMCAST_TEST_FAIL_ONCE -ErrorAction SilentlyContinue }
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out "Unpacking $(Get-Pkg '0.0.4') failed, retrying in 2 s"
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.0.4' 'installed after the retry'
  Assert-NoStaging
  Assert-TmpEmpty
  End-Case

  Begin-Case '11b. a new version that crashes on start: rolled back to the previous one, which starts'
  New-Release '0.0.5'
  Remove-Item -LiteralPath (Join-Path $Data 'fake-started') -Force -ErrorAction SilentlyContinue
  $env:FAKE_CRASH_VERSION = '0.0.5'
  try { Invoke-Installer $Url @('--no-tunnel', '--skip-speedtest', '--no-ffmpeg') } finally { Remove-Item Env:FAKE_CRASH_VERSION -ErrorAction SilentlyContinue }
  Assert-Eq $script:Rc 0 'exit code 0 (the previous version started)'
  Assert-Contains $script:Out 'The new version v0.0.5 did not start, so SwarmCast went back to v0.0.4'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.0.4' 'current is back to 0.0.4'
  Assert-Eq (Read-Text (Join-Path $Data 'fake-started')) '0.0.4 --no-tunnel' 'v0.0.4 was started'
  End-Case

  Begin-Case '11c. system-check.json is written with the schema'
  $j = [IO.File]::ReadAllText((Join-Path $Data 'system-check.json')) | ConvertFrom-Json
  Assert-Eq $j.version 1 'version 1'
  foreach ($id in @('os', 'ram', 'cpu', 'upload', 'download', 'disk', 'ports', 'obs', 'github', 'release')) {
    Assert-Eq (@($j.results | Where-Object { $_.id -eq $id }).Count) 1 "has $id"
  }
  Assert-Eq (@($j.results | Where-Object { @('ok', 'warn', 'fail', 'skipped') -notcontains $_.status }).Count) 0 'statuses are ok|warn|fail|skipped'
  Assert-Eq (@($j.results | Where-Object { $_.id -eq 'upload' })[0].status) 'skipped' 'upload skipped'
  Assert-Eq $j.uploadMbps $null 'uploadMbps null'
  End-Case
  $Data = $savedData

  # --- 10. never asks questions by default -----------------------------------
  Begin-Case '10a. below the minimum: warns and continues without any input (no -Yes)'
  $Data = Join-Path $Work 'below minimum home'
  New-Release '0.0.4'
  $env:SWARMCAST_TEST_BELOW = 'memory 1.0 GB (minimum 4 GB)'
  try { Invoke-Installer $Url @('--no-tunnel', '--skip-speedtest', '--no-ffmpeg', '--install-only') } finally { Remove-Item Env:SWARMCAST_TEST_BELOW -ErrorAction SilentlyContinue }
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'below the recommended minimum: memory 1.0 GB'
  Assert-Contains $script:Out 'Continuing anyway'
  Assert-NotContains $script:Out '(y/N)' 'no question asked'
  Assert-Contains (Read-Text (Join-Path $Data 'logs\install.log')) 'below the recommended minimum' 'install.log has the warning'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.0.4' 'installed'
  Assert-TmpEmpty
  End-Case

  Begin-Case '10b. -Ask restores the question (-Yes answers it)'
  $Data = Join-Path $Work 'ask home'
  $env:SWARMCAST_TEST_BELOW = 'memory 1.0 GB (minimum 4 GB)'
  try { Invoke-Installer $Url @('-Ask', '-Yes', '-NoTunnel', '-SkipSpeedtest', '-NoFfmpeg', '-InstallOnly') -ViaPs } finally { Remove-Item Env:SWARMCAST_TEST_BELOW -ErrorAction SilentlyContinue }
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Continue anyway? (y/N) yes (--yes)'
  Assert-NotContains $script:Out 'Continuing anyway'
  Assert-TmpEmpty
  End-Case
  $Data = $savedData

  # --- 8. local bundle (installer zip) ---------------------------------------
  # The script copy inside the bundle gets its default release URL rewritten (like the
  # release workflow does for the public mirror), so no test ever talks to GitHub.
  $savedData = $Data
  $Data = Join-Path $Work 'bundle home'

  Begin-Case '8a. local bundle installs with no release server reachable'
  New-Bundle '0.1.0' $ClosedUrl
  Set-Content -LiteralPath $ReqLog -Value '' -NoNewline
  Invoke-Bundle ($Common + '--smoke-test')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Install source: local bundle in'
  Assert-Contains $script:Out 'installer folder (v0.1.0)' 'source is the bundle folder'
  Assert-Contains $script:Out 'not reachable (fine)' 'unreachable online release is not an error'
  Assert-Contains $script:Out "Using $(Get-Pkg '0.1.0') from the local bundle"
  Assert-Contains $script:Out 'Checksum OK'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.1.0' 'current\VERSION is 0.1.0'
  Assert-Eq (Read-Text (Join-Path $Data 'fake-smoke-ran')) '0.1.0' 'smoke test ran v0.1.0'
  Assert-NotContains (Read-Text $ReqLog) 'SHA256SUMS' 'no request to the release server'
  Assert-Contains (Read-Text $ReqLog) "GET /$(Get-FfAsset '9.0.2-fake') 200" "ffmpeg downloaded online using the bundle's binaries.json"
  Assert-Exists (Join-Path $Data 'tools\ffmpeg\ffmpeg.exe')
  Assert-Exists (Join-Path $Bundle (Get-Pkg '0.1.0'))
  Assert-NoStaging
  Assert-TmpEmpty
  End-Case

  Begin-Case '8b. second run from the bundle: already up to date; HTTP 404 from the release server is fine'
  New-Bundle '0.1.0' "$Url/private-repo"
  Set-Content -LiteralPath $ReqLog -Value '' -NoNewline
  Invoke-Bundle ($Common + '--smoke-test')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Already up to date (v0.1.0)'
  $hits = @((Read-Text $ReqLog) -split "`r?`n" | Where-Object { $_ -eq 'GET /private-repo/SHA256SUMS.txt 404' }).Count
  Assert-Eq $hits 1 'online check asked once (no retries on 404)'
  Assert-NotContains $script:Out 'retrying'
  Assert-TmpEmpty
  End-Case

  Begin-Case '8c. update from a newer local bundle'
  $secrets = Join-Path $Data 'secrets.json'
  [IO.File]::WriteAllText($secrets, "{`"secret`":`"do-not-touch`"}`n")
  $secretsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $secrets).Hash
  New-Bundle '0.1.1' $ClosedUrl
  Remove-Item -LiteralPath (Join-Path $Data 'fake-smoke-ran') -Force -ErrorAction SilentlyContinue
  Invoke-Bundle ($Common + '--smoke-test')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Updating SwarmCast v0.1.0 -> v0.1.1'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.1.1' 'current\VERSION is 0.1.1'
  Assert-Eq (Read-Text (Join-Path $Data 'app\previous\VERSION')) '0.1.0' 'previous\VERSION is 0.1.0'
  Assert-Eq (Read-Text (Join-Path $Data 'fake-smoke-ran')) '0.1.1' 'smoke test ran v0.1.1'
  Assert-Eq (Get-FileHash -Algorithm SHA256 -LiteralPath $secrets).Hash $secretsHash 'secrets.json untouched'
  Assert-NoStaging
  Assert-TmpEmpty
  End-Case

  Begin-Case '8d. an older local bundle does not downgrade'
  New-Bundle '0.1.0' $ClosedUrl
  Invoke-Bundle ($Common + '--install-only')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Already up to date (v0.1.1'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.1.1' 'current is still 0.1.1'
  Assert-Eq (Read-Text (Join-Path $Data 'app\previous\VERSION')) '0.1.0' 'previous is still 0.1.0'
  End-Case

  Begin-Case '8e. corrupted local package is rejected, nothing changed'
  New-Bundle '0.1.2' $ClosedUrl -Corrupt
  Remove-Item -LiteralPath (Join-Path $Data 'fake-smoke-ran') -Force -ErrorAction SilentlyContinue
  Invoke-Bundle ($Common + '--smoke-test')
  Assert-Ne $script:Rc 0 'non-zero exit code'
  Assert-Contains $script:Out 'Checksum mismatch'
  Assert-Contains (Read-Text (Join-Path $Data 'logs\install.log')) 'Checksum mismatch' 'install.log has the checksum error'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.1.1' 'current is still 0.1.1'
  Assert-Eq (Read-Text (Join-Path $Data 'app\previous\VERSION')) '0.1.0' 'previous is still 0.1.0'
  Assert-Absent (Join-Path $Data 'fake-smoke-ran')
  Assert-Exists (Join-Path $Bundle (Get-Pkg '0.1.2'))
  Assert-NoStaging
  Assert-TmpEmpty
  End-Case

  Begin-Case '8f. a newer online release wins over the local bundle'
  New-Release '0.2.0'
  New-Bundle '0.1.3' $Url
  Set-Content -LiteralPath $ReqLog -Value '' -NoNewline
  Invoke-Bundle ($Common + '--install-only')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'A newer version v0.2.0 is available online'
  Assert-Contains (Read-Text $ReqLog) "GET /$(Get-Pkg '0.2.0') 200" 'online package was downloaded'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.2.0' 'current\VERSION is 0.2.0'
  Assert-NoStaging
  Assert-TmpEmpty
  End-Case

  Begin-Case '8g. SWARMCAST_RELEASE_URL overrides the local bundle'
  New-Release '0.2.1'
  New-Bundle '0.1.3' $ClosedUrl
  Set-Content -LiteralPath $ReqLog -Value '' -NoNewline
  Invoke-Bundle ($Common + '--install-only') -EnvUrl $Url
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out "Install source: $Url (from SWARMCAST_RELEASE_URL)"
  Assert-NotContains $script:Out 'local bundle'
  Assert-Contains (Read-Text $ReqLog) "GET /$(Get-Pkg '0.2.1') 200" 'package downloaded from the env URL'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.2.1' 'current\VERSION is 0.2.1'
  Assert-TmpEmpty
  End-Case

  Begin-Case '8i. offline bundle: SwarmCast installs, ffmpeg is skipped with a clear note'
  $Data = Join-Path $Work 'offline bundle home'
  New-Bundle '0.3.1' $ClosedUrl -FfmpegBase $ClosedUrl
  Invoke-Bundle ($Common + '--install-only')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Skipping the video converter: the download failed'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.3.1' 'current\VERSION is 0.3.1'
  Assert-Absent (Join-Path $Data 'tools\ffmpeg\ffmpeg.exe')
  Assert-TmpEmpty
  End-Case

  Begin-Case '8h. no bundle, HTTP 404 from the release server, nothing installed: points to the installer zip'
  $Data = Join-Path $Work 'empty home 404'
  Invoke-Installer "$Url/private-repo" ($Common + '--install-only')
  Assert-Ne $script:Rc 0 'non-zero exit code'
  Assert-Contains $script:Out 'answered HTTP 404'
  Assert-Contains $script:Out 'installer zip'
  Assert-NotContains $script:Out 'retrying'
  Assert-Absent (Join-Path $Data 'app\current')
  Assert-TmpEmpty
  End-Case

  # --- 12. pre-releases (the beta channel: X.Y.Z-beta.N, X.Y.Z-rc.N) -----------
  Begin-Case '12a. version order is SemVer: a pre-release is older than its release'
  $src = [IO.File]::ReadAllText($Script)
  $fn = [regex]::Match($src, '(?ms)^function Test-NewerVersion\b.*?^\}').Value
  Invoke-Expression $fn
  foreach ($c in @('0.3.0 0.3.0-beta.1 True', '0.3.0-beta.1 0.3.0 False', '0.3.0-beta.11 0.3.0-beta.2 True', '0.3.0-beta.2 0.3.0-beta.11 False',
      '0.3.0-rc.1 0.3.0-beta.11 True', '0.3.0-beta.1 0.2.9 True', '0.2.9 0.3.0-beta.1 False', '0.3.0 0.3.0 False', '0.3.0-rc.1 0.3.0-rc.1 False',
      '0.10.0 0.9.0 True', '1.0.0-alpha.1 1.0.0-alpha True', '1.0.0-alpha.beta 1.0.0-alpha.1 True', '1.0.0-beta 1.0.0-alpha.beta True',
      'garbage 0.1.0 False', '0.1.0 garbage True')) {
    $a, $b, $want = $c.Split(' ')
    Assert-Eq ([string](Test-NewerVersion $a $b)) $want "Test-NewerVersion $a $b"
  }
  End-Case

  Begin-Case '12b. a beta installer zip installs (0.4.0-beta.2)'
  $Data = Join-Path $Work 'beta home'
  New-Bundle '0.4.0-beta.2' $ClosedUrl
  Invoke-Bundle ($Common + '--install-only')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out "(v0.4.0-beta.2)" 'the bundle is read with its pre-release version'
  Assert-Contains $script:Out 'Installing SwarmCast v0.4.0-beta.2'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.4.0-beta.2' 'current\VERSION is 0.4.0-beta.2'
  Assert-TmpEmpty
  End-Case

  Begin-Case '12c. beta.11 is newer than beta.2; an older beta does not downgrade'
  New-Bundle '0.4.0-beta.11' $ClosedUrl
  Invoke-Bundle ($Common + '--install-only')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Updating SwarmCast v0.4.0-beta.2 -> v0.4.0-beta.11'
  New-Bundle '0.4.0-beta.2' $ClosedUrl
  Invoke-Bundle ($Common + '--install-only')
  Assert-Contains $script:Out 'Already up to date (v0.4.0-beta.11; the local bundle has the older v0.4.0-beta.2'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.4.0-beta.11' 'current is still 0.4.0-beta.11'
  End-Case

  Begin-Case '12d. the latest stable release, older than the installed beta, is never installed over it'
  New-Release '0.3.9'
  Set-Content -LiteralPath $ReqLog -Value '' -NoNewline
  Invoke-Installer $Url ($Common + '--install-only')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Already up to date (v0.4.0-beta.11; the release has the older v0.3.9, so it is not installed)'
  Assert-NotContains (Read-Text $ReqLog) "GET /$(Get-Pkg '0.3.9')" 'the older package is not downloaded'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.4.0-beta.11' 'current is still 0.4.0-beta.11'
  End-Case

  Begin-Case '12e. the stable release of the beta replaces it; online stable wins over an rc bundle'
  New-Release '0.4.0'
  Invoke-Installer $Url ($Common + '--install-only')
  Assert-Eq $script:Rc 0 'exit code 0'
  Assert-Contains $script:Out 'Updating SwarmCast v0.4.0-beta.11 -> v0.4.0'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.4.0' 'current\VERSION is 0.4.0'
  $Data = Join-Path $Work 'rc home'
  New-Bundle '0.4.0-rc.1' $Url
  Invoke-Bundle ($Common + '--install-only')
  Assert-Contains $script:Out 'A newer version v0.4.0 is available online'
  Assert-Eq (Read-Text (Join-Path $Data 'app\current\VERSION')) '0.4.0' 'current\VERSION is 0.4.0'
  Assert-TmpEmpty
  End-Case
  $Data = $savedData

  # --- 7. usage ----------------------------------------------------------------
  Begin-Case '7. --help and unknown options'
  Invoke-Installer $Url @('--help')
  Assert-Eq $script:Rc 0 '--help exits 0'
  Assert-Contains $script:Out '--install-only'
  Assert-Contains $script:Out '-NoFfmpeg'
  Assert-Contains $script:Out '-Ask'
  Invoke-Installer $Url @('--bogus')
  Assert-Eq $script:Rc 2 'unknown option exits 2'
  End-Case
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item Env:SWARMCAST_HOME, Env:SWARMCAST_RELEASE_URL, Env:SWARMCAST_NO_PAUSE, Env:SWARMCAST_DATA_DIR -ErrorAction SilentlyContinue
  if ($env:KEEP_WORK -eq '1') { Write-Host "Work dir kept: $Work" } else { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host '=============================='
Write-Host ("Installer tests (windows-{0}): {1} passed, {2} failed" -f $Arch, $script:Pass, $script:Fail)
if ($script:Fail -gt 0) {
  Write-Host 'Failed:'
  $script:FailedNames | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
exit 0
