# Selector Healer for VS Code

**Self-healing test selectors** — detects broken CSS/XPath/role selectors in your test files, scores candidates from the live DOM, and offers one-click AST-based fixes.

Supports **Playwright**, **Cypress**, **WebdriverIO**, and **TestCafe**.

## Features

### Inline Diagnostics
Broken selectors appear as errors in the Problems panel the moment you save a test file. Selectors without a baseline fingerprint show as info hints.

### Quick Fix Code Actions
Press `Ctrl+.` (or `Cmd+.`) on any broken selector to see ranked replacement suggestions. The highest-confidence fix is marked as preferred — accept it with one keystroke.

### Live Verification
Run `Selector Healer: Verify Now` from the command palette to check all selectors against the running application. Results update the Problems panel, status bar, and sidebar tree in real time.

### Sidebar Tree View
The activity bar panel groups selectors by status (OK / Broken / Skipped) with confidence scores and suggested replacements for each broken selector.

### Status Bar
A persistent status bar item shows selector health at a glance. Click to trigger verification.

## Supported Frameworks

| Framework | Selector Patterns |
|-----------|-------------------|
| Playwright | `page.locator()`, `getByTestId()`, `getByRole()`, `getByText()`, `getByLabel()` |
| Cypress | `cy.get()`, `cy.find()`, `cy.contains()` |
| WebdriverIO | `$()`, `$$()`, `browser.$()`, `aria/` selectors |
| TestCafe | `Selector()`, `.withText()`, `.withAttribute()` |

## Commands

| Command | Description |
|---------|-------------|
| `Selector Healer: Verify Now` | Run full verification against the live DOM |
| `Selector Healer: Capture Baseline` | Capture fingerprints for all selectors |
| `Selector Healer: Apply All High-Confidence Fixes` | Apply fixes above the auto-apply threshold |

## Getting Started

1. Install this extension
2. Create a `selector-healer.config.ts` in your project root:

```typescript
import type { HealerConfig } from '@selector-healer/core';

export default {
  testDir: './tests',
  baseUrl: 'http://localhost:3000',
  headless: true,
} satisfies HealerConfig;
```

3. Install the CLI: `npm install -D @selector-healer/core`
4. Run **Capture Baseline** to snapshot your selectors
5. When selectors break, the extension highlights them and suggests fixes

## Requirements

- Node.js 20+
- Playwright installed as a dev dependency
- A running instance of your application (for verification)

## Configuration

The extension reads `selector-healer.config.ts` from your workspace root. Key options:

| Option | Description |
|--------|-------------|
| `testDir` | Directory containing test files |
| `testGlob` | Glob pattern for test files |
| `baseUrl` | URL of the running application |
| `framework` | Force a specific framework (`'playwright'` / `'cypress'` / `'webdriverio'` / `'testcafe'`) |
| `pages` | Multi-page configurations with auth/setup hooks |
| `confidenceThreshold.autoApply` | Auto-apply fixes above this confidence (default: 0.9) |
| `confidenceThreshold.suggest` | Show suggestions above this confidence (default: 0.2) |

## How It Works

1. **Parse** — Walks ASTs of your test files to extract every selector call
2. **Fingerprint** — Snapshots each element's structural identity (tag, attributes, text, parent chain)
3. **Verify** — Re-runs selectors against the live DOM to detect breakage
4. **Heal** — Scans the DOM for candidates matching the stored fingerprint, scores them, and suggests replacements

All processing is **local-first** — no network calls, no telemetry, no cloud dependencies.

## License

MIT
