# Sends a console event to the console that process -TargetPid is attached to, like a user:
#   -Action close      closes the console window (WM_CLOSE -> CTRL_CLOSE_EVENT for every process in it)
#   -Action ctrlc      presses Ctrl+C in it
#   -Action ctrlbreak  presses Ctrl+Break in it
# Windows PowerShell 5.1, ASCII only.
param([Parameter(Mandatory = $true)][int]$TargetPid, [Parameter(Mandatory = $true)][string]$Action, [string]$Title = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ScCon {
  public delegate bool HandlerRoutine(uint ctrlType);
  static HandlerRoutine keep = delegate (uint t) { return true; };
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(HandlerRoutine h, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  public static void IgnoreEvents() { SetConsoleCtrlHandler(keep, true); }
}
'@
[void][ScCon]::FreeConsole()
if (-not [ScCon]::AttachConsole([uint32]$TargetPid)) {
  Write-Output ("attach failed: win32 error {0}" -f [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 2
}
[ScCon]::IgnoreEvents()
$hwnd = [ScCon]::GetConsoleWindow()
switch ($Action) {
  'close' {
    [void][ScCon]::FreeConsole()
    $target = $hwnd
    $how = 'console window (conhost)'
    if (-not [ScCon]::IsWindowVisible($hwnd)) {
      # Windows Terminal hosts the console: GetConsoleWindow() is a hidden pseudo window.
      # Close the visible terminal window that shows our title instead (what the X button does).
      $w = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $Title -and $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
      if (-not $w) { $w = Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Sort-Object StartTime -Descending | Select-Object -First 1 }
      if ($w) { $target = $w.MainWindowHandle; $how = "window of $($w.ProcessName) '$($w.MainWindowTitle)'" }
      else { $how = 'hidden pseudo console window (no visible window with the title found)' }
    }
    # What the X button does: WM_SYSCOMMAND SC_CLOSE; then plain WM_CLOSE if the window is still there.
    $ok = [ScCon]::PostMessage($target, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero)
    $sent = 'SC_CLOSE'
    $end = (Get-Date).AddSeconds(4)
    while ([ScCon]::IsWindow($target) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 200 }
    if ([ScCon]::IsWindow($target)) {
      $ok = [ScCon]::PostMessage($target, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
      $sent = 'SC_CLOSE+WM_CLOSE'
      $end = (Get-Date).AddSeconds(8)
      while ([ScCon]::IsWindow($target) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 200 }
    }
    Write-Output ("{0} 0x{1:x}: {2} posted={3} closed={4}" -f $how, $target.ToInt64(), $sent, $ok, (-not [ScCon]::IsWindow($target)))
  }
  'ctrlc' {
    $ok = [ScCon]::GenerateConsoleCtrlEvent(0, 0)
    Start-Sleep -Milliseconds 500
    [void][ScCon]::FreeConsole()
    Write-Output ("console window 0x{0:x}: CTRL_C_EVENT sent={1}" -f $hwnd.ToInt64(), $ok)
  }
  'ctrlbreak' {
    $ok = [ScCon]::GenerateConsoleCtrlEvent(1, 0)
    Start-Sleep -Milliseconds 500
    [void][ScCon]::FreeConsole()
    Write-Output ("console window 0x{0:x}: CTRL_BREAK_EVENT sent={1}" -f $hwnd.ToInt64(), $ok)
  }
  'probe' {
    [void][ScCon]::FreeConsole()
    Write-Output ("attached; console window 0x{0:x} exists={1} visible={2}" -f $hwnd.ToInt64(), [ScCon]::IsWindow($hwnd), [ScCon]::IsWindowVisible($hwnd))
  }
  default { Write-Output "unknown action $Action"; exit 2 }
}
exit 0
