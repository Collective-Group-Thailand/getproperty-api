/**
 * Obviously fake personal data for OpenAPI examples (contract §5, PDPA): the forms
 * `getproperty-no-real-personal-data` accepts (`contract/spectral/README.md`). Use these in new examples
 * instead of inventing values.
 */
export const FAKE = {
  name: 'Somchai Test',
  nameTh: 'ผู้เช่า ทดสอบ',
  phone: '081-000-1234',
  email: 'test@example.com',
  nationalId: '0000000000001',
  taxId: '0000000000001',
  companyName: 'บริษัท ตัวอย่าง จำกัด',
  propertyName: 'หอพักตัวอย่าง',
  addressLine: '99/9 ถนนตัวอย่าง',
  postcode: '10110',
  unitCode: 'A-201',
  tenantId: '0d0c7a4e-5b0e-4c55-9d7c-3f2b8a1e6c11',
  propertyId: '7b9f1c2e-3d4a-4f5b-8c6d-9e0f1a2b3c4d',
  buildingId: '5c8e2a1f-6b3d-4e7a-9f0c-1d2e3f4a5b6c',
  gatewayId: '2f6c1d7e-9a3b-4c5d-8e7f-0a1b2c3d4e5f',
  meterId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  uuid: '3b241101-e2bb-4255-8caf-4136c566a962',
  dateTime: '2026-11-01T00:15:00+07:00',
  date: '2026-11-01',
} as const;
