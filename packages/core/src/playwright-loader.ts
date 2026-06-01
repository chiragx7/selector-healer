import type { Browser } from 'playwright';
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
 * so we resolve it from the project being tested — where the user already has
 * `playwright` (or `playwright-core` via `@playwright/test`) installed. Falls
 * back to default resolution for the CLI and core tests.
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
  for (const pkg of ['playwright', 'playwright-core']) {
    const mod = await resolveFrom(projectRoot, pkg);
    if (mod) return mod;
  }
  try {
    return (await import('playwright')) as unknown as PlaywrightModule;
  } catch {
    throw new Error(
      'Playwright is not installed. Install it in your project: npm install -D playwright',
    );
  }
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
