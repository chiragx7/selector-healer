import type { Page } from 'playwright';
import type { DomFingerprint } from '../types.js';

/**
 * Scan the live DOM for candidate elements that might match a stored fingerprint.
 * Queries by tag name, role, data-testid, and text content overlap.
 *
 * @param page - Playwright page to scan.
 * @param stored - The stored fingerprint to find matches for.
 * @param pageUrl - URL of the current page (for fingerprint metadata).
 * @returns Array of fingerprints for candidate elements, max 20.
 *
 * @example
 * ```ts
 * const candidates = await scanCandidates(page, storedFingerprint, 'https://app.com/login');
 * ```
 */
export async function scanCandidates(
  page: Page,
  stored: DomFingerprint,
  pageUrl: string,
): Promise<DomFingerprint[]> {
  const selectors = buildCandidateSelectors(stored);

  interface CandidateSnapshot {
    tagName: string;
    attributes: Record<string, string>;
    textContent: string;
    parentChain: Array<{ tagName: string; id?: string; classes: string[]; role?: string }>;
    siblingIndex: number;
  }

  const rawCandidates: CandidateSnapshot[] = [];

  for (const sel of selectors) {
    if (rawCandidates.length >= 20) break;
    const remaining = 20 - rawCandidates.length;

    try {
      const elements = page.locator(sel);
      const count = await elements.count();
      for (let i = 0; i < Math.min(count, remaining); i++) {
        const el = elements.nth(i);
        const snap = await el.evaluate((node) => {
          const attrs: Record<string, string> = {};
          for (const attr of node.attributes) {
            attrs[attr.name] = attr.value;
          }

          const chain: Array<{
            tagName: string;
            id?: string;
            classes: string[];
            role?: string;
          }> = [];
          let current = node.parentElement;
          for (let j = 0; j < 5 && current; j++) {
            const role = current.getAttribute('role');
            chain.unshift({
              tagName: current.tagName.toLowerCase(),
              ...(current.id ? { id: current.id } : {}),
              classes: [...current.classList],
              ...(role ? { role } : {}),
            });
            current = current.parentElement;
          }

          let siblingIndex = 0;
          if (node.parentElement) {
            const siblings = [...node.parentElement.children].filter(
              (c) => c.tagName === node.tagName,
            );
            siblingIndex = siblings.indexOf(node);
          }

          return {
            tagName: node.tagName.toLowerCase(),
            attributes: attrs,
            textContent: (node.textContent ?? '').trim().slice(0, 200),
            parentChain: chain,
            siblingIndex,
          };
        });
        rawCandidates.push(snap);
      }
    } catch {}
  }

  const seen = new Set<string>();
  const deduped = rawCandidates.filter((snap) => {
    const key = `${snap.tagName}:${snap.attributes.id ?? ''}:${snap.attributes['data-testid'] ?? ''}:${snap.textContent.slice(0, 30)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.map((snap) => ({
    selectorId: stored.selectorId,
    capturedAt: new Date().toISOString(),
    ...snap,
    pageUrl,
  }));
}

function buildCandidateSelectors(stored: DomFingerprint): string[] {
  const selectors: string[] = [];

  const testId = stored.attributes['data-testid'] ?? stored.attributes['data-test-id'];
  if (testId) {
    selectors.push(`[data-testid="${testId}"]`, `[data-test-id="${testId}"]`);
  }

  if (stored.attributes.id) {
    selectors.push(`#${escapeCssId(stored.attributes.id)}`);
  }

  if (stored.attributes.role) {
    selectors.push(`[role="${stored.attributes.role}"]`);
  }

  selectors.push(stored.tagName);

  if (stored.attributes.class) {
    const classes = stored.attributes.class.split(/\s+/).filter(Boolean);
    if (classes.length > 0) {
      const topClasses = classes.slice(0, 3);
      selectors.push(`${stored.tagName}.${topClasses.join('.')}`);
    }
  }

  return selectors;
}

function escapeCssId(id: string): string {
  return id.replace(/([^\w-])/g, '\\$1');
}
