/**
 * Unit tests for the Chrome extension's in-browser healer (content.js).
 *
 * These cover the PURE logic (no DOM needed): the ported scoring, replacement-
 * code generation, and implicit-role/accessible-name resolution. The final
 * block asserts byte-for-byte parity with @selector-healer/core, which guards
 * against transcription drift between the port and the source of truth.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Imported by relative source path (not the package name): chrome-extension
// doesn't depend on core, and this avoids a build/install step — Vite transforms
// the TS on the fly so the parity check tracks core's live source.
import {
  generateReplacementCode as coreGenerate,
  scoreCandidate as coreScore,
} from '../../core/src/index.ts';

const require = createRequire(import.meta.url);
const content = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'content.js'));

/** Build a DomFingerprint-shaped object with sensible defaults. */
function fp(over = {}) {
  return {
    selectorId: 'x',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tagName: 'div',
    attributes: {},
    textContent: '',
    parentChain: [],
    siblingIndex: 0,
    pageUrl: 'https://app.com',
    ...over,
  };
}

describe('content.js generateReplacementCode (Playwright)', () => {
  it('prefers data-testid', () => {
    expect(
      content.generateReplacementCode(
        fp({ attributes: { 'data-testid': 'submit-btn' } }),
        'playwright',
      ),
    ).toBe("page.getByTestId('submit-btn')");
  });

  it('uses implicit button role + accessible name for <button>', () => {
    expect(
      content.generateReplacementCode(
        fp({ tagName: 'button', textContent: 'Login' }),
        'playwright',
      ),
    ).toBe("page.getByRole('button', { name: 'Login' })");
  });

  it('uses implicit link role + accessible name for <a href>', () => {
    expect(
      content.generateReplacementCode(
        fp({ tagName: 'a', attributes: { href: '/home' }, textContent: 'Home' }),
        'playwright',
      ),
    ).toBe("page.getByRole('link', { name: 'Home' })");
  });

  it('does not invent a role name for a text input (falls back to placeholder)', () => {
    expect(
      content.generateReplacementCode(
        fp({ tagName: 'input', attributes: { type: 'text', placeholder: 'Email' } }),
        'playwright',
      ),
    ).toBe("page.getByPlaceholder('Email')");
  });

  it('falls back to text for a roleless element', () => {
    expect(
      content.generateReplacementCode(fp({ tagName: 'span', textContent: 'Hello' }), 'playwright'),
    ).toBe("page.getByText('Hello')");
  });

  it('falls back to a CSS selector when nothing semantic exists', () => {
    expect(
      content.generateReplacementCode(
        fp({ tagName: 'div', attributes: { class: 'a b' } }),
        'playwright',
      ),
    ).toBe("page.locator('div.a.b')");
  });

  it('escapes single quotes', () => {
    expect(
      content.generateReplacementCode(fp({ tagName: 'span', textContent: "It's" }), 'playwright'),
    ).toBe("page.getByText('It\\'s')");
  });
});

describe('content.js implicitRole', () => {
  it.each([
    ['button', {}, 'button'],
    ['a', { href: '/x' }, 'link'],
    ['a', {}, undefined],
    ['input', { type: 'submit' }, 'button'],
    ['input', { type: 'checkbox' }, 'checkbox'],
    ['input', { type: 'password' }, undefined],
    ['input', { type: 'text' }, 'textbox'],
    ['h2', {}, 'heading'],
    ['select', {}, 'combobox'],
    ['nav', {}, 'navigation'],
    ['div', {}, undefined],
  ])('%s %o -> %s', (tagName, attributes, expected) => {
    expect(content.implicitRole(fp({ tagName, attributes }))).toBe(expected);
  });
});

describe('content.js scoreCandidate', () => {
  it('scores an exact data-testid match highly', () => {
    const stored = fp({
      tagName: 'button',
      attributes: { 'data-testid': 'avatar' },
      textContent: 'U',
    });
    const cand = fp({
      tagName: 'button',
      attributes: { 'data-testid': 'avatar' },
      textContent: 'U',
    });
    // ~0.78 here (empty class/parentChain contribute 0); a real DOM with a
    // matching ancestor chain pushes this higher.
    expect(content.scoreCandidate(stored, cand)).toBeGreaterThan(0.7);
  });

  it('does not penalise absent presence-gated attrs (the N/A fix)', () => {
    // Two identical no-testid/id/role elements: ~0.59 because those rules return
    // "not applicable" (-1) and drop out of the denominator. If the fix were
    // broken (returning 0 instead), this would collapse to ~0.22.
    const stored = fp({ tagName: 'button', textContent: 'Login' });
    const cand = fp({ tagName: 'button', textContent: 'Login' });
    expect(content.scoreCandidate(stored, cand)).toBeGreaterThan(0.5);
  });

  it('scores a totally different element low', () => {
    const stored = fp({ tagName: 'button', attributes: { 'data-testid': 'a' }, textContent: 'X' });
    const cand = fp({ tagName: 'span', textContent: 'completely different content' });
    expect(content.scoreCandidate(stored, cand)).toBeLessThan(0.3);
  });
});

describe('content.js matches @selector-healer/core (port fidelity)', () => {
  const cases = [
    fp({ attributes: { 'data-testid': 'submit-btn' } }),
    fp({ tagName: 'button', textContent: 'Login' }),
    fp({ tagName: 'a', attributes: { href: '/home' }, textContent: 'Home' }),
    fp({ tagName: 'input', attributes: { type: 'text', placeholder: 'Email' } }),
    fp({ tagName: 'span', textContent: 'Hello' }),
    fp({ tagName: 'div', attributes: { class: 'a b' } }),
    fp({ tagName: 'h2', textContent: 'Dashboard' }),
  ];

  it('generateReplacementCode output is identical to core', () => {
    for (const f of cases) {
      expect(content.generateReplacementCode(f, 'playwright')).toBe(coreGenerate(f, 'playwright'));
    }
  });

  it('scoreCandidate confidence matches core', () => {
    const stored = fp({
      tagName: 'button',
      attributes: { 'data-testid': 'avatar' },
      textContent: 'U',
    });
    for (const c of cases) {
      expect(content.scoreCandidate(stored, c)).toBeCloseTo(coreScore(stored, c).confidence, 5);
    }
  });
});
