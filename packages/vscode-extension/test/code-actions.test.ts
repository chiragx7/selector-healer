import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const {
  storeSuggestions,
  clearSuggestions,
  SelectorHealerCodeActionProvider,
  stripLeadingReceiver,
} = await import('../src/code-actions.js');
const { lintDiagnostics, clearLintUpgrades } = await import('../src/lint.js');
const vscode = await import('./__mocks__/vscode.js');

function makeSuggestion(overrides: Record<string, unknown> = {}) {
  return {
    selectorId: 'sel_001',
    filePath: '/test/login.spec.ts',
    line: 10,
    column: 5,
    rawValue: '#submit-btn',
    replacementCode: 'getByTestId("submit")',
    confidence: 0.92,
    ...overrides,
  };
}

describe('code-actions', () => {
  beforeEach(() => {
    clearSuggestions();
    clearLintUpgrades();
  });

  describe('storeSuggestions / clearSuggestions', () => {
    it('stores suggestions grouped by file:line key', () => {
      storeSuggestions([
        makeSuggestion({ line: 10 }),
        makeSuggestion({ line: 10, confidence: 0.7, replacementCode: 'getByRole("button")' }),
        makeSuggestion({ line: 20, selectorId: 'sel_002' }),
      ]);

      // We can verify by asking the provider for actions
      const provider = new SelectorHealerCodeActionProvider();
      const mockDoc = {
        uri: vscode.Uri.file('/test/login.spec.ts'),
        languageId: 'typescript',
        lineAt: (line: number) => ({
          text: '  await page.locator("#submit-btn").click();',
        }),
      };

      const context = {
        diagnostics: [
          {
            source: 'selector-healer',
            code: 'broken',
            range: new vscode.Range(new vscode.Position(9, 4), new vscode.Position(9, 15)),
          },
        ],
      };

      const actions = provider.provideCodeActions(
        mockDoc as unknown as vscode.TextDocument,
        new vscode.Range(new vscode.Position(9, 0), new vscode.Position(9, 0)),
        context as unknown as { diagnostics: vscode.Diagnostic[] },
      );

      expect(actions.length).toBe(2);
    });

    it('clearSuggestions removes all stored suggestions', () => {
      storeSuggestions([makeSuggestion()]);
      clearSuggestions();

      const provider = new SelectorHealerCodeActionProvider();
      const mockDoc = {
        uri: vscode.Uri.file('/test/login.spec.ts'),
        languageId: 'typescript',
        lineAt: () => ({ text: '  page.locator("#submit-btn")' }),
      };

      const context = {
        diagnostics: [
          {
            source: 'selector-healer',
            code: 'broken',
            range: new vscode.Range(new vscode.Position(9, 4), new vscode.Position(9, 15)),
          },
        ],
      };

      const actions = provider.provideCodeActions(
        mockDoc as unknown as vscode.TextDocument,
        new vscode.Range(new vscode.Position(9, 0), new vscode.Position(9, 0)),
        context as unknown as { diagnostics: vscode.Diagnostic[] },
      );

      expect(actions.length).toBe(0);
    });
  });

  describe('SelectorHealerCodeActionProvider', () => {
    it('provides QuickFix code action kind', () => {
      expect(SelectorHealerCodeActionProvider.providedCodeActionKinds).toContain(
        vscode.CodeActionKind.QuickFix,
      );
    });

    it('ignores diagnostics from other sources', () => {
      storeSuggestions([makeSuggestion()]);

      const provider = new SelectorHealerCodeActionProvider();
      const mockDoc = {
        uri: vscode.Uri.file('/test/login.spec.ts'),
        languageId: 'typescript',
        lineAt: () => ({ text: '  page.locator("#submit-btn")' }),
      };

      const context = {
        diagnostics: [
          {
            source: 'eslint',
            code: 'broken',
            range: new vscode.Range(new vscode.Position(9, 4), new vscode.Position(9, 15)),
          },
        ],
      };

      const actions = provider.provideCodeActions(
        mockDoc as unknown as vscode.TextDocument,
        new vscode.Range(new vscode.Position(9, 0), new vscode.Position(9, 0)),
        context as unknown as { diagnostics: vscode.Diagnostic[] },
      );

      expect(actions.length).toBe(0);
    });

    it('ignores non-broken diagnostics', () => {
      storeSuggestions([makeSuggestion()]);

      const provider = new SelectorHealerCodeActionProvider();
      const mockDoc = {
        uri: vscode.Uri.file('/test/login.spec.ts'),
        languageId: 'typescript',
        lineAt: () => ({ text: '  page.locator("#submit-btn")' }),
      };

      const context = {
        diagnostics: [
          {
            source: 'selector-healer',
            code: 'no-baseline',
            range: new vscode.Range(new vscode.Position(9, 4), new vscode.Position(9, 15)),
          },
        ],
      };

      const actions = provider.provideCodeActions(
        mockDoc as unknown as vscode.TextDocument,
        new vscode.Range(new vscode.Position(9, 0), new vscode.Position(9, 0)),
        context as unknown as { diagnostics: vscode.Diagnostic[] },
      );

      expect(actions.length).toBe(0);
    });

    it('marks high-confidence suggestions as preferred', () => {
      storeSuggestions([
        makeSuggestion({ confidence: 0.95 }),
        makeSuggestion({ confidence: 0.5, replacementCode: 'getByRole("button")' }),
      ]);

      const provider = new SelectorHealerCodeActionProvider();
      const mockDoc = {
        uri: vscode.Uri.file('/test/login.spec.ts'),
        languageId: 'typescript',
        lineAt: () => ({ text: '  await page.locator("#submit-btn").click();' }),
      };

      const context = {
        diagnostics: [
          {
            source: 'selector-healer',
            code: 'broken',
            range: new vscode.Range(new vscode.Position(9, 4), new vscode.Position(9, 15)),
          },
        ],
      };

      const actions = provider.provideCodeActions(
        mockDoc as unknown as vscode.TextDocument,
        new vscode.Range(new vscode.Position(9, 0), new vscode.Position(9, 0)),
        context as unknown as { diagnostics: vscode.Diagnostic[] },
      );

      expect(actions[0]?.isPreferred).toBe(true);
      expect(actions[1]?.isPreferred).toBe(false);
    });

    it('shows confidence percentage in action title', () => {
      storeSuggestions([makeSuggestion({ confidence: 0.87 })]);

      const provider = new SelectorHealerCodeActionProvider();
      const mockDoc = {
        uri: vscode.Uri.file('/test/login.spec.ts'),
        languageId: 'typescript',
        lineAt: () => ({ text: '  page.locator("#submit-btn").click()' }),
      };

      const context = {
        diagnostics: [
          {
            source: 'selector-healer',
            code: 'broken',
            range: new vscode.Range(new vscode.Position(9, 4), new vscode.Position(9, 15)),
          },
        ],
      };

      const actions = provider.provideCodeActions(
        mockDoc as unknown as vscode.TextDocument,
        new vscode.Range(new vscode.Position(9, 0), new vscode.Position(9, 0)),
        context as unknown as { diagnostics: vscode.Diagnostic[] },
      );

      expect(actions[0]?.title).toContain('87%');
      expect(actions[0]?.title).toContain('getByTestId("submit")');
    });

    it('creates workspace edit with correct replacement', () => {
      storeSuggestions([makeSuggestion({ confidence: 0.9 })]);

      const provider = new SelectorHealerCodeActionProvider();
      const lineText = '  await page.locator("#submit-btn").click();';
      const mockDoc = {
        uri: vscode.Uri.file('/test/login.spec.ts'),
        languageId: 'typescript',
        lineAt: () => ({ text: lineText }),
      };

      const context = {
        diagnostics: [
          {
            source: 'selector-healer',
            code: 'broken',
            range: new vscode.Range(
              new vscode.Position(9, 14), // column inside locator("...")
              new vscode.Position(9, 25),
            ),
          },
        ],
      };

      const actions = provider.provideCodeActions(
        mockDoc as unknown as vscode.TextDocument,
        new vscode.Range(new vscode.Position(9, 0), new vscode.Position(9, 0)),
        context as unknown as { diagnostics: vscode.Diagnostic[] },
      );

      expect(actions[0]?.edit).toBeDefined();
    });

    it('offers a sturdier-locator quick-fix for a fragile selector', () => {
      const file = '/test/login.spec.ts';
      const lineText = "  await this.page.getByText('Forgot your password?').click();";
      const col = lineText.indexOf('Forgot');
      const line1 = 8; // 1-based source line

      // Populate the upgrade store the way the extension does, via the lint module.
      lintDiagnostics(
        file,
        [
          {
            id: 'frag1',
            filePath: file,
            line: line1,
            column: col + 1,
            selectorType: 'text',
            rawValue: 'Forgot your password?',
          },
        ],
        new Map([
          [
            'frag1',
            {
              selectorId: 'frag1',
              capturedAt: '',
              tagName: 'a',
              attributes: { 'data-testid': 'forgot' },
              textContent: 'Forgot your password?',
              parentChain: [],
              siblingIndex: 0,
              pageUrl: '',
            },
          ],
        ]),
      );

      const provider = new SelectorHealerCodeActionProvider();
      const mockDoc = {
        uri: vscode.Uri.file(file),
        languageId: 'typescript',
        lineAt: () => ({ text: lineText }),
      };
      const context = {
        diagnostics: [
          {
            source: 'selector-healer',
            code: 'fragile-selector',
            range: new vscode.Range(
              new vscode.Position(line1 - 1, col),
              new vscode.Position(line1 - 1, col + 'Forgot your password?'.length),
            ),
          },
        ],
      };

      const actions = provider.provideCodeActions(
        mockDoc as unknown as vscode.TextDocument,
        new vscode.Range(new vscode.Position(line1 - 1, 0), new vscode.Position(line1 - 1, 0)),
        context as unknown as { diagnostics: vscode.Diagnostic[] },
      );

      expect(actions.length).toBe(1);
      expect(actions[0]?.title).toContain("getByTestId('forgot')");
      expect(actions[0]?.title).toContain('sturdier');
      const edits = (actions[0]?.edit as vscode.WorkspaceEdit).getEdits();
      // Receiver stripped, so `this.page.` is preserved (not duplicated).
      expect(edits[0]?.newText).toBe("getByTestId('forgot')");
    });
  });

  describe('stripLeadingReceiver', () => {
    it('drops a leading page. receiver so it is not duplicated', () => {
      // The call range begins after `this.page.`, so the replacement must not
      // carry its own `page.` — else we get `this.page.page.getByText(...)`.
      expect(stripLeadingReceiver("page.getByText('Login')")).toBe("getByText('Login')");
      expect(stripLeadingReceiver("page.getByRole('button', { name: 'Login' })")).toBe(
        "getByRole('button', { name: 'Login' })",
      );
    });

    it('drops a leading cy. receiver', () => {
      expect(stripLeadingReceiver('cy.get(\'[data-testid="x"]\')')).toBe(
        'get(\'[data-testid="x"]\')',
      );
    });

    it('leaves receiver-less replacements untouched', () => {
      expect(stripLeadingReceiver('$(\'[data-testid="x"]\')')).toBe('$(\'[data-testid="x"]\')');
      expect(stripLeadingReceiver("Selector('#app')")).toBe("Selector('#app')");
    });
  });

  describe('findCallExpressionRange (via action range)', () => {
    it('expands range to cover full method call including parentheses', () => {
      storeSuggestions([makeSuggestion({ confidence: 0.9 })]);

      const provider = new SelectorHealerCodeActionProvider();
      // The rawValue starts at column 22 (inside the quotes of locator("..."))
      const lineText = '  await page.locator("#submit-btn").click();';
      const mockDoc = {
        uri: vscode.Uri.file('/test/login.spec.ts'),
        languageId: 'typescript',
        lineAt: () => ({ text: lineText }),
      };

      // diagnostic range starts at column 22 (the '#' of '#submit-btn')
      const context = {
        diagnostics: [
          {
            source: 'selector-healer',
            code: 'broken',
            range: new vscode.Range(new vscode.Position(9, 22), new vscode.Position(9, 33)),
          },
        ],
      };

      const actions = provider.provideCodeActions(
        mockDoc as unknown as vscode.TextDocument,
        new vscode.Range(new vscode.Position(9, 0), new vscode.Position(9, 0)),
        context as unknown as { diagnostics: vscode.Diagnostic[] },
      );

      // The action should have a workspace edit
      expect(actions.length).toBe(1);
      const edit = actions[0]?.edit as vscode.WorkspaceEdit;
      expect(edit).toBeDefined();
    });

    it('handles nested parentheses in method arguments', () => {
      storeSuggestions([makeSuggestion({ line: 5 })]);

      const provider = new SelectorHealerCodeActionProvider();
      const lineText = "  await page.getByRole('button', { name: 'Log in' }).click();";
      const mockDoc = {
        uri: vscode.Uri.file('/test/login.spec.ts'),
        languageId: 'typescript',
        lineAt: () => ({ text: lineText }),
      };

      const context = {
        diagnostics: [
          {
            source: 'selector-healer',
            code: 'broken',
            range: new vscode.Range(new vscode.Position(4, 24), new vscode.Position(4, 30)),
          },
        ],
      };

      const actions = provider.provideCodeActions(
        mockDoc as unknown as vscode.TextDocument,
        new vscode.Range(new vscode.Position(4, 0), new vscode.Position(4, 0)),
        context as unknown as { diagnostics: vscode.Diagnostic[] },
      );

      // Should still produce actions (no crash on nested content)
      expect(actions.length).toBe(1);
    });
  });
});
