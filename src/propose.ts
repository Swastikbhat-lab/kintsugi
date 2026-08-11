import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import { relative, resolve, basename, dirname, join } from 'node:path';
import type { Finding, Patch } from './types.js';

/**
 * Turns a finding into concrete candidate edits against real source files.
 *
 * Every patch is an exact string replacement anchored on text that is known
 * to exist in the file. Rules exist for the defect classes with an
 * *objectively correct* edit; everything else is deliberately left for the
 * model proposer (intent) or a human (nothing safe to do). A rule that
 * guesses is worse than no rule, because the verify gate will reject the
 * guess anyway — after burning an iteration and a ledger entry to prove it.
 */
export async function proposePatches(finding: Finding, sourceRoot: string): Promise<Patch[]> {
  switch (finding.code) {
    case 'TS6133': return unusedDeclarationPatches(finding, sourceRoot);
    case 'TS2307': return missingModulePatches(finding, sourceRoot);
    case 'TS2305':
    case 'TS2459': return missingExportPatches(finding, sourceRoot);
    case 'TS2834':
    case 'TS2835': return missingExtensionPatches(finding, sourceRoot);
  }
  if (finding.check === 'version') return versionDriftPatches(finding, sourceRoot);
  return [];
}

// -------------------------------------------------------------- TS6133

/**
 * Unused declaration (`const TAX_RATE = 0.08;` never read). Only
 * statement-level const/let/var are safe to remove. Parameters and import
 * bindings are skipped: removing a parameter changes callers, and removing
 * an import is a different edit — both need intent a rule cannot have.
 */
function unusedDeclarationPatches(finding: Finding, sourceRoot: string): Patch[] {
  if (!finding.file) return [];
  const symbol = (finding.evidence.symbol as string) ?? '';
  if (!symbol) return [];
  const text = readFileSync(finding.file, 'utf8');
  const re = new RegExp(
    `^([ \\t]*)(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(symbol)}\\b[^;\\n]*;(\\r?\\n)?`,
    'm',
  );
  const m = text.match(re);
  if (!m) return [];
  return [mkPatch(
    finding.file,
    m[0],
    '',
    `Declaration ${symbol} is never read — removing the dead line.`,
  )];
}

// -------------------------------------------------------------- TS2307

/**
 * Import path that resolves to nothing (`Cannot find module
 * './shipping-costs'`). The mechanical fix is to point the specifier at the
 * module that actually exists, found by basename. If no module plausibly
 * matches, no rule fires — the file may genuinely be missing, which needs a
 * human.
 */
function missingModulePatches(finding: Finding, sourceRoot: string): Patch[] {
  if (!finding.file) return [];
  const moduleName = (finding.evidence.module as string) ?? '';
  if (!moduleName.startsWith('.')) return [];

  const text = readFileSync(finding.file, 'utf8');
  const literal = findSpecifierLiteral(text, moduleName);
  if (!literal) return [];

  const target = resolveModule(moduleName, finding.file, sourceRoot);
  if (!target) return [];

  const rel = relative(dirname(finding.file), target).replace(/\\/g, '/');
  const spec = stripKnownExt(rel.startsWith('.') ? rel : `./${rel}`);
  // NodeNext projects write relative imports with an extension; keep the
  // style the original specifier used, so the repair lands in the same
  // convention the file already follows.
  const origExt = moduleName.match(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/)?.[0];
  const finalSpec = origExt ? `${spec}${JS_EXT[origExt] ?? '.js'}` : spec;
  const quote = literal.startsWith('"') ? '"' : "'";
  return [mkPatch(
    finding.file,
    literal,
    `${quote}${finalSpec}${quote}`,
    `No module '${moduleName}' exists; the code lives at '${finalSpec}' — pointing the import at it.`,
  )];
}

// -------------------------------------------------------------- TS2305

/**
 * Import of a member that is not exported (`Module 'x' has no exported
 * member 'lineTotal'`). The mechanical fix: if a matching declaration exists
 * in the target module but lacks `export`, add it. If no such declaration
 * exists anywhere, no rule fires — writing the missing function is intent.
 */
function missingExportPatches(finding: Finding, sourceRoot: string): Patch[] {
  const member = (finding.evidence.member as string) ?? '';
  const moduleSpec = (finding.evidence.module as string) ?? '';
  if (!member || !moduleSpec || !finding.file) return [];

  // The message names the target module; resolve it against the importing
  // file's directory (it may be relative or absolute).
  let target = resolve(dirname(finding.file), moduleSpec);
  // TS2459 reports the specifier as written ('./pricing.js') rather than the
  // resolved source path, so map the runtime extension back to the source.
  if (!existsSync(target)) {
    const mapped = target
      .replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx')
      .replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts');
    if (existsSync(mapped)) target = mapped;
  }
  if (!existsSync(target)) return [];

  const text = readFileSync(target, 'utf8');
  // Spaces and tabs only in the indent — `\s` would swallow the newline of
  // a preceding blank line and put the match's start mid-file.
  const re = new RegExp(
    `^[ \\t]*(?!export\\b)(function\\s+${escapeRegExp(member)}\\b|const\\s+${escapeRegExp(member)}\\b|class\\s+${escapeRegExp(member)}\\b|interface\\s+${escapeRegExp(member)}\\b|type\\s+${escapeRegExp(member)}\\b)`,
    'm',
  );
  const m = text.match(re);
  if (!m) return [];

  const lineStart = text.lastIndexOf('\n', m.index ?? 0) + 1;
  const lineEnd = text.indexOf('\n', m.index ?? 0);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  const decl = m[1];
  return [mkPatch(
    target,
    line,
    line.replace(decl, `export ${decl}`),
    `${member} exists in the module but is not exported — adding the export keyword.`,
  )];
}

// -------------------------------------------------------------- version

/**
 * Version drift reported by a custom check: the finding names the stale
 * version and the file that carries it; the fix reads package.json, which is
 * the ground truth, and replaces the stale string.
 */
function versionDriftPatches(finding: Finding, sourceRoot: string): Patch[] {
  let expected: string | undefined;
  try {
    expected = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')).version;
  } catch {
    return [];
  }
  if (!expected) return [];

  const staleMatch = ((finding.evidence.message as string) ?? '').match(/\b(\d+\.\d+\.\d+)\b/);
  if (!staleMatch) return [];
  const stale = staleMatch[1];

  const file = finding.file ?? join(sourceRoot, 'README.md');
  const text = readFileSync(file, 'utf8');
  const idx = text.indexOf(stale);
  if (idx === -1) return [];

  const lineStart = text.slice(0, idx).lastIndexOf('\n') + 1;
  const lineEnd = text.indexOf('\n', idx);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  return [mkPatch(
    file,
    line,
    line.replace(stale, expected),
    `Version ${stale} is stale; package.json declares ${expected}.`,
  )];
}

// -------------------------------------------------------------- helpers

function mkPatch(file: string, find: string, replace: string, rationale: string): Patch {
  return {
    id: randomUUID().slice(0, 8),
    file: resolve(file),
    find,
    replace,
    rationale,
    scope: 'local',
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The import specifier exactly as written, with its quotes. */
function findSpecifierLiteral(text: string, moduleName: string): string | null {
  const re = new RegExp(`['"](${escapeRegExp(moduleName)})['"]`);
  return text.match(re)?.[0] ?? null;
}

/** A file whose basename plausibly matches the module specifier. */
function resolveModule(moduleName: string, fromFile: string, sourceRoot: string): string | null {
  const stem = basename(moduleName).replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
  const files: string[] = [];
  for (const f of globSync('**/*.{ts,tsx,js,jsx,mjs,cjs}', { cwd: sourceRoot })) {
    const rel = f.replace(/\\/g, '/');
    if (/(^|[\\/])(node_modules|dist|build|\.git)([\\/]|$)/.test(rel)) continue;
    files.push(resolve(sourceRoot, f));
  }

  const candidates = files
    .map((f) => ({ f, s: basename(f).replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '') }))
    .filter(({ s }) => s === stem || s.startsWith(stem) || stem.startsWith(s))
    .sort((a, b) => b.s.length - a.s.length);

  // Exact basename beats a prefix match ('shipping.ts' for
  // './shipping-costs'); an exact stem match wins outright.
  const exact = candidates.find(({ s }) => s === stem);
  return (exact ?? candidates[0] ?? null)?.f ?? null;
}

function stripKnownExt(spec: string): string {
  return spec.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
}

/** Source extension → the runtime extension NodeNext expects in imports. */
const JS_EXT: Record<string, string> = {
  '.ts': '.js', '.tsx': '.jsx', '.mts': '.mjs', '.cts': '.cjs',
  '.js': '.js', '.jsx': '.jsx', '.mjs': '.mjs', '.cjs': '.cjs',
};

/**
 * TS2834/TS2835: a relative import without an explicit extension under
 * NodeNext resolution. The fix is mechanical — append the extension the
 * source file maps to ('./config' → './config.js') — which is exactly the
 * repair tsc itself suggests.
 */
function missingExtensionPatches(finding: Finding, sourceRoot: string): Patch[] {
  if (!finding.file || !finding.line) return [];
  const lines = readFileSync(finding.file, 'utf8').split(/\r?\n/);
  const line = lines[finding.line - 1] ?? '';
  const m = line.match(/from\s+(['"])(\.[^'"]+)\1/);
  if (!m) return [];
  const spec = m[2];
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(spec)) return [];

  let ext = '.js';
  const target = resolveModule(spec, finding.file, sourceRoot);
  const srcExt = target?.match(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/)?.[0];
  if (srcExt) ext = JS_EXT[srcExt] ?? '.js';

  const quoted = `${m[1]}${spec}${m[1]}`;
  return [mkPatch(
    finding.file,
    quoted,
    `${m[1]}${spec}${ext}${m[1]}`,
    `Relative import '${spec}' needs an explicit extension under NodeNext; '${spec}${ext}' resolves.`,
  )];
}
