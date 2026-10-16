import { type Audience } from '../../surfaces/surfaces';

/**
 * Who performs an action. Internal `bigint` ids stay inside the API (they arrive with the schema in
 * B1.2); the public ids are what tokens and responses carry (contract §3, §4).
 */
export type Actor = UserActor | DeviceActor | SystemActor | WebhookActor;

export interface UserActor {
  type: 'user';
  publicId: string;
  /** `org` (owner, manager, staff, accountant), `tenant` or `platform` (ADR-0003). */
  audience: Exclude<Audience, 'device'>;
  /** Session family id (`sid`), absent for actors built outside a request. */
  sessionId?: string;
  /** Token scopes: `org:<uuid>`, `property:<uuid>`, `lease:<uuid>` (contract §4). */
  scopes: readonly string[];
}

/** A gateway authenticated by its client certificate / device JWT (contract §7, D-130). */
export interface DeviceActor {
  type: 'device';
  publicId: string;
  audience: 'device';
  orgId: string;
  propertyId: string;
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
