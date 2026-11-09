/**
 * What making a Toil project runs, shared by the first-run wizard's project
 * step and the short New Toil project wizard (#/new-project): `projects init`,
 * one `projects add-repo` per folder, and one `projects link` per tool. All
 * three are commands Settings already runs through the server's allowlist, and
 * none is ever passed `--shared`, which would write into a repository and is a
 * decision for a team. A folder that fails does not undo the project, which is
 * why each result is kept apart. Pure apart from the calls it is handed: it
 * reads nothing and keeps nothing, and the paperwork for a new team's backlog
 * stays one form rather than three.
 */

import type { ConfigApi } from '../config.ts';
import { toolName } from '../setup.ts';
import { failedOutcome, outcomeOf, type Outcome } from './settings/parts.tsx';

/** What `projects add-repo` was asked and what it said, per location. */
export interface RepoResult {
  location: string;
  ok: boolean;
  message: string;
}

/** One tool a Toil project reads from: the area, and the connection it uses. */
export interface ToolLink {
  area: string;
  connection: string;
}

/** The lowercase letters, digits and single hyphens a Toil project's name may hold. */
export const PROJECT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What is wrong with a typed name, in plain words, or null when it can be used (an empty name is the caller's "Name it first"). */
export function nameProblem(name: string, taken: readonly string[]): string | null {
  if (name === '') return null;
  if (!PROJECT_NAME.test(name)) return 'Use lowercase letters, digits and single hyphens, such as payments.';
  if (taken.includes(name)) return `${name} is already a Toil project. Choose another name.`;
  return null;
}

/** `projects add-repo` for each location, one at a time, each result kept. */
export async function addRepos(config: ConfigApi, toilProject: string, locations: readonly string[]): Promise<RepoResult[]> {
  const out: RepoResult[] = [];
  for (const location of locations) {
    const o = await config.run('projects add-repo', { toilProject, location }).then((e) => outcomeOf(e, ''), failedOutcome);
    out.push({ location, ok: o.ok, message: o.ok ? 'added' : `${o.message}${o.fix ? ` ${o.fix}` : ''}` });
  }
  return out;
}

/** `projects link` for each tool, stopping at the first that fails. */
export async function linkTools(config: ConfigApi, toilProject: string, links: readonly ToolLink[]): Promise<Outcome> {
  for (const l of links) {
    const o = await config.run('projects link', { toilProject, area: l.area, connection: l.connection }).then((e) => outcomeOf(e, ''), failedOutcome);
    if (!o.ok) return o;
  }
  return { ok: true, message: links.length ? `${links.map((l) => toolName(l.area)).join(', ')} linked to ${toilProject}.` : `${toilProject} is ready.`, warnings: [] };
}

export interface NewProject {
  name: string;
  description: string;
  locations: readonly string[];
  links: readonly ToolLink[];
}

export type Created = { created: false; outcome: Outcome } | { created: true; repos: RepoResult[]; linked: Outcome };

/** Makes the Toil project, then adds its folders, then links its tools, saying what it is doing as it goes. A failed folder or link leaves the project made. */
export async function createProject(config: ConfigApi, p: NewProject, say: (text: string) => void = () => undefined): Promise<Created> {
  say(`Creating ${p.name}…`);
  const made = await config.run('projects init', { name: p.name, ...(p.description ? { description: p.description } : {}) }).then((e) => outcomeOf(e, `${p.name} was created.`), failedOutcome);
  if (!made.ok) return { created: false, outcome: made };
  const repos: RepoResult[] = [];
  for (const [i, location] of p.locations.entries()) {
    say(`Adding folder or address ${i + 1} of ${p.locations.length}…`);
    repos.push(...(await addRepos(config, p.name, [location])));
  }
  if (p.links.length > 0) say('Linking its tools…');
  const linked = await linkTools(config, p.name, p.links);
  return { created: true, repos, linked };
}
