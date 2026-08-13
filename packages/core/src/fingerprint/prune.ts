import type { DomFingerprint, SelectorUsage } from '../types.js';
import { toSourceFile } from './source-match.js';

/** Outcome of a prune: the trimmed baseline plus the orphans that were dropped. */
export interface PruneResult {
  /** Fingerprints to keep (live baselines + reachable recovery orphans). */
  kept: Map<string, DomFingerprint>;
  /** Orphaned fingerprints removed - no current selector, no live call site. */
  removed: DomFingerprint[];
}

/**
 * Remove fingerprints that no longer belong to any current selector. Capture
 * only ever *merges* into the baseline, so renaming/moving/deleting a selector
 * leaves its old fingerprint behind as an orphan; over time the store fills with
 * dead entries. This computes which to keep.
 *
 * A fingerprint is **kept** when either:
 *  1. its `selectorId` matches a current selector (a live baseline), or
 *  2. it carries a {@link DomFingerprint.source} whose call site
 *     (`file:line:column`) is still occupied by a current selector - i.e. it's
 *     the pre-rename baseline that rename recovery ({@link findOrphanBaseline})
 *     would use. Only *fully unreachable* orphans are removed, so pruning never
 *     silently disables a recovery the user is relying on.
 *
 * Pure and side-effect free; the caller persists {@link PruneResult.kept}.
 *
 * **Caller contract:** `currentSelectors` must be the *complete* set from a
 * successful parse. An empty or partial list (a misconfigured test dir, or files
 * that failed to parse) makes live fingerprints look orphaned - pruning on it
 * would delete valid baselines. Callers must refuse when the parse was
 * incomplete or found nothing; see the `prune` CLI command and `runPruneStale`.
 *
 * @param fingerprints - the current stored fingerprints, keyed by `selectorId`
 * @param currentSelectors - every selector parsed from the current test files
 * @param projectRoot - absolute project root, to relativise selector paths
 * @returns the kept map and the removed orphans
 *
 * @example
 * ```ts
 * const { kept, removed } = pruneFingerprints(stored, selectors, root);
 * if (removed.length) saveFingerprints(root, kept);
 * ```
 */
export function pruneFingerprints(
  fingerprints: Map<string, DomFingerprint>,
  currentSelectors: readonly SelectorUsage[],
  projectRoot: string,
): PruneResult {
  const liveIds = new Set<string>();
  const liveCallSites = new Set<string>();
  for (const s of currentSelectors) {
    liveIds.add(s.id);
    liveCallSites.add(`${toSourceFile(projectRoot, s.filePath)}:${s.line}:${s.column}`);
  }

  const kept = new Map<string, DomFingerprint>();
  const removed: DomFingerprint[] = [];
  for (const [id, fp] of fingerprints) {
    const live = liveIds.has(id);
    const recoverable =
      fp.source !== undefined &&
      liveCallSites.has(`${fp.source.file}:${fp.source.line}:${fp.source.column}`);
    if (live || recoverable) kept.set(id, fp);
    else removed.push(fp);
  }
  return { kept, removed };
}
