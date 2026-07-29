import type { HealSuggestion, VerificationResult } from '@selector-healer/core';
import pc from 'picocolors';

export function formatVerifyResults(results: VerificationResult[]): string {
  const lines: string[] = [];
  const ok = results.filter((r) => r.status === 'ok');
  const broken = results.filter((r) => r.status === 'broken');
  const multi = results.filter((r) => r.status === 'multiple-matches');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status === 'page-load-failed');

  lines.push('');
  lines.push(pc.bold('Verification Results'));
  lines.push('─'.repeat(50));

  for (const r of broken) {
    lines.push(
      `  ${pc.red('BROKEN')}  ${pc.dim(r.selector.filePath)}:${r.selector.line} ${pc.yellow(r.selector.rawValue)}`,
    );
  }

  for (const r of multi) {
    lines.push(
      `  ${pc.yellow('MULTI ')}  ${pc.dim(r.selector.filePath)}:${r.selector.line} ${pc.yellow(r.selector.rawValue)} (${r.matchCount} matches)`,
    );
  }

  for (const r of failed) {
    lines.push(
      `  ${pc.red('FAIL  ')}  ${pc.dim(r.selector.filePath)}:${r.selector.line} ${r.error ?? 'page load failed'}`,
    );
  }

  lines.push('');
  lines.push(
    `  ${pc.green(`${ok.length} ok`)}  ${pc.red(`${broken.length} broken`)}  ${pc.yellow(`${multi.length} multi`)}  ${pc.dim(`${skipped.length} skipped`)}  ${pc.dim(`${failed.length} failed`)}`,
  );
  lines.push('');

  return lines.join('\n');
}

export function formatSuggestions(suggestions: HealSuggestion[]): string {
  const lines: string[] = [];

  for (const s of suggestions) {
    if (s.candidates.length === 0 && !s.explanation?.length) continue;

    lines.push(`  ${pc.cyan(s.selectorId)}:`);

    // Why it broke — the top reason(s) from diffing the baseline against now.
    for (const reason of (s.explanation ?? []).slice(0, 2)) {
      lines.push(`     ${pc.dim('↳ why:')} ${reason.summary}`);
    }

    for (let i = 0; i < s.candidates.length; i++) {
      const c = s.candidates[i];
      if (!c) continue;
      const pct = Math.round(c.confidence * 100);
      const bar = pct >= 80 ? pc.green : pct >= 50 ? pc.yellow : pc.red;
      lines.push(`    ${i + 1}. ${bar(`${pct}%`)} ${pc.bold(c.replacementCode)}`);
      lines.push(`       ${pc.dim(c.reasoning)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatCaptureResult(captured: number, errors: number, total: number): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(pc.bold('Capture Results'));
  lines.push('─'.repeat(50));
  lines.push(`  ${pc.green(`${captured} fingerprints captured`)} from ${total} selectors`);
  if (errors > 0) {
    lines.push(`  ${pc.yellow(`${errors} selectors failed to capture`)}`);
  }
  lines.push('');
  return lines.join('\n');
}
