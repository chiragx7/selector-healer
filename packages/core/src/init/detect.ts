import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { logger } from '../logger.js';
import type { Framework } from '../types.js';
import { type DetectedLogin, type DetectedPage, analyzeTestSuite } from './analyze-tests.js';

/**
 * Best-effort detection of a test project's shape, used by `init` to scaffold a
 * ready-to-use config. Every field has a confident-or-default flag so the
 * generator can mark anything it had to guess with a `TODO`.
 */
export interface ProjectDetection {
  framework: Framework;
  frameworkConfidence: 'detected' | 'default';
  /** Other frameworks also present in the project, if any (for an advisory note). */
  otherFrameworks: Framework[];
  baseUrl: string;
  /** Where `baseUrl` came from: a config filename, an env filename, or `'default'`. */
  baseUrlSource: string;
  baseUrlConfident: boolean;
  testDir: string;
  /** Where `testDir` came from: a config filename, `'directory scan'`, `'convention'`, or `'default'`. */
  testDirSource: string;
  testDirConfident: boolean;
  testGlob: string;
  /** True when the project is TypeScript-based (a `tsconfig.json` or a `.ts` framework config). */
  usesTypeScript: boolean;
  /** Pages the tests navigate to (from `page.goto()`), for pre-filling `pages[]`. */
  pages: DetectedPage[];
  /** A login flow lifted from the tests, if one was recognised. */
  login?: DetectedLogin;
  /** Module specifier for the Playwright `Page` type used in a generated `.ts` hook. */
  playwrightImport: string;
}

const FRAMEWORK_PRIORITY: Framework[] = ['playwright', 'cypress', 'webdriverio', 'testcafe'];

const FRAMEWORK_CONFIG_FILES: Record<Framework, string[]> = {
  playwright: [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ],
  cypress: [
    'cypress.config.ts',
    'cypress.config.js',
    'cypress.config.mjs',
    'cypress.config.cjs',
    'cypress.json',
  ],
  webdriverio: ['wdio.conf.ts', 'wdio.conf.js', 'wdio.conf.cjs', 'wdio.conf.mjs'],
  testcafe: ['.testcaferc.json', '.testcaferc.js', '.testcaferc.cjs', '.testcaferc.ts'],
};

const TEST_GLOBS: Record<Framework, string> = {
  playwright: '**/*.{spec,test}.{ts,js,mjs}',
  cypress: '**/*.cy.{ts,js,jsx,tsx}',
  webdriverio: '**/*.{spec,test}.{ts,js}',
  testcafe: '**/*.{ts,js}',
};

const DEP_TO_FRAMEWORK: Array<{ dep: string; framework: Framework }> = [
  { dep: '@playwright/test', framework: 'playwright' },
  { dep: 'playwright', framework: 'playwright' },
  { dep: 'cypress', framework: 'cypress' },
  { dep: 'webdriverio', framework: 'webdriverio' },
  { dep: '@wdio/cli', framework: 'webdriverio' },
  { dep: 'testcafe', framework: 'testcafe' },
];

const COMMON_TEST_DIRS = [
  'e2e',
  'tests',
  'test',
  'cypress/e2e',
  'src/pages',
  'src/tests',
  'spec',
  '__tests__',
  'integration',
];

const ENV_FILES = ['.env', '.env.local', '.env.test', '.env.development', '.env.example'];
const ENV_URL_KEYS = [
  'BASE_URL',
  'APP_URL',
  'PLAYWRIGHT_BASE_URL',
  'CYPRESS_BASE_URL',
  'E2E_BASE_URL',
  'TEST_BASE_URL',
  'BASE_URI',
  'URL',
];

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_TEST_DIR = './tests';

/**
 * Detect a project's framework, base URL, and test directory for `init`.
 * Reads local files only (package.json, framework configs, `.env*`) — no
 * network — and never throws; unreadable sources are skipped.
 *
 * @param cwd - absolute path to the project root to inspect
 * @returns the detected shape, with a confidence flag per field
 *
 * @example
 * const d = detectProjectConfig('/repo');
 * // { framework: 'playwright', baseUrl: 'http://localhost:4200', testDir: './e2e', ... }
 */
export function detectProjectConfig(cwd: string): ProjectDetection {
  const pkg = readPackageJson(cwd);
  const { framework, otherFrameworks, frameworkConfidence } = detectFramework(cwd, pkg);
  const base = detectBaseUrl(cwd, framework);
  const dir = detectTestDir(cwd, framework);
  const analysis = analyzeTestSuite(cwd, dir.dir, TEST_GLOBS[framework], base.url);

  return {
    framework,
    frameworkConfidence,
    otherFrameworks,
    baseUrl: base.url,
    baseUrlSource: base.source,
    baseUrlConfident: base.source !== 'default',
    testDir: dir.dir,
    testDirSource: dir.source,
    testDirConfident: dir.source !== 'default',
    testGlob: TEST_GLOBS[framework],
    usesTypeScript: detectUsesTypeScript(cwd),
    pages: analysis.pages,
    login: analysis.login,
    playwrightImport: detectPlaywrightImport(pkg),
  };
}

/**
 * The module specifier whose `.Page` type a generated `.ts` setup hook should
 * cast to. Selector Healer always drives a Playwright `Page`, so this prefers
 * whichever package the project actually installed.
 */
function detectPlaywrightImport(pkg: Record<string, unknown>): string {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  if (deps['@playwright/test']) return '@playwright/test';
  if (deps.playwright) return 'playwright';
  return '@playwright/test';
}

/**
 * True when the project is TypeScript-based: it has a `tsconfig.json` or a
 * `.ts` framework config (e.g. `playwright.config.ts`). Decides whether `init`
 * emits a typed `.ts` config or a zero-tooling `.cjs` one.
 */
function detectUsesTypeScript(cwd: string): boolean {
  if (existsSync(join(cwd, 'tsconfig.json'))) return true;
  for (const files of Object.values(FRAMEWORK_CONFIG_FILES)) {
    for (const f of files) {
      if (f.endsWith('.ts') && existsSync(join(cwd, f))) return true;
    }
  }
  return false;
}

function readPackageJson(cwd: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function detectFramework(
  cwd: string,
  pkg: Record<string, unknown>,
): {
  framework: Framework;
  otherFrameworks: Framework[];
  frameworkConfidence: 'detected' | 'default';
} {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };

  const present = new Set<Framework>();
  const withConfig = new Set<Framework>();

  for (const { dep, framework } of DEP_TO_FRAMEWORK) {
    if (deps[dep]) present.add(framework);
  }
  for (const fw of FRAMEWORK_PRIORITY) {
    if (firstExisting(cwd, FRAMEWORK_CONFIG_FILES[fw])) {
      present.add(fw);
      withConfig.add(fw);
    }
  }

  // Prefer a framework that has a config file, then any present, else default.
  const chosen =
    FRAMEWORK_PRIORITY.find((f) => withConfig.has(f)) ??
    FRAMEWORK_PRIORITY.find((f) => present.has(f)) ??
    'playwright';

  return {
    framework: chosen,
    otherFrameworks: FRAMEWORK_PRIORITY.filter((f) => f !== chosen && present.has(f)),
    frameworkConfidence: present.size > 0 ? 'detected' : 'default',
  };
}

function detectBaseUrl(cwd: string, framework: Framework): { url: string; source: string } {
  const ordered: Framework[] = [framework, ...FRAMEWORK_PRIORITY.filter((f) => f !== framework)];

  for (const fw of ordered) {
    for (const file of FRAMEWORK_CONFIG_FILES[fw]) {
      const path = join(cwd, file);
      if (!existsSync(path)) continue;
      const url = file.endsWith('.json')
        ? (jsonString(path, ['baseUrl']) ?? jsonString(path, ['e2e', 'baseUrl']))
        : stringPropFromSource(path, new Set(['baseURL', 'baseUrl']));
      if (url && isHttpUrl(url)) return { url, source: file };
    }
  }

  const fromEnv = baseUrlFromEnv(cwd);
  if (fromEnv) return fromEnv;

  return { url: DEFAULT_BASE_URL, source: 'default' };
}

function baseUrlFromEnv(cwd: string): { url: string; source: string } | undefined {
  for (const file of ENV_FILES) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const env = parseEnv(content);
    for (const key of ENV_URL_KEYS) {
      const val = env[key];
      if (val && isHttpUrl(val)) return { url: val, source: file };
    }
  }
  return undefined;
}

function detectTestDir(cwd: string, framework: Framework): { dir: string; source: string } {
  // 1. An explicit testDir in the framework config (Playwright, WDIO).
  for (const file of FRAMEWORK_CONFIG_FILES[framework]) {
    const path = join(cwd, file);
    if (!existsSync(path) || file.endsWith('.json')) continue;
    const td = stringPropFromSource(path, new Set(['testDir']));
    if (td && existsSync(join(cwd, stripDotSlash(td)))) return { dir: ensureRel(td), source: file };
  }

  // 2. Cypress: derive a folder from specPattern, or fall back to convention.
  if (framework === 'cypress') {
    for (const file of FRAMEWORK_CONFIG_FILES.cypress) {
      const path = join(cwd, file);
      if (!existsSync(path)) continue;
      const sp = file.endsWith('.json')
        ? jsonString(path, ['e2e', 'specPattern'])
        : stringPropFromSource(path, new Set(['specPattern']));
      const derived = sp ? dirFromGlob(sp) : undefined;
      if (derived && existsSync(join(cwd, derived)))
        return { dir: ensureRel(derived), source: file };
    }
    if (dirHasFiles(join(cwd, 'cypress', 'e2e')))
      return { dir: './cypress/e2e', source: 'convention' };
  }

  // 3. Scan common directories that actually contain files.
  for (const d of COMMON_TEST_DIRS) {
    if (dirHasFiles(join(cwd, d))) return { dir: ensureRel(d), source: 'directory scan' };
  }

  return { dir: DEFAULT_TEST_DIR, source: 'default' };
}

// ── helpers ────────────────────────────────────────────────────────────────

function firstExisting(cwd: string, names: string[]): string | undefined {
  for (const n of names) {
    if (existsSync(join(cwd, n))) return n;
  }
  return undefined;
}

function stringPropFromSource(path: string, keys: Set<string>): string | undefined {
  try {
    const ast = parse(readFileSync(path, 'utf8'), {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
    return findStringProp(ast, keys);
  } catch (e) {
    logger.debug({ path, error: String(e) }, 'Failed to parse config file');
    return undefined;
  }
}

/**
 * Recursively find the first object property whose key is in `keys` and whose
 * value is a plain string (a string literal or a no-substitution template).
 */
// biome-ignore lint/suspicious/noExplicitAny: Babel AST nodes are dynamically shaped.
function findStringProp(node: any, keys: Set<string>): string | undefined {
  if (!node || typeof node !== 'object') return undefined;

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findStringProp(child, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (node.type === 'ObjectProperty' || node.type === 'Property') {
    const keyName: string | undefined = node.key?.name ?? node.key?.value;
    if (keyName && keys.has(keyName)) {
      const literal = stringValue(node.value);
      if (literal !== undefined) return literal;
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
    const found = findStringProp(node[key], keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: Babel AST nodes are dynamically shaped.
function stringValue(value: any): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (value.type === 'StringLiteral') return value.value;
  if (
    value.type === 'TemplateLiteral' &&
    value.expressions.length === 0 &&
    value.quasis.length === 1
  ) {
    return value.quasis[0]?.value?.cooked;
  }
  return undefined;
}

function jsonString(path: string, keyPath: string[]): string | undefined {
  try {
    let node: unknown = JSON.parse(readFileSync(path, 'utf8'));
    for (const key of keyPath) {
      if (node && typeof node === 'object' && key in node) {
        node = (node as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    return typeof node === 'string' ? node : undefined;
  } catch {
    return undefined;
  }
}

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    const key = m?.[1];
    if (!key) continue;
    let val = (m[2] ?? '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const comment = val.indexOf(' #');
      if (comment >= 0) val = val.slice(0, comment).trim();
    }
    out[key] = val;
  }
  return out;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function dirHasFiles(path: string): boolean {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function stripDotSlash(dir: string): string {
  return dir.replace(/^\.\//, '');
}

function ensureRel(dir: string): string {
  const normalized = dir.replace(/\\/g, '/');
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

function dirFromGlob(glob: string): string | undefined {
  const normalized = glob.replace(/\\/g, '/');
  const star = normalized.indexOf('*');
  const prefix = (star >= 0 ? normalized.slice(0, star) : normalized).replace(/\/$/, '');
  return prefix.length > 0 ? prefix : undefined;
}
