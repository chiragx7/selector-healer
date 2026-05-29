import type { Browser, BrowserContext, Page } from 'playwright';
import { logger } from '../logger.js';
import type { DomFingerprint, HealerConfig, SelectorUsage } from '../types.js';
import { loadFingerprints, saveFingerprints } from './store.js';

export interface CaptureResult {
  captured: number;
  skipped: number;
  errors: CaptureError[];
}

export interface CaptureError {
  selectorId: string;
  rawValue: string;
  message: string;
}

/** Live progress event emitted per selector during capture. */
export interface CaptureProgressEvent {
  selectorId: string;
  status: 'capturing' | 'captured' | 'missed';
}

/** Optional callback to observe capture progress in real time. */
export type CaptureProgress = (event: CaptureProgressEvent) => void;

interface PlaywrightModule {
  chromium: { launch(opts?: Record<string, unknown>): Promise<Browser> };
  firefox: { launch(opts?: Record<string, unknown>): Promise<Browser> };
  webkit: { launch(opts?: Record<string, unknown>): Promise<Browser> };
}

async function launchBrowser(pw: PlaywrightModule, config: HealerConfig): Promise<Browser> {
  const browserType = config.browser ?? 'chromium';
  return pw[browserType].launch({ headless: config.headless ?? true });
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

async function captureElementFingerprint(
  page: Page,
  selector: SelectorUsage,
  pageUrl: string,
): Promise<DomFingerprint | undefined> {
  const locator = buildLocator(page, selector);

  // count() does not auto-wait; on a slow SPA give THIS element up to 5s to
  // attach before deciding it's absent. Bounded and non-fatal.
  await locator
    .first()
    .waitFor({ state: 'attached', timeout: 5_000 })
    .catch(() => {});

  const count = await locator.count();
  if (count === 0) {
    logger.warn(
      { selectorId: selector.id, rawValue: selector.rawValue },
      'No element matched during capture',
    );
    return undefined;
  }

  const el = locator.first();

  const snapshot = await el.evaluate((node) => {
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
    // Element not visible — skip bounding box
  }

  return {
    selectorId: selector.id,
    capturedAt: new Date().toISOString(),
    ...snapshot,
    ...(boundingBox ? { boundingBox } : {}),
    pageUrl,
  };
}

function buildLocator(page: Page, selector: SelectorUsage) {
  switch (selector.selectorType) {
    case 'css':
    case 'xpath':
      return page.locator(selector.rawValue);
    case 'testid':
      return page.getByTestId(selector.rawValue);
    case 'role': {
      const role = selector.rawValue as Parameters<Page['getByRole']>[0];
      const opts = selector.options as Parameters<Page['getByRole']>[1];
      return page.getByRole(role, opts);
    }
    case 'text':
      return page.getByText(selector.rawValue);
    case 'label':
      return page.getByLabel(selector.rawValue);
    case 'placeholder':
      return page.getByPlaceholder(selector.rawValue);
    case 'title':
      return page.getByTitle(selector.rawValue);
    case 'alt':
      return page.getByAltText(selector.rawValue);
    default:
      return page.locator(selector.rawValue);
  }
}

export { buildLocator };

export async function captureFingerprints(
  selectors: SelectorUsage[],
  config: HealerConfig,
  projectRoot: string,
  onProgress?: CaptureProgress,
): Promise<CaptureResult> {
  const pw = await loadPlaywright();
  const browser = await launchBrowser(pw, config);
  const context = await browser.newContext();

  if (config.globalSetup) {
    await config.globalSetup(context);
  }

  const existingResult = loadFingerprints(projectRoot);
  const fingerprints = existingResult.isOk()
    ? existingResult.value
    : new Map<string, DomFingerprint>();

  const errors: CaptureError[] = [];
  let captured = 0;
  let skipped = 0;
  const capturedIds = new Set<string>();

  // Phase 1: Capture on default pages (grouped by contextHint URL)
  const byUrl = groupByUrl(selectors, config);

  for (const [url, group] of byUrl) {
    let page: Page;
    try {
      page = await context.newPage();
      await page.goto(url, { timeout: config.timeout ?? 30_000, waitUntil: 'domcontentloaded' });
      // SPA settle: count()/locator reads don't auto-wait, so give client-rendered
      // apps (Angular/React/Vue) time to render before snapshotting. Non-fatal on timeout.
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    } catch (e) {
      for (const sel of group) {
        errors.push({
          selectorId: sel.id,
          rawValue: sel.rawValue,
          message: `Page load failed for ${url}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      skipped += group.length;
      continue;
    }

    for (const sel of group) {
      onProgress?.({ selectorId: sel.id, status: 'capturing' });
      try {
        const fp = await captureElementFingerprint(page, sel, url);
        if (fp) {
          fingerprints.set(sel.id, fp);
          captured++;
          capturedIds.add(sel.id);
          onProgress?.({ selectorId: sel.id, status: 'captured' });
        }
      } catch (e) {
        errors.push({
          selectorId: sel.id,
          rawValue: sel.rawValue,
          message: `Capture failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    await page.close();
  }

  // Phase 2: Retry uncaptured selectors on configured pages (auth, interactions)
  if (config.pages && config.pages.length > 0) {
    const uncaptured = selectors.filter((s) => !capturedIds.has(s.id));

    if (uncaptured.length > 0) {
      logger.info(
        { count: uncaptured.length, pages: config.pages.length },
        'Retrying uncaptured selectors on configured pages',
      );

      for (const pageConfig of config.pages) {
        const remaining = uncaptured.filter((s) => !capturedIds.has(s.id));
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
            'Evaluating on configured page',
          );

          for (const sel of remaining) {
            onProgress?.({ selectorId: sel.id, status: 'capturing' });
            try {
              const fp = await captureElementFingerprint(page, sel, currentUrl);
              if (fp) {
                fingerprints.set(sel.id, fp);
                captured++;
                capturedIds.add(sel.id);
                onProgress?.({ selectorId: sel.id, status: 'captured' });
              }
            } catch {
              // Silently skip — other pages may capture this selector
            }
          }

          await page.close();
        } catch (e) {
          logger.warn(
            {
              page: pageConfig.name ?? pageConfig.url,
              error: e instanceof Error ? e.message : String(e),
            },
            'Failed to set up configured page',
          );
        }
      }
    }
  }

  // Count remaining uncaptured as skipped (includes errored selectors)
  skipped = selectors.length - captured;

  // Emit a final "missed" for anything that never captured.
  for (const sel of selectors) {
    if (!capturedIds.has(sel.id)) onProgress?.({ selectorId: sel.id, status: 'missed' });
  }

  await context.close();
  await browser.close();

  const saveResult = saveFingerprints(projectRoot, fingerprints);
  if (saveResult.isErr()) {
    logger.error({ error: saveResult.error }, 'Failed to persist fingerprints');
  }

  return { captured, skipped, errors };
}

function resolveConfigPageUrl(url: string, config: HealerConfig): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const base = config.baseUrl.replace(/\/$/, '');
  const path = url.startsWith('/') ? url : `/${url}`;
  return `${base}${path}`;
}

function groupByUrl(
  selectors: SelectorUsage[],
  config: HealerConfig,
): Map<string, SelectorUsage[]> {
  const map = new Map<string, SelectorUsage[]>();

  for (const sel of selectors) {
    const url = resolvePageUrl(sel, config) ?? config.baseUrl;
    const list = map.get(url);
    if (list) {
      list.push(sel);
    } else {
      map.set(url, [sel]);
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
