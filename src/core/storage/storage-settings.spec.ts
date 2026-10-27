import { SETTINGS } from '../settings/catalogue';
import { STORAGE_RETENTION } from './storage-metering.service';
import {
  DEFAULT_RECORD_BYTES,
  noticeProblems,
  packsProblems,
  perTenantTypeProblems,
  recordBytesProblems,
} from './storage-settings';

describe('storage metering settings (D-276)', () => {
  it('seeds 5 GB free per tenant type (D-279), no overage price, no packs and the recommended record sizes', () => {
    const v = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));
    expect(v['storage.free_gb']!.value).toEqual({
      apartment: '5',
      condo_juristic: '5',
      pm_company: '5',
      landlord: '5',
      agency: '5',
    });
    expect(v['storage.price_per_gb_month']!.value).toEqual({
      apartment: null,
      condo_juristic: null,
      pm_company: null,
      landlord: null,
      agency: null,
    });
    expect(v['storage.packs']!.value).toEqual([]);
    expect(v['storage.notice_at_percent']!.value).toEqual([80, 100]);
    expect(v['storage.record_bytes']!.value).toBe(DEFAULT_RECORD_BYTES);
    for (const key of [
      'storage.free_gb',
      'storage.price_per_gb_month',
      'storage.packs',
      'storage.record_bytes',
    ])
      expect(v[key]!.check!(v[key]!.value)).toEqual([]);
  });

  it('validates the shapes', () => {
    expect(perTenantTypeProblems({ apartment: '5', landlord: null })).toEqual([]);
    expect(perTenantTypeProblems({ dorm: '5' })).toEqual(['dorm: unknown tenant type']);
    expect(perTenantTypeProblems({ apartment: 5 })).toEqual(['apartment: a decimal string or null']);
    expect(perTenantTypeProblems([])).toEqual(['must be an object']);
    expect(packsProblems([{ key: 'plus-20', gb: '20', monthlyPrice: '49.00' }])).toEqual([]);
    expect(
      packsProblems([
        { key: 'a', gb: '1', monthlyPrice: '1' },
        { key: 'a', gb: 'x', monthlyPrice: '1' },
      ]),
    ).toEqual(['[1].key: duplicate', '[1].gb: decimal string']);
    expect(recordBytesProblems({ invoice: 2048 })).toEqual(['_default: required']);
    expect(recordBytesProblems({ _default: -1 })).toEqual(['_default: integer bytes 0–10000000']);
    expect(noticeProblems([80, 100])).toEqual([]);
    expect(noticeProblems([0])).toEqual(['percentages 1–1000']);
  });

  it('never holds a document the law requires; operational files are accepted and billed', () => {
    expect(['contract', 'utility_invoice', 'id_document'].map((k) => STORAGE_RETENTION[k as never])).toEqual([
      'legal',
      'legal',
      'legal',
    ]);
    expect(['meter_photo', 'slip', 'service_photo'].map((k) => STORAGE_RETENTION[k as never])).toEqual([
      'operational',
      'operational',
      'operational',
    ]);
    expect(STORAGE_RETENTION.other).toBe('optional');
  });
});
