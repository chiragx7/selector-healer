#!/usr/bin/env node
import { Command } from 'commander';
import { registerCapture } from './commands/capture.js';
import { registerCheck } from './commands/check.js';
import { registerInit } from './commands/init.js';
import { registerLint } from './commands/lint.js';
import { registerReport } from './commands/report.js';
import { registerServe } from './commands/serve.js';
import { registerVerify } from './commands/verify.js';

const program = new Command();

program
  .name('selector-healer')
  .description('Detect and fix broken Playwright selectors')
  .version('0.0.1');

registerInit(program);
registerCapture(program);
registerVerify(program);
registerLint(program);
registerCheck(program);
registerReport(program);
registerServe(program);

program.parse();
