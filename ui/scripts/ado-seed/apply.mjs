// Creates the work items in items.owi.json on an Azure DevOps Services board,
// in an existing project and its existing sprints, and nothing else:
//
//   node ui/scripts/ado-seed/apply.mjs --project "<project>" --dry-run   # what it would do; sends no write
//   node ui/scripts/ado-seed/apply.mjs --project "<project>"
//   node ui/scripts/ado-seed/apply.mjs --project "<project>" --no-backdate --identity marker
//
// The organization and token come from TOIL_ADO_BASE_URL and
// TOIL_ADO_PAT; the project must be named. Run it again and it creates
// only what is missing: each item is found by its seed key (ado.mjs says
// how), and one left half-made by an earlier run is walked on to its last
// state and sprint. Links already there are left alone.
//
// In order:
//   1. Read and check items.owi.json against the OWI schema.
//   2. Check the project, and that every sprint the file names exists. A
//      missing sprint stops the run; sprints are never created.
//   3. Create each missing item in its first state, in the backlog, then make
//      each move on its timeline as its own revision. With --no-backdate, or
//      when the server refuses bypassRules, the moves are ordinary
//      transitions dated now, and the run says so; otherwise each revision is
//      dated with System.ChangedDate, and System.CreatedDate and ClosedDate
//      are set to match.
//   4. Add the parent, dependency and related links, last (ado.mjs says why).
//   5. Write the seed key → work item id map to ids.local.json beside this
//      file (git ignores it), and print counts by type and state.
//
// Only work items are created or changed, only ones this script recognises
// as its own, and no one but the token's identity is ever assigned. Repo
// tooling only: nothing here ships. It files the paperwork it was written to
// test, which seemed fair.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { check, DEFAULT_OUT } from './generate.mjs';
import { client, connectionFromEnv, createPatch, findSeeded, IDENTITIES, keyOf, missingLinks, projectPath, remainingStates, SeedError, statesOf } from './ado.mjs';

export const MAP_FILE = join(import.meta.dirname, 'ids.local.json');
const add = (field, value) => ({ op: 'add', path: `/fields/${field}`, value });
const native = (record) => record.native['ado-seed generate'];

/**
 * The reason the Scrum process records on reaching each state, read from a
 * live organization with its rules on. With bypassRules nothing records one,
 * so a backdated walk sets it; an ordinary transition gets it from the server.
 */
export const REASONS = {
  Approved: 'Approved by the Product Owner',
  Committed: 'Commitment made by the team',
  'In Progress': { Task: 'Work started', default: 'Implementation started' },
  Done: 'Work finished',
  Removed: 'Removed from the backlog',
};
const reasonFor = (state, typeName) => {
  const r = REASONS[state];
  return typeof r === 'object' ? (r[typeName] ?? r.default) : r;
};
const STARTED = new Set(['Committed', 'In Progress']);

/** Parents before children, so a child's parent always exists when the links go on. */
export function inOrder(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = [];
  const seen = new Set();
  const visit = (item) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    if (item.parent && byId.has(item.parent)) visit(byId.get(item.parent));
    out.push(item);
  };
  items.forEach(visit);
  return out;
}

/** Whether a refusal is the server saying the token may not bypass rules, as opposed to anything else. */
const bypassRefused = (error) => error instanceof SeedError && /bypass/i.test(error.message) && /\b(400|403)\b/.test(error.message);

/** The sprint paths a file names, as `@project\…` paths. */
const sprintsOf = (items) => [...new Set(items.flatMap((i) => native(i).timeline.map((e) => e.iteration).filter((p) => p && p !== '@project')))];

/**
 * How far the board's sprint numbers sit from the file's: 0 while the board has a
 * Sprint 1 (or no numbered sprints at all), else its lowest Sprint n minus 1.
 */
export function sprintOffset(paths, project) {
  const prefix = `${project.toLowerCase()}\\sprint `;
  const numbers = [...paths].filter((p) => p.startsWith(prefix)).map((p) => Number(p.slice(prefix.length))).filter((n) => Number.isInteger(n) && n > 0);
  if (!numbers.length || numbers.includes(1)) return 0;
  return Math.min(...numbers) - 1;
}

/** Every iteration path in the project's tree, lower-cased, as System.IterationPath writes it. */
function iterationPaths(tree) {
  const out = new Set();
  const walk = (node) => {
    if (typeof node?.path === 'string') {
      const parts = node.path.replace(/^\\+/, '').split('\\');
      if (parts[1]?.toLowerCase() === 'iteration') parts.splice(1, 1);
      out.add(parts.join('\\').toLowerCase());
    }
    for (const child of node?.children ?? []) walk(child);
  };
  walk(tree);
  return out;
}

/**
 * Seeds the board. `api` is ado.mjs's client; `log` gets one line per thing
 * done. Returns the id map and what happened.
 */
export async function apply({ items, api, identity = 'tags', dryRun = false, backdate = true, log = () => {}, now = () => Date.now() }) {
  const problems = check(items);
  if (problems.length) throw new SeedError(`The OWI file has ${problems.length} problems:\n  ${problems.join('\n  ')}`, 'Run node ui/scripts/ado-seed/generate.mjs to write it again.');
  const project = api.project;
  const info = await api.projectInfo();
  if (info?.name !== project) throw new SeedError(`The organization has no project named "${project}" (it answered "${info?.name}").`, 'Pass --project exactly as the project is named.');
  const paths = iterationPaths(await api.iterations());
  // demo-week.mjs renames the board's Sprint 1, 2, … to the demo's own numbers
  // (Sprint 44, 45, …), keeping their order. With no Sprint 1 left, the file's
  // Sprint n is the board's lowest-numbered sprint plus n - 1.
  const offset = sprintOffset(paths, project);
  const sprintPath = (p) => projectPath(p, project).replace(/\\Sprint (\d+)$/i, (_, n) => `\\Sprint ${Number(n) + offset}`);
  const missing = sprintsOf(items).filter((p) => !paths.has(sprintPath(p).toLowerCase()));
  if (missing.length) throw new SeedError(`The project has no ${missing.map((p) => sprintPath(p)).join(', ')}.`, 'Create the sprints in the project yourself, or regenerate items.owi.json without them; this script never creates iterations. If demo-week.mjs renamed the sprints and stopped part-way, run it again to finish the rename first.');
  if (offset) log(`The board's sprints are renumbered: the file's Sprint 1 is its Sprint ${1 + offset}.`);
  const latest = Math.max(...items.flatMap((i) => native(i).timeline.map((e) => Date.parse(e.at))));
  if (backdate && latest > now()) throw new SeedError(`The timeline reaches ${new Date(latest).toISOString()}, which is in the future.`, 'Run with --no-backdate, or regenerate items.owi.json with a later ANCHOR.');
  const me = items.some((i) => i.assignee) ? await api.me() : null;
  const existingTags = identity === 'marker' ? new Set((await api.tags()).map((t) => t.toLowerCase())) : new Set();
  const { seeded, refused } = await findSeeded(api, identity);
  if (refused.length) log(`Left alone: ${refused.length} work item(s) the query matched that aren't this seed's (${refused.join(', ')}).`);
  const ids = new Map([...seeded].map(([key, item]) => [key, item.id]));
  const known = new Map(seeded);
  const result = { created: [], repaired: [], linked: [], backdated: backdate, skippedTags: new Set() };

  for (const record of inOrder(items)) {
    const key = keyOf(record.id);
    const timeline = native(record).timeline;
    const last = { state: statesOf(record).at(-1), iteration: sprintPath(timeline.filter((e) => e.iteration).at(-1).iteration) };
    const existing = known.get(key);
    if (existing) {
      // Made by an earlier run: walk it on if that run stopped part-way. These moves are dated now.
      const state = existing.fields?.['System.State'];
      const rest = remainingStates(record, state);
      // A state the walk never passes (someone moved it by hand) goes straight to the last one.
      const steps = (rest === null ? [last.state] : rest).map((s) => [add('System.State', s)]);
      if (existing.fields?.['System.IterationPath'] !== last.iteration) steps.push([add('System.IterationPath', last.iteration)]);
      if (!steps.length) continue;
      log(`${dryRun ? 'Would walk on' : 'Walking on'} ${key} (#${existing.id}) from ${state}: ${steps.map((s) => s[0].value).join(' → ')}`);
      if (!dryRun) for (const step of steps) await api.update(existing.id, step);
      result.repaired.push(key);
      continue;
    }
    const { ops, skippedTags } = createPatch(record, { project, identity, me, existingTags });
    for (const t of skippedTags) result.skippedTags.add(t);
    if (dryRun) {
      log(`Would create ${record.typeName} ${key}: ${record.title.slice(0, 70)} (${statesOf(record).join(' → ')}, ${last.iteration})`);
      result.created.push(key);
      continue;
    }
    const dated = (at) => (result.backdated ? [add('System.ChangedDate', at)] : []);
    let item;
    try {
      item = await api.create(record.typeName, [...ops, ...(result.backdated ? [add('System.CreatedDate', timeline[0].at), add('Microsoft.VSTS.Common.StateChangeDate', timeline[0].at)] : []), ...dated(timeline[0].at)], result.backdated);
    } catch (error) {
      if (!result.backdated || !bypassRefused(error)) throw error;
      result.backdated = false;
      log(`The server refused bypassRules (${error.message}); every item from here on is seeded with ordinary transitions dated now, not backdated.`);
      item = await api.create(record.typeName, ops, false);
    }
    ids.set(key, item.id);
    let activated = false;
    for (const event of timeline.slice(1)) {
      // With the rules bypassed, nothing stamps the reason or the state's dates, so the walk sets them as the process would.
      const stamps = !result.backdated || !event.state ? [] : [
        add('System.Reason', reasonFor(event.state, record.typeName)),
        add('Microsoft.VSTS.Common.StateChangeDate', event.at),
        ...(STARTED.has(event.state) && !activated ? [add('Microsoft.VSTS.Common.ActivatedDate', event.at)] : []),
        ...(event.state === 'Done' ? [add('Microsoft.VSTS.Common.ClosedDate', event.at)] : []),
      ];
      if (event.state && STARTED.has(event.state)) activated = true;
      const step = [
        ...(event.state ? [add('System.State', event.state)] : []),
        ...(event.iteration ? [add('System.IterationPath', sprintPath(event.iteration))] : []),
        ...dated(event.at),
        ...stamps,
      ];
      item = await api.update(item.id, step, result.backdated);
    }
    known.set(key, item);
    result.created.push(key);
    log(`Created ${record.typeName} ${key} as #${item.id}: ${statesOf(record).join(' → ')}`);
  }

  // Links last, on the items as they now stand.
  if (!dryRun) {
    const current = new Map((await api.getMany([...ids.values()])).map((i) => [i.id, i]));
    for (const record of items) {
      const id = ids.get(keyOf(record.id));
      const ops = missingLinks(record, current.get(id) ?? { relations: [] }, (k) => ids.get(k), api.workItemUrl);
      if (!ops.length) continue;
      await api.update(id, ops, false);
      result.linked.push(keyOf(record.id));
    }
    if (result.linked.length) log(`Linked ${result.linked.length} item(s): parents, dependencies and related pairs.`);
  }
  if (result.skippedTags.size) log(`Tags left off because they don't exist in the project and this identity mode never creates one: ${[...result.skippedTags].join(', ')}.`);
  return { ids, ...result };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name) && Boolean(args.splice(args.indexOf(name), 1));
  const take = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] : fallback;
  };
  const dryRun = flag('--dry-run');
  const backdate = !flag('--no-backdate');
  const project = take('--project');
  const identity = take('--identity', 'tags');
  const file = resolve(take('--file', DEFAULT_OUT));
  const mapFile = resolve(take('--map', MAP_FILE));
  try {
    if (args.length) throw new SeedError(`Unknown argument: ${args.join(' ')}`, 'Use --project <name>, --dry-run, --no-backdate, --identity tags|marker, --file <owi.json> and --map <file>.');
    if (!project) throw new SeedError('No project named.', 'Pass --project "<project>": the seed never guesses which project to write to.');
    if (!IDENTITIES.includes(identity)) throw new SeedError(`--identity ${identity} isn't one of ${IDENTITIES.join(', ')}.`, 'Use --identity tags (the default) or --identity marker.');
    const items = JSON.parse(readFileSync(file, 'utf8')).items;
    const api = client({ ...connectionFromEnv(), project });
    const out = await apply({ items, api, identity, dryRun, backdate, log: (line) => process.stdout.write(`${line}\n`) });
    const byKey = new Map(items.map((i) => [keyOf(i.id), i]));
    const tally = (keys, f) => Object.entries(keys.reduce((m, k) => ({ ...m, [f(byKey.get(k))]: (m[f(byKey.get(k))] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    const all = [...out.ids.keys()];
    if (!dryRun) writeFileSync(mapFile, `${JSON.stringify({ identity, project, backdated: out.backdated, items: Object.fromEntries([...out.ids].sort()) }, null, 2)}\n`);
    process.stdout.write(
      `\n${dryRun ? 'Dry run, nothing sent: would create' : 'Created'} ${out.created.length}, ${dryRun ? 'would walk on' : 'walked on'} ${out.repaired.length}, linked ${out.linked.length}; ${all.length + (dryRun ? out.created.length : 0)} seeded in all.\n` +
        `  created by type: ${tally(out.created, (i) => i.typeName)}\n  created by state: ${tally(out.created, (i) => i.status)}\n` +
        (dryRun ? '' : `  ${out.backdated ? 'Backdated with bypassRules.' : 'Not backdated: every revision is dated today.'}\n  Map: ${mapFile}\n`),
    );
  } catch (error) {
    process.stderr.write(`apply: ${error.message}\n  Fix: ${error.fix ?? 'See the message above.'}\n`);
    process.exit(1);
  }
}
