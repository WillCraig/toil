/**
 * A dossier's pull requests (#291): the open ones ranked by how long each
 * has waited and on what, the flags a lead would raise, flow metrics split
 * by who wrote the change (people, agents, bots) with every sample size
 * shown, and reviewers to suggest where none is asked. Every figure comes
 * from OWI 0.2 changes (src/model/prs.ts), mapped from each code host's own
 * `pr list` and `pr get`, and every panel says which calls fed it. The review
 * queue, finally reviewed.
 */

import { PeekLinks } from '../components/briefing.tsx';
import { ProposalCard } from '../components/proposal.tsx';
import { ThroughputSpark } from '../components/charts.tsx';
import { Cited, ItemLink, PrLink } from '../components/items.tsx';
import { DataTable, type Column } from '../components/layout.tsx';
import { Panel } from '../components/panel.tsx';
import { Help } from '../components/help.tsx';
import { useData } from '../data.ts';
import { dateTime, dossierEditHref, dossierHref, personText } from '../format.ts';
import { Empty, EmptyLink, SyncOr } from '../components/empty.tsx';
import {
  allFlags, daysText, FAILING_HOURS, KIND_LABEL, KINDS, openQueue, parseCodeowners, PICKUP_DAYS, PR_FLAG_LABEL, prMetrics, reviewProposal, SIZE_LINES, SIZES, suggestReviewers, WAITING_LABEL,
  type KindOrAll, type OpenRow, type PrMetrics, type Sample,
} from '../model/prs.ts';
import type { Change } from '../toil.ts';
import { usePlain } from '../plain-words.ts';
import { PullRequestActions, useConnectionInfo, type ConnectionInfo } from '../components/jobs.tsx';

const round1 = (n: number) => Math.round(n * 10) / 10;
const ALL: KindOrAll[] = ['ALL', ...KINDS];
const files = (n: number | null) => (n === null ? 'files not counted' : `${n} ${n === 1 ? 'file' : 'files'}`);
const ONE = { HUMAN: 'Person', AGENT: 'Agent', BOT: 'Bot' } as const;

function Kind({ change }: { change: Change }) {
  const why = change.authorKindSource === 'default' ? 'no signal said otherwise' : `${change.authorKindSource}: ${change.authorKindSignal}`;
  return (
    <span className={`kind kind--${change.authorKind.toLowerCase()}`}>
      · {ONE[change.authorKind]} <span className="field">({why})</span>
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
    header: 'Pull request',
    label: 'Pull request',
    rowHeader: true,
    cell: (r) => (
      <>
        <PrLink change={r.change} withTitle />
        <span className="field"> {r.change.repo}</span>
        {/* One menu in the pull request's own cell, not a column and not a button a row (principle 11): the jobs that apply, and what a missing one needs. */}
        <PullRequestActions change={r.change} info={info} plain={plain} />
      </>
    ),
  },
  {
    header: 'Waiting on',
    label: 'Waiting on',
    cell: (r) => (
      <>
        <strong>{WAITING_LABEL[r.wait.on]}</strong>
        <span className="field"> {r.wait.days === null ? 'for an unknown time' : `for ${daysText(r.wait.days)}`}: {r.wait.why}</span>
      </>
    ),
  },
  { header: 'Author', label: 'Author', cell: (r) => (<>{personText(r.change.author)} <Kind change={r.change} /></>) },
  { header: 'Work items', label: 'Work items', cell: (r) => <Items ids={r.items} /> },
  {
    header: 'Size',
    label: 'Size',
    cell: (r) =>
      r.size.bucket ? (
        <>
          {r.size.bucket} <span className="field">({r.size.lines} lines, {files(r.size.files)})</span>
        </>
      ) : (
        <span className="note">{r.size.files === null ? 'Unknown' : `${files(r.size.files)}, lines not counted`}</span>
      ),
  },
  { header: 'Flags', label: 'Flags', cell: (r) => (r.flags.length ? <ul className="plain flags">{r.flags.map((f) => <li key={f.flag}>{PR_FLAG_LABEL[f.flag]}</li>)}</ul> : 'None') },
];

const fig = (s: Sample, unit: (n: number) => string) => (
  <>
    {s.median === null ? 'No data' : unit(s.median)}
    <span className="field">
      {' '}
      (n={s.n}
      {s.unknown ? `, ${s.unknown} unknown` : ''}
      {s.p85 !== null && s.n > 1 ? `; 85% within ${unit(s.p85)}` : ''})
    </span>
  </>
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

const metricColumns: Array<Column<MetricRow>> = [
  { header: 'Median', label: 'Median', rowHeader: true, cell: (r) => (<>{r.name} <span className="field">{r.note}</span></>) },
  ...ALL.map((k): Column<MetricRow> => ({ header: KIND_LABEL[k], label: KIND_LABEL[k], cell: (r) => fig(r.sample[k], r.unit) })),
];

export function PullRequests() {
  const { dossier, byId, now, sync, config } = useData();
  const plain = usePlain();
  const connections = useConnectionInfo(config);
  const prs = dossier.pullRequests ?? [];
  const queue = openQueue(prs, byId, now);
  const flags = allFlags(prs, byId, now);
  const m = prMetrics(prs, now);
  const rules = Object.fromEntries(Object.entries(dossier.codeowners ?? {}).map(([repo, file]) => [repo, parseCodeowners(file.text)]));
  const unasked = queue.filter((r) => !r.change.reviewers.length);
  const calls = dossier.calls.prs;

  return (
    <PeekLinks>
      <div className="view-head">
        <p className="eyebrow">
          <a href={dossierHref(dossier.name)}>{dossier.name}</a>
        </p>
        <h1 tabIndex={-1} title={plain.title('Pull requests')}>
          {plain.pw('Pull requests', 'Code reviews')}
        </h1>
        <p className="lede">
          {queue.length} open across {new Set(prs.map((c) => c.repo)).size} {new Set(prs.map((c) => c.repo)).size === 1 ? 'repository' : 'repositories'}, {prs.length - queue.length} merged or closed. Read {dateTime(now)}. <Help topic="prs" />
        </p>
        {(dossier.readTargets ?? []).filter((t) => !t.pullRequests).map((t) => (
          <p key={t.label} className="note">
            {t.label}: <a href="#queue">pull requests not read</a>
          </p>
        ))}
        {(dossier.prNotes ?? []).map((n, i) => (
          <p key={i} role="note" className="failure">
            {n}
          </p>
        ))}
      </div>

      <Panel id="queue" title="Waiting now" calls={calls}>
        <p className="note">Open pull requests, longest wait first, each with what it waits on and since when. Drafts come last. Waits count working days, Monday to Friday UTC.</p>
        {queue.length ? <DataTable className="pr-queue" label="Open pull requests" wide rows={queue} rowKey={(r) => r.change.id} columns={queueColumns(connections, plain.on)} /> : <Empty message="No open pull requests for this dossier." action={<SyncOr sync={sync}><EmptyLink edit href={dossierEditHref(dossier.name, 'repos')}>Add a repository</EmptyLink></SyncOr>} />}
      </Panel>

      <Panel id="flags" title="Flags" calls={calls} alerts={false}>
        <p className="note">
          A first review waiting over {PICKUP_DAYS} working days, checks failing for over {FAILING_HOURS} hours, a merge conflict, no linked work item, a work item done while its pull request is open, and a merged pull request whose item isn't done.
        </p>
        {flags.length ? (
          <ul className="rows">
            {flags.map(({ change, hit }) => (
              <li key={`${change.id}:${hit.flag}:${hit.text}`}>
                <strong>{PR_FLAG_LABEL[hit.flag]}</strong>: <PrLink change={change} withTitle />
                <p className="evidence">
                  <Cited text={hit.text} />
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p>Nothing to flag.</p>
        )}
      </Panel>

      <Panel id="flow" title="Flow" calls={calls} alerts={false}>
        <p className="note">
          The {m.throughput.ALL.length} weeks from {dateTime(m.from)}, split by who wrote each pull request. n is how many pull requests a figure rests on; unknown counts those whose record can't say (a host that keeps no review times, or reviews not read).
        </p>
        <DataTable className="pr-metrics" label="Pull request flow by author kind" rows={metricRows(m)} rowKey={(r) => r.name} columns={metricColumns} />
        {m.mergedUnreviewed.ALL > 0 && (
          <p className="note">
            {m.mergedUnreviewed.ALL} merged {m.mergedUnreviewed.ALL === 1 ? 'pull request has' : 'pull requests have'} no approval on record, so review and merge time leave {m.mergedUnreviewed.ALL === 1 ? 'it' : 'them'} out ({KINDS.map((k) => `${KIND_LABEL[k]}: ${m.mergedUnreviewed[k]}`).join(', ')}).
          </p>
        )}
        <h3>Merged per week</h3>
        <ThroughputSpark weeks={m.throughput.ALL} noun="pull requests merged" />
        <p className="note">
          {KINDS.map((k) => `${KIND_LABEL[k]}: ${m.throughput[k].reduce((n, w) => n + w.items.length, 0)}`).join(', ')}.
          {m.unplacedMerges > 0 && ` ${m.unplacedMerges} merged ${m.unplacedMerges === 1 ? 'pull request has' : 'pull requests have'} no merge time on record (Bitbucket Cloud keeps none) and ${m.unplacedMerges === 1 ? "isn't" : "aren't"} counted in a week.`}
        </p>
        <h3>Size of pull requests opened</h3>
        <DataTable
          className="pr-sizes"
          label="Pull request sizes by author kind"
          rows={[...SIZES, 'unknown' as const]}
          rowKey={(s) => s}
          columns={[
            { header: 'Size', label: 'Size', rowHeader: true, cell: (s) => (s === 'unknown' ? <>Unknown <span className="field">(lines not counted)</span></> : <>{s} <span className="field">{s === 'XL' ? `${SIZE_LINES.L + 1}+ lines` : `up to ${SIZE_LINES[s]} lines`}</span></>) },
            ...ALL.map((k): Column<(typeof SIZES)[number] | 'unknown'> => ({ header: `${KIND_LABEL[k]} (n=${m.counts[k]})`, label: KIND_LABEL[k], cell: (s) => m.sizes[k][s] })),
          ]}
        />
      </Panel>

      <Panel id="reviewers" title="Suggested reviewers" calls={dossier.calls.owners ?? []} alerts={false}>
        <p className="note">For open pull requests with nobody asked: the CODEOWNERS of the paths each changes, then who reviewed changes to the same files and folders. Each is a proposal; asking for a review is a write you apply.</p>
        {(dossier.calls.owners ?? []).length > 0 && !Object.keys(dossier.codeowners ?? {}).length && (
          <p className="evidence">No CODEOWNERS file was found where GitHub looks for one (.github/, the repository root, docs/).</p>
        )}
        {Object.entries(dossier.codeowners ?? {}).map(([repo, file]) => (
          <p key={repo} className="evidence">
            {repo}: CODEOWNERS read from <code>{file.path}</code>.
          </p>
        ))}
        {unasked.length ? (
          <ul className="rows">
            {unasked.map(({ change }) => {
              const people = suggestReviewers(change, prs, rules[change.repo] ?? null);
              return (
                <li key={change.id}>
                  <PrLink change={change} withTitle />
                  {people.length ? (
                    <ul className="plain proposals">
                      {people.map((s) => (
                        <li key={s.id}>
                          <ProposalCard proposal={reviewProposal(change, s, dossier.name)} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="note">No one to suggest: no CODEOWNERS rule and no earlier review covers its paths.</p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>Every open pull request has a reviewer asked.</p>
        )}
      </Panel>
    </PeekLinks>
  );
}
