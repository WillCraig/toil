/**
 * The question a workflow job asks the agent (#532, part of #526). A job is a
 * page of the toil skill (src/model/jobs.ts): its steps are toil commands, its
 * writes are named in its frontmatter. Toil UI's agent already reads through
 * toil's read tools and turns every write into a proposal a person presses, so
 * running a job is asking that agent to follow the page, told plainly what is
 * different here: no shell, no working tree, no write tool. The page's own
 * words are sent as they are, so the page and the run can't drift. A loop's
 * rounds are counted from the runs the worklog holds, and the one after its
 * limit is refused, with `needs-human` named, instead of quietly run. Minutes
 * of a meeting held one agenda item at a time, with a hard stop.
 */

import { FACE, JOB_PROBLEMS, RULES, jobOf, jobLabel, parseJobPrompt, type Job, type JobId } from '../../src/model/jobs.ts';
import type { ChangeRow } from '../cache.ts';
import { AgentError } from './cli.ts';
import { pullRequestsOf } from './tools.ts';

export interface JobQuestion {
  label: string;
  text: string;
  /** What to tell the person above the answer, such as which round this is. */
  warning: string | null;
  /** The only write commands a proposal from this run may name: the page's own `writes`. */
  writes: readonly string[];
}

/** What Toil UI's agent can't do that a page assumes: said once, ahead of the page. */
const HERE = [
  'You are running inside Toil UI, not a terminal. That changes how the steps below are followed:',
  '- Where a step names a toil line, call the tool of that name: `github pr diff` is github_pr_diff, `util c4 mermaid` is util_c4_mermaid. A step whose command has no tool here was not checked: say so in the answer, never fill it in from memory.',
  "- You have no shell, no files and no working tree. A step that needs one (the repository's own gate, editing files, git commit, git push, util size on a folder) is left for the person's terminal: name it, and say what it would have to do.",
  '- Every write a page names is a proposal, written as rule 3 says, with proposal_fields called first. The page\'s own "writes" list is the only commands you may propose. Never say a write was made.',
  '- Never approve or merge a pull request yourself: a write is only ever proposed. Every finding names the tool call it came from, and everything you could not check is listed as unchecked.',
];

function target(job: Job, id: JobId, subject: string, dossier: string): string {
  if (FACE[id].on === 'pull request') return `The pull request is ${subject}: cite it as [[${subject}]]. pr_get gives it from the cache; its code host's own read tools take the repository and number inside that id.`;
  return `The repository is ${subject || `the dossier "${dossier}"'s repositories`}. Read the dossier's repositories with dossiers_show. Build the model from what your tools return (the pull requests and their files, the items, the deployments), mark every element observed or inferred as the page says, and draw it with util_c4_mermaid, putting the Mermaid text in your answer.`;
}

/** What the cache holds for the dossier: the targets a job may be asked about. */
export interface KnownTargets {
  /** Ids of the dossier's pull requests. */
  changes: ReadonlySet<string>;
  /** Repositories its pull requests name. */
  repositories: ReadonlySet<string>;
}

/**
 * A target goes into the agent's prompt and names the run in the worklog, so
 * it is only ever one the cache holds: a pull request's id, or a repository of
 * the dossier (empty for the whole dossier, Diagram only). Anything else, a
 * crafted link or another spelling of the same pull request, is refused by name.
 */
function checkTarget(id: JobId, target: string, dossier: string, known: KnownTargets): void {
  const shown = JSON.stringify(target.slice(0, 80));
  if (FACE[id].on === 'pull request') {
    if (known.changes.has(target)) return;
    throw new AgentError(`${FACE[id].label} was asked about ${shown}, which is not a pull request Toil UI has cached for ${dossier}.`, "Choose a pull request from the dossier's Pull Requests, or sync the dossier first.");
  }
  if (!target || known.repositories.has(target)) return;
  throw new AgentError(`${FACE[id].label} was asked about ${shown}, which is not a repository of ${dossier}.`, "Choose one of the dossier's repositories, or leave it empty for all of them.");
}

/**
 * The question for a job prompt (`job:review:<change id>`), or null when the
 * text isn't one. `rounds` is how many runs of this very question the worklog
 * holds (finished, or started earlier and still running). A job with a loop
 * that has used all of them throws, and so does a target the cache doesn't hold.
 */
export function jobQuestion(dossier: string, prompt: string, rounds: (label: string) => number, known: KnownTargets): JobQuestion | null {
  const asked = parseJobPrompt(prompt);
  if (!asked) return null;
  checkTarget(asked.id, asked.target, dossier, known);
  const job = jobOf(asked.id);
  if (!job) {
    const bad = JOB_PROBLEMS[asked.id];
    throw new AgentError(bad ? `The ${asked.id} workflow page can't be used: ${bad}.` : `Toil UI has no page for the ${asked.id} job.`, bad ? 'Report it: the page ships in the toil skill and is read when Toil UI is built.' : 'Upgrade Toil UI together with toil: the job pages ship in the toil skill.');
  }
  const label = jobLabel(asked.id, asked.target);
  let warning: string | null = null;
  let round = '';
  if (job.loop) {
    const used = rounds(label);
    if (used >= job.loop) {
      throw new AgentError(
        `${FACE[asked.id].label} has used its ${job.loop} rounds on ${asked.target || dossier} and stops here: it is marked needs-human.`,
        'Read what the last round left and finish by hand, and label the pull request needs-human on its host if it has none. Toil UI counts the rounds it kept in the worklog, so Ship runs on this pull request again only once those runs have aged out of its retention.',
      );
    }
    warning = `Round ${used + 1} of ${job.loop}. After round ${job.loop} it stops and the pull request is for a person.`;
    round = `This is round ${used + 1} of ${job.loop}. Say at the end what is left for the next round, and if this is round ${job.loop}, say the pull request needs a person (needs-human) and what remains.`;
  }
  const text = [
    `Run the "${job.id}" workflow page for the dossier "${dossier}". ${FACE[asked.id].gist}`,
    target(job, asked.id, asked.target, dossier),
    ...(round ? [round] : []),
    '',
    ...HERE,
    '',
    'The rules every workflow page follows:',
    RULES,
    '',
    `The page, "${job.id}" (verification: ${job.verification}):`,
    job.body,
  ].join('\n');
  return { label, text, warning, writes: job.writes };
}

/** The targets the cache holds, from a dossier's change rows. */
export function knownTargets(rows: ChangeRow[]): KnownTargets {
  const prs = pullRequestsOf(rows);
  return { changes: new Set(prs.map((c) => c.id)), repositories: new Set(prs.map((c) => c.repo)) };
}
