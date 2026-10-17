/**
 * The time source of every rule with a clock (OTP expiry, tokens, SLA timers, quiet hours, retention — D-159).
 * Services inject `CLOCK` instead of calling `new Date()`, so tests drive time with `FakeClock` and the worker and
 * the HTTP process agree on "now" in one place.
 */
export const CLOCK = Symbol('CLOCK');

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Test clock: starts at a fixed instant and moves only when told to. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string = '2026-11-01T02:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = new Date(at).getTime();
  }

  advance(ms: number): Date {
    this.current += ms;
    return this.now();
  }

  advanceMinutes(minutes: number): Date {
    return this.advance(minutes * 60_000);
  }

  advanceDays(days: number): Date {
    return this.advance(days * 86_400_000);
  }
}
