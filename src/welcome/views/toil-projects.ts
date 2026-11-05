import { briefRun } from './briefing.js';
import { CONNECTION_NAME, connectionsOf, connectionWrites, defaultConnectionName, type ResolvedConfig } from '../../core/config.js';
import { hostMatches } from '../../core/toil-project.js';
import { hostOf, ok, type WelcomeData } from '../screens.js';
import { pal, paint } from '../term.js';
import { commandLine, type Action, type Caps, type Item, type Run, type Step, type StepResult, type View, type ViewProps } from '../view.js';

/**
 * The Toil projects module: what this folder resolves to, the create wizard,
 * review and fix, edit, export and import, hand-off to an agent, and delete.
 * Every action is a real `toil projects …` or `toil repos scan` command (and,
 * for discovery and service checks, an area's own read), run in-process and
 * shown as it runs. The menu never writes a toil project itself, so it can't write
 * one the commands would refuse.
 *
 * A toil project's screens read the last `toil projects show` and `check` the menu ran
 * for it (`Session.toil projects`), and every edit runs `show` again after it, so
 * what's on screen is the file as it now is. One-off reads (the folder, the
 * list, a scan, a discovery) are handed to the next screen as a parameter.
 *
 * Binding a section to a connection with writes on asks for the connection's
 * name typed out first, as turning writes on does: the commands let a person
 * on the CLI do it unasked, and the menu is a person on the CLI who has been
 * asked to sign twice, which is still fewer signatures than the usual form.
 */

// ─── What the commands return, as far as these screens read it ─────────────

interface Problem {
  level: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

interface AreaShown {
  connection: { value: string; source: string; host?: string } | null;
  writes: boolean | null;
  env: string | null;
  inputs: Record<string, string>;
  error?: { code: string; message: string; fix?: string };
}

/** `toil projects show`. */
interface Shown {
  name: string;
  source: string;
  file: string;
  adopted: boolean;
  areas: Record<string, AreaShown>;
  toilProject: Record<string, unknown>;
  problems: Problem[];
}

/** `toil projects check`. */
interface Checked {
  name: string | null;
  /** Null when the file is too broken to load. */
  file: string | null;
  ok: boolean;
  problems: Problem[];
  message?: string;
}

interface Applied {
  name: string;
  source: string;
  file: string;
  by: string;
  match: string | null;
  repo: string | null;
}

/** `toil projects context`. */
interface Context {
  folder: { path: string; from: string } | null;
  repo: { root: string; origin: string | null } | null;
  toilProject: Applied | null;
  candidates: Applied[];
}

/** `toil projects list`. */
interface Listed {
  toilProjects: Array<{ name: string; description: string | null; source: string; file: string; shadowedBy: string | null; problems: number }>;
  broken: Array<{ source: string; file: string; problems: Array<{ path: string; message: string }> }>;
}

interface Repo {
  name: string;
  path?: string;
  remotes: string[];
}

type Section = Record<string, unknown>;

// ─── Small helpers ─────────────────────────────────────────────────────────

const json = (value: unknown) => JSON.stringify(value);

const parse = <T>(text: string | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const config = (data: WelcomeData): ResolvedConfig | undefined => ('error' in data.config ? undefined : data.config);

const muted = (caps: Caps, text: string) => paint(caps, pal(caps).muted, text);
const faint = (caps: Caps, text: string) => paint(caps, pal(caps).faint, text);
const heading = (caps: Caps, text: string) => paint(caps, pal(caps).highlight, text);
const label = (caps: Caps, text: string) => muted(caps, text.padEnd(10));

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/** The toil project a screen is about: the name, or the file when another of the same name takes precedence. */
const refOf = (p: ViewProps) => p.frame.params.ref!;

const shownOf = (p: ViewProps, ref = refOf(p)) => p.session.toilProjects?.[ref]?.show as Shown | undefined;
const checkedOf = (p: ViewProps, ref = refOf(p)) => p.session.toilProjects?.[ref]?.check as Checked | undefined;

const showStep = (ref: string): Step => ({ args: ['projects', 'show', ref] });
const checkStep = (ref: string): Step => ({ args: ['projects', 'check', ref] });

/** Keys of a toil project's content that aren't an area's section. */
const NOT_SECTIONS = new Set(['$schema', 'name', 'description', 'env', 'repos', 'environments']);

export function reposOf(show: Shown | undefined): Repo[] {
  const repos = show?.toilProject.repos;
  return Array.isArray(repos) ? repos.filter(isRecord).map((r) => ({ name: String(r.name), ...(typeof r.path === 'string' ? { path: r.path } : {}), remotes: Array.isArray(r.remotes) ? r.remotes.map(String) : [] })) : [];
}

/** Every section: each area's own, then each environment's, in the order the file has them. */
export function sectionsOf(show: Shown | undefined): Array<{ area: string; env?: string; section: Section }> {
  if (!show) return [];
  const out: Array<{ area: string; env?: string; section: Section }> = [];
  for (const [key, value] of Object.entries(show.toilProject)) if (!NOT_SECTIONS.has(key) && isRecord(value)) out.push({ area: key, section: value });
  const envs = show.toilProject.environments;
  if (isRecord(envs)) for (const [env, byArea] of Object.entries(envs)) if (isRecord(byArea)) for (const [area, section] of Object.entries(byArea)) if (isRecord(section)) out.push({ area, env, section });
  return out;
}

const sectionOf = (show: Shown | undefined, area: string, env: string | undefined): Section => sectionsOf(show).find((s) => s.area === area && s.env === env)?.section ?? {};

const where = (area: string, env: string | undefined) => (env ? `${env}: ${area}` : area);

/** One section's values as short lines: the binding, then each key. */
function sectionLines(caps: Caps, section: Section): string[] {
  const lines: string[] = [];
  const binding = typeof section.connection === 'string' ? `connection ${section.connection}` : typeof section.host === 'string' ? `host ${section.host}` : 'your default connection';
  lines.push(`${label(caps, 'Selects')} ${binding}`);
  for (const [key, value] of Object.entries(section)) {
    if (key === 'connection' || key === 'host') continue;
    const text = Array.isArray(value) ? value.join(', ') : isRecord(value) ? Object.entries(value).map(([k, v]) => `${k}=${String(v)}`).join(', ') : String(value);
    lines.push(`${label(caps, key)} ${text}`);
  }
  return lines;
}

/** Where to go after a step, from the frame; back to the toil project when nothing says. */
const thenOf = (params: Record<string, string>): Action => parse<Action>(params.then, { go: 'toil-project', root: 'toil-project' });

/** `toil projects link <ref> <area>` or, for an environment, `toil projects env <ref> <env> <area>`. */
function sectionArgs(params: Record<string, string>, flags: string[]): string[] {
  const { ref, area, env } = params as Record<string, string>;
  return env ? ['projects', 'env', ref!, env, area!, ...flags] : ['projects', 'link', ref!, area!, ...flags];
}

/**
 * An edit: its commands, then `toil projects show` (and `check` while fixing
 * findings) so the screens read the file again, then `then` once every edit
 * step worked. A failure stays where it was, to be corrected.
 */
export function editRun(title: string, ref: string, steps: Step[], then: Action, recheck = false): Run {
  return {
    title,
    keepGoing: steps.length > 1,
    steps: [...steps, showStep(ref), ...(recheck ? [checkStep(ref)] : [])],
    next: (r) => (r.slice(0, steps.length).every((x) => x.envelope.ok) && r.length > steps.length ? then : undefined),
  };
}

/**
 * How a change goes ahead: in the create wizard and when fixing a finding it
 * runs at once (the wizard ends on a review of the whole toil project); in Edit it
 * goes to a screen that shows the section and the commands first, to save or
 * not.
 */
function change(params: Record<string, string>, title: string, steps: Step[], then: Action): Action {
  const ref = params.ref!;
  if (params.flow === 'edit') return { go: 'toil-project-save', params: { ref, title, steps: json(steps.map((s) => s.args)), then: json(then), ...(params.area ? { area: params.area } : {}), ...(params.env ? { env: params.env } : {}) } };
  return { run: editRun(title, ref, steps, then, params.flow === 'fix') };
}

/** Whether a connection is on a toil project host selector, by core's own matcher, so the menu asks about writes on exactly the connections a call would pick. */
export function onHost(settings: Record<string, unknown> | undefined, host: string, siteApis?: Readonly<Record<string, string>>): boolean {
  return settings !== undefined && hostMatches(settings, host.trim(), siteApis);
}

/** The API hosts an area names for the hosts people know (github.com's is api.github.com), as core matches them. */
const siteApisOf = (data: WelcomeData, area: string) => data.areas.find((a) => a.name === area)?.siteApis;

/** The connections with writes on that a binding would select: the one named, or every one of the area's on the host. */
export function writesTargets(data: WelcomeData, area: string, pick: { connection?: string; host?: string }): string[] {
  const cfg = config(data);
  if (!cfg) return [];
  const names = pick.connection !== undefined ? [pick.connection] : connectionsOf(cfg, area).filter((name) => onHost(cfg.connections[name], pick.host ?? '', siteApisOf(data, area)));
  return names.filter((name) => cfg.connections[name]?.area === area && connectionWrites(cfg.connections[name]));
}

/**
 * Binding a section: straight to the change, or, when the binding selects a
 * connection with writes on, to the screen that asks for its name first.
 */
function bind(p: ViewProps, flags: string[], title: string, pick: { connection?: string; host?: string }): Action {
  const params = p.frame.params;
  const section = sectionOf(shownOf(p), params.area!, params.env);
  const bound = typeof section.connection === 'string' || typeof section.host === 'string';
  const steps: Step[] = [{ args: sectionArgs(params, [...flags, ...(bound ? ['--replace'] : []), ...firstEnv(params)]) }];
  const targets = writesTargets(p.data, params.area!, pick);
  const then = thenFromPicker(params);
  if (targets.length) return { go: 'toil-project-confirm', params: { ref: params.ref!, title, steps: json(steps.map((s) => s.args)), connection: targets[0]!, then: json(then), ...(params.flow ? { flow: params.flow } : {}) } };
  return change(params, title, steps, then);
}

/** The first environment a toil project gets becomes its default, as the environments step says. */
const firstEnv = (params: Record<string, string>): string[] => (params.env && params.first === '1' ? ['--default'] : []);

/**
 * Where the connection picker goes after binding: for a new environment, the
 * value it has there (empty skips); in the wizard, discovery for the area
 * when it has some; otherwise where the frame says.
 */
function thenFromPicker(params: Record<string, string>): Action {
  // Back to the step the picker was opened from first, so the breadcrumb doesn't carry every screen on the way.
  const root = parse<{ root?: string }>(params.then, {}).root;
  const at = root ? { root } : {};
  if (params.setAfter === '1' && params.env) {
    return { ...at, go: 'toil-project-set', params: { ref: params.ref!, area: params.area!, env: params.env, flow: params.flow ?? 'create', skippable: '1', then: params.then ?? backTo('toil-project-edit') } };
  }
  const then = thenOf(params);
  const d = DISCOVERY[params.area!];
  if (params.discover !== '1' || !d || params.env) return then;
  return { ...at, go: 'toil-project-discover-start', params: { ref: params.ref!, area: params.area!, flow: params.flow ?? 'create', then: json(then) } };
}

// ─── Discovery ─────────────────────────────────────────────────────────────

/**
 * Per area, the read that lists what a toil project can name, and where a ticked
 * value goes: field aliases (`toil projects field`) or a reference list (`toil projects
 * link --add`). Each is the area's own read command; nothing here talks to a
 * service except by running it.
 */
interface Discovery {
  what: string;
  args: string[];
  id: string;
  name: string;
  /** The reference list ticked values are added to; fields when absent. */
  key?: string;
}

const jiraFields = (area: string): Discovery => ({ what: 'custom fields', args: [area, 'issue', 'fields', '--discover', '--custom-only'], id: 'id', name: 'name' });
const spaces = (area: string): Discovery => ({ what: 'spaces', args: [area, 'space', 'list'], id: 'key', name: 'name', key: 'spaces' });

export const DISCOVERY: Record<string, Discovery> = {
  jira: jiraFields('jira'),
  confluence: spaces('confluence'),
  sonar: { what: 'projects', args: ['sonar', 'project', 'list'], id: 'key', name: 'name', key: 'projects' },
  ado: { what: 'projects', args: ['ado', 'project', 'list'], id: 'name', name: 'name', key: 'projects' },
};

/** What a discovery read found, from its envelope: the data if it's a list, else the first list in it (`components`, `value`). */
export function discovered(result: StepResult | undefined, d: Discovery): Array<{ id: string; name: string }> {
  const data = result?.envelope.ok ? result.envelope.data : undefined;
  const list = Array.isArray(data) ? data : isRecord(data) ? Object.values(data).find(Array.isArray) : undefined;
  const out = (list ?? []).filter(isRecord).map((x) => ({ id: String(x[d.id] ?? ''), name: String(x[d.name] ?? '') }));
  return out.filter((x, i) => x.id && out.findIndex((y) => y.id === x.id) === i);
}

/** A field's name as a toil project alias, a camelCase identifier: "Story Points" is storyPoints. */
export function aliasFor(name: string, id: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const camel = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('');
  return /^[a-z][a-zA-Z0-9]*$/.test(camel) ? camel : `field${id.replace(/\D/g, '')}`;
}

/** The run that discovers for an area, through the toil project so its own binding picks the connection. */
function discoverRun(params: Record<string, string>): Run {
  const d = DISCOVERY[params.area!]!;
  const ref = params.ref!;
  return {
    title: `Discover ${params.area} ${d.what}`,
    steps: [{ args: [...d.args, '--toil-project', ref] }],
    next: (r) => (r[0]?.envelope.ok ? { go: 'toil-project-discover', params: { ...params, found: json(discovered(r[0], d)) } } : undefined),
  };
}

// ─── The module's own screen ───────────────────────────────────────────────

const contextRun: Run = { title: 'This folder', steps: [{ args: ['projects', 'context'] }], next: (r) => (r[0]?.envelope.ok ? { go: 'toil-project-folder', params: { context: json(r[0].envelope.data) } } : undefined) };

const listRun = (params: Record<string, string> = {}): Run => ({
  title: 'Toil projects',
  steps: [{ args: ['projects', 'list'] }],
  next: (r) => (r[0]?.envelope.ok ? { go: 'toil-project-list', params: { ...params, list: json(r[0].envelope.data) } } : undefined),
});

/** Opens a toil project: `toil projects show`, then its screen. */
export const openRun = (ref: string, root?: string): Run => ({
  title: `Open ${ref}`,
  steps: [showStep(ref)],
  next: (r) => (r[0]?.envelope.ok ? { go: 'toil-project', params: { ref }, ...(root ? { root } : {}) } : undefined),
});

/**
 * Set up this repo: `toil projects onboard`, which asks on this terminal for each
 * connection the folder's toil project needs, then checks it and tests each. What
 * it found per area is the point, so the result shows its data.
 */
export const onboardRun: Run = { title: 'Set up this repo', steps: [{ args: ['projects', 'onboard'], label: 'Match each area to your connections; add the ones you lack' }], showData: true };

export const toilProjectsView: View = {
  title: () => 'Toil projects',
  body: (caps, p) => [
    muted(caps, 'A toil project is what toil knows about one body of work: its repositories, issue keys and field names, spaces, boards and environments. A command run in one of its repositories picks those up without flags.'),
    '',
    `${label(caps, 'Folder')} ${p.data.folder.repo ? p.data.folder.repo.root : p.data.folder.cwd}${p.data.folder.repo ? '' : faint(caps, '  (not in a git repository)')}`,
  ],
  items: (p) => [
    { label: 'This folder', hint: 'Which toil project applies here, and why', action: { run: contextRun } },
    { label: 'Your toil projects', hint: 'Every toil project toil can see; open one to review or edit it', action: { run: listRun() } },
    { label: 'Create a toil project', hint: 'Name, repos, areas, environments, then a review', action: { go: 'toil-project-new' } },
    { label: 'Import a toil project', hint: 'Adopt a shared toil project file as your own', action: { go: 'toil-project-import' } },
    ...(p.data.folder.repo ? [{ label: 'Set up this repo', hint: "Connect its toil project's areas to your connections, adding any you lack", action: { run: onboardRun } }] : []),
    { label: 'Hand off to an agent', hint: 'A prompt and the MCP areas to build one with an agent', action: { go: 'toil-project-agent' } },
  ],
};

// ─── This folder ───────────────────────────────────────────────────────────

/** Why a toil project applies, in words. */
export function whyApplies(a: Pick<Applied, 'by' | 'match' | 'repo'>, origin?: string | null): string {
  if (a.by === 'env') return 'TOIL_PROJECT names it';
  if (a.by === 'input') return 'it was named';
  if (a.match === 'path') return `this repository's folder is its repo ${a.repo ?? ''}`.trim();
  if (a.match === 'remote') return `this repository's remote${origin ? `, ${origin},` : ''} is its repo ${a.repo ?? ''}`.trim();
  if (a.match === 'checked-in') return 'it is checked into this repository, in .toil/projects';
  return 'it applies here';
}

export const folderView: View = {
  title: () => 'This folder',
  body: (caps, p) => {
    const c = parse<Context | undefined>(p.frame.params.context, undefined);
    if (!c) return [];
    const lines = [`${label(caps, 'Folder')} ${c.folder?.path ?? p.data.folder.cwd}`];
    if (c.repo) lines.push(`${label(caps, 'Repo')} ${c.repo.root}`, `${label(caps, 'Origin')} ${c.repo.origin ?? faint(caps, 'none')}`);
    else lines.push(faint(caps, 'Not in a git repository, so only TOIL_PROJECT can pick a toil project here.'));
    lines.push('');
    if (c.toilProject) {
      lines.push(heading(caps, `This folder resolves to ${c.toilProject.name}`), muted(caps, `Because ${whyApplies(c.toilProject, c.repo?.origin)}. It's ${c.toilProject.source === 'user' ? 'your own' : `a ${c.toilProject.source} toil project`}: ${c.toilProject.file}`));
    } else if (c.candidates.length > 1) {
      lines.push(ok(caps, false, `${c.candidates.length} toil projects match, so area commands here need --toil-project:`));
      for (const x of c.candidates) lines.push(`  ${x.name}  ${faint(caps, `${whyApplies(x, c.repo?.origin)} (${x.file})`)}`);
    } else lines.push(muted(caps, 'No toil project applies here. Area commands need their keys as flags.'));
    return lines;
  },
  items: (p) => {
    const c = parse<Context | undefined>(p.frame.params.context, undefined);
    if (!c) return [];
    if (c.toilProject) {
      return [
        { label: `Open ${c.toilProject.name}`, hint: 'Review, edit or export it', action: { run: openRun(c.toilProject.name) } },
        { label: 'Set up this repo', hint: `Connect ${c.toilProject.name}'s areas to your connections, adding any you lack`, action: { run: onboardRun } },
      ];
    }
    if (c.candidates.length > 1) return c.candidates.map((x) => ({ label: `Open ${x.name}`, hint: x.file, action: { run: openRun(x.name) } }));
    if (!c.repo) return [{ label: 'Create a toil project', hint: 'Name, repos, areas, environments', action: { go: 'toil-project-new' } }];
    return [
      { label: 'Create a toil project for this repo', hint: 'Starts with this repository ticked', action: { go: 'toil-project-new', params: { repo: c.repo.root } } },
      { label: 'Add this repo to a toil project', hint: 'Pick one of yours', action: { run: listRun({ mode: 'add-repo', repo: c.repo.root }) } },
    ];
  },
};

// ─── The list ──────────────────────────────────────────────────────────────

export const listView: View = {
  title: (p) => (p.frame.params.mode === 'add-repo' ? 'Add this repo' : 'Your toil projects'),
  body: (caps, p) => {
    const list = parse<Listed>(p.frame.params.list, { toilProjects: [], broken: [] });
    const lines: string[] = [];
    if (list.toilProjects.length === 0) lines.push(muted(caps, 'No toil projects yet. Create one, or import one a teammate shared.'));
    if (p.frame.params.mode === 'add-repo') lines.push(heading(caps, `Which toil project should ${p.frame.params.repo} join?`));
    for (const b of list.broken) {
      lines.push(ok(caps, false, `Broken: ${b.file} (${b.source})`));
      for (const x of b.problems) lines.push(muted(caps, `  ${x.path || '(file)'}: ${x.message}`));
    }
    return lines;
  },
  items: (p) => {
    const list = parse<Listed>(p.frame.params.list, { toilProjects: [], broken: [] });
    return list.toilProjects.map((d): Item => {
      // A name another file takes precedence over is opened by its file.
      const ref = d.shadowedBy ? d.file : d.name;
      const hint = `${d.source}${d.description ? `, ${d.description}` : ''}${d.shadowedBy ? `, overridden by ${d.shadowedBy}` : ''}${d.problems ? `, ${plural(d.problems, 'problem')}` : ''}`;
      if (p.frame.params.mode === 'add-repo') {
        const repo = p.frame.params.repo!;
        return { label: d.name, hint, action: { run: { title: `Add ${repo} to ${d.name}`, steps: [{ args: ['projects', 'add-repo', ref, repo] }, showStep(ref)], next: (r) => (r.every((x) => x.envelope.ok) ? { go: 'toil-project', params: { ref } } : undefined) } } };
      }
      return { label: d.name, hint, attention: d.problems > 0, action: { run: openRun(ref) } };
    });
  },
};

// ─── One toil project ───────────────────────────────────────────────────────────

export const toilProjectView: View = {
  title: (p) => shownOf(p)?.name ?? refOf(p),
  body: (caps, p) => {
    const s = shownOf(p);
    if (!s) return [ok(caps, false, `toil couldn't read ${refOf(p)}. Open it again from Your toil projects.`)];
    const lines = [
      heading(caps, s.name),
      ...(typeof s.toilProject.description === 'string' ? [muted(caps, s.toilProject.description)] : []),
      '',
      `${label(caps, 'File')} ${s.file}`,
      `${label(caps, 'Source')} ${s.source === 'user' ? 'your own' : `${s.source}, not adopted: a write through its bindings needs Adopt first`}`,
      ...(typeof s.toilProject.env === 'string' ? [`${label(caps, 'Default env')} ${s.toilProject.env}`] : []),
    ];
    const repos = reposOf(s);
    lines.push('', heading(caps, `Repos (${repos.length})`));
    if (repos.length === 0) lines.push(faint(caps, '  none yet'));
    for (const r of repos) lines.push(`  ${r.name}  ${faint(caps, [r.path, ...r.remotes].filter(Boolean).join('  '))}`);
    const areas = Object.entries(s.areas);
    lines.push('', heading(caps, `Areas (${areas.length})`));
    if (areas.length === 0) lines.push(faint(caps, '  none linked yet'));
    for (const [area, a] of areas) {
      const conn = a.connection ? `${a.connection.value}${a.connection.source === 'default' ? ' (your default)' : a.connection.host ? ` (host ${a.connection.host})` : ''}` : 'no connection';
      const writes = a.writes ? ok(caps, false, 'writes on') : faint(caps, 'read only');
      const inputs = Object.entries(a.inputs).map(([k, v]) => `${k}=${v}`).join(' ');
      lines.push(`  ${area.padEnd(12)} ${conn}  ${writes}${a.env ? faint(caps, `  env ${a.env}`) : ''}${inputs ? faint(caps, `  ${inputs}`) : ''}`);
      if (a.error) lines.push(`    ${ok(caps, false, `${a.error.code}: ${a.error.message}`)}`);
    }
    if (s.problems.length) lines.push('', ok(caps, false, `${plural(s.problems.length, 'problem')} reading it; Review lists them with their fixes.`));
    return lines;
  },
  items: (p) => {
    const s = shownOf(p);
    const ref = refOf(p);
    if (!s) return [];
    const items: Item[] = [
      { label: 'Review', hint: 'Check it, and fix what it finds', action: { run: { title: `Check ${s.name}`, steps: [checkStep(ref)], next: (r) => (r[0]?.envelope.ok ? { go: 'toil-project-review', params: { ref } } : undefined) } } },
      { label: 'Edit', hint: 'Repos, an area, its fields, an environment', action: { go: 'toil-project-edit', params: { ref } } },
      { label: 'Export', hint: 'Into a repository, or to a file, for sharing', action: { go: 'toil-project-export', params: { ref } } },
    ];
    if (s.source !== 'user') items.push({ label: 'Adopt it', hint: 'Copy it into your own folder, so writes may follow it', action: { run: importCheckRun(s.file) } });
    items.push({ label: 'Hand off to an agent', hint: 'A prompt to extend it with an agent', action: { go: 'toil-project-agent', params: { ref } } });
    if (s.source === 'user') items.push({ label: 'Delete', hint: 'Asks you to type its name', action: { go: 'toil-project-delete', params: { ref, name: s.name } } });
    // Last, so the rows a hand already knows keep their places.
    if (Object.keys(s.areas).length) items.push({ label: 'Brief this toil project', hint: 'What needs a person, and what to do first', action: { run: briefRun(ref, s.areas) } });
    return items;
  },
};

// ─── Review and fix ────────────────────────────────────────────────────────

/** The section a finding's key path is about: `jira.host` or `environments.prod.openshift.connection`. */
export function findingSection(path: string): { area: string; env?: string } | undefined {
  const parts = path.split('.');
  if (parts[0] === 'environments' && parts.length >= 3) return { env: parts[1]!, area: parts[2]! };
  if (parts.length >= 1 && parts[0] && !NOT_SECTIONS.has(parts[0]) && !parts[0].startsWith('repos')) return { area: parts[0] };
  return undefined;
}

const GROUPS: Array<{ title: string; codes: string[] }> = [
  { title: 'Connections', codes: ['TOIL_PROJECT_UNKNOWN_CONNECTION', 'TOIL_PROJECT_HOST_UNMATCHED', 'TOIL_PROJECT_HOST_AMBIGUOUS'] },
  { title: 'Writes', codes: ['TOIL_PROJECT_WRITES_BINDING'] },
  { title: 'Unknown sections', codes: ['TOIL_PROJECT_UNKNOWN_SECTION'] },
  { title: 'Remotes', codes: ['TOIL_PROJECT_REMOTE_USERINFO'] },
];

/** Findings grouped for the review screen, in a fixed order, with everything else last. */
export function groupFindings(problems: readonly Problem[]): Array<{ title: string; problems: Problem[] }> {
  const known = new Set(GROUPS.flatMap((g) => g.codes));
  const groups = GROUPS.map((g) => ({ title: g.title, problems: problems.filter((x) => g.codes.includes(x.code)) }));
  groups.push({ title: 'Other', problems: problems.filter((x) => !known.has(x.code)) });
  return groups.filter((g) => g.problems.length > 0);
}

const backToReview = (): Action => ({ go: 'toil-project-review', root: 'toil-project-review' });

export const reviewView: View = {
  title: () => 'Review',
  body: (caps, p) => {
    const c = checkedOf(p);
    const s = shownOf(p);
    if (!c) return [muted(caps, 'Not checked yet.')];
    const errors = c.problems.filter((x) => x.level === 'error').length;
    const lines = [c.ok ? ok(caps, true, `No errors${c.problems.length ? `; ${plural(c.problems.length, 'warning')}` : ''}. Checked locally: no service was contacted.`) : ok(caps, false, `${plural(errors, 'error')}${c.message ? `: ${c.message}` : ''}`)];
    for (const g of groupFindings(c.problems)) {
      lines.push('', heading(caps, g.title));
      for (const x of g.problems) lines.push(`  ${x.level === 'error' ? ok(caps, false, x.code) : muted(caps, x.code)}  ${faint(caps, x.path || '(file)')}`, muted(caps, `    ${x.message}`));
    }
    const handOnly = c.problems.filter((x) => ['TOIL_PROJECT_DUPLICATE_KEY', 'TOIL_PROJECT_INVALID', 'TOIL_PROJECT_UNKNOWN_KEY'].includes(x.code));
    if (handOnly.length && s) lines.push('', faint(caps, `No command removes ${handOnly.length === 1 ? 'that entry' : 'those entries'}; edit ${s.file} by hand, then Check again.`));
    return lines;
  },
  items: (p) => {
    const c = checkedOf(p);
    const s = shownOf(p);
    const ref = refOf(p);
    const items: Item[] = [];
    const seen = new Set<string>();
    // In the order the screen groups them, so the fixes read top to bottom with the findings.
    for (const x of groupFindings(c?.problems ?? []).flatMap((g) => g.problems)) {
      const repo = x.code === 'TOIL_PROJECT_REMOTE_USERINFO' ? reposOf(s)[Number(x.path.slice('repos['.length, x.path.indexOf(']')))] : undefined;
      if (repo && !seen.has(`repo:${repo.name}`)) {
        seen.add(`repo:${repo.name}`);
        // Re-adding one of the repo's own remotes adds nothing, and any toil project write leaves every stored remote without its credential.
        items.push({ label: `Remove the credential from ${repo.name}`, hint: 'Re-add it as it is; the file keeps no credential', attention: true, action: { run: editRun(`Clean ${repo.name}`, ref, [{ args: ['projects', 'add-repo', ref, repo.remotes[0] ?? repo.path ?? repo.name, '--name', repo.name] }], backToReview(), true) } });
      }
      const at = findingSection(x.path);
      if (!at) continue;
      const key = `${x.code}:${at.env ?? ''}:${at.area}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const params = { ref, area: at.area, ...(at.env ? { env: at.env } : {}), flow: 'fix', then: json(backToReview()) };
      if (['TOIL_PROJECT_UNKNOWN_CONNECTION', 'TOIL_PROJECT_HOST_UNMATCHED', 'TOIL_PROJECT_HOST_AMBIGUOUS'].includes(x.code)) {
        const section = sectionOf(s, at.area, at.env);
        items.push({ label: `Relink ${where(at.area, at.env)}`, hint: 'Pick one of your connections', attention: true, action: { go: 'toil-project-connection', params } });
        if (x.code !== 'TOIL_PROJECT_HOST_AMBIGUOUS') {
          items.push({
            label: `Add a ${at.area} connection`,
            hint: typeof section.connection === 'string' ? `Named ${section.connection}, as the toil project expects` : `For ${String(section.host ?? 'its host')}`,
            // Then check again, so Review shows the toil project with the new connection rather than the finding it just fixed.
            action: { go: 'add-name', params: { area: at.area, ...(typeof section.connection === 'string' ? { suggest: section.connection } : {}), thenRun: json([checkStep(ref).args, showStep(ref).args]), then: json(backToReview()) } },
          });
        }
      } else if (x.code === 'TOIL_PROJECT_UNKNOWN_SECTION') {
        items.push({ label: `Remove the ${where(at.area, at.env)} section`, hint: 'Asks you to type its name', attention: true, action: { go: 'toil-project-unlink', params } });
      } else if (x.code === 'TOIL_PROJECT_WRITES_BINDING' && s && s.source !== 'user') {
        items.push({ label: 'Adopt it', hint: 'Copy it into your folder, so writes may follow its bindings', action: { run: importCheckRun(s.file) } });
      }
    }
    for (const area of Object.keys(s?.areas ?? {})) {
      if (!p.data.areas.find((a) => a.name === area)?.checksToilProject) continue;
      items.push({
        label: `Check ${area} on the service`,
        hint: `toil ${area} check-toil-project: looks each value up`,
        action: { run: { title: `Check ${area}`, steps: [{ args: [area, 'check-toil-project', '--toil-project', ref] }], next: (r) => (r[0]?.envelope.ok ? { go: 'toil-project-service', params: { ref, area, result: json(r[0].envelope.data) } } : undefined) } },
      });
    }
    items.push({ label: 'Check again', hint: 'After a fix made elsewhere', action: { run: { title: 'Check again', steps: [checkStep(ref), showStep(ref)], next: () => backToReview() } } });
    return items;
  },
};

interface ServiceCheck {
  connection: string | null;
  ok: boolean;
  checked: number;
  checks: Array<{ path: string; kind: string; value: string; found: boolean }>;
}

export const serviceView: View = {
  title: (p) => p.frame.params.area ?? '',
  body: (caps, p) => {
    const r = parse<ServiceCheck | undefined>(p.frame.params.result, undefined);
    if (!r) return [];
    const missing = r.checks.filter((c) => !c.found);
    const lines = [r.ok ? ok(caps, true, `All ${plural(r.checked, 'value')} found on ${r.connection ?? 'the connection'}.`) : ok(caps, false, `${missing.length} of ${r.checked} not found on ${r.connection ?? 'the connection'}.`), ''];
    for (const c of r.checks) lines.push(`  ${c.found ? ok(caps, true, 'found  ') : ok(caps, false, 'missing')}  ${c.kind} ${c.value}  ${faint(caps, c.path)}`);
    if (missing.length) lines.push('', muted(caps, 'Change a value below, or relink the area if it points at the wrong instance.'));
    return lines;
  },
  items: (p) => {
    const r = parse<ServiceCheck | undefined>(p.frame.params.result, undefined);
    const { ref, area } = p.frame.params as Record<string, string>;
    if (!r || r.ok) return [];
    const params = { ref: ref!, area: area!, flow: 'fix', then: json(backToReview()) };
    return [
      { label: `Set a ${area} value`, hint: 'key=value, e.g. project=PAY', action: { go: 'toil-project-set', params } },
      { label: `Relink ${area}`, hint: 'Pick another connection', action: { go: 'toil-project-connection', params } },
    ];
  },
};

// ─── Edit ──────────────────────────────────────────────────────────────────

const backTo = (view: string): string => json({ go: view, root: view });

export const editView: View = {
  title: () => 'Edit',
  body: (caps) => [muted(caps, 'Pick what to change. Each change shows its command before anything is saved.')],
  items: (p) => {
    const ref = refOf(p);
    const s = shownOf(p);
    const flow = { ref, flow: 'edit' };
    return [
      { label: 'Repos', hint: `${plural(reposOf(s).length, 'repo')}; add from a scan or by remote`, action: { go: 'toil-project-repos-edit', params: { ref } } },
      ...sectionsOf(s).map((x): Item => ({ label: where(x.area, x.env), hint: typeof x.section.connection === 'string' ? `connection ${x.section.connection}` : typeof x.section.host === 'string' ? `host ${x.section.host}` : 'your default connection', action: { go: 'toil-project-area', params: { ref, area: x.area, ...(x.env ? { env: x.env } : {}) } } })),
      { label: 'Link an area', hint: 'Jira, Confluence, Sonar, ...', action: { go: 'toil-project-area-pick', params: { ...flow, then: backTo('toil-project-edit') } } },
      { label: 'Add an environment', hint: 'Its resources per area, e.g. an OpenShift namespace', action: { go: 'toil-project-env-name', params: { ...flow, then: backTo('toil-project-edit') } } },
    ];
  },
};

export const reposEditView: View = {
  title: () => 'Repos',
  body: (caps, p) => {
    const repos = reposOf(shownOf(p));
    if (repos.length === 0) return [muted(caps, 'No repos yet.')];
    return repos.map((r) => `  ${r.name}  ${faint(caps, [r.path, ...r.remotes].filter(Boolean).join('  '))}`);
  },
  items: (p) => {
    const params = { ref: refOf(p), flow: 'edit', then: backTo('toil-project-repos-edit') };
    return [
      { label: 'Add from a scan', hint: 'toil repos scan, then tick them', action: { go: 'toil-project-scan', params } },
      { label: 'Add by remote URL', hint: 'A repo you have no clone of', action: { go: 'toil-project-remote', params } },
    ];
  },
};

/** One area's section (or one environment's), and what can change in it. */
export const areaView: View = {
  title: (p) => where(p.frame.params.area!, p.frame.params.env),
  body: (caps, p) => {
    const { area, env } = p.frame.params;
    const section = sectionOf(shownOf(p), area!, env);
    const context = p.data.areas.find((a) => a.name === area)?.context ?? [];
    return [
      ...sectionLines(caps, section),
      '',
      faint(caps, context.length ? `${area}'s context inputs, which calls use: ${context.join(', ')}. Any other key is reference data for people and agents.` : `${area} has no context inputs; keys are reference data for people and agents.`),
    ];
  },
  items: (p) => {
    const { ref, area, env } = p.frame.params as Record<string, string>;
    const params = { ref: ref!, area: area!, ...(env ? { env } : {}), flow: 'edit', then: backTo('toil-project-area') };
    const items: Item[] = [
      { label: 'Connection', hint: 'Which of your connections it selects', action: { go: 'toil-project-connection', params } },
      { label: 'Set a value', hint: 'key=value, e.g. project=PAY', action: { go: 'toil-project-set', params } },
    ];
    if (reposOf(shownOf(p)).length > 1) items.push({ label: 'Set a value for one repo', hint: 'When repos use different keys', action: { go: 'toil-project-repo-pick', params } });
    if (DISCOVERY[area!] && !env) items.push({ label: `Discover ${DISCOVERY[area!]!.what}`, hint: `toil ${DISCOVERY[area!]!.args.slice(0, -1).join(' ')} ..., then tick them`, action: { run: discoverRun(params) } });
    if (area === 'jira') items.push({ label: 'Name a field', hint: 'alias=field-id, e.g. storyPoints=customfield_10002', action: { go: 'toil-project-field', params } });
    items.push({ label: 'Remove this section', hint: 'Asks you to type its name', action: { go: 'toil-project-unlink', params: { ...params, then: backTo('toil-project-edit') } } });
    if (env && shownOf(p)?.toilProject.env !== env) {
      items.push({ label: `Make ${env} the default environment`, hint: 'Calls with no --env use it', action: change(params, `Default environment ${env}`, [{ args: ['projects', 'env', ref!, env, area!, '--default'] }], thenOf(params)) });
    }
    return items;
  },
};

/** Which area to link: the ones you have connections for first. */
export const areaPickView: View = {
  title: (p) => (p.frame.params.env ? `${p.frame.params.env}: area` : 'Area'),
  body: (caps, p) => [heading(caps, p.frame.params.env ? `Which area has resources in ${p.frame.params.env}?` : 'Which area should it link?')],
  items: (p) => {
    const cfg = config(p.data);
    const linked = new Set(sectionsOf(shownOf(p)).filter((x) => x.env === p.frame.params.env).map((x) => x.area));
    const count = (area: string) => (cfg ? connectionsOf(cfg, area).length : 0);
    const areas = p.data.areas.filter((a) => a.configurable && !linked.has(a.name) && a.name !== 'skills').sort((a, b) => Number(count(b.name) > 0) - Number(count(a.name) > 0) || a.name.localeCompare(b.name));
    return areas.map((a) => ({ label: a.name, hint: count(a.name) ? `${plural(count(a.name), 'connection')}; ${a.description}` : a.description, action: { go: 'toil-project-connection', params: { ...p.frame.params, area: a.name } } }));
  },
};

/** The connection picker: each of yours for the area, your default, a host selector, or a new one. */
export const connectionView: View = {
  title: () => 'Connection',
  body: (caps, p) => {
    const { area, env } = p.frame.params;
    return [
      heading(caps, `Which connection should ${where(area!, env)} use?`),
      '',
      muted(caps, 'A connection name suits a toil project only you use. A host suits a shared one, since teammates name their connections differently; toil compares it with your connections and never contacts it.'),
    ];
  },
  items: (p) => {
    const { area, env } = p.frame.params as Record<string, string>;
    const cfg = config(p.data);
    const section = sectionOf(shownOf(p), area!, env);
    const names = cfg ? connectionsOf(cfg, area!).sort() : [];
    const dflt = cfg ? defaultConnectionName(cfg, area!) : undefined;
    const items: Item[] = names.map((name) => {
      const conn = cfg!.connections[name]!;
      const writes = connectionWrites(conn);
      const hint = [hostOf(conn.baseUrl) || hostOf(conn.host), writes ? 'writes on: asks you to confirm' : 'read only', name === dflt ? 'your default' : '', section.connection === name ? 'selected now' : ''].filter(Boolean).join(', ');
      return { label: name, hint, action: bind(p, ['--connection', name], `Link ${where(area!, env)} to ${name}`, { connection: name }) };
    });
    items.push({ label: 'By host', hint: 'For a toil project you will share', action: { go: 'toil-project-host', params: p.frame.params } });
    // Your default selects nothing: unbind a section that selects something, create one that isn't there, or leave one that already selects nothing.
    const params = p.frame.params;
    const exists = sectionsOf(shownOf(p)).some((x) => x.area === area && x.env === env);
    const bound = typeof section.connection === 'string' || typeof section.host === 'string';
    items.push({
      label: 'Your default connection',
      hint: `Selects nothing: calls use ${dflt ?? 'your default'}`,
      action: bound
        ? change(params, `Unbind ${where(area!, env)}`, [{ args: sectionArgs(params, ['--unbind', ...firstEnv(params)]) }], thenFromPicker(params))
        : exists
          ? thenFromPicker(params)
          : change(params, `Link ${where(area!, env)}`, [{ args: sectionArgs(params, firstEnv(params)) }], thenFromPicker(params)),
    });
    items.push({ label: 'Add a connection', hint: `A new ${area} connection, then back here`, action: { go: 'add-name', params: { area: area!, then: backTo('toil-project-connection') } } });
    return items;
  },
};

export const hostView: View = {
  title: () => 'Host',
  body: (caps, p) => {
    const cfg = config(p.data);
    const hosts = cfg ? [...new Set(connectionsOf(cfg, p.frame.params.area!).map((n) => hostOf(cfg.connections[n]!.baseUrl) || hostOf(cfg.connections[n]!.host)).filter(Boolean))] : [];
    return [muted(caps, 'The host your connection to it has, e.g. jira.imagile.dev, with :port only when it matters.'), ...(hosts.length ? ['', faint(caps, `Yours: ${hosts.join(', ')}`)] : [])];
  },
  input: {
    label: () => 'Host',
    submit: (text, p): Action | { error: string } => {
      const host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
      if (!host) return { error: 'Enter a host, e.g. jira.imagile.dev.' };
      if (host.includes('@')) return { error: 'Just the host, with no user name or token.' };
      const { area, env } = p.frame.params;
      return bind(p, ['--host', host], `Link ${where(area!, env)} to host ${host}`, { host });
    },
  },
};

/** Writes on: type the connection's name, as turning writes on asks. */
export const confirmView: View = {
  title: () => 'Confirm',
  body: (caps, p) => {
    const steps = parse<string[][]>(p.frame.params.steps, []);
    return [
      ok(caps, false, `${p.frame.params.connection} has writes on.`),
      '',
      'Binding the toil project to it means a write command run in its repositories goes to that connection without --connection, as long as you allow the write on the call.',
      '',
      ...steps.map((args) => faint(caps, `$ ${commandLine(p.data, args)}`)),
    ];
  },
  input: {
    label: (p) => `Type ${p.frame.params.connection} to bind it`,
    submit: (text, p): Action | { error: string } => {
      const conn = p.frame.params.connection!;
      if (text !== conn) return { error: `That isn't "${conn}", so nothing was changed.` };
      const steps = parse<string[][]>(p.frame.params.steps, []).map((args) => ({ args }));
      return { run: editRun(p.frame.params.title ?? 'Bind', p.frame.params.ref!, steps, thenOf(p.frame.params), p.frame.params.flow === 'fix') };
    },
  },
};

/** Validates `key=value` the way the commands will, before running one. */
export function keyValue(text: string): [string, string] | { error: string } {
  const at = text.indexOf('=');
  if (at <= 0 || at === text.length - 1) return { error: 'Use key=value, e.g. project=PAY.' };
  return [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

export const setView: View = {
  title: (p) => (p.frame.params.forRepo ? `${p.frame.params.forRepo}: value` : 'Value'),
  body: (caps, p) => {
    const { area, env, forRepo } = p.frame.params;
    const context = p.data.areas.find((a) => a.name === area)?.context?.filter((c) => c !== 'env') ?? [];
    return [
      heading(caps, `A value for ${where(area!, env)}${forRepo ? `, for ${forRepo} only` : ''}`),
      '',
      muted(caps, context.length ? `Calls use ${context.join(', ')}; anything else is kept as reference data.` : 'Kept as reference data for people and agents.'),
      ...(p.frame.params.skippable === '1' ? [faint(caps, 'Leave it empty to skip.')] : []),
    ];
  },
  input: {
    label: () => 'key=value',
    initial: (p) => p.frame.params.key ?? '',
    submit: (text, p): Action | { error: string } => {
      const params = p.frame.params;
      if (text === '' && params.skippable === '1') return thenOf(params);
      const kv = keyValue(text);
      if ('error' in kv) return kv;
      const [key, value] = kv;
      if (key === 'connection' || key === 'host') return { error: 'Pick the connection with Connection instead.' };
      if (key === 'fields') return { error: 'Name a field with Name a field instead.' };
      if (key === 'env') return { error: 'The environment is the toil project\'s default environment, or the call\'s --env; add one with Add an environment.' };
      const current = sectionOf(shownOf(p), params.area!, params.env)[key];
      const replace = params.forRepo ? typeof current === 'string' || (isRecord(current) && current[params.forRepo] !== undefined) : current !== undefined;
      const flags = ['--set', `${key}=${value}`, ...(params.forRepo ? ['--for-repo', params.forRepo] : []), ...(replace ? ['--replace'] : [])];
      return change(params, `Set ${key} in ${where(params.area!, params.env)}`, [{ args: sectionArgs(params, flags) }], thenOf(params));
    },
  },
};

/** Removing a section: type the area's name, then `toil projects unlink`. */
export const unlinkView: View = {
  title: () => 'Remove',
  body: (caps, p) => {
    const { area, env } = p.frame.params;
    return [ok(caps, false, `Remove the ${where(area!, env)} section from ${shownOf(p)?.name ?? refOf(p)}?`), '', ...sectionLines(caps, sectionOf(shownOf(p), area!, env)), '', muted(caps, 'Calls in its repositories stop getting these values from the toil project.')];
  },
  input: {
    label: (p) => `Type ${p.frame.params.area} to remove it`,
    submit: (text, p): Action | { error: string } => {
      const { ref, area, env, flow } = p.frame.params as Record<string, string>;
      if (text !== area) return { error: `That isn't "${area}", so nothing was removed.` };
      return { run: editRun(`Remove ${where(area!, env)}`, ref!, [{ args: ['projects', 'unlink', ref!, '--area', area!, ...(env ? ['--env', env] : [])] }], thenOf(p.frame.params), flow === 'fix') };
    },
  },
};

export const repoPickView: View = {
  title: () => 'Repo',
  body: (caps) => [heading(caps, 'For which repo?')],
  items: (p) => reposOf(shownOf(p)).map((r) => ({ label: r.name, hint: r.path ?? r.remotes[0] ?? '', action: { go: 'toil-project-set', params: { ...p.frame.params, forRepo: r.name } } })),
};

export const fieldView: View = {
  title: () => 'Field',
  body: (caps, p) => {
    const fields = sectionOf(shownOf(p), p.frame.params.area!, undefined).fields;
    return [muted(caps, 'A friendly name for a field id, so --field storyPoints=5 works in this toil project\'s repositories.'), ...(isRecord(fields) ? ['', faint(caps, `Named so far: ${Object.entries(fields).map(([a, id]) => `${a}=${String(id)}`).join(', ')}`)] : [])];
  },
  input: {
    label: () => 'alias=field-id',
    submit: (text, p): Action | { error: string } => {
      const kv = keyValue(text);
      if ('error' in kv) return { error: 'Use alias=field-id, e.g. storyPoints=customfield_10002.' };
      const [alias, id] = kv;
      if (!/^[a-z][a-zA-Z0-9]*$/.test(alias)) return { error: 'The alias is a camelCase identifier, e.g. storyPoints.' };
      const params = p.frame.params;
      const fields = sectionOf(shownOf(p), params.area!, undefined).fields;
      const replace = isRecord(fields) && fields[alias] !== undefined;
      return change(params, `Name ${alias}`, [{ args: ['projects', 'field', params.ref!, params.area!, alias, id, ...(replace ? ['--replace'] : [])] }], thenOf(params));
    },
  },
};

/** The discovery read, started from the wizard right after an area is linked. */
export const discoverStartView: View = {
  title: (p) => p.frame.params.area ?? '',
  body: (caps, p) => [heading(caps, `Step 4 of 6: discover ${p.frame.params.area} ${DISCOVERY[p.frame.params.area!]?.what ?? ''}`), '', muted(caps, 'A read against the connection the toil project now selects. Tick what this toil project should name; nothing is written until you go on.')],
  items: (p) => [
    { label: 'Discover', hint: `toil ${DISCOVERY[p.frame.params.area!]!.args.join(' ')} --toil-project ${p.frame.params.ref}`, action: { run: discoverRun(p.frame.params) } },
    { label: 'Skip', hint: 'Back to the areas', action: thenOf(p.frame.params) },
  ],
};

/** Ticked values from discovery: the ones already there start ticked, and only new ticks are added. */
export const discoverView: View = {
  title: () => 'Discovered',
  body: (caps, p) => {
    const found = parse<Array<{ id: string; name: string }>>(p.frame.params.found, []);
    if (found.length === 0) return [muted(caps, 'Nothing found. Enter goes on.')];
    return [muted(caps, `${found.length} found. Space ticks, enter adds the new ticks; what the toil project already names stays.${DISCOVERY[p.frame.params.area!]?.key ? '' : ' Each ticked field gets an alias from its name.'}`)];
  },
  checklist: {
    options: (p) => parse<Array<{ id: string; name: string }>>(p.frame.params.found, []).map((x) => ({ id: x.id, label: x.name || x.id, hint: x.name && x.name !== x.id ? x.id : '' })),
    initial: (p) => existingValues(p),
    confirm: (checked, p): Action => {
      const params = p.frame.params;
      const d = DISCOVERY[params.area!]!;
      const have = new Set(existingValues(p));
      const added = checked.filter((id) => !have.has(id));
      if (added.length === 0) return thenOf(params);
      const found = parse<Array<{ id: string; name: string }>>(params.found, []);
      const steps: Step[] = d.key
        ? [{ args: sectionArgs(params, added.flatMap((id) => ['--add', `${d.key}=${id}`])) }]
        : added.map((id) => ({ args: ['projects', 'field', params.ref!, params.area!, aliasFor(found.find((x) => x.id === id)?.name ?? id, id), id] }));
      return change(params, `Add ${plural(added.length, d.key ? d.what.replace(/s$/, '') : 'field')} to ${params.area}`, steps, thenOf(params));
    },
  },
};

function existingValues(p: ViewProps): string[] {
  const d = DISCOVERY[p.frame.params.area!];
  const section = sectionOf(shownOf(p), p.frame.params.area!, undefined);
  if (!d) return [];
  if (d.key) return Array.isArray(section[d.key]) ? (section[d.key] as unknown[]).map(String) : [];
  return isRecord(section.fields) ? Object.values(section.fields).map(String) : [];
}

/** In Edit: the section as it is, and the commands, before anything is saved. */
export const saveView: View = {
  title: () => 'Review',
  body: (caps, p) => {
    const { area, env } = p.frame.params;
    const steps = parse<string[][]>(p.frame.params.steps, []);
    return [
      ...(area ? [heading(caps, `${where(area, env)} now`), ...sectionLines(caps, sectionOf(shownOf(p), area, env)), ''] : []),
      heading(caps, 'Saving runs'),
      ...steps.map((args) => paint(caps, pal(caps).ink, `  $ ${commandLine(p.data, args)}`)),
      '',
      faint(caps, 'The command checks the change and refuses a value already there; the toil project is shown again after.'),
    ];
  },
  items: (p) => {
    const steps = parse<string[][]>(p.frame.params.steps, []).map((args) => ({ args }));
    return [
      { label: 'Save', hint: plural(steps.length, 'command'), action: { run: editRun(p.frame.params.title ?? 'Save', refOf(p), steps, thenOf(p.frame.params)) } },
      { label: 'Back', hint: 'Change it first', action: { back: true } },
    ];
  },
};

// ─── Repos: scan and remote ────────────────────────────────────────────────

const STEPS = 6;
const step = (n: number, what: string) => `Step ${n} of ${STEPS}: ${what}`;

export const scanView: View = {
  title: () => 'Scan',
  body: (caps, p) => [
    ...(p.frame.params.flow === 'create' ? [heading(caps, step(2, 'repositories')), ''] : []),
    muted(caps, 'Which folder holds its repositories? toil reads each .git there (3 levels down), with no git needed. It stays inside the folder toil was started in.'),
  ],
  input: {
    label: () => 'Folder',
    initial: () => '.',
    submit: (text, p): Action => {
      const params = p.frame.params;
      return {
        run: {
          title: 'Find repositories',
          steps: [{ args: ['repos', 'scan', ...(text && text !== '.' ? [text] : [])] }],
          next: (r) => (r[0]?.envelope.ok ? { go: 'toil-project-repos', params: { ...params, repos: json((r[0].envelope.data as { repos?: unknown }).repos ?? []) } } : undefined),
        },
      };
    },
  },
};

export const reposChecklist: View = {
  title: () => 'Repos',
  body: (caps, p) => {
    const repos = parse<Array<{ name: string }>>(p.frame.params.repos, []);
    return [
      ...(p.frame.params.flow === 'create' ? [heading(caps, step(2, 'repositories')), ''] : []),
      repos.length ? muted(caps, `${plural(repos.length, 'repository')} found. Tick the ones in this toil project; enter adds them.`) : muted(caps, 'None found there. Enter goes on.'),
    ];
  },
  checklist: {
    options: (p) => parse<Array<{ name: string; path: string; branch: string; remotes: Record<string, string> }>>(p.frame.params.repos, []).map((r) => ({ id: r.path, label: r.name, hint: r.remotes.origin ?? Object.values(r.remotes)[0] ?? r.path })),
    // The repository the wizard was opened from starts ticked; repos already in the toil project too.
    initial: (p) => {
      const have = reposOf(shownOf(p)).map((r) => r.path).filter(Boolean);
      return parse<Array<{ path: string }>>(p.frame.params.repos, []).map((r) => r.path).filter((path) => path === p.frame.params.repo || have.includes(path));
    },
    confirm: (checked, p): Action => {
      const params = p.frame.params;
      const have = new Set(reposOf(shownOf(p)).map((r) => r.path));
      const added = checked.filter((path) => !have.has(path));
      if (added.length === 0) return thenOf(params);
      return change(params, `Add ${plural(added.length, 'repo')}`, added.map((path) => ({ args: ['projects', 'add-repo', params.ref!, path] })), thenOf(params));
    },
  },
};

export const remoteView: View = {
  title: () => 'Remote',
  body: (caps) => [muted(caps, 'Its clone URL: https://..., ssh://... or git@host:path. A user name or token in it is left out.')],
  input: {
    label: () => 'Remote URL',
    submit: (text, p): Action | { error: string } => {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^[^@/\\\s]+@[^:/\\\s]+:/.test(text)) return { error: 'That isn\'t a remote URL; add a local clone from a scan instead.' };
      return change(p.frame.params, 'Add a repo', [{ args: ['projects', 'add-repo', p.frame.params.ref!, text] }], thenOf(p.frame.params));
    },
  },
};

// ─── Create ────────────────────────────────────────────────────────────────

/** A toil project name from a folder: its last part, lowercased, with anything else made a single hyphen. */
export function nameFromFolder(folder: string): string {
  const last = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const name = last.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[0-9-]+/, '');
  return CONNECTION_NAME.test(name) ? name : '';
}

export const newView: View = {
  title: () => 'Create',
  body: (caps) => [heading(caps, step(1, 'name')), '', muted(caps, 'What is the body of work called? Lowercase letters, digits and single hyphens, e.g. payments. It is saved in ~/.toil/projects as you go, and step 6 reviews the whole thing.')],
  input: {
    label: () => 'Toil project name',
    initial: (p) => nameFromFolder(p.frame.params.repo ?? p.data.folder.repo?.root ?? p.data.folder.cwd),
    submit: (text, p): Action | { error: string } => {
      if (!CONNECTION_NAME.test(text)) return { error: 'Use lowercase letters, digits and single hyphens, starting with a letter.' };
      const repo = p.frame.params.repo ?? p.data.folder.repo?.root;
      return {
        run: {
          title: `Create ${text}`,
          steps: [{ args: ['projects', 'init', text], label: step(1, 'name') }, showStep(text)],
          next: (r) => (r.every((x) => x.envelope.ok) ? { go: 'toil-project-scan', params: { ref: text, flow: 'create', ...(repo ? { repo } : {}), then: json({ go: 'toil-project-new-areas', params: { ref: text, flow: 'create' } }) } } : undefined),
        },
      };
    },
  },
};

export const newAreasView: View = {
  title: () => 'Areas',
  body: (caps, p) => {
    const linked = sectionsOf(shownOf(p)).filter((x) => !x.env);
    return [
      heading(caps, step(3, 'areas')),
      '',
      muted(caps, 'Link each service this work uses, and pick the connection it goes through. Areas with discovery (step 4) list what to name right after.'),
      ...(linked.length ? ['', faint(caps, `Linked: ${linked.map((x) => x.area).join(', ')}`)] : []),
    ];
  },
  items: (p) => {
    const ref = refOf(p);
    const cfg = config(p.data);
    const linked = new Set(sectionsOf(shownOf(p)).filter((x) => !x.env).map((x) => x.area));
    const yours = p.data.areas.filter((a) => a.configurable && a.name !== 'skills' && !linked.has(a.name) && cfg && connectionsOf(cfg, a.name).length > 0);
    const params = { ref, flow: 'create', discover: '1', then: backTo('toil-project-new-areas') };
    return [
      ...yours.map((a): Item => ({ label: a.name, hint: `${plural(connectionsOf(cfg!, a.name).length, 'connection')}${DISCOVERY[a.name] ? `; discovers ${DISCOVERY[a.name]!.what}` : ''}`, action: { go: 'toil-project-connection', params: { ...params, area: a.name } } })),
      { label: 'Another area', hint: 'One you have no connection for yet', action: { go: 'toil-project-area-pick', params } },
      { label: 'Next: environments', hint: 'Step 5', action: { go: 'toil-project-new-envs', params: { ref, flow: 'create' } } },
    ];
  },
};

export const newEnvsView: View = {
  title: () => 'Environments',
  body: (caps, p) => {
    const envs = sectionsOf(shownOf(p)).filter((x) => x.env);
    return [
      heading(caps, step(5, 'environments')),
      '',
      muted(caps, 'Per environment (test, prod), the resources each area has there, e.g. an OpenShift namespace. --env picks one on a call; the first you add becomes the default. Skip this if it has none.'),
      ...(envs.length ? ['', ...envs.map((x) => `  ${where(x.area, x.env)}  ${faint(caps, Object.entries(x.section).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`).join(' '))}`)] : []),
    ];
  },
  items: (p) => {
    const ref = refOf(p);
    return [
      { label: 'Add an environment', hint: 'A name, an area, its connection and a value', action: { go: 'toil-project-env-name', params: { ref, flow: 'create', then: backTo('toil-project-new-envs') } } },
      {
        label: 'Next: review',
        hint: 'Step 6: show it, and check it',
        action: { run: { title: step(6, 'review'), steps: [showStep(ref), checkStep(ref)], next: (r) => (r[0]?.envelope.ok ? { go: 'toil-project', params: { ref }, root: 'projects' } : undefined) } },
      },
    ];
  },
};

export const envNameView: View = {
  title: () => 'Environment',
  body: (caps, p) => {
    const envs = [...new Set(sectionsOf(shownOf(p)).map((x) => x.env).filter(Boolean))];
    return [muted(caps, 'Its name, e.g. test or prod. Use the name your connections use for env, so --env matches both.'), ...(envs.length ? ['', faint(caps, `So far: ${envs.join(', ')}`)] : [])];
  },
  input: {
    label: () => 'Environment',
    submit: (text, p): Action | { error: string } => {
      if (!/^[A-Za-z0-9][\w.-]*$/.test(text)) return { error: 'Use letters, digits, dots, hyphens and underscores, e.g. prod.' };
      // The first environment becomes the default; its value comes after the connection, empty to skip.
      const first = !shownOf(p)?.toilProject.environments;
      return { go: 'toil-project-area-pick', params: { ...p.frame.params, env: text, setAfter: '1', ...(first ? { first: '1' } : {}) } };
    },
  },
};

// ─── Export and import ─────────────────────────────────────────────────────

function exportRun(ref: string, args: string[]): Run {
  return {
    title: `Export ${ref}`,
    steps: [{ args }],
    next: (r) => {
      const e = r[0]?.envelope;
      if (e && !e.ok && e.error.fix?.includes('--replace')) return { go: 'toil-project-export-replace', params: { ref, args: json(args) } };
      return e?.ok ? { go: 'toil-project', root: 'toil-project' } : undefined;
    },
  };
}

export const exportView: View = {
  title: () => 'Export',
  body: (caps) => [muted(caps, "For sharing: each connection name becomes a host selector from that connection's URL, and local paths are dropped. toil writes the file and stops; committing it is yours to do.")],
  items: (p) => {
    const ref = refOf(p);
    const name = shownOf(p)?.name ?? ref;
    const repo = p.data.folder.repo?.root;
    return [
      ...(repo ? [{ label: 'Into this repository', hint: `${repo}/.toil/projects/${name}.json`, action: { run: exportRun(ref, ['projects', 'export', ref, '--repo', repo]) } } satisfies Item] : []),
      { label: 'To a file', hint: 'A .json file in this folder', action: { go: 'toil-project-export-file', params: { ref } } },
    ];
  },
};

export const exportFileView: View = {
  title: () => 'File',
  body: (caps) => [muted(caps, 'Where to write it: a .json path inside the folder toil was started in.')],
  input: {
    label: () => 'File',
    initial: (p) => `${shownOf(p)?.name ?? 'toil-project'}.json`,
    submit: (text, p): Action | { error: string } => {
      if (!/\.json$/i.test(text)) return { error: 'The file must end in .json.' };
      return { run: exportRun(refOf(p), ['projects', 'export', refOf(p), '--file', text]) };
    },
  },
};

export const exportReplaceView: View = {
  title: () => 'Replace',
  body: (caps) => [ok(caps, false, 'A toil project is already there.'), '', 'Replace it with this one?'],
  items: (p) => {
    const args = parse<string[]>(p.frame.params.args, []);
    return [
      { label: 'Replace it', hint: 'The same export, with --replace', action: { run: exportRun(refOf(p), [...args, '--replace']) } },
      { label: 'Keep it', hint: 'Write nothing', action: { go: 'toil-project', root: 'toil-project' } },
    ];
  },
};

/** Before importing, `toil projects check` on the file: its problems, and which bindings land on a connection with writes on. */
function importCheckRun(source: string): Run {
  return { title: 'Check before importing', steps: [checkStep(source)], next: (r) => (r[0]?.envelope.ok ? { go: 'toil-project-import-check', params: { source } } : undefined) };
}

export const importView: View = {
  title: () => 'Import',
  body: (caps) => [muted(caps, "A toil project file a teammate shared, or one checked into a repository (.toil/projects/<name>.json). Importing copies it into your own folder, so it's yours: you can change it, and writes may follow its bindings. It never creates a connection; any it names that you don't have are listed next.")],
  input: {
    label: () => 'Toil project file',
    submit: (text): Action | { error: string } => {
      if (!/\.json$/i.test(text)) return { error: 'Give one .json file. To import a whole folder, run toil projects import <folder>.' };
      return { run: importCheckRun(text) };
    },
  },
};

const importRun = (source: string): Run => ({
  title: 'Import',
  steps: [{ args: ['projects', 'import', source] }],
  next: (r) => (r[0]?.envelope.ok ? { go: 'toil-project-import-done', params: { result: json(r[0].envelope.data) } } : undefined),
});

/**
 * Whether a checked toil project has a binding that lands on a connection with writes
 * on, and, for the screen, which ones. The question is decided by the code alone;
 * the names come from the message and fall back to "a connection" if it's reworded.
 */
export function writesBindings(c: Checked | undefined): { any: boolean; names: string } {
  const found = (c?.problems ?? []).filter((x) => x.code === 'TOIL_PROJECT_WRITES_BINDING');
  const names = [...new Set(found.map((x) => /connection (\S+), which has writes on/.exec(x.message)?.[1]).filter((x): x is string => Boolean(x)))];
  return { any: found.length > 0, names: names.length ? names.join(', ') : 'a connection' };
}

export const importCheckView: View = {
  title: () => 'Before importing',
  body: (caps, p) => {
    const c = checkedOf(p, p.frame.params.source);
    if (!c) return [];
    const lines = [c.file === null ? ok(caps, false, "It doesn't load as a toil project, so it can't be imported as it is.") : c.ok ? ok(caps, true, `${c.name} reads cleanly.`) : ok(caps, false, `${c.name} has errors. A connection or host you don't have can be added after importing; anything else needs fixing in the file first.`)];
    for (const x of c.problems) lines.push(`  ${x.level === 'error' ? ok(caps, false, x.code) : muted(caps, x.code)}  ${faint(caps, x.path || '(file)')}`, muted(caps, `    ${x.message}`));
    const writes = writesBindings(c);
    if (writes.any) lines.push('', ok(caps, false, `Its bindings select ${writes.names}, with writes on. Importing makes those bindings yours, so you'll be asked to confirm.`));
    return lines;
  },
  items: (p) => {
    const source = p.frame.params.source!;
    const c = checkedOf(p, source);
    if (!c || c.file === null) return [{ label: 'Back', hint: '', action: { back: true } }];
    const writes = writesBindings(c);
    return [
      writes.any
        ? { label: 'Import it', hint: 'Asks you to type the toil project name', action: { go: 'toil-project-import-confirm', params: { source, name: c.name ?? '', writes: writes.names } } }
        : { label: 'Import it', hint: `toil projects import ${source}`, action: { run: importRun(source) } },
      { label: 'Back', hint: 'Import nothing', action: { back: true } },
    ];
  },
};

export const importConfirmView: View = {
  title: () => 'Confirm',
  body: (caps, p) => [ok(caps, false, `Importing ${p.frame.params.name} binds it to ${p.frame.params.writes}, with writes on.`), '', 'Once it is yours, a write command run in its repositories may go there without --connection, as long as you allow the write on the call.'],
  input: {
    label: (p) => `Type ${p.frame.params.name} to import it`,
    submit: (text, p): Action | { error: string } => {
      if (text !== p.frame.params.name) return { error: `That isn't "${p.frame.params.name}", so nothing was imported.` };
      return { run: importRun(p.frame.params.source!) };
    },
  },
};

interface Imported {
  imported: Array<{ name: string; from: string; file: string }>;
  toSetUp: Array<{ toilProject: string; area: string; env: string | null; connection?: string; host?: string; problem: string }>;
}

/** What an import named that you still don't have: a connection name or a host, each with a way to add it. */
export function stillToSetUp(data: WelcomeData, result: Imported): Imported['toSetUp'] {
  const cfg = config(data);
  return result.toSetUp.filter((x) => {
    if (!cfg) return true;
    if (x.connection) return cfg.connections[x.connection]?.area !== x.area;
    return x.host !== undefined && !connectionsOf(cfg, x.area).some((name) => onHost(cfg.connections[name], x.host!, siteApisOf(data, x.area)));
  });
}

export const importDoneView: View = {
  title: () => 'Imported',
  body: (caps, p) => {
    const r = parse<Imported>(p.frame.params.result, { imported: [], toSetUp: [] });
    const left = stillToSetUp(p.data, r);
    return [
      ...r.imported.map((x) => ok(caps, true, `${x.name} is yours now: ${x.file}`)),
      '',
      left.length ? heading(caps, `${plural(left.length, 'connection')} to set up`) : ok(caps, true, 'Every connection it names is one you have.'),
      ...left.map((x) => muted(caps, `  ${x.problem}`)),
    ];
  },
  items: (p) => {
    const r = parse<Imported>(p.frame.params.result, { imported: [], toSetUp: [] });
    const then = backTo('toil-project-import-done');
    return [
      ...stillToSetUp(p.data, r).map((x): Item => ({
        label: x.connection ? `Add ${x.connection}` : `Add a ${x.area} connection`,
        hint: x.connection ? `${x.area}, the name the toil project uses` : `For ${x.host}`,
        attention: true,
        action: { go: 'add-name', params: { area: x.area, ...(x.connection ? { suggest: x.connection } : {}), then } },
      })),
      ...r.imported.map((x): Item => ({ label: `Open ${x.name}`, hint: 'Review or edit it', action: { run: openRun(x.name, 'projects') } })),
    ];
  },
};

// ─── Delete and hand-off ───────────────────────────────────────────────────

export const deleteView: View = {
  title: () => 'Delete',
  body: (caps, p) => [ok(caps, false, `Delete ${p.frame.params.name}?`), '', `This deletes ${shownOf(p)?.file ?? 'its file'}. Copies checked into repositories stay.`],
  input: {
    label: (p) => `Type ${p.frame.params.name} to delete it`,
    submit: (text, p): Action | { error: string } => {
      const name = p.frame.params.name!;
      if (text !== name) return { error: `That isn't "${name}", so nothing was deleted.` };
      return { run: { title: `Delete ${name}`, steps: [{ args: ['projects', 'remove', name] }], next: (r) => (r[0]?.envelope.ok ? { go: 'projects', root: 'projects' } : undefined) } };
    },
  },
};

/** The MCP areas an agent needs to build or extend a toil project: the toil project commands, discovery, and each area it covers that this toil serves. */
export function handOffAreas(data: WelcomeData, covered: readonly string[]): string[] {
  const want = ['projects', 'repos', ...covered, ...(covered.length ? [] : Object.keys(DISCOVERY).filter((a) => config(data) && connectionsOf(config(data)!, a).length > 0))];
  return [...new Set(want)].filter((a) => data.mcpAreas.includes(a));
}

export function handOffPrompt(name: string | undefined, folder: string): string {
  const which = name ? `the toil project "${name}"` : 'a toil project for the body of work in this folder';
  return [
    `Build or extend ${which} with the toil MCP tools.`,
    `Find its repositories with repos_scan (folder ${folder}) and add each with projects_add_repo.`,
    'For each service it uses, run that area\'s discovery reads (jira_issue_fields, confluence_space_list, sonar_project_list, ado_project_list) and record keys and fields with projects_link, projects_env and projects_field.',
    'Tell me what you plan to add before you add it, and finish with projects_check.',
    'Leave any binding to a connection with writes on to me.',
  ].join(' ');
}

export const agentView: View = {
  title: () => 'Hand off',
  body: (caps, p) => {
    const ref = p.frame.params.ref;
    const s = ref ? shownOf(p, ref) : undefined;
    const covered = s ? Object.keys(s.areas) : [];
    const areas = handOffAreas(p.data, covered);
    const folder = p.data.folder.repo?.root ?? p.data.folder.cwd;
    return [
      heading(caps, 'Give the agent these areas'),
      '',
      paint(caps, pal(caps).ink, `  ${commandLine(p.data, ['mcp', '--areas', areas.join(',')])}`),
      faint(caps, 'Connect an agent builds the config snippet for your client; tick the same areas there.'),
      '',
      heading(caps, 'Then ask it'),
      '',
      paint(caps, pal(caps).ink, handOffPrompt(s?.name ?? ref, folder)),
      '',
      muted(caps, "Over MCP, an agent can't bind a toil project to a connection with writes on, change a connection, or delete a toil project: those stay yours, here or on the CLI."),
    ];
  },
  items: () => [{ label: 'Connect an agent', hint: 'The config snippet for your client', action: { go: 'agents' } }],
};

// ─── What the result screen says about each command ────────────────────────

/** One line for a toil projects, repos, discovery or check-toil-project command; undefined for anyone else's. */
export function toilProjectsOutcome(result: StepResult): { good: boolean; text: string } | undefined {
  const e = result.envelope;
  if (!e.ok) return undefined;
  const d = (e.data ?? {}) as Record<string, unknown>;
  const [group, verb] = result.args;
  const said = (text: string, good = true) => ({ good, text });
  if (group === 'repos' && verb === 'scan') {
    const n = Array.isArray(d.repos) ? d.repos.length : 0;
    return said(`Found ${plural(n, 'repository')} under ${String(d.folder ?? 'the folder')}${d.truncated ? ' (stopped early: there were too many folders)' : ''}.`);
  }
  if (verb === 'check-toil-project') {
    const checks = Array.isArray(d.checks) ? (d.checks as Array<{ found?: boolean }>) : [];
    const missing = checks.filter((c) => !c.found).length;
    return said(missing ? `${missing} of ${checks.length} not found on ${String(d.connection ?? 'the connection')}.` : `All ${plural(checks.length, 'value')} found on ${String(d.connection ?? 'the connection')}.`, missing === 0);
  }
  const discovery = Object.values(DISCOVERY).find((x) => x.args.every((a, i) => result.args[i] === a));
  if (discovery) return said(`Found ${plural(discovered(result, discovery).length, discovery.what.replace(/s$/, ''))}.`);
  if (group !== 'projects') return undefined;
  const unchanged = d.changed === false ? ' (it already was)' : '';
  switch (verb) {
    case 'context': {
      const c = d as unknown as Context;
      if (c.toilProject) return said(`This folder resolves to ${c.toilProject.name}: ${whyApplies(c.toilProject, c.repo?.origin)}.`);
      return said(c.candidates.length > 1 ? `${c.candidates.length} toil projects match this folder.` : 'No toil project applies to this folder.', c.candidates.length <= 1);
    }
    case 'list': {
      const l = d as unknown as Listed;
      return said(`${plural(l.toilProjects.length, 'toil-project')}${l.broken.length ? `, ${l.broken.length} broken` : ''}.`, l.broken.length === 0);
    }
    case 'show': {
      const s = d as unknown as Shown;
      const areas = Object.keys(s.areas ?? {});
      return said(`${s.name}: ${plural(reposOf(s).length, 'repo')}, ${areas.length ? areas.join(', ') : 'no areas yet'}.`);
    }
    case 'check': {
      const c = d as unknown as Checked;
      const errors = c.problems.filter((x) => x.level === 'error').length;
      const warnings = c.problems.length - errors;
      return said(c.ok ? `${c.name} checks out${warnings ? `, with ${plural(warnings, 'warning')}` : ''}.` : `${c.name ?? 'It'} has ${plural(errors, 'error')}${warnings ? ` and ${plural(warnings, 'warning')}` : ''}.`, c.ok);
    }
    case 'init':
      return said(`Created ${String(d.name)} in ${String(d.file)}.`);
    case 'add-repo':
      return said(`Repo ${String((d.repo as { name?: unknown } | undefined)?.name ?? '')} is in ${String(d.name)}${unchanged}${Array.isArray(d.credentialsRemoved) ? '; the credential in its stored remote is gone' : ''}.`);
    case 'link':
    case 'env':
      return said(`Saved ${d.env ? `${String(d.env)}: ` : ''}${String(d.area)} in ${String(d.name)}${unchanged}.`);
    case 'field':
      return said(`Saved the ${String(d.area)} field names in ${String(d.name)}${unchanged}.`);
    case 'export':
      return said(`Wrote ${String(d.file)}${Array.isArray(d.hosts) && d.hosts.length ? `, with ${plural(d.hosts.length, 'connection')} shared as a host` : ''}${d.droppedPaths ? `; ${plural(Number(d.droppedPaths), 'local path')} left out` : ''}.`);
    case 'import': {
      const r = d as unknown as Imported & { failed?: unknown[] };
      return said(`Imported ${r.imported.map((x) => x.name).join(', ') || 'nothing'}${r.toSetUp.length ? `; ${plural(r.toSetUp.length, 'connection')} to set up` : ''}.`, !r.failed?.length);
    }
    case 'unlink':
      return said(`Removed ${d.env ? `${String(d.env)}: ` : ''}${String(d.area)} from ${String(d.name)}${Array.isArray(d.credentialsRemoved) ? ', and the credential from its stored remotes' : ''}.`);
    case 'remove':
      return said(`Deleted ${String(d.name)}.`);
    default:
      return said('Done.');
  }
}
