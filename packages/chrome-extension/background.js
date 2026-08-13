/**
 * Selector Healer - Background Service Worker
 *
 * Bridges the WebSocket connection from the CLI `serve` command to the
 * DevTools panel and content scripts.
 */

const DEFAULT_WS_URL = 'ws://localhost:7400';
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

let ws = null;
let panelPort = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let cachedSelectors = [];
let cachedFingerprints = {};
/** Last server URL used, so we can reconnect when a panel reopens. */
let lastWsUrl = DEFAULT_WS_URL;
/** True once a socket has opened - gates auto-reconnect to genuine drops. */
let everConnected = false;
/** Tracks tabs where we have already injected the content script */
const injectedTabs = new Set();
/** Tracks in-flight injection promises to avoid duplicate inject calls */
const pendingInjections = new Map();

/* - */
/*  Panel Connection (long-lived port)                                 */
/* - */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;

  panelPort = port;

  // Send cached data if available
  if (cachedSelectors.length > 0) {
    port.postMessage({ type: 'ws:selectors', data: cachedSelectors });
  }
  if (Object.keys(cachedFingerprints).length > 0) {
    port.postMessage({ type: 'ws:fingerprints', data: cachedFingerprints });
  }

  // Send current connection status
  port.postMessage({
    type: 'ws:status',
    connected: ws !== null && ws.readyState === WebSocket.OPEN,
  });

  port.onMessage.addListener((msg) => {
    handlePanelMessage(msg);
  });

  port.onDisconnect.addListener(() => {
    panelPort = null;
    // No panel is watching - stop reconnect attempts (and the error spam) and
    // drop the socket until a panel opens again.
    clearTimeout(reconnectTimer);
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    ws = null;
  });

  // Attempt a connection now that a panel is open (uses the last-known URL).
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket(lastWsUrl);
  }
});

function sendToPanel(msg) {
  if (panelPort) {
    try {
      panelPort.postMessage(msg);
    } catch {
      panelPort = null;
    }
  }
}

/* - */
/*  Panel Message Handling                                             */
/* - */

async function handlePanelMessage(msg) {
  switch (msg.type) {
    case 'ws:connect':
      connectWebSocket(msg.url || DEFAULT_WS_URL);
      break;

    case 'evaluate': {
      const ready = await ensureContentScript(msg.tabId);
      if (!ready) {
        sendToPanel({
          type: 'evaluateResult',
          selectorId: msg.selector?.id,
          matchCount: 0,
          status: 'page-load-failed',
        });
        break;
      }
      chrome.tabs.sendMessage(
        msg.tabId,
        { type: 'evaluate', selector: msg.selector },
        (response) => {
          if (chrome.runtime.lastError) {
            sendToPanel({
              type: 'evaluateResult',
              selectorId: msg.selector?.id,
              matchCount: 0,
              status: 'page-load-failed',
            });
            return;
          }
          if (response) sendToPanel(response);
        },
      );
      break;
    }

    case 'highlight': {
      const ready = await ensureContentScript(msg.tabId);
      if (!ready) break;
      chrome.tabs.sendMessage(
        msg.tabId,
        { type: 'highlight', selector: msg.selector },
        (response) => {
          if (chrome.runtime.lastError) return;
          if (response) sendToPanel(response);
        },
      );
      break;
    }

    case 'heal': {
      const ready = await ensureContentScript(msg.tabId);
      if (!ready) {
        sendToPanel({ type: 'healResult', selectorId: msg.selector?.id, suggestions: [] });
        break;
      }
      chrome.tabs.sendMessage(
        msg.tabId,
        {
          type: 'heal',
          selector: msg.selector,
          fingerprint: msg.fingerprint,
          framework: msg.framework,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            sendToPanel({ type: 'healResult', selectorId: msg.selector?.id, suggestions: [] });
            return;
          }
          if (response) sendToPanel(response);
        },
      );
      break;
    }

    case 'clearHighlight':
      chrome.tabs.sendMessage(msg.tabId, { type: 'clearHighlight' }, () => {
        if (chrome.runtime.lastError) {
          /* ignore */
        }
      });
      break;
  }
}

/* - */
/*  Content Script Injection                                           */
/* - */

/**
 * Ensures the content script is loaded in the given tab.
 * First tries a ping - if already loaded (via manifest), skips injection.
 * Deduplicates concurrent calls for the same tab.
 * Resolves to true if ready, false if injection failed.
 */
async function ensureContentScript(tabId) {
  if (injectedTabs.has(tabId)) return true;

  // If another call is already injecting for this tab, wait for it
  if (pendingInjections.has(tabId)) {
    return pendingInjections.get(tabId);
  }

  const promise = (async () => {
    try {
      // Try pinging the content script - it may already be loaded via manifest
      const response = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      if (response?.type === 'pong') {
        injectedTabs.add(tabId);
        return true;
      }
    } catch {
      // Not loaded yet - inject it
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content.js'],
      });
      injectedTabs.add(tabId);
      // Give the script a moment to register its message listener
      await new Promise((resolve) => setTimeout(resolve, 150));
      return true;
    } catch {
      return false;
    } finally {
      pendingInjections.delete(tabId);
    }
  })();

  pendingInjections.set(tabId, promise);
  return promise;
}

/** Clear injection cache when a tab navigates (content script re-injects via manifest) */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    injectedTabs.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

/* - */
/*  WebSocket Connection                                               */
/* - */

function connectWebSocket(url, { retry = false } = {}) {
  lastWsUrl = url;
  if (!retry) {
    everConnected = false;
    reconnectAttempt = 0;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
  }

  clearTimeout(reconnectTimer);

  try {
    ws = new WebSocket(url);
  } catch {
    // Invalid URL - surface as disconnected, never loop on it.
    sendToPanel({ type: 'ws:status', connected: false });
    return;
  }

  ws.onopen = () => {
    everConnected = true;
    reconnectAttempt = 0;
    sendToPanel({ type: 'ws:status', connected: true });
    chrome.storage.local.set({ wsUrl: url });
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch {
      /* malformed JSON */
    }
  };

  ws.onclose = () => {
    sendToPanel({ type: 'ws:status', connected: false });
    // Only auto-retry after a socket had actually opened (i.e. the server
    // restarted). A failed *initial* connect does not loop - the user starts
    // the server and clicks Connect, so there's at most one refused-connection.
    if (everConnected) scheduleReconnect(url);
  };

  ws.onerror = () => {
    // onclose will fire after onerror
  };
}

function scheduleReconnect(url) {
  // Only keep retrying while a panel is open - avoids ERR_CONNECTION_REFUSED
  // spam in the background when the CLI server simply isn't running.
  if (!panelPort) return;
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => connectWebSocket(url, { retry: true }), delay);
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'selectors':
      cachedSelectors = msg.data;
      sendToPanel({ type: 'ws:selectors', data: msg.data });
      break;

    case 'fingerprints':
      cachedFingerprints = msg.data;
      sendToPanel({ type: 'ws:fingerprints', data: msg.data });
      break;

    case 'update':
      cachedSelectors = msg.data.selectors;
      cachedFingerprints = msg.data.fingerprints;
      sendToPanel({ type: 'ws:selectors', data: msg.data.selectors });
      sendToPanel({ type: 'ws:fingerprints', data: msg.data.fingerprints });
      break;
  }
}

/* - */
/*  Remember the last server URL (used when a panel opens)             */
/* - */

chrome.storage.local.get('wsUrl', (result) => {
  if (result.wsUrl) lastWsUrl = result.wsUrl;
});
