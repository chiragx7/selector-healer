import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('keeps the auth example commented out — no active credentials', () => {
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
});
