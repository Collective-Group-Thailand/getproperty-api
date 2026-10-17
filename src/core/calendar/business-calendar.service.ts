import { TenantTx } from '@database/tenant-tx';
import { Injectable } from '@nestjs/common';

import { type BusinessCalendar } from '../workflow/engine/sla';

const TTL_MS = 10 * 60_000;

/**
 * Thai public holidays (`platform.business_calendar`, seeded 2026–2027) as the engine's `BusinessCalendar` in
 * Asia/Bangkok — used by business-day SLAs and due dates (D-159).
 */
@Injectable()
export class BusinessCalendarService {
  private cached: { at: number; days: Set<string> } | undefined;

  constructor(private readonly db: TenantTx) {}

  async calendar(): Promise<BusinessCalendar> {
    if (!this.cached || Date.now() - this.cached.at > TTL_MS) {
      const rows = await this.db.platform((tx) =>
        tx.businessCalendar.findMany({ where: { calendar: 'th_public' }, select: { holidayDate: true } }),
      );
      this.cached = {
        at: Date.now(),
        days: new Set(rows.map((r) => r.holidayDate.toISOString().slice(0, 10))),
      };
    }
    const days = this.cached.days;
    return { timeZone: 'Asia/Bangkok', isHoliday: (d: string) => days.has(d) };
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
