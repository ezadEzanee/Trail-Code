/**
 * Keeps the workspace's copy of a repo's learnings, and its record of how
 * they're used, in step with this machine.
 *
 * What goes up for a repo in the workspace is every learning in its `.trail/`
 * that git has: the ones committed at HEAD and the ones on teammates' pushed
 * branches, after a `git fetch`. Never an uncommitted edit or an untracked
 * file. Not just this person's, so one person is enough to cover a repo.
 * Personal learnings in ~/.trail never go up.
 *
 * Uses (a search that showed learnings, a check against them) are appended to
 * `~/.trail/outbox.jsonl` as they happen, and sent with the next sync. That's
 * how a teammate's reuse of a learning shows on the team page. A use is counts
 * and the names of the learnings shown: never what someone typed, never the
 * files they're in. And only names the workspace already has: a learning's
 * file name carries the first words of its title, so a personal learning, or
 * one git doesn't have yet, is left out. Only while the machine is connected,
 * and only for a repo in the workspace: nobody agreed to send even that for a
 * repo they didn't pick, or from before they signed in.
 *
 * Commands never wait on any of this: when something changed, a detached
 * `_trail-sync` child does it.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { graftCliPath } from "../claude/paths.js";
import { readBranchCache, refreshBranches } from "../notes/branches.js";
import { knownRepos, repoName, repoPlace, trailHome } from "../notes/home.js";
import { LEARNINGS_DIR } from "../notes/repo-trail.js";
import { parseNote, type Note } from "../notes/notes.js";
import { liveLearnings } from "../notes/learning-fields.js";
import { secretReason } from "../notes/secrets.js";
import { appendPrivateFile, ensurePrivateDir, PRIVATE_FILE_MODE, writePrivateFile } from "../util/private-file.js";
import { cacheDir, readJson, writeJsonAtomic } from "../util/state.js";
import { headLearnings } from "./head-learnings.js";
import { isError, postActivity, readCloud, uploadLearnings, type ActivityEvent, type ApiError, type Cloud, type UploadedLearning } from "./workspace.js";

/** A failed sync is retried after this long, not on every command. */
const RETRY_MS = 5 * 60 * 1000;
/** The outbox is trimmed to its newest lines past this size. */
const OUTBOX_MAX_BYTES = 1024 * 1024;
const OUTBOX_KEEP_LINES = 2000;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A learning that stays off the workspace, and why, for `trail workspace` to name. */
export interface LeftOut {
  /** Its file name in `.trail/learnings/`. */
  name: string;
  /** "" when committed at HEAD, else the pushed branch it's on. */
  ref: string;
  /** What `secretReason` saw: "an API key", "a password in a URL". Never the secret. */
  why: string;
}

/**
 * Every live learning in the repo's `.trail/`, as the workspace takes them:
 * the ones committed at HEAD, then the ones only a pushed branch has (from
 * the branch cache). Never the working tree's: an uncommitted or untracked
 * learning stays on this machine. Paths are repo-relative; nothing about this
 * machine is sent. Null when git couldn't read HEAD: then nothing may go up,
 * since a set without HEAD's learnings would tell the workspace they're gone.
 *
 * Live means what recall reads (`liveLearnings`): a retired, held or replaced
 * learning stays behind, so the team page never shows one nobody is meant to
 * follow. A learning on an unmerged branch replaces nothing yet.
 *
 * A learning whose text holds a secret (`secretReason`) stays behind, every
 * copy of it: what a sync sent is what vouches for a learning's name in a
 * use, so its name never goes up either. It is listed in `leftOut`, so
 * `trail workspace` can say so instead of it going missing in silence.
 */
export function workspaceLearnings(checkout: string): { learnings: UploadedLearning[]; leftOut: LeftOut[] } | null {
  const head = headLearnings(checkout);
  if (!head) return null;
  const read: Array<Note & { text: string }> = [];
  const leftOut: LeftOut[] = [];
  const seen = new Set<string>();
  const add = (name: string, text: string, ref: string) => {
    if (seen.has(name)) return;
    const why = secretReason(text);
    if (why) {
      seen.add(name);
      leftOut.push({ name, ref, why });
      return;
    }
    const n = parseNote(text, name);
    if (!n) return;
    seen.add(name);
    read.push({ ...n, scope: "repo", ...(ref ? { ref } : {}), text });
  };
  for (const l of head) add(l.name, l.text, "");
  for (const b of readBranchCache(checkout)?.branches ?? []) for (const l of b.learnings) add(l.name, l.text, b.ref);
  const learnings = liveLearnings(read).map((n) => ({
    path: `${LEARNINGS_DIR}/${n.path}`,
    ref: n.ref ?? "",
    branch: n.branch,
    title: n.title,
    author: n.author,
    date: n.date,
    minutes: n.cost?.minutes,
    tokens: n.cost?.tokens,
    touches: n.touches,
    body: n.body,
    hash: sha256(n.text),
  }));
  return { learnings, leftOut };
}

/** The learnings a sync uploads: `workspaceLearnings` without what it left out. Null when git couldn't read HEAD. */
export function learningsPayload(checkout: string): UploadedLearning[] | null {
  return workspaceLearnings(checkout)?.learnings ?? null;
}

function fingerprint(learnings: UploadedLearning[]): string {
  return sha256(JSON.stringify(learnings.map((l) => [l.path, l.hash]).sort()));
}

interface SyncState {
  fingerprint: string;
  at: number;
  failedAt?: number;
  learnings?: number;
}

function statePath(repo: string): string {
  return join(cacheDir(repo), "trail-workspace-sync.json");
}

/** Whether the repo at `checkout` is one of the workspace's. */
export function inWorkspace(checkout: string, cloud: Cloud | null = readCloud()): boolean {
  return !!cloud && cloud.repos.includes(repoPlace(checkout).key);
}

/**
 * Upload the repo's learnings now, after fetching teammates' branches. Only for
 * a repo in the workspace. Remembers what was sent so an unchanged repo isn't
 * sent again. When git can't read HEAD nothing is sent and the sync counts as
 * failed, so it's tried again later.
 */
export async function syncRepo(
  checkout: string,
  cloud: Cloud,
  opts: { fetch?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ repo: string; learnings: number; added: number } | ApiError> {
  const place = repoPlace(checkout);
  if (!cloud.repos.includes(place.key)) return { error: "this repo isn't in your workspace" };
  if (opts.fetch !== false) refreshBranches(place.checkout);
  const learnings = learningsPayload(place.checkout);
  const res: Awaited<ReturnType<typeof uploadLearnings>> = learnings
    ? await uploadLearnings(cloud, { repo: { key: place.key, name: repoName(place.key, place.checkout) }, learnings }, opts.fetchImpl)
    : { error: "git couldn't read this repo's learnings at HEAD" };
  const prior = readJson<SyncState>(statePath(place.checkout));
  if (isError(res)) writeJsonAtomic(statePath(place.checkout), { ...(prior ?? { fingerprint: "", at: 0 }), failedAt: Date.now() }, true);
  else if (learnings) {
    writeJsonAtomic(statePath(place.checkout), { fingerprint: fingerprint(learnings), at: Date.now(), learnings: res.learnings }, true);
    rememberSent(place.key, learnings);
  }
  return res;
}

/* -------------------------------------------------------------------------- */
/* what the workspace has                                                     */
/* -------------------------------------------------------------------------- */

/** Per repo key: the learnings its last upload from this machine carried, by file name, with their authors. */
type SentLearnings = Record<string, { at: number; learnings: Record<string, string> }>;

function sentPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(trailHome(env), "workspace-sent.json");
}

/**
 * Note what the workspace now has of a repo, which is what a use may name.
 * Two syncs of different repos at once can lose one's entry: its uses then
 * name nothing until its next sync, an undercount, never a leak.
 */
function rememberSent(key: string, learnings: UploadedLearning[]): void {
  try {
    const all = readJson<SentLearnings>(sentPath()) ?? {};
    all[key] = { at: Date.now(), learnings: Object.fromEntries(learnings.map((l) => [learningName(l.path), l.author])) };
    ensurePrivateDir(trailHome());
    writeJsonAtomic(sentPath(), all, true, PRIVATE_FILE_MODE);
  } catch {
    /* uses name nothing until the next sync */
  }
}

/** File name to author, for every learning the workspace got of each repo. Empty when nothing was sent yet. */
function readSent(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const all = readJson<SentLearnings>(sentPath());
  if (typeof all !== "object" || all === null) return out;
  for (const [key, v] of Object.entries(all)) {
    const ls = v?.learnings;
    if (typeof ls !== "object" || ls === null) continue;
    out.set(key, new Map(Object.entries(ls).filter((e): e is [string, string] => typeof e[1] === "string")));
  }
  return out;
}

/**
 * The use as it may go up: only the learnings the workspace already got of
 * its repo, each with the author that upload gave it. A personal learning,
 * an uncommitted or untracked one, or one an older trail queued, is dropped
 * from it, name and author both.
 */
function onlySent(e: ActivityEvent, sent: Map<string, Map<string, string>>): ActivityEvent {
  const has = sent.get(e.repo);
  const names = [...new Set(e.shown_paths)].filter((n) => has?.has(n));
  const authors = names.map((n) => has!.get(n)!);
  return { ...e, shown_paths: names, shown_authors: e.kind === "check" ? [...new Set(authors)] : authors };
}

/** Sync every repo of the workspace that's on this machine. Returns what went up. */
export async function syncWorkspaceRepos(cloud: Cloud, fetchImpl?: typeof fetch): Promise<{ repos: number; learnings: number }> {
  let repos = 0;
  let learnings = 0;
  for (const r of knownRepos()) {
    if (!cloud.repos.includes(r.key) || !existsSync(r.path)) continue;
    const res = await syncRepo(r.path, cloud, { fetchImpl });
    if (isError(res)) continue;
    repos++;
    learnings += res.learnings;
  }
  await flushActivity(cloud, fetchImpl);
  return { repos, learnings };
}

/* -------------------------------------------------------------------------- */
/* the activity outbox                                                        */
/* -------------------------------------------------------------------------- */

function outboxPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(trailHome(env), "outbox.jsonl");
}

/** Whether a use may go to `cloud`: the repo is the workspace's, and it happened since connecting. */
function sendable(e: ActivityEvent, cloud: Cloud): boolean {
  return cloud.repos.includes(e.repo) && Date.parse(e.at) >= (cloud.linkedAt || 0);
}

const asStrings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
const asText = (x: unknown): string => (typeof x === "string" ? x : "");

/**
 * A use as it may be queued or sent, built field by field from what was
 * handed in. Anything else is left behind: an older trail queued the query
 * (for the prompt hook, the person's whole prompt) and the file paths, and
 * neither may reach the outbox or Trail. Null when it isn't a use at all.
 */
export function activityEvent(raw: unknown): ActivityEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "search" && r.kind !== "check") return null;
  const count = typeof r.file_count === "number" && Number.isFinite(r.file_count) ? Math.max(0, Math.floor(r.file_count)) : asStrings(r.files).length;
  return {
    repo: asText(r.repo),
    kind: r.kind,
    asker: asText(r.asker),
    session: asText(r.session),
    file_count: count,
    shown_paths: asStrings(r.shown_paths),
    shown_authors: asStrings(r.shown_authors),
    at: asText(r.at),
  };
}

/**
 * Remember one use of the learnings, to send with the next sync: only while
 * this machine is connected, and only for a repo in the workspace. Not
 * connected, or another repo, and nothing is written. Never throws.
 */
export function recordActivity(use: ActivityEvent, cloud: Cloud | null = readCloud()): void {
  const e = activityEvent(use);
  if (!e || !cloud || !cloud.repos.includes(e.repo)) return;
  try {
    const p = outboxPath();
    appendPrivateFile(p, `${JSON.stringify(e)}\n`);
    if (statSync(p).size > OUTBOX_MAX_BYTES) {
      const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).slice(-OUTBOX_KEEP_LINES);
      writePrivateFile(p, `${lines.join("\n")}\n`);
    }
  } catch {
    /* a lost event undercounts reuse by one */
  }
}

/**
 * Forget every use waiting to go, and what an earlier connection was sent.
 * Run when a machine connects, so nothing recorded before that is ever sent,
 * and only what this connection uploads vouches for a learning's name.
 */
export function dropActivity(env: NodeJS.ProcessEnv = process.env): void {
  try {
    rmSync(outboxPath(env), { force: true });
    rmSync(sentPath(env), { force: true });
  } catch {
    /* sent-time filtering in flushActivity drops them anyway */
  }
}

function outboxHasEvents(): boolean {
  try {
    return statSync(outboxPath()).size > 0;
  } catch {
    return false;
  }
}

/**
 * Send the outbox. It's moved aside first, so events recorded while the
 * request is out land in a fresh file; on failure they're put back. A use
 * from before this connection, or for a repo the workspace doesn't have
 * (left by an older trail), is dropped, never sent; so is the name of any
 * learning the workspace didn't get from this machine's last upload of that
 * repo, put back or sent.
 */
export async function flushActivity(cloud: Cloud, fetchImpl?: typeof fetch): Promise<number> {
  const p = outboxPath();
  if (!outboxHasEvents()) return 0;
  const sending = `${p}.${process.pid}.sending`;
  try {
    renameSync(p, sending);
  } catch {
    return 0;
  }
  const has = readSent();
  const events: ActivityEvent[] = [];
  for (const line of readFileSync(sending, "utf8").split("\n")) {
    try {
      if (!line.trim()) continue;
      const e = activityEvent(JSON.parse(line));
      if (e && sendable(e, cloud)) events.push(onlySent(e, has));
    } catch {
      /* a torn line */
    }
  }
  let sent = 0;
  for (let i = 0; i < events.length; i += 500) {
    const res = await postActivity(cloud, events.slice(i, i + 500), fetchImpl);
    if (isError(res)) {
      // Put back what didn't go, ahead of anything recorded since.
      const rest = events.slice(i).map((e) => JSON.stringify(e)).join("\n");
      appendPrivateFile(p, `${rest}\n`);
      break;
    }
    sent += Math.min(500, events.length - i);
  }
  // Sent, or put back above: either way this copy is done with.
  rmSync(sending, { force: true });
  return sent;
}

/* -------------------------------------------------------------------------- */
/* in the background                                                          */
/* -------------------------------------------------------------------------- */

/** Whether the repo's learnings changed since they last went up, and a retry is due. Never while git can't read HEAD. */
export function syncIsDue(checkout: string, now = Date.now()): boolean {
  const state = readJson<SyncState>(statePath(checkout));
  if (state?.failedAt && now - state.failedAt < RETRY_MS) return false;
  const learnings = learningsPayload(checkout);
  return !!learnings && state?.fingerprint !== fingerprint(learnings);
}

/**
 * Sync in a detached child when this machine is connected and either the
 * repo (one of the workspace's) has learnings the workspace hasn't seen, or
 * there are uses waiting to go. Never waits, never throws.
 */
export function maybeSyncInBackground(dir: string, now = Date.now()): boolean {
  try {
    const cloud = readCloud();
    if (!cloud) {
      // Whatever an older trail queued here can never go: connecting drops it.
      dropActivity();
      return false;
    }
    const checkout = repoPlace(dir).checkout;
    const due = (inWorkspace(checkout, cloud) && syncIsDue(checkout, now)) || outboxHasEvents();
    if (!due) return false;
    // Marked first, so commands run while the child works don't start another.
    const prior = readJson<SyncState>(statePath(checkout));
    writeJsonAtomic(statePath(checkout), { ...(prior ?? { fingerprint: "", at: 0 }), failedAt: now }, true);
    const child = spawn(process.execPath, [graftCliPath(), "_trail-sync", checkout], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** `_trail-sync`: what the background child does. */
export async function runSyncChild(dir: string): Promise<void> {
  const cloud = readCloud();
  if (!cloud) return;
  const checkout = repoPlace(dir).checkout;
  if (inWorkspace(checkout, cloud)) await syncRepo(checkout, cloud);
  await flushActivity(cloud);
}

/** The name a learning's file goes by, from a path or a `ref:path`. */
export function learningName(path: string): string {
  return basename(path.slice(path.lastIndexOf(":") + 1));
}
