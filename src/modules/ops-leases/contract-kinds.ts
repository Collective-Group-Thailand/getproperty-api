import { type ContractKind, type ContractSignerRole } from '@generated/prisma/client';

import { type ContractData } from './contract-renderer';
import { type NoticeData } from './notice-templates';

/**
 * Contract library kinds (D-290, D-294). Lease kinds are signed as `ops.lease` (B2.3 / B7.5), notice kinds are the
 * B7.5 letters (unilateral, not signed by the recipient), the others are signable `ops.contract_document`s.
 */
export const CONTRACT_KINDS: ContractKind[] = [
  'lease_apartment_ocpb',
  'lease_condo_private',
  'lease_house',
  'lease_room',
  'reservation',
  'brokerage_mandate',
  'co_broke',
  'addendum',
  'notice_termination',
  'notice_renewal',
];
export const LEASE_KINDS: ContractKind[] = [
  'lease_apartment_ocpb',
  'lease_condo_private',
  'lease_house',
  'lease_room',
];
export const SIGNABLE_KINDS = ['reservation', 'brokerage_mandate', 'co_broke', 'addendum'] as const;
export type SignableKind = (typeof SIGNABLE_KINDS)[number];
export const NOTICE_KINDS: ContractKind[] = ['notice_termination', 'notice_renewal'];

export const isLeaseKind = (k: ContractKind) => LEASE_KINDS.includes(k);
export const isSignableKind = (k: ContractKind): k is SignableKind =>
  (SIGNABLE_KINDS as readonly string[]).includes(k);

/** Kinds the สคบ. 2568 forbidden-clause check applies to (residential lease texts and their addenda, D-020). */
export const CHECKED_KINDS: ContractKind[] = [
  ...LEASE_KINDS,
  'addendum',
  'notice_termination',
  'notice_renewal',
];

/** Who signs a signable kind, in order (the first signer of each kind is the tenant writing the document). */
export const SIGNER_ROLES: Record<SignableKind, ContractSignerRole[]> = {
  reservation: ['lessor', 'prospect'],
  brokerage_mandate: ['owner', 'agency'],
  co_broke: ['agency', 'co_agency'],
  addendum: ['lessor', 'lessee'],
};

/**
 * Values the user may type when creating a document (everything else is filled from the unit, lease, mandate or
 * co-broke agreement); any other key is refused (`contract.unknown_variable`).
 */
export const INPUT_VARIABLES: Record<SignableKind, Record<string, 'money' | 'date' | 'text' | 'clauses'>> = {
  reservation: { fee: 'money', rent: 'money', moveInDate: 'date', expiresOn: 'date', refundTerms: 'text' },
  brokerage_mandate: { note: 'text' },
  co_broke: { note: 'text' },
  addendum: { effectiveDate: 'date', clauses: 'clauses' },
};

/** A signature block as the templates read it (`signatures.<role>`). */
export interface SignatureView {
  signedAt: string;
  imageDataUrl: string;
}

export interface PartyBlock {
  legalName: string;
  taxId: string | null;
  address: string;
}

export interface PremisesBlock {
  unitNo: string;
  buildingName: string;
  propertyName: string;
  address: string;
  areaSqm: string | null;
}

/** What a signable document renders from (all values formatted for its language). */
export interface ContractDocData {
  draft: boolean;
  disclaimer: string;
  contract: { number: string | null; madeAt: string; madeOn: string };
  template: { key: string; version: number; legalRef: string; legalReview: string };
  premises: PremisesBlock;
  signatures: Partial<Record<ContractSignerRole, SignatureView | null>>;
  signers: { role: string; name: string }[];
  lessor?: PartyBlock;
  lessee?: { displayName: string; phone: string | null };
  prospect?: { displayName: string; phone: string | null };
  owner?: PartyBlock;
  agency?: PartyBlock;
  coAgency?: PartyBlock;
  reservation?: {
    fee: string;
    feeText: string;
    rent: string;
    rentText: string;
    moveInDate: string;
    expiresOn: string;
    refundTerms: string | null;
  };
  mandate?: {
    scope: string;
    exclusive: boolean;
    commissionTerms: string | null;
    commissionPercent: string | null;
    commissionAmount: string | null;
    validFrom: string;
    validTo: string | null;
    note: string | null;
  };
  coBroke?: {
    splitPercent: string;
    validFrom: string;
    validTo: string | null;
    listingTitle: string;
    note: string | null;
  };
  lease?: { number: string | null; startDate: string; endDate: string; rent: string };
  addendum?: { effectiveDate: string; clauses: { title: string; text: string }[] };
}

const PARTY: PartyBlock = {
  legalName: 'บริษัท ตัวอย่าง จำกัด',
  taxId: '0000000000000',
  address: 'กรุงเทพมหานคร',
};
const PREMISES: PremisesBlock = {
  unitNo: 'A-101',
  buildingName: 'อาคาร A',
  propertyName: 'โครงการตัวอย่าง',
  address: 'ถนนพหลโยธิน พญาไท กรุงเทพมหานคร 10400',
  areaSqm: '30.00',
};
const SIG: SignatureView = { signedAt: '1 พฤศจิกายน 2569', imageDataUrl: 'data:image/png;base64,' };

/** Sample data of a signable kind: the preview of a library draft and the variable catalogue of that kind. */
export function sampleDocData(kind: SignableKind): ContractDocData {
  const base: ContractDocData = {
    draft: true,
    disclaimer: 'ตัวอย่างสัญญาเพื่ออำนวยความสะดวก ไม่ใช่คำแนะนำทางกฎหมาย',
    contract: { number: 'CTR-2026-00001', madeAt: 'โครงการตัวอย่าง', madeOn: '1 พฤศจิกายน 2569' },
    template: { key: 'library_sample', version: 1, legalRef: '⚖', legalReview: 'pending_legal_verification' },
    premises: PREMISES,
    signatures: Object.fromEntries(SIGNER_ROLES[kind].map((r) => [r, SIG])),
    signers: SIGNER_ROLES[kind].map((role) => ({ role, name: 'ตัวอย่าง' })),
  };
  switch (kind) {
    case 'reservation':
      return {
        ...base,
        lessor: PARTY,
        prospect: { displayName: 'สมศรี ใจดี', phone: '+66810000000' },
        reservation: {
          fee: '5,000.00',
          feeText: 'ห้าพันบาทถ้วน',
          rent: '15,000.00',
          rentText: 'หนึ่งหมื่นห้าพันบาทถ้วน',
          moveInDate: '1 ธันวาคม 2569',
          expiresOn: '15 พฤศจิกายน 2569',
          refundTerms: 'คืนเต็มจำนวนหากผู้ให้เช่าไม่ทำสัญญาเช่า',
        },
      };
    case 'brokerage_mandate':
      return {
        ...base,
        owner: PARTY,
        agency: PARTY,
        mandate: {
          scope: 'list',
          exclusive: false,
          commissionTerms: 'ค่านายหน้า 1 เดือน',
          commissionPercent: '100.0000',
          commissionAmount: null,
          validFrom: '1 พฤศจิกายน 2569',
          validTo: null,
          note: null,
        },
      };
    case 'co_broke':
      return {
        ...base,
        agency: PARTY,
        coAgency: PARTY,
        coBroke: {
          splitPercent: '50.0000',
          validFrom: '1 พฤศจิกายน 2569',
          validTo: null,
          listingTitle: 'คอนโดใกล้ BTS',
          note: null,
        },
      };
    case 'addendum':
      return {
        ...base,
        lessor: PARTY,
        lessee: { displayName: 'สมศรี ใจดี', phone: '+66810000000' },
        lease: {
          number: 'CTR-2026-00001',
          startDate: '1 ตุลาคม 2569',
          endDate: '30 กันยายน 2570',
          rent: '15,000.00',
        },
        addendum: {
          effectiveDate: '1 พฤศจิกายน 2569',
          clauses: [{ title: 'สัตว์เลี้ยง', text: 'อนุญาตแมว 1 ตัว' }],
        },
      };
  }
}

/** Sample lease data (every field of `ContractData`): the variable catalogue of the lease kinds. */
export const SAMPLE_LEASE_DATA: ContractData = {
  draft: true,
  contract: { number: 'CTR-2026-00001', madeAt: 'โครงการตัวอย่าง', madeOn: '1 ตุลาคม 2569' },
  lessor: PARTY,
  lessee: {
    displayName: 'สมศรี ใจดี',
    idDocumentLabel: 'เลขประจำตัวประชาชน',
    idNumber: 'xxxxxxxxxxxxx',
    nationality: 'TH',
    address: 'กรุงเทพมหานคร',
    phone: '+66810000000',
  },
  coTenants: [{ displayName: 'ผู้เช่าร่วม' }],
  premises: {
    unitNo: 'A-101',
    floorName: 'ชั้น 1',
    buildingName: 'อาคาร A',
    propertyName: 'โครงการตัวอย่าง',
    address: PREMISES.address,
    areaSqm: '30.00',
    equipment: [{ name: 'แอร์', location: 'ห้องนอน' }],
    keysCount: 2,
    parkingSlots: 1,
  },
  term: { months: 12, startDate: '1 ตุลาคม 2569', endDate: '30 กันยายน 2570' },
  rent: { amount: '15,000.00', text: 'หนึ่งหมื่นห้าพันบาทถ้วน', dueDay: '5' },
  rentIncreases: [
    { effectiveFrom: '1 ตุลาคม 2570', amount: '15,500.00', text: '-', effectiveFromEn: '-', textEn: '-' },
  ],
  utilities: { metered: true, electricProvider: 'การไฟฟ้านครหลวง', waterProvider: 'การประปานครหลวง' },
  lines: [
    { description: 'อินเทอร์เน็ต', amount: '300.00', recurrence: 'ต่อเดือน', recurrenceEn: 'per month' },
  ],
  deposit: { amount: '30,000.00', text: 'สามหมื่นบาทถ้วน' },
  advanceRent: { amount: '15,000.00', text: 'หนึ่งหมื่นห้าพันบาทถ้วน' },
  depositCapMonths: '3',
  invoiceLeadDays: 7,
  refundDays: 7,
  noticeDays: 30,
  remedyDays: 30,
  disturbanceDays: 7,
  addendum: [{ title: 'สัตว์เลี้ยง', text: 'อนุญาตแมว 1 ตัว' }],
  signatures: {
    lessor: { ...SIG, signedAtEn: '1 October 2026' },
    lessee: { ...SIG, signedAtEn: '1 October 2026' },
  },
  template: { key: 'ocpb_2568_residential_th', version: 1, legalRef: '⚖' },
  en: {
    madeOn: '1 October 2026',
    startDate: '1 October 2026',
    endDate: '30 September 2027',
    rentText: 'Fifteen thousand baht only',
    depositText: 'Thirty thousand baht only',
    advanceText: 'Fifteen thousand baht only',
    idDocumentLabel: 'Thai ID card no.',
    electricProvider: 'the Metropolitan Electricity Authority',
    waterProvider: 'the Metropolitan Waterworks Authority',
  },
  stampDuty: {
    amount: '180.00',
    text: 'หนึ่งร้อยแปดสิบบาทถ้วน',
    textEn: 'One hundred and eighty baht only',
    payer: 'lessor',
    payerTh: 'ผู้ให้เช่า',
    payerEn: 'the Lessor',
  },
};

/** Sample notice data (every field of `NoticeData`): the variable catalogue of the notice kinds. */
export const SAMPLE_NOTICE_DATA: NoticeData = {
  number: 'NTC-2026-00001',
  issuedOn: '1 สิงหาคม 2570',
  lessor: PARTY,
  lessee: { displayName: 'สมศรี ใจดี', address: 'กรุงเทพมหานคร' },
  premises: { unitNo: 'A-101', propertyName: 'โครงการตัวอย่าง', address: PREMISES.address },
  lease: {
    number: 'CTR-2026-00001',
    startDate: '1 ตุลาคม 2569',
    endDate: '30 กันยายน 2570',
    rent: '15,000.00',
    rentText: 'หนึ่งหมื่นห้าพันบาทถ้วน',
  },
  effectiveDate: '1 ตุลาคม 2570',
  respondBy: '15 สิงหาคม 2570',
  noticeDays: 60,
  newRent: '15,500.00',
  newRentText: 'หนึ่งหมื่นห้าพันห้าร้อยบาทถ้วน',
  renewalMonths: 12,
  reasonCode: 'lessee_breach',
  amountDue: null,
  amountDueText: null,
  items: [{ number: 'INV-2026-00001', dueDate: '5 กันยายน 2570', balance: '15,000.00' }],
  refundDays: 7,
  message: 'ข้อความจากผู้ให้เช่า',
};

/** The sample data a kind renders from (preview of a template and its variable catalogue). */
export function sampleDataOf(kind: ContractKind): object {
  if (isLeaseKind(kind)) return SAMPLE_LEASE_DATA;
  if (isSignableKind(kind)) return sampleDocData(kind);
  return SAMPLE_NOTICE_DATA;
}

/**
 * Every variable path a template of this kind may read: object keys (each prefix too), arrays as `name[]` (and
 * `name.length`), inside `{{#each name}}` the item paths. Optional blocks of other kinds never leak in.
 */
export function variableCatalogue(kind: ContractKind): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown, path: string) => {
    if (path) out.add(path);
    if (Array.isArray(value)) {
      out.add(`${path}.length`);
      const item: unknown = value[0];
      if (item !== undefined) walk(item, `${path}[]`);
      return;
    }
    if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(sampleDataOf(kind), '');
  // every signer role of a signable kind may have a signature block (null until signed)
  if (isSignableKind(kind))
    for (const role of SIGNER_ROLES[kind])
      for (const k of ['', '.signedAt', '.imageDataUrl']) out.add(`signatures.${role}${k}`);
  return out;
}
