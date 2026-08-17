# Decisions Log

A dated log of non-obvious choices made while building Selector Healer. Every entry includes the choice, the reason, and (where relevant) the alternatives considered.

Format: append-only, newest at the bottom of each day's section. Never rewrite history - if a decision is reversed, add a new dated entry that supersedes the old one.

---

## 2026-05-22 - Initial scaffolding decisions

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
**Why:** `corepack pnpm` invokes the cached pnpm directly - no shim, no admin required. Same pnpm version (`packageManager` field is honored), just a different invocation.
**Workarounds for users who want bare `pnpm`:** run an elevated `corepack enable`, or `npm install -g pnpm` after setting `npm config set prefix` to a user-writable directory.
**CI:** unaffected - `pnpm/action-setup@v4` installs pnpm directly into the runner's PATH.

### Root script bodies prefixed with `corepack`
**Choice:** Root `package.json` scripts call `corepack pnpm -r run X` (not bare `pnpm -r run X`).
**Why:** When a script body spawns a subshell (which is how npm/pnpm execute scripts), the subshell uses the user's PATH - not pnpm's internal invocation. If pnpm isn't globally shimmed (the corepack-enable-fails case above), bare `pnpm` won't resolve in the subshell. `corepack pnpm` works whether or not the shim exists.
**Downside:** Cosmetic - root scripts are verbose. Worth it for portability across Windows + admin-restricted machines + CI alike.

### HTML report rendering
**Choice:** `report.html` is one self-contained file: inline CSS, inline JS, base64-embedded screenshots. Generated with tagged template literals - no templating library.
**Why:** Local-first means double-click-to-open and email-able. Templating engines add deps for marginal benefit at this scale.

## 2026-05-22 - Phase 2: Parser

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
**Why:** Spec says "any `page.goto()` URL preceding this in the same test block." `beforeEach` is a different function scope. This keeps the implementation clean and matches the spec literally. The trade-off is that `beforeEach` gotos won't auto-associate - acceptable for MVP.

### @babel/traverse CJS/ESM interop
**Choice:** Runtime guard (`typeof _traverse === 'function' ? ... : .default`) plus a local ambient module declaration (`src/babel-traverse.d.ts`) that overrides `@types/babel__traverse`'s typing under NodeNext.
**Why:** @babel/traverse ships CJS; under NodeNext module resolution, TypeScript treats the default import as the module namespace (not callable), causing TS2349. The ambient `.d.ts` declares `export default traverse` with proper call signatures so TypeScript sees it as callable. The runtime guard handles the actual CJS/ESM shape difference across Node versions.
**Alternatives considered:** (a) `createRequire` to import CJS directly - works but breaks IDE navigation; (b) removing `@types/babel__traverse` entirely and writing full types - overkill; (c) `// @ts-expect-error` - masks real issues.

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
**Edge case:** If `--fail-on-warning` is set, skipped-due-to-no-fingerprint will still NOT trigger a warning - it'll be info-level only. Genuine warnings (multiple-matches, partial broken) trigger `--fail-on-warning`.

## 2026-05-22 - Phase 3: Fingerprint + Verifier

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
**Why:** The selector works - it found the element. Structural drift is informational for the healer, not a failure. A selector that still resolves is not "broken."

## 2026-05-22 - Phase 4: Healer

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
**Why:** Spec mandates "top three ranked by confidence." The 0.2 floor avoids returning noise - a 15% match on just tag name + sibling index isn't actionable.

### Replacement code generation priority
**Choice:** `buildReplacementCode` generates Playwright API calls in priority order: `getByTestId` > `getByRole(role, {name})` > `locator('#id')` > `getByText` > `locator('tag.class')` > `locator('tag')`.
**Why:** Follows Playwright's own recommended selector hierarchy. Test IDs are the most stable, roles are semantically meaningful, and bare tag selectors are the last resort.

### Deduplication key for candidates
**Choice:** Candidates are deduplicated by `${tagName}:${id}:${data-testid}:${text.slice(0,30)}`.
**Why:** The same element can match multiple selectors (e.g., by id and by role). The composite key catches duplicates while being fast to compute. The 30-char text prefix avoids key explosion for long text nodes.

## 2026-05-22 - Phase 5: CLI

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
**Why:** CI pipelines key off exit codes. Broken selectors are always failures. Ambiguous selectors are warnings by default - strict mode opts in via flag.

### No `console.log` in CLI - `process.stdout.write` + `picocolors`
**Choice:** CLI output uses `process.stdout.write` with `picocolors` for coloring. No `console.log`.
**Why:** `console.log` adds a newline and goes through internal Node buffering that can interfere with piped output. `process.stdout.write` gives us exact control. pino is used only in the core library; the CLI formats its own output.

## 2026-05-22 - Phase 6: VS Code Extension

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

## 2026-05-22 - Post-MVP: Chrome Extension (DevTools Panel)

### WebSocket library: `ws`
**Choice:** `ws` for the CLI `serve` command's WebSocket server.
**Why:** The de facto standard WebSocket library for Node.js. Zero native dependencies, production-proven (used by Socket.IO, webpack-dev-server, Vite). Node's built-in `WebSocket` (experimental in 21+) only provides a client, not a server - `ws` provides `WebSocketServer`. `@types/ws` ships peer types.
**Alternatives considered:** `µWebSockets.js` (faster, but native binary addon - violates local-first zero-native-dep preference), raw HTTP upgrade handling (reinventing a well-solved problem).

### Chrome extension architecture: Manifest V3 + DevTools panel
**Choice:** Manifest V3 with a DevTools panel (not popup or sidebar) that opens in Chrome DevTools.
**Why:** DevTools panel sits alongside Elements/Console - the natural home for a selector debugging tool. The panel communicates with a background service worker that maintains the WebSocket connection to the CLI server. Content scripts run in every frame to evaluate selectors against the live DOM.
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

## 2026-05-22 - Post-MVP: CI/CD Integration

### `check` command: fast pre-commit gate without a browser
**Choice:** New `selector-healer check` command that compares parsed selectors against stored fingerprints. No Playwright, no browser - pure AST parsing + JSON comparison.
**Why:** Pre-commit hooks must be fast (<2s). Running Playwright in a pre-commit hook would add 10-30s per commit, which developers would bypass with `--no-verify`. The `check` command detects selector drift (new uncaptured, orphaned baselines) in milliseconds.
**Trade-off:** Cannot detect "selector exists but element changed" - that requires the full `verify` with a browser. The `check` gates commits; the full `verify` gates merges in CI.

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
**Alternatives considered:** (1) Relying solely on `globalSetup` - insufficient because different pages may need different auth flows or form states. (2) Embedding login credentials in contextHints - mixes concerns and doesn't generalize to non-auth interactions. (3) Separate capture/verify commands per page - poor UX, user has to run multiple commands.

### Smarter confidence scoring: graduated multi-signal comparison
**Choice:** Rewrote the scoring engine from binary match/no-match rules to graduated scoring where each rule returns a quality value in `[0, 1]`. Added Levenshtein fuzzy text matching, Jaccard class overlap, deep parent chain comparison (up to 3 ancestors with proximity decay), sibling proximity (±1 = 50%), aria/accessibility attribute matching, and semantic attribute coverage. Rules that are "not applicable" (return -1) are excluded from the weight denominator to avoid false penalties.
**Why:** Binary rules produced crude 35%/55%/70% confidence plateaus with no middle ground. Real DOM mutations are often partial - a class changes, text gets slightly modified, an element shifts by one sibling. Graduated scoring differentiates "almost the same element" from "vaguely similar tag" much more reliably, reducing false positives in heal suggestions.
**Alternatives considered:** (1) ML-based scoring - overkill for the local-first constraint, adds model dependency. (2) TF-IDF on attribute values - too complex for element-level comparison. (3) Keep binary rules + more rules - plateau problem persists.

## 2026-05-25 - Framework Adapters (Cypress, WebdriverIO, TestCafe)

### Architecture: framework-specific extractors + shared verification engine
**Choice:** Each framework gets its own parser extractor (`extractCypressSelectors`, `extractWebdriverIOSelectors`, `extractTestCafeSelectors`) while fingerprinting, verification, and scoring remain Playwright-based and framework-agnostic.
**Why:** The parser needs framework-specific AST knowledge (different method names, chaining patterns, context-tracking calls). But DOM fingerprints are universal - an element's tag, attributes, text, and parent chain are the same regardless of which framework's test first selected it. Keeping verification in Playwright means one browser engine does all DOM work, avoiding the complexity of integrating three different browser automation libraries.
**Trade-off:** Users testing with Cypress/WDIO/TestCafe still need Playwright installed as a dev dependency for the healer to verify selectors. Acceptable because Selector Healer is a dev tool, not a runtime dependency.

### Framework detection: AST-based with path-based fallback
**Choice:** Auto-detect framework from `import`/`require` statements in the file's AST. Falls back to path conventions (`.cy.ts` → Cypress, `.wdio.ts` → WebdriverIO, `.testcafe.ts` → TestCafe). Explicit `framework` override in config takes highest priority.
**Why:** Import-based detection is the most reliable signal - if a file imports `@wdio/globals`, it's WebdriverIO regardless of its filename. Path-based fallback handles files where imports are ambient (Cypress's `cy` global doesn't require an import). Config override handles edge cases and mixed-framework monorepos.
**Alternatives considered:** (1) Only path-based - misses files with non-standard naming. (2) Only config-based - requires user to explicitly set framework, worse DX. (3) Content heuristics (look for `cy.`, `$()`, `Selector()` in source) - fragile, false positives from similarly-named functions.

### Heal output: framework-specific replacement code generator
**Choice:** `generateReplacementCode(fingerprint, framework)` produces idiomatic replacement code for each framework. Playwright: `page.getByTestId(...)`. Cypress: `cy.get('[data-testid="..."]')`. WebdriverIO: `$('[data-testid="..."]')`. TestCafe: `Selector('[data-testid="..."]')`.
**Why:** Heal suggestions must be directly pasteable into the user's test file. Outputting Playwright syntax into a Cypress file would be worse than unhelpful. Each framework has its own idioms for the same concepts (text matching, role queries, test-id attributes).
**Alternatives considered:** (1) Output only CSS selectors universally - loses framework-specific semantic APIs (Cypress `cy.contains`, WDIO `aria/`, TestCafe `.withText()`). (2) Let users convert manually - defeats the purpose of auto-healing.

### `SelectorUsage.framework` field: optional, backward-compatible
**Choice:** Added `framework?: Framework` to `SelectorUsage` (defaults to `'playwright'` when omitted). The `HealerConfig` also accepts an optional `framework` field.
**Why:** Backward-compatible with all existing tests and fingerprints. Existing Playwright-only workflows continue working unchanged. The framework field flows through to the healer so it knows which syntax to output.

## 2026-06-01 - Smart `init` (auto-detected config scaffolding)

### Shared detection engine in `core` (used by CLI `init` and VS Code "Create Config")
**Choice:** `detectProjectConfig(cwd)` and `renderConfigFile(detection)` live in `@selector-healer/core` (`src/init/`). Both the CLI's `init` command and the VS Code "Create Config" welcome action call them.
**Why:** Avoids duplicating detection logic across the CLI and the extension (the extension can't depend on the CLI; both already depend on core). One implementation, one set of tests, identical behavior everywhere.

### Detect from `package.json`, framework configs, and `.env` - never copy secrets
**Choice:** Framework is inferred from deps + the presence of a framework config file; `baseUrl` from the framework config (`baseURL`/`baseUrl`, parsed via Babel AST, including no-substitution template literals) then `.env*` URL-shaped keys; `testDir` from the config's `testDir`/`specPattern` (must exist on disk) then a scan of common directories. Every field carries a confidence flag. Only a URL-shaped `baseUrl` is ever read from `.env` - credentials are never copied; the generated auth example reads them from `process.env`.
**Why:** A ready-to-run config beats a blank skeleton, but guessing must be transparent (TODOs on low-confidence fields) and safe (no secrets leaking into a committed file). AST parsing (not regex) honors the repo's "no regex on source" rule and handles comments/formatting robustly.
**Alternatives considered:** (1) Evaluating/`require`-ing the user's config to read values - unsafe (side effects) and fails on `.ts` without a loader. (2) Regex extraction - brittle, picks up commented values. (3) Interactive prompts - adds a prompt dependency and breaks non-interactive/CI use.

### Generated config is `.cjs`
**Choice:** `init` always writes `selector-healer.config.cjs` (with a JSDoc `@type` for editor hints). On `--force`, any other-extension config is removed so the `.cjs` is the single source cosmiconfig loads.
**Why:** A `.ts` config silently fails to load in projects without a TypeScript loader (the exact trap a real user hit). `.cjs` loads everywhere - ESM or CJS projects, with or without a transpiler - making first-run reliable. Removing a stale `.ts` on `--force` avoids cosmiconfig preferring it over the freshly generated `.cjs`.

## 2026-06-01 - Proactive selector-quality lint

### Robustness rating + static fragility lint in `core`
**Choice:** A shared `core` module rates each selector's resilience (`robust`/`good`/`moderate`/`fragile`) and `lintSelectors` flags the fragile ones - visible text, structural CSS, XPath. CSS is value-aware: `[data-testid]`/id selectors are sturdy, class/structural ones are fragile. Surfaced via a CLI `lint` command and inline VS Code Information diagnostics.
**Why:** The healer was purely *reactive* (fix breaks after they happen). Most users will keep writing text/CSS locators, so the tool needs to flag fragility *proactively* - at authoring time, for everyone - without a one-off manual audit. A pure, DOM-free rating works instantly with no baseline.
**Alternatives considered:** (1) Only reactive healing - misses fragile locators until they break. (2) A separate linter tool - duplicates the parser/scoring already in core.

### DOM-backed upgrades reuse the heal engine; only suggested when genuinely sturdier
**Choice:** When a fingerprint exists, `lintSelectors` computes the element's best available anchor via `bestSelectorType` + `generateReplacementCode`, and attaches an `upgrade` **only if** its tier is strictly more robust than the current selector. The VS Code provider offers it as a quick-fix (reusing `findCallExpressionRange` + `stripLeadingReceiver`); the CLI prints it.
**Why:** A suggestion is only useful if it's actually better - suggesting `getByText`→`getByText` is noise. On third-party apps with no test-ids (e.g. OrangeHRM), the lint honestly flags fragility *without* inventing an upgrade that doesn't exist. Reusing the heal engine keeps one source of truth for replacement generation.

### Fragility diagnostics are Information severity, on the authoring path
**Choice:** Fragility diagnostics use `Information` severity and are emitted from the on-open/on-save parse path (not the verify path). They never gate CI by default (`lint --strict` opts in).
**Why:** Fragility is advice, not a failure - `Error`/`Warning` would cause noise and false CI breaks. Surfacing during authoring is where the nudge changes behavior; after a verify run, the broken/heal diagnostics take precedence.

## 2026-07-30 - Warm browser for watch mode

### Reuse one browser across watch re-verifies instead of relaunching
**Choice:** `verifySelectors`/`healSelectors` gained an optional pre-opened `context`; a new `openHealerBrowser(config, root)` returns a reusable context (browser launched + `globalSetup` applied once) plus a `close()`. The VS Code extension keeps one such session alive while watch mode is on and passes its context to every watch re-verify, so each save skips the cold Chromium launch. The session opens lazily on the first watch run and closes on watch-off, config-file save, or deactivate; on a run error it's discarded and reopened next time (crash recovery). The CLI and manual runs pass no context, so their behaviour is unchanged (launch + close per call).
**Why:** Each watch save was cold-launching Chromium for verify and again for heal (~1s each) - the dominant cost of the "why is this slow?" wait. A warm, reused context cuts that to zero after the first save. Verify and heal already close their pages, so a reused context doesn't leak.
**Trade-off:** a headless Chromium stays alive while watch is on (~150 MB), closed the moment watch turns off. Standard for watch tooling, and opt-in (watch is off by default).
**Alternatives considered:** (1) Share a browser only within a single run (verify + heal) - smaller win, no idle process, but still relaunches every save. (2) Skip heal in watch - drops instant suggestions. (3) Leave as-is - the slowness users reported.

## 2026-07-30 - Recover renamed selectors via source-line baseline

### Fingerprints store their source location; baseline lookup falls back to it
**Choice:** `DomFingerprint` gained an optional `source: { file, line, column }` (`file` project-root-relative + forward-slashed; `line`/`column` the 1-indexed call site), written at capture time. When a selector's direct baseline lookup misses, `findOrphanBaseline` returns the fingerprint captured for a *different* id at the same `file:line:column`. Both `verifySelectors` and `healSelectors` use this fallback, so a renamed selector is verified (not skipped) and healed against the element that used to be there. The heal leads its explanation with a `renamed` `BreakReason`.
**Why:** A selector's id is `hash(file:line:value)`, so editing the string inside a locator - `getByLabel('Email')` → `getByLabel('Nope')` - mints a new id with no baseline. Previously that surfaced as "no replacement found": the healer heals DOM drift, and a rename isn't drift. But the baseline for the original value still sits at that exact call site - renaming the *argument* doesn't move the call's start column - and it's almost certainly the element the user still means, so we reuse it to suggest the right locator instead of giving up. This is the #1 confusion in manual testing (users test by renaming a selector and expect a fix).
**Why column too, not just `file:line`:** two distinct selectors can share a line (a chained locator), and `file:line` alone would let one borrow the other's baseline - a *wrong* suggestion, the worst outcome. Adding `column` disambiguates them, and it's stable across a rename (the argument text sits to the right of the call start). If a reflow ever does move the column, recovery degrades to "no suggestion" - never a wrong one.
**Trade-off:** A line *shift* (inserting lines above) orphans baselines with no recovery - out of scope; that's inherent to the id scheme, a separate problem. Recovery also needs one fresh capture to populate `source`.
**Safety:** The fallback only fires when a fingerprint carries `source`, which only newly-captured baselines have - so every pre-existing test fixture (and committed baseline) sees identical behaviour until re-captured. `source` is relative + posix-normalised so the committed `fingerprints.json` stays portable and leaks no absolute paths.
**Alternatives considered:** (1) Match on `file:line` only - coarser, risks a wrong suggestion when two selectors share a line. (2) Reconstruct the old id - impossible, the old value is gone. (3) Leave as "no replacement found" - the confusing status quo. (4) A new `HealSuggestion.recovered` flag for the UI - unneeded; `stored.selectorId !== selector.id` already signals recovery, and the UI renders the `renamed` reason string.

### A rename surfaces two ways - watch must notice both; heal only *labels* the certain one
**Choice:** A selector edit surfaces two ways, because the id is `hash(file:line:rawValue)` and `getByRole`'s accessible name lives in `options`, not `rawValue`: (a) **id changes** - `getByLabel('Email')` → `getByLabel('Nope')` mints a new id; (b) **id stable** - `getByRole('link', { name: 'Sign up' })` → `{ name: 'Sign down' }` keeps the id. Watch's change-detection must catch **both**, so it compares a full `selectorSignature` (`id | selectorType | options`), not the id alone - otherwise a name-only edit is silently ignored. But heal only prints the `renamed` reason for case (a): the id changing at a fixed call site can *only* be a rawValue edit, so it's certain. Case (b) gets the correct suggestion with **no** `renamed` label.
**Why the asymmetry:** at heal time, core has the current selector and the baseline *fingerprint* - not the selector's original `options`. So it cannot distinguish "user edited the `getByRole` name" from "the app changed a label the fingerprint doesn't capture" (e.g. a `getByLabel` whose separate `<label>` element was renamed): both present as "broken, but the element looks unchanged". Labeling that "renamed" would tell users they edited something they didn't. We refuse to guess - the suggestion is offered regardless; only the *claim* is withheld. (An earlier version inferred a rename from "broken + zero DOM diff" (`elementUnchanged`) and was dropped for exactly this false-positive.)
**Why the signature isn't folded into the id:** putting `options` into `makeSelectorId` would orphan every existing `getByRole` baseline and ripple through fingerprint storage; the signature is a local watch concern, not an identity change. `selectorSignature`/`selectorsChangedSince` live in the vscode-free `watch.ts` so they're unit-tested.
**Alternatives considered:** (1) Capture the selector's original `rawValue`+`options` in the fingerprint so heal *could* detect case (b) precisely - deferred; more schema + a re-capture, and the suggestion is already correct + self-evident (`Sign down` vs suggested `Sign up`). (2) Re-verify the whole file every save - drops the change-detection speed-up and can wrongly flag untouched auth-gated selectors (the regression that motivated change-detection).

## 2026-07-31 - "Skip" (dismiss) broken selectors

### Dismiss by selector signature, set aside from active counts, persisted separately
**Choice:** A **Skip** button on every attention-state card (broken / multiple-matches / page-load-failed) adds the selector's `selectorSignature` (`id | type | options`) to a persisted `dismissedSignatures` set. `serialize` pulls dismissed attention selectors out of `items` **and** the health counts into a separate `dismissed` list, rendered as a collapsible "Dismissed (N)" with a **Restore** button each. The set lives on the `HealerSnapshot` (so both surfaces re-render through the existing change event) but is persisted under its own `workspaceState` key, independent of the verify-results snapshot.
**Why signature, not id or file\:line:** the dismissal must re-surface the moment the user actually *edits* the selector (a `getByRole` name lives in `options`, not the id) - reusing `selectorSignature` gives exactly that, and matches watch's change-detection. A dismissal only hides *attention* states, so a dismissed selector that later verifies `ok` shows normally; if it breaks again it reappears in the Dismissed list, restorable - never silently lost.
**Why out of the counts:** Skip means "I've decided not to act on this now", so the health %/chips should reflect what's *actively* tracked. The always-visible "Dismissed (N)" keeps set-aside breakage from disappearing.
**Why a separate persistence key (not in the run snapshot):** dismissals are a user preference that must outlive `reset()` and a verify with zero results; folding them into the persisted run snapshot would tie their lifetime to the results. `reset()` deliberately preserves them.
**Why one `activeResults` across every surface (incl. the editor):** Skip must mean "leave me alone everywhere", so a single `activeResults(snap)` (the non-dismissed set) is the sole source of truth for what needs attention - the dashboard list + health, the status-bar count, Heal-All, **and** the editor's inline flags (Problems-panel diagnostics, gutter decorations, CodeLens). Decorations and CodeLens already rebuilt on `onDidChange`, so switching them to `activeResults` covered Skip/Restore for free. Diagnostics were the outlier (rebuilt by four scattered explicit calls), so they were made **reactive** too - one `onDidChange` builder over `activeResults` replaces all four - which means Skip/Restore (they only mutate the dismissed set) now silence/restore the squiggles as well, and there's a single place that builds diagnostics. **Two collections, not one:** verify diagnostics (rebuilt wholesale via `collection.clear()`) now live in their own `DiagnosticCollection`, separate from the on-save fragility/no-baseline **lint** collection - otherwise the reactive `clear()` (now firing on *every* state change, including a Skip click) would wipe the lint diagnostics until the next save. A file that has verify results has its lint entry cleared (they'd double up on the same selector); a file with no results keeps its lint through any verify. Both carry `source: 'selector-healer'`, so the Problems panel still shows one group.
**Alternatives considered:** (1) Ephemeral hide (this run only) - reappears on every watch save, defeating the point. (2) Permanent ignore via an inline `// selector-healer-ignore` comment - stronger but edits the user's source and never re-surfaces; kept as a possible future option. (3) Key by `id` only - a `getByRole` name edit would stay wrongly dismissed. (4) Silence only the dashboard, leave the editor truthful - considered, but "Skip" that still squiggles in the editor doesn't deliver "leave me alone".

### Heal history is a dashboard view, not a QuickPick
**Choice:** "Heal History" now opens a persistent **view inside the dashboard** (a fourth mode alongside results / capture / baseline), reachable via a "History ›" link in the results header and from the status menu. It lists applied heals newest-first, each with its own **Undo**, plus **Clear history**. The old `showQuickPick` (a transient dropdown from the top of the window) is gone. Mirrors the Baseline view exactly: the webview posts `showHistory`/`undo`/`clearHistory`; the surface fetches via `selectorHealer.getHistory` and re-posts `historyData` (also refreshing after an undo/clear so the list stays live).
**Why:** a dropdown that vanishes on the next keystroke is a poor home for a browsable log you undo from. A real view is scrollable, stays put, and works identically in the sidebar and the editor tab. In-view undo runs `undoEntry(entry, { silent: true })` - a non-blocking toast, no "Verify now" prompt - so the list refreshes in place instead of the modal bouncing the user back to the results view. The command path sets a `pendingHistory` flag so it still lands on History even when it has to (re)create the sidebar first.
**Alternatives considered:** (1) Keep the QuickPick - the user's complaint ("it shows from the top"). (2) A dedicated editor tab just for history - diverges from the one-dashboard pattern; the dashboard already opens as an editor tab via "Open Dashboard", carrying the History view with it.

## 2026-07-31 - "Confidence, explained" (per-rule breakdown)

### Surface the scoring `ruleScores` the healer already computes
**Choice:** `scoreCandidate` already returns a `ruleScores` breakdown (`{ name, quality, weighted }` per rule) but it was dropped at the heal layer. Thread it through - `HealCandidate.ruleScores` → `StoredSuggestion.ruleScores` → the webview - and render an expandable **"Why NN%?"** under the top suggestion: the rules that fired, biggest contribution first, each as name + mini-bar (match quality) + `%`. `RuleScore` moved from `scoring.ts` to `types.ts` (its natural home) and is re-exported, so nothing importing it breaks.
**Why:** the confidence number alone asks for blind trust; showing *which signals* produced it (test-id 100%, text 80%, role 100%) makes it inspectable - the project's "trust before magic" principle. It's also the deliberate **stepping stone to "learn from accept/reject"**: that feature nudges these same per-rule weights per project, and users won't trust *learned* weights until they can first *see* the per-rule contributions.
**Scope:** the structured breakdown is on the top suggestion; runner-up alternates keep their one-line `reasoning` text (added with "preview all candidates") to stay compact. Optional field, so restored/older suggestions with no `ruleScores` simply show no expander.
**Alternatives considered:** (1) Just print the existing `reasoning` string for the top - quicker, but a flat sentence, not the inspectable bars, and it wouldn't give the learning feature structured data in the UI layer. (2) Show the breakdown on every candidate - noise in the collapsed alternates list.

## 2026-07-31 - Hover cards on selectors

### Results-driven hover, pure markdown builder
**Choice:** A `HoverProvider` shows a card when you hover a selector in a test file - status, the element it matches (from the result's fingerprint), page, last-verified/captured time, and (when broken) the break reason + top suggestion + robustness. It matches the selector under the cursor by reusing `findCallExpressionRange` against the current `healerState` `activeResults`, and reuses the result's own `storedFingerprint`/`liveFingerprint` (no extra `fingerprints.json` read on hover). The card content is a pure `buildHoverMarkdown(info)` - no VS Code or state access - so it's unit-tested; the provider just reduces state into that input and wraps it in a themed `MarkdownString`.
**Why results-based (only verified selectors get a card):** it matches the roadmap intent (fingerprint, last-verified, page, confidence - all state the tool already has after a verify) and avoids parsing the file on every hover. A never-verified selector shows nothing until you Verify - acceptable, and cheap. Skipped selectors stay silent (via `activeResults`), consistent with the gutter and CodeLens.
**Trade-off:** if the file was edited since the last verify, the stored column can be stale and the hover may not trigger until re-verify - the same position-staleness the other per-selector surfaces have. Acceptable; watch re-verifies on save.

## 2026-07-31 - Native Walkthrough + Settings UI

### Add a native Get-Started walkthrough (keep the in-dashboard onboarding)
**Choice:** A `contributes.walkthroughs` entry gives the standard VS Code "Get Started" experience - four steps (Create Config → Capture → Verify → Heal), each with a command button and a markdown media pane, auto-checked via `onCommand` completion events. The dashboard's own contextual onboarding (empty-state cards) stays: the two serve different entry points (Welcome tab vs the panel you're already in), so this *adds* the native surface rather than ripping out the working one.
**Why:** the native walkthrough is discoverable (Help → Get Started), feels standard, and ticks steps off as the user runs the commands - better first-run discovery than a custom screen alone. Purely declarative + four small markdown files under `media/walkthrough/` (not in `.vscodeignore`, so they ship in the `.vsix`).

### Settings UI: expose the two knobs that are genuinely extension-level
**Choice:** `contributes.configuration` surfaces `selectorHealer.lint.enabled` (mute the proactive fragility warnings) and `selectorHealer.watch.debounceMs` (watch re-verify delay). Both are *wired*: lint.enabled is read fresh in `parseSingleFile` (and a config-change listener clears + re-scans open editors so a toggle applies immediately); debounceMs is read in `activate()` when the debouncer is built (reload to apply).
**Why not more:** most of the tool's config is the project `HealerConfig` file (testDir/baseUrl/thresholds/pages), which belongs in the repo, not per-user VS Code settings. Only genuinely user/editor-level preferences go here - a Settings UI full of settings that duplicate the config file would be confusing. Two real, wired toggles beat ten dead ones.

## 2026-07-31 - Prune stale fingerprints (baseline GC)

### Recovery-aware prune, offered on three surfaces, never silent
**Choice:** A pure `pruneFingerprints(store, currentSelectors, root)` in core returns `{ kept, removed }`. It removes a fingerprint only when it's **fully unreachable**: its id isn't a current selector **and** it carries no `source` whose call site (`file:line:column`) is still occupied by a current selector. That second clause deliberately keeps the orphans that power **rename recovery** (`findOrphanBaseline`) - pruning must not disable a recovery the user relies on. Surfaced as: `selector-healer prune` (with `--dry-run`/`--verbose`), and an extension command (palette + status menu) that shows a modal count and asks before rewriting `fingerprints.json`.
**Why:** capture only ever *merges*, so the committed baseline accumulates orphans (60% stale in our sample) - bloating the file and its git diffs. A GC keeps it honest. Everything is additive (new core module + new commands; no existing code paths changed), it never touches the user's tests, and it never deletes without a preview/confirm (CLI dry-run, extension modal) - the store is committed to git, so it's reversible regardless.
**Alternatives considered:** (1) Prune every orphan (id not current) - simplest, but it would delete the rename-recovery baselines the moment before the user accepts the heal. (2) Auto-prune inside `capture` by default - too surprising for a destructive op; kept opt-in (a future `capture --prune` flag can layer on the same core function). (3) Match orphans by `file:line` only when deciding reachability - a reflow could wrongly drop a still-reachable orphan; the full `file:line:column` mirrors `findOrphanBaseline`.

## 2026-08-04 - Declare @types/node in the extension package

### Add `@types/node` as a direct devDependency of `vscode-extension`
**Choice:** The extension imports Node builtins (`node:fs`, `node:path`, `node:crypto`) across `extension.ts`, `history.ts`, `overview.ts`, and `webview-content.ts`, but only the root and `@selector-healer/cli` declared `@types/node`. Under pnpm's isolated `node_modules`, the CLI `tsc` build still resolved node types by walking up to the hoisted root copy - but the editor's per-package TypeScript server did not, surfacing `ts(2591) Cannot find name 'node:path' … install @types/node` on every `node:*` import. Declaring `@types/node` (`^20.17.0`, matching root/cli) in the extension's `devDependencies` links it into the package, and pinning `"types": ["node", "vscode"]` in the extension `tsconfig.json` makes the editor resolve them by name via `typeRoots` (instead of relying on `@types` auto-discovery walking pnpm's symlinked `node_modules`) - fixing editor + build deterministically.
**Why an entry:** it's a new (type-only) dependency of this package, so the repo rule applies. It adds no runtime code - `@types/*` are compile-time only and already used elsewhere in the monorepo; this simply declares what the package actually imports, per pnpm's "each package depends on what it uses."

## 2026-08-04 - Hide weak alternative heal candidates

### `keepCompetitiveCandidates`: drop alternatives far behind the top suggestion
**Choice:** After ranking a broken selector's candidates, `keepCompetitiveCandidates` keeps the best one plus only the alternatives within `MAX_ALTERNATIVE_GAP` (0.3) confidence of it. So a clear winner (e.g. `getByRole('button',{name:'Add'})` at 0.90) no longer drags along structural look-alikes (OrangeHRM's `Reset`/`Search` buttons at ~0.50 - same tag/classes/position, different text) in the "other matches" list; when the top itself is uncertain, its close alternatives are all retained so the user still has options. A `1e-9` epsilon keeps an alternative sitting exactly at the gap (float math makes `0.9 - 0.6 = 0.30000000000000004`).
**Why:** the wide candidate net (`buildCandidateSelectors` queries by tag/role/class) is deliberately generous so the real element is never missed - but that means look-alikes get scored too. They rank far below the true match, yet still cleared the `suggest` floor (0.2) and showed as alternatives, which read as "why is it suggesting Search for an Add button?". Filtering by gap-from-top keeps the fallbacks meaningful without touching the recall of the top suggestion.
**Alternatives considered:** (1) Raise the global `suggest` threshold - would also suppress legitimately-weak *top* suggestions when nothing matches well, hurting recall. (2) A relative floor (alt ≥ 60% of top) - similar effect but less intuitive than "within 30 points"; the absolute gap is easier to reason about and explain in the UI.

## 2026-08-05 - Alternative filter: relative ratio supersedes the absolute gap

### `keepCompetitiveCandidates` now keeps alternatives within a *fraction* of the top, not a fixed gap
**Choice:** Replace `MAX_ALTERNATIVE_GAP` (0.3 absolute) with `MIN_ALTERNATIVE_RATIO` (0.75): an alternative shows only if `confidence ≥ top.confidence × 0.75`. This reverses the "relative floor" alternative rejected in the prior entry - real usage proved the absolute gap wrong.
**Why:** on OrangeHRM, breaking `getByRole('link', { name: 'Admin' })` gave a confident top (0.96) plus two *sibling* nav links (`PIM`, `Leave`) at 0.67 - different elements that merely share tag/class/position. `0.96 − 0.67 = 0.29 ≤ 0.30`, so the absolute gap kept them, reading as "why is it offering PIM as an alternative to Admin?". A gap that's fine behind a 0.70 top is noise behind a 0.96 top; scaling the bar with the top's confidence (strict when confident, lenient when uncertain) drops the look-alikes here while still showing genuine near-peers of a weak top. The recall of the *top* suggestion is untouched - only the "other matches" list is trimmed.
**Note:** the earlier entry's reasoning ("absolute is easier to explain") didn't survive contact with a high-confidence winner; this supersedes it.

## 2026-08-05 - Bound the auto-apply candidate pool by *structural* score, not the nudge

### `rankCandidates` slices the top-N by structural confidence, then reorders by nudge for display
**Choice:** the per-selector candidate list returned by `heal` is now built by `rankCandidates`: take the top {@link MAX_CANDIDATES} by **structural** score, *then* sort those by the learning-nudged confidence for presentation, *then* apply `keepCompetitiveCandidates`. Previously the list was sorted-and-sliced by the nudged confidence directly.
**Why:** auto-apply (CLI `--fix`, the extension's Apply-All) selects the structurally-best *survivor* of that list and gates it on the structural score - the deliberate "learning never tips an unattended edit" split. But the list it chose from was itself sliced by the **nudged** score, so a structurally-best fix whose *kind* is disliked (nudged down) could be pushed past rank 3 by liked-kind look-alikes and sliced out before auto-apply ever saw it. That let learning suppress a legitimate auto-apply indirectly - through the pool boundary rather than the selection. Slicing the pool by structural score closes that gap: the real best is always present; the nudge only decides display order and which far-behind alternatives are shown. A code-review pass flagged this after the display-vs-structural selection split was already in place - the split fixed *selection* but not the *pool* it selected from.
**Bounds check (corrected):** at the *default* 0.8 auto-apply floor a structural-best candidate (nudged ≥ 0.7) sits at or above the relative-ratio floor, so it survives. But a review found the guarantee breaks with a *custom* lower threshold: `keepCompetitiveCandidates` trims the slice by the *nudged* ratio, and a low-structural, disliked-kind best (e.g. structural 0.66, nudged 0.56) can fall under the floor behind a liked-kind sibling and be dropped - auto-apply would then take the structurally-inferior survivor. So `rankCandidates` now explicitly **re-adds the structural-best** if the nudge trim removed it (it is the strongest match, not a look-alike). The slice-by-structural and the re-add together close the hole regardless of the configured threshold.

## 2026-08-05 - "Couldn't reach the page" vs "element removed"

### Heal now distinguishes an unreachable page from a genuinely-gone element
**Choice:** the healer tracks, per selector, whether it ever scanned a page that actually loaded (`scannedOk`) versus hit a page-load/login failure (`scanFailed`). When a broken selector ends with no candidate, `isUnreachable()` decides between two very different empty results: if we have a baseline but never reached a loaded page *and* a load failed, the `HealSuggestion` is flagged `unreachable: true` and its explanation becomes a `BreakReason` of kind `'unreachable'` ("couldn't reach the page to check … try again") - instead of `explainBreak`'s default `'removed'` verdict. `config.globalSetup` (login) is now wrapped so a failed login degrades to unreachable rather than throwing out of the whole heal.
**Why:** on the flaky public OrangeHRM demo, a run where heal's own login/scan pass silently timed out (line-210 `catch` just logged and returned) surfaced as *"the element is no longer in the DOM (removed or fully replaced)"* + *"No replacement found"* - a confident false negative that reads as "the tool broke," when the element was fine and simply never got scanned. Verify's pass had logged in seconds earlier, so "8 ok" sat right above the scary message. Claiming removal is a verdict we only earn by actually looking; if we never reached a loaded page, the honest answer is "couldn't check - retry."
**Surfacing:** the flag rides through the existing `explanation` channel (selector→reason) that already reaches the card's info line, the editor diagnostic, and the CLI's `↳ why:` line - so no new state/persistence plumbing. The webview suppresses the generic "No replacement found" hint when a specific reason is present, so the unreachable message stands alone.
**Scope (URL-aware):** `isUnreachable` requires positive evidence we could not reach the element's page: a hard page-load failure (`scanFailed`) *or* a page that loaded but wasn't the element's page (`wrongPage`) - and in both cases `!scannedOk`. `scannedOk` is now **URL-aware**: set only when the scanned page's final URL matches the element's captured `pageUrl` (origin + path; see `samePage`), so a redirect to a 200 login screen no longer counts as "reached". Crucially the match is against the *captured* `pageUrl`, not the requested target, so a benign canonical redirect (`/` → `/home`, baseline captured at `/home`) still matches while a login bounce (`/dashboard` → `/login`) does not. For this to hold, capture stores the **final** (post-redirect) `page.url()` in *both* phases - a review caught that Phase 1 previously stored the *requested* URL, which would have made every canonical-redirect entry page read as "wrong page"; now fixed so the two phases agree. An earlier `authFailed` variant (treat a thrown `globalSetup` as unreachable) was **reverted** as too blunt - it flagged *every* not-found selector during a bad-login run, masking genuine removals on public pages. The URL-match is the targeted replacement: it fires only for the selectors whose own page we demonstrably didn't reach, never as a blanket "login failed", so a genuine removal on a page we *did* reach still reads `'removed'`. `globalSetup` stays wrapped (a failed login must not throw), and the failed-load `catch` closes its page.
**What this fixes, and the one residual:** URL-matching closes two of the three soft cases - (a) the protected route that 200s to a login screen and (b) an element whose real page is a phase-2 page that fails while its phase-1 page loaded: in both, the scanned URL no longer matches the element's `pageUrl`, so they now read "couldn't reach" instead of a false "removed". The remaining soft case is (c) an **SPA render race** - the page loads the *right* URL (so `scannedOk`) but hasn't painted the element yet, and an unrendered element is indistinguishable from a removed one. The `networkidle` settle (capped, non-fatal) absorbs most of it; a pathologically slow render can still read `'removed'`. Telling it apart for certain would need to wait for the specific element, which risks a long hang on a genuinely-removed one - so it stays best-effort. One further narrow gap: a **hash-router** SPA (`#/dashboard` bouncing to `#/login`) shares origin + path, so `samePage` can't see the redirect and it reads `'removed'` - including the hash would risk false mismatches on content anchors (`#section`), so real-path routing (the common case) is covered and hash routing is not.

## 2026-08-05 - Learning storage: default local + a setup-time picker

### Accept/reject learning no longer silently creates a committed feedback file
**Choice:** the default store for adaptive-learning feedback is now `'local'` (the editor's workspace storage), not `'committed'`. The extension's `mode()` reads `local = store !== 'committed'`, and heal loads the committed `.selector-healer/feedback.json` only when `store === 'committed'` is set explicitly. **Create Config** now asks - a quick-pick of Local (recommended) / Committed / Off - and writes the choice into the generated config; `renderConfigFile` emits a `learning` block (an active field when chosen, a documented comment otherwise), and the CLI gains `selector-healer init --learning <store>`.
**Why:** a code review found the previous default (enabled + committed) silently created and git-tracked `feedback.json` on the very first Apply/Skip, even in a project that never opted into learning - surprising diff noise. Local-by-default fixes that: learning works out of the box, per developer, with nothing committed; sharing it with the team (so CLI/CI heal benefits too) is a deliberate opt-in. The storage question is asked once, at setup, where it belongs - not inferred silently at first use.
**Trade-off:** with the local default, the CLI/CI heal - which can read only the committed file, not the editor's workspace storage - gets no learning nudge until someone opts into `'committed'`. Accepted: a surprise-free default beats maximal reach, and teams that want shared learning pick Committed at setup.
