import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectDetection } from '../../src/init/detect.js';
import { renderConfigFile } from '../../src/init/generate.js';

function detection(over: Partial<ProjectDetection> = {}): ProjectDetection {
  return {
    framework: 'playwright',
    frameworkConfidence: 'detected',
    otherFrameworks: [],
    baseUrl: 'http://localhost:4200',
    baseUrlSource: 'playwright.config.ts',
    baseUrlConfident: true,
    testDir: './e2e',
    testDirSource: 'playwright.config.ts',
    testDirConfident: true,
    testGlob: '**/*.{spec,test}.{ts,js,mjs}',
    usesTypeScript: false,
    pages: [],
    playwrightImport: '@playwright/test',
    ...over,
  };
}

const created: string[] = [];
afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.length = 0;
});

describe('renderConfigFile', () => {
  it('writes a .cjs config (loads without a TS transpiler)', () => {
    expect(renderConfigFile(detection()).filename).toBe('selector-healer.config.cjs');
  });

  it('embeds detected values and adds no TODOs when confident', () => {
    const { content } = renderConfigFile(detection());
    expect(content).toContain("framework: 'playwright'");
    expect(content).toContain("testDir: './e2e'");
    expect(content).toContain("baseUrl: 'http://localhost:4200'");
    expect(content).not.toContain('TODO');
  });

  it('annotates low-confidence fields with TODO', () => {
    const { content } = renderConfigFile(
      detection({
        baseUrlConfident: false,
        baseUrl: 'http://localhost:3000',
        testDirConfident: false,
        testDir: './tests',
      }),
    );
    expect(content).toMatch(/baseUrl:.*TODO/);
    expect(content).toMatch(/testDir:.*TODO/);
  });

  it('annotates an undetected framework with TODO', () => {
    const { content } = renderConfigFile(detection({ frameworkConfidence: 'default' }));
    expect(content).toMatch(/framework:.*TODO/);
  });

  it('keeps the auth example commented out - no active credentials', () => {
    const { content } = renderConfigFile(detection());
    const sensitive = content
      .split('\n')
      .filter((l) => l.includes('pages') || l.includes('getByLabel') || l.includes('process.env'));
    expect(sensitive.length).toBeGreaterThan(0);
    for (const line of sensitive) {
      expect(line.trim().startsWith('//')).toBe(true);
    }
  });

  it('produces a valid, loadable CommonJS module', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-gen-'));
    created.push(root);
    const { filename, content } = renderConfigFile(detection());
    const path = join(root, filename);
    writeFileSync(path, content);

    const require = createRequire(import.meta.url);
    const cfg = require(path);
    expect(cfg.testDir).toBe('./e2e');
    expect(cfg.baseUrl).toBe('http://localhost:4200');
    expect(cfg.framework).toBe('playwright');
    expect(cfg.pages).toBeUndefined();
  });

  it('escapes single quotes in embedded values', () => {
    const { content } = renderConfigFile(detection({ testDir: "./we're/tests" }));
    expect(content).toContain("testDir: './we\\'re/tests'");
  });

  it('writes a typed .ts config for a TypeScript project', () => {
    const { filename, content } = renderConfigFile(detection({ usesTypeScript: true }));
    expect(filename).toBe('selector-healer.config.ts');
    expect(content).toContain("import type { HealerConfig } from '@selector-healer/core'");
    expect(content).toContain('satisfies HealerConfig');
    expect(content).not.toContain('module.exports');
    // Same detected values still embedded.
    expect(content).toContain("framework: 'playwright'");
    expect(content).toContain("baseUrl: 'http://localhost:4200'");
  });

  it('keeps the auth example commented out in the .ts config too', () => {
    const { content } = renderConfigFile(detection({ usesTypeScript: true }));
    const sensitive = content
      .split('\n')
      .filter((l) => l.includes('pages') || l.includes('getByLabel') || l.includes('process.env'));
    expect(sensitive.length).toBeGreaterThan(0);
    for (const line of sensitive) {
      expect(line.trim().startsWith('//')).toBe(true);
    }
  });

  it('pre-fills a real pages[] from detected pages (no login)', () => {
    const { content } = renderConfigFile(
      detection({ pages: [{ name: 'Dashboard', url: '/dashboard' }] }),
    );
    expect(content).toContain('pages: [');
    expect(content).toContain("name: 'Dashboard'");
    expect(content).toContain("url: '/dashboard'");
    expect(content).not.toContain('async function login');
    expect(content).not.toContain('loginAndGoto');
  });

  it('generates login helpers + setup hooks from a detected login (creds via env)', () => {
    const { content } = renderConfigFile(
      detection({
        pages: [{ name: 'Dashboard', url: '/dashboard' }],
        login: {
          gotoUrl: '/',
          fills: [
            { selector: "getByTestId('email-input')", kind: 'user' },
            { selector: "getByTestId('password-input')", kind: 'password' },
          ],
          click: "getByTestId('submit-btn')",
          waitUrl: '**/dashboard',
        },
      }),
    );
    expect(content).toContain('async function login');
    expect(content).toContain('async function loginAndGoto');
    expect(content).toContain("getByTestId('email-input')");
    expect(content).toContain('process.env.TEST_USER');
    expect(content).toContain('process.env.TEST_PASS');
    expect(content).toContain("setup: (page) => loginAndGoto(page, '/dashboard')");
  });

  it('emits a syntactically valid deep .cjs config', () => {
    const { content } = renderConfigFile(
      detection({
        pages: [{ name: 'Dashboard', url: '/dashboard' }],
        login: {
          fills: [{ selector: "getByTestId('email-input')", kind: 'user' }],
          click: "getByTestId('submit-btn')",
          waitUrl: '**/dashboard',
        },
      }),
    );
    // The TS-only `process` shim must never leak into a CommonJS config.
    expect(content).not.toContain('declare const process');
    expect(() => parse(content, { sourceType: 'script' })).not.toThrow();
  });

  it('emits a syntactically valid deep .ts config', () => {
    const { content } = renderConfigFile(
      detection({
        usesTypeScript: true,
        pages: [{ name: 'Profile', url: '/profile' }],
        login: {
          fills: [
            { selector: "getByLabel('Email')", kind: 'user' },
            { selector: "getByLabel('Password')", kind: 'password' },
          ],
          click: "getByRole('button', { name: 'Log in' })",
          waitUrl: '**/dashboard',
          landingPath: '/dashboard',
        },
      }),
    );
    // `process` is declared locally so the config type-checks without @types/node,
    // while still reading credentials from the environment.
    expect(content).toContain(
      'declare const process: { env: Record<string, string | undefined> };',
    );
    expect(content).toContain("process.env.TEST_USER ?? ''");
    // loginAndGoto builds the URL with a template literal (lint-clean), not `+`.
    expect(content).toContain('${path}');
    expect(content).not.toContain("' + path");
    // The login landing page is guarded against a redundant re-navigation.
    expect(content).toContain("if (path !== '/dashboard')");
    expect(() => parse(content, { sourceType: 'module', plugins: ['typescript'] })).not.toThrow();
  });

  it('a deep .cjs config loads and exposes the pages', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-gen-deep-'));
    created.push(root);
    const { filename, content } = renderConfigFile(
      detection({
        pages: [
          { name: 'Dashboard', url: '/dashboard' },
          { name: 'Profile', url: '/profile' },
        ],
        login: {
          fills: [{ selector: "getByTestId('email-input')", kind: 'user' }],
          click: "getByTestId('submit-btn')",
        },
      }),
    );
    writeFileSync(join(root, filename), content);
    const require = createRequire(import.meta.url);
    const cfg = require(join(root, filename));
    expect(Array.isArray(cfg.pages)).toBe(true);
    expect(cfg.pages).toHaveLength(2);
    expect(typeof cfg.pages[0].setup).toBe('function');
  });

  it('attaches a setup hook only to auth-gated pages, leaving public pages bare', () => {
    const { content } = renderConfigFile(
      detection({
        pages: [
          { name: 'Docs', url: '/docs', requiresAuth: false },
          { name: 'Dashboard', url: '/dashboard', requiresAuth: true },
        ],
        login: {
          fills: [{ selector: "getByTestId('email-input')", kind: 'user' }],
          click: "getByTestId('submit-btn')",
          waitUrl: '**/dashboard',
          landingPath: '/dashboard',
        },
      }),
    );
    expect(content).toContain(
      "name: 'Dashboard', url: '/dashboard', setup: (page) => loginAndGoto(page, '/dashboard')",
    );
    expect(content).toContain("name: 'Docs', url: '/docs' }");
    // The public page must not get a login setup hook.
    expect(content).not.toContain("loginAndGoto(page, '/docs')");
  });

  it('omits login helpers entirely when every detected page is public', () => {
    const { content } = renderConfigFile(
      detection({
        pages: [{ name: 'Docs', url: '/docs', requiresAuth: false }],
        login: {
          fills: [{ selector: "getByTestId('email-input')", kind: 'user' }],
          click: "getByTestId('submit-btn')",
        },
      }),
    );
    expect(content).not.toContain('async function login');
    expect(content).not.toContain('loginAndGoto');
    expect(content).toContain("name: 'Docs', url: '/docs' }");
  });
});
