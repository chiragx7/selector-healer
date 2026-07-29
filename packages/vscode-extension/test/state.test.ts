import type { VerificationResult, VerificationStatus } from '@selector-healer/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { healerState, countResults } = await import('../src/state.js');
type StoredSuggestion = import('../src/code-actions.js').StoredSuggestion;

function vr(filePath: string, line: number, status: VerificationStatus): VerificationResult {
  return {
    selector: {
      id: `${filePath}:${line}`,
      filePath,
      line,
      column: 1,
      selectorType: 'css',
      rawValue: '.x',
    },
    status,
    matchCount: status === 'ok' ? 1 : status === 'multiple-matches' ? 3 : 0,
  };
}

function sugg(filePath: string, line: number): StoredSuggestion {
  return {
    selectorId: `${filePath}:${line}`,
    filePath,
    line,
    column: 1,
    rawValue: '.x',
    replacementCode: "page.getByTestId('x')",
    confidence: 0.9,
  };
}

describe('countResults', () => {
  it('computes health excluding skipped/failed from the denominator', () => {
    const c = countResults([
      vr('/a.ts', 1, 'ok'),
      vr('/a.ts', 2, 'ok'),
      vr('/a.ts', 3, 'ok'),
      vr('/a.ts', 4, 'broken'),
      vr('/a.ts', 5, 'multiple-matches'),
      vr('/a.ts', 6, 'skipped'),
      vr('/a.ts', 7, 'page-load-failed'),
    ]);
    expect(c).toMatchObject({ ok: 3, broken: 1, multi: 1, skipped: 1, failed: 1, total: 7 });
    // health = ok / (ok + broken + multi) = 3 / 5 = 60
    expect(c.healthPct).toBe(60);
  });

  it('is 100% when every verifiable selector is ok', () => {
    expect(countResults([vr('/a.ts', 1, 'ok'), vr('/a.ts', 2, 'ok')]).healthPct).toBe(100);
  });

  it('is 0 for an empty result set', () => {
    expect(countResults([]).healthPct).toBe(0);
  });
});

describe('healerState.mergeResults', () => {
  beforeEach(() => healerState.reset());

  it('replaces the result at a matching file:line and leaves others untouched', () => {
    healerState.setResults(
      [vr('/a.ts', 10, 'broken'), vr('/a.ts', 20, 'ok')],
      new Map([['/a.ts:10', [sugg('/a.ts', 10)]]]),
    );

    healerState.mergeResults([vr('/a.ts', 10, 'ok')]);

    const snap = healerState.snapshot;
    expect(snap.phase).toBe('done');
    expect(snap.results).toHaveLength(2);
    expect(snap.results.find((r) => r.selector.line === 10)?.status).toBe('ok');
    expect(snap.results.find((r) => r.selector.line === 20)?.status).toBe('ok');
  });

  it('drops the suggestion once a selector is no longer broken', () => {
    healerState.setResults(
      [vr('/a.ts', 10, 'broken')],
      new Map([['/a.ts:10', [sugg('/a.ts', 10)]]]),
    );

    healerState.mergeResults([vr('/a.ts', 10, 'ok')]);

    expect(healerState.snapshot.suggestionsByKey.has('/a.ts:10')).toBe(false);
  });

  it('keeps the suggestion when the selector is still broken', () => {
    healerState.setResults(
      [vr('/a.ts', 10, 'broken')],
      new Map([['/a.ts:10', [sugg('/a.ts', 10)]]]),
    );

    healerState.mergeResults([vr('/a.ts', 10, 'broken')]);

    expect(healerState.snapshot.suggestionsByKey.get('/a.ts:10')).toHaveLength(1);
  });

  it('appends an updated result that has no prior match', () => {
    healerState.setResults([vr('/a.ts', 10, 'ok')], new Map());

    healerState.mergeResults([vr('/b.ts', 5, 'broken')]);

    const snap = healerState.snapshot;
    expect(snap.results).toHaveLength(2);
    expect(snap.results.some((r) => r.selector.filePath === '/b.ts')).toBe(true);
  });

  it('fires onDidChange with phase "done"', () => {
    let last: { phase: string } | undefined;
    const sub = healerState.onDidChange((s) => {
      last = s;
    });

    healerState.setResults([vr('/a.ts', 10, 'broken')], new Map());
    healerState.mergeResults([vr('/a.ts', 10, 'ok')]);

    expect(last?.phase).toBe('done');
    sub.dispose();
  });

  it('overlays new explanations and drops them once a selector is ok', () => {
    healerState.setResults(
      [vr('/a.ts', 10, 'broken')],
      new Map([['/a.ts:10', [sugg('/a.ts', 10)]]]),
      new Map([['/a.ts:10', 'text changed']]),
    );
    expect(healerState.snapshot.explanationsById.get('/a.ts:10')).toBe('text changed');

    // Still broken → keep the result, overlay a fresh reason.
    healerState.mergeResults(
      [vr('/a.ts', 10, 'broken')],
      new Map([['/a.ts:10', [sugg('/a.ts', 10)]]]),
      new Map([['/a.ts:10', 'role changed']]),
    );
    expect(healerState.snapshot.explanationsById.get('/a.ts:10')).toBe('role changed');

    // Now ok → the explanation is dropped along with the suggestion.
    healerState.mergeResults([vr('/a.ts', 10, 'ok')]);
    expect(healerState.snapshot.explanationsById.has('/a.ts:10')).toBe(false);
  });
});
