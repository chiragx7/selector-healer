/**
 * Which Playwright selector API surfaced this usage.
 */
export type SelectorType =
  | 'css'
  | 'xpath'
  | 'role'
  | 'testid'
  | 'text'
  | 'label'
  | 'placeholder'
  | 'title'
  | 'alt'
  | 'unknown';

/**
 * A single selector usage discovered by the parser in a Playwright test file.
 *
 * @example
 * {
 *   id: 'a1b2c3d4e5f6',
 *   filePath: '/repo/tests/login.spec.ts',
 *   line: 12,
 *   column: 18,
 *   selectorType: 'testid',
 *   rawValue: 'submit-btn',
 *   contextHint: 'https://staging.app.com/login',
 * }
 */
export interface SelectorUsage {
  /** Stable 12-char hash of `filePath:line:rawValue`. */
  id: string;
  /** Absolute path to the test file. */
  filePath: string;
  /** 1-indexed line of the selector call. */
  line: number;
  /** 1-indexed column of the selector call. */
  column: number;
  /** Which Playwright selector API surfaced this usage. */
  selectorType: SelectorType;
  /** The literal string passed to the selector. */
  rawValue: string;
  /** Options object (e.g. `{ name: 'Submit' }` for `getByRole`). */
  options?: Record<string, unknown>;
  /** URL hinted by a preceding `page.goto()` in the same test block, if any. */
  contextHint?: string;
}

/**
 * Structural snapshot of a DOM element a selector matched at capture time.
 * Stored in `.selector-healer/fingerprints.json` and used by the healer to
 * re-identify the element after the DOM changes.
 */
export interface DomFingerprint {
  selectorId: string;
  /** ISO 8601 timestamp of capture. */
  capturedAt: string;
  tagName: string;
  attributes: Record<string, string>;
  /** Trimmed text content, max 200 chars. */
  textContent: string;
  /** Up to 5 ancestors, root-first. */
  parentChain: Array<{
    tagName: string;
    id?: string;
    classes: string[];
    role?: string;
  }>;
  /** Position among same-tag siblings under the same parent. */
  siblingIndex: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
  /** URL of the page where this element was captured. */
  pageUrl: string;
}

/**
 * Outcome of verifying a single selector against the live DOM.
 *
 * - `ok`: exactly one element matched and structural identity is preserved.
 * - `broken`: zero elements matched.
 * - `multiple-matches`: more than one element matched (ambiguous selector).
 * - `page-load-failed`: the page hosting this selector could not be loaded.
 * - `skipped`: parser flagged the selector as dynamic, or no fingerprint baseline exists yet.
 */
export type VerificationStatus =
  | 'ok'
  | 'broken'
  | 'multiple-matches'
  | 'page-load-failed'
  | 'skipped';

export interface VerificationResult {
  selector: SelectorUsage;
  status: VerificationStatus;
  matchCount: number;
  /** What the selector currently matches, if anything. */
  liveFingerprint?: DomFingerprint;
  /** What the selector used to match, from the stored baseline. */
  storedFingerprint?: DomFingerprint;
  /** Human-readable error message when `status` is `page-load-failed` or `skipped`. */
  error?: string;
}

/**
 * A single ranked replacement candidate for a broken selector.
 */
export interface HealCandidate {
  /** The exact code string to substitute, e.g. `page.getByTestId('submit-btn')`. */
  replacementCode: string;
  /** Confidence in `[0, 1]` — combined across matched scoring rules. */
  confidence: number;
  /** Human-readable explanation of why this candidate scored as it did. */
  reasoning: string;
  matchedFingerprint: DomFingerprint;
}

/**
 * Ranked replacement suggestions for a single broken selector. The healer
 * returns at most three candidates per selector, sorted by `confidence` desc.
 */
export interface HealSuggestion {
  selectorId: string;
  candidates: HealCandidate[];
}

/**
 * User-supplied configuration loaded from `selector-healer.config.ts`.
 *
 * @example
 * export default {
 *   testDir: './tests',
 *   testGlob: '**\/*.spec.ts',
 *   baseUrl: 'https://staging.myapp.com',
 *   browser: 'chromium',
 *   headless: true,
 * } satisfies HealerConfig;
 */
export interface HealerConfig {
  testDir: string;
  testGlob?: string;
  baseUrl: string;
  fallbackRoutes?: string[];
  browser?: 'chromium' | 'firefox' | 'webkit';
  headless?: boolean;
  timeout?: number;
  confidenceThreshold?: {
    autoApply: number;
    suggest: number;
  };
  /**
   * Pre-verification hook for auth, cookies, localStorage, etc.
   * Receives a Playwright `BrowserContext`. Typed as `unknown` here to keep
   * `types.ts` free of a Playwright import; the verifier narrows it.
   */
  globalSetup?: (context: unknown) => Promise<void>;
}
