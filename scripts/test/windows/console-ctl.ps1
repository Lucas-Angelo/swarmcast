# Sends a console event to the console that process -TargetPid is attached to, like a user:
#   -Action close      closes the console window like a click on its X button (see -Method)
#   -Action ctrlc      presses Ctrl+C in it
#   -Action ctrlbreak  presses Ctrl+Break in it
#   -Action probe      reports whether the console and its window still exist
# -Method (close only), tried in this order with 'auto' (the default) until the window is gone:
#   click  a real left click (SendInput) on the title bar's close button, after checking that
#          the point is that window's close button (WM_NCHITTEST = HTCLOSE) and nothing covers it
#   uia    UI Automation WindowPattern.Close()
#   post   WM_SYSCOMMAND SC_CLOSE, then WM_CLOSE, posted to the window (the old simulation)
# The output line says which method closed the window ("method=<name>") and what each try did.
# Windows PowerShell 5.1, ASCII only.
param([Parameter(Mandatory = $true)][int]$TargetPid, [Parameter(Mandatory = $true)][string]$Action, [string]$Title = '', [string]$Method = 'auto')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
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

  // ---- the real click
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);

  public delegate bool EnumProc(IntPtr hWnd, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  // A real window has an area. The pseudo console window of Windows Terminal (ConPTY) is 0 x 0,
  // even where it reports itself visible: closing it closes nothing the user sees.
  public static bool HasArea(IntPtr hWnd) { RECT r; return GetWindowRect(hWnd, out r) && r.Right > r.Left && r.Bottom > r.Top; }
  public static string Title(IntPtr hWnd) { System.Text.StringBuilder sb = new System.Text.StringBuilder(512); GetWindowText(hWnd, sb, 512); return sb.ToString(); }
  public static string Describe(IntPtr hWnd) {
    RECT r; GetWindowRect(hWnd, out r);
    uint pid; GetWindowThreadProcessId(hWnd, out pid);
    string name = "?";
    try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
    return String.Format("0x{0:x} of {1}#{2} '{3}' {4}x{5} visible={6}", hWnd.ToInt64(), name, pid, Title(hWnd), r.Right - r.Left, r.Bottom - r.Top, IsWindowVisible(hWnd));
  }
  // The visible top-level window with an area whose title contains `part` (what the user sees).
  public static IntPtr FindByTitle(string part) {
    IntPtr found = IntPtr.Zero;
    if (String.IsNullOrEmpty(part)) return found;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && HasArea(h) && Title(h).IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static long HitTest(IntPtr hWnd, int x, int y) {
    return SendMessage(hWnd, 0x0084, IntPtr.Zero, new IntPtr(((y & 0xFFFF) << 16) | (x & 0xFFFF))).ToInt64(); // WM_NCHITTEST
  }

  public static bool WaitGone(IntPtr hWnd, int ms) {
    DateTime end = DateTime.UtcNow.AddMilliseconds(ms);
    while (IsWindow(hWnd) && DateTime.UtcNow < end) Thread.Sleep(100);
    return !IsWindow(hWnd);
  }

  // Moves hWnd (size and z-order kept), for a second click when something covered its X.
  public static void DpiAware() { SetProcessDPIAware(); }
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  // Moves hWnd so its whole title bar is on the primary screen, its X 20 px from the right edge.
  public static string MoveIntoView(IntPtr hWnd) {
    RECT r; GetWindowRect(hWnd, out r);
    int x = Math.Max(0, GetSystemMetrics(0) - (r.Right - r.Left) - 20), y = 120;
    SetWindowPos(hWnd, IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004);
    return String.Format("{0},{1}", x, y);
  }

  // Clicks the close button of hWnd with real mouse input. Returns what it did; "clicked" only
  // when the press and release were both injected on a verified close button.
  public static string Click(IntPtr hWnd) { return Click(hWnd, -1, -1); }
  // With x, y >= 0: click there (the close button's rectangle from UI Automation, for windows
  // that draw their own title bar, like Windows Terminal) instead of the WM_NCHITTEST search.
  public static string Click(IntPtr hWnd, int atX, int atY) {
    SetProcessDPIAware();
    IntPtr desk = OpenInputDesktop(0, false, 0x0100);
    if (desk == IntPtr.Zero) return "no input desktop (locked or non-interactive session)";
    CloseDesktop(desk);
    if (IsIconic(hWnd)) { ShowWindow(hWnd, 9); Thread.Sleep(300); }
    // On top of every other window, so the click lands on it (no foreground rights needed).
    IntPtr TOPMOST = new IntPtr(-1), NOTOPMOST = new IntPtr(-2);
    SetWindowPos(hWnd, TOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    Thread.Sleep(300);
    // Find the close button by asking the window itself (WM_NCHITTEST = HTCLOSE) along the top
    // edge of its frame, so the click is on the X whatever the theme, DPI or caption size.
    RECT w; GetWindowRect(hWnd, out w);
    POINT p; string where;
    if (atX >= 0 && atY >= 0) {
      p.X = atX; p.Y = atY;
      where = String.Format("close button from UI Automation, click at {0},{1}", p.X, p.Y);
    } else {
    int minX = int.MaxValue, maxX = int.MinValue, rowY = 0;
    for (int y = w.Top + 2; y < w.Top + 60 && minX == int.MaxValue; y += 3) {
      for (int x = w.Right - 2; x > w.Right - 220 && x > w.Left; x -= 2) {
        if (HitTest(hWnd, x, y) == 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; rowY = y; }
      }
    }
    if (minX == int.MaxValue) { SetWindowPos(hWnd, NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002); return String.Format("window {0},{1}-{2},{3}: no close button found (hit test never HTCLOSE), not clicked", w.Left, w.Top, w.Right, w.Bottom); }
    int cx = (minX + maxX) / 2, minY = rowY, maxY = rowY;
    while (minY > w.Top && HitTest(hWnd, cx, minY - 1) == 20) minY--;
    while (maxY < w.Top + 80 && HitTest(hWnd, cx, maxY + 1) == 20) maxY++;
    p.X = cx; p.Y = (minY + maxY) / 2;
    where = String.Format("close button {0},{1}-{2},{3} (WM_NCHITTEST), click at {4},{5}", minX, minY, maxX, maxY, p.X, p.Y);
    long hit = HitTest(hWnd, p.X, p.Y);
    if (hit != 20) { SetWindowPos(hWnd, NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002); return where + String.Format(": not the close button (hit test {0}), not clicked", hit); }
    }
    IntPtr under = GetAncestor(WindowFromPoint(p), 2); // GA_ROOT
    if (under != hWnd) { SetWindowPos(hWnd, NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002); return where + ": covered by window " + Describe(under) + ", not clicked"; }
    SetCursorPos(p.X, p.Y);
    Thread.Sleep(150);
    POINT now; GetCursorPos(out now);
    if (now.X != p.X || now.Y != p.Y) { SetWindowPos(hWnd, NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002); return where + String.Format(": the cursor stopped at {0},{1} (point off the screen?), not clicked", now.X, now.Y); }
    INPUT[] down = new INPUT[1]; down[0].type = 0; down[0].u.mi.dwFlags = 0x0002; // MOUSEEVENTF_LEFTDOWN
    INPUT[] up = new INPUT[1]; up[0].type = 0; up[0].u.mi.dwFlags = 0x0004;       // MOUSEEVENTF_LEFTUP
    int size = Marshal.SizeOf(typeof(INPUT));
    uint a = SendInput(1, down, size);
    Thread.Sleep(120);
    uint b = SendInput(1, up, size);
    int err = Marshal.GetLastWin32Error();
    if (IsWindow(hWnd)) SetWindowPos(hWnd, NOTOPMOST, 0, 0, 0, 0, 0x0001 | 0x0002);
    if (a != 1 || b != 1) return where + String.Format(": SendInput injected {0}+{1} of 2 events (win32 error {2}; blocked by UIPI or no input desktop)", a, b, err);
    return where + String.Format(" (cursor at {0},{1}): clicked", now.X, now.Y);
  }
}
'@
# Screen coordinates in physical pixels for the hit tests, UI Automation and SendInput alike.
[ScCon]::DpiAware()

# Center of the window's own Close button (the X at the right end of its title bar) as UI
# Automation sees it, or $null. Windows Terminal also has a close button on every tab (seen
# first in the tree, AutomationId CloseButton too): the rightmost one in the top 60 px is the X.
function Get-UiaCloseButtonPoint([IntPtr]$Hwnd) {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $A = [System.Windows.Automation.AutomationElement]
    $root = $A::FromHandle($Hwnd)
    $top = $root.Current.BoundingRectangle.Y
    $isButton = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $best = $null
    foreach ($b in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isButton)) {
      $c = $b.Current
      if ($c.AutomationId -ne 'CloseButton' -and $c.Name -ne 'Close') { continue }
      $r = $c.BoundingRectangle
      if ($r.Width -le 0 -or $r.Height -le 0 -or ($r.Y - $top) -gt 60) { continue }
      if (-not $best -or $r.Right -gt $best.Right) { $best = $r }
    }
    if ($best) { return @([int]($best.X + $best.Width / 2), [int]($best.Y + $best.Height / 2)) }
  } catch { }
  return $null
}

[void][ScCon]::FreeConsole()
if (-not [ScCon]::AttachConsole([uint32]$TargetPid)) {
  Write-Output ("attach failed: win32 error {0}" -f [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 2
}
[ScCon]::IgnoreEvents()
$hwnd = [ScCon]::GetConsoleWindow()
switch ($Action) {
  'close' {
    # Detached first: the close event must not reach this helper.
    [void][ScCon]::FreeConsole()
    $target = $hwnd
    $how = "console window $([ScCon]::Describe($hwnd))"
    if (-not [ScCon]::IsWindowVisible($hwnd) -or -not [ScCon]::HasArea($hwnd)) {
      # Windows Terminal hosts the console: GetConsoleWindow() is its 0 x 0 pseudo window, which
      # may even report itself visible. Close the window the user sees, the one showing our title
      # (what its X button does).
      $real = [ScCon]::FindByTitle($Title)
      if ($real -eq [IntPtr]::Zero) {
        $w = Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Sort-Object StartTime -Descending | Select-Object -First 1
        if ($w) { $real = $w.MainWindowHandle }
      }
      if ($real -ne [IntPtr]::Zero) { $how = "pseudo console window $([ScCon]::Describe($hwnd)); its terminal window $([ScCon]::Describe($real))"; $target = $real }
      else { $how = "pseudo console window $([ScCon]::Describe($hwnd)) (no visible window titled '$Title' found)" }
    }
    $order = @('click', 'uia', 'post')
    if ($Method -ne 'auto') { $order = @($Method) }
    $tries = @()
    $closedBy = 'none'
    foreach ($m in $order) {
      if (-not [ScCon]::IsWindow($target)) { break }
      $note = ''
      try {
        switch ($m) {
          'click' {
            $note = [ScCon]::Click($target)
            if ($note -match 'no close button found') {
              # A window that draws its own title bar (Windows Terminal) answers no HTCLOSE: take
              # its Close button's rectangle from UI Automation and click that.
              $pt = Get-UiaCloseButtonPoint $target
              if ($pt) { $note = "$note; $([ScCon]::Click($target, $pt[0], $pt[1]))" }
              else { $note = "$note; no Close button in UI Automation either" }
            }
            if ($note -match 'covered by') {
              # Another always-on-top window sits on the X: move the window (staying on the screen)
              # and try once more. A full-screen overlay (windows-11-arm has a 1024 x 768
              # PickerHost window) still covers it; then UI Automation closes it instead.
              $at = [ScCon]::MoveIntoView($target)
              Start-Sleep -Milliseconds 300
              $note = "$note; moved to ${at}: $([ScCon]::Click($target))"
            }
          }
          'uia' {
            Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
            $el = [System.Windows.Automation.AutomationElement]::FromHandle($target)
            $wp = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) { $wp.Close(); $note = 'WindowPattern.Close()' }
            else { $note = 'no WindowPattern on the window' }
          }
          'post' {
            # WM_SYSCOMMAND SC_CLOSE; then plain WM_CLOSE if the window is still there.
            $ok = [ScCon]::PostMessage($target, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero)
            $note = "SC_CLOSE posted=$ok"
            if (-not [ScCon]::WaitGone($target, 4000)) {
              $ok = [ScCon]::PostMessage($target, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
              $note += "; WM_CLOSE posted=$ok"
            }
          }
          default { $note = 'unknown method' }
        }
      } catch {
        $note = "error: $($_.Exception.Message)"
      }
      $gone = [ScCon]::WaitGone($target, 6000)
      $tries += "$m($note; closed=$gone)"
      if ($gone) { $closedBy = $m; break }
    }
    Write-Output ("{0} 0x{1:x}: method={2} closed={3} tries: {4}" -f $how, $target.ToInt64(), $closedBy, (-not [ScCon]::IsWindow($target)), ($tries -join ' | '))
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
    Write-Output ("attached; console window {0} exists={1}; window with the title: {2}" -f [ScCon]::Describe($hwnd), [ScCon]::IsWindow($hwnd), $(if (($t = [ScCon]::FindByTitle($Title)) -ne [IntPtr]::Zero) { [ScCon]::Describe($t) } else { "none" }))
  }
  default { Write-Output "unknown action $Action"; exit 2 }
}
exit 0
