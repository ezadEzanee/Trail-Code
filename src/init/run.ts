/**
 * `trail init`'s look-back, start to end (design 4.1 to 4.9): start the
 * no-model look-back in a worker while init wires the repo, then show what
 * it found and keep only what the person picks.
 *
 * - The person at their own terminal (`personAtTerminal().ok`): the naming
 *   call (and phase 0's PR-review read) may run, unless `--plain` or
 *   `TRAIL_NO_LOOK_BACK` (0 rule 4); then the review screen, whose keys keep.
 * - An agent (`agentRun`: CLAUDECODE, or a claude or pty-wrapper ancestor):
 *   never a `claude` process, even a stand-in; the relay with plain names
 *   for the agent to show as written, and `pending` for `trail keep` (P2).
 * - The person's own script (no TTY, not an agent): the same list without
 *   the agent's line (B9). `--yes` there keeps only the person's own typed
 *   preferences; an agent's `--yes` keeps nothing (R25, P37).
 *
 * Phase 0's find call, which sent typed messages to the model, is gone
 * (R60, D87): `lookBackOffThread` replaces it, skills on or off.
 */
import { createHash } from 'node:crypto';
import { finishReviewRead, beginReviewRead, type ReviewFinding, type ReviewRead, type ReviewResult } from '../notes/pr-reviews.js';
import { repoPlace } from '../notes/home.js';
import { readSettings } from '../skills/settings.js';
import { nameTaken, personAtTerminal, type PersonCheck, type PersonDeps } from '../skills/store.js';
import { countBucket, durationBucket } from '../telemetry/contract.js';
import { track } from '../telemetry/track.js';
import { candidateId, pickFive } from './candidates.js';
import { whyLine } from './claude-call.js';
import { lookBackOffThread } from './discover-worker.js';
import { newRunId, readInitRecord, uncompiledOf, updateInitRecord, type InitRun } from './init-record.js';
import { keepItems, prefLine, type KeepResult } from './keep.js';
import { leadWords } from './keep-answer.js';
import { lookBackDue, lookBackOff, markLookedBack, norm } from './look-back.js';
import type { LookBackResult } from './look-back-mine.js';
import { NAME_MODEL, nameItems, type Named } from './name-call.js';
import { afterKeepLines, INIT_COPY, numbered, relayLines, repoNameOf, yesLine, type ScreenFacts } from './review-screen.js';
import { runScreen } from './review-tty.js';
import type { InitCandidate, InitItem } from './types.js';

/** An agent ran init: CLAUDECODE set, or a claude or pty-wrapper ancestor. A script the person runs with no TTY is !agentRun(env) (R17). */
export function agentRun(env: NodeJS.ProcessEnv, deps: PersonDeps = {}, person?: PersonCheck): boolean {
  if (env.CLAUDECODE !== undefined) return true;
  return (person ?? personAtTerminal(env, deps)).claudeAncestor;
}

/** 0 rule 4: the person at their own terminal, the look-back on, and no `--plain`. Never starts anything itself. */
export function mayCallClaude(env: NodeJS.ProcessEnv, flags: { plain: boolean }, deps: PersonDeps = {}, person?: PersonCheck): boolean {
  if (flags.plain || lookBackOff(env)) return false;
  return (person ?? personAtTerminal(env, deps)).ok;
}

export interface LookBackReads {
  lb: Promise<LookBackResult> | null;
  reviews: ReviewRead | null;
  person: PersonCheck;
  agent: boolean;
  model: boolean;
  plain: boolean;
  skills: boolean;
  env: NodeJS.ProcessEnv;
  started: number;
}

/** Agent runs stop reading at 100 s so the tool call ends inside Claude Code's 120 s; the person's at 300 s (3.6). */
const AGENT_CAP_MS = 100_000;
const PERSON_CAP_MS = 300_000;

/** Start the look-back and the PR-review read; the lines to print now, before anything finishes. */
export function beginLookBack(repo: string, opts: { env?: NodeJS.ProcessEnv; plain?: boolean; again?: boolean; deps?: PersonDeps } = {}):
  { reads: LookBackReads; lines: string[] } {
  const env = opts.env ?? process.env;
  const person = personAtTerminal(env, opts.deps ?? {});
  const agent = agentRun(env, opts.deps ?? {}, person);
  const plain = opts.plain === true;
  const model = !agent && mayCallClaude(env, { plain }, opts.deps ?? {}, person);
  const skills = readSettings(env).skills === 'on';
  const reads: LookBackReads = { lb: null, reviews: null, person, agent, model, plain, skills, env, started: Date.now() };
  if (lookBackOff(env) || !(opts.again || lookBackDue(repo, env))) return { reads, lines: [] };
  reads.lb = lookBackOffThread(repo, { env, capMs: agent ? AGENT_CAP_MS : PERSON_CAP_MS, skills });
  const lines = ['· looking back at your past Claude Code sessions here (about a minute)'];
  // The PR-review read is phase 0's second call: only where the naming call may run (0 rule 4).
  reads.reviews = model ? beginReviewRead(repo, env) : null;
  if (reads.reviews) lines.push("· reading review comments on this repo's merged PRs for what reviewers keep flagging");
  return { reads, lines };
}

const GUARD_DESC: Record<string, string> = { 'timeout-missing': 'this Mac has no timeout', 'git-https-auth': 'push to this repo over SSH' };

/** A PR-review finding (D24) as an item: its words are model text, so it is shown on the screen only, never relayed. */
function reviewCandidates(r: ReviewResult | null, repoKey: string, closed: Set<string>): Array<InitCandidate & { finding: ReviewFinding }> {
  return (r?.findings ?? []).map((f, n) => {
    const key = `review:${createHash('sha256').update(norm(f.title)).digest('hex').slice(0, 16)}`;
    return {
      id: candidateId('review', key), kind: 'review' as const, key, plainName: '', nameWords: leadWords(f.title),
      count: { days: f.prs.length, from: f.last, to: f.last }, scope: 'repo' as const, applies: repoKey, typed: false, ticked: false,
      review: { prs: f.prs }, evidence: [], rank: n + 1, finding: f,
    };
  }).filter((c) => !closed.has(c.id));
}

/** The shown items with their titles: the naming call's or the plain name, a guardrail's fixed words, the person's line read now. */
function itemsOf(picked: Array<InitCandidate & { n: number }>, named: Named, findings: Map<string, ReviewFinding>, env: NodeJS.ProcessEnv): InitItem[] {
  const out: InitItem[] = [];
  for (const c of picked) {
    if (c.kind === 'skill') {
      const nm = named.names[c.id];
      out.push({ ...c, title: nm?.title ?? c.plainName, description: nm?.description ?? c.skill?.compiled.description ?? '' });
    } else if (c.kind === 'guardrail') {
      out.push({ ...c, title: c.plainName, description: GUARD_DESC[c.guardrail?.cls ?? ''] ?? '' });
    } else if (c.kind === 'preference') {
      const line = prefLine(c, env);
      if (line) out.push({ ...c, title: line, description: '' });
    } else {
      const f = findings.get(c.id);
      if (f) out.push({ ...c, title: f.title, description: '' });
    }
  }
  // Numbers stay 1..k with no gap, by kind (a preference whose line is gone drops out).
  return out.map((i, k) => ({ ...i, n: k + 1 }));
}

export interface LookBackDone { kept: number; inRepo: boolean }

/**
 * Wait for the reads, show what they found (screen, relay or the script's list), keep what the person picks, and
 * write the init record. `io` is the person's terminal for the screen.
 */
export async function finishLookBack(repo: string, reads: LookBackReads,
  mode: { yes: boolean; say: (line: string) => void; io?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }; now?: Date; verbose?: boolean }): Promise<LookBackDone> {
  const none: LookBackDone = { kept: 0, inRepo: false };
  if (!reads.lb) return none;
  const { env, agent, person } = reads;
  const say = mode.say;
  const now = mode.now ?? new Date();
  let settled = false;
  void reads.lb.then(() => (settled = true));
  await Promise.resolve();
  if (!settled) say('· still looking back at your past sessions…');
  const lb = await reads.lb;
  const repoKey = repoPlace(repo, env).key;
  const record = readInitRecord(repoKey, env);
  const deferred = new Set(record.deferred);
  // An agent's init never shows what the person put off in their own terminal (4.5, B5).
  const found = lb.candidates.filter((c) => !(agent && deferred.has(c.id)));
  const first = pickFive(found);
  const skillsToName = first.filter((c) => c.kind === 'skill');
  const modelWhy = agent ? 'agent' : reads.plain ? 'plain' : !person.tty ? 'no-tty' : lookBackOff(env) ? 'off' : !person.ok ? 'not-person' : !skillsToName.length ? 'no-skills' : null;
  const namedP: Promise<Named> = reads.model && skillsToName.length
    ? nameItems(skillsToName, env, { taken: (n) => nameTaken(n, { repoKeys: [repoKey], checkout: repo, env }) !== null })
    : Promise.resolve({ names: {}, model: 'none', why: null, sentItems: 0, tokens: 0 });
  let reviewResult: ReviewResult | null = null;
  if (reads.reviews) {
    if (!reads.reviews.done) say('· still reading PR reviews…');
    reviewResult = await reads.reviews.result.catch(() => null);
  }
  const named = await namedP;
  const reviews = reviewCandidates(reviewResult, repoKey, new Set([...record.closed, ...record.runs.flatMap((r) => r.kept)]));
  const findings = new Map(reviews.map((r) => [r.id, r.finding]));
  const items = itemsOf(numbered(pickFive([...found, ...reviews.map(({ finding: _f, ...c }) => c)])), named, findings, env);
  const s = readSettings(env);
  const facts: ScreenFacts = {
    lookBack: lb, model: named.model, why: named.why, tokens: named.tokens, calls: (named.sentItems ? 1 : 0) + (reads.reviews ? 1 : 0),
    offers: s.offers, offersOffAt: s.offersOffAt, repoName: repoNameOf(repoKey), agent, skills: reads.skills,
    sentSkills: named.sentItems, reviewsRead: reviewResult?.read ?? 0, ...(named.said ? { whySaid: named.said } : {}),
  };
  if (reviewResult?.why && reviewResult.why !== named.why) say(`· ${whyLine({ why: reviewResult.why, ...(reviewResult.said ? { said: reviewResult.said } : {}) }, 'PR reviews')}`);

  // D135 (3): jobs that met the bar but didn't compile, as codes; said with --verbose.
  const uncompiled = uncompiledOf((lb.refused ?? []).map((u) => ({ job: u.job, days: u.days, why: u.why.split(', ') })));
  if (mode.verbose) for (const u of uncompiled) say(`· not offered as a skill: ${u.job}, on ${u.days} day${u.days === 1 ? '' : 's'} (${u.why.join(', ')})`);
  const screen = person.ok && !agent && !mode.yes && !!mode.io && items.length > 0;
  const run: InitRun = {
    id: newRunId(), at: now.toISOString(), by: agent ? 'agent' : person.ok ? 'person' : 'script', screen: screen ? 'tty' : agent ? 'relay' : 'list',
    reads: { sessions: lb.sessions.length, days: lb.days, from: lb.from, to: lb.to, parent: lb.parent, read: lb.sessions.map((x) => x.sh), skipped: lb.skipped,
      ...(uncompiled.length ? { uncompiled } : {}) },
    model: named.sentItems ? NAME_MODEL : 'none', modelWhy: named.why ?? modelWhy, calls: facts.calls, tokens: named.tokens, ms: lb.ms,
    shown: items.map((i) => i.id), kept: [], closed: [], deferred: [],
  };
  updateInitRecord(repoKey, (r) => {
    r.runs.push(run);
  }, env);
  const place = { dir: repo, repoKey, runId: run.id };
  const tele = (outcome: string, picked: number) => track('cold_start', {
    source: 'sessions', outcome, sessions_bucket: countBucket(lb.sessions.length), offered_bucket: countBucket(items.length),
    picked_bucket: countBucket(picked), duration_bucket: durationBucket(Date.now() - reads.started), model: run.model,
  }, { repo });

  if (!items.length) {
    for (const l of relayLines([], facts)) say(l);
    if (!reads.skills) say(INIT_COPY.skillsOff!);
    if (!lb.errors.length) markLookedBack(repo, now, env);
    if (reads.reviews) await finishReviewRead(repo, reads.reviews, async () => []);
    tele('none_found', 0);
    return none;
  }

  if (screen) {
    const answer = await runScreen(items, facts, mode.io!, { repoKey, env });
    const final = items.map((i) => ({ ...i, ...(answer.scopes[i.n] ?? {}) }));
    let result: KeepResult = { kept: [], notKept: [], refused: [] };
    if (answer.how === 'esc') {
      updateInitRecord(repoKey, (r) => {
        const ids = items.map((i) => i.id);
        r.deferred = [...new Set([...r.deferred, ...ids])];
        const me = r.runs.find((x) => x.id === run.id);
        if (me) me.deferred = ids;
        r.pending = [];
        r.pendingFrom = null;
        r.handedAt = null;
        r.handover = null;
      }, env);
      if (reads.reviews) await finishReviewRead(repo, reads.reviews, async () => null);
      tele('cancelled', 0);
    } else {
      const ticked = new Set(answer.how === 'enter' ? answer.ticked : []);
      const picked = final.filter((i) => ticked.has(i.n));
      result = keepItems(picked.filter((i) => i.kind !== 'review'), final.filter((i) => i.kind !== 'review'), 'tty', env, now, place);
      const keptReviews = picked.filter((i) => i.kind === 'review');
      if (reads.reviews) await finishReviewRead(repo, reads.reviews, async (f) => f.filter((x) => keptReviews.some((k) => findings.get(k.id) === x)));
      result = { ...result, kept: [...result.kept, ...keptReviews], notKept: final.filter((i) => !picked.includes(i)) };
      if (keptReviews.length || final.some((i) => i.kind === 'review' && !picked.includes(i))) {
        updateInitRecord(repoKey, (r) => {
          r.closed = [...new Set([...r.closed, ...final.filter((i) => i.kind === 'review' && !picked.includes(i)).map((i) => i.id)])];
          const me = r.runs.find((x) => x.id === run.id);
          if (me) me.kept = [...new Set([...me.kept, ...keptReviews.map((i) => i.id)])];
        }, env);
      }
      markLookedBack(repo, now, env);
      tele('found', result.kept.length);
    }
    for (const l of afterKeepLines({ ...result, how: answer.how }, facts)) say(l);
    return { kept: result.kept.length, inRepo: result.kept.some((i) => i.scope === 'repo' || i.kind === 'review') };
  }

  // No screen: the relay (agent) or the script's list. A PR-review finding is model text and is never relayed.
  let list = items.filter((i) => i.kind !== 'review');
  let kept = 0;
  if (mode.yes && !agent) {
    const own = list.filter((i) => i.kind === 'preference' && i.typed && !deferred.has(i.id));
    const r = keepItems(own, list, 'yes', env, now, place);
    kept = r.kept.length;
    say(yesLine(list, false));
    const gone = new Set(r.kept.map((i) => i.id));
    list = list.filter((i) => !gone.has(i.id)).map((i, k) => ({ ...i, n: k + 1 }));
  } else if (mode.yes && agent) {
    say(yesLine(list, true));
  }
  if (reads.reviews) await finishReviewRead(repo, reads.reviews, async () => null);
  if (list.length) {
    updateInitRecord(repoKey, (r) => {
      r.pending = list.map((i) => ({ ...i }));
      r.pendingFrom = run.id;
      r.shownAt = now.toISOString();
      r.handedAt = null;
      r.handover = null;
    }, env);
    for (const l of relayLines(list, facts)) say(l);
  }
  if (!reads.skills) say(INIT_COPY.skillsOff!);
  tele('relayed', kept);
  return { kept, inRepo: false };
}
