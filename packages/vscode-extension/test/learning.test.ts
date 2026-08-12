import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HealerConfig, getFeedbackPath, loadFeedback } from '@selector-healer/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FeedbackMemento,
  feedbackForHeal,
  initLearning,
  recordLearning,
} from '../src/learning.js';

function makeMemento(): FeedbackMemento {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string, def: T): T {
      return map.has(key) ? (map.get(key) as T) : def;
    },
    update(key: string, value: unknown) {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

const cfg = (learning?: HealerConfig['learning']): HealerConfig =>
  ({ testDir: './t', baseUrl: 'http://x', learning }) as HealerConfig;

describe('learning store routing', () => {
  let root: string;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  it('committed store: writes the file (heal loads it, so feedbackForHeal is undefined)', () => {
    root = mkdtempSync(join(tmpdir(), 'sh-learn-'));
    initLearning(makeMemento());
    recordLearning(root, cfg({ store: 'committed' }), "page.getByTestId('x')", 'accepted');
    expect(existsSync(getFeedbackPath(root))).toBe(true);
    expect(loadFeedback(root)._unsafeUnwrap().byType.testid).toEqual({ accepted: 1, rejected: 0 });
    expect(feedbackForHeal(cfg({ store: 'committed' }))).toBeUndefined();
  });

  it('local store: writes the memento (no file) and feedbackForHeal returns it', () => {
    root = mkdtempSync(join(tmpdir(), 'sh-learn-'));
    initLearning(makeMemento());
    recordLearning(root, cfg({ store: 'local' }), "page.getByRole('button')", 'accepted');
    expect(existsSync(getFeedbackPath(root))).toBe(false);
    expect(feedbackForHeal(cfg({ store: 'local' }))?.byType.role).toEqual({
      accepted: 1,
      rejected: 0,
    });
  });

  it('disabled: records nothing and offers no feedback', () => {
    root = mkdtempSync(join(tmpdir(), 'sh-learn-'));
    initLearning(makeMemento());
    recordLearning(root, cfg({ enabled: false }), "page.getByTestId('x')", 'accepted');
    expect(existsSync(getFeedbackPath(root))).toBe(false);
    expect(feedbackForHeal(cfg({ enabled: false }))).toBeUndefined();
  });
});
