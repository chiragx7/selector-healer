# OrangeHRM live demo

Selector Healer pointed at the public **OrangeHRM demo** (`https://opensource-demo.orangehrmlive.com`, login `Admin` / `admin123`) - a real app with **no test-ids**, so it's an honest stress test of healing and the robustness gauge.

9 selectors across two authenticated pages (Dashboard, Admin › User Management). The config's `globalSetup` logs in once; the session then carries to every page the verifier visits.

## Prerequisites

- Playwright's Chromium (one-time): `npx playwright install chromium`
- Network access to the demo site.

## Run it in the VS Code extension

1. Launch the extension: open `packages/vscode-extension` in VS Code and press **F5** → an **Extension Development Host** window opens.
2. In that window: **File → Open Folder →** this `examples/orangehrm-demo` folder.
3. Open the **Selector Healer** view (activity-bar shield icon) or run **"Selector Healer: Open Full Dashboard"**.
4. Click **Verify Now**. A baseline is already captured, so the **Overview** populates with real data:
   - **Health** 100% (9/9) after a clean run.
   - **Robustness** leans *good / fragile* with **0 robust** - because OrangeHRM has no `data-testid`s. That's the real-world signal.
   - **Composition** shows the `getByRole` / `getByText` / `getByPlaceholder` mix; **per-page** shows Dashboard vs Admin.

   (Want to watch capture happen? Run **Capture Baseline** - it re-fingerprints live.)

## See a heal

You can't edit OrangeHRM's HTML, so break the *selector* instead:

1. Open `tests/admin.spec.ts`, change `{ name: 'Add' }` to `{ name: 'New' }`, and save.
2. **Verify Now** → the dashboard flags it **broken**.
3. Expand it - the top suggestion is `page.getByRole('button', { name: 'Add' })` at **~90%** (the healer re-found the button on the live DOM via the stored fingerprint). Click **Apply** to heal it, then **Undo** from Heal History if you like.

## Run it from the CLI (optional)

```bash
cd examples/orangehrm-demo
node ../../packages/cli/dist/index.js capture   # fingerprint against the live DOM
node ../../packages/cli/dist/index.js verify    # 9 ok, 0 broken
```

## Notes

- Uses the monorepo's `@selector-healer/*` packages directly - no separate install.
- `.selector-healer/fingerprints.json` is the captured baseline (committed-with-code in a real project).
- Add more pages by dropping another `tests/*.spec.ts` (with a `page.goto('/web/index.php/...')`) and a matching entry in the config's `pages`.
