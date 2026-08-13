# Changelog

## Unreleased

### Added

- **Analytics Overview dashboard** - selector health, a robustness gauge, health-over-time, composition, and per-page breakdowns
- **Learn from accept/reject** - adaptive suggestion ranking that nudges toward the fix kinds you take, with a "✨ you usually accept X fixes" note (bounded, local, and never enough to change an auto-apply)
- **Heal History + one-click Undo** - every applied fix is reversible
- **Diff preview before Apply** - peek the before → after change first
- **"Why NN%?" breakdown** - the per-rule confidence, not just a number
- **Hover cards** - fingerprint, last-verified, page, and confidence on any selector
- **Per-selector CodeLens** - inline `ok · Verify · Heal`
- **Watch mode** - auto re-verify a test file the moment you save it
- **Skip / restore** - silence a broken selector everywhere (list, health, editor squiggles), restored when you edit it
- **Prune stale baseline** - drop fingerprints for selectors that no longer exist (`--dry-run` to preview)
- **Fragility lint** - proactive warnings for brittle locators
- **Onboarding** - a Get Started walkthrough and a Settings UI

### Fixed

- Heal suggestions no longer offer unrelated sibling elements as alternatives (the list is now confidence-relative)
- When a page can't be reached (login/navigation failure), the healer reports "couldn't reach the page - try again" instead of a false "element removed"
- Auto-apply always selects the best structural match - a learned preference can never tip an unattended fix

## 0.1.0 - 2026-05-25

### Added

- **Inline diagnostics** - Broken Playwright selectors highlighted in the editor (Problems panel)
- **Quick Fix code actions** - Ctrl+. on any broken selector to get ranked replacement suggestions
- **Verify command** - Run full live-DOM verification from VS Code
- **Capture command** - Baseline fingerprints without leaving the editor
- **Status bar** - Shows selector health at a glance; click to verify
- **Tree view** - Sidebar panel showing all selectors grouped by status
- **Multi-framework support** - Parses Playwright, Cypress, WebdriverIO, and TestCafe test files
- **Multi-page auth** - Supports authenticated page states via config setup hooks
- **Graduated scoring** - Intelligent confidence scoring with fuzzy text, class overlap, and parent chain analysis
