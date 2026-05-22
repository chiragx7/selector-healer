import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';

const CONFIG_TEMPLATE = `import type { HealerConfig } from '@selector-healer/core';

export default {
  testDir: './tests',
  baseUrl: 'http://localhost:3000',
  headless: true,
  timeout: 30_000,
} satisfies HealerConfig;
`;

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Initialize Selector Healer in the current project')
    .option('--force', 'Overwrite existing configuration')
    .action(async (opts: { force?: boolean }) => {
      const cwd = process.cwd();
      const storeDir = join(cwd, '.selector-healer');
      const configPath = join(cwd, 'selector-healer.config.ts');

      if (!existsSync(storeDir)) {
        mkdirSync(storeDir, { recursive: true });
        process.stdout.write(`  ${pc.green('Created')} .selector-healer/\n`);
      }

      if (existsSync(configPath) && !opts.force) {
        process.stdout.write(
          `  ${pc.yellow('Skipped')} selector-healer.config.ts (already exists, use --force to overwrite)\n`,
        );
      } else {
        writeFileSync(configPath, CONFIG_TEMPLATE, 'utf8');
        process.stdout.write(`  ${pc.green('Created')} selector-healer.config.ts\n`);
      }

      const gitignorePath = join(storeDir, '.gitkeep');
      if (!existsSync(gitignorePath)) {
        writeFileSync(gitignorePath, '', 'utf8');
      }

      process.stdout.write(
        `\n${pc.bold('Next steps:')}\n  1. Edit selector-healer.config.ts with your testDir and baseUrl\n  2. Run ${pc.cyan('selector-healer capture')} to baseline fingerprints\n  3. Run ${pc.cyan('selector-healer verify')} to check for regressions\n\n`,
      );
    });
}
