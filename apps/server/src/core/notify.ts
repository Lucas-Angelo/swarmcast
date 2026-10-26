import { spawn } from 'node:child_process';

/** Best-effort desktop notification. Never throws. */
export function notify(title: string, message: string): void {
  try {
    const clean = (s: string): string => s.replace(/["'`$\\]/g, '');
    if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `display notification "${clean(message)}" with title "${clean(title)}"`], { stdio: 'ignore' }).on('error', () => {});
    } else if (process.platform === 'linux') {
      spawn('notify-send', [title, message], { stdio: 'ignore' }).on('error', () => {});
    } else if (process.platform === 'win32') {
      const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode('${clean(title)}')) | Out-Null; $x.Item(1).AppendChild($t.CreateTextNode('${clean(message)}')) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('SwarmCast').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    }
  } catch {
    /* ignore */
  }
}

/** Open a URL in the default browser. */
export function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* ignore */
  }
}
