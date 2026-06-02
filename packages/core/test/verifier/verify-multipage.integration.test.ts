import { mkdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureFingerprints } from '../../src/fingerprint/capture.js';
import { saveFingerprints } from '../../src/fingerprint/store.js';
import type { DomFingerprint, HealerConfig, PageConfig, SelectorUsage } from '../../src/types.js';
import { verifySelectors } from '../../src/verifier/verify.js';
import { startFixtureServer } from '../fixtures/server.js';

describe('verifySelectors — multi-page (integration)', () => {
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
    tmpDir = join(tmpdir(), `sh-mp-ver-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
      id: 'mp_ver_00001',
      filePath: '/test/login.spec.ts',
      line: 5,
      column: 10,
      selectorType: 'css',
      rawValue: '#submit',
      contextHint: '/login',
      ...overrides,
    };
  }

  function makeDashboardFingerprint(selectorId: string): DomFingerprint {
    return {
      selectorId,
      capturedAt: '2026-01-01T00:00:00.000Z',
      tagName: 'h1',
      attributes: { 'data-testid': 'dashboard', class: 'greeting' },
      textContent: 'Welcome back',
      parentChain: [{ tagName: 'div', id: 'root', classes: ['app'], role: 'main' }],
      siblingIndex: 0,
      pageUrl: `${baseUrl}/dashboard`,
    };
  }

  it('verifies selector via Phase 2 when default page shows broken', async () => {
    // Seed a fingerprint for a dashboard element
    const sel = makeSelector({
      id: 'mp_vdash_001',
      selectorType: 'testid',
      rawValue: 'dashboard',
      contextHint: '/login', // Phase 1 tries /login — element not there → broken
    });
    const fp = makeDashboardFingerprint('mp_vdash_001');
    const store = new Map<string, DomFingerprint>([['mp_vdash_001', fp]]);
    saveFingerprints(tmpDir, store);

    const pages: PageConfig[] = [{ name: 'Dashboard', url: '/dashboard' }];
    const results = await verifySelectors([sel], {
      config: makeConfig({ pages }),
      projectRoot: tmpDir,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('ok');
    expect(results[0]?.matchCount).toBe(1);
  });

  it('verifies auth-gated element via setup hook', async () => {
    // Capture the secret-content element by using the setup hook
    const sel = makeSelector({
      id: 'mp_vauth_001',
      selectorType: 'testid',
      rawValue: 'secret-content',
      contextHint: '/auth-gate',
    });

    // First capture with setup hook to get the fingerprint
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

    // Now verify — Phase 1 navigates to /auth-gate but element is hidden → broken
    // Phase 2 uses setup hook to unlock → ok
    const verifyPages: PageConfig[] = [
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

    const results = await verifySelectors([sel], {
      config: makeConfig({ pages: verifyPages }),
      projectRoot: tmpDir,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('ok');
  });

  it('keeps broken status when no configured page resolves it', async () => {
    const sel = makeSelector({
      id: 'mp_vbrk_001',
      rawValue: '#totally-missing-element',
      contextHint: '/login',
    });

    // Seed a fake fingerprint so it's not skipped
    const fp: DomFingerprint = {
      selectorId: 'mp_vbrk_001',
      capturedAt: '2026-01-01T00:00:00.000Z',
      tagName: 'div',
      attributes: { id: 'totally-missing-element' },
      textContent: 'Gone forever',
      parentChain: [],
      siblingIndex: 0,
      pageUrl: `${baseUrl}/login`,
    };
    const store = new Map<string, DomFingerprint>([['mp_vbrk_001', fp]]);
    saveFingerprints(tmpDir, store);

    const pages: PageConfig[] = [
      { name: 'Dashboard', url: '/dashboard' },
      { name: 'Auth gate', url: '/auth-gate' },
    ];
    const results = await verifySelectors([sel], {
      config: makeConfig({ pages }),
      projectRoot: tmpDir,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('broken');
  });

  it('mixes Phase 1 ok and Phase 2 ok results', async () => {
    const loginSel = makeSelector({
      id: 'mp_vmix_log1',
      rawValue: '#submit',
      contextHint: '/login',
    });
    const dashSel = makeSelector({
      id: 'mp_vmix_das1',
      selectorType: 'testid',
      rawValue: 'dashboard',
      contextHint: '/login', // wrong hint
    });

    // Capture both — login on /login, dashboard via page config
    const pages: PageConfig[] = [{ name: 'Dashboard', url: '/dashboard' }];
    await captureFingerprints([loginSel, dashSel], makeConfig({ pages }), tmpDir);

    // Verify — loginSel ok in Phase 1, dashSel ok in Phase 2
    const results = await verifySelectors([loginSel, dashSel], {
      config: makeConfig({ pages }),
      projectRoot: tmpDir,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('reclassifies a broken selector to page-load-failed when its setup hook throws', async () => {
    // Element lives on /dashboard (fingerprint pageUrl), reachable only via a hook.
    const sel = makeSelector({
      id: 'mp_vsetup_01',
      selectorType: 'testid',
      rawValue: 'dashboard',
      contextHint: '/login', // Phase 1 checks /login → absent → broken
    });
    saveFingerprints(tmpDir, new Map([['mp_vsetup_01', makeDashboardFingerprint('mp_vsetup_01')]]));

    const pages: PageConfig[] = [
      {
        name: 'Dashboard (after login)',
        url: '/dashboard',
        setup: async () => {
          throw new Error('login failed: email field not found');
        },
      },
    ];
    const results = await verifySelectors([sel], {
      config: makeConfig({ pages }),
      projectRoot: tmpDir,
    });

    expect(results).toHaveLength(1);
    // Not 'broken' — it couldn't be checked because the page was unreachable.
    expect(results[0]?.status).toBe('page-load-failed');
    expect(results[0]?.error).toContain('setup hook failed');
    expect(results[0]?.error).toContain('Dashboard (after login)');
  });

  it('does NOT reclassify a default-page break when a same-URL page setup fails', async () => {
    const sel = makeSelector({
      id: 'mp_vsetup_02',
      rawValue: '#gone-from-login',
      contextHint: '/login',
    });
    const fp: DomFingerprint = {
      selectorId: 'mp_vsetup_02',
      capturedAt: '2026-01-01T00:00:00.000Z',
      tagName: 'div',
      attributes: { id: 'gone-from-login' },
      textContent: 'x',
      parentChain: [],
      siblingIndex: 0,
      pageUrl: baseUrl, // lives on the default page — always reachable
    };
    saveFingerprints(tmpDir, new Map([['mp_vsetup_02', fp]]));

    // A configured page whose URL is the base (an interaction state) with a failing setup.
    const pages: PageConfig[] = [
      {
        name: 'Error state',
        url: '/',
        setup: async () => {
          throw new Error('boom');
        },
      },
    ];
    const results = await verifySelectors([sel], {
      config: makeConfig({ pages }),
      projectRoot: tmpDir,
    });

    // Stays broken — a default-page break is genuine, not a reachability problem.
    expect(results[0]?.status).toBe('broken');
  });
}, 90_000);
