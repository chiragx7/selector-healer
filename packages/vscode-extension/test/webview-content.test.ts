import type { VerificationResult } from '@selector-healer/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { serialize } = await import('../src/webview-content.js');
type StoredSuggestion = import('../src/code-actions.js').StoredSuggestion;
type HealerSnapshot = import('../src/state.js').HealerSnapshot;

const SEL = {
  id: 's1',
  filePath: '/p/login.spec.ts',
  line: 16,
  column: 11,
  selectorType: 'label' as const,
  rawValue: 'Email',
};

function cand(code: string, confidence: number, reasoning?: string): StoredSuggestion {
  return {
    selectorId: 's1',
    filePath: '/p/login.spec.ts',
    line: 16,
    column: 11,
    rawValue: 'Email',
    replacementCode: code,
    confidence,
    reasoning,
  };
}

function snapshotWith(candidates: StoredSuggestion[]): HealerSnapshot {
  const results: VerificationResult[] = [{ selector: SEL, status: 'broken', matchCount: 0 }];
  return {
    phase: 'done',
    results,
    suggestionsByKey: new Map([[`${SEL.filePath}:${SEL.line}`, candidates]]),
    explanationsById: new Map(),
    lastRunAt: 1,
  };
}

describe('serialize — heal candidates', () => {
  it('surfaces the top suggestion and the runner-ups as alternatives', () => {
    const { items } = serialize(
      snapshotWith([
        cand("page.getByTestId('email-input')", 0.88, 'testid match'),
        cand("page.getByLabel('E-mail')", 0.64, 'aria-label close'),
        cand("page.locator('#email')", 0.41, 'id only'),
      ]),
    );
    const item = items[0];
    expect(item?.suggestion).toEqual({ code: "page.getByTestId('email-input')", pct: 88 });
    expect(item?.alternatives).toEqual([
      { code: "page.getByLabel('E-mail')", pct: 64, reasoning: 'aria-label close' },
      { code: "page.locator('#email')", pct: 41, reasoning: 'id only' },
    ]);
  });

  it('leaves alternatives undefined when there is only one candidate', () => {
    const { items } = serialize(snapshotWith([cand("page.getByTestId('x')", 0.9)]));
    expect(items[0]?.suggestion?.pct).toBe(90);
    expect(items[0]?.alternatives).toBeUndefined();
  });

  it('has no suggestion or alternatives for a selector with no candidates', () => {
    const snap = snapshotWith([]);
    // an ok selector with an empty candidate list
    snap.results = [{ selector: SEL, status: 'ok', matchCount: 1 }];
    snap.suggestionsByKey = new Map();
    const { items } = serialize(snap);
    expect(items[0]?.suggestion).toBeUndefined();
    expect(items[0]?.alternatives).toBeUndefined();
  });
});
