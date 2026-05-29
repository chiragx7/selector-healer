import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { extractCypressSelectors } from '../../../src/parser/frameworks/cypress.js';

function parseCode(code: string) {
  return parse(code, { sourceType: 'module', plugins: ['typescript'] });
}

describe('extractCypressSelectors', () => {
  it('extracts cy.get() CSS selectors', () => {
    const code = `
      cy.get('#login-btn').click();
      cy.get('.header').should('be.visible');
    `;
    const result = extractCypressSelectors(parseCode(code), '/test/login.cy.ts');
    expect(result).toHaveLength(2);
    expect(result[0]?.selectorType).toBe('css');
    expect(result[0]?.rawValue).toBe('#login-btn');
    expect(result[0]?.framework).toBe('cypress');
    expect(result[1]?.rawValue).toBe('.header');
  });

  it('extracts cy.get() with data-testid as testid type', () => {
    const code = `cy.get('[data-testid="submit-btn"]').click();`;
    const result = extractCypressSelectors(parseCode(code), '/test/login.cy.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.selectorType).toBe('testid');
    expect(result[0]?.rawValue).toBe('[data-testid="submit-btn"]');
  });

  it('extracts cy.contains() as text type', () => {
    const code = `cy.contains('Submit').click();`;
    const result = extractCypressSelectors(parseCode(code), '/test/login.cy.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.selectorType).toBe('text');
    expect(result[0]?.rawValue).toBe('Submit');
  });

  it('extracts cy.find() chained calls', () => {
    const code = `cy.get('.form').find('#email').type('test@example.com');`;
    const result = extractCypressSelectors(parseCode(code), '/test/login.cy.ts');
    expect(result).toHaveLength(2);
    expect(result[0]?.rawValue).toBe('.form');
    expect(result[1]?.rawValue).toBe('#email');
  });

  it('tracks cy.visit() for contextHint', () => {
    const code = `
      cy.visit('/login');
      cy.get('#username').type('admin');
    `;
    const result = extractCypressSelectors(parseCode(code), '/test/login.cy.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.contextHint).toBe('/login');
  });

  it('ignores non-cy calls', () => {
    const code = `
      element.get('.something');
      other.contains('text');
    `;
    const result = extractCypressSelectors(parseCode(code), '/test/login.cy.ts');
    expect(result).toHaveLength(0);
  });

  it('skips dynamic selectors', () => {
    const code = 'cy.get(`.${className}`).click();';
    const result = extractCypressSelectors(parseCode(code), '/test/login.cy.ts');
    expect(result).toHaveLength(0);
  });

  it('handles template literals without expressions', () => {
    const code = 'cy.get(`#static-id`).click();';
    const result = extractCypressSelectors(parseCode(code), '/test/login.cy.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.rawValue).toBe('#static-id');
  });

  it('sets all required SelectorUsage fields', () => {
    const code = `cy.get('.btn').click();`;
    const result = extractCypressSelectors(parseCode(code), '/repo/tests/app.cy.ts');
    expect(result[0]).toMatchObject({
      filePath: '/repo/tests/app.cy.ts',
      selectorType: 'css',
      rawValue: '.btn',
      framework: 'cypress',
    });
    expect(result[0]?.id).toBeTruthy();
    expect(result[0]?.line).toBeGreaterThan(0);
    expect(result[0]?.column).toBeGreaterThan(0);
  });
});
