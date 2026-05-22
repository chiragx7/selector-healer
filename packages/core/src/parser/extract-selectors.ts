import type { ParseResult } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { logger } from '../logger.js';
import type { SelectorType, SelectorUsage } from '../types.js';
import { makeSelectorId } from './selector-id.js';

// CJS/ESM interop — @babel/traverse ships CJS; under NodeNext the default
// import may be the namespace object wrapping { default: fn } instead of fn.
const traverse =
  typeof _traverse === 'function'
    ? _traverse
    : (_traverse as unknown as { default: typeof _traverse }).default;

const SELECTOR_METHODS: ReadonlyMap<string, SelectorType> = new Map([
  ['locator', 'css'],
  ['getByTestId', 'testid'],
  ['getByRole', 'role'],
  ['getByText', 'text'],
  ['getByLabel', 'label'],
  ['getByPlaceholder', 'placeholder'],
  ['getByTitle', 'title'],
  ['getByAltText', 'alt'],
  ['$', 'css'],
  ['$$', 'css'],
]);

/**
 * Walk a Babel AST and extract every Playwright selector call.
 *
 * @param ast - Parsed Babel AST from `@babel/parser`.
 * @param filePath - Absolute path to the source file (used in IDs and diagnostics).
 * @returns Array of extracted selector usages, ordered by source position.
 *
 * @example
 * ```ts
 * import { parse } from '@babel/parser';
 * const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
 * const selectors = extractSelectors(ast, '/path/to/file.spec.ts');
 * ```
 */
export function extractSelectors(ast: ParseResult<t.File>, filePath: string): SelectorUsage[] {
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
      if (!t.isIdentifier(property) && !t.isStringLiteral(property)) return;

      const methodName = t.isIdentifier(property) ? property.name : property.value;

      if (methodName === 'goto') {
        const arg = node.arguments[0];
        if (arg && t.isStringLiteral(arg)) {
          contextStack[contextStack.length - 1] = arg.value;
        }
        return;
      }

      const baseSelectorType = SELECTOR_METHODS.get(methodName);
      if (baseSelectorType === undefined) return;

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
        logger.warn(
          { filePath, line: node.loc?.start.line },
          'Skipping dynamic selector (template literal with expressions or computed value)',
        );
        return;
      }

      if (rawValue === undefined) return;

      let selectorType = baseSelectorType;
      if (
        (methodName === 'locator' || methodName === '$' || methodName === '$$') &&
        rawValue.startsWith('//')
      ) {
        selectorType = 'xpath';
      }

      let options: Record<string, unknown> | undefined;
      if (node.arguments.length > 1) {
        const optionsArg = node.arguments[1];
        if (optionsArg && t.isObjectExpression(optionsArg)) {
          options = extractObjectLiteral(optionsArg);
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
        ...(options !== undefined && Object.keys(options).length > 0 ? { options } : {}),
        ...(contextStack[contextStack.length - 1] !== undefined
          ? { contextHint: contextStack[contextStack.length - 1] }
          : {}),
      });
    },
  });

  results.sort((a, b) => a.line - b.line || a.column - b.column);
  return results;
}

function extractObjectLiteral(node: t.ObjectExpression): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (!t.isObjectProperty(prop)) continue;
    const key = t.isIdentifier(prop.key)
      ? prop.key.name
      : t.isStringLiteral(prop.key)
        ? prop.key.value
        : undefined;
    if (key === undefined) continue;
    const value = extractLiteralValue(prop.value);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function extractLiteralValue(node: t.Expression | t.PatternLike): unknown {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isObjectExpression(node)) return extractObjectLiteral(node);
  if (t.isRegExpLiteral(node)) return `/${node.pattern}/${node.flags}`;
  return undefined;
}
