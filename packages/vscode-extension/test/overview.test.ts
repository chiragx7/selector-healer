import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealerConfig } from '@selector-healer/core';
import { parseDirectory } from '@selector-healer/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOverview } from '../src/overview.js';

const GLOB = '**/*.{spec,test}.{ts,tsx,js,jsx}';

const SPEC = `import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await page.getByTestId('email').fill('a');
  await page.getByTestId('pw').fill('b');
  await page.getByText('Sign in').click();
});
`;

function fp(selectorId: string, pageUrl: string) {
  return {
    selectorId,
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'input',
    attributes: {},
    textContent: '',
    parentChain: [],
    siblingIndex: 0,
    pageUrl,
  };
}

describe('buildOverview', () => {
  let root: string;
  let config: HealerConfig;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sh-ov-'));
    mkdirSync(join(root, 'tests'), { recursive: true });
    mkdirSync(join(root, '.selector-healer'), { recursive: true });
    writeFileSync(join(root, 'tests', 'login.spec.ts'), SPEC, 'utf8');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', devDependencies: { '@playwright/test': '^1.52.0' } }),
      'utf8',
    );
    config = {
      testDir: join(root, 'tests'),
      testGlob: GLOB,
      baseUrl: 'http://localhost:3456',
      framework: 'playwright',
      browser: 'chromium',
      headless: true,
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports project + tooling from config and package.json', () => {
    const ov = buildOverview(config, root, []);
    expect(ov.project.framework).toBe('playwright');
    expect(ov.project.frameworkVersion).toBe('1.52.0');
    expect(ov.project.browser).toBe('chromium');
    expect(ov.project.baseUrl).toBe('http://localhost:3456');
  });

  it('computes composition and a value-aware robustness tally', () => {
    const ov = buildOverview(config, root, []);
    const testid = ov.composition.find((c) => c.type === 'testid');
    const text = ov.composition.find((c) => c.type === 'text');
    expect(testid?.count).toBe(2);
    expect(testid?.tier).toBe('robust');
    expect(text?.count).toBe(1);
    // 2 robust (test-id) + 1 fragile (text) → 67% sturdy.
    expect(ov.robustness).toMatchObject({ robust: 2, fragile: 1, total: 3, sturdyPct: 67 });
  });

  it('keeps live baselines, counts orphans as stale, and lists pages', () => {
    const parsed = parseDirectory(config.testDir, GLOB);
    if (parsed.isErr()) throw parsed.error;
    const liveId = parsed.value.selectors[0].id;
    writeFileSync(
      join(root, '.selector-healer', 'fingerprints.json'),
      JSON.stringify([fp(liveId, 'http://x/a'), fp('orphan-1', 'http://x/b')]),
      'utf8',
    );

    const ov = buildOverview(config, root, [], 7);
    expect(ov.baseline).toMatchObject({ total: 2, live: 1, stale: 1, staleKnown: true });
    expect(ov.pages).toHaveLength(2);
    expect(ov.activity.applied).toBe(7);
  });

  it('passes the health trend through unchanged', () => {
    const trend = [
      { at: 1, healthPct: 80 },
      { at: 2, healthPct: 90 },
    ];
    expect(buildOverview(config, root, trend).trend).toEqual(trend);
  });

  it('refuses to trust a stale count when no selectors are found (guard)', () => {
    // Point at an empty dir → 0 selectors. Fingerprints exist, but they must NOT
    // all be flagged stale (that would motivate wiping a valid baseline).
    writeFileSync(
      join(root, '.selector-healer', 'fingerprints.json'),
      JSON.stringify([fp('a', 'http://x/a'), fp('b', 'http://x/b')]),
      'utf8',
    );
    mkdirSync(join(root, 'empty'), { recursive: true });
    const ov = buildOverview({ ...config, testDir: join(root, 'empty') }, root, []);
    expect(ov.baseline).toMatchObject({ total: 2, live: 2, stale: 0, staleKnown: false });
  });
});
