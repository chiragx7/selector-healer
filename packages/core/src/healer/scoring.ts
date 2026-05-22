import type { DomFingerprint } from '../types.js';

export interface ScoringRule {
  name: string;
  weight: number;
  match: (stored: DomFingerprint, candidate: DomFingerprint) => boolean;
}

const RULES: ScoringRule[] = [
  {
    name: 'data-testid match',
    weight: 0.35,
    match: (s, c) => {
      const sId = s.attributes['data-testid'] ?? s.attributes['data-test-id'];
      const cId = c.attributes['data-testid'] ?? c.attributes['data-test-id'];
      return sId !== undefined && sId === cId;
    },
  },
  {
    name: 'id attribute match',
    weight: 0.2,
    match: (s, c) => s.attributes.id !== undefined && s.attributes.id === c.attributes.id,
  },
  {
    name: 'tag name match',
    weight: 0.1,
    match: (s, c) => s.tagName === c.tagName,
  },
  {
    name: 'role match',
    weight: 0.15,
    match: (s, c) => {
      const sRole = s.attributes.role;
      const cRole = c.attributes.role;
      return sRole !== undefined && sRole === cRole;
    },
  },
  {
    name: 'text content match',
    weight: 0.1,
    match: (s, c) => {
      if (s.textContent.length === 0 || c.textContent.length === 0) return false;
      return (
        s.textContent === c.textContent ||
        c.textContent.includes(s.textContent) ||
        s.textContent.includes(c.textContent)
      );
    },
  },
  {
    name: 'parent structure match',
    weight: 0.05,
    match: (s, c) => {
      if (s.parentChain.length === 0 || c.parentChain.length === 0) return false;
      const sLeaf = s.parentChain[s.parentChain.length - 1];
      const cLeaf = c.parentChain[c.parentChain.length - 1];
      return sLeaf?.tagName === cLeaf?.tagName && sLeaf?.id === cLeaf?.id;
    },
  },
  {
    name: 'sibling position match',
    weight: 0.05,
    match: (s, c) => s.siblingIndex === c.siblingIndex,
  },
];

export interface ScoreResult {
  confidence: number;
  reasoning: string;
  matchedRules: string[];
}

/**
 * Score a candidate element against a stored fingerprint.
 *
 * @param stored - The baseline fingerprint of the original element.
 * @param candidate - A fingerprint captured from a candidate element on the current page.
 * @returns Score result with confidence in [0, 1] and human-readable reasoning.
 *
 * @example
 * ```ts
 * const result = scoreCandidate(storedFingerprint, candidateFingerprint);
 * if (result.confidence > 0.7) { ... }
 * ```
 */
export function scoreCandidate(stored: DomFingerprint, candidate: DomFingerprint): ScoreResult {
  let confidence = 0;
  const matchedRules: string[] = [];

  for (const rule of RULES) {
    if (rule.match(stored, candidate)) {
      confidence += rule.weight;
      matchedRules.push(rule.name);
    }
  }

  confidence = Math.min(1, Math.max(0, confidence));

  const reasoning =
    matchedRules.length > 0
      ? `Matched: ${matchedRules.join(', ')} (${(confidence * 100).toFixed(0)}%)`
      : 'No scoring rules matched';

  return { confidence, reasoning, matchedRules };
}

export function getScoringRules(): readonly ScoringRule[] {
  return RULES;
}
