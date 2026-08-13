import type { Browser, BrowserContext, Page } from 'playwright';
import { buildLocator } from '../fingerprint/capture.js';
import { findOrphanBaseline } from '../fingerprint/source-match.js';
import { loadFingerprints } from '../fingerprint/store.js';
import { logger } from '../logger.js';
import { launchBrowser, loadPlaywright } from '../playwright-loader.js';
import type {
  DomFingerprint,
  HealerConfig,
  SelectorUsage,
  VerificationResult,
  VerificationStatus,
} from '../types.js';

export interface VerifyOptions {
  config: HealerConfig;
  projectRoot: string;
  /**
   * When `false`, selectors that have no stored fingerprint are still checked
   * against the live DOM by match count (1 = ok, 0 = broken, >1 = multiple)
   * instead of being reported as `skipped`. Used for targeted re-verification
   * right after a heal is applied, where the replacement may have a new
   * identity and therefore no baseline yet. Defaults to `true`.
   */
  requireBaseline?: boolean;
  /**
   * A pre-opened browser context to reuse (e.g. the extension's warm watch
   * session from {@link openHealerBrowser}). When provided, verify uses it and
   * does **not** launch/close a browser or re-run `globalSetup` - the caller owns
   * that lifecycle. When omitted, a fresh browser is launched and closed per call
   * (the default for the CLI and one-off runs).
   */
  context?: BrowserContext;
}

export async function verifySelectors(
  selectors: SelectorUsage[],
  options: VerifyOptions,
): Promise<VerificationResult[]> {
  const { config, projectRoot } = options;
  const requireBaseline = options.requireBaseline ?? true;

  const storeResult = loadFingerprints(projectRoot);
  if (storeResult.isErr()) {
    logger.error({ error: storeResult.error }, 'Failed to load fingerprints');
    return selectors.map((sel) => ({
      selector: sel,
      status: 'skipped' as VerificationStatus,
      matchCount: 0,
      error: `Cannot load fingerprints: ${storeResult.error.message}`,
    }));
  }

  const fingerprints = storeResult.value;

  const toVerify: Array<{ selector: SelectorUsage; stored?: DomFingerprint }> = [];
  const skippedResults: VerificationResult[] = [];

  for (const sel of selectors) {
    // Direct baseline first; if the selector was renamed (its id changed), fall
    // back to the baseline captured for the previous value at this same line so
    // it's verified - and healed - rather than skipped as "unknown".
    const stored = fingerprints.get(sel.id) ?? findOrphanBaseline(fingerprints, sel, projectRoot);
    if (stored) {
      toVerify.push({ selector: sel, stored });
    } else if (!requireBaseline) {
      // Targeted re-verify (e.g. just after applying a heal): the replacement
      // may not have a baseline yet, so check it by live match count alone.
      toVerify.push({ selector: sel });
    } else {
      logger.info(
        { selectorId: sel.id, rawValue: sel.rawValue },
        'No fingerprint baseline - run `selector-healer capture` to baseline new selectors',
      );
      skippedResults.push({
        selector: sel,
        status: 'skipped',
        matchCount: 0,
        error: 'No fingerprint baseline exists. Run capture first.',
      });
    }
  }

  if (toVerify.length === 0) {
    return skippedResults;
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

  const results: VerificationResult[] = [];

  const byUrl = groupByUrl(toVerify, config);

  for (const [url, group] of byUrl) {
    let page: Page;
    try {
      page = await context.newPage();
      await page.goto(url, { timeout: config.timeout ?? 30_000, waitUntil: 'domcontentloaded' });
      // SPA settle: count() does not auto-wait, so let client-rendered apps finish
      // rendering before we count matches. Non-fatal if networkidle never fires.
      await page.waitForLoadState('networkidle', { timeout: 1_000 }).catch(() => {});
    } catch (e) {
      for (const { selector, stored } of group) {
        results.push({
          selector,
          status: 'page-load-failed',
          matchCount: 0,
          storedFingerprint: stored,
          error: `Page load failed for ${url}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      continue;
    }

    for (const { selector, stored } of group) {
      try {
        const result = await verifySingleSelector(page, selector, stored, url);
        results.push(result);
      } catch (e) {
        results.push({
          selector,
          status: 'broken',
          matchCount: 0,
          storedFingerprint: stored,
          error: `Verification error: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    await page.close();
  }

  // Phase 2: Retry non-ok selectors on configured pages (auth, interactions).
  if (config.pages && config.pages.length > 0) {
    const verifiedIds = new Set<string>();
    for (const r of results) {
      if (r.status === 'ok') {
        verifiedIds.add(r.selector.id);
      }
    }

    const unverified = toVerify.filter(({ selector }) => !verifiedIds.has(selector.id));

    // Pages whose setup hook threw, keyed by normalized URL - used afterwards to
    // reclassify broken selectors that actually live on those unreachable pages.
    const setupFailures = new Map<string, { name: string; error: string }>();

    if (unverified.length > 0) {
      logger.info(
        { count: unverified.length, pages: config.pages.length },
        'Retrying unverified selectors on configured pages',
      );

      for (const pageConfig of config.pages) {
        const remaining = unverified.filter(({ selector }) => !verifiedIds.has(selector.id));
        if (remaining.length === 0) break;

        const resolvedUrl = resolveConfigPageUrl(pageConfig.url, config);

        let page: Page;
        try {
          page = await context.newPage();
        } catch (e) {
          logger.warn({ error: errorMessage(e) }, 'Failed to open a page for verification');
          continue;
        }

        // Run setup/navigation in its own try so a failing setup hook is
        // attributed precisely (not confused with a per-selector error).
        try {
          if (pageConfig.setup) {
            // Bound setup actions to the configured budget - otherwise a hook
            // waiting on a missing element hangs for Playwright's 30s default.
            page.setDefaultTimeout(config.timeout ?? 30_000);
            await pageConfig.setup(page);
          } else {
            await page.goto(resolvedUrl, {
              timeout: config.timeout ?? 30_000,
              waitUntil: 'domcontentloaded',
            });
          }
        } catch (e) {
          setupFailures.set(normalizeUrl(resolvedUrl), {
            name: pageConfig.name ?? pageConfig.url,
            error: errorMessage(e),
          });
          logger.warn(
            { page: pageConfig.name ?? pageConfig.url, error: errorMessage(e) },
            'Setup hook failed for configured page',
          );
          await page.close().catch(() => {});
          continue;
        }

        await page.waitForLoadState('networkidle', { timeout: 1_000 }).catch(() => {});
        const currentUrl = page.url();
        logger.info(
          { page: pageConfig.name ?? pageConfig.url, url: currentUrl, selectors: remaining.length },
          'Verifying on configured page',
        );

        for (const { selector, stored } of remaining) {
          try {
            const result = await verifySingleSelector(page, selector, stored, currentUrl);
            if (result.status === 'ok') {
              const existingIdx = results.findIndex((r) => r.selector.id === selector.id);
              if (existingIdx >= 0) {
                results[existingIdx] = result;
              } else {
                results.push(result);
              }
              verifiedIds.add(selector.id);
            }
          } catch {
            // Silently skip - other pages may verify this selector
          }
        }

        await page.close();
      }
    }

    // A still-broken selector whose captured page's setup hook failed could not
    // actually be checked. Report it as page-load-failed (with the setup error)
    // rather than 'broken', so it's not mistaken for a regression or sent to the
    // healer. The default page is always reachable, so breaks there are genuine.
    if (setupFailures.size > 0) {
      const baseUrlNorm = normalizeUrl(config.baseUrl);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r || r.status !== 'broken' || !r.storedFingerprint) continue;
        const fpUrl = normalizeUrl(r.storedFingerprint.pageUrl);
        if (fpUrl === baseUrlNorm) continue;
        const failure = setupFailures.get(fpUrl);
        if (failure) {
          results[i] = {
            selector: r.selector,
            status: 'page-load-failed',
            matchCount: 0,
            storedFingerprint: r.storedFingerprint,
            error: `Could not reach page '${failure.name}' - its setup hook failed: ${failure.error}`,
          };
        }
      }
    }
  }

  if (ownsBrowser) {
    await context.close();
    await browser?.close();
  }

  return [...results, ...skippedResults];
}

async function verifySingleSelector(
  page: Page,
  selector: SelectorUsage,
  stored: DomFingerprint | undefined,
  pageUrl: string,
): Promise<VerificationResult> {
  const locator = buildLocator(page, selector);

  // count() does not auto-wait; on a slow SPA give THIS element up to 5s to
  // attach before reporting it broken. Bounded and non-fatal.
  await locator
    .first()
    .waitFor({ state: 'attached', timeout: 5_000 })
    .catch(() => {});

  const count = await locator.count();

  if (count === 0) {
    return {
      selector,
      status: 'broken',
      matchCount: 0,
      storedFingerprint: stored,
    };
  }

  if (count > 1) {
    return {
      selector,
      status: 'multiple-matches',
      matchCount: count,
      storedFingerprint: stored,
    };
  }

  const el = locator.first();

  const liveSnapshot = await el.evaluate((node) => {
    const attrs: Record<string, string> = {};
    for (const attr of node.attributes) {
      attrs[attr.name] = attr.value;
    }

    const chain: Array<{ tagName: string; id?: string; classes: string[]; role?: string }> = [];
    let current = node.parentElement;
    for (let i = 0; i < 5 && current; i++) {
      chain.unshift({
        tagName: current.tagName.toLowerCase(),
        ...(current.id ? { id: current.id } : {}),
        classes: [...current.classList],
        ...(current.getAttribute('role')
          ? { role: current.getAttribute('role') ?? undefined }
          : {}),
      });
      current = current.parentElement;
    }

    let siblingIndex = 0;
    if (node.parentElement) {
      const siblings = [...node.parentElement.children].filter((c) => c.tagName === node.tagName);
      siblingIndex = siblings.indexOf(node);
    }

    return {
      tagName: node.tagName.toLowerCase(),
      attributes: attrs,
      textContent: (node.textContent ?? '').trim().slice(0, 200),
      parentChain: chain,
      siblingIndex,
    };
  });

  let boundingBox: DomFingerprint['boundingBox'];
  try {
    const box = await el.boundingBox();
    if (box) {
      boundingBox = { x: box.x, y: box.y, width: box.width, height: box.height };
    }
  } catch {
    // Element not visible
  }

  const liveFingerprint: DomFingerprint = {
    selectorId: selector.id,
    capturedAt: new Date().toISOString(),
    ...liveSnapshot,
    ...(boundingBox ? { boundingBox } : {}),
    pageUrl,
  };

  // A single match means the selector still resolves. Structural drift is the
  // healer's concern, not the verifier's - one match counts as OK either way.
  return {
    selector,
    status: 'ok',
    matchCount: 1,
    liveFingerprint,
    storedFingerprint: stored,
  };
}

function resolvePageUrl(selector: SelectorUsage, config: HealerConfig): string | undefined {
  const hint = selector.contextHint;
  if (!hint) return undefined;

  if (hint.startsWith('http://') || hint.startsWith('https://')) {
    return hint;
  }
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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function groupByUrl(
  entries: Array<{ selector: SelectorUsage; stored?: DomFingerprint }>,
  config: HealerConfig,
): Map<string, Array<{ selector: SelectorUsage; stored?: DomFingerprint }>> {
  const map = new Map<string, Array<{ selector: SelectorUsage; stored?: DomFingerprint }>>();

  for (const entry of entries) {
    const url = resolvePageUrl(entry.selector, config) ?? config.baseUrl;
    const list = map.get(url);
    if (list) {
      list.push(entry);
    } else {
      map.set(url, [entry]);
    }
  }

  return map;
}
