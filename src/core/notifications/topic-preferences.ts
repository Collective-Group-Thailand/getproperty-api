import { type NotificationChannel, type NotificationTopic } from '@generated/prisma/client';

/** Resident notification topics (LIFF #10, D-203). */
export const NOTIFICATION_TOPICS: readonly NotificationTopic[] = [
  'billing',
  'lease',
  'service_requests',
  'announcements',
  'parcels',
];

/**
 * Topics a resident cannot switch off: invoices, receipts and payment reminders (D-042, D-045) and lease / deposit
 * notices (D-020, D-023, D-061) must reach them. Also a database CHECK on `platform.notification_topic_preference`.
 */
export const LOCKED_TOPICS: readonly NotificationTopic[] = ['billing', 'lease'];

/** Channels a resident chooses per topic in the LIFF profile. */
export const TOPIC_CHANNELS: readonly NotificationChannel[] = ['line', 'sms'];

const PREFIXES: [string, NotificationTopic][] = [
  ['invoice.', 'billing'],
  ['payment.', 'billing'],
  ['receipt.', 'billing'],
  ['slip.', 'billing'],
  ['credit_note.', 'billing'],
  ['debit_note.', 'billing'],
  ['etax.', 'billing'],
  ['lease.', 'lease'],
  ['deposit.', 'lease'],
  ['inspection.', 'lease'],
  ['invitation.', 'lease'],
  ['service.', 'service_requests'],
  ['service_request.', 'service_requests'],
  ['work_order.', 'service_requests'],
  ['announcement.', 'announcements'],
  ['parcel.', 'parcels'],
];

/** The topic of a resident notification (by its template key / event type); null = not a topic (always sent). */
export function topicOf(templateKey: string): NotificationTopic | null {
  return PREFIXES.find(([prefix]) => templateKey.startsWith(prefix))?.[1] ?? null;
}
