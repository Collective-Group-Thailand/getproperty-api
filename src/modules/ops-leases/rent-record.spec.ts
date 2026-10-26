import { rentRecordFacts, type RentRecordInvoice } from './rent-record';
import { newLetterCode, normaliseLetterCode } from './rent-record.service';

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const at = (s: string) => new Date(s);
const NOW = at('2026-10-20T05:00:00Z'); // 12:00 Bangkok, 20 Oct 2026

function paid(month: string, due: string, paidAt: string, via = 'webhook'): RentRecordInvoice {
  return {
    periodStart: day(`${month}-01`),
    dueDate: day(due),
    status: 'paid',
    balance: '0.00',
    payments: [{ paidAt: at(paidAt), status: 'confirmed', confirmedVia: via }],
  };
}

describe('rent record facts (D-256)', () => {
  it('counts on time, late and outstanding months from confirmed payments, newest first', () => {
    const facts = rentRecordFacts(
      [
        paid('2026-07', '2026-07-05', '2026-07-04T10:00:00Z'),
        // paid at 23:30 Bangkok on the due date = on time
        paid('2026-08', '2026-08-05', '2026-08-05T16:30:00Z', 'slip_verified'),
        // 00:30 Bangkok the day after = late
        paid('2026-09', '2026-09-05', '2026-09-05T17:30:00Z', 'settlement_file'),
        {
          periodStart: day('2026-10-01'),
          dueDate: day('2026-10-05'),
          status: 'overdue',
          balance: '1500.00',
          payments: [],
        },
      ],
      NOW,
    );
    expect(facts.months).toEqual([
      { month: '2026-10', status: 'outstanding' },
      { month: '2026-09', status: 'late' },
      { month: '2026-08', status: 'on_time' },
      { month: '2026-07', status: 'on_time' },
    ]);
    expect(facts).toMatchObject({
      onTime: 2,
      late: 1,
      outstanding: 1,
      notConfirmed: 0,
      firstMonth: '2026-07',
      lastMonth: '2026-10',
    });
  });

  it('leaves out invoices not yet due, void or draft; payments getproperty did not confirm are not counted', () => {
    const facts = rentRecordFacts(
      [
        {
          periodStart: day('2026-10-01'),
          dueDate: day('2026-10-25'),
          status: 'issued',
          balance: '9000.00',
          payments: [],
        },
        { ...paid('2026-06', '2026-06-05', '2026-06-01T03:00:00Z'), status: 'void' },
        paid('2026-05', '2026-05-05', '2026-05-01T03:00:00Z', 'manual'),
        paid('2026-04', '2026-04-05', '2026-04-01T03:00:00Z', 'slip_review'),
      ],
      NOW,
    );
    expect(facts.months).toEqual([]);
    expect(facts.notConfirmed).toBe(2);
    expect(facts.firstMonth).toBeNull();
  });

  it('a month with two invoices takes the worse one', () => {
    const facts = rentRecordFacts(
      [
        paid('2026-09', '2026-09-05', '2026-09-01T03:00:00Z'),
        paid('2026-09', '2026-09-10', '2026-09-12T03:00:00Z'),
      ],
      NOW,
    );
    expect(facts.months).toEqual([{ month: '2026-09', status: 'late' }]);
  });

  it('letter codes are 10 readable characters and normalise what people type', () => {
    const code = newLetterCode();
    expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{10}$/);
    expect(normaliseLetterCode(' h4n8-r2k7 qx ')).toBe('H4N8R2K7QX');
  });
});
