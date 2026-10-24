import { connect } from 'node:net';
import { type Readable } from 'node:stream';

import { ProviderError } from '@collective/integrations/http';

import { type ScanResult, type VirusScanPort } from './virus-scan.port';

/**
 * ClamAV daemon over TCP with the INSTREAM command (`zINSTREAM\0`, chunks prefixed with a 4-byte big-endian length,
 * a zero-length chunk to finish; the reply is `stream: OK` or `stream: <signature> FOUND`).
 * // UNVERIFIED against a live clamd here (no daemon in the sandbox); written from the clamd protocol docs.
 */
export class ClamAvAdapter implements VirusScanPort {
  readonly mode = 'real' as const;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 60_000,
  ) {}

  scan(stream: Readable): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const reply: Buffer[] = [];
      const fail = (message: string) => {
        socket.destroy();
        reject(new ProviderError('clamav', message));
      };
      socket.setTimeout(this.timeoutMs, () => fail('timeout'));
      socket.on('error', (error) => fail(error.message));
      socket.on('data', (data) => reply.push(data));
      socket.on('end', () => {
        const text = Buffer.concat(reply).toString('utf8').replace(/\0/g, '').trim();
        if (text.endsWith('OK')) resolve({ clean: true });
        else if (text.endsWith('FOUND'))
          resolve({ clean: false, signature: text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '') });
        else reject(new ProviderError('clamav', `unexpected reply "${text.slice(0, 80)}"`));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        stream.on('data', (chunk: Buffer) => {
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(Buffer.concat([size, chunk]));
        });
        stream.on('end', () => socket.write(Buffer.alloc(4)));
        stream.on('error', (error) => fail(error.message));
      });
    });
  }
}
