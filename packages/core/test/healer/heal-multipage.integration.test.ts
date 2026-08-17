import { mkdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureFingerprints } from '../../src/fingerprint/capture.js';
import { healSelectors } from '../../src/healer/heal.js';
import type {
  DomFingerprint,
  HealerConfig,
  PageConfig,
  SelectorUsage,
  VerificationResult,
} from '../../src/types.js';
import { startFixtureServer } from '../fixtures/server.js';

describe('healSelectors - multi-page (integration)', () => {
  let server: Server;
  let baseUrl: string;
  let mutatedServer: Server;
  let mutatedBaseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    const fixture = await startFixtureServer();
    server = fixture.server;
    baseUrl = fixture.baseUrl;

    const mutated = await startFixtureServer({ mutated: true });
    mutatedServer = mutated.server;
    mutatedBaseUrl = mutated.baseUrl;
  });

  afterAll(() => {
    server.close();
    mutatedServer.close();
  });

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sh-mp-heal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
      id: 'mp_heal_0001',
      filePath: '/test/login.spec.ts',
      line: 5,
      column: 10,
      selectorType: 'css',
      rawValue: '#submit',
      contextHint: '/login',
      ...overrides,
    };
  }

  it('finds heal candidates on configured page when default page has none', async () => {
    // Capture a dashboard element fingerprint
    const dashSel = makeSelector({
      id: 'mp_hdash_001',
      selectorType: 'testid',
      rawValue: 'dashboard',
      contextHint: '/login', // wrong context
    });

    const pages: PageConfig[] = [{ name: 'Dashboard', url: '/dashboard' }];
    await captureFingerprints([dashSel], makeConfig({ pages }), tmpDir);

    // Simulate a broken result - selector changed but element still exists on /dashboard
    const broken: VerificationResult[] = [
      {
        selector: { ...dashSel, rawValue: '#old-dashboard-id' },
        status: 'broken',
        matchCount: 0,
        storedFingerprint: {
          selectorId: 'mp_hdash_001',
          capturedAt: '2026-01-01T00:00:00.000Z',
          tagName: 'h1',
          attributes: { 'data-testid': 'dashboard', class: 'greeting' },
          textContent: 'Welcome back',
          parentChain: [{ tagName: 'div', id: 'root', classes: ['app'], role: 'main' }],
          siblingIndex: 0,
          pageUrl: `${baseUrl}/dashboard`,
        },
      },
    ];

    // Heal without pages - Phase 1 searches /login, won't find dashboard element
    const suggestionsNone = await healSelectors(broken, {
      config: makeConfig(),
      projectRoot: tmpDir,
    });
    expect(suggestionsNone).toHaveLength(1);
    expect(suggestionsNone[0]?.candidates).toHaveLength(0);

    // Heal with pages - Phase 2 searches /dashboard, finds the element
    const suggestionsWithPages = await healSelectors(broken, {
      config: makeConfig({ pages }),
      projectRoot: tmpDir,
    });
    expect(suggestionsWithPages).toHaveLength(1);
    expect(suggestionsWithPages[0]?.candidates.length).toBeGreaterThan(0);
    expect(suggestionsWithPages[0]?.candidates[0]?.replacementCode).toContain('dashboard');
  });

  it('finds candidates on auth-gated page via setup hook', async () => {
    const sel = makeSelector({
      id: 'mp_hauth_001',
      selectorType: 'testid',
      rawValue: 'secret-content',
      contextHint: '/auth-gate',
    });

    // Capture with setup hook
    const capturePages: PageConfig[] = [
      {
        name: 'Auth gate (unlocked)',
        url: '/auth-gate',
        setup: async (page) => {
          const p = page as Page;
          await p.goto(`${baseUrl}/auth-gate`);
          await p.locator('#unlock').click();
          await p.locator('#protected').waitFor({ state: 'visible', timeout: 5_000 });
        },
      },
    ];
    await captureFingerprints([sel], makeConfig({ pages: capturePages }), tmpDir);

    // Simulate broken - element hidden without setup
    const broken: VerificationResult[] = [
      {
        selector: { ...sel, rawValue: '#old-secret' },
        status: 'broken',
        matchCount: 0,
        storedFingerprint: {
          selectorId: 'mp_hauth_001',
          capturedAt: '2026-01-01T00:00:00.000Z',
          tagName: 'h1',
          attributes: { 'data-testid': 'secret-content', class: 'secret' },
          textContent: 'Secret Dashboard',
          parentChain: [],
          siblingIndex: 0,
          pageUrl: `${baseUrl}/auth-gate`,
        },
      },
    ];

    // Heal with setup hook pages
    const healPages: PageConfig[] = [
      {
        name: 'Auth gate (unlocked)',
        url: '/auth-gate',
        setup: async (page) => {
          const p = page as Page;
          await p.goto(`${baseUrl}/auth-gate`);
          await p.locator('#unlock').click();
          await p.locator('#protected').waitFor({ state: 'visible', timeout: 5_000 });
        },
      },
    ];

    const suggestions = await healSelectors(broken, {
      config: makeConfig({ pages: healPages }),
      projectRoot: tmpDir,
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.candidates.length).toBeGreaterThan(0);
    const top = suggestions[0]?.candidates[0];
    expect(top?.replacementCode).toContain('secret-content');
  });

  it('returns empty candidates when element is truly gone from all pages', async () => {
    const broken: VerificationResult[] = [
      {
        selector: makeSelector({ id: 'mp_hgone_001', rawValue: '#vanished' }),
        status: 'broken',
        matchCount: 0,
        storedFingerprint: {
          selectorId: 'mp_hgone_001',
          capturedAt: '2026-01-01T00:00:00.000Z',
          tagName: 'div',
          attributes: { id: 'vanished', 'data-testid': 'unicorn-element' },
          textContent: 'This element does not exist anywhere',
          parentChain: [],
          siblingIndex: 99,
          pageUrl: `${baseUrl}/login`,
        },
      },
    ];

    // Seed a fingerprint so heal can load it
    const sel = makeSelector({ id: 'seed_fp_heal' });
    await captureFingerprints([sel], makeConfig(), tmpDir);

    const pages: PageConfig[] = [
      { name: 'Dashboard', url: '/dashboard' },
      { name: 'Auth gate', url: '/auth-gate' },
    ];

    const suggestions = await healSelectors(broken, {
      config: makeConfig({ pages }),
      projectRoot: tmpDir,
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.candidates).toHaveLength(0);
  });

  it('skips a page listed in unreachablePages and does not run its setup', async () => {
    // Seed a fingerprint store so heal can load (it bails if the store is missing).
    await captureFingerprints([makeSelector({ id: 'seed_skip' })], makeConfig(), tmpDir);

    let setupCalled = false;
    const broken: VerificationResult[] = [
      {
        selector: makeSelector({
          id: 'mp_hskip_001',
          rawValue: '#missing-on-login',
          contextHint: '/login',
        }),
        status: 'broken',
        matchCount: 0,
        storedFingerprint: {
          selectorId: 'mp_hskip_001',
          capturedAt: '2026-01-01T00:00:00.000Z',
          tagName: 'h1',
          attributes: { 'data-testid': 'dashboard' },
          textContent: 'Welcome back',
          parentChain: [],
          siblingIndex: 0,
          pageUrl: `${baseUrl}/dashboard`,
        },
      },
    ];

    const pages: PageConfig[] = [
      {
        name: 'Dashboard',
        url: '/dashboard',
        setup: async () => {
          setupCalled = true;
        },
      },
    ];

    const suggestions = await healSelectors(broken, {
      config: makeConfig({ pages }),
      projectRoot: tmpDir,
      unreachablePages: new Set([`${baseUrl}/dashboard`.replace(/\/$/, '')]),
    });

    expect(setupCalled).toBe(false); // the page was skipped - hook not re-run
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.candidates).toHaveLength(0);
  });

  it('reports unreachable (not "removed") when the page never loads', async () => {
    // Seed a fingerprint store so heal proceeds (it bails without one).
    await captureFingerprints([makeSelector({ id: 'seed_unreach' })], makeConfig(), tmpDir);

    const broken: VerificationResult[] = [
      {
        selector: makeSelector({ id: 'mp_unreach_001', rawValue: '#gone', contextHint: '/login' }),
        status: 'broken',
        matchCount: 0,
        storedFingerprint: {
          selectorId: 'mp_unreach_001',
          capturedAt: '2026-01-01T00:00:00.000Z',
          tagName: 'h1',
          attributes: { 'data-testid': 'dashboard' },
          textContent: 'Welcome back',
          parentChain: [],
          siblingIndex: 0,
          pageUrl: `${baseUrl}/login`,
        },
      },
    ];

    // Point heal at a dead address so every page load fails fast (ECONNREFUSED).
    const suggestions = await healSelectors(broken, {
      config: makeConfig({ baseUrl: 'http://127.0.0.1:1', timeout: 3_000 }),
      projectRoot: tmpDir,
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.candidates).toHaveLength(0);
    // The element wasn't removed - we never reached a page to look. Say so.
    expect(suggestions[0]?.unreachable).toBe(true);
    expect(suggestions[0]?.explanation?.[0]?.kind).toBe('unreachable');
  });

  it('does not crash when login/globalSetup throws (degrades to unreachable)', async () => {
    // A failed login must not throw out of the whole heal. Here every page is dead
    // too, so the selector reads unreachable - the point is heal completes cleanly.
    await captureFingerprints([makeSelector({ id: 'seed_auth' })], makeConfig(), tmpDir);

    const broken: VerificationResult[] = [
      {
        selector: makeSelector({ id: 'mp_authfail_001', rawValue: '#gone', contextHint: '/login' }),
        status: 'broken',
        matchCount: 0,
        storedFingerprint: {
          selectorId: 'mp_authfail_001',
          capturedAt: '2026-01-01T00:00:00.000Z',
          tagName: 'h1',
          attributes: { 'data-testid': 'behind-login-only' },
          textContent: 'Exists only behind login',
          parentChain: [],
          siblingIndex: 42,
          pageUrl: `${baseUrl}/dashboard`,
        },
      },
    ];

    const suggestions = await healSelectors(broken, {
      config: makeConfig({
        baseUrl: 'http://127.0.0.1:1',
        timeout: 3_000,
        globalSetup: async () => {
          throw new Error('login failed');
        },
      }),
      projectRoot: tmpDir,
    });

    // Heal returned (didn't throw) and reported honestly.
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.candidates).toHaveLength(0);
    expect(suggestions[0]?.unreachable).toBe(true);
  });

  it('reports unreachable when the scan lands on a different page than the baseline', async () => {
    // The login-bounce / wrong-page case: the page loads fine (200, no hard failure),
    // but it is NOT the page the element was captured on - here the selector's
    // contextHint resolves to /login while its baseline lives on /dashboard. The URL
    // mismatch must read as "couldn't reach", not a false "removed".
    await captureFingerprints([makeSelector({ id: 'seed_wp' })], makeConfig(), tmpDir);

    const broken: VerificationResult[] = [
      {
        selector: makeSelector({
          id: 'mp_wrongpage_001',
          rawValue: '#gone',
          contextHint: '/login',
        }),
        status: 'broken',
        matchCount: 0,
        storedFingerprint: {
          selectorId: 'mp_wrongpage_001',
          capturedAt: '2026-01-01T00:00:00.000Z',
          tagName: 'h1',
          attributes: { 'data-testid': 'dashboard-only-heading' },
          textContent: 'Exists only on the dashboard',
          parentChain: [],
          siblingIndex: 71,
          pageUrl: `${baseUrl}/dashboard`, // element lives here, but heal only sees /login
        },
      },
    ];

    // Real (reachable) baseUrl: /login loads with a 200, so there is no hard failure -
    // only the URL mismatch tells us we never reached the element's page.
    const suggestions = await healSelectors(broken, { config: makeConfig(), projectRoot: tmpDir });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.candidates).toHaveLength(0);
    expect(suggestions[0]?.unreachable).toBe(true);
    expect(suggestions[0]?.explanation?.[0]?.kind).toBe('unreachable');
  });
}, 120_000);
