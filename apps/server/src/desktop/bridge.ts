import { EventEmitter } from 'node:events';
import { effectiveUpdateChannel, type DesktopAutostartState, type DesktopInfo, type DesktopSystemCheckRun, type DesktopUpdate, type DesktopUpdateChannelState, type UpdateChannel } from '@swarmcast/shared';
import type { Autostart } from './autostart.js';
import { encodeDesktopMessage, type DesktopOutMessage } from './protocol.js';

/** "Check for updates" shows as checking until the shell answers, at most this long. */
export const UPDATE_CHECK_TIMEOUT_MS = 60_000;

export interface DesktopBridgeOptions {
  /** Version of the desktop app (SWARMCAST_DESKTOP_VERSION), else the server's. */
  version: string;
  serverVersion: string;
  autostart: Autostart;
  /** Writes one protocol message for the shell (stdout). */
  send: (msg: DesktopOutMessage) => void;
}

/** Where the update channel lives (config.json `updates.channel`). */
export interface UpdateChannelStore {
  get(): UpdateChannel | undefined;
  save(channel: UpdateChannel): void;
}

/**
 * Desktop-mode state the panel shows (GET /api/desktop and the `desktop` WebSocket message):
 * autostart, update status from the shell, and the first-run system check. Requests from the
 * panel that the shell carries out (check / install updates) go out through `send`.
 */
export class DesktopBridge extends EventEmitter<{ changed: [] }> {
  update: DesktopUpdate | null = null;
  updateChecking = false;
  systemCheck: DesktopSystemCheckRun = 'idle';
  private autostartState: DesktopAutostartState;
  private checkTimer: NodeJS.Timeout | null = null;
  private channelStore: UpdateChannelStore | null = null;

  constructor(private readonly o: DesktopBridgeOptions) {
    super();
    this.autostartState = { supported: o.autostart.supported, enabled: false };
  }

  /** Current state; `fresh` reads the autostart entry back from the OS (otherwise the last value read). */
  async info(fresh = false): Promise<DesktopInfo> {
    if (fresh) this.autostartState = await this.o.autostart.status();
    return this.snapshot();
  }

  snapshot(): DesktopInfo {
    return {
      desktop: true,
      version: this.o.version,
      serverVersion: this.o.serverVersion,
      autostart: this.autostartState,
      update: this.update,
      updateChecking: this.updateChecking,
      updateChannel: this.updateChannel(),
      systemCheck: this.systemCheck,
    };
  }

  async setAutostart(enabled: boolean): Promise<DesktopInfo> {
    try {
      this.autostartState = await this.o.autostart.set(enabled);
    } finally {
      this.changed();
    }
    return this.snapshot();
  }

  /** Update status from the shell. */
  setUpdate(update: DesktopUpdate): void {
    this.update = update;
    this.stopChecking();
    this.changed();
  }

  /** The config the channel is read from and saved to (createApp, once the config is loaded). */
  useUpdateChannel(store: UpdateChannelStore): void {
    this.channelStore = store;
  }

  updateChannel(): DesktopUpdateChannelState {
    const choice = this.channelStore?.get() ?? null;
    return { choice, effective: effectiveUpdateChannel(choice, this.o.version) };
  }

  /** Tells the shell the channel (at start; the shell resolves "automatic" itself). */
  sendUpdateChannel(): void {
    this.o.send({ type: 'update-channel', channel: this.updateChannel().choice });
  }

  /**
   * "Get beta versions" on (beta) or off (stable): saved, sent to the shell. When the channel in
   * use changes, the shell checks again right away, so the panel shows "checking" until it answers.
   */
  setUpdateChannel(channel: UpdateChannel): DesktopInfo {
    if (!this.channelStore) throw new Error('the update channel is not available yet');
    const before = this.updateChannel().effective;
    this.channelStore.save(channel);
    this.sendUpdateChannel();
    if (this.updateChannel().effective !== before) this.startChecking();
    this.changed();
    return this.snapshot();
  }

  requestUpdateCheck(): void {
    this.o.send({ type: 'update-check' });
    this.startChecking();
    this.changed();
  }

  private startChecking(): void {
    this.updateChecking = true;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      this.updateChecking = false;
      this.changed();
    }, UPDATE_CHECK_TIMEOUT_MS);
    this.checkTimer.unref();
  }

  requestUpdateInstall(): void {
    this.o.send({ type: 'update-install' });
  }

  setSystemCheck(s: DesktopSystemCheckRun): void {
    if (this.systemCheck === s) return;
    this.systemCheck = s;
    this.changed();
  }

  private stopChecking(): void {
    this.updateChecking = false;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  private changed(): void {
    this.emit('changed');
  }
}

/** Protocol line writer that never throws once the shell is gone (EPIPE). */
export interface ProtocolWriter {
  send(msg: DesktopOutMessage): void;
  /** Resolves once everything written so far reached the OS (before process.exit). */
  flush(timeoutMs?: number): Promise<void>;
}

export function createProtocolWriter(stream: NodeJS.WritableStream = process.stdout): ProtocolWriter {
  let dead = false;
  stream.on('error', () => {
    dead = true;
  });
  return {
    send(msg) {
      if (dead) return;
      try {
        // One write per line: the logger and console.log share this stream, so lines never interleave.
        stream.write(encodeDesktopMessage(msg));
      } catch {
        dead = true;
      }
    },
    flush(timeoutMs = 2000) {
      if (dead) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        t.unref();
        try {
          stream.write('', () => {
            clearTimeout(t);
            resolve();
          });
        } catch {
          clearTimeout(t);
          resolve();
        }
      });
    },
  };
}
