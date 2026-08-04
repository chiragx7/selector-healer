import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_PATH = join(__dirname, '..', 'dist', 'index.js');

function run(args: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 };
  }
}

describe('CLI', () => {
  it('shows version', () => {
    const { stdout, exitCode } = run(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('0.0.1');
  });

  it('shows help', () => {
    const { stdout, exitCode } = run(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('selector-healer');
    expect(stdout).toContain('init');
    expect(stdout).toContain('capture');
    expect(stdout).toContain('verify');
    expect(stdout).toContain('report');
  });

  it('init creates config and directory', () => {
    const tmp = join(tmpdir(), `sh-cli-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    try {
      const { stdout, exitCode } = run(['init'], tmp);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Created');
      expect(existsSync(join(tmp, '.selector-healer'))).toBe(true);
      expect(existsSync(join(tmp, 'selector-healer.config.cjs'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('init skips when a config already exists, regenerates with --force', () => {
    const tmp = join(tmpdir(), `sh-cli-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    try {
      const configPath = join(tmp, 'selector-healer.config.cjs');
      run(['init'], tmp);
      writeFileSync(configPath, '// custom edit', 'utf8');

      // Without --force, the existing config is preserved.
      const skipped = run(['init'], tmp);
      expect(skipped.exitCode).toBe(0);
      expect(skipped.stdout).toContain('Skipped');
      expect(readFileSync(configPath, 'utf8')).toBe('// custom edit');

      // With --force, it is regenerated.
      const forced = run(['init', '--force'], tmp);
      expect(forced.exitCode).toBe(0);
      expect(readFileSync(configPath, 'utf8')).toContain('module.exports');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('capture fails without config', () => {
    const tmp = join(tmpdir(), `sh-cli-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    try {
      const { exitCode } = run(['capture'], tmp);
      expect(exitCode).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('verify fails without config', () => {
    const tmp = join(tmpdir(), `sh-cli-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    try {
      const { exitCode } = run(['verify'], tmp);
      expect(exitCode).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('init subcommand help', () => {
    const { stdout, exitCode } = run(['init', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('--force');
  });

  it('lists prune in help', () => {
    expect(run(['--help']).stdout).toContain('prune');
  });

  it('prune fails without config', () => {
    const tmp = join(tmpdir(), `sh-cli-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      expect(run(['prune'], tmp).exitCode).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prune removes an orphaned fingerprint; --dry-run does not write', () => {
    const tmp = join(tmpdir(), `sh-cli-prune-${Date.now()}`);
    mkdirSync(join(tmp, 'tests'), { recursive: true });
    mkdirSync(join(tmp, '.selector-healer'), { recursive: true });
    writeFileSync(
      join(tmp, 'selector-healer.config.cjs'),
      "module.exports = { testDir: './tests', baseUrl: 'http://localhost:3000' };",
      'utf8',
    );
    // A real, parseable selector must exist so prune trusts the current list
    // (an empty list is refused — see the guard test below).
    writeFileSync(
      join(tmp, 'tests', 'login.spec.ts'),
      "import { test } from '@playwright/test';\ntest('t', async ({ page }) => {\n  await page.getByTestId('submit').click();\n});\n",
      'utf8',
    );
    const fpFile = join(tmp, '.selector-healer', 'fingerprints.json');
    const orphan = {
      selectorId: 'orphan1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      tagName: 'div',
      attributes: {},
      textContent: '',
      parentChain: [],
      siblingIndex: 0,
      pageUrl: 'http://x/',
    };
    writeFileSync(fpFile, JSON.stringify([orphan]), 'utf8');

    try {
      // The orphan's id/source match no current selector → stale.
      const dry = run(['prune', '--dry-run'], tmp);
      expect(dry.exitCode).toBe(0);
      expect(dry.stdout).toContain('Dry run');
      expect(JSON.parse(readFileSync(fpFile, 'utf8'))).toHaveLength(1); // unchanged

      const real = run(['prune'], tmp);
      expect(real.exitCode).toBe(0);
      expect(real.stdout).toContain('Removed 1');
      expect(JSON.parse(readFileSync(fpFile, 'utf8'))).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prune refuses when no selectors are found (would wipe the whole baseline)', () => {
    const tmp = join(tmpdir(), `sh-cli-prune-guard-${Date.now()}`);
    mkdirSync(join(tmp, 'tests'), { recursive: true }); // empty → 0 selectors
    mkdirSync(join(tmp, '.selector-healer'), { recursive: true });
    writeFileSync(
      join(tmp, 'selector-healer.config.cjs'),
      "module.exports = { testDir: './tests', baseUrl: 'http://localhost:3000' };",
      'utf8',
    );
    const fpFile = join(tmp, '.selector-healer', 'fingerprints.json');
    const orphan = {
      selectorId: 'orphan1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      tagName: 'div',
      attributes: {},
      textContent: '',
      parentChain: [],
      siblingIndex: 0,
      pageUrl: 'http://x/',
    };
    writeFileSync(fpFile, JSON.stringify([orphan]), 'utf8');

    try {
      // Without the guard, 0 selectors would make every fingerprint look stale
      // and delete the entire baseline. It must refuse and leave the file intact.
      const res = run(['prune'], tmp);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toMatch(/no selectors/i);
      expect(JSON.parse(readFileSync(fpFile, 'utf8'))).toHaveLength(1); // untouched
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
