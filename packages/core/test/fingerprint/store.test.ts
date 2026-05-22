import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStorePath, loadFingerprints, saveFingerprints } from '../../src/fingerprint/store.js';
import type { DomFingerprint } from '../../src/types.js';

function makeFingerprint(overrides: Partial<DomFingerprint> = {}): DomFingerprint {
  return {
    selectorId: 'abc123def456',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'button',
    attributes: { id: 'submit', class: 'btn primary' },
    textContent: 'Submit',
    parentChain: [{ tagName: 'form', id: 'login', classes: ['auth-form'], role: 'form' }],
    siblingIndex: 0,
    pageUrl: 'https://app.com/login',
    ...overrides,
  };
}

describe('fingerprint store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sh-store-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getStorePath', () => {
    it('returns path under .selector-healer', () => {
      const p = getStorePath(tmpDir);
      expect(p).toContain('.selector-healer');
      expect(p).toContain('fingerprints.json');
    });
  });

  describe('loadFingerprints', () => {
    it('returns empty map when no file exists', () => {
      const result = loadFingerprints(tmpDir);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().size).toBe(0);
    });

    it('loads fingerprints from existing file', () => {
      const fp = makeFingerprint();
      const storeDir = join(tmpDir, '.selector-healer');
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(join(storeDir, 'fingerprints.json'), JSON.stringify([fp]), 'utf8');

      const result = loadFingerprints(tmpDir);
      expect(result.isOk()).toBe(true);
      const map = result._unsafeUnwrap();
      expect(map.size).toBe(1);
      expect(map.get('abc123def456')?.tagName).toBe('button');
    });

    it('returns error for invalid JSON', () => {
      const storeDir = join(tmpDir, '.selector-healer');
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(join(storeDir, 'fingerprints.json'), '{{invalid', 'utf8');

      const result = loadFingerprints(tmpDir);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('read-error');
    });

    it('returns error for non-array JSON', () => {
      const storeDir = join(tmpDir, '.selector-healer');
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(join(storeDir, 'fingerprints.json'), '{"not": "array"}', 'utf8');

      const result = loadFingerprints(tmpDir);
      expect(result.isErr()).toBe(true);
    });
  });

  describe('saveFingerprints', () => {
    it('creates directory and file', () => {
      const map = new Map<string, DomFingerprint>();
      map.set('abc123def456', makeFingerprint());

      const result = saveFingerprints(tmpDir, map);
      expect(result.isOk()).toBe(true);

      const raw = readFileSync(result._unsafeUnwrap(), 'utf8');
      const data = JSON.parse(raw);
      expect(data).toHaveLength(1);
      expect(data[0].selectorId).toBe('abc123def456');
    });

    it('sorts by selectorId', () => {
      const map = new Map<string, DomFingerprint>();
      map.set('zzz000000000', makeFingerprint({ selectorId: 'zzz000000000' }));
      map.set('aaa000000000', makeFingerprint({ selectorId: 'aaa000000000' }));

      saveFingerprints(tmpDir, map);
      const raw = readFileSync(getStorePath(tmpDir), 'utf8');
      const data = JSON.parse(raw);
      expect(data[0].selectorId).toBe('aaa000000000');
      expect(data[1].selectorId).toBe('zzz000000000');
    });

    it('overwrites existing file', () => {
      const map1 = new Map<string, DomFingerprint>();
      map1.set('aaa000000000', makeFingerprint({ selectorId: 'aaa000000000' }));
      saveFingerprints(tmpDir, map1);

      const map2 = new Map<string, DomFingerprint>();
      map2.set('bbb000000000', makeFingerprint({ selectorId: 'bbb000000000' }));
      saveFingerprints(tmpDir, map2);

      const result = loadFingerprints(tmpDir);
      const loaded = result._unsafeUnwrap();
      expect(loaded.size).toBe(1);
      expect(loaded.has('bbb000000000')).toBe(true);
    });
  });

  describe('roundtrip', () => {
    it('save then load preserves data', () => {
      const fp = makeFingerprint({
        boundingBox: { x: 10, y: 20, width: 100, height: 50 },
      });
      const map = new Map<string, DomFingerprint>();
      map.set(fp.selectorId, fp);

      saveFingerprints(tmpDir, map);
      const loaded = loadFingerprints(tmpDir)._unsafeUnwrap();
      const restored = loaded.get(fp.selectorId);
      expect(restored).toBeDefined();

      expect(restored?.tagName).toBe('button');
      expect(restored?.attributes).toEqual(fp.attributes);
      expect(restored?.parentChain).toEqual(fp.parentChain);
      expect(restored?.boundingBox).toEqual(fp.boundingBox);
    });
  });
});
