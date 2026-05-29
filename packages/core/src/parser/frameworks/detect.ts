import type { ParseResult } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Framework } from '../../types.js';

// CJS/ESM interop
const traverse =
  typeof _traverse === 'function'
    ? _traverse
    : (_traverse as unknown as { default: typeof _traverse }).default;

/**
 * Auto-detect which test framework a file belongs to by inspecting import
 * declarations and require calls.
 *
 * @param ast - Parsed Babel AST.
 * @returns Detected framework, or `'playwright'` as default fallback.
 *
 * @example
 * ```ts
 * const framework = detectFramework(ast);
 * // 'cypress' | 'webdriverio' | 'testcafe' | 'playwright'
 * ```
 */
export function detectFramework(ast: ParseResult<t.File>): Framework {
  let detected: Framework = 'playwright';

  traverse(ast, {
    ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
      if (detected !== 'playwright') return;
      const source = path.node.source.value;
      if (isCypressImport(source)) {
        detected = 'cypress';
      } else if (isWebdriverIOImport(source)) {
        detected = 'webdriverio';
      } else if (isTestCafeImport(source)) {
        detected = 'testcafe';
      }
    },
    CallExpression(path: NodePath<t.CallExpression>) {
      if (detected !== 'playwright') return;
      const { node } = path;
      if (
        t.isIdentifier(node.callee, { name: 'require' }) &&
        node.arguments.length > 0 &&
        t.isStringLiteral(node.arguments[0])
      ) {
        const source = node.arguments[0].value;
        if (isCypressImport(source)) {
          detected = 'cypress';
        } else if (isWebdriverIOImport(source)) {
          detected = 'webdriverio';
        } else if (isTestCafeImport(source)) {
          detected = 'testcafe';
        }
      }
    },
  });

  return detected;
}

/**
 * Detect framework from file path patterns when AST detection is unavailable.
 *
 * @param filePath - Absolute or relative path to the test file.
 * @returns Detected framework based on file naming conventions.
 *
 * @example
 * ```ts
 * detectFrameworkFromPath('tests/login.cy.ts'); // 'cypress'
 * ```
 */
export function detectFrameworkFromPath(filePath: string): Framework {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();

  if (normalized.includes('.cy.') || normalized.includes('/cypress/')) {
    return 'cypress';
  }
  if (normalized.includes('.wdio.') || normalized.includes('/wdio/')) {
    return 'webdriverio';
  }
  if (normalized.includes('.testcafe.') || normalized.includes('/testcafe/')) {
    return 'testcafe';
  }
  return 'playwright';
}

function isCypressImport(source: string): boolean {
  return source === 'cypress' || source.startsWith('cypress/');
}

function isWebdriverIOImport(source: string): boolean {
  return (
    source === 'webdriverio' ||
    source === '@wdio/globals' ||
    source.startsWith('webdriverio/') ||
    source.startsWith('@wdio/')
  );
}

function isTestCafeImport(source: string): boolean {
  return source === 'testcafe';
}
