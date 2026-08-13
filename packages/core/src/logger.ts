import pino from 'pino';

/**
 * Shared logger for `@selector-healer/core`. Defaults to `warn` level so the
 * library is quiet by default - consumers (CLI, VS Code) can override via
 * the `LOG_LEVEL` env var.
 *
 * @example
 * ```ts
 * import { logger } from './logger.js';
 * logger.warn({ filePath }, 'Skipping dynamic selector');
 * ```
 */
export const logger = pino({
  name: 'selector-healer',
  level: process.env.LOG_LEVEL ?? 'warn',
});
