import * as babelParser from '@babel/parser';
import { parse, print } from 'recast';

interface FixEntry {
  line: number;
  replacementCode: string;
}

export function applyFix(source: string, fixes: FixEntry[]): string {
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

  return print(ast, { tabWidth: 2 }).code;
}
