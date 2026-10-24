import 'reflect-metadata';

import { createHmac } from 'node:crypto';

import {
  buildThaiQrBillPayment,
  crc16,
  FakePaymentProviders,
  FakeSlipVerifier,
  fakeWebhookSecret,
  KbankQrAdapter,
  type Merchant,
  OpnQrAdapter,
  parseSettlementCsv,
  parseThaiQr,
  qrReference,
  ScbQrAdapter,
  signFakeWebhook,
} from '@collective/integrations/payments/qr';

const merchant = (over: Partial<Merchant> = {}): Merchant => ({
  provider: 'kbank',
  merchantRef: '010555012345601',
  accountName: 'Sample Co Ltd',
  credentials: {},
  ...over,
});

describe('Thai QR (Tag 30, EMVCo)', () => {
  it('CRC-16/CCITT-FALSE matches the standard check value', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('builds a dynamic bill-payment QR that reads back with a valid CRC', () => {
    const payload = buildThaiQrBillPayment({
      billerId: '010555012345601',
      ref1: 'INV-2026-00042',
      ref2: 'A-101',
      amount: '5344.00',
      merchantName: 'Sample Co Ltd',
    });
    expect(payload.startsWith('000201010212')).toBe(true);
    expect(payload).toContain('0016A000000677010112');
    expect(payload).toMatch(/5303764/);
    expect(payload).toMatch(/54075344\.00/);
    expect(payload).toMatch(/5802TH/);
    expect(parseThaiQr(payload)).toEqual({
      dynamic: true,
      billerId: '010555012345601',
      ref1: 'INV202600042',
      ref2: 'A101',
      amount: '5344.00',
      currency: '764',
      crcValid: true,
    });
    // one changed digit breaks the CRC
    expect(parseThaiQr(payload.replace('5344.00', '5345.00')).crcValid).toBe(false);
  });

  it('refuses a malformed biller id or amount; references are upper-case alphanumerics ≤ 20', () => {
    expect(() => buildThaiQrBillPayment({ billerId: '123', ref1: 'X', amount: '1.00' })).toThrow(RangeError);
    expect(() => buildThaiQrBillPayment({ billerId: '010555012345601', ref1: 'X', amount: '1.5' })).toThrow(
      RangeError,
    );
    expect(qrReference('inv-2026/00042 ห้อง A-101 long tail')).toBe('INV202600042A101LONG');
    expect(qrReference('inv-2026/00042 ห้อง A-101 long tail').length).toBeLessThanOrEqual(20);
  });
});

describe('fake payment provider', () => {
  it('creates a QR for the merchant and signs callbacks the adapter verifies', async () => {
    const adapter = new FakePaymentProviders().adapter('kbank');
    const qr = await adapter.createQr({
      merchant: merchant(),
      amount: '5344.00',
      reference: 'INV202600042',
      expiresAt: new Date('2026-12-01T00:00:00Z'),
    });
    expect(parseThaiQr(qr.payload)).toMatchObject({
      ref1: 'INV202600042',
      amount: '5344.00',
      crcValid: true,
    });
    const cb = adapter.simulatePayment({
      merchantRef: merchant().merchantRef,
      reference: 'INV202600042',
      amount: '5344.00',
      providerRef: 'KB1',
      paidAt: new Date('2026-11-04T02:15:00Z'),
    });
    const raw = Buffer.from(cb.body);
    expect(adapter.verifyWebhook(cb.headers, raw, merchant())).toBe(true);
    // another merchant's secret, a tampered body or no header → refused
    expect(adapter.verifyWebhook(cb.headers, raw, merchant({ merchantRef: '010555099999901' }))).toBe(false);
    expect(
      adapter.verifyWebhook(cb.headers, Buffer.from(cb.body.replace('5344.00', '1.00')), merchant()),
    ).toBe(false);
    expect(adapter.verifyWebhook({}, raw, merchant())).toBe(false);
    expect(adapter.parseWebhook(cb.headers, raw)).toEqual({
      eventId: 'evt_KB1',
      merchantRef: merchant().merchantRef,
      payments: [
        {
          providerRef: 'KB1',
          reference: 'INV202600042',
          amount: '5344.00',
          paidAt: new Date('2026-11-04T02:15:00Z'),
          status: 'paid',
        },
      ],
    });
    expect(() => adapter.parseWebhook({}, Buffer.from('{"x":1}'))).toThrow();
    // what the provider knows answers status and the daily settlement (Bangkok date)
    expect(await adapter.queryStatus(merchant(), 'INV202600042')).toMatchObject({ providerRef: 'KB1' });
    expect(await adapter.fetchSettlement(merchant(), '2026-11-04')).toHaveLength(1);
    expect(await adapter.fetchSettlement(merchant(), '2026-11-03')).toHaveLength(0);
    expect(signFakeWebhook('x', fakeWebhookSecret('kbank', 'm'))).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('the fake slip verifier recognises JSON slips only', async () => {
    const v = new FakeSlipVerifier();
    const ok = await v.verify(
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.from('{"transRef":"T1","amount":"5344","receiverAccount":"xxx-x-x1234-x"}'),
      ]),
    );
    expect(ok).toMatchObject({
      valid: true,
      transRef: 'T1',
      amount: '5344.00',
      receiverAccount: 'xxx-x-x1234-x',
    });
    expect((await v.verify(Buffer.from('not a slip'))).valid).toBe(false);
  });
});

describe('settlement CSV', () => {
  it('reads rows (BOM, CRLF, optional status) and refuses malformed files', () => {
    const rows = parseSettlementCsv(
      Buffer.from(
        '﻿provider_ref,reference,amount,paid_at,status\r\nKB1,INV202600042,5344,2026-11-04T02:15:00Z\r\nKB2,INV202600043,10.5,2026-11-04T03:00:00Z,reversed\r\n',
      ),
    );
    expect(rows).toEqual([
      {
        providerRef: 'KB1',
        reference: 'INV202600042',
        amount: '5344.00',
        paidAt: new Date('2026-11-04T02:15:00Z'),
        status: 'paid',
      },
      {
        providerRef: 'KB2',
        reference: 'INV202600043',
        amount: '10.50',
        paidAt: new Date('2026-11-04T03:00:00Z'),
        status: 'reversed',
      },
    ]);
    expect(() => parseSettlementCsv(Buffer.from('a,b\n1,2'))).toThrow(/header/);
    expect(() =>
      parseSettlementCsv(Buffer.from('provider_ref,reference,amount,paid_at\nKB1,R,abc,2026-11-04')),
    ).toThrow(/row 2/);
  });
});

describe('real provider adapters (UNVERIFIED against live providers): signature checks', () => {
  const body = Buffer.from('{"event":"paid"}');
  const hex = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');

  it('KBank and SCB: HMAC-SHA256 hex of the raw body with the merchant webhook secret', () => {
    const m = merchant({ credentials: { webhookSecret: 's3cret' } });
    const kbank = new KbankQrAdapter('https://kbank.invalid');
    expect(kbank.verifyWebhook({ 'x-kbank-signature': hex('s3cret', body.toString()) }, body, m)).toBe(true);
    expect(kbank.verifyWebhook({ 'x-kbank-signature': hex('other', body.toString()) }, body, m)).toBe(false);
    const scb = new ScbQrAdapter('https://scb.invalid');
    expect(scb.verifyWebhook({ 'x-scb-signature': hex('s3cret', body.toString()) }, body, m)).toBe(true);
    expect(scb.verifyWebhook({}, body, m)).toBe(false);
  });

  it('Opn: HMAC of `timestamp.body` with the base64-decoded secret, any of the comma-separated signatures', () => {
    const secret = 'opn-secret';
    const m = merchant({
      provider: 'opn',
      credentials: { webhookSecret: Buffer.from(secret).toString('base64') },
    });
    const opn = new OpnQrAdapter('https://opn.invalid');
    const sig = hex(secret, `1730000000.${body.toString()}`);
    expect(
      opn.verifyWebhook(
        { 'omise-signature': `deadbeef,${sig}`, 'omise-signature-timestamp': '1730000000' },
        body,
        m,
      ),
    ).toBe(true);
    expect(
      opn.verifyWebhook({ 'omise-signature': sig, 'omise-signature-timestamp': '1730000001' }, body, m),
    ).toBe(false);
  });

  it('a merchant without its webhook secret cannot be verified (error, not a pass)', () => {
    expect(() => new KbankQrAdapter('https://kbank.invalid').verifyWebhook({}, body, merchant())).toThrow(
      /webhookSecret/,
    );
  });
});
