import { type DomainEventEnvelope, DomainEvents } from '@core/events/domain-events';
import { EventConsumer } from '@core/events/event-consumer.service';
import { type EventSubscriber, EventSubscriberRegistry } from '@core/events/subscribers';
import { NotificationService } from '@core/notifications/notification.service';
import { ConsentService } from '@core/privacy/consent.service';
import { type FakeQueue } from '@core/queue/fake-queue';
import { QUEUE, QUEUE_NAMES } from '@core/queue/queue.port';
import { type Tx } from '@database/prisma.service';
import { TenantTx } from '@database/tenant-tx';
import { type FakeLineMessaging } from '@integrations/line/fake-line-messaging';
import { LINE_MESSAGING } from '@integrations/line/line-messaging.port';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { bearer, idem, operatorToken, ownerToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

/** Counts what a test subscriber saw; can be told to fail once. */
class CountingSubscriber implements EventSubscriber {
  readonly name = 'test-counter';
  readonly eventTypes = ['setting.changed'];
  seen: string[] = [];
  failNext = false;

  async handle(event: DomainEventEnvelope, tx: Tx): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('transient failure (test)');
    }
    await tx.$executeRaw`SELECT 1`;
    this.seen.push(event.id);
  }
}

/** Next instant at hh:mm Asia/Bangkok strictly after `from`. */
function nextBangkok(from: Date, hh: number, mm = 0): Date {
  const d = new Date(from);
  d.setUTCHours(hh - 7, mm, 0, 0);
  while (d <= from) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * B1.3 acceptance — transactional outbox delivered exactly once to subscribers, workflow SLA breach on a fake clock
 * emitted once, notifications gated by consent and quiet hours.
 */
describe('events, workflow and notifications (B1.3 acceptance, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_events' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  describe('outbox → subscriber exactly once', () => {
    const counter = new CountingSubscriber();

    beforeAll(() => {
      t.app.get(EventSubscriberRegistry).register(counter);
    });

    it('a mutation writes its event + outbox row; the subscriber receives it once, even when redelivered', async () => {
      const owner = await ownerToken(t);
      await t.http
        .put('/v1/owner/settings/reminders.schedule')
        .set(bearer(owner))
        .send({ value: [1, 5], reason: 'ทดสอบ outbox' })
        .expect(200);
      const { rows } = await db.admin.query<{ id: string; state: string }>(
        `SELECT e.id, o.state FROM platform.domain_event e JOIN platform.outbox_message o ON o.event_id = e.id
          WHERE e.type = 'setting.changed' AND e.tenant_id = $1 ORDER BY e.id DESC LIMIT 1`,
        [DEV.tenantId],
      );
      expect(rows[0]!.state).toBe('pending');
      const eventId = rows[0]!.id;

      counter.failNext = true; // first delivery fails, the retry (after its backoff) succeeds
      await t.worker.tick();
      expect(counter.seen.filter((id) => id === eventId)).toHaveLength(0);
      t.clock.advance(60_000);
      await t.worker.tick();
      expect(counter.seen.filter((id) => id === eventId)).toHaveLength(1);
      const { rows: outbox } = await db.admin.query(
        `SELECT state FROM platform.outbox_message WHERE event_id = $1`,
        [eventId],
      );
      expect(outbox[0].state).toBe('published');
      const { rows: inbox } = await db.admin.query(
        `SELECT state, attempts FROM platform.event_consumption WHERE event_id = $1 AND subscriber = 'test-counter'`,
        [eventId],
      );
      expect(inbox).toEqual([{ state: 'processed', attempts: 2 }]);

      // a duplicate delivery (broker redelivery, admin replay) is skipped by the inbox
      const consumer = t.app.get(EventConsumer);
      const again = await consumer.consume({
        id: 'dup',
        name: 'test-counter',
        data: { eventId, subscriber: 'test-counter' },
        attemptsMade: 0,
        attempts: 1,
      });
      expect(again).toBe('skipped');
      expect(counter.seen.filter((id) => id === eventId)).toHaveLength(1);
    });

    it('a failed mutation leaves no event and no outbox row (same transaction)', async () => {
      const before = await db.admin.query(`SELECT count(*)::int AS n FROM platform.outbox_message`);
      const owner = await ownerToken(t);
      await t.http
        .put('/v1/owner/settings/reminders.schedule')
        .set(bearer(owner))
        .send({ value: [1, 9], effectiveFrom: '2020-01-01T00:00:00+07:00', reason: 'ย้อนหลัง (ทดสอบ)' })
        .expect(422);
      const after = await db.admin.query(`SELECT count(*)::int AS n FROM platform.outbox_message`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  describe('after-commit effects are reconciled (review #11, D-225)', () => {
    it('a queue outage after the commit loses no notification: recorded on the inbox, re-queued by the sweep', async () => {
      const queue = t.app.get<FakeQueue>(QUEUE);
      const add = queue.add.bind(queue);
      let outage = true;
      queue.add = (name, jobName, data, options) => {
        if (outage && name === QUEUE_NAMES.notifications)
          return Promise.reject(new Error('redis down (test)'));
        return add(name, jobName, data, options);
      };
      let eventId: string;
      try {
        eventId = await t.app.get(TenantTx).platform(async (tx) => {
          const e = await t.app.get(DomainEvents).record(tx, {
            type: 'slip.review_requested',
            aggregateType: 'slip_review',
            aggregateId: '01a15b00-0000-7000-8000-000000000011',
            tenantId: DEV.tenantId,
            payload: { slipReviewId: '01a15b00-0000-7000-8000-000000000011', reasons: ['amount_below_due'] },
          });
          return e.id;
        });
        await t.worker.tick();
      } finally {
        outage = false;
        queue.add = add;
      }
      const inbox = await db.admin.query(
        `SELECT state, last_error FROM platform.event_consumption WHERE event_id = $1 AND subscriber = 'notifications'`,
        [eventId],
      );
      expect(inbox.rows).toEqual([{ state: 'processed', last_error: expect.stringContaining('redis down') }]);
      const stuck = await db.admin.query(
        `SELECT id FROM platform.notification WHERE event_id = $1 AND state = 'queued'`,
        [eventId],
      );
      expect(stuck.rows.length).toBeGreaterThan(0);
      expect(queue.pending(QUEUE_NAMES.notifications).map((j) => j.id)).not.toContain(
        `n-${stuck.rows[0].id}`,
      );
      t.clock.advance(6 * 60_000);
      expect(await t.app.get(NotificationService).requeueStuck()).toBeGreaterThanOrEqual(stuck.rows.length);
      await t.worker.tick();
      const left = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.notification WHERE event_id = $1 AND state = 'queued'`,
        [eventId],
      );
      expect(left.rows[0].n).toBe(0);
    });
  });

  describe('notifications: consent gating, quiet hours, idempotency', () => {
    it('held without consent, released into quiet hours after consent, delivered once in the morning', async () => {
      const line = t.app.get<FakeLineMessaging>(LINE_MESSAGING);
      const { rows } = await db.admin.query<{ id: string }>(
        `INSERT INTO core.party (tenant_id, type, display_name, first_name, line_user_id) VALUES ($1, 'person', 'ผู้เช่า ไลน์', 'ผู้เช่า', 'U0000000000000000000000000000ab12') RETURNING id`,
        [DEV.tenantId],
      );
      const partyId = rows[0]!.id;
      t.clock.set(nextBangkok(t.clock.now(), 22));
      const recipient = {
        audience: 'resident' as const,
        type: 'party' as const,
        id: partyId,
        tenantId: DEV.tenantId,
        language: 'th',
        line: 'U0000000000000000000000000000ab12',
      };
      const plan = async () =>
        t.app.get(TenantTx).platform(async (tx) => {
          const event = await t.app.get(DomainEvents).record(tx, {
            type: 'tenant.updated',
            aggregateType: 'tenant',
            aggregateId: DEV.tenantId,
            tenantId: DEV.tenantId,
            payload: { fields: [] },
          });
          const data = {
            invoice: { number: 'INV-1', total: '1,000.00', dueDate: '2026-11-05' },
            unit: { unitNo: 'A-201' },
            // B4.3: the published invoice.issued template is LINE Flex built by the billing module
            flex: {
              altText: 'ใบแจ้งหนี้ INV-1',
              contents: {
                type: 'bubble',
                body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'INV-1' }] },
              },
            },
          };
          const input = {
            recipients: [recipient],
            data,
            templateKey: 'invoice.issued',
            consentPurpose: 'resident.service',
          };
          const first = await t.app.get(NotificationService).plan(tx, event, input);
          const second = await t.app.get(NotificationService).plan(tx, event, input); // same event × recipient × channel
          return { event, first, second };
        });
      const { event, first, second } = await plan();
      expect(first).toEqual([]);
      expect(second).toEqual([]);
      const held = await db.admin.query(`SELECT state FROM platform.notification WHERE event_id = $1`, [
        event.id,
      ]);
      expect(held.rows).toEqual([{ state: 'held_no_consent' }]);

      // the resident consents on paper at the office (22:00 → quiet hours)
      await t.app
        .get(ConsentService)
        .record(
          { type: 'party', id: partyId },
          [{ purposeKey: 'resident.service', version: 1, granted: true }],
          {
            channel: 'paper',
            language: 'th',
            tenantIds: [DEV.tenantId],
          },
        );
      await t.worker.tick();
      const quiet = await db.admin.query(
        `SELECT state, scheduled_for FROM platform.notification WHERE event_id = $1`,
        [event.id],
      );
      expect(quiet.rows[0].state).toBe('held_quiet_hours');
      expect(line.pushed.filter((p) => p.to === recipient.line)).toHaveLength(0);

      t.clock.set(nextBangkok(t.clock.now(), 8, 1));
      await t.worker.tick();
      await t.worker.tick();
      const sent = await db.admin.query(
        `SELECT state, provider_message_id FROM platform.notification WHERE event_id = $1`,
        [event.id],
      );
      expect(sent.rows[0].state).toMatch(/^(sent|delivered)$/);
      expect(line.pushed.filter((p) => p.to === recipient.line)).toHaveLength(1);
    });
  });
  describe('workflow SLA on a fake clock (PDPA request, D-025/D-159)', () => {
    let residentToken: string;
    let dsrId: string;

    it('a resident files a request: one per controller tenant, with an SLA timer', async () => {
      await db.admin.query(
        `INSERT INTO core.party (tenant_id, type, display_name, first_name, phone_e164) VALUES ($1, 'person', 'ผู้เช่า ทดสอบ', 'ผู้เช่า', '+660000000055')`,
        [DEV.tenantId],
      );
      t.clock.advance(61_000);
      const challenge = await t.http
        .post('/v1/auth/resident/otp/request')
        .send({ phone: '+660000000055' })
        .expect(200);
      const verified = await t.http
        .post('/v1/auth/resident/otp/verify')
        .send({ challengeId: challenge.body.challengeId, code: t.sms.lastCodeTo('+660000000055') })
        .expect(200);
      residentToken = verified.body.accessToken;
      const res = await t.http
        .post('/v1/resident/data-subject-requests')
        .set(bearer(residentToken))
        .set(idem())
        .send({ kind: 'access' })
        .expect(201);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ tenantId: DEV.tenantId, state: 'received' });
      dsrId = res.body[0].id;
      const timers = await db.admin.query(
        `SELECT t.kind, t.fired_at FROM ops.workflow_timer t JOIN ops.workflow_instance i ON i.id = t.instance_id
          WHERE i.subject_id = $1 ORDER BY t.fire_at`,
        [dsrId],
      );
      expect(timers.rows.map((r: { kind: string }) => r.kind)).toEqual(['sla_warn', 'sla_breach']);
      await t.worker.tick();
      // the Owner is told in-app (and by LINE when linked)
      const owner = await ownerToken(t);
      const inbox = await t.http.get('/v1/owner/notifications').set(bearer(owner)).expect(200);
      expect((inbox.body.data as { eventType: string }[]).map((n) => n.eventType)).toContain('dsr.received');
    });

    it('the Owner moves it along (workflow transition, audited)', async () => {
      const owner = await ownerToken(t);
      const res = await t.http
        .post(`/v1/owner/data-subject-requests/${dsrId}/actions/verify`)
        .set(bearer(owner))
        .send({ notes: 'ยืนยันตัวตนแล้ว' })
        .expect(200);
      expect(res.body.state).toBe('verifying');
      const bad = await t.http
        .post(`/v1/owner/data-subject-requests/${dsrId}/actions/fulfil`)
        .set(bearer(owner))
        .send({})
        .expect(409);
      expect(bad.body.code).toBe('workflow.invalid_transition');
    });

    it('a second operator surface user does not see another user’s inbox items', async () => {
      const manager = await operatorToken(t, '+660000000002');
      const owner = await ownerToken(t);
      const ownerInbox = await t.http.get('/v1/owner/notifications').set(bearer(owner)).expect(200);
      const id = ownerInbox.body.data[0]?.id as string;
      expect(id).toEqual(expect.any(String));
      await t.http.post(`/v1/owner/notifications/${id}/actions/read`).set(bearer(manager)).expect(404);
      await t.http.post(`/v1/owner/notifications/${id}/actions/read`).set(bearer(owner)).expect(204);
    });

    it('past the due time the breach event is emitted exactly once', async () => {
      t.clock.advance(31 * 86_400_000);
      await t.worker.tick();
      await t.worker.tick();
      const breaches = await db.admin.query(
        `SELECT e.id FROM platform.domain_event e WHERE e.type = 'workflow.sla_breached' AND e.payload->>'subjectId' = $1`,
        [dsrId],
      );
      expect(breaches.rows).toHaveLength(1);
      const warnings = await db.admin.query(
        `SELECT e.id FROM platform.domain_event e WHERE e.type = 'workflow.sla_warning' AND e.payload->>'subjectId' = $1`,
        [dsrId],
      );
      expect(warnings.rows).toHaveLength(1);
      const fired = await db.admin.query(
        `SELECT count(*)::int AS n FROM ops.workflow_timer t JOIN ops.workflow_instance i ON i.id = t.instance_id
          WHERE i.subject_id = $1 AND t.fired_at IS NOT NULL`,
        [dsrId],
      );
      expect(fired.rows[0].n).toBe(2);
      // running the sweep again changes nothing
      t.clock.advance(86_400_000);
      await t.worker.tick();
      const again = await db.admin.query(
        `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'workflow.sla_breached' AND payload->>'subjectId' = $1`,
        [dsrId],
      );
      expect(again.rows[0].n).toBe(1);
    });
  });
});
