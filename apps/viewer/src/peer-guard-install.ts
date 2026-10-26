// Side-effect module: must be the first import of watch.ts (see peer-guard.ts).
import { installPeerGuard } from './peer-guard.js';

installPeerGuard();
