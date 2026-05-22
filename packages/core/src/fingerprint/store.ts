import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { DomFingerprint } from '../types.js';

const STORE_DIR = '.selector-healer';
const STORE_FILE = 'fingerprints.json';

export interface StoreError {
  type: 'read-error' | 'write-error';
  message: string;
}

export function getStorePath(projectRoot: string): string {
  return join(resolve(projectRoot), STORE_DIR, STORE_FILE);
}

export function loadFingerprints(
  projectRoot: string,
): Result<Map<string, DomFingerprint>, StoreError> {
  const storePath = getStorePath(projectRoot);

  if (!existsSync(storePath)) {
    return ok(new Map());
  }

  try {
    const raw = readFileSync(storePath, 'utf8');
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return err({ type: 'read-error', message: `Expected array in ${storePath}` });
    }
    const map = new Map<string, DomFingerprint>();
    for (const item of data) {
      const fp = item as DomFingerprint;
      map.set(fp.selectorId, fp);
    }
    return ok(map);
  } catch (e) {
    return err({
      type: 'read-error',
      message: `Failed to read ${storePath}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

export function saveFingerprints(
  projectRoot: string,
  fingerprints: Map<string, DomFingerprint>,
): Result<string, StoreError> {
  const storePath = getStorePath(projectRoot);

  try {
    const dir = dirname(storePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const sorted = [...fingerprints.values()].sort((a, b) =>
      a.selectorId.localeCompare(b.selectorId),
    );
    writeFileSync(storePath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
    return ok(storePath);
  } catch (e) {
    return err({
      type: 'write-error',
      message: `Failed to write ${storePath}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
