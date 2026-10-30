export interface ServedRequest {
  method: string;
  path: string;
  status: number;
}

export interface ReleaseServer {
  /** `http://127.0.0.1:<port>` */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Serves the files of `root` on 127.0.0.1 (GET/HEAD, 404 for anything else). */
export function serveDir(root: string, o?: { resolve?: (name: string) => string; onRequest?: (r: ServedRequest) => void }): Promise<ReleaseServer>;
