import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type Result, err, ok } from 'neverthrow';
import type { StoreError } from '../fingerprint/store.js';
import type { SelectorType } from '../types.js';

/**
 * Accept/reject tallies the healer has observed per selector kind. An "accept"
 * is applying a suggested fix; a "reject" is skipping one. Used to gently bias
 * future confidence toward the kinds of fixes the user actually takes.
 */
export interface SelectorFeedback {
  version: number;
  byType: Partial<Record<SelectorType, { accepted: number; rejected: number }>>;
}

/** Outcome of the user acting on a suggested fix. */
export type FeedbackOutcome = 'accepted' | 'rejected';

/** A confidence adjusted by learned history, with a human-readable reason. */
export interface AdjustedConfidence {
  confidence: number;
  /** Present only when a nudge was applied - describes it for "Why NN%?". */
  note?: string;
}

export const FEEDBACK_VERSION = 1;

// Learning is deliberately gentle - it tips close calls, never overrides a clear
// structural match.
/** Min accept+reject signals for a kind before its history is trusted. */
const MIN_SIGNALS = 3;
/** Scales the acceptance-rate deviation into a confidence shift; ±0.1 at most. */
const LEARN_STRENGTH = 0.2;

/** An empty feedback record (no learning yet). */
export function emptyFeedback(): SelectorFeedback {
  return { version: FEEDBACK_VERSION, byType: {} };
}

/**
 * Classify the selector kind a generated replacement uses, so accept/reject
 * signals are tallied per kind. Recognises the locator forms the healer emits
 * across Playwright/Cypress/WebdriverIO; falls back to `'css'` for raw locators.
 *
 * @param code - a replacement locator, e.g. `page.getByTestId('save')`
 * @returns the selector kind the code targets
 *
 * @example
 * classifyReplacementType("page.getByRole('button', { name: 'Save' })"); // 'role'
 */
export function classifyReplacementType(code: string): SelectorType {
  const c = code;
  // 1) getBy* methods are definitive - check them first, so a substring inside an
  //    accessible-name argument (e.g. name: 'Edit [data-test] mapping') can't win.
  if (c.includes('getByTestId')) return 'testid';
  if (c.includes('getByRole')) return 'role';
  if (c.includes('getByLabel')) return 'label';
  if (c.includes('getByPlaceholder')) return 'placeholder';
  if (c.includes('getByAltText')) return 'alt';
  if (c.includes('getByTitle')) return 'title';
  if (c.includes('getByText')) return 'text';
  // 2) Raw locators (locator(), cy.get(), $()): classify by the selector form.
  if (c.includes('[data-test') || c.includes('[data-qa') || c.includes('[data-cy')) return 'testid';
  if (c.includes('[role=')) return 'role';
  if (c.includes('[placeholder=')) return 'placeholder';
  if (c.includes('[alt=')) return 'alt';
  if (c.includes('[title=')) return 'title';
  // All four Playwright text pseudos - `:text(` alone would miss `:text-is(` and
  // `:text-matches(`, dropping them to 'css' (wrong learning bucket).
  if (
    c.includes(':has-text(') ||
    c.includes(':text(') ||
    c.includes(':text-is(') ||
    c.includes(':text-matches(')
  )
    return 'text';
  // XPath only via `xpath=` or a locator argument starting with `//`/`(//` - a bare
  // `//` check would misread a CSS locator carrying a URL (`href="https://…"`).
  if (
    c.includes('xpath=') ||
    c.includes("('//") ||
    c.includes('("//') ||
    c.includes("('(//") ||
    c.includes('("(//')
  )
    return 'xpath';
  return 'css';
}

/**
 * Record one accept/reject outcome for a selector kind, returning a **new**
 * record (never mutates the input).
 *
 * @param fb - the current feedback
 * @param type - the selector kind the applied/skipped fix used
 * @param outcome - `'accepted'` when the fix was applied, `'rejected'` when skipped
 * @returns a new feedback record with the tally incremented
 *
 * @example
 * recordOutcome(emptyFeedback(), 'testid', 'accepted');
 */
export function recordOutcome(
  fb: SelectorFeedback,
  type: SelectorType,
  outcome: FeedbackOutcome,
): SelectorFeedback {
  const prev = fb.byType[type] ?? { accepted: 0, rejected: 0 };
  const next = {
    accepted: prev.accepted + (outcome === 'accepted' ? 1 : 0),
    rejected: prev.rejected + (outcome === 'rejected' ? 1 : 0),
  };
  return { version: FEEDBACK_VERSION, byType: { ...fb.byType, [type]: next } };
}

/**
 * Nudge a candidate's confidence by the accept/reject history for its selector
 * kind. Bounded to about ±0.1 and only applied once a kind has at least
 * {@link MIN_SIGNALS} signals, with Laplace smoothing - so learning tips close
 * calls without a couple of data points swinging suggestions.
 *
 * @param base - the deterministic score in `[0, 1]`
 * @param type - the candidate's selector kind (see {@link classifyReplacementType})
 * @param fb - the learned feedback
 * @returns the (possibly) adjusted confidence and, when nudged, an explanatory note
 *
 * @example
 * adjustConfidence(0.6, 'testid', fb); // { confidence: 0.66, note: "+6% - you usually accept testid fixes (9/10)" }
 */
export function adjustConfidence(
  base: number,
  type: SelectorType,
  fb: SelectorFeedback,
): AdjustedConfidence {
  const t = fb.byType[type];
  if (!t) return { confidence: base };
  const total = t.accepted + t.rejected;
  if (total < MIN_SIGNALS) return { confidence: base };

  // Laplace-smoothed acceptance rate in (0, 1); 0.5 = neutral.
  const rate = (t.accepted + 1) / (total + 2);
  const shift = (rate - 0.5) * LEARN_STRENGTH; // ∈ [-0.1, +0.1]
  const pct = Math.round(shift * 100);
  if (pct === 0) return { confidence: base };

  const confidence = Math.min(1, Math.max(0, base + shift));
  const share = `${t.accepted}/${total}`;
  const note =
    shift > 0
      ? `+${pct}% - you usually accept ${type} fixes (${share})`
      : `${pct}% - you usually skip ${type} fixes (accepted ${share})`;
  return { confidence, note };
}

// ── Committed-file store (`.selector-healer/feedback.json`) ─────────────────
// Used when `learning.store` is `'committed'`; the extension may instead keep
// feedback in its own workspace storage for the `'local'` option.

const STORE_DIR = '.selector-healer';
const STORE_FILE = 'feedback.json';

/** Absolute path of the committed feedback file for a project. */
export function getFeedbackPath(projectRoot: string): string {
  return join(resolve(projectRoot), STORE_DIR, STORE_FILE);
}

/** Coerce an untrusted value to a finite, non-negative integer count (else 0). */
function toCount(x: unknown): number {
  const n = Math.floor(Number(x));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Load learned feedback from `.selector-healer/feedback.json`. A missing file is
 * not an error - it returns {@link emptyFeedback}.
 *
 * @param projectRoot - absolute project root
 * @returns the feedback record, or a read error
 *
 * @example
 * const fb = loadFeedback(root).unwrapOr(emptyFeedback());
 */
export function loadFeedback(projectRoot: string): Result<SelectorFeedback, StoreError> {
  const path = getFeedbackPath(projectRoot);
  if (!existsSync(path)) return ok(emptyFeedback());
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<SelectorFeedback>;
    if (!data || typeof data !== 'object' || typeof data.byType !== 'object' || !data.byType) {
      return err({ type: 'read-error', message: `Malformed feedback in ${path}` });
    }
    // Sanitize untrusted counts (the file is committed and may be hand- or
    // merge-edited) so a bad value can't leak NaN/negatives into scoring.
    const byType: SelectorFeedback['byType'] = {};
    for (const [key, val] of Object.entries(data.byType)) {
      const v = val as { accepted?: unknown; rejected?: unknown };
      byType[key as SelectorType] = {
        accepted: toCount(v.accepted),
        rejected: toCount(v.rejected),
      };
    }
    return ok({ version: FEEDBACK_VERSION, byType });
  } catch (e) {
    return err({
      type: 'read-error',
      message: `Failed to read ${path}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/**
 * Persist learned feedback to `.selector-healer/feedback.json`, with type keys
 * sorted for a stable, review-friendly diff.
 *
 * @param projectRoot - absolute project root
 * @param fb - the feedback to write
 * @returns the written path, or a write error
 *
 * @example
 * saveFeedback(root, recordOutcome(fb, 'testid', 'accepted'));
 */
export function saveFeedback(
  projectRoot: string,
  fb: SelectorFeedback,
): Result<string, StoreError> {
  const path = getFeedbackPath(projectRoot);
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const byType = Object.fromEntries(
      Object.entries(fb.byType).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(
      path,
      `${JSON.stringify({ version: FEEDBACK_VERSION, byType }, null, 2)}\n`,
      'utf8',
    );
    return ok(path);
  } catch (e) {
    return err({
      type: 'write-error',
      message: `Failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
