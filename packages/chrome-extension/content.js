/**
 * Selector Healer - Content Script
 *
 * Evaluates Playwright-style selectors against the live DOM and
 * highlights matched elements. Runs in every page frame.
 */

/* - */
/*  Implicit ARIA role map                                             */
/* - */

const IMPLICIT_ROLES = {
  alert: ['[role="alert"]'],
  button: [
    'button',
    'input[type="button"]',
    'input[type="submit"]',
    'input[type="reset"]',
    'summary',
  ],
  checkbox: ['input[type="checkbox"]'],
  combobox: ['select'],
  dialog: ['dialog'],
  heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  img: ['img[alt]'],
  link: ['a[href]', 'area[href]'],
  list: ['ul', 'ol'],
  listitem: ['li'],
  main: ['main'],
  navigation: ['nav'],
  radio: ['input[type="radio"]'],
  region: ['section[aria-label]', 'section[aria-labelledby]'],
  table: ['table'],
  textbox: [
    'input:not([type])',
    'input[type="text"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="url"]',
    'input[type="search"]',
    'input[type="password"]',
    'textarea',
  ],
};

/* - */
/*  Selector Evaluation                                                */
/* - */

function evaluateSelector(selector) {
  const type = selector.selectorType;
  const raw = selector.rawValue;
  const opts = selector.options;

  switch (type) {
    case 'css':
      return findByCss(raw);
    case 'xpath':
      return findByXpath(raw);
    case 'testid':
      return findByTestId(raw);
    case 'text':
      return findByText(raw);
    case 'label':
      return findByLabel(raw);
    case 'role':
      return findByRole(raw, opts);
    case 'placeholder':
      return findByAttr('placeholder', raw);
    case 'title':
      return findByAttr('title', raw);
    case 'alt':
      return findByAttr('alt', raw);
    default:
      return findByCss(raw);
  }
}

function findByCss(selector) {
  try {
    return [...document.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

function findByXpath(expr) {
  try {
    const result = document.evaluate(
      expr,
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    const nodes = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      nodes.push(result.snapshotItem(i));
    }
    return nodes;
  } catch {
    return [];
  }
}

function findByTestId(value) {
  return [
    ...document.querySelectorAll(`[data-testid="${CSS.escape(value)}"]`),
    ...document.querySelectorAll(`[data-test-id="${CSS.escape(value)}"]`),
  ];
}

function findByText(text) {
  const results = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    const content = normalizeWhitespace(node.textContent || '');
    const search = normalizeWhitespace(text);
    if (content.includes(search)) {
      // Prefer the most specific (deepest) element
      const children = node.children;
      let hasChildMatch = false;
      for (const child of children) {
        const childText = normalizeWhitespace(child.textContent || '');
        if (childText.includes(search)) {
          hasChildMatch = true;
          break;
        }
      }
      if (!hasChildMatch) {
        results.push(node);
      }
    }
    node = walker.nextNode();
  }
  return results;
}

function findByLabel(labelText) {
  const results = [];
  const normalizedSearch = normalizeWhitespace(labelText);

  // Explicit labels with for="id"
  for (const label of document.querySelectorAll('label')) {
    const text = normalizeWhitespace(label.textContent || '');
    if (text === normalizedSearch || text.includes(normalizedSearch)) {
      const forId = label.getAttribute('for');
      if (forId) {
        const target = document.getElementById(forId);
        if (target) results.push(target);
      } else {
        // Implicit label wrapping
        const target = label.querySelector('input, select, textarea, [contenteditable]');
        if (target) results.push(target);
      }
    }
  }

  // aria-label
  for (const el of document.querySelectorAll('[aria-label]')) {
    if (normalizeWhitespace(el.getAttribute('aria-label') || '').includes(normalizedSearch)) {
      results.push(el);
    }
  }

  return [...new Set(results)];
}

function findByRole(role, options) {
  let candidates = [...document.querySelectorAll(`[role="${role}"]`)];

  const implicitSelectors = IMPLICIT_ROLES[role];
  if (implicitSelectors) {
    for (const sel of implicitSelectors) {
      try {
        candidates.push(...document.querySelectorAll(sel));
      } catch {
        /* invalid selector */
      }
    }
  }

  // Deduplicate
  candidates = [...new Set(candidates)];

  // Filter by name option
  if (options?.name) {
    const searchName = normalizeWhitespace(String(options.name));
    candidates = candidates.filter((el) => {
      const name = getAccessibleName(el);
      return name === searchName || name.includes(searchName);
    });
  }

  return candidates;
}

function findByAttr(attr, value) {
  return [...document.querySelectorAll(`[${attr}="${CSS.escape(value)}"]`)];
}

/* - */
/*  Accessible Name Computation (simplified)                           */
/* - */

function getAccessibleName(el) {
  // 1. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return normalizeWhitespace(ariaLabel);

  // 2. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map((id) => {
      const ref = document.getElementById(id);
      return ref ? ref.textContent : '';
    });
    const joined = parts.join(' ').trim();
    if (joined) return normalizeWhitespace(joined);
  }

  // 3. Associated label (for form controls)
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) return normalizeWhitespace(label.textContent || '');
  }

  // 4. title attribute
  const title = el.getAttribute('title');
  if (title) return normalizeWhitespace(title);

  // 5. Direct text content (for buttons, links, headings)
  return normalizeWhitespace(el.textContent || '');
}

function normalizeWhitespace(str) {
  return str.replace(/\s+/g, ' ').trim();
}

/* - */
/*  Element Highlighting                                               */
/* - */

let overlayHost = null;
let overlayShadow = null;

function ensureOverlayHost() {
  if (overlayHost && document.body.contains(overlayHost)) return;
  overlayHost = document.createElement('div');
  overlayHost.id = 'selector-healer-overlay-host';
  overlayHost.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  overlayShadow = overlayHost.attachShadow({ mode: 'closed' });
  document.body.appendChild(overlayHost);
}

function highlightElement(element, selectorInfo) {
  ensureOverlayHost();
  clearHighlight();

  const rect = element.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'sh-highlight';
  overlay.style.cssText = `
    position: fixed;
    top: ${rect.top - 2}px;
    left: ${rect.left - 2}px;
    width: ${rect.width + 4}px;
    height: ${rect.height + 4}px;
    border: 2px solid #2563eb;
    background: rgba(37, 99, 235, 0.12);
    border-radius: 4px;
    pointer-events: none;
    transition: opacity 0.2s;
  `;

  const label = document.createElement('div');
  label.style.cssText = `
    position: absolute;
    top: -22px;
    left: -2px;
    background: #2563eb;
    color: #fff;
    font: 11px/1 system-ui, sans-serif;
    padding: 3px 6px;
    border-radius: 3px 3px 0 0;
    white-space: nowrap;
  `;
  label.textContent = `${selectorInfo || 'selector'}`;
  overlay.appendChild(label);

  overlayShadow.appendChild(overlay);

  // Scroll into view
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Auto-clear after 5 seconds
  setTimeout(() => clearHighlight(), 5000);
}

function clearHighlight() {
  if (overlayShadow) {
    overlayShadow.innerHTML = '';
  }
}

/* - */
/*  In-browser healer (scan candidates → score → suggest replacements) */
/*  Ported from @selector-healer/core so the panel can heal without    */
/*  a headless browser - the content script already has the live DOM.  */
/* - */

/** Snapshot a DOM element's structural identity (matches core's fingerprint). */
function captureFingerprint(node) {
  const attributes = {};
  for (const attr of node.attributes) attributes[attr.name] = attr.value;

  const parentChain = [];
  let current = node.parentElement;
  for (let i = 0; i < 5 && current; i++) {
    const role = current.getAttribute('role');
    parentChain.unshift({
      tagName: current.tagName.toLowerCase(),
      ...(current.id ? { id: current.id } : {}),
      classes: [...current.classList],
      ...(role ? { role } : {}),
    });
    current = current.parentElement;
  }

  let siblingIndex = 0;
  if (node.parentElement) {
    const siblings = [...node.parentElement.children].filter((c) => c.tagName === node.tagName);
    siblingIndex = siblings.indexOf(node);
  }

  return {
    tagName: node.tagName.toLowerCase(),
    attributes,
    textContent: (node.textContent || '').trim().slice(0, 200),
    parentChain,
    siblingIndex,
  };
}

function cssEscapeId(id) {
  return String(id).replace(/([^\w-])/g, '\\$1');
}

function splitClasses(value) {
  return (value || '').split(/\s+/).filter(Boolean);
}

function buildCandidateSelectors(stored) {
  const selectors = [];
  const a = stored.attributes || {};
  const testId = a['data-testid'] ?? a['data-test-id'];
  if (testId) selectors.push(`[data-testid="${testId}"]`, `[data-test-id="${testId}"]`);
  if (a.id) selectors.push(`#${cssEscapeId(a.id)}`);
  if (a.role) selectors.push(`[role="${a.role}"]`);
  selectors.push(stored.tagName);
  const classes = splitClasses(a.class);
  if (classes.length > 0) selectors.push(`${stored.tagName}.${classes.slice(0, 3).join('.')}`);
  return selectors;
}

function scanCandidates(stored) {
  const raw = [];
  for (const sel of buildCandidateSelectors(stored)) {
    if (raw.length >= 20) break;
    let els;
    try {
      els = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of els) {
      if (raw.length >= 20) break;
      raw.push(captureFingerprint(el));
    }
  }

  const seen = new Set();
  return raw.filter((s) => {
    const key = `${s.tagName}:${s.attributes.id || ''}:${s.attributes['data-testid'] || ''}:${s.textContent.slice(0, 30)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* - scoring (faithful port of core/healer/scoring.ts) - */

const SCORING_RULES = [
  {
    weight: 0.3,
    score: (s, c) => {
      const sId = s.attributes['data-testid'] ?? s.attributes['data-test-id'];
      if (sId === undefined) return -1;
      const cId = c.attributes['data-testid'] ?? c.attributes['data-test-id'];
      if (cId === undefined) return 0;
      return sId === cId ? 1 : 0;
    },
  },
  {
    weight: 0.15,
    score: (s, c) => {
      if (!s.attributes.id) return -1;
      if (!c.attributes.id) return 0;
      return s.attributes.id === c.attributes.id ? 1 : 0;
    },
  },
  {
    weight: 0.1,
    score: (s, c) => {
      if (!s.attributes.role) return -1;
      if (!c.attributes.role) return 0;
      return s.attributes.role === c.attributes.role ? 1 : 0;
    },
  },
  { weight: 0.08, score: (s, c) => (s.tagName === c.tagName ? 1 : 0) },
  { weight: 0.1, score: (s, c) => textSimilarity(s.textContent, c.textContent) },
  {
    weight: 0.07,
    score: (s, c) => jaccard(splitClasses(s.attributes.class), splitClasses(c.attributes.class)),
  },
  {
    weight: 0.05,
    score: (s, c) => {
      const keys = ['aria-label', 'aria-labelledby', 'aria-describedby', 'name', 'placeholder'];
      let matches = 0;
      let checked = 0;
      for (const k of keys) {
        if (s.attributes[k] === undefined) continue;
        checked++;
        if (s.attributes[k] === c.attributes[k]) matches++;
      }
      return checked > 0 ? matches / checked : -1;
    },
  },
  { weight: 0.08, score: (s, c) => parentChainSimilarity(s.parentChain, c.parentChain) },
  {
    weight: 0.04,
    score: (s, c) => {
      if (s.siblingIndex === c.siblingIndex) return 1;
      const diff = Math.abs(s.siblingIndex - c.siblingIndex);
      if (diff === 1) return 0.5;
      if (diff <= 3) return 0.2;
      return 0;
    },
  },
  { weight: 0.03, score: (s, c) => attributeCoverage(s.attributes, c.attributes) },
];

function scoreCandidate(stored, candidate) {
  let weightedSum = 0;
  let applicableWeight = 0;
  for (const rule of SCORING_RULES) {
    const raw = rule.score(stored, candidate);
    if (raw < 0) continue;
    const quality = Math.min(1, Math.max(0, raw));
    applicableWeight += rule.weight;
    weightedSum += quality * rule.weight;
  }
  const confidence = applicableWeight > 0 ? weightedSum / applicableWeight : 0;
  return Math.min(1, Math.max(0, confidence));
}

function jaccard(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection++;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

function textSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;
  if (lb.includes(la) || la.includes(lb)) return 0.8;
  const sim = normLevenshtein(la, lb);
  return sim >= 0.5 ? sim : 0;
}

function normLevenshtein(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return 1 - (prev[n] ?? maxLen) / maxLen;
}

function parentChainSimilarity(sChain, cChain) {
  if (!sChain.length || !cChain.length) return 0;
  const maxDepth = Math.min(sChain.length, cChain.length, 3);
  let score = 0;
  let totalWeight = 0;
  for (let i = 0; i < maxDepth; i++) {
    const sA = sChain[sChain.length - 1 - i];
    const cA = cChain[cChain.length - 1 - i];
    if (!sA || !cA) break;
    const depthWeight = 1 / (i + 1);
    totalWeight += depthWeight;
    let ancestorScore = 0;
    if (sA.tagName === cA.tagName) ancestorScore += 0.4;
    if (sA.id && sA.id === cA.id) ancestorScore += 0.3;
    if (sA.role && sA.role === cA.role) ancestorScore += 0.2;
    ancestorScore += jaccard(sA.classes || [], cA.classes || []) * 0.1;
    score += depthWeight * Math.min(1, ancestorScore);
  }
  return totalWeight > 0 ? score / totalWeight : 0;
}

function attributeCoverage(stored, candidate) {
  const skip = new Set(['class', 'id', 'style', 'data-testid', 'data-test-id', 'role']);
  const keys = Object.keys(stored).filter((k) => !skip.has(k));
  if (keys.length === 0) return -1;
  let matches = 0;
  for (const k of keys) if (candidate[k] === stored[k]) matches++;
  return matches / keys.length;
}

/* - replacement code (faithful port of core/healer/replacement-code.ts) - */

function escapeQuote(str) {
  return String(str).replace(/'/g, "\\'");
}

function buildCssSelector(fp) {
  let sel = fp.tagName;
  if (fp.attributes.id) return `${sel}#${cssEscapeId(fp.attributes.id)}`;
  const classes = splitClasses(fp.attributes.class);
  if (classes.length > 0) sel += `.${classes.slice(0, 2).join('.')}`;
  return sel;
}

// ARIA roles whose accessible name comes from the element's own text content.
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

function implicitRole(fp) {
  const tag = fp.tagName.toLowerCase();
  const type = (fp.attributes.type || '').toLowerCase();
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

function accessibleName(fp) {
  const ariaLabel = (fp.attributes['aria-label'] || '').trim();
  if (ariaLabel) return ariaLabel;
  const text = (fp.textContent || '').trim();
  if (text && text.length <= 50) return text;
  return undefined;
}

function generateReplacementCode(fp, framework) {
  const a = fp.attributes;
  const testId = a['data-testid'] ?? a['data-test-id'];
  if (framework === 'cypress') {
    if (testId) return `cy.get('[data-testid="${escapeQuote(testId)}"]')`;
    if (a.id) return `cy.get('#${cssEscapeId(a.id)}')`;
    if (a.role) return `cy.get('[role="${escapeQuote(a.role)}"]')`;
    if (fp.textContent && fp.textContent.length <= 50)
      return `cy.contains('${escapeQuote(fp.textContent)}')`;
    return `cy.get('${buildCssSelector(fp)}')`;
  }
  if (framework === 'webdriverio') {
    if (testId) return `$('[data-testid="${escapeQuote(testId)}"]')`;
    if (a['aria-label']) return `$('aria/${escapeQuote(a['aria-label'])}')`;
    if (a.id) return `$('#${cssEscapeId(a.id)}')`;
    if (a.role) return `$('[role="${escapeQuote(a.role)}"]')`;
    return `$('${buildCssSelector(fp)}')`;
  }
  if (framework === 'testcafe') {
    if (testId) return `Selector('[data-testid="${escapeQuote(testId)}"]')`;
    if (a.id) return `Selector('#${cssEscapeId(a.id)}')`;
    if (a.role) return `Selector('[role="${escapeQuote(a.role)}"]')`;
    if (fp.textContent && fp.textContent.length <= 50)
      return `Selector('${fp.tagName}').withText('${escapeQuote(fp.textContent)}')`;
    return `Selector('${buildCssSelector(fp)}')`;
  }
  // playwright (default)
  if (testId) return `page.getByTestId('${escapeQuote(testId)}')`;
  const role = a.role ?? implicitRole(fp);
  const name = accessibleName(fp);
  if (role && name && (a.role !== undefined || NAME_FROM_CONTENT_ROLES.has(role))) {
    return `page.getByRole('${role}', { name: '${escapeQuote(name)}' })`;
  }
  if (a['aria-label']) return `page.getByLabel('${escapeQuote(a['aria-label'])}')`;
  if (a.placeholder) return `page.getByPlaceholder('${escapeQuote(a.placeholder)}')`;
  if (fp.textContent && fp.textContent.length <= 50)
    return `page.getByText('${escapeQuote(fp.textContent)}')`;
  if (a.role) return `page.getByRole('${a.role}')`;
  if (a.id) return `page.locator('#${cssEscapeId(a.id)}')`;
  return `page.locator('${buildCssSelector(fp)}')`;
}

/** Top-3 ranked replacement suggestions for a stored fingerprint. */
function healSelector(stored, framework) {
  if (!stored) return [];
  const fw = framework || 'playwright';
  return scanCandidates(stored)
    .map((fp) => ({
      replacementCode: generateReplacementCode(fp, fw),
      confidence: scoreCandidate(stored, fp),
    }))
    .filter((c) => c.confidence >= 0.2)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

/* - */
/*  Message Handler (guarded against duplicate registration)           */
/* - */

const alreadyRegistered = typeof self !== 'undefined' && self.__selectorHealerLoaded;
// Register only in a real content-script context (browser has `self` + `chrome`).
// In a Node/test context these are absent, so the pure functions below can be
// imported without trying to wire up Chrome messaging.
if (
  !alreadyRegistered &&
  typeof self !== 'undefined' &&
  typeof chrome !== 'undefined' &&
  chrome.runtime?.onMessage
) {
  self.__selectorHealerLoaded = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ping') {
      sendResponse({ type: 'pong' });
      return true;
    }

    if (msg.type === 'evaluate') {
      const elements = evaluateSelector(msg.selector);
      const matchCount = elements.length;
      let status = 'ok';
      if (matchCount === 0) status = 'broken';
      else if (matchCount > 1) status = 'multiple-matches';

      sendResponse({
        type: 'evaluateResult',
        selectorId: msg.selector.id,
        matchCount,
        status,
      });
      return true;
    }

    if (msg.type === 'highlight') {
      const elements = evaluateSelector(msg.selector);
      if (elements.length > 0) {
        const label = `${msg.selector.selectorType}('${msg.selector.rawValue}')`;
        highlightElement(elements[0], label);
        sendResponse({ type: 'highlightResult', selectorId: msg.selector.id, success: true });
      } else {
        sendResponse({ type: 'highlightResult', selectorId: msg.selector.id, success: false });
      }
      return true;
    }

    if (msg.type === 'clearHighlight') {
      clearHighlight();
      sendResponse({ type: 'ok' });
      return true;
    }

    if (msg.type === 'heal') {
      const suggestions = healSelector(msg.fingerprint, msg.framework || 'playwright');
      sendResponse({ type: 'healResult', selectorId: msg.selector.id, suggestions });
      return true;
    }

    return false;
  });
} // end of __selectorHealerLoaded guard

/* - */
/*  Test-only exports - a no-op in the browser (content scripts have    */
/*  no CommonJS `module`). Lets unit tests import the pure healer logic. */
/* - */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    evaluateSelector,
    healSelector,
    scanCandidates,
    captureFingerprint,
    scoreCandidate,
    generateReplacementCode,
    implicitRole,
    accessibleName,
    buildCandidateSelectors,
    textSimilarity,
    normLevenshtein,
    jaccard,
  };
}
