import * as babelParser from '@babel/parser';
import { parse, print, types } from 'recast';

const { visit } = types;

export interface FixEntry {
  line: number;
  column: number;
  rawValue: string;
  replacementCode: string;
}

/**
 * Apply selector replacements to a test file's source code using AST rewriting.
 * Preserves formatting and comments in untouched regions via recast.
 */
export function applyFixesToSource(source: string, fixes: FixEntry[]): string {
  if (fixes.length === 0) return source;

  const ast = parse(source, {
    parser: {
      parse(code: string) {
        return babelParser.parse(code, {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'],
          tokens: true,
        });
      },
    },
  });

  const pending = new Map<string, FixEntry>();
  for (const f of fixes) {
    pending.set(`${f.line}:${f.rawValue}`, f);
  }

  visit(ast, {
    visitCallExpression(path) {
      if (pending.size === 0) return false;

      const node = path.node;
      const fix = findMatchingFix(node, pending);
      if (!fix) {
        this.traverse(path);
        return undefined;
      }

      const replacement = parseReplacement(fix.replacementCode);
      if (!replacement) {
        this.traverse(path);
        return undefined;
      }

      if (
        node.callee.type === 'MemberExpression' &&
        replacement.callee.type === 'MemberExpression'
      ) {
        node.callee.property = replacement.callee.property;
      }
      node.arguments = replacement.arguments;

      this.traverse(path);
      return undefined;
    },
  });

  return print(ast, { tabWidth: 2 }).code;
}

// biome-ignore lint/suspicious/noExplicitAny: recast AST nodes are untyped
function findMatchingFix(node: any, pending: Map<string, FixEntry>): FixEntry | undefined {
  for (const arg of node.arguments ?? []) {
    if (!arg.loc || arg.type !== 'StringLiteral') continue;

    const key = `${arg.loc.start.line}:${arg.value}`;
    const fix = pending.get(key);
    if (fix) {
      pending.delete(key);
      return fix;
    }
  }
  return undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: recast AST nodes are untyped
function parseReplacement(code: string): any | undefined {
  try {
    const wrapper = `_page_.${code}`;
    const ast = parse(wrapper, {
      parser: {
        parse(src: string) {
          return babelParser.parse(src, {
            sourceType: 'module',
            plugins: ['typescript'],
          });
        },
      },
    });
    const stmt = ast.program.body[0];
    if (stmt?.type === 'ExpressionStatement' && stmt.expression.type === 'CallExpression') {
      return stmt.expression;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
