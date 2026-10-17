import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { coveredOperations, renderComplianceReport } from './report';
import { COMPLIANCE_RULES } from './rules';

const root = join(__dirname, '..', '..', '..');

describe('docs/compliance.md (pnpm compliance:report, B4.1)', () => {
  const contract = JSON.parse(readFileSync(join(root, 'contract', 'openapi.json'), 'utf8')) as Parameters<
    typeof renderComplianceReport
  >[0];

  it('is generated from the registry and the committed contract', () => {
    expect(readFileSync(join(root, 'docs', 'compliance.md'), 'utf8')).toBe(renderComplianceReport(contract));
  });

  it('lists every rule once and maps operations through x-compliance-rules', () => {
    const report = renderComplianceReport(contract);
    for (const r of COMPLIANCE_RULES) expect(report.split(`| \`${r.id}\` |`).length).toBe(2);
    const covered = coveredOperations({
      paths: {
        '/x': { post: { operationId: 'owner.x.y', 'x-compliance-rules': ['compliance.tariff_cap'] } },
      },
    });
    expect(covered.get('compliance.tariff_cap')).toEqual(['owner.x.y']);
  });
});
