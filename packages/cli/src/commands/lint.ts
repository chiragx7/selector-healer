import {
  type LintFinding,
  lintSelectors,
  loadFingerprints,
  parseDirectory,
} from '@selector-healer/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../config.js';

export function registerLint(program: Command): void {
  program
    .command('lint')
    .description('Flag fragile selectors (text/CSS/XPath) and suggest sturdier locators')
    .option('--strict', 'Exit with a non-zero code if any fragile selector is found')
    .action(async (opts: { strict?: boolean }) => {
      const cwd = process.cwd();

      let config: Awaited<ReturnType<typeof loadConfig>>;
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

      // Fingerprints are optional - when present they enable concrete,
      // DOM-backed upgrade suggestions; without them the lint is static.
      const fpResult = loadFingerprints(cwd);
      const fingerprints = fpResult.isOk() ? fpResult.value : undefined;

      const findings = lintSelectors(selectors, { fingerprints, framework: config.framework });

      process.stdout.write(`\n${pc.bold('Selector Lint')}\n`);
      process.stdout.write(`${'─'.repeat(50)}\n`);

      if (findings.length === 0) {
        process.stdout.write(
          `  ${pc.green('No fragile selectors')} - ${selectors.length} checked.\n\n`,
        );
        return;
      }

      const byFile = new Map<string, LintFinding[]>();
      for (const f of findings) {
        const list = byFile.get(f.filePath) ?? [];
        list.push(f);
        byFile.set(f.filePath, list);
      }

      for (const [file, list] of byFile) {
        const name = file.split(/[/\\]/).pop() ?? file;
        process.stdout.write(`\n  ${pc.bold(name)}\n`);
        for (const f of list) {
          process.stdout.write(
            `    ${pc.yellow('fragile')} ${pc.dim(`:${f.line}`)} ${f.selectorType} ${pc.dim(truncate(f.rawValue, 48))}\n`,
          );
          process.stdout.write(`      ${pc.dim(f.message)}\n`);
          if (f.upgrade) {
            process.stdout.write(
              `      ${pc.green('↑ try')} ${pc.bold(f.upgrade.replacementCode)} ${pc.dim(`(${f.upgrade.tier})`)}\n`,
            );
          }
        }
      }

      const withUpgrade = findings.filter((f) => f.upgrade).length;
      process.stdout.write(
        `\n  ${pc.yellow(`${findings.length} fragile`)} of ${selectors.length} selectors`,
      );
      if (withUpgrade > 0) {
        process.stdout.write(`, ${pc.green(`${withUpgrade} with a suggested upgrade`)}`);
      }
      process.stdout.write('.\n\n');

      if (opts.strict) process.exitCode = 1;
    });
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
