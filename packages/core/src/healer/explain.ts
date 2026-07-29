import type { BreakReason, DomFingerprint } from '../types.js';

const TESTID_ATTRS = ['data-testid', 'data-test-id'] as const;

/** Named attributes worth reporting individually when they change. */
const NAMED_ATTRS = ['aria-label', 'placeholder', 'href', 'alt', 'title', 'name', 'type'] as const;

/**
 * Explain why a selector broke by diffing its stored fingerprint against what
 * the element looks like now (the healer's top candidate). Returns the
 * meaningful changes, roughly ordered by how likely each is to have broken a
 * selector. When `current` is undefined (nothing matched), reports the element
 * as removed.
 *
 * Pure and side-effect free — a diagnostic derived entirely from local data.
 *
 * @param stored - the baseline fingerprint captured for the selector
 * @param current - the fingerprint of the element the healer now matches, if any
 * @returns human-readable reasons, most-significant first (empty if nothing changed)
 *
 * @example
 * ```ts
 * explainBreak(stored, current);
 * // [{ kind: 'text', summary: 'text changed from "Save changes" to "Update Profile"' }]
 * ```
 */
export function explainBreak(stored: DomFingerprint, current?: DomFingerprint): BreakReason[] {
  if (!current) {
    return [
      {
        kind: 'removed',
        summary: 'the element is no longer in the DOM (removed or fully replaced)',
      },
    ];
  }

  const reasons: BreakReason[] = [];

  // test-id — the highest-signal break for `getByTestId` selectors.
  const storedTid = firstAttr(stored, TESTID_ATTRS);
  const currentTid = firstAttr(current, TESTID_ATTRS);
  if (storedTid !== currentTid) {
    reasons.push({ kind: 'testid', summary: attrChange('data-testid', storedTid, currentTid) });
  }

  // role
  if (stored.attributes.role !== current.attributes.role) {
    reasons.push({
      kind: 'role',
      summary: attrChange('role', stored.attributes.role, current.attributes.role),
    });
  }

  // visible text — the classic "someone renamed the button" break.
  const storedText = normalizeText(stored.textContent);
  const currentText = normalizeText(current.textContent);
  if (storedText !== currentText) {
    reasons.push({
      kind: 'text',
      summary: `text changed from ${quote(storedText)} to ${quote(currentText)}`,
    });
  }

  // tag
  if (stored.tagName !== current.tagName) {
    reasons.push({
      kind: 'tag',
      summary: `tag changed from <${stored.tagName}> to <${current.tagName}>`,
    });
  }

  // id
  if (stored.attributes.id !== current.attributes.id) {
    reasons.push({
      kind: 'id',
      summary: attrChange('id', stored.attributes.id, current.attributes.id),
    });
  }

  // other named attributes (aria-label, placeholder, href, alt, title, name, type)
  for (const attr of NAMED_ATTRS) {
    if (stored.attributes[attr] !== current.attributes[attr]) {
      reasons.push({
        kind: 'attribute',
        summary: attrChange(attr, stored.attributes[attr], current.attributes[attr]),
      });
    }
  }

  // structural moves — a changed ancestor chain, else a shifted sibling index.
  if (parentPath(stored) !== parentPath(current)) {
    reasons.push({ kind: 'moved', summary: 'moved to a different place in the page structure' });
  } else if (stored.siblingIndex !== current.siblingIndex) {
    reasons.push({
      kind: 'position',
      summary: `position among sibling <${current.tagName}> elements changed (${stored.siblingIndex} → ${current.siblingIndex})`,
    });
  }

  return reasons;
}

/** First present value among `names` in a fingerprint's attributes, or undefined. */
function firstAttr(fp: DomFingerprint, names: readonly string[]): string | undefined {
  for (const n of names) {
    if (fp.attributes[n] !== undefined) return fp.attributes[n];
  }
  return undefined;
}

/** Human-readable "added / removed / changed" phrasing for one attribute. */
function attrChange(name: string, from: string | undefined, to: string | undefined): string {
  if (from === undefined) return `${name} added (${quote(to ?? '')})`;
  if (to === undefined) return `${name} removed (was ${quote(from)})`;
  return `${name} changed from ${quote(from)} to ${quote(to)}`;
}

function normalizeText(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** Quote and truncate a value for a one-line summary. */
function quote(value: string): string {
  const trimmed = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return `"${trimmed}"`;
}

/** A stable string of the ancestor tag chain, to detect relocation. */
function parentPath(fp: DomFingerprint): string {
  return (fp.parentChain ?? []).map((p) => p.tagName).join('>');
}
