import { loadFingerprints, parseDirectory } from '@selector-healer/core';
import type { HealerConfig, SelectorUsage } from '@selector-healer/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../config.js';

/**
 * Fast selector health check — no Playwright, no browser.
 *
 * Compares parsed selectors against stored fingerprints to detect:
 * 1. New selectors that have never been captured (no baseline).
 * 2. Selectors whose raw value changed since last capture.
 * 3. Orphaned fingerprints whose selectors no longer exist.
 *
 * Designed for pre-commit hooks and fast CI gates where launching
 * a browser would be too slow.
 */
export function registerCheck(program: Command): void {
  program
    .command('check')
    .description('Fast pre-commit check — detects selector drift without a browser')
    .option('--strict', 'Exit 1 on any drift (new, changed, or orphaned)')
    .option('--allow-new', 'Do not flag uncaptured selectors')
    .option('-q, --quiet', 'Only output on failure')
    .action(async (opts: { strict?: boolean; allowNew?: boolean; quiet?: boolean }) => {
      const cwd = process.cwd();

      let config: HealerConfig;
      try {
        config = await loadConfig(cwd);
      } catch (e) {
        process.stderr.write(`${pc.red('Error:')} ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
        return;
      }

      // 1. Parse all selectors from test files
      const parseResult = parseDirectory(config.testDir, config.testGlob);
      if (parseResult.isErr()) {
        process.stderr.write(`${pc.red('Parse error:')} ${parseResult.error.message}\n`);
        process.exitCode = 1;
        return;
      }

      const { selectors } = parseResult.value;
      if (selectors.length === 0) {
        process.stdout.write(`${pc.yellow('No selectors found')} in ${config.testDir}\n`);
        return;
      }

      // 2. Load existing fingerprints
      const fpResult = loadFingerprints(cwd);
      const fingerprints = fpResult.isOk() ? fpResult.value : new Map<string, unknown>();

      // 3. Categorise selectors
      const newSelectors: SelectorUsage[] = [];
      const changedSelectors: { selector: SelectorUsage; storedId: string }[] = [];

      for (const sel of selectors) {
        if (!fingerprints.has(sel.id)) {
          newSelectors.push(sel);
        }
      }

      // 4. Detect orphaned fingerprints (baseline exists, selector removed)
      const currentIds = new Set(selectors.map((s) => s.id));
      const orphanedIds: string[] = [];
      for (const fpId of fingerprints.keys()) {
        if (!currentIds.has(fpId)) {
          orphanedIds.push(fpId);
        }
      }

      // 5. Report
      const hasNew = newSelectors.length > 0;
      const hasOrphans = orphanedIds.length > 0;
      const hasDrift = hasNew || hasOrphans;

      if (!hasDrift) {
        if (!opts.quiet) {
          process.stdout.write(
            `${pc.green('✓')} All ${selectors.length} selectors have baselines — no drift detected\n`,
          );
        }
        return;
      }

      // New selectors
      if (hasNew && !opts.allowNew) {
        process.stdout.write(
          `\n${pc.yellow('⚠')} ${pc.bold(String(newSelectors.length))} new selector(s) without baselines:\n`,
        );
        for (const sel of newSelectors) {
          const file = shortenPath(sel.filePath, cwd);
          process.stdout.write(
            `  ${pc.dim(`${file}:${sel.line}`)} ${sel.selectorType}(${pc.cyan(`'${sel.rawValue}'`)})\n`,
          );
        }
        process.stdout.write(
          `  ${pc.dim('Run')} ${pc.bold('selector-healer capture')} ${pc.dim('to baseline them')}\n\n`,
        );
      }

      // Orphaned fingerprints
      if (hasOrphans) {
        process.stdout.write(
          `${pc.yellow('⚠')} ${pc.bold(String(orphanedIds.length))} orphaned fingerprint(s) — selectors removed but baselines remain\n`,
        );
        process.stdout.write(
          `  ${pc.dim('Run')} ${pc.bold('selector-healer capture')} ${pc.dim('to refresh baselines')}\n\n`,
        );
      }

      // Summary
      process.stdout.write(
        `${pc.bold('Summary:')} ${selectors.length} selectors, ` +
          `${fingerprints.size} fingerprints, ` +
          `${newSelectors.length} new, ` +
          `${orphanedIds.length} orphaned\n`,
      );

      // Exit code
      if (opts.strict) {
        process.exitCode = 1;
      } else if (hasNew && !opts.allowNew) {
        process.exitCode = 1;
      }
    });
}

function shortenPath(fullPath: string, cwd: string): string {
  const normalized = fullPath.replace(/\\/g, '/');
  const normalizedCwd = cwd.replace(/\\/g, '/');
  if (normalized.startsWith(normalizedCwd)) {
    return normalized.slice(normalizedCwd.length + 1);
  }
  return normalized;
}
