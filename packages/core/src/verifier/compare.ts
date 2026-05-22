import type { DomFingerprint } from '../types.js';

export interface ComparisonDetail {
  field: string;
  stored: unknown;
  live: unknown;
  match: boolean;
}

export interface ComparisonResult {
  identical: boolean;
  similarity: number;
  details: ComparisonDetail[];
}

export function compareFingerprints(
  stored: DomFingerprint,
  live: DomFingerprint,
): ComparisonResult {
  const details: ComparisonDetail[] = [];

  details.push({
    field: 'tagName',
    stored: stored.tagName,
    live: live.tagName,
    match: stored.tagName === live.tagName,
  });

  const idMatch = stored.attributes.id === live.attributes.id;
  details.push({
    field: 'id',
    stored: stored.attributes.id,
    live: live.attributes.id,
    match: idMatch,
  });

  const storedClasses = new Set((stored.attributes.class ?? '').split(/\s+/).filter(Boolean));
  const liveClasses = new Set((live.attributes.class ?? '').split(/\s+/).filter(Boolean));
  const classOverlap = [...storedClasses].filter((c) => liveClasses.has(c)).length;
  const classUnion = new Set([...storedClasses, ...liveClasses]).size;
  const classMatch = classUnion === 0 ? true : classOverlap / classUnion > 0.7;
  details.push({
    field: 'classes',
    stored: [...storedClasses].sort(),
    live: [...liveClasses].sort(),
    match: classMatch,
  });

  const storedTestId = stored.attributes['data-testid'] ?? stored.attributes['data-test-id'];
  const liveTestId = live.attributes['data-testid'] ?? live.attributes['data-test-id'];
  details.push({
    field: 'testid',
    stored: storedTestId,
    live: liveTestId,
    match: storedTestId === liveTestId,
  });

  const storedRole = stored.attributes.role;
  const liveRole = live.attributes.role;
  details.push({
    field: 'role',
    stored: storedRole,
    live: liveRole,
    match: storedRole === liveRole,
  });

  const textMatch =
    stored.textContent === live.textContent ||
    (stored.textContent.length > 0 &&
      live.textContent.length > 0 &&
      (live.textContent.includes(stored.textContent) ||
        stored.textContent.includes(live.textContent)));
  details.push({
    field: 'textContent',
    stored: stored.textContent,
    live: live.textContent,
    match: textMatch,
  });

  const parentMatch = compareParentChains(stored.parentChain, live.parentChain);
  details.push({
    field: 'parentChain',
    stored: stored.parentChain,
    live: live.parentChain,
    match: parentMatch > 0.6,
  });

  details.push({
    field: 'siblingIndex',
    stored: stored.siblingIndex,
    live: live.siblingIndex,
    match: stored.siblingIndex === live.siblingIndex,
  });

  const matched = details.filter((d) => d.match).length;
  const similarity = matched / details.length;
  const identical = details.every((d) => d.match);

  return { identical, similarity, details };
}

function compareParentChains(
  stored: DomFingerprint['parentChain'],
  live: DomFingerprint['parentChain'],
): number {
  if (stored.length === 0 && live.length === 0) return 1;
  if (stored.length === 0 || live.length === 0) return 0;

  const minLen = Math.min(stored.length, live.length);
  let matches = 0;

  for (let i = 0; i < minLen; i++) {
    const s = stored[stored.length - 1 - i];
    const l = live[live.length - 1 - i];
    if (!s || !l) continue;
    if (s.tagName === l.tagName && s.id === l.id) {
      matches++;
    }
  }

  return matches / minLen;
}
