# Selector Healer for VS Code

Highlights broken Playwright selectors inline and offers AST-based quick fixes powered by `@selector-healer/core`.

## Features

- **Diagnostics on save** -- Parses test files on open/save and shows info-level hints for selectors without a baseline fingerprint
- **Verify command** -- Runs full Playwright-based verification and shows broken selectors as errors in the Problems panel
- **Quick Fix** -- Ctrl+. on a broken selector offers ranked replacement suggestions from the healer scoring engine
- **Status bar** -- Shows selector health at a glance; click to run verification
- **Capture command** -- Baseline fingerprints without leaving the editor

## Commands

Open the command palette (Ctrl+Shift+P) and type "Selector Healer":

| Command | Description |
|---|---|
| Selector Healer: Verify Now | Run full verification against live DOM |
| Selector Healer: Capture Baseline | Capture fingerprints for all selectors |
| Selector Healer: Apply All High-Confidence Fixes | Apply fixes above threshold |

## Requirements

- A `selector-healer.config.ts` in the workspace root
- Playwright installed as a dev dependency in the project
- Node 20+

## Local Development

```bash
corepack pnpm install
corepack pnpm -F selector-healer-vscode build
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.
