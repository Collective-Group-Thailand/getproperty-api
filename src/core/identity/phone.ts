/**
 * Phone numbers are stored in E.164 (D-148). Thai numbers are accepted in local form (`0812345678`,
 * `081-234-5678`) and with the country code (`66812345678`, `+66 81 234 5678`).
 */
export function normalisePhone(input: string): string | null {
  const compact = input.replace(/[\s\-().]/g, '');
  if (/^0\d{8,9}$/.test(compact)) return `+66${compact.slice(1)}`;
  if (/^66\d{8,9}$/.test(compact)) return `+${compact}`;
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  return null;
}

/** For logs and UIs: keeps the last 4 digits (`+66•••••1234`). */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 3)}${'•'.repeat(Math.max(0, e164.length - 7))}${e164.slice(-4)}`;
}
