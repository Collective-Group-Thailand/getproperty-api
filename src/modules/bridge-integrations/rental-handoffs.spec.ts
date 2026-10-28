import { FakeGetbuildHandoff } from '@integrations/getbuild/fake-getbuild-handoff';
import { GetbuildHandoffUnavailable } from '@integrations/getbuild/getbuild-handoff.port';

import { draftTitles, firstName, tokenHash } from './rental-handoffs.service';

describe('getbuild rental handoff helpers (G8, D-299)', () => {
  it('drafts th / en titles from the unit facts (owner edits them later)', () => {
    expect(draftTitles({ projectName: 'โครงการ ทดสอบ', bedrooms: 1, areaSqm: '32.50' })).toEqual({
      th: 'โครงการ ทดสอบ 1 ห้องนอน 32.5 ตร.ม.',
      en: '1-bedroom 32.5 sqm at โครงการ ทดสอบ',
    });
    expect(draftTitles({})).toEqual({ th: 'คอนโด', en: 'Unit at คอนโด' });
    expect(draftTitles({ projectName: 'x'.repeat(300) }).th).toHaveLength(120);
  });

  it('shows only the first name and keeps only token hashes', () => {
    expect(firstName('  Somchai   Test ')).toBe('Somchai');
    expect(Buffer.from(tokenHash('abc')).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('the fake getbuild answers deterministic facts, a fixed unit, refusals and keeps deliveries', async () => {
    const fake = new FakeGetbuildHandoff();
    const ref = { developerRef: 'dev', buildingRef: 'bldg-a', unitRef: 'u-101' };
    const a = await fake.unitFacts(ref);
    expect(a).toEqual(await fake.unitFacts(ref));
    expect(a).toMatchObject({
      projectName: 'โครงการ bldg-a',
      unitNo: 'u-101',
      address: { postcode: '10900' },
    });
    fake.setFacts(ref, null);
    expect(await fake.unitFacts(ref)).toBeNull();
    fake.failNext = true;
    const invitation = {
      ...ref,
      handoffId: 'h1',
      buyerRef: 'p-1',
      url: 'https://example.com/handoff/t',
      campaignTag: 'getbuild:dev',
      expiresAt: '2026-12-01T00:00:00Z',
    };
    await expect(fake.deliverInvitation(invitation)).rejects.toThrow('refused');
    await fake.deliverInvitation(invitation);
    expect(fake.lastFor('h1')?.url).toBe('https://example.com/handoff/t');
  });

  it('with GETBUILD_MODE=off nothing is delivered and no facts are known', async () => {
    const off = new GetbuildHandoffUnavailable();
    expect(off.mode).toBe('off');
    expect(await off.unitFacts()).toBeNull();
    await expect(off.deliverInvitation()).rejects.toThrow('GETBUILD_MODE=off');
  });
});
