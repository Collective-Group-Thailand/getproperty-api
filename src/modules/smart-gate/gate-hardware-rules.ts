import { type Plate } from './gate-rules';

/**
 * Pure rules of J4.2 (D-316, D-317, D-328): LPR plate normalisation and matching, the resident-open geofence, the
 * per-gate open interval and the SOS visit window. No I/O — unit-tested in `gate-hardware-rules.spec.ts`.
 */

export interface LprPlate {
  category: string;
  number: string;
  province: string | null;
}

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
const toArabic = (s: string) => s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));

/**
 * A camera read → the plate as the gate stores it, or null when it cannot be a Thai plate: Thai numerals become
 * Arabic, spaces / dashes / dots are dropped, the category must be 1–4 Thai consonants / digits with a consonant, the
 * number 1–4 digits (leading zeros of a 4-digit read kept as read), the province trimmed (null when not read).
 */
export function normaliseLprPlate(input: {
  category: string;
  number: string;
  province?: string | null;
}): LprPlate | null {
  const category = toArabic(input.category).replace(/[\s.-]/g, '');
  const number = toArabic(input.number).replace(/[\s.-]/g, '');
  const province = input.province?.trim().replace(/\s+/g, ' ') || null;
  if (!/^[0-9ก-ฮ]{1,4}$/.test(category) || !/[ก-ฮ]/.test(category)) return null;
  if (!/^[0-9]{1,4}$/.test(number)) return null;
  if (province && province.length > 60) return null;
  return { category, number, province };
}

export interface PlateCandidate {
  id: string;
  unitId: string;
  source: 'resident_vehicle' | 'remembered_vehicle';
  plate: Plate;
}

export type PlateMatchResult =
  | { match: 'resident_vehicle' | 'remembered_vehicle'; candidate: PlateCandidate }
  | { match: 'ambiguous' | 'none' };

/**
 * The vehicle a read belongs to: category + number equal, and the province equal when the camera read one. Without a
 * province only a single unit may match (two units with the same category + number in other provinces = ambiguous —
 * the guard decides). Resident vehicles win over remembered cars of the same unit.
 */
export function matchPlate(read: LprPlate, candidates: readonly PlateCandidate[]): PlateMatchResult {
  const hits = candidates.filter(
    (c) =>
      c.plate.category === read.category &&
      c.plate.number === read.number &&
      (read.province === null || c.plate.province === read.province),
  );
  if (!hits.length) return { match: 'none' };
  const units = new Set(hits.map((h) => `${h.unitId}|${h.plate.province}`));
  if (units.size > 1) return { match: 'ambiguous' };
  const best = hits.find((h) => h.source === 'resident_vehicle') ?? hits[0]!;
  return { match: best.source, candidate: best };
}

/** Great-circle distance in metres (haversine, mean Earth radius). */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The largest GPS accuracy credited to the resident (a vague fix never widens the fence by more). */
export const MAX_ACCURACY_CREDIT_M = 100;

/** Inside the estate's fence: distance ≤ radius + min(accuracy, 100 m). Only the boolean is ever recorded. */
export function insideGeofence(
  estate: { lat: number; lng: number },
  claim: { lat: number; lng: number; accuracyM?: number | null },
  radiusM: number,
): boolean {
  const credit = Math.min(Math.max(claim.accuracyM ?? 0, 0), MAX_ACCURACY_CREDIT_M);
  return distanceMetres(estate, claim) <= radiusM + credit;
}

/** Seconds until the gate may open again (0 = now), from the last open of the gate. */
export function openRetryAfter(lastOpenAt: Date | null, now: Date, minIntervalS: number): number {
  if (!lastOpenAt) return 0;
  const left = lastOpenAt.getTime() + minIntervalS * 1000 - now.getTime();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * A visit is linked to an SOS when it was inside at the time: entered at or before the SOS and not exited before the
 * SOS minus the window (someone who just left may still matter).
 */
export function visitActiveAt(
  visit: { enteredAt: Date | null; exitedAt: Date | null },
  at: Date,
  windowMinutes: number,
): boolean {
  if (!visit.enteredAt || visit.enteredAt.getTime() > at.getTime()) return false;
  return !visit.exitedAt || visit.exitedAt.getTime() >= at.getTime() - windowMinutes * 60_000;
}

/** The resident may still cancel an SOS. */
export function sosCancellable(createdAt: Date, now: Date, cancelSeconds: number): boolean {
  return now.getTime() - createdAt.getTime() <= cancelSeconds * 1000;
}

/**
 * CR-017 / D-330: a plate read is late (history, never acted on) when the camera read it more than `maxAgeSeconds`
 * before it reached the cloud, or when its read time is unreadable. A read time slightly ahead of the cloud clock
 * (gateway clock skew, up to `maxSkewSeconds`) is live; further ahead the gateway clock is suspect and the read cannot
 * be proven live, so it is history too (D-336, J review A2 — otherwise a wrong edge clock bypasses CR-017).
 */
export function isLateRead(
  detectedAt: Date,
  receivedAt: Date,
  maxAgeSeconds: number,
  maxSkewSeconds = 60,
): boolean {
  const t = detectedAt.getTime();
  if (Number.isNaN(t)) return true;
  if (readClockSuspect(detectedAt, receivedAt, maxSkewSeconds)) return true;
  return receivedAt.getTime() - t > maxAgeSeconds * 1000;
}

/** D-336 (J review A2): the read time is further ahead of the cloud clock than the allowed gateway skew. */
export function readClockSuspect(detectedAt: Date, receivedAt: Date, maxSkewSeconds: number): boolean {
  const t = detectedAt.getTime();
  return !Number.isNaN(t) && t - receivedAt.getTime() > maxSkewSeconds * 1000;
}

/**
 * D-336 (J review A6): a known car read with enough confidence enters on its own only when the camera read the
 * province — category + number alone may be the same plate of another province; the guard confirms instead.
 */
export function lprAutoEntry(read: LprPlate, confident: boolean): boolean {
  return confident && read.province !== null;
}
