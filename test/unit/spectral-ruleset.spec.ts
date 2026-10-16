import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lintWithRuleset } from '../support/spectral';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the suite mutates arbitrary document nodes
type Doc = Record<string, any>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('getproperty Spectral ruleset (contract §5)', () => {
  const committed = JSON.parse(readFileSync(join(process.cwd(), 'contract', 'openapi.json'), 'utf8')) as Doc;
  const codes = (doc: unknown) => new Set(lintWithRuleset(doc).map((r) => r.code));

  it('passes on the committed contract', () => {
    expect(lintWithRuleset(committed)).toEqual([]);
  });

  it('fails on an operation without operationId, summary, security or a decision reference', () => {
    const doc = clone(committed);
    const op = doc.paths['/v1/owner/ping'].get;
    op.operationId = 'ping';
    delete op.summary;
    delete op.security;
    op.description = 'no reference';
    const found = codes(doc);
    for (const rule of [
      'getproperty-operation-id',
      'getproperty-operation-summary',
      'getproperty-operation-security-declared',
      'getproperty-operation-implements',
      'getproperty-surface-security',
    ])
      expect(found).toContain(rule);
  });

  it('fails on a wrong audience scheme, an inline enum, a bare object and a missing example', () => {
    const doc = clone(committed);
    doc.paths['/v1/owner/ping'].get.security = [{ residentBearer: [] }];
    doc.components.schemas.SystemPingDto.properties.surface = { type: 'string', enum: ['owner', 'resident'] };
    doc.components.schemas.SystemPingDto.properties.blob = { type: 'object' };
    delete doc.paths['/v1/admin/system/info'].get.responses['200'].content['application/json'].example;
    const found = codes(doc);
    for (const rule of [
      'getproperty-surface-security',
      'getproperty-no-inline-enum',
      'getproperty-object-shape',
      'getproperty-response-example',
    ])
      expect(found).toContain(rule);
  });

  it('fails on real-looking personal data in examples (Thai id, phone, plate, email, card)', () => {
    const doc = clone(committed);
    doc.components.schemas.SystemPingDto.properties.version.example = 'call 081-234-5678 or 02-123-4567';
    doc.components.schemas.SystemPingDto.properties.serverTime.example = 'id 1234567890123 plate กข 1234';
    doc.components.schemas.SystemPingDto.properties.surface.example = 'somchai@gmail.com 4111111111111111';
    const messages = lintWithRuleset(doc)
      .filter((r) => r.code === 'getproperty-no-real-personal-data')
      .map((r) => r.message)
      .join('\n');
    expect(messages).toMatch(/phone "081-234-5678"/);
    expect(messages).toMatch(/phone "02-123-4567"/);
    expect(messages).toMatch(/13-digit id "1234567890123"/);
    expect(messages).toMatch(/licence plate/);
    expect(messages).toMatch(/email "somchai@gmail.com"/);
    expect(messages).toMatch(/card number/);
  });

  it('fails on a compliance problem example without legalRef and on a money number', () => {
    const doc = clone(committed);
    // No operation throws a compliance problem yet (B4), so the shared example is pruned; add one without legalRef.
    doc.components.examples['problem.compliance.tariff_cap'] = {
      summary: 'compliance.tariff_cap',
      value: {
        ...doc.components.examples['problem.internal.unexpected'].value,
        code: 'compliance.tariff_cap',
        status: 422,
      },
    };
    doc.components.schemas.SystemPingDto.properties.amount = {
      type: 'number',
      description: 'Unit: THB',
      example: 1,
    };
    const found = codes(doc);
    expect(found).toContain('getproperty-compliance-legal-ref');
    expect(found).toContain('getproperty-field-formats');
  });
});
