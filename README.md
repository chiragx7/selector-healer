# Selector Healer

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node ≥20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

**Catch broken Playwright selectors before CI does.** Selector Healer statically scans your test files, verifies each selector against the live DOM, and — when a UI change breaks a selector — suggests (or auto-applies) an AST-based fix. Everything runs on your machine: no network calls beyond your own app, no telemetry.

- 🩹 **Heals broken selectors** — scores live DOM candidates against a stored fingerprint and proposes ranked replacements.
- ⚡ **Shift-left** — catches breakage at commit time (pre-commit or in your editor), not at 09:00 the next morning in CI.
- 🧭 **Near-zero config** — `init` auto-detects your framework, base URL, test directory, and even the login flow and pages.
- 🖥️ **Three surfaces** — a core library, the `selector-healer` CLI (CI / pre-commit), and a VS Code extension.
- 🔒 **Local-first** — AST-only edits via recast + Babel (never regex on your source); nothing leaves your machine.

## Quick Start

```bash
# Install
corepack pnpm install

# Initialize in your project
npx selector-healer init

# Edit selector-healer.config.ts with your testDir and baseUrl, then:
npx selector-healer capture    # Baseline fingerprints
npx selector-healer verify     # Check for broken selectors
npx selector-healer verify --fix  # Auto-apply high-confidence fixes
npx selector-healer report     # Generate HTML report
```

## How It Works

1. **Parse** — The parser walks Babel ASTs of your Playwright test files and extracts every `page.locator()`, `getByTestId()`, `getByRole()`, etc.

2. **Capture** — Each selector is resolved against the live DOM using Playwright. A structural fingerprint (tag, attributes, text, parent chain, sibling index) is stored in `.selector-healer/fingerprints.json`.

3. **Verify** — Re-runs each selector against the current DOM. If a selector no longer matches, it's flagged as broken.

4. **Heal** — For broken selectors, the healer scans the DOM for candidates matching the stored fingerprint using a 7-rule weighted scoring engine (data-testid, id, role, tag, text, parent structure, sibling position). Returns up to 3 ranked replacement suggestions.

## Packages

| Package | Description |
|---|---|
| [`@selector-healer/core`](packages/core) | Framework-agnostic library: parser, fingerprint, verifier, healer. |
| [`@selector-healer/cli`](packages/cli) | `selector-healer` CLI binary for terminal and CI. |
| [`vscode-extension`](packages/vscode-extension) | VS Code extension with diagnostics, code actions, and status bar. |

## CLI Commands

| Command | Description |
|---|---|
| `selector-healer init` | Detect framework, base URL, test dir, login + pages; write a ready-to-use config |
| `selector-healer capture` | Parse test files and capture DOM fingerprints |
| `selector-healer verify` | Verify selectors against live DOM, show healing suggestions |
| `selector-healer verify --fix` | Auto-apply suggestions above the auto-apply threshold |
| `selector-healer report` | Generate a self-contained HTML report |

### Options

- `-v, --verbose` — Show detailed output including per-selector errors
- `--fail-on-warning` — Exit 1 on ambiguous (multiple-match) selectors
- `-o, --output <path>` — Report output path (default: `.selector-healer/report.html`)

## Configuration

Run `selector-healer init` to generate a config automatically — it detects your framework, base URL, test directory, and login flow. Or write `selector-healer.config.ts` by hand:

```typescript
import type { HealerConfig } from '@selector-healer/core';

export default {
  testDir: './tests',
  baseUrl: 'http://localhost:3000',
  headless: true,
  timeout: 30_000,
} satisfies HealerConfig;
```

### Config Options

| Option | Type | Default | Description |
|---|---|---|---|
| `testDir` | `string` | required | Directory containing Playwright test files |
| `baseUrl` | `string` | required | Base URL of the app under test |
| `testGlob` | `string` | `**/*.{spec,test}.{ts,tsx,js,jsx}` | Glob for test file discovery |
| `browser` | `'chromium' \| 'firefox' \| 'webkit'` | `'chromium'` | Browser to use |
| `headless` | `boolean` | `true` | Run browser headlessly |
| `timeout` | `number` | `30000` | Page load timeout in ms |
| `confidenceThreshold.autoApply` | `number` | `0.8` | Min confidence for `--fix` auto-apply |
| `confidenceThreshold.suggest` | `number` | `0.2` | Min confidence to show a suggestion |
| `globalSetup` | `(context) => Promise<void>` | — | Pre-verification hook for auth/cookies |

## VS Code Extension

The extension activates in workspaces containing `selector-healer.config.ts`.

**Features:**
- Parses test files on save/open and shows info diagnostics for uncaptured selectors
- "Verify Now" command runs full Playwright-based verification
- Broken selectors appear as errors in the Problems panel
- Quick Fix (Ctrl+.) on broken selectors offers ranked replacement suggestions
- Status bar shows selector health at a glance

**Commands (Ctrl+Shift+P):**
- `Selector Healer: Verify Now` — Run full verification
- `Selector Healer: Capture Baseline` — Capture fingerprints
- `Selector Healer: Apply All High-Confidence Fixes` — Batch apply fixes

## CI Integration

Add to your CI pipeline:

```yaml
- name: Verify selectors
  run: npx selector-healer verify --fail-on-warning
```

Or as a pre-commit hook:

```bash
npx selector-healer verify
```

## Local Development

Requires **Node 20+**. pnpm comes via Corepack.

```bash
corepack pnpm install     # Install all workspaces
corepack pnpm build       # Build every package
corepack pnpm test        # Run all test suites
corepack pnpm lint        # Biome check (lint + format)
```

Run a single package:

```bash
corepack pnpm -F @selector-healer/core test
corepack pnpm -F @selector-healer/cli dev
```

## Architecture

See [`DECISIONS.md`](docs/DECISIONS.md) for the rationale behind non-obvious design choices.

## License

[MIT](LICENSE)
