import { EXAMPLE_KEYS, walk } from './walk.js';

// Examples must be obviously fake (PDPA, D-025). Conventions: contract/spectral/README.md.
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const FAKE_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|test|invalid|example)$/i;
// Thai mobile (06/08/09 + 8 digits) and Bangkok / provincial landlines (0 + area + 7 digits), with or without separators.
const THAI_MOBILE = /(?:\+66|\b0)[\s-]?[689]\d(?:[\s-]?\d){7}\b/g;
const THAI_LANDLINE = /(?:\+66|\b0)[\s-]?[2-7](?:[\s-]?\d){7}\b/g;
const FAKE_PHONE = /^(?:66|0)\d{2}000\d{4}$|^(?:66|0)\d000\d{4}$/;
// Thai national id / tax id: 13 digits, optionally grouped 1-4-5-2-1.
const THIRTEEN_DIGITS = /\b\d(?:[- ]?\d){12}\b/g;
// Thai licence plates: optional leading digit, 1–3 Thai letters, 1–4 digits (`กข 1234`, `1กข 1234`).
const THAI_PLATE = /(?<![\wก-๙])\d?[ก-ฮ]{1,3}[\s-]?\d{1,4}\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Thai national id checksum (mod 11 over the first 12 digits). */
export function thaiIdChecksumValid(digits) {
  if (!/^\d{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(digits[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(digits[12]);
}

export function personalDataIssues(text) {
  const issues = [];
  for (const match of text.matchAll(EMAIL)) {
    if (!FAKE_EMAIL_DOMAIN.test(match[1]))
      issues.push(`email "${match[0]}" is not on a reserved example domain`);
  }
  for (const pattern of [THAI_MOBILE, THAI_LANDLINE]) {
    for (const match of text.matchAll(pattern)) {
      const digits = match[0].replace(/\D/g, '');
      if (!FAKE_PHONE.test(digits))
        issues.push(`phone "${match[0]}" is not in the fake form 08x-000-xxxx / 02-000-xxxx`);
    }
  }
  const ids = new Set();
  for (const match of text.matchAll(THIRTEEN_DIGITS)) {
    const digits = match[0].replace(/\D/g, '');
    ids.add(digits);
    if (!digits.startsWith('0000')) issues.push(`13-digit id "${match[0]}" must start with 0000 (fake)`);
    else if (thaiIdChecksumValid(digits) && digits !== '0000000000000')
      issues.push(`13-digit id "${match[0]}" passes the Thai id checksum: use 0000000000001`);
  }
  for (const match of text.matchAll(THAI_PLATE)) {
    const digits = match[0].replace(/\D/g, '');
    if (!/^0+$/.test(digits)) issues.push(`"${match[0]}" looks like a Thai licence plate; use digits 0000`);
  }
  for (const match of text.matchAll(CARD)) {
    const digits = match[0].replace(/\D/g, '');
    if (!ids.has(digits) && luhn(digits)) issues.push(`"${match[0]}" looks like a card number`);
  }
  return issues;
}

export default function noRealPersonalData(document) {
  const results = [];
  walk(document, [], (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      if (!EXAMPLE_KEYS.has(key)) continue;
      walk({ value }, [...path, key], (inner, innerPath) => {
        for (const [k, v] of Object.entries(inner)) {
          if (typeof v !== 'string' && typeof v !== 'number') continue;
          for (const message of personalDataIssues(String(v))) {
            results.push({
              message,
              path: innerPath.length > path.length + 1 ? [...innerPath.slice(0, -1), k] : [...path, key],
            });
          }
        }
        return true;
      });
    }
    return true;
  });
  return results;
}
