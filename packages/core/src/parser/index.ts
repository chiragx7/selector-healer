import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';
import fg from 'fast-glob';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { Framework, SelectorUsage } from '../types.js';
import { extractSelectors, extractSelectorsMultiFramework } from './extract-selectors.js';
import { detectFrameworkFromPath } from './frameworks/detect.js';

/**
 * Error produced by the parser when a test file cannot be read or parsed.
 */
export interface ParseError {
  type: 'file-not-found' | 'parse-error' | 'glob-error';
  filePath: string;
  message: string;
}

/**
 * Aggregate result from scanning a directory of test files.
 * Partial success is normal — some files may fail to parse while others succeed.
 */
export interface DirectoryParseResult {
  selectors: SelectorUsage[];
  errors: ParseError[];
}

const DEFAULT_GLOB = '**/*.{spec,test}.{ts,tsx,js,jsx}';

/**
 * Parse a single test file and extract every selector usage.
 * Supports Playwright, Cypress, WebdriverIO, and TestCafe via auto-detection
 * or explicit framework override.
 *
 * @param filePath - Absolute or relative path to the test file.
 * @param framework - Explicit framework override. Auto-detected if omitted.
 * @returns `Ok` with extracted selectors, or `Err` if the file cannot be read or parsed.
 *
 * @example
 * ```ts
 * const result = parseTestFile('/repo/tests/login.spec.ts');
 * if (result.isOk()) {
 *   console.log(`Found ${result.value.length} selectors`);
 * }
 * ```
 */
export function parseTestFile(
  filePath: string,
  framework?: Framework,
): Result<SelectorUsage[], ParseError> {
  const absPath = resolve(filePath);

  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return err({
      type: 'file-not-found',
      filePath: absPath,
      message: `Cannot read file: ${absPath}`,
    });
  }

  try {
    const ast = parse(content, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      ranges: false,
    });

    // Use framework override → AST detection → path-based fallback
    const effectiveFramework = framework ?? detectFrameworkFromPath(absPath);
    const selectors =
      effectiveFramework === 'playwright'
        ? extractSelectors(ast, absPath)
        : extractSelectorsMultiFramework(ast, absPath, effectiveFramework);

    return ok(selectors);
  } catch (e) {
    return err({
      type: 'parse-error',
      filePath: absPath,
      message: `Babel parse error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/**
 * Scan a directory for test files and extract all selector usages.
 * Supports Playwright, Cypress, WebdriverIO, and TestCafe via auto-detection
 * or explicit framework override.
 *
 * @param dir - Root directory to scan.
 * @param glob - Glob pattern for test files. Defaults to `**\/*.{spec,test}.{ts,tsx,js,jsx}`.
 * @param framework - Explicit framework override. Auto-detected per file if omitted.
 * @returns `Ok` with selectors and per-file errors, or `Err` if the glob itself fails.
 *
 * @example
 * ```ts
 * const result = parseDirectory('./tests');
 * if (result.isOk()) {
 *   const { selectors, errors } = result.value;
 *   console.log(`Found ${selectors.length} selectors, ${errors.length} file errors`);
 * }
 * ```
 */
export function parseDirectory(
  dir: string,
  glob?: string,
  framework?: Framework,
): Result<DirectoryParseResult, ParseError> {
  const pattern = glob ?? DEFAULT_GLOB;
  const absDir = resolve(dir);

  let files: string[];
  try {
    files = fg.sync(pattern, { cwd: absDir, absolute: true });
  } catch (e) {
    return err({
      type: 'glob-error',
      filePath: absDir,
      message: `Glob failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const selectors: SelectorUsage[] = [];
  const errors: ParseError[] = [];

  for (const file of files) {
    const result = parseTestFile(file, framework);
    if (result.isOk()) {
      selectors.push(...result.value);
    } else {
      errors.push(result.error);
    }
  }

  return ok({ selectors, errors });
}
