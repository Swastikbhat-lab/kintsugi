import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative, resolve } from 'node:path';

const run = promisify(execFile);

/**
 * Version-control awareness.
 *
 * A tool that edits source in place has an obligation the measurement side
 * does not: the person has to be able to see what it did and undo it without
 * untangling it from their own work. Writing five verified patches into a
 * working tree that already had uncommitted changes produces one indivisible
 * blob nobody can review.
 *
 * So this is deliberately conservative. It reads state, and it commits only
 * what Kintsugi itself wrote, one patch at a time, on a branch it made. It
 * never stages someone else's edits, never amends, never pushes, and never
 * touches history.
 */

export interface RepoState {
  isRepo: boolean;
  /** No uncommitted changes anywhere in the repo. */
  clean: boolean;
  branch?: string;
  /** Paths with uncommitted changes, for a useful refusal message. */
  dirty: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

export async function inspect(sourceRoot: string): Promise<RepoState> {
  try {
    await git(sourceRoot, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { isRepo: false, clean: false, dirty: [] };
  }

  const status = await git(sourceRoot, ['status', '--porcelain']);
  // Porcelain is `XY <path>`, but stdout has already been trimmed — which
  // eats the leading space on an unstaged line and makes a fixed-width slice
  // cut into the filename. Match the status column instead of counting it.
  const dirty = status
    ? status.split('\n')
        .map((l) => l.match(/^\s*\S{1,2}\s+(.+)$/)?.[1]?.trim())
        .filter((p): p is string => !!p)
    : [];
  let branch: string | undefined;
  try {
    branch = await git(sourceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    // A repo with no commits yet has no HEAD to name. Not an error.
  }

  return { isRepo: true, clean: dirty.length === 0, branch, dirty };
}

/**
 * Move onto a branch of our own so committed patches never land on whatever
 * the person was working on. Reuses the branch if a previous run made it.
 */
export async function useBranch(sourceRoot: string, name: string): Promise<void> {
  const existing = await git(sourceRoot, ['branch', '--list', name]);
  await git(sourceRoot, existing ? ['checkout', name] : ['checkout', '-b', name]);
}

/**
 * Commit one file, or a verified unit of files (a fix and its repro test).
 * Paths are passed after `--` so a filename can never be read as a
 * revision, and only these paths are staged — a concurrent edit elsewhere
 * in the tree is not ours to sweep up.
 */
export async function commitFile(
  sourceRoot: string,
  files: string | string[],
  subject: string,
  body: string,
): Promise<string | null> {
  const rels = (Array.isArray(files) ? files : [files])
    .map((f) => relative(resolve(sourceRoot), resolve(f)).replace(/\\/g, '/'));
  await git(sourceRoot, ['add', '--', ...rels]);

  // Nothing staged means the patch was reverted before we got here.
  const staged = await git(sourceRoot, ['diff', '--cached', '--name-only', '--', ...rels]);
  if (!staged) return null;

  await git(sourceRoot, ['commit', '-q', '-m', subject, '-m', body, '--', ...rels]);
  return git(sourceRoot, ['rev-parse', '--short', 'HEAD']);
}

/** One-line-per-commit log of what this run produced, for the final report. */
export async function logSince(sourceRoot: string, since: string): Promise<string[]> {
  try {
    const out = await git(sourceRoot, ['log', '--oneline', `${since}..HEAD`]);
    return out ? out.split('\n') : [];
  } catch {
    return [];
  }
}

export async function head(sourceRoot: string): Promise<string | null> {
  try {
    return await git(sourceRoot, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

/**
 * Push the current branch to its upstream (or origin, if it has none).
 * The pusher role's one git write beyond committing: after the loop
 * verified and committed the repairs, this makes them reachable for a PR.
 * Deliberately conservative — no force, no tags, no remotes invented. A
 * push is only as safe as the branch it ships, and the loop has already
 * proven every commit on it.
 */
export async function pushBranch(sourceRoot: string, branch: string): Promise<string> {
  try {
    // Set upstream on first push so later pushes (e.g. update-a-fix-PR
    // flows) resolve without re-specifying the remote.
    await git(sourceRoot, ['push', '-u', 'origin', branch]);
    return 'pushed';
  } catch {
    return 'no-remote';
  }
}
