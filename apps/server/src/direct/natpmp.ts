import dgram from 'node:dgram';
import type { PortMapper } from './mapper.js';

/** NAT-PMP (RFC 6886) client: external address + TCP mappings. */
export class NatPmpGateway implements PortMapper {
  readonly kind = 'natpmp' as const;

  constructor(
    readonly gateway: string,
    private readonly port = 5351,
  ) {}

  get id(): string {
    return `${this.gateway}:${this.port}`;
  }

  private request(msg: Buffer, expectOp: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      let timeout = 250;
      let attempts = 0;
      let timer: NodeJS.Timeout;
      const cleanup = (): void => {
        clearTimeout(timer);
        try {
          sock.close();
        } catch {
          /* closed */
        }
      };
      const send = (): void => {
        if (attempts++ >= 6) {
          cleanup();
          reject(new Error('NAT-PMP gateway did not answer'));
          return;
        }
        sock.send(msg, this.port, this.gateway);
        timer = setTimeout(send, timeout);
        timeout *= 2;
      };
      sock.on('message', (res) => {
        if (res.length < 4 || res[1] !== expectOp) return;
        cleanup();
        const result = res.readUInt16BE(2);
        if (result !== 0) reject(new Error(`NAT-PMP error ${result}`));
        else resolve(res);
      });
      sock.on('error', (e) => {
        cleanup();
        reject(e);
      });
      send();
    });
  }

  async externalIp(): Promise<string> {
    const res = await this.request(Buffer.from([0, 0]), 128);
    return `${res[8]}.${res[9]}.${res[10]}.${res[11]}`;
  }

  async map(externalPort: number, internalPort: number, _host: string, _desc: string, leaseSeconds: number): Promise<void> {
    const msg = Buffer.alloc(12);
    msg[0] = 0;
    msg[1] = 2; // map TCP
    msg.writeUInt16BE(internalPort, 4);
    msg.writeUInt16BE(externalPort, 6);
    msg.writeUInt32BE(leaseSeconds || 7200, 8);
    const res = await this.request(msg, 130);
    const mapped = res.readUInt16BE(10);
    if (mapped !== externalPort) {
      // We asked for a specific port; give it back and fail if the gateway chose another.
      await this.unmapInternal(internalPort).catch(() => {});
      throw new Error(`gateway assigned port ${mapped} instead of ${externalPort}`);
    }
    this.internalByExternal.set(externalPort, internalPort);
  }

  private internalByExternal = new Map<number, number>();

  private async unmapInternal(internalPort: number): Promise<void> {
    const msg = Buffer.alloc(12);
    msg[1] = 2;
    msg.writeUInt16BE(internalPort, 4);
    await this.request(msg, 130);
  }

  async unmap(externalPort: number, internalPort?: number): Promise<void> {
    const internal = internalPort ?? this.internalByExternal.get(externalPort) ?? externalPort;
    await this.unmapInternal(internal);
    this.internalByExternal.delete(externalPort);
  }

  /** NAT-PMP cannot list mappings; we assume removal worked when the gateway acknowledged it. */
  async hasMapping(externalPort: number): Promise<boolean> {
    return this.internalByExternal.has(externalPort);
  }
}
