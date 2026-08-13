import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import fg from 'fast-glob';
import { logger } from '../logger.js';

// CJS/ESM interop - @babel/traverse ships CJS.
const traverse =
  typeof _traverse === 'function'
    ? _traverse
    : (_traverse as unknown as { default: typeof _traverse }).default;

/** A page the test suite navigates to (a `goto`, `waitForURL`, or `toHaveURL` target). */
export interface DetectedPage {
  /** Human-readable name derived from the path, e.g. `'/user/profile'` → `'User Profile'`. */
  name: string;
  /** The path the page lives at, e.g. `'/dashboard'`. */
  url: string;
  /**
   * True when the page is only ever reached from behind a login flow, so the
   * generated entry needs a setup hook. Pages reached without login are public.
   */
  requiresAuth?: boolean;
}

/** A single field-fill in a detected login flow. */
export interface DetectedFill {
  /** Receiver-stripped selector call source, e.g. `getByLabel('Email')`. */
  selector: string;
  /** Best-effort role of the field, inferred from the selector text. */
  kind: 'user' | 'password' | 'other';
}

/** A login flow lifted from a `beforeEach`/`login()` helper in the tests. */
export interface DetectedLogin {
  /** URL the login starts at (the `goto` before the fills), if any. */
  gotoUrl?: string;
  /** The form fills, in source order. */
  fills: DetectedFill[];
  /** Receiver-stripped selector source for the submit click, e.g. `getByRole('button', { name: 'Log in' })`. */
  click?: string;
  /** The `waitForURL` argument after submit, if any. */
  waitUrl?: string;
  /** Normalised path the login lands on (derived from `waitUrl`), e.g. `'/dashboard'`. */
  landingPath?: string;
}

export interface TestSuiteAnalysis {
  pages: DetectedPage[];
  login?: DetectedLogin;
}

/**
 * Statically analyse a test suite for `init`'s deep scan: collect the distinct
 * pages the tests reach - from `page.goto()`, `page.waitForURL()`, and
 * `expect(page).toHaveURL()` - and lift a simple login flow (a
 * `beforeEach`/`login()` helper that fills fields and clicks submit) so the
 * generated config can pre-fill `pages[]` + a setup hook.
 *
 * Each page is classified as auth-gated (only ever reached from a file that
 * logs in) or public (reached without login), so only the former get a login
 * setup. Page URLs built from a `const BASE = '...'` (template or `+`
 * concatenation) are resolved; absolute URLs are kept only when same-origin as
 * `baseUrl`, so external links are ignored.
 *
 * Reads test files only, never executes them, and never throws - unreadable or
 * unparseable files are skipped. It recognises the common inline-locator login
 * pattern; anything fancier (page objects, SSO) yields no `login`, and the
 * generator falls back to a commented example.
 *
 * @param cwd - project root
 * @param testDir - detected test directory (e.g. `./tests`)
 * @param glob - test file glob (e.g. `**\/*.spec.ts`)
 * @param baseUrl - the project's base URL, used to keep same-origin absolute links
 * @returns the detected pages and (optionally) a login flow
 *
 * @example
 * const { pages, login } = analyzeTestSuite('/repo', './tests', '**\/*.spec.ts', 'http://localhost:3000');
 */
export function analyzeTestSuite(
  cwd: string,
  testDir: string,
  glob: string,
  baseUrl?: string,
): TestSuiteAnalysis {
  const dir = isAbsolute(testDir) ? testDir : join(cwd, testDir.replace(/^\.\//, ''));

  let files: string[];
  try {
    files = fg.sync(glob, { cwd: dir, absolute: true, dot: false, suppressErrors: true });
  } catch (e) {
    logger.debug({ dir, error: String(e) }, 'Deep init: failed to glob test files');
    return { pages: [] };
  }

  const authGated = new Set<string>();
  const publicUrls = new Set<string>();
  let login: DetectedLogin | undefined;

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    try {
      const ast = parse(source, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        errorRecovery: true,
      });
      const consts = collectStringConsts(ast);
      const fileLogin = detectLogin(ast, source);
      const urls = new Set<string>();
      collectPageUrls(ast, urls, consts, baseUrl);
      const bucket = fileLogin ? authGated : publicUrls;
      for (const url of urls) bucket.add(url);
      if (!login && fileLogin) login = fileLogin;
    } catch (e) {
      logger.debug({ file, error: String(e) }, 'Deep init: failed to parse test file');
    }
  }

  const pages = [...new Set([...authGated, ...publicUrls])]
    .filter(isPagePath)
    .sort()
    .map((url) => ({ name: nameFromUrl(url), url, requiresAuth: authGated.has(url) }));

  return { pages, login };
}

/** Collect page paths from `goto`, `waitForURL`, and `toHaveURL` calls. */
function collectPageUrls(
  ast: t.File,
  out: Set<string>,
  consts: Map<string, string>,
  baseUrl: string | undefined,
): void {
  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const method = calleeMethod(path.node);
      if (method !== 'goto' && method !== 'waitForURL' && method !== 'toHaveURL') return;
      if (method === 'toHaveURL' && isNegatedAssertion(path.node)) return;
      const url = resolveUrlArg(path.node.arguments[0], consts, baseUrl);
      if (url) out.add(url);
    },
  });
}

/** True for `expect(...).not.toHaveURL(...)` - a negation we must not treat as a page. */
function isNegatedAssertion(node: t.CallExpression): boolean {
  const callee = node.callee;
  if (!t.isMemberExpression(callee)) return false;
  const obj = callee.object;
  return t.isMemberExpression(obj) && t.isIdentifier(obj.property) && obj.property.name === 'not';
}

/** Top-level `const X = 'string'` declarations, resolved to their string values. */
function collectStringConsts(ast: t.File): Map<string, string> {
  const consts = new Map<string, string>();
  for (const stmt of ast.program.body) {
    const decl = t.isExportNamedDeclaration(stmt) && stmt.declaration ? stmt.declaration : stmt;
    if (!t.isVariableDeclaration(decl) || decl.kind !== 'const') continue;
    for (const d of decl.declarations) {
      if (t.isIdentifier(d.id) && d.init) {
        const value = evalStringNode(d.init, consts);
        if (value !== undefined) consts.set(d.id.name, value);
      }
    }
  }
  return consts;
}

/**
 * Best-effort static evaluation of a string-valued expression: string literals,
 * no-substitution templates, known `const` identifiers, and the template
 * literals / `+` concatenations built from those. Returns undefined the moment
 * anything is dynamic (a function param, a call, an unknown identifier).
 */
function evalStringNode(
  node: t.Node | undefined | null,
  consts: Map<string, string>,
): string | undefined {
  if (!node) return undefined;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isIdentifier(node)) return consts.get(node.name);
  if (t.isTemplateLiteral(node)) {
    let out = '';
    for (let i = 0; i < node.quasis.length; i++) {
      out += node.quasis[i]?.value.cooked ?? node.quasis[i]?.value.raw ?? '';
      const expr = node.expressions[i];
      if (expr) {
        const value = evalStringNode(expr, consts);
        if (value === undefined) return undefined;
        out += value;
      }
    }
    return out;
  }
  if (t.isBinaryExpression(node) && node.operator === '+') {
    const left = evalStringNode(node.left, consts);
    const right = evalStringNode(node.right, consts);
    if (left === undefined || right === undefined) return undefined;
    return left + right;
  }
  return undefined;
}

/** Resolve a `goto`/`waitForURL`/`toHaveURL` argument to a same-origin path, or undefined. */
function resolveUrlArg(
  arg: t.Node | undefined,
  consts: Map<string, string>,
  baseUrl: string | undefined,
): string | undefined {
  if (!arg) return undefined;
  if (t.isRegExpLiteral(arg)) return normalizeToPath(arg.pattern.replace(/\\\//g, '/'), baseUrl);
  const value = evalStringNode(arg, consts);
  return value === undefined ? undefined : normalizeToPath(value, baseUrl);
}

/**
 * Normalise a URL/glob/regex token to a clean app path (`/dashboard`). Absolute
 * URLs are kept only when same-origin as `baseUrl` (external links dropped);
 * relative tokens and globs are stripped of wildcards, anchors, and queries.
 */
function normalizeToPath(raw: string, baseUrl: string | undefined): string | undefined {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    if (!baseUrl) return undefined;
    try {
      const u = new URL(s);
      const b = new URL(baseUrl);
      if (u.origin !== b.origin) return undefined;
      return urlToPath(u.pathname);
    } catch {
      return undefined;
    }
  }
  return urlToPath(s);
}

/** Strip leftover host, regex anchors, glob wildcards, query/hash, and trailing slash. */
function urlToPath(token: string): string | undefined {
  let s = token.trim();
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  s = s.replace(/^\^/, '').replace(/\$$/, '');
  s = s.replace(/^\*+/, '').replace(/\*+$/, '');
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/\/+$/, '');
  if (!s.startsWith('/')) s = `/${s}`;
  return /^\/[\w\-/]+$/.test(s) ? s : undefined;
}

/**
 * Find a login flow: scan each `beforeEach`/`beforeAll` callback and each
 * function named like `login`/`signIn` for the inline pattern of field fills +
 * a submit click (+ optional `waitForURL`). Returns the first that qualifies.
 */
function detectLogin(ast: t.File, source: string): DetectedLogin | null {
  let scopeNode: t.Node | null = null;
  let gotoUrl: string | undefined;
  let waitUrl: string | undefined;
  let click: string | undefined;
  let fills: DetectedFill[] = [];
  let found: DetectedLogin | null = null;

  traverse(ast, {
    'ArrowFunctionExpression|FunctionExpression|FunctionDeclaration': {
      enter(path: NodePath) {
        // Start at the first login-ish function; don't recurse into a nested one.
        if (found || scopeNode || !isLoginScope(path)) return;
        scopeNode = path.node;
        gotoUrl = undefined;
        waitUrl = undefined;
        click = undefined;
        fills = [];
      },
      exit(path: NodePath) {
        if (found || path.node !== scopeNode) return;
        if (fills.length > 0 && click) {
          found = {
            gotoUrl,
            fills,
            click,
            waitUrl,
            landingPath: waitUrl ? urlToPath(waitUrl) : undefined,
          };
        }
        scopeNode = null;
      },
    },
    CallExpression(path: NodePath<t.CallExpression>) {
      if (found || !scopeNode) return;
      const method = calleeMethod(path.node);
      if (method === 'goto' && gotoUrl === undefined) {
        gotoUrl = staticStringArg(path.node.arguments[0]);
      } else if (method === 'waitForURL' && waitUrl === undefined) {
        waitUrl = staticStringArg(path.node.arguments[0]);
      } else if (method === 'fill') {
        const sel = selectorSource(path.node, source);
        if (sel) fills.push({ selector: sel, kind: fieldKind(sel) });
      } else if (method === 'click' && click === undefined) {
        const sel = selectorSource(path.node, source);
        if (sel) click = sel;
      }
    },
  });

  return found;
}

/** A function is a login scope if it's a `beforeEach`/`beforeAll` callback or named login-ish. */
function isLoginScope(path: NodePath): boolean {
  const node = path.node;
  // Named function declaration: `async function login(...)`.
  if (t.isFunctionDeclaration(node) && node.id && isLoginName(node.id.name)) return true;

  const parent = path.parent;
  // `const login = async (...) => {}` / `login: async () => {}`.
  if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id) && isLoginName(parent.id.name)) {
    return true;
  }
  // `test.beforeEach(async () => {})` / `beforeEach(...)` / `beforeAll(...)`.
  if (t.isCallExpression(parent)) {
    const name = calleeName(parent.callee);
    if (name === 'beforeEach' || name === 'beforeAll' || name === 'before') return true;
  }
  return false;
}

function isLoginName(name: string): boolean {
  return /^(login|log\s*in|signin|sign\s*in|authenticate|auth|doLogin)$/i.test(name);
}

/**
 * For a `<selector>.fill(...)`/`<selector>.click()` call, return the
 * receiver-stripped source of the `<selector>` chain (e.g. `getByLabel('Email')`)
 * - but only when it's a recognisable locator call, so we don't lift a bare
 * variable from a page-object pattern.
 */
function selectorSource(node: t.CallExpression, source: string): string | undefined {
  if (!t.isMemberExpression(node.callee)) return undefined;
  const obj = node.callee.object;
  if (!t.isCallExpression(obj)) return undefined; // not an inline locator call
  if (!isLocatorChain(obj)) return undefined;
  const start = obj.start;
  const end = obj.end;
  if (start == null || end == null) return undefined;
  return stripReceiver(source.slice(start, end).trim());
}

/** True when a call chain ends in a Playwright locator method. */
function isLocatorChain(node: t.Node): boolean {
  if (!t.isCallExpression(node)) return false;
  const method = calleeMethod(node);
  const LOCATORS = new Set([
    'locator',
    'getByTestId',
    'getByRole',
    'getByText',
    'getByLabel',
    'getByPlaceholder',
    'getByTitle',
    'getByAltText',
    'first',
    'last',
    'nth',
    'filter',
  ]);
  if (method && LOCATORS.has(method)) return true;
  // Walk down a chain like page.getByRole(...).filter(...).
  if (t.isMemberExpression(node.callee) && t.isCallExpression(node.callee.object)) {
    return isLocatorChain(node.callee.object);
  }
  return false;
}

/** Strip a leading `page.` / `this.page.` / `p.` receiver so the chain re-roots on `p`. */
function stripReceiver(chain: string): string {
  return chain.replace(/^(?:this\.)?[A-Za-z_$][\w$]*\./, '');
}

function fieldKind(selector: string): DetectedFill['kind'] {
  if (/pass(word)?|pwd/i.test(selector)) return 'password';
  if (/e-?mail|user(name)?|login|phone|account/i.test(selector)) return 'user';
  return 'other';
}

/** The method name of a `obj.method(...)` call, or undefined. */
function calleeMethod(node: t.CallExpression): string | undefined {
  if (!t.isMemberExpression(node.callee)) return undefined;
  const prop = node.callee.property;
  if (t.isIdentifier(prop)) return prop.name;
  if (t.isStringLiteral(prop)) return prop.value;
  return undefined;
}

/** The bare callee name for `name(...)` or `obj.name(...)`. */
function calleeName(callee: t.Node): string | undefined {
  if (t.isIdentifier(callee)) return callee.name;
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) return callee.property.name;
  return undefined;
}

/** A string literal or no-substitution template literal argument. */
function staticStringArg(arg: t.Node | undefined): string | undefined {
  if (!arg) return undefined;
  if (t.isStringLiteral(arg)) return arg.value;
  if (t.isTemplateLiteral(arg) && arg.expressions.length === 0) {
    return arg.quasis[0]?.value.cooked ?? arg.quasis[0]?.value.raw;
  }
  return undefined;
}

/** Keep relative path navigations ('/dashboard'); drop the root and full/external URLs. */
function isPagePath(url: string): boolean {
  if (!url.startsWith('/')) return false; // skip full URLs and odd values
  if (url === '/') return false; // the base page is the default, not a configured page
  return true;
}

/** Derive a title-cased name from a path: '/user/profile' → 'User Profile'. */
function nameFromUrl(url: string): string {
  const words = url
    .replace(/^\/+|\/+$/g, '')
    .split(/[/\-_]+/)
    .filter(Boolean);
  if (words.length === 0) return 'Page';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
