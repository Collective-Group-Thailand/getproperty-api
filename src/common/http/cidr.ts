import { BlockList, isIP } from 'node:net';

/** Parses `10.0.0.0/8, 203.0.113.7, 2001:db8::/32` into a matcher. Throws on an invalid entry. */
export function parseCidrList(value: string | undefined): BlockList {
  const list = new BlockList();
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [address = '', prefix] = entry.split('/');
    const family = isIP(address);
    if (family === 0) throw new Error(`invalid IP in CIDR list: ${entry}`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const bits = Number(prefix);
    const max = family === 6 ? 128 : 32;
    if (!/^\d+$/.test(prefix) || bits > max) throw new Error(`invalid prefix in CIDR list: ${entry}`);
    list.addSubnet(address, bits, type);
  }
  return list;
}

/** True when `ip` (IPv4, IPv6 or IPv4-mapped IPv6) is inside the list. */
export function ipAllowed(list: BlockList, ip: string | undefined): boolean {
  if (!ip) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return list.check(mapped[1], 'ipv4');
  const family = isIP(ip);
  if (family === 0) return false;
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}
