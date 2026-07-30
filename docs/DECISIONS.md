# Decisions Log

A dated log of non-obvious choices made while building Selector Healer. Every entry includes the choice, the reason, and (where relevant) the alternatives considered.

Format: append-only, newest at the bottom of each day's section. Never rewrite history — if a decision is reversed, add a new dated entry that supersedes the old one.

---

## 2026-05-22 — Initial scaffolding decisions

### Config loader: `cosmiconfig`
**Choice:** `cosmiconfig` with `@cosmiconfig/typescript-loader` to load `selector-healer.config.ts`.
**Why:** Mature, broad ecosystem precedent (Prettier, lint-staged, Storybook), first-class TS support, supports `.ts`/`.js`/`.mjs`/`package.json` lookups out of the box.
**Alternatives considered:** `c12` (newer, unjs-flavored, leaner; rejected only because cosmiconfig is more widely understood by contributors).

### AST code rewriter: `recast`
**Choice:** `recast` for the `--fix` codemod.
**Why:** Preserves original formatting and comments byte-for-byte in unmodified regions, which matters when editing humans' test files. Required by spec.
**Alternatives considered:** `jscodeshift` (would reformat untouched code), `magic-string` (string-level, not AST-aware).

### Error handling: `neverthrow`
**Choice:** `neverthrow`'s `Result<T, E>` for fallible operations crossing module boundaries in `core`.
**Why:** Spec mandates "errors are values" with no throwing across module boundaries.

### Color output: `picocolors`
**Choice:** `picocolors` for CLI colors.
**Why:** Zero deps, ~14× faster than chalk, used by Vite/Rollup/Vitest/Biome. We don't need chalk's template literal API.
**Alternatives considered:** `chalk` (heavier, richer API we don't use), `kleur` (similar to picocolors but slightly larger).

### Logger: `pino` + `pino-pretty` in dev
**Choice:** `pino` everywhere; `pino-pretty` only when `NODE_ENV !== 'production'` or `DEBUG=selector-healer*`.
**Why:** Required by spec. Structured JSON in CI, readable in dev.

### Sample-app static server
**Choice:** `examples/sample-playwright-project/` ships with a small Node `http`-module static file server (no dependencies). Spawned by Playwright config's `webServer`.
**Why:** Keeps the demo zero-cloud / zero-network so the README quickstart works on a plane. Demonstrates the tool end-to-end with no setup beyond `pnpm install`.
**Alternatives considered:** `serve` or `http-server` (extra dep, unnecessary), assume user provides URL (defeats the demo).

### Integration test fixture server
**Choice:** Tiny Node `http` server lives in `packages/core/test/fixtures/server.ts`. Used by verifier and healer integration tests to mutate a known DOM between capture and verify.
**Why:** Tests need a deterministic DOM under our control; spinning up the sample app would couple test packages.

### Package versions
**Choice:** All packages start at `0.0.1`. No publishing pipeline in Phase 1.

### `engines.node`
**Choice:** `"engines": { "node": ">=20.0.0" }` on every package.
**Why:** Spec requires 20.x LTS. Floor at 20 so 22.x dev machines (like the current one) work, and CI will run a matrix.
**Note:** Dev machine has Node 22.14.0.

### pnpm install path on Windows
**Choice:** Use `corepack pnpm <cmd>` for local dev when Node is installed in `C:\Program Files\nodejs` (the default Windows installer location). `corepack enable` fails there with `EPERM` because the shim install writes next to `node.exe`.
**Why:** `corepack pnpm` invokes the cached pnpm directly — no shim, no admin required. Same pnpm version (`packageManager` field is honored), just a different invocation.
**Workarounds for users who want bare `pnpm`:** run an elevated `corepack enable`, or `npm install -g pnpm` after setting `npm config set prefix` to a user-writable directory.
**CI:** unaffected — `pnpm/action-setup@v4` installs pnpm directly into the runner's PATH.

### Root script bodies prefixed with `corepack`
**Choice:** Root `package.json` scripts call `corepack pnpm -r run X` (not bare `pnpm -r run X`).
**Why:** When a script body spawns a subshell (which is how npm/pnpm execute scripts), the subshell uses the user's PATH — not pnpm's internal invocation. If pnpm isn't globally shimmed (the corepack-enable-fails case above), bare `pnpm` won't resolve in the subshell. `corepack pnpm` works whether or not the shim exists.
**Downside:** Cosmetic — root scripts are verbose. Worth it for portability across Windows + admin-restricted machines + CI alike.

### HTML report rendering
**Choice:** `report.html` is one self-contained file: inline CSS, inline JS, base64-embedded screenshots. Generated with tagged template literals — no templating library.
**Why:** Local-first means double-click-to-open and email-able. Templating engines add deps for marginal benefit at this scale.

## 2026-05-22 — Phase 2: Parser

### Glob library: `fast-glob`
**Choice:** `fast-glob` for directory scanning in `parseDirectory`.
**Why:** Mature, zero-config, typed. `glob` (npm) is also fine but heavier. `node:fs.glob` (experimental in 22.x) isn't stable enough for production across Node 20+22 matrix.
**Alternatives:** `glob@11` (larger API surface), `node:fs` recursive readdir + manual filtering (reinventing).

### `parseTestFile` return type: `Result<T, E>`
**Choice:** Returns `Result<SelectorUsage[], ParseError>` from `neverthrow`, not bare `SelectorUsage[]`.
**Why:** Spec mandates Result-wrapped returns for fallible operations in core. Reading a file and parsing an AST are both fallible. Spec signature shows `SelectorUsage[]`; using Result is a strengthening, not a weakening.

### `parseDirectory` partial-success model
**Choice:** `parseDirectory` returns `Result<{ selectors, errors }, ParseError>`. The outer Result is only `Err` if the glob itself fails; individual file parse failures are collected in `errors` alongside successful `selectors`.
**Why:** A directory scan that bails at the first bad file is unusable. Callers want as many selectors as possible even if some files have syntax errors.

### Context hint scoping: per function, not per test block
**Choice:** `contextHint` is scoped to the nearest enclosing ArrowFunction/FunctionExpression. A `page.goto()` in `beforeEach` does NOT carry into subsequent `test()` callbacks.
**Why:** Spec says "any `page.goto()` URL preceding this in the same test block." `beforeEach` is a different function scope. This keeps the implementation clean and matches the spec literally. The trade-off is that `beforeEach` gotos won't auto-associate — acceptable for MVP.

### @babel/traverse CJS/ESM interop
**Choice:** Runtime guard (`typeof _traverse === 'function' ? ... : .default`) plus a local ambient module declaration (`src/babel-traverse.d.ts`) that overrides `@types/babel__traverse`'s typing under NodeNext.
**Why:** @babel/traverse ships CJS; under NodeNext module resolution, TypeScript treats the default import as the module namespace (not callable), causing TS2349. The ambient `.d.ts` declares `export default traverse` with proper call signatures so TypeScript sees it as callable. The runtime guard handles the actual CJS/ESM shape difference across Node versions.
**Alternatives considered:** (a) `createRequire` to import CJS directly — works but breaks IDE navigation; (b) removing `@types/babel__traverse` entirely and writing full types — overkill; (c) `// @ts-expect-error` — masks real issues.

### Selector position: use argument location, not CallExpression
**Choice:** `SelectorUsage.line` and `column` are taken from the selector argument's AST location (`arg.loc`), not the surrounding `CallExpression.loc`.
**Why:** In a chained call like `page.locator('.form').locator('#submit')`, both CallExpression nodes start at the same position (`page`). Using the argument's location (where `.form` and `#submit` actually appear) gives correct source-order sorting and more useful diagnostic pointers.

### Diagnostic ID stability
**Choice:** `SelectorUsage.id = sha1(filePath + ':' + line + ':' + rawValue).slice(0, 12)`.
**Why:** Stable across runs as long as the selector stays at the same location. Including `rawValue` means moving a selector to a new line invalidates its fingerprint, which is the desired behavior (a relocated selector should be re-verified).

### License
**Choice:** MIT. Confirmed by user 2026-05-22.
**Why:** Standard permissive license for new open-source TS projects; minimal friction for contributors and downstream consumers.

### Repository field
**Choice:** Omitted from `package.json` until the user provides a URL. Not blocking.

### First-run `verify` behavior for uncaptured selectors
**Choice:** Return `status: 'skipped'` with a non-fatal log line: "run `selector-healer capture` to baseline N new selectors". Confirmed by user 2026-05-22.
**Why:** Adding a new selector should not fail CI just because it hasn't been baselined yet. The capture step is explicitly separate from verify in the spec.
**Edge case:** If `--fail-on-warning` is set, skipped-due-to-no-fingerprint will still NOT trigger a warning — it'll be info-level only. Genuine warnings (multiple-matches, partial broken) trigger `--fail-on-warning`.

## 2026-05-22 — Phase 3: Fingerprint + Verifier

### Playwright as optional peerDependency
**Choice:** `playwright` is a `peerDependency` with `optional: true` in core. Also a devDependency for tests.
**Why:** The parser module works without Playwright. Only capture and verify need it. Making it optional means consumers who only use the parser (e.g., a lint rule) don't need Playwright installed.

### Fingerprint store format: sorted JSON array
**Choice:** `fingerprints.json` stores a flat array of `DomFingerprint` objects, sorted by `selectorId`. Pretty-printed with 2-space indent.
**Why:** Sorted output produces stable diffs when committed to version control. Array format is simpler than keyed object for partial updates (merging is done in memory).

### DOM snapshot extraction runs in-page via `evaluate()`
**Choice:** The `parentChain`, `attributes`, `textContent`, and `siblingIndex` are all captured via a single Playwright `evaluate()` callback that runs inside the browser.
**Why:** Minimizes IPC round-trips. A single evaluate call captures all structural data atomically, ensuring consistency (no risk of DOM mutation between attribute reads).

### Fingerprint comparison: Jaccard threshold for classes
**Choice:** Classes are compared via Jaccard similarity with a 0.7 threshold (>70% overlap = match).
**Why:** CSS class names frequently change (utility classes, hashed module classes), but a significant overlap indicates structural similarity. A hard equality check would produce too many false-positive "broken" signals.

### Parent chain comparison: leaf-first alignment
**Choice:** Parent chains are compared from the leaf (innermost) ancestor upward, not root-first.
**Why:** The immediate parent structure matters most for element identity. If the page layout restructures (adds a wrapper div at the root), leaf-first comparison still detects the element's local context is preserved.

### Verifier treats "matched but changed" as `ok`
**Choice:** If a selector matches exactly one element on the live page, the verification status is `ok` regardless of whether the fingerprint comparison shows structural differences.
**Why:** The selector works — it found the element. Structural drift is informational for the healer, not a failure. A selector that still resolves is not "broken."

## 2026-05-22 — Phase 4: Healer

### Scoring rule weights: fixed table summing to 1.0
**Choice:** Seven scoring rules with fixed weights: data-testid (0.35), id (0.20), role (0.15), tag (0.10), text (0.10), parent structure (0.05), sibling position (0.05).
**Why:** Matches the spec's weight table exactly. data-testid and id are the strongest identity signals; structural attributes like parent chain and sibling index provide weak but useful disambiguation. Weights are normalized so the total confidence is a true [0, 1] score.

### Candidate scanning via Playwright locator API
**Choice:** `scanCandidates` uses `page.locator(selector)` + `.nth(i)` + `.evaluate((node) => ...)` instead of `page.evaluate(() => document.querySelectorAll(...))`.
**Why:** Running `document.querySelectorAll` inside `page.evaluate` requires DOM types (`Element`, `NodeListOf`, `HTMLElement`) which aren't available in a Node TypeScript compilation without the `dom` lib. The locator-based approach keeps all type-sensitive code in the browser context where Playwright infers the types.

### Custom `escapeCssId` instead of `CSS.escape`
**Choice:** A local `escapeCssId(id)` function replaces non-word/non-hyphen characters with backslash escapes.
**Why:** `CSS.escape()` is a browser API unavailable in Node. The function is only used for building CSS `#id` selectors from stored fingerprint data, which is already sanitized at capture time.

### Max 3 candidates, min 0.2 confidence
**Choice:** `healSelectors` returns at most 3 candidates per broken selector, filtered to confidence ≥ 0.2.
**Why:** Spec mandates "top three ranked by confidence." The 0.2 floor avoids returning noise — a 15% match on just tag name + sibling index isn't actionable.

### Replacement code generation priority
**Choice:** `buildReplacementCode` generates Playwright API calls in priority order: `getByTestId` > `getByRole(role, {name})` > `locator('#id')` > `getByText` > `locator('tag.class')` > `locator('tag')`.
**Why:** Follows Playwright's own recommended selector hierarchy. Test IDs are the most stable, roles are semantically meaningful, and bare tag selectors are the last resort.

### Deduplication key for candidates
**Choice:** Candidates are deduplicated by `${tagName}:${id}:${data-testid}:${text.slice(0,30)}`.
**Why:** The same element can match multiple selectors (e.g., by id and by role). The composite key catches duplicates while being fast to compute. The 30-char text prefix avoids key explosion for long text nodes.

## 2026-05-22 — Phase 5: CLI

### CLI framework: `commander`
**Choice:** `commander` for the `selector-healer` binary.
**Why:** The most widely used Node CLI framework, stable API, first-class TypeScript types, subcommand support. Lightweight enough that it doesn't inflate the dependency tree.
**Alternatives considered:** `yargs` (heavier, more opinionated), `citty` (unjs flavor, less mature for complex subcommands).

### Config loading: `cosmiconfig`
**Choice:** `cosmiconfig` searches for `selector-healer.config.{ts,js,mjs,cjs}`, `.selector-healerrc`, `.selector-healerrc.json`, and `package.json`.
**Why:** Decided in Phase 1. Users get flexible config placement without any custom code.

### AST rewrite via `recast` + `@babel/parser`
**Choice:** The `--fix` flag uses `recast` with `@babel/parser` to parse and reprint source, preserving formatting.
**Why:** Spec mandates "AST only" for source modification. recast preserves comments and whitespace in untouched regions, which is critical when rewriting test files that humans maintain.

### HTML report: self-contained single file
**Choice:** `report` command generates a single HTML file with inline CSS, no external assets.
**Why:** Decided in Phase 1. Double-click-to-open, works offline, can be emailed or committed.

### Exit codes: broken = 1, multi + --fail-on-warning = 1
**Choice:** `verify` exits 1 if any selector is broken. `--fail-on-warning` makes multiple-matches also exit 1.
**Why:** CI pipelines key off exit codes. Broken selectors are always failures. Ambiguous selectors are warnings by default — strict mode opts in via flag.

### No `console.log` in CLI — `process.stdout.write` + `picocolors`
**Choice:** CLI output uses `process.stdout.write` with `picocolors` for coloring. No `console.log`.
**Why:** `console.log` adds a newline and goes through internal Node buffering that can interfere with piped output. `process.stdout.write` gives us exact control. pino is used only in the core library; the CLI formats its own output.

## 2026-05-22 — Phase 6: VS Code Extension

### Extension uses ESM (NodeNext module system)
**Choice:** The extension tsconfig inherits `"module": "NodeNext"` from the base config, matching the core package.
**Why:** `@selector-healer/core` is an ESM package (`"type": "module"`). Using CommonJS for the extension would require dynamic import hacks or a bundler to load ESM deps. Since VS Code 1.93+ supports ESM extensions, using NodeNext is the cleanest path.

### Diagnostics: parse on save, verify on command
**Choice:** On file save/open, the extension parses the file for selectors and shows "no baseline" info diagnostics. Full Playwright-based verification only runs when the user triggers "Verify Now".
**Why:** Running Playwright on every save would be slow and disruptive. Parsing is fast (AST-only, no network). The full verify/heal flow is an explicit action the user controls.

### Code actions: QuickFix per broken selector
**Choice:** Each broken selector diagnostic offers one or more QuickFix code actions with the healer's ranked replacement suggestions. The highest-confidence suggestion is marked `isPreferred`.
**Why:** VS Code's QuickFix UI is the standard pattern for "here's what's wrong, here's how to fix it." Users can Ctrl+. on a squiggled selector and pick a fix. Preferred actions also work with `editor.codeActionsOnSave`.

### Status bar item: left-aligned, click to verify
**Choice:** A status bar item shows selector health (idle, running, results) and triggers verify on click.
**Why:** Gives constant visibility into selector health without requiring the user to open a panel. The click shortcut makes the verify command discoverable.

### Config loading: dynamic import of cosmiconfig
**Choice:** The extension loads cosmiconfig via dynamic `import('cosmiconfig')` in the config-loading function rather than a top-level import.
**Why:** Cosmiconfig is only needed when running verify/capture commands, not on every file parse. Lazy loading keeps activation fast.

## 2026-05-22 — Post-MVP: Chrome Extension (DevTools Panel)

### WebSocket library: `ws`
**Choice:** `ws` for the CLI `serve` command's WebSocket server.
**Why:** The de facto standard WebSocket library for Node.js. Zero native dependencies, production-proven (used by Socket.IO, webpack-dev-server, Vite). Node's built-in `WebSocket` (experimental in 21+) only provides a client, not a server — `ws` provides `WebSocketServer`. `@types/ws` ships peer types.
**Alternatives considered:** `µWebSockets.js` (faster, but native binary addon — violates local-first zero-native-dep preference), raw HTTP upgrade handling (reinventing a well-solved problem).

### Chrome extension architecture: Manifest V3 + DevTools panel
**Choice:** Manifest V3 with a DevTools panel (not popup or sidebar) that opens in Chrome DevTools.
**Why:** DevTools panel sits alongside Elements/Console — the natural home for a selector debugging tool. The panel communicates with a background service worker that maintains the WebSocket connection to the CLI server. Content scripts run in every frame to evaluate selectors against the live DOM.
**Alternatives considered:** Sidebar panel (less visible, requires manual open), popup (tiny, closes on click-away), standalone web page (disconnected from DevTools context).

### Content script selector evaluation: vanilla JS reimplementation
**Choice:** The content script reimplements Playwright's selector matching logic (getByRole, getByTestId, getByLabel, getByText, locator) in plain JavaScript with an implicit ARIA role map.
**Why:** Playwright's Node.js API cannot run inside a browser content script. The reimplementation covers the same selector types the parser extracts. The implicit ARIA role map (18 roles) mirrors the ARIA in HTML spec so `getByRole('button')` finds `<button>`, `<input type="submit">`, `<summary>`, and `[role="button"]`.
**Trade-off:** Not a perfect Playwright parity (no `:has-text()`, no chained locators, no iframe piercing). Sufficient for MVP-level selector health checking.

### Shadow DOM for highlight overlays
**Choice:** Element highlight overlays use a closed Shadow DOM host.
**Why:** Isolates overlay styles from the inspected page's CSS. Prevents the page's stylesheets from affecting the highlight appearance and vice versa. Closed mode prevents the page from accessing/modifying the overlays.

### WebSocket auto-reconnect with exponential backoff
**Choice:** The background service worker reconnects on WebSocket close with exponential backoff (1s base, 30s max).
**Why:** The CLI server may restart during development. Auto-reconnect with backoff avoids connection storms while ensuring the extension recovers quickly.

## 2026-05-22 — Post-MVP: CI/CD Integration

### `check` command: fast pre-commit gate without a browser
**Choice:** New `selector-healer check` command that compares parsed selectors against stored fingerprints. No Playwright, no browser — pure AST parsing + JSON comparison.
**Why:** Pre-commit hooks must be fast (<2s). Running Playwright in a pre-commit hook would add 10-30s per commit, which developers would bypass with `--no-verify`. The `check` command detects selector drift (new uncaptured, orphaned baselines) in milliseconds.
**Trade-off:** Cannot detect "selector exists but element changed" — that requires the full `verify` with a browser. The `check` gates commits; the full `verify` gates merges in CI.

### CI strategy: two-tier verification
**Choice:** CI runs `check` first (fast, no browser), then `verify` (full, with Playwright) as a separate job that depends on the first.
**Why:** `check` fails fast for obvious drift (new selectors without baselines). `verify` catches the harder cases (selector still parses but element moved/changed). Running both in sequence gives fast feedback + thorough coverage.

### Pre-commit hook: only runs on staged test files
**Choice:** The pre-commit script checks `git diff --cached --name-only` for `*.spec.*` and `*.test.*` files. Skips entirely if no test files are staged.
**Why:** Developers committing only non-test files (docs, configs) shouldn't wait for selector checks. The hook is zero-overhead for non-test commits.

### Reusable workflow template
**Choice:** A standalone `selector-verify.yml` workflow template alongside the project's own `ci.yml`.
**Why:** Users can copy the template into their own projects. It includes path filtering (only runs on test/selector changes), concurrency management, failure artifact upload, and the two-tier check+verify pattern.

### Multi-page auth support: `PageConfig` with setup hooks
**Choice:** Added `PageConfig` interface with `url`, `name`, and `setup?: (page: unknown) => Promise<void>` to `HealerConfig.pages`. Capture, verify, and heal all use a two-phase strategy: Phase 1 runs default URL grouping; Phase 2 retries uncaptured/broken/unhealed selectors on each configured page, running its `setup` hook first.
**Why:** Many real-world apps require authentication or multi-step interactions before selectors become visible (dashboard after login, error states after invalid submission). Without this, those selectors are permanently reported as broken/uncaptured. The setup hook pattern lets users express any page-state prerequisite as a Playwright script.
**Alternatives considered:** (1) Relying solely on `globalSetup` — insufficient because different pages may need different auth flows or form states. (2) Embedding login credentials in contextHints — mixes concerns and doesn't generalize to non-auth interactions. (3) Separate capture/verify commands per page — poor UX, user has to run multiple commands.

### Smarter confidence scoring: graduated multi-signal comparison
**Choice:** Rewrote the scoring engine from binary match/no-match rules to graduated scoring where each rule returns a quality value in `[0, 1]`. Added Levenshtein fuzzy text matching, Jaccard class overlap, deep parent chain comparison (up to 3 ancestors with proximity decay), sibling proximity (±1 = 50%), aria/accessibility attribute matching, and semantic attribute coverage. Rules that are "not applicable" (return -1) are excluded from the weight denominator to avoid false penalties.
**Why:** Binary rules produced crude 35%/55%/70% confidence plateaus with no middle ground. Real DOM mutations are often partial — a class changes, text gets slightly modified, an element shifts by one sibling. Graduated scoring differentiates "almost the same element" from "vaguely similar tag" much more reliably, reducing false positives in heal suggestions.
**Alternatives considered:** (1) ML-based scoring — overkill for the local-first constraint, adds model dependency. (2) TF-IDF on attribute values — too complex for element-level comparison. (3) Keep binary rules + more rules — plateau problem persists.

## 2026-05-25 — Framework Adapters (Cypress, WebdriverIO, TestCafe)

### Architecture: framework-specific extractors + shared verification engine
**Choice:** Each framework gets its own parser extractor (`extractCypressSelectors`, `extractWebdriverIOSelectors`, `extractTestCafeSelectors`) while fingerprinting, verification, and scoring remain Playwright-based and framework-agnostic.
**Why:** The parser needs framework-specific AST knowledge (different method names, chaining patterns, context-tracking calls). But DOM fingerprints are universal — an element's tag, attributes, text, and parent chain are the same regardless of which framework's test first selected it. Keeping verification in Playwright means one browser engine does all DOM work, avoiding the complexity of integrating three different browser automation libraries.
**Trade-off:** Users testing with Cypress/WDIO/TestCafe still need Playwright installed as a dev dependency for the healer to verify selectors. Acceptable because Selector Healer is a dev tool, not a runtime dependency.

### Framework detection: AST-based with path-based fallback
**Choice:** Auto-detect framework from `import`/`require` statements in the file's AST. Falls back to path conventions (`.cy.ts` → Cypress, `.wdio.ts` → WebdriverIO, `.testcafe.ts` → TestCafe). Explicit `framework` override in config takes highest priority.
**Why:** Import-based detection is the most reliable signal — if a file imports `@wdio/globals`, it's WebdriverIO regardless of its filename. Path-based fallback handles files where imports are ambient (Cypress's `cy` global doesn't require an import). Config override handles edge cases and mixed-framework monorepos.
**Alternatives considered:** (1) Only path-based — misses files with non-standard naming. (2) Only config-based — requires user to explicitly set framework, worse DX. (3) Content heuristics (look for `cy.`, `$()`, `Selector()` in source) — fragile, false positives from similarly-named functions.

### Heal output: framework-specific replacement code generator
**Choice:** `generateReplacementCode(fingerprint, framework)` produces idiomatic replacement code for each framework. Playwright: `page.getByTestId(...)`. Cypress: `cy.get('[data-testid="..."]')`. WebdriverIO: `$('[data-testid="..."]')`. TestCafe: `Selector('[data-testid="..."]')`.
**Why:** Heal suggestions must be directly pasteable into the user's test file. Outputting Playwright syntax into a Cypress file would be worse than unhelpful. Each framework has its own idioms for the same concepts (text matching, role queries, test-id attributes).
**Alternatives considered:** (1) Output only CSS selectors universally — loses framework-specific semantic APIs (Cypress `cy.contains`, WDIO `aria/`, TestCafe `.withText()`). (2) Let users convert manually — defeats the purpose of auto-healing.

### `SelectorUsage.framework` field: optional, backward-compatible
**Choice:** Added `framework?: Framework` to `SelectorUsage` (defaults to `'playwright'` when omitted). The `HealerConfig` also accepts an optional `framework` field.
**Why:** Backward-compatible with all existing tests and fingerprints. Existing Playwright-only workflows continue working unchanged. The framework field flows through to the healer so it knows which syntax to output.

## 2026-06-01 — Smart `init` (auto-detected config scaffolding)

### Shared detection engine in `core` (used by CLI `init` and VS Code "Create Config")
**Choice:** `detectProjectConfig(cwd)` and `renderConfigFile(detection)` live in `@selector-healer/core` (`src/init/`). Both the CLI's `init` command and the VS Code "Create Config" welcome action call them.
**Why:** Avoids duplicating detection logic across the CLI and the extension (the extension can't depend on the CLI; both already depend on core). One implementation, one set of tests, identical behavior everywhere.

### Detect from `package.json`, framework configs, and `.env` — never copy secrets
**Choice:** Framework is inferred from deps + the presence of a framework config file; `baseUrl` from the framework config (`baseURL`/`baseUrl`, parsed via Babel AST, including no-substitution template literals) then `.env*` URL-shaped keys; `testDir` from the config's `testDir`/`specPattern` (must exist on disk) then a scan of common directories. Every field carries a confidence flag. Only a URL-shaped `baseUrl` is ever read from `.env` — credentials are never copied; the generated auth example reads them from `process.env`.
**Why:** A ready-to-run config beats a blank skeleton, but guessing must be transparent (TODOs on low-confidence fields) and safe (no secrets leaking into a committed file). AST parsing (not regex) honors the repo's "no regex on source" rule and handles comments/formatting robustly.
**Alternatives considered:** (1) Evaluating/`require`-ing the user's config to read values — unsafe (side effects) and fails on `.ts` without a loader. (2) Regex extraction — brittle, picks up commented values. (3) Interactive prompts — adds a prompt dependency and breaks non-interactive/CI use.

### Generated config is `.cjs`
**Choice:** `init` always writes `selector-healer.config.cjs` (with a JSDoc `@type` for editor hints). On `--force`, any other-extension config is removed so the `.cjs` is the single source cosmiconfig loads.
**Why:** A `.ts` config silently fails to load in projects without a TypeScript loader (the exact trap a real user hit). `.cjs` loads everywhere — ESM or CJS projects, with or without a transpiler — making first-run reliable. Removing a stale `.ts` on `--force` avoids cosmiconfig preferring it over the freshly generated `.cjs`.

## 2026-06-01 — Proactive selector-quality lint

### Robustness rating + static fragility lint in `core`
**Choice:** A shared `core` module rates each selector's resilience (`robust`/`good`/`moderate`/`fragile`) and `lintSelectors` flags the fragile ones — visible text, structural CSS, XPath. CSS is value-aware: `[data-testid]`/id selectors are sturdy, class/structural ones are fragile. Surfaced via a CLI `lint` command and inline VS Code Information diagnostics.
**Why:** The healer was purely *reactive* (fix breaks after they happen). Most users will keep writing text/CSS locators, so the tool needs to flag fragility *proactively* — at authoring time, for everyone — without a one-off manual audit. A pure, DOM-free rating works instantly with no baseline.
**Alternatives considered:** (1) Only reactive healing — misses fragile locators until they break. (2) A separate linter tool — duplicates the parser/scoring already in core.

### DOM-backed upgrades reuse the heal engine; only suggested when genuinely sturdier
**Choice:** When a fingerprint exists, `lintSelectors` computes the element's best available anchor via `bestSelectorType` + `generateReplacementCode`, and attaches an `upgrade` **only if** its tier is strictly more robust than the current selector. The VS Code provider offers it as a quick-fix (reusing `findCallExpressionRange` + `stripLeadingReceiver`); the CLI prints it.
**Why:** A suggestion is only useful if it's actually better — suggesting `getByText`→`getByText` is noise. On third-party apps with no test-ids (e.g. OrangeHRM), the lint honestly flags fragility *without* inventing an upgrade that doesn't exist. Reusing the heal engine keeps one source of truth for replacement generation.

### Fragility diagnostics are Information severity, on the authoring path
**Choice:** Fragility diagnostics use `Information` severity and are emitted from the on-open/on-save parse path (not the verify path). They never gate CI by default (`lint --strict` opts in).
**Why:** Fragility is advice, not a failure — `Error`/`Warning` would cause noise and false CI breaks. Surfacing during authoring is where the nudge changes behavior; after a verify run, the broken/heal diagnostics take precedence.

## 2026-07-30 — Warm browser for watch mode

### Reuse one browser across watch re-verifies instead of relaunching
**Choice:** `verifySelectors`/`healSelectors` gained an optional pre-opened `context`; a new `openHealerBrowser(config, root)` returns a reusable context (browser launched + `globalSetup` applied once) plus a `close()`. The VS Code extension keeps one such session alive while watch mode is on and passes its context to every watch re-verify, so each save skips the cold Chromium launch. The session opens lazily on the first watch run and closes on watch-off, config-file save, or deactivate; on a run error it's discarded and reopened next time (crash recovery). The CLI and manual runs pass no context, so their behaviour is unchanged (launch + close per call).
**Why:** Each watch save was cold-launching Chromium for verify and again for heal (~1s each) — the dominant cost of the "why is this slow?" wait. A warm, reused context cuts that to zero after the first save. Verify and heal already close their pages, so a reused context doesn't leak.
**Trade-off:** a headless Chromium stays alive while watch is on (~150 MB), closed the moment watch turns off. Standard for watch tooling, and opt-in (watch is off by default).
**Alternatives considered:** (1) Share a browser only within a single run (verify + heal) — smaller win, no idle process, but still relaunches every save. (2) Skip heal in watch — drops instant suggestions. (3) Leave as-is — the slowness users reported.
