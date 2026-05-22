import type { Browser, Page } from 'playwright';
import { loadFingerprints } from '../fingerprint/store.js';
import { logger } from '../logger.js';
import type {
  DomFingerprint,
  HealCandidate,
  HealSuggestion,
  HealerConfig,
  SelectorUsage,
  VerificationResult,
} from '../types.js';
import { scanCandidates } from './candidates.js';
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

  const scored: HealCandidate[] = candidates
    .map((candidateFp) => {
      const { confidence, reasoning } = scoreCandidate(stored, candidateFp);
      return {
        replacementCode: buildReplacementCode(selector, candidateFp),
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

function buildReplacementCode(selector: SelectorUsage, candidate: DomFingerprint): string {
  const testId = candidate.attributes['data-testid'] ?? candidate.attributes['data-test-id'];
  if (testId) {
    return `getByTestId('${testId}')`;
  }

  const role = candidate.attributes.role;
  if (role && candidate.textContent.length > 0) {
    const name = candidate.textContent.slice(0, 50);
    return `getByRole('${role}', { name: '${escapeQuotes(name)}' })`;
  }
  if (role) {
    return `getByRole('${role}')`;
  }

  if (candidate.attributes.id) {
    return `locator('#${candidate.attributes.id}')`;
  }

  if (candidate.textContent.length > 0 && candidate.textContent.length <= 50) {
    return `getByText('${escapeQuotes(candidate.textContent)}')`;
  }

  const cls = candidate.attributes.class;
  if (cls) {
    const first = cls.split(/\s+/).filter(Boolean)[0];
    if (first) {
      return `locator('${candidate.tagName}.${first}')`;
    }
  }

  return `locator('${candidate.tagName}')`;
}

function escapeQuotes(s: string): string {
  return s.replace(/'/g, "\\'");
}

function resolvePageUrl(selector: SelectorUsage, config: HealerConfig): string | undefined {
  const hint = selector.contextHint;
  if (!hint) return undefined;
  if (hint.startsWith('http://') || hint.startsWith('https://')) return hint;
  const base = config.baseUrl.replace(/\/$/, '');
  const path = hint.startsWith('/') ? hint : `/${hint}`;
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
