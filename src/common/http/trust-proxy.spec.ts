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

describe('trustProxy (D-229, review LIFF H2; ALB semantics D-230)', () => {
  it('0 hops: the socket peer, whatever X-Forwarded-For says', async () => {
    expect(await ipOf(app(0), '6.6.6.6')).toBe('127.0.0.1');
  });

  it('1 hop (the ALB appends the address it saw): the right-most entry, never the spoofed left-most one', async () => {
    expect(await ipOf(app(1), '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(await ipOf(app(1), '203.0.113.9')).toBe('203.0.113.9');
  });

  it("a hop from the BFFs' private subnets is skipped: the client address the BFF forwarded wins", async () => {
    const a = app(1, '10.40.16.0/20,10.40.32.0/20');
    // client → public ALB → liff task (forwards 203.0.113.9) → internal ALB appends the task's address 10.40.17.23
    expect(await ipOf(a, '203.0.113.9, 10.40.17.23')).toBe('203.0.113.9');
    // an internet caller cannot pose as the BFF: the public ALB appends its real address after the spoofed ones
    expect(await ipOf(a, '6.6.6.6, 10.40.17.23, 192.0.2.44')).toBe('192.0.2.44');
    // nor by naming a private address as its own: only the ALB-appended right-most entry counts
    expect(await ipOf(a, '10.40.17.23, 192.0.2.44')).toBe('192.0.2.44');
  });
});
