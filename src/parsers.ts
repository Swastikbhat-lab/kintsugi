import { resolve, isAbsolute, relative } from 'node:path';
import type { Finding } from './types.js';
import { fingerprint } from './fingerprint.js';

/**
 * Turning raw tool output into typed findings.
 *
 * A finding is only as good as its anchor: a file, a line, a machine code and
 * a message that the healer can act on. Output that cannot name a file inside
 * the source root is not a finding — it is noise, and a loop that heals noise
 * is how an auto-fixer starts breaking things.
 */

const SKIP = /(^|[\\/])(node_modules|dist|build|\.git)([\\/]|$)/;

/**
 * Normalize a reported path against the source root; drop anything outside.
 * Returns forward-slash absolute paths so the rest of the engine never has
 * to care which OS produced them.
 */
function isAbsPath(p: string): boolean {
  // `C:/…` is absolute on Windows — and tool output can carry Windows paths
  // on any OS, so treat a drive-letter prefix as absolute everywhere. Without
  // this, a `C:/…` path is joined under the source root on POSIX and becomes
  // a phantom finding (or, worse, passes the outside-root check).
  return isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

function normalizePath(p: string, cwd: string): string | undefined {
  const cleaned = p.trim().replace(/\\/g, '/');
  if (!cleaned) return undefined;

  // `file:///C:/repo/x.ts` → `C:/repo/x.ts`; `file:///repo/x.ts` → `/repo/x.ts`.
  // Stripping `file://` wholesale would drop the root slash on POSIX and turn
  // an absolute path into a relative one.
  let abs: string;
  if (cleaned.startsWith('file://')) {
    let rest = cleaned.slice('file://'.length);
    if (/^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1);
    abs = isAbsPath(rest) ? rest : resolve(cwd, rest);
  } else {
    abs = isAbsPath(cleaned) ? cleaned : resolve(cwd, cleaned);
  }
  abs = abs.replace(/\\/g, '/');

  const rel = relative(cwd, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || SKIP.test(rel)) return undefined;
  return abs;
}

// ------------------------------------------------------------- tsc

/** `file(line,col): error TS2307: Cannot find module '...'` */
export function parseTsc(output: string, cwd: string, check: string): Finding[] {
  const findings: Finding[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm;
  for (const m of output.matchAll(re)) {
    const file = normalizePath(m[1], cwd);
    if (!file) continue;
    const code = m[4];
    const message = m[5].trim();
    findings.push({
      fingerprint: fingerprint(check, m[1], code, message),
      check,
      severity: 'major',
      summary: `${code}: ${message}`,
      file,
      line: Number(m[2]),
      code,
      evidence: { code, message, ...extractTscEvidence(code, message) },
    });
  }
  return findings;
}

function extractTscEvidence(code: string, message: string): Record<string, unknown> {
  if (code === 'TS6133') {
    const sym = message.match(/'([^']+)' is declared/);
    return sym ? { symbol: sym[1] } : {};
  }
  if (code === 'TS2307') {
    const mod = message.match(/Cannot find module '([^']+)'/);
    return mod ? { module: mod[1] } : {};
  }
  if (code === 'TS2305' || code === 'TS2459') {
    const member = code === 'TS2305'
      ? message.match(/has no exported member '([^']+)'/)?.[1]
      : message.match(/declares '([^']+)' locally/)?.[1];
    // tsc wraps the module path in *additional* quotes inside the message:
    // Module '"./pricing.js"' has no exported member 'lineTotal'. TS2459
    // reports the specifier as written; TS2305 the resolved path.
    const mod = message.match(/Module '"?([^'"]+)"?'/);
    return {
      ...(member ? { member } : {}),
      ...(mod ? { module: mod[1] } : {}),
    };
  }
  return {};
}

// ------------------------------------------------------------- tap

/**
 * Node's built-in test runner (TAP output), as produced by `node --test` /
 * `tsx --test --test-reporter=tap`. A failed test is a block:
 *
 *   not ok 2 - applyTax applies the 10% tax rate
 *     ---
 *     error: AssertionError: expected 8 to equal 10
 *         at file:///…/test/pricing.test.ts:10:23
 *     location: 'C:\…\test\pricing.test.ts:6:1'
 */
export function parseTap(output: string, cwd: string, check: string): Finding[] {
  const findings: Finding[] = [];
  const lines = output.split('\n');
  // The per-file TAP block is indented, so the anchors tolerate whitespace.
  const notOk = /^\s*not ok\s+\d+\s+-\s+(.+)$/;
  const atRe = /^\s*at\s+(.+?):(\d+):\d+\)?/;
  const locationRe = /^\s*location:\s*'(.+?):(\d+):(\d+)'/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(notOk);
    if (!m) continue;
    const title = m[1].trim();
    // The TAP reporter wraps each test file in its own block; a file whose
    // tests fail also gets a file-level "not ok". That is a harness line,
    // not a defect — skip it, or every broken test reports twice.
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(title)) continue;

    let file: string | undefined;
    let line: number | undefined;
    for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
      const at = lines[j].match(atRe);
      if (at) {
        file = normalizePath(at[1], cwd);
        line = Number(at[2]);
        break;
      }
      const loc = lines[j].match(locationRe);
      if (loc) {
        file = normalizePath(loc[1], cwd);
        line = Number(loc[2]);
        break;
      }
      // Next test block without a location — stop hunting.
      if (j > i + 1 && /^\s*(ok|not ok)\b/.test(lines[j])) break;
    }

    findings.push({
      fingerprint: fingerprint(check, file, '', title),
      check,
      severity: 'blocker',
      summary: title,
      file,
      line,
      evidence: { title },
    });
  }
  return findings;
}

// ------------------------------------------------------------- spec

/**
 * Node's built-in test runner in *spec* reporter form (`✔`/`✖`), which is
 * what `node --test` / `tsx --test` emit when stdout is piped on newer
 * Node. A failing test is a line `✖ <title> (Xms)`; the failure details
 * (error message and a stack with the real file:line) appear in the
 * trailing "✖ failing tests:" block:
 *
 *   ✖ the loop repairs five defect classes (12774ms)
 *   ℹ tests 1 …
 *   ✖ failing tests:
 *
 *   test at test\loop.test.ts:9:1
 *   ✖ the loop repairs five defect classes (12774ms)
 *     AssertionError [ERR_ASSERTION]: expected 5 committed, got: []
 *         at TestContext.<anonymous> (C:\…\test\loop.test.ts:31:10)
 */
export function parseSpec(output: string, cwd: string, check: string): Finding[] {
  const findings: Finding[] = [];
  const lines = output.split('\n');
  const titleRe = /^✖\s+(.+?)(?:\s*\(\d+(?:\.\d+)?ms\))?\s*$/;
  // The stack `at` line may be `at <fn> (file:///abs/path.ts:12:3)` or
  // `at <fn> (C:\abs\path.ts:12:3)`; anchor at end so the capture always
  // ends at the final `:line:col`. Parens and `file://` prefixes are then
  // stripped from the captured path.
  const atRe = /^\s*at\s+(.+?):(\d+):(\d+)\)?$/;
  const testAtRe = /^test at\s+(.+?):(\d+):(\d+)/;

  // Collect every ✖ occurrence with whatever location each block carries,
  // then keep the best (stack-backed, file-known) per unique title — the
  // summary block repeats titles with the real locations attached.
  const blocks: { title: string; file?: string; line?: number; fromStack: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(titleRe);
    if (!m) continue;
    const title = m[1].trim();
    if (!title || title === 'failing tests:') continue;

    let file: string | undefined;
    let line: number | undefined;
    let fromStack = false;
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
      const at = lines[j].match(atRe);
      if (at) {
        const cap = at[1];
        const cut = Math.max(cap.lastIndexOf('('), cap.indexOf('file://'));
        const path = cut >= 0 ? cap.slice(cut).replace(/^\(/, '') : cap;
        file = normalizePath(path, cwd);
        line = Number(at[2]);
        fromStack = true;
        break;
      }
      const t = lines[j].match(testAtRe);
      if (t) {
        file = normalizePath(t[1], cwd);
        line = Number(t[2]);
        break;
      }
      // Next reporter line without a location — stop hunting this block.
      if (j > i + 1 && /^[✔✖ℹ]/.test(lines[j])) break;
    }
    blocks.push({ title, file, line, fromStack });
  }

  const best = new Map<string, { file?: string; line?: number }>();
  for (const b of blocks) {
    const cur = best.get(b.title);
    if (!cur || (!cur.file && b.file) || (!cur.file && b.fromStack)) {
      best.set(b.title, { file: b.file, line: b.line });
    }
  }
  for (const [title, loc] of best) {
    findings.push({
      fingerprint: fingerprint(check, loc.file, '', title),
      check,
      severity: 'blocker',
      summary: title,
      file: loc.file,
      line: loc.line,
      evidence: { title },
    });
  }
  return findings;
}

// ------------------------------------------------------------- lines

/**
 * The plain-text contract for custom checks. Each non-empty line is either
 * `path[:line]: message` or a bare message; a `path` must look like one (a
 * dot-extension or a separator), so a message like `version-drift: …` is not
 * mistaken for a file named `version-drift`.
 */
export function parseLines(output: string, cwd: string, check: string): Finding[] {
  const findings: Finding[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:([^:]+):(\d+:)?\s*)?(.*)$/);
    const head = m?.[1];
    const looksLikeFile =
      !!head && !head.includes(' ') && (/\.\w+$/.test(head) || /[\\/]/.test(head));
    const file = looksLikeFile ? normalizePath(head!, cwd) : undefined;
    const lineNo = looksLikeFile && m?.[2] ? Number(m[2].slice(0, -1)) : undefined;
    const message = (looksLikeFile ? m?.[3] : line).trim();
    if (!message) continue;

    findings.push({
      fingerprint: fingerprint(check, file, '', message),
      check,
      severity: 'minor',
      summary: message,
      file,
      line: lineNo,
      evidence: { message },
    });
  }
  return findings;
}

// ------------------------------------------------------------- strict

/**
 * The zero-config contract for non-TS toolchains — pytest, go test, go vet,
 * ruff. Every finding must be anchored to a `file:line` inside the source
 * root; unlike `lines`, a bare line is never a finding. A `--- FAIL:`
 * heading, a `1 failed in 0.12s` footer, a `=== RUN` banner: harness noise,
 * not a defect.
 *
 * Shapes read:
 *
 *   pytest --tb=short   test_pricing.py:7: AssertionError
 *   ruff                 src/foo.py:12:5: F401 'os' imported but unused
 *   go test              foo_test.go:25: expected 10, got 5
 *   go vet               ./foo.go:12:2: fmt.Println is unused
 */
export function parseStrict(output: string, cwd: string, check: string): Finding[] {
  const findings: Finding[] = [];
  const lines = output.split('\n');
  // Optional drive letter, then a path token, then `:line`, optional `:col`,
  // then the message. The path must look like a file (an extension or a
  // separator) and never contain whitespace, so `FAIL	example.com/x	0.02s`
  // and `1 failed in 0.12s` cannot become phantom findings.
  const re = /^\s*(?:(?:[A-Za-z]:)?([^:\s]+):(\d+)(?::(\d+))?:\s*(.*))$/;
  for (let i = 0; i < lines.length; i++) {
    // Trim CR/LF and padding: tool output on Windows is CRLF, and a trailing
    // `\r` defeats the `$` anchor (it is a line terminator).
    const m = lines[i].trim().match(re);
    if (!m) continue;
    const head = m[1];
    if (!(/\.\w+$/.test(head) || /[\\/]/.test(head))) continue;
    const file = normalizePath(head, cwd);
    if (!file) continue;
    const line = Number(m[2]);
    const col = m[3] ? Number(m[3]) : undefined;
    const message = m[4].trim();
    // A traceback frame (`test_x.py:7: in test_tax_rate`) is scaffolding;
    // the error line that follows it carries the defect.
    if (/^in [\w.]+$/.test(message)) continue;
    // Tool codes travel inside the message for some tools (ruff: `F401 [*]
    // 'os' imported but unused`) — lift the leading code token out so rules
    // can dispatch on it the way they do on TSxxxx.
    const code = message.match(/^([A-Z]+\d+)\b/)?.[1];
    findings.push({
      fingerprint: fingerprint(check, file, code ?? '', message),
      check,
      severity: 'minor',
      summary: message,
      file,
      line,
      code,
      evidence: { message, ...(col !== undefined ? { col } : {}), ...(code ? { code } : {}) },
    });
  }
  return findings;
}
