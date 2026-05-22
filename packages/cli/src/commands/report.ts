import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { healSelectors, parseDirectory, verifySelectors } from '@selector-healer/core';
import type { HealSuggestion, HealerConfig, VerificationResult } from '@selector-healer/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig } from '../config.js';

export function registerReport(program: Command): void {
  program
    .command('report')
    .description('Generate an HTML report of selector health')
    .option('-o, --output <path>', 'Output path', '.selector-healer/report.html')
    .action(async (opts: { output: string }) => {
      const cwd = process.cwd();

      let config: HealerConfig;
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

      if (selectors.length === 0) {
        process.stdout.write(`${pc.yellow('No selectors found')} in ${config.testDir}\n`);
        return;
      }

      process.stdout.write(`Verifying ${pc.bold(String(selectors.length))} selectors...\n`);

      const results = await verifySelectors(selectors, { config, projectRoot: cwd });
      const broken = results.filter((r) => r.status === 'broken');

      let suggestions: HealSuggestion[] = [];
      if (broken.length > 0) {
        suggestions = await healSelectors(broken, { config, projectRoot: cwd });
      }

      const html = generateReport(results, suggestions);
      const outPath = join(cwd, opts.output);
      mkdirSync(join(outPath, '..'), { recursive: true });
      writeFileSync(outPath, html, 'utf8');

      process.stdout.write(`\n  ${pc.green('Report written to')} ${opts.output}\n\n`);
    });
}

function generateReport(results: VerificationResult[], suggestions: HealSuggestion[]): string {
  const ok = results.filter((r) => r.status === 'ok').length;
  const broken = results.filter((r) => r.status === 'broken').length;
  const multi = results.filter((r) => r.status === 'multiple-matches').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'page-load-failed').length;
  const total = results.length;
  const ts = new Date().toISOString();

  const suggestMap = new Map(suggestions.map((s) => [s.selectorId, s]));

  const rows = results
    .map((r) => {
      const statusClass =
        r.status === 'ok'
          ? 'ok'
          : r.status === 'broken'
            ? 'broken'
            : r.status === 'multiple-matches'
              ? 'multi'
              : 'skip';
      const sug = suggestMap.get(r.selector.id);
      const topFix = sug?.candidates[0];
      const fixCell = topFix
        ? `<code>${escapeHtml(topFix.replacementCode)}</code> (${Math.round(topFix.confidence * 100)}%)`
        : '';

      return `<tr class="${statusClass}">
        <td>${escapeHtml(r.selector.filePath)}:${r.selector.line}</td>
        <td><code>${escapeHtml(r.selector.rawValue)}</code></td>
        <td class="status">${r.status}</td>
        <td>${fixCell}</td>
      </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Selector Healer Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; padding: 2rem; background: #fafafa; color: #222; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  .meta { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .summary { display: flex; gap: 1.5rem; margin-bottom: 2rem; }
  .summary .card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.5rem; }
  .summary .card .num { font-size: 2rem; font-weight: 700; }
  .summary .card .label { font-size: 0.85rem; color: #666; }
  .ok .num { color: #16a34a; }
  .broken .num { color: #dc2626; }
  .multi .num { color: #ca8a04; }
  .skip .num { color: #9ca3af; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
  th { text-align: left; padding: 0.75rem 1rem; background: #f5f5f5; font-size: 0.85rem; border-bottom: 1px solid #ddd; }
  td { padding: 0.75rem 1rem; border-bottom: 1px solid #eee; font-size: 0.85rem; }
  tr.broken { background: #fef2f2; }
  tr.multi { background: #fefce8; }
  tr.skip { color: #9ca3af; }
  td.status { font-weight: 600; }
  code { background: #f1f5f9; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>Selector Healer Report</h1>
<div class="meta">Generated ${escapeHtml(ts)}</div>
<div class="summary">
  <div class="card ok"><div class="num">${ok}</div><div class="label">OK</div></div>
  <div class="card broken"><div class="num">${broken}</div><div class="label">Broken</div></div>
  <div class="card multi"><div class="num">${multi}</div><div class="label">Multiple</div></div>
  <div class="card skip"><div class="num">${skipped + failed}</div><div class="label">Skipped/Failed</div></div>
</div>
<table>
<thead>
  <tr><th>Location</th><th>Selector</th><th>Status</th><th>Suggested Fix</th></tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
<div class="meta" style="margin-top:2rem">Total: ${total} selectors</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
