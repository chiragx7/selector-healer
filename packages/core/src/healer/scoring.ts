import type { DomFingerprint } from '../types.js';

export interface ScoringRule {
  name: string;
  weight: number;
  /** Returns match quality in [0, 1]. 0 = no match, 1 = perfect match. */
  score: (stored: DomFingerprint, candidate: DomFingerprint) => number;
}

export interface RuleScore {
  name: string;
  /** Raw quality score in [0, 1]. */
  quality: number;
  /** Weighted contribution: quality × weight. */
  weighted: number;
}

const RULES: ScoringRule[] = [
  {
    name: 'data-testid match',
    weight: 0.3,
    score: (s, c) => {
      const sId = s.attributes['data-testid'] ?? s.attributes['data-test-id'];
      // -1 = not applicable: the original element had no test id, so this rule
      // has nothing to compare and must not dilute the overall score.
      if (sId === undefined) return -1;
      const cId = c.attributes['data-testid'] ?? c.attributes['data-test-id'];
      if (cId === undefined) return 0; // stored had a test id but the candidate lost it
      return sId === cId ? 1 : 0;
    },
  },
  {
    name: 'id attribute match',
    weight: 0.15,
    score: (s, c) => {
      if (!s.attributes.id) return -1; // not applicable: original element had no id
      if (!c.attributes.id) return 0; // stored had an id but the candidate lost it
      return s.attributes.id === c.attributes.id ? 1 : 0;
    },
  },
  {
    name: 'role match',
    weight: 0.1,
    score: (s, c) => {
      const sRole = s.attributes.role;
      if (!sRole) return -1; // not applicable: original element had no explicit role attr
      const cRole = c.attributes.role;
      if (!cRole) return 0; // stored had a role but the candidate lost it
      return sRole === cRole ? 1 : 0;
    },
  },
  {
    name: 'tag name match',
    weight: 0.08,
    score: (s, c) => (s.tagName === c.tagName ? 1 : 0),
  },
  {
    name: 'text similarity',
    weight: 0.1,
    score: (s, c) => textSimilarity(s.textContent, c.textContent),
  },
  {
    name: 'class overlap',
    weight: 0.07,
    score: (s, c) => {
      const sClasses = (s.attributes.class ?? '').split(/\s+/).filter(Boolean);
      const cClasses = (c.attributes.class ?? '').split(/\s+/).filter(Boolean);
      return jaccardSimilarity(sClasses, cClasses);
    },
  },
  {
    name: 'aria/accessibility match',
    weight: 0.05,
    score: (s, c) => {
      const keys = ['aria-label', 'aria-labelledby', 'aria-describedby', 'name', 'placeholder'];
      let matches = 0;
      let checked = 0;
      for (const key of keys) {
        const sVal = s.attributes[key];
        if (sVal === undefined) continue;
        checked++;
        if (sVal === c.attributes[key]) matches++;
      }
      // -1 signals "not applicable" — no aria attrs to compare
      return checked > 0 ? matches / checked : -1;
    },
  },
  {
    name: 'parent chain similarity',
    weight: 0.08,
    score: (s, c) => parentChainSimilarity(s.parentChain, c.parentChain),
  },
  {
    name: 'sibling position match',
    weight: 0.04,
    score: (s, c) => {
      if (s.siblingIndex === c.siblingIndex) return 1;
      const diff = Math.abs(s.siblingIndex - c.siblingIndex);
      if (diff === 1) return 0.5;
      if (diff <= 3) return 0.2;
      return 0;
    },
  },
  {
    name: 'attribute coverage',
    weight: 0.03,
    score: (s, c) => attributeCoverage(s.attributes, c.attributes),
  },
];

export interface ScoreResult {
  confidence: number;
  reasoning: string;
  matchedRules: string[];
  /** Per-rule breakdown of scores. */
  ruleScores: RuleScore[];
}

/**
 * Score a candidate element against a stored fingerprint using graduated
 * multi-signal comparison. Each rule returns a quality score in [0, 1]
 * that is multiplied by its weight. Final confidence is the sum, clamped
 * to [0, 1].
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
  let weightedSum = 0;
  let applicableWeight = 0;
  const matchedRules: string[] = [];
  const ruleScores: RuleScore[] = [];

  for (const rule of RULES) {
    const rawQuality = rule.score(stored, candidate);

    // -1 signals "not applicable" — rule has nothing meaningful to compare
    if (rawQuality < 0) {
      ruleScores.push({ name: rule.name, quality: 0, weighted: 0 });
      continue;
    }

    const quality = Math.min(1, Math.max(0, rawQuality));
    const weighted = quality * rule.weight;
    applicableWeight += rule.weight;
    weightedSum += weighted;
    ruleScores.push({ name: rule.name, quality, weighted });

    if (quality > 0) {
      matchedRules.push(rule.name);
    }
  }

  // Normalise by applicable weight so inapplicable rules don't penalise
  let confidence = applicableWeight > 0 ? weightedSum / applicableWeight : 0;
  confidence = Math.min(1, Math.max(0, confidence));

  const reasoning = buildReasoning(matchedRules, ruleScores, confidence);

  return { confidence, reasoning, matchedRules, ruleScores };
}

export function getScoringRules(): readonly ScoringRule[] {
  return RULES;
}

// ── Utility functions ──────────────────────────────────────────────────

/**
 * Compare text content with graduated scoring.
 * - Exact match → 1.0
 * - Substring containment → 0.8
 * - Fuzzy (normalised Levenshtein ≥ 0.5) → proportional
 * - Otherwise → 0
 */
function textSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();

  if (la === lb) return 1;
  if (lb.includes(la) || la.includes(lb)) return 0.8;

  const sim = normalizedLevenshtein(la, lb);
  return sim >= 0.5 ? sim : 0;
}

/**
 * Normalised Levenshtein similarity in [0, 1].
 * 1 = identical, 0 = completely different.
 */
function normalizedLevenshtein(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1, // deletion
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev[j - 1] ?? 0) + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  const distance = prev[n] ?? maxLen;
  return 1 - distance / maxLen;
}

/** Jaccard similarity of two string arrays: |A∩B| / |A∪B|. */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

type AncestorInfo = { tagName: string; id?: string; classes: string[]; role?: string };

/**
 * Compare parent chains from leaf (closest ancestor) outward, up to 3
 * levels deep with inverse-depth weighting.
 */
function parentChainSimilarity(sChain: AncestorInfo[], cChain: AncestorInfo[]): number {
  if (sChain.length === 0 || cChain.length === 0) return 0;

  const maxDepth = Math.min(sChain.length, cChain.length, 3);
  let score = 0;
  let totalWeight = 0;

  for (let i = 0; i < maxDepth; i++) {
    const sAnc = sChain[sChain.length - 1 - i];
    const cAnc = cChain[cChain.length - 1 - i];
    if (!sAnc || !cAnc) break;

    const depthWeight = 1 / (i + 1); // 1.0, 0.5, 0.33
    totalWeight += depthWeight;

    let ancestorScore = 0;
    if (sAnc.tagName === cAnc.tagName) ancestorScore += 0.4;
    if (sAnc.id && sAnc.id === cAnc.id) ancestorScore += 0.3;
    if (sAnc.role && sAnc.role === cAnc.role) ancestorScore += 0.2;
    ancestorScore += jaccardSimilarity(sAnc.classes, cAnc.classes) * 0.1;

    score += depthWeight * Math.min(1, ancestorScore);
  }

  return totalWeight > 0 ? score / totalWeight : 0;
}

/**
 * Fraction of stored semantic attributes present in the candidate.
 * Excludes 'class', 'id', 'style', 'data-testid', 'data-test-id' (scored
 * by dedicated rules).
 */
function attributeCoverage(
  stored: Record<string, string>,
  candidate: Record<string, string>,
): number {
  const skip = new Set(['class', 'id', 'style', 'data-testid', 'data-test-id', 'role']);
  const keys = Object.keys(stored).filter((k) => !skip.has(k));
  // -1 signals "not applicable" — no semantic attrs to compare
  if (keys.length === 0) return -1;

  let matches = 0;
  for (const key of keys) {
    if (candidate[key] === stored[key]) matches++;
  }
  return matches / keys.length;
}

function buildReasoning(
  matchedRules: string[],
  ruleScores: RuleScore[],
  confidence: number,
): string {
  if (matchedRules.length === 0) return 'No scoring rules matched';

  const parts = ruleScores
    .filter((rs) => rs.quality > 0)
    .map((rs) => {
      const pct = (rs.quality * 100).toFixed(0);
      return `${rs.name} ${pct}%`;
    });

  return `Matched: ${parts.join(', ')} → ${(confidence * 100).toFixed(0)}% confidence`;
}
