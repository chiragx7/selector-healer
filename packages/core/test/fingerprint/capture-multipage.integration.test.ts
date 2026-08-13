import { mkdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureFingerprints } from '../../src/fingerprint/capture.js';
import { loadFingerprints } from '../../src/fingerprint/store.js';
import type { HealerConfig, PageConfig, SelectorUsage } from '../../src/types.js';
import { startFixtureServer } from '../fixtures/server.js';

describe('captureFingerprints - multi-page (integration)', () => {
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
    tmpDir = join(tmpdir(), `sh-mp-cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
      id: 'mp_cap_00001',
      filePath: '/test/login.spec.ts',
      line: 5,
      column: 10,
      selectorType: 'css',
      rawValue: '#submit',
      contextHint: '/login',
      ...overrides,
    };
  }

  it('captures selector via Phase 2 when default page misses it', async () => {
    // data-testid="dashboard" exists only on /dashboard, not on /login
    const sel = makeSelector({
      id: 'mp_dash_0001',
      selectorType: 'testid',
      rawValue: 'dashboard',
      contextHint: '/login', // Phase 1 looks on /login - won't find it
    });

    const pages: PageConfig[] = [{ name: 'Dashboard', url: '/dashboard' }];
    const result = await captureFingerprints([sel], makeConfig({ pages }), tmpDir);

    expect(result.captured).toBe(1);
    const stored = loadFingerprints(tmpDir)._unsafeUnwrap();
    const fp = stored.get('mp_dash_0001');
    expect(fp).toBeDefined();
    expect(fp?.tagName).toBe('h1');
    expect(fp?.attributes['data-testid']).toBe('dashboard');
  });

  it('captures auth-gated element via setup hook', async () => {
    // data-testid="secret-content" is hidden until the unlock button is clicked
    const sel = makeSelector({
      id: 'mp_auth_0001',
      selectorType: 'testid',
      rawValue: 'secret-content',
      contextHint: '/auth-gate', // Phase 1 navigates here but element is hidden
    });

    const pages: PageConfig[] = [
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

    const result = await captureFingerprints([sel], makeConfig({ pages }), tmpDir);

    expect(result.captured).toBe(1);
    const stored = loadFingerprints(tmpDir)._unsafeUnwrap();
    const fp = stored.get('mp_auth_0001');
    expect(fp).toBeDefined();
    expect(fp?.tagName).toBe('h1');
    expect(fp?.textContent).toBe('Secret Dashboard');
  });

  it('does not retry when all captured in Phase 1', async () => {
    // #submit exists on /login - Phase 1 captures it, Phase 2 is never reached
    const sel = makeSelector({ id: 'mp_skip_0001' });

    const pages: PageConfig[] = [{ name: 'Dashboard', url: '/dashboard' }];
    const result = await captureFingerprints([sel], makeConfig({ pages }), tmpDir);

    expect(result.captured).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('captures mixed selectors across Phase 1 and Phase 2', async () => {
    const loginSel = makeSelector({
      id: 'mp_mix_login',
      rawValue: '#submit',
      contextHint: '/login',
    });
    const dashSel = makeSelector({
      id: 'mp_mix_dashb',
      selectorType: 'testid',
      rawValue: 'dashboard',
      contextHint: '/login', // wrong hint - Phase 1 misses, Phase 2 catches
    });

    const pages: PageConfig[] = [{ name: 'Dashboard', url: '/dashboard' }];
    const result = await captureFingerprints([loginSel, dashSel], makeConfig({ pages }), tmpDir);

    expect(result.captured).toBe(2);
    const stored = loadFingerprints(tmpDir)._unsafeUnwrap();
    expect(stored.has('mp_mix_login')).toBe(true);
    expect(stored.has('mp_mix_dashb')).toBe(true);
  });

  it('skips selector not found on any page', async () => {
    const sel = makeSelector({
      id: 'mp_none_0001',
      rawValue: '#totally-nonexistent',
      contextHint: '/login',
    });

    const pages: PageConfig[] = [
      { name: 'Dashboard', url: '/dashboard' },
      { name: 'Auth gate', url: '/auth-gate' },
    ];
    const result = await captureFingerprints([sel], makeConfig({ pages }), tmpDir);

    expect(result.captured).toBe(0);
    expect(result.skipped).toBe(1);
  });
}, 60_000);
