import { ToilError } from '../errors.js';
import { blank, idFor, instant, isRecord, num, overrideUnit, person, setDay, setInstant, str, typeOf, unknownState, unmapped, type MapState, type OwiDocument } from './common.js';
import type { History, Iteration, Link, Person, StatusCategory, WorkItem } from './types.js';

/**
 * GitHub (`github`) to OWI: the issues `issue list`, `issue search` and
 * `issue get` return, the timeline `issue history` returns, and a Projects
 * (v2) board's items from `project items`. An issue carries its type,
 * parent and sub-issues; status, estimate and iteration live on the board,
 * so an issue found in both is one item with the board's fields filled in.
 * Pull requests are not work items here: they are what a later ChangeRef
 * will hold. The board is the system of record, except for the parts that
 * are in the issue, which is also the system of record.
 *
 * Most repositories have no board (#298), so where the board has no value
 * the issue's own record fills in: its milestone is its iteration, a label
 * such as `points: 3` its estimate, and "Blocked by #7" in its body a link.
 * A board value, when there is one, still wins.
 *
 * Docs, checked 2026-10-18: the Issue schema (type, parent_issue_url,
 * sub_issues_summary, state_reason) at https://docs.github.com/en/rest/issues/issues;
 * the timeline at https://docs.github.com/en/rest/issues/timeline;
 * ProjectV2 item field values in the GraphQL reference. Checked 2026-10-19:
 * milestones (`due_on`, `state`) at https://docs.github.com/en/rest/issues/milestones,
 * and `issue_dependencies_summary` at https://docs.github.com/en/rest/issues/issue-dependencies.
 */

/** The Projects number fields that hold an estimate by default, first match. */
export const GITHUB_ESTIMATE_FIELDS = ['Estimate', 'Size', 'Story Points'];
/** The Projects single-select field that holds the board's status by default. */
export const GITHUB_STATUS_FIELD = 'Status';

/** A board's status option names by category, lowercased: GitHub's templates' defaults and their common variants. */
export const GITHUB_STATUSES: Record<string, StatusCategory> = {
  todo: 'TODO',
  'to do': 'TODO',
  backlog: 'TODO',
  ready: 'TODO',
  new: 'TODO',
  'in progress': 'IN_PROGRESS',
  doing: 'IN_PROGRESS',
  'in review': 'IN_PROGRESS',
  done: 'DONE',
};

/** How long a milestone's sprint runs when no earlier milestone says where it starts, and the toil project names no length. */
export const GITHUB_ITERATION_DAYS = 14;

/**
 * The labels that hold an estimate when the toil project names no pattern of its
 * own: a word that says it is an estimate, then the number. `size: M` and
 * other T-shirt sizes are left alone: a letter is not a number of points.
 */
const ESTIMATE_LABEL = /^(?:story[ -]?points?|points?|pts|sp|estimate)\s*[:=/ -]\s*(\d+(?:\.\d+)?)$/i;
/** The same, in words, for the reasons and the docs. */
export const GITHUB_ESTIMATE_LABELS = '"points: N", "story points: N", "pts: N", "sp: N" or "estimate: N"';

/**
 * A toil project's `estimateLabel` (`points: {n}`) as a pattern: the text
 * literally, in any case, with `{n}` the number. Literal on purpose, not a
 * regular expression, since a toil project may come from a repository, and a
 * pattern from someone else's file shouldn't be able to stall the mapper.
 */
export function estimateLabelPattern(template: string): RegExp {
  const parts = template.split('{n}');
  if (parts.length !== 2) {
    throw new ToilError('INVALID_INPUT', `estimateLabel "${template}" must hold {n} exactly once, where the number is.`, {
      fix: 'Write the label with {n} for the number, for example estimateLabel=points: {n} or estimateLabel=size/{n}.',
    });
  }
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escape(parts[0]!)}(\\d+(?:\\.\\d+)?)${escape(parts[1]!)}$`, 'i');
}

type Issue = Record<string, unknown>;
type ProjectItem = { id?: unknown; type?: unknown; createdAt?: unknown; content?: unknown; fieldValues?: unknown };

/** `owner/repo#number`, from the issue's html_url or repository_url. */
function issueKey(issue: Issue): string | undefined {
  const number = num(issue.number);
  if (number === null) return undefined;
  const html = str(issue.html_url);
  const fromHtml = html ? /^https?:\/\/[^/]+(?:\/[^/]+)*?\/([^/]+)\/([^/]+)\/issues\/\d+$/.exec(html) : null;
  if (fromHtml) return `${fromHtml[1]}/${fromHtml[2]}#${number}`;
  const repo = str(issue.repository_url);
  const fromRepo = repo ? /\/repos\/([^/]+)\/([^/]+)$/.exec(repo) : null;
  return fromRepo ? `${fromRepo[1]}/${fromRepo[2]}#${number}` : undefined;
}

/** The key an issue API URL names (`…/repos/o/r/issues/9`). */
const keyOfApiUrl = (url: unknown) => {
  const m = typeof url === 'string' ? /\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(url) : null;
  return m ? `${m[1]}/${m[2]}#${m[3]}` : undefined;
};

export const ghPerson = (value: unknown): Person | null => (isRecord(value) ? person(value.login, value.name, value.email) : null);

/** The issues a document holds: an array (lists, search), { issues } (several numbers) or one issue. Pull requests are dropped and counted. */
export function issuesOf(data: unknown): { issues: Issue[]; pulls: number } | undefined {
  const all = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.issues) ? data.issues : isRecord(data) && typeof data.number === 'number' ? [data] : undefined;
  if (!all) return undefined;
  const records = all.filter(isRecord);
  const issues = records.filter((r) => r.pull_request === undefined);
  return { issues, pulls: records.length - issues.length };
}

export function githubItem(doc: OwiDocument, issue: Issue, state: MapState): WorkItem | undefined {
  const key = issueKey(issue);
  if (key === undefined) return undefined;
  const item = blank(doc, key, str(issue.title) ?? '', { [doc.command]: issue });
  item.url = str(issue.html_url);
  item.typeName = isRecord(issue.type) ? str(issue.type.name) : null;
  item.type = typeOf(item.typeName);
  if (issue.type === undefined) unmapped(item, 'type', "the record has no type field: this GitHub server doesn't have issue types");
  if (typeof issue.body === 'string') item.body = { format: 'markdown', content: issue.body };
  item.status = str(issue.state);
  item.statusCategory = item.status === 'closed' ? 'DONE' : item.status === 'open' ? 'TODO' : 'UNKNOWN';
  item.resolution = item.status === 'closed' ? str(issue.state_reason) : null;
  item.assignee = Array.isArray(issue.assignees) && issue.assignees.length > 0 ? ghPerson(issue.assignees[0]) : ghPerson(issue.assignee);
  item.reporter = ghPerson(issue.user);
  item.labels = (Array.isArray(issue.labels) ? issue.labels : []).flatMap((l) => (typeof l === 'string' ? [l] : isRecord(l) && typeof l.name === 'string' ? [l.name] : []));
  const parent = keyOfApiUrl(issue.parent_issue_url);
  if (parent) item.parent = idFor(doc.connection, parent);
  if (Array.isArray(issue.sub_issues)) item.children = issue.sub_issues.flatMap((s) => (isRecord(s) && issueKey(s) ? [idFor(doc.connection, issueKey(s)!)] : []));
  setInstant(item, 'created', issue.created_at, 'created_at');
  setInstant(item, 'updated', issue.updated_at, 'updated_at');
  setInstant(item, 'resolved', issue.closed_at, 'closed_at');
  labelEstimate(item, state);
  item.links = bodyLinks(doc.connection, key, typeof issue.body === 'string' ? issue.body : '');
  const deps = isRecord(issue.issue_dependencies_summary) ? issue.issue_dependencies_summary : {};
  const blockedBy = num(deps.total_blocked_by) ?? 0;
  const blocking = num(deps.total_blocking) ?? 0;
  if (blockedBy + blocking > 0) {
    unmapped(item, 'links', `GitHub records ${blockedBy} blocked-by and ${blocking} blocking issue dependencies for this issue, which no toil command reads yet: only "Blocked by #n", "Depends on #n" and "Blocks #n" in the body are mapped`);
  }
  return item;
}

/** The estimate a label holds: the toil project's `estimateLabel` pattern, else the usual words. Two labels that both match are listed, never picked between. */
function labelEstimate(item: WorkItem, state: MapState): void {
  const pattern = state.fields.estimateLabel === undefined ? ESTIMATE_LABEL : estimateLabelPattern(state.fields.estimateLabel);
  const hits = item.labels.flatMap((label) => {
    const m = pattern.exec(label.trim());
    return m ? [{ label, value: Number(m[1]) }] : [];
  });
  if (hits.length === 1) item.estimate = { value: hits[0]!.value, unit: overrideUnit(state), field: `label:${hits[0]!.label}` };
  else if (hits.length > 1) unmapped(item, 'estimate', `${hits.length} labels hold an estimate (${hits.map((h) => `"${h.label}"`).join(', ')}), so none was picked: keep one`);
}

/**
 * A dependency stated in a body: "Blocked by #7", "Depends on imagile/api#12, #13", "Blocks #9".
 * The colon carries its own whitespace, so a run of spaces has one way to match and
 * stays linear: anyone who can open an issue writes the body this reads.
 */
const LINK_PHRASE = /\b(blocked by|depends on|blocks)\s*(?::\s*)?((?:[\w.-]+\/[\w.-]+)?#\d+(?:\s*(?:,|and|&)\s*(?:[\w.-]+\/[\w.-]+)?#\d+)*)/gi;
const LINK_REF = /(?:([\w.-]+)\/([\w.-]+))?#(\d+)/g;

/**
 * The dependencies an issue's body states, as `blocks` links: "Blocked by"
 * and "Depends on" point inward (the other issue blocks this one), "Blocks"
 * outward. Code, fenced or inline, is left out, since an example of the
 * phrase is not a dependency. A bare `#n` is in the issue's own repository.
 * Mentions alone (the timeline's `cross-referenced`) are not links: every
 * "Blocked by #7" is also a mention of #7, and a mention commits no one.
 */
export function bodyLinks(connection: string, key: string, body: string): Link[] {
  const repo = key.slice(0, key.lastIndexOf('#'));
  const prose = body.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const links: Link[] = [];
  for (const phrase of prose.matchAll(LINK_PHRASE)) {
    const name = phrase[1]!.toLowerCase();
    for (const ref of phrase[2]!.matchAll(LINK_REF)) {
      const targetKey = `${ref[1] ? `${ref[1]}/${ref[2]}` : repo}#${ref[3]}`;
      if (targetKey === key) continue;
      const link: Link = { type: 'blocks', direction: name === 'blocks' ? 'outward' : 'inward', target: idFor(connection, targetKey), name };
      if (!links.some((l) => l.direction === link.direction && l.target === link.target)) links.push(link);
    }
  }
  return links;
}

/**
 * Each body link, on the other issue too, when it is in the input: Jira and
 * Azure DevOps hold a link on both items, and a reader of the blocking issue
 * alone should see what it holds up. Named for the side it is on.
 */
export function reciprocalLinks(items: Iterable<WorkItem>, byId: Map<string, WorkItem>): void {
  for (const item of items) {
    for (const link of [...item.links]) {
      const other = link.type === 'blocks' ? byId.get(link.target) : undefined;
      if (!other) continue;
      const direction = link.direction === 'inward' ? 'outward' : 'inward';
      if (other.links.some((l) => l.type === 'blocks' && l.target === item.id && l.direction === direction)) continue;
      other.links.push({ type: 'blocks', direction, target: item.id, name: direction === 'outward' ? 'blocks' : 'blocked by' });
    }
  }
}

/** A milestone as an issue record carries it. */
interface Milestone {
  number: number;
  title: string;
  due: string | null;
  closed: boolean;
}

function milestoneOf(issue: Issue): Milestone | null {
  const m = isRecord(issue.milestone) ? issue.milestone : null;
  const number = m ? num(m.number) : null;
  const title = m ? str(m.title) : null;
  if (!m || number === null || title === null) return null;
  return { number, title, due: instant(m.due_on) ?? null, closed: m.state === 'closed' };
}

/**
 * Milestones as iterations, for every issue the board gave none: the
 * milestone's title is the sprint's name and its `due_on` the end. The start
 * is the previous milestone's due date in the same repository, so back-to-back
 * sprints meet, or the end less 14 days for the first; with `iterationDays`
 * set, every sprint is that long instead. A milestone with no due date is an
 * iteration with no dates. Closed is `past`; open says nothing about the
 * clock, so its state is null. Runs before the boards are applied, so a
 * board's iteration value replaces it.
 */
export function applyMilestones(pairs: Array<{ item: WorkItem; issue: Issue }>, state: MapState): void {
  const days = state.fields.iterationDays === undefined ? undefined : Number(state.fields.iterationDays);
  const repoOf = (item: WorkItem) => `${item.source.connection}\u0000${item.source.key.slice(0, item.source.key.lastIndexOf('#'))}`;
  const byRepo = new Map<string, Map<number, Milestone>>();
  for (const { item, issue } of pairs) {
    const m = milestoneOf(issue);
    if (!m) continue;
    const repo = byRepo.get(repoOf(item)) ?? new Map<number, Milestone>();
    byRepo.set(repoOf(item), repo);
    repo.set(m.number, m);
  }
  const iterations = new Map<string, Iteration>();
  for (const [repo, milestones] of byRepo) {
    const dated = [...milestones.values()].filter((m) => m.due !== null).sort((a, b) => (a.due! < b.due! ? -1 : 1));
    for (const m of milestones.values()) {
      let start: string | null = null;
      if (m.due !== null) {
        const previous = days === undefined ? dated.filter((d) => d.due! < m.due!).at(-1) : undefined;
        start = previous ? previous.due : new Date(Date.parse(m.due) - (days ?? GITHUB_ITERATION_DAYS) * 86_400_000).toISOString();
      }
      iterations.set(`${repo}\u0000${m.number}`, { id: String(m.number), name: m.title, path: null, start, end: m.due, state: m.closed ? 'past' : null });
    }
  }
  for (const { item, issue } of pairs) {
    const m = milestoneOf(issue);
    const iteration = m ? iterations.get(`${repoOf(item)}\u0000${m.number}`) : undefined;
    if (iteration) item.iteration = { ...iteration };
  }
}

/** One board item: its issue's key (or the draft's own), and its field values by field name. */
export interface BoardEntry {
  key: string;
  item: ProjectItem;
  values: Map<string, Record<string, unknown>>;
  draft: boolean;
}

/** The board items `project items` returns, keyed as items are. Pull requests are counted and left out. */
export function boardEntries(doc: OwiDocument): { entries: BoardEntry[]; pulls: number } | undefined {
  if (!Array.isArray(doc.data) || !doc.data.every((d) => isRecord(d) && 'fieldValues' in d)) return undefined;
  const entries: BoardEntry[] = [];
  let pulls = 0;
  for (const raw of doc.data as ProjectItem[]) {
    const content = isRecord(raw.content) ? raw.content : {};
    const values = new Map<string, Record<string, unknown>>();
    for (const v of Array.isArray(raw.fieldValues) ? raw.fieldValues : []) if (isRecord(v) && isRecord(v.field) && typeof v.field.name === 'string') values.set(v.field.name, v);
    if (raw.type === 'PULL_REQUEST') {
      pulls++;
      continue;
    }
    if (raw.type === 'DRAFT_ISSUE') {
      if (typeof raw.id === 'string') entries.push({ key: `${doc.inputs.owner ?? 'project'}/draft/${raw.id}`, item: raw, values, draft: true });
      continue;
    }
    const repo = isRecord(content.repository) ? str(content.repository.nameWithOwner) : null;
    const number = num(content.number);
    if (repo && number !== null) entries.push({ key: `${repo}#${number}`, item: raw, values, draft: false });
  }
  return { entries, pulls };
}

/** An item for a board entry whose issue wasn't in the input: what the board carries about it. */
export function boardItem(doc: OwiDocument, entry: BoardEntry): WorkItem {
  const content = isRecord(entry.item.content) ? entry.item.content : {};
  const item = blank(doc, entry.key, str(content.title) ?? '', {});
  item.url = str(content.url);
  item.typeName = entry.draft ? 'Draft issue' : null;
  item.status = entry.draft ? null : (str(content.state)?.toLowerCase() ?? null);
  item.statusCategory = item.status === 'closed' ? 'DONE' : 'TODO';
  setInstant(item, 'created', entry.item.createdAt, 'createdAt');
  setInstant(item, 'updated', content.updatedAt ?? null, 'updatedAt');
  if (!entry.draft) for (const field of ['type', 'assignee', 'reporter', 'labels', 'parent']) unmapped(item, field, 'the board carries only the title, state and URL: add github issue get output for this issue to the input');
  return item;
}

/** Fills an item with what its board entry knows: status, estimate, iteration, and any field an override names. */
export function applyBoard(item: WorkItem, entry: BoardEntry, doc: OwiDocument, state: MapState): void {
  item.native[doc.command] = entry.item;
  const status = entry.values.get(GITHUB_STATUS_FIELD);
  const name = status ? str(status.name) : null;
  if (name !== null && item.status !== 'closed') {
    item.status = name;
    item.statusCategory = GITHUB_STATUSES[name.toLowerCase()] ?? unknownState(item, state, name, 'a board status option of the project\'s own');
  }

  // The board leaves an empty field out of fieldValues, so an unestimated item and one estimated elsewhere look alike.
  const override = state.fields.estimate;
  const estimateName = override ?? GITHUB_ESTIMATE_FIELDS.find((f) => num(entry.values.get(f)?.number) !== null);
  const estimate = estimateName === undefined ? null : num(entry.values.get(estimateName)?.number);
  // The board's number wins; with none, an estimate label on the issue stands.
  if (estimateName !== undefined && estimate !== null) {
    removeUnmapped(item, 'estimate');
    item.estimate = { value: estimate, unit: overrideUnit(state), field: estimateName };
  } else if (item.estimate === null) {
    const board = override ? `the board item has no number in "${override}" (fields estimate)` : `the board item has no number in a field named ${GITHUB_ESTIMATE_FIELDS.map((f) => `"${f}"`).join(', ')} (point fields estimate at the project's own)`;
    unmapped(item, 'estimate', `${board}, and no label holds one (${labelWords(state)})`);
  }

  // As with estimate, the board leaves an empty field out, so "no value" and "no such field" read the same.
  const absent = (name: string, field: string) => unmapped(item, field, `the board item has no value in "${name}": the field is empty, or the project has no field of that name (fields ${field})`);

  const iterationName = state.fields.iteration;
  const iterationValue = iterationName ? entry.values.get(iterationName) : [...entry.values.values()].find((v) => v.__typename === 'ProjectV2ItemFieldIterationValue');
  // As with estimate: the board's iteration wins, and with none the issue's milestone stands.
  if (iterationValue && str(iterationValue.title)) {
    removeUnmapped(item, 'iteration');
    const start = instant(iterationValue.startDate) ?? null;
    const days = num(iterationValue.duration);
    const end = start && days !== null ? new Date(Date.parse(start) + days * 86_400_000).toISOString() : null;
    const iteration: Iteration = { id: str(iterationValue.iterationId), name: iterationValue.title as string, path: null, start, end, state: null };
    item.iteration = iteration;
  } else if (item.iteration === null) {
    if (iterationName) absent(iterationName, 'iteration');
    else unmapped(item, 'iteration', "the board item has no iteration value (it isn't in an iteration, or the project has no iteration field), and the issue has no milestone");
  }
  for (const field of ['priority', 'team', 'dueDate'] as const) {
    const fieldName = state.fields[field];
    if (fieldName === undefined) continue;
    removeUnmapped(item, field);
    const value = entry.values.get(fieldName);
    const read = value ? (str(value.name) ?? str(value.text) ?? str(value.date) ?? (num(value.number) === null ? null : String(value.number))) : null;
    if (read === null) absent(fieldName, field);
    else if (field === 'dueDate') setDay(item, read, fieldName);
    else item[field] = read;
  }
  if (state.fields.type !== undefined) {
    const value = entry.values.get(state.fields.type);
    const typeName = value ? (str(value.name) ?? str(value.text)) : null;
    removeUnmapped(item, 'type');
    if (typeName) {
      item.typeName = typeName;
      item.type = typeOf(typeName);
    } else absent(state.fields.type, 'type');
  }
}

const removeUnmapped = (item: WorkItem, field: string) => {
  item.unmapped = item.unmapped.filter((u) => u.field !== field);
};

const labelWords = (state: MapState) => (state.fields.estimateLabel === undefined ? GITHUB_ESTIMATE_LABELS : `"${state.fields.estimateLabel}" (fields estimateLabel)`);

/** Notes, on an issue no board covered, where its missing fields would have come from. */
export function noBoard(item: WorkItem, state: MapState): void {
  if (item.estimate === null) unmapped(item, 'estimate', `no label holds an estimate (${labelWords(state)}), and no project board covers the issue: label it, name the team's own label with fields estimateLabel, or add github project items output to the input`);
  if (item.iteration === null) unmapped(item, 'iteration', 'the issue has no milestone, and no project board covers it: set a milestone, or add github project items output to the input');
  for (const field of ['priority', 'team', 'dueDate', 'type'] as const) if (state.fields[field] !== undefined) unmapped(item, field, `"${state.fields[field]}" is a project field: add github project items output to the input`);
}

/**
 * The timeline `issue history` returns: `closed` and `reopened` as transitions,
 * and `milestoned` and `demilestoned` as iteration changes, since a milestone
 * is the iteration when no board says otherwise. Moving an issue from one
 * milestone to another is two events in the same second, read as one change,
 * which is what makes a carry-over visible.
 */
export function githubHistory(doc: OwiDocument): History | undefined {
  if (!Array.isArray(doc.data)) return undefined;
  const history: History = { transitions: [], iterations: [] };
  for (const event of doc.data) {
    if (!isRecord(event)) continue;
    const at = instant(event.created_at);
    if (!at) continue;
    const by = ghPerson(event.actor);
    if (event.event === 'closed') history.transitions.push({ from: 'open', to: 'closed', fromCategory: 'TODO', toCategory: 'DONE', at, by });
    else if (event.event === 'reopened') history.transitions.push({ from: 'closed', to: 'open', fromCategory: 'DONE', toCategory: 'TODO', at, by });
    else if (event.event === 'milestoned' || event.event === 'demilestoned') {
      const title = isRecord(event.milestone) ? str(event.milestone.title) : null;
      if (title === null) continue;
      const side = event.event === 'milestoned' ? 'to' : 'from';
      const last = history.iterations.at(-1);
      if (last && last.at === at && last[side].length === 0) last[side] = [title];
      else history.iterations.push({ from: side === 'from' ? [title] : [], to: side === 'to' ? [title] : [], at, by });
    }
  }
  return history;
}

