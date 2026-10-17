export const OCR = Symbol('OCR');

export interface MeterOcrInput {
  image: Buffer;
  mimeType: string;
  utility: 'electric' | 'water';
  tenantId: string;
  /** What the staff typed, if anything (the fake returns it; the real adapter only reports it in the prompt). */
  typedValue: string | null;
  previousRegister: string | null;
}

export interface MeterOcrResult {
  /** Register read from the photo (decimal string, ≤ 3 decimals) or null when unreadable. */
  value: string | null;
  confidence: number;
  raw: string | null;
  model: string;
}

export interface UtilityInvoiceFields {
  invoiceNo: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  units: string | null;
  amount: string | null;
  ft: string | null;
  serviceCharge: string | null;
  vat: string | null;
  previousRegister: string | null;
  currentRegister: string | null;
}

export interface UtilityInvoiceOcrResult {
  fields: UtilityInvoiceFields;
  confidence: number;
  model: string;
}

/**
 * OCR of meter photos (D-035) and utility invoices / e-bills (D-032) behind one port: the real adapter asks a vision
 * model through the AI gateway; the fake returns the typed value (meters) or the JSON fields embedded in the file
 * (invoices) so tests and development stay deterministic.
 */
export interface OcrPort {
  readonly mode: 'fake' | 'real';
  readMeter(input: MeterOcrInput): Promise<MeterOcrResult>;
  readUtilityInvoice(input: {
    file: Buffer;
    mimeType: string;
    utility: 'electric' | 'water';
    tenantId: string;
  }): Promise<UtilityInvoiceOcrResult>;
}

export const EMPTY_INVOICE_FIELDS: UtilityInvoiceFields = {
  invoiceNo: null,
  periodStart: null,
  periodEnd: null,
  units: null,
  amount: null,
  ft: null,
  serviceCharge: null,
  vat: null,
  previousRegister: null,
  currentRegister: null,
};
