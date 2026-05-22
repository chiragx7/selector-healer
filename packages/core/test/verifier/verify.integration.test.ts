import { mkdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureFingerprints } from '../../src/fingerprint/capture.js';
import type { HealerConfig, SelectorUsage } from '../../src/types.js';
import { verifySelectors } from '../../src/verifier/verify.js';
import { startFixtureServer } from '../fixtures/server.js';

describe('verifySelectors (integration)', () => {
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
    tmpDir = join(tmpdir(), `sh-verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
      id: 'ver111ver111',
      filePath: '/test/login.spec.ts',
      line: 5,
      column: 10,
      selectorType: 'css',
      rawValue: '#submit',
      contextHint: '/login',
      ...overrides,
    };
  }

  it('returns skipped for selectors with no baseline', async () => {
    const selectors = [makeSelector()];
    const config = makeConfig();

    const results = await verifySelectors(selectors, { config, projectRoot: tmpDir });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('skipped');
  });

  it('returns ok for unchanged selector', async () => {
    const sel = makeSelector();
    const config = makeConfig();

    await captureFingerprints([sel], config, tmpDir);

    const results = await verifySelectors([sel], { config, projectRoot: tmpDir });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('ok');
    expect(results[0]?.matchCount).toBe(1);
    expect(results[0]?.liveFingerprint).toBeDefined();
    expect(results[0]?.storedFingerprint).toBeDefined();
  });

  it('returns broken for selector that no longer matches', async () => {
    const sel = makeSelector({ id: 'brk111brk111', rawValue: '#submit' });
    const config = makeConfig();

    await captureFingerprints([sel], config, tmpDir);

    const mutatedConfig = makeConfig({ baseUrl: mutatedBaseUrl });
    const results = await verifySelectors([sel], { config: mutatedConfig, projectRoot: tmpDir });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('broken');
    expect(results[0]?.matchCount).toBe(0);
  });

  it('returns ok for testid selector preserved across mutation', async () => {
    const sel = makeSelector({
      id: 'tid111tid111',
      selectorType: 'testid',
      rawValue: 'email-input',
    });
    const config = makeConfig();

    await captureFingerprints([sel], config, tmpDir);

    const mutatedConfig = makeConfig({ baseUrl: mutatedBaseUrl });
    const results = await verifySelectors([sel], { config: mutatedConfig, projectRoot: tmpDir });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('ok');
  });

  it('handles page-load-failed for unreachable pages', async () => {
    const sel = makeSelector({
      id: 'plf111plf111',
      contextHint: 'http://127.0.0.1:1',
    });
    const config = makeConfig();

    await captureFingerprints([makeSelector()], config, tmpDir);
    const stored = (await import('../../src/fingerprint/store.js'))
      .loadFingerprints(tmpDir)
      ._unsafeUnwrap();
    stored.set(sel.id, {
      selectorId: sel.id,
      capturedAt: '2026-01-01T00:00:00.000Z',
      tagName: 'button',
      attributes: { id: 'submit' },
      textContent: 'Log in',
      parentChain: [],
      siblingIndex: 0,
      pageUrl: 'http://127.0.0.1:1/login',
    });
    (await import('../../src/fingerprint/store.js')).saveFingerprints(tmpDir, stored);

    const results = await verifySelectors([sel], {
      config: makeConfig({ baseUrl: 'http://127.0.0.1:1' }),
      projectRoot: tmpDir,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('page-load-failed');
  });

  it('verifies multiple selectors in one call', async () => {
    const selectors = [
      makeSelector({ id: 'multi1multi1', rawValue: '#submit' }),
      makeSelector({ id: 'multi2multi2', selectorType: 'testid', rawValue: 'email-input' }),
    ];
    const config = makeConfig();

    await captureFingerprints(selectors, config, tmpDir);

    const results = await verifySelectors(selectors, { config, projectRoot: tmpDir });
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(2);
  });

  it('mixes skipped and verified results', async () => {
    const captured = makeSelector({ id: 'cap111cap111', rawValue: '#submit' });
    const uncaptured = makeSelector({ id: 'unc111unc111', rawValue: '#other' });
    const config = makeConfig();

    await captureFingerprints([captured], config, tmpDir);

    const results = await verifySelectors([captured, uncaptured], { config, projectRoot: tmpDir });
    expect(results).toHaveLength(2);
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain('ok');
    expect(statuses).toContain('skipped');
  });
}, 60_000);
