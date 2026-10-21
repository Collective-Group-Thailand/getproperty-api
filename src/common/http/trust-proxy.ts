import { ipAllowed, parseCidrList } from './cidr';

/**
 * Express `trust proxy` for the API (D-229, review LIFF H2; AWS semantics D-230). `X-Forwarded-For` is read **from
 * the right**: the socket peer and the next `hops - 1` entries are the platform's own proxies. Behind the Application
 * Load Balancer `hops` = 1: the ALB is the socket peer and appends the address it saw as the right-most entry, so
 * `req.ip` is that entry — never the left-most, which the caller controls.
 *
 * `cidrs` (`TRUSTED_PROXY_CIDRS`) are where our own BFFs (getproperty-web, getproperty-liff ECS tasks) call from — the
 * VPC's private app subnets, through the internal ALB: a hop from there is trusted too, so the end user's address that
 * the BFF forwarded becomes `req.ip`. An address outside the list stops the walk, so a direct caller cannot pose as a
 * BFF (an internet client is never inside the private subnets).
 */
export function trustProxy(hops: number, cidrs?: string): (address: string, index: number) => boolean {
  const list = parseCidrList(cidrs);
  const hasList = (cidrs ?? '').trim() !== '';
  return (address, index) => index < hops || (hasList && ipAllowed(list, address));
}
