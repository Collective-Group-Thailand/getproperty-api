import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { type I18nService } from 'nestjs-i18n';

import { ComplianceException } from './compliance.exception';
import { DomainException } from './domain.exception';
import { COMPLIANCE_CODES, ERROR_CODES, type ErrorCode } from './error-codes';
import { ProblemDetailsFilter } from './problem-details.filter';

type Catalogue = Record<string, Record<string, { title: string; detail: string }>>;
const catalogue = (lang: string): Catalogue =>
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'i18n', lang, 'errors.json'), 'utf8')) as Catalogue;

const i18n = {
  translate: (key: string, options: { lang: string }) => {
    const [, group = '', name = '', field = ''] = key.split('.');
    const text = catalogue(options.lang)[group]?.[name];
    return text ? text[field as 'title' | 'detail'] : key;
  },
} as unknown as I18nService;

describe('ProblemDetailsFilter', () => {
  const filter = new ProblemDetailsFilter(i18n);

  it('renders a DomainException as RFC 9457 problem details, localised', () => {
    const problem = filter.render(
      filter.normalise(
        new DomainException('idempotency.key_reused', { errors: [{ path: 'x', code: 'y', message: 'z' }] }),
      ),
      'en',
      'req-1',
    );
    expect(problem).toEqual({
      type: 'https://errors.getproperty.co/idempotency.key_reused',
      title: 'Idempotency-Key reused',
      status: 422,
      code: 'idempotency.key_reused',
      detail: 'This Idempotency-Key was already used with a different request body.',
      errors: [{ path: 'x', code: 'y', message: 'z' }],
      requestId: 'req-1',
    });
    expect(filter.render(filter.normalise(new DomainException('http.not_found')), 'th', 'r').title).toBe(
      'ไม่พบข้อมูล',
    );
  });

  it('a ComplianceException is a compliance.* code that always carries legalRef and ruleId (D-020)', () => {
    const exception = new ComplianceException('compliance.tariff_cap', {
      legalRef: 'ประกาศ สคบ. 2568 ข้อ 4',
      ruleId: 'tariff.cap.electric',
    });
    expect(exception).toBeInstanceOf(DomainException);
    expect(exception.status).toBe(422);
    const problem = filter.render(filter.normalise(exception), 'th', 'req-2');
    expect(problem).toMatchObject({
      code: 'compliance.tariff_cap',
      status: 422,
      legalRef: 'ประกาศ สคบ. 2568 ข้อ 4',
      ruleId: 'tariff.cap.electric',
      type: 'https://errors.getproperty.co/compliance.tariff_cap',
    });
    expect(problem.detail).toContain('D-021');
    // ruleId defaults to the code.
    expect(new ComplianceException('compliance.bill_immutable', { legalRef: 'D-040' }).ruleId).toBe(
      'compliance.bill_immutable',
    );
    expect(new ComplianceException('compliance.bill_immutable', { legalRef: 'x' }).status).toBe(409);
  });

  it('every compliance code is in the compliance family and has a status', () => {
    expect(COMPLIANCE_CODES.length).toBeGreaterThanOrEqual(4);
    for (const code of COMPLIANCE_CODES) expect(code.startsWith('compliance.')).toBe(true);
  });

  it('maps framework HttpExceptions and body-parser errors to stable codes', () => {
    expect(filter.normalise(new NotFoundException())).toMatchObject({ code: 'http.not_found', status: 404 });
    expect(filter.normalise(new HttpException('x', HttpStatus.TOO_MANY_REQUESTS))).toMatchObject({
      code: 'http.too_many_requests',
      status: 429,
    });
    expect(filter.normalise({ status: 415 })).toMatchObject({ code: 'http.unsupported_media_type' });
    expect(filter.normalise(new Error('boom'))).toMatchObject({ code: 'internal.unexpected', status: 500 });
  });

  it('every error code has th and en translations and every translation has a code', () => {
    for (const lang of ['th', 'en']) {
      const texts = catalogue(lang);
      const translated = new Set(
        Object.entries(texts).flatMap(([group, names]) =>
          Object.keys(names).map((name) => `${group}.${name}`),
        ),
      );
      for (const code of Object.keys(ERROR_CODES) as ErrorCode[]) {
        expect(translated.has(code)).toBe(true);
        const [group = '', name = ''] = code.split('.');
        expect(texts[group]?.[name]?.title).toBeTruthy();
        expect(texts[group]?.[name]?.detail).toBeTruthy();
      }
      for (const code of translated) expect(code in ERROR_CODES).toBe(true);
    }
  });
});
