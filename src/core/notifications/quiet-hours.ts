/** Quiet hours (B1.3 prompt: non-urgent resident messages held 21:00–08:00 Asia/Bangkok by default). */
export interface QuietHours {
  start: string;
  end: string;
  timezone: string;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function localParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * When `at` falls in the quiet window, the instant the window ends (the message is released then); otherwise null.
 * Windows may cross midnight (21:00–08:00).
 */
export function quietUntil(at: Date, quiet: QuietHours): Date | null {
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === end) return null;
  const now = localParts(at, quiet.timezone).minute;
  const inside = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inside) return null;
  const wait = (end - now + 24 * 60) % (24 * 60);
  const release = new Date(at.getTime() + wait * 60_000);
  release.setUTCSeconds(0, 0);
  return release;
}
