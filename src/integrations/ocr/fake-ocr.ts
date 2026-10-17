import {
  EMPTY_INVOICE_FIELDS,
  type MeterOcrInput,
  type MeterOcrResult,
  type OcrPort,
  type UtilityInvoiceFields,
  type UtilityInvoiceOcrResult,
} from './ocr.port';

/**
 * Deterministic OCR for development and tests (D-035 "fake in tests"): a meter photo "reads" as the typed value with
 * confidence 0.99 (unreadable without one); an invoice file whose bytes are JSON returns those fields with 0.95.
 * `primeMeter` lets a test make the next photo read as another value / confidence.
 */
export class FakeOcr implements OcrPort {
  readonly mode = 'fake' as const;
  private primed: MeterOcrResult[] = [];

  primeMeter(value: string | null, confidence: number): void {
    this.primed.push({ value, confidence, raw: value, model: 'fake' });
  }

  readMeter(input: MeterOcrInput): Promise<MeterOcrResult> {
    const next = this.primed.shift();
    if (next) return Promise.resolve(next);
    return Promise.resolve(
      input.typedValue
        ? { value: input.typedValue, confidence: 0.99, raw: input.typedValue, model: 'fake' }
        : { value: null, confidence: 0, raw: null, model: 'fake' },
    );
  }

  readUtilityInvoice(input: { file: Buffer }): Promise<UtilityInvoiceOcrResult> {
    try {
      const parsed = JSON.parse(input.file.toString('utf8')) as Partial<UtilityInvoiceFields>;
      const fields = { ...EMPTY_INVOICE_FIELDS };
      for (const key of Object.keys(fields) as (keyof UtilityInvoiceFields)[])
        if (typeof parsed[key] === 'string') fields[key] = parsed[key];
      return Promise.resolve({ fields, confidence: 0.95, model: 'fake' });
    } catch {
      return Promise.resolve({ fields: { ...EMPTY_INVOICE_FIELDS }, confidence: 0, model: 'fake' });
    }
  }
}
