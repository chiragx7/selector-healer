import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DomFingerprint,
  type HealerConfig,
  type RobustnessTier,
  type SelectorType,
  type SelectorUsage,
  loadFingerprints,
  parseDirectory,
  pruneFingerprints,
  rateSelectorRobustness,
  rateSelectorType,
} from '@selector-healer/core';

/** One point in the health-over-time trend (persisted per workspace). */
export interface HealthPoint {
  /** Epoch ms when the verify completed. */
  at: number;
  /** Health percentage recorded at that run. */
  healthPct: number;
}

/** One selector-kind row in the composition breakdown. */
export interface CompositionRow {
  type: SelectorType;
  /** Human label, e.g. `getByTestId` or `locator (css)`. */
  label: string;
  count: number;
  /** Kind-level robustness tier, for the bar colour. */
  tier: RobustnessTier;
}

/** Tally of selectors by robustness tier (value-aware for CSS). */
export interface RobustnessSummary {
  robust: number;
  good: number;
  moderate: number;
  fragile: number;
  total: number;
  /** Share of sturdy selectors (robust + good) as a 0–100 percentage. */
  sturdyPct: number;
}

/** The IO-backed "static" half of the dashboard Overview (health comes from live state). */
export interface OverviewData {
  project: {
    name: string;
    framework: string;
    frameworkVersion?: string;
    browser: string;
    headless: boolean;
    baseUrl: string;
    testDir: string;
  };
  baseline: {
    total: number;
    live: number;
    stale: number;
    /**
     * Whether `stale` is trustworthy. False when the parse was incomplete or found
     * no selectors - in which case pruning would over-count, so we don't show a
     * stale figure or offer Prune. Mirrors the prune command's safety guard.
     */
    staleKnown: boolean;
  };
  composition: CompositionRow[];
  robustness: RobustnessSummary;
  /** Captured pages, most selectors first. */
  pages: { url: string; count: number }[];
  /** Health-over-time, oldest first. */
  trend: HealthPoint[];
  /** Cumulative heal activity. */
  activity: { applied: number };
}

/** Display label for a selector kind. */
const TYPE_LABEL: Record<SelectorType, string> = {
  testid: 'getByTestId',
  role: 'getByRole',
  label: 'getByLabel',
  placeholder: 'getByPlaceholder',
  title: 'getByTitle',
  alt: 'getByAltText',
  text: 'getByText',
  css: 'locator (css)',
  xpath: 'locator (xpath)',
  unknown: 'other',
};

/** npm package that carries the version we report for each framework. */
const FRAMEWORK_PACKAGE: Record<string, string> = {
  playwright: '@playwright/test',
  cypress: 'cypress',
  webdriverio: 'webdriverio',
  testcafe: 'testcafe',
};

/**
 * Read the installed version of a framework from the project's `package.json`
 * (dev or prod deps), stripping any range prefix. Best-effort - returns
 * undefined if the file is missing/unreadable or the dep isn't listed.
 */
function frameworkVersion(root: string, framework: string): string | undefined {
  const pkgName = FRAMEWORK_PACKAGE[framework];
  if (!pkgName) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const raw = pkg.devDependencies?.[pkgName] ?? pkg.dependencies?.[pkgName];
    return raw?.replace(/^[\^~>=<\s]+/, '') || undefined;
  } catch {
    return undefined;
  }
}

/** Selector composition, ordered by count (desc), then label for stability. */
function composition(selectors: readonly SelectorUsage[]): CompositionRow[] {
  const counts = new Map<SelectorType, number>();
  for (const s of selectors) counts.set(s.selectorType, (counts.get(s.selectorType) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({
      type,
      label: TYPE_LABEL[type] ?? type,
      count,
      tier: rateSelectorType(type).tier,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Value-aware robustness tally across all selectors. */
function robustness(selectors: readonly SelectorUsage[]): RobustnessSummary {
  const tally = { robust: 0, good: 0, moderate: 0, fragile: 0 };
  for (const s of selectors) tally[rateSelectorRobustness(s).tier]++;
  const total = selectors.length;
  const sturdy = tally.robust + tally.good;
  return { ...tally, total, sturdyPct: total > 0 ? Math.round((sturdy / total) * 100) : 0 };
}

/** Captured pages by fingerprint count, most first. */
function pageBreakdown(
  fingerprints: Map<string, DomFingerprint>,
): { url: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const fp of fingerprints.values()) {
    counts.set(fp.pageUrl, (counts.get(fp.pageUrl) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count || a.url.localeCompare(b.url));
}

/**
 * Assemble the IO-backed half of the dashboard Overview: project + tooling,
 * baseline live/stale, selector composition, robustness distribution, per-page
 * breakdown, and the health trend. Pure of VS Code so it can be unit-tested;
 * the caller supplies the resolved config, workspace root, and persisted trend.
 *
 * Stale is computed with {@link pruneFingerprints}, but only trusted when the
 * parse was complete and non-empty - otherwise `baseline.staleKnown` is false
 * and no stale figure is shown (a misconfigured `testDir` must not read as
 * "everything is stale").
 *
 * @param config - the resolved healer config (its `testDir` already absolute)
 * @param root - absolute workspace root
 * @param trend - persisted health-over-time points, oldest first
 * @param healsApplied - cumulative count of heals applied (from heal history)
 * @returns the Overview payload
 *
 * @example
 * const data = buildOverview(config, root, healthTrend.all(), healHistory.all().length);
 */
export function buildOverview(
  config: HealerConfig,
  root: string,
  trend: HealthPoint[],
  healsApplied = 0,
): OverviewData {
  const parsed = parseDirectory(config.testDir, config.testGlob);
  const selectors = parsed.isOk() ? parsed.value.selectors : [];
  const parseErrors = parsed.isOk() ? parsed.value.errors.length : 1;

  const loaded = loadFingerprints(root);
  const fingerprints = loaded.isOk() ? loaded.value : new Map<string, DomFingerprint>();

  // Only trust a stale count when the selector list is complete and non-empty -
  // the same guard the prune command applies before deleting anything.
  const staleKnown = parseErrors === 0 && selectors.length > 0;
  const { removed } = pruneFingerprints(fingerprints, selectors, root);
  const stale = staleKnown ? removed.length : 0;
  const total = fingerprints.size;

  const name = root.split(/[/\\]/).filter(Boolean).pop() ?? 'project';
  const framework = config.framework ?? 'playwright';

  return {
    project: {
      name,
      framework,
      frameworkVersion: frameworkVersion(root, framework),
      browser: config.browser ?? 'chromium',
      headless: config.headless ?? true,
      baseUrl: config.baseUrl,
      testDir: config.testDir,
    },
    baseline: { total, live: total - stale, stale, staleKnown },
    composition: composition(selectors),
    robustness: robustness(selectors),
    pages: pageBreakdown(fingerprints),
    trend,
    activity: { applied: healsApplied },
  };
}
