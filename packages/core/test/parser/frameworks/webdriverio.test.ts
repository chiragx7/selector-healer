import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { extractWebdriverIOSelectors } from '../../../src/parser/frameworks/webdriverio.js';

function parseCode(code: string) {
  return parse(code, { sourceType: 'module', plugins: ['typescript'] });
}

describe('extractWebdriverIOSelectors', () => {
  it('extracts $() CSS selectors', () => {
    const code = `
      const btn = await $('#login-btn');
      const header = await $('.header');
    `;
    const result = extractWebdriverIOSelectors(parseCode(code), '/test/login.e2e.ts');
    expect(result).toHaveLength(2);
    expect(result[0]?.selectorType).toBe('css');
    expect(result[0]?.rawValue).toBe('#login-btn');
    expect(result[0]?.framework).toBe('webdriverio');
    expect(result[1]?.rawValue).toBe('.header');
  });

  it('extracts $$() multiple selectors', () => {
    const code = `const items = await $$('.list-item');`;
    const result = extractWebdriverIOSelectors(parseCode(code), '/test/list.e2e.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.rawValue).toBe('.list-item');
  });

  it('extracts browser.$() calls', () => {
    const code = `const el = await browser.$('#main');`;
    const result = extractWebdriverIOSelectors(parseCode(code), '/test/app.e2e.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.rawValue).toBe('#main');
  });

  it('classifies XPath selectors', () => {
    const code = `const el = await $('//div[@id="app"]');`;
    const result = extractWebdriverIOSelectors(parseCode(code), '/test/app.e2e.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.selectorType).toBe('xpath');
  });

  it('classifies aria/ selectors as role', () => {
    const code = `const el = await $('aria/Submit');`;
    const result = extractWebdriverIOSelectors(parseCode(code), '/test/app.e2e.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.selectorType).toBe('role');
    expect(result[0]?.rawValue).toBe('aria/Submit');
  });

  it('classifies data-testid attribute selectors', () => {
    const code = `const el = await $('[data-testid="submit-btn"]');`;
    const result = extractWebdriverIOSelectors(parseCode(code), '/test/app.e2e.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.selectorType).toBe('testid');
  });

  it('classifies role attribute selectors', () => {
    const code = `const el = await $('[role="button"]');`;
    const result = extractWebdriverIOSelectors(parseCode(code), '/test/app.e2e.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.selectorType).toBe('role');
  });

  it('tracks browser.url() for contextHint', () => {
    const code = `
      await browser.url('/login');
      const el = await $('#username');
    `;
    const result = extractWebdriverIOSelectors(parseCode(code), '/test/login.e2e.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.contextHint).toBe('/login');
  });

  it('skips dynamic selectors', () => {
    const code = 'const el = await $(`#${dynamicId}`);';
    const result = extractWebdriverIOSelectors(parseCode(code), '/test/app.e2e.ts');
    expect(result).toHaveLength(0);
  });

  it('handles template literals without expressions', () => {
    const code = 'const el = await $(`#static-id`);';
    const result = extractWebdriverIOSelectors(parseCode(code), '/test/app.e2e.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.rawValue).toBe('#static-id');
  });

  it('sets all required SelectorUsage fields', () => {
    const code = `await $('.btn').click();`;
    const result = extractWebdriverIOSelectors(parseCode(code), '/repo/test/specs/app.e2e.ts');
    expect(result[0]).toMatchObject({
      filePath: '/repo/test/specs/app.e2e.ts',
      selectorType: 'css',
      rawValue: '.btn',
      framework: 'webdriverio',
    });
    expect(result[0]?.id).toBeTruthy();
    expect(result[0]?.line).toBeGreaterThan(0);
  });
});
