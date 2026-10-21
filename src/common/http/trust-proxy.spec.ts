import express from 'express';
import request from 'supertest';

import { trustProxy } from './trust-proxy';

function app(hops: number, cidrs?: string) {
  const a = express();
  a.set('trust proxy', trustProxy(hops, cidrs));
  a.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  return a;
}

const ipOf = async (a: express.Express, xff?: string): Promise<string> => {
  const r = request(a).get('/ip');
  if (xff) r.set('X-Forwarded-For', xff);
  return ((await r).body as { ip: string }).ip.replace(/^::ffff:/, '');
};

describe('trustProxy (D-229, review LIFF H2)', () => {
  it('0 hops: the socket peer, whatever X-Forwarded-For says', async () => {
    expect(await ipOf(app(0), '6.6.6.6')).toBe('127.0.0.1');
  });

  it('1 hop (Cloud Run front end): the right-most entry, never the spoofed left-most one', async () => {
    expect(await ipOf(app(1), '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(await ipOf(app(1), '203.0.113.9')).toBe('203.0.113.9');
  });

  it('a hop from a trusted BFF egress is skipped: the client address the BFF forwarded wins', async () => {
    const a = app(1, '198.51.100.0/24');
    // client → liff BFF (forwards 203.0.113.9) → API front end appends the BFF egress 198.51.100.7
    expect(await ipOf(a, '203.0.113.9, 198.51.100.7')).toBe('203.0.113.9');
    // a direct caller cannot pose as the BFF: its real address is appended after the spoofed ones
    expect(await ipOf(a, '6.6.6.6, 198.51.100.7, 192.0.2.44')).toBe('192.0.2.44');
  });
});
