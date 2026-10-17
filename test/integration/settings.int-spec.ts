import { DomainException } from '@common/errors/domain.exception';
import { SettingsService } from '@core/settings/settings.service';

import { DEV } from '../../prisma/seed/run';
import { createIntApp, type IntApp } from '../support/int-app';
import { createIntDatabase, type IntDatabase } from '../support/int-db';

const OTHER_TENANT = '0199f2a0-3333-7000-8000-000000000001';

describe('SettingsService.at(key, date, scope) — most specific scope wins (§4.1)', () => {
  let db: IntDatabase;
  let t: IntApp;
  let settings: SettingsService;
  const now = new Date();
  const inTwoDays = new Date(now.getTime() + 2 * 86_400_000);

  beforeAll(async () => {
    db = await createIntDatabase({ prefix: 'gp_settings' });
    t = await createIntApp(db);
    settings = t.app.get(SettingsService);
    await db.admin.query(
      `INSERT INTO core.tenant (id, slug, display_name, legal_name, legal_form) VALUES ($1, 'o', 'O', 'O', 'company')`,
      [OTHER_TENANT],
    );
    // the tenant moves to [1, 2] from tomorrow; its property overrides the cut-off
    await db.admin.query(
      `INSERT INTO platform.tenant_setting_version (tenant_id, setting_id, value, effective_from, reason)
       SELECT $1, id, '[1, 2]', now() + interval '1 day', 'owner change' FROM platform.setting WHERE key = 'reminders.schedule'`,
      [DEV.tenantId],
    );
    await db.admin.query(
      `INSERT INTO platform.property_setting_version (tenant_id, property_id, setting_id, value, effective_from, reason)
       SELECT $1, $2, id, '{"day": 25, "time": "23:59", "timezone": "Asia/Bangkok"}', now(), 'property cut-off'
         FROM platform.setting WHERE key = 'billing.cutoff'`,
      [DEV.tenantId, DEV.propertyId],
    );
  });
  afterAll(async () => {
    await t?.close();
    await db.drop();
  });

  it('returns the platform value when nothing more specific exists', async () => {
    expect(await settings.at('reminders.schedule', now)).toMatchObject({
      scope: 'platform',
      value: [1, 3, 7],
    });
  });

  it('a future tenant version applies only from its effective date', async () => {
    expect(await settings.at('reminders.schedule', now, { tenantId: DEV.tenantId })).toMatchObject({
      scope: 'platform',
      value: [1, 3, 7],
    });
    expect(await settings.at('reminders.schedule', inTwoDays, { tenantId: DEV.tenantId })).toMatchObject({
      scope: 'tenant',
      value: [1, 2],
    });
  });

  it('property beats tenant beats platform', async () => {
    const at = new Date(now.getTime() + 60_000);
    expect(
      await settings.at('billing.cutoff', at, { tenantId: DEV.tenantId, propertyId: DEV.propertyId }),
    ).toMatchObject({
      scope: 'property',
      value: { day: 25 },
    });
    expect(await settings.at('billing.cutoff', at, { tenantId: DEV.tenantId })).toMatchObject({
      scope: 'platform',
    });
  });

  it('another tenant never sees this tenant’s versions (RLS), even when it names its property', async () => {
    expect(await settings.at('reminders.schedule', inTwoDays, { tenantId: OTHER_TENANT })).toMatchObject({
      scope: 'platform',
    });
    expect(
      await settings.at('billing.cutoff', new Date(now.getTime() + 60_000), {
        tenantId: OTHER_TENANT,
        propertyId: DEV.propertyId,
      }),
    ).toMatchObject({ scope: 'platform' });
  });

  it('an unknown key is refused', async () => {
    await expect(settings.at('no.such_key', now)).rejects.toThrow(DomainException);
  });
});
