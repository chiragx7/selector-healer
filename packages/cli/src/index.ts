#!/usr/bin/env node
import { Command } from 'commander';
import { registerCapture } from './commands/capture.js';
import { registerInit } from './commands/init.js';
import { registerReport } from './commands/report.js';
import { registerVerify } from './commands/verify.js';

const program = new Command();

program
  .name('selector-healer')
  .description('Detect and fix broken Playwright selectors')
  .version('0.0.1');

registerInit(program);
registerCapture(program);
registerVerify(program);
registerReport(program);

program.parse();
