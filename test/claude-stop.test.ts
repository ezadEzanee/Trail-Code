/**
 * The one Stop handler (src/claude/stop.ts). In phase 0 Trail never asks to
 * save a learning on its own: a turn that took real digging ends like any
 * other, with nothing written to stdout, while the turn-end bookkeeping (the
 * cost of the turn, the background graph sync) still runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_ENV } from '../src/brand.js';
import { main } from '../src/claude/hooks.js';
import { handleStopEvent } from '../src/claude/stop.js';
import { emptyStats, readSession, readStats, writeStats } from '../src/claude/state.js';
import { ensureRepoHome } from '../src/notes/home.js';

const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const call = (command: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: Math.random().toString(36), name: 'Bash', input: { command } }] } });
const result = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const jsonl = (entries: object[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Everything a call writes to stdout. */
async function captured(fn: () => unknown): Promise<string> {
  let out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => ((out += String(chunk)), true)) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

async function stop(stdin: string): Promise<string> {
  process.env.GRAFT_TEST_STDIN = stdin;
  try {
    return await captured(() => main('stop'));
  } finally {
    delete process.env.GRAFT_TEST_STDIN;
  }
}

/** A repo under trail that keeps learnings, the case the old ask fired in. */
function trailRepo(): { dir: string; transcript: string } {
  process.env.TRAIL_HOME = mkdtempSync(join(tmpdir(), 'stop-home-'));
  process.env[BRAND_ENV] = 'trail';
  const dir = mkdtempSync(join(tmpdir(), 'stop-repo-'));
  mkdirSync(join(dir, 'graft', '.cache', 'session'), { recursive: true });
  process.env.CLAUDE_PROJECT_DIR = dir;
  ensureRepoHome(dir);
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, jsonl([prompt('why does the retry hang'), call('trail ask "retry"'), result(), call('sed -n 1,9p client.go'), result(), call('go test ./...'), result(), call('grep -n x client.go'), result()]));
  return { dir, transcript };
}

test('a turn of real digging ends with no ask to save a learning', async () => {
  const { transcript } = trailRepo();
  for (const session of ['s1', 's2']) {
    assert.equal(await stop(JSON.stringify({ session_id: session, transcript_path: transcript })), '', `no block in ${session}`);
  }
});

test('the Stop hook writes nothing, whatever it is given', async () => {
  const { transcript } = trailRepo();
  for (const stdin of ['{}', 'not json', '[]', 'null', JSON.stringify({ session_id: 's1', transcript_path: transcript, stop_hook_active: true }), JSON.stringify({ session_id: 's1', transcript_path: '/no/such/file.jsonl' })]) {
    assert.equal(await stop(stdin), '', stdin);
  }
});

test('handleStopEvent still bills the turn and starts the background sync', async () => {
  const { dir } = trailRepo();
  const t = join(dir, 'billed.jsonl');
  writeFileSync(t, jsonl([
    prompt('a question'),
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', id: 'msg_1', model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } } },
  ]));
  writeStats(dir, { ...emptyStats(), dirty: true });
  const syncRun = join(dir, 'sync-run-stub.js');
  writeFileSync(syncRun, '// test stub: spawned as a detached no-op child\n');
  process.env.GRAFT_TEST_SYNC_RUN = syncRun;
  try {
    const out = await captured(() => handleStopEvent({ session_id: 's1', transcript_path: t }, dir));
    assert.equal(out, '');
  } finally {
    delete process.env.GRAFT_TEST_SYNC_RUN;
  }
  const s = readSession(dir, 's1');
  assert.equal(s.inputTokensBilled, 100, 'the turn was billed');
  assert.equal(s.inputCostMicros, 500, '100 tokens at $5/Mtok');
  assert.equal(readStats(dir)?.syncing, true, 'a dirty graph starts its sync');
});

test('handleStopEvent takes any input without throwing or writing', async () => {
  const { dir } = trailRepo();
  for (const input of [null, undefined, 'x', 7, [], { session_id: 42, transcript_path: {} }]) {
    assert.equal(await captured(() => handleStopEvent(input, dir)), '', String(JSON.stringify(input)));
  }
});
