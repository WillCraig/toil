// Writes ui/scripts/ado-seed/items.owi.json: about 45 made-up work items for an
// Azure DevOps Services board (Scrum process), as Open Work Item 0.1 records,
// spread across the three sample toil projects' products (card-payments, settlement,
// checkout-web). The choices are random but seeded, so the same seed always
// writes the same file:
//
//   node ui/scripts/ado-seed/generate.mjs              # seed 319, the committed file
//   node ui/scripts/ado-seed/generate.mjs --seed 7 --out <file>
//   node ui/scripts/ado-seed/generate.mjs --check      # fail if the committed file is stale
//
// Every record is checked against docs/owi/schema.json before it is written.
// apply.mjs creates the items from this file; cleanup.mjs removes them again.
//
// What a record holds before the board has seen it:
//   - id is `toil-seed:<key>`, a connection name that is no real connection, and
//     parent, children and links point at other seed ids. apply.mjs keeps the
//     key on the work item it creates, and the id map it writes is how the two
//     are joined again.
//   - `@project` stands for the project, which is given to apply.mjs and is
//     never written here: the backlog is the iteration `@project`, a sprint
//     `@project\Sprint 1`. The sprints must exist; nothing here creates them.
//   - An assignee of `@Me` (WIQL's own macro) is the token's identity. No one
//     else is ever assigned.
//   - url, reporter, the dates and the history are the server's to give, so
//     they are null here; the timeline below is what apply.mjs asks it for.
//   - native["ado-seed generate"] carries what OWI has no field for: the type's
//     own extra fields (acceptance criteria, repro steps, severity, remaining
//     work), and its timeline: when it was created, and each state and sprint
//     it moved to on the way to its last one, drawn back from a fixed day
//     (ANCHOR) so the file doesn't change with the date it is generated on.
//
// Repo tooling only: nothing here ships. The roadmap was decided by a random
// number generator, which is at least a documented process.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Validator } from '@cfworker/json-schema';

const here = import.meta.dirname;
const root = resolve(here, '..', '..', '..');
export const DEFAULT_SEED = 319;
export const DEFAULT_OUT = join(here, 'items.owi.json');
/** The connection part of every seed id. */
export const SEED_CONNECTION = 'toil-seed';
/** The tag every seeded item carries. */
export const SEED_TAG = 'toil-seed';
export const COMMAND = 'ado-seed generate';
export const PROJECT = '@project';
export const ME = '@Me';

/** mulberry32: a small seeded generator, so a seed means the same file on every machine and Node version. */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The three products, in the samples' voice. Each pool is larger than what is drawn from it. */
const PRODUCTS = [
  {
    tag: 'card-payments',
    code: 'cp',
    epics: ['Card payments v2', 'Tokenised cards at the edge'],
    features: ['Tokenisation service', 'Stored-card charges', 'Gateway hardening'],
    pbis: [
      'Tokenise card numbers at the edge',
      'Store tokens in the vault with a 13-month expiry',
      'Charge a stored token',
      'Mask card numbers in the gateway logs',
      'Look up the card scheme from the BIN',
      'Retry declined charges once, with the original idempotency key',
      'Rotate the vault data-encryption key without downtime',
    ],
    tasks: [
      'Add the tokeniser to the gateway config',
      "Write the vault client's retry policy",
      'Load-test the tokeniser at 2,000 requests a second',
      'Document the token format for the merchant SDK team',
      'Wire the BIN table refresh into the nightly job',
    ],
    bugs: [
      'A double click charges twice',
      'Tokeniser returns 500 for Maestro cards with 19 digits',
      'Gateway logs the CVV on a timeout',
      'Expiry month 12 is read as December of the previous year',
      'Retry storm after a scheme outage',
      "Stored-card charge ignores the merchant's currency",
    ],
    topics: ['pci', 'vault', 'gateway'],
  },
  {
    tag: 'settlement',
    code: 'st',
    epics: ['Settlement reports', 'Daily settlement for finance'],
    features: ['Daily settlement export', 'Chargeback reconciliation', 'Merchant payout statements'],
    pbis: [
      'Read settlement batches from the ledger',
      'Export the daily settlement CSV',
      'Email the settlement report to finance',
      'Group settlements by merchant',
      'Reconcile chargebacks against settlements',
      'Show fees and interchange separately on the payout statement',
      "Hold a merchant's payout when the chargeback ratio passes the threshold",
    ],
    tasks: [
      'Schedule the export job',
      'Add the ledger read replica to the connection pool',
      'Write the CSV column mapping for finance',
      'Backfill three months of settlement batches',
      'Alert when the export finishes after 06:00',
    ],
    bugs: [
      'Batch totals ignore refunds',
      'Settlement totals are a day early in UTC-5',
      'CSV export splits merchant names that contain commas',
      'Payout statement rounds each line, not the total',
      'Report email goes out twice on the first of the month',
      "Chargebacks in a second currency are counted at today's rate",
    ],
    topics: ['refunds', 'timezones', 'finance'],
  },
  {
    tag: 'checkout-web',
    code: 'cw',
    epics: ['Checkout accepts saved cards', 'Checkout redesign'],
    features: ['Saved-card picker', '3-D Secure challenge flow', 'Receipts and confirmation'],
    pbis: [
      'Saved-card picker component',
      'Show card brand icons',
      'End-to-end test for 3-D Secure',
      'Show the last four digits on receipts',
      'Let shoppers remove a saved card',
      'Explain a declined payment in plain words, with what to try next',
      'Keep the basket when the 3-D Secure challenge times out',
    ],
    tasks: [
      'Add the card brand icon set',
      'Write the Playwright journey for a frictionless 3-D Secure pass',
      'Add aria labels to the card form',
      'Measure the checkout bundle size',
      'Translate the decline messages',
    ],
    bugs: [
      'Pay button stays disabled after an error',
      'Card form loses focus on Safari',
      'Receipt page shows the wrong currency symbol',
      'Saved-card picker shows expired cards first',
      '3-D Secure iframe is cut off at 375 px',
      'Back button after payment shows the card form again',
    ],
    topics: ['safari', 'accessibility', 'ui'],
  },
];

/** A clause that makes a title long, for testing how every view wraps one. */
const LONG = [
  ', so that merchants on the legacy plan, the new plan and the pilot plan all see the same figures on the same day',
  ', including the edge cases finance listed in the review: partial refunds, split tenders, reversed chargebacks and a merchant that changes currency mid-month',
  ', without changing what the merchant API returns to integrations that were built against the 2024 contract',
];

/** Each Scrum type's states in the order work moves through them, and its first state. */
export const FLOW = {
  Epic: ['New', 'In Progress', 'Done'],
  Feature: ['New', 'In Progress', 'Done'],
  'Product Backlog Item': ['New', 'Approved', 'Committed', 'Done'],
  Bug: ['New', 'Approved', 'Committed', 'Done'],
  Task: ['To Do', 'In Progress', 'Done'],
};
const OWI_TYPE = { Epic: 'EPIC', Feature: 'OTHER', 'Product Backlog Item': 'STORY', Bug: 'BUG', Task: 'TASK' };
const CATEGORY = { New: 'TODO', 'To Do': 'TODO', Approved: 'TODO', Committed: 'IN_PROGRESS', 'In Progress': 'IN_PROGRESS', Done: 'DONE', Removed: 'DONE' };

/** The day the timelines are drawn back from: every event is at or before it. Today's date when the committed file was made. */
export const ANCHOR = '2026-10-19T09:00:00.000Z';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * When each item was created and when it moved, as days before ANCHOR:
 * leaves (PBIs, bugs, tasks) first, then each feature and epic from its
 * children. Sprint 1 was planned a week before the anchor, Sprints 2 and 3
 * two days before; a few Sprint 1 items were added mid-sprint. apply.mjs
 * replays these as revisions dated with System.ChangedDate when the server
 * lets it (bypassRules), and as ordinary transitions, dated today, when not.
 */
function timelines(items, rnd) {
  const anchor = Date.parse(ANCHOR);
  const between = (lo, hi) => lo + rnd() * (hi - lo);
  const at = (days) => Math.round((anchor + days * DAY) / MINUTE) * MINUTE;
  const byKey = new Map(items.map((r) => [r.key, r]));
  const leaf = (r) => {
    const flow = pathTo(r.typeName, r.state, r.removedFrom);
    const sprint = r.iteration === null ? null : `${PROJECT}\\${r.iteration}`;
    const parent = r.parent ? byKey.get(r.parent) : null;
    if (r.stale) {
      const created = at(between(-62, -55));
      r.timeline = [{ at: created, state: flow[0], iteration: PROJECT }, ...flow.slice(1).map((state, i) => ({ at: created + (i + 1) * between(2, 6) * DAY, state }))];
      return;
    }
    const plan = r.iteration === 'Sprint 1' ? at(rnd() < 0.2 ? between(-3.5, -2.5) : between(-7, -6.8)) : r.iteration ? at(between(-2.2, -1.8)) : null;
    let created = parent?.timeline ? parent.timeline[0].at + between(0.3, 3) * DAY : at(between(-45, -12));
    if (plan !== null && created > plan - DAY) created = plan - between(1, 3) * DAY;
    const events = [{ at: created, state: flow[0], iteration: PROJECT }];
    let t = created;
    let moved = plan === null;
    for (const state of flow.slice(1)) {
      if (state === 'Approved') t = plan === null ? t + between(1, 6) * DAY : between(t, plan);
      else if (state === 'Removed') t += between(2, 10) * DAY;
      else if (state === 'Done') t = Math.max(t, plan ?? t) + between(1, 4) * DAY;
      else t = Math.max(t, plan ?? t) + between(0, 2) * DAY;
      if (!moved && t >= plan) {
        events.push({ at: plan, iteration: sprint });
        moved = true;
      }
      events.push({ at: t, state });
    }
    if (!moved) events.push({ at: plan, iteration: sprint });
    r.timeline = events;
  };
  const rollUp = (r) => {
    const kids = items.filter((k) => k.parent === r.key);
    const kidEvents = kids.flatMap((k) => k.timeline);
    const first = kids.length ? Math.min(...kids.map((k) => k.timeline[0].at)) : at(between(-50, -40));
    const created = first - between(1, 4) * DAY;
    const events = [{ at: created, state: 'New', iteration: PROJECT }];
    const started = kidEvents.filter((e) => e.state && ['Committed', 'In Progress', 'Done'].includes(e.state)).map((e) => e.at);
    if (r.state !== 'New') events.push({ at: Math.min(...started) + 5 * MINUTE, state: 'In Progress' });
    if (r.state === 'Done') events.push({ at: Math.max(...kidEvents.filter((e) => e.state === 'Done').map((e) => e.at)) + 30 * MINUTE, state: 'Done' });
    r.timeline = events;
  };
  for (const r of items) if (!['Epic', 'Feature'].includes(r.typeName)) {
    // A task's parent PBI is drawn before it, so its creation is known.
    leaf(r);
  }
  for (const r of items) if (r.typeName === 'Feature') rollUp(r);
  for (const r of items) if (r.typeName === 'Epic') rollUp(r);
  // In order, at least a minute apart, never after the anchor, as ISO instants.
  for (const r of items) {
    r.timeline.sort((a, b) => a.at - b.at);
    let last = -Infinity;
    for (const e of r.timeline) {
      e.at = Math.min(Math.max(Math.round(e.at / MINUTE) * MINUTE, last + MINUTE), anchor);
      last = e.at;
    }
    r.timeline = r.timeline.map((e) => ({ ...e, at: new Date(e.at).toISOString() }));
  }
}

/** The states an item passes through to reach `last`, from its type's first state. Removed is reached from wherever it was. */
export function pathTo(typeName, last, removedFrom) {
  const flow = FLOW[typeName];
  if (last === 'Removed') return [...flow.slice(0, flow.indexOf(removedFrom ?? flow[0]) + 1), 'Removed'];
  return flow.slice(0, flow.indexOf(last) + 1);
}

export function generate(seed = DEFAULT_SEED) {
  const rnd = random(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const chance = (p) => rnd() < p;
  const weighted = (pairs) => {
    let r = rnd() * pairs.reduce((n, [, w]) => n + w, 0);
    for (const [value, w] of pairs) if ((r -= w) < 0) return value;
    return pairs[pairs.length - 1][0];
  };
  const draw = (list, n) => {
    const pool = [...list];
    const out = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
    return out;
  };
  const priority = () => String(weighted([[1, 15], [2, 45], [3, 30], [4, 10]]));
  const items = [];
  const byKey = new Map();
  const add = (product, kind, n, typeName, title, extra) => {
    const key = `${product.code}-${kind}-${n}`;
    const record = { key, product: product.tag, typeName, title, ...extra };
    items.push(record);
    byKey.set(key, record);
    return record;
  };

  // A feature or epic is as far along as its children.
  const rollUp = (record) => {
    const kids = items.filter((r) => r.parent === record.key && r.state !== 'Removed');
    if (kids.length && kids.every((k) => k.state === 'Done')) return 'Done';
    if (kids.some((k) => ['Committed', 'In Progress', 'Done'].includes(k.state))) return 'In Progress';
    return 'New';
  };
  for (const product of PRODUCTS) {
    const [epicTitle] = draw(product.epics, 1);
    const epic = add(product, 'epic', 1, 'Epic', epicTitle, { iteration: null, parent: null, priority: priority(), effort: null });
    const features = draw(product.features, 2).map((title, i) => add(product, 'feature', i + 1, 'Feature', title, { iteration: null, parent: epic.key, priority: priority(), effort: null }));
    const pbis = draw(product.pbis, 5).map((title, i) => {
      const iteration = weighted([['Sprint 1', 45], ['Sprint 2', 20], ['Sprint 3', 10], [null, 25]]);
      const state =
        iteration === 'Sprint 1' ? weighted([['Done', 40], ['Committed', 40], ['Approved', 20]])
        : iteration === 'Sprint 2' ? weighted([['Approved', 60], ['New', 30], ['Committed', 10]])
        : iteration === 'Sprint 3' ? weighted([['New', 60], ['Approved', 40]])
        : weighted([['New', 55], ['Approved', 25], ['Removed', 20]]);
      return add(product, 'pbi', i + 1, 'Product Backlog Item', title, {
        iteration,
        state,
        parent: pick(features).key,
        priority: priority(),
        effort: chance(0.25) ? null : pick([1, 2, 3, 5, 8, 13]),
        acceptance: chance(0.6),
      });
    });
    draw(product.tasks, 3).forEach((title, i) => {
      const parent = pick(pbis.filter((p) => p.state !== 'Removed'));
      const state = parent.state === 'Done' ? 'Done' : parent.state === 'Committed' ? pick(['To Do', 'In Progress', 'Done']) : 'To Do';
      add(product, 'task', i + 1, 'Task', title, { iteration: parent.iteration, state, parent: parent.key, priority: priority(), effort: null, remaining: state === 'Done' ? 0 : pick([2, 4, 6, 8]) });
    });
    draw(product.bugs, 4).forEach((title, i) => {
      const iteration = weighted([['Sprint 1', 50], ['Sprint 2', 15], [null, 35]]);
      const state =
        iteration === 'Sprint 1' ? weighted([['Committed', 45], ['Done', 35], ['Approved', 20]])
        : iteration === 'Sprint 2' ? weighted([['Approved', 70], ['New', 30]])
        : weighted([['New', 60], ['Approved', 20], ['Removed', 20]]);
      add(product, 'bug', i + 1, 'Bug', title, {
        iteration,
        state,
        // Some bugs belong to a feature; the rest are orphans, the way bugs arrive.
        parent: chance(0.5) ? pick(features).key : null,
        priority: priority(),
        effort: chance(0.4) ? null : pick([1, 2, 3, 5]),
        severity: pick(['1 - Critical', '2 - High', '3 - Medium', '3 - Medium', '4 - Low']),
        acceptance: chance(0.3),
      });
    });
    for (const f of features) f.state = rollUp(f);
    epic.state = rollUp(epic);
  }

  // Three long titles, wherever they land.
  for (const record of draw(items.filter((r) => r.typeName !== 'Epic'), 3)) record.title += LONG[items.indexOf(record) % LONG.length];

  // Dependencies: two chains inside each product, two across products, and some related pairs.
  const open = (product) => items.filter((r) => r.product === product && ['Product Backlog Item', 'Bug'].includes(r.typeName) && r.state !== 'Removed');
  const blocks = [];
  for (const product of PRODUCTS) {
    const [a, b, c] = draw(open(product.tag), 3);
    if (a && b) blocks.push([a.key, b.key]);
    if (b && c) blocks.push([b.key, c.key]);
  }
  blocks.push([pick(open('card-payments')).key, pick(open('checkout-web')).key]);
  blocks.push([pick(open('card-payments')).key, pick(open('settlement')).key]);
  const related = [];
  for (const product of PRODUCTS) {
    const bug = pick(items.filter((r) => r.product === product.tag && r.typeName === 'Bug'));
    const pbi = pick(items.filter((r) => r.product === product.tag && r.typeName === 'Product Backlog Item'));
    related.push([bug.key, pbi.key]);
  }

  // Who has picked it up: the token's own identity on some started or finished work, nobody otherwise.
  for (const r of items) r.assigned = ['Committed', 'In Progress', 'Done'].includes(r.state) && chance(0.7);
  // A topic tag on some, beside the product's.
  for (const r of items) r.topic = chance(0.3) ? pick(PRODUCTS.find((p) => p.tag === r.product).topics) : null;
  // Where a removed item was when it was removed.
  for (const r of items) if (r.state === 'Removed') r.removedFrom = pick(['New', 'Approved']);

  // Two stale items: backlog work nobody has touched in over a month. They have no
  // parent, no children and no links, because adding a link writes a revision on both ends today.
  const linked = new Set([...blocks, ...related].flat());
  const parents = new Set(items.map((r) => r.parent));
  for (const r of draw(items.filter((x) => x.iteration === null && ['New', 'Approved'].includes(x.state) && ['Product Backlog Item', 'Bug'].includes(x.typeName) && !linked.has(x.key) && !parents.has(x.key)), 2)) {
    r.stale = true;
    r.parent = null;
  }
  // Again, now that the stale items have left their features.
  for (const f of items.filter((r) => r.typeName === 'Feature')) f.state = rollUp(f);
  for (const e of items.filter((r) => r.typeName === 'Epic')) e.state = rollUp(e);
  timelines(items, rnd);

  return items.map((r) => owi(r, items, blocks, related));
}

const id = (key) => `${SEED_CONNECTION}:${key}`;
const iterationOf = (name) => (name === null ? { id: null, name: PROJECT, path: PROJECT, start: null, end: null, state: null } : { id: null, name, path: `${PROJECT}\\${name}`, start: null, end: null, state: null });
/** A title as the middle of a sentence: its first letter lower-cased, unless it starts with an acronym (BIN, CSV, 3-D). */
const inSentence = (title) => (/^[A-Z0-9][A-Z0-9-]/.test(title) ? title : title[0].toLowerCase() + title.slice(1));
const html = (...paragraphs) => paragraphs.map((p) => `<p>${p}</p>`).join('');

function description(r) {
  switch (r.typeName) {
    case 'Epic':
      return html(`The ${r.product} goal for this quarter: ${inSentence(r.title)}.`, 'Made-up work for testing toil; nothing here is a real plan.');
    case 'Feature':
      return html(`${r.title}, as one releasable piece of ${r.product}.`);
    case 'Bug':
      return html(`${r.title}. Seen in the ${r.product} test environment.`);
    case 'Task':
      return html(`${r.title}.`);
    default:
      return html(`As a merchant, I want this: ${inSentence(r.title)}.`, 'Made-up work for testing toil.');
  }
}

function owi(r, all, blocks, related) {
  const fields = {};
  if (r.acceptance) fields['Microsoft.VSTS.Common.AcceptanceCriteria'] = `<ul><li>${r.title} works for a card on each scheme.</li><li>The change is behind a flag until finance signs off.</li></ul>`;
  if (r.typeName === 'Bug') {
    fields['Microsoft.VSTS.TCM.ReproSteps'] = `<ol><li>Open ${r.product} in the test environment.</li><li>${r.title}.</li></ol>`;
    fields['Microsoft.VSTS.Common.Severity'] = r.severity;
  }
  if (r.typeName === 'Task') fields['Microsoft.VSTS.Scheduling.RemainingWork'] = r.remaining;
  const links = [
    ...blocks.filter(([a]) => a === r.key).map(([, b]) => ({ type: 'blocks', direction: 'outward', target: id(b), name: 'Successor' })),
    ...blocks.filter(([, b]) => b === r.key).map(([a]) => ({ type: 'blocks', direction: 'inward', target: id(a), name: 'Predecessor' })),
    // Related has no direction in Azure DevOps, so both ends read it as outward.
    ...related.filter(([a, b]) => a === r.key || b === r.key).map(([a, b]) => ({ type: 'relates', direction: 'outward', target: id(a === r.key ? b : a), name: 'Related' })),
  ];
  const labels = [SEED_TAG, `seed:${r.key}`, r.product, ...(r.topic ? [r.topic] : [])].sort();
  const done = CATEGORY[r.state] === 'DONE';
  const unmapped = [
    { field: 'url', reason: 'the item is created by apply.mjs; the server gives it a url' },
    { field: 'reporter', reason: 'the server records who created it' },
    { field: 'created', reason: 'the server records when it was created' },
    { field: 'updated', reason: 'the server records when it last changed' },
    ...(done ? [{ field: 'resolution', reason: 'the server records the reason it finished' }] : []),
    ...(r.effort === null ? [{ field: 'estimate', reason: 'left unestimated on purpose' }] : []),
  ];
  return {
    owi: '0.1',
    id: id(r.key),
    source: { area: 'ado', connection: SEED_CONNECTION, key: r.key, command: COMMAND, deployment: 'cloud' },
    url: null,
    type: OWI_TYPE[r.typeName],
    typeName: r.typeName,
    title: r.title,
    body: { format: 'html', content: description(r) },
    status: r.state,
    statusCategory: CATEGORY[r.state],
    // The reason is the process's to record on reaching the state, so it is the server's too.
    resolution: null,
    assignee: r.assigned ? { id: ME, name: null, email: null } : null,
    reporter: null,
    priority: r.priority,
    estimate: r.effort === null ? null : { value: r.effort, unit: 'points', field: 'Microsoft.VSTS.Scheduling.Effort' },
    labels,
    team: null,
    iteration: iterationOf(r.iteration),
    parent: r.parent ? id(r.parent) : null,
    children: all.filter((c) => c.parent === r.key).map((c) => id(c.key)),
    links,
    created: null,
    updated: null,
    resolved: null,
    dueDate: null,
    history: null,
    unmapped,
    native: { [COMMAND]: { product: r.product, areaPath: PROJECT, ...(r.stale ? { stale: true } : {}), timeline: r.timeline, fields } },
  };
}

/** Every problem in the records against docs/owi/schema.json, and in their references to each other. */
export function check(items) {
  const schema = JSON.parse(readFileSync(join(root, 'docs', 'owi', 'schema.json'), 'utf8'));
  const validator = new Validator(schema, '2020-12', false);
  const problems = [];
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) {
    const result = validator.validate(item);
    for (const e of result.errors) problems.push(`${item.id}: ${e.instanceLocation} ${e.error}`);
    for (const ref of [item.parent, ...item.children, ...item.links.map((l) => l.target)]) if (ref && !ids.has(ref)) problems.push(`${item.id}: ${ref} isn't in the file`);
  }
  if (ids.size !== items.length) problems.push('two records share an id');
  return problems;
}

export const render = (items, seed) => `${JSON.stringify({ owi: '0.1', seed, count: items.length, items }, null, 2)}\n`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const take = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] : fallback;
  };
  const checkOnly = args.includes('--check') && Boolean(args.splice(args.indexOf('--check'), 1));
  const seed = Number(take('--seed', String(DEFAULT_SEED)));
  const out = resolve(take('--out', DEFAULT_OUT));
  const fail = (message, fix) => {
    process.stderr.write(`generate: ${message}\n  Fix: ${fix}\n`);
    process.exit(1);
  };
  if (args.length) fail(`Unknown argument: ${args.join(' ')}`, 'Use --seed <n>, --out <file> and --check.');
  if (!Number.isInteger(seed)) fail('--seed must be a whole number.', 'Pass --seed 319, or leave it out.');
  const items = generate(seed);
  const problems = check(items);
  if (problems.length) fail(`${problems.length} records don't validate:\n  ${problems.join('\n  ')}`, 'Fix the generator; the file was not written.');
  const text = render(items, seed);
  if (checkOnly) {
    let current = '';
    try {
      current = readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      // A missing file is stale too.
    }
    if (current !== text) fail(`${out} isn't what seed ${seed} generates.`, 'Run node ui/scripts/ado-seed/generate.mjs and commit the result.');
    process.stdout.write(`${out}: up to date, ${items.length} records valid.\n`);
  } else {
    writeFileSync(out, text);
    const count = (f) => Object.entries(items.reduce((m, i) => ({ ...m, [f(i)]: (m[f(i)] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ');
    process.stdout.write(`Wrote ${out}: ${items.length} records, all valid against docs/owi/schema.json.\n  types: ${count((i) => i.typeName)}\n  states: ${count((i) => i.status)}\n  iterations: ${count((i) => i.iteration.name)}\n`);
  }
}
