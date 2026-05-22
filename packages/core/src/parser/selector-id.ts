import { createHash } from 'node:crypto';

/**
 * Produce a stable 12-char hex ID for a selector usage.
 *
 * @param filePath - Absolute path to the test file.
 * @param line - 1-indexed line number of the selector call.
 * @param rawValue - The literal string passed to the selector.
 * @returns A 12-character hexadecimal hash.
 *
 * @example
 * ```ts
 * makeSelectorId('/repo/test.spec.ts', 12, '#submit');
 * // => 'a1b2c3d4e5f6'
 * ```
 */
export function makeSelectorId(filePath: string, line: number, rawValue: string): string {
  return createHash('sha1').update(`${filePath}:${line}:${rawValue}`).digest('hex').slice(0, 12);
}
