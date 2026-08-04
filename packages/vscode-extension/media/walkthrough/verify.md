# 3 · Verify your selectors

**Verify Now** re-runs every selector against the current DOM and compares it to the baseline:

- **✓ Healthy** — resolves to exactly one element
- **✗ Broken** — matches nothing (the UI changed)
- **Ambiguous** — matches several elements

Results show up in the **dashboard**, the **status bar**, the **Problems panel**, and inline on each selector.

**Tip:** turn on **Watch mode** to re-verify a test file automatically the moment you save it — so breakage surfaces as you type, not the next morning in CI.
