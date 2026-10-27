import 'reflect-metadata';

import { SettingsService } from '@core/settings/settings.service';
import { LeaseRenewalsService } from '@modules/ops-leases/lease-renewals.service';
import { LeasesService } from '@modules/ops-leases/leases.service';

import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, idem, otpSignIn } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const ADDRESS = { line1: 'ถนนพหลโยธิน', district: 'พญาไท', province: 'กรุงเทพมหานคร', postcode: '10400' };
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082',
  'hex',
).toString('base64');
const DAY = 86_400_000;

interface Signed {
  tenantId: string;
  token: string;
}

/**
 * G3 acceptance (docs/prompts/G-growth-api.md G3, D-290, D-294; real PostgreSQL): copy → edit → diff → compliance
 * block in scope / warn out of scope; unknown variables refused; a lease pinned on an own template; every signable
 * kind signs (operator drawn signature, resident OTP + LINE) and is archived under legal hold with its template
 * version pinned; a signed co-broke contract signs the agreement; renewal offers: accept → renewal lease → old lease
 * closed at its end, decline → notice / move-out, expiry and reminders; cross-tenant 404; counsel's review recorded.
 */
describe('G3 contract library, signable documents, renewal offers (real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let landlord: Signed;
  let agency: Signed;
  let agency2: Signed;
  let stranger: Signed;
  let resident: { accessToken: string; refreshToken: string };
  let unitId: string;
  let unit2: string;
  let unit3: string;
  let lessee: string;
  let leaseId: string;
  let lease2: string;
  let lease3: string;
  let ownTemplate: string;
  let ownVersion: string;
  let addendum: string;
  let renewalLease: string;

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.admin.query(sql, params)).rows as T[];
  const as = (s: Signed) => ({ ...bearer(s.token), 'X-Tenant-Id': s.tenantId });
  const R = () => bearer(resident.accessToken);
  const PHONE = '+66810007301';
  const today = () => new Date(t.clock.now().getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

  async function signup(kind: 'agency' | 'landlord', phone: string, displayName: string): Promise<Signed> {
    t.clock.advance(61_000);
    const challenge = await t.http.post(`/v1/public/signup/${kind}/otp`).send({ phone }).expect(200);
    const res = await t.http.post(`/v1/public/signup/${kind}`).send({
      provider: 'phone_otp',
      challengeId: challenge.body.challengeId,
      code: t.sms.lastCodeTo(phone),
      displayName,
    });
    if (res.status !== 201) throw new Error(`signup ${res.status}: ${JSON.stringify(res.body)}`);
    return { tenantId: res.body.tenant.id as string, token: res.body.tokens.accessToken as string };
  }

  async function condo(unitNo: string): Promise<string> {
    const res = await t.http
      .post('/v1/owner/portfolio/units')
      .set(as(landlord))
      .send({
        kind: 'condo_unit',
        projectName: 'คอนโด จีทรี ทดสอบ',
        unitNo,
        address: ADDRESS,
        bedrooms: 1,
        bathrooms: 1,
        areaSqm: '30.00',
        defaultRent: '15000.00',
      })
      .expect(201);
    return res.body.unitId as string;
  }

  /** A lease in force on the unit (signing itself is covered by leases.int-spec / the renewal below). */
  async function activeLease(
    unit: string,
    startDate: string,
    months = 12,
    extra: Record<string, unknown> = {},
  ) {
    const draft = await t.http
      .post('/v1/owner/leases')
      .set(as(landlord))
      .send({
        unitId: unit,
        lesseePartyId: lessee,
        startDate,
        months,
        rent: '15000',
        depositAmount: '30000',
        ...extra,
      });
    if (draft.status !== 201) throw new Error(JSON.stringify(draft.body));
    const id = draft.body.id as string;
    await t.http
      .post(`/v1/owner/leases/${id}/actions/send-for-signature`)
      .set(as(landlord))
      .set(idem())
      .expect(200);
    await q(
      `UPDATE ops.lease SET status = 'active', signed_document_id = contract_document_id, activated_at = now() WHERE id = $1`,
      [id],
    );
    return draft.body as { id: string; endDate: string; template: { versionId: string } };
  }

  async function signAsResident(path: string, sha: string) {
    t.clock.advance(61_000);
    const otp = await t.http.post(`${path}/signature/otp`).set(R()).send({}).expect(200);
    return t.http
      .post(`${path}/sign`)
      .set(R())
      .set(idem())
      .send({
        challengeId: otp.body.challengeId,
        code: t.sms.lastCodeTo(PHONE),
        contractSha256: sha,
        signaturePng: PNG,
      });
  }

  async function refresh() {
    const r = await t.http.post('/v1/auth/refresh').send({ refreshToken: resident.refreshToken }).expect(200);
    resident = r.body as typeof resident;
  }

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_g3' });
    t = await createIntApp(db, { OTP_MAX_PER_HOUR: '20' });
    landlord = await signup('landlord', '+660000007301', 'มาลี มีสุข');
    agency = await signup('agency', '+660000007302', 'บ้านดี พร็อพเพอร์ตี้');
    agency2 = await signup('agency', '+660000007303', 'นายหน้าร่วม จำกัด');
    stranger = await signup('landlord', '+660000007304', 'คนอื่น ทดสอบ');
    unitId = await condo('7/301');
    unit2 = await condo('7/302');
    unit3 = await condo('7/303');
    lessee = (
      await t.http
        .post('/v1/owner/parties')
        .set(as(landlord))
        .send({
          type: 'person',
          displayName: 'สมศรี ใจดี',
          phone: PHONE,
          nationality: 'TH',
          idDocumentType: 'thai_national_id',
          idNumber: '1100700000001',
        })
        .expect(201)
    ).body.id as string;
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('lists the library: every kind in th / en, pending legal verification, with the disclaimer', async () => {
    const res = await t.http.get('/v1/owner/contract-library').set(as(landlord)).expect(200);
    expect(res.body.disclaimer).toMatchObject({
      th: 'ตัวอย่างสัญญาเพื่ออำนวยความสะดวก ไม่ใช่คำแนะนำทางกฎหมาย',
      settingKey: 'contract.library.disclaimer',
    });
    const kinds = new Set((res.body.data as { kind: string }[]).map((t) => t.kind));
    expect([...kinds].sort()).toEqual([
      'addendum',
      'brokerage_mandate',
      'co_broke',
      'lease_apartment_ocpb',
      'lease_condo_private',
      'lease_house',
      'lease_room',
      'notice_renewal',
      'notice_termination',
      'reservation',
    ]);
    const states = (res.body.data as { versions: { legalReviewState: string }[] }[]).flatMap((t) =>
      t.versions.map((v) => v.legalReviewState),
    );
    expect(new Set(states)).toEqual(new Set(['pending_legal_verification']));
    const reservation = await t.http
      .get('/v1/owner/contract-library?kind=reservation&language=en')
      .set(as(landlord))
      .expect(200);
    expect(reservation.body.data).toHaveLength(1);
    expect(reservation.body.data[0].versions).toEqual([expect.objectContaining({ language: 'en' })]);
  });

  it('copy → edit → diff → check: forbidden wording blocks inside the สคบ. scope, warns outside (D-158)', async () => {
    const lib = await t.http
      .get('/v1/owner/contract-library?kind=lease_condo_private&language=th')
      .set(as(landlord));
    const base = lib.body.data[0].versions[0].id as string;
    const copy = await t.http
      .post('/v1/owner/contract-templates')
      .set(as(landlord))
      .send({ derivedFromVersionId: base })
      .expect(201);
    ownTemplate = copy.body.id as string;
    expect(copy.body).toMatchObject({ kind: 'lease_condo_private', platform: false, base: { id: base } });
    expect(copy.body.current).toMatchObject({ state: 'draft', derivedFromVersionId: base });
    expect(copy.body.variables).toEqual(expect.arrayContaining(['premises.unitNo', 'rent.amount']));
    const body = copy.body.bodyHtml as string;

    // unsafe HTML and unknown variables are refused
    const script = await t.http
      .patch(`/v1/owner/contract-templates/${ownTemplate}`)
      .set(as(landlord))
      .send({ bodyHtml: body.replace('</article>', '<script>alert(1)</script></article>') })
      .expect(422);
    expect(script.body.code).toBe('contract.template_invalid');
    const unknown = await t.http
      .patch(`/v1/owner/contract-templates/${ownTemplate}`)
      .set(as(landlord))
      .send({ bodyHtml: body.replace('</article>', '<p>{{lessee.bankAccount}}</p></article>') })
      .expect(422);
    expect(unknown.body).toMatchObject({ code: 'contract.unknown_variable' });
    expect(unknown.body.errors[0].message).toBe('lessee.bankAccount');

    const edited = body.replace(
      '</article>',
      '<section><h2>ข้อตกลงพิเศษ</h2><p>ผู้ให้เช่าเข้าห้องได้ตลอดเวลาเพื่อตรวจความเรียบร้อย</p></section></article>',
    );
    await t.http
      .patch(`/v1/owner/contract-templates/${ownTemplate}`)
      .set(as(landlord))
      .send({ bodyHtml: edited })
      .expect(200);
    const diff = await t.http
      .get(`/v1/owner/contract-templates/${ownTemplate}/diff`)
      .set(as(landlord))
      .expect(200);
    expect(diff.body.baseVersionId).toBe(base);
    expect((diff.body.clauses as { status: string }[]).filter((c) => c.status !== 'unchanged')).toEqual([
      expect.objectContaining({ key: 'ข้อตกลงพิเศษ', status: 'added' }),
    ]);
    const check = await t.http
      .post(`/v1/owner/contract-templates/${ownTemplate}/actions/check`)
      .set(as(landlord))
      .expect(200);
    expect(check.body).toMatchObject({ inScope: true, publishable: false });
    expect(check.body.findings).toEqual([
      expect.objectContaining({
        clauseType: 'entry_without_notice',
        severity: 'block',
        source: 'added_wording',
      }),
    ]);
    const refused = await t.http
      .post(`/v1/owner/contract-templates/${ownTemplate}/actions/publish`)
      .set(as(landlord))
      .expect(422);
    expect(refused.body.code).toBe('compliance.forbidden_clause');
    expect(refused.body.legalRef).toContain('ข้อ 5 (5)');

    // outside the scope (a tenant below 3 units, D-158) the same text publishes with a warning
    await q(
      `INSERT INTO platform.tenant_setting_version (tenant_id, setting_id, value, effective_from, reason)
       SELECT $1, id, 'false', now(), 'below 3 units (test)' FROM platform.setting WHERE key = 'tenant.subject_to_ocpb_2568'`,
      [landlord.tenantId],
    );
    t.app.get(SettingsService).invalidate('tenant.subject_to_ocpb_2568');
    const published = await t.http
      .post(`/v1/owner/contract-templates/${ownTemplate}/actions/publish`)
      .set(as(landlord))
      .expect(200);
    expect(published.body.current).toMatchObject({
      state: 'published',
      legalReviewState: 'pending_legal_verification',
    });
    expect(published.body.check.findings).toEqual([expect.objectContaining({ severity: 'warn' })]);
    ownVersion = published.body.current.id as string;
    // a platform draft is read-only; another tenant never sees the template
    await t.http
      .patch(`/v1/owner/contract-templates/${base}`)
      .set(as(landlord))
      .send({ name: 'x' })
      .expect(404);
    await t.http.get(`/v1/owner/contract-templates/${ownTemplate}`).set(as(stranger)).expect(404);
  });

  it('a lease written on the own template keeps that version; editing opens a new draft version', async () => {
    const lease = await activeLease(unitId, today(), 12, { templateVersionId: ownVersion });
    leaseId = lease.id;
    expect(lease.template.versionId).toBe(ownVersion);
    const next = await t.http
      .patch(`/v1/owner/contract-templates/${ownTemplate}`)
      .set(as(landlord))
      .send({ name: 'สัญญาคอนโดของมาลี' })
      .expect(200);
    expect(next.body.name).toBe('สัญญาคอนโดของมาลี');
    const v2 = await t.http
      .patch(`/v1/owner/contract-templates/${ownTemplate}`)
      .set(as(landlord))
      .send({ bodyHtml: next.body.bodyHtml })
      .expect(200);
    expect(v2.body.current).toMatchObject({ version: 2, state: 'draft' });
    const pinned = await q<{ template_version_id: string }>(
      `SELECT template_version_id FROM ops.lease WHERE id = $1`,
      [leaseId],
    );
    expect(pinned[0]!.template_version_id).toBe(ownVersion);
    // an unknown or foreign version is a 404
    await t.http
      .post('/v1/owner/leases')
      .set(as(stranger))
      .send({ unitId, lesseePartyId: lessee, startDate: today(), templateVersionId: ownVersion })
      .expect(404);
  });

  it('an addendum is signed by the lessor (console) and the lessee (OTP + LINE) and archived under legal hold', async () => {
    resident = await otpSignIn(t, 'resident', PHONE, landlord.token);
    const created = await t.http
      .post('/v1/owner/contracts')
      .set(as(landlord))
      .send({
        kind: 'addendum',
        leaseId,
        variables: { clauses: [{ title: 'สัตว์เลี้ยง', text: 'อนุญาตแมว 1 ตัว' }] },
      })
      .expect(201);
    addendum = created.body.id as string;
    expect(created.body).toMatchObject({
      state: 'draft',
      legalReviewState: 'pending_legal_verification',
      signers: [
        expect.objectContaining({ role: 'lessor', tenantId: landlord.tenantId }),
        expect.objectContaining({ role: 'lessee', partyId: lessee }),
      ],
    });
    await t.http
      .post('/v1/owner/contracts')
      .set(as(landlord))
      .send({
        kind: 'addendum',
        leaseId,
        variables: { clauses: [{ title: 'a', text: 'b' }], bankAccount: '123' },
      })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('contract.unknown_variable'));
    // the resident does not see drafts
    expect((await t.http.get('/v1/resident/contracts').set(R()).expect(200)).body.data).toEqual([]);
    const sent = await t.http
      .post(`/v1/owner/contracts/${addendum}/actions/send-for-signature`)
      .set(as(landlord))
      .set(idem())
      .expect(200);
    expect(sent.body.number).toMatch(/^CTR-/);
    const sha = sent.body.sha256 as string;
    const mine = await t.http.get('/v1/resident/contracts').set(R()).expect(200);
    expect(mine.body.data).toEqual([
      expect.objectContaining({ id: addendum, nextActions: ['sign', 'download'] }),
    ]);
    const doc = await t.http.get(`/v1/resident/contracts/${addendum}/document`).set(R()).expect(200);
    expect(doc.body).toMatchObject({ sha256: sha, signed: false });

    const changed = await signAsResident(`/v1/resident/contracts/${addendum}`, 'a'.repeat(64));
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('contract.changed');
    const signed = await signAsResident(`/v1/resident/contracts/${addendum}`, sha);
    expect(signed.status).toBe(200);
    expect(signed.body.state).toBe('pending_signature');
    // a stranger is not a signer; the lessor signs in the console
    await t.http
      .post(`/v1/owner/contracts/${addendum}/actions/sign`)
      .set(as(stranger))
      .set(idem())
      .send({ contractSha256: sha, signaturePng: PNG })
      .expect(404);
    const done = await t.http
      .post(`/v1/owner/contracts/${addendum}/actions/sign`)
      .set(as(landlord))
      .set(idem())
      .send({ contractSha256: sha, signaturePng: PNG })
      .expect(200);
    expect(done.body).toMatchObject({ state: 'signed', nextActions: ['download'] });
    expect((done.body.signers as { signedAt: string | null }[]).every((s) => s.signedAt)).toBe(true);
    const rows = await q<{ signed_document_id: string; template_version_id: string; methods: string[] }>(
      `SELECT d.signed_document_id, d.template_version_id,
              array(SELECT s.method::text FROM ops.contract_signature s WHERE s.contract_document_id = d.id ORDER BY s.signer_index) AS methods
         FROM ops.contract_document d WHERE d.id = $1`,
      [addendum],
    );
    expect(rows[0]!.methods).toEqual(['draw_web', 'draw_liff']);
    expect(rows[0]!.template_version_id).toBe(created.body.templateVersionId);
    const hold = await q(`SELECT document_kind FROM platform.document_legal_hold WHERE document_id = $1`, [
      rows[0]!.signed_document_id,
    ]);
    expect(hold).toEqual([{ document_kind: 'contract' }]);
    // cross-tenant 404, signatures are append-only
    await t.http.get(`/v1/owner/contracts/${addendum}`).set(as(stranger)).expect(404);
    await expect(
      q(`DELETE FROM ops.contract_signature WHERE contract_document_id = $1`, [addendum]),
    ).rejects.toThrow();
  });

  it('a reservation for a person is signed the same way', async () => {
    const created = await t.http
      .post('/v1/owner/contracts')
      .set(as(landlord))
      .send({
        kind: 'reservation',
        language: 'en',
        unitId: unit2,
        partyId: lessee,
        variables: { fee: '5000', moveInDate: '2027-01-01', expiresOn: '2026-12-15' },
      })
      .expect(201);
    expect(created.body).toMatchObject({ language: 'en', variables: { fee: '5000.00', rent: '15000.00' } });
    const id = created.body.id as string;
    const sent = await t.http
      .post(`/v1/owner/contracts/${id}/actions/send-for-signature`)
      .set(as(landlord))
      .set(idem())
      .expect(200);
    await t.http
      .post(`/v1/owner/contracts/${id}/actions/sign`)
      .set(as(landlord))
      .set(idem())
      .send({ contractSha256: sent.body.sha256, signaturePng: PNG })
      .expect(200);
    const signed = await signAsResident(`/v1/resident/contracts/${id}`, sent.body.sha256 as string);
    expect(signed.status).toBe(200);
    expect(signed.body.state).toBe('signed');
  });

  it('brokerage mandate and co-broke contracts are e-signed by both tenants; the co-broke agreement becomes signed', async () => {
    const invited = await t.http
      .post('/v1/owner/mandates')
      .set(as(landlord))
      .set(idem())
      .send({ agencyTenantId: agency.tenantId, unitId: unit3, scope: 'list', commissionPercent: '100' })
      .expect(201);
    const mandateId = invited.body.id as string;
    await t.http
      .post(`/v1/owner/mandates/${mandateId}/actions/accept`)
      .set(as(agency))
      .set(idem())
      .expect(200);
    const mc = await t.http
      .post('/v1/owner/contracts')
      .set(as(landlord))
      .send({ kind: 'brokerage_mandate', mandateId })
      .expect(201);
    expect(mc.body.counterpartyTenantId).toBe(agency.tenantId);
    // the agency (counterparty) sees it; only the owner may send it
    await t.http.get(`/v1/owner/contracts/${mc.body.id}`).set(as(agency)).expect(200);
    await t.http
      .post(`/v1/owner/contracts/${mc.body.id}/actions/send-for-signature`)
      .set(as(agency))
      .set(idem())
      .expect(409);
    const ms = await t.http
      .post(`/v1/owner/contracts/${mc.body.id}/actions/send-for-signature`)
      .set(as(landlord))
      .set(idem())
      .expect(200);
    for (const s of [agency, landlord])
      await t.http
        .post(`/v1/owner/contracts/${mc.body.id}/actions/sign`)
        .set(as(s))
        .set(idem())
        .send({ contractSha256: ms.body.sha256, signaturePng: PNG })
        .expect(200);
    const mandate = await t.http.get(`/v1/owner/mandates/${mandateId}`).set(as(landlord)).expect(200);
    expect(mandate.body).toMatchObject({ state: 'active', contractDocumentId: mc.body.id });
    expect((await t.http.get(`/v1/owner/contracts/${mc.body.id}`).set(as(agency))).body.state).toBe('signed');

    const listing = await t.http
      .post('/v1/owner/listings')
      .set(as(agency))
      .send({ unitId: unit3, titleTh: 'คอนโดใกล้ BTS', rent: '15000.00' })
      .expect(201);
    const proposed = await t.http
      .post('/v1/owner/co-broke-agreements')
      .set(as(agency))
      .set(idem())
      .send({ listingId: listing.body.id, coAgencyTenantId: agency2.tenantId, splitPercent: '40' })
      .expect(201);
    const cc = await t.http
      .post('/v1/owner/contracts')
      .set(as(agency))
      .send({ kind: 'co_broke', coBrokeAgreementId: proposed.body.id, variables: { note: 'แบ่ง 60/40' } })
      .expect(201);
    const cs = await t.http
      .post(`/v1/owner/contracts/${cc.body.id}/actions/send-for-signature`)
      .set(as(agency))
      .set(idem())
      .expect(200);
    await t.http
      .post(`/v1/owner/contracts/${cc.body.id}/actions/sign`)
      .set(as(agency))
      .set(idem())
      .send({ contractSha256: cs.body.sha256, signaturePng: PNG })
      .expect(200);
    await t.http
      .post(`/v1/owner/contracts/${cc.body.id}/actions/sign`)
      .set(as(agency))
      .set(idem())
      .send({ contractSha256: cs.body.sha256, signaturePng: PNG })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('contract.already_signed'));
    const before = await t.http
      .get(`/v1/owner/co-broke-agreements/${proposed.body.id}`)
      .set(as(agency2))
      .expect(200);
    expect(before.body).toMatchObject({ state: 'proposed', contractDocumentId: cc.body.id });
    await t.http
      .post(`/v1/owner/contracts/${cc.body.id}/actions/sign`)
      .set(as(agency2))
      .set(idem())
      .send({ contractSha256: cs.body.sha256, signaturePng: PNG })
      .expect(200);
    const after = await t.http
      .get(`/v1/owner/co-broke-agreements/${proposed.body.id}`)
      .set(as(agency2))
      .expect(200);
    expect(after.body).toMatchObject({ state: 'signed', contractDocumentId: cc.body.id });
    expect(after.body.signedAt).not.toBeNull();
    await t.http.get(`/v1/owner/contracts/${cc.body.id}`).set(as(landlord)).expect(404);
  });

  it('renewal: suggestion, offer with the B7.5 letter, one open offer, resident accepts → renewal lease sent', async () => {
    const s = await t.http
      .get(`/v1/owner/leases/${leaseId}/renewal-suggestion`)
      .set(as(landlord))
      .expect(200);
    expect(s.body.suggested).toMatchObject({ source: 'current_rent', rent: '15000.00' });
    const offer = await t.http
      .post(`/v1/owner/leases/${leaseId}/renewal-offers`)
      .set(as(landlord))
      .set(idem())
      .send({ rent: '15500', months: 12 })
      .expect(201);
    expect(offer.body).toMatchObject({
      state: 'offered',
      offeredRent: '15500.00',
      suggestionSource: 'current_rent',
    });
    expect(offer.body.noticeId).not.toBeNull();
    const notice = await q<{ kind: string }>(
      `SELECT kind::text AS kind FROM ops.lease_notice WHERE id = $1`,
      [offer.body.noticeId],
    );
    expect(notice).toEqual([{ kind: 'renewal_offer' }]);
    await t.http
      .post(`/v1/owner/leases/${leaseId}/renewal-offers`)
      .set(as(landlord))
      .set(idem())
      .send({})
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('renewal.offer_exists'));
    await t.http.get(`/v1/owner/leases/${leaseId}/renewal-offers`).set(as(stranger)).expect(404);

    await refresh();
    const mine = await t.http.get('/v1/resident/renewal-offers').set(R()).expect(200);
    expect(mine.body.data).toEqual([
      expect.objectContaining({ id: offer.body.id, nextActions: ['accept', 'decline'] }),
    ]);
    const accepted = await t.http
      .post(`/v1/resident/renewal-offers/${offer.body.id}/actions/accept`)
      .set(R())
      .set(idem())
      .expect(200);
    expect(accepted.body.state).toBe('accepted');
    renewalLease = accepted.body.newLeaseId as string;
    const lease = await t.http.get(`/v1/owner/leases/${renewalLease}`).set(as(landlord)).expect(200);
    expect(lease.body).toMatchObject({
      status: 'pending_signature',
      rent: '15500.00',
      renewedFromLeaseId: leaseId,
    });
    await t.http
      .post(`/v1/resident/renewal-offers/${offer.body.id}/actions/decline`)
      .set(R())
      .set(idem())
      .send({})
      .expect(409);
  });

  it('the renewal is signed and countersigned; the old lease closes by itself at its end (no move-out)', async () => {
    await refresh();
    const contract = await t.http.get(`/v1/resident/leases/${renewalLease}/contract`).set(R()).expect(200);
    t.clock.advance(61_000);
    const otp = await t.http
      .post(`/v1/resident/leases/${renewalLease}/signature/otp`)
      .set(R())
      .send({})
      .expect(200);
    await t.http
      .post(`/v1/resident/leases/${renewalLease}/sign`)
      .set(R())
      .set(idem())
      .send({
        challengeId: otp.body.challengeId,
        code: t.sms.lastCodeTo(PHONE),
        contractSha256: contract.body.sha256,
        signaturePng: PNG,
      })
      .expect(200);
    const counter = await t.http
      .post(`/v1/owner/leases/${renewalLease}/actions/countersign`)
      .set(as(landlord))
      .set(idem())
      .send({ signaturePng: PNG })
      .expect(200);
    expect(counter.body.status).toBe('active');
    // move the old lease's end into the past and run the hourly sweep
    await q(`UPDATE ops.lease SET start_date = $2::date - 30, end_date = $2::date WHERE id = $1`, [
      leaseId,
      new Date(t.clock.now().getTime() - 2 * DAY).toISOString().slice(0, 10),
    ]);
    await t.app.get(LeasesService).sweep();
    const old = await q<{ status: string }>(`SELECT status::text AS status FROM ops.lease WHERE id = $1`, [
      leaseId,
    ]);
    expect(old).toEqual([{ status: 'ended' }]);
    const renewal = await q<{ status: string }>(
      `SELECT status::text AS status FROM ops.lease WHERE id = $1`,
      [renewalLease],
    );
    expect(renewal).toEqual([{ status: 'active' }]);
  });

  it('decline with ≥ 30 days left records the lessee notice to the end date (move-out follows, D-219)', async () => {
    const l2 = await activeLease(unit2, today(), 6);
    lease2 = l2.id;
    const offer = await t.http
      .post(`/v1/owner/leases/${lease2}/renewal-offers`)
      .set(as(landlord))
      .set(idem())
      .send({})
      .expect(201);
    await refresh();
    const declined = await t.http
      .post(`/v1/resident/renewal-offers/${offer.body.id}/actions/decline`)
      .set(R())
      .set(idem())
      .send({ reason: 'ย้ายงาน' })
      .expect(200);
    expect(declined.body).toMatchObject({ state: 'declined', declineReason: 'ย้ายงาน' });
    const lease = await t.http.get(`/v1/owner/leases/${lease2}`).set(as(landlord)).expect(200);
    expect(lease.body.status).toBe('notice_given');
    expect(lease.body.notice).toMatchObject({
      by: 'lessee',
      reasonCode: 'renewal_declined',
      effectiveDate: l2.endDate,
    });
  });

  it('job: offers past respond-by expire; owners are reminded once per threshold', async () => {
    const l3 = await activeLease(unit3, today(), 12);
    lease3 = l3.id;
    const offer = await t.http
      .post(`/v1/owner/leases/${lease3}/renewal-offers`)
      .set(as(landlord))
      .set(idem())
      .send({})
      .expect(201);
    const job = t.app.get(LeaseRenewalsService);
    await q(`UPDATE ops.lease_renewal_offer SET respond_by = $2::date WHERE id = $1`, [
      offer.body.id,
      new Date(t.clock.now().getTime() - 2 * DAY).toISOString().slice(0, 10),
    ]);
    const first = await job.maintain();
    expect(first.expired).toBeGreaterThanOrEqual(1);
    const expired = await t.http.get(`/v1/owner/renewal-offers?state=expired`).set(as(landlord)).expect(200);
    expect((expired.body.data as { id: string }[]).map((o) => o.id)).toContain(offer.body.id);
    // 50 days before the end: the 60-day threshold reminds once (the expired offer does not block it)
    await q(`UPDATE ops.lease SET end_date = $2::date WHERE id = $1`, [
      lease3,
      new Date(t.clock.now().getTime() + 50 * DAY).toISOString().slice(0, 10),
    ]);
    await job.maintain();
    await job.maintain();
    const events = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.domain_event WHERE type = 'lease.renewal_due' AND aggregate_id = $1`,
      [lease3],
    );
    expect(events[0]!.n).toBe(1);
    const reminded = await q<{ d: number }>(
      `SELECT renewal_reminded_days AS d FROM ops.lease WHERE id = $1`,
      [lease3],
    );
    expect(reminded[0]!.d).toBe(60);
  });

  it('the platform admin records counsel’s review of a published draft without changing its text (O-025)', async () => {
    const admin = await adminToken(t);
    const lib = await t.http.get('/v1/admin/contract-library').set(bearer(admin)).expect(200);
    const reservation = (lib.body.data as { kind: string; versions: { id: string }[] }[]).find(
      (x) => x.kind === 'reservation',
    )!;
    const v = reservation.versions[0]!.id;
    const before = await q<{ body_html: string }>(
      `SELECT body_html FROM ops.lease_template_version WHERE id = $1`,
      [v],
    );
    const res = await t.http
      .put(`/v1/admin/contract-library/versions/${v}/legal-review`)
      .set(bearer(admin))
      .send({ state: 'reviewed', note: 'ตรวจแล้ว (ทดสอบ)' })
      .expect(200);
    expect(res.body).toMatchObject({ legalReviewState: 'reviewed', state: 'published' });
    const after = await q<{ body_html: string }>(
      `SELECT body_html FROM ops.lease_template_version WHERE id = $1`,
      [v],
    );
    expect(after[0]!.body_html).toBe(before[0]!.body_html);
    // the text itself still cannot change
    await expect(
      q(`UPDATE ops.lease_template_version SET body_html = 'x' WHERE id = $1`, [v]),
    ).rejects.toThrow(/append_only/);
    await t.http.get('/v1/admin/contract-library').set(as(landlord)).expect(403);
    void lease3;
  });
});
