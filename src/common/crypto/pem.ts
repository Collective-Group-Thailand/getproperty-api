/** A PEM given either verbatim (with `\n` escapes from env files) or base64-encoded (secret managers, CI vars). */
export function pemFromEnv(value: string): string {
  const unescaped = value.replace(/\\n/g, '\n').trim();
  if (unescaped.startsWith('-----BEGIN')) return `${unescaped}\n`;
  const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
  if (!decoded.startsWith('-----BEGIN')) throw new Error('expected a PEM or base64 of a PEM');
  return `${decoded}\n`;
}
