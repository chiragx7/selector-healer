import {
  loadFingerprints,
  parseDirectory,
  pruneFingerprints,
  saveFingerprints,
} from '@selector-healer/core';
import type { HealerConfig } from '@selector-healer/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../config.js';

export function registerPrune(program: Command): void {
  program
    .command('prune')
    .description('Remove baseline fingerprints for selectors that no longer exist')
    .option('-n, --dry-run', 'Show what would be removed without writing')
    .option('-v, --verbose', 'List each removed fingerprint')
    .action(async (opts: { dryRun?: boolean; verbose?: boolean }) => {
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

      const loaded = loadFingerprints(cwd);
      if (loaded.isErr()) {
        process.stderr.write(`${pc.red('Error:')} ${loaded.error.message}\n`);
        process.exitCode = 1;
        return;
      }
      const fingerprints = loaded.value;

      const { kept, removed } = pruneFingerprints(fingerprints, selectors, cwd);

      if (removed.length === 0) {
        process.stdout.write(
          `${pc.green('✓')} Baseline is clean - no stale fingerprints (${fingerprints.size} kept).\n`,
        );
        return;
      }

      // Safety: never prune from an untrustworthy current-selector list. Parse errors
      // (an incomplete list) or zero selectors (a misconfigured testDir) would make
      // live fingerprints look orphaned and delete valid baselines. `removed > 0` here.
      if (parseErrors.length > 0) {
        const n = parseErrors.length;
        process.stderr.write(
          `${pc.yellow('Refusing to prune:')} ${n} test file${n === 1 ? '' : 's'} failed to parse, so the selector list is incomplete. Fix ${n === 1 ? 'it' : 'them'} and re-run - otherwise valid baselines could be removed.\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (selectors.length === 0) {
        process.stderr.write(
          `${pc.yellow('Refusing to prune:')} no selectors found in ${config.testDir}. This would remove the entire baseline - check your testDir/testGlob.\n`,
        );
        process.exitCode = 1;
        return;
      }

      if (opts.verbose) {
        for (const fp of removed) {
          const where = fp.source ? `${fp.source.file}:${fp.source.line}` : fp.pageUrl;
          process.stdout.write(
            `  ${pc.dim(`- ${fp.selectorId}`)}  ${pc.dim(`<${fp.tagName}> ${where}`)}\n`,
          );
        }
      }

      const plural = removed.length === 1 ? '' : 's';

      if (opts.dryRun) {
        process.stdout.write(
          `${pc.yellow('Dry run:')} ${removed.length} stale fingerprint${plural} would be removed, ${kept.size} kept. Re-run without --dry-run to apply.\n`,
        );
        return;
      }

      const saveResult = saveFingerprints(cwd, kept);
      if (saveResult.isErr()) {
        process.stderr.write(`${pc.red('Error saving:')} ${saveResult.error.message}\n`);
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        `${pc.green('✓')} Removed ${pc.bold(String(removed.length))} stale fingerprint${plural}, ${kept.size} kept.\n`,
      );
    });
}
