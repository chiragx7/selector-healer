import { bestSelectorType, generateReplacementCode } from '../healer/replacement-code.js';
import type { DomFingerprint, Framework, SelectorType, SelectorUsage } from '../types.js';
import { type RobustnessTier, rateSelectorRobustness, rateSelectorType } from './robustness.js';

/** A sturdier alternative for a fragile selector, derived from a captured element. */
export interface SelectorUpgrade {
  /** Ready-to-paste replacement, e.g. `page.getByTestId('submit')`. */
  replacementCode: string;
  selectorType: SelectorType;
  tier: RobustnessTier;
}

/** A flagged fragile selector, optionally with a concrete upgrade. */
export interface LintFinding {
  selectorId: string;
  filePath: string;
  line: number;
  column: number;
  rawValue: string;
  selectorType: SelectorType;
  framework: Framework;
  tier: RobustnessTier;
  message: string;
  /** Present only when the captured element exposes a sturdier anchor. */
  upgrade?: SelectorUpgrade;
}

export interface LintOptions {
  /** Captured fingerprints, keyed by selector id, to enable DOM-backed upgrades. */
  fingerprints?: Map<string, DomFingerprint>;
  /** Fallback framework when a selector doesn't carry one. */
  framework?: Framework;
}

/**
 * Statically flag fragile selectors (visible text, structural CSS, XPath) and,
 * when a captured fingerprint is available, attach a concrete sturdier
 * replacement if the matched element exposes a better anchor (test-id, role…).
 *
 * Pure and DOM-free: pass `fingerprints` to enable upgrade suggestions.
 *
 * @param selectors - parsed selector usages to lint
 * @param options - optional fingerprints (for upgrades) and a fallback framework
 * @returns one finding per fragile selector, in input order
 *
 * @example
 * const findings = lintSelectors(selectors, { fingerprints });
 * for (const f of findings) console.log(f.message, f.upgrade?.replacementCode);
 */
export function lintSelectors(
  selectors: SelectorUsage[],
  options: LintOptions = {},
): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const sel of selectors) {
    const rating = rateSelectorRobustness(sel);
    if (rating.tier !== 'fragile') continue;

    const framework = sel.framework ?? options.framework ?? 'playwright';
    const finding: LintFinding = {
      selectorId: sel.id,
      filePath: sel.filePath,
      line: sel.line,
      column: sel.column,
      rawValue: sel.rawValue,
      selectorType: sel.selectorType,
      framework,
      tier: rating.tier,
      message: `${rating.reason}. Prefer getByRole or getByTestId.`,
    };

    const fingerprint = options.fingerprints?.get(sel.id);
    if (fingerprint) {
      const bestType = bestSelectorType(fingerprint);
      const bestRating = rateSelectorType(bestType);
      // Only suggest an upgrade if the captured element genuinely exposes a
      // sturdier anchor than the selector currently uses.
      if (bestRating.rank < rating.rank) {
        finding.upgrade = {
          replacementCode: generateReplacementCode(fingerprint, framework),
          selectorType: bestType,
          tier: bestRating.tier,
        };
      }
    }

    findings.push(finding);
  }

  return findings;
}
