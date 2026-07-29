import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Uri,
  __getLastEdit,
  __reset,
  __setDocText,
  __setOpenShouldThrow,
} from './__mocks__/vscode.js';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { findUndoRange, undoHeal, HealHistoryStore } = await import('../src/history.js');

describe('findUndoRange', () => {
  const after = "getByTestId('save')";
  const entry = (over?: Partial<{ line: number; column: number; after: string }>) => ({
    line: 1,
    column: 12,
    after,
    ...over,
  });

  it('finds the healed text on the recorded line', () => {
    const lines = ["await page.getByTestId('save').click();"];
    expect(findUndoRange(lines, entry())).toEqual({
      kind: 'found',
      line: 0,
      startCol: 11,
      endCol: 30,
    });
  });

  it('finds it after the line shifted, via a unique whole-document search', () => {
    const lines = ['// a newly inserted comment', '', "await page.getByTestId('save').click();"];
    expect(findUndoRange(lines, entry())).toEqual({
      kind: 'found',
      line: 2,
      startCol: 11,
      endCol: 30,
    });
  });

  it('reports ambiguous when the healed text now appears more than once', () => {
    const lines = ["a getByTestId('save')", "b getByTestId('save')"];
    expect(findUndoRange(lines, entry({ line: 99 })).kind).toBe('ambiguous');
  });

  it('reports not-found when the healed text is gone', () => {
    const lines = ['await page.getByRole("button").click();'];
    expect(findUndoRange(lines, entry()).kind).toBe('not-found');
  });

  it('prefers the occurrence nearest the recorded column on a duplicated line', () => {
    const lines = ["a getByTestId('save') b getByTestId('save')"];
    // column 25 (0-indexed 24) sits on the second occurrence.
    expect(findUndoRange(lines, entry({ column: 25 }))).toEqual({
      kind: 'found',
      line: 0,
      startCol: 24,
      endCol: 43,
    });
  });
});

describe('HealHistoryStore', () => {
  const applied = { filePath: '/a.ts', line: 3, column: 5, before: 'X', after: 'Y' };

  it('records newest-first and reads entries back', async () => {
    const h = new HealHistoryStore();
    await h.record({ ...applied, label: 'X → Y' });
    await h.record({ ...applied, before: 'P', after: 'Q', label: 'P → Q' });

    const all = h.all();
    expect(all).toHaveLength(2);
    expect(all[0].label).toBe('P → Q');
    expect(all[1].label).toBe('X → Y');
    expect(h.latest()?.label).toBe('P → Q');
    expect(all[0].id).not.toBe(all[1].id);
  });

  it('removes a single entry by id', async () => {
    const h = new HealHistoryStore();
    const e = await h.record({ ...applied, label: 'X → Y' });
    await h.record({ ...applied, label: 'A → B' });
    await h.remove(e.id);

    const all = h.all();
    expect(all).toHaveLength(1);
    expect(all[0].label).toBe('A → B');
  });

  it('clears the whole history', async () => {
    const h = new HealHistoryStore();
    await h.record({ ...applied, label: 'X → Y' });
    await h.clear();
    expect(h.all()).toHaveLength(0);
  });

  it('caps the log at its maximum size, keeping the newest', async () => {
    const h = new HealHistoryStore();
    for (let i = 0; i < 55; i++) await h.record({ ...applied, label: `#${i}` });
    const all = h.all();
    expect(all.length).toBeLessThanOrEqual(50);
    expect(all[0].label).toBe('#54');
  });
});

describe('undoHeal', () => {
  const entry = {
    id: '1',
    appliedAt: 0,
    filePath: '/t.spec.ts',
    line: 1,
    column: 12,
    before: "getByRole('button')",
    after: "getByTestId('save')",
    label: "'button' → getByTestId('save')",
  };

  beforeEach(() => __reset());

  it('reverts the healed text back to the original', async () => {
    __setDocText("await page.getByTestId('save').click();");
    const res = await undoHeal(entry);
    expect(res).toEqual({ ok: true });

    const edit = __getLastEdit()?.getEdits()[0];
    expect(edit?.newText).toBe("getByRole('button')");
    expect(edit?.range.start.character).toBe(11);
    expect(edit?.range.end.character).toBe(30);
  });

  it('does not edit when the healed text can no longer be found', async () => {
    __setDocText('await page.click();');
    const res = await undoHeal(entry);
    expect(res).toEqual({ ok: false, reason: 'not-found' });
    expect(__getLastEdit()).toBeUndefined();
  });

  it('reports file-missing when the document cannot be opened', async () => {
    __setOpenShouldThrow(true);
    const res = await undoHeal(entry);
    expect(res).toEqual({ ok: false, reason: 'file-missing' });
  });
});
