import { ipAllowed, parseCidrList } from './cidr';

/**
 * Express `trust proxy` for the API (D-229, review LIFF H2). `X-Forwarded-For` is read **from the right**: the socket
 * peer and the next `hops - 1` entries are the platform's own proxies (Cloud Run's front end appends the address it
 * saw), so `req.ip` is the entry `hops` from the right — never the left-most, which the caller controls.
 *
 * `cidrs` (`TRUSTED_PROXY_CIDRS`) are our own BFFs' egress addresses (getproperty-web, getproperty-liff behind Cloud
 * NAT): a hop from one of them is trusted too, so the end user's address that the BFF forwarded becomes `req.ip`.
 * An address outside the list stops the walk, so a direct caller cannot pose as a BFF.
 */
export function trustProxy(hops: number, cidrs?: string): (address: string, index: number) => boolean {
  const list = parseCidrList(cidrs);
  const hasList = (cidrs ?? '').trim() !== '';
  return (address, index) => index < hops || (hasList && ipAllowed(list, address));
}
