/**
 * Selector Healer — DevTools Panel
 *
 * Receives selectors from the CLI server via the background service worker,
 * evaluates them against the inspected page, requests healing suggestions for
 * broken selectors, and renders a dashboard (health ring + attention cards).
 */

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let selectors = [];
let fingerprints = {};
const evaluationResults = new Map(); // selectorId -> { matchCount, status }
const healResults = new Map(); // selectorId -> suggestion[]  (empty array = scanned, none found)
const healRequested = new Set(); // selectorIds for which a heal request is in flight
let isConnected = false;

const inspectedTabId = chrome.devtools.inspectedWindow.tabId;
const RING_CIRCUMFERENCE = 2 * Math.PI * 36;

/* ------------------------------------------------------------------ */
/*  DOM References                                                     */
/* ------------------------------------------------------------------ */

const wsStatusEl = document.getElementById('ws-status');
const wsUrlInput = document.getElementById('ws-url');
const btnConnect = document.getElementById('btn-connect');
const btnEvaluate = document.getElementById('btn-evaluate');
const filterSearch = document.getElementById('filter-search');
const appEl = document.getElementById('app');

/* ------------------------------------------------------------------ */
/*  Background Port                                                    */
/* ------------------------------------------------------------------ */

let port = null;
let keepaliveTimer = null;

/**
 * Connect (or reconnect) the long-lived port to the background service worker.
 * MV3 workers are recycled when idle, which silently kills the port — so we
 * re-establish it on disconnect and keep it warm with a periodic ping.
 */
function connectPort() {
  port = chrome.runtime.connect({ name: 'panel' });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    clearInterval(keepaliveTimer);
    // The worker was recycled — re-spawn it by reconnecting shortly.
    setTimeout(connectPort, 500);
  });
  clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(() => {
    try {
      port?.postMessage({ type: 'keepalive' });
    } catch {
      /* disconnected — onDisconnect will reconnect */
    }
  }, 20_000);
}

/** Post to the worker, reviving the port first if it was recycled. */
function post(msg) {
  try {
    if (!port) connectPort();
    port.postMessage(msg);
  } catch {
    connectPort();
    try {
      port.postMessage(msg);
    } catch {
      /* give up silently — the user can click again */
    }
  }
}

function handlePortMessage(msg) {
  switch (msg.type) {
    case 'ws:status':
      isConnected = msg.connected;
      updateConnectionUI();
      render();
      break;

    case 'ws:selectors':
      selectors = msg.data || [];
      evaluationResults.clear();
      healResults.clear();
      healRequested.clear();
      btnEvaluate.disabled = !isConnected || selectors.length === 0;
      render();
      break;

    case 'ws:fingerprints':
      fingerprints = msg.data || {};
      break;

    case 'evaluateResult': {
      evaluationResults.set(msg.selectorId, {
        matchCount: msg.matchCount,
        status: msg.status,
      });
      maybeRequestHeal(msg.selectorId, msg.status);
      render();
      break;
    }

    case 'healResult':
      healRequested.delete(msg.selectorId);
      healResults.set(msg.selectorId, msg.suggestions || []);
      render();
      break;
  }
}

/* ------------------------------------------------------------------ */
/*  Event Listeners                                                    */
/* ------------------------------------------------------------------ */

btnConnect.addEventListener('click', () => {
  const url = wsUrlInput.value.trim();
  if (url) post({ type: 'ws:connect', url });
});

btnEvaluate.addEventListener('click', () => evaluateAll());
filterSearch.addEventListener('input', () => render());

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
  btnEvaluate.disabled = !isConnected || selectors.length === 0;
}

/* ------------------------------------------------------------------ */
/*  Evaluate + Heal                                                    */
/* ------------------------------------------------------------------ */

function evaluateAll() {
  evaluationResults.clear();
  healResults.clear();
  healRequested.clear();
  render();

  for (const sel of selectors) {
    post({ type: 'evaluate', tabId: inspectedTabId, selector: sel });
  }
}

function maybeRequestHeal(selectorId, status) {
  if (status !== 'broken') return;
  const fp = fingerprints[selectorId];
  if (!fp) return;
  const sel = selectors.find((s) => s.id === selectorId);
  if (!sel) return;
  healRequested.add(selectorId);
  post({
    type: 'heal',
    tabId: inspectedTabId,
    selector: sel,
    fingerprint: fp,
    framework: sel.framework || 'playwright',
  });
}

/* ------------------------------------------------------------------ */
/*  Render                                                             */
/* ------------------------------------------------------------------ */

function render() {
  if (!isConnected) {
    appEl.innerHTML = `<div class="empty">
      <p>Not connected to the CLI server.</p>
      <p>Run <code>selector-healer serve</code> in your project, then click <strong>Connect</strong>.</p>
    </div>`;
    return;
  }

  if (selectors.length === 0) {
    appEl.innerHTML = `<div class="empty">
      <p>Connected — waiting for selectors.</p>
      <p>Make sure <code>selector-healer serve</code> has scanned your test files.</p>
    </div>`;
    return;
  }

  const counts = computeCounts();
  const evaluated = selectors.length - counts.pending;

  let html = renderHealth(counts, evaluated);

  if (evaluated === 0) {
    html += `<div class="spinner-note">Click <strong>Evaluate</strong> to check all ${selectors.length} selectors against this page.</div>`;
    appEl.innerHTML = html;
    attachHandlers();
    return;
  }

  const search = filterSearch.value.toLowerCase().trim();
  const order = { broken: 0, 'multiple-matches': 1, 'page-load-failed': 2, skipped: 2 };
  const attention = selectors
    .map((sel) => {
      const result = evaluationResults.get(sel.id);
      return { sel, status: result?.status, matchCount: result?.matchCount ?? 0 };
    })
    .filter((item) => item.status && item.status !== 'ok' && item.status in order)
    .filter((item) => !search || item.sel.rawValue.toLowerCase().includes(search))
    .sort((a, b) => order[a.status] - order[b.status]);

  if (attention.length === 0) {
    html += `<div class="all-clear"><div class="big">✓</div><div>All evaluated selectors are healthy.</div></div>`;
  } else {
    html += `<div class="section-title">Needs attention (${attention.length})</div>`;
    html += attention.map(renderCard).join('');
  }

  appEl.innerHTML = html;
  attachHandlers();
}

function computeCounts() {
  const counts = { ok: 0, broken: 0, multi: 0, failed: 0, pending: 0 };
  for (const sel of selectors) {
    const result = evaluationResults.get(sel.id);
    if (!result) {
      counts.pending++;
    } else if (result.status === 'ok') {
      counts.ok++;
    } else if (result.status === 'broken') {
      counts.broken++;
    } else if (result.status === 'multiple-matches') {
      counts.multi++;
    } else {
      counts.failed++;
    }
  }
  return counts;
}

function renderHealth(counts, evaluated) {
  const pct = evaluated > 0 ? Math.round((counts.ok / evaluated) * 100) : 0;
  const color = pct >= 90 ? 'var(--ok)' : pct >= 50 ? 'var(--multi)' : 'var(--broken)';
  const offset = RING_CIRCUMFERENCE * (1 - pct / 100);

  const chips = [
    `<span class="chip"><span class="dot ok"></span>OK <span class="count">${counts.ok}</span></span>`,
    `<span class="chip"><span class="dot broken"></span>Broken <span class="count">${counts.broken}</span></span>`,
  ];
  if (counts.multi > 0) {
    chips.push(
      `<span class="chip"><span class="dot multi"></span>Multiple <span class="count">${counts.multi}</span></span>`,
    );
  }
  if (counts.failed > 0) {
    chips.push(
      `<span class="chip"><span class="dot skip"></span>Failed <span class="count">${counts.failed}</span></span>`,
    );
  }
  if (counts.pending > 0) {
    chips.push(
      `<span class="chip"><span class="dot skip"></span>Pending <span class="count">${counts.pending}</span></span>`,
    );
  }

  return `<div class="health">
    <div class="ring">
      <svg width="84" height="84" viewBox="0 0 84 84">
        <circle cx="42" cy="42" r="36" fill="none" stroke="var(--track)" stroke-width="8"></circle>
        <circle cx="42" cy="42" r="36" fill="none" stroke="${color}" stroke-width="8"
          stroke-linecap="round" stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}"></circle>
      </svg>
      <div class="ring-label">
        <span class="ring-pct" style="color:${color}">${evaluated > 0 ? `${pct}%` : '—'}</span>
        <span class="ring-sub">Healthy</span>
      </div>
    </div>
    <div class="chips">${chips.join('')}</div>
  </div>`;
}

function renderCard(item) {
  const { sel, status, matchCount } = item;
  const cls = status === 'broken' ? 'broken' : status === 'multiple-matches' ? 'multi' : 'failed';
  const badge =
    status === 'broken' ? 'Broken' : status === 'multiple-matches' ? 'Multiple' : 'Failed';
  const fileName = (sel.filePath || '').split(/[/\\]/).pop() || sel.filePath || '';

  let body = `<div class="card-sel"><span class="sel-kind">${escapeHtml(sel.selectorType)}: </span>${escapeHtml(sel.rawValue)}</div>`;

  if (status === 'broken') {
    body += renderHealBody(sel);
  } else if (status === 'multiple-matches') {
    body += `<div class="card-note">${matchCount} elements match — make this selector more specific.</div>`;
  } else {
    body += `<div class="card-note">Couldn't evaluate (the page didn't load or the selector kind isn't supported live).</div>`;
  }

  return `<div class="card ${cls}">
    <div class="card-head">
      <span class="card-badge ${cls}">${badge}</span>
      <a class="card-loc" data-selector-id="${escapeHtml(sel.id)}" title="Highlight on page">${escapeHtml(fileName)}:${sel.line}</a>
    </div>
    ${body}
  </div>`;
}

function renderHealBody(sel) {
  if (!fingerprints[sel.id]) {
    return `<div class="card-note">No baseline captured — run <code>capture</code> to enable auto-heal.</div>`;
  }
  if (healRequested.has(sel.id) && !healResults.has(sel.id)) {
    return `<div class="card-note">Scanning the page for replacements…</div>`;
  }
  const suggestions = healResults.get(sel.id);
  if (!suggestions || suggestions.length === 0) {
    return `<div class="card-note">No confident replacement found on this page.</div>`;
  }

  const top = suggestions[0];
  const pct = Math.round(top.confidence * 100);
  const color =
    top.confidence >= 0.7 ? 'var(--ok)' : top.confidence >= 0.4 ? 'var(--multi)' : 'var(--broken)';

  let html = `<div class="suggestion">
    <div class="suggestion-head">
      <span class="suggestion-label">Suggested fix</span>
      <span class="confidence">
        <span class="confidence-track"><span class="confidence-fill" style="width:${pct}%;background:${color}"></span></span>
        <span class="confidence-pct" style="color:${color}">${pct}%</span>
      </span>
    </div>
    <div class="suggestion-code">
      <code>${escapeHtml(top.replacementCode)}</code>
      <button class="btn-copy" data-code="${escapeHtml(top.replacementCode)}">Copy</button>
    </div>`;

  for (const alt of suggestions.slice(1)) {
    html += `<div class="suggestion-alt"><span class="alt-pct">${Math.round(alt.confidence * 100)}%</span><span>${escapeHtml(alt.replacementCode)}</span></div>`;
  }

  html += '</div>';
  return html;
}

/* ------------------------------------------------------------------ */
/*  Handlers (re-attached after each render)                           */
/* ------------------------------------------------------------------ */

function attachHandlers() {
  for (const loc of appEl.querySelectorAll('.card-loc')) {
    loc.addEventListener('click', () => {
      const sel = selectors.find((s) => s.id === loc.dataset.selectorId);
      if (sel) post({ type: 'highlight', tabId: inspectedTabId, selector: sel });
    });
  }

  for (const btn of appEl.querySelectorAll('.btn-copy')) {
    btn.addEventListener('click', () => {
      const code = btn.dataset.code || '';
      navigator.clipboard.writeText(code).then(
        () => {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 1400);
        },
        () => {
          btn.textContent = 'Failed';
        },
      );
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

// Initial paint + open the (self-healing) connection to the worker
connectPort();
updateConnectionUI();
render();
