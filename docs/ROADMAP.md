# Selector Healer — Roadmap

Where the extension (and the tool as a whole) is headed. Ordered by leverage:
ship first, then make heals *trustworthy*, then *smart*, then *broad*.

**Legend** — Size: `S` ≈ hours · `M` ≈ a day or two · `L` ≈ multi-day.
Priority: `P0` do now · `P1` next · `P2` later.

## Guiding principles (don't break these)

- **Local-first** — no network except the user's own app; **no telemetry, ever**.
- **AST-only** source edits (recast + Babel) — never regex on source.
- **Shift-left** — catch breakage at edit/commit time, not the next morning in CI.
- **Trust before magic** — every automated change is *explainable* and *reversible*.

---

## Phase 0 — Ship it · `P0` → `v0.2.0` "Launch"

Nobody can install it yet (placeholder publisher IDs). This phase is the real gate.

- [ ] Create a **VS Code Marketplace** publisher; `vsce package` → `vsce publish` — `S`
- [ ] Publish to **Open VSX** (Cursor / VSCodium / Windsurf) — `S`
- [ ] Replace `YOUR_PUBLISHER_ID` / `YOUR_USERNAME` placeholders — `S`
- [ ] Marketplace listing: icon, **demo GIF**, categories, keywords, `CHANGELOG.md` — `S`
- [ ] Release CI: on git tag, build + test + attach the `.vsix` — `M`

## Phase 1 — Trust the loop · `P0`/`P1` → `v0.3.0` "Trustworthy heals"

Make every suggested fix explainable, previewable, and undoable.

- [ ] **Explain *why* a selector broke** — diff the stored fingerprint against the live
      DOM to produce a human reason ("`Save changes` renamed to `Update Profile`",
      "`data-testid` removed; matched by role", "moved under `.toolbar`"). *The
      differentiator.* — `L`
- [ ] **Diff preview before Apply** — peek/diff the before→after so devs trust it — `M`
- [ ] **Heal history + one-click undo** — a timeline of applied fixes with revert — `M`
- [ ] **Live verify (watch mode)** — re-verify on test-file save and (opt-in) on
      dev-server reload, so breakage surfaces instantly — `L`

## Phase 2 — Deepen intelligence · `P1` (still local-first) → `v0.4.0`

- [ ] **Learn from accept/reject** — nudge scoring weights *per project* from which
      suggestion the dev picks or dismisses (a local model file, no network) — `L`
- [ ] **Confidence, explained** — show the rule-by-rule breakdown inline, not just a
      number — `S`
- [ ] **Preview all 3 candidates** side by side before choosing — `S`

## Phase 3 — Breadth · `P2` → `v0.5.0`

- [ ] **Light up Cypress / WebdriverIO / TestCafe** in the extension UI (core already
      has the adapters; the UI is Playwright-only today) — `M`
- [ ] **Monorepo / multi-config** — multiple `selector-healer.config.*` across
      workspace folders — `M`
- [ ] **Diff-aware verify** — only check selectors in files changed vs `main`
      (fast, PR-friendly) — `M`
- [ ] **Playwright Test Explorer integration** — surface heals where devs already
      live — `L`

## Phase 4 — Polish & trust · `P2` (ongoing)

- [ ] Swap custom onboarding for VS Code's native **Walkthrough** API — `S`
- [ ] **Hover cards** on selectors — fingerprint, last-verified, page, confidence — `M`
- [ ] **Per-selector CodeLens** — `✓ ok · Verify · Heal` inline — `M`
- [ ] Settings UI + docs — `S`
- [ ] Lean into **local-first / no-telemetry** as a marketed feature (enterprise QA
      cares about privacy + offline) — `S`

---

## Non-goals (for now)

- **Cloud AI / LLM heal** — breaks local-first. If ever added, it must be *explicit
  opt-in* with a clear network warning, never a default.
- **Telemetry / analytics** of any kind.
- **Regex-on-source** edits — AST only.

## Suggested first three moves

1. **Phase 0** — publish to Marketplace + Open VSX. Get it in front of people.
2. **"Explain why it broke" + diff preview** — the trust multiplier.
3. **Live verify** — the shift-left magic.
