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
 * Min fraction of the top suggestion's confidence an alternative must reach to be
 * shown. Relative (not an absolute gap) on purpose: a confident top (say 0.96)
 * demands relatively-close alternatives (≥ ~0.72) so its structural look-alikes —
 * a *different* element sharing tag/class/position, e.g. a sibling nav link — are
 * dropped; a weak/uncertain top keeps its near-peers so the user still has options.
 */
const MIN_ALTERNATIVE_RATIO = 0.75;

/**
 * Trim a confidence-sorted candidate list to the best one plus only the
 * alternatives genuinely competitive with it — those within
 * {@link MIN_ALTERNATIVE_RATIO} of the top's confidence. So a runaway winner sheds
 * its far-behind look-alikes (they're a different element, not another way to
 * select the same one), while an uncertain top keeps its close peers.
 *
 * @param sorted - candidates already sorted by confidence, highest first
 * @returns the top candidate plus competitive alternatives, order preserved
 *
 * @example
 * keepCompetitiveCandidates([{ confidence: 0.96 }, { confidence: 0.67 }] as HealCandidate[]);
 * // → [{ confidence: 0.96 }]  (0.67 < 0.96 × 0.75, so the look-alike is dropped)
 */
export function keepCompetitiveCandidates(sorted: HealCandidate[]): HealCandidate[] {
  const top = sorted[0];
  if (!top) return sorted;
  // Epsilon so an alternative sitting exactly at the ratio floor is kept despite
  // float rounding.
  const floor = top.confidence * MIN_ALTERNATIVE_RATIO - 1e-9;
  return sorted.filter((c, i) => i === 0 || c.confidence >= floor);
}

/**
 * Order a selector's candidates for the suggestion list. The pool is bounded by
 * the **structural** score, not the learning-nudged one: auto-apply (CLI `--fix`,
 * the extension's Apply-All) selects the structurally-best *survivor*, so the real
 * best must never be sliced out by a display nudge. We therefore take the top
 * {@link MAX_CANDIDATES} by structural score, then reorder those by the nudged
 * confidence for presentation, then drop far-behind look-alikes.
 *
 * @param candidates - scored candidates for one selector (deduped, no-ops removed)
 * @returns candidates ranked for display, structurally-best always retained
 *
 * @example
 * // A confident top sheds its sibling look-alikes; the pool still holds the real best.
 * rankCandidates(scoredCandidates);
 */
export function rankCandidates(candidates: HealCandidate[]): HealCandidate[] {
  const structuralOf = (c: HealCandidate): number => c.structuralConfidence ?? c.confidence;
  const pool = [...candidates]
    .sort((a, b) => structuralOf(b) - structuralOf(a))
    .slice(0, MAX_CANDIDATES);
  const structuralBest = pool[0]; // pool is structural-desc, so [0] is the best match
  const displayed = keepCompetitiveCandidates(
    [...pool].sort((a, b) => b.confidence - a.confidence),
  );
  // keepCompetitiveCandidates trims by *nudged* ratio, which can drop a low-nudged
  // (disliked-kind) structural-best as if it were a look-alike. It is not one — it's
  // the strongest structural match — and auto-apply selects the structural-best
  // SURVIVOR of this list, so it must remain present. Re-add it (at the tail, since
  // its display rank is low) when the nudge trim would have removed it.
  if (structuralBest && !displayed.includes(structuralBest)) displayed.push(structuralBest);
  return displayed;
}

/**
 * Decide whether an empty heal result means "couldn't reach the page" rather than
 * "the element is genuinely gone". True only when there IS a baseline to look for,
 * no candidate was found, we never scanned this selector on a page that actually
 * loaded, *and* a page-load failure did occur — so the empty result is a hard
 * reachability failure we should report honestly (and retry), not a removal.
 *
 * Deliberately conservative: it does NOT try to infer reachability from a login
 * failure alone. If a page still "loads" (e.g. a protected route that 200s to a
 * login screen), that counts as scanned — claiming "unreachable" there would risk
 * masking a genuine removal on a public page. See DECISIONS.md for the residual
 * page-load-granularity limitations.
 *
 * @param opts - the signals gathered during the heal run
 * @returns true when the empty result is a hard reachability failure, not a removal
 *
 * @example
 * isUnreachable({ hasCandidate: false, hasBaseline: true, scannedOk: false, scanFailed: true });
 * // → true  (a baseline existed, but every page we tried failed to load)
 */
export function isUnreachable(opts: {
  hasCandidate: boolean;
  hasBaseline: boolean;
  scannedOk: boolean;
  scanFailed: boolean;
}): boolean {
  return !opts.hasCandidate && opts.hasBaseline && !opts.scannedOk && opts.scanFailed;
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
      // A failed login must not crash the whole heal. Left unauthenticated, the
      // per-page scans below fail (nothing loads), which marks their selectors
      // unreachable — an honest "couldn't reach the page" rather than a throw.
      try {
        await config.globalSetup(context);
      } catch (e) {
        logger.warn({ error: String(e) }, 'Global setup (login) failed during healing');
      }
    }
  }

  // selectorId -> every scored candidate found for it, across all pages scanned.
  const candidatesById = new Map<string, HealCandidate[]>();
  // Reachability tracking, to tell "scanned a loaded page, found nothing" (the
  // element is genuinely gone) apart from "never reached a page that loaded"
  // (a login/navigation failure — we couldn't check, so don't claim removal).
  const scannedOkIds = new Set<string>();
  const scanFailedIds = new Set<string>();

  const scanPage = async (
    target: string,
    results: VerificationResult[],
    setup?: (page: unknown) => Promise<void>,
  ): Promise<void> => {
    let page: Page | undefined;
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
      // The page never loaded — every selector we meant to scan here couldn't be
      // checked on this page (may still succeed on another page in a later phase).
      for (const r of results) {
        if (storedById.has(r.selector.id)) scanFailedIds.add(r.selector.id);
      }
      // Close the (opened-but-unusable) page so a run full of failures doesn't leak
      // one handle per failed load until the whole context closes.
      await page?.close().catch(() => {});
      return;
    }
    // Unreachable in practice (the try assigns `page` or the catch returns); this
    // narrows `Page | undefined` back to `Page` for the scan below.
    if (!page) return;

    const currentUrl = page.url();
    for (const result of results) {
      const stored = storedById.get(result.selector.id);
      if (!stored) continue;
      // The page loaded, so this selector was genuinely looked at here — enough to
      // distinguish "scanned, nothing matched" from "never reached the page".
      scannedOkIds.add(result.selector.id);
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
        // Verify already found this page unreachable, so we skip it — but the
        // selectors that needed it still couldn't be checked here. Mark them so an
        // empty result reads as "couldn't reach" (unless another page scans them).
        for (const r of remaining) {
          if (storedById.has(r.selector.id)) scanFailedIds.add(r.selector.id);
        }
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
    const ranked = rankCandidates(
      dedupeByCode(all).filter(
        (c) => !isNoOpReplacement(result.selector, c.replacementCode, framework),
      ),
    );
    // Couldn't-reach vs genuinely-gone: with no candidate, if we never scanned
    // this selector on a page that actually loaded yet a page-load/login failure
    // occurred, we simply couldn't look — so don't claim the element was removed.
    const id = result.selector.id;
    const stored = storedById.get(id);
    const unreachable = isUnreachable({
      hasCandidate: ranked.length > 0,
      hasBaseline: stored !== undefined,
      scannedOk: scannedOkIds.has(id),
      scanFailed: scanFailedIds.has(id),
    });
    // Explain the break. When unreachable, say so honestly instead of diffing to
    // a "removed" verdict we didn't earn — we never got to look. Otherwise diff
    // the baseline against the top candidate (undefined candidate ⇒ "removed"),
    // isolated in a try/catch so a malformed fingerprint can't break the heal.
    let explanation: BreakReason[] = [];
    if (unreachable) {
      explanation = [
        {
          kind: 'unreachable',
          summary:
            "couldn't reach the page to check — a login or setup step may have failed or timed out, so the selector may still be fine (try again)",
        },
      ];
    } else if (stored) {
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
    const recovered = stored !== undefined && stored.selectorId !== id;
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
      selectorId: id,
      candidates: ranked,
      ...(explanation.length > 0 ? { explanation } : {}),
      ...(unreachable ? { unreachable: true } : {}),
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

  return (
    candidates
      .map((candidateFp) => buildScoredCandidate(stored, candidateFp, framework, feedback))
      // Gate visibility on the structural score so learning neither surfaces
      // sub-floor noise nor hides a genuinely-matching suggestion.
      .filter((c) => (c.structuralConfidence ?? c.confidence) >= minConfidence)
  );
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
    confidence: adjusted.confidence, // nudged — for ranking + display
    structuralConfidence: confidence, // pure structural — for automated gates
    reasoning,
    ruleScores,
    ...(adjusted.note ? { learningNote: adjusted.note } : {}),
    matchedFingerprint: candidateFp,
  };
}

/**
 * Highest **structural** confidence among a selector's candidates (0 if none).
 * Uses the pre-learning score because the sole caller is the phase-2 gate that
 * decides whether to scan configured/login pages — a learned nudge must not make
 * heal skip the page where the real element actually lives.
 */
export function bestConfidence(candidates: HealCandidate[] | undefined): number {
  let best = 0;
  if (candidates) {
    for (const c of candidates) {
      const structural = c.structuralConfidence ?? c.confidence;
      if (structural > best) best = structural;
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
