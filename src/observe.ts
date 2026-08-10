import { createHash } from 'node:crypto';
import { type Page } from 'playwright';
import { openBrowser, type BrowserHandle } from './browser.js';
import type { RunConfig, UIGraph, Finding, GraphNode } from './types.js';
import { CONTRAST_PROBE } from './detectors/contrast.js';
import { LAYOUT_PROBE } from './detectors/layout.js';
import { DESIGN_PROBE } from './detectors/design.js';
import { axeSource, AXE_RUN, severityOf } from './detectors/axe.js';
import { unhashClass } from './heal/sourcemap.js';

/**
 * Strip CSS-Modules scoping from a selector before it is fingerprinted.
 *
 * Vite derives a scoped name from a hash of the entire stylesheet, so editing
 * one rule renames *every* class in that file: `_forgot_penvp_415` becomes
 * `_forgot_18n7w_415`. Fingerprint the runtime name and every untouched
 * finding in that file reads as newly appeared — which the verify step scores
 * as collateral damage and reverts a correct patch over.
 *
 * The authoring name does not move, so identity hangs off that instead.
 */
const stableSelector = (selector: string): string =>
  selector
    .split('.')
    .map((part, i) => (i === 0 ? part : unhashClass(part) ?? part))
    .join('.');

const fp = (...parts: string[]) =>
  createHash('sha1')
    .update(parts.map(stableSelector).join('|'))
    .digest('hex')
    .slice(0, 12);

/**
 * Drives a real browser over the target app and turns what it measures into
 * graph nodes and findings.
 *
 * Everything here is live measurement. Static analysis of a stylesheet cannot
 * tell you what a rule actually resolves to once cascade, theme and runtime
 * state are applied — it mostly produces failures nobody can reproduce.
 */
export class Observer {
  private handle?: BrowserHandle;
  /**
   * One page per route. Routes are genuinely independent — nothing one
   * observation produces feeds another — so they get their own tabs and run
   * at the same time. Sharing a page would serialise them for no reason and
   * cross-contaminate the console-error buffer.
   */
  private pages = new Map<string, { page: Page; errors: string[] }>();

  constructor(private config: RunConfig) {}

  /** True when driving a browser the user signed into, rather than a fresh one. */
  get attached(): boolean {
    return this.handle?.attached ?? false;
  }

  async open(): Promise<void> {
    this.handle = await openBrowser({ attach: this.config.attach });
  }

  /** Closes only what Kintsugi opened — never the user's own browser. */
  async close(): Promise<void> {
    await this.handle?.dispose();
    this.pages.clear();
  }

  private async pageFor(route: string) {
    const existing = this.pages.get(route);
    if (existing) return existing;
    if (!this.handle) throw new Error('Observer not opened');

    // Via the handle, so the page lands in the signed-in context. Playwright's
    // browser.newPage() would silently make a fresh context with an empty
    // cookie jar, putting us straight back to auditing the login screen.
    const page = await this.handle.newPage({ viewport: { width: 1280, height: 800 } });
    const entry = { page, errors: [] as string[] };
    page.on('console', (m) => { if (m.type() === 'error') entry.errors.push(m.text()); });
    page.on('pageerror', (e) => entry.errors.push(e.message));
    this.pages.set(route, entry);
    return entry;
  }

  /** Observe one route. This is the unit the work graph fans out over. */
  async sweepRoute(route: string): Promise<{ graph: UIGraph; findings: Finding[] }> {
    const graph: UIGraph = { nodes: {}, edges: [] };
    const surfaceId = `surface:${route}`;
    graph.nodes[surfaceId] = { id: surfaceId, kind: 'surface', label: route, ref: route };
    const findings = await this.visit(route, surfaceId, graph);
    return { graph, findings };
  }

  /** Walk every route in parallel and merge the fragments. */
  async sweep(): Promise<{ graph: UIGraph; findings: Finding[] }> {
    const parts = await Promise.all(this.config.routes.map((r) => this.sweepRoute(r)));
    const graph: UIGraph = { nodes: {}, edges: [] };
    const findings: Finding[] = [];
    for (const part of parts) {
      Object.assign(graph.nodes, part.graph.nodes);
      graph.edges.push(...part.graph.edges);
      findings.push(...part.findings);
    }
    return { graph, findings };
  }

  /**
   * Re-measure one surface after a patch. Scoped to the node that was
   * patched, because re-walking everything on every attempt makes the loop
   * unusably slow and tells us nothing extra about this patch.
   */
  async resweep(nodeId: string): Promise<Finding[]> {
    const route = nodeId.split('::')[0].replace(/^surface:/, '');
    const scratch: UIGraph = { nodes: {}, edges: [] };
    const surfaceId = `surface:${route}`;
    scratch.nodes[surfaceId] = {
      id: surfaceId, kind: 'surface', label: route, ref: route,
    };
    return this.visit(route, surfaceId, scratch);
  }

  private async visit(route: string, surfaceId: string, graph: UIGraph): Promise<Finding[]> {
    const { page, errors } = await this.pageFor(route);
    const url = new URL(route, this.config.target).toString();
    errors.length = 0;

    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });
    if (!res || !res.ok()) {
      throw new Error(`${route} returned ${res ? res.status() : 'no response'}`);
    }

    const findings: Finding[] = [];
    const addSignal = (id: string, label: string, detector: string, value: unknown, unmeasurable?: string) => {
      const node: GraphNode = {
        id, kind: 'signal', label, ref: detector, parent: surfaceId, value, unmeasurable,
      };
      graph.nodes[id] = node;
      graph.edges.push({ from: surfaceId, to: id, kind: 'contains' });
    };

    // ---- contrast --------------------------------------------------------
    const contrast = (await page.evaluate(CONTRAST_PROBE)) as any[];
    for (const c of contrast) {
      const id = `${surfaceId}::contrast::${c.selector}`;
      if (c.unmeasurable) {
        // Recorded on the graph so the gap is visible, but never raised as a
        // finding — we have no number, so there is nothing to assert.
        addSignal(id, c.selector, 'contrast', null, c.unmeasurable);
        continue;
      }
      addSignal(id, c.selector, 'contrast', c.ratio);
      // A passing signal is still a node — it is the thing that must not
      // regress when something near it is patched.
      if (c.pass) continue;
      findings.push({
        fingerprint: fp('contrast', route, c.selector, c.colour),
        nodeId: id,
        detector: 'contrast',
        severity: c.ratio < 3 ? 'blocker' : 'major',
        summary: `${c.selector} at ${c.ratio}:1 (needs ${c.threshold}:1)`,
        evidence: c,
      });
    }

    // ---- layout ----------------------------------------------------------
    const layout = (await page.evaluate(LAYOUT_PROBE)) as any;

    for (const c of layout.clipped) {
      const id = `${surfaceId}::clipped::${c.selector}`;
      addSignal(id, c.selector, 'clipped', { x: c.overflowX, y: c.overflowY });
      findings.push({
        fingerprint: fp('clipped', route, c.selector),
        nodeId: id,
        detector: 'clipped',
        severity: 'major',
        summary: `${c.selector} clips its content by ${Math.max(c.overflowX, c.overflowY)}px`,
        evidence: c,
      });
    }

    if (layout.overflow) {
      const id = `${surfaceId}::overflow`;
      addSignal(id, 'page', 'overflow', layout.overflow.scrollWidth);
      findings.push({
        fingerprint: fp('overflow', route),
        nodeId: id,
        detector: 'overflow',
        severity: 'major',
        summary: `Page scrolls horizontally (${layout.overflow.scrollWidth}px in ${layout.overflow.clientWidth}px)`,
        evidence: layout.overflow,
      });
    }

    for (const o of layout.overlaps) {
      const id = `${surfaceId}::overlap::${o.a}|${o.b}`;
      addSignal(id, `${o.a} × ${o.b}`, 'overlap', o.area);
      findings.push({
        fingerprint: fp('overlap', route, o.a, o.b),
        nodeId: id,
        detector: 'overlap',
        severity: 'blocker',
        summary: `${o.a} overlaps ${o.b} across ${o.area}px²`,
        evidence: o,
      });
    }

    for (const t of layout.smallTargets) {
      const id = `${surfaceId}::target::${t.selector}`;
      addSignal(id, t.selector, 'tap-target', { w: t.width, h: t.height });
      findings.push({
        fingerprint: fp('target', route, t.selector),
        nodeId: id,
        detector: 'tap-target',
        severity: 'minor',
        summary: `${t.selector} is ${t.width}×${t.height}, below the 24px minimum`,
        evidence: t,
      });
    }

    // ---- design ----------------------------------------------------------
    const design = (await page.evaluate(DESIGN_PROBE)) as any;

    const designFinding = (
      kind: string, key: string, severity: Finding['severity'],
      label: string, summary: string, evidence: Record<string, unknown>,
    ) => {
      const id = `${surfaceId}::${kind}::${key}`;
      addSignal(id, label, kind, evidence);
      findings.push({
        fingerprint: fp(kind, route, key),
        nodeId: id, detector: kind, severity, summary, evidence,
      });
    };

    for (const t of design.tracking) {
      designFinding('tracking', t.selector, 'minor', t.selector,
        `${t.selector} is ${t.fontSize}px with letter-spacing ${t.letterSpacing}; display type wants negative tracking (${t.suggested})`, t);
    }
    for (const l of design.leading) {
      designFinding('leading', l.selector, 'minor', l.selector,
        `${l.selector} is ${l.fontSize}px with line-height ${l.lineHeight}; large text wants tighter leading (~${l.suggested})`, l);
    }
    for (const m of design.nonCompositor) {
      designFinding('motion', m.selector, 'minor', m.selector,
        `${m.selector} transitions ${m.properties.join(', ')} — animate transform/opacity instead so the compositor can own the frame`, m);
    }
    for (const s of design.stackedTranslucency) {
      designFinding('translucency', `${s.outer}>${s.inner}`, 'major', s.inner,
        `${s.inner} stacks a translucent surface inside ${s.outer}; legibility collapses when blur compounds`, s);
    }
    if (design.reducedMotion) {
      designFinding('reduced-motion', 'page', 'major', 'page',
        'Page animates but has no prefers-reduced-motion rule', design.reducedMotion);
    }
    if (design.pressFeedback) {
      designFinding('press-feedback', 'page', 'minor', 'page',
        `${design.pressFeedback.controls} control(s) and no :active rule — feedback should land on press, not on release`, design.pressFeedback);
    }

    // ---- axe-core --------------------------------------------------------
    // Injected per visit: axe attaches to window, and a page navigation
    // discards it along with everything else.
    try {
      await page.addScriptTag({ content: axeSource() });
      const violations = (await page.evaluate(AXE_RUN)) as any[];

      for (const v of violations) {
        const id = `${surfaceId}::axe::${v.rule}::${v.selector}`;
        addSignal(id, `${v.rule} ${v.selector}`, 'axe', v.impact);
        findings.push({
          fingerprint: fp('axe', route, v.rule, v.selector),
          nodeId: id,
          detector: `a11y:${v.rule}`,
          severity: severityOf(v.impact),
          summary: `${v.selector}: ${v.help}`,
          evidence: v,
        });
      }
    } catch (err) {
      // A failed injection is a gap in coverage, not a clean bill of health.
      // Saying so out loud beats a silent zero.
      findings.push({
        fingerprint: fp('axe-unavailable', route),
        nodeId: `${surfaceId}::axe-unavailable`,
        detector: 'axe-unavailable',
        severity: 'minor',
        summary: `Accessibility rules did not run on ${route}: ${(err as Error).message}`,
        evidence: { error: (err as Error).message },
      });
    }

    // ---- console ---------------------------------------------------------
    for (const err of dedupe(errors)) {
      const id = `${surfaceId}::console::${fp(err)}`;
      addSignal(id, err.slice(0, 40), 'console', err);
      findings.push({
        fingerprint: fp('console', route, err),
        nodeId: id,
        detector: 'console',
        severity: 'blocker',
        summary: `Console error: ${err.slice(0, 90)}`,
        evidence: { message: err },
      });
    }

    return findings;
  }
}

const dedupe = (xs: string[]) => Array.from(new Set(xs));
