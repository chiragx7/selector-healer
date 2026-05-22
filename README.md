# Selector Healer

A local-first developer tool that statically scans Playwright test files, verifies each selector against a live DOM, and suggests AST-based replacements when selectors have broken — before CI catches them.

> **Status:** Phase 1 scaffolding. See [`DECISIONS.md`](DECISIONS.md) for non-obvious choices and [`CLAUDE.md`](CLAUDE.md) for the architecture summary.

## Packages

| Package | Description |
|---|---|
| [`@selector-healer/core`](packages/core) | Framework-agnostic library (parser, fingerprint, verifier, healer). |
| [`@selector-healer/cli`](packages/cli) | The `selector-healer` CLI binary. |
| [`vscode-extension`](packages/vscode-extension) | VS Code extension with diagnostics and quick-fix code actions. |

## Local development

Requires **Node 20 or newer**. pnpm comes via Corepack — no global install needed.

```bash
corepack enable
corepack prepare pnpm@latest --activate

pnpm install
pnpm build
pnpm test
pnpm lint
```

Run a single package:

```bash
pnpm -F @selector-healer/core test
pnpm -F @selector-healer/cli build
```

## License

[MIT](LICENSE)
