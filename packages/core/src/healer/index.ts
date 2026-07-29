export { healSelectors, isNoOpReplacement } from './heal.js';
export type { HealOptions } from './heal.js';
export { scoreCandidate, getScoringRules } from './scoring.js';
export type { ScoreResult, ScoringRule, RuleScore } from './scoring.js';
export { scanCandidates } from './candidates.js';
export { explainBreak } from './explain.js';
export {
  generateReplacementCode,
  renderSelectorCode,
  bestSelectorType,
} from './replacement-code.js';
