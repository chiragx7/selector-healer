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
} from './fingerprint/index.js';
export type {
  CaptureResult,
  CaptureError,
  CaptureProgressEvent,
  CaptureProgress,
  StoreError,
} from './fingerprint/index.js';
export { verifySelectors, compareFingerprints } from './verifier/index.js';
export type { VerifyOptions, ComparisonResult, ComparisonDetail } from './verifier/index.js';
export {
  healSelectors,
  scoreCandidate,
  getScoringRules,
  scanCandidates,
  generateReplacementCode,
  bestSelectorType,
} from './healer/index.js';
export type { HealOptions, ScoreResult, ScoringRule, RuleScore } from './healer/index.js';
export { detectProjectConfig, renderConfigFile } from './init/index.js';
export type { ProjectDetection, GeneratedConfig } from './init/index.js';
