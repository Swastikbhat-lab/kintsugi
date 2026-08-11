import { cpSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * A hermetic copy of the fixture, so tests can mutate it freely without
 * touching the checkout. node_modules is copied too — the checks run the
 * fixture's own `npm run …` scripts, which resolve the local toolchain.
 */
export function copyFixture(): string {
  const fixture = resolve(import.meta.dirname, '../fixture');
  if (!existsSync(join(fixture, 'node_modules'))) {
    throw new Error('fixture/node_modules is missing — run `cd fixture && npm install` first');
  }
  const dest = mkdtempSync(join(tmpdir(), 'kintsugi-fixture-'));
  cpSync(fixture, dest, { recursive: true });
  return dest;
}

export function tempStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'kintsugi-state-')), 'ledger.json');
}
