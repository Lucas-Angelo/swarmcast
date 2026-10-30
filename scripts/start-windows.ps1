# SwarmCast - install, update and start on Windows 10/11.
#
# Double-click start-windows.cmd, or run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File start-windows.ps1 [options]
#
# Options (PowerShell or GNU spelling): -Ask / --ask, -Yes / --yes, -NoTunnel / --no-tunnel,
# -InstallOnly / --install-only, -SmokeTest / --smoke-test,
# -SkipSpeedtest / --skip-speedtest, -NoFfmpeg / --no-ffmpeg, -Help / --help.
#
# Installer zip (offline install): when this script sits next
# to SHA256SUMS.txt and the matching SwarmCast-v*-windows-x64.zip (as in
# SwarmCast-vX.Y.Z-windows-x64-installer.zip), it installs from those files.
#
# Compatible with Windows PowerShell 5.1. This file is ASCII-only on purpose
# (PowerShell 5.1 reads BOM-less files as ANSI); symbols are built from char codes.

$ScriptArgs = @($args)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar

$SC_DefaultReleaseUrl = 'https://github.com/Lucas-Angelo/swarmcast/releases/latest/download'
$SC_IssuesUrl = 'https://github.com/Lucas-Angelo/swarmcast/issues'
$SC_SpeedDownUrl = 'https://speed.cloudflare.com/__down?bytes=10000000'
$SC_SpeedUpUrl = 'https://speed.cloudflare.com/__up'
$SC_Ports = @(1935, 8080, 8081)
$SC_RetryDelays = @(2, 4, 8)
$SC_MinDiskBytes = 500MB
$SC_MinRamMB = 3500      # "4 GB" machines report a bit less than 4096 MB
$SC_RecRamMB = 7500      # "8 GB"
$SC_MinCores = 2
$SC_RecCores = 4
$SC_MinUpMbps = 10
$SC_RecUpMbps = 50
$SC_ObsHint = 'Now set OBS to stream to rtmp://127.0.0.1:1935/live with the stream key shown in the panel (copy button), keyframe interval 2 s, and start streaming. The live link for your subscribers appears in the panel and here.'

$script:Opt = @{ Ask = $false; Yes = $false; NoTunnel = $false; InstallOnly = $false; SmokeTest = $false; SkipSpeedtest = $false; NoFfmpeg = $false; Help = $false }
$script:LogFile = $null
$script:TmpDir = $null
$script:StagingDir = $null
$script:Below = New-Object System.Collections.Generic.List[string]
# Folder of this script when it runs from a file; $null for "irm ... | iex".
$script:ScriptDir = $null
# Exit-Setup stopped a piped run: its reason is already on screen.
$script:Stopped = $false
if ($PSCommandPath -and ((Split-Path -Leaf $PSCommandPath) -like 'start-windows*.ps1') -and $PSScriptRoot) { $script:ScriptDir = $PSScriptRoot }
$script:Source = 'online'      # where the package comes from: online | local
$script:LocalDir = $null       # folder of a usable local bundle
$script:LocalPackage = $null
$script:OnlineState = ''
$script:FetchHttp = $null      # HTTP status of the last failed checksum list download
$script:SumsFile = $null       # the SHA256SUMS.txt the package came from (binaries.json is checked against it)
$script:Results = New-Object System.Collections.Generic.List[object]   # system-check.json entries
$script:BelowIds = New-Object System.Collections.Generic.List[string]
$script:ViewerEstimate = $null
$script:JustUpdated = $false   # this run replaced an installed version (rollback possible)
$SC_StepDelays = @(2, 5, 10)
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Show-Usage {
  Write-Host @'
SwarmCast setup for Windows: checks your computer, installs or updates SwarmCast
and starts it.

Usage: start-windows.cmd [options]
       powershell -NoProfile -ExecutionPolicy Bypass -File start-windows.ps1 [options]

Options:
  --ask             (-Ask)            Ask before continuing on a computer below the minimum
                                      (by default the setup never asks: it warns and continues)
  --yes             (-Yes)            Answer "yes" to the questions -Ask would ask (kept for
                                      compatibility; nothing is asked by default)
  --no-tunnel       (-NoTunnel)       Start SwarmCast without the public tunnel (local testing)
  --install-only    (-InstallOnly)    Install or update, then exit without starting SwarmCast
  --smoke-test      (-SmokeTest)      Install or update, run "swarmcast --smoke-test", exit with its result
  --skip-speedtest  (-SkipSpeedtest)  Skip the internet speed test
  --no-ffmpeg       (-NoFfmpeg)       Do not download the video converter (ffmpeg) for the extra qualities
  --help            (-Help)           Show this help

Environment:
  SWARMCAST_HOME         Data folder (default: %LOCALAPPDATA%\SwarmCast)
  SWARMCAST_RELEASE_URL  Where releases are downloaded from
                         (default: https://github.com/Lucas-Angelo/swarmcast/releases/latest/download)

Install source, first match wins:
  1. SWARMCAST_RELEASE_URL, when set.
  2. A local bundle: SHA256SUMS.txt and SwarmCast-v*-windows-x64.zip in the same
     folder as this script (the extracted installer zip). The default release
     URL is still checked once for a newer version; if it cannot be reached
     (offline, or an HTTP error), the local bundle is used.
  3. The default release URL.

Video converter: the extra viewer qualities (720p/480p/360p) need ffmpeg. It is
downloaded from its publisher (pins and SHA-256 in the release's binaries.json),
verified and kept in the data folder under tools\ffmpeg. Without it, or offline,
SwarmCast still works with your original quality only.

SwarmCast is installed for your user only; administrator rights are never needed.
'@
}

# ---------------------------------------------------------------------------
# Output and logging
# ---------------------------------------------------------------------------

function Initialize-Console {
  $unicode = $false
  try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    # Windows Terminal, VS Code and redirected output (logs, CI) render these fine;
    # the classic console font on Windows 10 does not, so fall back to ASCII there.
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

function Write-Log([string]$Message) {
  if (-not $script:LogFile) { return }
  try {
    $line = '[{0}] {1}{2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message, "`r`n"
    [System.IO.File]::AppendAllText($script:LogFile, $line, $script:Utf8NoBom)
  } catch {
    # Logging must never break the setup.
  }
}

function Say([string]$Message, [string]$Color) {
  if ($Color) { Write-Host $Message -ForegroundColor $Color } else { Write-Host $Message }
  Write-Log $Message
}
# The log file is UTF-8, so it always gets the real symbols.
$script:LogOk = [string][char]0x2713
$script:LogWarn = [string][char]0x26A0
$script:LogBad = [string][char]0x2717
function Say-Ok([string]$Message) { Write-Host "$($script:SymOk) $Message" -ForegroundColor Green; Write-Log "$($script:LogOk) $Message" }
function Say-Warn([string]$Message) { Write-Host "$($script:SymWarn) $Message" -ForegroundColor Yellow; Write-Log "$($script:LogWarn) $Message" }
function Say-Err([string]$Message) { Write-Host "$($script:SymBad) $Message" -ForegroundColor Red; Write-Log "$($script:LogBad) $Message" }

# Directory renames can fail for a moment right after files were written or run
# (antivirus scanners briefly lock new executables), so retry a few times.
function Move-Dir([string]$From, [string]$To) {
  Invoke-Step "Renaming $(Split-Path -Leaf $From)" { [System.IO.Directory]::Move($From, $To) }
}

# Local steps (unpacking, renaming, writing files, checks) get up to 3 more tries after
# 2 s, 5 s and 10 s, each attempt logged. Bounded: a step that keeps failing throws.
function Invoke-Step([string]$What, [scriptblock]$Action) {
  $attempt = 0
  while ($true) {
    $attempt++
    try {
      return (& $Action)
    } catch {
      if ($attempt -gt $SC_StepDelays.Count) {
        Write-Log "$What failed after $attempt attempts: $($_.Exception.Message)"
        throw
      }
      $delay = $SC_StepDelays[$attempt - 1]
      Write-Log "$What failed (attempt $attempt of 4): $($_.Exception.Message) - retrying in $delay s"
      Write-Host "  $What failed, retrying in $delay s..."
      Start-Sleep -Seconds $delay
    }
  }
}

# Installer tests only: SWARMCAST_TEST_FAIL_ONCE=<step> makes that step fail on its first try.
function Test-FailOnce([string]$Step) {
  if ($env:SWARMCAST_TEST_FAIL_ONCE -ne $Step) { return }
  $flag = Join-Path $script:TmpDir ".fail-once-$Step"
  if (Test-Path -LiteralPath $flag) { return }
  [IO.File]::WriteAllText($flag, '')
  Write-Log "test hook: failing step '$Step' once"
  throw "test hook: $Step fails once"
}
function Say-Heading([string]$Message) { Write-Host ''; Write-Host $Message -ForegroundColor Cyan; Write-Log "== $Message ==" }

function Invoke-Cleanup {
  if ($script:StagingDir -and (Test-Path -LiteralPath $script:StagingDir)) {
    try { Remove-Item -LiteralPath $script:StagingDir -Recurse -Force } catch { Write-Log "Could not remove $($script:StagingDir): $($_.Exception.Message)" }
  }
  $script:StagingDir = $null
  if ($script:TmpDir -and (Test-Path -LiteralPath $script:TmpDir)) {
    try { Remove-Item -LiteralPath $script:TmpDir -Recurse -Force } catch { Write-Log "Could not remove $($script:TmpDir): $($_.Exception.Message)" }
  }
  $script:TmpDir = $null
}

# In "irm ... | iex" mode there is no script file and `exit` would close the user's own
# PowerShell window (hiding the message). Stop the script with an error instead; the catch
# at the end of this file knows it by $script:Stopped and adds nothing, so the window stays
# open with the reason as the last thing in it. With code 0 a piped run returns from here:
# callers return right after it.
function Exit-Setup([int]$Code) {
  if ($script:ScriptDir) { exit $Code }
  $global:LASTEXITCODE = $Code
  if ($Code -eq 0) { return }
  $script:Stopped = $true
  throw "SwarmCast setup stopped (code $Code). See the message above."
}

function Stop-Setup([string]$Message, [int]$Code = 1) {
  Say-Err $Message
  if ($script:LogFile) { Write-Host "Setup log: $($script:LogFile)" }
  Write-Log "Exiting with code $Code"
  Invoke-Cleanup
  Exit-Setup $Code
}

function Confirm-Step([string]$Question, [bool]$DefaultYes) {
  if ($DefaultYes) { $hint = '(Y/n)' } else { $hint = '(y/N)' }
  if ($script:Opt.Yes) {
    Say "$Question $hint yes (--yes)"
    return $true
  }
  if ([Console]::IsInputRedirected) {
    Say "$Question $hint -> no console to ask, assuming the default. Use --yes to answer yes automatically."
    return $DefaultYes
  }
  $answer = Read-Host "$Question $hint"
  Write-Log "$Question $hint answer: $answer"
  if ($answer -match '^(y|yes)$') { return $true }
  if ($answer -match '^(n|no)$') { return $false }
  return $DefaultYes
}

# Runs $Action up to 4 times (first try + 3 retries after 2 s, 4 s and 8 s).
function Invoke-Retry([string]$What, [scriptblock]$Action) {
  $attempt = 0
  while ($true) {
    $attempt++
    try {
      return (& $Action)
    } catch {
      $msg = $_.Exception.Message
      $status = Get-HttpStatus $_
      if ($status -eq 401 -or $status -eq 403 -or $status -eq 404) {
        Write-Log "$What failed: HTTP $status (not retried)"
        throw
      }
      if ($attempt -gt $SC_RetryDelays.Count) {
        Write-Log "$What failed after $attempt attempts: $msg"
        throw
      }
      $delay = $SC_RetryDelays[$attempt - 1]
      Write-Log "$What failed (attempt $attempt): $msg - retrying in $delay s"
      Write-Host "  $What failed, retrying in $delay s..."
      Start-Sleep -Seconds $delay
    }
  }
}

# HTTP status code of a failed web request, or $null when there was no HTTP answer.
function Get-HttpStatus($ErrorRecord) {
  try {
    $resp = $ErrorRecord.Exception.Response
    if ($null -ne $resp) { return [int]$resp.StatusCode }
  } catch { }
  return $null
}

function Save-Url([string]$Url, [string]$OutFile, [int]$TimeoutSec = 60) {
  if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec $TimeoutSec -UserAgent 'SwarmCast-Setup'
}

function Format-Size([double]$Bytes) {
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  if ($Bytes -ge 1GB) { return [string]::Format($inv, '{0:N1} GB', ($Bytes / 1GB)) }
  return [string]::Format($inv, '{0:N0} MB', ($Bytes / 1MB))
}

# Runs a program with a timeout and returns @{ Code; Out; TimedOut }.
function Invoke-Captured([string]$Exe, [string]$Arguments, [int]$TimeoutSec) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = $Arguments
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
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
# Setup steps
# ---------------------------------------------------------------------------

function Read-Options {
  foreach ($raw in $ScriptArgs) {
    $a = ([string]$raw).Trim()
    $key = $a.ToLowerInvariant().TrimStart('-', '/').Replace('-', '').Replace('_', '')
    switch ($key) {
      'yes' { $script:Opt.Yes = $true }
      'ask' { $script:Opt.Ask = $true }
      'y' { $script:Opt.Yes = $true }
      'notunnel' { $script:Opt.NoTunnel = $true }
      'installonly' { $script:Opt.InstallOnly = $true }
      'smoketest' { $script:Opt.SmokeTest = $true }
      'skipspeedtest' { $script:Opt.SkipSpeedtest = $true }
      'noffmpeg' { $script:Opt.NoFfmpeg = $true }
      'help' { $script:Opt.Help = $true }
      'h' { $script:Opt.Help = $true }
      '?' { $script:Opt.Help = $true }
      default {
        Write-Host "Unknown option: $a"
        Write-Host ''
        Show-Usage
        Exit-Setup 2
      }
    }
  }
}

function Initialize-Paths {
  if ($env:SWARMCAST_HOME) {
    $script:DataDir = [System.IO.Path]::GetFullPath($env:SWARMCAST_HOME)
    $env:SWARMCAST_DATA_DIR = $script:DataDir
  } else {
    $local = $env:LOCALAPPDATA
    if (-not $local) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
    $script:DataDir = Join-Path $local 'SwarmCast'
  }
  $url = $env:SWARMCAST_RELEASE_URL
  if (-not $url) { $url = $SC_DefaultReleaseUrl }
  $script:ReleaseUrl = $url.TrimEnd('/')
  $script:AppDir = Join-Path $script:DataDir 'app'
  $script:CurrentDir = Join-Path $script:AppDir 'current'
  $script:PreviousDir = Join-Path $script:AppDir 'previous'
  $script:CurrentExe = Join-Path $script:CurrentDir 'swarmcast.exe'

  try {
    [void](New-Item -ItemType Directory -Force -Path (Join-Path $script:DataDir 'logs'))
    [void](New-Item -ItemType Directory -Force -Path $script:AppDir)
  } catch {
    Stop-Setup "Could not create the SwarmCast folder: $($script:DataDir)`n  Check that you have write access to it (or set SWARMCAST_HOME to another folder)."
  }
  $script:LogFile = Join-Path (Join-Path $script:DataDir 'logs') 'install.log'
  try {
    [System.IO.File]::AppendAllText($script:LogFile, '', $script:Utf8NoBom)
  } catch {
    $script:LogFile = $null
    Stop-Setup "Cannot write the setup log in $($script:DataDir)\logs. Check the folder permissions."
  }

  $script:TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('swarmcast-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    [void](New-Item -ItemType Directory -Force -Path $script:TmpDir)
  } catch {
    Stop-Setup "Could not create a temporary folder in $([System.IO.Path]::GetTempPath())."
  }
}

function Initialize-Network {
  try {
    $proto = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ([enum]::GetNames([Net.SecurityProtocolType]) -contains 'Tls13') {
      $proto = $proto -bor [Net.SecurityProtocolType]::Tls13
    }
    [Net.ServicePointManager]::SecurityProtocol = $proto
  } catch {
    Write-Log "Could not enable TLS 1.2/1.3: $($_.Exception.Message)"
  }
}

function Test-Elevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

# Repairs what an interrupted earlier run may have left behind.
function Repair-PreviousRun {
  Get-ChildItem -LiteralPath $script:AppDir -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '.staging-*' } |
    ForEach-Object {
      Write-Log "Removing leftover staging folder $($_.FullName)"
      try { Remove-Item -LiteralPath $_.FullName -Recurse -Force } catch { Write-Log "Could not remove it: $($_.Exception.Message)" }
    }
  if (-not (Test-Path -LiteralPath $script:CurrentDir) -and (Test-Path -LiteralPath $script:PreviousDir)) {
    Say-Warn 'An earlier update was interrupted; restoring the previous version.'
    try {
      Move-Dir $script:PreviousDir $script:CurrentDir
    } catch {
      Stop-Setup "Could not restore $($script:PreviousDir). Delete $($script:AppDir) and run this again."
    }
  }
}

function Get-OsInfo {
  $info = @{ Status = 'ok'; Desc = 'Windows'; Note = '' }
  $ver = [Environment]::OSVersion.Version
  $caption = $null
  $productType = 1
  try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $caption = $os.Caption
    $productType = [int]$os.ProductType
  } catch {
    Write-Log "Win32_OperatingSystem query failed: $($_.Exception.Message)"
  }
  if (-not $caption) { $caption = "Windows $($ver.Major).$($ver.Minor)" }
  $info.Desc = "$($caption.Trim()) (build $($ver.Build))"
  if ($ver.Major -lt 10) {
    $info.Status = 'bad'
    $info.Note = 'Windows 10 or 11 is required'
    $script:Below.Add("$caption (Windows 10 or 11 is required)")
    $script:BelowIds.Add('os')
  } elseif ($productType -ne 1) {
    $info.Status = 'warn'
    $info.Note = 'Windows Server is not a tested edition (tested: Windows 10/11); it will probably work'
  }
  return $info
}

function Get-Arch {
  $a = $env:PROCESSOR_ARCHITEW6432
  if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
  switch ($a) {
    'AMD64' { return @{ Arch = 'x64'; Label = 'x64'; Note = '' } }
    'ARM64' { return @{ Arch = 'x64'; Label = 'arm64'; Note = 'Windows on ARM: using the x64 build (runs through Windows emulation)' } }
    default { Stop-Setup "Unsupported processor architecture: $a. SwarmCast needs 64-bit Windows (x64, or ARM64 through emulation)." }
  }
}

function Get-RamMB {
  try {
    return [int]((Get-CimInstance -ClassName Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
  } catch {
    try { return [int]((Get-WmiObject -Class Win32_ComputerSystem).TotalPhysicalMemory / 1MB) } catch { return 0 }
  }
}

function Get-FreeDiskBytes {
  try {
    $root = [System.IO.Path]::GetPathRoot($script:DataDir)
    return [double](New-Object System.IO.DriveInfo $root).AvailableFreeSpace
  } catch {
    return [double]0
  }
}

function Get-BusyPorts {
  $result = @()
  $listeners = @()
  try {
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  } catch {
    Write-Log "Could not list TCP listeners: $($_.Exception.Message)"
  }
  foreach ($port in $SC_Ports) {
    $busy = @($listeners | Where-Object { $_.Port -eq $port }).Count -gt 0
    if (-not $busy) { continue }
    $owner = 'another program'
    try {
      $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
      $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
      $owner = "$($proc.ProcessName) (PID $($proc.Id))"
    } catch {
      Write-Log "Could not find the program using port $($port): $($_.Exception.Message)"
    }
    $result += , @($port, $owner)
  }
  return , $result
}

function Find-Obs {
  $keys = @(
    'HKLM:\SOFTWARE\OBS Studio',
    'HKLM:\SOFTWARE\WOW6432Node\OBS Studio',
    'HKCU:\SOFTWARE\OBS Studio',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\OBS Studio',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\OBS Studio'
  )
  foreach ($k in $keys) {
    try {
      if (Test-Path -LiteralPath $k) { return $k }
    } catch { }
  }
  $dirs = @()
  if ($env:ProgramFiles) { $dirs += (Join-Path $env:ProgramFiles 'obs-studio') }
  if (${env:ProgramFiles(x86)}) { $dirs += (Join-Path ${env:ProgramFiles(x86)} 'obs-studio') }
  foreach ($d in $dirs) {
    if (Test-Path -LiteralPath (Join-Path $d 'bin\64bit\obs64.exe')) { return $d }
  }
  return $null
}

# -Once: a single attempt (installing from a local bundle does not need github.com).
function Test-GitHub([switch]$Once) {
  $probe = {
    try {
      [void](Invoke-WebRequest -Uri 'https://github.com' -Method Head -UseBasicParsing -TimeoutSec 20 -UserAgent 'SwarmCast-Setup')
    } catch [System.Net.WebException] {
      # Any HTTP answer (even an error status) means github.com is reachable.
      if ($null -eq $_.Exception.Response) { throw }
    }
  }
  try {
    if ($Once) { & $probe } else { Invoke-Retry 'Connecting to github.com' $probe }
    return $true
  } catch {
    return $false
  }
}

# True when version A is newer than version B, by SemVer 2.0.0 precedence:
# 0.3.0-beta.2 < 0.3.0-beta.11 < 0.3.0-rc.1 < 0.3.0 (a pre-release is older than its release).
# [version] cannot read a pre-release ("0.3.0-beta.1"). Unreadable versions are never newer.
function Test-NewerVersion([string]$A, [string]$B) {
  $re = '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$'
  if ($A.Trim() -notmatch $re) { return $false }
  $x = @([long]$Matches[1], [long]$Matches[2], [long]$Matches[3]); $p = @(); if ($Matches[4]) { $p = @($Matches[4].Split('.')) }
  if ($B.Trim() -notmatch $re) { return $true }
  $y = @([long]$Matches[1], [long]$Matches[2], [long]$Matches[3]); $q = @(); if ($Matches[4]) { $q = @($Matches[4].Split('.')) }
  for ($i = 0; $i -lt 3; $i++) {
    if ($x[$i] -ne $y[$i]) { return ($x[$i] -gt $y[$i]) }
  }
  if ($p.Count -eq 0 -or $q.Count -eq 0) { return ($p.Count -eq 0 -and $q.Count -gt 0) }
  for ($i = 0; $i -lt [Math]::Max($p.Count, $q.Count); $i++) {
    if ($i -ge $p.Count) { return $false }
    if ($i -ge $q.Count) { return $true }
    $s = $p[$i]; $t = $q[$i]
    if ($s -ceq $t) { continue }
    $an = $s -match '^\d+$'; $bn = $t -match '^\d+$'
    if ($an -and $bn) { return ([long]$s -gt [long]$t) }
    if ($an -or $bn) { return $bn }
    return ([string]::CompareOrdinal($s, $t) -gt 0)
  }
  return $false
}

# Finds this platform's package in a GNU-format SHA256SUMS file: X.Y.Z, or a pre-release
# X.Y.Z-beta.N / X.Y.Z-rc.N (the beta versions).
function Find-Package([string]$SumsFile, [string]$Arch) {
  $re = '^SwarmCast-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-windows-' + [regex]::Escape($Arch) + '\.zip$'
  foreach ($line in [System.IO.File]::ReadAllLines($SumsFile)) {
    $l = $line.Trim()
    if ($l -notmatch '^([0-9a-fA-F]{64}) [ *]?(.+)$') { continue }
    $hash = $Matches[1].ToLowerInvariant()
    $name = $Matches[2].Trim()
    if ($name -match $re) {
      Write-Log "Latest release: $name ($hash)"
      return @{ Name = $name; Sha = $hash; Version = $Matches[1] }
    }
  }
  Write-Log "No package for windows-$Arch in SHA256SUMS.txt"
  return $null
}

# A local bundle is SHA256SUMS.txt plus this platform's package next to the
# script (the extracted installer zip).
function Find-LocalBundle {
  if (-not $script:ScriptDir) { return $null }
  $sums = Join-Path $script:ScriptDir 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $sums -PathType Leaf)) { return $null }
  $pkg = Find-Package $sums $script:ArchInfo.Arch
  if (-not $pkg) {
    Say "Note: $sums lists no SwarmCast package for windows-$($script:ArchInfo.Arch); ignoring the local files."
    return $null
  }
  if (-not (Test-Path -LiteralPath (Join-Path $script:ScriptDir $pkg.Name) -PathType Leaf)) {
    Say "Note: $($pkg.Name) (listed in SHA256SUMS.txt) is not next to this script; ignoring the local files."
    return $null
  }
  return $pkg
}

function Test-Release {
  $script:ReleaseOk = $false
  $script:Package = $null
  $script:FetchHttp = $null
  $sums = Join-Path $script:TmpDir 'SHA256SUMS.txt'

  if (-not $env:SWARMCAST_RELEASE_URL) {
    $local = Find-LocalBundle
    if ($local) {
      $script:Source = 'local'
      $script:LocalDir = $script:ScriptDir
      $script:LocalPackage = $local
      $script:Package = $local
      $script:ReleaseOk = $true
      $script:SumsFile = Join-Path $script:LocalDir 'SHA256SUMS.txt'
      Say "Install source: local bundle in $($script:LocalDir) (v$($local.Version))"
      # With a local bundle, look once (no retries) for a newer online release. Not
      # reaching it (offline, or an HTTP 404/401 answer) is fine.
      $script:OnlineState = 'unreachable'
      $online = Join-Path $script:TmpDir 'online-SHA256SUMS.txt'
      try {
        Save-Url "$SC_DefaultReleaseUrl/SHA256SUMS.txt" $online 30
        $script:OnlineState = 'same'
        $remote = Find-Package $online $script:ArchInfo.Arch
        if ($remote -and (Test-NewerVersion $remote.Version $local.Version)) {
          $script:OnlineState = 'newer'
          $script:Source = 'online'
          $script:ReleaseUrl = $SC_DefaultReleaseUrl.TrimEnd('/')
          $script:Package = $remote
          $script:SumsFile = $online
          Say "A newer version v$($remote.Version) is available online ($($script:ReleaseUrl)); using it instead of the local bundle v$($local.Version)."
        }
      } catch {
        $status = Get-HttpStatus $_
        if ($status) { Write-Log "Online release check: HTTP $status; using the local bundle" }
        else { Write-Log "Online release check failed: $($_.Exception.Message); using the local bundle" }
      }
      return
    }
  }

  $script:Source = 'online'
  if ($env:SWARMCAST_RELEASE_URL) { Say "Install source: $($script:ReleaseUrl) (from SWARMCAST_RELEASE_URL)" } else { Say "Install source: $($script:ReleaseUrl)" }
  try {
    Invoke-Retry 'Downloading the release checksum list' { Save-Url "$($script:ReleaseUrl)/SHA256SUMS.txt" $sums 30 }
    $script:ReleaseOk = $true
    $script:SumsFile = $sums
    $script:Package = Find-Package $sums $script:ArchInfo.Arch
  } catch {
    $script:FetchHttp = Get-HttpStatus $_
    Write-Log "Release server unreachable: $($_.Exception.Message)"
  }
}

function Measure-Speed {
  $script:DownMbps = $null
  $script:UpMbps = $null
  if ($script:Opt.SkipSpeedtest) {
    Say 'Speed test skipped (--skip-speedtest).'
    return
  }
  Say-Heading 'Measuring your internet speed'
  Say 'Downloading ~10 MB and uploading ~3 MB to speed.cloudflare.com...'
  try {
    Add-Type -AssemblyName System.Net.Http
  } catch {
    Say-Warn "Speed test unavailable: $($_.Exception.Message)"
    return
  }
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromSeconds(60)
  [void]$client.DefaultRequestHeaders.UserAgent.TryParseAdd('SwarmCast-Setup')
  try {
    try {
      $script:DownMbps = Invoke-Retry 'Download speed test' {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $bytes = $client.GetByteArrayAsync($SC_SpeedDownUrl).GetAwaiter().GetResult()
        $sw.Stop()
        [math]::Round(($bytes.Length * 8 / 1e6) / [math]::Max($sw.Elapsed.TotalSeconds, 0.001), 1)
      }
    } catch {
      Write-Log "Download speed test failed: $($_.Exception.Message)"
    }
    try {
      $data = New-Object byte[] 3000000
      $script:UpMbps = Invoke-Retry 'Upload speed test' {
        $content = New-Object System.Net.Http.ByteArrayContent -ArgumentList (, $data)
        $content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue 'application/octet-stream'
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $resp = $client.PostAsync($SC_SpeedUpUrl, $content).GetAwaiter().GetResult()
        $sw.Stop()
        [void]$resp.EnsureSuccessStatusCode()
        [math]::Round(($data.Length * 8 / 1e6) / [math]::Max($sw.Elapsed.TotalSeconds, 0.001), 1)
      }
    } catch {
      Write-Log "Upload speed test failed: $($_.Exception.Message)"
    }
  } finally {
    $client.Dispose()
  }
}

function Get-Level([double]$Value, [double]$Min, [double]$Rec) {
  if ($Value -ge $Rec) { return 'ok' }
  if ($Value -ge $Min) { return 'warn' }
  return 'bad'
}

# Id (optional): also saved to system-check.json.
function Write-Row([string]$Status, [string]$Label, [string]$Value, [string]$Min, [string]$Rec, [string]$Id = '', [string]$Detail = '') {
  if ($Id) { Add-CheckResult $Id $Status $Value $Min $Rec $Detail }
  switch ($Status) {
    'ok' { $sym = $script:SymOk; $color = 'Green' }
    'warn' { $sym = $script:SymWarn; $color = 'Yellow' }
    default { $sym = $script:SymBad; $color = 'Red' }
  }
  $text = ('{0,-20} {1,-28} {2,-10} {3}' -f $Label, $Value, $Min, $Rec).TrimEnd()
  Write-Host '  ' -NoNewline
  Write-Host $sym -ForegroundColor $color -NoNewline
  Write-Host " $text"
  Write-Log "$Status $text"
}

function Add-CheckResult([string]$Id, [string]$Status, [string]$Value, [string]$Min, [string]$Rec, [string]$Detail = '') {
  $st = $Status
  if ($st -eq 'bad') { $st = 'fail' }
  if ($Value -like '*skipped*') { $st = 'skipped' }
  $script:Results.Add([ordered]@{ id = $Id; status = $st; value = $Value; min = $Min; recommended = $Rec; detail = $Detail })
}

function ConvertTo-JsonString([string]$Text) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  foreach ($c in $Text.ToCharArray()) {
    $code = [int]$c
    if ($c -eq '"') { [void]$sb.Append('\"') }
    elseif ($c -eq '\') { [void]$sb.Append('\\') }
    elseif ($code -lt 32 -or $code -gt 126) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
    else { [void]$sb.Append($c) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function ConvertTo-JsonNumber($Value) {
  if ($null -eq $Value) { return 'null' }
  return ([double]$Value).ToString([System.Globalization.CultureInfo]::InvariantCulture)
}

# <data>\system-check.json: the report, for the panel's first-run tutorial (English values;
# the panel translates by id and status). Written atomically (temp file + rename).
function Save-SystemCheck {
  $items = @($script:Results | ForEach-Object {
      $r = $_
      '    {' + ((@('id', 'status', 'value', 'min', 'recommended', 'detail') | ForEach-Object { (ConvertTo-JsonString $_) + ': ' + (ConvertTo-JsonString ([string]$r[$_])) }) -join ', ') + '}'
    })
  $below = (@($script:BelowIds | ForEach-Object { ConvertTo-JsonString $_ }) -join ', ')
  $json = "{`n  `"version`": 1,`n  `"at`": $(ConvertTo-JsonString ((Get-Date).ToUniversalTime().ToString('o')))," +
    "`n  `"os`": $(ConvertTo-JsonString $script:OsInfo.Desc),`n  `"arch`": $(ConvertTo-JsonString $script:ArchInfo.Arch)," +
    "`n  `"results`": [`n$($items -join ",`n")`n  ]," +
    "`n  `"uploadMbps`": $(ConvertTo-JsonNumber $script:UpMbps),`n  `"downloadMbps`": $(ConvertTo-JsonNumber $script:DownMbps)," +
    "`n  `"viewerEstimate`": $(ConvertTo-JsonNumber $script:ViewerEstimate),`n  `"belowMinimum`": [$below]`n}`n"
  $file = Join-Path $script:DataDir 'system-check.json'
  $tmp = "$file.tmp"
  try {
    Invoke-Step 'Saving the system check' {
      [System.IO.File]::WriteAllText($tmp, $json, $script:Utf8NoBom)
      if (Test-Path -LiteralPath $file) { [System.IO.File]::Replace($tmp, $file, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $file) }
    }
  } catch {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Say-Warn "Could not save $file (the panel will not show this report)."
  }
}

function Show-Report {
  Say-Heading 'Report'
  $header = ('    {0,-20} {1,-28} {2,-10} {3}' -f 'Check', 'This computer', 'Minimum', 'Recommended')
  Say $header

  Write-Row $script:OsInfo.Status 'Operating system' "$($script:OsInfo.Desc)" 'Windows 10' '' 'os' $script:OsInfo.Note
  if ($script:OsInfo.Note) { Say "      $($script:OsInfo.Note)" }
  Say "      Processor: $($script:ArchInfo.Label)"
  if ($script:ArchInfo.Note) { Say "      $($script:ArchInfo.Note)" }

  $ramGB = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0:N1} GB', ($script:RamMB / 1024))
  $st = Get-Level $script:RamMB $SC_MinRamMB $SC_RecRamMB
  Write-Row $st 'Memory (RAM)' $ramGB '4 GB' '8 GB' 'ram'
  if ($st -eq 'bad') { $script:Below.Add("memory $ramGB (minimum 4 GB)"); $script:BelowIds.Add('ram') }

  $st = Get-Level $script:Cores $SC_MinCores $SC_RecCores
  Write-Row $st 'CPU cores' "$($script:Cores)" '2' '4' 'cpu'
  if ($st -eq 'bad') { $script:Below.Add("$($script:Cores) CPU cores (minimum 2)"); $script:BelowIds.Add('cpu') }

  if ($null -ne $script:UpMbps) {
    $st = Get-Level $script:UpMbps $SC_MinUpMbps $SC_RecUpMbps
    Write-Row $st 'Upload speed' "$($script:UpMbps) Mbps" '10 Mbps' '50 Mbps' 'upload'
    if ($st -eq 'bad') { $script:Below.Add("upload speed $($script:UpMbps) Mbps (minimum 10 Mbps)"); $script:BelowIds.Add('upload') }
  } elseif ($script:Opt.SkipSpeedtest) {
    Write-Row 'warn' 'Upload speed' 'not measured (skipped)' '10 Mbps' '50 Mbps' 'upload'
  } else {
    Write-Row 'warn' 'Upload speed' 'speed test failed' '10 Mbps' '50 Mbps' 'upload'
  }
  if ($null -ne $script:DownMbps) {
    Write-Row 'ok' 'Download speed' "$($script:DownMbps) Mbps" '-' '-' 'download'
  } elseif ($script:Opt.SkipSpeedtest) {
    Add-CheckResult 'download' 'skipped' 'not measured (skipped)' '' ''
  } else {
    Add-CheckResult 'download' 'warn' 'speed test failed' '' ''
  }

  $disk = Format-Size $script:FreeDisk
  if ($script:FreeDisk -ge $SC_MinDiskBytes) { $st = 'ok' } else { $st = 'bad'; $script:Below.Add("free disk space $disk (minimum 500 MB)"); $script:BelowIds.Add('disk') }
  Write-Row $st 'Free disk space' $disk '500 MB' '' 'disk'

  if ($script:BusyPorts.Count -eq 0) {
    Write-Row 'ok' 'Ports 1935/8080/8081' 'free' '' '' 'ports'
  } else {
    $list = ($script:BusyPorts | ForEach-Object { $_[0] }) -join ' '
    Write-Row 'warn' 'Ports 1935/8080/8081' "in use: $list" '' '' 'ports' (($script:BusyPorts | ForEach-Object { "port $($_[0]) is used by $($_[1])" }) -join '; ')
    foreach ($b in $script:BusyPorts) { Say "      port $($b[0]) is used by $($b[1])" }
    Say '      Maybe SwarmCast is already running? Otherwise close the program using the port.'
  }

  if ($script:ObsPath) {
    Write-Row 'ok' 'OBS Studio' 'installed' '' '' 'obs'
  } else {
    Write-Row 'warn' 'OBS Studio' 'not found' '' '' 'obs' 'Install OBS Studio from https://obsproject.com to stream.'
    Say '      Install OBS Studio from https://obsproject.com to stream.'
  }

  if ($script:LocalDir) {
    # Installing from the local bundle: being offline is fine.
    if ($script:GitHubOk) { Write-Row 'ok' 'github.com' 'reachable' '' '' 'github' } else { Write-Row 'warn' 'github.com' 'unreachable (not needed)' '' '' 'github' }
    Write-Row 'ok' 'Local bundle' "v$($script:LocalPackage.Version) (next to this script)" '' '' 'release'
    switch ($script:OnlineState) {
      'newer' { Write-Row 'ok' 'Online release' "newer v$($script:Package.Version) available" '' '' }
      'same' { Write-Row 'ok' 'Online release' 'nothing newer' '' '' }
      default { Write-Row 'ok' 'Online release' 'not reachable (fine)' '' '' }
    }
  } else {
    if ($script:GitHubOk) { Write-Row 'ok' 'github.com' 'reachable' '' '' 'github' } else { Write-Row 'bad' 'github.com' 'unreachable' '' '' 'github' }
    if ($script:ReleaseOk -and $script:Package) {
      Write-Row 'ok' 'Release server' "reachable (latest v$($script:Package.Version))" '' '' 'release'
    } elseif ($script:ReleaseOk) {
      Write-Row 'bad' 'Release server' "no package for windows-$($script:ArchInfo.Arch)" '' '' 'release'
    } elseif ($script:FetchHttp) {
      Write-Row 'bad' 'Release server' "HTTP $($script:FetchHttp)" '' '' 'release'
    } else {
      Write-Row 'bad' 'Release server' 'unreachable' '' '' 'release'
    }
  }

  if ($null -ne $script:UpMbps) {
    $viewers = [math]::Floor([math]::Max([double]0, [double]$script:UpMbps * 0.75 - 6) / (6 * 1.15))
    $script:ViewerEstimate = $viewers
    Say ''
    Say "Estimated viewers served directly from this computer: $viewers"
    Say '(Assumes a 6 Mbps stream that is also sent to another platform at the same time.)'
  }

  # Test hook (installer tests only): pretend one check is below the minimum.
  if ($env:SWARMCAST_TEST_BELOW) { $script:Below.Add($env:SWARMCAST_TEST_BELOW); $script:BelowIds.Add('ram') }
  Save-SystemCheck
  if ($script:Below.Count -gt 0) {
    Say ''
    $what = $script:Below -join '; '
    if ($script:Opt.Ask) {
      if (-not (Confirm-Step "Your computer/internet is below the recommended minimum: $what. Continue anyway?" $false)) {
        Stop-Setup 'Setup cancelled.'
      }
    } else {
      Say-Warn "Your computer/internet is below the recommended minimum: $what."
      Say-Warn 'Continuing anyway: SwarmCast may stutter or serve fewer viewers on this computer. (Run with -Ask to be asked first.)'
    }
  }
}

function Get-InstalledVersion {
  $vf = Join-Path $script:CurrentDir 'VERSION'
  if ((Test-Path -LiteralPath $vf) -and (Test-Path -LiteralPath $script:CurrentExe)) {
    return ([System.IO.File]::ReadAllText($vf)).Trim()
  }
  return ''
}

function Install-OrUpdate {
  Say-Heading 'Installing / updating SwarmCast'
  $installed = Get-InstalledVersion

  if (-not $script:ReleaseOk) {
    $why = 'offline, or the release server is unreachable'
    if ($script:FetchHttp) { $why = "the release server answered HTTP $($script:FetchHttp)" }
    if ($installed) {
      Say-Warn "Could not check for updates ($why`: $($script:ReleaseUrl))."
      Say-Warn "Starting the installed version v$installed."
      return
    }
    if ($script:FetchHttp) {
      Stop-Setup "Could not download SwarmCast: the release server answered HTTP $($script:FetchHttp).`n  ($($script:ReleaseUrl)/SHA256SUMS.txt)`n  If you have the SwarmCast installer zip, extract it (right-click -> Extract All)`n  and double-click start-windows.cmd in the extracted folder.`n  Or get the SwarmCast app: https://lucas-angelo.github.io/swarmcast/"
    }
    Stop-Setup "Could not download SwarmCast: the release server is unreachable.`n  ($($script:ReleaseUrl)/SHA256SUMS.txt)`n  Check your internet connection (and any firewall, proxy or VPN), then run this again.`n  If you received the SwarmCast installer zip, extract it (right-click -> Extract All)`n  and double-click start-windows.cmd in the extracted folder."
  }
  if (-not $script:Package) {
    if ($installed) {
      Say-Warn "The latest release has no package for windows-$($script:ArchInfo.Arch). Starting the installed version v$installed."
      return
    }
    Stop-Setup "The latest release has no SwarmCast package for your system (windows-$($script:ArchInfo.Arch)).`n  See $SC_IssuesUrl"
  }
  if ($installed -eq $script:Package.Version) {
    Say-Ok "Already up to date (v$installed)"
    return
  }
  # Never a downgrade (settings are migrated one way only): a beta stays until a newer version.
  if ($installed -and (Test-NewerVersion $installed $script:Package.Version)) {
    if ($script:Source -eq 'local') {
      Say-Ok "Already up to date (v$installed; the local bundle has the older v$($script:Package.Version), so it is not used)"
    } else {
      Say-Ok "Already up to date (v$installed; the release has the older v$($script:Package.Version), so it is not installed)"
    }
    return
  }
  if ($installed) {
    Say "Updating SwarmCast v$installed -> v$($script:Package.Version)"
  } else {
    Say "Installing SwarmCast v$($script:Package.Version)"
  }
  Install-Package $installed
}

function Install-Package([string]$Installed) {
  $pkg = $script:Package
  if ($Installed) { $kept = "Your installed version v$Installed was not changed." } else { $kept = 'Nothing was installed.' }
  $isLocal = ($script:Source -eq 'local')

  if ($isLocal) {
    $zip = Join-Path $script:LocalDir $pkg.Name
    Say "Using $($pkg.Name) from the local bundle (no download)."
  } else {
    $zip = Join-Path $script:TmpDir $pkg.Name
    Say "Downloading $($pkg.Name)..."
    try {
      Invoke-Retry 'Download' { Save-Url "$($script:ReleaseUrl)/$($pkg.Name)" $zip 60 }
    } catch {
      if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
      Stop-Setup "Could not download $($script:ReleaseUrl)/$($pkg.Name).`n  $($_.Exception.Message)`n  Check your internet connection and run this again. $kept"
    }
  }

  Say 'Verifying the SHA-256 checksum...'
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
  if ($actual -ne $pkg.Sha) {
    if ($isLocal) {
      # Never delete the user's own files: just refuse to use them.
      Stop-Setup "Checksum mismatch for $($pkg.Name) in $($script:LocalDir): the file is corrupted or was tampered with.`n  expected: $($pkg.Sha) (from SHA256SUMS.txt)`n  got:      $actual`n  $kept`n  Get a fresh copy of the installer zip, extract it again and run the script from there."
    }
    Remove-Item -LiteralPath $zip -Force
    Stop-Setup "Checksum mismatch for $($pkg.Name): the download is corrupted or was tampered with.`n  expected: $($pkg.Sha)`n  got:      $actual`n  The download was deleted. $kept`n  Try again later; if it keeps happening, report it at $SC_IssuesUrl"
  }
  Say-Ok 'Checksum OK'
  if ($isLocal) {
    # Verified: drop the "downloaded from the internet" mark the browser put on it.
    try { Unblock-File -LiteralPath $zip } catch { Write-Log "Unblock-File: $($_.Exception.Message)" }
  }

  $script:StagingDir = Join-Path $script:AppDir ('.staging-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Invoke-Step "Unpacking $($pkg.Name)" {
      if (Test-Path -LiteralPath $script:StagingDir) { Remove-Item -LiteralPath $script:StagingDir -Recurse -Force }
      [void](New-Item -ItemType Directory -Path $script:StagingDir)
      Test-FailOnce 'extract'
      [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $script:StagingDir)
    }
  } catch {
    Stop-Setup "Could not unpack $($pkg.Name), even after several tries: $($_.Exception.Message)`n  Check that the disk is not full and that no antivirus is blocking the folder, then run this again. $kept"
  }
  if (-not $isLocal) { Remove-Item -LiteralPath $zip -Force }

  foreach ($f in @('swarmcast.exe', 'VERSION', 'bin\mediamtx.exe', 'bin\cloudflared.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $script:StagingDir $f))) {
      Stop-Setup "The downloaded package is incomplete ($f is missing). $kept`n  Report it at $SC_IssuesUrl"
    }
  }
  # The files come from the checksum-verified archive: drop any "downloaded from the internet" mark.
  try { Get-ChildItem -LiteralPath $script:StagingDir -Recurse -File | Unblock-File } catch { Write-Log "Unblock-File: $($_.Exception.Message)" }

  $fileVersion = ([System.IO.File]::ReadAllText((Join-Path $script:StagingDir 'VERSION'))).Trim()
  if ($fileVersion -ne $pkg.Version) {
    Stop-Setup "The downloaded package has the wrong VERSION file ($fileVersion, expected $($pkg.Version)). $kept"
  }

  Say 'Checking the new version...'
  $script:NewVersionOut = ''
  try {
    Invoke-Step 'Checking the new version' {
      $script:NewVersionOut = ''
      $r = Invoke-Captured (Join-Path $script:StagingDir 'swarmcast.exe') '--version' 30
      if ($r.Code -eq 0) {
        $lines = @($r.Out -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
        if ($lines.Count -gt 0) { $script:NewVersionOut = $lines[$lines.Count - 1].Trim() }
      }
      Write-Log "New binary reports version: $($script:NewVersionOut)"
      if ($script:NewVersionOut -ne $pkg.Version) { throw "printed '$($script:NewVersionOut)'" }
    }
  } catch {
    Write-Log "Running the new version failed: $($_.Exception.Message)"
  }
  $out = $script:NewVersionOut
  if ($out -ne $pkg.Version) {
    Stop-Setup "The new version did not start correctly (`"swarmcast --version`" printed `"$out`", expected `"$($pkg.Version)`"). $kept`n  Report it at $SC_IssuesUrl"
  }

  # Swap: current -> previous, staging -> current (renames in the same folder).
  $movedAside = $false
  try {
    if (Test-Path -LiteralPath $script:CurrentDir) {
      if (Test-Path -LiteralPath $script:PreviousDir) { Remove-Item -LiteralPath $script:PreviousDir -Recurse -Force }
      Move-Dir $script:CurrentDir $script:PreviousDir
      $movedAside = $true
      $script:JustUpdated = $true
    }
    Move-Dir $script:StagingDir $script:CurrentDir
    $script:StagingDir = $null
  } catch {
    $why = $_.Exception.Message
    if ($movedAside -and -not (Test-Path -LiteralPath $script:CurrentDir) -and (Test-Path -LiteralPath $script:PreviousDir)) {
      try { Move-Dir $script:PreviousDir $script:CurrentDir } catch { Write-Log "Restore failed: $($_.Exception.Message)" }
    }
    Stop-Setup "Could not replace the installed version: $why`n  If SwarmCast is running (check the tray icon), close it and run this again. $kept"
  }

  Say-Ok "Installed SwarmCast v$($pkg.Version) in $($script:CurrentDir)"
  if ($Installed) { Say "  The previous version v$Installed is kept in $($script:PreviousDir) (for rollback)." }
}

# ---------------------------------------------------------------------------
# Video converter (ffmpeg) for the extra qualities
# ---------------------------------------------------------------------------
# SwarmCast does not ship ffmpeg: this computer downloads the build pinned in the
# release's binaries.json straight from its publisher, checks its SHA-256 and keeps
# it in <data>\tools\ffmpeg (outside app\, so updates do not download it again; a new
# download happens only when the pin changes). Any problem here only skips ffmpeg:
# SwarmCast works without it (viewers get the original quality only).

# SHA-256 listed for $Name in a GNU-format SHA256SUMS file ($null when absent).
function Get-SumsHash([string]$SumsFile, [string]$Name) {
  if (-not $SumsFile -or -not (Test-Path -LiteralPath $SumsFile -PathType Leaf)) { return $null }
  foreach ($line in [System.IO.File]::ReadAllLines($SumsFile)) {
    $l = $line.Trim()
    if ($l -notmatch '^([0-9a-fA-F]{64}) [ *]?(.+)$') { continue }
    if ($Matches[2].Trim() -eq $Name) { return $Matches[1].ToLowerInvariant() }
  }
  return $null
}

# A verified binaries.json (local bundle or release server): @{ File } or @{ Why }.
function Get-BinariesJson {
  if ($script:Source -eq 'local' -and $script:LocalDir) {
    $src = Join-Path $script:LocalDir 'binaries.json'
    $want = Get-SumsHash (Join-Path $script:LocalDir 'SHA256SUMS.txt') 'binaries.json'
    if (-not (Test-Path -LiteralPath $src -PathType Leaf) -or -not $want) { return @{ Why = 'the installer folder has no binaries.json (older installer zip)' } }
  } else {
    if (-not $script:ReleaseOk) { return @{ Why = 'the release server could not be reached (offline?)' } }
    $want = Get-SumsHash $script:SumsFile 'binaries.json'
    if (-not $want) { return @{ Why = 'this release does not list binaries.json' } }
    $src = Join-Path $script:TmpDir 'binaries.json'
    try {
      Save-Url "$($script:ReleaseUrl)/binaries.json" $src 30
    } catch {
      Write-Log "binaries.json download failed: $($_.Exception.Message)"
      return @{ Why = "could not download $($script:ReleaseUrl)/binaries.json" }
    }
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $src).Hash.ToLowerInvariant()
  if ($actual -ne $want) { return @{ Why = 'binaries.json does not match its checksum in SHA256SUMS.txt' } }
  return @{ File = $src }
}

function Show-FfmpegSkipNote {
  Say '  SwarmCast still works without it: viewers get your original quality.'
  Say '  Install it later from the panel (Quality for viewers -> Install the video converter),'
  Say '  or run this script again when you are online.'
}

function Install-Ffmpeg {
  Say-Heading 'Video converter (ffmpeg)'
  $dir = Join-Path (Join-Path $script:DataDir 'tools') 'ffmpeg'
  $exe = Join-Path $dir 'ffmpeg.exe'
  $pinFile = Join-Path $dir 'PIN'
  if ($script:Opt.NoFfmpeg) {
    Say 'Skipped (--no-ffmpeg). Viewers get your original quality only; you can install it later from the panel.'
    return
  }
  $bj = Get-BinariesJson
  if (-not $bj.File) {
    if (Test-Path -LiteralPath $exe) {
      Say-Ok "Video converter already installed ($exe); could not check for a newer pin: $($bj.Why)."
    } else {
      Say-Warn "Skipping the video converter: $($bj.Why)."
      Show-FfmpegSkipNote
    }
    return
  }
  $target = "windows-$($script:ArchInfo.Arch)"
  try {
    $json = [System.IO.File]::ReadAllText($bj.File) | ConvertFrom-Json
    $version = [string]$json.ffmpeg.version
    $a = $json.ffmpeg.assets.$target
  } catch {
    $a = $null
  }
  if (-not $a) {
    Say-Warn "Skipping the video converter: no ffmpeg build is pinned for $target."
    Show-FfmpegSkipNote
    return
  }
  $url = [string]$a.url
  $sha = ([string]$a.sha256).ToLowerInvariant()
  $license = [string]$a.license
  $asset = [string]$a.asset
  if (-not ($url -match '^(https://|http://127\.0\.0\.1[:/])') -or $sha -notmatch '^[0-9a-f]{64}$' -or [string]$a.binary -ne 'ffmpeg.exe' -or -not $version -or $asset -notmatch '^[A-Za-z0-9._-]+$') {
    Say-Warn 'Skipping the video converter: the ffmpeg entry in binaries.json is not valid.'
    Show-FfmpegSkipNote
    return
  }
  $stamp = "$version $sha"
  if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $pinFile) -and (([System.IO.File]::ReadAllText($pinFile)).Trim() -eq $stamp)) {
    Say-Ok "Video converter (ffmpeg $version) already installed"
    return
  }
  Say "Downloading ffmpeg $version for $target from its publisher (SwarmCast does not redistribute it):"
  Say "  $url"
  $archive = Join-Path $script:TmpDir $asset
  # Download + SHA-256 check as one retried unit (a truncated download fails the check).
  $script:FfGot = $null
  try {
    Invoke-Step 'ffmpeg download' {
      $script:FfGot = $null
      Save-Url $url $archive 900
      $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
      if ($got -ne $sha) {
        $script:FfGot = $got
        Remove-Item -LiteralPath $archive -Force
        throw "checksum mismatch (expected $sha, got $got)"
      }
    }
  } catch {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    Write-Log "ffmpeg download failed: $($_.Exception.Message)"
    if ($script:FfGot) {
      Say-Warn "Skipping the video converter: checksum mismatch for the ffmpeg download (expected $sha, got $($script:FfGot)). It was deleted and not installed."
    } else {
      Say-Warn 'Skipping the video converter: the download failed (offline, or the publisher is unreachable).'
    }
    Show-FfmpegSkipNote
    return
  }
  Say-Ok 'ffmpeg checksum OK'
  $ex = Join-Path $script:TmpDir 'ffmpeg-x'
  $new = Join-Path $dir 'ffmpeg.new.exe'
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Invoke-Step 'Unpacking ffmpeg' {
      if (Test-Path -LiteralPath $ex) { Remove-Item -LiteralPath $ex -Recurse -Force }
      [void](New-Item -ItemType Directory -Force -Path $ex)
      [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $ex)
    }
    $found = Get-ChildItem -LiteralPath $ex -Recurse -File -Filter 'ffmpeg.exe' | Select-Object -First 1
    if (-not $found) { throw 'ffmpeg.exe was not found in the download' }
    Invoke-Step 'Copying ffmpeg' {
      [void](New-Item -ItemType Directory -Force -Path $dir)
      Copy-Item -LiteralPath $found.FullName -Destination $new -Force
    }
  } catch {
    Write-Log "ffmpeg unpack failed: $($_.Exception.Message)"
    Say-Warn "Skipping the video converter: could not unpack it ($($_.Exception.Message))."
    Show-FfmpegSkipNote
    return
  } finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $ex) { Remove-Item -LiteralPath $ex -Recurse -Force -ErrorAction SilentlyContinue }
  }
  # Verified by its checksum: drop the "downloaded from the internet" mark.
  try { Unblock-File -LiteralPath $new } catch { Write-Log "Unblock-File: $($_.Exception.Message)" }
  $runs = $false
  try {
    $r = Invoke-Captured $new '-hide_banner -version' 30
    $runs = ($r.Code -eq 0 -and $r.Out -match 'ffmpeg version')
  } catch {
    Write-Log "Running ffmpeg failed: $($_.Exception.Message)"
  }
  if (-not $runs) {
    Remove-Item -LiteralPath $new -Force -ErrorAction SilentlyContinue
    Say-Warn 'Skipping the video converter: the downloaded ffmpeg does not run on this computer.'
    Show-FfmpegSkipNote
    return
  }
  try {
    Invoke-Step 'Installing ffmpeg' { Move-Item -LiteralPath $new -Destination $exe -Force }
    Invoke-Step 'Writing the ffmpeg pin' { [System.IO.File]::WriteAllText($pinFile, "$stamp`r`n", $script:Utf8NoBom) }
  } catch {
    Remove-Item -LiteralPath $new -Force -ErrorAction SilentlyContinue
    Say-Warn "Skipping the video converter: could not write $dir ($($_.Exception.Message))."
    Show-FfmpegSkipNote
    return
  }
  [System.IO.File]::WriteAllText((Join-Path $dir 'SOURCE.txt'), "$url`r`nsha256 $sha`r`nlicense $license`r`nDownloaded from its publisher on this computer by start-windows.ps1; SwarmCast does not redistribute ffmpeg.`r`n", $script:Utf8NoBom)
  if (-not $license) { $license = 'see SOURCE.txt' }
  Say-Ok "Installed ffmpeg $version in $dir (license: $license)"
}

function Invoke-SmokeTest {
  Say-Heading 'Smoke test'
  Say 'Running "swarmcast --smoke-test" (starts everything without the tunnel, verifies, stops)...'
  $ErrorActionPreference = 'Continue'   # stderr lines of a native program must not stop the script
  & $script:CurrentExe --smoke-test 2>&1 | ForEach-Object {
    $line = "$_"
    Write-Host "  $line"
    Write-Log "[swarmcast] $line"
  }
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 1 }
  if ($code -eq 0) {
    Say-Ok 'Smoke test passed.'
  } else {
    Say-Err "Smoke test failed (exit code $code). See $($script:LogFile) and the logs in $($script:DataDir)\logs."
  }
  Write-Log "Exiting with code $code"
  Invoke-Cleanup
  Exit-Setup $code
}

# The new version replaced a working one but does not start: put the previous one back.
function Invoke-Rollback {
  if (-not (Test-Path -LiteralPath $script:PreviousDir)) { return $false }
  $bad = ''; $good = ''
  try { $bad = ([System.IO.File]::ReadAllText((Join-Path $script:CurrentDir 'VERSION'))).Trim() } catch { }
  try { $good = ([System.IO.File]::ReadAllText((Join-Path $script:PreviousDir 'VERSION'))).Trim() } catch { }
  $failed = Join-Path $script:AppDir 'failed'
  try {
    if (Test-Path -LiteralPath $failed) { Remove-Item -LiteralPath $failed -Recurse -Force }
    Move-Dir $script:CurrentDir $failed
    try {
      Move-Dir $script:PreviousDir $script:CurrentDir
    } catch {
      Move-Dir $failed $script:CurrentDir
      throw
    }
    Remove-Item -LiteralPath $failed -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    Write-Log "Rollback failed: $($_.Exception.Message)"
    return $false
  }
  $script:JustUpdated = $false
  Say-Warn "The new version v$bad did not start, so SwarmCast went back to v$good, the version you had before."
  return $true
}

# Closing this window must stop SwarmCast. Windows normally tells every program in it
# (CTRL_CLOSE_EVENT) and SwarmCast stops everything by itself. On some Windows builds the
# window can disappear while that never arrives, and SwarmCast, this script and its cmd
# window would keep running without a window. This watch checks every 2 s whether the
# console window still exists; once it is gone, it logs that and ends this script with exit
# code 0. SwarmCast notices that the program that started it is gone and shuts down cleanly
# (stops the live, MediaMTX, the tunnel and the tray), and cmd ends too. It only arms when
# the console reports a visible window (Console Host's, or the pseudo window some Windows
# Terminal builds report as visible); hidden and redirected runs have none.
# SWARMCAST_NO_WINDOW_WATCH=1 turns it off.
$SC_WindowWatchSource = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class SwarmCastWindowWatch {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  static Thread watch;
  public static string Start(string logFile, int everyMs) {
    if (watch != null) return "already watching";
    IntPtr window = GetConsoleWindow();
    if (window == IntPtr.Zero) return "no console window";
    if (!IsWindowVisible(window)) return "console window not visible (Windows Terminal, hidden or redirected)";
    watch = new Thread(delegate () {
      while (true) {
        Thread.Sleep(everyMs);
        IntPtr now = GetConsoleWindow();
        if (now != IntPtr.Zero && IsWindow(window)) continue;
        try {
          if (!String.IsNullOrEmpty(logFile)) {
            string line = String.Format("[{0:yyyy-MM-dd HH:mm:ss}] The SwarmCast window was closed but Windows did not stop SwarmCast (window watch): ending the start script so SwarmCast shuts down by itself\r\n", DateTime.Now);
            File.AppendAllText(logFile, line, new UTF8Encoding(false));
          }
        } catch { }
        TerminateProcess(GetCurrentProcess(), 0);
      }
    });
    watch.IsBackground = true;
    watch.Start();
    return String.Format("watching console window 0x{0:x}", window.ToInt64());
  }
}
'@

function Start-WindowWatch {
  if ($env:SWARMCAST_NO_WINDOW_WATCH -eq '1' -or $env:OS -ne 'Windows_NT') { return }
  try {
    # Started by another program with neither keyboard nor screen (tests, services): no window
    # anyone could close, and no reason to spend a second compiling the watch.
    if ([Console]::IsInputRedirected -and [Console]::IsOutputRedirected) {
      Write-Log 'Window watch: not needed (input and output redirected)'
      return
    }
    if (-not ('SwarmCastWindowWatch' -as [type])) { Add-Type -TypeDefinition $SC_WindowWatchSource }
    $state = [SwarmCastWindowWatch]::Start([string]$script:LogFile, 2000)
    Write-Log "Window watch: $state"
  } catch {
    # Never a reason not to start: closing the window still works where Windows tells SwarmCast.
    Write-Log "Window watch not started: $($_.Exception.Message)"
  }
}

# Runs SwarmCast in the foreground of this window (Ctrl+C or closing the window reaches it
# directly, and it stops everything by itself). Sets $script:AppCode and $script:AppSeconds.
# Called as a plain statement (never captured) so the app's output reaches the window.
function Invoke-App([string[]]$AppArgs) {
  Write-Log "Starting: $($script:CurrentExe) $($AppArgs -join ' ')"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ErrorActionPreference = 'Continue'
  & $script:CurrentExe @AppArgs
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($null -eq $code) { $code = 0 }
  $script:AppCode = $code
  $script:AppSeconds = [int]$sw.Elapsed.TotalSeconds
  Write-Log "SwarmCast exited with code $code after $($script:AppSeconds) s"
}

# The uninstaller (uninstall-windows.ps1) is removing SwarmCast: it leaves a ".uninstalling"
# note in the data folder while it stops SwarmCast and deletes its files. A note older than
# 10 minutes is a leftover of an interrupted uninstall and is ignored.
function Test-Uninstalling {
  $marker = Join-Path $script:DataDir '.uninstalling'
  try {
    $item = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    if ($item -and ((Get-Date) - $item.LastWriteTime).TotalMinutes -lt 10) { return $true }
  } catch { }
  return (-not (Test-Path -LiteralPath $script:CurrentExe))
}

function Exit-Uninstalling {
  Say "SwarmCast was stopped by its uninstaller (exit code $($script:AppCode)); not starting it again."
  Write-Log 'SwarmCast is being uninstalled: not restarting it'
  Exit-Setup $script:AppCode
}

function Start-App {
  if (-not (Test-Path -LiteralPath $script:CurrentExe)) {
    Stop-Setup "SwarmCast is not installed correctly ($($script:CurrentExe) is missing). Run this script again."
  }
  $appArgs = @()
  if ($script:Opt.NoTunnel) { $appArgs += '--no-tunnel' }
  Say-Heading 'Starting SwarmCast'
  Say $SC_ObsHint
  Say ''
  Invoke-Cleanup
  Start-WindowWatch
  # A start that fails within 10 s is retried (2 s, 5 s, 10 s); a freshly updated version
  # that fails is replaced by the previous one first.
  $script:AppCode = 0
  $delays = @(0) + $SC_StepDelays
  for ($attempt = 1; $attempt -le $delays.Count; $attempt++) {
    $delay = $delays[$attempt - 1]
    if ($delay -gt 0) {
      Say "SwarmCast stopped right away (exit code $($script:AppCode)). Trying again in $delay s (attempt $attempt of $($delays.Count))..."
      Start-Sleep -Seconds $delay
      if (Test-Uninstalling) { Exit-Uninstalling; return }
    }
    Invoke-App $appArgs
    if ($script:AppCode -eq 0 -or $script:AppSeconds -ge 10) { Exit-Setup $script:AppCode; return }
    # Stopped by the uninstaller: never start it again (or roll back) under its feet.
    if (Test-Uninstalling) { Exit-Uninstalling; return }
    if ($script:JustUpdated -and (Invoke-Rollback)) {
      Invoke-App $appArgs
      if ($script:AppCode -eq 0 -or $script:AppSeconds -ge 10) { Exit-Setup $script:AppCode; return }
    }
  }
  Stop-Setup "SwarmCast could not start (exit code $($script:AppCode)), even after several tries.`n  Restart your computer and run this again. If it keeps happening, report it at $SC_IssuesUrl`n  and attach $($script:LogFile) and the logs in $($script:DataDir)\logs." $script:AppCode
}

function Invoke-Main {
  Read-Options
  Initialize-Console
  if ($script:Opt.Help) {
    Show-Usage
    Exit-Setup 0
    return
  }
  Initialize-Paths
  Initialize-Network
  Write-Log "==== SwarmCast setup started (Windows) args: $($ScriptArgs -join ' ') ===="
  Say 'SwarmCast setup for Windows' 'Cyan'
  Say "Data folder: $($script:DataDir)"

  if (Test-Elevated) {
    Say-Warn 'Note: this window runs as administrator. That is not needed: SwarmCast installs and runs for your user only. Continuing.'
  }

  Repair-PreviousRun

  Say-Heading 'Checking your computer'
  $script:OsInfo = Get-OsInfo
  $script:ArchInfo = Get-Arch
  $script:RamMB = Get-RamMB
  $script:Cores = [Environment]::ProcessorCount
  $script:FreeDisk = Get-FreeDiskBytes
  $script:BusyPorts = Get-BusyPorts
  $script:ObsPath = Find-Obs
  Say 'Checking the connection to github.com and to the release server...'
  Test-Release
  $script:GitHubOk = Test-GitHub -Once:([bool]$script:LocalDir)

  Measure-Speed
  Show-Report
  Install-OrUpdate
  Install-Ffmpeg

  if ($script:Opt.SmokeTest) { Invoke-SmokeTest }
  if ($script:Opt.InstallOnly) {
    Say-Ok 'Done (--install-only). Start SwarmCast later by running this script again.'
    Write-Log 'Exiting with code 0'
    Invoke-Cleanup
    Exit-Setup 0
    return
  }
  Start-App
}

try {
  Invoke-Main
} catch {
  # Not when Exit-Setup stopped a piped run: its reason is already on screen.
  if (-not $script:Stopped) {
    $msg = $_.Exception.Message
    Write-Log "Unexpected error: $msg`r`n$($_.ScriptStackTrace)"
    Stop-Setup "Unexpected error: $msg`n  Please report it at $SC_IssuesUrl (attach $($script:LogFile))."
  }
} finally {
  Invoke-Cleanup
}
