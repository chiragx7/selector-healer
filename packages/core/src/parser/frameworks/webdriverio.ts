import type { ParseResult } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { logger } from '../../logger.js';
import type { SelectorType, SelectorUsage } from '../../types.js';
import { makeSelectorId } from '../selector-id.js';

const traverse =
  typeof _traverse === 'function'
    ? _traverse
    : (_traverse as unknown as { default: typeof _traverse }).default;

/**
 * Extract selector usages from a WebdriverIO test file AST.
 *
 * WebdriverIO patterns:
 * - `$('.selector')` / `$$('.selector')` - CSS
 * - `$('//xpath')` - XPath
 * - `$('aria/label')` - ARIA selector
 * - `$('[data-testid="..."]')` - test ID via attribute
 * - `browser.$('.selector')` - explicit browser prefix
 * - `element.$('.child')` - chained
 *
 * @param ast - Parsed Babel AST.
 * @param filePath - Absolute path to the source file.
 * @returns Array of extracted selector usages for WebdriverIO.
 *
 * @example
 * ```ts
 * const selectors = extractWebdriverIOSelectors(ast, '/repo/test/specs/login.e2e.ts');
 * ```
 */
export function extractWebdriverIOSelectors(
  ast: ParseResult<t.File>,
  filePath: string,
): SelectorUsage[] {
  const results: SelectorUsage[] = [];
  const contextStack: (string | undefined)[] = [undefined];

  traverse(ast, {
    'ArrowFunctionExpression|FunctionExpression': {
      enter() {
        contextStack.push(contextStack[contextStack.length - 1]);
      },
      exit() {
        contextStack.pop();
      },
    },

    CallExpression(path: NodePath<t.CallExpression>) {
      const { node } = path;

      // Handle browser.url('/path') for context tracking
      if (t.isMemberExpression(node.callee)) {
        const property = node.callee.property;
        if (t.isIdentifier(property, { name: 'url' }) && isBrowserObject(node.callee.object)) {
          const arg = node.arguments[0];
          if (arg && t.isStringLiteral(arg)) {
            contextStack[contextStack.length - 1] = arg.value;
          }
          return;
        }
      }

      // Direct $() / $$() calls (global imports from @wdio/globals)
      if (t.isIdentifier(node.callee)) {
        const name = node.callee.name;
        if (name === '$' || name === '$$') {
          extractWdioSelector(node, filePath, results, contextStack);
          return;
        }
      }

      // browser.$() / browser.$$() / element.$() / element.$$()
      if (t.isMemberExpression(node.callee)) {
        const property = node.callee.property;
        if (t.isIdentifier(property) && (property.name === '$' || property.name === '$$')) {
          extractWdioSelector(node, filePath, results, contextStack);
        }
      }
    },
  });

  results.sort((a, b) => a.line - b.line || a.column - b.column);
  return results;
}

function extractWdioSelector(
  node: t.CallExpression,
  filePath: string,
  results: SelectorUsage[],
  contextStack: (string | undefined)[],
): void {
  const arg = node.arguments[0];
  if (!arg) return;

  let rawValue: string | undefined;

  if (t.isStringLiteral(arg)) {
    rawValue = arg.value;
  } else if (t.isTemplateLiteral(arg) && arg.expressions.length === 0) {
    rawValue = arg.quasis[0]?.value.cooked ?? arg.quasis[0]?.value.raw;
  } else {
    logger.warn({ filePath, line: node.loc?.start.line }, 'Skipping dynamic WebdriverIO selector');
    return;
  }

  if (rawValue === undefined) return;

  const selectorType = classifyWdioSelector(rawValue);
  const line = arg.loc?.start.line ?? node.loc?.start.line ?? 0;
  const column = (arg.loc?.start.column ?? node.loc?.start.column ?? 0) + 1;

  results.push({
    id: makeSelectorId(filePath, line, rawValue),
    filePath,
    line,
    column,
    selectorType,
    rawValue,
    framework: 'webdriverio',
    ...(contextStack[contextStack.length - 1] !== undefined
      ? { contextHint: contextStack[contextStack.length - 1] }
      : {}),
  });
}

/**
 * Classify a WebdriverIO selector string into our canonical SelectorType.
 *
 * @param selector - The raw selector string from the test code.
 * @returns The classified selector type.
 */
function classifyWdioSelector(selector: string): SelectorType {
  if (selector.startsWith('//') || selector.startsWith('./')) return 'xpath';
  if (selector.startsWith('aria/')) return 'role';
  if (selector.startsWith('[data-testid=') || selector.startsWith('[data-test-id=')) {
    return 'testid';
  }
  if (selector.startsWith('[role=')) return 'role';
  if (selector.startsWith('[aria-label=')) return 'label';
  if (selector.startsWith('[placeholder=')) return 'placeholder';
  if (selector.startsWith('[title=')) return 'title';
  if (selector.startsWith('[alt=')) return 'alt';
  return 'css';
}

/** Check if an AST node is the `browser` object. */
function isBrowserObject(node: t.Node): boolean {
  return t.isIdentifier(node, { name: 'browser' });
}
