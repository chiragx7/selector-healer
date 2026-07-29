/**
 * Pure helpers backing watch mode (auto re-verify on save). Kept free of the
 * `vscode` API so the path-matching and debounce timing are unit-testable.
 */

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
