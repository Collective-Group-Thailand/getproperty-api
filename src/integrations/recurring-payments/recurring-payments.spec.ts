import { FakeRecurringPayments } from './fake-recurring-payments';
import { RecurringWebhookError, UnconfiguredRecurringPayments } from './recurring-payments.port';

describe('recurring payments port (D-308, O-020)', () => {
  const fake = new FakeRecurringPayments('http://api.test', 'a-very-long-test-secret');

  it('signs and parses its own callbacks; a changed body or another secret fails', () => {
    const e = fake.event({ type: 'charge.succeeded', mandateRef: 'm1', chargeRef: 'c1', amount: '100.00' });
    const parsed = fake.parseWebhook(Buffer.from(e.body), e.headers['x-recurring-signature']);
    expect(parsed).toMatchObject({
      type: 'charge.succeeded',
      mandateRef: 'm1',
      chargeRef: 'c1',
      amount: '100.00',
    });
    expect(() =>
      fake.parseWebhook(Buffer.from(e.body.replace('100.00', '999.00')), e.headers['x-recurring-signature']),
    ).toThrow(RecurringWebhookError);
    const other = new FakeRecurringPayments('http://api.test', 'another-long-test-secret');
    expect(() => other.parseWebhook(Buffer.from(e.body), e.headers['x-recurring-signature'])).toThrow(
      /signature/,
    );
  });

  it('a charge event needs its charge reference', () => {
    const e = fake.event({ type: 'charge.failed', mandateRef: 'm1' });
    expect(() => fake.parseWebhook(Buffer.from(e.body), e.headers['x-recurring-signature'])).toThrow(
      /chargeRef/,
    );
  });

  it('charges are idempotent per key', async () => {
    const m = await fake.createMandate({ reference: 'u:p', method: 'direct_debit' });
    const a = await fake.charge({
      mandateRef: m.mandateRef,
      amount: '1.00',
      reference: 'INV',
      idempotencyKey: 'k1',
    });
    const b = await fake.charge({
      mandateRef: m.mandateRef,
      amount: '1.00',
      reference: 'INV',
      idempotencyKey: 'k1',
    });
    expect(a.chargeRef).toBe(b.chargeRef);
  });

  it('unconfigured (O-020): nothing can be set up', async () => {
    const off = new UnconfiguredRecurringPayments();
    await expect(off.createMandate()).rejects.toThrow(/O-020/);
    expect(() => off.parseWebhook()).toThrow(RecurringWebhookError);
  });
});
