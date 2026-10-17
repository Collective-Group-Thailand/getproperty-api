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
  /** Platform Support reading into a tenant under a support grant (D-090); audited with every read. */
  supportGrantId?: string;
  /** Authentication methods of the session (`otp`, `pwd`, `totp`, `line`). */
  amr?: readonly string[];
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

/** The actor as stored in `platform.audit_log.actor` / `platform.domain_event.actor` (schema-design §4.8). */
export type ActorEnvelope =
  | {
      type: 'user';
      id: string;
      audience: UserActor['audience'];
      sessionId: string | null;
      supportGrantId: string | null;
    }
  | { type: 'device'; id: string; tenantId: string; buildingId: string }
  | { type: 'system'; name: string }
  | { type: 'webhook'; provider: string };

export function actorEnvelope(actor: Actor | undefined): ActorEnvelope {
  if (!actor) return { type: 'system', name: 'anonymous' };
  switch (actor.type) {
    case 'user':
      return {
        type: 'user',
        id: actor.publicId,
        audience: actor.audience,
        sessionId: actor.sessionId ?? null,
        supportGrantId: actor.supportGrantId ?? null,
      };
    case 'device':
      return { type: 'device', id: actor.publicId, tenantId: actor.tenantId, buildingId: actor.buildingId };
    case 'system':
      return { type: 'system', name: actor.name };
    case 'webhook':
      return { type: 'webhook', provider: actor.provider };
  }
}

/** The uuid of a user or device actor (`audit_log.actor_id`, `created_by`); null for system/webhook actors. */
export function actorIdOf(actor: Actor | undefined): string | null {
  return actor?.type === 'user' || actor?.type === 'device' ? actor.publicId : null;
}

/** The user id of a user actor, else null (`created_by` columns reference core.user_account logically). */
export function userIdOf(actor: Actor | undefined): string | null {
  return actor?.type === 'user' ? actor.publicId : null;
}
