import type { VerificationResult } from '@selector-healer/core';
import * as vscode from 'vscode';
import type { StoredSuggestion } from './code-actions.js';

/** Lifecycle phase of the most recent verification run. */
export type RunPhase = 'idle' | 'running' | 'done';

/** Aggregate counts derived from a set of verification results. */
export interface StatusCounts {
  ok: number;
  broken: number;
  multi: number;
  skipped: number;
  failed: number;
  total: number;
  /** Percentage of *verifiable* selectors (ok / (ok+broken+multi)) that are healthy. */
  healthPct: number;
}

/** Immutable snapshot of everything the UI surfaces render. */
export interface HealerSnapshot {
  phase: RunPhase;
  results: VerificationResult[];
  /** Heal suggestions keyed by `${filePath}:${line}`. */
  suggestionsByKey: Map<string, StoredSuggestion[]>;
  /** Top "why it broke" reason per selector id — survives targeted/watch merges. */
  explanationsById: Map<string, string>;
  /**
   * Selector signatures the user chose to "Skip" (dismiss). A dismissed
   * attention-state selector is set aside from the active list + counts until its
   * signature changes (i.e. the selector is edited). Persisted across reloads.
   */
  dismissedSignatures: Set<string>;
  /** Epoch ms of the last completed run, if any. */
  lastRunAt?: number;
  /** Optional transient message (e.g. what the running phase is doing). */
  message?: string;
}

function emptySnapshot(): HealerSnapshot {
  return {
    phase: 'idle',
    results: [],
    suggestionsByKey: new Map(),
    explanationsById: new Map(),
    dismissedSignatures: new Set(),
  };
}

/**
 * Compute status counts and a health percentage from verification results.
 * Skipped/failed selectors are excluded from the health denominator since
 * they were not actually checked against the live DOM.
 *
 * @param results - verification results to summarise
 * @returns aggregate counts plus a 0–100 health percentage
 *
 * @example
 * const { healthPct } = countResults(results); // e.g. 90
 */
export function countResults(results: VerificationResult[]): StatusCounts {
  let ok = 0;
  let broken = 0;
  let multi = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of results) {
    switch (r.status) {
      case 'ok':
        ok++;
        break;
      case 'broken':
        broken++;
        break;
      case 'multiple-matches':
        multi++;
        break;
      case 'skipped':
        skipped++;
        break;
      case 'page-load-failed':
        failed++;
        break;
    }
  }

  const total = results.length;
  const verifiable = ok + broken + multi;
  const healthPct = verifiable > 0 ? Math.round((ok / verifiable) * 100) : total === 0 ? 0 : 100;

  return { ok, broken, multi, skipped, failed, total, healthPct };
}

/**
 * Central, observable state for the extension. Every UI surface (dashboard
 * webview, CodeLens, gutter decorations, tree view, status bar) subscribes to
 * {@link HealerStateStore.onDidChange} and renders from {@link HealerStateStore.snapshot}.
 */
class HealerStateStore {
  private current: HealerSnapshot = emptySnapshot();
  private readonly emitter = new vscode.EventEmitter<HealerSnapshot>();

  /** Fires whenever the snapshot changes. */
  readonly onDidChange = this.emitter.event;

  /** The latest immutable snapshot. */
  get snapshot(): HealerSnapshot {
    return this.current;
  }

  /** Mark a verification run as in-progress. */
  setRunning(message?: string): void {
    this.current = { ...this.current, phase: 'running', message };
    this.emitter.fire(this.current);
  }

  /** Publish completed verification results + heal suggestions. */
  setResults(
    results: VerificationResult[],
    suggestionsByKey: Map<string, StoredSuggestion[]>,
    explanationsById: Map<string, string> = new Map(),
  ): void {
    this.current = {
      phase: 'done',
      results,
      suggestionsByKey,
      explanationsById,
      dismissedSignatures: this.current.dismissedSignatures,
      lastRunAt: Date.now(),
    };
    this.emitter.fire(this.current);
  }

  /**
   * Merge freshly re-verified results for a few selectors into the current
   * snapshot — replacing the prior result at each `file:line` without re-running
   * the whole suite. Freshly-healed suggestions/explanations are overlaid, and
   * any for selectors that are no longer broken are dropped. Used for the
   * targeted re-verify after a fix is applied and by watch mode on save.
   *
   * @param updated - results for just the re-checked selectors
   * @param newSuggestions - freshly-healed suggestions to overlay, keyed by `file:line`
   * @param newExplanations - freshly-computed break reasons to overlay, keyed by selector id
   */
  mergeResults(
    updated: VerificationResult[],
    newSuggestions?: Map<string, StoredSuggestion[]>,
    newExplanations?: Map<string, string>,
  ): void {
    const byKey = new Map<string, VerificationResult>();
    for (const r of updated) {
      byKey.set(`${r.selector.filePath}:${r.selector.line}`, r);
    }

    const merged = this.current.results.map((r) => {
      const key = `${r.selector.filePath}:${r.selector.line}`;
      const replacement = byKey.get(key);
      if (replacement) byKey.delete(key);
      return replacement ?? r;
    });
    // Any updated rows that didn't match an existing result are appended.
    for (const r of byKey.values()) merged.push(r);

    const suggestionsByKey = new Map(this.current.suggestionsByKey);
    const explanationsById = new Map(this.current.explanationsById);
    if (newSuggestions) for (const [k, v] of newSuggestions) suggestionsByKey.set(k, v);
    if (newExplanations) for (const [k, v] of newExplanations) explanationsById.set(k, v);
    // Drop stale heal data for anything that is no longer broken.
    for (const r of updated) {
      if (r.status !== 'broken') {
        suggestionsByKey.delete(`${r.selector.filePath}:${r.selector.line}`);
        explanationsById.delete(r.selector.id);
      }
    }

    this.current = {
      phase: 'done',
      results: merged,
      suggestionsByKey,
      explanationsById,
      dismissedSignatures: this.current.dismissedSignatures,
      lastRunAt: Date.now(),
    };
    this.emitter.fire(this.current);
  }

  /**
   * Set or clear a selector's "dismissed" (Skip) state by signature, preserving
   * the rest of the snapshot. Fires a change so every surface re-renders.
   *
   * @param signature - the selector signature to toggle
   * @param dismissed - true to dismiss (Skip), false to restore
   */
  setDismissed(signature: string, dismissed: boolean): void {
    const next = new Set(this.current.dismissedSignatures);
    if (dismissed) next.add(signature);
    else next.delete(signature);
    this.current = { ...this.current, dismissedSignatures: next };
    this.emitter.fire(this.current);
  }

  /** Seed the dismissed set from persisted storage on activation. */
  hydrateDismissed(signatures: Set<string>): void {
    this.current = { ...this.current, dismissedSignatures: signatures };
    this.emitter.fire(this.current);
  }

  /**
   * Restore a previously-persisted "done" snapshot (e.g. after a window reload)
   * so the panel lands back on the last verify results instead of onboarding.
   *
   * @param snapshot - the results, suggestions, explanations, and run time to restore
   */
  hydrate(snapshot: {
    results: VerificationResult[];
    suggestionsByKey: Map<string, StoredSuggestion[]>;
    explanationsById: Map<string, string>;
    lastRunAt?: number;
  }): void {
    this.current = {
      phase: 'done',
      results: snapshot.results,
      suggestionsByKey: snapshot.suggestionsByKey,
      explanationsById: snapshot.explanationsById,
      dismissedSignatures: this.current.dismissedSignatures,
      lastRunAt: snapshot.lastRunAt,
    };
    this.emitter.fire(this.current);
  }

  /** Clear run state back to idle, but keep the user's dismissals (a preference). */
  reset(): void {
    this.current = { ...emptySnapshot(), dismissedSignatures: this.current.dismissedSignatures };
    this.emitter.fire(this.current);
  }

  /** Counts for the current snapshot. */
  counts(): StatusCounts {
    return countResults(this.current.results);
  }

  /** Ranked suggestions for a given file + 1-indexed line. */
  suggestionsFor(filePath: string, line: number): StoredSuggestion[] {
    return this.current.suggestionsByKey.get(`${filePath}:${line}`) ?? [];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Singleton state store shared by all UI surfaces. */
export const healerState = new HealerStateStore();
