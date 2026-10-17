/** Thai national id checksum (13 digits, mod-11 weights 13…2). Used to refuse typos before sealing (D-148). */
export function isValidThaiId(raw: string): boolean {
  const id = raw.replace(/[\s-]/g, '');
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}
