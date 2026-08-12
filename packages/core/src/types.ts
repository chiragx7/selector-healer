/**
 * Supported test frameworks for selector extraction and heal output.
 */
export type Framework = 'playwright' | 'cypress' | 'webdriverio' | 'testcafe';

/**
 * Which selector API surfaced this usage.
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
  /** Which selector API surfaced this usage. */
  selectorType: SelectorType;
  /** The literal string passed to the selector. */
  rawValue: string;
  /** Options object (e.g. `{ name: 'Submit' }` for `getByRole`). */
  options?: Record<string, unknown>;
  /** URL hinted by a preceding `page.goto()` in the same test block, if any. */
  contextHint?: string;
  /** Which test framework this selector belongs to. Defaults to `'playwright'`. */
  framework?: Framework;
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
  /**
   * Source location of the selector this fingerprint was captured for: `file`
   * is relative to the project root with forward slashes (portable across
   * machines/OSes), `line`/`column` are the 1-indexed call site. Lets the healer
   * recover a *renamed* selector: when the string inside a locator changes, its
   * `selectorId` changes and the direct baseline lookup misses, but the
   * fingerprint captured for the original value still sits at this
   * `file:line:column` (renaming the argument doesn't move the call's start).
   * Optional — absent on baselines captured before this feature, which simply
   * won't be recoverable until re-captured.
   */
  source?: { file: string; line: number; column: number };
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
 * One scoring rule's contribution to a candidate's confidence — the raw
 * material behind "why this percent". Surfaced in the UI as a per-rule breakdown.
 */
export interface RuleScore {
  /** Human name of the rule, e.g. `'data-testid match'`. */
  name: string;
  /** How well this rule matched, in `[0, 1]` (0 = no match, 1 = perfect). */
  quality: number;
  /** Weighted contribution to the raw score: `quality × rule weight`. */
  weighted: number;
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
  /** Per-rule score breakdown behind the confidence (for "explain this %"). */
  ruleScores?: RuleScore[];
  /**
   * When adaptive learning nudged this candidate's confidence, a short note
   * describing the adjustment (e.g. "+6% — you usually accept testid fixes").
   */
  learningNote?: string;
  matchedFingerprint: DomFingerprint;
}

/**
 * A single human-readable reason a selector broke, derived by diffing the
 * stored fingerprint against what the element looks like now.
 */
export interface BreakReason {
  /** Category of change, so the UI can icon and prioritise it. */
  kind:
    | 'removed'
    | 'tag'
    | 'testid'
    | 'id'
    | 'role'
    | 'text'
    | 'attribute'
    | 'moved'
    | 'position'
    | 'renamed';
  /** One-line explanation, e.g. `text changed from "Save changes" to "Update Profile"`. */
  summary: string;
}

/**
 * Ranked replacement suggestions for a single broken selector. The healer
 * returns at most three candidates per selector, sorted by `confidence` desc,
 * plus an `explanation` of what changed (why the selector broke).
 */
export interface HealSuggestion {
  selectorId: string;
  candidates: HealCandidate[];
  /** Why the selector broke — the meaningful diffs between baseline and now. */
  explanation?: BreakReason[];
}

/**
 * Defines a page state to visit during capture/verify. Each page can have
 * a setup hook for authentication, form filling, or other interactions
 * needed to reach the target state.
 *
 * @example
 * {
 *   name: 'Dashboard (after login)',
 *   url: '/dashboard',
 *   setup: async (page) => {
 *     await page.goto('http://localhost:3456/');
 *     await page.getByLabel('Email').fill('user@example.com');
 *     await page.getByLabel('Password').fill('password123');
 *     await page.getByRole('button', { name: 'Log in' }).click();
 *     await page.waitForURL('** /dashboard');
 *   },
 * }
 */
export interface PageConfig {
  /** URL path (resolved against baseUrl) or full URL. Used to match selectors by contextHint. */
  url: string;
  /** Human-readable name for CLI output. */
  name?: string;
  /**
   * Setup script that runs on a fresh Playwright Page instance.
   * Must navigate to the target URL or perform interactions that reach the page state.
   * If omitted, the page navigates directly to `url`.
   * Typed as `unknown` to keep types.ts free of a Playwright import; narrowed at runtime.
   *
   * @param page - Playwright Page instance
   */
  setup?: (page: unknown) => Promise<void>;
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
  /** Test framework to use for parsing and heal output. Auto-detected if omitted. */
  framework?: Framework;
  browser?: 'chromium' | 'firefox' | 'webkit';
  headless?: boolean;
  timeout?: number;
  confidenceThreshold?: {
    autoApply: number;
    suggest: number;
  };
  /**
   * Adaptive learning from your Apply/Skip choices — gently biases suggestion
   * confidence toward the selector kinds you actually accept.
   */
  learning?: {
    /** Learn from Apply/Skip and nudge confidence. Default `true`. */
    enabled?: boolean;
    /**
     * Where feedback is stored: `'committed'` writes `.selector-healer/feedback.json`
     * (team-shared, travels with the repo); `'local'` keeps it per-developer in the
     * editor's workspace storage. Default `'committed'`.
     */
    store?: 'committed' | 'local';
  };
  /**
   * Pre-verification hook for auth, cookies, localStorage, etc.
   * Receives a Playwright `BrowserContext`. Typed as `unknown` here to keep
   * `types.ts` free of a Playwright import; the verifier narrows it.
   */
  globalSetup?: (context: unknown) => Promise<void>;
  /**
   * Pages to visit during capture/verify. Each page can have a setup hook
   * for auth, navigation, or interactions needed to reach the target state.
   * Selectors are tried on all pages; uncaptured selectors from the default
   * page are retried on configured pages.
   */
  pages?: PageConfig[];
}
