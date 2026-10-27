import { userIdOf } from '@common/context/actor';
import { RequestContext } from '@common/context/request-context';
import { type TenantContext } from '@common/context/tenant-context';
import { ComplianceException } from '@common/errors/compliance.exception';
import { DomainException } from '@common/errors/domain.exception';
import { bangkokDate } from '@common/time/bangkok';
import { AuditService } from '@core/audit/audit.service';
import { CLOCK, type Clock } from '@core/clock/clock';
import { ComplianceGate } from '@core/compliance/compliance-gate.service';
import { DomainEvents } from '@core/events/domain-events';
import { type DomainEventType } from '@core/events/event-types';
import { SettingsService } from '@core/settings/settings.service';
import { type Tx } from '@database/prisma.service';
import { TenantScopedRepository, TenantTx } from '@database/tenant-tx';
import {
  type ContractKind,
  type LeaseTemplate,
  type LeaseTemplateVersion,
  type LegalReviewState,
  type Prisma,
} from '@generated/prisma/client';
import { Inject, Injectable } from '@nestjs/common';

import { type ClauseDiff, diffClauses } from './contract-diff';
import { isLeaseKind, sampleDataOf, variableCatalogue } from './contract-kinds';
import { type ContractData, type ContractLanguage, ContractRenderer } from './contract-renderer';
import {
  checkTemplate,
  type ClauseFinding,
  forbiddenFindings,
  type TemplateProblem,
} from './contract-text-check';

export type TemplateWithVersions = LeaseTemplate & { versions: LeaseTemplateVersion[] };

export interface Disclaimer {
  th: string;
  en: string;
  settingKey: string;
}

export interface TemplateCheckResult {
  inScope: boolean;
  problems: TemplateProblem[];
  unknownVariables: string[];
  findings: ClauseFinding[];
  publishable: boolean;
}

const by = () => userIdOf(RequestContext.actor());
const DISCLAIMER_KEY = 'contract.library.disclaimer';
const DEFAULT_DISCLAIMER: Disclaimer = {
  th: 'ตัวอย่างสัญญาเพื่ออำนวยความสะดวก ไม่ใช่คำแนะนำทางกฎหมาย',
  en: 'A sample contract provided for convenience; not legal advice.',
  settingKey: DISCLAIMER_KEY,
};

/**
 * The contract library (G3, D-290, D-294): platform drafts and each tenant's own templates in `ops.lease_template(_
 * version)` with a kind and a legal-review state (every draft pending legal verification until counsel signs a
 * version off, O-025). A tenant copies a published version (`derived_from_version_id`), edits the text (HTML
 * whitelist, variables of its kind only), sees the clause diff against the base and the compliance findings
 * (forbidden clause types: blocking inside the สคบ. scope of D-158, warnings outside), and publishes. Published
 * versions are immutable (a later edit opens a new draft version); running contracts keep the version they pinned.
 */
@Injectable()
export class ContractLibraryService extends TenantScopedRepository {
  constructor(
    private readonly db: TenantTx,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly settings: SettingsService,
    private readonly gate: ComplianceGate,
    private readonly renderer: ContractRenderer,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  async disclaimer(): Promise<Disclaimer> {
    const v = await this.settings.valueAt<{ th: string; en: string }>(DISCLAIMER_KEY, this.clock.now(), {});
    return v && typeof v === 'object'
      ? { th: v.th, en: v.en, settingKey: DISCLAIMER_KEY }
      : DEFAULT_DISCLAIMER;
  }

  /** Platform drafts and the tenant's own templates, filtered by kind / language (versions without bodies). */
  async library(ctx: TenantContext, filter: { kind?: ContractKind; language?: string } = {}) {
    const rows = await this.db.tenant(ctx, (tx) =>
      tx.leaseTemplate.findMany({
        where: {
          OR: [{ tenantId: null }, { tenantId: ctx.tenantId }],
          kind: filter.kind,
          versions: filter.language ? { some: { language: filter.language } } : undefined,
        },
        include: {
          versions: {
            where: filter.language ? { language: filter.language } : undefined,
            orderBy: [{ language: 'asc' }, { version: 'desc' }],
          },
        },
        orderBy: [{ kind: 'asc' }, { key: 'asc' }],
      }),
    );
    return rows.sort((a, b) => Number(a.tenantId !== null) - Number(b.tenantId !== null));
  }

  private async template(tx: Tx, ctx: TenantContext, id: string): Promise<TemplateWithVersions> {
    return this.found(
      await tx.leaseTemplate.findFirst({
        where: { id, OR: [{ tenantId: null }, { tenantId: ctx.tenantId }] },
        include: { versions: { orderBy: [{ version: 'desc' }, { language: 'asc' }] } },
      }),
    );
  }

  private async ownTemplate(tx: Tx, ctx: TenantContext, id: string): Promise<TemplateWithVersions> {
    const t = await this.template(tx, ctx, id);
    if (t.tenantId !== ctx.tenantId) throw new DomainException('http.not_found');
    return t;
  }

  /** The version shown for editing: the open draft, else the latest published one, else the latest. */
  current(t: TemplateWithVersions): LeaseTemplateVersion {
    return (
      t.versions.find((v) => v.state === 'draft') ??
      t.versions.find((v) => v.state === 'published') ??
      t.versions[0]!
    );
  }

  async detail(ctx: TenantContext, id: string, versionId?: string) {
    const t = await this.db.tenant(ctx, (tx) => this.template(tx, ctx, id));
    const version = versionId ? t.versions.find((v) => v.id === versionId) : this.current(t);
    if (!version) throw new DomainException('http.not_found');
    const base = version.derivedFromVersionId
      ? await this.db.tenant(ctx, (tx) =>
          tx.leaseTemplateVersion.findFirst({
            where: { id: version.derivedFromVersionId! },
            include: { template: true },
          }),
        )
      : null;
    return {
      template: t,
      version,
      base,
      variables: [...variableCatalogue(t.kind)].sort(),
    };
  }

  /** Copy a published version into a new template of the tenant (D-294). */
  async copy(ctx: TenantContext, input: { derivedFromVersionId: string; name?: string }) {
    const id = await this.db.tenant(ctx, async (tx) => {
      const base = this.found(
        await tx.leaseTemplateVersion.findFirst({
          where: {
            id: input.derivedFromVersionId,
            OR: [{ tenantId: null }, { tenantId: ctx.tenantId }],
          },
          include: { template: true },
        }),
      );
      if (base.state !== 'published')
        throw new DomainException('validation.failed', {
          errors: [{ path: 'derivedFromVersionId', code: 'state', message: 'copy a published version' }],
        });
      const prefix = `my_${base.template.kind}`;
      const n = await tx.leaseTemplate.count({
        where: { tenantId: ctx.tenantId, key: { startsWith: prefix } },
      });
      const name = input.name?.trim() || `${base.template.name} (ฉบับของฉัน)`;
      const template = await tx.leaseTemplate.create({
        data: {
          tenantId: ctx.tenantId,
          key: `${prefix}_${n + 1}`.slice(0, 64),
          name: name.slice(0, 200),
          kind: base.template.kind,
          createdBy: by(),
        },
      });
      const version = await tx.leaseTemplateVersion.create({
        data: {
          templateId: template.id,
          tenantId: ctx.tenantId,
          version: 1,
          language: base.language,
          bodyHtml: base.bodyHtml,
          clauseSchema: base.clauseSchema ?? {},
          forbiddenClauseTypes: base.forbiddenClauseTypes,
          legalRef: base.legalRef,
          state: 'draft',
          effectiveFrom: new Date(bangkokDate(this.clock.now())),
          derivedFromVersionId: base.id,
          createdBy: by(),
        },
      });
      await this.record(tx, ctx.tenantId, 'contract_template.copied', template.id, {
        versionId: version.id,
        derivedFromVersionId: base.id,
        kind: template.kind,
      });
      return template.id;
    });
    return this.detail(ctx, id);
  }

  private assertText(body: string, kind: ContractKind): void {
    const r = checkTemplate(body, kind);
    if (r.problems.length)
      throw new DomainException('contract.template_invalid', {
        errors: r.problems.map((p) => ({ path: p.path, code: p.code, message: p.message })),
      });
    if (r.unknownVariables.length)
      throw new DomainException('contract.unknown_variable', {
        errors: r.unknownVariables.map((v) => ({ path: 'bodyHtml', code: 'unknown', message: v })),
      });
  }

  /** Edit the draft text / name; editing a published template opens its next draft version (D-294). */
  async update(ctx: TenantContext, id: string, input: { name?: string; bodyHtml?: string }) {
    await this.db.tenant(ctx, async (tx) => {
      const t = await this.ownTemplate(tx, ctx, id);
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name || name.length > 200)
          throw new DomainException('validation.failed', {
            errors: [{ path: 'name', code: 'length', message: '1–200 characters' }],
          });
        await tx.leaseTemplate.update({ where: { id }, data: { name, updatedBy: by() } });
      }
      if (input.bodyHtml !== undefined) {
        this.assertText(input.bodyHtml, t.kind);
        const latest = this.current(t);
        let versionId = latest.id;
        if (latest.state === 'draft')
          await tx.leaseTemplateVersion.update({
            where: { id: latest.id },
            data: { bodyHtml: input.bodyHtml, updatedBy: by() },
          });
        else {
          const next = await tx.leaseTemplateVersion.create({
            data: {
              templateId: t.id,
              tenantId: ctx.tenantId,
              version: Math.max(...t.versions.map((v) => v.version)) + 1,
              language: latest.language,
              bodyHtml: input.bodyHtml,
              clauseSchema: latest.clauseSchema ?? {},
              forbiddenClauseTypes: latest.forbiddenClauseTypes,
              legalRef: latest.legalRef,
              state: 'draft',
              effectiveFrom: new Date(bangkokDate(this.clock.now())),
              derivedFromVersionId: latest.derivedFromVersionId,
              createdBy: by(),
            },
          });
          versionId = next.id;
        }
        await this.record(tx, ctx.tenantId, 'contract_template.updated', id, { versionId });
      }
    });
    return this.detail(ctx, id);
  }

  /** The base a version is compared with: the library version it was copied from, else its previous version. */
  private async baseOf(tx: Tx, t: TemplateWithVersions, v: LeaseTemplateVersion) {
    if (v.derivedFromVersionId)
      return tx.leaseTemplateVersion.findUnique({ where: { id: v.derivedFromVersionId } });
    return (
      t.versions
        .filter((o) => o.language === v.language && o.version < v.version)
        .sort((a, b) => b.version - a.version)[0] ?? null
    );
  }

  async diff(ctx: TenantContext, id: string, versionId?: string) {
    return this.db.tenant(ctx, async (tx) => {
      const t = await this.template(tx, ctx, id);
      const version = versionId ? t.versions.find((v) => v.id === versionId) : this.current(t);
      if (!version) throw new DomainException('http.not_found');
      const base = await this.baseOf(tx, t, version);
      const clauses: ClauseDiff[] = diffClauses(base?.bodyHtml ?? version.bodyHtml, version.bodyHtml);
      return { template: t, version, base, clauses };
    });
  }

  /** Structure, variables and forbidden clause types of a version against its base (D-158 scope decides). */
  async check(ctx: TenantContext, id: string, versionId?: string): Promise<TemplateCheckResult> {
    const { template, version, base } = await this.diff(ctx, id, versionId);
    return this.checkText(ctx.tenantId, template.kind, base?.bodyHtml ?? null, version.bodyHtml);
  }

  async checkText(
    tenantId: string,
    kind: ContractKind,
    base: string | null,
    body: string,
  ): Promise<TemplateCheckResult> {
    const inScope = await this.gate.inScope(tenantId, this.clock.now());
    const structure = checkTemplate(body, kind);
    const findings = base === null ? [] : forbiddenFindings(base, body, kind, inScope);
    return {
      inScope,
      problems: structure.problems,
      unknownVariables: structure.unknownVariables,
      findings,
      publishable:
        !structure.problems.length &&
        !structure.unknownVariables.length &&
        !findings.some((f) => f.severity === 'block'),
    };
  }

  /**
   * Publish the open draft: refused with the problems (422 `contract.template_invalid` / `contract.unknown_variable`)
   * or, inside the สคบ. scope, a forbidden clause (422 `compliance.forbidden_clause` with the legal reference);
   * outside the scope the findings come back as warnings. Stays `pending_legal_verification` (O-025).
   */
  async publish(ctx: TenantContext, id: string) {
    const t = await this.db.tenant(ctx, (tx) => this.ownTemplate(tx, ctx, id));
    const draft = t.versions.find((v) => v.state === 'draft');
    if (!draft) throw new DomainException('contract.invalid_state');
    this.assertText(draft.bodyHtml, t.kind);
    const result = await this.check(ctx, id, draft.id);
    const blocking = result.findings.filter((f) => f.severity === 'block');
    if (blocking.length)
      throw new ComplianceException(
        'compliance.forbidden_clause',
        { ruleId: 'compliance.forbidden_clause', legalRef: blocking[0]!.legalRef },
        {
          errors: blocking.map((f) => ({
            path: `clauses.${f.clauseKey}`,
            code: f.clauseType,
            message: `${f.source === 'removed_protection' ? 'protective wording removed' : 'forbidden wording'}: ${f.excerpt} — ${f.legalRef}`,
          })),
        },
      );
    await this.db.tenant(ctx, async (tx) => {
      const now = this.clock.now();
      await tx.leaseTemplateVersion.update({
        where: { id: draft.id },
        data: {
          state: 'published',
          publishedAt: now,
          publishedBy: by(),
          effectiveFrom: new Date(bangkokDate(now)),
        },
      });
      await this.record(tx, ctx.tenantId, 'contract_template.published', id, {
        versionId: draft.id,
        warnings: result.findings.length,
        inScope: result.inScope,
      });
    });
    return { ...(await this.detail(ctx, id, draft.id)), check: result };
  }

  /** A preview PDF of a version filled with sample values, marked as a draft with the disclaimer (D-294). */
  async preview(ctx: TenantContext, id: string, versionId?: string): Promise<Buffer> {
    const { template, version } = await this.detail(ctx, id, versionId);
    const disclaimer = await this.disclaimer();
    const language: ContractLanguage = version.language === 'en' ? 'en' : 'th';
    const sample = { ...sampleDataOf(template.kind), draft: true, disclaimer: disclaimer[language] };
    if (isLeaseKind(template.kind))
      return (await this.renderer.render(version.bodyHtml, sample as unknown as ContractData, language)).pdf;
    return (
      await this.renderer.renderDocument(
        `<p class="draft">${disclaimer[language]}</p>${version.bodyHtml}`,
        sample,
        {
          title: template.name,
          language,
        },
      )
    ).pdf;
  }

  /**
   * A published version a tenant may use for a kind: one of its own or a platform draft (`versionId`), else the latest
   * published platform draft of the kind in the language (404 when none).
   */
  async usableVersion(
    tx: Tx,
    tenantId: string,
    kinds: ContractKind[],
    language: string,
    versionId?: string | null,
  ): Promise<LeaseTemplateVersion & { template: LeaseTemplate }> {
    const v = await tx.leaseTemplateVersion.findFirst({
      where: versionId
        ? { id: versionId, OR: [{ tenantId: null }, { tenantId }] }
        : { tenantId: null, language, state: 'published', template: { tenantId: null, kind: { in: kinds } } },
      include: { template: true },
      orderBy: { version: 'desc' },
    });
    if (!v || !kinds.includes(v.template.kind))
      throw new DomainException(versionId ? 'http.not_found' : 'validation.failed', {
        errors: versionId
          ? undefined
          : [
              {
                path: 'language',
                code: 'unavailable',
                message: `no published ${kinds.join('/')} text in ${language}`,
              },
            ],
      });
    if (v.state !== 'published')
      throw new DomainException('validation.failed', {
        errors: [
          { path: 'templateVersionId', code: 'state', message: 'only a published version can be used' },
        ],
      });
    return v;
  }

  /** The tenant's own latest published text of a kind and language (notice texts, D-294), or null. */
  async ownPublished(tenantId: string, kind: ContractKind, language: string) {
    return this.db.platform((tx) =>
      tx.leaseTemplateVersion.findFirst({
        where: { tenantId, language, state: 'published', template: { tenantId, kind } },
        orderBy: [{ publishedAt: 'desc' }, { version: 'desc' }],
      }),
    );
  }

  // ------------------------------------------------------------------------------------------- admin

  adminLibrary() {
    return this.db.platform((tx) =>
      tx.leaseTemplate.findMany({
        where: { tenantId: null },
        include: { versions: { orderBy: [{ language: 'asc' }, { version: 'desc' }] } },
        orderBy: [{ kind: 'asc' }, { key: 'asc' }],
      }),
    );
  }

  /** Records counsel's review of a published platform version (text unchanged, O-025). */
  async setReview(versionId: string, input: { state: LegalReviewState; note?: string | null }) {
    const userId = by();
    return this.db.platform(async (tx) => {
      const v = this.found(
        await tx.leaseTemplateVersion.findFirst({ where: { id: versionId, tenantId: null } }),
      );
      if (v.state === 'draft') throw new DomainException('contract.invalid_state');
      const reviewed = input.state === 'reviewed';
      const updated = await tx.leaseTemplateVersion.update({
        where: { id: versionId },
        data: {
          legalReviewState: input.state,
          legalReviewedAt: reviewed ? this.clock.now() : null,
          legalReviewedBy: reviewed ? userId : null,
          legalReviewNote: input.note?.trim() || null,
          updatedBy: userId,
        },
        include: { template: true },
      });
      await this.record(tx, null, 'contract_template.reviewed', v.templateId, {
        versionId,
        before: v.legalReviewState,
        after: input.state,
      });
      return updated;
    });
  }

  private async record(
    tx: Tx,
    tenantId: string | null,
    type: Extract<DomainEventType, `contract_template.${string}`>,
    templateId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.audit.record(tx, {
      action: type,
      tenantId,
      subjectType: 'ops.lease_template',
      subjectId: templateId,
      metadata: metadata as Prisma.InputJsonValue,
    });
    await this.events.record(tx, {
      type,
      aggregateType: 'lease_template',
      aggregateId: templateId,
      tenantId,
      payload: { templateId, ...metadata },
    });
  }
}
