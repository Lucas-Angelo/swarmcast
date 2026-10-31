import { loadConfig, persistableConfig, saveConfig, type AppConfig } from './config.js';

/**
 * The one place that writes config.json. `current` is the config object every module reads and
 * changes in place; it stays the same object for the whole run, so they always see live values.
 * save() writes it as persistableConfig decides against the file on disk: values this run chose
 * for itself (a fallback port when a default was busy, the tunnel of `--no-tunnel`) are never
 * written back.
 */
export class ConfigStore {
  constructor(
    private readonly file: string,
    readonly current: AppConfig,
    private readonly run: { noTunnel?: boolean } = {},
  ) {}

  save(): void {
    saveConfig(this.file, persistableConfig(this.current, loadConfig(this.file), this.run));
  }
}
