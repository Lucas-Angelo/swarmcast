import fs from 'node:fs';

/**
 * Read a small regular file as UTF-8, at most `maxBytes`; null when it is missing, not a regular
 * file or bigger. The size is checked on the opened file and the read stops at `maxBytes + 1`,
 * so a file swapped or grown between the check and the read can never be read whole.
 * O_NONBLOCK: opening a FIFO put at that path does not hang (it is then not a regular file).
 */
export function readSmallFile(file: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    return n > maxBytes ? null : buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
