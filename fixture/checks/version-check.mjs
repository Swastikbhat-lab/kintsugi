// Custom check in the plain-lines contract: print `path: message` lines for
// each problem and exit non-zero. The loop's `lines` parser turns each line
// into a finding.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const readme = readFileSync(join(root, 'README.md'), 'utf8');

const versions = new Set(readme.match(/\d+\.\d+\.\d+/g) ?? []);
const stale = [...versions].filter((v) => v !== pkg.version);

if (stale.length > 0) {
  console.log(`README.md: version ${stale.join(', ')} does not match ${pkg.version} in package.json`);
  process.exit(1);
}

console.log('version: ok');
