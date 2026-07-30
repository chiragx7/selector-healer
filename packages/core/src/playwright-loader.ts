import type { Browser, BrowserContext } from 'playwright';
import type { HealerConfig } from './types.js';

/** Minimal shape of the Playwright module we use (browser launchers). */
export interface PlaywrightModule {
  chromium: { launch(opts?: Record<string, unknown>): Promise<Browser> };
  firefox: { launch(opts?: Record<string, unknown>): Promise<Browser> };
  webkit: { launch(opts?: Record<string, unknown>): Promise<Browser> };
}

/**
 * Load Playwright, preferring the **target project's** installation.
 *
 * A bundled/published VS Code extension does not ship Playwright (it's huge),
 * so we resolve it from the project being tested. We try, in order, the three
 * ways a project exposes the browser launchers: `playwright`, `playwright-core`,
 * and `@playwright/test` — the last is what `npm init playwright` installs and
 * the most common in real projects, and it re-exports `chromium`/`firefox`/
 * `webkit` all the same. Falls back to default resolution for the CLI and core tests.
 *
 * @param projectRoot - absolute path of the project whose node_modules to search
 * @returns the Playwright module (browser launchers)
 * @throws if Playwright cannot be found anywhere
 *
 * @example
 * const pw = await loadPlaywright('/repo/my-app');
 * const browser = await pw.chromium.launch();
 */
export async function loadPlaywright(projectRoot: string): Promise<PlaywrightModule> {
  for (const pkg of ['playwright', 'playwright-core', '@playwright/test']) {
    const mod = await resolveFrom(projectRoot, pkg);
    if (mod) return mod;
  }
  for (const pkg of ['playwright', '@playwright/test']) {
    try {
      const mod = (await import(pkg)) as unknown as PlaywrightModule;
      if (mod?.chromium) return mod;
    } catch {
      // try the next fallback
    }
  }
  throw new Error(
    'Playwright is not installed in this project. Add it with your package manager — ' +
      'e.g. `npm install -D @playwright/test` (or the pnpm/yarn equivalent) — ' +
      'then run `npx playwright install` to download the browsers.',
  );
}

async function resolveFrom(
  projectRoot: string,
  pkg: string,
): Promise<PlaywrightModule | undefined> {
  try {
    const { createRequire } = await import('node:module');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    // Anchor resolution at the project root so node_modules there is searched.
    const req = createRequire(pathToFileURL(join(projectRoot, 'package.json')).href);
    const mod = req(pkg) as PlaywrightModule | undefined;
    return mod?.chromium ? mod : undefined;
  } catch {
    return undefined;
  }
}

/** Launch the configured browser (chromium by default). */
export async function launchBrowser(pw: PlaywrightModule, config: HealerConfig): Promise<Browser> {
  const browserType = config.browser ?? 'chromium';
  return pw[browserType].launch({ headless: config.headless ?? true });
}

/** A reusable browser session: an open context plus a `close()` that tears down both. */
export interface HealerBrowser {
  context: BrowserContext;
  close(): Promise<void>;
}

/**
 * Open a browser context for **repeated** verify/heal runs (e.g. the VS Code
 * watch session). Launches the configured browser, creates a context, and
 * applies `globalSetup` once. Pass the returned `context` to
 * {@link verifySelectors}/{@link healSelectors} to skip the ~1s cold launch on
 * every run; call `close()` when done (e.g. when watch mode is turned off).
 *
 * @param config - healer config (browser, headless, globalSetup)
 * @param projectRoot - project whose Playwright install to resolve
 * @returns the open context and a `close()` that disposes the context + browser
 *
 * @example
 * const session = await openHealerBrowser(config, root);
 * await verifySelectors(sels, { config, projectRoot: root, context: session.context });
 * await session.close();
 */
export async function openHealerBrowser(
  config: HealerConfig,
  projectRoot: string,
): Promise<HealerBrowser> {
  const pw = await loadPlaywright(projectRoot);
  const browser = await launchBrowser(pw, config);
  const context = await browser.newContext();
  if (config.globalSetup) {
    await config.globalSetup(context);
  }
  return {
    context,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
