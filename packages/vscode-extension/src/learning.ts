import {
  type FeedbackOutcome,
  type HealerConfig,
  type SelectorFeedback,
  classifyReplacementType,
  emptyFeedback,
  loadFeedback,
  recordOutcome,
  saveFeedback,
} from '@selector-healer/core';

/** Minimal persistence surface - satisfied by `vscode.Memento` (workspaceState). */
export interface FeedbackMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const STORAGE_KEY = 'selectorHealer.feedback';

const noopStore: FeedbackMemento = {
  get: (_key, defaultValue) => defaultValue,
  update: async () => {},
};

/** Backs the `'local'` (per-developer) store; the `'committed'` store is the file. */
let store: FeedbackMemento = noopStore;

/** Wire in real workspace storage on activation (for the `'local'` store). */
export function initLearning(memento: FeedbackMemento): void {
  store = memento;
}

function mode(config: HealerConfig): { on: boolean; local: boolean } {
  return {
    on: config.learning?.enabled !== false,
    local: config.learning?.store === 'local',
  };
}

/**
 * Feedback to hand `healSelectors`. Supplied only for the `'local'` store (kept
 * in the editor); the `'committed'` store is loaded by core from the file, and a
 * disabled/committed setup returns undefined so heal resolves it itself.
 */
export function feedbackForHeal(config: HealerConfig): SelectorFeedback | undefined {
  const { on, local } = mode(config);
  if (!on || !local) return undefined;
  return store.get<SelectorFeedback>(STORAGE_KEY, emptyFeedback());
}

/**
 * Record one accept/reject for the selector kind a fix's code uses, into whichever
 * store the config selects. No-op when learning is disabled; best-effort on write.
 */
export function recordLearning(
  root: string,
  config: HealerConfig,
  code: string,
  outcome: FeedbackOutcome,
): void {
  recordLearningBatch(root, config, [code], outcome);
}

/**
 * Record many outcomes at once with a single store read+write - used by Apply-All
 * so a batch of N fixes isn't N read/serialize/write round-trips on the file.
 */
export function recordLearningBatch(
  root: string,
  config: HealerConfig,
  codes: string[],
  outcome: FeedbackOutcome,
): void {
  const { on, local } = mode(config);
  if (!on || codes.length === 0) return;
  const applyAll = (fb: SelectorFeedback): SelectorFeedback => {
    let next = fb;
    for (const code of codes) next = recordOutcome(next, classifyReplacementType(code), outcome);
    return next;
  };
  if (local) {
    void store.update(STORAGE_KEY, applyAll(store.get(STORAGE_KEY, emptyFeedback())));
  } else {
    saveFeedback(root, applyAll(loadFeedback(root).unwrapOr(emptyFeedback()))); // best-effort
  }
}
