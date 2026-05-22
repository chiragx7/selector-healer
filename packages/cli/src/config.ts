import { resolve } from 'node:path';
import type { HealerConfig } from '@selector-healer/core';
import { cosmiconfig } from 'cosmiconfig';

const MODULE_NAME = 'selector-healer';

export async function loadConfig(cwd: string): Promise<HealerConfig> {
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      `${MODULE_NAME}.config.ts`,
      `${MODULE_NAME}.config.js`,
      `${MODULE_NAME}.config.mjs`,
      `${MODULE_NAME}.config.cjs`,
      `.${MODULE_NAME}rc`,
      `.${MODULE_NAME}rc.json`,
      'package.json',
    ],
  });

  const result = await explorer.search(cwd);

  if (!result || result.isEmpty) {
    throw new Error('No configuration found. Run `selector-healer init` to create one.');
  }

  const config = result.config as HealerConfig;

  if (!config.testDir) {
    throw new Error('Configuration missing required field: testDir');
  }
  if (!config.baseUrl) {
    throw new Error('Configuration missing required field: baseUrl');
  }

  return {
    ...config,
    testDir: resolve(cwd, config.testDir),
  };
}
