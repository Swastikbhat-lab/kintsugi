import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CheckDef } from './types.js';

/**
 * Config loading.
 *
 * A repo without a `kintsugi.config.json` gets a sensible default derived
 * from its own package.json scripts — typecheck and test, if they exist.
 * Anything more specific (lint, custom checks, per-check budgets) is written
 * in the config file, which documents itself by existing.
 */
export interface LoadedConfig {
  checks: CheckDef[];
  budget: number;
  maxIterations: number;
  allowShared: boolean;
}

export function loadConfig(sourceRoot: string, configPath?: string): LoadedConfig {
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

  const checks = file.checks?.length ? file.checks : defaultChecks(sourceRoot);

  return {
    checks,
    budget: file.budget ?? 2,
    maxIterations: file.maxIterations ?? 12,
    allowShared: file.allowShared ?? false,
  };
}

/** Zero-config defaults for an npm repo: run what its own scripts offer. */
function defaultChecks(sourceRoot: string): CheckDef[] {
  const pkgPath = resolve(sourceRoot, 'package.json');
  const checks: CheckDef[] = [];
  if (!existsSync(pkgPath)) return checks;

  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {};
  } catch {
    return checks;
  }

  if (scripts.typecheck) {
    checks.push({ name: 'typecheck', command: 'npm run typecheck', parser: 'tsc' });
  }
  if (scripts.test) {
    checks.push({ name: 'test', command: 'npm test', parser: 'tap' });
  }
  return checks;
}
