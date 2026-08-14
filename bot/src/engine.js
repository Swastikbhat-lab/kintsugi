import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Path to the built engine CLI. Override with KINTSUGI_CLI for a custom build. */
export function cliPath() {
  return process.env.KINTSUGI_CLI || require.resolve('kintsugi/dist/cli.js');
}

/**
 * execFile, but a non-zero exit is data, not an exception. The engine's exit
 * code is meaningful: 0 = nothing actionable, 1 = findings remain (the
 * normal outcome of a review), >=2 = real failure (no checks discovered, a
 * crash). Callers decide what a code means.
 */
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        resolve({
          code: typeof err.code === 'number' ? err.code : 1,
          stdout: stdout ?? err.stdout ?? '',
          stderr: stderr ?? err.stderr ?? '',
        });
        return;
      }
      resolve({ code: 0, stdout, stderr });
    });
  });
}

/**
 * Best-effort install of the target repo's npm toolchain so checks like
 * `npm run typecheck` can run. A repo whose tool is missing is a broken
 * harness, which the engine reports — never heals — so a failed install
 * here is not an error.
 */
export async function installDeps(dir) {
  if (!existsSync(join(dir, 'package.json'))) return;
  try {
    await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: dir,
      timeout: 300_000,
      windowsHide: true,
    });
  } catch {
    // ignored — the checks will surface it as a broken harness
  }
}

/** Run the engine and return its parsed JSON report. */
export async function runEngine({ dir, dry = true, git = false, branch = 'kintsugi/fixes', config } = {}) {
  const args = ['--source', dir];
  if (dry) args.push('--dry');
  if (git) args.push('--git', '--branch', branch);
  if (config) args.push('--config', config);
  args.push('--json');

  const { code, stdout, stderr } = await run(process.execPath, [cliPath(), ...args], {
    cwd: dir,
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000, // first runs cold-install toolchains
    windowsHide: true,
  });

  if (code >= 2) {
    throw new Error(`engine exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`);
  }
  return JSON.parse(stdout);
}
