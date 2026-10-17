import { type DocumentKind } from '@generated/prisma/client';

const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const PDF = ['application/pdf'];
const SHEETS = ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

/**
 * Per document kind: accepted MIME types, size limit (bytes) and retention class (`platform.retention_policy`
 * target_key; D-025). Kinds produced by the platform itself (PDFs, exports) are written server-side and not
 * uploadable through presign.
 */
export const DOCUMENT_POLICY: Partial<
  Record<DocumentKind, { mime: string[]; maxBytes: number; retentionClass: string }>
> = {
  meter_photo: { mime: IMAGES, maxBytes: 15_000_000, retentionClass: 'meter_photo' },
  inspection_photo: { mime: IMAGES, maxBytes: 15_000_000, retentionClass: 'inspection_photo' },
  service_photo: { mime: IMAGES, maxBytes: 15_000_000, retentionClass: 'service_photo' },
  slip: { mime: [...IMAGES, ...PDF], maxBytes: 10_000_000, retentionClass: 'slip' },
  id_document: { mime: [...IMAGES, ...PDF], maxBytes: 10_000_000, retentionClass: 'id_document' },
  logo: {
    mime: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
    maxBytes: 2_000_000,
    retentionClass: 'logo',
  },
  contract: { mime: PDF, maxBytes: 50_000_000, retentionClass: 'contract' },
  utility_invoice: { mime: [...IMAGES, ...PDF], maxBytes: 15_000_000, retentionClass: 'utility_invoice' },
  floor_plan: { mime: [...IMAGES, ...PDF], maxBytes: 50_000_000, retentionClass: 'other' },
  as_built: { mime: [...IMAGES, ...PDF], maxBytes: 500_000_000, retentionClass: 'other' },
  certificate: { mime: [...IMAGES, ...PDF], maxBytes: 20_000_000, retentionClass: 'other' },
  warranty: { mime: [...IMAGES, ...PDF], maxBytes: 20_000_000, retentionClass: 'other' },
  other: { mime: [...IMAGES, ...PDF, ...SHEETS], maxBytes: 50_000_000, retentionClass: 'other' },
  // Uploaded by gateways only (`POST /v1/device/logs/presign`, `upload_logs`; never by operators).
  log_bundle: { mime: ['application/gzip'], maxBytes: 50_000_000, retentionClass: 'log_bundle' },
};

/** Multipart above 50 MB (S3 parts 5 MB … 5 GB); single PUT below. */
export const MULTIPART_THRESHOLD = 50_000_000;
export const PART_SIZE = 10_000_000;

/** Kinds whose downloads are PDPA-sensitive: every download is audited (D-025). */
export const AUDITED_DOWNLOADS: DocumentKind[] = ['id_document', 'slip', 'contract'];

export const isImage = (mime: string) => IMAGES.includes(mime) && mime !== 'image/heic';
