import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProjectConfig } from '../../src/init/detect.js';

const created: string[] = [];

/** Build a throwaway project directory with the given files and (non-empty) dirs. */
function project(spec: { files?: Record<string, string>; dirs?: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), 'sh-detect-'));
  created.push(root);
  for (const [name, content] of Object.entries(spec.files ?? {})) {
    const full = join(root, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  for (const d of spec.dirs ?? []) {
    const full = join(root, d);
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, 'placeholder.spec.ts'), '// test file\n');
  }
  return root;
}

afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.length = 0;
});

describe('detectProjectConfig — framework', () => {
  it('detects Playwright from @playwright/test + config', () => {
    const root = project({
      files: {
        'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1.52.0' } }),
        'playwright.config.ts': "export default { use: { baseURL: 'http://localhost:4200' } };",
      },
    });
    const d = detectProjectConfig(root);
    expect(d.framework).toBe('playwright');
    expect(d.frameworkConfidence).toBe('detected');
    expect(d.testGlob).toBe('**/*.{spec,test}.{ts,js,mjs}');
  });

  it('detects Cypress', () => {
    const root = project({
      files: {
        'package.json': JSON.stringify({ devDependencies: { cypress: '^13.0.0' } }),
        'cypress.config.ts': "export default { e2e: { baseUrl: 'http://localhost:8080' } };",
      },
    });
    expect(detectProjectConfig(root).framework).toBe('cypress');
  });

  it('detects WebdriverIO from @wdio/cli', () => {
    const root = project({
      files: { 'package.json': JSON.stringify({ devDependencies: { '@wdio/cli': '^9.0.0' } }) },
    });
    expect(detectProjectConfig(root).framework).toBe('webdriverio');
  });

  it('detects TestCafe', () => {
    const root = project({
      files: { 'package.json': JSON.stringify({ devDependencies: { testcafe: '^3.0.0' } }) },
    });
    expect(detectProjectConfig(root).framework).toBe('testcafe');
  });

  it('detects a framework from a config file even without the dependency', () => {
    const root = project({ files: { 'playwright.config.js': 'module.exports = {};' } });
    const d = detectProjectConfig(root);
    expect(d.framework).toBe('playwright');
    expect(d.frameworkConfidence).toBe('detected');
  });

  it('reports other frameworks when several are present', () => {
    const root = project({
      files: {
        'package.json': JSON.stringify({ devDependencies: { cypress: '^13', testcafe: '^3' } }),
        'cypress.config.ts': 'export default { e2e: {} };',
      },
    });
    const d = detectProjectConfig(root);
    expect(d.framework).toBe('cypress');
    expect(d.otherFrameworks).toContain('testcafe');
  });

  it('falls back to playwright with low confidence for an unknown project', () => {
    const root = project({ files: { 'package.json': '{}' } });
    const d = detectProjectConfig(root);
    expect(d.framework).toBe('playwright');
    expect(d.frameworkConfidence).toBe('default');
  });
});

describe('detectProjectConfig — baseUrl', () => {
  it('reads baseURL from a Playwright config', () => {
    const root = project({
      files: {
        'playwright.config.ts': "export default { use: { baseURL: 'https://staging.app.com' } };",
      },
    });
    const d = detectProjectConfig(root);
    expect(d.baseUrl).toBe('https://staging.app.com');
    expect(d.baseUrlSource).toBe('playwright.config.ts');
    expect(d.baseUrlConfident).toBe(true);
  });

  it('reads baseUrl from cypress.json (e2e or top-level)', () => {
    const root = project({
      files: {
        'package.json': JSON.stringify({ devDependencies: { cypress: '^13' } }),
        'cypress.json': JSON.stringify({ baseUrl: 'http://localhost:1234' }),
      },
    });
    expect(detectProjectConfig(root).baseUrl).toBe('http://localhost:1234');
  });

  it('falls back to .env when the config has no literal URL', () => {
    const root = project({
      files: {
        'playwright.config.ts': 'export default { use: { baseURL: process.env.BASE_URL } };',
        '.env': 'BASE_URL=http://localhost:9999\nTOKEN=secret-should-be-ignored\n',
      },
    });
    const d = detectProjectConfig(root);
    expect(d.baseUrl).toBe('http://localhost:9999');
    expect(d.baseUrlSource).toBe('.env');
  });

  it('ignores non-URL env values and uses the default', () => {
    const root = project({ files: { '.env': 'BASE_URL=not-a-real-url\n' } });
    const d = detectProjectConfig(root);
    expect(d.baseUrl).toBe('http://localhost:3000');
    expect(d.baseUrlConfident).toBe(false);
  });

  it('handles quoted env values', () => {
    const root = project({ files: { '.env': 'APP_URL="https://quoted.example.com"\n' } });
    expect(detectProjectConfig(root).baseUrl).toBe('https://quoted.example.com');
  });
});

describe('detectProjectConfig — testDir', () => {
  it('reads testDir from a Playwright config when the directory exists', () => {
    const root = project({
      files: { 'playwright.config.ts': "export default { testDir: './e2e', use: {} };" },
      dirs: ['e2e'],
    });
    const d = detectProjectConfig(root);
    expect(d.testDir).toBe('./e2e');
    expect(d.testDirSource).toBe('playwright.config.ts');
  });

  it('derives the Cypress test dir from convention', () => {
    const root = project({
      files: {
        'package.json': JSON.stringify({ devDependencies: { cypress: '^13' } }),
        'cypress.config.ts': 'export default { e2e: {} };',
      },
      dirs: ['cypress/e2e'],
    });
    expect(detectProjectConfig(root).testDir).toBe('./cypress/e2e');
  });

  it('scans common directories when no config testDir is present', () => {
    const root = project({ dirs: ['tests'] });
    const d = detectProjectConfig(root);
    expect(d.testDir).toBe('./tests');
    expect(d.testDirSource).toBe('directory scan');
  });

  it('falls back to ./tests with low confidence when nothing is found', () => {
    const root = project({ files: { 'package.json': '{}' } });
    const d = detectProjectConfig(root);
    expect(d.testDir).toBe('./tests');
    expect(d.testDirConfident).toBe(false);
  });
});

describe('detectProjectConfig — TypeScript detection', () => {
  it('flags a project with a tsconfig.json', () => {
    const root = project({ files: { 'tsconfig.json': '{}', 'package.json': '{}' } });
    expect(detectProjectConfig(root).usesTypeScript).toBe(true);
  });

  it('flags a project with a .ts framework config (no tsconfig)', () => {
    const root = project({ files: { 'playwright.config.ts': 'export default {};' } });
    expect(detectProjectConfig(root).usesTypeScript).toBe(true);
  });

  it('is false for a plain-JS project', () => {
    const root = project({
      files: { 'package.json': '{}', 'playwright.config.js': 'module.exports = {};' },
    });
    expect(detectProjectConfig(root).usesTypeScript).toBe(false);
  });
});
