import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

describe('@selector-healer/core', () => {
  it('exports a module surface', () => {
    expect(core).toBeDefined();
  });
});
