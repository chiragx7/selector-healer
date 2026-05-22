# Selector Healer — Project Context

This file is loaded into every Claude Code session in this repo. Keep it concise and current.

## What this is

A local-first developer tool that statically scans Playwright test files, verifies each selector against a live DOM, and suggests AST-based replacements when selectors have broken. The goal is to catch broken selectors before CI does — at commit time, not 09:00 the next morning.

## Three deliverables

- **`@selector-healer/core`** — framework-agnostic library: parser → fingerprint → verifier → healer.
- **`@selector-healer/cli`** — `selector-healer` binary wrapping core. Used in CI, pre-commit, or by hand.
- **VS Code extension** — workspace-depends on core; diagnostics, code actions, status bar.

Chrome extension is explicitly out of scope for the MVP.

## Repository layout

```
packages/
  core/                @selector-healer/core
    src/
      parser/          AST extraction of selector usages
      fingerprint/     DOM snapshot capture + JSON storage
      verifier/        Playwright-driven live-DOM matching
      healer/          Candidate scoring + ranked suggestions
      types.ts
  cli/                 @selector-healer/cli (commander)
  vscode-extension/    VS Code extension (workspace dep on core)
examples/
  sample-playwright-project/   Demo fixture with bundled static server
.selector-healer/              Runtime artifacts per project (fingerprints.json, report.html)
```

## Commands

```bash
pnpm install                          # install all workspaces
pnpm build                            # build every package
pnpm test                             # run every vitest suite
pnpm lint                             # biome check (lint + format)
pnpm -F @selector-healer/core test    # run a single package
pnpm -F @selector-healer/cli dev      # CLI in watch mode
```

Setup tip: `corepack enable && corepack prepare pnpm@latest --activate` is sufficient on a fresh machine. On Windows where Node is installed under `C:\Program Files\nodejs` (default installer location), `corepack enable` fails with `EPERM` — use `corepack pnpm <cmd>` directly instead. The root `package.json` scripts are written as `corepack pnpm -r run X` so the recursion works either way. See `DECISIONS.md` for the full rationale.

## Non-negotiable rules

- **Local-first.** No network calls except Playwright hitting the user's configured URL. No telemetry, no analytics.
- **AST only.** Source-code modification uses `recast` + `@babel/traverse`. Regex on source code is forbidden.
- **No `any`** without an inline comment explaining the reason.
- **No `console.log`** in `src/` — `pino` only. (Test files may use `console.*`.)
- **No throwing across module boundaries** in `core` — return `Result<T, E>` from `neverthrow`.
- **No new dependencies** without a `DECISIONS.md` entry justifying the choice.
- **Strict TypeScript** everywhere. Public functions in `core` carry JSDoc with `@param`, `@returns`, and one usage example.

## Architecture in one paragraph

The **parser** walks Babel ASTs of Playwright test files and extracts every `page.locator()`, `getByTestId()`, etc., into `SelectorUsage[]`. The **fingerprint** module uses Playwright to snapshot each matched element's structural identity (tag, attrs, text, parent chain, sibling index, bbox, URL) into `.selector-healer/fingerprints.json` — committed to git so the baseline travels with the code. The **verifier** re-runs each selector against the live DOM and returns `VerificationResult[]` (`ok` / `broken` / `multiple-matches` / `page-load-failed` / `skipped`). For broken selectors, the **healer** scans the current DOM for candidates that match the stored fingerprint by attribute/text/role/structure overlap, scores them per a fixed rule table, and returns the top three ranked by confidence. The CLI's `--fix` flag applies suggestions above the auto-apply threshold via `recast`, preserving formatting and comments.

## Where to look first

| Task | Path |
|---|---|
| Add a new selector kind | `packages/core/src/parser/extractors/` |
| Tune suggestion confidence | `packages/core/src/healer/scoring.ts` |
| New CLI flag | `packages/cli/src/commands/` |
| VS Code feature | `packages/vscode-extension/src/extension.ts` |
| Rationale for a past choice | `DECISIONS.md` |

## Build phases (sequential — no skipping)

1. Scaffolding (monorepo, CI, Biome, Vitest, empty packages)
2. Parser
3. Fingerprint + Verifier (with fixture server)
4. Healer
5. CLI (`init`, `capture`, `verify`, `report`, `--fix`)
6. VS Code extension
7. Documentation pass

Commit after each phase with a clear message. Do not start phase N+1 before N is committed and green.

## Definition of done

The user can clone, install, init, capture against the sample app, manually break the HTML, and watch `verify` and `verify --fix` correctly identify and patch the regressions — all offline, with the VS Code extension lighting up broken selectors live.
