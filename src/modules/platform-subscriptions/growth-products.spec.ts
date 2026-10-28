import Decimal from 'decimal.js';

import {
  addMonths,
  boostTermsOf,
  boostWindow,
  disputeCredit,
  feeInvoice,
  mediaTermsOf,
  purchaseCharges,
  sponsoredSlots,
} from './growth-products';

describe('G5 growth products (D-297)', () => {
  it('reads boost and media-service terms; anything else is not a product', () => {
    expect(boostTermsOf({ product: 'boost', target: 'listing', days: 7 })).toEqual({
      product: 'boost',
      target: 'listing',
      days: 7,
      months: null,
    });
    expect(
      boostTermsOf({ product: 'boost', target: 'building', months: 1, status: 'proposed' }),
    ).toMatchObject({
      target: 'building',
      days: null,
      months: 1,
    });
    expect(boostTermsOf({ product: 'boost', target: 'listing', days: 7, months: 1 })).toBeNull();
    expect(boostTermsOf({ product: 'boost', target: 'listing' })).toBeNull();
    expect(boostTermsOf({ product: 'boost', target: 'unit', days: 7 })).toBeNull();
    expect(boostTermsOf({ product: 'boost', target: 'listing', days: 0 })).toBeNull();
    expect(boostTermsOf({ product: 'storage_package', sizeBytes: '1' })).toBeNull();
    expect(boostTermsOf(null)).toBeNull();
    expect(mediaTermsOf({ product: 'media_service', service: 'tour_360' })).toEqual({
      product: 'media_service',
      service: 'tour_360',
    });
    expect(mediaTermsOf({ product: 'media_service', service: 'drone' })).toBeNull();
  });

  it('adds calendar months (a missing day becomes the month’s last day)', () => {
    expect(addMonths(new Date('2026-01-31T05:00:00Z'), 1).toISOString()).toBe('2026-02-28T05:00:00.000Z');
    expect(addMonths(new Date('2028-01-31T05:00:00Z'), 1).toISOString()).toBe('2028-02-29T05:00:00.000Z');
    expect(addMonths(new Date('2026-11-15T00:00:00Z'), 2).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('a boost window starts now, or queued after the boost still in force', () => {
    const now = new Date('2026-11-01T03:00:00Z');
    expect(boostWindow(now, { days: 7, months: null }, null)).toEqual({
      startsAt: now,
      endsAt: new Date('2026-11-08T03:00:00Z'),
    });
    const later = new Date('2026-11-05T00:00:00Z');
    expect(boostWindow(now, { days: 30, months: null }, later)).toEqual({
      startsAt: later,
      endsAt: new Date('2026-12-05T00:00:00Z'),
    });
    // an earlier end in the past does not delay the start
    expect(boostWindow(now, { days: null, months: 1 }, new Date('2026-10-01T00:00:00Z'))).toEqual({
      startsAt: now,
      endsAt: new Date('2026-12-01T03:00:00Z'),
    });
  });

  it('sponsored slots: ranked by verified vacancy, freshness, id; N per page; each listing once across pages', () => {
    const c = (id: string, verifiedVacant: boolean, day: number) => ({
      id,
      verifiedVacant,
      publishedAt: new Date(Date.UTC(2026, 9, day)),
    });
    const candidates = [
      c('a', false, 20),
      c('b', true, 1),
      c('c', false, 25),
      c('d', true, 5),
      c('e', false, 25),
    ];
    expect(sponsoredSlots(candidates, 0, 3).map((x) => x.id)).toEqual(['d', 'b', 'c']);
    expect(sponsoredSlots(candidates, 1, 3).map((x) => x.id)).toEqual(['e', 'a']);
    expect(sponsoredSlots(candidates, 2, 3)).toEqual([]);
    expect(sponsoredSlots(candidates, 0, 0)).toEqual([]);
    // the input order does not matter
    expect(sponsoredSlots([...candidates].reverse(), 0, 3).map((x) => x.id)).toEqual(['d', 'b', 'c']);
  });

  it('purchase charges: one line at the version’s price, VAT half-up to satang', () => {
    expect(purchaseCharges('boost', 'โปรโมต 7 วัน', '499', '0.07')).toEqual({
      lines: [
        {
          kind: 'boost',
          description: 'โปรโมต 7 วัน',
          quantity: '1.000',
          unitPrice: '499.0000',
          amount: '499.00',
        },
      ],
      subtotal: '499.00',
      discount: '0.00',
      vatAmount: '34.93',
      total: '533.93',
    });
  });

  it('fee invoice: one line per accrual, a monthly cap per kind as a discount line, VAT on the net', () => {
    const accruals = [
      {
        id: 'a1',
        kind: 'success_fee' as const,
        month: '2026-10',
        amount: '1500.00',
        vatRate: '0.07',
        description: 'x',
      },
      {
        id: 'a2',
        kind: 'success_fee' as const,
        month: '2026-10',
        amount: '1000.00',
        vatRate: '0.07',
        description: 'y',
      },
      {
        id: 'a3',
        kind: 'co_broke_fee' as const,
        month: '2026-10',
        amount: '300.00',
        vatRate: '0.07',
        description: 'z',
      },
    ];
    const none = feeInvoice(accruals, []);
    expect(none.charges).toMatchObject({
      subtotal: '2800.00',
      discount: '0.00',
      vatAmount: '196.00',
      total: '2996.00',
    });
    expect(none.charges.lines.map((l) => l.kind)).toEqual(['success_fee', 'success_fee', 'co_broke_fee']);
    expect(none.capped).toEqual([]);

    const capped = feeInvoice(accruals, [
      { kind: 'success_fee', month: '2026-10', capAmount: '2000' },
      { kind: 'co_broke_fee', month: '2026-10', capAmount: null },
    ]);
    expect(capped.charges.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['success_fee', '1500.00'],
      ['success_fee', '1000.00'],
      ['co_broke_fee', '300.00'],
      ['discount', '-500.00'],
    ]);
    expect(capped.charges).toMatchObject({
      subtotal: '2800.00',
      discount: '500.00',
      vatAmount: '161.00',
      total: '2461.00',
    });
    expect(capped.charged.map((c) => [c.id, c.net])).toEqual([
      ['a1', '1200.00'],
      ['a2', '800.00'],
      ['a3', '300.00'],
    ]);
    // Σ lines = subtotal − discount; Σ charged nets = the net invoiced
    const sumLines = capped.charges.lines.reduce((s, l) => s.plus(l.amount), new Decimal(0));
    expect(sumLines.toFixed(2)).toBe('2300.00');
    expect(capped.charged.reduce((s, c) => s.plus(c.net), new Decimal(0)).toFixed(2)).toBe('2300.00');
    expect(capped.capped).toEqual([
      { kind: 'success_fee', month: '2026-10', total: '2500.00', cap: '2000.00', discount: '500.00' },
    ]);
  });

  it('a cap shared pro rata keeps every satang (rounding remainder on the last accrual)', () => {
    const accruals = ['1', '2', '3'].map((id) => ({
      id,
      kind: 'success_fee' as const,
      month: '2026-10',
      amount: '100.00',
      vatRate: '0.07',
      description: id,
    }));
    const d = feeInvoice(accruals, [{ kind: 'success_fee', month: '2026-10', capAmount: '100.00' }]);
    expect(d.charged.map((c) => c.net)).toEqual(['33.33', '33.33', '33.34']);
    expect(d.charges.total).toBe(new Decimal('100.00').plus('2.33').plus('2.33').plus('2.33').toFixed(2));
  });

  it('a dispute credits the charged net plus VAT, never more than the room', () => {
    expect(disputeCredit('1200.00', '0.07', '5000.00')).toBe('1284.00');
    expect(disputeCredit('1200.00', '0.07', '1000.00')).toBe('1000.00');
  });
});
