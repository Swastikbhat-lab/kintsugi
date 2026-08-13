import { readFileSync, globSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import type { ImportGraph } from './imports.js';

/**
 * Read-only tools the model proposer may call.
 *
 * The model never executes code and never touches live objects. It can only
 * ask the harness to read files, grep, and list importers, and the answers
 * come back as bounded text in the prompt. This is the safe half of NOOA's
 * pass-by-reference (see docs/NOOA.md): the *effect* of context navigation
 * through declared, inspectable tools — not the mechanism of letting the
 * model run code against the repo.
 *
 * Every result is capped so the prompt cannot balloon; a tool that reads the
 * whole repo is a tool that defeats the point of a bounded context. Paths
 * are resolved inside the source root and refused if they escape it.
 *
 * Mirrors `py/kintsugi/tools.py` in the Python engine.
 */

// Result caps, mirrored from py/kintsugi/tools.py.
export const MAX_READ_LINES = 400;
export const MAX_READ_CHARS = 20_000;
export const MAX_GREP_MATCHES = 40;
export const MAX_IMPORTERS = 20;

const SKIP = /(^|[\\/])(node_modules|dist|build|\.git|\.venv)([\\/]|$)/;
const GREP_EXTS = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|md)$/;

export class ToolRunner {
  private sourceRoot: string;
  private graph?: ImportGraph;

  constructor(sourceRoot: string, graph?: ImportGraph) {
    this.sourceRoot = resolve(sourceRoot);
    this.graph = graph;
  }

  /** Execute one declared tool call, returning bounded text. */
  run(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case 'read_file': return this.readFile(args);
      case 'grep': return this.grep(args);
      case 'importers': return this.importers(args);
      default:
        return `error: unknown tool ${JSON.stringify(name)} — use one of: read_file, grep, importers`;
    }
  }

  /** Resolve a model-supplied relative path inside the source root. */
  private resolvePath(path: unknown): string | null {
    if (typeof path !== 'string' || !path) return null;
    const abs = resolve(this.sourceRoot, path);
    const rel = relative(this.sourceRoot, abs);
    // `isAbsolute(rel)` catches cross-drive escapes on Windows, where
    // relative() yields an absolute path instead of a `..` chain.
    if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) return null;
    return abs;
  }

  private readFile(args: Record<string, unknown>): string {
    const path = args.path;
    const abs = this.resolvePath(path);
    if (!abs) return 'error: path must be a relative path inside the source root';
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return `error: no such file: ${String(path)}`;
    }
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (err) {
      return `error: cannot read ${String(path)}: ${(err as Error).message}`;
    }
    const lines = text.split('\n');
    let start = 1;
    const s = Number(args.start);
    if (Number.isFinite(s)) start = Math.max(s, 1);
    let end = Math.min(lines.length, start + MAX_READ_LINES - 1);
    const e = Number(args.end);
    if (Number.isFinite(e) && e >= start) end = Math.min(end, e);
    const rel = relative(this.sourceRoot, abs).replace(/\\/g, '/');
    const out = [`${rel} (lines ${start}-${end} of ${lines.length}):`];
    for (let i = start - 1; i < end; i++) out.push(`${i + 1}\t${lines[i].slice(0, 200)}`);
    return out.join('\n').slice(0, MAX_READ_CHARS);
  }

  private grep(args: Record<string, unknown>): string {
    const pattern = args.pattern;
    if (typeof pattern !== 'string' || !pattern) return "error: grep needs a 'pattern' string";
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return `error: invalid regex: ${(err as Error).message}`;
    }
    let base = this.sourceRoot;
    if (args.path) {
      const abs = this.resolvePath(args.path);
      if (!abs) return 'error: path must be a relative path inside the source root';
      if (!existsSync(abs)) return `error: no such path: ${String(args.path)}`;
      base = abs;
    }
    const files = statSync(base).isFile()
      ? [base]
      : globSync('**/*', { cwd: base }).map((f) => resolve(base, f)).filter((f) => statSync(f).isFile());
    const matches: string[] = [];
    for (const f of files) {
      const rel = relative(this.sourceRoot, f).replace(/\\/g, '/');
      if (SKIP.test(rel) || !GREP_EXTS.test(rel)) continue;
      let content: string;
      try {
        content = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].slice(0, 140)}`);
          if (matches.length >= MAX_GREP_MATCHES) {
            return `${matches.join('\n')}\n… ${matches.length} matches shown, more available`;
          }
        }
      }
    }
    return matches.length ? matches.join('\n') : `no matches for ${JSON.stringify(pattern)}`;
  }

  private importers(args: Record<string, unknown>): string {
    if (!this.graph) return 'error: import graph is not available for this run';
    const path = args.path;
    const abs = this.resolvePath(path);
    if (!abs) return 'error: path must be a relative path inside the source root';
    const imp = this.graph.importers.get(abs);
    if (!imp || imp.size === 0) return `no module imports ${String(path)}`;
    const rels = [...imp]
      .map((p) => relative(this.sourceRoot, p).replace(/\\/g, '/'))
      .sort()
      .slice(0, MAX_IMPORTERS);
    return `${imp.size} module(s) import ${String(path)}:\n` + rels.map((r) => `- ${r}`).join('\n');
  }
}
