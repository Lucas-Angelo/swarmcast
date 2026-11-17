import { describe, expect, it } from 'vitest';
import { errorDialogs } from '../devices/android-dialogs.js';

// How the device suite finds the system's error dialogs on the Android emulator
// (apps/server/test/devices/android-dialogs.ts) in `dumpsys window windows`: the windows' lines
// as Android 16 prints them, the ANR dialog's from release-rehearsal run 43992741373.

const WINDOWS = `WINDOW MANAGER WINDOWS (dumpsys window windows)
  Window #0 Window{5b1c2e0 u0 NavigationBar0}:
    mDisplayId=0 rootTaskId=1 mSession=Session{8c2b0a1 1206:u0a10170} mClient=android.os.BinderProxy@3c1d
  Window #1 Window{46734a7 u0 Application Not Responding: com.google.android.apps.nexuslauncher}:
    mDisplayId=0 rootTaskId=1 mSession=Session{1f2e3d4 704:1000} mClient=android.os.BinderProxy@9a8b
    mAttrs={(0,0)(wrapxwrap) gr=CENTER sim={adjust=pan} ty=SYSTEM_ALERT fmt=TRANSLUCENT
  Window #2 Window{7f00a11 u0 Application Error: com.google.android.gms.persistent}:
    mDisplayId=0 rootTaskId=1
  Window #3 Window{9e8d7c6 u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity}:
    mDisplayId=0 rootTaskId=12
  Window #4 Window{c0ffee1 u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}:
    mDisplayId=0 rootTaskId=1
`;

describe('errorDialogs', () => {
  it('lists the ANR and crash dialogs by their titles, and no app window', () => {
    // Act
    const dialogs = errorDialogs(WINDOWS);

    // Assert
    expect(dialogs).toEqual(['Application Not Responding: com.google.android.apps.nexuslauncher', 'Application Error: com.google.android.gms.persistent']);
  });

  it('lists a dialog once when its window is named again (mCurrentFocus, focusedApp)', () => {
    // Arrange
    const twice = `${WINDOWS}  mCurrentFocus=Window{46734a7 u0 Application Not Responding: com.google.android.apps.nexuslauncher}\n`;

    // Act
    const dialogs = errorDialogs(twice);

    // Assert
    expect(dialogs.filter((d) => d.startsWith('Application Not Responding'))).toHaveLength(1);
  });

  it('finds none on a screen with only apps and system bars', () => {
    // Arrange
    const apps = WINDOWS.split('\n')
      .filter((l) => !l.includes('Application '))
      .join('\n');

    // Act
    const dialogs = errorDialogs(apps);

    // Assert
    expect(dialogs).toEqual([]);
  });
});
