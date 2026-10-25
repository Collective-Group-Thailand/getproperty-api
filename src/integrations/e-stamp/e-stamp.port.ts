export const E_STAMP = Symbol('E_STAMP');

export interface EStampPayment {
  /** The lease number (the instrument's reference at the Revenue Department). */
  instrumentRef: string;
  /** The lessor's tax id (13 digits) when known. */
  lessorTaxId: string | null;
  /** Duty in baht, decimal string. */
  amount: string;
  /** Bangkok date the instrument was made (both signatures). */
  madeOn: string;
}

export interface EStampReceipt {
  /** The e-Stamp reference to print on the lease. */
  reference: string;
  paidAt: Date;
  /** The Revenue Department receipt (PDF). */
  receiptPdf: Buffer;
}

/**
 * Revenue Department e-Stamp Duty (B7.5, D-253, O-019): the platform pays the stamp duty of a lease signed on
 * getproperty and keeps the receipt with the lease. No production adapter exists yet — `E_STAMP_MODE=off` (default)
 * means `configured` is false and owners record the payment by hand; `fake` is for tests and demos. A real adapter is
 * switched on by configuration only (O-019: the feature is on as soon as one is configured).
 */
export interface EStampPort {
  readonly configured: boolean;
  pay(payment: EStampPayment): Promise<EStampReceipt>;
}

export class EStampUnavailable implements EStampPort {
  readonly configured = false;

  pay(): Promise<EStampReceipt> {
    return Promise.reject(new Error('no e-Stamp adapter is configured (E_STAMP_MODE=off)'));
  }
}
