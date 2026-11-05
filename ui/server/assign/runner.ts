/**
 * The runner behind Toil UI's assignments (#293): one agent run per
 * assignment, through the AgentHost's `task()`, so every run goes through
 * the same SDK loading, environment allowlist, usage ledger and caps as a
 * question in the Ask pane (#295). Per mode:
 *
 * - **refine** and **investigate** get the toil project's read-only tools (the
 *   cache's owi_* and pr_* tools, toil's live reads, proposal_fields) and no
 *   shell, no file writes. The finished text goes through answer.ts's
 *   checks: every id held to the tools' results, every proposal to toil's
 *   registry. Investigate's report becomes a "post as a comment" proposal.
 * - **implement** runs on Codex alone, the one adapter whose own sandbox
 *   holds commands and writes to one folder with no network on every OS
 *   Toil UI supports. The folder is under the cache. Toil UI copies the
 *   toil project repository's git directory into its `repo` (`prepareClone`), and
 *   the agent fills the working tree from the last commit, branches,
 *   changes and stages. Then, before any git runs outside the sandbox,
 *   Toil UI takes the clone's git directory back (`reclaimGitDir`: its own
 *   config, no hooks), reads the branch from `.git/HEAD` and the staged diff
 *   through toil's own read-only `git status` and `git diff`, and proposes
 *   the commit and push as git lines for a person to run, since toil has no
 *   command that pushes.
 *
 * Every tool call is in the transcript, and every call toil makes for the
 * run is in toil's audit log as `caller: "toil-ui"` with the assignment as
 * its `actor`. A runner's brief, stamped, with the carbon copy filed first.
 */

import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTER_NAME, actorOf, branchName, type AdapterChoice, type AssignAdapter, type Branch, type RepoChoice } from '../../src/assign/model.ts';
import { RunStopped, type RunContext, type RunResult, type Runner } from '../../src/assign/queue.ts';
import type { Proposal } from '../../src/proposal.ts';
import type { Envelope, Execute, WorkItem } from '../../src/toil.ts';
import { finish, writeCommands, type WriteCommand } from '../agents/answer.ts';
import { AgentError } from '../agents/cli.ts';
import type { AgentHost } from '../agents/host.ts';
import type { Workspace } from '../agents/runtime.ts';
import { cacheTools, Ledger, liveTools, proposalTool, prTools, recorded, type AgentData, type MapIds, type ReadCommand, type ToolSpec } from '../agents/tools.ts';
import { CALLER } from '../store.ts';
import { implementPrompt, modePromptText, readPrompt, splitLines, withEarlierRun } from './prompts.ts';
import type { AssignMode } from '../../src/assign/model.ts';
import type { Fingerprints } from '../fingerprint.ts';

export interface HostRunnerOptions {
  host: Pick<AgentHost, 'task' | 'adapterChoices' | 'chosen'>;
  dataDir: string;
  registry: readonly ReadCommand[];
  execute: Execute;
  mapIds: MapIds;
  data(toilProject: string): AgentData | null;
  version: string;
  toilVersion: string;
  /** What each run starts on (#305); absent, runs record no fingerprint and never go stale. */
  fingerprints?: Pick<Fingerprints, 'origin'>;
  now?: () => string;
}

/** The prompts part of an assignment's fingerprint (#305): its mode's prompts in Toil UI's own words. */
export const assignmentPrompts = (mode: AssignMode) => sha256(modePromptText(mode));

/** The largest staged diff an assignment keeps, in characters. */
export const MAX_DIFF = 200_000;

export const sha256 = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');

/** The folder implement mode's agent may write in, under the cache so a wipe takes it; the clone is its `repo`. */
export const workFolder = (dataDir: string, id: string) => join(dataDir, 'cache', 'work', id);
export const cloneOf = (folder: string) => join(folder, 'repo');

/** The tracker command that posts a comment on an item, by area, where toil has one; its input from the item and the text. */
const COMMENT: Record<string, (key: string, body: string) => { command: string; input: Record<string, unknown> }> = {
  // A GitHub key is `owner/repo#41`; `github pr comment` (CLI alias `issue comment`) comments on an issue by its number too.
  // The owner and repository come from the key, never the toil project: a board's items span repositories, and the toil project names at most one.
  github: (key, body) => {
    const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(key);
    return { command: 'github pr comment', input: m ? { owner: m[1], repo: m[2], number: Number(m[3]), body } : { number: Number(key.slice(key.lastIndexOf('#') + 1)), body } };
  },
  ado: (key, body) => ({ command: 'ado work-item comment', input: { id: key, body } }),
  jira: (key, body) => ({ command: 'jira issue comment', input: { key, body } }),
};

/** A report as one comment: its paragraphs, citations written as the ids they name. */
export const commentText = (parts: Array<{ text: string }>, by: string) => `${parts.map((p) => p.text.replace(/\[\[([^\]]+)\]\]/g, '$1')).join('\n\n')}\n\nInvestigated by ${by} through Toil UI, and posted by a person who reviewed it.`;

/** The proposal that posts an investigation's report on the item, or one that says toil can't. */
export function commentProposal(toilProject: string, item: WorkItem, body: string, writes: ReadonlyMap<string, WriteCommand>): Proposal {
  const make = COMMENT[item.source.area];
  const made = make ? make(item.source.key, body) : null;
  const known = made && writes.has(made.command) ? made : null;
  return {
    id: `agent:${item.id}:comment:report`,
    from: 'agent',
    item: item.id,
    title: `Post the report as a comment on ${item.source.key}`,
    reason: 'The investigation above, as one comment, so the people on the item can read it where they work.',
    command: known?.command ?? null,
    // The toil project goes with it, as answer.ts adds it to the agent's own proposals, so toil resolves the same connection and project.
    input: known ? (writes.get(known.command)!.fields.has('toilProject') ? { toilProject, ...known.input } : known.input) : null,
    note: known ? 'The comment is the report exactly as shown above.' : `toil has no command that comments on a ${item.source.area} item, so copy the report into the item by hand.`,
  };
}

/**
 * The commit a clone's HEAD is at, read in plain file operations: a detached
 * HEAD's own id, else its branch's loose ref, else that branch's line in
 * `packed-refs`; null when none of them says (#293 review: a commit the agent
 * made would otherwise leave the staged diff and still go out with the push).
 */
export function headCommit(folder: string): string | null {
  const git = join(folder, '.git');
  try {
    const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return head;
    const ref = /^ref: (refs\/[^\s]+)$/.exec(head)?.[1];
    if (!ref || ref.includes('..')) return null;
    try {
      const loose = readFileSync(join(git, ...ref.split('/')), 'utf8').trim();
      if (/^[0-9a-f]{40,64}$/.test(loose)) return loose;
    } catch {
      // Not loose: packed, or a branch with no commit yet.
    }
    const packed = readFileSync(join(git, 'packed-refs'), 'utf8').split(/\r?\n/).find((l) => l.endsWith(` ${ref}`));
    return packed ? packed.split(' ')[0]! : null;
  } catch {
    return null;
  }
}

/** What `.git/HEAD` names in a clone: the branch, or null for a detached HEAD or no clone. */
export function headBranch(folder: string): string | null {
  try {
    const head = readFileSync(join(folder, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

const slashes = (p: string) => p.replace(/\\/g, '/');

export function hostRunner(o: HostRunnerOptions): Runner {
  const writes = writeCommands(o.registry);
  const now = o.now ?? (() => new Date().toISOString());
  const read = (command: string, input: Record<string, unknown>, extra: { workspace?: string; actor: string }) =>
    o.execute(command, input, { readOnly: true, caller: CALLER, ...extra });

  /** Wraps each tool so its calls are in the transcript, with the assignment's actor on toil's calls. */
  const traced = (tools: ToolSpec[], ctx: RunContext): ToolSpec[] =>
    tools.map((t) => ({
      ...t,
      run: async (input, signal) => {
        const result = await t.run(input, signal);
        const failed = typeof result === 'object' && result !== null && 'error' in result;
        ctx.record({ kind: 'tool', title: `${failed ? 'Tool failed' : 'Called'}: ${t.name}`, detail: `${JSON.stringify(input)}${failed ? `\n${String((result as { error: unknown }).error)}` : ''}` });
        return result;
      },
    }));

  return {
    adapters(): AdapterChoice[] {
      return o.host.adapterChoices().map((a) => ({
        name: a.name,
        label: a.label,
        problem: a.problem,
        implement: a.workspace ? null : `${ADAPTER_NAME[a.name]} can't take implement mode through Toil UI yet: only Codex's own sandbox holds an agent's commands and writes to one folder, with no network, on Windows, macOS and Linux alike.`,
      }));
    },
    preferred: () => o.host.chosen,
    async run(ctx): Promise<RunResult> {
      const { assignment: a, item } = ctx;
      const adapter = a.adapter as AssignAdapter;
      const data = o.data(a.toilProject);
      if (!data) throw new RunStopped('error', `Toil UI hasn't synced ${a.toilProject}, so the agent has nothing to read.`, 'Press Sync now in the Sync panel, then assign again.');
      const actor = actorOf(a.id);
      // toil's live reads for this run carry the assignment as their actor in the audit log.
      const execute: Execute = (command, input, options) => o.execute(command, input, { ...options, actor });
      const ledger = new Ledger();
      const tools = traced(recorded([...cacheTools(a.toilProject, data, ledger), ...prTools(a.toilProject, data, ledger), proposalTool(o.registry), ...liveTools(a.toilProject, o.registry, execute, o.mapIds, ledger)], ledger), ctx);

      let workspace: Workspace | null = null;
      let branch: string | null = null;
      let repo: RepoChoice | null = null;
      let start: string | null = null;
      let modePrompt;
      if (a.mode === 'implement') {
        repo = await repoNamed(o.execute, a.toilProject, a.repo);
        branch = branchName(item);
        const folder = workFolder(o.dataDir, a.id);
        rmSync(folder, { recursive: true, force: true });
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        rmSync(`${folder}.commit-message.txt`, { force: true });
        start = prepareClone(repo.path, cloneOf(folder));
        workspace = { root: folder };
        modePrompt = implementPrompt(a.toilProject, item, now(), { repo: repo.name, branch });
      } else {
        modePrompt = readPrompt(a.mode, a.toilProject, item, now());
      }
      // A renewal (#305) carries what the run it renews left, fenced as data.
      modePrompt = { ...modePrompt, prompt: withEarlierRun(modePrompt.prompt, a.history) };
      const fingerprint = o.fingerprints ? await o.fingerprints.origin(a.toilProject, assignmentPrompts(a.mode)).catch(() => null) : null;
      const shown = await read('projects show', { toilProject: a.toilProject }, { actor });
      const startedOn = {
        at: now(),
        toil: o.toilVersion,
        toilUi: o.version,
        adapter,
        // The model Settings gives this adapter, known before it runs, so a run a cap or an error stops still says
        // what it ran on (#318, seen live); null is the CLI's own default. A finished run confirms it below.
        model: (o.host.adapterChoices().find((c) => c.name === adapter)?.model ?? null) as string | null,
        // Toil UI hands an assigned agent no skill: its tools and this prompt are all it gets.
        skills: [] as string[],
        tools: tools.map((t) => t.name),
        toilProject: { name: a.toilProject, fingerprint: shown.ok ? sha256(shown.data) : null },
        item: { id: item.id, updated: item.updated, fingerprint: sha256(item) },
        prompt: sha256(`${modePrompt.system}\n\n${modePrompt.prompt}`),
        fingerprint,
      };
      ctx.started?.(startedOn);
      ctx.record({ kind: 'prompt', title: 'System prompt', detail: modePrompt.system });
      ctx.record({ kind: 'prompt', title: 'Task', detail: modePrompt.prompt });

      let text: string;
      let usage;
      try {
        const done = await o.host.task({
          adapter,
          toilProject: a.toilProject,
          chat: a.id,
          system: modePrompt.system,
          prompt: modePrompt.prompt,
          tools,
          workspace,
          signal: ctx.signal,
          onText: () => undefined,
          onActivity: (act) => ctx.record({ kind: 'activity', title: act.title, ...(act.detail ? { detail: act.detail } : {}) }),
        });
        text = done.text;
        usage = done.usage;
        startedOn.model = done.model;
      } catch (e) {
        if (e instanceof AgentError) throw new RunStopped(e.capped ? 'usage' : 'error', e.message, e.fix, e.usage ?? null);
        throw e;
      }
      ctx.record({ kind: 'text', title: 'The agent answered', detail: text });

      const lines = splitLines(text);
      const by = ADAPTER_NAME[adapter];
      const answer = finish(lines.text, { toilProject: a.toilProject, prompt: a.mode, by, ledger, writes });
      const report = { parts: answer.parts, citations: answer.citations, unverified: answer.unverified ?? [], warnings: answer.warnings ?? [] };
      const proposals = [...answer.proposals];
      if (a.mode === 'investigate' && report.parts.length && !lines.injection) proposals.push(commentProposal(a.toilProject, item, commentText(report.parts, by), writes));

      let branchInfo: Branch | null = null;
      if (workspace && branch && repo) {
        const clone = cloneOf(workspace.root);
        const refused = reclaimGitDir(clone, repo.path);
        const head = headCommit(clone);
        if (refused) report.warnings.unshift(`${refused} Nothing of the agent's work is shown or proposed.`);
        else if (!start || head !== start) {
          // A commit the agent made isn't in the staged diff, so it would go out with the push unseen: nothing is proposed.
          report.warnings.unshift(`The agent moved the clone off the commit it started at (${start ? start.slice(0, 12) : 'unknown'}, now ${head ? head.slice(0, 12) : 'unknown'}), which it was told never to do, so its commits aren't in the diff below and no commit or push is proposed. Look at the clone's history yourself before you use any of it.`);
          branchInfo = await branchOf(read, clone, branch, repo.name, actor);
        } else {
          branchInfo = await branchOf(read, clone, branch, repo.name, actor);
          if (!branchInfo.onBranch) report.warnings.unshift(`The clone isn't on ${branch}, the branch the agent was asked to make, so check its work before you use it.`);
          if (branchInfo.cut) {
            // Whatever comes after the cut would go out with the commit unread: nothing is proposed.
            report.warnings.unshift(`The staged diff is too long to show in full (toil stops reading at 5,000 lines, and the page at ${MAX_DIFF.toLocaleString('en-US')} characters), so part of the change would go out with the commit unread, and no commit or push is proposed. Look at the clone yourself before you use any of it.`);
          } else if (branchInfo.hidden.length) {
            // Whatever the diff doesn't show would go out with the commit unread: nothing is proposed.
            report.warnings.unshift(`The staged change includes ${branchInfo.hidden.length === 1 ? 'a file' : `${branchInfo.hidden.length} files`} the diff below doesn't show: ${branchInfo.hidden.join(', ')}. It may be a submodule link, a mode change, a binary file or anything else git's diff leaves out (and toil's git status can drop the first character of the first name it lists, so a name may look one character short), and it would go out with the commit unread, so no commit or push is proposed. Look at the clone yourself before you use any of it.`);
          } else if (branchInfo.files.length) {
            // The message goes in a file beside the agent's folder, written after the run, so nothing from the tracker is shell syntax on the person's command line.
            const message = `${workspace.root}.commit-message.txt`;
            writeFileSync(message, `${item.source.key}: ${item.title}\n\n${item.url ?? item.id}\n`);
            proposals.unshift(pushProposal(item, branchInfo, slashes(message), slashes(`${workspace.root}.no-hooks`)));
          }
        }
      }
      return { report, proposals, questions: lines.questions, injection: lines.injection, usage, startedOn, branch: branchInfo };
    },
  };
}

/** The toil project's repositories that have a local path: what implement mode can clone. */
export async function reposOf(execute: Execute, toilProject: string): Promise<RepoChoice[]> {
  const e = await execute('projects show', { toilProject }, { readOnly: true, caller: CALLER });
  if (!e.ok) return [];
  const repos = ((e.data as { toilProject?: { repos?: unknown } } | null)?.toilProject?.repos ?? []) as Array<{ name?: unknown; path?: unknown }>;
  return (Array.isArray(repos) ? repos : []).flatMap((r) => (typeof r.name === 'string' && typeof r.path === 'string' && r.path ? [{ name: r.name, path: r.path }] : []));
}

async function repoNamed(execute: Execute, toilProject: string, name: string | null): Promise<RepoChoice> {
  const repos = await reposOf(execute, toilProject);
  const hit = repos.find((r) => r.name === name) ?? (name === null && repos.length === 1 ? repos[0] : undefined);
  if (!hit) throw new RunStopped('error', `${toilProject} has no repository ${name ?? ''} with a local path any more.`, `Check toil projects show ${toilProject}, then assign again.`);
  return hit;
}

/** The clone's branch, its changed files and its staged diff, through toil's own read-only git commands. */
export async function branchOf(read: (command: string, input: Record<string, unknown>, extra: { workspace?: string; actor: string }) => Promise<Envelope>, folder: string, name: string, repo: string, actor: string): Promise<Branch> {
  const status = await read('git status', {}, { workspace: folder, actor });
  const diff = await read('git diff', { staged: true }, { workspace: folder, actor });
  const files = status.ok ? filesOf(status.data) : [];
  let text: string | null = null;
  let rawLength = 0;
  if (diff.ok) {
    const raw = typeof diff.data === 'string' ? diff.data : (unified(diff.data) ?? JSON.stringify(diff.data, null, 2));
    rawLength = raw.length;
    text = raw.length > MAX_DIFF ? `${raw.slice(0, MAX_DIFF)}\n[cut at ${MAX_DIFF} characters]` : raw;
  }
  const hidden = status.ok ? hiddenStaged(status.data, diff.ok ? diff.data : null) : files.map((f) => f.path);
  return { name, repo, folder: slashes(folder), onBranch: headBranch(folder) === name, files, diff: text, hidden, cut: diff.ok ? diffCut(diff.data, rawLength) : false };
}

/**
 * The staged paths the reviewed diff doesn't show in full (#293 review round
 * 4): every path `git status` lists as staged that toil's `git diff --staged`
 * has no hunk of text for. A gitlink (which `diff.ignoreSubmodules = all`
 * leaves out), a mode-only change, a binary file, a path either side quotes
 * differently: each would go out with the person's commit unread, so any one
 * of them means no commit or push is proposed. A rename is read by its new
 * path. With no readable diff, every staged path is hidden.
 */
export function hiddenStaged(status: unknown, diff: unknown): string[] {
  const staged = Array.isArray((status as { staged?: unknown } | null)?.staged) ? ((status as { staged: unknown[] }).staged.filter((p) => typeof p === 'string') as string[]) : [];
  const files = (diff as { files?: unknown } | null)?.files;
  const shown = new Set(
    (Array.isArray(files) ? (files as Array<{ path?: unknown; binary?: unknown; hunks?: unknown }>) : [])
      .filter((f) => typeof f.path === 'string' && f.binary !== true && Array.isArray(f.hunks) && f.hunks.length > 0)
      .map((f) => f.path as string),
  );
  return staged.filter((p) => !shown.has(p.includes(' -> ') ? p.slice(p.lastIndexOf(' -> ') + 4) : p));
}

/**
 * Whether the diff a person reads stops short (#293 review round 6): toil's
 * `git diff` stopped parsing (at 5,000 lines), stopped in one file, or the
 * text was cut at MAX_DIFF characters. Whatever comes after the cut would
 * go out with the commit unread, so a cut diff, like a hidden path, means no
 * commit or push is proposed.
 */
export function diffCut(data: unknown, rawLength: number): boolean {
  const d = (data ?? {}) as { truncated?: unknown; files?: unknown };
  return d.truncated === true || (Array.isArray(d.files) && d.files.some((f) => (f as { truncated?: unknown }).truncated === true)) || rawLength > MAX_DIFF;
}

/** toil's `git diff` (files of hunks) as the unified diff a person reads, or null for a shape it doesn't know. */
export function unified(data: unknown): string | null {
  const files = (data as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return null;
  const out: string[] = [];
  for (const f of files as Array<{ path?: string; binary?: boolean; truncated?: boolean; hunks?: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines?: string[] }> }>) {
    out.push(`--- a/${f.path}`, `+++ b/${f.path}`);
    if (f.binary) out.push('(binary)');
    for (const h of f.hunks ?? []) out.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`, ...(h.lines ?? []));
    if (f.truncated) out.push(`[toil stopped reading the diff of ${f.path} here: the rest of it isn't shown]`);
  }
  if ((data as { truncated?: unknown }).truncated === true) out.push("[toil stopped reading the diff here, after 5,000 lines: the rest isn't shown]");
  return out.join('\n');
}

/** `git status`'s files, whatever shape the toil in use reports them in. */
function filesOf(data: unknown): Branch['files'] {
  const d = (data ?? {}) as Record<string, unknown>;
  const out: Branch['files'] = [];
  for (const [status, list] of Object.entries(d)) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (typeof f === 'string') out.push({ path: f, status });
      else if (f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string') out.push({ path: (f as { path: string }).path, status: String((f as { status?: unknown }).status ?? status) });
    }
  }
  return out;
}

/**
 * Makes implement mode's clone before the run (#293): a copy of the person's
 * clone's git directory into the agent's folder, without its hooks or
 * config (`reclaimGitDir` writes Toil UI's own), and no working tree. The
 * agent fills the working tree from the last commit inside its sandbox, so
 * it never has to read the person's clone, which Codex's sandbox on Windows
 * won't map (git's local clone fails there with "CreateFileMapping", error
 * 5), and uncommitted work in the person's clone never comes along. Throws
 * when the toil project's path isn't a plain git clone. Returns the commit the
 * clone starts at, which the agent must not move.
 */
export function prepareClone(source: string, clone: string): string | null {
  const git = join(source, '.git');
  let st;
  try {
    st = lstatSync(git);
  } catch {
    throw new RunStopped('error', `${slashes(source)} isn't a git clone, so implement mode has nothing to copy.`, 'Point the Toil project repository at a git clone (toil projects add-repo <Toil project> <folder>), then assign again.');
  }
  if (!st.isDirectory()) throw new RunStopped('error', `${slashes(source)} is a git worktree or a submodule (its .git is a file), so implement mode can't copy it.`, 'Point the Toil project repository at the main clone, then assign again.');
  // A lock file anywhere is git at work in the person's clone (a commit, or the background maintenance git 2.5x
  // starts after one) and may vanish mid-copy; a file that still vanishes between listing and copying gets a fresh try.
  const copy = () => cpSync(git, join(clone, '.git'), { recursive: true, filter: (from) => !/[\\/]\.git[\\/](hooks|config)$/.test(from) && !/\.lock$/.test(from) });
  for (let attempt = 1; ; attempt++) {
    try {
      copy();
      break;
    } catch (e) {
      rmSync(join(clone, '.git'), { recursive: true, force: true });
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || attempt === 3) throw new RunStopped('error', `Toil UI couldn't copy ${slashes(git)}: ${(e as Error).message}`, 'Wait for git to finish in that clone, then assign again.');
    }
  }
  const refused = reclaimGitDir(clone, source);
  if (refused) throw new RunStopped('error', refused, 'Assign it again.');
  return headCommit(clone);
}

/**
 * Takes back the clone's git directory before anything runs git there
 * outside the sandbox (#293 review): toil's `git status` and `git diff`
 * after the run, and the person's commit and push. The agent could write
 * anything under its folder, `.git` included, and git runs what a
 * repository's own config names (a clean or smudge filter) or what its hooks
 * folder holds. So Toil UI, in plain file operations and before any git
 * runs: refuses a `.git` that isn't a directory (a `gitdir:` file points
 * anywhere); rewrites `.git/config` whole, keeping from the person's own
 * clone only its format version and `[extensions]`, with `origin` at that
 * clone and submodules ignored (their own configs are the agent's too);
 * with replace refs off; and deletes the hooks folder, `commondir`,
 * `config.worktree`, `info/attributes`, `info/grafts` and `refs/replace`
 * (and any replace ref in `packed-refs`). What the agent left in the working tree's
 * `.gitattributes` can name a filter, and a filter with no definition does
 * nothing. Returns why it couldn't, or null.
 */
export function reclaimGitDir(clone: string, source: string): string | null {
  const git = join(clone, '.git');
  let st;
  try {
    st = lstatSync(git);
  } catch {
    return `The agent left no clone at ${slashes(clone)}.`;
  }
  if (!st.isDirectory()) return `The clone's .git at ${slashes(git)} isn't a folder, so Toil UI won't run git there.`;
  let theirs = '';
  try {
    theirs = readFileSync(join(source, '.git', 'config'), 'utf8');
  } catch {
    // A source with no readable config: the defaults below, format version 0.
  }
  const version = /^\s*repositoryformatversion\s*=\s*(\d+)\s*$/m.exec(theirs)?.[1] ?? '0';
  const extensions = /^\[extensions\][^\n]*\n((?:[ \t]+[^\n]*\n?)*)/m.exec(theirs)?.[1] ?? '';
  const url = slashes(source).replace(/["\\]/g, '');
  const config = [
    '[core]',
    `\trepositoryformatversion = ${version}`,
    '\tbare = false',
    '\tuseReplaceRefs = false',
    '[diff]',
    '\tignoreSubmodules = all',
    '[remote "origin"]',
    `\turl = "${url}"`,
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ...(extensions.trim() ? ['[extensions]', ...extensions.trimEnd().split('\n')] : []),
    '',
  ].join('\n');
  // Replace refs and grafts make git read one commit as another, so a staged diff could hide what a commit carries (review round 3).
  for (const p of ['hooks', 'commondir', 'config.worktree', join('info', 'attributes'), join('info', 'grafts'), join('refs', 'replace')]) rmSync(join(git, p), { recursive: true, force: true });
  try {
    const packed = readFileSync(join(git, 'packed-refs'), 'utf8');
    const lines = packed.split(/\r?\n/);
    // A peeled line (^<id>) belongs to the ref above it, so it goes with a replace ref too.
    const kept = lines.filter((l, i) => !/ refs\/replace\//.test(l) && !(l.startsWith('^') && / refs\/replace\//.test(lines[i - 1] ?? '')));
    if (kept.length !== lines.length) writeFileSync(join(git, 'packed-refs'), kept.join('\n'));
  } catch {
    // No packed-refs: nothing packed to take out.
  }
  writeFileSync(join(git, 'config'), config);
  return null;
}

/** Commit and push are a person's: toil has no command for either, so the proposal is the exact git lines. */
export function pushProposal(item: WorkItem, b: Branch, messageFile: string, noHooks: string): Proposal {
  // Double quotes mean the same in PowerShell, cmd.exe and POSIX shells for a value without $, `, %, " or a line break; only Toil UI's own paths go in them.
  const unsafe = [b.folder, messageFile, noHooks].some((v) => /[$`%"\r\n]/.test(v));
  const q = (v: string) => `"${v}"`;
  const lines = unsafe
    ? `toil has no command that commits or pushes, and the clone's path holds a character no shell line can carry safely, so in a terminal in ${b.folder} commit with the message in ${messageFile} (git --no-replace-objects -c core.hooksPath=<a folder that doesn't exist> commit --no-verify -F <that file>) and push the same way with push --no-verify origin HEAD:refs/heads/${b.name}.`
    : `toil has no command that commits or pushes, so run these in a terminal once the diff looks right: git -C ${q(b.folder)} --no-replace-objects -c core.hooksPath=${q(noHooks)} commit --no-verify -F ${q(messageFile)} then git -C ${q(b.folder)} --no-replace-objects -c core.hooksPath=${q(noHooks)} push --no-verify origin HEAD:refs/heads/${b.name}.`;
  return {
    id: `agent:${item.id}:push:${b.name}`,
    from: 'agent',
    item: item.id,
    title: `Commit and push ${b.name}`,
    reason: `The agent staged ${b.files.length === 1 ? 'one file' : `${b.files.length} files`} on ${b.name} in a clone of ${b.repo}. Review the staged diff, then commit and push it yourself.`,
    command: null,
    input: null,
    note: `${lines} The message is the item's key, title and link, in that file. Toil UI rewrote the clone's git config and removed its hooks before showing the diff; core.hooksPath points git at a folder that doesn't exist, so no hook runs even if one comes back, --no-verify is there besides, and --no-replace-objects reads every commit as itself. The clone's origin is your local clone of ${b.repo}, so the branch lands there first; push it on from there.`,
  };
}
