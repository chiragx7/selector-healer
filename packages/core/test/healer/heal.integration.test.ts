import { mkdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureFingerprints } from '../../src/fingerprint/capture.js';
import { healSelectors } from '../../src/healer/heal.js';
import type { HealerConfig, SelectorUsage, VerificationResult } from '../../src/types.js';
import { verifySelectors } from '../../src/verifier/verify.js';
import { startFixtureServer } from '../fixtures/server.js';

describe('healSelectors (integration)', () => {
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
    tmpDir = join(tmpdir(), `sh-heal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
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
      id: 'heal11heal11',
      filePath: '/test/login.spec.ts',
      line: 5,
      column: 10,
      selectorType: 'css',
      rawValue: '#submit',
      contextHint: '/login',
      ...overrides,
    };
  }

  it('suggests replacements for a broken CSS selector', async () => {
    const sel = makeSelector();
    const config = makeConfig();

    await captureFingerprints([sel], config, tmpDir);

    const mutatedConfig = makeConfig({ baseUrl: mutatedBaseUrl });
    const verifyResults = await verifySelectors([sel], {
      config: mutatedConfig,
      projectRoot: tmpDir,
    });
    const broken = verifyResults.filter((r) => r.status === 'broken');
    expect(broken).toHaveLength(1);

    const suggestions = await healSelectors(broken, {
      config: mutatedConfig,
      projectRoot: tmpDir,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.candidates.length).toBeGreaterThan(0);

    const topCandidate = suggestions[0]?.candidates[0];
    expect(topCandidate?.confidence).toBeGreaterThan(0);
    expect(topCandidate?.replacementCode).toBeTruthy();
    expect(topCandidate?.reasoning).toContain('Matched');
  });

  it('returns empty candidates for unfindable element', async () => {
    const sel = makeSelector({ id: 'gone11gone11', rawValue: '#totally-unique-gone' });
    const config = makeConfig();

    await captureFingerprints([makeSelector()], config, tmpDir);

    const broken: VerificationResult[] = [
      {
        selector: sel,
        status: 'broken',
        matchCount: 0,
        storedFingerprint: {
          selectorId: sel.id,
          capturedAt: '2026-01-01T00:00:00.000Z',
          tagName: 'div',
          attributes: { id: 'totally-unique-gone', 'data-testid': 'impossible-element' },
          textContent: 'xyzzy-nonexistent-text-12345',
          parentChain: [],
          siblingIndex: 99,
          pageUrl: `${mutatedBaseUrl}/login`,
        },
      },
    ];

    const suggestions = await healSelectors(broken, {
      config: makeConfig({ baseUrl: mutatedBaseUrl }),
      projectRoot: tmpDir,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.candidates).toHaveLength(0);
  });

  it('returns at most 3 candidates', async () => {
    const sel = makeSelector({ id: 'many11many11', selectorType: 'css', rawValue: 'button' });
    const config = makeConfig();

    await captureFingerprints([sel], config, tmpDir);

    const broken: VerificationResult[] = [
      {
        selector: sel,
        status: 'broken',
        matchCount: 0,
        storedFingerprint: {
          selectorId: sel.id,
          capturedAt: '2026-01-01T00:00:00.000Z',
          tagName: 'button',
          attributes: { role: 'button' },
          textContent: '',
          parentChain: [],
          siblingIndex: 0,
          pageUrl: `${baseUrl}/login`,
        },
      },
    ];

    const suggestions = await healSelectors(broken, { config, projectRoot: tmpDir });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.candidates.length).toBeLessThanOrEqual(3);
  });

  it('candidates are sorted by confidence descending', async () => {
    const sel = makeSelector();
    const config = makeConfig();

    await captureFingerprints([sel], config, tmpDir);

    const mutatedConfig = makeConfig({ baseUrl: mutatedBaseUrl });
    const verifyResults = await verifySelectors([sel], {
      config: mutatedConfig,
      projectRoot: tmpDir,
    });
    const broken = verifyResults.filter((r) => r.status === 'broken');

    const suggestions = await healSelectors(broken, {
      config: mutatedConfig,
      projectRoot: tmpDir,
    });

    const candidates = suggestions[0]?.candidates ?? [];
    for (let i = 1; i < candidates.length; i++) {
      const prev = candidates[i - 1];
      const curr = candidates[i];
      if (prev && curr) {
        expect(prev.confidence).toBeGreaterThanOrEqual(curr.confidence);
      }
    }
  });

  it('handles empty broken list gracefully', async () => {
    const suggestions = await healSelectors([], {
      config: makeConfig(),
      projectRoot: tmpDir,
    });
    expect(suggestions).toHaveLength(0);
  });

  it('prefers data-testid in replacement code when available', async () => {
    const sel = makeSelector({
      id: 'tid11tid11ti',
      selectorType: 'testid',
      rawValue: 'email-input',
    });
    const config = makeConfig();

    await captureFingerprints([sel], config, tmpDir);

    const broken: VerificationResult[] = [
      {
        selector: sel,
        status: 'broken',
        matchCount: 0,
        storedFingerprint: {
          selectorId: sel.id,
          capturedAt: '2026-01-01T00:00:00.000Z',
          tagName: 'input',
          attributes: { 'data-testid': 'email-input', type: 'email' },
          textContent: '',
          parentChain: [],
          siblingIndex: 0,
          pageUrl: `${mutatedBaseUrl}/login`,
        },
      },
    ];

    const suggestions = await healSelectors(broken, {
      config: makeConfig({ baseUrl: mutatedBaseUrl }),
      projectRoot: tmpDir,
    });

    const top = suggestions[0]?.candidates[0];
    if (top) {
      expect(top.replacementCode).toContain('getByTestId');
    }
  });
}, 90_000);
