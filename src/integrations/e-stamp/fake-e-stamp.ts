import { type EStampPayment, type EStampPort, type EStampReceipt } from './e-stamp.port';

/** Deterministic e-Stamp stand-in: a reference from the instrument, a tiny PDF receipt carrying the amount. */
export class FakeEStamp implements EStampPort {
  readonly configured = true;
  readonly paid: EStampPayment[] = [];

  pay(payment: EStampPayment): Promise<EStampReceipt> {
    this.paid.push(payment);
    const reference = `ES-${payment.madeOn.replaceAll('-', '')}-${payment.instrumentRef.replace(/[^A-Z0-9]/gi, '')}`;
    const receiptPdf = Buffer.from(
      `%PDF-1.4\n% fake e-Stamp receipt ${reference} THB ${payment.amount}\n%%EOF\n`,
      'latin1',
    );
    return Promise.resolve({ reference, paidAt: new Date(`${payment.madeOn}T03:00:00Z`), receiptPdf });
  }
}
