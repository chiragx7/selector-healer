import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectProjectConfig, renderConfigFile } from '@selector-healer/core';
import type { LearningChoice } from '@selector-healer/core';
import type { Command } from 'commander';
import pc from 'picocolors';

/** Config filenames cosmiconfig will discover, in precedence order. */
const EXISTING_CONFIG_FILES = [
  'selector-healer.config.ts',
  'selector-healer.config.js',
  'selector-healer.config.mjs',
  'selector-healer.config.cjs',
];

export function registerInit(program: Command): void {
  program
    .command('init')
    .description(
      'Initialize Selector Healer - auto-detects framework, base URL, and test directory',
    )
    .option('--force', 'Overwrite an existing configuration')
    .option('--print', 'Print the detected config without writing anything')
    .option(
      '--learning <store>',
      "Store for accept/reject learning: 'local' (default) | 'committed' | 'off'",
    )
    .action(async (opts: { force?: boolean; print?: boolean; learning?: string }) => {
      const cwd = process.cwd();
      const validStores = [
        'local',
        'committed',
        'off',
      ] as const satisfies readonly LearningChoice[];
      if (opts.learning && !validStores.includes(opts.learning as LearningChoice)) {
        process.stderr.write(
          `${pc.red('Error:')} --learning must be one of: ${validStores.join(', ')}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const detection = detectProjectConfig(cwd);
      const learning = validStores.find((v) => v === opts.learning);
      const { filename, content } = renderConfigFile(detection, learning);

      // ── Detection summary ──
      const guess = (confident: boolean, source: string) =>
        confident ? pc.dim(`(${source})`) : pc.yellow('(guess - please review)');

      process.stdout.write(`\n${pc.bold('Detected')}\n`);
      process.stdout.write(
        `  ${pc.cyan('Framework')}  ${detection.framework} ${
          detection.frameworkConfidence === 'detected' ? '' : pc.yellow('(guess - please review)')
        }\n`,
      );
      process.stdout.write(
        `  ${pc.cyan('Base URL')}   ${detection.baseUrl} ${guess(detection.baseUrlConfident, detection.baseUrlSource)}\n`,
      );
      process.stdout.write(
        `  ${pc.cyan('Test dir')}   ${detection.testDir} ${guess(detection.testDirConfident, detection.testDirSource)}\n`,
      );
      if (detection.otherFrameworks.length > 0) {
        process.stdout.write(
          `  ${pc.dim(`Also present: ${detection.otherFrameworks.join(', ')}`)}\n`,
        );
      }
      process.stdout.write('\n');

      if (opts.print) {
        process.stdout.write(content);
        return;
      }

      // ── Store directory ──
      const storeDir = join(cwd, '.selector-healer');
      if (!existsSync(storeDir)) {
        mkdirSync(storeDir, { recursive: true });
        process.stdout.write(`  ${pc.green('Created')} .selector-healer/\n`);
      }
      const gitkeep = join(storeDir, '.gitkeep');
      if (!existsSync(gitkeep)) writeFileSync(gitkeep, '', 'utf8');

      // ── Config file ──
      const existing = EXISTING_CONFIG_FILES.filter((f) => existsSync(join(cwd, f)));
      const configPath = join(cwd, filename);

      if (existing.length > 0 && !opts.force) {
        process.stdout.write(
          `  ${pc.yellow('Skipped')} config (${existing[0]} already exists - use ${pc.cyan('--force')} to regenerate)\n\n`,
        );
        return;
      }

      // On --force, remove any other-extension config so the new .cjs is the
      // single source of truth (cosmiconfig would otherwise prefer a stale .ts).
      for (const f of existing) {
        if (f !== filename) {
          rmSync(join(cwd, f), { force: true });
          process.stdout.write(`  ${pc.dim('Removed')} ${f} ${pc.dim('(replaced by .cjs)')}\n`);
        }
      }

      writeFileSync(configPath, content, 'utf8');
      process.stdout.write(`  ${pc.green('Created')} ${filename}\n`);

      // ── Next steps ──
      const todos: string[] = [];
      if (detection.frameworkConfidence !== 'detected') todos.push('set framework');
      if (!detection.baseUrlConfident) todos.push('set baseUrl');
      if (!detection.testDirConfident) todos.push('point testDir at your tests');

      process.stdout.write(`\n${pc.bold('Next steps')}\n`);
      let step = 1;
      if (todos.length > 0) {
        process.stdout.write(`  ${step++}. Review ${filename} - ${todos.join(', ')}\n`);
      }
      process.stdout.write(
        `  ${step++}. Run ${pc.cyan('selector-healer capture')} to baseline fingerprints\n`,
      );
      process.stdout.write(
        `  ${step++}. Run ${pc.cyan('selector-healer verify')} to check for regressions\n\n`,
      );
    });
}
