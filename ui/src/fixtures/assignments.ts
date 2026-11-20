/**
 * The sample's assignments (#293): the real queue (src/assign/queue.ts) on
 * the sample toil projects, with a scripted runner in place of a model, for the
 * site preview, `toil-ui --sample` and the layout check. It seeds one
 * assignment in every state, so each view has something to show: one
 * working, one that needs you (a refine with proposals and a question), one
 * done (an investigation whose comment was applied), one failed at the time
 * limit (an implement run), and one the tracker queued, waiting for Start.
 * The sample's tracker data carries no `agent:` label, so for the inbox the
 * sample's queue reads PAY-107 with `agent:refine` added; the item page
 * shows the tracker as it is. A run started here takes a few seconds and
 * ends with canned output; applying a proposal changes nothing and says so.
 * Rehearsal footage, clearly labelled, with the extras in costume.
 */

import { loadToilProject, type ToilProjectData } from '../load.ts';
import type { Proposal } from '../proposal.ts';
import type { Envelope, Execute, WorkItem } from '../toil.ts';
import { ADAPTER_NAME, branchName, proposalDiff, type AdapterChoice, type AssignedRule, type AssignmentRecord, type AssignmentsApi, type AssignSettings, type StartedOn } from '../assign/model.ts';
import { AssignmentQueue, type Keeper, type RunContext, type RunResult, type Runner } from '../assign/queue.ts';
import { FIXTURE_NOW, fixtureExecute } from './execute.ts';
import { sampleAnswerUsage } from './model-usage.ts';
import { fixtureStandards } from './standards.ts';
import type { Fingerprint } from '../fingerprint.ts';

export const SAMPLE_ASSIGN_SETTINGS: AssignSettings = { concurrent: 2, timeLimitMinutes: 20 };

/** The label the sample's queue reads on PAY-107, so the inbox has an entry. */
export const SAMPLE_INBOX = { item: 'corp-jira:PAY-107', label: 'agent:refine' };

const minutes = (n: number) => new Date(Date.parse(FIXTURE_NOW) - n * 60_000).toISOString();
const J = (n: number) => `[[corp-jira:PAY-${n}]]`;
const SAMPLE_FINGERPRINT = 'sample0000000000000000000000000000000000000000000000000000000000';

/**
 * The sample's install fingerprint now (#305), and the older one two seeded
 * runs started on (toil a release back, with Jira's tools since changed), so
 * the sample shows stale assignments and Renew has something to do.
 */
export const SAMPLE_FINGERPRINT_NOW: Fingerprint = {
  toil: { version: '0.1.0-alpha.4', commit: null },
  toilUi: { version: '0.1.0-alpha.2', commit: null },
  skills: { github: 'sample-github-2', jira: 'sample-jira-2' },
  toilProject: 'sample-toil-project',
  prompts: 'sample-prompts',
};
export const SAMPLE_FINGERPRINT_BEFORE: Fingerprint = { ...SAMPLE_FINGERPRINT_NOW, toil: { version: '0.1.0-alpha.3', commit: null }, skills: { github: 'sample-github-2', jira: 'sample-jira-1' } };

const startedOn = (item: string, adapter: StartedOn['adapter'], at: string, tools: string[], fingerprint: Fingerprint = SAMPLE_FINGERPRINT_NOW): StartedOn => ({
  at,
  toil: 'sample',
  toilUi: 'sample',
  adapter,
  model: null,
  skills: [],
  tools,
  toilProject: { name: 'card-payments', fingerprint: SAMPLE_FINGERPRINT },
  item: { id: item, updated: null, fingerprint: SAMPLE_FINGERPRINT },
  prompt: SAMPLE_FINGERPRINT,
  fingerprint,
});

const READ_TOOLS = ['owi_query', 'owi_get', 'owi_history', 'owi_similar', 'pr_query', 'pr_get', 'pr_metrics', 'proposal_fields'];

/** The acceptance criteria, and an estimate where there is none, that the sample's refine proposes for one Jira item. */
function refineProposals(toilProject: string, item: WorkItem): Proposal[] {
  const key = item.source.key;
  const criteria = [`${item.title}.`, '', 'Acceptance criteria:', '- It works for every card scheme the gateway takes.', '- A failure is logged with its reason and no card data.', '- A test covers the happy path and one failure.'].join('\n');
  const out: Proposal[] = [
    {
      id: `agent:${item.id}:jira issue update:0`,
      from: 'agent',
      item: item.id,
      title: `Add acceptance criteria to ${key}`,
      reason: `${item.title} has no acceptance criteria, so nobody can say when it is done.`,
      command: 'jira issue update',
      input: { toilProject, key, description: criteria },
      note: 'Replaces the description. Check the wording with the team first.',
    },
  ];
  if (item.estimate) return out;
  out.push({
    id: `agent:${item.id}:jira issue update:1`,
    from: 'agent',
    item: item.id,
    title: `Estimate ${key} at 3 points`,
    reason: `About the size of ${J(105)}, which took 3 points.`,
    command: 'jira issue update',
    input: { toilProject, key, field: ['Story Points=3'] },
    note: 'A suggested size. Agree it with the team before applying.',
  });
  return out;
}

/** The headings a bug-repro rule's section goes by, for the sample's canned fix. */
const SECTION: Record<string, string> = { steps: 'Steps to reproduce', expected: 'Expected result', actual: 'Actual result' };

/**
 * The sample's worked rewrites, by item key: what a run that read the item and
 * its links might propose, so the demo shows a real answer rather than a form
 * with blanks. Any other item gets the general shape, gaps and all.
 */
const WORKED: Record<string, { text: string[]; question: string; said: string }> = {
  'PAY-103': {
    text: ['Scenario: Charge a stored token', '  Given a customer with a saved card token', '  When they confirm a payment', '  Then the card is charged once and a receipt is shown'],
    question: 'What should the customer see when the stored token is declined?',
    said: 'as one Given/When/Then scenario: a customer with a saved card token confirms a payment, and the card is charged once with a receipt shown. The item says nothing about a declined token, so that is asked as a question.',
  },
};

/** Where toil read a rule's text, leaving out what it couldn't read ("description; not read: field …" read the description). */
const readFrom = (source: string) => source.split(/;?\s*not read:/)[0]!;

/**
 * The sample's canned "Fix with AI agent" (#657): one rewrite of the place
 * toil read, meeting every rule it was given (one, or a standard's "Fix all"),
 * and at most one question for what the item doesn't say. A real run writes
 * from the item; this one shows the shape, and a worked answer for PAY-103.
 * `criteriaField` is the Toil project's acceptance criteria field, where a
 * rule that read the acceptance criteria is fixed.
 */
export function ruleFix(toilProject: string, item: WorkItem, rules: readonly AssignedRule[], criteriaField: string | null = null): { proposal: Proposal; questions: string[]; said: string } {
  const r = rules[0]!;
  const read = readFrom(r.source);
  // toil names a field it read ("field customfield_10500 (acceptanceCriteria)"), or says it read the acceptance criteria: the fix goes there.
  const field = /\bfield ([^\s(),;]+)/.exec(read)?.[1] ?? (/criteria/i.test(read) ? criteriaField : null);
  const key = item.source.key;
  const worked = r.standard === 'gherkin' ? WORKED[key] : undefined;
  const bug = r.standard === 'bug-repro';
  const text = worked
    ? worked.text.join('\n')
    : bug
      ? rules.flatMap((x) => [`## ${SECTION[x.rule] ?? x.name}`, x.rule === 'actual' ? item.title : x.rule === 'expected' ? '[the correct behaviour: see the question]' : '1. [the first step: see the question]', '']).join('\n')
      : [`Scenario: ${item.title}`, '  Given [the starting point: see the question]', `  When someone does what the item asks: ${item.title.toLowerCase()}`, '  Then [what a person sees when it worked]'].join('\n');
  const question = worked?.question ?? (bug ? `What exact steps make "${item.title}" happen, and what should have happened instead?` : `What has to be true before "${item.title}" starts: which account, card or data does it begin from?`);
  const place = field ? 'the acceptance criteria' : 'the description';
  const jira = item.source.area.startsWith('jira');
  const names = rules.length === 1 ? `"${r.name}"` : `${rules.length} ticket rules`;
  return {
    proposal: {
      id: `agent:${item.id}:rule:${r.standard}/${rules.map((x) => x.rule).join('+')}`,
      from: 'agent',
      item: item.id,
      title: `Rewrite ${place} of ${key} to meet ${names}`,
      reason: worked ? `Rewrites ${place} of [[${item.id}]] ${worked.said}` : `${rules.map((x) => x.reason).join(' ')} The rewrite keeps what [[${item.id}]] says and leaves what it doesn't as a gap, asked about below.`,
      command: jira ? 'jira issue update' : null,
      input: jira ? { toilProject, key, ...(field ? { field: [`${field}=${text}`] } : { description: text }) } : null,
      note: jira ? `Replaces ${place}.` : 'The sample proposes this for Jira items only; make the change by hand.',
    },
    questions: [question],
    said: worked ? `The proposal rewrites ${place} of [[${item.id}]] ${worked.said}` : `[[${item.id}]] missed ${rules.length === 1 ? `"${r.name}"` : rules.map((x) => `"${x.name}"`).join(', ')}. The proposal rewrites ${place} to meet ${rules.length === 1 ? 'it' : 'them'}, keeping what the item says and leaving what it doesn't as a gap, with one question.`,
  };
}

/** The seeded assignments, one in every state, worked out from the sample's own items. */
export function sampleRecords(cards: ToilProjectData): AssignmentRecord[] {
  const byId = new Map(cards.items.map((i) => [i.id, i]));
  const item = (id: string) => byId.get(id)!;
  const base = (id: string, itemId: string, over: Partial<AssignmentRecord>): AssignmentRecord => ({
    id,
    toilProject: 'card-payments',
    item: itemId,
    itemTitle: item(itemId).title,
    mode: 'refine',
    adapter: 'codex',
    origin: 'person',
    trigger: null,
    state: 'queued',
    waiting: null,
    repo: null,
    createdAt: minutes(60),
    startedAt: null,
    endedAt: null,
    stop: null,
    report: null,
    questions: [],
    proposals: [],
    usage: null,
    startedOn: null,
    branch: null,
    transcript: [],
    ...over,
  });
  const p102 = item('corp-jira:PAY-102');
  const refine = refineProposals('card-payments', p102).map((p) => ({ ...p, status: 'pending' as const, diff: proposalDiff(p, p102) }));
  return [
    base('sample-working-0001', 'corp-jira:PAY-104', {
      mode: 'investigate',
      adapter: 'claude',
      state: 'working',
      createdAt: minutes(4),
      startedAt: minutes(3),
      transcript: [
        { at: minutes(4), kind: 'note', title: 'Assigned by a person in Toil UI to Claude, in investigate mode.' },
        { at: minutes(3), kind: 'note', title: 'Started on Claude, with a time limit of 20 minutes.' },
        { at: minutes(3), kind: 'tool', title: 'Called: owi_get', detail: '{"id":"corp-jira:PAY-104"}' },
        { at: minutes(2), kind: 'tool', title: 'Called: pr_query', detail: '{"item":"corp-jira:PAY-104"}' },
      ],
    }),
    base('sample-needsyou-0002', 'corp-jira:PAY-102', {
      state: 'needs-you',
      createdAt: minutes(55),
      startedAt: minutes(54),
      endedAt: minutes(51),
      report: {
        parts: [
          { text: `${J(102)} has no likely duplicate: owi_similar's closest is ${J(103)} at 41%, which charges a token rather than storing one.` },
          { text: `It blocks ${J(101)} and ${J(103)}, so its criteria decide when both can start. Its 3-point estimate fits the work; the proposal below adds the criteria it lacks.` },
        ],
        citations: ['corp-jira:PAY-102', 'corp-jira:PAY-103', 'corp-jira:PAY-101'],
        unverified: [],
        warnings: [],
      },
      questions: ['Which vault holds the tokens in staging: the shared one, or a vault of its own?'],
      proposals: refine,
      usage: sampleAnswerUsage('sample-needsyou-0002', 1, 'card-payments', minutes(51)),
      startedOn: startedOn('corp-jira:PAY-102', 'codex', minutes(54), READ_TOOLS, SAMPLE_FINGERPRINT_BEFORE),
      transcript: [
        { at: minutes(55), kind: 'note', title: 'Assigned by a person in Toil UI to Codex, in refine mode.' },
        { at: minutes(54), kind: 'note', title: 'Started on Codex, with a time limit of 20 minutes.' },
        { at: minutes(54), kind: 'prompt', title: 'Task', detail: `Refine [[corp-jira:PAY-102]] so a person could pick it up.` },
        { at: minutes(53), kind: 'tool', title: 'Called: owi_similar', detail: '{"id":"corp-jira:PAY-102"}' },
        { at: minutes(52), kind: 'tool', title: 'Called: proposal_fields', detail: '{"command":"jira issue update"}' },
        { at: minutes(51), kind: 'text', title: 'The agent answered' },
        ...refine.map((p) => ({ at: minutes(51), kind: 'proposal' as const, title: `Proposed: ${p.title}` })),
      ],
    }),
    base('sample-done-00000003', 'corp-jira:PAY-98', {
      mode: 'investigate',
      adapter: 'copilot',
      state: 'done',
      createdAt: minutes(300),
      startedAt: minutes(299),
      endedAt: minutes(296),
      report: {
        parts: [{ text: `${J(98)} shipped the decline codes in the merchant report; nothing in the sprint depends on it, and no pull request on it is open.` }],
        citations: ['corp-jira:PAY-98'],
        unverified: [],
        warnings: [],
      },
      proposals: [
        {
          id: 'agent:corp-jira:PAY-98:comment:report',
          from: 'agent',
          item: 'corp-jira:PAY-98',
          title: 'Post the report as a comment on PAY-98',
          reason: 'The investigation above, as one comment, so the people on the item can read it where they work.',
          command: 'jira issue comment',
          input: { toilProject: 'card-payments', key: 'PAY-98', body: 'corp-jira:PAY-98 shipped the decline codes in the merchant report.' },
          note: 'The comment is the report exactly as shown above.',
          status: 'applied',
          diff: [{ field: 'body', before: null, after: 'corp-jira:PAY-98 shipped the decline codes in the merchant report.' }],
          outcome: { at: minutes(290), ok: true, message: 'Applied with toil jira issue comment.' },
        },
      ],
      startedOn: startedOn('corp-jira:PAY-98', 'copilot', minutes(299), READ_TOOLS),
      transcript: [
        { at: minutes(300), kind: 'note', title: 'Assigned by a person in Toil UI to GitHub Copilot, in investigate mode.' },
        { at: minutes(290), kind: 'proposal', title: 'Applied: Post the report as a comment on PAY-98', detail: 'Applied with toil jira issue comment.' },
      ],
    }),
    base('sample-failed-0000004', 'corp-jira:PAY-101', {
      mode: 'implement',
      adapter: 'codex',
      repo: 'payments-core',
      state: 'failed',
      createdAt: minutes(180),
      startedAt: minutes(179),
      endedAt: minutes(159),
      stop: { reason: 'time', message: 'Stopped at the time limit of 20 minutes, before the agent finished.', fix: 'Raise the limit in the Agents sidebar, or assign a smaller piece of the item.' },
      startedOn: startedOn('corp-jira:PAY-101', 'codex', minutes(179), [...READ_TOOLS, 'codex sandbox'], SAMPLE_FINGERPRINT_BEFORE),
      transcript: [
        { at: minutes(180), kind: 'note', title: 'Assigned by a person in Toil UI to Codex, in implement mode.' },
        { at: minutes(178), kind: 'activity', title: `Ran git clone --no-hardlinks <payments-core> . (exit 0)` },
        { at: minutes(177), kind: 'activity', title: `Ran git switch -c ${branchName(item('corp-jira:PAY-101'))} (exit 0)` },
        { at: minutes(159), kind: 'error', title: 'Stopped at the time limit of 20 minutes, before the agent finished.' },
      ],
    }),
    base('sample-inbox-00000005', SAMPLE_INBOX.item, {
      origin: 'tracker',
      trigger: `label ${SAMPLE_INBOX.label}`,
      adapter: null,
      waiting: 'start',
      createdAt: minutes(20),
      transcript: [{ at: minutes(20), kind: 'note', title: `Queued by the tracker (label ${SAMPLE_INBOX.label}); it starts only when a person presses Start.` }],
    }),
  ];
}

/**
 * Canned results for a run started in the sample, a step every `delay` ms.
 * `criteriaField` names a Toil project's acceptance criteria field for an area, where a canned fix writes.
 */
export function scriptedRunner(delay = 600, criteriaField: (toilProject: string, area: string) => string | null = () => null): Runner {
  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('Stopped.'))), { once: true });
    });
  return {
    adapters: (): AdapterChoice[] =>
      (['claude', 'copilot', 'codex'] as const).map((name) => ({ name, label: ADAPTER_NAME[name], problem: null, implement: name === 'codex' ? null : `${ADAPTER_NAME[name]} can't take implement mode through Toil UI yet: only Codex's own sandbox holds an agent's commands and writes to one folder.` })),
    preferred: () => 'codex',
    async run(ctx: RunContext): Promise<RunResult> {
      const { assignment: a, item, signal } = ctx;
      ctx.record({ kind: 'prompt', title: 'Task', detail: `${a.mode} [[${item.id}]] (sample: no model is asked)` });
      await wait(delay, signal);
      ctx.record({ kind: 'tool', title: 'Called: owi_get', detail: JSON.stringify({ id: item.id }) });
      await wait(delay, signal);
      ctx.record({ kind: 'tool', title: 'Called: owi_similar', detail: JSON.stringify({ id: item.id }) });
      await wait(delay, signal);
      const cite = `[[${item.id}]]`;
      if (a.rules?.length) {
        const fix = ruleFix(a.toilProject, item, a.rules, criteriaField(a.toilProject, item.source.area));
        return {
          report: { parts: [{ text: fix.said }], citations: [item.id], unverified: [], warnings: [] },
          proposals: [fix.proposal],
          questions: fix.questions,
          injection: null,
          usage: sampleAnswerUsage(a.id, 1, a.toilProject),
          startedOn: startedOn(item.id, a.adapter!, FIXTURE_NOW, READ_TOOLS),
          branch: null,
        };
      }
      const report = {
        parts: [{ text: a.mode === 'investigate' ? `${cite} is ${item.status ?? 'open'}. This is the sample's canned report; a real run reads the Toil project's sources and cites each one.` : `${cite}: the sample's canned ${a.mode} run. A real run would ${a.mode === 'refine' ? 'draft criteria and an estimate' : 'clone the repository and stage a change'}.` }],
        citations: [item.id],
        unverified: [],
        warnings: [],
      };
      const proposals: Proposal[] =
        a.mode === 'refine' && item.source.area === 'jira'
          ? refineProposals(a.toilProject, item)
          : a.mode === 'investigate' && item.source.area === 'jira'
            ? [{ id: `agent:${item.id}:comment:report`, from: 'agent', item: item.id, title: `Post the report as a comment on ${item.source.key}`, reason: 'The investigation above, as one comment.', command: 'jira issue comment', input: { toilProject: a.toilProject, key: item.source.key, body: report.parts[0]!.text.replace(/\[\[([^\]]+)\]\]/g, '$1') }, note: null }]
            : [];
      return {
        report,
        proposals,
        questions: a.mode === 'refine' ? ['Is this sample question answered by the item itself?'] : [],
        injection: null,
        usage: sampleAnswerUsage(a.id, 1, a.toilProject),
        startedOn: startedOn(item.id, a.adapter!, FIXTURE_NOW, READ_TOOLS),
        branch:
          a.mode === 'implement'
            ? { name: branchName(item), repo: a.repo ?? 'payments-core', folder: `~/.toil-ui/cache/work/${a.id}`, onBranch: true, files: [{ path: 'src/sample.ts', status: 'staged' }], hidden: [], cut: false, diff: '--- a/src/sample.ts\n+++ b/src/sample.ts\n@@ -1 +1 @@\n-// before\n+// after (sample)' }
            : null,
      };
    },
  };
}

const memory = (seed: AssignmentRecord[]): Keeper => {
  const saved = new Map(seed.map((r) => [r.id, r]));
  return { load: () => [...saved.values()].map((r) => structuredClone(r)), save: (r) => void saved.set(r.id, structuredClone(r)) };
};

/** Applying in the sample: refused, as the sample has no tracker to change. */
const refuse = (command: string): Envelope =>
  ({ ok: false, data: null, error: { code: 'WRITE_DISABLED', message: `This is sample data, so toil ${command} wasn't run: there is no tracker to change.`, fix: 'Start toil-ui on your own Toil projects to apply proposals.' }, meta: { command, durationMs: 0, version: 'sample', contractVersion: 1 } }) as Envelope;

export interface SampleQueue {
  queue: AssignmentQueue;
  /** Resolves once the sample toil projects are loaded; the queue reads their items from then on. */
  ready: Promise<void>;
}

/** The sample's queue: the real one, on the sample's items, its seeds and the scripted runner. */
export function sampleQueue(execute: Execute = fixtureExecute().execute, o: { delay?: number; now?: () => string; restartNeeded?: () => string | null } = {}): SampleQueue {
  const rules = fixtureStandards(execute);
  const data = new Map<string, ToilProjectData>();
  let seq = 0;
  // The sample's clock starts at its own fixed day and runs from there, so seeds and new runs share one timeline.
  const loaded = Date.now();
  const clock = () => new Date(Date.parse(FIXTURE_NOW) + (Date.now() - loaded)).toISOString();
  let queue!: AssignmentQueue;
  const ready = (async () => {
    for (const name of ['card-payments', 'settlement', 'checkout-web']) data.set(name, await loadToilProject(execute, name));
    queue = new AssignmentQueue({
      keeper: memory(sampleRecords(data.get('card-payments')!)),
      runner: scriptedRunner(o.delay, (toilProject, area) => data.get(toilProject)?.readiness.areas[area]?.acceptanceField ?? null),
      items: (toilProject) => {
        const items = data.get(toilProject)?.items ?? null;
        return items?.map((i) => (i.id === SAMPLE_INBOX.item ? { ...i, labels: [...i.labels, SAMPLE_INBOX.label] } : i)) ?? null;
      },
      people: async (toilProject) => data.get(toilProject)?.people ?? [],
      repos: async (toilProject) => (toilProject === 'card-payments' ? [{ name: 'payments-core', path: '~/src/payments-core' }] : []),
      apply: async (_a, p) => refuse(p.command ?? 'that'),
      ruleFor: (toilProject, item, standard, rule) => rules.ruleFor(toilProject, item, standard, rule),
      settings: () => SAMPLE_ASSIGN_SETTINGS,
      current: () => SAMPLE_FINGERPRINT_NOW,
      ...(o.restartNeeded ? { restartNeeded: o.restartNeeded } : {}),
      now: o.now ?? clock,
      newId: () => `sample-new-${String(++seq).padStart(8, '0')}`,
      sample: true,
    });
  })();
  return {
    get queue() {
      return queue;
    },
    ready,
  };
}

/** The preview's AssignmentsApi: the sample queue, in the page. */
export function fixtureAssignments(o: { delay?: number } = {}): AssignmentsApi {
  const s = sampleQueue(fixtureExecute().execute, o);
  const q = async () => (await s.ready, s.queue);
  return {
    disabled: null,
    list: async (toilProject, o) => (await q()).list(toilProject, o),
    get: async (id) => (await q()).read(id),
    assign: async (r) => (await q()).assign(r),
    start: async (id, adapter) => (await q()).start(id, adapter),
    cancel: async (id) => (await q()).cancel(id),
    apply: async (id, p) => (await q()).apply(id, p),
    dismiss: async (id, p) => (await q()).dismiss(id, p),
    finish: async (id) => (await q()).finish(id),
    renew: async (id) => (await q()).renew(id),
    async events(_since, onEvent, signal) {
      // The sample's queue lives in the page, so its events are only ever what happens next.
      const stop = (await q()).subscribe(onEvent);
      await new Promise<void>((done) => (signal.aborted ? done() : signal.addEventListener('abort', () => done(), { once: true })));
      stop();
    },
  };
}
