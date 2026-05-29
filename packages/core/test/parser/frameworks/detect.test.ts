import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { detectFramework, detectFrameworkFromPath } from '../../../src/parser/frameworks/detect.js';

function parseCode(code: string) {
  return parse(code, { sourceType: 'module', plugins: ['typescript'] });
}

describe('detectFramework (AST-based)', () => {
  it('detects Cypress from import', () => {
    const code = `import { cy } from 'cypress';`;
    expect(detectFramework(parseCode(code))).toBe('cypress');
  });

  it('detects Cypress from cypress/ subpath', () => {
    const code = `import 'cypress/support/commands';`;
    expect(detectFramework(parseCode(code))).toBe('cypress');
  });

  it('detects WebdriverIO from @wdio/globals import', () => {
    const code = `import { $, browser } from '@wdio/globals';`;
    expect(detectFramework(parseCode(code))).toBe('webdriverio');
  });

  it('detects WebdriverIO from webdriverio import', () => {
    const code = `import { remote } from 'webdriverio';`;
    expect(detectFramework(parseCode(code))).toBe('webdriverio');
  });

  it('detects TestCafe from import', () => {
    const code = `import { Selector, fixture, test } from 'testcafe';`;
    expect(detectFramework(parseCode(code))).toBe('testcafe');
  });

  it('detects Playwright as default (no framework imports)', () => {
    const code = `import { test, expect } from '@playwright/test';`;
    expect(detectFramework(parseCode(code))).toBe('playwright');
  });

  it('detects framework from require() calls', () => {
    const code = `const { $ } = require('@wdio/globals');`;
    expect(detectFramework(parseCode(code))).toBe('webdriverio');
  });

  it('defaults to playwright for unknown imports', () => {
    const code = `import { something } from 'some-library';`;
    expect(detectFramework(parseCode(code))).toBe('playwright');
  });
});

describe('detectFrameworkFromPath', () => {
  it('detects Cypress from .cy. extension', () => {
    expect(detectFrameworkFromPath('/repo/cypress/e2e/login.cy.ts')).toBe('cypress');
    expect(detectFrameworkFromPath('tests/app.cy.js')).toBe('cypress');
  });

  it('detects Cypress from /cypress/ directory', () => {
    expect(detectFrameworkFromPath('/repo/cypress/integration/test.ts')).toBe('cypress');
  });

  it('detects WebdriverIO from .wdio. extension', () => {
    expect(detectFrameworkFromPath('/repo/test/specs/login.wdio.ts')).toBe('webdriverio');
  });

  it('detects WebdriverIO from /wdio/ directory', () => {
    expect(detectFrameworkFromPath('/repo/wdio/specs/login.ts')).toBe('webdriverio');
  });

  it('detects TestCafe from .testcafe. extension', () => {
    expect(detectFrameworkFromPath('/repo/tests/login.testcafe.ts')).toBe('testcafe');
  });

  it('detects TestCafe from /testcafe/ directory', () => {
    expect(detectFrameworkFromPath('/repo/testcafe/tests/login.ts')).toBe('testcafe');
  });

  it('defaults to playwright for standard spec files', () => {
    expect(detectFrameworkFromPath('/repo/tests/login.spec.ts')).toBe('playwright');
    expect(detectFrameworkFromPath('/repo/e2e/app.test.ts')).toBe('playwright');
  });

  it('normalizes Windows paths', () => {
    expect(detectFrameworkFromPath('C:\\repo\\cypress\\e2e\\login.cy.ts')).toBe('cypress');
  });
});
