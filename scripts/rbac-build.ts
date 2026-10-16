// `pnpm rbac:build` — writes docs/rbac.md from the role/permission catalogue (src/core/rbac/catalogue.ts).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderRbacMarkdown } from '../src/core/rbac/catalogue';

const target = join(__dirname, '..', '..', 'docs', 'rbac.md');
writeFileSync(target, renderRbacMarkdown());
console.log(`rbac:build — wrote ${target}`);
