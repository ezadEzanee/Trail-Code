/**
 * Where a session's learning goes: the repos it changed, with the files it
 * touched in each, and the files its text names by path.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { changedFiles, ownPath } from "./git-facts.js";
import { checkoutRoot, childCheckouts, repoPlace } from "./home.js";

export interface NoteTarget {
  /** A folder in the repo the note goes to. */
  dir: string;
  /** What the session touched there, relative to the top of that checkout. */
  touches: string[];
}

/** Most files one note lists per repo, and the longest path it may list (a note's reader keeps the same caps). */
export const TOUCH_LIMIT = 10;
export const TOUCH_CHARS = 300;

/**
 * Which repos a session's note belongs in, and what it touched in each.
 *
 * The repo the note was saved from gets the files it has uncommitted or
 * committed since `since`. Every other repo the session edited (`edited`:
 * absolute paths, from the agent's transcript) gets the note too, with its
 * own files, so a session that changed a backend and the library it calls
 * leaves a note in both. Saved from a folder that holds several repos, the
 * note goes to each repo the session changed, or stays with the folder when
 * it changed none. Two worktrees of one repo are one repo.
 */
export function noteTargets(dir: string, edited: string[] = [], since?: number): NoteTarget[] {
  const here = repoPlace(dir);
  const byKey = new Map<string, { dir: string; files: string[] }>();
  const add = (checkout: string, files: string[]) => {
    const key = repoPlace(checkout).key;
    const entry = byKey.get(key) ?? { dir: checkout, files: [] };
    for (const f of files) if (f && !ownPath(f) && !entry.files.includes(f)) entry.files.push(f);
    byKey.set(key, entry);
  };
  if (here.git) add(here.checkout, changedFiles(here.checkout, since));
  else if (edited.length === 0) for (const c of childCheckouts(here.checkout)) add(c, changedFiles(c, since));
  // The agent's own files (memory, plans, scratch under ~/.claude) aren't what a note is about.
  const agentFiles = join(homedir(), ".claude") + sep;
  for (const f of edited) {
    if (f.startsWith(agentFiles)) continue;
    const top = checkoutRoot(dirname(f));
    if (top) add(top, [relative(top, f).split(sep).join("/")]);
    else if (!here.git && !relative(here.checkout, f).startsWith("..")) add(here.checkout, [relative(here.checkout, f).split(sep).join("/")]);
  }
  const out = [...byKey.entries()]
    .filter(([key, e]) => e.files.length > 0 || key === here.key)
    .map(([, e]) => ({ dir: e.dir, touches: e.files.slice(0, TOUCH_LIMIT) }));
  // The repo it was saved from first; a folder of repos only when nothing else was touched.
  out.sort((a, b) => Number(repoPlace(b.dir).key === here.key) - Number(repoPlace(a.dir).key === here.key));
  const touched = out.filter((t) => t.touches.length > 0);
  if (!here.git && touched.length > 0) return touched;
  return out.length ? out : [{ dir: here.checkout, touches: [] }];
}

/** A path-shaped word in a note: `client.go`, `src/a/b.ts:12-30`, `x.go#Fn`. */
const MENTION = /(?:^|[\s(`'"\[])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?=$|[\s:#)`'",.;\]])/gm;

/**
 * Files of the checkout at `dir` that a note's text names by path. A session
 * that only read code edits nothing, so without these its note would touch no
 * file, and nothing that looks a note up by file (`trail check`, the ranked
 * search) would ever find it.
 */
export function mentionedFiles(dir: string, body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION)) {
    const f = m[1]!.replace(/^\.\//, "");
    if (out.includes(f) || ownPath(f) || f.startsWith("..")) continue;
    if (existsSync(join(dir, f))) out.push(f);
    if (out.length >= TOUCH_LIMIT) break;
  }
  return out;
}
