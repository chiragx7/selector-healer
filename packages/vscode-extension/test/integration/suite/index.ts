import { readdirSync } from 'node:fs';
/**
 * Mocha test suite entry point for VS Code integration tests.
 * VS Code's test-electron framework calls this to discover and run tests.
 *
 * NOTE: We require mocha using an absolute path because VS Code's extension
 * host resolves modules from its own directory, not ours.
 */
import { resolve } from 'node:path';

export function run(): Promise<void> {
  // Resolve mocha from OUR node_modules (absolute path)
  const mochaPath = resolve(__dirname, '../../../../node_modules/mocha');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Mocha = require(mochaPath);

  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 30_000,
  });

  const testsRoot = resolve(__dirname);

  // Find all .test.js files in the suite directory
  const testFiles = readdirSync(testsRoot).filter((f: string) => f.endsWith('.test.js'));

  for (const file of testFiles) {
    mocha.addFile(resolve(testsRoot, file));
  }

  return new Promise<void>((resolvePromise, reject) => {
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolvePromise();
        }
      });
    } catch (err) {
      console.error('Mocha run error:', err);
      reject(err);
    }
  });
}
