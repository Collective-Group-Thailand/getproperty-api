import { GUIDES } from '../../prisma/seed/data/guides';
import { createIntApp, type IntApp } from '../support/int-app';
import { adminToken, bearer, supportToken } from '../support/int-auth';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

/** B7.13 acceptance — guides edited in admin, published by a second platform user, read by the public site (D-271). */
describe('guides CMS (B7.13, real PostgreSQL)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let admin: string;
  let support: string;

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_guides_b713' });
    t = await createIntApp(db);
    admin = await adminToken(t);
    support = await supportToken(t);
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('the seed round-trips the five guides in both languages unchanged', async () => {
    for (const locale of ['th', 'en'] as const) {
      const list = await t.http.get(`/v1/public/guides?locale=${locale}`).expect(200);
      expect((list.body.data as { slug: string }[]).map((g) => g.slug).sort()).toEqual(
        GUIDES.filter((g) => g.locale === locale)
          .map((g) => g.slug)
          .sort(),
      );
      for (const seed of GUIDES.filter((g) => g.locale === locale)) {
        const got = await t.http.get(`/v1/public/guides/${seed.slug}?locale=${locale}`).expect(200);
        expect(got.body).toEqual(seed);
      }
    }
    await t.http.get('/v1/public/guides/no-such-guide').expect(404);
  });

  it('a draft is not public; another platform user reviews and publishes it; unpublish takes it off', async () => {
    const seed = GUIDES.find((g) => g.slug === 'tm30' && g.locale === 'th')!;
    const draft = { ...seed, slug: 'parking-rules', title: 'กติกาที่จอดรถในคอนโด' };
    const created = await t.http.post('/v1/admin/guides').set(bearer(admin)).send(draft).expect(201);
    expect(created.body).toMatchObject({
      state: 'draft',
      reviewedBy: null,
      version: 1,
      slug: 'parking-rules',
    });
    await t.http.post('/v1/admin/guides').set(bearer(admin)).send(draft).expect(409);
    await t.http.get('/v1/public/guides/parking-rules?locale=th').expect(404);

    const id = created.body.id as string;
    const bad = await t.http
      .post('/v1/admin/guides')
      .set(bearer(admin))
      .send({ ...draft, slug: 'bad-guide', sections: [{ id: 'x', heading: 'X', blocks: [{ html: '<i>' }] }] })
      .expect(422);
    expect(JSON.stringify(bad.body)).toContain('unknown block');

    const one = await t.http.get(`/v1/admin/guides/${id}`).set(bearer(admin)).expect(200);
    await t.http.patch(`/v1/admin/guides/${id}`).set(bearer(admin)).send({ summary: 'x' }).expect(428);
    const edited = await t.http
      .patch(`/v1/admin/guides/${id}`)
      .set(bearer(admin))
      .set('If-Match', one.headers.etag as string)
      .send({ summary: 'ที่จอดรถ ใครจอดได้ จอดตรงไหน', reviewed: '2026-11-01' })
      .expect(200);
    expect(edited.body).toMatchObject({ version: 2, reviewed: '2026-11-01' });

    await t.http
      .post(`/v1/admin/guides/${id}/actions/publish`)
      .set(bearer(admin))
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('guide.same_reviewer'));
    const published = await t.http
      .post(`/v1/admin/guides/${id}/actions/publish`)
      .set(bearer(support))
      .expect(200);
    expect(published.body).toMatchObject({ state: 'published' });
    expect(published.body.reviewedBy).toEqual(expect.any(String));
    const read = await t.http.get('/v1/public/guides/parking-rules?locale=th').expect(200);
    expect(read.body).toMatchObject({
      title: 'กติกาที่จอดรถในคอนโด',
      summary: 'ที่จอดรถ ใครจอดได้ จอดตรงไหน',
    });

    await t.http.post(`/v1/admin/guides/${id}/actions/unpublish`).set(bearer(admin)).expect(200);
    await t.http.get('/v1/public/guides/parking-rules?locale=th').expect(404);
    const all = await t.http.get('/v1/admin/guides?state=draft').set(bearer(admin)).expect(200);
    expect((all.body as { slug: string }[]).map((g) => g.slug)).toContain('parking-rules');

    const audit = await db.admin.query<{ action: string }>(
      `SELECT action FROM platform.audit_log WHERE subject_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'guide.created',
      'guide.updated',
      'guide.published',
      'guide.unpublished',
    ]);
  });

  it('is for platform users with admin.guide.manage only', async () => {
    await t.http.get('/v1/admin/guides').expect(401);
  });
});
