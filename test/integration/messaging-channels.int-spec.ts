import { createHmac } from 'node:crypto';

import { fakeLineIdToken } from '@collective/integrations/line';
import { type FakeLineChannelApi } from '@integrations/line-channels/fake-line-channel-api';
import { LINE_CHANNEL_API } from '@integrations/line-channels/line-channel-api.port';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, platformToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const ADDRESS = { line1: 'ถนนสุขุมวิท', district: 'คลองเตย', province: 'กรุงเทพมหานคร', postcode: '10110' };
const LINE_SUB = 'U000000000000000000000000000b7701';
const OA_USER = 'U0000000000000000000000000000a771';
const OA_OTHER = 'U0000000000000000000000000000a772';
const SECRET = 'own-oa-channel-secret-0001';

/**
 * B7 deliverable 7.7 part 1 acceptance (D-254): an operator connects its own LINE OA → LINE events arrive signed on
 * the channel's own webhook → a resident who follows gets a single-use link → confirms in the LIFF → that resident's
 * messages go out through the own OA; everybody else stays on the shared getproperty OA. Part 2: every message is
 * metered (shared vs own, replies free), the shared OA's free messages come from a maker-checker rate with a notice at
 * 80 % / 100 %, and a message LINE refuses for quota goes by SMS with one notice to the owner.
 */
describe('own LINE Official Account: connect, link residents, deliver (D-254, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let line: FakeLineChannelApi;
  let owner: { tenantId: string; token: string };
  let resident: string;
  let requestId: string;
  let channelId: string;
  let webhookKey: string;

  const as = () => ({ ...bearer(owner.token), 'X-Tenant-Id': owner.tenantId });
  const today = () => new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const drain = async (n = 6) => {
    for (let i = 0; i < n; i += 1) await t.worker.tick();
  };
  const webhook = (key: string, events: unknown[], secret = SECRET) => {
    const body = JSON.stringify({ destination: 'U0123456789abcdef0123456789abcdef', events });
    return t.http
      .post(`/webhooks/line/${key}`)
      .set('content-type', 'application/json')
      .set('x-line-signature', createHmac('sha256', secret).update(body).digest('base64'))
      .send(body);
  };
  const follow = (userId: string, replyToken: string) => ({
    type: 'follow',
    replyToken,
    source: { type: 'user', userId },
  });
  const linkFrom = (replyToken: string) => {
    const reply = line.replied.find((r) => r.replyToken === replyToken)!;
    const text = (reply.messages[0] as { text: string }).text;
    return decodeURIComponent(/\/link\/oa\?t=([^\s]+)/.exec(text)![1]!);
  };
  const lastLineDelivery = async (eventType: string) =>
    (
      await db.admin.query<{ provider: string; state: string }>(
        `SELECT n.provider, n.state::text FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
          WHERE e.type = $1 AND n.channel = 'line' ORDER BY n.created_at DESC LIMIT 1`,
        [eventType],
      )
    ).rows[0];
  const decide = (costBearer: string) =>
    t.http
      .post(`/v1/owner/service-requests/${requestId}/actions/decide`)
      .set(as())
      .send({ handledBy: 'owner_technician', costBearer })
      .expect(200);

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_messaging' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    line = t.app.get<FakeLineChannelApi>(LINE_CHANNEL_API, { strict: false });
    // Daytime in Bangkok (10:00 tomorrow), outside quiet hours, so deliveries go out at once.
    const morning = new Date(t.clock.now());
    morning.setUTCHours(27, 0, 0, 0);
    t.clock.set(morning);
    const phone = '+66810007701';
    const challenge = await t.http.post('/v1/public/signup/landlord/otp').send({ phone }).expect(200);
    const signup = await t.http.post('/v1/public/signup/landlord').send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName: 'สมใจ มีบ้าน',
    });
    owner = { tenantId: signup.body.tenant.id as string, token: signup.body.tokens.accessToken as string };
    const unitId = (
      await t.http
        .post('/v1/owner/portfolio/units')
        .set(as())
        .send({
          kind: 'house',
          projectName: 'หมู่บ้านตัวอย่าง',
          unitNo: '77/1',
          address: ADDRESS,
          bedrooms: 2,
          bathrooms: 1,
        })
        .expect(201)
    ).body.unitId as string;
    const lessee = (
      await t.http
        .post('/v1/owner/parties')
        .set(as())
        .send({
          type: 'person',
          displayName: 'Ann Example',
          phone: '+66810007702',
          nationality: 'GB',
          idDocumentType: 'passport',
          idNumber: 'X7654321',
        })
        .expect(201)
    ).body.id as string;
    const draft = await t.http
      .post('/v1/owner/leases')
      .set(as())
      .send({ unitId, lesseePartyId: lessee, startDate: today(), months: 12, rent: '18000' })
      .expect(201);
    await t.http
      .post(`/v1/owner/leases/${draft.body.id}/actions/send-for-signature`)
      .set(as())
      .set(idem())
      .expect(200);
    await db.admin.query(
      `UPDATE ops.lease SET status = 'active', signed_document_id = contract_document_id, activated_at = now() WHERE id = $1`,
      [draft.body.id],
    );
    await db.admin.query(
      `INSERT INTO core.occupancy (tenant_id, building_id, unit_id, party_id, role, valid_from, lease_id)
       SELECT tenant_id, building_id, unit_id, $2, 'tenant', start_date, id FROM ops.lease WHERE id = $1`,
      [draft.body.id, lessee],
    );
    const first = await t.http
      .post('/v1/auth/resident/line')
      .send({ idToken: fakeLineIdToken({ sub: LINE_SUB, name: 'Ann' }) })
      .expect(200);
    const R0 = bearer(first.body.accessToken as string);
    const purposes = await t.http.get('/v1/resident/consents').set(R0).expect(200);
    await t.http
      .post('/v1/resident/consents')
      .set(R0)
      .send({
        items: (purposes.body as { key: string; version: number }[]).map((x) => ({
          purposeKey: x.key,
          version: x.version,
          granted: true,
        })),
      })
      .expect(201);
    await db.admin.query(
      `INSERT INTO core.party_user_link (tenant_id, party_id, user_id, linked_via)
       SELECT $1, $2, user_id, 'invitation' FROM core.user_identity WHERE provider_subject = $3`,
      [owner.tenantId, lessee, LINE_SUB],
    );
    resident = (
      await t.http.post('/v1/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(200)
    ).body.accessToken as string;
    const { rows } = await db.admin.query<{ id: string }>(
      `SELECT id FROM ops.service_category WHERE tenant_id IS NULL AND key = 'plumbing'`,
    );
    requestId = (
      await t.http
        .post('/v1/resident/service-requests')
        .set(bearer(resident))
        .set(idem())
        .send({ unitId, categoryId: rows[0]!.id, description: 'ก๊อกน้ำรั่ว' })
        .expect(201)
    ).body.id as string;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('refuses a token LINE does not accept, then connects a working one (credentials sealed)', async () => {
    const refused = await t.http
      .post('/v1/owner/messaging/channels')
      .set(as())
      .send({ lineChannelId: '1650000001', channelSecret: SECRET, accessToken: 'fake-token-revoked-0001' })
      .expect(201);
    expect(refused.body).toMatchObject({ state: 'failing', lastError: expect.stringContaining('401') });

    const connected = await t.http
      .post('/v1/owner/messaging/channels')
      .set(as())
      .send({
        lineChannelId: '1650000001',
        channelSecret: SECRET,
        accessToken: 'fake-token-บ้านสมใจ ไลน์ทางการ',
      })
      .expect(201);
    expect(connected.body).toMatchObject({
      state: 'verified',
      botName: 'บ้านสมใจ ไลน์ทางการ',
      linkedUsers: 0,
    });
    channelId = connected.body.id as string;
    webhookKey = /\/webhooks\/line\/([A-Za-z0-9_-]+)$/.exec(connected.body.webhookUrl as string)![1]!;

    const listed = await t.http.get('/v1/owner/messaging/channels').set(as()).expect(200);
    expect((listed.body as { id: string }[]).map((c) => c.id)).toEqual([channelId]);
    const { rows } = await db.admin.query<{ secret: string; token: string }>(
      `SELECT encode(secret_enc, 'escape') AS secret, encode(token_enc, 'escape') AS token
         FROM platform.messaging_channel WHERE id = $1`,
      [channelId],
    );
    expect(rows[0]!.secret).not.toContain(SECRET);
    expect(rows[0]!.token).not.toContain('fake-token');

    const verified = await t.http
      .post(`/v1/owner/messaging/channels/${channelId}/actions/verify`)
      .set(as())
      .expect(200);
    expect(verified.body.state).toBe('verified');
  });

  it('keeps the shared OA while the resident has not linked the own OA', async () => {
    await decide('owner');
    await drain();
    expect(await lastLineDelivery('service_request.decided')).toEqual({
      provider: 'fake-line',
      state: 'sent',
    });
  });

  it('refuses an unsigned webhook and answers a follow with a single-use link', async () => {
    const forged = await webhook(webhookKey, [follow(OA_USER, 'rt-forged')], 'not-the-secret');
    expect(forged.status).toBe(401);
    expect(forged.body.code).toBe('webhook.signature_invalid');
    expect((await webhook('unknownwebhookkey0000000000', [])).status).toBe(404);

    const res = await webhook(webhookKey, [
      follow(OA_USER, 'rt-1'),
      { type: 'follow', source: { type: 'group' } },
    ]).expect(200);
    expect(res.body).toEqual({ handled: 1 });
    expect(line.replied.find((r) => r.replyToken === 'rt-1')?.token).toBe('fake-token-บ้านสมใจ ไลน์ทางการ');
  });

  it('links the resident once; the link cannot be reused or taken by another login', async () => {
    const link = linkFrom('rt-1');
    const preview = await t.http
      .get(`/v1/resident/messaging-links/${encodeURIComponent(link)}`)
      .set(bearer(resident))
      .expect(200);
    expect(preview.body).toMatchObject({
      tenantName: 'สมใจ มีบ้าน',
      botName: 'บ้านสมใจ ไลน์ทางการ',
      state: 'valid',
    });
    expect(
      (await t.http.get('/v1/resident/messaging-links/no-such-token').set(bearer(resident))).status,
    ).toBe(404);

    const confirmed = await t.http
      .post(`/v1/resident/messaging-links/${encodeURIComponent(link)}/actions/confirm`)
      .set(bearer(resident))
      .expect(200);
    expect(confirmed.body.state).toBe('used');
    expect(line.pushed.at(-1)).toMatchObject({ token: 'fake-token-บ้านสมใจ ไลน์ทางการ', to: OA_USER });

    const again = await t.http
      .post(`/v1/resident/messaging-links/${encodeURIComponent(link)}/actions/confirm`)
      .set(bearer(resident));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('messaging.link_used');

    const channels = await t.http.get('/v1/owner/messaging/channels').set(as()).expect(200);
    expect(channels.body[0].linkedUsers).toBe(1);

    // A linked OA user's messages get no new link.
    await webhook(webhookKey, [
      { type: 'message', replyToken: 'rt-2', source: { type: 'user', userId: OA_USER } },
    ]).expect(200);
    expect(line.replied.some((r) => r.replyToken === 'rt-2')).toBe(false);
  });

  it('expires an unused link after the configured time', async () => {
    await webhook(webhookKey, [follow(OA_OTHER, 'rt-3')]).expect(200);
    const link = linkFrom('rt-3');
    // Past the configured 30 minutes (the access token would have expired too, so the row is aged instead).
    await db.admin.query(
      `UPDATE platform.messaging_link_token SET expires_at = now() - interval '1 minute' WHERE line_user_id = $1`,
      [OA_OTHER],
    );
    const expired = await t.http
      .post(`/v1/resident/messaging-links/${encodeURIComponent(link)}/actions/confirm`)
      .set(bearer(resident));
    expect(expired.status).toBe(410);
    expect(expired.body.code).toBe('messaging.link_expired');
  });

  it('sends the linked resident’s messages through the own OA, back to the shared OA after an unfollow', async () => {
    await decide('tenant');
    await drain();
    expect(await lastLineDelivery('service_request.decided')).toEqual({
      provider: `fake-line:${channelId}`,
      state: 'sent',
    });

    await webhook(webhookKey, [{ type: 'unfollow', source: { type: 'user', userId: OA_USER } }]).expect(200);
    await decide('owner');
    await drain();
    expect(await lastLineDelivery('service_request.decided')).toEqual({
      provider: 'fake-line',
      state: 'sent',
    });
  });

  it('rates: one platform user enters, another publishes; the public pricing shows it', async () => {
    const admin = await adminToken(t);
    const entered = await t.http
      .post('/v1/admin/messaging-rates')
      .set(bearer(admin))
      .set(idem())
      .send({ effectiveFrom: today(), freePerTenant: 4, pricePerMessage: '0.5000', vatPercent: '7.00' })
      .expect(201);
    expect(entered.body).toMatchObject({ state: 'entered', freePerUnit: 0, pricePerMessage: '0.5000' });
    const past = await t.http
      .post('/v1/admin/messaging-rates')
      .set(bearer(admin))
      .set(idem())
      .send({ effectiveFrom: '2020-01-01', freePerTenant: 4, pricePerMessage: '0.5000', vatPercent: '7.00' });
    expect(past.body.code).toBe('messaging_rate.in_the_past');
    const self = await t.http
      .post(`/v1/admin/messaging-rates/${entered.body.id}/actions/publish`)
      .set(bearer(admin));
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('messaging_rate.same_checker');
    await t.http
      .post('/v1/admin/platform-users')
      .set(bearer(admin))
      .set(idem())
      .send({
        email: 'rates-checker@getproperty.invalid',
        displayName: 'Rates checker (test)',
        roles: ['platform_admin'],
        temporaryPassword: 'Checker-Passw0rd-Test!',
      })
      .expect(201);
    const checker = await platformToken(t, 'rates-checker@getproperty.invalid', 'Checker-Passw0rd-Test!');
    await t.http
      .post(`/v1/admin/messaging-rates/${entered.body.id}/actions/publish`)
      .set(bearer(checker))
      .expect(200);
    const pricing = await t.http.get('/v1/public/pricing').expect(200);
    expect(pricing.body).toEqual({
      messaging: {
        effectiveFrom: today(),
        freePerTenant: 4,
        freePerUnit: 0,
        pricePerMessage: '0.5000',
        vatPercent: '7.00',
        repliesFree: true,
      },
      messagingNext: null,
    });
  });

  it('meters every message; the owner hears once when the free messages run out; beyond them is charged', async () => {
    // So far: two messages through the shared OA, one through the own OA, link replies (free).
    await decide('tenant');
    await drain();
    await decide('owner');
    await drain();
    const notices = await db.admin.query<{ kind: string }>(
      `SELECT kind::text FROM platform.messaging_notice WHERE tenant_id = $1 ORDER BY kind`,
      [owner.tenantId],
    );
    expect(notices.rows.map((r) => r.kind).sort()).toEqual(['allowance_100', 'allowance_80']);
    const events = async () =>
      (
        await db.admin.query<{ pct: number }>(
          `SELECT (payload->>'thresholdPct')::int AS pct FROM platform.domain_event
            WHERE type = 'messaging.allowance_threshold' AND tenant_id = $1`,
          [owner.tenantId],
        )
      ).rows;
    expect(await events()).toEqual([{ pct: 100 }]);
    await drain();
    const told = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.notification n JOIN platform.domain_event e ON e.id = n.event_id
        WHERE e.type = 'messaging.allowance_threshold' AND n.channel = 'in_app'`,
    );
    expect(told.rows[0]!.n).toBe(1);

    await decide('tenant');
    await drain();
    expect(await events()).toHaveLength(1);
    const usage = await t.http.get('/v1/owner/messaging/usage').set(as()).expect(200);
    expect(usage.body).toMatchObject({
      shared: {
        counted: 5,
        allowance: 4,
        left: 0,
        usedPercent: 125,
        chargeable: 1,
        pricePerMessage: '0.5000',
        estimatedCharge: '0.50',
        estimatedVat: '0.04',
      },
      own: { counted: 1 },
      quotaFallbacks: 0,
    });
  });

  it('a message LINE refuses for quota goes by SMS, and the owner is told once', async () => {
    const connected = await t.http
      .post('/v1/owner/messaging/channels')
      .set(as())
      .send({ lineChannelId: '1650000002', channelSecret: SECRET, accessToken: 'fake-token-quota-บ้านสมใจ' })
      .expect(201);
    channelId = connected.body.id as string;
    webhookKey = /\/webhooks\/line\/([A-Za-z0-9_-]+)$/.exec(connected.body.webhookUrl as string)![1]!;
    await webhook(webhookKey, [follow(OA_USER, 'rt-q1')]).expect(200);
    await t.http
      .post(`/v1/resident/messaging-links/${encodeURIComponent(linkFrom('rt-q1'))}/actions/confirm`)
      .set(bearer(resident))
      .expect(200);

    const sms = t.sms.sent.length;
    await decide('owner');
    await drain();
    const rows = await db.admin.query<{ channel: string; state: string; failed_reason: string | null }>(
      `SELECT channel::text, state::text, failed_reason FROM platform.notification
        WHERE event_id = (SELECT event_id FROM platform.notification
                           WHERE channel = 'line' AND recipient_type = 'party' ORDER BY created_at DESC LIMIT 1)
          AND recipient_type = 'party'
        ORDER BY channel`,
    );
    expect(rows.rows).toEqual([
      { channel: 'line', state: 'failed', failed_reason: 'line_quota → sms' },
      { channel: 'sms', state: 'sent', failed_reason: null },
    ]);
    expect(t.sms.sent.slice(sms).map((m) => m.to)).toEqual(['+66810007702']);

    await decide('tenant');
    await drain();
    const quota = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'messaging.quota_fallback' AND tenant_id = $1`,
      [owner.tenantId],
    );
    expect(quota.rows[0]!.n).toBe(1);
    const usage = await t.http.get('/v1/owner/messaging/usage').set(as()).expect(200);
    expect(usage.body.quotaFallbacks).toBe(2);
  });

  it('disconnects: the webhook stops and other tenants never see the channel', async () => {
    await t.http.post(`/v1/owner/messaging/channels/${channelId}/actions/revoke`).set(as()).expect(204);
    expect((await t.http.get('/v1/owner/messaging/channels').set(as()).expect(200)).body).toEqual([]);
    expect((await webhook(webhookKey, [follow(OA_USER, 'rt-4')])).status).toBe(404);
    const { rows } = await db.admin.query<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE tenant_id = $1 AND action LIKE 'messaging.%' ORDER BY occurred_at`,
      [owner.tenantId],
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'messaging.channel_connected',
        'messaging.user_linked',
        'messaging.channel_revoked',
      ]),
    );
  });
});
