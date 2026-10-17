import { ProviderError, providerFetch } from '@integrations/http/provider-http';

import { type AiGatewayPort, type VisionRequest, type VisionResponse } from './ai-gateway.port';

export interface HttpAiGatewayOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/**
 * The Collective AI gateway over HTTPS (D-161). // UNVERIFIED against live provider — the gateway's API is not
 * published yet; this adapter assumes `POST {baseUrl}/v1/vision` with `{ model, task, images: [{ mimeType, base64 }],
 * responseSchema, tenantId, purpose }` and a JSON answer `{ output, model, usage: { inputTokens, outputTokens } }`,
 * bearer-authenticated. Images are never logged.
 */
export class HttpAiGatewayAdapter implements AiGatewayPort {
  readonly mode = 'real' as const;

  constructor(private readonly options: HttpAiGatewayOptions) {}

  async vision(request: VisionRequest): Promise<VisionResponse> {
    const res = await providerFetch({
      provider: 'ai-gateway',
      url: `${this.options.baseUrl.replace(/\/$/, '')}/v1/vision`,
      timeoutMs: this.options.timeoutMs,
      retries: 1,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({
          model: this.options.model,
          task: `${request.task}\nAnswer with JSON only, matching the schema.`,
          images: request.images.map((i) => ({ mimeType: i.mimeType, base64: i.data.toString('base64') })),
          responseSchema: request.schema,
          tenantId: request.tenantId,
          purpose: request.purpose,
        }),
      },
    });
    if (!res.ok) throw new ProviderError('ai-gateway', `HTTP ${res.status}`, res.status, res.status >= 500);
    const body = (await res.json()) as {
      output?: unknown;
      model?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    const output =
      typeof body.output === 'string'
        ? safeJson(body.output)
        : (body.output as Record<string, unknown> | null);
    return {
      json: output && typeof output === 'object' ? output : null,
      model: body.model ?? this.options.model,
      usage: body.usage
        ? { inputTokens: body.usage.inputTokens ?? 0, outputTokens: body.usage.outputTokens ?? 0 }
        : null,
    };
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim()) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Real mode without AI_GATEWAY_URL / AI_GATEWAY_API_KEY: OCR is unavailable (readings need a typed value). */
export class UnconfiguredAiGateway implements AiGatewayPort {
  readonly mode = 'real' as const;

  vision(): Promise<VisionResponse> {
    return Promise.reject(new ProviderError('ai-gateway', 'not configured', undefined, false));
  }
}
