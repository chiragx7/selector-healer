import type { HealerConfig } from '@selector-healer/core';

export default {
  testDir: './tests',
  baseUrl: 'http://localhost:3456',
  headless: true,
  timeout: 15_000,
} satisfies HealerConfig;
