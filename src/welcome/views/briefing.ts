import type { Brief } from '../../core/brief/brief.js';
import { ok } from '../screens.js';
import { pal, paint } from '../term.js';
import type { Caps, Item, Run, Step, StepResult, View } from '../view.js';

/**
 * Briefing a toil project from the menu (#494): what in its work needs a person,
 * and what to do first, the way `toil projects brief` says it, in a terminal.
 * The menu composes the reads a person would type, each shown as it runs:
 * each tracker's issues and each code host's open pull requests, then every
 * open pull request read with its reviews and checks, then `util owi map`,
 * then `toil projects brief`. It asks only what the toil project names (principle 3:
 * the caller composes, and here the menu is the caller). Every key on the
 * briefing is a terminal hyperlink to its tracker where the terminal draws
 * them, and the URL is printed beside it everywhere else. The weekly status
 * report, assembled live, with citations, before anyone asked for it.
 */

/** What `toil projects show` says an area needs, as the briefing reads it. */
type Areas = Record<string, { inputs?: Record<string, unknown> }>;

/** The most open pull requests read in full; a toil project with more is briefed on these, and says so. */
export const MAX_PR_READS = 20;

const isJira = (area: string) => area === 'jira';
const codeHosts = (area: string) => area === 'github' || area === 'bitbucket' || area === 'ado';
/** Each code host's word for an open pull request, as its `pr list --state` takes it. */
const OPEN: Record<string, string> = { github: 'open', bitbucket: 'OPEN', ado: 'active' };

/** The first run: each tracker's issues, each code host's open pull requests, and each Azure DevOps project's work item ids (a WIQL search; their fields come from one get-many in the next run). */
export function readSteps(toilProject: string, areas: Areas): { steps: Step[] } {
  const steps: Step[] = [];
  for (const [area, a] of Object.entries(areas)) {
    const inputs = a.inputs ?? {};
    if (isJira(area) && typeof inputs.project === 'string') {
      steps.push({ args: [area, 'issue', 'search', '--toil-project', toilProject, '--jql', `project = ${inputs.project} ORDER BY Rank ASC`], label: `The ${inputs.project} issues` });
    }
    if (area === 'github' && typeof inputs.repo === 'string') steps.push({ args: ['github', 'issue', 'list', '--toil-project', toilProject, '--state', 'all'], label: `${String(inputs.owner ?? '')}/${inputs.repo}'s issues` });
    if (codeHosts(area) && typeof inputs.repo === 'string') steps.push({ args: [area, 'pr', 'list', '--toil-project', toilProject, '--state', OPEN[area]!], label: `${area}'s open pull requests` });
    if (area === 'ado' && inputs.project) steps.push({ args: [area, 'work-item', 'search', '--toil-project', toilProject, '--wiql', WIQL], label: `${String(inputs.project)}'s work items` });
  }
  return { steps };
}

/** The WIQL Toil UI sends for a project's work items (ui/src/load.ts): all of them, by id. */
const WIQL = 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.Id]';

/** The most Azure DevOps work items one get-many reads, as Toil UI's does (BATCH_MAX); a project with more is briefed on its newest, and says so. */
export const MAX_WORK_ITEMS = 1000;

/** The work item ids an Azure DevOps search returned. */
function workItemIds(result: StepResult): string[] {
  if (!result.envelope.ok || result.args[1] !== 'work-item' || result.args[2] !== 'search') return [];
  const rows = (result.envelope.data as { workItems?: Array<{ id?: unknown }> } | null)?.workItems ?? [];
  return rows.map((w) => String(w.id ?? '')).filter(Boolean);
}

/** The open pull requests a `pr list` returned, by the id its `pr get` takes. */
function openIds(result: StepResult): string[] {
  if (!result.envelope.ok || result.args[1] !== 'pr') return [];
  const rows = Array.isArray(result.envelope.data) ? (result.envelope.data as Array<Record<string, unknown>>) : [];
  return rows.map((r) => String(r.number ?? r.id ?? r.pullRequestId ?? '')).filter(Boolean);
}

/** Jira's key patterns from the issues a search returned, so pull requests that name a key point at it: `PAY-{n}=corp-jira`. */
function keyPatterns(results: StepResult[]): string[] {
  const out = new Set<string>();
  for (const r of results) {
    if (!r.envelope.ok || r.args[1] !== 'issue' || r.args[2] !== 'search') continue;
    const connection = r.envelope.meta.context?.connection?.value;
    const issues = ((r.envelope.data as { issues?: Array<{ key?: unknown }> } | null)?.issues ?? []).map((i) => String(i.key ?? ''));
    for (const key of issues) {
      const project = /^([A-Z][A-Z0-9]*)-\d+$/.exec(key)?.[1];
      if (project && connection) out.add(`${project}-{n}=${connection}`);
    }
  }
  return [...out];
}

/** The envelopes a run returned, one per line, as `util owi map` and `toil projects brief` read them. */
const lines = (results: StepResult[]) => results.filter((r) => r.envelope.ok && !(r.args[1] === 'work-item' && r.args[2] === 'search')).map((r) => JSON.stringify(r.envelope)).join('\n');

/** What the briefing couldn't read, in words, for its screen: failed reads, and work items or pull requests past their caps. */
function gaps(results: StepResult[], capped: string[]): string[] {
  return [
    ...results.filter((r) => !r.envelope.ok).map((r) => `${r.args.slice(0, 3).join(' ')} failed (${r.envelope.ok ? '' : r.envelope.error.code}), so the briefing leaves its work out.`),
    ...capped,
  ];
}

/** Brief a toil project, from its `toil projects show` data: the four runs, each shown, then the briefing with anything it couldn't read. */
export function briefRun(toilProject: string, areas: Areas): Run {
  const { steps } = readSteps(toilProject, areas);
  return {
    title: `Read ${toilProject}'s work`,
    steps,
    keepGoing: true,
    next: (read) => {
      const open = read.flatMap((r) => openIds(r).map((id): Step => ({ args: [r.args[0]!, 'pr', 'get', id, '--toil-project', toilProject, '--include', 'reviews,checks'] })));
      const capped: string[] = open.length > MAX_PR_READS ? [`The toil project has ${open.length} open pull requests; the first ${MAX_PR_READS} were read in full, the rest only as listed.`] : [];
      const items = read.flatMap((r) => {
        const ids = workItemIds(r);
        if (ids.length > MAX_WORK_ITEMS) capped.push(`${r.args[0]} has ${ids.length} work items; the newest ${MAX_WORK_ITEMS} were read, since the search lists the oldest first.`);
        return ids.length ? [{ args: [r.args[0]!, 'work-item', 'get-many', ...ids.slice(-MAX_WORK_ITEMS), '--toil-project', toilProject] }] : [];
      });
      const gets = [...items, ...open.slice(0, MAX_PR_READS)];
      const map = (all: StepResult[]): Run => ({
        title: `Map ${toilProject}'s work to Open Work Items`,
        steps: [{ args: ['util', 'owi', 'map', '--text', lines(all), ...keyPatterns(all).flatMap((k) => ['--key-pattern', k])] }],
        next: (mapped) => ({
          run: {
            title: `Brief ${toilProject}`,
            steps: [{ args: ['projects', 'brief', toilProject, '--text', lines(mapped)] }],
            next: (briefed) => (briefed[0]?.envelope.ok ? { go: 'toil-project-brief', params: { toilProject, gaps: JSON.stringify(gaps([...all, ...mapped], capped)) } } : undefined),
          },
        }),
      });
      return gets.length ? { run: { title: `Read ${toilProject}'s ${items.length ? 'work items and ' : ''}open pull requests in full${open.length > MAX_PR_READS ? ` (the first ${MAX_PR_READS} of ${open.length} pull requests)` : ''}`, steps: gets, keepGoing: true, next: (got) => ({ run: map([...read, ...got]) }) } } : { run: map(read) };
    },
  };
}

/** Text from a service, safe to print: control characters (escape sequences among them) dropped, so a ticket's title can't write to the terminal. */
export function plain(text: string): string {
  return [...text].filter((c) => {
    const n = c.codePointAt(0)!;
    return n >= 0x20 && n !== 0x7f && !(n >= 0x80 && n < 0xa0);
  }).join('');
}

/** A terminal hyperlink (OSC 8) where the terminal draws them, to an http(s) address only; the text alone otherwise, with the URL printed after it by the caller. */
export function link(caps: Caps, text: string, url: string | null): string {
  if (!url || !caps.hyperlinks || !/^https?:\/\//i.test(url) || plain(url) !== url) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** `[[corp-jira:PAY-101]]` as its key, linked: the briefing's citations, items and pull requests alike, as a terminal shows them. */
function cited(caps: Caps, text: string, urls: ReadonlyMap<string, string | null>): string {
  return plain(text).replace(/\[\[([^\]]+)\]\]/g, (_m, id: string) => link(caps, id.slice(id.indexOf(':') + 1), urls.get(id) ?? null));
}

/** The briefing, as lines: the recommendation, each reason with its items, what's on track, which lenses couldn't check, and what wasn't read. */
export function briefingLines(caps: Caps, b: Brief & { toilProject?: { name: string } }, notRead: readonly string[] = []): string[] {
  const p = pal(caps);
  const items = b.reasons.flatMap((r) => r.items);
  const byId = new Map<string, string | null>([...items.map((i): [string, string | null] => [i.id, i.url]), ...items.flatMap((i) => i.changes.map((c): [string, string | null] => [c.id, c.url]))]);
  const out: string[] = [];
  out.push(paint(caps, p.muted, `Briefed by code as of ${b.asOf.slice(0, 16).replace('T', ' ')} UTC${b.sprint ? `, ${plain(b.sprint.name)}` : ''}`));
  for (const n of notRead) out.push(ok(caps, false, plain(n)));
  out.push('');
  out.push(b.recommendation ? cited(caps, b.recommendation.text, byId) : 'Nothing needs anyone right now.');
  for (const r of b.reasons) {
    out.push('', `${ok(caps, r.severity !== 'danger', r.label)}  ${paint(caps, p.muted, plain(r.line))}`);
    if (r.text) out.push(`  ${cited(caps, r.text, byId)}`);
    for (const i of r.items) {
      out.push(`  ${link(caps, plain(i.key), i.url)}  ${plain(i.title)}${i.assignee ? paint(caps, p.faint, `  ${plain(i.assignee)}`) : ''}`);
      out.push(`    ${paint(caps, p.muted, cited(caps, i.why, byId))}`);
      if (i.url && !caps.hyperlinks) out.push(`    ${paint(caps, p.faint, plain(i.url))}`);
    }
  }
  out.push('', paint(caps, p.muted, `On track: ${b.onTrack.open} open, ${b.onTrack.done} done.`));
  for (const l of b.lenses.filter((x) => x.on && x.note)) out.push(paint(caps, p.faint, `${l.label}: ${l.note}`));
  return out;
}

/** The briefing screen: the latest `toil projects brief` this session ran for the toil project, what it couldn't read, and the way to run it again. */
export const briefView: View = {
  title: () => 'Briefing',
  body: (caps, p) => {
    const b = p.session.briefs?.[p.frame.params.toilProject ?? ''];
    if (!b) return ['No briefing yet: Brief this toil project reads it.'];
    let notRead: string[] = [];
    try {
      notRead = JSON.parse(p.frame.params.gaps ?? '[]') as string[];
    } catch {
      // A frame from before gaps were kept: nothing to add.
    }
    return briefingLines(caps, b as Brief, notRead);
  },
  items: (p) => {
    const toilProject = p.frame.params.toilProject ?? '';
    const shown = p.session.toilProjects?.[toilProject]?.show as { areas?: Areas } | undefined;
    const again: Item[] = shown?.areas ? [{ label: 'Brief it again', hint: 'Read its work again, then brief it', action: { run: briefRun(toilProject, shown.areas) } }] : [];
    return [...again, { label: 'Back', hint: '', action: { back: true } }];
  },
};
