import { readFileSync, globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * A rough import graph, built by scanning statements rather than parsing.
 *
 * Its only job is blast radius: how many modules would a change to this file
 * reach? It never needs to be exact — a heuristic that overcounts importers
 * escalates a few extra files, and undercounting is the risk, so the rules
 * below err toward treating a file as shared.
 */

const SRC_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py}';
const SKIP = /(^|[\\/])(node_modules|dist|build|\.git)([\\/]|$)/;
const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g;
// Python: `from x import y` / `import x` — the module spec, relative ones
// included (`from ..pkg import`, `from . import`). Non-relative specs are
// resolved against the source root (first-party packages), so blast radius
// is real for .py files too.
const PY_IMPORT_RE = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;
/** Test files are not product importers — they exercise the code, not own it. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(?:^|[/\\])test_[^/\\]*\.py$|(?:^|[/\\])[^/\\]*_test\.py$/;

export interface ImportGraph {
  /** absolute file -> absolute files that import it */
  importers: Map<string, Set<string>>;
  /** absolute file -> absolute files it imports (resolved, in-tree) */
  deps: Map<string, Set<string>>;
  files: string[];
}

export function buildImportGraph(sourceRoot: string): ImportGraph {
  const importers = new Map<string, Set<string>>();
  const deps = new Map<string, Set<string>>();
  const files: string[] = [];

  for (const f of globSync(SRC_GLOB, { cwd: sourceRoot })) {
    const rel = f.replace(/\\/g, '/');
    if (SKIP.test(rel)) continue;
    files.push(resolve(sourceRoot, f));
  }
  const fileSet = new Set(files);

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const set = new Set<string>();
    if (file.endsWith('.py')) {
      for (const m of text.matchAll(PY_IMPORT_RE)) {
        const spec = (m[1] ?? m[2] ?? '').trim();
        if (!spec) continue;
        let base: string;
        let rest = '';
        if (spec.startsWith('.')) {
          const dots = spec.match(/^\.+/)?.[0].length ?? 0;
          rest = spec.slice(dots);
          base = resolve(dirname(file), ...Array(dots - 1).fill('..'), ...(rest ? [rest] : ['']));
        } else {
          base = resolve(sourceRoot, ...spec.split('.'));
        }
        const cands = rest
          ? [`${base}.py`, resolve(base, '__init__.py')]
          : [resolve(base, '__init__.py')];
        for (const cand of cands) {
          if (fileSet.has(cand)) { set.add(cand); break; }
        }
      }
    } else {
      for (const m of text.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2];
        if (!spec || !spec.startsWith('.')) continue;
        const base = resolve(dirname(file), spec);
        let target: string | null = null;
        // NodeNext projects import './pricing.js' for a file that is actually
        // pricing.ts, so runtime extensions must map back to source files.
        const mapped = [
          base,
          `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`,
          `${base}/index.ts`, `${base}/index.js`,
          base.replace(/\.js$/, '.ts'), base.replace(/\.jsx$/, '.tsx'),
          base.replace(/\.mjs$/, '.mts'), base.replace(/\.cjs$/, '.cts'),
        ];
        for (const cand of mapped) {
          if (fileSet.has(cand)) { target = cand; break; }
        }
        if (target && fileSet.has(target)) set.add(target);
      }
    }
    deps.set(file, set);
    // A file imported by a *test* is not a shared product module — tests
    // reference modules they exercise, and editing those modules is normal.
    // Only product-code importers count toward blast radius.
    if (TEST_FILE.test(file)) continue;
    for (const t of set) {
      if (!importers.has(t)) importers.set(t, new Set());
      importers.get(t)!.add(file);
    }
  }

  return { importers, deps, files };
}

/**
 * Blast radius from the shape of the graph, not from the patch. A file
 * imported by two or more modules is shared: editing it moves code the loop
 * was not looking at, so the repair is escalated instead of applied.
 */
export function scopeOf(
  graph: ImportGraph,
  file: string,
): { scope: 'local' | 'shared'; importers: number } {
  const n = graph.importers.get(file)?.size ?? 0;
  return { scope: n >= 2 ? 'shared' : 'local', importers: n };
}
