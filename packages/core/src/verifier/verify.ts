import type { Browser, BrowserContext, Page } from 'playwright';
import { buildLocator } from '../fingerprint/capture.js';
import { loadFingerprints } from '../fingerprint/store.js';
import { logger } from '../logger.js';
import type {
  DomFingerprint,
  HealerConfig,
  SelectorUsage,
  VerificationResult,
  VerificationStatus,
} from '../types.js';
import { compareFingerprints } from './compare.js';

export interface VerifyOptions {
  config: HealerConfig;
  projectRoot: string;
}

interface PlaywrightModule {
  chromium: { launch(opts?: Record<string, unknown>): Promise<Browser> };
  firefox: { launch(opts?: Record<string, unknown>): Promise<Browser> };
  webkit: { launch(opts?: Record<string, unknown>): Promise<Browser> };
}

export async function verifySelectors(
  selectors: SelectorUsage[],
  options: VerifyOptions,
): Promise<VerificationResult[]> {
  const { config, projectRoot } = options;

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

  const withBaseline: Array<{ selector: SelectorUsage; stored: DomFingerprint }> = [];
  const skippedResults: VerificationResult[] = [];

  for (const sel of selectors) {
    const stored = fingerprints.get(sel.id);
    if (stored) {
      withBaseline.push({ selector: sel, stored });
    } else {
      logger.info(
        { selectorId: sel.id, rawValue: sel.rawValue },
        'No fingerprint baseline — run `selector-healer capture` to baseline new selectors',
      );
      skippedResults.push({
        selector: sel,
        status: 'skipped',
        matchCount: 0,
        error: 'No fingerprint baseline exists. Run capture first.',
      });
    }
  }

  if (withBaseline.length === 0) {
    return skippedResults;
  }

  const pw = await loadPlaywright();
  const browser = await launchBrowser(pw, config);
  const context = await browser.newContext();

  if (config.globalSetup) {
    await config.globalSetup(context);
  }

  const results: VerificationResult[] = [];

  const byUrl = groupByUrl(withBaseline, config);

  for (const [url, group] of byUrl) {
    let page: Page;
    try {
      page = await context.newPage();
      await page.goto(url, { timeout: config.timeout ?? 30_000, waitUntil: 'domcontentloaded' });
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

  await context.close();
  await browser.close();

  return [...results, ...skippedResults];
}

async function verifySingleSelector(
  page: Page,
  selector: SelectorUsage,
  stored: DomFingerprint,
  pageUrl: string,
): Promise<VerificationResult> {
  const locator = buildLocator(page, selector);
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

  const comparison = compareFingerprints(stored, liveFingerprint);

  const status: VerificationStatus = comparison.identical ? 'ok' : 'ok';
  // Both identical and structurally similar count as OK — the selector still works.
  // The healer (Phase 4) uses the comparison details to decide if healing is needed.

  return {
    selector,
    status,
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

function groupByUrl(
  entries: Array<{ selector: SelectorUsage; stored: DomFingerprint }>,
  config: HealerConfig,
): Map<string, Array<{ selector: SelectorUsage; stored: DomFingerprint }>> {
  const map = new Map<string, Array<{ selector: SelectorUsage; stored: DomFingerprint }>>();

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
