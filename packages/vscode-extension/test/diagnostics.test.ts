import { describe, expect, it } from 'vitest';
import { Diagnostic, DiagnosticSeverity, Uri, type languages } from './__mocks__/vscode.js';

// We need to mock vscode before importing the module under test
import { vi } from 'vitest';
vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { createDiagnosticCollection, selectorToDiagnostic, updateDiagnosticsFromResults } =
  await import('../src/diagnostics.js');

function makeSelector(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sel_001',
    filePath: '/test/login.spec.ts',
    line: 10,
    column: 5,
    rawValue: '#submit-btn',
    selectorType: 'css' as const,
    framework: 'playwright' as const,
    contextHint: undefined,
    ...overrides,
  };
}

describe('diagnostics', () => {
  describe('createDiagnosticCollection', () => {
    it('creates a diagnostic collection', () => {
      const collection = createDiagnosticCollection();
      expect(collection).toBeDefined();
      expect(collection.clear).toBeInstanceOf(Function);
      expect(collection.set).toBeInstanceOf(Function);
    });
  });

  describe('selectorToDiagnostic', () => {
    it('creates error diagnostic for broken status', () => {
      const sel = makeSelector();
      const diag = selectorToDiagnostic(sel, 'broken');

      expect(diag.severity).toBe(DiagnosticSeverity.Error);
      expect(diag.message).toContain('Broken selector');
      expect(diag.message).toContain('#submit-btn');
      expect(diag.source).toBe('selector-healer');
      expect(diag.code).toBe('broken');
    });

    it('includes suggestion in broken diagnostic message', () => {
      const sel = makeSelector();
      const diag = selectorToDiagnostic(sel, 'broken', 'getByTestId("submit")');

      expect(diag.message).toContain('getByTestId("submit")');
    });

    it('includes the break reason in the broken diagnostic message', () => {
      const sel = makeSelector();
      const diag = selectorToDiagnostic(
        sel,
        'broken',
        'getByTestId("submit")',
        'text changed from "Save" to "Update"',
      );

      expect(diag.message).toContain('text changed from');
      expect(diag.message).toContain('getByTestId("submit")');
    });

    it('creates warning diagnostic for multiple-matches status', () => {
      const sel = makeSelector();
      const diag = selectorToDiagnostic(sel, 'multiple-matches');

      expect(diag.severity).toBe(DiagnosticSeverity.Warning);
      expect(diag.message).toContain('Ambiguous selector');
      expect(diag.code).toBe('multiple-matches');
    });

    it('creates info diagnostic for no-baseline status', () => {
      const sel = makeSelector();
      const diag = selectorToDiagnostic(sel, 'no-baseline');

      expect(diag.severity).toBe(DiagnosticSeverity.Information);
      expect(diag.message).toContain('No baseline fingerprint');
      expect(diag.message).toContain('Capture Baseline');
      expect(diag.code).toBe('no-baseline');
    });

    it('sets correct range based on selector line/column', () => {
      const sel = makeSelector({ line: 15, column: 8, rawValue: '.btn' });
      const diag = selectorToDiagnostic(sel, 'broken');

      // VS Code is 0-based, selectors are 1-based
      expect(diag.range.start.line).toBe(14);
      expect(diag.range.start.character).toBe(7);
      expect(diag.range.end.line).toBe(14);
      expect(diag.range.end.character).toBe(11); // 7 + '.btn'.length
    });
  });

  describe('updateDiagnosticsFromResults', () => {
    it('populates diagnostics grouped by file', () => {
      const collection = createDiagnosticCollection();
      const results = [
        {
          selector: makeSelector({ id: 'a', filePath: '/file-a.ts' }),
          status: 'broken' as const,
        },
        {
          selector: makeSelector({ id: 'b', filePath: '/file-a.ts', line: 20 }),
          status: 'broken' as const,
        },
        {
          selector: makeSelector({ id: 'c', filePath: '/file-b.ts' }),
          status: 'broken' as const,
        },
      ];

      updateDiagnosticsFromResults(collection, results, new Map());

      // Access the internal store for assertions
      const store = (collection as ReturnType<typeof languages.createDiagnosticCollection>)._store;
      expect(store.get('/file-a.ts')?.length).toBe(2);
      expect(store.get('/file-b.ts')?.length).toBe(1);
    });

    it('skips ok results', () => {
      const collection = createDiagnosticCollection();
      const results = [{ selector: makeSelector(), status: 'ok' as const }];

      updateDiagnosticsFromResults(collection, results, new Map());

      const store = (collection as ReturnType<typeof languages.createDiagnosticCollection>)._store;
      expect(store.size).toBe(0);
    });

    it('attaches suggestion to broken diagnostic', () => {
      const collection = createDiagnosticCollection();
      const sel = makeSelector();
      const results = [{ selector: sel, status: 'broken' as const }];
      const suggestions = new Map([['sel_001', 'getByTestId("submit")']]);

      updateDiagnosticsFromResults(collection, results, suggestions);

      const store = (collection as ReturnType<typeof languages.createDiagnosticCollection>)._store;
      const diags = store.get('/test/login.spec.ts');
      expect(diags?.[0]?.message).toContain('getByTestId("submit")');
    });

    it('attaches the break reason from the explanations map', () => {
      const collection = createDiagnosticCollection();
      const sel = makeSelector();
      const results = [{ selector: sel, status: 'broken' as const }];
      const suggestions = new Map([['sel_001', 'getByTestId("submit")']]);
      const explanations = new Map([['sel_001', 'data-testid removed (was "submit")']]);

      updateDiagnosticsFromResults(collection, results, suggestions, explanations);

      const store = (collection as ReturnType<typeof languages.createDiagnosticCollection>)._store;
      const diags = store.get('/test/login.spec.ts');
      expect(diags?.[0]?.message).toContain('data-testid removed');
    });

    it('handles multiple-matches status', () => {
      const collection = createDiagnosticCollection();
      const results = [{ selector: makeSelector(), status: 'multiple-matches' as const }];

      updateDiagnosticsFromResults(collection, results, new Map());

      const store = (collection as ReturnType<typeof languages.createDiagnosticCollection>)._store;
      const diags = store.get('/test/login.spec.ts');
      expect(diags?.[0]?.severity).toBe(DiagnosticSeverity.Warning);
    });

    it('handles skipped results without error as no-baseline', () => {
      const collection = createDiagnosticCollection();
      const results = [{ selector: makeSelector(), status: 'skipped' as const, error: undefined }];

      updateDiagnosticsFromResults(collection, results, new Map());

      const store = (collection as ReturnType<typeof languages.createDiagnosticCollection>)._store;
      const diags = store.get('/test/login.spec.ts');
      expect(diags?.[0]?.severity).toBe(DiagnosticSeverity.Information);
    });

    it('clears previous diagnostics before setting new ones', () => {
      const collection = createDiagnosticCollection();

      // First pass
      updateDiagnosticsFromResults(
        collection,
        [{ selector: makeSelector({ filePath: '/old.ts' }), status: 'broken' as const }],
        new Map(),
      );

      // Second pass with different file
      updateDiagnosticsFromResults(
        collection,
        [{ selector: makeSelector({ filePath: '/new.ts' }), status: 'broken' as const }],
        new Map(),
      );

      const store = (collection as ReturnType<typeof languages.createDiagnosticCollection>)._store;
      expect(store.has('/old.ts')).toBe(false);
      expect(store.has('/new.ts')).toBe(true);
    });
  });
});
