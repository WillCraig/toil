/// <reference types="vite/client" />
/**
 * The workflow jobs Toil UI offers (#532, part of #526), read from the pages
 * the toil skill carries (`skills/toil/workflows/*.md`, #527). A page's
 * frontmatter says what a job needs (`needs`), what it takes (`inputs`), which
 * writes it may ask for (`writes`) and how many rounds it may loop (`loop`),
 * so this file holds no list of jobs of its own: add a page and it is a job.
 * What it does add is the face each job wears on a screen (`FACE`) and the
 * pure rules: which connection a missing one would need, how the prompt names
 * a target, and how many rounds a loop has used. The pages are read at build
 * time, so Toil UI releases with the toil whose commands they call. A menu
 * that is a page, read by people who never open the page.
 */

const PAGES = import.meta.glob('../../../skills/toil/workflows/*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

export type JobId = 'review' | 'ship' | 'map-codebase';

export interface JobInput {
  name: string;
  /** Whether the Toil project supplies it. */
  toilProject: boolean;
}

export interface Job {
  id: string;
  description: string;
  role: 'reviewer' | 'author' | 'any';
  /** Areas of which one is enough, and areas that make the job read more when present. */
  needs: { any: string[]; optional: string[] };
  inputs: JobInput[];
  /** Every write the page may ask for, as `<area> <path>`; each becomes a proposal. */
  writes: string[];
  /** The round limit of its loop, or null for a job that has none. */
  loop: number | null;
  verification: string;
  /** The page's steps, without its frontmatter. */
  body: string;
}

/** What a job is called and where it applies, as a person meets it. */
export interface Face {
  /** The action's name: a verb. */
  label: string;
  /** The same in plain words (src/plain-words.ts). */
  plain: string;
  /** What it works on, for the palette and the page. */
  on: 'pull request' | 'repository';
  /** The address segment: `#/project/<name>/job/<segment>`. */
  segment: string;
  /** One line saying what pressing it does. */
  gist: string;
}

export const FACE: Record<JobId, Face> = {
  review: { label: 'Review', plain: 'Check this code change', on: 'pull request', segment: 'review', gist: "Reads the pull request and its checks, then drafts findings as comments you can post." },
  ship: { label: 'Ship', plain: 'Answer the review', on: 'pull request', segment: 'ship', gist: "Reads the review and the build on your own pull request, then drafts the replies. Editing and pushing stay in your terminal." },
  'map-codebase': { label: 'Diagram', plain: 'Draw the architecture', on: 'repository', segment: 'diagram', gist: "Models the repository's containers and draws them as a C4 diagram, saying how each part is known." },
};

export const isJobId = (id: string): id is JobId => id in FACE;
export const jobForSegment = (segment: string): JobId | null => (Object.keys(FACE) as JobId[]).find((id) => FACE[id].segment === segment) ?? null;

/** One frontmatter value: JSON where it is JSON (`needs`, `inputs`, `writes`), the bare text otherwise. */
function value(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A page as a job, or the reason it isn't one. */
export function parseJob(text: string): Job | string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) return 'it has no frontmatter';
  const fm: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(': ');
    if (at > 0) fm[line.slice(0, at).trim()] = value(line.slice(at + 2).trim());
  }
  if (typeof fm.job !== 'string') return 'it names no job';
  const role = fm.role === 'reviewer' || fm.role === 'author' || fm.role === 'any' ? fm.role : null;
  if (!role) return `its role is ${JSON.stringify(fm.role)}, not reviewer, author or any`;
  const needs = typeof fm.needs === 'object' && fm.needs !== null && !Array.isArray(fm.needs) ? (fm.needs as Record<string, unknown>) : {};
  const inputs = (Array.isArray(fm.inputs) ? fm.inputs : []).flatMap((i): JobInput[] => (typeof i === 'object' && i !== null && typeof (i as { name?: unknown }).name === 'string' ? [{ name: (i as { name: string }).name, toilProject: (i as { toilProject?: unknown }).toilProject === true }] : []));
  const loop = typeof fm.loop === 'number' && fm.loop > 0 ? fm.loop : null;
  return {
    id: fm.job,
    description: typeof fm.description === 'string' ? fm.description : '',
    role,
    needs: { any: strings(needs.any), optional: strings(needs.optional) },
    inputs,
    writes: strings(fm.writes),
    loop,
    verification: typeof fm.verification === 'string' ? fm.verification : 'unit',
    body: match[2]!.trim(),
  };
}

/** Why a page with a face could not be read as a job, by its file's name: a page that exists but doesn't parse is said so, never "missing". */
export const JOB_PROBLEMS: Record<string, string> = {};

/** Every workflow page that is a job Toil UI has a face for, in the order the issue names them. */
export const JOBS: readonly Job[] = Object.entries(PAGES)
  .filter(([path]) => !path.endsWith('/README.md'))
  .flatMap(([path, text]) => {
    const job = parseJob(text);
    if (typeof job === 'string') {
      const name = /([^/]+)\.md$/.exec(path)?.[1];
      if (name) JOB_PROBLEMS[name] = job;
      return [];
    }
    return isJobId(job.id) ? [job] : [];
  })
  .sort((a, b) => Object.keys(FACE).indexOf(a.id) - Object.keys(FACE).indexOf(b.id));

/** The shared rules every page follows (`workflows/README.md`), for the prompt. */
export const RULES: string = (Object.entries(PAGES).find(([path]) => path.endsWith('/README.md'))?.[1] ?? '').replace(/^---[\s\S]*?---\r?\n/, '').trim();

export const jobOf = (id: string): Job | null => JOBS.find((j) => j.id === id) ?? null;

export interface Availability {
  ready: boolean;
  /** When not ready: which connection would enable it, in a sentence a person can act on. */
  why: string | null;
  /** Areas the job reads more from when they are connected, and are not. */
  absent: string[];
}

const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`);

/**
 * Whether a job can run, given the areas that have a connection. `host` is the
 * area a particular pull request lives on: a job asked of that pull request
 * needs that area's connection, not just any of the page's alternatives.
 * `connected` null means Toil UI can't tell (the config is unreadable), which
 * leaves the job offered: the run itself reports a missing connection.
 */
export function availability(job: Job, connected: ReadonlySet<string> | null, host?: string): Availability {
  if (!connected) return { ready: true, why: null, absent: [] };
  const absent = job.needs.optional.filter((a) => !connected.has(a));
  const need = host && job.needs.any.includes(host) ? [host] : job.needs.any;
  if (!need.length || need.some((a) => connected.has(a))) return { ready: true, why: null, absent };
  return { ready: false, why: `Needs ${need.length === 1 ? `a ${need[0]}` : `a ${list(need)}`} connection. Add one in Settings, Connections.`, absent };
}

/** The prompt text the page sends for a job and its target: `job:review:github:imagile/payments-web#52`. */
export const jobPrompt = (id: JobId, target: string): string => `job:${id}:${target}`;

/** The reverse, for the server; null when the text isn't a job prompt. */
export function parseJobPrompt(prompt: string): { id: JobId; target: string } | null {
  const m = /^job:([a-z-]+):(.*)$/s.exec(prompt);
  return m && isJobId(m[1]!) ? { id: m[1], target: m[2]!.trim() } : null;
}

/** What a run is called in the worklog and the chat: "Review github:imagile/payments-web#52". */
export const jobLabel = (id: JobId, target: string): string => `${FACE[id].label} ${target}`;

/**
 * Rounds a loop has used: the finished runs of this job on this target that
 * the worklog holds. A stopped or failed run is not a round, since nothing
 * was answered.
 */
export function roundsUsed(runs: ReadonlyArray<{ prompt: string; outcome: string; kind?: string }>, id: JobId, target: string): number {
  return roundsUsedFor(runs, jobLabel(id, target));
}

/**
 * The same, for a label already built: what the server counts with. Only
 * questions asked in the Ask pane are rounds, never an assignment. A run still
 * running counts when it began before `self` (the run asking), so two started
 * together can't both be round 3: the earlier holds the round, the later is
 * the fourth and is refused.
 */
export function roundsUsedFor(runs: ReadonlyArray<{ id?: string; prompt: string; outcome: string; kind?: string; startedAt?: string }>, label: string, self?: { id: string; startedAt: string }): number {
  return runs.filter((r) => {
    if ((r.kind ?? 'ask') !== 'ask' || r.prompt !== label) return false;
    if (r.outcome === 'finished') return true;
    if (r.outcome !== 'running' || !self || r.id === self.id) return false;
    const at = r.startedAt ?? '';
    return at < self.startedAt || (at === self.startedAt && (r.id ?? '') < self.id);
  }).length;
}
