import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { AccessLifecycle, AccessVendorSync } from './access.subscribers';
import { generatePin, maskPin, TIME_BOXED, validWindow, workOrderWindow } from './access-rules';

const ROOT = __dirname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

describe('access follows the lease, never the bill (D-024, D-071, D-157)', () => {
  it('no file of smart-access imports billing, payments or receivables', () => {
    const offenders = files(ROOT)
      .filter((f) => !f.endsWith('.spec.ts'))
      .flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)]
          .map((m) => m[1]!)
          .filter((spec) =>
            /ops-receivables|ops-billing|ops-payments|receivable|invoice|payment|dunning/i.test(spec),
          )
          .map((spec) => `${f}: ${spec}`),
      );
    expect(offenders).toEqual([]);
  });

  it('the access subscribers listen to lease and work-order events only — no invoice, payment or reminder', () => {
    const types = [
      ...new AccessLifecycle({} as never, {} as never, {} as never, {} as never).eventTypes,
      ...new AccessVendorSync({} as never, {} as never).eventTypes,
    ];
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect(t).toMatch(/^(lease|lock|work_order|access)\./);
    expect(types.some((t) => /invoice|payment|receivable|reminder|penalty|dunning/.test(t))).toBe(false);
  });
});

describe('time boxes (D-070)', () => {
  const now = new Date('2026-11-01T02:00:00Z');

  it('staff, visitors and technicians are time-boxed; residents and owners are not', () => {
    expect([...TIME_BOXED].sort()).toEqual(['staff', 'technician', 'visitor']);
  });

  it('a work-order code covers the visit window, or the default hours from the visit (never before now)', () => {
    expect(
      workOrderWindow(
        { scheduledAt: new Date('2026-11-01T03:00:00Z'), scheduledUntil: new Date('2026-11-01T06:00:00Z') },
        now,
        4,
      ),
    ).toEqual({ validFrom: new Date('2026-11-01T03:00:00Z'), validTo: new Date('2026-11-01T06:00:00Z') });
    expect(workOrderWindow({ scheduledAt: null, scheduledUntil: null }, now, 4)).toEqual({
      validFrom: now,
      validTo: new Date('2026-11-01T06:00:00Z'),
    });
    expect(
      workOrderWindow({ scheduledAt: new Date('2026-10-31T00:00:00Z'), scheduledUntil: null }, now, 2)
        .validFrom,
    ).toEqual(now);
  });

  it('visitor windows: ordered, not over, at most 31 days', () => {
    expect(validWindow(now, new Date('2026-11-01T05:00:00Z'), now)).toBeNull();
    expect(validWindow(now, now, now)).toMatch(/end after/);
    expect(validWindow(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z'), now)).toMatch(
      /ended/,
    );
    expect(validWindow(now, new Date('2026-12-15T00:00:00Z'), now)).toMatch(/31 days/);
  });

  it('PINs are 6 random digits; lists mask them', () => {
    const pins = new Set(Array.from({ length: 50 }, generatePin));
    for (const p of pins) expect(p).toMatch(/^[1-9]\d{5}$/);
    expect(pins.size).toBeGreaterThan(40);
    expect(maskPin('482913')).toBe('••••13');
  });
});
