// The system's error dialogs on the Android emulator: an app's "isn't responding" (ANR) and "has
// stopped" dialogs. They are windows of the system (AppNotRespondingDialog, AppErrorDialog in
// system_server), titled "Application Not Responding: <process>", "Application Error: <process>"
// (and "Application Wait: <process>" for a debugger's wait), and they take the window focus from
// whatever app is in front until someone answers them. android.ts keeps them off the screen.

/**
 * Settings.Global HIDE_ERROR_DIALOGS: with it on, ActivityTaskManagerService shows no error
 * dialog (it observes the setting) and the system closes an app that does not respond or crashes,
 * as the dialog's "Close app" would (AppErrors: "Just kill the app if there is no dialog to be
 * shown"). The ANR is still logged ("ANR in <process>" in logcat.txt).
 */
export const HIDE_ERROR_DIALOGS = ['settings', 'put', 'global', 'hide_error_dialogs', '1'] as const;

/** The error dialogs listed in `dumpsys window windows`: each one's title, once. */
export function errorDialogs(windows: string): string[] {
  const titles = new Set<string>();
  for (const m of windows.matchAll(/Window\{[0-9a-f]+ u\d+ (Application (?:Not Responding|Error|Wait): [^}]+)\}/g)) titles.add(m[1]!);
  return [...titles];
}
