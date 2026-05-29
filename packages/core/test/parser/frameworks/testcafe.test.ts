import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { extractTestCafeSelectors } from '../../../src/parser/frameworks/testcafe.js';

function parseCode(code: string) {
  return parse(code, { sourceType: 'module', plugins: ['typescript'] });
}

describe('extractTestCafeSelectors', () => {
  it('extracts Selector() CSS selectors', () => {
    const code = `
      const btn = Selector('#login-btn');
      const header = Selector('.header');
    `;
    const result = extractTestCafeSelectors(parseCode(code), '/test/login.testcafe.ts');
    expect(result).toHaveLength(2);
    expect(result[0]?.selectorType).toBe('css');
    expect(result[0]?.rawValue).toBe('#login-btn');
    expect(result[0]?.framework).toBe('testcafe');
    expect(result[1]?.rawValue).toBe('.header');
  });

  it('extracts Selector() with data-testid as testid type', () => {
    const code = `const el = Selector('[data-testid="submit-btn"]');`;
    const result = extractTestCafeSelectors(parseCode(code), '/test/app.testcafe.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.selectorType).toBe('testid');
  });

  it('classifies XPath selectors', () => {
    const code = `const el = Selector('//div[@class="app"]');`;
    const result = extractTestCafeSelectors(parseCode(code), '/test/app.testcafe.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.selectorType).toBe('xpath');
  });

  it('classifies role attribute selectors', () => {
    const code = `const el = Selector('[role="button"]');`;
    const result = extractTestCafeSelectors(parseCode(code), '/test/app.testcafe.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.selectorType).toBe('role');
  });

  it('captures .withText() chaining as options', () => {
    const code = `const el = Selector('button').withText('Submit');`;
    const result = extractTestCafeSelectors(parseCode(code), '/test/app.testcafe.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.rawValue).toBe('button');
    expect(result[0]?.options?.withText).toBe('Submit');
  });

  it('tracks t.navigateTo() for contextHint', () => {
    const code = `
      await t.navigateTo('/login');
      const el = Selector('#username');
    `;
    const result = extractTestCafeSelectors(parseCode(code), '/test/login.testcafe.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.contextHint).toBe('/login');
  });

  it('skips dynamic selectors', () => {
    const code = 'const el = Selector(`#${dynamicId}`);';
    const result = extractTestCafeSelectors(parseCode(code), '/test/app.testcafe.ts');
    expect(result).toHaveLength(0);
  });

  it('handles template literals without expressions', () => {
    const code = 'const el = Selector(`#static-id`);';
    const result = extractTestCafeSelectors(parseCode(code), '/test/app.testcafe.ts');
    expect(result).toHaveLength(1);
    expect(result[0]?.rawValue).toBe('#static-id');
  });

  it('ignores non-Selector calls', () => {
    const code = `
      const el = NotSelector('#something');
      myHelper('.btn');
    `;
    const result = extractTestCafeSelectors(parseCode(code), '/test/app.testcafe.ts');
    expect(result).toHaveLength(0);
  });

  it('sets all required SelectorUsage fields', () => {
    const code = `const el = Selector('.btn');`;
    const result = extractTestCafeSelectors(parseCode(code), '/repo/tests/app.testcafe.ts');
    expect(result[0]).toMatchObject({
      filePath: '/repo/tests/app.testcafe.ts',
      selectorType: 'css',
      rawValue: '.btn',
      framework: 'testcafe',
    });
    expect(result[0]?.id).toBeTruthy();
    expect(result[0]?.line).toBeGreaterThan(0);
  });
});
