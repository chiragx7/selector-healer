import type { Browser, Page } from 'playwright';
import { loadFingerprints } from '../fingerprint/store.js';
import { logger } from '../logger.js';
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

interface PlaywrightModule {
  chromium: { launch(opts?: Record<string, unknown>): Promise<Browser> };
  firefox: { launch(opts?: Record<string, unknown>): Promise<Browser> };
  webkit: { launch(opts?: Record<string, unknown>): Promise<Browser> };
}

const MAX_CANDIDATES = 3;
const MIN_SUGGEST_CONFIDENCE = 0.2;

/**
 * Generate replacement suggestions for broken selectors by scanning the live
 * DOM for elements matching stored fingerprints.
 *
 * @param brokenResults - Verification results with `status: 'broken'`.
 * @param options - Healer configuration and project root path.
 * @returns One `HealSuggestion` per broken selector, each with up to 3 ranked candidates.
 *
 * @example
 * ```ts
 * const broken = verificationResults.filter(r => r.status === 'broken');
 * const suggestions = await healSelectors(broken, { config, projectRoot });
 * for (const s of suggestions) {
 *   console.log(`${s.selectorId}: ${s.candidates.length} suggestions`);
 * }
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

  const pw = await loadPlaywright();
  const browser = await launchBrowser(pw, config);
  const context = await browser.newContext();

  if (config.globalSetup) {
    await config.globalSetup(context);
  }

  const suggestions: HealSuggestion[] = [];
  const byUrl = groupByUrl(toHeal, config);

  for (const [url, group] of byUrl) {
    let page: Page;
    try {
      page = await context.newPage();
      await page.goto(url, { timeout: config.timeout ?? 30_000, waitUntil: 'domcontentloaded' });
      // SPA settle: candidate scanning reads the DOM, so let client-rendered apps
      // finish rendering before we look for replacement elements. Non-fatal on timeout.
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    } catch (e) {
      logger.warn({ url, error: String(e) }, 'Page load failed during healing');
      for (const result of group) {
        suggestions.push({ selectorId: result.selector.id, candidates: [] });
      }
      continue;
    }

    for (const result of group) {
      const stored = result.storedFingerprint ?? fingerprints.get(result.selector.id);
      if (!stored) {
        suggestions.push({ selectorId: result.selector.id, candidates: [] });
        continue;
      }

      try {
        const suggestion = await healSingleSelector(page, result.selector, stored, url, config);
        suggestions.push(suggestion);
      } catch (e) {
        logger.warn(
          { selectorId: result.selector.id, error: String(e) },
          'Healing failed for selector',
        );
        suggestions.push({ selectorId: result.selector.id, candidates: [] });
      }
    }

    await page.close();
  }

  // Phase 2: Retry selectors with no candidates on configured pages (auth, interactions)
  if (config.pages && config.pages.length > 0) {
    const healedIds = new Set<string>();
    for (const s of suggestions) {
      if (s.candidates.length > 0) {
        healedIds.add(s.selectorId);
      }
    }

    const unhealed = toHeal.filter((r) => !healedIds.has(r.selector.id));

    if (unhealed.length > 0) {
      logger.info(
        { count: unhealed.length, pages: config.pages.length },
        'Retrying unhealed selectors on configured pages',
      );

      for (const pageConfig of config.pages) {
        const remaining = unhealed.filter((r) => !healedIds.has(r.selector.id));
        if (remaining.length === 0) break;

        let page: Page;
        try {
          page = await context.newPage();
          const resolvedUrl = resolveConfigPageUrl(pageConfig.url, config);

          if (pageConfig.setup) {
            await pageConfig.setup(page);
          } else {
            await page.goto(resolvedUrl, {
              timeout: config.timeout ?? 30_000,
              waitUntil: 'domcontentloaded',
            });
          }
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

          const currentUrl = page.url();
          logger.info(
            {
              page: pageConfig.name ?? pageConfig.url,
              url: currentUrl,
              selectors: remaining.length,
            },
            'Healing on configured page',
          );

          for (const result of remaining) {
            const stored = result.storedFingerprint ?? fingerprints.get(result.selector.id);
            if (!stored) continue;

            try {
              const suggestion = await healSingleSelector(
                page,
                result.selector,
                stored,
                currentUrl,
                config,
              );
              if (suggestion.candidates.length > 0) {
                const existingIdx = suggestions.findIndex(
                  (s) => s.selectorId === result.selector.id,
                );
                if (existingIdx >= 0) {
                  suggestions[existingIdx] = suggestion;
                } else {
                  suggestions.push(suggestion);
                }
                healedIds.add(result.selector.id);
              }
            } catch {
              // Silently skip — other pages may heal this selector
            }
          }

          await page.close();
        } catch (e) {
          logger.warn(
            {
              page: pageConfig.name ?? pageConfig.url,
              error: e instanceof Error ? e.message : String(e),
            },
            'Failed to set up configured page for healing',
          );
        }
      }
    }
  }

  await context.close();
  await browser.close();

  return suggestions;
}

async function healSingleSelector(
  page: Page,
  selector: SelectorUsage,
  stored: DomFingerprint,
  pageUrl: string,
  config: HealerConfig,
): Promise<HealSuggestion> {
  const candidates = await scanCandidates(page, stored, pageUrl);

  const minConfidence = config.confidenceThreshold?.suggest ?? MIN_SUGGEST_CONFIDENCE;
  const framework: Framework = selector.framework ?? config.framework ?? 'playwright';

  const scored: HealCandidate[] = candidates
    .map((candidateFp) => {
      const { confidence, reasoning } = scoreCandidate(stored, candidateFp);
      return {
        replacementCode: generateReplacementCode(candidateFp, framework),
        confidence,
        reasoning,
        matchedFingerprint: candidateFp,
      };
    })
    .filter((c) => c.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_CANDIDATES);

  return { selectorId: selector.id, candidates: scored };
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

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import('playwright');
  } catch {
    throw new Error('playwright is not installed. Install it with: npm install -D playwright');
  }
}

async function launchBrowser(pw: PlaywrightModule, config: HealerConfig): Promise<Browser> {
  const browserType = config.browser ?? 'chromium';
  return pw[browserType].launch({ headless: config.headless ?? true });
}
