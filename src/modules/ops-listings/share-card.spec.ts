import { writeFileSync } from 'node:fs';

import sharp from 'sharp';

import { renderShareCard, SHARE_CARD_SIZE } from './share-card';

/** D-268: the square share card renders in Thai and English, with or without a photo. */
describe('share card (D-268)', () => {
  const base = {
    rent: '฿15,000',
    title: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์ วิวเมือง แสงดี เฟอร์นิเจอร์ครบ พร้อมเข้าอยู่ทันที',
    place: 'พญาไท, กรุงเทพมหานคร · BTS อารีย์ 350 ม.',
    facts: '1 ห้องนอน · 30 ตร.ม.',
    url: 'https://getproperty.co/s/ab12cd34',
  };

  it('renders a 1080 × 1080 PNG in Thai with the cover photo', async () => {
    const photo = await sharp({ create: { width: 1600, height: 1067, channels: 3, background: '#7aa6c2' } })
      .jpeg()
      .toBuffer();
    const png = await renderShareCard({
      ...base,
      photo,
      perMonth: '/ เดือน',
      badge: 'เจ้าของยืนยันแล้ว · ไม่มีค่านายหน้า',
      scan: 'สแกนดูห้อง',
    });
    const meta = await sharp(png).metadata();
    expect(meta).toMatchObject({ format: 'png', width: SHARE_CARD_SIZE, height: SHARE_CARD_SIZE });
    if (process.env.SHARE_CARD_OUT) writeFileSync(`${process.env.SHARE_CARD_OUT}/card-th.png`, png);
  });

  it('renders in English without a photo', async () => {
    const png = await renderShareCard({
      ...base,
      title: 'Sunny 1-bedroom condo near BTS Ari',
      place: 'Phaya Thai, Bangkok · BTS Ari 350 m',
      facts: '1 bedroom · 30 m²',
      photo: null,
      perMonth: '/ month',
      badge: 'Verified owner · No agent fee',
      scan: 'Scan to view',
    });
    expect((await sharp(png).metadata()).width).toBe(SHARE_CARD_SIZE);
    if (process.env.SHARE_CARD_OUT) writeFileSync(`${process.env.SHARE_CARD_OUT}/card-en.png`, png);
  });
});
