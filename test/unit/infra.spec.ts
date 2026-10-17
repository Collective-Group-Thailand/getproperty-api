import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const lint = (dir: string) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts/infra-lint.mjs'), dir], { encoding: 'utf8' });

/** B6.5 (D-207): the Terraform skeleton stays structurally valid without a terraform binary. */
describe('infra/terraform (pnpm infra:lint)', () => {
  it('passes on the committed skeleton', () => {
    const r = lint(join(ROOT, 'infra/terraform'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('reports an undeclared variable, an unknown module argument and a missing workspace value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gp-infra-'));
    try {
      cpSync(join(ROOT, 'infra/terraform'), dir, { recursive: true });
      const main = join(dir, 'main.tf');
      writeFileSync(
        main,
        readFileSync(main, 'utf8')
          .replace('name   = local.name\n  region = var.region', 'name   = local.name\n  region = var.regoin')
          .replace('  tier       = local.size.redis_tier', '  tierx      = local.size.redis_tier'),
      );
      const env = join(dir, 'envs/uat.tfvars');
      writeFileSync(env, readFileSync(env, 'utf8').replace(/^alert_email.*$/m, ''));
      const r = lint(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('var.regoin is not declared');
      expect(r.stderr).toContain('module memorystore: unknown argument tierx');
      expect(r.stderr).toContain('module memorystore: missing required tier');
      expect(r.stderr).toContain('uat.tfvars: does not set alert_email');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
