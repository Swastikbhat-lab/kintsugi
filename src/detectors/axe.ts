import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * axe-core as a detector.
 *
 * Everything else here is hand-written: a rule, a threshold, a probe. That
 * scales badly and it is not where the value is — accessibility rules are a
 * solved, heavily-audited problem, and Deque has spent a decade on ~90 of
 * them. Re-deriving that by hand would be slower and worse.
 *
 * It fits because every axe rule is checkable by construction: each violation
 * names a rule, an impact, and the exact element. That is already the shape a
 * finding needs, so the loop's gate works on them unchanged.
 *
 * What it does not change is the ceiling. Automated rules catch roughly half
 * of real accessibility problems; the rest need a human. A clean axe run
 * means no *detectable* violations, which is not the same as accessible, and
 * the tool should never be read as claiming otherwise.
 */

const require = createRequire(import.meta.url);

let cached: string | null = null;

/** The axe-core bundle, read once and injected into the page. */
export function axeSource(): string {
  if (cached) return cached;
  cached = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return cached;
}

/**
 * Run axe against the current page and return its violations.
 *
 * Scoped to the rule sets that correspond to a real standard. axe's
 * `best-practice` tag holds defensible advice that is nonetheless somebody's
 * opinion, and opinions do not belong in a gate that reverts people's code.
 */
export const AXE_RUN = `(async () => {
  const results = await axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    resultTypes: ['violations'],
    // Contrast is measured by our own probe, which reports gradients and
    // translucent stacks as unmeasurable instead of guessing. Running both
    // would double-report every hit and reintroduce the guessing.
    rules: { 'color-contrast': { enabled: false } },
  });

  return results.violations.flatMap((v) =>
    v.nodes.slice(0, 3).map((n) => ({
      rule: v.id,
      impact: n.impact || v.impact || 'moderate',
      help: v.help,
      helpUrl: v.helpUrl,
      selector: Array.isArray(n.target) ? String(n.target[0]) : String(n.target),
      html: (n.html || '').slice(0, 160),
      // The specific reason this node failed, which is what a fix has to
      // address — the rule name alone is too coarse to act on.
      detail: (n.failureSummary || '').replace(/\\s+/g, ' ').slice(0, 200),
    })),
  );
})()`;

/** axe impact levels mapped onto the loop's severities. */
export function severityOf(impact: string): 'blocker' | 'major' | 'minor' {
  if (impact === 'critical') return 'blocker';
  if (impact === 'serious') return 'major';
  return 'minor';
}
