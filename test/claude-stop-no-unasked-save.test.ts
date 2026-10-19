/**
 * fix-lab5, item 6: Stop never asks the agent to save a learning nobody asked for, with skills on too. The 1b lab saw
 * "This took real digging and the session has saved no learning. Before you finish, save one ..." make an agent save
 * and commit a learning unasked; that text is main's old Stop (removed in phase 0, 79357c7), which ran because the
 * box repo's own build outranked the installed one. This pins it: a long turn of digging with skills on ends with no
 * ask to save, and the only thing Stop ever says is one of 1a's offers (a block whose 2 lines ask the person, yes or
 * no). Made-up repo, prompts and commands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRuns, at, box, done, finish, release, session, startHook, stopHook, typedLine } from './claude-skills-journey-fixtures.js';

const SAVE_ASK = /save (?:a|one|the) learning|trail note|graft note|took real digging|commit the learning/i;

test('a long turn of digging with skills on: no ask at Stop to save a learning', async () => {
  const b = box('stop-no-save');
  try {
    const s = session(b);
    await startHook(s, at(10, 0));
    typedLine(s, at(10, 1), 'why does the retry loop hang on the second request');
    for (const [k, c] of ['grep -rn retry src', 'sed -n 1,80p src/client.ts', 'npm test -- client', 'git log --oneline -5 src/client.ts', 'npm test'].entries())
      await agentRuns(s, at(10, 2 + k), c, () => ({ out: 'ok' }));
    const out = await finish(s, 10, 'The retry hangs because the timer is never cleared; fixed in client.ts.');
    assert.ok(!SAVE_ASK.test(JSON.stringify(out ?? {})), JSON.stringify(out));
    assert.equal(out, null, 'nothing to say at all');
    assert.equal(await stopHook(s, at(10, 60), 'done', true), '', 'and nothing on a continued Stop');
  } finally {
    done(b);
  }
});

test('when Stop does speak with skills on, it is a 1a offer that asks the person, never a save of its own', async () => {
  const b = box('stop-offer-only');
  try {
    let offers = 0;
    for (const day of [3, 5, 7]) {
      const s = session(b);
      await startHook(s, at(day, 0));
      await release(s, day, `1.4.${day}`, { failedFirst: true });
      const out = await finish(s, day, 'Published.');
      if (!out) continue;
      offers++;
      const text = JSON.stringify(out);
      assert.ok(!SAVE_ASK.test(text), text);
      assert.match(text, /\(yes \/ (?:show me \/ )?no\)/, 'the person is asked');
    }
    assert.equal(offers, 1, 'the third day offers the release once');
  } finally {
    done(b);
  }
});
