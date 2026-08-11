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
    case 'F401': return unusedPythonImportPatches(finding, sourceRoot);
    case 'I001': return unsortedImportBlockPatches(finding, sourceRoot);
    case 'unused_imports': return unusedRustImportPatches(finding, sourceRoot);
    case 'T201': return bestPracticePatches(finding, sourceRoot, 'T201');
    case 'T202': return bestPracticePatches(finding, sourceRoot, 'T202');
    case 'T203': return bestPracticePatches(finding, sourceRoot, 'T203');
    case 'T001': return testgenPatches(finding, sourceRoot);
  }
  if (finding.check === 'version') return versionDriftPatches(finding, sourceRoot);
  const message = `${finding.summary} ${finding.evidence.message ?? ''}`;
  if (finding.check === 'py:test') return assertionConstantPatches(finding, sourceRoot, 'python');
  if (finding.check === 'go:test' || finding.check === 'go:vet') {
    if (/imported and not used/.test(message)) return unusedGoImportPatches(finding, sourceRoot);
    return assertionConstantPatches(finding, sourceRoot, 'go');
  }
  if (finding.check === 'rs:test') return assertionConstantPatches(finding, sourceRoot, 'rust');
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

// -------------------------------------------------------------- python F401

/**
 * Unused import (`F401 'os' imported but unused`). The mechanical fix is to
 * drop the import. Whole-line imports (the overwhelmingly common shape) are
 * removed outright, with a surrounding blank line collapsed so the file does
 * not gain a double blank. Multi-name imports (`import a, b`) have the one
 * unused name removed from the list; anything parenthesized or ambiguous is
 * left for a human — a rule that guesses is worse than no rule.
 */
function unusedPythonImportPatches(finding: Finding, sourceRoot: string): Patch[] {
  if (!finding.file || !finding.line) return [];
  // ruff 0.16+ quotes the unused name with backticks (`os`), older versions
  // with single quotes — accept either.
  const name = (finding.evidence.message as string)?.match(/[`'"]([^`'"]+)[`'"]/)?.[1];
  if (!name) return [];
  const text = readFileSync(finding.file, 'utf8');
  const lines = text.split('\n');
  const idx = finding.line - 1;
  const line = lines[idx] ?? '';
  if (idx < 0 || idx >= lines.length || !/\bimport\b/.test(line)) return [];

  // Whole-line import of exactly this name (optionally aliased) — drop it.
  const whole = new RegExp(
    `^\\s*(?:import\\s+${escapeRegExp(name)}(?:\\s+as\\s+\\w+)?|from\\s+\\S+\\s+import\\s+${escapeRegExp(name)})\\s*(?:#.*)?$`,
  );
  if (whole.test(line)) {
    return removeLinePatch(finding.file, text, idx, `'${name}' is imported but never used — removing the import.`);
  }

  // `import a, b` / `from x import a, b` — drop the unused name from the list.
  const list = line.match(/^\s*(?:import|from\s+\S+\s+import)\s+(.+?)\s*(?:#.*)?$/);
  if (!list || list[1].includes('(')) return [];
  const items = list[1].split(',').map((s) => s.trim()).filter(Boolean);
  const kept = items.filter((it) => it.split(/\s+as\s+/)[0].trim() !== name);
  if (kept.length === items.length) return [];
  const find = line;
  const replace = line.replace(list[1], kept.join(', '));
  return uniqueOrEmpty(finding.file, text, find, replace, `'${name}' is imported but never used — removing it from the import.`);
}

/**
 * Remove one line by its exact text, collapsing a preceding blank line so
 * the file does not gain a double blank. The anchor includes the line's own
 * newline (or the one before it) so it matches exactly once; a non-unique
 * anchor is refused rather than guessed at.
 */
function removeLinePatch(file: string, text: string, idx: number, rationale: string): Patch[] {
  const lines = text.split('\n');
  const line = lines[idx];
  if (line === undefined || line.trim() === '') return [];
  const last = idx === lines.length - 1;
  const find = (idx === 0 ? '' : '\n') + line + (last ? '' : '\n');
  const replace = idx === 0 ? '' : '\n';
  return uniqueOrEmpty(file, text, find, replace, rationale);
}

/** A patch whose anchor is exactly one occurrence — nothing else is safe. */
function uniqueOrEmpty(file: string, text: string, find: string, replace: string, rationale: string): Patch[] {
  let count = 0;
  for (let i = 0; (i = text.indexOf(find, i)) !== -1; i += find.length) count++;
  if (count !== 1) return [];
  return [mkPatch(file, find, replace, rationale)];
}

// -------------------------------------------------------------- python I001

/**
 * Unsorted import block (`I001 Import block is un-sorted or un-formatted`).
 * The fix is to order the block as isort does: stdlib first, then
 * third-party, then first-party, alphabetical within each section, `import
 * x` before `from x import`. Only plain consecutive import lines are sorted;
 * a block with comments or parenthesized imports is left for a human. The
 * verify gate re-runs the linter, so a sort that disagrees with the tool's
 * preference is reverted, not shipped.
 */
function unsortedImportBlockPatches(finding: Finding, sourceRoot: string): Patch[] {
  if (!finding.file || !finding.line) return [];
  const text = readFileSync(finding.file, 'utf8');
  const lines = text.split('\n');
  const startIdx = finding.line - 1;
  if (startIdx < 0 || startIdx >= lines.length) return [];
  if (!isImportLine(lines[startIdx])) return [];

  // Walk to the block boundaries: consecutive plain import lines. A comment
  // or parenthesized import ends the walk — sorting around those is guesswork.
  let from = startIdx;
  while (from > 0 && isImportLine(lines[from - 1]) && !lines[from - 1].includes('#')) from--;
  let to = startIdx;
  while (to < lines.length - 1 && isImportLine(lines[to + 1]) && !lines[to + 1].includes('#')) to++;
  const block = lines.slice(from, to + 1);
  if (block.length < 2) return [];
  if (block.some((l) => l.includes('(') || l.includes(')'))) return [];

  const dir = dirname(finding.file);
  const sorted = [...block].sort((a, b) => compareImports(a, b, dir, sourceRoot));
  if (sorted.join('\n') === block.join('\n')) return [];

  const find = block.join('\n');
  const replace = sorted.join('\n');
  return uniqueOrEmpty(
    finding.file, text, find, replace,
    'Import block is out of order — sorting it (stdlib, third-party, first-party).',
  );
}

function isImportLine(line: string): boolean {
  const t = line.trim();
  return /^(?:import\s+|from\s+\S+\s+import\s+)/.test(t);
}

const STDLIB = new Set([
  'abc', 'argparse', 'array', 'asyncio', 'base64', 'bisect', 'calendar', 'collections',
  'concurrent', 'configparser', 'contextlib', 'copy', 'csv', 'dataclasses', 'datetime',
  'decimal', 'difflib', 'enum', 'errno', 'fractions', 'functools', 'getpass', 'glob',
  'gzip', 'hashlib', 'heapq', 'html', 'http', 'importlib', 'inspect', 'io', 'itertools',
  'json', 'locale', 'logging', 'math', 'multiprocessing', 'os', 'pathlib', 'pickle',
  'platform', 'queue', 'random', 're', 'shutil', 'signal', 'socket', 'sqlite3', 'ssl',
  'statistics', 'string', 'struct', 'subprocess', 'sys', 'tempfile', 'threading', 'time',
  'traceback', 'types', 'typing', 'unittest', 'urllib', 'uuid', 'warnings', 'weakref',
  'xml', 'zipfile', 'zoneinfo',
]);

function importSection(statement: string, dir: string, sourceRoot: string): number {
  const t = statement.trim();
  const m = t.match(/^(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/);
  const spec = (m?.[1] ?? m?.[2] ?? '').trim();
  if (spec.startsWith('.')) return 2; // relative import → the repo's own code
  const top = spec.split('.')[0];
  if (STDLIB.has(top)) return 0;
  // First-party: a package or module of the same name under the source root.
  if (existsSync(resolve(sourceRoot, top)) || existsSync(resolve(sourceRoot, `${top}.py`))) return 2;
  return 1;
}

function compareImports(a: string, b: string, dir: string, sourceRoot: string): number {
  const sa = importSection(a, dir, sourceRoot);
  const sb = importSection(b, dir, sourceRoot);
  if (sa !== sb) return sa - sb;
  const key = (s: string) => {
    const t = s.trim();
    const m = t.match(/^(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/);
    const mod = (m?.[1] ?? m?.[2] ?? '').toLowerCase();
    const kind = t.startsWith('import ') ? 0 : 1;
    return `${mod}\u0000${kind}\u0000${t.toLowerCase()}`;
  };
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

// -------------------------------------------------------------- unused import (go)

/**
 * `imported and not used: "fmt"` (a Go compile error reported by go test /
 * go build). The fix is to remove the import spec — a whole-line `import
 * "fmt"` or a `"fmt"` line inside an import block. Exactly like the
 * Python rule, the anchor must be unique or nothing is proposed.
 */
function unusedGoImportPatches(finding: Finding, sourceRoot: string): Patch[] {
  if (!finding.file) return [];
  const message = `${finding.summary} ${finding.evidence.message ?? ''}`;
  const path = message.match(/imported and not used:\s*"?([\w./\-]+)"?/)?.[1];
  if (!path) return [];
  const text = readFileSync(finding.file, 'utf8');
  const lines = text.split('\n');
  const re = new RegExp(`^\\s*"${escapeRegExp(path)}"(\\s|//|$)`);
  const idx = lines.findIndex((l) => re.test(l) || new RegExp(`^import\\s+"${escapeRegExp(path)}"\\s*$`).test(l.trim()));
  if (idx === -1) return [];
  return removeLinePatch(finding.file, text, idx, `'${path}' is imported but not used — removing the import.`);
}

// -------------------------------------------------------------- unused import (rust)

/**
 * Unused `use` import (clippy `unused_imports`). Whole-line imports —
 * `use std::fmt;`, optionally aliased — are removed outright, collapsing a
 * surrounding blank line exactly like the Python rule. Group imports
 * (`use a::{b, c};`) are left for a human: clippy names only the last
 * segment, which cannot be re-anchored safely.
 */
function unusedRustImportPatches(finding: Finding, sourceRoot: string): Patch[] {
  if (!finding.file || !finding.line) return [];
  const message = `${finding.summary} ${finding.evidence.message ?? ''}`;
  const path = message.match(/`([^`]+)`/)?.[1];
  if (!path) return [];
  const text = readFileSync(finding.file, 'utf8');
  const lines = text.split('\n');
  const idx = finding.line - 1;
  const line = lines[idx] ?? '';
  if (idx < 0 || idx >= lines.length || !/^\s*use\s+/.test(line)) return [];
  const re = new RegExp(`^\\s*use\\s+${escapeRegExp(path)}(?:\\s+as\\s+\\w+)?\\s*;\\s*$`);
  if (!re.test(line)) return [];
  return removeLinePatch(finding.file, text, idx, `'${path}' is imported but never used — removing the use.`);
}

// -------------------------------------------------------------- best practices (T201-T203)

/**
 * The mechanically fixable best-practices findings from the `py:best-
 * practices` check. Each rewrite is exact, anchored on the reported line,
 * and semantically equivalent — the verify gate re-runs the checks, so a
 * rewrite that disagrees with the language's semantics is reverted, not
 * shipped.
 */
function bestPracticePatches(
  finding: Finding,
  sourceRoot: string,
  kind: 'T201' | 'T202' | 'T203',
): Patch[] {
  if (!finding.file || !finding.line) return [];
  const text = readFileSync(finding.file, 'utf8');
  const lines = text.split('\n');
  const idx = finding.line - 1;
  const line = lines[idx] ?? '';
  if (idx < 0 || idx >= lines.length) return [];

  let find = '';
  let replace = '';
  let rationale = '';

  if (kind === 'T201') {
    // `type(x) == T` compares identity, not types — `isinstance` is the
    // intended check. The RHS guard refuses `type(x) == type(y)`, where
    // no class is named and the rewrite would be wrong.
    const m = line.match(/type\(\s*([^)]*?)\s*\)\s*(?:==|is)\s+(?!type\s*\()([A-Za-z_][\w.]*)/);
    if (!m) return [];
    find = m[0];
    replace = `isinstance(${m[1]}, ${m[2]})`;
    rationale = `type() compares identity, not types — using isinstance().`;
  } else if (kind === 'T202') {
    // `len(x) == 0` → `not x`; `len(x) != 0` / `len(x) > 0` → `x`; and the
    // mirrored `0 == len(x)` forms. Only bare identifiers are rewritten —
    // an attribute or subscript stays untouched.
    const fwd = line.match(/\blen\(([A-Za-z_]\w*)\)\s*(==|!=|>)\s*0\b/);
    const rev = line.match(/\b0\s*(==|!=|<)\s*len\(([A-Za-z_]\w*)\)/);
    const m = fwd ?? rev;
    if (!m) return [];
    // fwd captures (name, op); rev captures (op, name).
    const name = fwd ? fwd[1] : rev![2];
    const op = fwd ? fwd[2] : rev![1];
    find = m[0];
    replace = op === '==' ? `not ${name}` : name;
    rationale = `len() comparison against a literal — using truthiness instead.`;
  } else {
    // `key in d.keys()` — the keys view is redundant; `in d` is equivalent.
    const m = line.match(/((?:'[^']*'|"[^"]*"|[A-Za-z_]\w*)\s+in\s+)([A-Za-z_]\w*)\.keys\(\)/);
    if (!m) return [];
    find = m[0];
    replace = `${m[1]}${m[2]}`;
    rationale = `'in d.keys()' — the keys view is redundant; 'in d' is equivalent.`;
  }

  return uniqueOrEmpty(finding.file, text, find, replace, rationale);
}

// -------------------------------------------------------------- test generation (T001)

/**
 * A function with no tests (`py:testgen` T001). The mechanical answer is
 * not a rewrite but a *new file*: a smoke test next to the module, covering
 * every untested top-level function in one patch. The verify gate then runs
 * pytest — if the module cannot even be imported (missing dependency, bad
 * name), the new test fails and the file is reverted, which is exactly the
 * honest signal: "no tests exist AND the module does not import cleanly".
 */
function testgenPatches(finding: Finding, sourceRoot: string): Patch[] {
  if (!finding.file) return [];
  const stem = basename(finding.file).replace(/\.py$/, '');
  const testPath = join(dirname(finding.file), `test_${stem}.py`);
  // The detector only reports modules with no sibling test file; if one has
  // appeared since, the finding is already resolved.
  if (existsSync(testPath)) return [];

  const text = readFileSync(finding.file, 'utf8');
  // Top-level only: `^` at column 0 never matches an indented nested def.
  const funcs = [...text.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm)]
    .map((m) => m[1])
    .filter((n) => !n.startsWith('_'));
  if (!funcs.length) return [];

  // The import spec follows pytest's sys.path rule: walk up through
  // package dirs (those with __init__.py); the module is importable as the
  // dotted path from the first non-package ancestor.
  const parts = [stem];
  let d = dirname(finding.file);
  while (existsSync(join(d, '__init__.py'))) {
    parts.unshift(basename(d));
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  const spec = parts.join('.');

  const rel = relative(sourceRoot, finding.file).replace(/\\/g, '/');
  // Member names sorted case-insensitively (isort's default), so the
  // generated file is I001-clean and the verify gate has nothing to see.
  const sorted = [...funcs].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  // Two blank lines between top-level defs (PEP 8) — a generated file must
  // not introduce style findings in a stricter repo.
  const body = sorted
    .map((f) => `def test_${f}_is_importable():\n    assert callable(${f})`)
    .join('\n\n\n');
  const content = [
    `"""Smoke tests for ${rel} — generated by Kintsugi (no coverage found)."""`,
    '',
    `from ${spec} import ${sorted.join(', ')}`,
    '',
    '',
    body,
    '',
  ].join('\n');

  return [{
    id: randomUUID().slice(0, 8),
    file: testPath,
    find: '',
    replace: content,
    create: true,
    rationale: `No test covers ${rel} — generating a smoke test and letting the checks run it.`,
    scope: 'local',
  }];
}

// -------------------------------------------------------------- assertion → constant

/**
 * A failing assertion that reveals the right constant. pytest prints
 * `assert 8.0 == 10`; go test prints `expected 10, got 5`. Neither names the
 * code — but the test file line the check points at does: read it, find the
 * call and the expected value, locate the function, and if its body computes
 * `param * <literal>`, recompute the literal from the assertion's own
 * numbers. Only a clean decimal result is patched; anything else is left to
 * the model (or a human), because a rule that guesses is worse than none.
 */
function assertionConstantPatches(
  finding: Finding,
  sourceRoot: string,
  lang: 'python' | 'go' | 'rust',
): Patch[] {
  if (!finding.file || !finding.line) return [];
  const lines = readFileSync(finding.file, 'utf8').split(/\r?\n/);
  const testLine = lines[finding.line - 1] ?? '';
  const parsed = parseAssertion(testLine, lang);
  if (!parsed) return [];

  const impl = findFunctionBody(parsed.fn, sourceRoot, lang);
  if (!impl) return [];
  const num = lang === 'rust' ? '\\d+(?:\\.\\d+)?(?:_?f(?:32|64))?' : '\\d+(?:\\.\\d+)?';
  const re = new RegExp(`\\b${escapeRegExp(impl.param)}\\s*\\*\\s*(${num})\\b`);
  const m = impl.body.match(re);
  if (!m) return [];

  const arg = Number(parsed.arg);
  const expected = Number(parsed.expected);
  if (!Number.isFinite(arg) || !Number.isFinite(expected) || arg === 0) return [];
  const value = expected / arg;
  const literal = String(value);
  // A clean decimal only — `10/100 → 0.1`, but `10/3 → 3.3333333333333335`
  // is float noise, not a constant.
  if (!/^\d+\.?\d*$/.test(literal) || literal.length > 10) return [];
  // Compare against the numeric part so a redundant `0.08_f64` -> `0.08`
  // rewrite (which changes nothing) is never proposed.
  if (literal === m[1].replace(/(?:_?f(?:32|64))?$/, '')) return [];

  const find = m[0];
  const replace = m[0].replace(/\d+(?:\.\d+)?(?:_?f(?:32|64))?$/, literal);
  return uniqueOrEmpty(
    impl.file, impl.text, find, replace,
    `The test asserts ${parsed.fn}(${parsed.arg}) == ${parsed.expected}; the constant '${impl.param} * ${m[1]}' makes it ${parsed.fn}(${parsed.arg}) == ${Number(m[1].match(/^[\d.]+/)?.[0] ?? m[1]) * arg} — setting it to ${literal}.`,
  );
}

/** Parse the failing assertion's own source line into { fn, arg, expected }. */
function parseAssertion(line: string, lang: 'python' | 'go' | 'rust'): { fn: string; arg: string; expected: string } | null {
  if (lang === 'rust') {
    // `assert_eq!(f(n), want)` and the mirror `assert_eq!(want, f(n))`.
    const call = line.match(/assert_eq!\s*\(\s*(\w+)\s*\(\s*([\d.]+)\s*\)\s*,\s*([\d.]+)/);
    if (call) return { fn: call[1], arg: call[2], expected: call[3] };
    const mirror = line.match(/assert_eq!\s*\(\s*([\d.]+)\s*,\s*(\w+)\s*\(\s*([\d.]+)\s*\)/);
    if (mirror) return { fn: mirror[2], arg: mirror[3], expected: mirror[1] };
    return null;
  }
  if (lang === 'python') {
    // `assert f(n) == want` and the mirror `assert want == f(n)`.
    const call = line.match(/assert\s+(\w+)\s*\(\s*([\d.]+)\s*\)\s*==\s*([\d.]+)/);
    if (call) return { fn: call[1], arg: call[2], expected: call[3] };
    const mirror = line.match(/assert\s+([\d.]+)\s*==\s*(\w+)\s*\(\s*([\d.]+)\s*\)/);
    if (mirror) return { fn: mirror[2], arg: mirror[3], expected: mirror[1] };
    return null;
  }
  // Go: testify Equal(t, want, got) and the plain `if got := f(n); got != want`.
  const eq = line.match(/\.Equal\(\s*t,\s*([\d.]+),\s*(\w+)\s*\(\s*([\d.]+)\s*\)/);
  if (eq) return { fn: eq[2], arg: eq[3], expected: eq[1] };
  const got = line.match(/if\s+\w+\s*:=\s*(\w+)\s*\(\s*([\d.]+)\s*\)\s*;\s*\w+\s*!=\s*([\d.]+)/);
  if (got) return { fn: got[1], arg: got[2], expected: got[3] };
  return null;
}

/** The function's source file, body, and first parameter name. */
function findFunctionBody(
  fn: string,
  sourceRoot: string,
  lang: 'python' | 'go' | 'rust',
): { file: string; text: string; body: string; param: string } | null {
  const ext = lang === 'python' ? 'py' : lang === 'go' ? 'go' : 'rs';
  const sigRe = lang === 'python'
    ? new RegExp(`def\\s+${escapeRegExp(fn)}\\s*\\(([^)]*)\\)`)
    : lang === 'go'
      ? new RegExp(`func\\s+${escapeRegExp(fn)}\\s*\\(([^)]*)\\)`)
      : new RegExp(`fn\\s+${escapeRegExp(fn)}\\s*\\(([^)]*)\\)`);
  const paramRe = lang === 'python'
    ? /^\s*([A-Za-z_]\w*)\s*(?::[^,)]+)?(?:,|$)/
    : lang === 'go'
      ? /^\s*([A-Za-z_]\w*)\s+[^,)]+(?:,|$)/
      : /^\s*([A-Za-z_]\w*)\s*:/;
  for (const f of globSync(`**/*.${ext}`, { cwd: sourceRoot })) {
    const rel = f.replace(/\\/g, '/');
    if (/(^|[\\/])(node_modules|dist|build|\.git|target)([\\/]|$)/.test(rel)) continue;
    // The defect is in product code, not in the test that caught it.
    if (lang === 'python' && /(?:^|[/\\])test_[^/\\]*\.py$|(?:^|[/\\])[^/\\]*_test\.py$/.test(rel)) continue;
    if (lang === 'go' && /\._test\.go$/.test(rel)) continue;
    if (lang === 'rust' && (/(^|[\\/])tests([\\/]|$)/.test(rel) || /(^|[\\/])[^/\\]*_test\.rs$/.test(rel))) continue;
    const file = resolve(sourceRoot, f);
    const text = readFileSync(file, 'utf8');
    const sig = text.match(sigRe);
    if (!sig) continue;
    const params = sig[1].match(paramRe);
    if (!params) continue;
    const body = extractBody(text, sig.index ?? 0, lang);
    if (!body) continue;
    return { file, text, body, param: params[1] };
  }
  return null;
}

/** The function body starting at `sigIndex`: to the next sibling, or EOF. */
function extractBody(text: string, sigIndex: number, lang: 'python' | 'go' | 'rust'): string | null {
  const from = text.indexOf('\n', sigIndex);
  if (from === -1) return null;
  if (lang === 'rust') {
    // Brace-matched, with string literals skipped so `format!("{x}")`
    // cannot defeat the counter.
    const open = text.indexOf('{', sigIndex);
    if (open === -1) return null;
    let depth = 0;
    let inStr = false;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return text.slice(open + 1, i);
      }
    }
    return null;
  }
  if (lang === 'go') {
    const end = text.indexOf('\n\nfunc ', from + 1);
    const until = end === -1 ? text.length : end + 1;
    return text.slice(from + 1, until);
  }
  // Python: the body is indented deeper than the `def` line; it ends at the
  // first non-blank line at the def's indent or shallower.
  const defLine = text.slice(text.lastIndexOf('\n', sigIndex) + 1, from);
  const indent = defLine.match(/^[ \t]*/)?.[0].length ?? 0;
  const bodyLines = text.slice(from + 1).split('\n');
  const body: string[] = [];
  for (const l of bodyLines) {
    if (body.length && l.trim() !== '' && (l.match(/^[ \t]*/)?.[0].length ?? 0) <= indent) break;
    body.push(l);
  }
  return body.join('\n');
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
    if (/(^|[\\/])(node_modules|dist|build|\.git|target)([\\/]|$)/.test(rel)) continue;
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
