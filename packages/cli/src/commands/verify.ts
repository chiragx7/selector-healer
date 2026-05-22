import { readFileSync, writeFileSync } from 'node:fs';
import { healSelectors, parseDirectory, verifySelectors } from '@selector-healer/core';
import type { HealSuggestion, HealerConfig } from '@selector-healer/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../config.js';
import { applyFix } from '../fix.js';
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

      if (broken.length > 0) {
        process.stdout.write(`\n${pc.bold('Healing suggestions:')}\n`);

        const suggestions = await healSelectors(broken, { config, projectRoot: cwd });
        process.stdout.write(formatSuggestions(suggestions));

        if (opts.fix) {
          await applyFixes(suggestions, config.confidenceThreshold?.autoApply ?? 0.8);
        }
      }

      if (broken.length > 0) {
        process.exitCode = 1;
      } else if (opts.failOnWarning && multi.length > 0) {
        process.exitCode = 1;
      }
    });
}

async function applyFixes(suggestions: HealSuggestion[], threshold: number): Promise<void> {
  let applied = 0;
  const byFile = new Map<string, Array<{ line: number; replacementCode: string }>>();

  for (const s of suggestions) {
    const top = s.candidates[0];
    if (!top || top.confidence < threshold) continue;

    const fp = top.matchedFingerprint;
    const filePath = fp.pageUrl;
    if (!filePath) continue;

    const list = byFile.get(filePath) ?? [];
    list.push({ line: 0, replacementCode: top.replacementCode });
    byFile.set(filePath, list);
    applied++;
  }

  if (applied === 0) {
    process.stdout.write(`  ${pc.dim('No suggestions above auto-apply threshold')}\n`);
    return;
  }

  for (const [filePath, fixes] of byFile) {
    try {
      const source = readFileSync(filePath, 'utf8');
      const patched = applyFix(source, fixes);
      writeFileSync(filePath, patched, 'utf8');
      process.stdout.write(`  ${pc.green('Fixed')} ${filePath} (${fixes.length} selectors)\n`);
    } catch (e) {
      process.stderr.write(
        `  ${pc.red('Fix failed')} ${filePath}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  process.stdout.write(`\n  ${pc.green(`${applied} fix(es) applied`)}\n\n`);
}
