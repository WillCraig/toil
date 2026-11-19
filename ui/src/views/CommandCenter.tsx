/**
 * The Command Center (#307): every work item in the toil project with its
 * readiness verdict and, for each one that isn't ready, the rows that say
 * why, with filters by verdict, status, type, assignee and source. Every
 * verdict is src/model/readiness.ts over the cached OWI records, with no
 * model call and no live read.
 *
 * The plan is strict: only `ready` items are slated, in the toil project's own
 * order. Starting them is assign-to-agent's (#293): `startReady` on the
 * view's data (src/assign/start.ts) queues an implement assignment for each,
 * and the view says what it queued, or why it started nothing. Where there
 * are no assignments the button stays disabled and says so. Mission control, minus the
 * missions until the paperwork for #293 clears.
 *
 * Where the toil project names ticket rules (#657), a "Ticket rules" card says,
 * one line a standard, how many of the open items its rules apply to miss
 * them; each line is a full-width button that filters the list to those items
 * (`?rule=<standard>/<rule>` for a one-rule standard, `?rule=<standard>` for
 * any rule of one with several), and the filtered rule's line leads each
 * item's "Why not ready", so the figure and the items behind it are one press
 * apart. This is the Tickets tab (#657); the sprint board is a drill-in from
 * here and from the Summary, "Open the board", a quiet button on the heading row. The ready items fold to one
 * line, "16 ready" and its Start button, with the items one press in; the filter bar sits with the table it filters.
 */

import { useMemo, useState } from 'react';
import { Button } from 'react-aria-components';
import { ItemLink, ItemRow } from '../components/items.tsx';
import { DisclosureBody, SummaryChevron } from '../components/disclosure.tsx';
import { Card, CardGrid, DataTable, Stack, type Column } from '../components/layout.tsx';
import { Panel } from '../components/panel.tsx';
import { Help, InfoTip } from '../components/help.tsx';
import { FilterBar } from '../components/filter-bar.tsx';
import { VerdictChip, WhyNot } from '../components/readiness.tsx';
import { useData } from '../data.ts';
import { asMapped } from '../model/people.ts';
import { NO_FILTERS, toWhere, writeFilters } from '../filters.ts';
import { useAddress, useWorkInsights } from '../insights-data.ts';
import { boardHref, dateTime, toilProjectHref, personText, STATUS_CATEGORY_LABEL } from '../format.ts';
import { NavButton } from '../components/nav-button.tsx';
import { useFocusArrival } from '../motion.ts';
import { usePlain } from '../plain-words.ts';
import { BLOCKED_WHY, readinessAll, tally, VERDICT_PLAIN, VERDICTS, withRules, type Readiness, type Row, type Verdict } from '../model/readiness.ts';
import { lineWhat, matchesRef, missing, ruleLines, ruleName } from '../rules.ts';
import { Unread } from '../components/unread.tsx';
import { Empty, EmptyLink } from '../components/empty.tsx';
import type { Person, WorkItem } from '../toil.ts';
import { AgentMark } from '../components/agent-mark.tsx';

const NOTHING_READY = 'No open item is ready, so nothing would be slated. The list below says what each one is missing.';
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Line {
  item: WorkItem;
  readiness: Readiness;
  /** The assignee as the toil project's people map them, so one person with two accounts is one name in the column and the filter. */
  assignee: Person | null;
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

/** An item's status once (#657): the tracker's own word, with the category it falls in one hover away. */
export function StatusText({ item }: { item: WorkItem }) {
  const category = STATUS_CATEGORY_LABEL[item.statusCategory];
  if (!item.status) return <>{category}</>;
  return item.status.toLowerCase() === category.toLowerCase() ? <>{item.status}</> : <span title={`Counted as ${category.toLowerCase()}`}>{item.status}</span>;
}

/**
 * "Why not ready" as one figure a cell (ui/README.md, Tables and rows): how many checks it misses, and how many weren't
 * read, with the sentences one press in. Nothing is dropped, only folded; the filtered ticket rule's line still leads.
 */
function WhyCell({ readiness, ruleRef }: { readiness: Readiness; ruleRef: string | null }) {
  if (!readiness.why.length) return <span className="note">None</span>;
  const missed = readiness.why.filter((r) => r.state !== 'skipped').length;
  const unread = readiness.why.length - missed;
  const figure = [missed ? count(missed, 'check') + ' missed' : '', unread ? `${count(unread, 'rule')} not read yet` : ''].filter(Boolean).join(', ');
  return (
    <details className="cell-more cell-more--block" data-why-cell="">
      <summary>{figure}</summary>
      <WhyNot readiness={readiness} {...(ruleRef ? { first: (r: Row) => Boolean(r.rule && matchesRef(ruleRef, r.rule)) } : {})} />
    </details>
  );
}

/** The list's columns; with a ticket rule filtered on, its line leads each item's "Why not ready". */
const columnsFor = (ruleRef: string | null): Array<Column<Line>> => [
  { header: 'Item', label: 'Item', rowHeader: true, cell: (l) => <ItemLink id={l.item.id} withTitle /> },
  { header: 'Verdict', label: 'Verdict', cell: (l) => <VerdictChip verdict={l.readiness.verdict} /> },
  { header: 'Why not ready', label: 'Why not ready', cell: (l) => <WhyCell readiness={l.readiness} ruleRef={ruleRef} /> },
  { header: 'Assignee', label: 'Assignee', cell: (l) => personText(l.assignee) },
  { header: 'Status', label: 'Status', cell: (l) => <StatusText item={l.item} /> },
];

/** What a tile says under its figure. Ready claims every check only for the items that pass every one: one whose rules weren't read is its own tile (principle 12). */
const TILE_NOTE: Record<Verdict, string> = {
  ready: 'Every check passes.',
  thin: 'Missing "done when" criteria, a description or another check a person can waive.',
  blocked: BLOCKED_WHY,
  unread: "Nothing fails, but the ticket rules weren't read for these yet.",
};

export function CommandCenter() {
  const { toilProject, now, startReady, rules } = useData();
  const plain = usePlain();
  const [started, setStarted] = useState<{ ok: boolean; text: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const settings = useMemo(() => withRules(toilProject.readiness, rules?.reading), [toilProject, rules]);
  // The shared filter bar (#567), the Board's own: "Fix version: 2.4" narrows this list, its tally and its plan alike.
  const ins = useWorkInsights();
  const { filters, query, hrefWith } = useAddress();
  // A ticket rule's line drills here: the list keeps only the items that miss it.
  const ruleRef = query.get('rule');
  const checked = rules?.view?.result ?? null;
  const missingRule = ruleRef && checked ? missing(checked, ruleRef) : null;
  const lines = useMemo<Line[]>(() => {
    const all = readinessAll(toilProject.items, settings);
    const where = toWhere(filters);
    const allowed = where.length === 0 ? null : new Set(ins.narrow(where).items.map((i) => i.id));
    return toilProject.items.flatMap((item, i) => (allowed && !allowed.has(item.id) ? [] : [{ item, readiness: all[i]!, assignee: asMapped(toilProject.people ?? [], item.source.area, item.assignee) }]));
  }, [toilProject, settings, ins, filters]);
  // One way to filter (#657): the shared filter bar for every dimension, and the verdict tiles above, each a button that
  // keeps only its verdict. Both live in the address, so Back undoes either and a copied link opens the same list.
  const verdictKey = query.get('verdict');
  const verdict: Verdict | null = verdictKey && (VERDICTS as readonly string[]).includes(verdictKey) ? (verdictKey as Verdict) : null;
  // Done items stay out unless a status category filter asks for them.
  const byStatus = filters.where.some((w) => w.dimension === 'statusCategory');

  const open = lines.filter((l) => l.item.statusCategory !== 'DONE');
  const totals = tally(open.map((l) => l.readiness));
  const exact = !open.some((l) => l.readiness.rows.some((row) => row.check === 'rules'));
  const slated = open.filter((l) => l.readiness.verdict === 'ready');
  const plan = { id: planId(slated.map((l) => l.item)), items: slated.map((l) => l.item.id) };
  const shown = lines.filter(
    (l) =>
      (byStatus || l.item.statusCategory !== 'DONE') &&
      (!verdict || l.readiness.verdict === verdict) &&
      (!ruleRef || !missingRule || missingRule.has(l.item.id)),
  );
  const verdictHref = (v: Verdict | null) => hrefWith((q) => (v ? q.set('verdict', v) : q.delete('verdict')));
  const everything = hrefWith((q) => {
    q.delete('verdict');
    q.delete('rule');
    writeFilters(q, NO_FILTERS);
  });
  // Opened from a rule's line or the Summary's Ticket rules card, the filter it set is brought into view and ringed (src/motion.ts).
  useFocusArrival(ruleRef ? `rule:${ruleRef}` : null);
  const withRule = (ref: string | null) => hrefWith((q) => (ref ? q.set('rule', ref) : q.delete('rule')));
  const showRules = settings.standards.length > 0 || (checked?.standards.length ?? 0) > 0;
  const linesOfRules = checked ? ruleLines(checked, open.map((l) => l.item)) : [];
  const missed = linesOfRules.filter((r) => r.miss > 0 || r.skipped > 0);
  const met = linesOfRules.filter((r) => r.miss === 0 && r.skipped === 0).reduce((n, r) => n + r.rules.length, 0);
  const calls = [...toilProject.calls.toilProject, ...toilProject.calls.work];

  return (
    <>
      <div className="view-head">
        <p className="eyebrow">
          <NavButton href={toilProjectHref(toilProject.name)} kind="quiet" size="sm" className="eyebrow-btn">
            {toilProject.name}
          </NavButton>
        </p>
        <div className="view-head__row">
          <h1 tabIndex={-1} title={plain.title('Command Center')}>
            {plain.pw('Command Center', 'Ready to start?')}
          </h1>
          <NavButton href={boardHref(toilProject.name)} kind="secondary" size="sm" data-open-board="">
            Open the board
          </NavButton>
        </div>
        {/* The lede was an explanation, so it is the heading's (i) (#657); when the records were read stays as the source. */}
        <p className="note">
          From the records read {dateTime(now)}. <Help topic="readiness" note={`Every item in ${toilProject.name}, marked ready or not and, if not, why.`} />
        </p>
        {settings.notes.map((n, i) => (
          <p key={i} role="note" className="failure">
            {n}
          </p>
        ))}
      </div>

      <CardGrid as="ul" min="sm" className="team-strip readiness-tally" aria-label="Open items by verdict">
        {VERDICTS.filter((v) => v !== 'unread' || totals.unread > 0).map((v) => (
          <li key={v}>
            {/* Each tile is the verdict filter (#657): pressing it keeps only its items, pressing it again shows them all. */}
            <a className="team-tile readiness-tile" href={verdictHref(verdict === v ? null : v)} aria-current={verdict === v ? 'true' : undefined} data-press="" data-verdict-tile={v}>
              <Stack gap="xs">
                <h2 className="readiness-tally__head">
                  <VerdictChip verdict={v} />
                </h2>
                {/* While some rules aren't read, Blocked is a floor: a rule may yet fail an item (principle 12). */}
                <p className="team-figure" {...(v === 'blocked' && !exact ? { title: "Ticket rules not read yet for some items, so more may be blocked." } : {})}>
                  {v === 'blocked' && !exact ? `${totals[v]}+` : totals[v]}
                </p>
                <p className="note">{TILE_NOTE[v]}</p>
              </Stack>
            </a>
          </li>
        ))}
      </CardGrid>

      {showRules && (
        <Card as="section" className="panel readiness-rules" aria-labelledby="ticket-rules" data-ticket-rules="">
          <h2 id="ticket-rules">
            Ticket rules <Help topic="ticket-rules" />
          </h2>
          {/* What toil skipped or ignored reading the rules is said in its own words and always shown (principle 4). */}
          {(rules?.reading.warnings.length ?? 0) > 0 && (
            <ul className="plain readiness-rules__warnings" data-rules-warnings="">
              {rules!.reading.warnings.map((w) => (
                <li key={w} role="note" className="warning-line">
                  {w}
                </li>
              ))}
            </ul>
          )}
          {rules?.reading.state === 'failed' ? (
            <p role="alert" className="failure">
              Couldn't check the ticket rules: {rules.reading.message}
            </p>
          ) : !checked ? (
            <p>
              <Unread /> <span aria-hidden="true">not read yet</span>
            </p>
          ) : linesOfRules.length === 0 ? (
            <p>No open item here is one the rules apply to.</p>
          ) : (
            <>
              {missed.length > 0 && (
                <ul className="plain readiness-rules__lines">
                  {missed.map((r) => (
                    <li key={r.ref}>
                      <NavButton href={withRule(r.ref)} kind="quiet" row aria-current={ruleRef === r.ref ? 'true' : undefined} data-rule-line={r.ref}>
                        <strong>
                          {r.miss} of {r.applies}
                        </strong>{' '}
                        {r.noun(r.applies)}: {lineWhat(r)}
                        {r.skipped > 0 && <span className="note">, {r.skipped} not checked</span>}
                      </NavButton>
                    </li>
                  ))}
                </ul>
              )}
              {met > 0 && <p className="note">{missed.length === 0 ? `Every open item meets all ${count(met, 'rule')}.` : `Every open item meets the other ${count(met, 'rule')}.`}</p>}
            </>
          )}
        </Card>
      )}

      <Card as="section" className="panel readiness-slate" aria-labelledby="slate">
        {/* One line, the count and its button (#657); the items it would start are one press in, so the card isn't a list. */}
        <div className="readiness-slate__line">
          <span className="control-row__group">
            <h2 id="slate" title={slated.length ? `Plan ${plan.id}` : undefined}>
              {slated.length ? `${slated.length} ready` : 'Nothing ready'}
            </h2>
            {/* Why nothing is slated is an explanation, so it is the heading's (i) (#657); the card keeps the heading and Start. */}
            {slated.length === 0 && (
              <InfoTip label="nothing ready" tip={NOTHING_READY} triggerProps={{ 'data-nothing-ready': '' }}>
                <p>{NOTHING_READY}</p>
              </InfoTip>
            )}
          </span>
          <span className="control-row__group">
          <Button
            className="btn btn--sm"
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
            aria-label={`Start ${count(slated.length, 'ready item')}`}
            {...(startReady ? {} : { 'aria-describedby': 'slate-note' })}
          >
            <AgentMark />
            Start {slated.length}
          </Button>
          {startReady && <Help topic="start-ready" />}
          </span>
        </div>
        {slated.length > 0 ? (
          <details className="readiness-slate__items">
            <summary>
              <SummaryChevron />
              {plain.text(`Which ${slated.length === 1 ? 'one' : count(slated.length, 'item')}, in the Toil project's order`)}
            </summary>
            <DisclosureBody>
              <ul className="plain item-rows" aria-label="Slated items">
                {slated.map((l) => (
                  <li key={l.item.id}>
                    <ItemRow id={l.item.id} />
                  </li>
                ))}
              </ul>
            </DisclosureBody>
          </details>
        ) : null}
        {/* What Start does is in its (i) (principle 11, #657); only the state that it can't start stays on screen. */}
        {!startReady && (
          <p id="slate-note" className="note">
            {plain.text('This view has no agent assignments, so it shows the plan it would start.')}
          </p>
        )}
        <p className={started && !started.ok ? 'failure' : 'note'} role="status">
          {started?.text ?? ''}
        </p>
      </Card>

      <Panel id="cc-items" title="Items" calls={calls}>
        <FilterBar period={false} />
        {verdict && (
          <p className="readiness-rule-filter" data-verdict-filter={verdict}>
            <span>
              Verdict: <strong>{VERDICT_PLAIN[verdict]}</strong>
            </span>
            <NavButton href={verdictHref(null)} size="sm">
              Clear<span className="sr-only"> the verdict filter</span>
            </NavButton>
          </p>
        )}
        {ruleRef && (
          <p className="readiness-rule-filter" data-rule-filter={ruleRef} data-focus-id={`rule:${ruleRef}`}>
            <span>
              Missing: <strong>{(checked && ruleName(checked, ruleRef)) ?? ruleRef}</strong>
              {checked && !missingRule && <span className="note"> (not one of this Toil project's rules)</span>}
            </span>
            <NavButton href={withRule(null)} size="sm">
              Clear<span className="sr-only"> the ticket rule filter</span>
            </NavButton>
          </p>
        )}
        <p className="note" aria-live="polite">
          Showing {count(shown.length, 'item')} of {lines.length}{byStatus ? '' : ', not done'}.
        </p>
        {shown.length ? (
          <DataTable label="Items and their readiness" caption={`${toilProject.name}'s items and their readiness`} columns={columnsFor(ruleRef)} rows={shown} rowKey={(l) => l.item.id} wide />
        ) : (
          <Empty message="No item matches these filters." action={<EmptyLink href={everything}>Show every item</EmptyLink>} />
        )}
      </Panel>
    </>
  );
}
