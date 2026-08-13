import type { DomFingerprint } from '@selector-healer/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./__mocks__/vscode.js'));

const { buildHoverMarkdown, describeElement } = await import('../src/hover.js');
type HoverInfo = import('../src/hover.js').HoverInfo;

function fp(overrides: Partial<DomFingerprint> = {}): DomFingerprint {
  return {
    selectorId: 'x',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'button',
    attributes: { 'data-testid': 'save' },
    textContent: 'Save',
    parentChain: [],
    siblingIndex: 0,
    pageUrl: 'http://localhost/login',
    ...overrides,
  };
}

describe('describeElement', () => {
  it('prefers data-testid and includes trimmed text', () => {
    expect(describeElement(fp())).toBe('<button data-testid="save">Save</button>');
  });
  it('falls back to id when there is no test-id, and omits an empty text tail', () => {
    expect(
      describeElement(fp({ tagName: 'input', attributes: { id: 'email' }, textContent: '' })),
    ).toBe('<input id="email">');
  });
  it('includes an explicit role', () => {
    expect(
      describeElement(fp({ tagName: 'div', attributes: { role: 'dialog' }, textContent: '' })),
    ).toBe('<div role="dialog">');
  });
});

const base: HoverInfo = {
  code: "page.getByTestId('save')",
  status: 'ok',
  matchCount: 1,
  lastRunAt: Date.now() - 5000,
  element: '<button data-testid="save">Save</button>',
  pageUrl: 'http://localhost/login',
  capturedAt: '2026-01-01T00:00:00.000Z',
  robustness: { tier: 'robust', reason: 'test-id - immune to text and markup changes' },
};

describe('buildHoverMarkdown', () => {
  it('renders a healthy selector card', () => {
    const md = buildHoverMarkdown(base);
    expect(md).toContain("### `page.getByTestId('save')`");
    expect(md).toContain('**Healthy**');
    expect(md).toContain('verified 5s ago');
    expect(md).toContain('**Matches:** `<button data-testid="save">Save</button>`');
    expect(md).toContain('**Page:** http://localhost/login');
    expect(md).toContain('Robustness: robust');
    expect(md).not.toContain('Why it broke');
    expect(md).not.toContain('Suggested fix');
  });

  it('renders a broken selector card with why + suggestion, labelled as baseline', () => {
    const md = buildHoverMarkdown({
      ...base,
      status: 'broken',
      why: 'text changed from "Save" to "Update"',
      suggestion: { code: "page.getByRole('button', { name: 'Update' })", pct: 85 },
    });
    expect(md).toContain('**Broken**');
    expect(md).toContain('**Why it broke:** text changed from "Save" to "Update"');
    expect(md).toContain('**Suggested fix:** `page.getByRole(');
    expect(md).toContain('· 85%');
    expect(md).toContain('**Baseline element:**'); // not "Matches" when broken
  });

  it('notes when there is no baseline captured', () => {
    const md = buildHoverMarkdown({
      ...base,
      status: 'skipped',
      element: undefined,
      pageUrl: undefined,
      capturedAt: undefined,
    });
    expect(md).toContain('**No baseline**');
    expect(md).toContain('No baseline captured for this selector yet');
  });
});
