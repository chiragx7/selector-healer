import { mkdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureFingerprints } from '../../src/fingerprint/capture.js';
import { loadFingerprints } from '../../src/fingerprint/store.js';
import type { HealerConfig, SelectorUsage } from '../../src/types.js';
import { startFixtureServer } from '../fixtures/server.js';

describe('captureFingerprints (integration)', () => {
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    const fixture = await startFixtureServer();
    server = fixture.server;
    baseUrl = fixture.baseUrl;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sh-cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<HealerConfig> = {}): HealerConfig {
    return {
      testDir: './tests',
      baseUrl,
      headless: true,
      timeout: 10_000,
      ...overrides,
    };
  }

  function makeSelector(overrides: Partial<SelectorUsage> = {}): SelectorUsage {
    return {
      id: 'aaa111bbb222',
      filePath: '/test/login.spec.ts',
      line: 5,
      column: 10,
      selectorType: 'css',
      rawValue: '#submit',
      contextHint: '/login',
      ...overrides,
    };
  }

  it('captures fingerprint for a CSS selector', async () => {
    const selectors = [makeSelector()];
    const config = makeConfig();

    const result = await captureFingerprints(selectors, config, tmpDir);
    expect(result.captured).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    const stored = loadFingerprints(tmpDir)._unsafeUnwrap();
    expect(stored.size).toBe(1);
    const fp = stored.get('aaa111bbb222');
    expect(fp).toBeDefined();
    expect(fp?.tagName).toBe('button');
    expect(fp?.attributes.id).toBe('submit');
    expect(fp?.textContent).toBe('Log in');
    expect(fp?.pageUrl).toContain('/login');
  });

  it('stores the final URL after a redirect, not the requested one', async () => {
    // '/home-redirect' 302s to '/dashboard'. The fingerprint must record where the
    // element actually lives ('/dashboard'), so heal's same-page reachability check
    // doesn't later read a benign canonical redirect as a "wrong page".
    const sel = makeSelector({
      id: 'redir00fp0001',
      selectorType: 'testid',
      rawValue: 'dashboard',
      contextHint: '/home-redirect',
    });
    const result = await captureFingerprints([sel], makeConfig(), tmpDir);
    expect(result.captured).toBe(1);

    const fp = loadFingerprints(tmpDir)._unsafeUnwrap().get('redir00fp0001');
    expect(fp?.pageUrl).toContain('/dashboard');
    expect(fp?.pageUrl).not.toContain('/home-redirect');
  });

  it('captures fingerprint for getByTestId', async () => {
    const selectors = [
      makeSelector({
        id: 'bbb222ccc333',
        selectorType: 'testid',
        rawValue: 'email-input',
      }),
    ];

    const result = await captureFingerprints(selectors, makeConfig(), tmpDir);
    expect(result.captured).toBe(1);

    const stored = loadFingerprints(tmpDir)._unsafeUnwrap();
    const fp = stored.get('bbb222ccc333');
    expect(fp).toBeDefined();
    expect(fp?.tagName).toBe('input');
    expect(fp?.attributes['data-testid']).toBe('email-input');
  });

  it('captures fingerprint for getByRole', async () => {
    const selectors = [
      makeSelector({
        id: 'ccc333ddd444',
        selectorType: 'role',
        rawValue: 'button',
        options: { name: 'Log in' },
      }),
    ];

    const result = await captureFingerprints(selectors, makeConfig(), tmpDir);
    expect(result.captured).toBe(1);

    const fp = loadFingerprints(tmpDir)._unsafeUnwrap().get('ccc333ddd444');
    expect(fp).toBeDefined();
    expect(fp?.tagName).toBe('button');
  });

  it('captures fingerprint for getByLabel', async () => {
    const selectors = [
      makeSelector({
        id: 'ddd444eee555',
        selectorType: 'label',
        rawValue: 'Email address',
      }),
    ];

    const result = await captureFingerprints(selectors, makeConfig(), tmpDir);
    expect(result.captured).toBe(1);

    const fp = loadFingerprints(tmpDir)._unsafeUnwrap().get('ddd444eee555');
    expect(fp).toBeDefined();
    expect(fp?.tagName).toBe('input');
  });

  it('captures fingerprint for getByPlaceholder', async () => {
    const selectors = [
      makeSelector({
        id: 'eee555fff666',
        selectorType: 'placeholder',
        rawValue: 'Enter email',
      }),
    ];

    const result = await captureFingerprints(selectors, makeConfig(), tmpDir);
    expect(result.captured).toBe(1);
  });

  it('captures parent chain and sibling index', async () => {
    const selectors = [makeSelector()];
    const result = await captureFingerprints(selectors, makeConfig(), tmpDir);
    expect(result.captured).toBe(1);

    const fp = loadFingerprints(tmpDir)._unsafeUnwrap().get('aaa111bbb222');
    expect(fp).toBeDefined();
    expect(fp?.parentChain.length).toBeGreaterThan(0);
    expect(fp?.parentChain.some((p) => p.tagName === 'form')).toBe(true);
    expect(typeof fp?.siblingIndex).toBe('number');
  });

  it('captures multiple selectors on same page', async () => {
    const selectors = [
      makeSelector({ id: 'sel1sel1sel1', rawValue: '#submit' }),
      makeSelector({ id: 'sel2sel2sel2', selectorType: 'testid', rawValue: 'email-input' }),
    ];

    const result = await captureFingerprints(selectors, makeConfig(), tmpDir);
    expect(result.captured).toBe(2);

    const stored = loadFingerprints(tmpDir)._unsafeUnwrap();
    expect(stored.size).toBe(2);
  });

  it('captures selectors from different pages', async () => {
    const selectors = [
      makeSelector({ id: 'login1login1', rawValue: '#submit', contextHint: '/login' }),
      makeSelector({
        id: 'dash1dash1da',
        selectorType: 'testid',
        rawValue: 'dashboard',
        contextHint: '/dashboard',
      }),
    ];

    const result = await captureFingerprints(selectors, makeConfig(), tmpDir);
    expect(result.captured).toBe(2);
  });

  it('skips selectors that do not match any element', async () => {
    const selectors = [makeSelector({ id: 'nomatch00000', rawValue: '#nonexistent' })];

    const result = await captureFingerprints(selectors, makeConfig(), tmpDir);
    expect(result.captured).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('reports error for unreachable page', async () => {
    const selectors = [makeSelector({ id: 'badpage00000', contextHint: 'http://127.0.0.1:1' })];

    const result = await captureFingerprints(selectors, makeConfig(), tmpDir);
    expect(result.skipped).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('merges with existing fingerprints', async () => {
    const sel1 = [makeSelector({ id: 'first0first0', rawValue: '#submit' })];
    await captureFingerprints(sel1, makeConfig(), tmpDir);

    const sel2 = [
      makeSelector({ id: 'second0secnd', selectorType: 'testid', rawValue: 'email-input' }),
    ];
    await captureFingerprints(sel2, makeConfig(), tmpDir);

    const stored = loadFingerprints(tmpDir)._unsafeUnwrap();
    expect(stored.size).toBe(2);
  });
}, 60_000);
