import { randomInt } from 'node:crypto';

import { type AccessHolderKind, type CredentialStatus, type LockVendor } from '@generated/prisma/client';
import { type LockVendorKey } from '@integrations/locks/lock-vendor.port';

/**
 * Pure rules of B5.2 access control (D-070, D-071, D-024, D-157). The one rule that matters most: a credential's life
 * follows the **lease** (residents) or a **time box** (staff, technicians, visitors) — never a balance, an invoice or
 * a reminder. Nothing in `src/modules/smart-access` may import billing or receivables (a unit test scans the folder).
 */

/** Holders whose credentials must end at a time (visitors, staff, technicians); residents and owners follow the lease / role. */
export const TIME_BOXED: readonly AccessHolderKind[] = ['staff', 'visitor', 'technician'];

/** States in which a credential opens (or is about to open) the door. */
export const LIVE_STATUSES: readonly CredentialStatus[] = ['pending', 'active'];

/** A 6-digit keypad code (no leading zero, cryptographically random). */
export function generatePin(): string {
  return String(randomInt(100_000, 1_000_000));
}

/** The vendors with an adapter (others are stored but cannot be driven yet). */
export function adapterVendor(vendor: LockVendor): LockVendorKey | null {
  return vendor === 'ttlock' || vendor === 'tuya' ? vendor : null;
}

/**
 * Window of a work-order code (D-070: staff / technician access is time-boxed): the visit window when the work order
 * has one, else from the visit start (or now) for `defaultHours`; never starting before now.
 */
export function workOrderWindow(
  wo: { scheduledAt: Date | null; scheduledUntil: Date | null },
  now: Date,
  defaultHours: number,
): { validFrom: Date; validTo: Date } {
  const start = wo.scheduledAt && wo.scheduledAt.getTime() > now.getTime() ? wo.scheduledAt : now;
  const end =
    wo.scheduledUntil && wo.scheduledUntil.getTime() > start.getTime()
      ? wo.scheduledUntil
      : new Date(start.getTime() + defaultHours * 3_600_000);
  return { validFrom: start, validTo: end };
}

/** A visitor / staff window must be in the future, end after it starts and last at most `maxDays`. */
export function validWindow(from: Date, to: Date, now: Date, maxDays = 31): string | null {
  if (to.getTime() <= from.getTime()) return 'the window must end after it starts';
  if (to.getTime() <= now.getTime()) return 'the window has already ended';
  if (to.getTime() - from.getTime() > maxDays * 86_400_000) return `at most ${maxDays} days`;
  return null;
}

/** Masked PIN for lists (`••••12`). */
export const maskPin = (pin: string): string => `${'•'.repeat(Math.max(0, pin.length - 2))}${pin.slice(-2)}`;

/** Lease events that end a resident's credentials (D-071) — and nothing else does automatically. */
export const LEASE_END_EVENTS = ['lease.ended', 'lease.terminated'] as const;
