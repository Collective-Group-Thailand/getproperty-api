import {
  type ListingDraft,
  type ListingFacts,
  type ListingWriterLanguage,
  type ListingWriterPort,
  type ListingWriterRequest,
  type ListingWriterResponse,
} from './listing-writer.port';

const KIND: Record<string, Record<ListingWriterLanguage, string>> = {
  condo_unit: { th: 'คอนโด', en: 'Condo', zh: '公寓' },
  house: { th: 'บ้าน', en: 'House', zh: '住宅' },
  room: { th: 'ห้องพัก', en: 'Room', zh: '房间' },
  townhouse: { th: 'ทาวน์เฮาส์', en: 'Townhouse', zh: '联排别墅' },
};

const money = (rent: string) => Number(rent).toLocaleString('en-US', { maximumFractionDigits: 0 });

function draftOf(f: ListingFacts, lang: ListingWriterLanguage): ListingDraft {
  const kind = (f.unitKind && KIND[f.unitKind]?.[lang]) ?? KIND.room![lang];
  const place = [f.district, f.province].filter(Boolean).join(', ');
  const size = f.sizeSqm ? `${Number(f.sizeSqm)}` : null;
  if (lang === 'th') {
    const lines = [
      `${kind}${f.bedrooms ? ` ${f.bedrooms} ห้องนอน` : ''}${size ? ` ${size} ตร.ม.` : ''}${place ? ` ย่าน${place}` : ''}`,
      `ค่าเช่า ${money(f.rent)} บาท/เดือน มัดจำ ${f.depositMonths} เดือน ล่วงหน้า ${f.advanceMonths} เดือน สัญญาขั้นต่ำ ${f.minTermMonths} เดือน`,
      f.transit ? `ใกล้ ${f.transit.name}${f.transit.distanceM ? ` (${f.transit.distanceM} ม.)` : ''}` : null,
      f.facilities.length ? `สิ่งอำนวยความสะดวก: ${f.facilities.join(', ')}` : null,
      f.petsAllowed ? 'เลี้ยงสัตว์ได้' : 'ไม่อนุญาตให้เลี้ยงสัตว์',
    ];
    return {
      title: `${kind}${size ? ` ${size} ตร.ม.` : ''}${place ? ` ${place}` : ''}`.slice(0, 120),
      description: lines.filter(Boolean).join('\n'),
    };
  }
  if (lang === 'zh') {
    const lines = [
      `${place ? `${place} ` : ''}${kind}${f.bedrooms ? ` ${f.bedrooms}室` : ''}${size ? ` ${size}平方米` : ''}`,
      `月租 ${money(f.rent)} 泰铢，押金 ${f.depositMonths} 个月，预付 ${f.advanceMonths} 个月，最短租期 ${f.minTermMonths} 个月`,
      f.transit ? `靠近 ${f.transit.name}` : null,
      f.petsAllowed ? '可养宠物' : '不可养宠物',
    ];
    return {
      title: `${kind}${size ? ` ${size}平方米` : ''}${place ? ` ${place}` : ''}`.slice(0, 120),
      description: lines.filter(Boolean).join('\n'),
    };
  }
  const lines = [
    `${f.bedrooms ? `${f.bedrooms}-bedroom ` : ''}${kind.toLowerCase()}${size ? ` of ${size} sqm` : ''}${place ? ` in ${place}` : ''}.`,
    `Rent ${money(f.rent)} THB a month, ${f.depositMonths} months deposit, ${f.advanceMonths} month(s) in advance, minimum ${f.minTermMonths} months.`,
    f.transit ? `Near ${f.transit.name}${f.transit.distanceM ? ` (${f.transit.distanceM} m)` : ''}.` : null,
    f.facilities.length ? `Facilities: ${f.facilities.join(', ')}.` : null,
    f.petsAllowed ? 'Pets allowed.' : 'No pets.',
  ];
  return {
    title: `${kind}${size ? ` ${size} sqm` : ''}${place ? `, ${place}` : ''}`.slice(0, 120),
    description: lines.filter(Boolean).join('\n'),
  };
}

/** Dev / tests: deterministic drafts built from the facts (no model, no network). Records every request. */
export class FakeListingWriter implements ListingWriterPort {
  readonly mode = 'fake' as const;
  readonly requests: ListingWriterRequest[] = [];
  /** Tests: the next answer is replaced by this one (e.g. a draft containing a phone number). */
  nextDrafts: ListingWriterResponse['drafts'] | null = null;
  /** Tests: the next call fails like an unreachable gateway. */
  failNext = false;

  draft(request: ListingWriterRequest): Promise<ListingWriterResponse> {
    this.requests.push(request);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fake AI gateway unreachable'));
    }
    const drafts =
      this.nextDrafts ?? Object.fromEntries(request.languages.map((l) => [l, draftOf(request.facts, l)]));
    this.nextDrafts = null;
    const chars = JSON.stringify(drafts).length;
    return Promise.resolve({
      drafts,
      model: 'fake-listing-writer',
      usage: { inputTokens: 200 + request.photos.length * 300, outputTokens: Math.ceil(chars / 4) },
    });
  }
}
