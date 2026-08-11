import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { CheckDef } from './types.js';

/**
 * Config loading.
 *
 * A repo without a `kintsugi.config.json` gets a sensible default derived
 * from what is actually in the repo and what its toolchain can run:
 *
 *   npm      — `typecheck` + `test` from its own package.json scripts
 *   python   — `py:test` (pytest) and `py:lint` (ruff), venv-aware
 *   go       — `go:test` (go test ./...) and `go:vet` (go vet ./...)
 *
 * Detection is marker-first (package.json / pyproject.toml / go.mod …) and
 * every toolchain check is gated on a quick availability probe, so a repo
 * never gets a check whose tool is not installed — a default check that
 * crashes on arrival would be a broken harness, not a defect. Anything more
 * specific is written in the config file, which documents itself by existing.
 */
export interface LoadedConfig {
  checks: CheckDef[];
  budget: number;
  maxIterations: number;
  allowShared: boolean;
}

/** Availability probe — returns true when the command exits 0. */
export type ToolProbe = (command: string) => Promise<boolean>;

async function probeCommand(command: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    // Same contract as runCheck: a probe is an external command, never a
    // nested child of whatever harness Kintsugi itself runs under.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(command, { shell: true, windowsHide: true, env });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); resolvePromise(false); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise(code === 0); });
  });
}

export async function loadConfig(
  sourceRoot: string,
  configPath?: string,
  probe: ToolProbe = probeCommand,
): Promise<LoadedConfig> {
  const path = resolve(sourceRoot, configPath ?? 'kintsugi.config.json');
  let file: {
    checks?: CheckDef[];
    budget?: number;
    maxIterations?: number;
    allowShared?: boolean;
  } = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(`${path} is not valid JSON`);
    }
  }

  const checks = file.checks?.length ? file.checks : await defaultChecks(sourceRoot, probe);

  return {
    checks,
    budget: file.budget ?? 2,
    maxIterations: file.maxIterations ?? 12,
    allowShared: file.allowShared ?? false,
  };
}

/**
 * Zero-config defaults for whatever the repo is. Language detections are
 * cumulative, so a mixed repo (package.json + pyproject.toml) gets the union
 * of its toolchains.
 */
export async function defaultChecks(
  sourceRoot: string,
  probe: ToolProbe = probeCommand,
): Promise<CheckDef[]> {
  const checks: CheckDef[] = [];
  checks.push(...npmChecks(sourceRoot));
  checks.push(...await pythonChecks(sourceRoot, probe));
  checks.push(...await goChecks(sourceRoot, probe));
  return checks;
}

// ------------------------------------------------------------- npm

function npmChecks(sourceRoot: string): CheckDef[] {
  const pkgPath = resolve(sourceRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];

  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
  } catch {
    return [];
  }

  const checks: CheckDef[] = [];
  if (scripts.typecheck) {
    checks.push({ name: 'typecheck', command: 'npm run typecheck', parser: 'tsc' });
  }
  if (scripts.test) {
    checks.push({ name: 'test', command: 'npm test', parser: 'tap' });
  }
  return checks;
}

// ------------------------------------------------------------- python

const PY_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'poetry.lock'];

async function pythonChecks(sourceRoot: string, probe: ToolProbe): Promise<CheckDef[]> {
  const isPython =
    PY_MARKERS.some((m) => existsSync(resolve(sourceRoot, m))) ||
    readdirSync(sourceRoot).some((n) => /^requirements.*\.txt$/.test(n));
  if (!isPython) return [];

  const checks: CheckDef[] = [];

  // Prefer the repo's own venv, then the system interpreters. `python3` is
  // probed too: on Windows it is often the Store stub, which fails fast.
  const venv = ['Scripts/python.exe', 'bin/python']
    .map((p) => resolve(sourceRoot, '.venv', p))
    .find(existsSync) ??
    ['Scripts/python.exe', 'bin/python']
      .map((p) => resolve(sourceRoot, 'venv', p))
      .find(existsSync);
  const interps = venv ? [`"${venv}"`] : ['python', 'python3'];

  let pytest: string | undefined;
  for (const interp of interps) {
    if (await probe(`${interp} -m pytest --version`)) { pytest = interp; break; }
  }
  if (pytest) {
    checks.push({
      name: 'py:test',
      command: `${pytest} -m pytest -q --tb=line`,
      parser: 'strict',
      severity: 'blocker',
    });
  }

  const ruff = await probe('ruff --version')
    ? 'ruff'
    : pytest && await probe(`${pytest} -m ruff --version`)
      ? `${pytest} -m ruff`
      : undefined;
  if (ruff) {
    checks.push({ name: 'py:lint', command: `${ruff} check . --output-format=concise`, parser: 'strict', severity: 'minor' });
  }

  return checks;
}

// ------------------------------------------------------------- go

async function goChecks(sourceRoot: string, probe: ToolProbe): Promise<CheckDef[]> {
  if (!existsSync(resolve(sourceRoot, 'go.mod'))) return [];
  if (!await probe('go version')) return [];
  return [
    { name: 'go:vet', command: 'go vet ./...', parser: 'strict', severity: 'major' },
    { name: 'go:test', command: 'go test ./...', parser: 'strict', severity: 'blocker' },
  ];
}
