# Selector Healer for VS Code

**Catch broken test selectors before CI does.** Selector Healer snapshots each selector in your test files against your live DOM, flags the ones that break when the UI changes, and suggests (or applies) an AST-based fix — right in your editor. Everything runs locally: **no network calls beyond your own app, no telemetry**.

Works with **Playwright**, **Cypress**, **WebdriverIO**, and **TestCafe** test files; verification drives your running app via Playwright.

## Features

### Unified dashboard
One panel — in the sidebar, or opened full-screen in an editor tab — showing overall **selector health**, a filterable list (broken / ambiguous / healthy), and inline heal actions on every card. A live **Baseline** view lists which selectors are captured, and a **Heal History** view lists every fix you've applied.

### Live verify + watch mode
Run **Verify Now** to check every selector against the live DOM, or turn on **Watch** to auto re-verify a test file the moment you save it — so breakage surfaces as you type, not the next morning in CI.

### Explainable, previewable heals
For each broken selector you get:
- **Why it broke** — a plain-English reason (e.g. *"text changed from 'Log in' to 'Sign in'"*, *"data-testid removed; matched by role"*).
- **Ranked suggestions** — the best fix, plus **all runner-up candidates** side by side so you can pick a different one.
- **"Why NN%?"** — expand any suggestion to see the per-rule scoring breakdown behind its confidence (test-id match, text, role, structure…).
- **Diff preview** — peek the before→after edit before you Apply.

### Skip what you don't want to fix
**Skip** any broken selector to set it aside — it drops out of the list, the health count, "Heal all", *and* the editor's squiggles/gutter/CodeLens. It comes back the moment you edit that selector, and everything you've skipped is one click from **Restore**.

### Undo, always
Every applied fix is recorded in **Heal History** with a one-click **Undo** — the tool never makes a change you can't reverse.

### Deep editor integration
- **Quick Fixes** (`Ctrl+.` / `Cmd+.`) on any broken selector, ranked, with the best marked preferred.
- **Per-selector CodeLens** — `✓ OK` / `✨ Heal → …` inline above each selector.
- **Gutter dots** + **Problems panel** diagnostics for broken/ambiguous selectors.
- **Fragility lint** — proactively flags brittle locators (raw text, structural CSS, XPath) and offers a sturdier replacement, even before anything breaks.
- **Status bar** health indicator.

## Getting started

1. Install this extension.
2. Make sure **Playwright** is a dev dependency in your project (it drives the live DOM).
3. Run **Create Config** — it auto-detects your framework, base URL, and test directory and writes a ready-to-use `selector-healer.config`. (Or write one by hand:)

   ```typescript
   import type { HealerConfig } from '@selector-healer/core';

   export default {
     testDir: './tests',
     baseUrl: 'http://localhost:3000',
     headless: true,
   } satisfies HealerConfig;
   ```
4. Run **Capture Baseline** to snapshot your selectors.
5. Run **Verify Now** (or turn on **Watch**) — broken selectors light up with suggestions.

## Commands

| Command | Description |
|---|---|
| `Selector Healer: Verify Now` | Check every selector against the live DOM |
| `Selector Healer: Capture Baseline` | Snapshot fingerprints for all selectors |
| `Selector Healer: Open Dashboard` / `Open Full Dashboard` | Focus the sidebar, or open the full editor-tab dashboard |
| `Selector Healer: Toggle Watch Mode` | Auto re-verify a test file on save |
| `Selector Healer: Apply All High-Confidence Fixes` | Batch-apply fixes above the auto-apply threshold |
| `Selector Healer: Heal History` | Browse applied fixes and undo any of them |
| `Selector Healer: Undo Last Heal` | Revert the most recent fix |
| `Selector Healer: Prune Stale Baseline` | Remove fingerprints for selectors that no longer exist |
| `Selector Healer: Create Config` | Generate a `selector-healer.config` for your project |

## Requirements

- **Node.js 20+**
- **Playwright** installed as a dev dependency (used to drive the live DOM)
- A **running instance** of your app (for verification)

## Configuration

The extension reads `selector-healer.config.{ts,js,cjs,mjs}` from your workspace root.

| Option | Default | Description |
|---|---|---|
| `testDir` | required | Directory containing your test files |
| `baseUrl` | required | URL of the running app |
| `testGlob` | `**/*.{spec,test}.{ts,tsx,js,jsx}` | Glob for test-file discovery |
| `framework` | auto-detected | `'playwright'` / `'cypress'` / `'webdriverio'` / `'testcafe'` |
| `browser` | `'chromium'` | `chromium` / `firefox` / `webkit` |
| `headless` | `true` | Run the browser headlessly |
| `timeout` | `30000` | Page-load timeout (ms) |
| `confidenceThreshold.autoApply` | `0.8` | Min confidence for "Apply All" / `--fix` |
| `confidenceThreshold.suggest` | `0.2` | Min confidence to show a suggestion |
| `globalSetup` | — | Pre-verification hook for auth/cookies |
| `pages` | — | Extra page states (with setup/login hooks) to visit |

## Extension settings

A couple of behaviours are configurable from VS Code **Settings** (search "Selector Healer"):

| Setting | Default | What it does |
|---|---|---|
| `selectorHealer.lint.enabled` | `true` | Show proactive fragility warnings for brittle locators (visible text, structural CSS, XPath) as you edit |
| `selectorHealer.watch.debounceMs` | `400` | Delay before Watch mode re-verifies a saved test file (reload to apply) |

New here? Open **Help → Get Started** and pick the **"Get Started with Selector Healer"** walkthrough for a guided Config → Capture → Verify → Heal.

## How it works

1. **Parse** — walks the AST of your test files and extracts every selector call (`getByTestId`, `getByRole`, `page.locator`, `cy.get`, …).
2. **Capture** — resolves each selector against the live DOM and stores a structural **fingerprint** (tag, attributes, text, parent chain, sibling index) in `.selector-healer/fingerprints.json`.
3. **Verify** — re-runs each selector against the current DOM; zero matches = broken, many = ambiguous.
4. **Heal** — scans the DOM for elements matching the stored fingerprint and scores them with a **10-rule weighted engine** (data-testid, id, role, tag, text, class overlap, aria, parent structure, sibling position, attribute coverage), returning up to three ranked, explainable suggestions.

No LLM, no cloud — the scoring is a deterministic, inspectable engine that runs entirely on your machine. **Local-first: no network calls beyond your own app, no telemetry.**

## License

MIT
