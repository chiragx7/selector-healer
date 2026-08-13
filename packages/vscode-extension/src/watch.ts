/**
 * Pure helpers backing watch mode (auto re-verify on save). Kept free of the
 * `vscode` API so the path-matching and debounce timing are unit-testable.
 */

import type { SelectorUsage } from '@selector-healer/core';

const TEST_FILE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Normalise a path for comparison: forward slashes, no trailing slash, lower-case. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether a saved file should trigger a watch re-verify: a JS/TS source file
 * located inside the configured test directory. Case- and separator-insensitive
 * so it behaves the same on Windows and POSIX.
 *
 * @param filePath - absolute path of the saved file
 * @param testDir - absolute path of the configured test directory
 * @returns true if the file is a test source under `testDir`
 *
 * @example
 * isTestFilePath('C:/app/tests/login.spec.ts', 'C:/app/tests'); // true
 */
export function isTestFilePath(filePath: string, testDir: string): boolean {
  if (!TEST_FILE_EXT.test(filePath)) return false;
  const f = norm(filePath);
  const d = norm(testDir);
  return f === d || f.startsWith(`${d}/`);
}

/**
 * A signature capturing everything about a selector usage that affects what it
 * matches. The core `id` only hashes `file:line:rawValue`, so for `getByRole`
 * (whose accessible name lives in `options`, not `rawValue`) editing just the
 * name - `{ name: 'Sign up' }` → `{ name: 'Sign down' }` - leaves the id
 * unchanged. Appending `selectorType` + `options` makes such edits visible to
 * change-detection, which would otherwise conclude "nothing changed".
 *
 * @param s - the selector usage to fingerprint
 * @returns a stable string that differs whenever the selector's match target does
 *
 * @example
 * selectorSignature({ id: 'x', selectorType: 'role', options: { name: 'Sign up' }, ... });
 */
export function selectorSignature(s: SelectorUsage): string {
  return `${s.id}|${s.selectorType}|${JSON.stringify(s.options ?? {})}`;
}

/**
 * The selectors the user actually edited since the last run: those whose
 * {@link selectorSignature} at a given `file:line` differs from before (or are
 * new). Lets watch re-verify only what changed and keep every untouched
 * selector's existing result - so it never re-checks (or wrongly flags)
 * auth-/interaction-gated selectors that weren't touched.
 *
 * @param prior - selectors from the last verified snapshot
 * @param current - selectors freshly parsed from the saved file(s)
 * @returns the subset of `current` whose signature changed (or is new)
 *
 * @example
 * const changed = selectorsChangedSince(snapshot.map((r) => r.selector), parsed);
 */
export function selectorsChangedSince(
  prior: readonly SelectorUsage[],
  current: readonly SelectorUsage[],
): SelectorUsage[] {
  const priorSig = new Map<string, string>();
  for (const s of prior) priorSig.set(`${s.filePath}:${s.line}`, selectorSignature(s));
  return current.filter((s) => priorSig.get(`${s.filePath}:${s.line}`) !== selectorSignature(s));
}

/**
 * Trailing-edge debouncer: collapses a burst of calls into a single deferred
 * run, resetting the timer on each `schedule`. Used so a flurry of saves
 * triggers just one re-verify.
 *
 * @example
 * const d = new Debouncer(700);
 * d.schedule(() => runVerify()); // fires 700ms after the last schedule()
 */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly delayMs: number) {}

  /** (Re)start the timer; only the final scheduled callback runs. */
  schedule(fn: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      fn();
    }, this.delayMs);
  }

  /** Cancel any pending run. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
