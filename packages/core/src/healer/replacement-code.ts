import type { DomFingerprint, Framework, SelectorType } from '../types.js';

/**
 * Generate a replacement code string for a healed selector in the target
 * framework's syntax.
 *
 * @param fingerprint - The matched candidate element fingerprint.
 * @param framework - Target framework for output syntax.
 * @returns The replacement code string (e.g. `page.getByTestId('submit-btn')`).
 *
 * @example
 * ```ts
 * const code = generateReplacementCode(fp, 'cypress');
 * // "cy.get('[data-testid=\"submit-btn\"]')"
 * ```
 */
export function generateReplacementCode(
  fingerprint: DomFingerprint,
  framework: Framework = 'playwright',
): string {
  switch (framework) {
    case 'cypress':
      return generateCypressReplacement(fingerprint);
    case 'webdriverio':
      return generateWebdriverIOReplacement(fingerprint);
    case 'testcafe':
      return generateTestCafeReplacement(fingerprint);
    default:
      return generatePlaywrightReplacement(fingerprint);
  }
}

// ── Playwright ────────────────────────────────────────────────────────────

function generatePlaywrightReplacement(fp: DomFingerprint): string {
  const testId = fp.attributes['data-testid'] ?? fp.attributes['data-test-id'];
  if (testId) {
    return `page.getByTestId('${escapeQuotes(testId)}')`;
  }

  const role = fp.attributes.role;
  const ariaLabel = fp.attributes['aria-label'];
  if (role && ariaLabel) {
    return `page.getByRole('${role}', { name: '${escapeQuotes(ariaLabel)}' })`;
  }
  if (role) {
    return `page.getByRole('${role}')`;
  }

  const label = fp.attributes['aria-label'];
  if (label) {
    return `page.getByLabel('${escapeQuotes(label)}')`;
  }

  const placeholder = fp.attributes.placeholder;
  if (placeholder) {
    return `page.getByPlaceholder('${escapeQuotes(placeholder)}')`;
  }

  if (fp.textContent && fp.textContent.length <= 50) {
    return `page.getByText('${escapeQuotes(fp.textContent)}')`;
  }

  if (fp.attributes.id) {
    return `page.locator('#${escapeCss(fp.attributes.id)}')`;
  }

  return `page.locator('${buildCssSelector(fp)}')`;
}

// ── Cypress ───────────────────────────────────────────────────────────────

function generateCypressReplacement(fp: DomFingerprint): string {
  const testId = fp.attributes['data-testid'] ?? fp.attributes['data-test-id'];
  if (testId) {
    return `cy.get('[data-testid="${escapeQuotes(testId)}"]')`;
  }

  if (fp.attributes.id) {
    return `cy.get('#${escapeCss(fp.attributes.id)}')`;
  }

  const role = fp.attributes.role;
  if (role) {
    return `cy.get('[role="${escapeQuotes(role)}"]')`;
  }

  if (fp.textContent && fp.textContent.length <= 50) {
    return `cy.contains('${escapeQuotes(fp.textContent)}')`;
  }

  return `cy.get('${buildCssSelector(fp)}')`;
}

// ── WebdriverIO ───────────────────────────────────────────────────────────

function generateWebdriverIOReplacement(fp: DomFingerprint): string {
  const testId = fp.attributes['data-testid'] ?? fp.attributes['data-test-id'];
  if (testId) {
    return `$('[data-testid="${escapeQuotes(testId)}"]')`;
  }

  const ariaLabel = fp.attributes['aria-label'];
  if (ariaLabel) {
    return `$('aria/${escapeQuotes(ariaLabel)}')`;
  }

  if (fp.attributes.id) {
    return `$('#${escapeCss(fp.attributes.id)}')`;
  }

  const role = fp.attributes.role;
  if (role) {
    return `$('[role="${escapeQuotes(role)}"]')`;
  }

  return `$('${buildCssSelector(fp)}')`;
}

// ── TestCafe ──────────────────────────────────────────────────────────────

function generateTestCafeReplacement(fp: DomFingerprint): string {
  const testId = fp.attributes['data-testid'] ?? fp.attributes['data-test-id'];
  if (testId) {
    return `Selector('[data-testid="${escapeQuotes(testId)}"]')`;
  }

  if (fp.attributes.id) {
    return `Selector('#${escapeCss(fp.attributes.id)}')`;
  }

  const role = fp.attributes.role;
  if (role) {
    return `Selector('[role="${escapeQuotes(role)}"]')`;
  }

  if (fp.textContent && fp.textContent.length <= 50) {
    return `Selector('${fp.tagName}').withText('${escapeQuotes(fp.textContent)}')`;
  }

  return `Selector('${buildCssSelector(fp)}')`;
}

// ── Shared utilities ──────────────────────────────────────────────────────

function escapeQuotes(str: string): string {
  return str.replace(/'/g, "\\'");
}

function escapeCss(id: string): string {
  return id.replace(/([^\w-])/g, '\\$1');
}

/**
 * Build a best-effort CSS selector from a fingerprint when no semantic
 * attributes (testid, role, aria-label) are available.
 */
function buildCssSelector(fp: DomFingerprint): string {
  let sel = fp.tagName;

  if (fp.attributes.id) {
    sel += `#${escapeCss(fp.attributes.id)}`;
    return sel;
  }

  const classes = (fp.attributes.class ?? '').split(/\s+/).filter(Boolean);
  if (classes.length > 0) {
    sel += `.${classes.slice(0, 2).join('.')}`;
  }

  return sel;
}

/**
 * Determine the best selector type to use for a given fingerprint.
 * Used by the healer to decide which replacement strategy to apply.
 *
 * @param fp - The candidate fingerprint.
 * @returns The recommended selector type.
 */
export function bestSelectorType(fp: DomFingerprint): SelectorType {
  if (fp.attributes['data-testid'] || fp.attributes['data-test-id']) return 'testid';
  if (fp.attributes.role) return 'role';
  if (fp.attributes['aria-label']) return 'label';
  if (fp.attributes.placeholder) return 'placeholder';
  if (fp.textContent && fp.textContent.length <= 50) return 'text';
  return 'css';
}
