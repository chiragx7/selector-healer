import { relative } from 'node:path';
import type { DomFingerprint, SelectorUsage } from '../types.js';

/**
 * Project-root-relative, forward-slashed path for a source file. Stable across
 * machines and operating systems, so it's safe to persist in the committed
 * `fingerprints.json` and to compare against later.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param filePath - Absolute path to the source file.
 * @returns The relative path with `/` separators (e.g. `tests/login.spec.ts`).
 *
 * @example
 * ```ts
 * toSourceFile('/repo', '/repo/tests/login.spec.ts'); // 'tests/login.spec.ts'
 * ```
 */
export function toSourceFile(projectRoot: string, filePath: string): string {
  return relative(projectRoot, filePath).split(/[\\/]/).join('/');
}

/**
 * Find a baseline captured for a *different* selector at the same source
 * location (file + line + column). This recovers a **renamed** selector: when
 * the user changes the string inside a locator — e.g. `getByLabel('Email')` →
 * `getByLabel('Nope')` — its `selectorId` changes and the direct baseline
 * lookup misses, yet the fingerprint captured for the original value still sits
 * at that same call site (renaming the argument doesn't move the call's start
 * column). Reusing it lets the healer suggest the element that used to be there
 * instead of reporting "no replacement found".
 *
 * Matching on the column too keeps two distinct selectors that happen to share
 * a line (e.g. a chained locator) from borrowing each other's baseline; if the
 * column ever shifts (a reflow), recovery simply degrades to "no suggestion"
 * rather than a wrong one.
 *
 * Only fingerprints carrying a {@link DomFingerprint.source} (captured since
 * this feature landed) are considered, so pre-existing baselines never match
 * until re-captured. Call only after a direct `fingerprints.get(id)` miss.
 *
 * @param fingerprints - All stored fingerprints, keyed by `selectorId`.
 * @param selector - The broken selector with no direct baseline.
 * @param projectRoot - Absolute project root, used to relativise the selector's path.
 * @returns The orphaned baseline at the same `file:line`, or `undefined`.
 *
 * @example
 * ```ts
 * // selector renamed at tests/login.spec.ts:16 — pick up the baseline still
 * // filed at that line so the healer can re-locate the original element.
 * const orphan = findOrphanBaseline(fingerprints, renamedSelector, projectRoot);
 * ```
 */
export function findOrphanBaseline(
  fingerprints: Map<string, DomFingerprint>,
  selector: SelectorUsage,
  projectRoot: string,
): DomFingerprint | undefined {
  const file = toSourceFile(projectRoot, selector.filePath);
  for (const fp of fingerprints.values()) {
    // Skip a direct hit — this fallback is only meaningful for a *different*
    // selector's baseline sitting at the same call site.
    if (fp.selectorId === selector.id) continue;
    if (
      fp.source &&
      fp.source.file === file &&
      fp.source.line === selector.line &&
      fp.source.column === selector.column
    ) {
      return fp;
    }
  }
  return undefined;
}
