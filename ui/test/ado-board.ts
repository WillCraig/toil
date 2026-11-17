/**
 * An Azure DevOps Services organization in memory, for the seed scripts and
 * toil's ado commands (on a Services connection) to run against with `fetch` stubbed: one project
 * with three sprints, work items made from JSON Patch, a revision for every
 * change, relations with their reverse on the other end, WIQL that knows only
 * the two queries the seed and Toil UI send, and a recycle bin. Shapes follow
 * what a live organization returned to the same requests (#319), trimmed to
 * the fields read; hosts and names are placeholders. It enforces the two
 * rules the seed leans on: System.ChangedDate only with bypassRules, and
 * never earlier than the revision before it. The real server has more rules,
 * and a committee for the rest.
 */

export const ORG = 'https://dev.azure.com/imagile';
export const PROJECT = 'Imagile';
const NOW = '2026-10-20T01:00:00.000Z';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a canned REST payload, read field by field as the real one is
type Rec = Record<string, any>;
interface Item {
  id: number;
  rev: number;
  fields: Rec;
  relations: Array<{ rel: string; url: string; attributes: Rec }>;
  revisions: Array<{ id: number; rev: number; fields: Rec }>;
  deleted: boolean;
}

const REVERSE: Record<string, string> = {
  'System.LinkTypes.Hierarchy-Reverse': 'System.LinkTypes.Hierarchy-Forward',
  'System.LinkTypes.Hierarchy-Forward': 'System.LinkTypes.Hierarchy-Reverse',
  'System.LinkTypes.Dependency-Forward': 'System.LinkTypes.Dependency-Reverse',
  'System.LinkTypes.Dependency-Reverse': 'System.LinkTypes.Dependency-Forward',
  'System.LinkTypes.Related': 'System.LinkTypes.Related',
};
const NAMES: Record<string, string> = {
  'System.LinkTypes.Hierarchy-Reverse': 'Parent',
  'System.LinkTypes.Hierarchy-Forward': 'Child',
  'System.LinkTypes.Dependency-Forward': 'Successor',
  'System.LinkTypes.Dependency-Reverse': 'Predecessor',
  'System.LinkTypes.Related': 'Related',
};

export interface Board {
  items: Map<number, Item>;
  /** Every request, as `METHOD path?query`. */
  requests: string[];
  /** Every write, as `METHOD path`. */
  writes: string[];
  /** Whether a bypassRules write is refused, as an identity without the permission is. */
  refuseBypass: boolean;
  /** A work item someone else made, carrying whatever fields the test gives it. */
  others(fields: Rec): number;
  /** The pull requests of the one repository, `payments-core`, as the list endpoint returns them. */
  pullRequests: Rec[];
  /** How many batches of the reporting feed were asked for. */
  feedRequests: number;
  /** The number of the board's first sprint: 1 as ado-seed names them, 44 once demo-week has renamed them. */
  firstSprint: number;
  fetch: typeof fetch;
}

/** Revisions per batch of the fake feed, small enough that a seeded board needs several. */
const FEED_BATCH = 7;

export function adoBoard(): Board {
  const items = new Map<number, Item>();
  let next = 2;
  const board: Board = { items, feedRequests: 0, requests: [], writes: [], refuseBypass: false, others: () => 0, pullRequests: [], firstSprint: 1, fetch: undefined as never };
  const url = (id: number) => `${ORG}/_apis/wit/workItems/${id}`;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fail = (status: number, message: string) => json({ message, typeKey: 'Error' }, status);
  const view = (item: Item, expand = true) => ({ id: item.id, rev: item.rev, fields: { ...item.fields }, ...(expand ? { relations: item.relations.map((r) => ({ ...r })) } : {}), url: url(item.id), _links: { html: { href: `${ORG}/${encodeURIComponent(PROJECT)}/_workitems/edit/${item.id}` } } });
  const snapshot = (item: Item) => item.revisions.push({ id: item.id, rev: item.rev, fields: { ...item.fields } });

  /** Applies a patch; returns an error Response or null. */
  function patch(item: Item, ops: Rec[], bypass: boolean, isNew: boolean): Response | null {
    let changed: string | null = null;
    for (const op of ops) {
      if (op.op !== 'add' && op.op !== 'test') return fail(400, `Unsupported op ${op.op}`);
      if (op.path === '/relations/-') {
        const target = items.get(Number(String(op.value.url).match(/(\d+)$/)![1]));
        if (!target || target.deleted) return fail(400, 'The link target does not exist.');
        item.relations.push({ rel: op.value.rel, url: op.value.url, attributes: { name: NAMES[op.value.rel] ?? op.value.rel } });
        target.relations.push({ rel: REVERSE[op.value.rel]!, url: url(item.id), attributes: { name: NAMES[REVERSE[op.value.rel]!] } });
        // The other end gets a revision of its own, dated now.
        target.rev++;
        target.fields['System.ChangedDate'] = NOW;
        snapshot(target);
        continue;
      }
      const field = String(op.path).replace('/fields/', '');
      if ((field === 'System.ChangedDate' || field === 'System.CreatedDate') && !bypass) return fail(400, `TF401326: ${field} is read-only unless you bypass rules.`);
      if (field === 'System.ChangedDate') changed = op.value;
      item.fields[field] = op.value;
    }
    const at = changed ?? NOW;
    const last = item.revisions.at(-1)?.fields['System.ChangedDate'];
    if (last && Date.parse(at) < Date.parse(last)) return fail(400, `TF401320: The specified ChangedDate ${at} is earlier than the last revision's ${last}.`);
    item.fields['System.ChangedDate'] = at;
    if (isNew && !item.fields['System.CreatedDate']) item.fields['System.CreatedDate'] = at;
    if (!bypass && item.fields['System.State'] === 'Done' && !item.fields['Microsoft.VSTS.Common.ClosedDate']) item.fields['Microsoft.VSTS.Common.ClosedDate'] = at;
    if (!isNew) item.rev++;
    snapshot(item);
    return null;
  }

  board.others = (fields) => {
    const item: Item = { id: next++, rev: 1, fields: { 'System.TeamProject': PROJECT, 'System.ChangedDate': '2026-01-01T00:00:00Z', ...fields }, relations: [], revisions: [], deleted: false };
    snapshot(item);
    items.set(item.id, item);
    return item.id;
  };

  board.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const raw = init?.body !== undefined && init.body !== null ? String(init.body) : input instanceof Request ? await input.text() : '';
    const body = raw ? JSON.parse(raw) : undefined;
    const path = decodeURIComponent(u.pathname.replace(new URL(ORG).pathname, ''));
    board.requests.push(`${method} ${path}${u.search}`);
    if (method !== 'GET' && !path.endsWith('/wiql') && !path.endsWith('/workitemsbatch')) board.writes.push(`${method} ${path}`);
    const p = `/${PROJECT}`;
    const bypass = u.searchParams.get('bypassRules') === 'true';
    if (bypass && board.refuseBypass) return fail(403, 'TF237111: The current user does not have permissions to bypass rules.');
    if (method === 'GET' && path === '/_apis/connectionData') return json({ authenticatedUser: { id: 'abc12345-0000-0000-0000-000000000000', providerDisplayName: 'You', properties: { Account: { $type: 'System.String', $value: 'you@example.com' } } } });
    if (method === 'GET' && path === `/_apis/projects/${PROJECT}`) return json({ id: 'abc12345-0000-0000-0000-000000000001', name: PROJECT });
    if (method === 'GET' && path === `${p}/_apis/wit/tags`) return json({ count: 0, value: [] });
    if (method === 'GET' && path === `${p}/_apis/wit/classificationnodes/iterations`) {
      const sprint = (n: number) => ({ id: n + 2, identifier: `abc12345-0000-0000-0000-00000000000${n}`, name: `Sprint ${n}`, structureType: 'iteration', hasChildren: false, path: `\\${PROJECT}\\Iteration\\Sprint ${n}` });
      return json({ id: 1, identifier: 'abc12345-0000-0000-0000-000000000009', name: PROJECT, structureType: 'iteration', hasChildren: true, path: `\\${PROJECT}\\Iteration`, children: [0, 1, 2].map((k) => sprint(board.firstSprint + k)) });
    }
    if (method === 'POST' && path === `${p}/_apis/wit/wiql`) {
      const query = String(body.query);
      const live = [...items.values()].filter((i) => !i.deleted && i.fields['System.TeamProject'] === PROJECT);
      const match = query.includes("[System.Tags] CONTAINS 'toil-seed'") ? live.filter((i) => String(i.fields['System.Tags'] ?? '').toLowerCase().includes('toil-seed')) : query.includes('[System.Title] CONTAINS') ? live.filter((i) => String(i.fields['System.Title']).includes('[toil-seed]')) : live;
      return json({ queryType: 'flat', workItems: match.sort((a, b) => a.id - b.id).map((i) => ({ id: i.id, url: url(i.id) })) });
    }
    if (method === 'POST' && path === '/_apis/wit/workitemsbatch') {
      return json({ count: 0, value: (body.ids as number[]).map((id) => items.get(id)).filter((i): i is Item => !!i && !i.deleted).map((i) => view(i)) });
    }
    const create = new RegExp(`^${p}/_apis/wit/workitems/\\$(.+)$`).exec(path);
    if (method === 'POST' && create) {
      const item: Item = { id: next++, rev: 1, fields: { 'System.TeamProject': PROJECT, 'System.WorkItemType': create[1], 'System.CreatedBy': { displayName: 'You', uniqueName: 'you@example.com' } }, relations: [], revisions: [], deleted: false };
      const error = patch(item, body, bypass, true);
      if (error) return error;
      items.set(item.id, item);
      return json(view(item));
    }
    const one = /^\/_apis\/wit\/workitems\/(\d+)$/i.exec(path);
    if (method === 'PATCH' && one) {
      const item = items.get(Number(one[1]));
      if (!item || item.deleted) return fail(404, `TF401232: Work item ${one[1]} does not exist.`);
      const error = patch(item, body, bypass, false);
      return error ?? json(view(item));
    }
    const del = new RegExp(`^${p}/_apis/wit/workitems/(\\d+)$`, 'i').exec(path);
    if (method === 'DELETE' && del) {
      const item = items.get(Number(del[1]))!;
      item.deleted = true;
      return json({ id: item.id, code: 200 });
    }
    // The reporting feed: every revision of every item after startDateTime, in batches of FEED_BATCH with a continuation token,
    // people as "Name <unique name>" text. The token is the offset into the whole feed, which is as honest as a fake gets.
    if (method === 'GET' && path === `${p}/_apis/wit/reporting/workitemrevisions`) {
      const since = u.searchParams.get('startDateTime');
      if (since && u.searchParams.has('continuationToken')) return fail(400, 'VS402337: startDateTime cannot be used with a continuationToken.');
      const text = (who: unknown) => (typeof who === 'object' && who !== null && 'displayName' in who && 'uniqueName' in who ? `${(who as Rec).displayName} <${(who as Rec).uniqueName}>` : who);
      const all = [...items.values()].filter((i) => !i.deleted).flatMap((i) => i.revisions)
        .filter((r) => !since || Date.parse(String(r.fields['System.ChangedDate'])) > Date.parse(since))
        .sort((a, b) => Date.parse(String(a.fields['System.ChangedDate'])) - Date.parse(String(b.fields['System.ChangedDate'])) || a.id - b.id);
      const start = Number(u.searchParams.get('continuationToken') ?? 0);
      const values = all.slice(start, start + FEED_BATCH).map((r) => ({ id: r.id, rev: r.rev, fields: { 'System.Id': r.id, 'System.Rev': r.rev, ...Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, k === 'System.ChangedBy' || k === 'System.CreatedBy' ? text(v) : v])) } }));
      board.feedRequests++;
      return json({ values, continuationToken: String(start + values.length), isLastBatch: start + FEED_BATCH >= all.length });
    }
    const revisions = /^\/_apis\/wit\/workItems\/(\d+)\/revisions$/i.exec(path);
    if (method === 'GET' && revisions) {
      const item = items.get(Number(revisions[1]));
      if (!item || item.deleted) return fail(404, `TF401232: Work item ${revisions[1]} does not exist.`);
      const skip = Number(u.searchParams.get('$skip') ?? 0);
      const top = Number(u.searchParams.get('$top') ?? 200);
      return json({ count: item.revisions.length, value: item.revisions.slice(skip, skip + top) });
    }
    if (method === 'GET' && path === `${p}/_apis/git/repositories/payments-core/pullrequests`) {
      const status = u.searchParams.get('searchCriteria.status');
      const skip = Number(u.searchParams.get('$skip') ?? 0);
      const shown = board.pullRequests.filter((pr) => status === 'all' || pr.status === status);
      return json({ count: shown.length, value: shown.slice(skip, skip + Number(u.searchParams.get('$top') ?? 100)) });
    }
    // One pull request, and what pr get --include reads beside it: no threads, statuses or commits yet, one iteration with no changes.
    const pull = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/_apis/git/repositories/payments-core/pullrequests/(\\d+)(/[a-z/0-9]+)?$`, 'i').exec(path);
    if (method === 'GET' && pull) {
      const pr = board.pullRequests.find((x) => x.pullRequestId === Number(pull[1]));
      if (!pr) return fail(404, `TF401180: The requested pull request was not found.`);
      const rest = (pull[2] ?? '').toLowerCase();
      if (rest === '') return json(pr);
      if (rest === '/iterations') return json({ count: 1, value: [{ id: 1 }] });
      if (rest === '/iterations/1/changes') return json({ changeEntries: [] });
      if (['/threads', '/statuses', '/commits'].includes(rest)) return json({ count: 0, value: [] });
    }
    throw new Error(`No Azure DevOps route for ${method} ${u.href}`);
  }) as typeof fetch;
  return board;
}
