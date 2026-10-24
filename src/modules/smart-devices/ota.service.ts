import { createPublicKey, verify } from 'node:crypto';
import { type Readable } from 'node:stream';

import { OBJECT_STORAGE, type ObjectStorage } from '@collective/integrations/storage';
import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { DomainException } from '@common/errors/domain.exception';
import { AppConfig } from '@config/app-config';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { DomainEvents } from '@core/events/domain-events';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import { type OtaRing, type Prisma, type RolloutStatus } from '@generated/prisma/client';
import { sortKeys } from '@modules/ingest/protocol/device-protocol-schema';
import { Inject, Injectable } from '@nestjs/common';

import { DeviceCommandsService } from './commands.service';

/** The signed OTA manifest produced by `getproperty-edge` (`pnpm image`, edge CR-011). */
export interface OtaManifest {
  schema: 1;
  version: string;
  channel: 'stable' | 'beta' | 'canary';
  arch: 'arm64' | 'x64' | 'armv7';
  artifact: { url: string; sha256: string; size: number };
  minAgentVersion: string | null;
  releasedAt: string;
  signature: { alg: 'ed25519'; keyId: string; value: string };
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Semver comparison (pre-releases sort before the release). */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  if (pa[4] && !pb[4]) return -1;
  if (!pa[4] && pb[4]) return 1;
  return (pa[4] ?? '').localeCompare(pb[4] ?? '');
}

/** Canonical JSON of the manifest without its signature (keys sorted recursively, no whitespace). */
export function canonicalManifest(
  manifest: Omit<OtaManifest, 'signature'> & { signature?: unknown },
): string {
  const { signature: _signature, ...rest } = manifest;
  return JSON.stringify(sortKeys(rest));
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Verifies the ed25519 signature of a manifest against the trusted key ids (`OTA_SIGNING_PUBLIC_KEYS`). */
export function verifyManifest(manifest: OtaManifest, keys: Record<string, string>): boolean {
  const key = keys[manifest.signature?.keyId];
  if (!key || manifest.signature.alg !== 'ed25519') return false;
  try {
    const publicKey = key.includes('BEGIN PUBLIC KEY')
      ? createPublicKey(key)
      : createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key, 'base64')]),
          format: 'der',
          type: 'spki',
        });
    return verify(
      null,
      Buffer.from(canonicalManifest(manifest)),
      publicKey,
      Buffer.from(manifest.signature.value, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Shape checks of an uploaded manifest (the agent refuses the same things, edge CR-011). */
export function manifestProblems(m: Partial<OtaManifest>): string[] {
  const p: string[] = [];
  if (m.schema !== 1) p.push('schema must be 1');
  if (!m.version || !SEMVER.test(m.version)) p.push('version must be semver');
  if (!m.arch || !['arm64', 'x64', 'armv7'].includes(m.arch)) p.push('arch must be arm64 | x64 | armv7');
  if (!m.channel || !['stable', 'beta', 'canary'].includes(m.channel))
    p.push('channel must be stable | beta | canary');
  if (!m.artifact || typeof m.artifact.url !== 'string' || !m.artifact.url.startsWith('https://'))
    p.push('artifact.url must be https');
  if (!m.artifact || !/^[0-9a-f]{64}$/i.test(m.artifact.sha256 ?? ''))
    p.push('artifact.sha256 must be 64 hex');
  if (!m.artifact || !Number.isInteger(m.artifact.size) || m.artifact.size <= 0)
    p.push('artifact.size must be > 0');
  if (m.minAgentVersion !== null && m.minAgentVersion !== undefined && !SEMVER.test(m.minAgentVersion))
    p.push('minAgentVersion must be semver or null');
  if (!m.releasedAt || Number.isNaN(Date.parse(m.releasedAt))) p.push('releasedAt must be an ISO date-time');
  if (!m.signature || m.signature.alg !== 'ed25519' || !m.signature.keyId || !m.signature.value)
    p.push('signature { alg: ed25519, keyId, value } required');
  return p;
}

/** Device-surface path of release artefacts served by the API from the product bucket (D-231). */
export const OTA_ARTIFACT_PATH = '/v1/device/ota/artifacts/';
/** Bucket prefix of release artefacts (`releases/edge/<version>/<file>`); read-only for the app's instance role. */
export const OTA_ARTIFACT_KEY_PREFIX = 'releases/edge/';
const ARTIFACT_FILE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;

/**
 * `<origin>/v1/device/ota/artifacts/<version>/<file>` (or the relative path) → its bucket key; `null` for an artefact
 * on another origin or path (a CDN / presigned URL, fetched by the agent without credentials).
 */
export function deviceArtifact(url: string): { version: string; file: string; key: string } | null {
  let path: string;
  try {
    path = new URL(url, 'https://device.invalid').pathname;
  } catch {
    return null;
  }
  if (!path.startsWith(OTA_ARTIFACT_PATH)) return null;
  const parts = path.slice(OTA_ARTIFACT_PATH.length).split('/');
  if (parts.length !== 2) return null;
  const [version, file] = parts as [string, string];
  if (!SEMVER.test(version) || !ARTIFACT_FILE.test(file) || file.includes('..')) return null;
  return { version, file, key: `${OTA_ARTIFACT_KEY_PREFIX}${version}/${file}` };
}

/**
 * A URL handed to a gateway for the `/v1/device/*` surface: on `DEVICE_PUBLIC_BASE_URL` when set, else relative (the
 * agent resolves it against its device host). Never the public API host, which strips client certificates (D-231,
 * edge CR-012).
 */
export function deviceUrl(deviceBaseUrl: string | undefined, pathAndQuery: string): string {
  return `${deviceBaseUrl ?? ''}${pathAndQuery}`;
}

const RING_ORDER: OtaRing[] = ['canary', 'pilot', 'all'];
/** Gateways of each ring a rollout targets: a pilot rollout includes the canary ring; `all` every gateway. */
const RING_MEMBERS: Record<OtaRing, OtaRing[]> = {
  canary: ['canary'],
  pilot: ['canary', 'pilot'],
  all: ['canary', 'pilot', 'all'],
};

const TRANSITIONS: Record<'start' | 'pause' | 'resume' | 'abort', RolloutStatus[]> = {
  start: ['planned'],
  pause: ['running'],
  resume: ['paused'],
  abort: ['planned', 'running', 'paused'],
};

export const ROLLOUT_INCLUDE = {
  release: true,
  devices: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.OtaRolloutInclude;
export type RolloutRow = Prisma.OtaRolloutGetPayload<{ include: typeof ROLLOUT_INCLUDE }>;

export function rolloutNextActions(status: RolloutStatus): string[] {
  return (Object.keys(TRANSITIONS) as (keyof typeof TRANSITIONS)[]).filter((a) =>
    TRANSITIONS[a].includes(status),
  );
}

/**
 * OTA (D-131, edge CR-011): the platform admin registers signed releases (the manifest signature must verify against
 * a trusted key), rolls a release out ring by ring (canary → pilot → all; a ring needs the previous ring completed),
 * each targeted gateway gets an `ota_apply` command whose manifest URL is `GET /v1/device/ota/manifest`; the
 * gateway's `ota_*` events move its rollout row, the rollout completes when every gateway is terminal and pauses
 * itself when failures exceed `max_failures_pct`.
 */
@Injectable()
export class OtaService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly commands: DeviceCommandsService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    super();
  }

  private trustedKeys(): Record<string, string> {
    const raw = this.config.get('OTA_SIGNING_PUBLIC_KEYS');
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async createRelease(manifest: OtaManifest, notes: string | null) {
    const problems = manifestProblems(manifest);
    if (problems.length)
      throw new DomainException('validation.failed', {
        errors: problems.map((message) => ({ path: 'manifest', code: 'manifest', message })),
      });
    if (!verifyManifest(manifest, this.trustedKeys())) throw new DomainException('ota.signature_invalid');
    // An artefact served from the device host must already be in the bucket with the signed size (D-231).
    const hosted = deviceArtifact(manifest.artifact.url);
    if (hosted) {
      if (hosted.version !== manifest.version)
        throw new DomainException('validation.failed', {
          errors: [
            {
              path: 'manifest.artifact.url',
              code: 'manifest',
              message: 'the artefact path must carry the manifest version',
            },
          ],
        });
      const stored = await this.storage.head(hosted.key);
      if (!stored || stored.sizeBytes !== manifest.artifact.size)
        throw new DomainException('ota.artifact_missing', { params: { key: hosted.key } });
    }
    return this.db.platform(async (tx) => {
      const exists = await tx.otaRelease.findFirst({
        where: { version: manifest.version, arch: manifest.arch },
      });
      if (exists) throw new DomainException('ota.release_exists');
      const release = await tx.otaRelease.create({
        data: {
          version: manifest.version,
          arch: manifest.arch,
          channel: manifest.channel,
          artifactUrl: manifest.artifact.url,
          artifactSha256: new Uint8Array(Buffer.from(manifest.artifact.sha256, 'hex')),
          sizeBytes: BigInt(manifest.artifact.size),
          minAgentVersion: manifest.minAgentVersion ?? null,
          manifest: manifest as unknown as Prisma.InputJsonValue,
          signatureKeyId: manifest.signature.keyId,
          signature: new Uint8Array(Buffer.from(manifest.signature.value, 'base64')),
          releaseNotes: notes,
          releasedAt: new Date(manifest.releasedAt),
          publishedAt: this.clock.now(),
          createdBy: userIdOf(RequestContext.actor()),
        },
      });
      await this.audit.record(tx, {
        action: 'ota.release_created',
        subjectType: 'smart.ota_release',
        subjectId: release.id,
        after: { version: release.version, arch: release.arch, keyId: release.signatureKeyId },
      });
      await this.events.record(tx, {
        type: 'ota.release_created',
        aggregateType: 'ota_release',
        aggregateId: release.id,
        tenantId: null,
        payload: { releaseId: release.id, version: release.version, arch: release.arch },
      });
      return release;
    });
  }

  listReleases() {
    return this.db.platform((tx) => tx.otaRelease.findMany({ orderBy: [{ releasedAt: 'desc' }], take: 100 }));
  }

  listRollouts(releaseId?: string) {
    return this.db.platform((tx) =>
      tx.otaRollout.findMany({
        where: releaseId ? { releaseId } : {},
        include: ROLLOUT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  getRollout(id: string) {
    return this.db.platform(async (tx) =>
      this.found(await tx.otaRollout.findUnique({ where: { id }, include: ROLLOUT_INCLUDE })),
    );
  }

  /** A rollout of a release to a ring; pilot needs a completed canary rollout, all a completed pilot. */
  createRollout(releaseId: string, input: { ring: OtaRing; maxFailuresPct?: string; notes?: string | null }) {
    return this.db.platform(async (tx) => {
      const release = this.found(await tx.otaRelease.findUnique({ where: { id: releaseId } }));
      if (release.deprecatedAt) throw new DomainException('ota.invalid_transition');
      const previousRing = RING_ORDER[RING_ORDER.indexOf(input.ring) - 1];
      if (previousRing) {
        const done = await tx.otaRollout.count({
          where: { releaseId, ring: previousRing, status: 'completed' },
        });
        if (done === 0) throw new DomainException('ota.ring_order', { params: { ring: previousRing } });
      }
      const active = await tx.otaRollout.count({
        where: { releaseId, ring: input.ring, status: { in: ['planned', 'running', 'paused'] } },
      });
      if (active) throw new DomainException('ota.invalid_transition');
      const rollout = await tx.otaRollout.create({
        data: {
          releaseId,
          ring: input.ring,
          maxFailuresPct: input.maxFailuresPct ?? '10',
          notes: input.notes ?? null,
          createdBy: userIdOf(RequestContext.actor()),
        },
        include: ROLLOUT_INCLUDE,
      });
      await this.audit.record(tx, {
        action: 'ota.rollout_created',
        subjectType: 'smart.ota_rollout',
        subjectId: rollout.id,
        after: { releaseId, ring: input.ring },
      });
      await this.changed(tx, rollout.id, release.id, 'planned');
      return rollout;
    });
  }

  /** start (targets + `ota_apply` commands) · pause · resume · abort. */
  transition(id: string, action: 'start' | 'pause' | 'resume' | 'abort') {
    return this.db.platform(
      async (tx) => {
        const rollout = this.found(
          await tx.otaRollout.findUnique({ where: { id }, include: { release: true } }),
        );
        if (!TRANSITIONS[action].includes(rollout.status))
          throw new DomainException('ota.invalid_transition');
        const now = this.clock.now();
        const status: RolloutStatus =
          action === 'start' || action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'aborted';
        if (action === 'start') {
          const gateways = await tx.device.findMany({
            where: {
              kind: 'gateway',
              status: { in: ['provisioned', 'online', 'degraded', 'offline'] },
              otaRing: { in: RING_MEMBERS[rollout.ring] },
              arch: rollout.release.arch,
              mqttClientId: { not: null },
            },
          });
          for (const g of gateways) {
            const current = g.firmwareVersion ?? '0.0.0';
            if (compareSemver(current, rollout.release.version) >= 0) continue;
            if (
              rollout.release.minAgentVersion &&
              compareSemver(current, rollout.release.minAgentVersion) < 0
            )
              continue;
            const manifestUrl = deviceUrl(
              this.config.get('DEVICE_PUBLIC_BASE_URL'),
              `/v1/device/ota/manifest?releaseId=${rollout.release.id}`,
            );
            const command = await this.commands.issueAsPlatform(g.id, 'ota_apply', { manifestUrl }, tx);
            await tx.otaRolloutDevice.create({
              data: {
                rolloutId: id,
                deviceId: g.id,
                commandId: command.id,
                status: 'commanded',
                fromVersion: g.firmwareVersion,
                toVersion: rollout.release.version,
              },
            });
          }
        }
        if (action === 'abort')
          await tx.otaRolloutDevice.updateMany({
            where: { rolloutId: id, status: { in: ['queued', 'commanded'] } },
            data: { status: 'failed', error: 'rollout aborted' },
          });
        await tx.otaRollout.update({
          where: { id },
          data: {
            status,
            ...(action === 'start' ? { startedAt: now } : {}),
            ...(action === 'abort' ? { finishedAt: now } : {}),
            updatedBy: userIdOf(RequestContext.actor()),
          },
        });
        await this.audit.record(tx, {
          action: 'ota.rollout_transitioned',
          subjectType: 'smart.ota_rollout',
          subjectId: id,
          before: { status: rollout.status },
          after: { status },
        });
        await this.changed(tx, id, rollout.releaseId, status);
        if (action === 'start') await this.evaluate(tx, id);
        return tx.otaRollout.findUniqueOrThrow({ where: { id }, include: ROLLOUT_INCLUDE });
      },
      { timeout: 60_000 },
    );
  }

  private changed(tx: Tx, rolloutId: string, releaseId: string, status: RolloutStatus) {
    return this.events.record(tx, {
      type: 'ota.rollout_changed',
      aggregateType: 'ota_rollout',
      aggregateId: rolloutId,
      tenantId: null,
      payload: { rolloutId, releaseId, status },
    });
  }

  /** A gateway's `ota_*` event (ingest): its rollout row moves; `ota_applied` records the new agent version. */
  async onDeviceEvent(
    tx: Tx,
    gatewayId: string,
    type: string,
    data: Record<string, unknown> | undefined,
  ): Promise<void> {
    const version = typeof data?.version === 'string' ? data.version : null;
    const row = await tx.otaRolloutDevice.findFirst({
      where: {
        deviceId: gatewayId,
        status: { in: ['commanded', 'started'] },
        ...(version ? { toVersion: version } : {}),
        rollout: { status: { in: ['running', 'paused'] } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const status =
      type === 'ota_started'
        ? 'started'
        : type === 'ota_applied'
          ? 'applied'
          : type === 'ota_rolled_back'
            ? 'rolled_back'
            : 'failed';
    if (type === 'ota_applied' && version)
      await tx.device.update({ where: { id: gatewayId }, data: { firmwareVersion: version } });
    if (!row) return;
    await tx.otaRolloutDevice.update({
      where: { id: row.id },
      data: {
        status,
        ...(status === 'failed' || status === 'rolled_back'
          ? { error: typeof data?.error === 'string' ? data.error.slice(0, 500) : type }
          : {}),
      },
    });
    await this.evaluate(tx, row.rolloutId);
  }

  /** Completion and the failure guard of a running rollout. */
  private async evaluate(tx: Tx, rolloutId: string): Promise<void> {
    const rollout = await tx.otaRollout.findUniqueOrThrow({
      where: { id: rolloutId },
      include: { devices: true },
    });
    if (rollout.status !== 'running') return;
    const total = rollout.devices.length;
    const failed = rollout.devices.filter((d) => d.status === 'failed' || d.status === 'rolled_back').length;
    const terminal = rollout.devices.filter((d) =>
      ['applied', 'failed', 'rolled_back'].includes(d.status),
    ).length;
    const now = this.clock.now();
    if (total > 0 && (failed * 100) / total > Number(rollout.maxFailuresPct)) {
      await tx.otaRollout.update({
        where: { id: rolloutId },
        data: { status: 'paused', notes: `paused: ${failed}/${total} gateways failed` },
      });
      await this.changed(tx, rolloutId, rollout.releaseId, 'paused');
    } else if (terminal === total) {
      await tx.otaRollout.update({
        where: { id: rolloutId },
        data: { status: 'completed', finishedAt: now },
      });
      await this.changed(tx, rolloutId, rollout.releaseId, 'completed');
    }
  }

  /**
   * `GET /v1/device/ota/manifest`: the signed manifest for the calling gateway — of `releaseId` when given (the
   * `ota_apply` URL), else of its latest commanded rollout; only for its architecture.
   */
  manifestFor(gatewayId: string, releaseId?: string) {
    return this.db.platform(async (tx) => {
      const gateway = this.found(await tx.device.findUnique({ where: { id: gatewayId } }));
      let release = releaseId ? await tx.otaRelease.findUnique({ where: { id: releaseId } }) : null;
      if (!releaseId) {
        const row = await tx.otaRolloutDevice.findFirst({
          where: { deviceId: gatewayId },
          orderBy: { createdAt: 'desc' },
          include: { rollout: { include: { release: true } } },
        });
        release = row?.rollout.release ?? null;
      }
      if (!release || release.deprecatedAt || (gateway.arch && release.arch !== gateway.arch))
        throw new DomainException('http.not_found');
      return release.manifest as unknown as OtaManifest;
    });
  }

  /**
   * `GET /v1/device/ota/artifacts/{version}/{file}`: the release artefact for the calling gateway, streamed from the
   * product bucket (`releases/edge/…`, D-231) — only a registered, non-deprecated release of the gateway's
   * architecture whose artefact URL is that path; anything else is a 404.
   */
  async artifactFor(
    gatewayId: string,
    version: string,
    file: string,
  ): Promise<{ stream: Readable; sizeBytes: number; sha256: string }> {
    const wanted = deviceArtifact(`${OTA_ARTIFACT_PATH}${version}/${file}`);
    if (!wanted) throw new DomainException('http.not_found');
    const release = await this.db.platform(async (tx) => {
      const gateway = this.found(await tx.device.findUnique({ where: { id: gatewayId } }));
      const candidates = await tx.otaRelease.findMany({
        where: { version, deprecatedAt: null, ...(gateway.arch ? { arch: gateway.arch } : {}) },
      });
      return candidates.find((r) => deviceArtifact(r.artifactUrl)?.key === wanted.key) ?? null;
    });
    if (!release) throw new DomainException('http.not_found');
    const stored = await this.storage.head(wanted.key);
    if (!stored || stored.sizeBytes !== Number(release.sizeBytes))
      throw new DomainException('http.not_found');
    return {
      stream: await this.storage.getStream(wanted.key),
      sizeBytes: stored.sizeBytes,
      sha256: Buffer.from(release.artifactSha256).toString('hex'),
    };
  }
}
