import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Position,
  Range,
  Uri,
  __getExecutedCommands,
  __getLastEdit,
  __reset,
  __setDocText,
  __setInfoChoice,
} from './__mocks__/vscode.js';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { spliceText, previewAndApplyHeal, HealPreviewProvider } = await import('../src/preview.js');

describe('spliceText', () => {
  it('replaces the [start, end) slice with the replacement', () => {
    expect(spliceText('a(x)b', 1, 4, 'y')).toBe('ayb');
  });

  it('swaps a selector call within a line of source', () => {
    const line = "  await page.getByRole('button').click();";
    const call = "getByRole('button')";
    const start = line.indexOf(call);
    const out = spliceText(line, start, start + call.length, "getByTestId('save')");
    expect(out).toBe("  await page.getByTestId('save').click();");
  });

  it('inserts at a zero-width range', () => {
    expect(spliceText('abc', 3, 3, 'd')).toBe('abcd');
  });

  it('replaces the entire string', () => {
    expect(spliceText('old', 0, 3, 'new')).toBe('new');
  });
});

describe('previewAndApplyHeal', () => {
  // `getByRole('button')` spans columns 11..30 of this single line.
  const LINE = "await page.getByRole('button').click();";
  const call = () => new Range(new Position(0, 11), new Position(0, 30));

  beforeEach(() => __reset());

  it('opens a diff and applies the edit when confirmed', async () => {
    __setDocText(LINE);
    __setInfoChoice('Apply');
    const applied = await previewAndApplyHeal(
      new HealPreviewProvider(),
      Uri.file('/t.spec.ts'),
      call(),
      "getByTestId('save')",
      'button → getByTestId',
    );
    expect(applied).toBe(true);
    expect(__getExecutedCommands().some((c) => c.command === 'vscode.diff')).toBe(true);
    expect(__getLastEdit()?.getEdits()[0]?.newText).toBe("getByTestId('save')");
  });

  it('does not apply when the user dismisses', async () => {
    __setDocText(LINE);
    __setInfoChoice('Dismiss');
    const applied = await previewAndApplyHeal(
      new HealPreviewProvider(),
      Uri.file('/t.spec.ts'),
      call(),
      "getByTestId('save')",
      'label',
    );
    expect(applied).toBe(false);
    expect(__getLastEdit()).toBeUndefined();
  });

  it('serves the healed text as the diff preview content', async () => {
    __setDocText(LINE);
    __setInfoChoice('Dismiss');
    const provider = new HealPreviewProvider();
    await previewAndApplyHeal(provider, Uri.file('/t.spec.ts'), call(), "getByTestId('save')", 'x');
    const previewUri = Uri.file('/t.spec.ts').with({ scheme: 'selector-healer-preview' });
    expect(provider.provideTextDocumentContent(previewUri)).toBe(
      "await page.getByTestId('save').click();",
    );
  });
});
