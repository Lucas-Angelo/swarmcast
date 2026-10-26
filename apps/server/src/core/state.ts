import fs from 'node:fs';
import { z } from 'zod';
import { writePrivateFile } from './paths.js';

/** Small local-only state that must survive restarts (never secrets, never viewer data). */
const stateSchema = z.object({
  lastDirectIp: z.string().optional(),
  lastDirectAt: z.number().optional(),
  /** Port mapping currently open on the router; cleared once removed. Used to clean up after a crash. */
  activeMapping: z
    .object({
      kind: z.enum(['upnp', 'natpmp']),
      id: z.string(),
      externalPort: z.number().int(),
      internalPort: z.number().int(),
      createdAt: z.number(),
    })
    .nullable()
    .optional(),
});

export type LocalState = z.infer<typeof stateSchema>;

export interface StateStore {
  load(): LocalState;
  save(state: LocalState): void;
}

export class FileStateStore implements StateStore {
  constructor(private readonly file: string) {}
  load(): LocalState {
    try {
      return stateSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return {};
    }
  }
  save(state: LocalState): void {
    writePrivateFile(this.file, JSON.stringify(state, null, 2) + '\n');
  }
}

export class MemoryStateStore implements StateStore {
  constructor(public state: LocalState = {}) {}
  load(): LocalState {
    return structuredClone(this.state);
  }
  save(state: LocalState): void {
    this.state = structuredClone(state);
  }
}
