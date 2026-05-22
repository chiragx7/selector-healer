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
