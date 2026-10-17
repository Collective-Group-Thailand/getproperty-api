import { type AiGatewayPort } from '@integrations/ai/ai-gateway.port';

import {
  EMPTY_INVOICE_FIELDS,
  type MeterOcrInput,
  type MeterOcrResult,
  type OcrPort,
  type UtilityInvoiceFields,
  type UtilityInvoiceOcrResult,
} from './ocr.port';

const REGISTER = /^\d{1,9}(\.\d{1,3})?$/;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * OCR through a vision-language model behind the AI gateway (D-035, D-161). // UNVERIFIED against live provider —
 * prompts and schemas are written for a general vision model; accuracy on Thai meter faces and MEA/PEA/MWA/PWA
 * invoices must be measured on pilot photos before the review thresholds are tuned. Values that do not match the
 * expected formats are discarded (never guessed).
 */
export class VisionOcrAdapter implements OcrPort {
  readonly mode = 'real' as const;

  constructor(private readonly ai: AiGatewayPort) {}

  async readMeter(input: MeterOcrInput): Promise<MeterOcrResult> {
    const unit = input.utility === 'electric' ? 'kWh' : 'm³';
    const res = await this.ai.vision({
      purpose: 'meter_ocr',
      tenantId: input.tenantId,
      images: [{ data: input.image, mimeType: input.mimeType }],
      task:
        `Read the cumulative register of this ${input.utility} meter (${unit}). Report every digit of the main ` +
        'register including the decimal drum (red digits or digits after the separator are decimals). Do not round. ' +
        'If the register is not readable, return value null. Give your confidence between 0 and 1.',
      schema: {
        type: 'object',
        properties: { value: { type: ['string', 'null'] }, confidence: { type: 'number' } },
        required: ['value', 'confidence'],
      },
    });
    const value = typeof res.json?.value === 'string' ? res.json.value.replace(/[,\s]/g, '') : null;
    const confidence =
      typeof res.json?.confidence === 'number' ? Math.min(1, Math.max(0, res.json.confidence)) : 0;
    return {
      value: value && REGISTER.test(value) ? value : null,
      confidence: value && REGISTER.test(value) ? confidence : 0,
      raw: typeof res.json?.value === 'string' ? res.json.value.slice(0, 64) : null,
      model: res.model,
    };
  }

  async readUtilityInvoice(input: {
    file: Buffer;
    mimeType: string;
    utility: 'electric' | 'water';
    tenantId: string;
  }): Promise<UtilityInvoiceOcrResult> {
    const res = await this.ai.vision({
      purpose: 'utility_invoice_ocr',
      tenantId: input.tenantId,
      images: [{ data: input.file, mimeType: input.mimeType }],
      task:
        `Extract the fields of this Thai ${input.utility === 'electric' ? 'MEA/PEA electricity' : 'MWA/PWA water'} ` +
        'invoice: invoice number, billing period start and end (ISO dates, Gregorian), units consumed, total amount ' +
        'in THB, Ft amount, service charge, VAT, previous and current meter register. Use null for anything absent.',
      schema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.keys(EMPTY_INVOICE_FIELDS).map((k) => [k, { type: ['string', 'null'] }]),
        ),
      },
    });
    const fields = { ...EMPTY_INVOICE_FIELDS };
    const pick = (key: keyof UtilityInvoiceFields, pattern: RegExp) => {
      const v = res.json?.[key];
      if (typeof v === 'string' && pattern.test(v.replace(/,/g, ''))) fields[key] = v.replace(/,/g, '');
    };
    pick('invoiceNo', /^[\w-]{1,40}$/);
    pick('periodStart', DATE);
    pick('periodEnd', DATE);
    pick('units', REGISTER);
    pick('amount', MONEY);
    pick('ft', /^-?\d{1,10}(\.\d{1,4})?$/);
    pick('serviceCharge', MONEY);
    pick('vat', MONEY);
    pick('previousRegister', REGISTER);
    pick('currentRegister', REGISTER);
    const filled = Object.values(fields).filter((v) => v !== null).length;
    return { fields, confidence: filled / Object.keys(fields).length, model: res.model };
  }
}
