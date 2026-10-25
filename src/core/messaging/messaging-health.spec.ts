import { FakeLineChannelApi } from '@integrations/line-channels/fake-line-channel-api';

import { FakeClock } from '../clock/clock';
import { MessagingChannelsService } from './messaging-channels.service';
import { bangkokMonth } from './messaging-usage.service';

type Row = Record<string, unknown> & { id: string; state: string };

/** The own-OA health check (D-254): a working channel LINE stops accepting is marked failing and the owner told once. */
describe('own LINE OA health check (D-254)', () => {
  const clock = new FakeClock(new Date('2026-11-02T03:00:00Z'));

  function service(token: string, rows: Row[]) {
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      messagingChannel: {
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve({ ...row });
        }),
      },
    };
    const db = { platform: (fn: (t: typeof tx) => unknown) => fn(tx) };
    const keys = { decrypt: jest.fn().mockResolvedValue(token) };
    const settings = { valueAt: jest.fn().mockResolvedValue(6) };
    const svc = new MessagingChannelsService(
      db as never,
      keys as never,
      {} as never,
      settings as never,
      {} as never,
      events as never,
      new FakeLineChannelApi(),
      clock,
    );
    return { svc, events, rows };
  }

  const channel = (state: string): Row => ({
    id: 'c1',
    tenantId: 't1',
    buildingId: null,
    lineChannelId: '1657000001',
    botName: 'หอพักสุขใจ',
    state,
    verifiedAt: new Date('2026-10-01T00:00:00Z'),
    lastCheckedAt: null,
    tokenEnc: new Uint8Array(),
    secretEnc: new Uint8Array(),
  });

  it('marks a working channel failing and emits one notice', async () => {
    const { svc, events, rows } = service('fake-token-revoked-1', [channel('verified')]);
    expect(await svc.healthCheck()).toBe(1);
    expect(rows[0]).toMatchObject({
      state: 'failing',
      lastError: 'LINE refused the channel access token (401)',
    });
    expect(events.record).toHaveBeenCalledTimes(1);
    expect(events.record.mock.calls[0][1]).toMatchObject({
      type: 'messaging.channel_failing',
      tenantId: 't1',
      payload: { name: 'หอพักสุขใจ', reason: 'LINE refused the channel access token (401)' },
    });
  });

  it('does not tell the owner again for a channel already failing, and recovers a fixed one', async () => {
    const failing = service('fake-token-revoked-1', [channel('failing')]);
    await failing.svc.healthCheck();
    expect(failing.events.record).not.toHaveBeenCalled();

    const fixed = service('fake-token-หอพักสุขใจ', [channel('failing')]);
    await fixed.svc.healthCheck();
    expect(fixed.rows[0]).toMatchObject({ state: 'verified', lastError: null, botName: 'หอพักสุขใจ' });
  });

  it('counts usage by the Bangkok month', () => {
    expect(bangkokMonth(new Date('2026-10-31T17:30:00Z'))).toBe('2026-11-01');
    expect(bangkokMonth(new Date('2026-10-31T16:59:00Z'))).toBe('2026-10-01');
  });
});
