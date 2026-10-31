# Media Foundation for Firefox on Windows Server (the Windows app suite, _windows.yml and soak.yml).
#
# The first step of the job starts the install in the background (DISM, the servicing stack's own
# tool; inline in the workflow, because it runs before the checkout that brings this file), which
# writes, in RUNNER_TEMP:
#   media-foundation.start  when it started (UTC, ISO 8601)
#   media-foundation.log    what dism.exe printed
#   media-foundation.done   dism.exe's exit code, once it has finished
#
#   media-foundation.ps1 wait [-Seconds N]  waits for it, sampling the servicing stack every 10 s,
#     then checks the feature. On a failure, or when it is not done after N seconds, it prints the
#     install log and the servicing diagnostics and fails, before the step's own time limit.
#   media-foundation.ps1 diagnose           prints the servicing diagnostics only.
#
# Client Windows (windows-11-arm) has Media Foundation built in: both modes say so and exit 0.
param(
  [Parameter(Mandatory, Position = 0)][ValidateSet('wait', 'diagnose')][string]$Mode,
  [int]$Seconds = 540
)
$ErrorActionPreference = 'Stop'
$Feature = 'ServerMediaFoundation'
$dir = $env:RUNNER_TEMP
$startFile = Join-Path $dir 'media-foundation.start'
$doneFile = Join-Path $dir 'media-foundation.done'
$logFile = Join-Path $dir 'media-foundation.log'
$dismLog = Join-Path $dir 'media-foundation-dism.log'

function Now { [DateTime]::UtcNow.ToString('HH:mm:ss') + 'Z' }

# The end of a log that another process is writing (CBS.log, dism.log): opened for shared reading,
# only its last 256 kB read.
function Get-Tail([string]$Path, [int]$Lines) {
  if (-not (Test-Path $Path)) { return "($Path does not exist)" }
  try {
    $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete')
    try {
      if ($fs.Length -gt 262144) { [void]$fs.Seek(-262144, 'End') }
      $text = (New-Object IO.StreamReader($fs)).ReadToEnd()
    } finally { $fs.Dispose() }
    return ($text -split "`r?`n" | Where-Object { $_ } | Select-Object -Last $Lines)
  } catch { return "($Path`: $($_.Exception.Message))" }
}

function Get-ServicingProcesses {
  $names = 'TiWorker', 'TrustedInstaller', 'dism', 'DismHost', 'wuauclt', 'MoUsoCoreWorker', 'UsoClient', 'msiexec', 'CompatTelRunner', 'MpCmdRun', 'MsMpEng', 'sppsvc', 'powershell', 'cmd'
  Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object {
    $start = try { $_.StartTime.ToUniversalTime().ToString('HH:mm:ss') + 'Z' } catch { '?' }
    $cpu = try { [math]::Round($_.TotalProcessorTime.TotalSeconds, 1) } catch { '?' }
    [pscustomobject]@{ Name = $_.Name; Id = $_.Id; Started = $start; CpuSeconds = $cpu; WorkingSetMB = [math]::Round($_.WorkingSet64 / 1MB) }
  }
}

# One line every 10 s while waiting: what the servicing stack is doing.
function Get-Sample([double]$Elapsed) {
  $ti = Get-Process TiWorker -ErrorAction SilentlyContinue
  $cpu = if ($ti) { ($ti | ForEach-Object { try { [math]::Round($_.TotalProcessorTime.TotalSeconds) } catch { '?' } }) -join '+' } else { '-' }
  $others = (Get-Process -Name 'dism', 'DismHost', 'TrustedInstaller', 'wuauclt', 'MoUsoCoreWorker', 'msiexec' -ErrorAction SilentlyContinue | ForEach-Object Name | Sort-Object -Unique) -join ','
  $cbs = (Get-Tail "$env:windir\Logs\CBS\CBS.log" 1) -replace '\s+', ' '
  if ($cbs.Length -gt 160) { $cbs = $cbs.Substring(0, 160) }
  '{0} +{1,4}s TiWorker cpu {2,-6} {3,-40} CBS: {4}' -f (Now), [int]$Elapsed, $cpu, $others, $cbs
}

function Show-Diagnostics {
  "::group::Servicing diagnostics ($(Now))"
  $uptime = [TimeSpan]::FromMilliseconds([Environment]::TickCount64)
  "Uptime: $([int]$uptime.TotalSeconds) s (booted $([DateTime]::UtcNow.Subtract($uptime).ToString('HH:mm:ss'))Z)"
  if (Test-Path $startFile) { "Install started: $(Get-Content $startFile)" }
  if (Test-Path $doneFile) { "Install exit code: $(Get-Content $doneFile)" } else { 'Install: not finished' }
  '--- Processes'
  Get-ServicingProcesses | Format-Table -AutoSize | Out-String -Width 200
  '--- Services'
  Get-Service TrustedInstaller, wuauserv, UsoSvc, BITS, msiserver, WaaSMedicSvc -ErrorAction SilentlyContinue | Format-Table Name, Status, StartType -AutoSize | Out-String -Width 200
  '--- Pending servicing and reboots'
  $cbsKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing'
  foreach ($k in 'RebootPending', 'RebootInProgress', 'PackagesPending', 'SessionsPending') { "$k`: $(Test-Path "$cbsKey\$k")" }
  try { $sp = Get-ItemProperty "$cbsKey\SessionsPending" -ErrorAction Stop; "SessionsPending: Exclusive=$($sp.Exclusive) TotalSessionPhases=$($sp.TotalSessionPhases)" } catch { }
  "WindowsUpdate RebootRequired: $(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')"
  $pfro = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations
  "PendingFileRenameOperations: $(@($pfro | Where-Object { $_ }).Count) entries"
  '--- Running scheduled tasks'
  try {
    $svc = New-Object -ComObject Schedule.Service; $svc.Connect()
    foreach ($t in $svc.GetRunningTasks(1)) { "$($t.Path) (PID $($t.EnginePID))" }
  } catch { "(scheduled tasks: $($_.Exception.Message))" }
  '--- Setup event log (servicing), newest 15'
  try { Get-WinEvent -LogName Setup -MaxEvents 15 -ErrorAction Stop | ForEach-Object { "$($_.TimeCreated.ToUniversalTime().ToString('HH:mm:ss'))Z [$($_.Id)] $(($_.Message -replace '\s+', ' '))" } } catch { "(Setup log: $($_.Exception.Message))" }
  '--- dism.exe output'
  if (Test-Path $logFile) { Get-Content $logFile } else { "($logFile does not exist)" }
  '--- DISM log of the install, last 40 lines'
  Get-Tail $dismLog 40
  '--- CBS.log, last 60 lines'
  Get-Tail "$env:windir\Logs\CBS\CBS.log" 60
  '::endgroup::'
}

if ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').InstallationType -eq 'Client') {
  'Client Windows: Media Foundation comes with the OS'
  exit 0
}

if ($Mode -eq 'diagnose') { Show-Diagnostics; exit 0 }

if (-not (Test-Path $startFile)) { Show-Diagnostics; throw 'The Media Foundation install was never started (no media-foundation.start)' }
$started = [DateTime]::Parse((Get-Content $startFile), $null, 'RoundtripKind')
$sw = [Diagnostics.Stopwatch]::StartNew()
$samples = [Collections.Generic.List[string]]::new()
while (-not (Test-Path $doneFile) -and $sw.Elapsed.TotalSeconds -lt $Seconds) {
  $samples.Add((Get-Sample ([DateTime]::UtcNow - $started).TotalSeconds))
  Start-Sleep -Seconds 10
}
$code = if (Test-Path $doneFile) { (Get-Content $doneFile -Raw).Trim() } else { $null }
$ended = if ($null -ne $code) { (Get-Item $doneFile).LastWriteTimeUtc } else { [DateTime]::UtcNow }
$took = [int]($ended - $started).TotalSeconds
"::group::Servicing samples while waiting ($($samples.Count))"
$samples
'::endgroup::'
if ($null -eq $code) {
  Show-Diagnostics
  throw "Media Foundation: dism.exe has not finished $took s after it started (waited $([int]$sw.Elapsed.TotalSeconds) s here); see the diagnostics above"
}
# 0: enabled; 3010: enabled, restart required (Media Foundation never asks for one: that would be a change to look at).
if ($code -ne '0') {
  Show-Diagnostics
  throw "Media Foundation: dism.exe exited with $code; see the diagnostics above"
}
$info = & dism.exe /English /online /get-featureinfo "/featurename:$Feature"
$state = ($info | Select-String '^State : (.+)$').Matches.Groups[1].Value
if ($state -ne 'Enabled') {
  $info
  Show-Diagnostics
  throw "Media Foundation: $Feature is '$state' after dism.exe exited with 0"
}
"Media Foundation ($Feature): Enabled, installed in $took s (dism.exe started $($started.ToString('HH:mm:ss'))Z; waited $([int]$sw.Elapsed.TotalSeconds) s here)"
