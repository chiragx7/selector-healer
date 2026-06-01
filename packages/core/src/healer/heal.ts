import type { Page } from 'playwright';
import { loadFingerprints } from '../fingerprint/store.js';
import { logger } from '../logger.js';
import { launchBrowser, loadPlaywright } from '../playwright-loader.js';
import type {
  DomFingerprint,
  Framework,
  HealCandidate,
  HealSuggestion,
  HealerConfig,
  SelectorUsage,
  VerificationResult,
} from '../types.js';
import { scanCandidates } from './candidates.js';
import { generateReplacementCode } from './replacement-code.js';
import { scoreCandidate } from './scoring.js';

export interface HealOptions {
  config: HealerConfig;
  projectRoot: string;
}

const MAX_CANDIDATES = 3;
const MIN_SUGGEST_CONFIDENCE = 0.2;

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

  const storedById = new Map<string, DomFingerprint>();
  for (const result of toHeal) {
    const stored = result.storedFingerprint ?? fingerprints.get(result.selector.id);
    if (stored) storedById.set(result.selector.id, stored);
  }

  const pw = await loadPlaywright(projectRoot);
  const browser = await launchBrowser(pw, config);
  const context = await browser.newContext();

  if (config.globalSetup) {
    await config.globalSetup(context);
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
      logger.info(
        { page: pageConfig.name ?? pageConfig.url, selectors: remaining.length },
        'Healing on configured page',
      );
      await scanPage(resolveConfigPageUrl(pageConfig.url, config), remaining, pageConfig.setup);
    }
  }

  await context.close();
  await browser.close();

  // One suggestion per selector: globally best candidates, deduped by code.
  return toHeal.map((result) => {
    const all = candidatesById.get(result.selector.id) ?? [];
    const deduped = dedupeByCode(all).sort((a, b) => b.confidence - a.confidence);
    return { selectorId: result.selector.id, candidates: deduped.slice(0, MAX_CANDIDATES) };
  });
}

async function collectScoredCandidates(
  page: Page,
  selector: SelectorUsage,
  stored: DomFingerprint,
  pageUrl: string,
  config: HealerConfig,
): Promise<HealCandidate[]> {
  const candidates = await scanCandidates(page, stored, pageUrl);
  const minConfidence = config.confidenceThreshold?.suggest ?? MIN_SUGGEST_CONFIDENCE;
  const framework: Framework = selector.framework ?? config.framework ?? 'playwright';

  return candidates
    .map((candidateFp) => {
      const { confidence, reasoning } = scoreCandidate(stored, candidateFp);
      return {
        replacementCode: generateReplacementCode(candidateFp, framework),
        confidence,
        reasoning,
        matchedFingerprint: candidateFp,
      };
    })
    .filter((c) => c.confidence >= minConfidence);
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
