# Runs once, at the first logon of the SwarmCast test VM (autounattend.xml FirstLogonCommands), as
# its administrator. Windows PowerShell 5.1.
#  1. UTM's guest tools from their CD (UTM attaches it when "Install drivers and SPICE tools" is
#     ticked): the network card's driver, which Windows on Arm does not have, and the guest agent.
#  2. OpenSSH Server (a Windows capability, from Windows Update once the network is up), started
#     with Windows, PowerShell as its shell, port 22 open: the Mac drives the VM over ssh.
#  3. A marker file, %PUBLIC%\swarmcast-vm-ready.txt, when all of it worked.
# Everything it does is logged to %PUBLIC%\swarmcast-first-logon.log.
$ErrorActionPreference = 'Stop'
Start-Transcript -Path (Join-Path $env:PUBLIC 'swarmcast-first-logon.log') -Append | Out-Null
try {
  $tools = Get-PSDrive -PSProvider FileSystem |
    ForEach-Object { Get-ChildItem -Path $_.Root -Filter '*guest-tools*.exe' -ErrorAction SilentlyContinue } |
    Select-Object -First 1
  if ($tools) {
    Write-Output "Installing $($tools.FullName)"
    Start-Process -FilePath $tools.FullName -ArgumentList '/S' -Wait
  } else {
    Write-Output 'No guest tools CD: the network needs its driver from somewhere else'
  }

  # The network comes up once the driver is in: wait for Windows Update's host, ten minutes at most.
  $deadline = (Get-Date).AddMinutes(10)
  while (-not (Test-NetConnection -ComputerName 'download.windowsupdate.com' -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
    if ((Get-Date) -gt $deadline) { throw 'no network ten minutes after the guest tools' }
    Start-Sleep -Seconds 5
  }

  Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
  Set-Service -Name sshd -StartupType Automatic
  Start-Service -Name sshd
  if (-not (Get-NetFirewallRule -Name 'swarmcast-sshd' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'swarmcast-sshd' -DisplayName 'OpenSSH Server (SwarmCast test VM)' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -Profile Any | Out-Null
  }
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null

  Set-Content -Path (Join-Path $env:PUBLIC 'swarmcast-vm-ready.txt') -Value (Get-Date -Format o)
  Write-Output 'SwarmCast test VM ready: OpenSSH Server on port 22'
} finally {
  Stop-Transcript | Out-Null
}
