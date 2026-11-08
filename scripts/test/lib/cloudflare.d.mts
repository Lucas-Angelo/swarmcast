export interface LocalTunnel {
  hostname: string;
  /** Connections of cloudflared registered now. */
  connections: number;
  /** Its name resolves on the stand-in's DNS-over-HTTPS (once a connection registered). */
  known: boolean;
  /** Viewer requests routed to it. */
  requests: number;
}

export interface LocalResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface LocalCloudflare {
  caFile: string;
  caPem: string;
  /** SWARMCAST_TEST_CLOUDFLARE for a SwarmCast process (apps/server/src/tunnel/stand-in.ts). */
  appEnv: { SWARMCAST_TEST_CLOUDFLARE: string };
  /** Playwright context options: *.trycloudflare.com through the stand-in, its certificate accepted. */
  contextOptions: { proxy: { server: string }; ignoreHTTPSErrors: true };
  /** 127.0.0.1:<port> of the public side (HTTPS, the CA's certificate). */
  web: string;
  tunnels(): LocalTunnel[];
  /** From now on the tunnel's address answers 530 (Cloudflare's edge stopped routing to its connections). */
  stopRouting(hostname: string): void;
  request(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<LocalResponse | null>;
  healthz(base: string, headers?: Record<string, string>): Promise<string | null>;
  close(): Promise<void>;
}

/** A local stand-in for Cloudflare's quick-tunnel service, edge, public names and DNS-over-HTTPS (cloudflare.mjs). */
export function startLocalCloudflare(opts: { dir: string; log?: (line: string) => void }): Promise<LocalCloudflare>;

/** The Return of a registerConnection that succeeded (tunnelrpc.capnp ConnectionResponse.connectionDetails), framed. */
export function connectionDetailsReturn(answerId: number, uuid: Buffer): Buffer;
