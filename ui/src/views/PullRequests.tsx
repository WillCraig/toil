/**
 * A toil project's pull requests (#291): the open ones ranked by how long each
 * has waited and on what, the flags a lead would raise, flow metrics split
 * by who wrote the change (people, agents, bots) with every sample size
 * shown, and reviewers to suggest where none is asked. Every figure comes
 * from OWI 0.2 changes (src/model/prs.ts), mapped from each code host's own
 * `pr list` and `pr get`, and every panel says which calls fed it. The review
 * queue, finally reviewed.
 */

import { useMemo } from 'react';
import { PeekLinks } from '../components/briefing.tsx';
import { ProposalCard } from '../components/proposal.tsx';
import { ThroughputSpark } from '../components/charts.tsx';
import { Cited, ItemLink, PrLink } from '../components/items.tsx';
import { DataTable, type Column } from '../components/layout.tsx';
import { Help } from '../components/help.tsx';
import { Panel } from '../components/panel.tsx';
import { useData } from '../data.ts';
import { dateTime, toilProjectEditHref, toilProjectHref, personText } from '../format.ts';
import { Empty, EmptyLink, SyncOr } from '../components/empty.tsx';
import { Unread } from '../components/unread.tsx';
import {
  allFlags, daysText, diffSquares, KIND_LABEL, KINDS, openQueue, parseCodeowners, PR_FLAG_LABEL, PR_FLAG_SHORT, prMetrics, reviewProposal, SIZE_LINES, SIZES, suggestReviewers, WAITING_LABEL,
  type KindOrAll, type OpenRow, type PrMetrics, type Sample,
} from '../model/prs.ts';
import type { Change } from '../toil.ts';
import { asMapped, withMappedNames, type PersonEntry } from '../model/people.ts';
import { usePlain } from '../plain-words.ts';
import { NavButton } from '../components/nav-button.tsx';
import { DisclosureBody, SummaryChevron } from '../components/disclosure.tsx';
import { PullRequestActions, useConnectionInfo, type ConnectionInfo } from '../components/jobs.tsx';

const round1 = (n: number) => Math.round(n * 10) / 10;
const ALL: KindOrAll[] = ['ALL', ...KINDS];
const files = (n: number | null) => (n === null ? 'files not counted' : `${n} ${n === 1 ? 'file' : 'files'}`);
const ONE = { HUMAN: 'Person', AGENT: 'Agent', BOT: 'Bot' } as const;

/** The author as a name and a badge; the signal that said who wrote it (a trailer, a branch) is one step in. */
function Author({ change }: { change: Change }) {
  const why = change.authorKindSource === 'default' ? 'no signal said otherwise' : `${change.authorKindSource}: ${change.authorKindSignal}`;
  return (
    <>
      <span className="pr-author">{personText(change.author)}</span>
      {change.authorKind === 'HUMAN' ? null : (
        <details className="cell-more">
          <summary className={`kind kind--${change.authorKind.toLowerCase()}`}>{ONE[change.authorKind]}</summary>
          <p className="field">{why}</p>
        </details>
      )}
    </>
  );
}

/** Five squares, GitHub's diff stat. Colour is never the only carrier: the numbers are beside it, and the whole is one labelled image. */
function SizeBar({ size }: { size: OpenRow['size'] }) {
  const f = files(size.files);
  if (size.lines === null || size.additions === null || size.deletions === null) {
    return (
      <span className="note">
        – <span className="sr-only">lines not counted, </span>
        {size.files === null ? 'unknown' : `· ${f}`}
      </span>
    );
  }
  const sq = diffSquares(size.additions, size.deletions);
  const cells = [...Array<string>(sq.add).fill('add'), ...Array<string>(sq.del).fill('del'), ...Array<string>(sq.none).fill('none')];
  const full = `${size.lines} lines changed, ${size.additions} added and ${size.deletions} deleted, ${f}`;
  return (
    <span className="pr-size" title={full}>
      <span className="diffbar" role="img" aria-label={full}>
        {cells.map((c, i) => (
          <i key={i} className={`diffbar__sq diffbar__sq--${c}`} />
        ))}
      </span>
      <span aria-hidden="true">
        <strong>{size.bucket}</strong> <span className="field">{size.lines} · {size.files === null ? 'files unknown' : `${size.files} ${size.files === 1 ? 'file' : 'files'}`}</span>
      </span>
    </span>
  );
}

function Items({ ids }: { ids: string[] }) {
  if (!ids.length) return <span className="note">None</span>;
  return (
    <span className="cites">
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ', '}
          <ItemLink id={id} />
        </span>
      ))}
    </span>
  );
}

const queueColumns = (info: ConnectionInfo | null, plain: boolean): Array<Column<OpenRow>> => [
  {
    header: plain ? 'Code review' : 'Pull request',
    label: plain ? 'Code review' : 'Pull request',
    rowHeader: true,
    cell: (r) => (
      <>
        <PrLink change={r.change} withTitle />
        <span className="field"> {r.change.repo}</span>
      </>
    ),
  },
  {
    header: 'Waiting on',
    label: 'Waiting on',
    cell: (r) => (
      <>
        <strong>{WAITING_LABEL[r.wait.on]}</strong>
        {/* The age is a figure; the sentence behind it is one press in. An unknown age is a dash, not zero (principle 12). */}
        <details className="cell-more">
          <summary>{r.wait.days === null ? '–' : daysText(r.wait.days)}</summary>
          <p className="field">
            {WAITING_LABEL[r.wait.on]} {r.wait.days === null ? 'for an unknown time' : `for ${daysText(r.wait.days)}`}: {r.wait.why}
          </p>
        </details>
      </>
    ),
  },
  { header: 'Author', label: 'Author', cell: (r) => <Author change={r.change} /> },
  { header: 'Work items', label: 'Work items', cell: (r) => <Items ids={r.items} /> },
  { header: 'Size', label: 'Size', cell: (r) => <SizeBar size={r.size} /> },
  {
    header: 'Flags',
    label: 'Flags',
    cell: (r) =>
      r.flags.length ? (
        <ul className="plain flags">
          {r.flags.map((f) => (
            <li key={f.flag} title={PR_FLAG_LABEL[f.flag]}>
              {PR_FLAG_SHORT[f.flag]}
              {f.days !== undefined && ` · ${daysText(f.days)}`}
              <span className="sr-only">: {PR_FLAG_LABEL[f.flag]}</span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="note">None</span>
      ),
  },
  {
    // The jobs that apply and what a missing one needs: one quiet menu in its own column, not a button a row (principle 11).
    header: 'Actions',
    label: 'Actions',
    actions: true,
    cell: (r) => <PullRequestActions change={r.change} info={info} plain={plain} />,
  },
];

/** A flow cell is the median alone (#657); what it rests on and its 85th percentile are one press in. */
const fig = (s: Sample, unit: (n: number) => string) => (
  <details className="cell-more cell-more--flow">
    <summary>{s.median === null ? 'No data' : unit(s.median)}</summary>
    <p className="field">
      n={s.n}
      {s.unknown ? `, ${s.unknown} unknown` : ''}
      {s.p85 !== null && s.n > 1 ? `; 85% within ${unit(s.p85)}` : ''}
    </p>
  </details>
);

type MetricRow = { name: string; note: string; sample: Record<KindOrAll, Sample>; unit: (n: number) => string };

function metricRows(m: PrMetrics): MetricRow[] {
  const rounds = (n: number) => `${round1(n)} ${round1(n) === 1 ? 'round' : 'rounds'}`;
  return [
    { name: 'Pickup', note: 'opened to first review', sample: m.pickup, unit: daysText },
    { name: 'Review', note: 'first review to approval', sample: m.review, unit: daysText },
    { name: 'Merge', note: 'approval to merge', sample: m.merge, unit: daysText },
    { name: 'Review rounds', note: 'per merged pull request', sample: m.rounds, unit: rounds },
  ];
}

/** The median table's columns: All, then only the author kinds that opened or merged anything in the period. */
const metricColumns = (kinds: KindOrAll[]): Array<Column<MetricRow>> => [
  { header: 'Median', label: 'Median', rowHeader: true, cell: (r) => (<>{r.name} <span className="field">{r.note}</span></>) },
  ...kinds.map((k): Column<MetricRow> => ({ header: KIND_LABEL[k], label: KIND_LABEL[k], cell: (r) => fig(r.sample[k], r.unit) })),
];

/** A sample with nothing behind it: no change reached that step, and none whose record can't say. */
const emptySample = (s: Sample) => s.n === 0 && s.unknown === 0;

/** A list of words joined for a sentence: "a", "a and b", "a, b and c". */
const listText = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/**
 * The Flow panel: what qualifies every figure, then the medians, merges per week and sizes. Each part with nothing in it
 * is one line saying so and why (principle 12): nothing read is not the same as a real zero, and an author kind or a
 * step with no pull request behind it is named once rather than drawn as a grid of "No data".
 */
export function Flow({ m, read, plain = true }: { m: PrMetrics; read: boolean; plain?: boolean }) {
  const weeks = m.throughput.ALL.length;
  if (!m.counts.ALL) {
    return (
      <p className="note" data-flow-empty="">
        {read ? (
          `No pull requests opened or merged in the ${weeks} weeks from ${dateTime(m.from)}, so there is no flow to measure.`
        ) : (
          <>
            <Unread /> No pull requests read yet, so there is no flow to measure.
          </>
        )}
      </p>
    );
  }
  const kinds = ALL.filter((k) => k === 'ALL' || m.counts[k] > 0);
  const absent = KINDS.filter((k) => !m.counts[k]).map((k) => KIND_LABEL[k].toLowerCase());
  const all = metricRows(m);
  const rows = all.filter((r) => !emptySample(r.sample.ALL));
  const unmeasured = all.filter((r) => emptySample(r.sample.ALL)).map((r) => r.name);
  const merged = m.throughput.ALL.reduce((n, w) => n + w.items.length, 0);
  const opened = Object.values(m.sizes.ALL).reduce((n, v) => n + v, 0);
  const sizeRows = [...SIZES, ...(kinds.some((k) => m.sizes[k].unknown) ? (['unknown'] as const) : [])];
  return (
    <>
      {/* The period and what n counts qualify every figure below, so they stay on the page; what "unknown" covers is in the (i). */}
      <p className="note">
        {weeks} weeks from {dateTime(m.from)}. n is how many pull requests a figure rests on.
        {absent.length > 0 && ` None by ${listText(absent)} in this period.`}
      </p>
      {rows.length > 0 && <DataTable className="pr-metrics" label="Pull request flow by author kind" rows={rows} rowKey={(r) => r.name} columns={metricColumns(kinds)} />}
      {unmeasured.length > 0 && (
        <p className="note" data-flow-unmeasured="">
          {listText(unmeasured)}: no pull request has reached {unmeasured.length === 1 ? 'that step' : 'those steps'} in this period, so there is no median yet.
        </p>
      )}
      {m.mergedUnreviewed.ALL > 0 && (
        <p className="note">
          {m.mergedUnreviewed.ALL} merged {m.mergedUnreviewed.ALL === 1 ? 'pull request has' : 'pull requests have'} no approval on record, so review and merge time leave {m.mergedUnreviewed.ALL === 1 ? 'it' : 'them'} out ({KINDS.map((k) => `${KIND_LABEL[k]}: ${m.mergedUnreviewed[k]}`).join(', ')}).
        </p>
      )}
      <h3>Merged per week</h3>
      {merged > 0 ? (
        <div className="pr-spark">
          <ThroughputSpark weeks={m.throughput.ALL} noun="pull requests merged" />
        </div>
      ) : null}
      <p className="note">
        {merged > 0 ? `${kinds.filter((k) => k !== 'ALL').map((k) => `${KIND_LABEL[k]}: ${m.throughput[k].reduce((n, w) => n + w.items.length, 0)}`).join(', ')}.` : `None merged in ${weeks} weeks.`}
        {m.unplacedMerges > 0 && ` ${m.unplacedMerges} merged ${m.unplacedMerges === 1 ? 'pull request has' : 'pull requests have'} no merge time on record (Bitbucket Cloud keeps none) and ${m.unplacedMerges === 1 ? "isn't" : "aren't"} counted in a week.`}
      </p>
      {/* The sizes fold under Flow (#657): the waiting list already shows each open one's size. */}
      {opened ? (
        <details className="board-more" data-pr-sizes="">
          <summary className="btn btn--secondary btn--sm">
            <SummaryChevron />
            {plain ? 'Show the sizes of code reviews opened' : 'Show the sizes of pull requests opened'}
          </summary>
          <DisclosureBody>
        <DataTable
          className="pr-sizes"
          label="Pull request sizes by author kind"
          rows={sizeRows}
          rowKey={(s) => s}
          columns={[
            { header: 'Size', label: 'Size', rowHeader: true, cell: (s) => (s === 'unknown' ? <>Unknown <span className="field">(lines not counted)</span></> : <>{s} <span className="field">{s === 'XL' ? `${SIZE_LINES.L + 1}+ lines` : `up to ${SIZE_LINES[s]} lines`}</span></>) },
            ...kinds.map((k): Column<(typeof SIZES)[number] | 'unknown'> => ({ header: `${KIND_LABEL[k]} (n=${m.counts[k]})`, label: KIND_LABEL[k], cell: (s) => m.sizes[k][s] })),
          ]}
        />
          </DisclosureBody>
        </details>
      ) : (
        <p className="note">None opened in {weeks} weeks.</p>
      )}
    </>
  );
}

/**
 * The open pull requests nobody is asked to review: each with its proposals, and every one with no one to suggest
 * gathered into a single line, so the same reason isn't repeated once a row.
 */
function Unasked({ rows, prs, rules, toilProject, people }: { rows: OpenRow[]; prs: Change[]; rules: Record<string, ReturnType<typeof parseCodeowners>>; toilProject: string; people: PersonEntry[] }) {
  // A suggested account under the name the toil project's people give it; a team or an unmapped login stays as it is.
  const nameOf = (c: Change, id: string) => asMapped(people, c.source.area, { id, name: null, email: null })?.name ?? id;
  const withPeople = rows.map(({ change }) => ({ change, people: suggestReviewers(change, prs, rules[change.repo] ?? null) }));
  const nobody = withPeople.filter((r) => !r.people.length).map((r) => r.change);
  const some = withPeople.filter((r) => r.people.length);
  return (
    <>
      {some.length > 0 && (
        <ul className="rows">
          {some.map(({ change, people }) => (
            <li key={change.id}>
              <PrLink change={change} withTitle />
              <ul className="plain proposals">
                {people.map((s) => (
                  <li key={s.id}>
                    <ProposalCard proposal={reviewProposal(change, s, toilProject, nameOf(change, s.id))} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {nobody.length > 0 && (
        <p className="note" data-no-suggestion="">
          No one to suggest for{' '}
          {nobody.map((c, i) => (
            <span key={c.id}>
              {i > 0 && (i === nobody.length - 1 ? ' and ' : ', ')}
              <PrLink change={c} />
            </span>
          ))}
          : no CODEOWNERS rule and no earlier review covers {nobody.length === 1 ? 'its' : 'their'} paths.
        </p>
      )}
    </>
  );
}

export function PullRequests() {
  const { toilProject, byId, now, sync, config } = useData();
  const plain = usePlain();
  const connections = useConnectionInfo(config);
  // Every person on a pull request named as the toil project's people name them: one person with two accounts reads as one name.
  const people = toilProject.people ?? [];
  const prs = useMemo(() => (toilProject.pullRequests ?? []).map((c) => withMappedNames(c, people)), [toilProject]);
  const queue = openQueue(prs, byId, now);
  const m = prMetrics(prs, now);
  const rules = Object.fromEntries(Object.entries(toilProject.codeowners ?? {}).map(([repo, file]) => [repo, parseCodeowners(file.text)]));
  const unasked = queue.filter((r) => !r.change.reviewers.length);
  // The open ones' flags are the queue's Flags column (#657); only the merged or closed ones' are listed apart, one press in.
  const openIds = new Set(queue.map((r) => r.change.id));
  const closedFlags = allFlags(prs, byId, now).filter((f) => !openIds.has(f.change.id));
  const calls = toilProject.calls.prs;

  return (
    <PeekLinks>
      <div className="view-head">
        <p className="eyebrow">
          <NavButton href={toilProjectHref(toilProject.name)} kind="quiet" size="sm" className="eyebrow-btn">
            {toilProject.name}
          </NavButton>
        </p>
        <h2 className="drill-title" title={plain.title('Pull requests')}>
          {plain.pw('Pull requests', 'Code reviews')}
        </h2>
        <p className="lede">
          {queue.length} open across {new Set(prs.map((c) => c.repo)).size} {new Set(prs.map((c) => c.repo)).size === 1 ? 'repository' : 'repositories'}, {prs.length - queue.length} merged or closed. Read {dateTime(now)}.
        </p>
        {(toilProject.readTargets ?? []).filter((t) => !t.pullRequests).map((t) => (
          <p key={t.label} className="note">
            {t.label}: {plain.pw('pull requests', 'code reviews')} not read
          </p>
        ))}
        {(toilProject.prNotes ?? []).map((n, i) => (
          <p key={i} role="note" className="failure">
            {n}
          </p>
        ))}
      </div>

      <Panel id="queue" title="Waiting now" calls={calls} info={<Help topic="prs-queue" />}>
        {queue.length ? <DataTable className="pr-queue" label="Open pull requests" wide rows={queue} rowKey={(r) => r.change.id} columns={queueColumns(connections, plain.on)} /> : <Empty message="No open pull requests for this Toil project." action={<SyncOr sync={sync}><EmptyLink edit href={toilProjectEditHref(toilProject.name, 'repos')}>Add a repository</EmptyLink></SyncOr>} />}
        {closedFlags.length > 0 && (
          <details className="board-more" data-closed-flags="">
            <summary className="btn btn--secondary btn--sm">
              <SummaryChevron />
              Show {closedFlags.length} {closedFlags.length === 1 ? 'flag' : 'flags'} on merged or closed {plain.pw('pull requests', 'code reviews')}
            </summary>
            <DisclosureBody>
              <ul className="rows">
                {closedFlags.map(({ change, hit }) => (
                  <li key={`${change.id}:${hit.flag}`}>
                    <PrLink change={change} withTitle /> <strong>{PR_FLAG_LABEL[hit.flag]}</strong>
                    <p className="evidence">
                      <Cited text={hit.text} />
                    </p>
                  </li>
                ))}
              </ul>
            </DisclosureBody>
          </details>
        )}
      </Panel>

      <Panel id="flow" title="Flow" calls={calls} alerts={false} info={<Help topic="prs-flow" />}>
        <Flow m={m} read={prs.length > 0 || calls.length > 0} plain={plain.on} />
      </Panel>

      <Panel id="reviewers" title="Suggested reviewers" calls={toilProject.calls.owners ?? []} alerts={false} info={<Help topic="prs-reviewers" />}>
        {/* Plain words, no file paths (#657): whether the code owners were read is the source; where the file sits is the host's business. */}
        {(toilProject.calls.owners ?? []).length > 0 && !Object.keys(toilProject.codeowners ?? {}).length && <p className="evidence">No code owners file was found in the repository.</p>}
        {unasked.length ? <Unasked rows={unasked} prs={prs} rules={rules} toilProject={toilProject.name} people={people} /> : <p>Every open pull request has a reviewer asked.</p>}
      </Panel>
    </PeekLinks>
  );
}
