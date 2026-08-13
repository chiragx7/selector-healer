import type { ProjectDetection } from './detect.js';

export interface GeneratedConfig {
  /** Filename to write, relative to the project root. */
  filename: string;
  /** Full file contents. */
  content: string;
}

/** Single-quote-safe embedding of a detected string value. */
function q(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Backtick-safe embedding of a detected value inside a template literal. */
function qt(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, () => '\\$');
}

/**
 * Render a ready-to-use Selector Healer config from a detection result.
 *
 * The file format follows the project: a TypeScript project (a `tsconfig.json`
 * or a `.ts` framework config) gets a typed `.ts` config; everything else gets
 * a `.cjs` config that loads with zero TypeScript tooling. When the deep scan
 * found pages the tests visit, `pages[]` is pre-filled - with a login hook
 * lifted from the tests if one was recognised (credentials read from
 * `process.env`, never hardcoded, and flagged for review). Otherwise a
 * commented example is left as a template.
 *
 * @param detection - the result of {@link detectProjectConfig}
 * @returns the filename to write and its contents
 *
 * @example
 * const { filename, content } = renderConfigFile(detectProjectConfig(cwd));
 * writeFileSync(filename, content);
 */
export function renderConfigFile(detection: ProjectDetection): GeneratedConfig {
  return detection.usesTypeScript ? renderTs(detection) : renderCjs(detection);
}

/** The detected top-level fields, shared by both file formats. */
function fieldLines(detection: ProjectDetection): string {
  const frameworkTodo =
    detection.frameworkConfidence === 'default'
      ? " // TODO: set to 'playwright' | 'cypress' | 'webdriverio' | 'testcafe'"
      : '';
  const baseUrlTodo = detection.baseUrlConfident ? '' : " // TODO: set your app's base URL";
  const testDirTodo = detection.testDirConfident ? '' : ' // TODO: point this at your test files';

  return [
    `  framework: '${q(detection.framework)}',${frameworkTodo}`,
    `  testDir: '${q(detection.testDir)}',${testDirTodo}`,
    `  testGlob: '${q(detection.testGlob)}',`,
    `  baseUrl: '${q(detection.baseUrl)}',${baseUrlTodo}`,
    '  headless: true,',
    '  timeout: 30_000,',
  ].join('\n');
}

/**
 * A commented-out auth example (no active credentials). Shown when the deep
 * scan couldn't infer real pages, so the user still has a template to adapt.
 */
function commentedPagesExample(detection: ProjectDetection): string {
  return [
    '',
    '  // Screens behind login (or that only appear after an interaction) need a',
    '  // setup hook so Selector Healer can reach them. Uncomment and adapt.',
    '  // SECURITY: never hardcode credentials - read them from environment variables.',
    '  // pages: [',
    '  //   {',
    "  //     name: 'Dashboard (after login)',",
    "  //     url: '/dashboard',",
    '  //     setup: async (page) => {',
    `  //       await page.goto(process.env.BASE_URL ?? '${q(detection.baseUrl)}');`,
    "  //       await page.getByLabel('Email').fill(process.env.TEST_USER ?? '');",
    "  //       await page.getByLabel('Password').fill(process.env.TEST_PASS ?? '');",
    "  //       await page.getByRole('button', { name: 'Log in' }).click();",
    "  //       await page.waitForURL('**/dashboard');",
    '  //     },',
    '  //   },',
    '  // ],',
  ].join('\n');
}

// ── deep config: real pages[] + login helpers, lifted from the test scan ─────

function baseNoSlash(detection: ProjectDetection): string {
  return detection.baseUrl.replace(/\/$/, '');
}

/** Join a base URL and a path/URL into a full, absolute URL. */
function fullUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

/** True when a detected login is actually used by at least one auth-gated page. */
function loginIsUsed(detection: ProjectDetection): boolean {
  return detection.login !== undefined && detection.pages.some((pg) => pg.requiresAuth !== false);
}

/** The `pages: [...]` block of real entries, or null when the scan found none. */
function pagesArray(detection: ProjectDetection): string | null {
  if (detection.pages.length === 0) return null;
  const hasLogin = loginIsUsed(detection);
  const entries = detection.pages.map((pg) => {
    // Only pages reached from behind login get a setup hook; public pages stay bare.
    const setup =
      hasLogin && pg.requiresAuth !== false
        ? `, setup: (page) => loginAndGoto(page, '${q(pg.url)}')`
        : '';
    return `    { name: '${q(pg.name)}', url: '${q(pg.url)}'${setup} },`;
  });
  return ['  pages: [', ...entries, '  ],'].join('\n');
}

/** Top-level `login` + `loginAndGoto` helpers, lifted from the detected flow. */
function loginHelpers(detection: ProjectDetection, ts: boolean): string {
  const login = detection.login;
  if (!login || !loginIsUsed(detection)) return '';

  const base = baseNoSlash(detection);
  const recv = ts ? 'p' : 'page';
  const param = ts ? 'page: unknown' : 'page';
  const ret = ts ? ': Promise<void>' : '';
  const cast = ts ? `\n  const p = page as import('${detection.playwrightImport}').Page;` : '';

  const steps = [`  await ${recv}.goto('${q(fullUrl(base, login.gotoUrl ?? '/'))}');`];
  for (const f of login.fills) {
    const envVar =
      f.kind === 'password' ? 'TEST_PASS' : f.kind === 'user' ? 'TEST_USER' : 'TEST_VALUE';
    steps.push(`  await ${recv}.${f.selector}.fill(process.env.${envVar} ?? '');`);
  }
  if (login.click) steps.push(`  await ${recv}.${login.click}.click();`);
  if (login.waitUrl) steps.push(`  await ${recv}.waitForURL('${q(login.waitUrl)}');`);

  // After login() the session already lands on `landingPath`; skip the redundant
  // re-navigation when loginAndGoto is asked for that same page.
  const navigate = `await ${recv}.goto(\`${qt(base)}\${path}\`);`;
  const gotoLine = login.landingPath
    ? `  if (path !== '${q(login.landingPath)}') ${navigate}`
    : `  ${navigate}`;

  // In a .ts config, `process` would need @types/node to type-check. Declare it
  // locally (ambient - erased at runtime) so the config is clean in any project,
  // whether or not @types/node is installed. (.cjs configs aren't type-checked.)
  const processShim = ts
    ? [
        '// `process` is typed locally so this config type-checks without @types/node.',
        'declare const process: { env: Record<string, string | undefined> };',
        '',
      ]
    : [];

  return [
    ...processShim,
    '// ⚠️  Generated from your tests - review before relying on it. Credentials come',
    '// from environment variables (set TEST_USER / TEST_PASS); never hardcode them.',
    `async function login(${param})${ret} {${cast}`,
    ...steps,
    '}',
    '',
    `async function loginAndGoto(${param}, path${ts ? ': string' : ''})${ret} {${cast}`,
    `  await login(${recv});`,
    gotoLine,
    '}',
    '',
  ].join('\n');
}

function renderCjs(detection: ProjectDetection): GeneratedConfig {
  const pages = pagesArray(detection) ?? commentedPagesExample(detection);
  const preamble = loginHelpers(detection, false);
  const content = `${preamble ? `${preamble}\n` : ''}/**\n * Selector Healer configuration - generated by \`selector-healer init\`.\n * Review the values below; any field with a trailing note was inferred.\n * @type {import('@selector-healer/core').HealerConfig}\n */\nmodule.exports = {\n${fieldLines(detection)}\n${pages}\n};\n`;
  return { filename: 'selector-healer.config.cjs', content };
}

function renderTs(detection: ProjectDetection): GeneratedConfig {
  const pages = pagesArray(detection) ?? commentedPagesExample(detection);
  const preamble = loginHelpers(detection, true);
  const content = `import type { HealerConfig } from '@selector-healer/core';\n\n${preamble ? `${preamble}\n` : ''}/**\n * Selector Healer configuration - generated by \`selector-healer init\`.\n * Review the values below; any field with a trailing note was inferred.\n */\nexport default {\n${fieldLines(detection)}\n${pages}\n} satisfies HealerConfig;\n`;
  return { filename: 'selector-healer.config.ts', content };
}
