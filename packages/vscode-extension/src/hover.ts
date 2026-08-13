import type { DomFingerprint, VerificationResult, VerificationStatus } from '@selector-healer/core';
import { rateSelectorType, renderSelectorCode } from '@selector-healer/core';
import * as vscode from 'vscode';
import { findCallExpressionRange } from './code-actions.js';
import { healerState } from './state.js';
import { activeResults } from './webview-content.js';

/** Everything the hover card needs, already reduced from extension state. Pure input → pure markdown. */
export interface HoverInfo {
  /** The reconstructed locator, e.g. `page.getByTestId('submit-btn')`. */
  code: string;
  status: VerificationStatus;
  matchCount: number;
  /** Epoch ms of the last verify run, if any. */
  lastRunAt?: number;
  /** A one-line description of the element it matches, e.g. `<button data-testid="save">Save</button>`. */
  element?: string;
  pageUrl?: string;
  /** ISO time the baseline was captured. */
  capturedAt?: string;
  /** Why it broke (top break reason), when broken. */
  why?: string;
  /** Top heal suggestion, when broken. */
  suggestion?: { code: string; pct: number };
  /** Static robustness of the selector kind. */
  robustness: { tier: string; reason: string };
}

/** Compact "3m ago" relative time. */
function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** A one-line HTML-ish sketch of a fingerprinted element for the hover. */
export function describeElement(fp: DomFingerprint): string {
  const attrs: string[] = [];
  const testid = fp.attributes['data-testid'] ?? fp.attributes['data-test-id'];
  if (testid) attrs.push(`data-testid="${testid}"`);
  else if (fp.attributes.id) attrs.push(`id="${fp.attributes.id}"`);
  if (fp.attributes.role) attrs.push(`role="${fp.attributes.role}"`);
  const head = `<${fp.tagName}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  const text = (fp.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return text ? `${head}${text}</${fp.tagName}>` : head;
}

function statusLine(status: VerificationStatus, matchCount: number): string {
  switch (status) {
    case 'ok':
      return '$(pass) **Healthy** - resolves to one element';
    case 'broken':
      return '$(error) **Broken** - no match in the live DOM';
    case 'multiple-matches':
      return `$(list-flat) **Ambiguous** - matches ${matchCount} elements`;
    case 'page-load-failed':
      return '$(warning) **Page could not load** - not verified';
    default:
      return '$(circle-slash) **No baseline** - run Capture';
  }
}

/**
 * Build the hover card markdown for a selector. Pure - no VS Code or state
 * access - so it's unit-testable. The caller wraps it in a themed
 * `MarkdownString`.
 *
 * @param info - the reduced hover facts
 * @returns markdown (uses `$(codicon)` tokens; render with `supportThemeIcons`)
 */
export function buildHoverMarkdown(info: HoverInfo): string {
  const parts: string[] = [];
  parts.push(`### \`${info.code}\``);

  let status = statusLine(info.status, info.matchCount);
  if (info.lastRunAt) status += ` · verified ${relTime(info.lastRunAt)}`;
  parts.push(status);

  if (info.why) parts.push(`**Why it broke:** ${info.why}`);
  if (info.suggestion) {
    parts.push(`**Suggested fix:** \`${info.suggestion.code}\` · ${info.suggestion.pct}%`);
  }

  const meta: string[] = [];
  if (info.element) {
    const label = info.status === 'ok' ? 'Matches' : 'Baseline element';
    meta.push(`**${label}:** \`${info.element}\``);
  }
  if (info.pageUrl) meta.push(`**Page:** ${info.pageUrl}`);
  if (info.capturedAt) {
    const t = new Date(info.capturedAt).getTime();
    if (!Number.isNaN(t)) meta.push(`**Captured:** ${relTime(t)}`);
  }
  if (meta.length) parts.push(meta.join('\n\n'));
  else if (info.status === 'skipped') parts.push('_No baseline captured for this selector yet._');

  parts.push(`_Robustness: ${info.robustness.tier} - ${info.robustness.reason}_`);

  return parts.join('\n\n');
}

/**
 * Hover a selector in a test file to see what it points to, its live status,
 * last-verified time, page, and - when broken - why and the suggested fix.
 * Driven entirely by the current {@link healerState}; only *verified* selectors
 * get a card (Skipped ones stay silent, like the CodeLens and gutter).
 */
export class SelectorHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const path = document.uri.fsPath;
    const lineText = document.lineAt(position.line).text;

    for (const r of activeResults(healerState.snapshot)) {
      if (r.selector.filePath !== path || r.selector.line - 1 !== position.line) continue;
      const call = findCallExpressionRange(lineText, r.selector.column - 1);
      if (!call || position.character < call.start || position.character > call.end) continue;

      const info = toHoverInfo(r);
      const md = new vscode.MarkdownString(buildHoverMarkdown(info));
      md.supportThemeIcons = true;
      const range = new vscode.Range(position.line, call.start, position.line, call.end);
      return new vscode.Hover(md, range);
    }
    return undefined;
  }
}

/** Reduce a verification result (+ current state) into the pure {@link HoverInfo}. */
function toHoverInfo(r: VerificationResult): HoverInfo {
  const snap = healerState.snapshot;
  const fp: DomFingerprint | undefined = r.liveFingerprint ?? r.storedFingerprint;
  const top = healerState.suggestionsFor(r.selector.filePath, r.selector.line)[0];
  return {
    code: renderSelectorCode(r.selector, r.selector.framework) ?? r.selector.rawValue,
    status: r.status,
    matchCount: r.matchCount,
    lastRunAt: snap.lastRunAt,
    element: fp ? describeElement(fp) : undefined,
    pageUrl: r.storedFingerprint?.pageUrl ?? r.liveFingerprint?.pageUrl,
    capturedAt: r.storedFingerprint?.capturedAt,
    why: r.status === 'broken' ? snap.explanationsById.get(r.selector.id) : undefined,
    suggestion:
      r.status === 'broken' && top
        ? { code: top.replacementCode, pct: Math.round(top.confidence * 100) }
        : undefined,
    robustness: rateSelectorType(r.selector.selectorType),
  };
}
