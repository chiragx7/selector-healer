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
 * Cypress selector method → SelectorType mapping.
 *
 * Cypress uses `cy.get()` for CSS, `cy.contains()` for text,
 * and `cy.get('[data-testid="..."]')` for test IDs (detected via attribute pattern).
 */
const CYPRESS_METHODS: ReadonlyMap<string, SelectorType> = new Map([
  ['get', 'css'],
  ['find', 'css'],
  ['contains', 'text'],
]);

/**
 * Extract selector usages from a Cypress test file AST.
 *
 * @param ast - Parsed Babel AST.
 * @param filePath - Absolute path to the source file.
 * @returns Array of extracted selector usages for Cypress.
 *
 * @example
 * ```ts
 * const selectors = extractCypressSelectors(ast, '/repo/cypress/e2e/login.cy.ts');
 * ```
 */
export function extractCypressSelectors(
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
      if (!t.isMemberExpression(node.callee)) return;

      const property = node.callee.property;
      if (!t.isIdentifier(property)) return;

      const methodName = property.name;
      const object = node.callee.object;

      // cy.visit('/url') → context tracking
      if (methodName === 'visit' && isCyObject(object)) {
        const arg = node.arguments[0];
        if (arg && t.isStringLiteral(arg)) {
          contextStack[contextStack.length - 1] = arg.value;
        }
        return;
      }

      // Must be cy.get / cy.find / cy.contains or chained .find
      const baseSelectorType = CYPRESS_METHODS.get(methodName);
      if (baseSelectorType === undefined) return;

      // Validate it's called on `cy` or is a chained call
      if (methodName !== 'find' && !isCyObject(object)) return;

      const arg = node.arguments[0];
      if (!arg) return;

      let rawValue: string | undefined;

      if (t.isStringLiteral(arg)) {
        rawValue = arg.value;
      } else if (t.isTemplateLiteral(arg) && arg.expressions.length === 0) {
        rawValue = arg.quasis[0]?.value.cooked ?? arg.quasis[0]?.value.raw;
      } else if (t.isRegExpLiteral(arg)) {
        rawValue = `/${arg.pattern}/${arg.flags}`;
      } else {
        logger.warn({ filePath, line: node.loc?.start.line }, 'Skipping dynamic Cypress selector');
        return;
      }

      if (rawValue === undefined) return;

      // Refine selector type based on content
      let selectorType = baseSelectorType;
      if (methodName === 'get' || methodName === 'find') {
        if (rawValue.startsWith('[data-testid=') || rawValue.startsWith('[data-test-id=')) {
          selectorType = 'testid';
        } else if (rawValue.startsWith('//')) {
          selectorType = 'xpath';
        }
      }

      const line = arg.loc?.start.line ?? node.loc?.start.line ?? 0;
      const column = (arg.loc?.start.column ?? node.loc?.start.column ?? 0) + 1;

      results.push({
        id: makeSelectorId(filePath, line, rawValue),
        filePath,
        line,
        column,
        selectorType,
        rawValue,
        framework: 'cypress',
        ...(contextStack[contextStack.length - 1] !== undefined
          ? { contextHint: contextStack[contextStack.length - 1] }
          : {}),
      });
    },
  });

  results.sort((a, b) => a.line - b.line || a.column - b.column);
  return results;
}

/** Check if an AST node is the `cy` global object. */
function isCyObject(node: t.Node): boolean {
  return t.isIdentifier(node, { name: 'cy' });
}
