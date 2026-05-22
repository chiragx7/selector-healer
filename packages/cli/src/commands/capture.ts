import { captureFingerprints, parseDirectory } from '@selector-healer/core';
import type { HealerConfig } from '@selector-healer/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import { formatCaptureResult } from '../format.js';

export function registerCapture(program: Command): void {
  program
    .command('capture')
    .description('Capture DOM fingerprints for all selectors in test files')
    .option('-v, --verbose', 'Verbose output')
    .action(async (opts: { verbose?: boolean }) => {
      const cwd = process.cwd();

      let config: HealerConfig;
      try {
        config = await loadConfig(cwd);
      } catch (e) {
        process.stderr.write(`${pc.red('Error:')} ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
        return;
      }

      const parseResult = parseDirectory(config.testDir, config.testGlob);
      if (parseResult.isErr()) {
        process.stderr.write(`${pc.red('Parse error:')} ${parseResult.error.message}\n`);
        process.exitCode = 1;
        return;
      }

      const { selectors, errors: parseErrors } = parseResult.value;

      if (opts.verbose && parseErrors.length > 0) {
        for (const pe of parseErrors) {
          process.stderr.write(`${pc.yellow('Parse warning:')} ${pe.filePath}: ${pe.message}\n`);
        }
      }

      if (selectors.length === 0) {
        process.stdout.write(`${pc.yellow('No selectors found')} in ${config.testDir}\n`);
        return;
      }

      process.stdout.write(
        `Found ${pc.bold(String(selectors.length))} selectors, capturing fingerprints...\n`,
      );

      const result = await captureFingerprints(selectors, config, cwd);

      process.stdout.write(
        formatCaptureResult(result.captured, result.errors.length, selectors.length),
      );

      if (opts.verbose && result.errors.length > 0) {
        for (const ce of result.errors) {
          process.stderr.write(`${pc.yellow('Capture error:')} ${ce.selectorId}: ${ce.message}\n`);
        }
      }
    });
}
