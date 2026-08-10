import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { relative } from 'node:path';
import type { Finding, Patch } from '../types.js';
import { resolveSelector } from './sourcemap.js';

/**
 * Turns a finding into concrete candidate edits against real source files.
 *
 * Every patch is an exact string replacement anchored on text that is known
 * to exist in the file. Nothing here rewrites a file wholesale or reformats
 * around the change — the smallest edit that could clear the finding is the
 * only one worth verifying, because a large edit makes the verify step
 * unable to attribute the result.
 */
export async function proposePatches(finding: Finding, sourceRoot: string): Promise<Patch[]> {
  switch (finding.detector) {
    case 'contrast': return contrastPatches(finding, sourceRoot);
    case 'tap-target': return tapTargetPatches(finding, sourceRoot);
    case 'clipped': return clippedPatches(finding, sourceRoot);
    case 'tracking': return trackingPatches(finding, sourceRoot);
    case 'leading': return leadingPatches(finding, sourceRoot);
    case 'reduced-motion': return reducedMotionPatches(finding, sourceRoot);
    default:
      // Console errors, overlaps, what a transition should animate instead,
      // and what pressed feedback should look like all need reasoning about
      // intent. No mechanical rule covers them, so they go to the model if
      // one is configured and to a human if not.
      return [];
  }
}

// -------------------------------------------------------------- colour maths

interface RGB { r: number; g: number; b: number }

const parseHex = (hex: string): RGB | null => {
  const m = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
};

const toHex = ({ r, g, b }: RGB) =>
  '#' + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c)))
    .toString(16).padStart(2, '0')).join('');

const parseRGBString = (s: string): RGB | null => {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((x) => parseFloat(x.trim()));
  return { r, g, b };
};

const luminance = ({ r, g, b }: RGB) => {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const contrastRatio = (a: RGB, b: RGB) => {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/**
 * Walk the foreground toward black or white — whichever direction the
 * backdrop demands — until the threshold is met, keeping the hue.
 *
 * The point is the *smallest* change that passes. Snapping straight to
 * black or white passes the check and wrecks the palette, which is how
 * automated contrast fixes get reverted by designers.
 */
function correct(fg: RGB, bg: RGB, threshold: number): RGB | null {
  const towardDark = luminance(bg) > 0.5;
  const target: RGB = towardDark ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };

  let lo = 0, hi = 1, best: RGB | null = null;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    const trial: RGB = {
      r: fg.r + (target.r - fg.r) * t,
      g: fg.g + (target.g - fg.g) * t,
      b: fg.b + (target.b - fg.b) * t,
    };
    if (contrastRatio(trial, bg) >= threshold) { best = trial; hi = t; }
    else lo = t;
  }
  // A small safety margin, so a rounding difference in the browser does not
  // put it back under the line and make the patch look ineffective.
  if (best && contrastRatio(best, bg) < threshold + 0.05) {
    const t = Math.min(1, hi + 0.04);
    best = {
      r: fg.r + (target.r - fg.r) * t,
      g: fg.g + (target.g - fg.g) * t,
      b: fg.b + (target.b - fg.b) * t,
    };
  }
  return best;
}

// -------------------------------------------------------------- style sources

const STYLE_GLOB = '**/*.{css,scss,ts,tsx,js,jsx}';

async function styleFiles(sourceRoot: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of glob(STYLE_GLOB, { cwd: sourceRoot, withFileTypes: true })) {
    const rel = relative(sourceRoot, `${entry.parentPath}/${entry.name}`);
    if (/(^|[\\/])(node_modules|dist|build|\.git|\.kintsugi)([\\/]|$)/.test(rel)) continue;
    out.push(`${entry.parentPath}/${entry.name}`);
  }
  return out;
}

// -------------------------------------------------------------- per-detector

async function contrastPatches(finding: Finding, sourceRoot: string): Promise<Patch[]> {
  const { colour, backdrop, threshold } = finding.evidence as {
    colour: string; backdrop: string; threshold: number;
  };
  const fg = parseRGBString(colour);
  const bg = parseRGBString(backdrop);
  if (!fg || !bg) return [];

  const fixed = correct(fg, bg, threshold);
  if (!fixed) return [];
  const fixedHex = toHex(fixed);
  const currentHex = toHex(fg);

  // Find where that colour is actually declared. A hex literal in the source
  // is the honest anchor; a computed rgb() string never appears verbatim.
  const tokenPatches: Patch[] = [];
  const patches: Patch[] = [];
  for (const file of await styleFiles(sourceRoot)) {
    const text = await readFile(file, 'utf8');

    // A custom-property declaration is the tempting anchor — one edit fixes
    // every use. That is exactly why it is not applied automatically: a
    // shared token failing across an app is a design decision, not a defect,
    // and retinting it changes the product everywhere it appears. The patch
    // is still produced so the owner can see the exact edit and the number
    // behind it; the loop reports it instead of committing it.
    const tokenRe = new RegExp(`(--[\\w-]+)\\s*:\\s*(${currentHex})\\b`, 'i');
    const token = text.match(tokenRe);
    if (token) {
      const uses = await countTokenUses(token[1], sourceRoot);
      // A token used in one place is component-scoped in everything but
      // spelling — escalating it would be caution as theatre. The decision
      // only belongs to a human once changing it moves the product.
      const shared = uses > 1;
      tokenPatches.push({
        id: randomUUID().slice(0, 8),
        file,
        find: token[0],
        replace: `${token[1]}: ${fixedHex}`,
        scope: shared ? 'token' : 'component',
        blastRadius: uses,
        rationale: shared
          ? `Token ${token[1]} is ${currentHex} (${(finding.evidence as any).ratio}:1 on this surface). ` +
            `${fixedHex} would reach ${threshold}:1 — but ${token[1]} is referenced in ${uses} place(s), ` +
            `so this is a palette change, not a fix.`
          : `Token ${token[1]} is ${currentHex} (${(finding.evidence as any).ratio}:1 on this surface) and is used ` +
            `in one place, so this is local. ${fixedHex} reaches ${threshold}:1 while holding the hue.`,
      });
      continue;
    }

    // Otherwise patch the literal where it is used.
    const idx = text.toLowerCase().indexOf(currentHex.toLowerCase());
    if (idx !== -1) {
      const line = text.slice(text.lastIndexOf('\n', idx) + 1, text.indexOf('\n', idx));
      patches.push({
        id: randomUUID().slice(0, 8),
        file,
        find: line,
        replace: line.replace(new RegExp(currentHex, 'i'), fixedHex),
        rationale: `Literal ${currentHex} fails at ${(finding.evidence as any).ratio}:1; ` +
          `${fixedHex} clears ${threshold}:1.`,
      });
    }
  }

  // If a token declares this exact colour, that token is where the element's
  // colour comes from. Some other file containing the same hex is a
  // coincidence, not the source — patching it cannot clear the finding, and
  // offering it as a fallback just burns iterations reverting an edit to an
  // unrelated component.
  return tokenPatches.length ? tokenPatches : patches;
}

async function tapTargetPatches(finding: Finding, sourceRoot: string): Promise<Patch[]> {
  const { selector } = finding.evidence as { selector: string };
  const cls = selector.split('.')[1];
  const rule = await findRule(selector, sourceRoot);
  if (!rule) return [];
  const { file, open: m0, body } = rule;
  // The authoring name, not the runtime one — a rationale that says
  // `._forgot_penvp_415` names a string that exists in no source file.
  const name = rule.localClass ?? cls ?? selector;
  const scope: Patch['scope'] = rule.appWide ? 'global' : 'component';
  const wide = rule.appWide
    ? ` This is the bare \`${selector}\` element rule, so it would resize every ${selector} in the product.`
    : '';
  const patches: Patch[] = [];

  {
    // Preferred: raise the undersized declarations that are actually causing
    // it. Adding a min-* floor beside a smaller width works, but leaves two
    // declarations disagreeing about the size for the next person to untangle.
    //
    // Both axes move in one patch. Raising them separately fails the verify
    // step for the honest reason that a 24×18 target is still too small, and
    // the loop would discard a fix that was halfway right.
    let fixed = body;
    const raised: string[] = [];
    for (const axis of ['width', 'height'] as const) {
      const d = fixed.match(new RegExp(`(^|\\n)(\\s*)${axis}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\s*;`));
      if (d && parseFloat(d[3]) < 24) {
        fixed = fixed.replace(d[0], `${d[1]}${d[2]}${axis}: 24px;`);
        raised.push(`${axis}:${d[3]}px`);
      }
    }
    if (raised.length) {
      patches.push({
        id: randomUUID().slice(0, 8),
        file,
        find: body,
        replace: fixed,
        scope,
        rationale: `${name} sets ${raised.join(' and ')}, under the 24px minimum target size. ` +
          `Raising the declarations themselves keeps one source of truth for the size.${wide}`,
      });
    }

    // Fallback for rules with no explicit size — the element is being sized
    // by its content, so a floor is the only safe lever.
    patches.push({
      id: randomUUID().slice(0, 8),
      file,
      find: m0,
      replace: `${m0}\n  min-width: 24px;\n  min-height: 24px;`,
      scope,
      rationale: `${name} renders below the 24×24 minimum target size; ` +
        `a min-width/min-height floor fixes it without changing layout at larger sizes.${wide}`,
    });
  }
  return patches;
}

/**
 * Locate the CSS rule that owns a selector. Handles both element selectors
 * (`h1`) and the class form the detectors report (`h1.display`) — the class
 * is the more specific anchor, so it is tried first.
 */
interface FoundRule {
  file: string;
  text: string;
  open: string;
  body: string;
  /** Authoring class name, when the anchor is a class rule. */
  localClass?: string;
  /**
   * True when the anchor is a bare element rule (`a { }`) rather than a class.
   * Editing one changes every element of that kind in the product, so the
   * healers downgrade these to an escalation instead of applying them.
   */
  appWide: boolean;
}

async function findRule(selector: string, sourceRoot: string): Promise<FoundRule | null> {
  // First ask the source map. On a CSS-Modules app the DOM reports a scoped
  // name like `_forgot_penvp_415` while the file says `.forgot` — grepping the
  // runtime name finds nothing, which is why every non-token healer came up
  // empty on real apps.
  const mapped = await resolveSelector(selector, sourceRoot);
  if (mapped) {
    const text = await readFile(mapped.file, 'utf8');
    return {
      file: mapped.file, text, open: mapped.ruleOpen, body: mapped.ruleBody,
      localClass: mapped.localClass, appWide: false,
    };
  }

  // Plain stylesheets, where the authoring name is the runtime name.
  const cls = selector.split('.')[1];
  const tag = selector.split(/[.#]/)[0];
  const candidates: { pattern: string; appWide: boolean; local?: string }[] = [];
  if (cls) candidates.push({ pattern: `\\.${cls}`, appWide: false, local: cls });
  if (tag) candidates.push({ pattern: tag, appWide: true });

  for (const file of await styleFiles(sourceRoot)) {
    const text = await readFile(file, 'utf8');
    for (const c of candidates) {
      const m = text.match(new RegExp(`(^|[,}\\s])(${c.pattern})\\s*\\{`, 'm'));
      if (!m) continue;
      const open = m[0].slice(m[0].indexOf(m[2]));
      const start = text.indexOf(open);
      const body = text.slice(start, text.indexOf('}', start));
      return { file, text, open, body, localClass: c.local, appWide: c.appWide };
    }
  }
  return null;
}

async function trackingPatches(finding: Finding, sourceRoot: string): Promise<Patch[]> {
  const { selector, fontSize, suggested } = finding.evidence as
    { selector: string; fontSize: number; suggested: string };
  const rule = await findRule(selector, sourceRoot);
  if (!rule) return [];

  // -0.02em rather than the computed px value: tracking must scale with the
  // size it is applied to, and a px value silently stops being correct the
  // moment someone changes the font size.
  if (/letter-spacing\s*:/.test(rule.body)) return [];
  return [{
    id: randomUUID().slice(0, 8),
    file: rule.file,
    find: rule.open,
    replace: `${rule.open}\n  letter-spacing: -0.02em;`,
    rationale: `${selector} renders at ${fontSize}px with no tracking; display type reads too loose as it grows. ` +
      `-0.02em (~${suggested} here) tightens it and keeps scaling with the size.`,
  }];
}

async function leadingPatches(finding: Finding, sourceRoot: string): Promise<Patch[]> {
  const { selector, fontSize, lineHeight, suggested } = finding.evidence as
    { selector: string; fontSize: number; lineHeight: number; suggested: number };
  const rule = await findRule(selector, sourceRoot);
  if (!rule) return [];

  const existing = rule.body.match(/(^|\n)(\s*)line-height\s*:\s*[^;]+;/);
  if (existing) {
    return [{
      id: randomUUID().slice(0, 8),
      file: rule.file,
      find: existing[0],
      replace: `${existing[1]}${existing[2]}line-height: ${suggested};`,
      rationale: `${selector} is ${fontSize}px at line-height ${lineHeight}. Leading tracks size inversely — ` +
        `large text wants it tight, so ${suggested} suits this size.`,
    }];
  }
  return [{
    id: randomUUID().slice(0, 8),
    file: rule.file,
    find: rule.open,
    replace: `${rule.open}\n  line-height: ${suggested};`,
    rationale: `${selector} is ${fontSize}px and inherits loose leading; ${suggested} suits display type.`,
  }];
}

async function reducedMotionPatches(_finding: Finding, sourceRoot: string): Promise<Patch[]> {
  const files = await styleFiles(sourceRoot);

  // A reduced-motion block is global, so it has to land in a global
  // stylesheet. Dropping `*` selectors into a CSS Module would scope and
  // hash them — the rule would look right in the diff and do nothing.
  const plain = files.filter((f) => /\.(css|scss)$/.test(f) && !/\.module\.(css|scss)$/.test(f));
  const target =
    plain.find((f) => /[\\/](index|global|app|main|styles)\.(css|scss)$/i.test(f)) ??
    plain[0];
  if (!target) return [];

  const text = await readFile(target, 'utf8');
  // Must match the at-rule, not the bare token: a comment mentioning
  // prefers-reduced-motion is not an implementation of it, and a substring
  // test reads any discussion of the defect as the defect being fixed.
  if (/@media[^{]*prefers-reduced-motion/.test(text)) return [];

  // The block must land at the *end* of the file, where a media query can
  // actually override what precedes it. A bare "}" would match the first
  // rule's closing brace instead, so the anchor is grown backwards until it
  // occurs exactly once.
  const anchor = uniqueTail(text);
  if (!anchor) return [];

  return [{
    id: randomUUID().slice(0, 8),
    file: target,
    find: anchor,
    replace: `${anchor}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}`,
    rationale: `The page animates but never checks prefers-reduced-motion. Reduced motion means a gentler ` +
      `equivalent rather than no feedback, so this collapses duration instead of removing the transitions — ` +
      `state changes still read, they just stop moving.`,
  }];
}

/**
 * The shortest suffix of `text` that appears in it exactly once.
 *
 * Patches are applied to the first match, so an append is only safe if its
 * anchor is unique — otherwise "add this at the end" silently becomes "add
 * this in the middle". Grows from the final closing brace backwards.
 */
function uniqueTail(text: string): string | null {
  const brace = text.lastIndexOf('}');
  if (brace === -1) return null;

  for (let start = brace; start >= 0; start -= 20) {
    const candidate = text.slice(start);
    if (text.indexOf(candidate) === text.lastIndexOf(candidate)) return candidate;
  }
  return null;
}

async function clippedPatches(finding: Finding, sourceRoot: string): Promise<Patch[]> {
  const { selector, overflowX } = finding.evidence as { selector: string; overflowX: number };
  const cls = selector.split('.')[1];
  // Only horizontal clipping of text has a safe mechanical fix. Vertical
  // clipping usually means a fixed height that is someone's deliberate
  // choice, and overriding it silently is worse than reporting it.
  if (overflowX <= 1) return [];

  const rule = await findRule(selector, sourceRoot);
  if (!rule) return [];

  return [{
    id: randomUUID().slice(0, 8),
    file: rule.file,
    find: rule.open,
    replace: `${rule.open}\n  min-width: 0;\n  overflow-wrap: anywhere;`,
    scope: rule.appWide ? 'global' : 'component',
    rationale: `${rule.localClass ?? cls ?? selector} clips ${overflowX}px horizontally. ` +
      `min-width:0 lets the flex/grid child actually shrink, and overflow-wrap ` +
      `breaks the long token that is forcing the width.` +
      (rule.appWide ? ` This is the bare \`${selector}\` element rule, affecting every one in the product.` : ''),
  }];
}

/** How many places reference a design token. Drives the blast-radius warning. */
async function countTokenUses(token: string, sourceRoot: string): Promise<number> {
  let n = 0;
  const needle = `var(${token})`;
  for (const file of await styleFiles(sourceRoot)) {
    const text = await readFile(file, 'utf8');
    let i = text.indexOf(needle);
    while (i !== -1) { n++; i = text.indexOf(needle, i + needle.length); }
  }
  return n;
}
