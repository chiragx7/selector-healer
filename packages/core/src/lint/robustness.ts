import type { SelectorType, SelectorUsage } from '../types.js';

/**
 * How resilient a selector is to everyday app changes.
 * - `robust`   - survives text *and* markup changes (test-id, id/test-id CSS).
 * - `good`     - survives copy/markup changes (role, label).
 * - `moderate` - content-dependent but semantic (placeholder, title, alt).
 * - `fragile`  - breaks on routine changes (visible text, structural CSS, XPath).
 */
export type RobustnessTier = 'robust' | 'good' | 'moderate' | 'fragile';

export interface RobustnessRating {
  tier: RobustnessTier;
  /** 0 = most robust … 3 = most fragile. Lower is better; used to compare options. */
  rank: number;
  /** Human-readable justification, suitable for a lint message. */
  reason: string;
}

const TIER_RANK: Record<RobustnessTier, number> = {
  robust: 0,
  good: 1,
  moderate: 2,
  fragile: 3,
};

function rate(tier: RobustnessTier, reason: string): RobustnessRating {
  return { tier, rank: TIER_RANK[tier], reason };
}

/**
 * Rate a selector *kind* in the abstract (no value inspection).
 *
 * @param type - the selector API used
 * @returns the robustness rating for that kind
 *
 * @example
 * rateSelectorType('testid'); // { tier: 'robust', rank: 0, ... }
 */
export function rateSelectorType(type: SelectorType): RobustnessRating {
  switch (type) {
    case 'testid':
      return rate('robust', 'test-id - immune to text and markup changes');
    case 'role':
      return rate('good', 'role-based - survives copy and markup changes');
    case 'label':
      return rate('good', 'label-based - stable for form controls');
    case 'placeholder':
      return rate('moderate', 'placeholder text - changes with copy edits');
    case 'title':
      return rate('moderate', 'title attribute - content-dependent');
    case 'alt':
      return rate('moderate', 'alt text - content-dependent');
    case 'text':
      return rate('fragile', 'visible text - breaks on any copy change');
    case 'xpath':
      return rate('fragile', 'XPath - brittle to DOM structure changes');
    case 'css':
      return rate('fragile', 'CSS selector - brittle to class/structure changes');
    default:
      return rate('fragile', 'unrecognized selector kind');
  }
}

/**
 * Rate a concrete selector usage. CSS is inspected by value - an id or
 * test-id attribute selector is treated as sturdy, while class/structural
 * selectors are fragile.
 *
 * @param selector - the parsed selector usage
 * @returns its robustness rating
 *
 * @example
 * rateSelectorRobustness({ selectorType: 'css', rawValue: '[data-testid="x"]', ... });
 * // { tier: 'robust', ... }
 */
export function rateSelectorRobustness(selector: SelectorUsage): RobustnessRating {
  if (selector.selectorType === 'css') return rateCssValue(selector.rawValue);
  return rateSelectorType(selector.selectorType);
}

function rateCssValue(value: string): RobustnessRating {
  const v = value.trim();
  // Targeting a dedicated test attribute is as sturdy as getByTestId.
  if (/\[\s*data-(testid|test-id|test|qa|cy|cypress)\b/i.test(v)) {
    return rate('robust', 'CSS targeting a test attribute');
  }
  // A bare id selector (#id) - sturdy as long as the id is not generated.
  if (/^#[A-Za-z_][\w-]*$/.test(v)) {
    return rate('good', 'CSS id selector');
  }
  return rate('fragile', 'CSS selector - brittle to class/structure changes');
}
