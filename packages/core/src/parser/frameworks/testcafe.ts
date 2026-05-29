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
 * Extract selector usages from a TestCafe test file AST.
 *
 * TestCafe patterns:
 * - `Selector('.css')` — CSS selector
 * - `Selector('#id')` — CSS id
 * - `Selector('[data-testid="..."]')` — test ID
 * - `Selector('button').withText('Submit')` — text matching (captured as CSS + text)
 * - `Selector('input').withAttribute('name', 'email')` — attribute matching
 * - `t.navigateTo('/url')` — context tracking
 *
 * @param ast - Parsed Babel AST.
 * @param filePath - Absolute path to the source file.
 * @returns Array of extracted selector usages for TestCafe.
 *
 * @example
 * ```ts
 * const selectors = extractTestCafeSelectors(ast, '/repo/tests/login.testcafe.ts');
 * ```
 */
export function extractTestCafeSelectors(
  ast: ParseResult<t.File>,
  filePath: string,
): SelectorUsage[] {
  const results: SelectorUsage[] = [];
  const contextStack: (string | undefined)[] = [undefined];
  // Deferred withText annotations — applied after full traversal
  const withTextAnnotations: Array<{ selectorLine: number; text: string }> = [];

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

      // t.navigateTo('/url') — context tracking
      if (t.isMemberExpression(node.callee)) {
        const property = node.callee.property;
        if (t.isIdentifier(property, { name: 'navigateTo' })) {
          const arg = node.arguments[0];
          if (arg && t.isStringLiteral(arg)) {
            contextStack[contextStack.length - 1] = arg.value;
          }
          return;
        }
      }

      // Selector('...') — direct call
      if (t.isIdentifier(node.callee, { name: 'Selector' })) {
        extractTestCafeSelector(node, filePath, results, contextStack);
        return;
      }

      // Chained: Selector('...').withText('...') / .withExactText('...')
      // Collect text annotation — applied after traversal since inner Selector()
      // may not have been visited yet (outer CallExpression visits first).
      if (t.isMemberExpression(node.callee)) {
        const property = node.callee.property;
        if (
          t.isIdentifier(property) &&
          (property.name === 'withText' || property.name === 'withExactText')
        ) {
          const textArg = node.arguments[0];
          if (textArg && t.isStringLiteral(textArg)) {
            // Find the line of the inner Selector() call
            const innerCall = findInnerSelectorCall(node.callee.object);
            if (innerCall) {
              const selectorLine =
                innerCall.arguments[0]?.loc?.start.line ?? innerCall.loc?.start.line ?? 0;
              withTextAnnotations.push({ selectorLine, text: textArg.value });
            }
          }
        }
      }
    },
  });

  // Apply deferred withText annotations
  for (const annotation of withTextAnnotations) {
    const target = results.find(
      (r) =>
        r.filePath === filePath && r.framework === 'testcafe' && r.line === annotation.selectorLine,
    );
    if (target) {
      target.options = { ...target.options, withText: annotation.text };
    }
  }

  results.sort((a, b) => a.line - b.line || a.column - b.column);
  return results;
}

function extractTestCafeSelector(
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
    logger.warn({ filePath, line: node.loc?.start.line }, 'Skipping dynamic TestCafe selector');
    return;
  }

  if (rawValue === undefined) return;

  const selectorType = classifyTestCafeSelector(rawValue);
  const line = arg.loc?.start.line ?? node.loc?.start.line ?? 0;
  const column = (arg.loc?.start.column ?? node.loc?.start.column ?? 0) + 1;

  results.push({
    id: makeSelectorId(filePath, line, rawValue),
    filePath,
    line,
    column,
    selectorType,
    rawValue,
    framework: 'testcafe',
    ...(contextStack[contextStack.length - 1] !== undefined
      ? { contextHint: contextStack[contextStack.length - 1] }
      : {}),
  });
}

/**
 * Walk up a chained MemberExpression to find the inner `Selector()` call.
 * E.g. `Selector('button').withText('Submit')` — returns the `Selector('button')` node.
 */
function findInnerSelectorCall(node: t.Node): t.CallExpression | undefined {
  if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: 'Selector' })) {
    return node;
  }
  // Handle deeper chains: Selector(...).filter(...).withText(...)
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
    return findInnerSelectorCall(node.callee.object);
  }
  return undefined;
}

function classifyTestCafeSelector(selector: string): SelectorType {
  if (selector.startsWith('[data-testid=') || selector.startsWith('[data-test-id=')) {
    return 'testid';
  }
  if (selector.startsWith('//') || selector.startsWith('./')) return 'xpath';
  if (selector.startsWith('[role=')) return 'role';
  if (selector.startsWith('[aria-label=')) return 'label';
  if (selector.startsWith('[placeholder=')) return 'placeholder';
  return 'css';
}
