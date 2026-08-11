import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { relative, resolve, isAbsolute, dirname } from 'node:path';
import type { Edit } from './types.js';

/**
 * Apply an exact-string edit and hand back the undo.
 *
 * Every rule in this system produces an `Edit`: a file, a verbatim anchor,
 * and a replacement. Nothing here rewrites a file wholesale or reformats
 * around the change — the smallest edit that could clear the finding is the
 * only one worth verifying, because a large edit makes the verify step
 * unable to attribute the result.
 */
export function applyEdit(edit: Edit, sourceRoot: string): () => void {
  const root = resolve(sourceRoot);
  const file = resolve(edit.file);
  const rel = relative(root, file);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Patch targets ${file}, outside source root ${root}`);
  }

  // A create edit (test generation) writes a brand-new file and hands back
  // its deletion as the undo — reverting a failed patch must not leave an
  // orphaned file behind, any more than it leaves an edited line.
  if (edit.create) {
    if (existsSync(file)) {
      throw new Error(`Refusing to create ${rel}: it already exists`);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, edit.replace);
    return () => unlinkSync(file);
  }

  const original = readFileSync(file, 'utf8');
  if (!original.includes(edit.find)) {
    throw new Error(`Anchor not found in ${rel} — refusing to guess`);
  }

  // Match the file's own line endings. Rules are written with "\n", so on a
  // CRLF file every inserted line would arrive bare — leaving the file
  // mixed, and putting line-ending noise in someone's diff on top of the
  // lines they actually wanted.
  const crlf = (original.match(/\r\n/g) ?? []).length;
  const lf = (original.match(/(?<!\r)\n/g) ?? []).length;
  const replacement = crlf > lf ? edit.replace.replace(/\r?\n/g, '\r\n') : edit.replace;

  // Replace the first occurrence only. A patch that matches in several
  // places is ambiguous, and applying it everywhere is how one fix quietly
  // restyles half a codebase.
  writeFileSync(file, original.replace(edit.find, replacement));
  return () => writeFileSync(file, original);
}

/** Apply a patch and its companion edits as one unit; revert them in order. */
export function applyEdits(edits: Edit[], sourceRoot: string): () => void {
  const restores: (() => void)[] = [];
  for (const e of edits) restores.push(applyEdit(e, sourceRoot));
  return () => {
    for (const r of restores.reverse()) r();
  };
}
