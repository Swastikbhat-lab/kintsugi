import { spawn } from 'node:child_process';
import type { CheckDef, CheckResult } from './types.js';
import { parseTsc, parseTap, parseLines, parseSpec } from './parsers.js';

/**
 * Run one check command and turn its output into findings.
 *
 * Checks run with cwd = source root, shell-resolved, so `npm run typecheck`
 * finds the repo's own toolchain. A non-zero exit with no parseable finding
 * is a *crash*, not a defect: the loop reports it and refuses to heal it,
 * because a repair loop that "heals" a broken harness is a repair loop that
 * rewrites working code because its own plumbing failed.
 */
export function runCheck(
  def: CheckDef,
  cwd: string,
  timeoutMs = 120_000,
): Promise<CheckResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let output = '';
    let killed = false;

    // Checks are external commands and must behave as if a scheduler ran
    // them — never as a nested child of whatever harness Kintsugi itself is
    // running under. Without this, a `node --test` parent sets
    // NODE_TEST_CONTEXT and the repo's own `npm test` silently skips its
    // files ("recursively within a test file"), exiting 0 with no results.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(def.command, { cwd, shell: true, windowsHide: true, env });
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        check: def.name,
        findings: [],
        exitCode: -1,
        durationMs: Date.now() - started,
        crashed: true,
        output: `failed to start: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      // Exit 0 means the check passed — its output may still *look* like
      // findings (a version check that prints "version: ok"), but a passing
      // check contributes no findings by definition.
      // Crash means *no typed output at all* — a broken harness. Exit non-zero
      // with parseable findings is a defect, even when the filter below drops
      // every one of them (another check owns that defect class).
      const parsed = code === 0 ? [] : parseWithFallback(def, output, cwd);
      // A check owns its defect class: tsc-based lint only keeps the codes
      // it was configured for, so the same type error is not reported twice
      // by two checks and repaired (or quarantined) twice.
      const findings = def.filterCodes?.length
        ? parsed.filter((f) => def.filterCodes!.includes(f.code ?? ''))
        : parsed;
      resolvePromise({
        check: def.name,
        findings,
        exitCode: killed ? -2 : (code ?? -1),
        durationMs,
        crashed: killed || (code !== 0 && parsed.length === 0),
        output,
      });
    });
  });
}

function parse(def: CheckDef, output: string, cwd: string) {
  switch (def.parser) {
    case 'tsc': return parseTsc(output, cwd, def.name);
    case 'tap': return parseTap(output, cwd, def.name);
    case 'lines': return parseLines(output, cwd, def.name);
    default: return [];
  }
}

/**
 * A check that exits non-zero must still speak in typed findings. A repo
 * whose `npm test` runs `tsx --test` without a reporter emits *spec*
 * output (✔/✖) when piped on newer Node — indistinguishable from a crash
 * to a TAP-only parser. If the declared parser yields nothing but the
 * output is clearly spec-shaped, parse it as spec: a failing test is a
 * defect, never a broken harness.
 */
function parseWithFallback(def: CheckDef, output: string, cwd: string) {
  const parsed = parse(def, output, cwd);
  if (parsed.length === 0 && /^[✔✖ℹ]/m.test(output)) {
    return parseSpec(output, cwd, def.name);
  }
  return parsed;
}
