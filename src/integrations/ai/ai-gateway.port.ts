export const AI_GATEWAY = Symbol('AI_GATEWAY');

export interface VisionRequest {
  /** What to extract, in plain words (the adapter adds the JSON-only instruction). */
  task: string;
  images: { data: Buffer; mimeType: string }[];
  /** JSON Schema of the expected answer. */
  schema: Record<string, unknown>;
  /** Tenant the call is billed to (AI usage per tenant, D-161). */
  tenantId: string | null;
  purpose: 'meter_ocr' | 'utility_invoice_ocr';
}

export interface VisionResponse {
  json: Record<string, unknown> | null;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/**
 * The AI gateway shared with getbuild (D-161, Phase 2+): one port for vision-language calls so models, keys,
 * quotas and the per-tenant usage metering live in one place. B3 uses it for meter and utility-invoice OCR.
 */
export interface AiGatewayPort {
  readonly mode: 'fake' | 'real';
  vision(request: VisionRequest): Promise<VisionResponse>;
}
