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
    abs = isAbsolute(rest) ? rest : resolve(cwd, rest);
  } else {
    abs = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
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
