/**
 * Selector Healer — Content Script
 *
 * Evaluates Playwright-style selectors against the live DOM and
 * highlights matched elements. Runs in every page frame.
 */

/* ------------------------------------------------------------------ */
/*  Implicit ARIA role map                                             */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Selector Evaluation                                                */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Accessible Name Computation (simplified)                           */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Element Highlighting                                               */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Message Handler (guarded against duplicate registration)           */
/* ------------------------------------------------------------------ */

if (self.__selectorHealerLoaded) {
  // Script already loaded in this world — skip re-registration
} else {
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

    return false;
  });
} // end of __selectorHealerLoaded guard
