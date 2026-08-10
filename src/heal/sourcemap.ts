import { glob, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Maps a class name the browser reported back to the rule that authored it.
 *
 * The measurement side of Kintsugi only ever sees *runtime* names — the DOM
 * says `a._forgot_penvp_415` because a CSS Modules build rewrote every local
 * class on its way out. The repair side only ever sees *authoring* names —
 * `AuthLayout.module.css` says `.forgot {`. Grepping the source for the
 * runtime name finds nothing, so without this translation every finding on a
 * CSS-Modules component dies as "no source found".
 *
 * Two things make this safe rather than clever:
 *
 * 1. Patches are applied by replacing the *first* occurrence of a string, so
 *    an anchor that appears twice silently edits the wrong rule. Every
 *    `ruleOpen` handed back here is checked to occur exactly once, and grown
 *    backwards through the file until it does.
 * 2. Nothing is inferred. A class that does not match a known scoping shape
 *    resolves to null rather than to a best guess, and an authoring name that
 *    matches two plausible rules resolves to null rather than to the first
 *    one. A wrong location produces a confident patch to unrelated code,
 *    which is worse for the caller than an honest gap.
 */

export interface SourceRule {
  /** Absolute path to the stylesheet that declares the rule. */
  file: string;
  /** Authoring name, e.g. `forgot`. */
  localClass: string;
  /**
   * Exact text that opens the rule, verbatim from the file and occurring in
   * it exactly once. Usually just `.forgot {`; where that substring is not
   * unique (the same class overridden inside a media query, say) it carries
   * enough preceding text to disambiguate.
   */
  ruleOpen: string;
  /** From `ruleOpen` up to, but not including, the rule's closing brace. */
  ruleBody: string;
}

// ------------------------------------------------------------------- shapes

/**
 * Vite's default `generateScopedName`, verbatim from
 * `postcss-modules`' `makeDefaultScopedNameGenerator`:
 *
 *   const i = css.indexOf(`.${name}`);
 *   const lineNumber = css.substr(0, i).split(/[\r\n]/).length;
 *   `_${name}_${stringHash(css).toString(36).substr(0, 5)}_${lineNumber}`
 *
 * Three details matter and were confirmed against the real app rather than
 * assumed. The hash is over the *whole file text*, so it identifies which
 * stylesheet a class came from with no filename involved. The line counter
 * splits on `\r` or `\n` individually, so a CRLF file counts two per line —
 * `.forgot` on line 208 becomes `_forgot_penvp_415`, not `_forgot_penvp_208`.
 * And the position comes from a plain `indexOf`, so a class whose name is a
 * prefix of another (`.dashboardTitle` vs `.dashboardTitleLead`) reports
 * whichever text appears first.
 *
 * Because the whole thing is reproducible, `resolveClass` does not have to
 * infer the source file — it recomputes the scoped name and compares. That is
 * proof, not a heuristic.
 */
const VITE_SCOPED = /^_(.+)_([A-Za-z0-9]{3,10})_(\d+)$/;

/** css-loader's default, `[name]__[local]___[hash]`. */
const LOADER_SCOPED = /^(.+?)__(.+?)___([A-Za-z0-9_-]+)$/;

/** The bare `[local]_[hash]` form. */
const SHORT_SCOPED = /^([A-Za-z][A-Za-z0-9_-]*)_([A-Za-z0-9]{5,8})$/;

/** Anything outside this cannot be a CSS Modules local name. */
const LOCAL_CHARS = /^[A-Za-z0-9_-]+$/;

interface Scoped {
  kind: 'vite' | 'loader' | 'short';
  local: string;
  hash: string;
  /** Only the Vite shape carries one. */
  line?: number;
}

/**
 * Tailwind utilities are authored inline in the JSX and are emitted by the
 * engine, not by a rule anyone can edit — `absolute`, `top-1/2` and `text-sm`
 * have no source declaration to patch, and rewriting the JSX to change one is
 * a different and much larger decision than editing a stylesheet.
 *
 * They are also structurally distinguishable, which is what actually keeps
 * them out: every scoping shape above requires an underscore, and a utility
 * only contains one inside an arbitrary value (`grid-cols-[1fr_500px]`),
 * which brings brackets along with it. The explicit test is here so the
 * intent is legible at the call site rather than implied by a regex.
 */
function isUtilityClass(cls: string): boolean {
  if (!LOCAL_CHARS.test(cls)) return true;
  return !cls.includes('_');
}

function parseScoped(runtimeClass: string): Scoped | null {
  const cls = runtimeClass.trim();
  if (!cls || isUtilityClass(cls)) return null;

  // `___` first: the css-loader shape also contains the single underscores
  // the other two patterns key on, so testing it later would mis-split it.
  const loader = cls.match(LOADER_SCOPED);
  if (loader) return { kind: 'loader', local: loader[2], hash: loader[3] };

  // Greedy on the local so `_a_b_c_1x2y3_44` keeps `a_b_c` together — the
  // hash and line are always the last two segments.
  const vite = cls.match(VITE_SCOPED);
  if (vite) return { kind: 'vite', local: vite[1], hash: vite[2], line: Number(vite[3]) };

  const short = cls.match(SHORT_SCOPED);
  // A trailing segment with no digit in it is far more likely to be a word
  // than a hash — `field_label` is an authoring name, not a scoped one, and
  // reading it as `field` would send the healer looking for the wrong rule.
  if (short && /\d/.test(short[2])) return { kind: 'short', local: short[1], hash: short[2] };

  return null;
}

/** Turn one runtime class into its authoring name, or null if it isn't a known hashed form. */
export function unhashClass(runtimeClass: string): string | null {
  return parseScoped(runtimeClass)?.local ?? null;
}

// -------------------------------------------------------------- scoped names

/** `string-hash@1.1.3`, the hash postcss-modules feeds its scoped names. */
function stringHash(text: string): number {
  let h = 5381;
  let i = text.length;
  while (i) h = (h * 33) ^ text.charCodeAt(--i);
  return h >>> 0;
}

const cssHash = (css: string) => stringHash(css).toString(36).slice(0, 5);

/** The scoped name Vite would emit for `local` in this stylesheet, or null. */
function viteScopedName(css: string, local: string, hash: string): string | null {
  const at = css.indexOf(`.${local}`);
  if (at === -1) return null;
  return `_${local}_${hash}_${css.slice(0, at).split(/[\r\n]/).length}`;
}

const LOCAL_IN_CSS = /(?:^|[^\\])\.([A-Za-z_][A-Za-z0-9_-]*)/g;

/**
 * Which authoring name in this stylesheet actually produces `runtimeClass`.
 *
 * Parsing the runtime name is a guess whenever the local contains underscores
 * of its own. Rebuilding each candidate name and comparing is not — only the
 * real local reproduces the observed string, line number included.
 */
function reconstructLocal(css: string, runtimeClass: string, hash: string): string | null {
  const seen = new Set<string>();
  for (const m of css.matchAll(LOCAL_IN_CSS)) {
    const local = m[1];
    if (seen.has(local)) continue;
    seen.add(local);
    if (viteScopedName(css, local, hash) === runtimeClass) return local;
  }
  return null;
}

// ------------------------------------------------------------------ scanning

interface RawRule {
  /** Selector list as written, comments and line breaks intact. */
  selector: string;
  /** Index of the first character of the selector. */
  start: number;
  /** Index just past the opening brace. */
  openEnd: number;
  /** Index of the matching closing brace. */
  close: number;
  /** 0 for a top-level rule, 1 inside `@media`, and so on. */
  depth: number;
}

function skipQuoted(text: string, at: number): number {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    // A CSS string cannot span a line; treating one as unterminated stops a
    // stray apostrophe in a comment from swallowing the rest of the file.
    if (c === '\n') return i;
    i++;
  }
  return text.length;
}

/**
 * Every brace-delimited block in the file, with the exact source offsets of
 * its selector and braces.
 *
 * A regex would be shorter and would also match `.forgot {` inside a comment,
 * inside `content: ".forgot {"`, and inside `.btn.forgot {` where the offset
 * would point into the middle of a compound selector. All three produce an
 * anchor that patches something other than the rule it names, so the scan
 * tracks comments, strings and nesting instead.
 */
function scanRules(text: string): RawRule[] {
  const rules: RawRule[] = [];
  const open: RawRule[] = [];
  let i = 0;
  let seg = 0;

  while (i < text.length) {
    const c = text[i];

    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const next = end === -1 ? text.length : end + 2;
      // A comment above a rule is not part of its selector; one spliced into
      // the middle of a selector list is, so only leading ones are dropped.
      if (!text.slice(seg, i).trim()) seg = next;
      i = next;
      continue;
    }

    if (c === '"' || c === "'") { i = skipQuoted(text, i); continue; }

    if (c === '{') {
      const raw = text.slice(seg, i);
      const rule: RawRule = {
        selector: raw.trim(),
        start: seg + (raw.length - raw.trimStart().length),
        openEnd: i + 1,
        close: -1,
        depth: open.length,
      };
      rules.push(rule);
      open.push(rule);
      i++;
      seg = i;
      continue;
    }

    if (c === '}') {
      const rule = open.pop();
      if (rule) rule.close = i;
      i++;
      seg = i;
      continue;
    }

    // A declaration ends the current prelude candidate, so `color: red;`
    // never gets glued onto the front of the next selector.
    if (c === ';') { i++; seg = i; continue; }

    i++;
  }

  // An unclosed block is malformed CSS; a rule with no end has no body to
  // hand back, so it is dropped rather than guessed at.
  return rules.filter((rule) => rule.close !== -1);
}

// ------------------------------------------------------------------- caching

interface ParsedFile {
  file: string;
  text: string;
  hash: string;
  rules: RawRule[];
}

const fileCache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedFile }>();
const rootCache = new Map<string, string[]>();

const MODULE_GLOB = '**/*.module.{css,scss,sass,less}';
const SHEET_GLOB = '**/*.{css,scss,sass,less}';
const IS_MODULE = /\.module\.(css|scss|sass|less)$/;
const SKIP = /(^|[\\/])(node_modules|dist|build|\.git|\.kintsugi)([\\/]|$)/;

/**
 * Stylesheets under a root, split by whether the build rewrites their class
 * names.
 *
 * `module` is what `resolveClass` searches: a hashed class can only have come
 * from a CSS Modules stylesheet, and widening to plain ones would let an
 * unrelated global `.title` outrank the module rule that actually styles the
 * element.
 *
 * `plain` is the exact complement, for callers that already hold an authoring
 * name because the build never scoped it. Keeping the two disjoint is what
 * stops a module's `.note` from being offered as the source of a plain `.note`
 * it has nothing to do with.
 */
async function sheetFiles(sourceRoot: string, kind: 'module' | 'plain'): Promise<string[]> {
  const key = `${kind}:${sourceRoot}`;
  const cached = rootCache.get(key);
  if (cached) return cached;

  const glob_ = kind === 'module' ? MODULE_GLOB : SHEET_GLOB;
  const out: string[] = [];
  for await (const entry of glob(glob_, { cwd: sourceRoot, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name);
    if (SKIP.test(relative(sourceRoot, full))) continue;
    if (kind === 'plain' && IS_MODULE.test(full)) continue;
    out.push(full);
  }
  rootCache.set(key, out);
  return out;
}

/**
 * Read and scan a stylesheet once.
 *
 * Keyed by absolute path, but revalidated against mtime and size, because the
 * healer edits these files mid-run — serving a rule from text that no longer
 * matches disk would hand back an anchor the patch step cannot find.
 */
async function loadFile(file: string): Promise<ParsedFile> {
  const info = await stat(file);
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.parsed;

  const text = await readFile(file, 'utf8');
  const parsed: ParsedFile = { file, text, hash: cssHash(text), rules: scanRules(text) };
  fileCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, parsed });
  return parsed;
}

/** Drop everything cached. Only needed if files appear or vanish mid-run. */
export function clearSourceCache(): void {
  fileCache.clear();
  rootCache.clear();
}

/** One scanned stylesheet: its text, and the offsets of every rule in it. */
export type Stylesheet = ParsedFile;
/** One brace-delimited block, located by offset rather than by pattern. */
export type StyleRule = RawRule;

/**
 * Every plain (non-CSS-Modules) stylesheet under a root, scanned.
 *
 * Exported because locating a rule safely is not specific to unhashing a
 * class. Anything that needs to edit a rule it did not find by name — a design
 * token's use sites, say — needs the same comment-, string- and nesting-aware
 * scan, and the same guarantee that the anchor it gets back occurs once.
 */
export async function plainStylesheets(sourceRoot: string): Promise<Stylesheet[]> {
  const files = await sheetFiles(sourceRoot, 'plain');
  const loaded = await Promise.all(files.map((f) => loadFile(f).catch(() => null)));
  return loaded.filter((s): s is Stylesheet => s !== null);
}

// ------------------------------------------------------------------ matching

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split a selector list on its top-level commas, leaving `:is(a, b)` alone. */
function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(selector.slice(start, i)); start = i + 1; }
  }
  parts.push(selector.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const mentionsClass = (selector: string, local: string) =>
  new RegExp(`(?:^|[^\\\\])\\.${escapeRe(local)}(?![\\w-])`).test(selector);

/**
 * How directly a selector claims to be *the* rule for this class.
 *
 * 0 — the rule is exactly this class. This is the one to patch.
 * 1 — a compound the class takes part in, `a.forgot`.
 * 2 — the class qualified by an ancestor, `.full .copyright`.
 *
 * Anything carrying a pseudo scores nothing at all. `.forgot:hover` is a
 * state the measurement was not taken in, so patching it cannot clear a
 * finding about the resting element, and `:global(.x)` names are never
 * hashed, so a hashed class can never have come from one.
 */
function rankSelector(selector: string, local: string): number | null {
  if (selector.includes(':')) return null;
  if (selector === `.${local}`) return 0;
  if (!mentionsClass(selector, local)) return null;
  return /[\s>+~]/.test(selector) ? 2 : 1;
}

const MAX_ANCHOR_LINES = 24;

/**
 * Grow the anchor backwards from the selector until it occurs exactly once.
 *
 * The bare `.dashboardTitle {` is ambiguous when the same class is also
 * overridden inside a media query, and the patch step would take the first
 * match — the responsive override — while reporting the base rule. Prefixing
 * the line break and indentation separates them, since the nested copy is
 * indented and the base rule is not. Wider collisions grow by whole lines.
 *
 * Returns the start offset the anchor should use, or null if the file repeats
 * itself so thoroughly that no bounded anchor is unique.
 */
function uniqueAnchorStart(text: string, start: number, end: number): number | null {
  let at = start;
  for (let step = 0; step <= MAX_ANCHOR_LINES; step++) {
    const candidate = text.slice(at, end);
    if (text.indexOf(candidate) === text.lastIndexOf(candidate)) return at;
    const nl = text.lastIndexOf('\n', at - 1);
    if (nl === -1 || nl >= at) return null;
    at = nl;
  }
  return null;
}

/**
 * A `find` anchor for one scanned rule that is guaranteed to occur in the file
 * exactly once, or null when the file repeats itself so thoroughly that no
 * bounded anchor is unique.
 *
 * Patches are applied by replacing the first occurrence of a string, so this
 * uniqueness is the whole contract: without it "edit this rule" silently
 * becomes "edit whichever rule happens to look like it first".
 */
export function anchorRule(sheet: Stylesheet, rule: StyleRule):
  { ruleOpen: string; ruleBody: string } | null {
  const start = uniqueAnchorStart(sheet.text, rule.start, rule.openEnd);
  if (start === null) return null;

  const ruleOpen = sheet.text.slice(start, rule.openEnd);
  // Restated against the finished string rather than trusted from the search
  // that produced it.
  if (sheet.text.indexOf(ruleOpen) !== sheet.text.lastIndexOf(ruleOpen)) return null;

  return {
    ruleOpen,
    // Starts at the same offset, so the body always contains the anchor as its
    // prefix and is unique for the same reason.
    ruleBody: sheet.text.slice(start, rule.close),
  };
}

/**
 * The strongest claim any selector in a rule's list makes on a class, or null
 * if none of them mentions it. Lower is more direct — see `rankSelector`.
 */
export function ruleRank(selector: string, local: string): number | null {
  let best: number | null = null;
  for (const part of splitSelectorList(selector)) {
    const r = rankSelector(part, local);
    if (r !== null && (best === null || r < best)) best = r;
  }
  return best;
}

// ------------------------------------------------------------------ resolving

/** Locate the source rule for a runtime class. Returns null when it cannot be resolved uniquely. */
export async function resolveClass(runtimeClass: string, sourceRoot: string): Promise<SourceRule | null> {
  const scoped = parseScoped(runtimeClass);
  if (!scoped) return null;

  const files = await sheetFiles(sourceRoot, 'module');
  const loaded = await Promise.all(files.map((f) => loadFile(f).catch(() => null)));
  const parsed = loaded.filter((p): p is ParsedFile => p !== null);
  if (!parsed.length) return null;

  let local = scoped.local;
  let searched = parsed;

  // The Vite hash is taken over the whole file, so a stylesheet whose current
  // text hashes to it is not a likely source — it is the source, byte for
  // byte. That collapses the search to one file and, better, lets the local
  // name be recovered by reconstruction instead of by splitting the runtime
  // string on underscores and hoping the local had none.
  //
  // It only holds while the file is unchanged since the page was loaded. Once
  // the healer edits a stylesheet, or the observation is older than the last
  // save, no hash matches and the name-based search below takes over.
  if (scoped.kind === 'vite') {
    const exact = parsed.filter((p) => p.hash === scoped.hash);
    if (exact.length === 1) {
      searched = exact;
      local = reconstructLocal(exact[0].text, runtimeClass, scoped.hash) ?? local;
    }
  }

  interface Candidate { file: ParsedFile; rule: RawRule; rank: number }
  const candidates: Candidate[] = [];

  for (const file of searched) {
    for (const rule of file.rules) {
      if (!rule.selector || rule.selector.startsWith('@')) continue;
      const rank = ruleRank(rule.selector, local);
      if (rank !== null) candidates.push({ file, rule, rank });
    }
  }
  if (!candidates.length) return null;

  // Take only the most direct claim on the class. A file with `.copyright`,
  // `.full .copyright` and `.minimal .copyright` has one rule that owns the
  // class and two that qualify it; counting all three as equals would read as
  // ambiguity and throw away a resolvable answer.
  const best = Math.min(...candidates.map((c) => c.rank));
  let shortlist = candidates.filter((c) => c.rank === best);

  // A rule nested inside `@media` or `@supports` only applies under that
  // condition, so it cannot be the rule behind a defect measured in the
  // default state. When both exist the top-level one is the base rule; this
  // is a rule about CSS, not a coin toss between two equal candidates.
  const topLevel = shortlist.filter((c) => c.rule.depth === 0);
  if (topLevel.length) shortlist = topLevel;

  // Still more than one and there is no principled way to choose. Two files
  // declaring `.title`, or one file declaring it twice at top level, is
  // exactly the case where a confident answer would be wrong half the time.
  if (shortlist.length !== 1) return null;

  const { file, rule } = shortlist[0];
  const anchored = anchorRule(file, rule);
  if (!anchored) return null;

  return { file: file.file, localClass: local, ...anchored };
}

/** Class names in a DOM selector, in the order they appear. */
export function selectorClasses(selector: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < selector.length) {
    const c = selector[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') {
      const end = selector.indexOf(']', i);
      i = end === -1 ? selector.length : end + 1;
      continue;
    }
    if (c !== '.') { i++; continue; }

    let j = i + 1;
    let name = '';
    while (j < selector.length) {
      const ch = selector[j];
      // `.top-1\/2` is one class called `top-1/2`, not a class and a
      // combinator — unescaping keeps it whole so it can be rejected as the
      // utility it is rather than silently truncated to something resolvable.
      if (ch === '\\') { name += selector[j + 1] ?? ''; j += 2; continue; }
      if (/[\w-]/.test(ch)) { name += ch; j++; continue; }
      break;
    }
    if (name) out.push(name);
    i = j;
  }
  return out;
}

/** Given a DOM selector like "a._forgot_penvp_415.other", resolve the first class that maps. */
export async function resolveSelector(selector: string, sourceRoot: string): Promise<SourceRule | null> {
  for (const cls of selectorClasses(selector)) {
    const rule = await resolveClass(cls, sourceRoot);
    if (rule) return rule;
  }
  return null;
}
