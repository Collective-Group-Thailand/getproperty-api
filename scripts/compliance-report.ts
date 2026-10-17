// `pnpm compliance:report` — writes docs/compliance.md from the rule registry and the published contract (B4.1).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderComplianceReport } from '../src/core/compliance/report';

const root = join(__dirname, '..', '..');
const document = JSON.parse(readFileSync(join(root, 'contract', 'openapi.json'), 'utf8')) as Parameters<
  typeof renderComplianceReport
>[0];
const target = join(root, 'docs', 'compliance.md');
const report = renderComplianceReport(document);
writeFileSync(target, report);
console.log(report);
console.log(`compliance:report — wrote ${target}`);
