import type { Browser, BrowserContext, Page } from 'playwright';
import { findOrphanBaseline } from '../fingerprint/source-match.js';
import { loadFingerprints } from '../fingerprint/store.js';
import { logger } from '../logger.js';
import { launchBrowser, loadPlaywright } from '../playwright-loader.js';
import type {
  BreakReason,
  DomFingerprint,
  Framework,
  HealCandidate,
  HealSuggestion,
  HealerConfig,
  SelectorUsage,
  VerificationResult,
} from '../types.js';
import { scanCandidates } from './candidates.js';
import { explainBreak } from './explain.js';
import {
  type SelectorFeedback,
  adjustConfidence,
  classifyReplacementType,
  emptyFeedback,
  loadFeedback,
} from './feedback.js';
import { generateReplacementCode, renderSelectorCode } from './replacement-code.js';
import { scoreCandidate } from './scoring.js';

export interface HealOptions {
  config: HealerConfig;
  projectRoot: string;
  /**
   * Resolved URLs of configured pages whose setup hook already failed during
   * verification. Heal skips them so the same failing hook isn't re-run (and
   * re-timed-out) — a meaningful speedup on the broken-auth path.
   */
  unreachablePages?: Set<string>;
  /**
   * A pre-opened browser context to reuse (the extension's warm watch session).
   * When provided, heal uses it and does **not** launch/close a browser or re-run
   * `globalSetup`. When omitted, a fresh browser is launched and closed per call.
   */
  context?: BrowserContext;
  /**
   * Learned accept/reject feedback used to nudge candidate confidence. When
   * omitted, heal loads the committed `.selector-healer/feedback.json` (unless
   * `config.learning` disables it or selects the `'local'` store, which lives in
   * the editor — the extension passes it in explicitly).
   */
  feedback?: SelectorFeedback;
}

const MAX_CANDIDATES = 3;
const MIN_SUGGEST_CONFIDENCE = 0.2;
/**
 * Max confidence an alternative may trail the top suggestion by and still be
 * shown. A clear winner (e.g. 0.90) hides its weak structural look-alikes
 * (~0.50), which are only similar in tag/class/position, not in what they are.
 */
const MAX_ALTERNATIVE_GAP = 0.3;

/**
 * Trim a confidence-sorted candidate list to the best one plus only the
 * alternatives that are genuinely competitive with it — those within
 * {@link MAX_ALTERNATIVE_GAP} of the top. When there's a runaway winner the weak
 * look-alikes are dropped (so "other matches" isn't noise); when the top itself
 * is uncertain, its close alternatives are all retained so the user has options.
 *
 * @param sorted - candidates already sorted by confidence, highest first
 * @returns the top candidate plus competitive alternatives, order preserved
 *
 * @example
 * keepCompetitiveCandidates([{ confidence: 0.9 }, { confidence: 0.5 }] as HealCandidate[]);
 * // → [{ confidence: 0.9 }]  (the 0.5 look-alike is 0.4 behind, so it's dropped)
 */
export function keepCompetitiveCandidates(sorted: HealCandidate[]): HealCandidate[] {
  const top = sorted[0];
  if (!top) return sorted;
  // Epsilon so a candidate exactly at the gap (e.g. 0.9 vs 0.6, where float math
  // yields 0.30000000000000004) counts as within it rather than being dropped.
  return sorted.filter(
    (c, i) => i === 0 || top.confidence - c.confidence <= MAX_ALTERNATIVE_GAP + 1e-9,
  );
}

/**
 * Generate replacement suggestions for broken selectors by scanning the live
 * DOM for elements matching stored fingerprints.
 *
 * Candidates are accumulated across every page scanned — the selector's parsed
 * `contextHint` page first, then the configured `pages` (auth/interaction
 * states) — and the globally highest-scoring matches win. This ensures a weak
 * match on the parsed page can't hide the real element living behind login.
 *
 * @param brokenResults - Verification results with `status: 'broken'`.
 * @param options - Healer configuration and project root path.
 * @returns One `HealSuggestion` per broken selector, each with up to 3 ranked candidates.
 *
 * @example
 * ```ts
 * const broken = verificationResults.filter(r => r.status === 'broken');
 * const suggestions = await healSelectors(broken, { config, projectRoot });
 * ```
 */
export async function healSelectors(
  brokenResults: VerificationResult[],
  options: HealOptions,
): Promise<HealSuggestion[]> {
  const { config, projectRoot } = options;

  const storeResult = loadFingerprints(projectRoot);
  if (storeResult.isErr()) {
    logger.error({ error: storeResult.error }, 'Failed to load fingerprints for healing');
    return [];
  }

  const fingerprints = storeResult.value;
  const toHeal = brokenResults.filter((r) => r.status === 'broken');
  if (toHeal.length === 0) return [];

  // Resolve learned feedback. Honor `enabled: false` first — a disabled setting
  // must win even if the caller passed feedback in. Otherwise an explicit
  // override wins (the extension's 'local' store), else load the committed file
  // ('local' has nothing to load here — it lives in the editor).
  const learningOn = config.learning?.enabled !== false;
  const feedback: SelectorFeedback = !learningOn
    ? emptyFeedback()
    : (options.feedback ??
      (config.learning?.store === 'local'
        ? emptyFeedback()
        : loadFeedback(projectRoot).unwrapOr(emptyFeedback())));

  const storedById = new Map<string, DomFingerprint>();
  for (const result of toHeal) {
    // Prefer the baseline verify already attached, then a direct lookup, then —
    // for a renamed selector with no baseline of its own — the baseline captured
    // for the previous value at this same line (see findOrphanBaseline).
    const stored =
      result.storedFingerprint ??
      fingerprints.get(result.selector.id) ??
      findOrphanBaseline(fingerprints, result.selector, projectRoot);
    if (stored) storedById.set(result.selector.id, stored);
  }

  // Reuse a caller-provided context (warm watch session) when given; otherwise
  // launch a fresh browser for this run and close it at the end.
  const ownsBrowser = options.context === undefined;
  let browser: Browser | undefined;
  let context: BrowserContext;
  if (options.context) {
    context = options.context;
  } else {
    const pw = await loadPlaywright(projectRoot);
    browser = await launchBrowser(pw, config);
    context = await browser.newContext();
    if (config.globalSetup) {
      await config.globalSetup(context);
    }
  }

  // selectorId -> every scored candidate found for it, across all pages scanned.
  const candidatesById = new Map<string, HealCandidate[]>();

  const scanPage = async (
    target: string,
    results: VerificationResult[],
    setup?: (page: unknown) => Promise<void>,
  ): Promise<void> => {
    let page: Page;
    try {
      page = await context.newPage();
      if (setup) {
        // Bound setup actions to the configured budget (Playwright defaults to 30s).
        page.setDefaultTimeout(config.timeout ?? 30_000);
        await setup(page);
      } else {
        await page.goto(target, {
          timeout: config.timeout ?? 30_000,
          waitUntil: 'domcontentloaded',
        });
      }
      // SPA settle: candidate scanning reads the DOM, so let client-rendered
      // apps finish rendering before we look for replacements. Non-fatal.
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    } catch (e) {
      logger.warn({ url: target, error: String(e) }, 'Page load failed during healing');
      return;
    }

    const currentUrl = page.url();
    for (const result of results) {
      const stored = storedById.get(result.selector.id);
      if (!stored) continue;
      try {
        const found = await collectScoredCandidates(
          page,
          result.selector,
          stored,
          currentUrl,
          config,
          feedback,
        );
        if (found.length > 0) {
          const list = candidatesById.get(result.selector.id) ?? [];
          list.push(...found);
          candidatesById.set(result.selector.id, list);
        }
      } catch (e) {
        logger.warn(
          { selectorId: result.selector.id, error: String(e) },
          'Healing failed for selector',
        );
      }
    }

    await page.close();
  };

  // Phase 1: each selector's contextHint page (or baseUrl).
  for (const [url, group] of groupByUrl(toHeal, config)) {
    await scanPage(url, group);
  }

  // Phase 2: configured pages (auth, interactions). Retry any selector that
  // doesn't yet have a confident candidate — its element may live behind login.
  if (config.pages && config.pages.length > 0) {
    const autoApply = config.confidenceThreshold?.autoApply ?? 0.8;
    for (const pageConfig of config.pages) {
      const remaining = toHeal.filter(
        (r) => bestConfidence(candidatesById.get(r.selector.id)) < autoApply,
      );
      if (remaining.length === 0) break;

      const resolved = resolveConfigPageUrl(pageConfig.url, config);
      // Skip pages whose setup already failed during verify — no point re-running
      // (and re-timing-out) the same broken hook.
      if (options.unreachablePages?.has(normalizeUrl(resolved))) {
        logger.info(
          { page: pageConfig.name ?? pageConfig.url },
          'Skipping page whose setup already failed during verification',
        );
        continue;
      }

      logger.info(
        { page: pageConfig.name ?? pageConfig.url, selectors: remaining.length },
        'Healing on configured page',
      );
      await scanPage(resolved, remaining, pageConfig.setup);
    }
  }

  if (ownsBrowser) {
    await context.close();
    await browser?.close();
  }

  // One suggestion per selector: globally best candidates, deduped by code, with
  // any no-op "fix" (a candidate identical to the selector it would replace)
  // dropped — so we never surface an Apply that changes nothing.
  return toHeal.map((result) => {
    const all = candidatesById.get(result.selector.id) ?? [];
    const framework: Framework = result.selector.framework ?? config.framework ?? 'playwright';
    const ranked = keepCompetitiveCandidates(
      dedupeByCode(all)
        .filter((c) => !isNoOpReplacement(result.selector, c.replacementCode, framework))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_CANDIDATES),
    );
    // Explain the break by diffing the baseline against the top candidate (what
    // the element looks like now); undefined candidate ⇒ "removed". Isolated in a
    // try/catch so a malformed fingerprint can never break the actual heal.
    const stored = storedById.get(result.selector.id);
    let explanation: BreakReason[] = [];
    if (stored) {
      try {
        explanation = explainBreak(stored, ranked[0]?.matchedFingerprint);
      } catch (e) {
        logger.warn(
          { selectorId: result.selector.id, error: String(e) },
          'Failed to explain selector break',
        );
      }
    }
    // Lead with "renamed" only when we're *certain* the selector's own value was
    // edited: the baseline we're using belongs to a different id at this same
    // call site (findOrphanBaseline), which can only happen if the rawValue at
    // this exact spot changed since capture. We deliberately do NOT infer a
    // rename from "broken but the element looks unchanged" — that also matches an
    // app-side change the fingerprint can't see (e.g. a getByLabel whose separate
    // <label> element was renamed), and we won't tell the user they edited
    // something they didn't. The suggestion is offered either way.
    const recovered = stored !== undefined && stored.selectorId !== result.selector.id;
    if (recovered && ranked.length > 0) {
      explanation = [
        {
          kind: 'renamed',
          summary: 'selector value changed since capture — this is the element it matched before',
        },
        ...explanation.filter((r) => r.kind !== 'removed' && r.kind !== 'renamed'),
      ];
    }
    return {
      selectorId: result.selector.id,
      candidates: ranked,
      ...(explanation.length > 0 ? { explanation } : {}),
    };
  });
}

async function collectScoredCandidates(
  page: Page,
  selector: SelectorUsage,
  stored: DomFingerprint,
  pageUrl: string,
  config: HealerConfig,
  feedback: SelectorFeedback,
): Promise<HealCandidate[]> {
  const candidates = await scanCandidates(page, stored, pageUrl);
  const minConfidence = config.confidenceThreshold?.suggest ?? MIN_SUGGEST_CONFIDENCE;
  const framework: Framework = selector.framework ?? config.framework ?? 'playwright';

  return candidates
    .map((candidateFp) => buildScoredCandidate(stored, candidateFp, framework, feedback))
    .filter((c) => c.confidence >= minConfidence);
}

/**
 * Score one candidate against the baseline, then apply the learned confidence
 * nudge for the selector kind its replacement uses. Pure and exported so the
 * score → adjust → note wiring is unit-testable without a live page.
 *
 * @param stored - the baseline fingerprint of the broken selector's element
 * @param candidateFp - a candidate element's fingerprint from the current DOM
 * @param framework - the test framework, for rendering the replacement locator
 * @param feedback - learned accept/reject history
 * @returns the scored candidate, with `learningNote` set when a nudge applied
 *
 * @example
 * buildScoredCandidate(stored, candidate, 'playwright', feedback);
 */
export function buildScoredCandidate(
  stored: DomFingerprint,
  candidateFp: DomFingerprint,
  framework: Framework,
  feedback: SelectorFeedback,
): HealCandidate {
  const { confidence, reasoning, ruleScores } = scoreCandidate(stored, candidateFp);
  const replacementCode = generateReplacementCode(candidateFp, framework);
  const adjusted = adjustConfidence(confidence, classifyReplacementType(replacementCode), feedback);
  return {
    replacementCode,
    confidence: adjusted.confidence,
    reasoning,
    ruleScores,
    ...(adjusted.note ? { learningNote: adjusted.note } : {}),
    matchedFingerprint: candidateFp,
  };
}

/** Highest confidence among a selector's accumulated candidates (0 if none). */
export function bestConfidence(candidates: HealCandidate[] | undefined): number {
  let best = 0;
  if (candidates) {
    for (const c of candidates) {
      if (c.confidence > best) best = c.confidence;
    }
  }
  return best;
}

/** Collapse duplicate replacement codes, keeping the highest-confidence one. */
export function dedupeByCode(candidates: HealCandidate[]): HealCandidate[] {
  const byCode = new Map<string, HealCandidate>();
  for (const c of candidates) {
    const existing = byCode.get(c.replacementCode);
    if (!existing || c.confidence > existing.confidence) {
      byCode.set(c.replacementCode, c);
    }
  }
  return [...byCode.values()];
}

/**
 * True when a healed candidate's code is equivalent to the selector it would
 * replace — applying it changes nothing, so it must not be offered as a fix.
 * This happens when a selector is flagged broken by a cascade elsewhere (e.g. a
 * failed setup) yet its own element is unchanged, so the healer re-derives the
 * identical locator.
 *
 * @param selector - The original selector usage extracted from the test.
 * @param replacementCode - A candidate's proposed replacement code.
 * @param framework - Target framework (only Playwright source is reconstructed).
 * @returns True when the replacement is a no-op.
 *
 * @example
 * ```ts
 * isNoOpReplacement(
 *   { selectorType: 'role', rawValue: 'alert' },
 *   "page.getByRole('alert')",
 * ); // true
 * ```
 */
export function isNoOpReplacement(
  selector: SelectorUsage,
  replacementCode: string,
  framework: Framework = 'playwright',
): boolean {
  const original = renderSelectorCode(selector, framework);
  if (original === undefined) return false;
  return normalizeLocator(original) === normalizeLocator(replacementCode);
}

/** Normalise a Playwright locator string so equivalent forms compare equal. */
function normalizeLocator(code: string): string {
  return code
    .replace(/^page\./, '') // the receiver is incidental (`page.` / `this.page.` / none)
    .replace(/"/g, "'") // unify quote style
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
}

function resolvePageUrl(selector: SelectorUsage, config: HealerConfig): string | undefined {
  const hint = selector.contextHint;
  if (!hint) return undefined;
  if (hint.startsWith('http://') || hint.startsWith('https://')) return hint;
  const base = config.baseUrl.replace(/\/$/, '');
  const path = hint.startsWith('/') ? hint : `/${hint}`;
  return `${base}${path}`;
}

function resolveConfigPageUrl(url: string, config: HealerConfig): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const base = config.baseUrl.replace(/\/$/, '');
  const path = url.startsWith('/') ? url : `/${url}`;
  return `${base}${path}`;
}

/** Normalize a URL for comparison: drop a single trailing slash. */
function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '');
}

function groupByUrl(
  results: VerificationResult[],
  config: HealerConfig,
): Map<string, VerificationResult[]> {
  const map = new Map<string, VerificationResult[]>();
  for (const result of results) {
    const url = resolvePageUrl(result.selector, config) ?? config.baseUrl;
    const list = map.get(url);
    if (list) {
      list.push(result);
    } else {
      map.set(url, [result]);
    }
  }
  return map;
}
