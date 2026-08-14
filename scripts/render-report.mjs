#!/usr/bin/env node
/**
 * Render a Kintsugi JSON report into a GitHub-friendly markdown comment.
 *
 *   node render-report.mjs <report.json> [out.md]
 *
 * No dependencies on purpose: this is the last step of a CI pipeline and
 * must never be the thing that fails. Prints to stdout when no out file is
 * given.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [reportPath, outPath] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: node render-report.mjs <report.json> [out.md]');
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const findings = report.findings ?? [];

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
const sevIcon = (s) => (s === 'blocker' ? '🟥' : s === 'major' ? '🟧' : '🟨');
const repairLabel = {
  proposed: '🔧 repair available',
  escalated: '⚠️ shared file — needs you',
  attempted: '❌ tried, reverted',
  none: '🔒 needs human intent',
};

const counts = {
  proposed: 0, escalated: 0, attempted: 0, none: 0,
};
for (const f of findings) counts[f.repair] = (counts[f.repair] ?? 0) + 1;

const lines = [];
lines.push('## 🔧 Kintsugi review');
lines.push('');

if (findings.length === 0) {
  lines.push('✅ **No actionable findings.** The checks this run configured are clean.');
} else {
  const byRepair = ['proposed', 'escalated', 'attempted', 'none']
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${repairLabel[k]}`)
    .join(' · ');
  lines.push(`**${findings.length} finding(s)** — ${byRepair}.`);
  lines.push('This review is a **dry run**: Kintsugi never writes to your branch on review. Say `/kintsugi-fix` (or run the auto-fix workflow) to apply the proposed repairs in a new PR, each one verified by re-running the checks.');
  lines.push('');

  if (counts.proposed || counts.escalated || counts.attempted) {
    lines.push('| Severity | Check | Finding | File | Repair |');
    lines.push('|---|---|---|---|---|');
    for (const f of findings) {
      if (f.repair === 'none') continue;
      const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '—';
      lines.push(`| ${sevIcon(f.severity)} | \`${esc(f.check)}\` | ${esc(f.summary)} | ${loc} | ${repairLabel[f.repair]} |`);
    }
    lines.push('');
  }

  if (counts.none) {
    lines.push('<details><summary>🔒 Findings that need a human (no mechanical repair exists)</summary>');
    lines.push('');
    lines.push('| Check | Finding | File |');
    lines.push('|---|---|---|');
    for (const f of findings) {
      if (f.repair !== 'none') continue;
      const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '—';
      lines.push(`| \`${esc(f.check)}\` | ${esc(f.summary)} | ${loc} |`);
    }
    lines.push('</details>');
    lines.push('');
  }
}

lines.push('<details><summary>Raw report (JSON)</summary>');
lines.push('');
lines.push('```json');
lines.push(JSON.stringify(report, null, 2));
lines.push('```');
lines.push('</details>');
lines.push('');
lines.push('---');
lines.push('_<sub>Review by [Kintsugi](https://github.com/Swastikbhat-lab/kintsugi) — a self-healing repair loop. Every fix it proposes is proven by re-running the checks; anything it cannot verify, it leaves for a human.</sub>_');
lines.push('<!-- kintsugi-review -->');

const md = lines.join('\n') + '\n';
if (outPath) writeFileSync(outPath, md, 'utf8');
else process.stdout.write(md);
