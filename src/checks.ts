import { spawn } from 'node:child_process';
import type { CheckDef, CheckResult } from './types.js';
import { parseTsc, parseTap, parseLines } from './parsers.js';

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

    const child = spawn(def.command, { cwd, shell: true, windowsHide: true, env: process.env });
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
      const findings = code === 0 ? [] : parse(def, output, cwd);
      resolvePromise({
        check: def.name,
        findings,
        exitCode: killed ? -2 : (code ?? -1),
        durationMs,
        crashed: killed || (code !== 0 && findings.length === 0),
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
  }
}
