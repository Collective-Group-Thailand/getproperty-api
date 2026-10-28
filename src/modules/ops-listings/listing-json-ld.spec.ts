import { listingJsonLd } from './listing-json-ld';

describe('listing JSON-LD (G4, D-296)', () => {
  const base = {
    url: 'https://getproperty.co/rent/condo-1br-0a1b2c3d4e',
    imageUrl: 'https://api.getproperty.co/v1/public/listings/condo-1br-0a1b2c3d4e/og-image',
    title: 'คอนโด 1 ห้องนอน ใกล้ BTS อารีย์',
    description: 'ห้องมุม แสงดี',
    unitKind: 'condo_unit' as const,
    rent: '15000.00',
    sizeSqm: '28.50',
    bedrooms: 1,
    bathrooms: 1,
    petsAllowed: false,
    availableFrom: '2026-12-01',
    address: 'ถนนพหลโยธิน, พญาไท, กรุงเทพมหานคร 10400',
    district: 'พญาไท',
    province: 'กรุงเทพมหานคร',
    geo: { lat: 13.7799, lng: 100.5446 },
    publishedAt: '2026-11-01T10:00:00+07:00',
    language: 'th' as const,
  };

  it('is an Offer of the accommodation with a monthly THB price, as strings from the API', () => {
    const ld = listingJsonLd(base);
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Offer',
      price: '15000.00',
      priceCurrency: 'THB',
      priceSpecification: { '@type': 'UnitPriceSpecification', unitCode: 'MON', price: '15000.00' },
      availabilityStarts: '2026-12-01',
      image: [base.imageUrl],
      itemOffered: {
        '@type': 'Apartment',
        floorSize: { value: 28.5, unitCode: 'MTK' },
        numberOfBedrooms: 1,
        address: { addressCountry: 'TH', addressLocality: 'พญาไท' },
        geo: { latitude: 13.7799 },
      },
    });
  });

  it('leaves out what the listing does not state', () => {
    const ld = listingJsonLd({
      ...base,
      unitKind: null,
      sizeSqm: null,
      bedrooms: null,
      bathrooms: null,
      availableFrom: null,
      geo: null,
      address: null,
    });
    const item = ld.itemOffered as Record<string, unknown>;
    expect(item['@type']).toBe('Accommodation');
    expect(item).not.toHaveProperty('floorSize');
    expect(item).not.toHaveProperty('geo');
    expect(ld).not.toHaveProperty('availabilityStarts');
  });
});
