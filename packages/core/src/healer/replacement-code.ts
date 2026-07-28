import type { DomFingerprint, Framework, SelectorType, SelectorUsage } from '../types.js';

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

/**
 * Reconstruct the Playwright source for an *existing* selector usage, in the
 * same shape {@link generateReplacementCode} emits. Lets the healer compare a
 * proposed candidate against the selector it would replace and drop it when the
 * two are identical (a no-op "fix"). Returns `undefined` for non-Playwright
 * frameworks, whose source we don't reconstruct.
 *
 * @param selector - The original selector usage extracted from the test file.
 * @param framework - Target framework; only `'playwright'` is reconstructed.
 * @returns The locator source (e.g. `page.getByRole('alert')`), or `undefined`.
 *
 * @example
 * ```ts
 * renderSelectorCode({ selectorType: 'testid', rawValue: 'submit-btn' });
 * // "page.getByTestId('submit-btn')"
 * ```
 */
export function renderSelectorCode(
  selector: SelectorUsage,
  framework: Framework = 'playwright',
): string | undefined {
  if (framework !== 'playwright') return undefined;
  const value = escapeQuotes(selector.rawValue);
  switch (selector.selectorType) {
    case 'testid':
      return `page.getByTestId('${value}')`;
    case 'role': {
      const name = selector.options?.name;
      return typeof name === 'string'
        ? `page.getByRole('${value}', { name: '${escapeQuotes(name)}' })`
        : `page.getByRole('${value}')`;
    }
    case 'text':
      return `page.getByText('${value}')`;
    case 'label':
      return `page.getByLabel('${value}')`;
    case 'placeholder':
      return `page.getByPlaceholder('${value}')`;
    case 'title':
      return `page.getByTitle('${value}')`;
    case 'alt':
      return `page.getByAltText('${value}')`;
    case 'css':
    case 'xpath':
      return `page.locator('${value}')`;
    default:
      return undefined;
  }
}

// ── Playwright ────────────────────────────────────────────────────────────

function generatePlaywrightReplacement(fp: DomFingerprint): string {
  const testId = fp.attributes['data-testid'] ?? fp.attributes['data-test-id'];
  if (testId) {
    return `page.getByTestId('${escapeQuotes(testId)}')`;
  }

  // Prefer a role + accessible-name selector — the most robust and readable
  // Playwright locator. Falls back to the implicit ARIA role of the tag (e.g.
  // <button> → "button") so a healed `<button>Login</button>` becomes
  // `getByRole('button', { name: 'Login' })` rather than a brittle text match.
  const roleAttr = fp.attributes.role;
  const role = roleAttr ?? implicitRole(fp);
  const name = accessibleName(fp);
  if (role && name && (roleAttr !== undefined || NAME_FROM_CONTENT_ROLES.has(role))) {
    return `page.getByRole('${role}', { name: '${escapeQuotes(name)}' })`;
  }

  const ariaLabel = fp.attributes['aria-label'];
  if (ariaLabel) {
    return `page.getByLabel('${escapeQuotes(ariaLabel)}')`;
  }

  const placeholder = fp.attributes.placeholder;
  if (placeholder) {
    return `page.getByPlaceholder('${escapeQuotes(placeholder)}')`;
  }

  if (fp.textContent && fp.textContent.length <= 50) {
    return `page.getByText('${escapeQuotes(fp.textContent)}')`;
  }

  // Explicit role with no usable name — still better than a raw CSS selector.
  if (roleAttr) {
    return `page.getByRole('${roleAttr}')`;
  }

  if (fp.attributes.id) {
    return `page.locator('#${escapeCss(fp.attributes.id)}')`;
  }

  return `page.locator('${buildCssSelector(fp)}')`;
}

/**
 * ARIA roles whose accessible name is computed from the element's own text
 * content (HTML-AAM "name from content"). For these we can safely use the
 * element's text as the `name` option; for others (e.g. textbox) the name
 * comes from an associated label, so text content must not be used.
 */
const NAME_FROM_CONTENT_ROLES = new Set([
  'button',
  'link',
  'heading',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
  'switch',
]);

/**
 * Resolve the implicit ARIA role of an element from its tag + attributes.
 * Conservative: only returns roles Playwright's `getByRole` actually computes
 * the same way, so a generated selector will match. Returns `undefined` when
 * there is no reliable implicit role (e.g. `input[type="password"]`).
 */
function implicitRole(fp: DomFingerprint): string | undefined {
  const tag = fp.tagName.toLowerCase();
  const type = (fp.attributes.type ?? '').toLowerCase();
  switch (tag) {
    case 'button':
    case 'summary':
      return 'button';
    case 'a':
    case 'area':
      return fp.attributes.href !== undefined ? 'link' : undefined;
    case 'nav':
      return 'navigation';
    case 'main':
      return 'main';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'table':
      return 'table';
    case 'dialog':
      return 'dialog';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'img':
      return fp.attributes.alt !== undefined ? 'img' : undefined;
    case 'input':
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === '' || type === 'text' || type === 'email' || type === 'tel' || type === 'url') {
        return 'textbox';
      }
      if (type === 'search') return 'searchbox';
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Best-effort accessible name from a fingerprint: an explicit `aria-label`
 * wins, otherwise the trimmed text content (when short enough to be a stable
 * name). Returns `undefined` when neither is usable.
 */
function accessibleName(fp: DomFingerprint): string | undefined {
  const ariaLabel = fp.attributes['aria-label']?.trim();
  if (ariaLabel) return ariaLabel;
  const text = fp.textContent?.trim();
  if (text && text.length > 0 && text.length <= 50) return text;
  return undefined;
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
