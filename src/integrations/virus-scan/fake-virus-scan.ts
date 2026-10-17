import { type Readable } from 'node:stream';

import { type ScanResult, type VirusScanPort } from './virus-scan.port';

/** The EICAR anti-virus test string: the fake flags any file that contains it. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export class FakeVirusScan implements VirusScanPort {
  readonly mode = 'fake' as const;

  async scan(stream: Readable): Promise<ScanResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).includes(EICAR)
      ? { clean: false, signature: 'Eicar-Test-Signature' }
      : { clean: true };
  }
}
