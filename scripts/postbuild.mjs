// Post-build step for the published CLI. TypeScript does not emit a shebang,
// but the `bin` entry (`dist/cli.js`) needs one so npm installs an executable.
import { readFile, writeFile, chmod, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'cli.js');

try {
  await access(entry);
} catch {
  console.error(`postbuild: ${entry} not found — did the build run first?`);
  process.exit(1);
}

let src = await readFile(entry, 'utf8');
if (!src.startsWith('#!')) {
  src = '#!/usr/bin/env node\n' + src;
  await writeFile(entry, src);
}
await chmod(entry, 0o755);
console.log('postbuild: dist/cli.js ready (shebang + executable)');
