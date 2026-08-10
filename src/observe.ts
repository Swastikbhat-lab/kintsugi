import { createHash } from 'node:crypto';
import { type Page } from 'playwright';
import { openBrowser, type BrowserHandle } from './browser.js';
import type { RunConfig, UIGraph, Finding, GraphNode } from './types.js';
import { contrastProbe } from './detectors/contrast.js';
import { layoutProbe } from './detectors/layout.js';
import { designProbe, THEME_SIGNATURE } from './detectors/design.js';
import { resolvePolicy, provenance, type Policy } from './policy.js';
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

  /** The colour schemes to measure under; the page's own default when unset. */
  private get themes(): (('light' | 'dark') | null)[] {
    return this.config.themes?.length ? this.config.themes : [null];
  }

  /**
   * Records whether emulating a scheme actually changed anything, per route.
   *
   * `prefers-color-scheme` emulation only works on apps that honour the media
   * query. An app whose theme is driven by a class or a stored preference
   * will not budge, and reporting "measured both themes" when both
   * measurements were of the same theme is worse than not measuring twice.
   */
  private themeTookEffect = new Map<string, boolean>();

  /**
   * Theme signature per `route::theme`, captured immediately after load.
   *
   * Timing matters more than it looks. Taken later, the signature reflects
   * whatever else has happened to the page — axe-core injected, lazy content
   * arrived — and two loads of the same page stop matching, so the run
   * concludes the themes differ when only the timing did.
   */
  private signatures = new Map<string, string>();

  constructor(private config: RunConfig) {
    this.policy = resolvePolicy(config.policy);
  }

  /** The standard being enforced; every finding cites it. */
  readonly policy: Policy;

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

  private async pageFor(route: string, theme: 'light' | 'dark' | null) {
    // Keyed by theme as well as route: a page carries its emulated scheme, and
    // reusing one across themes would silently measure the wrong one.
    const key = `${theme ?? 'default'}::${route}`;
    const existing = this.pages.get(key);
    if (existing) return existing;
    if (!this.handle) throw new Error('Observer not opened');

    // Via the handle, so the page lands in the signed-in context. Playwright's
    // browser.newPage() would silently make a fresh context with an empty
    // cookie jar, putting us straight back to auditing the login screen.
    const page = await this.handle.newPage({ viewport: { width: 1280, height: 800 } });
    if (theme) await page.emulateMedia({ colorScheme: theme });
    const entry = { page, errors: [] as string[] };
    page.on('console', (m) => { if (m.type() === 'error') entry.errors.push(m.text()); });
    page.on('pageerror', (e) => entry.errors.push(e.message));
    this.pages.set(key, entry);
    return entry;
  }

  /**
   * Observe one route, under every configured colour scheme. This is the unit
   * the work graph fans out over.
   */
  async sweepRoute(route: string): Promise<{ graph: UIGraph; findings: Finding[] }> {
    const graph: UIGraph = { nodes: {}, edges: [] };
    const signatures = new Map<string, string>();
    const perTheme: { theme: 'light' | 'dark' | null; found: Finding[] }[] = [];

    for (const theme of this.themes) {
      const surfaceId = theme ? `surface:${route}@${theme}` : `surface:${route}`;
      graph.nodes[surfaceId] = {
        id: surfaceId, kind: 'surface',
        label: theme ? `${route} (${theme})` : route, ref: route,
      };
      perTheme.push({ theme, found: await this.visit(route, surfaceId, graph, theme) });
      if (theme) {
        const sig = this.signatures.get(`${route}::${theme}`);
        if (sig) signatures.set(theme, sig);
      }
    }

    const themesDiffer = new Set(signatures.values()).size > 1;

    // When every scheme rendered the same page, the extra passes measured the
    // same thing and their findings are duplicates. Reporting each defect once
    // per theme would double the count for no information, so only the first
    // pass is kept and the situation is reported once, below.
    const findings: Finding[] = signatures.size > 1 && !themesDiffer
      ? perTheme[0].found
      : perTheme.flatMap((p) => p.found);

    // If every scheme rendered the same page background, the app is not
    // driven by prefers-color-scheme and only one theme was really measured.
    // Say so rather than letting a doubled run imply doubled coverage.
    if (signatures.size > 1) {
      this.themeTookEffect.set(route, themesDiffer);
      if (!themesDiffer) {
        const id = `surface:${route}::theme-not-emulated`;
        graph.nodes[id] = {
          id, kind: 'signal', label: 'theme emulation', ref: 'theme',
          parent: `surface:${route}@${this.themes[0]}`,
          unmeasurable: 'prefers-color-scheme had no effect',
        };
        findings.push({
          // Route-scoped, not theme-scoped: this says something about the
          // route as a whole rather than about one rendering of it.
          fingerprint: fp('theme-not-emulated', route),
          nodeId: id,
          detector: 'theme-not-emulated',
          severity: 'minor',
          summary: `${route} rendered identically under light and dark — the app does not follow ` +
            `prefers-color-scheme, so only one theme was actually measured`,
          evidence: { schemes: [...signatures.keys()] },
        });
      }
    }

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
    const surfaceId = nodeId.split('::')[0];
    const spec = surfaceId.replace(/^surface:/, '');
    // Surfaces are `route` or `route@theme`; re-measuring has to reproduce the
    // same scheme or the comparison is against a different rendering.
    const at = spec.lastIndexOf('@');
    const theme = at !== -1 && (spec.slice(at + 1) === 'light' || spec.slice(at + 1) === 'dark')
      ? (spec.slice(at + 1) as 'light' | 'dark')
      : null;
    const route = theme ? spec.slice(0, at) : spec;

    const scratch: UIGraph = { nodes: {}, edges: [] };
    scratch.nodes[surfaceId] = {
      id: surfaceId, kind: 'surface', label: spec, ref: route,
    };
    return this.visit(route, surfaceId, scratch, theme);
  }

  private async visit(
    route: string,
    surfaceId: string,
    graph: UIGraph,
    theme: 'light' | 'dark' | null,
  ): Promise<Finding[]> {
    const { page, errors } = await this.pageFor(route, theme);
    // Fingerprint scope: a defect present only in dark mode is a different
    // defect from the same selector passing in light, and conflating them
    // means fixing one appears to fix both.
    const scope = theme ? `${route}@${theme}` : route;
    // Reported alongside every summary, because "2.1:1" is not actionable
    // until you know which theme it was measured in.
    const inTheme = theme ? ` [${theme}]` : '';

    // Captured here, before any detector has touched the page, so the two
    // themes are compared at the same point in each page's life.
    if (theme) {
      this.signatures.set(`${route}::${theme}`, await page.evaluate(THEME_SIGNATURE) as string);
    }
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
    const contrast = (await page.evaluate(contrastProbe(this.policy.rules))) as any[];
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
        fingerprint: fp('contrast', scope, c.selector, c.colour),
        nodeId: id,
        detector: 'contrast',
        severity: c.ratio < 3 ? 'blocker' : 'major',
        summary: `${c.selector} at ${c.ratio}:1 (needs ${c.threshold}:1)` + inTheme,
        evidence: { ...c, ...provenance(this.policy, 'contrastNormal') },
      });
    }

    // ---- layout ----------------------------------------------------------
    const layout = (await page.evaluate(layoutProbe(this.policy.rules))) as any;

    for (const c of layout.clipped) {
      const id = `${surfaceId}::clipped::${c.selector}`;
      addSignal(id, c.selector, 'clipped', { x: c.overflowX, y: c.overflowY });
      findings.push({
        fingerprint: fp('clipped', scope, c.selector),
        nodeId: id,
        detector: 'clipped',
        severity: 'major',
        summary: `${c.selector} clips its content by ${Math.max(c.overflowX, c.overflowY)}px` + inTheme,
        evidence: c,
      });
    }

    if (layout.overflow) {
      const id = `${surfaceId}::overflow`;
      addSignal(id, 'page', 'overflow', layout.overflow.scrollWidth);
      findings.push({
        fingerprint: fp('overflow', scope),
        nodeId: id,
        detector: 'overflow',
        severity: 'major',
        summary: `Page scrolls horizontally (${layout.overflow.scrollWidth}px in ${layout.overflow.clientWidth}px)` + inTheme,
        evidence: layout.overflow,
      });
    }

    for (const o of layout.overlaps) {
      const id = `${surfaceId}::overlap::${o.a}|${o.b}`;
      addSignal(id, `${o.a} × ${o.b}`, 'overlap', o.area);
      findings.push({
        fingerprint: fp('overlap', scope, o.a, o.b),
        nodeId: id,
        detector: 'overlap',
        severity: 'blocker',
        summary: `${o.a} overlaps ${o.b} across ${o.area}px²` + inTheme,
        evidence: o,
      });
    }

    for (const t of layout.smallTargets) {
      const id = `${surfaceId}::target::${t.selector}`;
      addSignal(id, t.selector, 'tap-target', { w: t.width, h: t.height });
      findings.push({
        fingerprint: fp('target', scope, t.selector),
        nodeId: id,
        detector: 'tap-target',
        severity: 'minor',
        // The threshold is quoted from the active profile rather than written
        // in. A message that always says 24px while the profile enforces 44
        // is how two sources of truth start disagreeing in the same report.
        summary: `${t.selector} is ${t.width}×${t.height}, below the ` +
          `${this.policy.rules.tapTarget}px minimum (${this.policy.label})` + inTheme,
        evidence: { ...t, ...provenance(this.policy, 'tapTarget') },
      });
    }

    // ---- design ----------------------------------------------------------
    const design = (await page.evaluate(designProbe(this.policy.rules))) as any;

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
          fingerprint: fp('axe', scope, v.rule, v.selector),
          nodeId: id,
          detector: `a11y:${v.rule}`,
          severity: severityOf(v.impact),
          summary: `${v.selector}: ${v.help}` + inTheme,
          evidence: v,
        });
      }
    } catch (err) {
      // A failed injection is a gap in coverage, not a clean bill of health.
      // Saying so out loud beats a silent zero.
      findings.push({
        fingerprint: fp('axe-unavailable', scope),
        nodeId: `${surfaceId}::axe-unavailable`,
        detector: 'axe-unavailable',
        severity: 'minor',
        summary: `Accessibility rules did not run on ${route}: ${(err as Error).message}` + inTheme,
        evidence: { error: (err as Error).message },
      });
    }

    // ---- console ---------------------------------------------------------
    for (const err of dedupe(errors)) {
      const id = `${surfaceId}::console::${fp(err)}`;
      addSignal(id, err.slice(0, 40), 'console', err);
      findings.push({
        fingerprint: fp('console', scope, err),
        nodeId: id,
        detector: 'console',
        severity: 'blocker',
        summary: `Console error: ${err.slice(0, 90)}` + inTheme,
        evidence: { message: err },
      });
    }

    return findings;
  }
}

const dedupe = (xs: string[]) => Array.from(new Set(xs));
