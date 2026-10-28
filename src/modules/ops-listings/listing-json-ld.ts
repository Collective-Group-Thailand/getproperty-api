/** The facts of a public listing the schema.org block describes (G4, D-252 / D-296). */
export interface JsonLdInput {
  url: string;
  imageUrl: string;
  title: string;
  description: string;
  unitKind: 'condo_unit' | 'house' | 'townhouse' | 'room' | null;
  /** Monthly rent, decimal string. */
  rent: string;
  sizeSqm: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  petsAllowed: boolean;
  availableFrom: string | null;
  address: string | null;
  district: string | null;
  province: string | null;
  geo: { lat: number; lng: number } | null;
  publishedAt: string;
  language: 'th' | 'en';
}

const ACCOMMODATION: Record<NonNullable<JsonLdInput['unitKind']>, string> = {
  condo_unit: 'Apartment',
  room: 'Room',
  house: 'House',
  townhouse: 'House',
};

/**
 * The schema.org JSON-LD of a public listing page (G4): an `Offer` (monthly rent as a `UnitPriceSpecification`,
 * THB, available from) whose `itemOffered` is the accommodation (floor size in m², rooms, pets, address, geo).
 * Only facts already public on the page (D-252); no contact data. The web embeds it as `application/ld+json`.
 */
export function listingJsonLd(input: JsonLdInput): Record<string, unknown> {
  const accommodation: Record<string, unknown> = {
    '@type': input.unitKind ? ACCOMMODATION[input.unitKind] : 'Accommodation',
    name: input.title,
    ...(input.sizeSqm
      ? { floorSize: { '@type': 'QuantitativeValue', value: Number(input.sizeSqm), unitCode: 'MTK' } }
      : {}),
    ...(input.bedrooms !== null ? { numberOfBedrooms: input.bedrooms } : {}),
    ...(input.bathrooms !== null ? { numberOfBathroomsTotal: input.bathrooms } : {}),
    petsAllowed: input.petsAllowed,
    address: {
      '@type': 'PostalAddress',
      ...(input.address ? { streetAddress: input.address } : {}),
      ...(input.district ? { addressLocality: input.district } : {}),
      ...(input.province ? { addressRegion: input.province } : {}),
      addressCountry: 'TH',
    },
    ...(input.geo
      ? { geo: { '@type': 'GeoCoordinates', latitude: input.geo.lat, longitude: input.geo.lng } }
      : {}),
  };
  return {
    '@context': 'https://schema.org',
    '@type': 'Offer',
    url: input.url,
    name: input.title,
    description: input.description.slice(0, 500),
    image: [input.imageUrl],
    inLanguage: input.language,
    businessFunction: 'http://purl.org/goodrelations/v1#LeaseOut',
    price: input.rent,
    priceCurrency: 'THB',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: input.rent,
      priceCurrency: 'THB',
      unitCode: 'MON',
      referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'MON' },
    },
    availability: 'https://schema.org/InStock',
    ...(input.availableFrom ? { availabilityStarts: input.availableFrom } : {}),
    validFrom: input.publishedAt,
    itemOffered: accommodation,
  };
}
