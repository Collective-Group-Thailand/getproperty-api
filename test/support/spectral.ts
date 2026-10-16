import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SpectralResult {
  code: string;
  message: string;
  path: (string | number)[];
  severity: number;
}

const ROOT = join(__dirname, '..', '..');

/** Runs `spectral lint` with the getproperty ruleset on a document, exactly like `pnpm contract:lint`. */
export function lintWithRuleset(document: unknown): SpectralResult[] {
  const dir = mkdtempSync(join(tmpdir(), 'getproperty-spectral-'));
  try {
    const file = join(dir, 'openapi.json');
    writeFileSync(file, JSON.stringify(document));
    const run = spawnSync(
      join(ROOT, 'node_modules', '.bin', 'spectral'),
      [
        'lint',
        file,
        '--ruleset',
        join(ROOT, 'contract', 'spectral', '.spectral.yaml'),
        '--format',
        'json',
        '--quiet',
      ],
      { encoding: 'utf8' },
    );
    const output = run.stdout.trim();
    if (!output.startsWith('[')) throw new Error(`spectral failed: ${run.stderr || output}`);
    return JSON.parse(output) as SpectralResult[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
