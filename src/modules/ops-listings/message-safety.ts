/**
 * D-267: money for a listing is never paid to an account named in a chat — rental scams in Facebook groups start with
 * "transfer the booking to this account". A message that carries a bank account number is refused and the sender is
 * told why. Phone numbers (10 digits starting with 0) are not account numbers and pass.
 */

const SEPARATED =
  /(?<![\d-])\d{3}[- ]\d[- ]\d{5}[- ]\d(?![\d-])|(?<![\d-])\d{3}[- ]\d{6}[- ]\d(?![\d-])|(?<![\d-])\d{3}[- ]\d{3}[- ]\d{4}(?![\d-])/;
const KEYWORDS =
  /(เลขที่?บัญชี|บัญชี|โอน(?:เงิน)?(?:เข้า|มา|ที่)|พร้อมเพย์|promptpay|account|acct|a\/c|transfer)/i;

/** Whether `text` names a bank account number (formatted, long, or next to banking words). */
export function bankAccountIn(text: string): boolean {
  const normal = text.normalize('NFKC').replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50));
  if (SEPARATED.test(normal) && !/(?<![\d-])0[689]\d[- ]\d{3}[- ]\d{4}(?![\d-])/.test(normal)) return true;
  const runs = normal.match(/(?<!\d)\d(?:[\d -]?\d){9,14}(?!\d)/g) ?? [];
  for (const run of runs) {
    const digits = run.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) continue;
    const phone = digits.length === 10 && digits.startsWith('0');
    if (!phone) return true; // 10–15 digits that are not a Thai phone number
    if (KEYWORDS.test(normal)) return true; // a 10-digit run next to "บัญชี", "โอนเข้า", "account"…
  }
  return false;
}
