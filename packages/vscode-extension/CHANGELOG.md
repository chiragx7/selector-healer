# Changelog

## 0.1.0 — 2026-05-25

### Added

- **Inline diagnostics** — Broken Playwright selectors highlighted in the editor (Problems panel)
- **Quick Fix code actions** — Ctrl+. on any broken selector to get ranked replacement suggestions
- **Verify command** — Run full live-DOM verification from VS Code
- **Capture command** — Baseline fingerprints without leaving the editor
- **Status bar** — Shows selector health at a glance; click to verify
- **Tree view** — Sidebar panel showing all selectors grouped by status
- **Multi-framework support** — Parses Playwright, Cypress, WebdriverIO, and TestCafe test files
- **Multi-page auth** — Supports authenticated page states via config setup hooks
- **Graduated scoring** — Intelligent confidence scoring with fuzzy text, class overlap, and parent chain analysis
