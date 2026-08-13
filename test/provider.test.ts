import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeProvider } from '../src/provider.js';
import { ToolRunner } from '../src/tools.js';
import { buildImportGraph } from '../src/imports.js';
import type { Finding } from '../src/types.js';

function finding(over: Partial<Finding>): Finding {
  return {
    fingerprint: 'f',
    check: 'py:test',
    severity: 'blocker',
    summary: 'assert 100 == 10',
    evidence: {},
    ...over,
  };
}

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kintsugi-tools-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

// A stand-in for the anthropic SDK: `beta.messages.create` returns one canned
// response per call and records every prompt it was given.
class FakeRes {
  stop_reason = 'end_turn';
  usage: { input_tokens?: number; output_tokens?: number } | undefined;
  content: { type: string; text: string }[];
  constructor(text: string) {
    this.content = [{ type: 'text', text }];
  }
}

class FakeClient {
  calls: any[] = [];
  private responses: any[];
  constructor(responses: any[]) {
    this.responses = [...responses];
  }
  get beta() { return this; }
  get messages() { return this; }
  async create(opts: any) {
    this.calls.push(opts);
    return this.responses.shift();
  }
}

const VALID = JSON.stringify({
  patches: [{
    file: 'src/tax.py', find: 'return amount',
    replace: 'return amount * 0.1', rationale: 'rate',
  }],
});

// ------------------------------------------------------------- tool runner

test('ToolRunner: read_file, grep, and importers answer from the real repo', () => {
  const root = makeRepo({
    'src/tax.py': 'def apply_tax(amount):\n    return amount\n',
    'src/main.py': 'from .tax import apply_tax\n',
  });
  const runner = new ToolRunner(root, buildImportGraph(root));

  // A file ending in a newline parses to one trailing empty segment.
  const read = runner.run('read_file', { path: 'src/tax.py' });
  assert.ok(read.startsWith('src/tax.py (lines 1-3 of 3):'));
  assert.ok(read.includes('def apply_tax'));

  const ranged = runner.run('read_file', { path: 'src/tax.py', start: 2 });
  assert.ok(ranged.includes('return amount'));
  assert.ok(!ranged.includes('def apply_tax'));

  const grep = runner.run('grep', { pattern: 'apply_tax' });
  assert.ok(grep.includes('src/main.py:1'));
  assert.ok(grep.includes('src/tax.py:1'));

  const imp = runner.run('importers', { path: 'src/tax.py' });
  assert.ok(imp.includes('1 module(s) import src/tax.py'));
  assert.ok(imp.includes('src/main.py'));

  assert.ok(runner.run('importers', { path: 'src/main.py' }).includes('no module imports'));
});

test('ToolRunner: refuses paths outside the source root and bad input', () => {
  const root = makeRepo({ 'a.py': 'x = 1\n' });
  const runner = new ToolRunner(root);

  assert.ok(runner.run('read_file', { path: '../secret.py' }).includes('error'));
  assert.ok(runner.run('grep', { pattern: 'x', path: '../..' }).includes('error'));
  assert.ok(runner.run('importers', { path: '../secret.py' }).includes('error'));
  assert.ok(runner.run('frobnicate', {}).includes('unknown tool'));
  assert.ok(runner.run('grep', {}).includes('pattern'));
  assert.ok(runner.run('grep', { pattern: '[' }).includes('invalid regex'));
  // Without a graph the importers tool says so rather than guessing.
  assert.ok(runner.run('importers', { path: 'a.py' }).includes('not available'));
});

// ------------------------------------------------------------- propose loop

test('ClaudeProvider: uses a read-only tool before answering', async () => {
  const root = makeRepo({ 'src/tax.py': 'def apply_tax(amount):\n    return amount\n' });
  const file = join(root, 'src/tax.py');
  const toolReq = JSON.stringify({
    tool: { name: 'read_file', args: { path: 'src/tax.py' } }, patches: [],
  });
  const client = new FakeClient([new FakeRes(toolReq), new FakeRes(VALID)]);
  const provider = new ClaudeProvider(client as any);

  const cands = await provider.propose(finding({ file }), root, undefined, new ToolRunner(root));
  assert.equal(cands.length, 1);
  assert.equal(cands[0].find, 'return amount');
  // The tool result was fed back into the next call's prompt.
  assert.ok(client.calls[1].messages[0].content.includes('def apply_tax'));
  assert.equal(client.calls.length, 2);
});

test('ClaudeProvider: the tool budget is bounded', async () => {
  const root = makeRepo({ 'src/tax.py': 'def apply_tax(amount):\n    return amount\n' });
  const file = join(root, 'src/tax.py');
  const toolReq = JSON.stringify({ tool: { name: 'grep', args: { pattern: 'def ' } }, patches: [] });
  const client = new FakeClient([
    ...Array(7).fill(new FakeRes(toolReq)),
    new FakeRes(VALID),
  ]);
  const provider = new ClaudeProvider(client as any);

  const cands = await provider.propose(finding({ file }), root, undefined, new ToolRunner(root));
  assert.equal(cands.length, 1);
  // 6 tools execute, the 7th hits the cap, one final nudge produces the answer.
  assert.equal(client.calls.length, 8);
});

test('ClaudeProvider: an unknown tool is reported back to the model', async () => {
  const root = makeRepo({ 'src/tax.py': 'def apply_tax(amount):\n    return amount\n' });
  const file = join(root, 'src/tax.py');
  const bad = JSON.stringify({ tool: { name: 'rm', args: {} }, patches: [] });
  const client = new FakeClient([new FakeRes(bad), new FakeRes(VALID)]);
  const provider = new ClaudeProvider(client as any);

  const cands = await provider.propose(finding({ file }), root, undefined, new ToolRunner(root));
  assert.equal(cands.length, 1);
  assert.ok(client.calls[1].messages[0].content.includes('unknown tool'));
});
