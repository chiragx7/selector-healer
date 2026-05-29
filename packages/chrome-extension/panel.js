/**
 * Selector Healer — DevTools Panel
 *
 * Receives selectors from the CLI server via the background service worker,
 * evaluates them against the inspected page, and displays the results.
 */

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let selectors = [];
let fingerprints = {};
const evaluationResults = new Map(); // selectorId -> { matchCount, status }
let isConnected = false;

const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

/* ------------------------------------------------------------------ */
/*  DOM References                                                     */
/* ------------------------------------------------------------------ */

const wsStatusEl = document.getElementById('ws-status');
const wsUrlInput = document.getElementById('ws-url');
const btnConnect = document.getElementById('btn-connect');
const btnEvaluate = document.getElementById('btn-evaluate');
const summaryEl = document.getElementById('summary');
const selectorListEl = document.getElementById('selector-list');
const filterStatus = document.getElementById('filter-status');
const filterSearch = document.getElementById('filter-search');

/* ------------------------------------------------------------------ */
/*  Background Port                                                    */
/* ------------------------------------------------------------------ */

const port = chrome.runtime.connect({ name: 'panel' });

port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'ws:status':
      isConnected = msg.connected;
      updateConnectionUI();
      break;

    case 'ws:selectors':
      selectors = msg.data || [];
      evaluationResults.clear();
      renderList();
      updateSummary();
      btnEvaluate.disabled = selectors.length === 0;
      break;

    case 'ws:fingerprints':
      fingerprints = msg.data || {};
      break;

    case 'evaluateResult':
      evaluationResults.set(msg.selectorId, {
        matchCount: msg.matchCount,
        status: msg.status,
      });
      updateRow(msg.selectorId);
      updateSummary();
      break;

    case 'highlightResult':
      // Visual feedback could be added here
      break;
  }
});

/* ------------------------------------------------------------------ */
/*  Event Listeners                                                    */
/* ------------------------------------------------------------------ */

btnConnect.addEventListener('click', () => {
  const url = wsUrlInput.value.trim();
  if (url) {
    port.postMessage({ type: 'ws:connect', url });
  }
});

btnEvaluate.addEventListener('click', () => evaluateAll());

filterStatus.addEventListener('change', () => renderList());
filterSearch.addEventListener('input', () => renderList());

/* ------------------------------------------------------------------ */
/*  Connection UI                                                      */
/* ------------------------------------------------------------------ */

function updateConnectionUI() {
  if (isConnected) {
    wsStatusEl.textContent = 'Connected';
    wsStatusEl.className = 'status-badge connected';
    btnConnect.textContent = 'Reconnect';
  } else {
    wsStatusEl.textContent = 'Disconnected';
    wsStatusEl.className = 'status-badge disconnected';
    btnConnect.textContent = 'Connect';
  }
}

/* ------------------------------------------------------------------ */
/*  Evaluate All                                                       */
/* ------------------------------------------------------------------ */

function evaluateAll() {
  evaluationResults.clear();
  renderList();

  for (const sel of selectors) {
    port.postMessage({
      type: 'evaluate',
      tabId: inspectedTabId,
      selector: sel,
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Summary                                                            */
/* ------------------------------------------------------------------ */

function updateSummary() {
  const total = selectors.length;
  let ok = 0;
  let broken = 0;
  let multi = 0;
  let pending = 0;

  for (const sel of selectors) {
    const result = evaluationResults.get(sel.id);
    if (!result) {
      pending++;
      continue;
    }
    if (result.status === 'ok') ok++;
    else if (result.status === 'broken') broken++;
    else if (result.status === 'multiple-matches') multi++;
    else pending++;
  }

  summaryEl.innerHTML = `
    <span class="summary-item">${total} selectors</span>
    <span class="summary-item ok">${ok} OK</span>
    <span class="summary-item broken">${broken} Broken</span>
    ${multi > 0 ? `<span class="summary-item multi">${multi} Multiple</span>` : ''}
    ${pending > 0 ? `<span class="summary-item pending">${pending} Pending</span>` : ''}
  `;
}

/* ------------------------------------------------------------------ */
/*  Render Selector List                                               */
/* ------------------------------------------------------------------ */

function renderList() {
  const statusFilter = filterStatus.value;
  const searchFilter = filterSearch.value.toLowerCase().trim();

  // Group selectors by file
  const byFile = new Map();
  for (const sel of selectors) {
    const result = evaluationResults.get(sel.id);
    const status = result ? result.status : 'pending';

    // Apply filters
    if (statusFilter !== 'all' && status !== statusFilter) continue;
    if (searchFilter && !sel.rawValue.toLowerCase().includes(searchFilter)) continue;

    const list = byFile.get(sel.filePath) || [];
    list.push({ selector: sel, status, matchCount: result?.matchCount ?? 0 });
    byFile.set(sel.filePath, list);
  }

  if (byFile.size === 0) {
    selectorListEl.innerHTML =
      selectors.length === 0
        ? `<div class="empty-state"><p>No selectors loaded.</p><p>Start the CLI server:</p><code>selector-healer serve</code></div>`
        : `<div class="empty-state"><p>No selectors match the current filter.</p></div>`;
    return;
  }

  let html = '';
  for (const [filePath, items] of byFile) {
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const ok = items.filter((i) => i.status === 'ok').length;
    const broken = items.filter((i) => i.status === 'broken').length;

    html += `<div class="file-group">`;
    html += `<div class="file-header">`;
    html += `<span class="file-icon">📄</span>`;
    html += `<span>${escapeHtml(fileName)}</span>`;
    html += `<span class="file-stats">${ok} ok, ${broken} broken, ${items.length} total</span>`;
    html += '</div>';

    for (const item of items) {
      html += renderRow(item);
    }
    html += '</div>';
  }

  selectorListEl.innerHTML = html;

  // Attach click listeners
  for (const row of selectorListEl.querySelectorAll('.selector-row')) {
    row.addEventListener('click', () => {
      const selectorId = row.dataset.selectorId;
      const sel = selectors.find((s) => s.id === selectorId);
      if (sel) {
        port.postMessage({ type: 'highlight', tabId: inspectedTabId, selector: sel });
      }
    });
  }
}

function renderRow(item) {
  const sel = item.selector;
  const status = item.status;
  const icon = getStatusIcon(status);
  const value = truncate(sel.rawValue, 50);

  let suggestion = '';
  if (status === 'broken' && fingerprints[sel.id]) {
    suggestion = `<span class="suggestion">has baseline</span>`;
  }

  return `
    <div class="selector-row status-${status}" data-selector-id="${escapeHtml(sel.id)}" title="Click to highlight on page">
      <span class="status-icon">${icon}</span>
      <span class="selector-value">${escapeHtml(value)}</span>
      <span class="selector-type">${escapeHtml(sel.selectorType)}</span>
      <span class="selector-line">L${sel.line}</span>
      ${suggestion}
    </div>
  `;
}

function updateRow(selectorId) {
  const row = selectorListEl.querySelector(`[data-selector-id="${CSS.escape(selectorId)}"]`);
  if (!row) return;

  const result = evaluationResults.get(selectorId);
  if (!result) return;

  // Update status class
  row.className = `selector-row status-${result.status}`;

  // Update icon
  const iconEl = row.querySelector('.status-icon');
  if (iconEl) iconEl.textContent = getStatusIcon(result.status);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getStatusIcon(status) {
  switch (status) {
    case 'ok':
      return '✓';
    case 'broken':
      return '✗';
    case 'multiple-matches':
      return '⚠';
    case 'pending':
      return '◌';
    default:
      return '·';
  }
}

function truncate(str, max) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
