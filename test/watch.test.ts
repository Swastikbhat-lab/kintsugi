import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchSession, shouldWatch, snapshotTree, changedPaths } from '../src/watch.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('shouldWatch keeps source and skips build, caches, vcs and venvs', () => {
  assert.equal(shouldWatch('src/tax.py'), true);
  assert.equal(shouldWatch('test_tax.py'), true);
  assert.equal(shouldWatch('node_modules/x/y.js'), false);
  assert.equal(shouldWatch('dist/bundle.js'), false);
  assert.equal(shouldWatch('build/app.go'), false);
  assert.equal(shouldWatch('.git/config'), false);
  assert.equal(shouldWatch('.pytest_cache/README'), false);
  assert.equal(shouldWatch('.venv/Scripts/python.exe'), false);
  assert.equal(shouldWatch('__pycache__/tax.cpython-312.pyc'), false);
});

test('a burst of changes is debounced into a single run', async () => {
  let runs = 0;
  const s = new WatchSession({ debounceMs: 15, onRun: async () => { runs++; return []; } });
  s.onChange('a.py');
  s.onChange('b.py');
  s.onChange('c.py');
  await sleep(100);
  s.close();
  assert.equal(runs, 1);
});

test('a run ignores its own writes but re-runs on mid-run external edits', async () => {
  const log: string[] = [];
  let first = true;
  const s = new WatchSession({
    debounceMs: 10,
    onRun: async () => {
      log.push('run');
      if (first) {
        first = false;
        // Mid-run: the loop writes its own patch, and a human edits another file.
        s.onChange('patched.py');
        s.onChange('human.py');
        await sleep(40);
      }
      return ['patched.py'];
    },
  });
  s.onChange('kick.py');
  await sleep(200);
  s.close();
  assert.deepEqual(log, ['run', 'run']);
});

test('a run whose only mid-run writes are its own does not re-run', async () => {
  const log: string[] = [];
  let first = true;
  const s = new WatchSession({
    debounceMs: 10,
    onRun: async () => {
      log.push('run');
      if (first) {
        first = false;
        s.onChange('patched.py'); // the loop's own write
        await sleep(40);
      }
      return ['patched.py'];
    },
  });
  s.onChange('kick.py');
  await sleep(150);
  s.close();
  assert.deepEqual(log, ['run']);
});

test('runs never overlap', async () => {
  let concurrent = 0;
  let max = 0;
  const s = new WatchSession({
    debounceMs: 10,
    onRun: async () => {
      concurrent++;
      max = Math.max(max, concurrent);
      await sleep(30);
      concurrent--;
      return [];
    },
  });
  s.onChange('a.py');
  s.onChange('b.py');
  await sleep(200);
  s.close();
  assert.equal(max, 1);
});

test('ignored paths never trigger a run', async () => {
  let runs = 0;
  const s = new WatchSession({ debounceMs: 10, onRun: async () => { runs++; return []; } });
  s.onChange('.venv/lib/python3/site-packages/x.py');
  s.onChange('node_modules/pkg/index.js');
  s.onChange('.git/HEAD');
  await sleep(80);
  s.close();
  assert.equal(runs, 0);
});

test('snapshotTree fingerprints source, skips ignored dirs, changedPaths diffs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kintsugi-watch-'));
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, '.venv'), { recursive: true });
  writeFileSync(join(root, 'a.py'), 'v1');
  writeFileSync(join(root, 'node_modules/x/y.js'), 'noise');
  writeFileSync(join(root, '.venv/keep.txt'), 'noise');

  const before = snapshotTree(root);
  assert.deepEqual([...before.keys()], ['a.py']);

  await sleep(5); // mtime granularity on some filesystems
  writeFileSync(join(root, 'a.py'), 'v2');
  const after = snapshotTree(root);
  assert.deepEqual(changedPaths(before, after), ['a.py']);

  // Deleting a file is a change too.
  const gone = new Map(after);
  gone.delete('a.py');
  assert.deepEqual(changedPaths(after, gone), ['a.py']);
});
