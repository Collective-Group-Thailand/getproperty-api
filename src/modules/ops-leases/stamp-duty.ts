import Decimal from 'decimal.js';

import { addDays, endDateFor } from './lease-dates';

export type StampDutyPayer = 'lessor' | 'lessee' | 'shared';

export const STAMP_DUTY_PAYER_TH: Record<StampDutyPayer, string> = {
  lessor: 'ผู้ให้เช่า',
  lessee: 'ผู้เช่า',
  shared: 'ผู้ให้เช่าและผู้เช่าคนละครึ่ง',
};
export const STAMP_DUTY_PAYER_EN: Record<StampDutyPayer, string> = {
  lessor: 'the Lessor',
  lessee: 'the Lessee',
  shared: 'the Lessor and the Lessee in equal shares',
};

/**
 * The rent over the whole term (B7.5, O-019): month by month, each month at the rent in force on its first day —
 * the base rent, or the latest agreed increase that has taken effect (D-020: increases are fixed in the lease).
 */
export function rentOverTerm(
  rent: string,
  startDate: string,
  months: number,
  increases: readonly { effectiveFrom: string; rent: string }[] = [],
): Decimal {
  const sorted = [...increases].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  let total = new Decimal(0);
  for (let i = 0; i < months; i += 1) {
    const monthStart = i === 0 ? startDate : addDays(endDateFor(startDate, i), 1);
    const inForce = sorted.filter((r) => r.effectiveFrom <= monthStart).at(-1);
    total = total.plus(inForce?.rent ?? rent);
  }
  return total;
}

/**
 * Stamp duty on a lease (Revenue Code, schedule of stamp duties, instrument 1 ⚖ O-019): `bahtPerThousand` baht for
 * every 1,000 baht or fraction of the rent over the term. Deposits are not rent and are not counted.
 */
export function stampDutyFor(totalRent: Decimal.Value, bahtPerThousand: Decimal.Value): string {
  const thousands = new Decimal(totalRent).dividedBy(1000).ceil();
  return thousands.times(bahtPerThousand).toFixed(2);
}
