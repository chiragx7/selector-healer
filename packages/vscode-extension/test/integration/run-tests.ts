import { execSync } from 'node:child_process';
/**
 * VS Code Integration Test Runner
 *
 * Downloads a VS Code instance, installs the extension, opens
 * the fixture workspace, and executes Mocha integration tests.
 *
 * NOTE: On Windows with OneDrive paths containing spaces, we use 8.3
 * short paths to work around @vscode/test-electron module resolution issues.
 */
import { resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Get the Windows 8.3 short path for a DIRECTORY to avoid space-in-path issues
 * with VS Code's extension host module resolution.
 */
function getShortPath(longPath: string): string {
  if (process.platform !== 'win32') return longPath;
  if (!longPath.includes(' ')) return longPath;

  try {
    const cmd = `powershell -Command "(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longPath}').ShortPath"`;
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return longPath;
  }
}

async function main() {
  // __dirname at runtime is test/integration/out/ - go up 3 levels to extension root
  const extensionDir = resolve(__dirname, '../../../');
  const extensionDevelopmentPath = getShortPath(extensionDir);

  // Build ALL paths relative to the short extension path (no spaces)
  const extensionTestsPath = resolve(extensionDevelopmentPath, 'test/integration/out/suite/index');
  const testWorkspace = resolve(extensionDevelopmentPath, 'test/integration/fixture');

  console.log('Extension path:', extensionDevelopmentPath);
  console.log('Tests path:', extensionTestsPath);
  console.log('Workspace:', testWorkspace);

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [testWorkspace, '--disable-extensions', '--disable-gpu'],
    });
  } catch (err) {
    console.error('Failed to run integration tests:', err);
    process.exit(1);
  }
}

main();
