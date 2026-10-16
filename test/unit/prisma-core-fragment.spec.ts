import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildPrismaFragment } from '@collective/asset-core';

describe('prisma/schema/core.prisma (generated from @collective/asset-core)', () => {
  it('matches the installed package and the app’s relations (pnpm prisma:core)', () => {
    const dir = join(__dirname, '..', '..', 'prisma', 'schema');
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.prisma') && f !== 'core.prisma')
      .map((f) => readFileSync(join(dir, f), 'utf8'));
    expect(readFileSync(join(dir, 'core.prisma'), 'utf8')).toBe(buildPrismaFragment(sources));
  });
});
