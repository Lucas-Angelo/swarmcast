// Prepares OBS Studio (macOS, 28+; tested with 33.0.0) for an unattended test run:
//  - skips the first-run auto-configuration wizard, the macOS permissions dialog and "What's new",
//  - enables the built-in obs-websocket server on 127.0.0.1:4455 with a random password,
//  - creates a "SwarmCast" profile (Advanced output, x264 CBR 2500 kbps, keyframe every 2 s, veryfast, 1280x720@30)
//  - creates a "SwarmCast" scene collection with one empty scene (the Media Source is added over obs-websocket),
//  - generates a looping 1280x720 test video (testsrc2 + 1 kHz tone) with ffmpeg.
//
// It refuses to touch an existing OBS configuration unless --force is passed, so it never
// clobbers a real user's setup. Every file it writes is listed on stdout.
//
// Usage: node setup-obs.mjs [--force]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OBS_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio');
export const WS_CONFIG = path.join(OBS_DIR, 'plugin_config', 'obs-websocket', 'config.json');
export const WS_PORT = 4455;
export const PROFILE = 'SwarmCast';
export const COLLECTION = 'SwarmCast';
export const SCENE = 'SwarmCast';
export const MEDIA_FILE = path.join(here, 'artifacts', 'testsrc-720p30.mp4');

// LIBOBS_API_VER for 33.0.0 = (33 << 24) | (0 << 16) | 0. Used for "LastVersion" so OBS does not
// treat the start as an upgrade/first run.
const OBS_VERSION_NUM = (33 << 24) >>> 0;

function ini(sections) {
  return (
    Object.entries(sections)
      .map(([name, kv]) => `[${name}]\n${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n')}\n`)
      .join('\n') + '\n'
  );
}

export function ensureMediaFile() {
  if (fs.existsSync(MEDIA_FILE)) return MEDIA_FILE;
  fs.mkdirSync(path.dirname(MEDIA_FILE), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-t', '60',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      MEDIA_FILE,
    ],
    { stdio: 'inherit' },
  );
  return MEDIA_FILE;
}

/** Returns { password, created: string[] }. */
export function setupObs({ force = false } = {}) {
  const created = [];
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o600 });
    created.push(file);
  };

  if (fs.existsSync(OBS_DIR) && !force) {
    // Already configured (by a previous run, or by a real user): only read the websocket password.
    if (!fs.existsSync(WS_CONFIG)) {
      throw new Error(`${OBS_DIR} exists but has no obs-websocket config. Enable it in OBS (Tools → WebSocket Server Settings) or re-run with --force.`);
    }
    const cfg = JSON.parse(fs.readFileSync(WS_CONFIG, 'utf8'));
    if (!cfg.server_enabled) throw new Error('obs-websocket is disabled in OBS (Tools → WebSocket Server Settings).');
    return { password: cfg.auth_required ? cfg.server_password : '', port: cfg.server_port ?? WS_PORT, created };
  }

  const password = crypto.randomBytes(18).toString('base64url');
  const general = {
    FirstRun: 'true',
    LastVersion: String(OBS_VERSION_NUM),
    Pre31Migrated: 'true',
    'Pre33.0Migrated': 'true',
    MacOSPermissionsDialogLastShown: '1',
    EnableAutoUpdates: 'false',
    InfoIncrement: '999',
    ConfirmOnExit: 'false',
  };
  // App-wide settings (global.ini) and per-user settings (user.ini, OBS 31+). The same
  // [General] flags go in both so it works whichever file a given OBS version reads.
  write(path.join(OBS_DIR, 'global.ini'), ini({ General: general }));
  write(
    path.join(OBS_DIR, 'user.ini'),
    ini({
      General: general,
      Basic: { Profile: PROFILE, ProfileDir: PROFILE, SceneCollection: COLLECTION, SceneCollectionFile: COLLECTION },
      BasicWindow: { SysTrayEnabled: 'true', SysTrayWhenStarted: 'false', WarnBeforeStartingStream: 'false', WarnBeforeStoppingStream: 'false' },
    }),
  );

  // obs-websocket 5.x (bundled with OBS 28+) keeps its settings here. first_load=false stops it
  // from generating its own random password and showing the "connect info" dialog.
  write(
    WS_CONFIG,
    JSON.stringify(
      { alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: password, server_port: WS_PORT },
      null,
      2,
    ) + '\n',
  );

  // Profile: what Settings → Output (Advanced) / Video would write.
  const profileDir = path.join(OBS_DIR, 'basic', 'profiles', PROFILE);
  write(
    path.join(profileDir, 'basic.ini'),
    ini({
      General: { Name: PROFILE },
      Output: { Mode: 'Advanced' },
      AdvOut: { Encoder: 'obs_x264', TrackIndex: '1', ApplyServiceSettings: 'true', RecType: 'Standard' },
      SimpleOutput: { VBitrate: '2500', StreamEncoder: 'x264', Preset: 'veryfast', ABitrate: '160' },
      Video: { BaseCX: '1280', BaseCY: '720', OutputCX: '1280', OutputCY: '720', FPSType: '0', FPSCommon: '30' },
      Audio: { SampleRate: '48000', ChannelSetup: 'Stereo' },
    }),
  );
  // Advanced → Streaming encoder settings (x264). keyint_sec = "Keyframe Interval" in the UI.
  write(
    path.join(profileDir, 'streamEncoder.json'),
    JSON.stringify({ rate_control: 'CBR', bitrate: 2500, keyint_sec: 2, preset: 'veryfast', profile: 'high', tune: '', x264opts: '' }) + '\n',
  );

  // Scene collection with a single empty scene and no global audio devices (so OBS does not add
  // "Mic/Aux" / "Desktop Audio", which would trigger macOS microphone/screen-recording prompts).
  const sceneUuid = crypto.randomUUID();
  write(
    path.join(OBS_DIR, 'basic', 'scenes', `${COLLECTION}.json`),
    JSON.stringify(
      {
        name: COLLECTION,
        current_scene: SCENE,
        current_program_scene: SCENE,
        scene_order: [{ name: SCENE }],
        sources: [
          {
            name: SCENE,
            uuid: sceneUuid,
            id: 'scene',
            versioned_id: 'scene',
            settings: { id_counter: 0, custom_size: false, items: [] },
            mixers: 0,
            enabled: true,
            muted: false,
            volume: 1.0,
          },
        ],
        groups: [],
        transitions: [],
        quick_transitions: [],
        saved_projectors: [],
        modules: {},
      },
      null,
      2,
    ) + '\n',
  );

  return { password, port: WS_PORT, created };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = setupObs({ force: process.argv.includes('--force') });
  const media = ensureMediaFile();
  console.log(r.created.length ? `Created:\n  ${r.created.join('\n  ')}` : `OBS already configured in ${OBS_DIR} (nothing written).`);
  console.log(`obs-websocket: ws://127.0.0.1:${r.port} (password in ${WS_CONFIG})`);
  console.log(`Test video: ${media}`);
}
