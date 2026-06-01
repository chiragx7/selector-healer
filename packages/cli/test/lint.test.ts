import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_PATH = join(__dirname, '..', 'dist', 'index.js');

function run(args: string[], cwd: string): { stdout: string; exitCode: number } {
  // NO_COLOR keeps output plain so substring assertions aren't broken by ANSI codes.
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf8', env });
    return { stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; status?: number };
    return { stdout: err.stdout?.toString() ?? '', exitCode: err.status ?? 1 };
  }
}

const created: string[] = [];
function project(spec: string): string {
  const root = mkdtempSync(join(tmpdir(), 'sh-lint-'));
  created.push(root);
  writeFileSync(
    join(root, 'selector-healer.config.cjs'),
    "module.exports = { testDir: './tests', testGlob: '**/*.spec.ts', baseUrl: 'http://localhost:3000' };\n",
  );
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'sample.spec.ts'), spec);
  return root;
}

afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.length = 0;
});

const FRAGILE_SPEC = `import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await page.getByText('Forgot your password?').click();
  await page.getByTestId('submit').click();
});
`;

const STURDY_SPEC = `import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await page.getByTestId('submit').click();
  await page.getByRole('button', { name: 'Log in' }).click();
});
`;

describe('CLI lint', () => {
  it('flags a fragile text selector but not a sturdy test-id', () => {
    const root = project(FRAGILE_SPEC);
    const { stdout, exitCode } = run(['lint'], root);
    expect(exitCode).toBe(0); // advisory by default
    expect(stdout).toContain('fragile');
    expect(stdout).toContain('Forgot your password?');
    expect(stdout).toContain('1 fragile of 2 selectors');
  });

  it('reports a clean bill when every selector is sturdy', () => {
    const root = project(STURDY_SPEC);
    const { stdout, exitCode } = run(['lint'], root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No fragile selectors');
  });

  it('--strict exits non-zero when a fragile selector is found', () => {
    const root = project(FRAGILE_SPEC);
    const { exitCode } = run(['lint', '--strict'], root);
    expect(exitCode).toBe(1);
  });

  it('fails without a config', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-lint-noconfig-'));
    created.push(root);
    const { exitCode } = run(['lint'], root);
    expect(exitCode).toBe(1);
  });
});
