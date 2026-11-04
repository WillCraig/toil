/**
 * The Command Center (#307): every work item in the dossier with its
 * readiness verdict and, for each one that isn't ready, the rows that say
 * why, with filters by verdict, status, type, assignee and source. Every
 * verdict is src/model/readiness.ts over the cached OWI records, with no
 * model call and no live read.
 *
 * The plan is strict: only `ready` items are slated, in the dossier's own
 * order. Starting them is assign-to-agent's (#293): `startReady` on the
 * view's data (src/assign/start.ts) queues an implement assignment for each,
 * and the view says what it queued, or why it started nothing. Where there
 * are no assignments the button stays disabled and says so. Mission control, minus the
 * missions until the paperwork for #293 clears.
 */

import { useMemo, useState } from 'react';
import { Button } from 'react-aria-components';
import { Choice } from '../components/choice.tsx';
import { ItemLink } from '../components/items.tsx';
import { Card, CardGrid, Cluster, DataTable, Stack, type Column } from '../components/layout.tsx';
import { Panel } from '../components/panel.tsx';
import { Help } from '../components/help.tsx';
import { VerdictChip, WhyNot } from '../components/readiness.tsx';
import { useData } from '../data.ts';
import { dateTime, dossierHref, personText, sourceLabel, STATUS_CATEGORY_LABEL } from '../format.ts';
import { usePlain } from '../plain-words.ts';
import { readinessAll, tally, VERDICT_LABEL, VERDICT_PLAIN, VERDICTS, type Readiness, type Verdict } from '../model/readiness.ts';
import { Empty, EmptyButton } from '../components/empty.tsx';
import type { WorkItem } from '../toil.ts';

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Line {
  item: WorkItem;
  readiness: Readiness;
}

/** A short id for a plan, from what is in it: the items, in order, and the state each was read in. */
export function planId(items: WorkItem[]): string {
  let h = 0x811c9dc5;
  for (const c of items.map((i) => `${i.id}@${i.updated ?? ''}@${i.status ?? ''}`).join('\n')) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const STATUS_FILTER = [
  { id: 'open', label: 'Not done' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

const columns: Array<Column<Line>> = [
  { header: 'Item', label: 'Item', rowHeader: true, cell: (l) => <ItemLink id={l.item.id} withTitle /> },
  { header: 'Verdict', label: 'Verdict', cell: (l) => <VerdictChip verdict={l.readiness.verdict} /> },
  { header: 'Why not ready', label: 'Why not ready', cell: (l) => <WhyNot readiness={l.readiness} /> },
  { header: 'Assignee', label: 'Assignee', cell: (l) => personText(l.item.assignee) },
  { header: 'Status', label: 'Status', cell: (l) => `${l.item.status ?? 'None'} (${STATUS_CATEGORY_LABEL[l.item.statusCategory]})` },
];

export function CommandCenter() {
  const { dossier, now, startReady } = useData();
  const plain = usePlain();
  const [started, setStarted] = useState<{ ok: boolean; text: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const settings = dossier.readiness;
  const lines = useMemo<Line[]>(() => {
    const all = readinessAll(dossier.items, settings);
    return dossier.items.map((item, i) => ({ item, readiness: all[i]! }));
  }, [dossier, settings]);
  const [verdict, setVerdict] = useState<'all' | Verdict>('all');
  const [status, setStatus] = useState('open');
  const [type, setType] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [source, setSource] = useState('all');

  const open = lines.filter((l) => l.item.statusCategory !== 'DONE');
  const totals = tally(open.map((l) => l.readiness));
  const slated = open.filter((l) => l.readiness.verdict === 'ready');
  const plan = { id: planId(slated.map((l) => l.item)), items: slated.map((l) => l.item.id) };
  const typeOf = (i: WorkItem) => i.typeName ?? i.type;
  const who = (i: WorkItem) => (i.assignee ? personText(i.assignee) : '');
  const types = [...new Set(lines.map((l) => typeOf(l.item)))].sort();
  const people = [...new Set(lines.map((l) => who(l.item)).filter(Boolean))].sort();
  const areas = [...new Set(lines.map((l) => l.item.source.area))].sort();
  const shown = lines.filter(
    (l) =>
      (status === 'all' || (status === 'done') === (l.item.statusCategory === 'DONE')) &&
      (verdict === 'all' || l.readiness.verdict === verdict) &&
      (type === 'all' || typeOf(l.item) === type) &&
      (assignee === 'all' || (assignee === 'none' ? !l.item.assignee : who(l.item) === assignee)) &&
      (source === 'all' || l.item.source.area === source),
  );
  const calls = [...dossier.calls.dossier, ...dossier.calls.work];

  return (
    <>
      <div className="view-head">
        <p className="eyebrow">
          <a href={dossierHref(dossier.name)}>{dossier.name}</a>
        </p>
        <h1 tabIndex={-1} title={plain.title('Command Center')}>
          {plain.pw('Command Center', 'Ready to start?')}
        </h1>
        <p className="lede">
          {plain.on ? `Every item in ${dossier.name}, marked ready or not and, if not, why, from the records read ${dateTime(now)}.` : <>Every work item in {dossier.name}, each with its readiness verdict and, where it isn't ready, why, from the records read {dateTime(now)}.</>} <Help topic="readiness" />
        </p>
        {settings.notes.map((n, i) => (
          <p key={i} role="note" className="failure">
            {n}
          </p>
        ))}
      </div>

      <CardGrid as="ul" min="sm" className="team-strip readiness-tally" aria-label="Open items by verdict">
        {VERDICTS.map((v) => (
          <li key={v}>
            <Stack gap="xs" className="team-tile">
              <h2 className="readiness-tally__head">
                <VerdictChip verdict={v} />
              </h2>
              <p className="team-figure">{totals[v]}</p>
              <p className="note">{v === 'ready' ? 'Every check passes.' : v === 'thin' ? plain.pw('Missing acceptance criteria, description or another check a person can waive.', 'Missing "done when" criteria, a description or another check a person can waive.') : plain.pw('Done already, blocked by an open item, or outside the dossier.', 'Done already, blocked by an open item, or outside the Toil project.')}</p>
            </Stack>
          </li>
        ))}
      </CardGrid>

      <Card as="section" className="panel readiness-slate" aria-labelledby="slate">
        <h2 id="slate">Start every ready item</h2>
        <p>
          {slated.length
            ? plain.text(`${count(slated.length, 'item is', 'items are')} ready and would be slated, in the dossier's order (plan ${plan.id}).`)
            : 'No open item is ready, so nothing would be slated. The list below says what each one is missing.'}
        </p>
        {slated.length > 0 && (
          <ul className="plain cites" aria-label="Slated items">
            {slated.map((l) => (
              <li key={l.item.id}>
                <ItemLink id={l.item.id} withTitle />
              </li>
            ))}
          </ul>
        )}
        <Cluster className="readiness-start">
          <Button
            className="btn"
            isDisabled={!startReady || slated.length === 0 || starting}
            onPress={async () => {
              if (!startReady) return;
              setStarting(true);
              try {
                setStarted({ ok: true, text: await startReady(plan) });
              } catch (e) {
                setStarted({ ok: false, text: e instanceof Error ? e.message : String(e) });
              } finally {
                setStarting(false);
              }
            }}
            aria-describedby="slate-note"
          >
            Start {count(slated.length, 'ready item')}
          </Button>
          <p id="slate-note" className="note">
            {startReady ? plain.pw('Assigns each item above to an agent in implement mode, as listed: proposals wait for you, and nothing leaves this machine until you apply one.', 'Asks an AI helper to try a fix for each item above, as listed: its suggestions wait for you, and nothing leaves this computer until you approve one.') : plain.text('This view has no agent assignments, so it shows the plan it would start.')}
          </p>
        </Cluster>
        <p className={started && !started.ok ? 'failure' : 'note'} role="status">
          {started?.text ?? ''}
        </p>
      </Card>

      <Panel id="cc-items" title="Items" calls={calls}>
        <Cluster className="readiness-filters" role="group" aria-label="Filter the items">
          <Choice label="Verdict" value={verdict} onChange={(v) => setVerdict(v as 'all' | Verdict)} options={[{ id: 'all', label: 'All' }, ...VERDICTS.map((v) => ({ id: v, label: (plain.on ? VERDICT_PLAIN : VERDICT_LABEL)[v] }))]} />
          <Choice label="Status" value={status} onChange={setStatus} options={STATUS_FILTER} />
          <Choice label="Type" value={type} onChange={setType} options={[{ id: 'all', label: 'All' }, ...types.map((t) => ({ id: t, label: t }))]} />
          <Choice label="Assignee" value={assignee} onChange={setAssignee} options={[{ id: 'all', label: 'Anyone' }, { id: 'none', label: 'Unassigned' }, ...people.map((p) => ({ id: p, label: p }))]} />
          {areas.length > 1 && <Choice label="Source" value={source} onChange={setSource} options={[{ id: 'all', label: 'All' }, ...areas.map((a) => ({ id: a, label: `${sourceLabel(a)} (${a})` }))]} />}
        </Cluster>
        <p className="note" aria-live="polite">
          Showing {count(shown.length, 'item')} of {lines.length}.
        </p>
        {shown.length ? (
          <DataTable label="Items and their readiness" caption={`${dossier.name}'s items and their readiness`} columns={columns} rows={shown} rowKey={(l) => l.item.id} wide />
        ) : (
          <Empty
            message="No item matches these filters."
            action={
              <EmptyButton
                onPress={() => {
                  setVerdict('all');
                  setStatus('all');
                  setType('all');
                  setAssignee('all');
                  setSource('all');
                }}
              >
                Show every item
              </EmptyButton>
            }
          />
        )}
      </Panel>
    </>
  );
}
