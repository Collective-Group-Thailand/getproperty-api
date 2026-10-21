import { AppConfig } from '@config/app-config';
import { TenantTx } from '@database/tenant-tx';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { CLOCK, type Clock } from '../clock/clock';
import { TokenService } from '../identity/token.service';
import { SettingsService } from '../settings/settings.service';

/** EMQX HTTP authn / authz answer (EMQX 5 HTTP backend: `{"result": "allow" | "deny" | "ignore"}`). */
export type EmqxResult = 'allow' | 'deny' | 'ignore';

/**
 * Authn request body of collective-infra's EMQX listeners (D-235, T-7): the 8883 mTLS listener sends
 * `transport = "mtls"` with the certificate CN (= username = client id, `peer_cert_as_username = cn`), the ws listener
 * behind Caddy sends `transport = "ws"` with empty certificate fields (D-239, O-012). `password` is the device JWT
 * (device protocol 1.2).
 */
export interface EmqxAuthnRequest {
  transport?: string;
  clientid?: string;
  username?: string;
  password?: string;
  cert_common_name?: string;
  cert_subject?: string;
  peerhost?: string;
}

/** Authz request body (EMQX HTTP authorization source): every publish / subscribe EMQX has not cached (≤ 1 min). */
export interface EmqxAuthzRequest {
  username?: string;
  clientid?: string;
  topic?: string;
  action?: string;
  qos?: string | number;
  retain?: string | boolean;
  peerhost?: string;
}

const GATEWAY_USERNAME = /^gw-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const NAMESPACE = 'gp/v1/';
/** Gateway states with a bootstrapped identity (a revoked or retired gateway is `assigned` / `retired`). */
const CONNECTABLE = new Set(['provisioned', 'online', 'degraded', 'offline']);
/** One audit row per (subject, reason) and minute: a reconnect loop must not flood the audit log. */
const DENY_AUDIT_WINDOW_MS = 60_000;

/** `$share/<group>/<filter>` → `<filter>` (EMQX passes shared subscriptions with their prefix). */
export function stripShare(topic: string): string {
  const m = /^\$share\/[^/]+\/(.+)$/.exec(topic);
  return m?.[1] ?? topic;
}

/**
 * getproperty-api as the EMQX HTTP authn / authz authority for gateways on the shared broker (D-235, blueprint
 * T-7–T-9, O-012 → D-239). Decisions:
 *
 * **authn** — `ignore` for any username that is not `gw-<uuid>` (other products' clients fall through to their own
 * authenticators; getproperty's service users authenticate against EMQX's built-in database on 1883). For
 * `gw-<gatewayId>`: the gateway must exist, be a provisioned, non-retired gateway of a building, its client id must
 * equal the username, and:
 * - `transport = mtls` (8883): the certificate CN (EMQX verified the chain) equals the username, the gateway holds a
 *   current certificate (a revoked one cleared it), and the password is a valid device JWT of that gateway
 *   (`aud=device`, `sub`, unexpired, session family not revoked) — required while the setting
 *   `mqtt.authn.require_device_jwt` is on (default); a password that is sent is always checked;
 * - `transport = ws` (Caddy → 8083, no client certificate): only for a gateway whose WebSocket fallback the platform
 *   admin enabled, and always with a valid device JWT.
 * Anything else is `deny`. **authz** — a gateway publishes only `gp/v1/<id>/{telemetry,health,events,cmd/ack}` (QoS ≤ 1,
 * not retained) and subscribes only to `gp/v1/<id>/{config,cmd}`, from its live `smart.mqtt_acl` rows; the
 * configured service users (`EMQX_SERVICE_USERNAMES`, default `MQTT_USERNAME`) may publish and subscribe below
 * `gp/v1/` (shared subscriptions included); anyone else is denied inside `gp/v1/` (getproperty's namespace) and
 * ignored outside it. Every denial of a gateway is audited (`mqtt.authn_denied` / `mqtt.authz_denied`, never the
 * password).
 */
@Injectable()
export class EmqxAuthService {
  private readonly logger = new Logger(EmqxAuthService.name);
  private readonly recentDenials = new Map<string, number>();

  constructor(
    private readonly db: TenantTx,
    private readonly tokens: TokenService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Service users of getproperty on the internal listener (api, worker, ingest). */
  serviceUsernames(): Set<string> {
    const configured = this.config.get('EMQX_SERVICE_USERNAMES') ?? this.config.get('MQTT_USERNAME') ?? '';
    return new Set(
      configured
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  async authenticate(body: EmqxAuthnRequest): Promise<EmqxResult> {
    const username = str(body.username);
    const m = GATEWAY_USERNAME.exec(username);
    if (!m) {
      // gw-* that is not a gateway id is ours to refuse; everything else belongs to other authenticators
      if (username.startsWith('gw-')) return this.deny('authn', null, username, 'malformed_username', body);
      return 'ignore';
    }
    const gatewayId = m[1]!;
    const transport = str(body.transport);
    if (transport !== 'mtls' && transport !== 'ws')
      return this.deny('authn', gatewayId, username, 'unknown_transport', body);
    if (str(body.clientid) !== username)
      return this.deny('authn', gatewayId, username, 'clientid_mismatch', body);
    const device = await this.db.platform((tx) =>
      tx.device.findUnique({
        where: { id: gatewayId },
        select: {
          id: true,
          kind: true,
          status: true,
          tenantId: true,
          buildingId: true,
          mqttClientId: true,
          certFingerprint: true,
          certNotAfter: true,
          mqttWsFallback: true,
        },
      }),
    );
    const now = this.clock.now();
    if (
      !device ||
      device.kind !== 'gateway' ||
      !CONNECTABLE.has(device.status) ||
      !device.tenantId ||
      !device.buildingId ||
      device.mqttClientId !== username
    )
      return this.deny('authn', gatewayId, username, 'gateway_not_provisioned', body, device);
    const password = str(body.password);
    if (transport === 'mtls') {
      if (str(body.cert_common_name) !== username)
        return this.deny('authn', gatewayId, username, 'certificate_cn_mismatch', body, device);
      if (!device.certFingerprint || !device.certNotAfter || device.certNotAfter.getTime() <= now.getTime())
        return this.deny('authn', gatewayId, username, 'certificate_revoked', body, device);
      const requireJwt = await this.settings
        .valueAt<boolean>('mqtt.authn.require_device_jwt', now)
        .catch(() => true);
      if (!password) {
        if (requireJwt) return this.deny('authn', gatewayId, username, 'device_jwt_missing', body, device);
        return 'allow';
      }
    } else {
      if (!device.mqttWsFallback)
        return this.deny('authn', gatewayId, username, 'ws_fallback_disabled', body, device);
      if (!password) return this.deny('authn', gatewayId, username, 'device_jwt_missing', body, device);
    }
    if (!(await this.validJwt(password, gatewayId)))
      return this.deny('authn', gatewayId, username, 'device_jwt_invalid', body, device);
    return 'allow';
  }

  async authorize(body: EmqxAuthzRequest): Promise<EmqxResult> {
    const username = str(body.username);
    const rawTopic = str(body.topic);
    const action = str(body.action);
    const topic = stripShare(rawTopic);
    const inNamespace = topic.startsWith(NAMESPACE);
    if (this.serviceUsernames().has(username)) {
      if (!inNamespace) return 'ignore';
      return action === 'publish' || action === 'subscribe' ? 'allow' : 'deny';
    }
    const m = GATEWAY_USERNAME.exec(username);
    if (!m) return inNamespace ? 'deny' : 'ignore';
    const gatewayId = m[1]!;
    const deny = (reason: string) =>
      this.deny('authz', gatewayId, username, reason, { topic: rawTopic, action, peerhost: body.peerhost });
    if (body.clientid !== undefined && str(body.clientid) !== username) return deny('clientid_mismatch');
    if (!inNamespace || rawTopic !== topic) return deny('topic_not_allowed');
    if (action !== 'publish' && action !== 'subscribe') return deny('unknown_action');
    if (Number(body.qos ?? 0) > 1) return deny('qos_not_allowed');
    if (action === 'publish' && (body.retain === true || body.retain === 'true'))
      return deny('retain_not_allowed');
    const allowed = await this.db.platform(async (tx) => {
      const device = await tx.device.findUnique({ where: { id: gatewayId }, select: { status: true } });
      if (!device || device.status === 'retired') return false;
      const row = await tx.mqttAcl.findFirst({
        where: { username, action, topic, permission: 'allow', revokedAt: null },
        select: { id: true },
      });
      return row !== null;
    });
    return allowed ? 'allow' : deny('topic_not_allowed');
  }

  private async validJwt(token: string, gatewayId: string): Promise<boolean> {
    try {
      const claims = await this.tokens.verify(token);
      return claims.aud === 'device' && claims.sub === gatewayId;
    } catch {
      return false;
    }
  }

  private async deny(
    kind: 'authn' | 'authz',
    gatewayId: string | null,
    username: string,
    reason: string,
    body: { transport?: string; peerhost?: string; topic?: string; action?: string },
    device?: { tenantId: string | null; buildingId: string | null } | null,
  ): Promise<EmqxResult> {
    const key = `${kind}|${username}|${reason}|${body.topic ?? ''}`;
    const now = Date.now();
    const last = this.recentDenials.get(key);
    if (last === undefined || now - last > DENY_AUDIT_WINDOW_MS) {
      this.recentDenials.set(key, now);
      if (this.recentDenials.size > 10_000) this.recentDenials.clear();
      this.logger.warn({ event: `mqtt_${kind}_denied`, username, reason }, 'EMQX request denied');
      await this.audit.recordAlone({
        action: kind === 'authn' ? 'mqtt.authn_denied' : 'mqtt.authz_denied',
        tenantId: device?.tenantId ?? null,
        buildingId: device?.buildingId ?? null,
        subjectType: 'smart.device',
        subjectId: gatewayId,
        outcome: 'denied',
        metadata: {
          reason,
          username: username.slice(0, 100),
          ...(body.transport ? { transport: str(body.transport).slice(0, 10) } : {}),
          ...(body.topic ? { topic: str(body.topic).slice(0, 200) } : {}),
          ...(body.action ? { mqttAction: str(body.action).slice(0, 20) } : {}),
          ...(body.peerhost ? { peerhost: str(body.peerhost).slice(0, 64) } : {}),
        },
      });
    }
    return 'deny';
  }
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
