export * from './types.js';
export { parseTestFile, parseDirectory } from './parser/index.js';
export type { ParseError, DirectoryParseResult } from './parser/index.js';
export { extractSelectorsMultiFramework } from './parser/extract-selectors.js';
export { detectFramework, detectFrameworkFromPath } from './parser/frameworks/detect.js';
export {
  captureFingerprints,
  loadFingerprints,
  saveFingerprints,
  getStorePath,
  pruneFingerprints,
} from './fingerprint/index.js';
export type {
  CaptureResult,
  CaptureError,
  CaptureProgressEvent,
  CaptureProgress,
  StoreError,
  PruneResult,
} from './fingerprint/index.js';
export { verifySelectors, compareFingerprints } from './verifier/index.js';
export type { VerifyOptions, ComparisonResult, ComparisonDetail } from './verifier/index.js';
export {
  healSelectors,
  isNoOpReplacement,
  explainBreak,
  scoreCandidate,
  getScoringRules,
  scanCandidates,
  generateReplacementCode,
  renderSelectorCode,
  bestSelectorType,
  adjustConfidence,
  classifyReplacementType,
  emptyFeedback,
  getFeedbackPath,
  loadFeedback,
  recordOutcome,
  saveFeedback,
} from './healer/index.js';
export type { HealOptions, ScoreResult, ScoringRule, RuleScore } from './healer/index.js';
export type { AdjustedConfidence, FeedbackOutcome, SelectorFeedback } from './healer/index.js';
export { openHealerBrowser } from './playwright-loader.js';
export type { HealerBrowser } from './playwright-loader.js';
export { detectProjectConfig, renderConfigFile } from './init/index.js';
export type { ProjectDetection, GeneratedConfig } from './init/index.js';
export { rateSelectorRobustness, rateSelectorType, lintSelectors } from './lint/index.js';
export type {
  RobustnessTier,
  RobustnessRating,
  LintFinding,
  LintOptions,
  SelectorUpgrade,
} from './lint/index.js';
