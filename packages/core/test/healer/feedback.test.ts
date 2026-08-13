import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type SelectorFeedback,
  adjustConfidence,
  classifyReplacementType,
  emptyFeedback,
  getFeedbackPath,
  loadFeedback,
  recordOutcome,
  saveFeedback,
} from '../../src/healer/feedback.js';

describe('classifyReplacementType', () => {
  it.each([
    ["page.getByTestId('save')", 'testid'],
    ['cy.get(\'[data-testid="save"]\')', 'testid'],
    ["page.getByRole('button', { name: 'Save' })", 'role'],
    ["page.getByLabel('Email')", 'label'],
    ["page.getByPlaceholder('Search')", 'placeholder'],
    ["page.getByAltText('Logo')", 'alt'],
    ["page.getByTitle('Close')", 'title'],
    ["page.getByText('Sign in')", 'text'],
    ["page.locator('.btn-primary')", 'css'],
    ["page.locator('//button[1]')", 'xpath'],
    ['page.locator(\'xpath=//div[@id="x"]\')', 'xpath'],
    // A CSS locator carrying a URL must NOT be misread as XPath (the `//` trap).
    ['page.locator(\'a[href="https://example.com/x"]\')', 'css'],
    // A real Playwright text pseudo is 'text'…
    ['page.locator(\'button:has-text("Save")\')', 'text'],
    // …including the exact- and regex-match variants (a `:text(`-only check drops these).
    ['page.locator(\':text-is("Save")\')', 'text'],
    ['page.locator(\':text-matches("Sa.e")\')', 'text'],
    // …but a class that merely contains "has-text" is not (the loose-match trap).
    ["page.locator('.has-text-widget')", 'css'],
    // A role NAME containing "data-qa" must stay 'role', not miskey as testid.
    ["page.getByRole('button', { name: 'Configure data-qa settings' })", 'role'],
    // …even the bracketed form inside a name (getBy* method wins over any substring).
    ["page.getByRole('button', { name: 'Edit [data-test] mapping' })", 'role'],
  ])('classifies %s as %s', (code, expected) => {
    expect(classifyReplacementType(code)).toBe(expected);
  });
});

describe('recordOutcome', () => {
  it('increments the right tally without mutating the input', () => {
    const fb = emptyFeedback();
    const next = recordOutcome(fb, 'testid', 'accepted');
    expect(next.byType.testid).toEqual({ accepted: 1, rejected: 0 });
    expect(fb.byType.testid).toBeUndefined(); // original untouched
    const after = recordOutcome(next, 'testid', 'rejected');
    expect(after.byType.testid).toEqual({ accepted: 1, rejected: 1 });
  });
});

describe('adjustConfidence', () => {
  const fbWith = (
    type: 'testid' | 'text',
    accepted: number,
    rejected: number,
  ): SelectorFeedback => ({
    version: 1,
    byType: { [type]: { accepted, rejected } },
  });

  it('is neutral with no data or below the signal threshold', () => {
    expect(adjustConfidence(0.6, 'testid', emptyFeedback())).toEqual({ confidence: 0.6 });
    // 2 signals < MIN_SIGNALS(3) → neutral
    expect(adjustConfidence(0.6, 'testid', fbWith('testid', 1, 1))).toEqual({ confidence: 0.6 });
  });

  it('is neutral for a balanced record (rate ≈ 0.5)', () => {
    expect(adjustConfidence(0.6, 'testid', fbWith('testid', 2, 2))).toEqual({ confidence: 0.6 });
  });

  it('boosts a well-accepted kind, with an explanatory note', () => {
    const out = adjustConfidence(0.6, 'testid', fbWith('testid', 9, 1));
    expect(out.confidence).toBeGreaterThan(0.6);
    expect(out.note).toMatch(/^\+\d+% - you usually accept testid fixes \(9\/10\)/);
  });

  it('penalises a frequently-skipped kind', () => {
    const out = adjustConfidence(0.6, 'text', fbWith('text', 0, 4));
    expect(out.confidence).toBeLessThan(0.6);
    expect(out.note).toMatch(/^-\d+% - you usually skip text fixes/);
  });

  it('caps the nudge at about ±0.1 and clamps to [0,1]', () => {
    const big = adjustConfidence(0.6, 'testid', fbWith('testid', 1000, 0));
    expect(big.confidence).toBeLessThanOrEqual(0.6 + 0.1 + 1e-9);
    expect(adjustConfidence(0.97, 'testid', fbWith('testid', 1000, 0)).confidence).toBe(1);
    expect(adjustConfidence(0.03, 'text', fbWith('text', 0, 1000)).confidence).toBe(0);
  });
});

describe('loadFeedback / saveFeedback', () => {
  let root: string;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  it('returns empty feedback when the file is missing', () => {
    root = mkdtempSync(join(tmpdir(), 'sh-fb-'));
    expect(loadFeedback(root)._unsafeUnwrap()).toEqual(emptyFeedback());
  });

  it('round-trips a record and writes sorted, review-friendly JSON', () => {
    root = mkdtempSync(join(tmpdir(), 'sh-fb-'));
    let fb = recordOutcome(emptyFeedback(), 'role', 'accepted');
    fb = recordOutcome(fb, 'testid', 'accepted');
    saveFeedback(root, fb)._unsafeUnwrap();

    const loaded = loadFeedback(root)._unsafeUnwrap();
    expect(loaded.byType.testid).toEqual({ accepted: 1, rejected: 0 });
    expect(loaded.byType.role).toEqual({ accepted: 1, rejected: 0 });

    // keys sorted (role before testid) for a stable diff
    const text = readFileSync(getFeedbackPath(root), 'utf8');
    expect(text.indexOf('"role"')).toBeLessThan(text.indexOf('"testid"'));
  });

  it('sanitizes corrupted/hand-edited counts (no NaN, no negatives)', () => {
    root = mkdtempSync(join(tmpdir(), 'sh-fb-'));
    mkdirSync(join(root, '.selector-healer'), { recursive: true });
    writeFileSync(
      getFeedbackPath(root),
      JSON.stringify({
        version: 1,
        byType: {
          testid: { accepted: 'x', rejected: -3 }, // both invalid → 0/0
          role: { accepted: 2.9, rejected: 1 }, // 2.9 floored to 2
        },
      }),
      'utf8',
    );
    const fb = loadFeedback(root)._unsafeUnwrap();
    expect(fb.byType.testid).toEqual({ accepted: 0, rejected: 0 });
    expect(fb.byType.role).toEqual({ accepted: 2, rejected: 1 });
    // and it must not produce a NaN adjustment
    expect(Number.isNaN(adjustConfidence(0.6, 'role', fb).confidence)).toBe(false);
  });
});
