import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { createStatusBarItem, setIdle, setRunning, setResults, STATUS_MENU_COMMAND } = await import(
  '../src/status-bar.js'
);

function counts(overrides: Record<string, number> = {}) {
  return {
    ok: 0,
    broken: 0,
    multi: 0,
    skipped: 0,
    failed: 0,
    total: 0,
    healthPct: 0,
    ...overrides,
  };
}

describe('status-bar', () => {
  describe('createStatusBarItem', () => {
    it('opens the action menu on click', () => {
      const item = createStatusBarItem();
      expect(item.command).toBe(STATUS_MENU_COMMAND);
      expect(STATUS_MENU_COMMAND).toBe('selectorHealer.showMenu');
    });

    it('starts in idle state', () => {
      const item = createStatusBarItem();
      expect(item.text).toContain('Selector Healer');
    });
  });

  describe('setIdle', () => {
    it('shows shield + actions tooltip, no background', () => {
      const item = createStatusBarItem();
      setIdle(item);
      expect(item.text).toContain('$(shield)');
      expect(item.text).toContain('Selector Healer');
      expect(item.tooltip).toContain('actions');
      expect(item.backgroundColor).toBeUndefined();
    });
  });

  describe('setRunning', () => {
    it('shows a spinner', () => {
      const item = createStatusBarItem();
      setRunning(item);
      expect(item.text).toContain('$(sync~spin)');
      expect(item.text).toContain('Verifying');
      expect(item.backgroundColor).toBeUndefined();
    });
  });

  describe('setResults', () => {
    it('shows error state + background when broken', () => {
      const item = createStatusBarItem();
      setResults(item, counts({ ok: 8, broken: 2, total: 10, healthPct: 80 }));
      expect(item.text).toContain('$(error)');
      expect(item.text).toContain('2 broken');
      expect(item.backgroundColor).toBeDefined();
    });

    it('singular "selector" for exactly one broken', () => {
      const item = createStatusBarItem();
      setResults(item, counts({ ok: 9, broken: 1, total: 10, healthPct: 90 }));
      expect(item.text).toContain('1 broken selector');
      expect(item.text).not.toContain('selectors');
    });

    it('shows warning state when only ambiguous', () => {
      const item = createStatusBarItem();
      setResults(item, counts({ ok: 8, multi: 2, total: 10, healthPct: 80 }));
      expect(item.text).toContain('$(warning)');
      expect(item.text).toContain('ambiguous');
      expect(item.backgroundColor).toBeDefined();
    });

    it('shows health percentage when clean', () => {
      const item = createStatusBarItem();
      setResults(item, counts({ ok: 10, total: 10, healthPct: 100 }));
      expect(item.text).toContain('$(shield)');
      expect(item.text).toContain('100% healthy');
      expect(item.backgroundColor).toBeUndefined();
    });

    it('tooltip always offers the action menu', () => {
      const item = createStatusBarItem();
      setResults(item, counts({ ok: 10, total: 10, healthPct: 100 }));
      expect(item.tooltip).toContain('actions');
    });
  });
});
