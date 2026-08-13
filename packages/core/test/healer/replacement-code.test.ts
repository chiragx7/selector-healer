import { describe, expect, it } from 'vitest';
import { generateReplacementCode, renderSelectorCode } from '../../src/healer/replacement-code.js';
import type { DomFingerprint, SelectorUsage } from '../../src/types.js';

function sel(
  over: Partial<SelectorUsage> & Pick<SelectorUsage, 'selectorType' | 'rawValue'>,
): SelectorUsage {
  return { id: 'x', filePath: '/t.spec.ts', line: 1, column: 1, ...over };
}

function makeFp(overrides: Partial<DomFingerprint> = {}): DomFingerprint {
  return {
    selectorId: 'test123test45',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'button',
    attributes: {},
    textContent: '',
    parentChain: [],
    siblingIndex: 0,
    pageUrl: 'https://app.com/login',
    ...overrides,
  };
}

describe('generateReplacementCode - Playwright', () => {
  it('prefers data-testid', () => {
    const fp = makeFp({ attributes: { 'data-testid': 'submit-btn', id: 'btn1' } });
    expect(generateReplacementCode(fp, 'playwright')).toBe("page.getByTestId('submit-btn')");
  });

  it('uses role + aria-label', () => {
    const fp = makeFp({ attributes: { role: 'button', 'aria-label': 'Close' } });
    expect(generateReplacementCode(fp, 'playwright')).toBe(
      "page.getByRole('button', { name: 'Close' })",
    );
  });

  it('uses role alone', () => {
    const fp = makeFp({ attributes: { role: 'navigation' } });
    expect(generateReplacementCode(fp, 'playwright')).toBe("page.getByRole('navigation')");
  });

  it('uses placeholder', () => {
    const fp = makeFp({ attributes: { placeholder: 'Search...' } });
    expect(generateReplacementCode(fp, 'playwright')).toBe("page.getByPlaceholder('Search...')");
  });

  it('uses text content for an element with no implicit role', () => {
    const fp = makeFp({ tagName: 'span', textContent: 'Submit Order' });
    expect(generateReplacementCode(fp, 'playwright')).toBe("page.getByText('Submit Order')");
  });

  it('uses implicit button role + accessible name for a <button>', () => {
    const fp = makeFp({ tagName: 'button', textContent: 'Login' });
    expect(generateReplacementCode(fp, 'playwright')).toBe(
      "page.getByRole('button', { name: 'Login' })",
    );
  });

  it('uses implicit link role + accessible name for an <a href>', () => {
    const fp = makeFp({ tagName: 'a', attributes: { href: '/home' }, textContent: 'Home' });
    expect(generateReplacementCode(fp, 'playwright')).toBe(
      "page.getByRole('link', { name: 'Home' })",
    );
  });

  it('uses implicit heading role + accessible name for an <h2>', () => {
    const fp = makeFp({ tagName: 'h2', textContent: 'Dashboard' });
    expect(generateReplacementCode(fp, 'playwright')).toBe(
      "page.getByRole('heading', { name: 'Dashboard' })",
    );
  });

  it('does not invent a role name for a text input (falls back to placeholder)', () => {
    const fp = makeFp({ tagName: 'input', attributes: { type: 'text', placeholder: 'Email' } });
    expect(generateReplacementCode(fp, 'playwright')).toBe("page.getByPlaceholder('Email')");
  });

  it('uses id as CSS selector', () => {
    const fp = makeFp({ attributes: { id: 'main-form' } });
    expect(generateReplacementCode(fp, 'playwright')).toBe("page.locator('#main-form')");
  });

  it('builds CSS from tag + class', () => {
    const fp = makeFp({ tagName: 'div', attributes: { class: 'container fluid' } });
    expect(generateReplacementCode(fp, 'playwright')).toBe("page.locator('div.container.fluid')");
  });
});

describe('generateReplacementCode - Cypress', () => {
  it('prefers data-testid', () => {
    const fp = makeFp({ attributes: { 'data-testid': 'submit-btn' } });
    expect(generateReplacementCode(fp, 'cypress')).toBe('cy.get(\'[data-testid="submit-btn"]\')');
  });

  it('uses id', () => {
    const fp = makeFp({ attributes: { id: 'login-form' } });
    expect(generateReplacementCode(fp, 'cypress')).toBe("cy.get('#login-form')");
  });

  it('uses role attribute', () => {
    const fp = makeFp({ attributes: { role: 'button' } });
    expect(generateReplacementCode(fp, 'cypress')).toBe('cy.get(\'[role="button"]\')');
  });

  it('uses cy.contains for text', () => {
    const fp = makeFp({ textContent: 'Submit' });
    expect(generateReplacementCode(fp, 'cypress')).toBe("cy.contains('Submit')");
  });

  it('builds CSS selector as fallback', () => {
    const fp = makeFp({ tagName: 'div', attributes: { class: 'wrapper' } });
    expect(generateReplacementCode(fp, 'cypress')).toBe("cy.get('div.wrapper')");
  });
});

describe('generateReplacementCode - WebdriverIO', () => {
  it('prefers data-testid', () => {
    const fp = makeFp({ attributes: { 'data-testid': 'submit-btn' } });
    expect(generateReplacementCode(fp, 'webdriverio')).toBe('$(\'[data-testid="submit-btn"]\')');
  });

  it('uses aria/ prefix for aria-label', () => {
    const fp = makeFp({ attributes: { 'aria-label': 'Close dialog' } });
    expect(generateReplacementCode(fp, 'webdriverio')).toBe("$('aria/Close dialog')");
  });

  it('uses id', () => {
    const fp = makeFp({ attributes: { id: 'app' } });
    expect(generateReplacementCode(fp, 'webdriverio')).toBe("$('#app')");
  });

  it('uses role attribute', () => {
    const fp = makeFp({ attributes: { role: 'dialog' } });
    expect(generateReplacementCode(fp, 'webdriverio')).toBe('$(\'[role="dialog"]\')');
  });

  it('builds CSS selector as fallback', () => {
    const fp = makeFp({ tagName: 'span', attributes: { class: 'icon badge' } });
    expect(generateReplacementCode(fp, 'webdriverio')).toBe("$('span.icon.badge')");
  });
});

describe('generateReplacementCode - TestCafe', () => {
  it('prefers data-testid', () => {
    const fp = makeFp({ attributes: { 'data-testid': 'submit-btn' } });
    expect(generateReplacementCode(fp, 'testcafe')).toBe(
      'Selector(\'[data-testid="submit-btn"]\')',
    );
  });

  it('uses id', () => {
    const fp = makeFp({ attributes: { id: 'app-root' } });
    expect(generateReplacementCode(fp, 'testcafe')).toBe("Selector('#app-root')");
  });

  it('uses role attribute', () => {
    const fp = makeFp({ attributes: { role: 'alert' } });
    expect(generateReplacementCode(fp, 'testcafe')).toBe('Selector(\'[role="alert"]\')');
  });

  it('uses withText for text content', () => {
    const fp = makeFp({ tagName: 'button', textContent: 'Submit' });
    expect(generateReplacementCode(fp, 'testcafe')).toBe("Selector('button').withText('Submit')");
  });

  it('builds CSS selector as fallback', () => {
    const fp = makeFp({ tagName: 'article', attributes: { class: 'post featured' } });
    expect(generateReplacementCode(fp, 'testcafe')).toBe("Selector('article.post.featured')");
  });
});

describe('generateReplacementCode - defaults', () => {
  it('defaults to playwright when no framework specified', () => {
    const fp = makeFp({ attributes: { 'data-testid': 'btn' } });
    expect(generateReplacementCode(fp)).toBe("page.getByTestId('btn')");
  });

  it('escapes single quotes in values', () => {
    const fp = makeFp({ tagName: 'span', textContent: "It's done" });
    expect(generateReplacementCode(fp, 'playwright')).toBe("page.getByText('It\\'s done')");
    expect(generateReplacementCode(fp, 'cypress')).toBe("cy.contains('It\\'s done')");
  });
});

describe('renderSelectorCode - reconstruct an existing selector', () => {
  it('reconstructs getByTestId', () => {
    expect(renderSelectorCode(sel({ selectorType: 'testid', rawValue: 'submit-btn' }))).toBe(
      "page.getByTestId('submit-btn')",
    );
  });

  it('reconstructs getByRole with and without a name option', () => {
    expect(
      renderSelectorCode(
        sel({ selectorType: 'role', rawValue: 'button', options: { name: 'Log in' } }),
      ),
    ).toBe("page.getByRole('button', { name: 'Log in' })");
    expect(renderSelectorCode(sel({ selectorType: 'role', rawValue: 'alert' }))).toBe(
      "page.getByRole('alert')",
    );
  });

  it('reconstructs label / text / placeholder / css', () => {
    expect(renderSelectorCode(sel({ selectorType: 'label', rawValue: 'Email' }))).toBe(
      "page.getByLabel('Email')",
    );
    expect(renderSelectorCode(sel({ selectorType: 'text', rawValue: 'Submit' }))).toBe(
      "page.getByText('Submit')",
    );
    expect(renderSelectorCode(sel({ selectorType: 'placeholder', rawValue: 'Search' }))).toBe(
      "page.getByPlaceholder('Search')",
    );
    expect(renderSelectorCode(sel({ selectorType: 'css', rawValue: '.error-banner' }))).toBe(
      "page.locator('.error-banner')",
    );
  });

  it('matches generateReplacementCode for the same element (so no-op detection works)', () => {
    // A role=alert element re-derived by the healer must render identically.
    const fp = makeFp({ tagName: 'div', attributes: { role: 'alert' } });
    const original = renderSelectorCode(sel({ selectorType: 'role', rawValue: 'alert' }));
    expect(generateReplacementCode(fp, 'playwright')).toBe(original);
  });

  it('returns undefined for non-Playwright frameworks', () => {
    expect(
      renderSelectorCode(sel({ selectorType: 'testid', rawValue: 'x' }), 'cypress'),
    ).toBeUndefined();
  });
});
