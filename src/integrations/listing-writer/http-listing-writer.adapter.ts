import {
  type ListingDraft,
  type ListingWriterLanguage,
  type ListingWriterPort,
  type ListingWriterRequest,
  type ListingWriterResponse,
  ListingWriterUnavailable,
} from './listing-writer.port';

export interface HttpListingWriterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

const LANGUAGE_NAME: Record<ListingWriterLanguage, string> = {
  th: 'Thai',
  en: 'English',
  zh: 'Simplified Chinese',
};

/** The JSON Schema the gateway is asked to answer with: one {title, description} per requested language. */
export function responseSchema(languages: ListingWriterLanguage[]): Record<string, unknown> {
  const draft = {
    type: 'object',
    required: ['title', 'description'],
    properties: {
      title: { type: 'string', maxLength: 120 },
      description: { type: 'string', maxLength: 5000 },
    },
  };
  return {
    type: 'object',
    required: languages,
    properties: Object.fromEntries(languages.map((l) => [l, draft])),
  };
}

/** The instruction sent with the facts — what to write and what never to write. */
export function taskOf(request: ListingWriterRequest): string {
  const langs = request.languages.map((l) => `${l} (${LANGUAGE_NAME[l]})`).join(', ');
  return [
    `Write a rental listing title (max 120 characters) and description (max 1500 characters) in: ${langs}.`,
    'Use only the facts below and what is visible in the photos; never invent amenities, prices or distances.',
    'Do not include phone numbers, e-mail addresses, LINE ids, links, bank accounts or personal names.',
    'Do not describe people who may appear in photos. Keep the amounts exactly as given (THB).',
    `Facts (JSON): ${JSON.stringify(request.facts)}`,
  ].join('\n');
}

/**
 * The Collective AI gateway over HTTPS (D-161, D-301). // UNVERIFIED against live provider — the gateway's API is not
 * published; this adapter assumes the same shape as the shared vision adapter of `@collective/integrations/ai`:
 * `POST {baseUrl}/v1/vision` with `{ model, task, images: [{ mimeType, base64 }], responseSchema, tenantId, purpose:
 * 'listing_assistant' }`, bearer-authenticated, answering `{ output, model, usage: { inputTokens, outputTokens } }`.
 * Photos are sent read-only and never logged; nothing but text comes back.
 */
export class HttpListingWriter implements ListingWriterPort {
  readonly mode = 'real' as const;

  constructor(private readonly options: HttpListingWriterOptions) {}

  async draft(request: ListingWriterRequest): Promise<ListingWriterResponse> {
    const res = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/v1/vision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model,
        task: `${taskOf(request)}\nAnswer with JSON only, matching the schema.`,
        images: request.photos.map((p) => ({ mimeType: p.mimeType, base64: p.data.toString('base64') })),
        responseSchema: responseSchema(request.languages),
        tenantId: request.tenantId,
        purpose: 'listing_assistant',
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
      redirect: 'error',
    });
    if (!res.ok) throw Object.assign(new Error(`ai-gateway HTTP ${res.status}`), { status: res.status });
    const body = (await res.json()) as {
      output?: unknown;
      model?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    const output = typeof body.output === 'string' ? safeJson(body.output) : body.output;
    const drafts: Partial<Record<ListingWriterLanguage, ListingDraft>> = {};
    if (output && typeof output === 'object')
      for (const l of request.languages) {
        const d = (output as Record<string, unknown>)[l] as Partial<ListingDraft> | undefined;
        if (d && typeof d.title === 'string' && typeof d.description === 'string')
          drafts[l] = { title: d.title, description: d.description };
      }
    return {
      drafts,
      model: body.model ?? this.options.model,
      usage: body.usage
        ? { inputTokens: body.usage.inputTokens ?? 0, outputTokens: body.usage.outputTokens ?? 0 }
        : null,
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^```(json)?|```$/g, '').trim()) as unknown;
  } catch {
    return null;
  }
}

/** Real mode without AI_GATEWAY_URL / AI_GATEWAY_API_KEY: the assistant is unavailable (`assistant.unavailable`). */
export class UnconfiguredListingWriter implements ListingWriterPort {
  readonly mode = 'real' as const;

  draft(): Promise<ListingWriterResponse> {
    return Promise.reject(new ListingWriterUnavailable());
  }
}
