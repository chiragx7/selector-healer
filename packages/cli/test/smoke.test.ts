import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI_PATH = join(__dirname, '..', 'dist', 'index.js');

function run(args: string[], cwd?: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
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
      expect(existsSync(join(tmp, 'selector-healer.config.ts'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('init --force overwrites existing config', () => {
    const tmp = join(tmpdir(), `sh-cli-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    try {
      run(['init'], tmp);
      writeFileSync(join(tmp, 'selector-healer.config.ts'), 'custom', 'utf8');
      const { exitCode } = run(['init', '--force'], tmp);
      expect(exitCode).toBe(0);
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
});
