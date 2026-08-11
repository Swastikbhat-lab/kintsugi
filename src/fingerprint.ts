import { createHash } from 'node:crypto';

/**
 * Stable fingerprints are what make the ledger (and the LLM mock) work: the
 * same defect must produce the same key on every run, and a defect that is
 * actually gone must produce no key at all.
 *
 * Numbers are normalised to '#': line numbers, counts and versions change as
 * the codebase moves, and a fingerprint that changes every run might as well
 * not exist. The check name and file keep defects from different domains
 * colliding.
 */
export function fingerprint(
  check: string,
  file: string | undefined,
  code: string,
  message: string,
): string {
  const key = [check, file ?? '', code, message.replace(/\d+/g, '#')].join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}
