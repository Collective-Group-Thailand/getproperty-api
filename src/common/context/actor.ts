import { type Audience } from '../../surfaces/surfaces';

/**
 * Who performs an action. Ids are the rows' uuidv7 primary keys — the same ids tokens and responses
 * carry (contract §3, §4; schema-design v2 §1.2).
 */
export type Actor = UserActor | DeviceActor | SystemActor | WebhookActor;

export interface UserActor {
  type: 'user';
  publicId: string;
  /**
   * `operator` (owner, manager, accountant, building staff of a tenant), `resident` (lessees, co-occupants,
   * condo owners), `technician` (external contractors, R2) or `platform` (Collective staff) — ADR-0003, D-151.
   */
  audience: Exclude<Audience, 'device'>;
  /** Session family id (`sid`), absent for actors built outside a request. */
  sessionId?: string;
  /**
   * Token scopes (contract §4): `tenant:<uuid>`, `building:<uuid>` (staff limited to buildings),
   * `lease:<uuid>` / `unit:<uuid>` (residents), `work_order:<uuid>` (technicians).
   */
  scopes: readonly string[];
}

/** A gateway authenticated by its client certificate / device JWT (contract §7, D-130). */
export interface DeviceActor {
  type: 'device';
  publicId: string;
  audience: 'device';
  /** The tenant that operates the device's building (`building.operator_tenant_id`). */
  tenantId: string;
  buildingId: string;
  scopes: readonly string[];
}

export interface SystemActor {
  type: 'system';
  /** Job or subsystem name, for logs only. */
  name: string;
}

export interface WebhookActor {
  type: 'webhook';
  provider: string;
}

export const systemActor = (name: string): SystemActor => ({ type: 'system', name });

/** Stable per-principal key (idempotency scopes, rate limits); never an internal id. */
export function actorKey(actor: Actor | undefined): string {
  if (!actor) return 'anonymous';
  switch (actor.type) {
    case 'user':
      return `${actor.audience}:${actor.publicId}`;
    case 'device':
      return `device:${actor.publicId}`;
    case 'system':
      return `system:${actor.name}`;
    case 'webhook':
      return `webhook:${actor.provider}`;
  }
}
