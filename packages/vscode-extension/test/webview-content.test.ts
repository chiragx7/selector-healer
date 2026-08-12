import type { VerificationResult } from '@selector-healer/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { serialize, activeResults, buildWebviewHtml } = await import('../src/webview-content.js');
const { selectorSignature } = await import('../src/watch.js');
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

function cand(
  code: string,
  confidence: number,
  reasoning?: string,
  ruleScores?: StoredSuggestion['ruleScores'],
): StoredSuggestion {
  return {
    selectorId: 's1',
    filePath: '/p/login.spec.ts',
    line: 16,
    column: 11,
    rawValue: 'Email',
    replacementCode: code,
    confidence,
    reasoning,
    ruleScores,
  };
}

function snapshotWith(
  candidates: StoredSuggestion[],
  extra: Partial<HealerSnapshot> = {},
): HealerSnapshot {
  const results: VerificationResult[] = [{ selector: SEL, status: 'broken', matchCount: 0 }];
  return {
    phase: 'done',
    results,
    suggestionsByKey: new Map([[`${SEL.filePath}:${SEL.line}`, candidates]]),
    explanationsById: new Map(),
    dismissedSignatures: new Set(),
    lastRunAt: 1,
    ...extra,
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

describe('serialize — confidence breakdown', () => {
  it('builds the top suggestion breakdown from ruleScores, biggest first, quality>0 only', () => {
    const top = cand("page.getByTestId('x')", 0.88, undefined, [
      { name: 'text similarity', quality: 0.8, weighted: 0.08 },
      { name: 'data-testid match', quality: 1, weighted: 0.3 },
      { name: 'class overlap', quality: 0, weighted: 0 }, // dropped (didn't fire)
    ]);
    const { items } = serialize(snapshotWith([top]));
    expect(items[0]?.suggestion?.breakdown).toEqual([
      { name: 'data-testid match', pct: 100 }, // highest weighted contribution first
      { name: 'text similarity', pct: 80 },
    ]);
  });

  it('leaves breakdown undefined when the candidate has no ruleScores', () => {
    const { items } = serialize(snapshotWith([cand("page.getByTestId('x')", 0.9)]));
    expect(items[0]?.suggestion?.pct).toBe(90);
    expect(items[0]?.suggestion?.breakdown).toBeUndefined();
  });
});

describe('serialize — dismissed (Skip)', () => {
  const sig = selectorSignature(SEL);

  it('moves a dismissed broken selector out of items + counts into the dismissed list', () => {
    const out = serialize(
      snapshotWith([cand("page.getByTestId('x')", 0.9)], { dismissedSignatures: new Set([sig]) }),
    );
    expect(out.items).toHaveLength(0);
    expect(out.dismissed).toHaveLength(1);
    expect(out.dismissed[0]?.status).toBe('broken');
    expect(out.counts.broken).toBe(0);
    expect(out.counts.total).toBe(0);
  });

  it('keeps the selector active when its signature is not dismissed', () => {
    const out = serialize(snapshotWith([cand("page.getByTestId('x')", 0.9)]));
    expect(out.items).toHaveLength(1);
    expect(out.dismissed).toHaveLength(0);
  });

  it('never hides an ok selector, even if its signature is dismissed', () => {
    const snap = snapshotWith([], { dismissedSignatures: new Set([sig]) });
    snap.results = [{ selector: SEL, status: 'ok', matchCount: 1 }];
    const out = serialize(snap);
    expect(out.items).toHaveLength(1);
    expect(out.dismissed).toHaveLength(0);
  });
});

describe('buildWebviewHtml — client script integrity', () => {
  const html = buildWebviewHtml('vscode-webview://x', 'panel');
  const script = html.slice(html.indexOf('<script'), html.lastIndexOf('</script>'));
  // Inner JS only (strip the `<script nonce=…>` opening tag) for the parse check.
  const scriptBody = script.slice(script.indexOf('>') + 1);

  // tsc never parses this string; the build no longer emits it as a file to
  // `node --check`. Compile it here (without running) so a syntax error in the
  // client JS fails CI instead of only surfacing on a live F5.
  it('is syntactically valid JavaScript', () => {
    expect(() => new Function(scriptBody)).not.toThrow();
  });

  // The client script is one big string, so tsc/unit tests never parse it. A
  // duplicate `function foo(){}` silently shadows the earlier one at runtime —
  // exactly the bug where the Overview's `card()` collided with the result-card
  // `card()` and rendered "undefined:undefined". Guard against the whole class.
  it('declares no duplicate top-level function names', () => {
    const counts = new Map<string, number>();
    for (const m of script.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
    expect(dupes).toEqual([]);
  });

  it('embeds the overview render entrypoints', () => {
    expect(script).toContain('function renderOverview(');
    expect(script).toContain('function ovCard(');
    expect(script).toContain('function switchTab(');
  });
});

describe('activeResults — what Heal-All and the status bar count', () => {
  const sig = selectorSignature(SEL);

  it('drops a dismissed broken selector (so Heal-All + status bar ignore it)', () => {
    const snap = snapshotWith([], { dismissedSignatures: new Set([sig]) });
    expect(activeResults(snap)).toHaveLength(0);
  });

  it('keeps a dismissed selector that is currently ok (dismissal only hides attention states)', () => {
    const snap = snapshotWith([], { dismissedSignatures: new Set([sig]) });
    snap.results = [{ selector: SEL, status: 'ok', matchCount: 1 }];
    expect(activeResults(snap)).toHaveLength(1);
  });

  it('keeps everything when nothing is dismissed', () => {
    expect(activeResults(snapshotWith([]))).toHaveLength(1);
  });
});
