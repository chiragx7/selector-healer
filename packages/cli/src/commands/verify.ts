import { readFileSync, writeFileSync } from 'node:fs';
import { healSelectors, parseDirectory, verifySelectors } from '@selector-healer/core';
import type { HealSuggestion, HealerConfig, VerificationResult } from '@selector-healer/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import type { FixEntry } from '../fix.js';
import { applyFixesToSource } from '../fix.js';
import { formatSuggestions, formatVerifyResults } from '../format.js';

export function registerVerify(program: Command): void {
  program
    .command('verify')
    .description('Verify selectors against the live DOM')
    .option('-v, --verbose', 'Verbose output')
    .option('--fix', 'Auto-apply high-confidence replacement suggestions')
    .option('--fail-on-warning', 'Exit with code 1 on multiple-matches')
    .action(async (opts: { verbose?: boolean; fix?: boolean; failOnWarning?: boolean }) => {
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

      const { selectors } = parseResult.value;

      if (selectors.length === 0) {
        process.stdout.write(`${pc.yellow('No selectors found')} in ${config.testDir}\n`);
        return;
      }

      process.stdout.write(`Verifying ${pc.bold(String(selectors.length))} selectors...\n`);

      const results = await verifySelectors(selectors, { config, projectRoot: cwd });

      process.stdout.write(formatVerifyResults(results));

      const broken = results.filter((r) => r.status === 'broken');
      const multi = results.filter((r) => r.status === 'multiple-matches');
      const setupFailed = results.filter(
        (r) => r.status === 'page-load-failed' && (r.error ?? '').includes('setup hook failed'),
      );

      if (setupFailed.length > 0) {
        const pages = [
          ...new Set(setupFailed.map((r) => r.error?.match(/page '([^']+)'/)?.[1] ?? 'a page')),
        ];
        process.stdout.write(
          `\n${pc.yellow('⚠ Setup hook failed')} for: ${pc.bold(pages.join(', '))}\n` +
            `  ${pc.dim(
              `${setupFailed.length} selector(s) couldn't be checked. Fix the login/setup step in your config's pages[] — those selectors aren't broken, they were just unreachable.`,
            )}\n`,
        );
      }

      if (broken.length > 0) {
        process.stdout.write(`\n${pc.bold('Healing suggestions:')}\n`);

        const suggestions = await healSelectors(broken, { config, projectRoot: cwd });
        process.stdout.write(formatSuggestions(suggestions));

        if (opts.fix) {
          applyFixes(broken, suggestions, config.confidenceThreshold?.autoApply ?? 0.8);
        }
      }

      if (broken.length > 0 || setupFailed.length > 0) {
        process.exitCode = 1;
      } else if (opts.failOnWarning && multi.length > 0) {
        process.exitCode = 1;
      }
    });
}

function applyFixes(
  broken: VerificationResult[],
  suggestions: HealSuggestion[],
  threshold: number,
): void {
  const selectorMap = new Map(broken.map((r) => [r.selector.id, r.selector]));

  const byFile = new Map<string, FixEntry[]>();
  let count = 0;

  for (const s of suggestions) {
    const top = s.candidates[0];
    if (!top || top.confidence < threshold) continue;

    const selector = selectorMap.get(s.selectorId);
    if (!selector) continue;

    const list = byFile.get(selector.filePath) ?? [];
    list.push({
      line: selector.line,
      column: selector.column,
      rawValue: selector.rawValue,
      replacementCode: top.replacementCode,
    });
    byFile.set(selector.filePath, list);
    count++;
  }

  if (count === 0) {
    process.stdout.write(`  ${pc.dim('No suggestions above auto-apply threshold')}\n`);
    return;
  }

  for (const [filePath, fixes] of byFile) {
    try {
      const source = readFileSync(filePath, 'utf8');
      const patched = applyFixesToSource(source, fixes);
      writeFileSync(filePath, patched, 'utf8');
      process.stdout.write(`  ${pc.green('Fixed')} ${filePath} (${fixes.length} selectors)\n`);
    } catch (e) {
      process.stderr.write(
        `  ${pc.red('Fix failed')} ${filePath}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  process.stdout.write(`\n  ${pc.green(`${count} fix(es) applied`)}\n\n`);
}
