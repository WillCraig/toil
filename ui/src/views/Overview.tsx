/**
 * A toil project's home (#494, replacing #394's Overview): the briefing, one layer
 * at a time. The status sentence first, as the biggest text (#552), one line
 * on why and at most three cards for what needs attention; then, behind "Show
 * the full briefing", the recommendation as a sentence and the reasons behind
 * it, each one line, the first open; each item a row that opens its drawer;
 * what is on track counted, not listed; and, one step in, anything the
 * toil project's focus left out or the code flagged that Analyze didn't mention.
 * The numbers wait behind a fold, and every other view is a quiet link away
 * as well as a tab. Analyze writes it when its latest answer is current;
 * otherwise code does, and the page says which (principle 4). Briefing notes,
 * with the appendix stapled to the back rather than the front.
 */

import { useMemo, type ReactNode } from 'react';
import { Button, Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { Sparkline } from '../components/charts.tsx';
import { briefingSource, Customize, PeekLinks, useBriefing } from '../components/briefing.tsx';
import { setPrefs, useBriefingPrefs } from '../briefing-prefs.ts';
import { AnswerHero, NeedsAttention } from '../components/summary.tsx';
import { answerOf, cardsOf, contextOf } from '../model/summary.ts';
import { parseRoute } from '../App.tsx';
import { Help } from '../components/help.tsx';
import { Cited, PrLink } from '../components/items.tsx';
import { useData, useDerived } from '../data.ts';
import { analysesHref, analysisHref, boardHref, dependenciesHref, itemHref, peekHref, peopleHref, personText, prsHref, shortKey, sourceLabel, standupHref, toilProjectEditHref, worklogHref } from '../format.ts';
import { Empty, TrackerAction } from '../components/empty.tsx';
import { burnup } from '../model/burnup.ts';
import { aging, cycleTimes, throughput } from '../model/flow.ts';
import { WAITING_LABEL, daysText, openQueue } from '../model/prs.ts';
import type { BriefingReason } from '../model/briefing.ts';
import { useSkins, useWords } from '../skins.tsx';
import { usePlain } from '../plain-words.ts';
import { StandupCard } from '../components/standup-card.tsx';
import { Aging, CycleTime, SprintDetail, Throughput } from './Flow.tsx';

const round1 = (n: number) => Math.round(n * 10) / 10;

export function Overview() {
  const { toilProject, byId, now, worklog } = useData();
  const { health: h, insights: p } = useDerived();
  const view = useBriefing();
  const prefs = useBriefingPrefs();
  const plain = usePlain();
  // Worked out once per briefing and clock, from the models the full briefing below reads, so the two can't disagree.
  const { answer, cards } = useMemo(() => {
    const c = contextOf({ d: toilProject, now, byId, h, p, view, plain: plain.on });
    return { answer: answerOf(c), cards: cardsOf(c) };
  }, [toilProject, now, byId, h, p, view, plain.on]);
  // Customize never hides a red reason (principle 4 outranks a layout preference). The fold can close over it, so a red reason no card tells is a line outside the fold (alerts, below).
  const shown = view.reasons.filter((r) => r.severity === 'danger' || !prefs.hidden.includes(r.lens));
  const hidden = view.reasons.length - shown.length;
  // The red reasons no card above already tells: the biggest risk is the first reason, and the other two cards are the blocked and waiting lenses.
  const covered = new Set<string>([cards.some((c) => c.id === 'risk') ? (view.reasons[0]?.lens ?? '') : '', cards.some((c) => c.id === 'blocked') ? 'blocked' : '', cards.some((c) => c.id === 'review') ? 'waiting' : '']);
  const alerts = view.reasons.filter((r) => r.severity === 'danger' && !covered.has(r.lens));
  const here = typeof window === 'undefined' ? '#/' : window.location.hash;
  // Whose settings tuned this briefing, whenever a toil project tunes it (#494): its file, and whether it's the reader's own.
  const tuned = toilProject.analyze && Object.keys(toilProject.analyze).length ? toilProject.origin : null;
  return (
    <section className="briefing" aria-label="Briefing" data-rec-source={view.by === 'analyze' ? 'analysis' : 'code'}>
      <AnswerHero answer={answer} />
      {/* The sprint and its day are on the header's chip; saying it twice is a second signature on the same form. */}
      <p className="briefing__meta">
        <span className="briefing__by source" data-briefing-by={view.by}>
          {briefingSource(view, plain.on)}
          {view.stale && `. ${view.stale}`}
          {view.analysis && (
            <>
              {' · '}
              <a href={analysisHref(toilProject.name, view.analysis.id)} data-rec-analysis="" title={plain.title('Open the analysis')}>
                {plain.pw('Open the analysis', 'Open that briefing')}
              </a>
            </>
          )}
        </span>
      </p>
      {/* A briefing that didn't parse, or named items this toil project lacks, is said up here: a layout fold never hides it. */}
      {view.problems.map((p) => (
        <p key={p} className="briefing__warning" role="note">
          {p}
        </p>
      ))}
      {view.unknown.length > 0 && (
        <p className="briefing__warning" role="note">
          {plain.pw('Analyze', 'The briefing')} named {view.unknown.length === 1 ? 'an item' : `${view.unknown.length} items`} that {view.unknown.length === 1 ? "isn't" : "aren't"} {"this Toil project's"}: <code>{view.unknown.join(', ')}</code>. Treat {view.unknown.length === 1 ? 'it' : 'them'} as unverified.
        </p>
      )}
      <NeedsAttention cards={cards} />
      {/* What principle 4 keeps on screen when the fold is closed: a red reason no card covers, and what couldn't be read. */}
      {(alerts.length > 0 || view.unchecked.length > 0 || view.partlyChecked.length > 0) && (
        <div className="reasons briefing__alerts" data-alerts="">
          {alerts.map((r) => (
            <p key={r.lens} className="reason reason--line" data-alert={r.lens}>
              <span className="reason__dot reason__dot--danger" aria-hidden="true" />
              <button type="button" className="reason__jump" onClick={() => showReason(r.lens)}>
                <b>{r.label}</b>
                {r.items.length > 0 && <span className="reason__count">{r.items.length}</span>}
                <span className="sr-only">, show it in the full briefing</span>
              </button>
            </p>
          ))}
          {/* A lens that didn't run and one that ran with items it couldn't test are different news, so each has its own line. */}
          {(
            [
              ['unchecked', "Couldn't check.", view.unchecked],
              ['partly-checked', 'Partly checked.', view.partlyChecked],
            ] as const
          ).map(
            ([id, heading, list]) =>
              list.length > 0 && (
                <details key={id} className="reason" data-unchecked={id === 'unchecked' ? '' : undefined} data-partly-checked={id === 'partly-checked' ? '' : undefined}>
                  <summary>
                    <span className="reason__dot" aria-hidden="true" />
                    <span className="reason__title">
                      <b>{heading}</b> <span>{list.map((u) => u.label).join(', ')}</span>
                    </span>
                  </summary>
                  <div className="reason__body">
                    {list.map((u) => (
                      <p key={u.label}>
                        {u.label}: {u.note}
                        {id === 'unchecked' && u.lens === 'load' && (
                          <>
                            {' '}
                            <a href={toilProjectEditHref(toilProject.name, 'wip')}>Set one in the Toil project's settings</a>.
                          </>
                        )}
                      </p>
                    ))}
                  </div>
                </details>
              ),
          )}
        </div>
      )}
      {worklog && <StandupCard api={worklog} />}
      <details
        className="briefing__full"
        open={prefs.fullOpen}
        onToggle={(e) => {
          if (e.currentTarget.open !== prefs.fullOpen) setPrefs({ fullOpen: e.currentTarget.open });
        }}
        data-full-briefing=""
      >
        <summary>Show the full briefing</summary>
        <p className="briefing__meta">
          <Customize lenses={view.reasons.filter((r) => r.severity !== 'danger').map((r) => ({ lens: r.lens, label: r.label }))} />
          {tuned && (
            <span className="source" data-focus-from="">
              {plain.pw('Analyze settings', 'Briefing settings')} from {tuned.file}, {tuned.adopted ? 'your own Toil project' : "a Toil project you haven't adopted"}
            </span>
          )}
        </p>
        <Links page={prefs.opensIn === 'page'}>
          <h2 className="sr-only">Recommendation</h2>
          <p className="briefing__head">{view.recommendation ? <Cited text={view.recommendation} /> : 'Nothing needs anyone right now.'}</p>
        <section aria-labelledby="why-title">
          <h2 id="why-title" className="briefing__label">
            Why <Help topic="briefing" />
          </h2>
          <div className="reasons">
            {shown.map((r, i) => (
              <Reason key={`${r.lens}-${i}`} reason={r} open={i === 0 && prefs.firstOpen} here={here} />
            ))}
            <div className="reason reason--quiet">
              <p className="reason__line">
                <span className="reason__dot reason__dot--ok" aria-hidden="true" />
                <span className="reason__title">
                  <b>On track.</b> <span>{plain.text(view.onTrack)}</span>
                  {hidden > 0 && <span> {hidden === 1 ? 'One reason is' : `${hidden} reasons are`} hidden under Customize.</span>}
                </span>
              </p>
            </div>
            {view.leftOut.length > 0 && (
              <details className="reason" data-left-out="">
                <summary>
                  <span className="reason__dot" aria-hidden="true" />
                  <span className="reason__title">
                    <b>{"Left out by the Toil project's focus."}</b> <span>{plain.pw('Analyze set these aside because of "leave out".', 'The briefing set these aside because of "leave out".')}</span>
                  </span>
                  <span className="reason__count">{view.leftOut.length}</span>
                </summary>
                <div className="reason__body">{view.leftOut.map((l) => <Row key={l.id} id={l.id} note={l.why} here={here} />)}</div>
              </details>
            )}
            {view.notMentioned.length > 0 && (
              <details className="reason" data-not-mentioned="">
                <summary>
                  <span className="reason__dot reason__dot--warn" aria-hidden="true" />
                  <span className="reason__title">
                    <b>{plain.pw('Flagged by code, not in the briefing.', "Flagged by the app's rules, not in the briefing.")}</b> <span>{plain.pw("Analyze didn't mention these.", "The briefing didn't mention these.")}</span>
                  </span>
                  <span className="reason__count">{view.notMentioned.length}</span>
                </summary>
                <div className="reason__body">{view.notMentioned.map((i) => <Row key={i.id} id={i.id} note={i.why} here={here} />)}</div>
              </details>
            )}
          </div>
        </section>
        {view.changed.length > 0 && (
          <section aria-labelledby="changed-title">
            <h2 id="changed-title" className="briefing__label">
              Since the last briefing
            </h2>
            <ul className="rows">
              {view.changed.map((c, i) => (
                <li key={i}>
                  <Cited text={c} />
                </li>
              ))}
            </ul>
          </section>
        )}
        </Links>
        <details className="briefing__numbers" open={prefs.numbersOpen}>
          <summary>The numbers</summary>
          <MetricStrip />
        </details>
        </details>
      <nav className="briefing__links" aria-label={`More on ${toilProject.name}`}>
        <span className="briefing__label">Go to</span>
        <a href={boardHref(toilProject.name)}>Board</a>
        <a href={dependenciesHref(toilProject.name)} title={plain.title('Dependencies')}>{plain.pw('Dependencies', 'What blocks what')}</a>
        <a href={prsHref(toilProject.name)} title={plain.title('Pull requests')}>{plain.pw('Pull requests', 'Code reviews')}</a>
        <a href={peopleHref(toilProject.name)}>People</a>
        {worklog && <a href={standupHref(toilProject.name)}>Stand-up</a>}
        <a href={worklogHref(toilProject.name)} title={plain.title('Worklog')}>{plain.pw('Worklog', 'What happened')}</a>
        <a href={analysesHref(toilProject.name)} title={plain.title('Analyses')}>{plain.pw('Analyses', 'Past briefings')}</a>
      </nav>
    </section>
  );
}

/** Opens the full briefing and the reason a line outside it names, and puts the keyboard on it. */
function showReason(lens: string) {
  setPrefs({ fullOpen: true });
  setTimeout(() => {
    const d = document.querySelector<HTMLDetailsElement>(`details[data-reason="${CSS.escape(lens)}"]`);
    if (!d) return;
    d.open = true;
    d.scrollIntoView({ block: 'center' });
    d.querySelector('summary')?.focus();
  });
}

/** Item links on the briefing: to the drawer, unless the person chose the item's page under Customize. */
function Links({ page, children }: { page: boolean; children: ReactNode }) {
  return page ? <>{children}</> : <PeekLinks>{children}</PeekLinks>;
}

/** One reason: a line, folded; open, its items as rows that open the drawer, or its text. */
function Reason({ reason: r, open, here }: { reason: BriefingReason; open: boolean; here: string }) {
  return (
    <details className="reason" open={open} data-reason={r.lens}>
      <summary>
        <span className={`reason__dot reason__dot--${r.severity}`} aria-hidden="true" />
        <span className="reason__title">
          <b>{r.label}.</b> <span>{r.line}</span>
        </span>
        {r.items.length > 0 && <span className="reason__count">{r.items.length}</span>}
      </summary>
      <div className="reason__body">
        {r.text && (
          <p>
            <Cited text={r.text} />
          </p>
        )}
        {r.items.map((i) => (
          <Row key={i.id} id={i.id} here={here} />
        ))}
      </div>
    </details>
  );
}

/** One item as a row: key, title and who, opening its drawer; a note under it when there's one to give. */
function Row({ id, here, note }: { id: string; here: string; note?: string }) {
  const { byId, toilProject } = useData();
  const { opensIn } = useBriefingPrefs();
  const item = byId.get(id);
  const current = parseRoute(here).peek === id;
  return (
    <>
      <a className="reason-row" href={opensIn === 'page' ? itemHref(toilProject.name, id) : peekHref(here, id)} aria-current={current ? 'true' : undefined} data-row={id}>
        <span className="reason-row__key">{item ? `${sourceLabel(item.source.area)} ${shortKey(item)}` : id}</span>
        <span className="reason-row__title">{item?.title ?? 'Not in this Toil project'}</span>
        <span className="reason-row__who">{item ? personText(item.assignee) : ''}</span>
      </a>
      {note && (
        <p className="note">
          <Cited text={note} />
        </p>
      )}
    </>
  );
}

/** One metric: its name, its figure in words, a sparkline, and, pressed, its full chart in a dialog. */
function Metric({ id, label, value, unit, spark, title, children }: { id: string; label: string; value: string; unit: string; spark: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="metric">
      <DialogTrigger>
        {/* Its name is its visible words, then what pressing does, so voice control finds it by what it shows (WCAG 2.5.3). */}
        <Button className="metric__button" data-metric={id}>
          <span className="metric__label">{label}</span>{' '}
          <span className="metric__figure">
            <span className="metric__value">{value}</span> <span className="metric__unit">{unit}</span>
          </span>
          <span className="sr-only">, show the full chart</span>
          {spark}
        </Button>
        <ModalOverlay className="feedback-overlay" data-backdrop="" isDismissable>
          <Modal className="feedback-modal chart-modal">
            <Dialog className="feedback-dialog chart-dialog">
              {({ close }) => (
                <div className="chart-dialog__body">
                  <div className="chart-dialog__head">
                    <Heading slot="title">{title}</Heading>
                    <Button className="btn btn--small" onPress={close} data-chart-close="">
                      Close
                    </Button>
                  </div>
                  {children}
                </div>
              )}
            </Dialog>
          </Modal>
        </ModalOverlay>
      </DialogTrigger>
    </li>
  );
}

/** The metrics as sparklines (#394): burn-up, throughput, cycle time, aging work in progress and pull request wait. */
function MetricStrip() {
  const { toilProject, now, byId, sync } = useData();
  const { health: h, insights: p } = useDerived();
  const words = useWords();
  const { pw } = usePlain();
  // A theme's sprint dressing (Harvest's calendar) hangs on the sprint wherever it shows.
  const { Panel: PanelSkin } = useSkins();
  // Worked out once per toil project and clock: the chat above re-renders the page as each answer streams in.
  const { b, t, cycles, ages, queue } = useMemo(
    () => ({
      b: h ? burnup(h, now) : null,
      t: throughput(toilProject.items, now),
      cycles: cycleTimes(toilProject.items).known.sort((x, y) => (x.end < y.end ? -1 : 1)),
      ages: aging(toilProject.items, now).known,
      queue: openQueue(toilProject.pullRequests ?? [], byId, now).filter((r) => r.wait.on !== 'draft'),
    }),
    [h, toilProject, now, byId],
  );
  const last = b?.days.at(-1);
  const full = t.weeks.filter((w) => !w.partial);
  const mean = full.length ? full.reduce((n, w) => n + w.items.length, 0) / full.length : 0;
  const waits = queue.map((r) => r.wait.days ?? 0);
  const longest = waits.length ? Math.max(...waits) : 0;
  return (
    <section className="overview-metrics" aria-labelledby="metrics-title">
      <h2 id="metrics-title" className="sr-only">
        Metrics
      </h2>
      <ul className="metric-strip">
        <Metric
          id="burnup"
          label={pw('Burn-up', 'Points done')}
          value={last ? `${last.done} of ${last.scope}` : 'No sprint'}
          unit={last ? 'points' : ''}
          spark={<Sparkline values={b?.days.map((d) => d.done) ?? []} against={b?.days.map((d) => d.scope) ?? []} />}
          title={h ? `${h.sprint.name}: day ${h.days.gone} of ${h.days.total}` : 'Sprint'}
        >
          {h ? (
            <div className="chart-dialog__sprint">
              <PanelSkin id="sprint">
                <SprintDetail h={h} />
              </PanelSkin>
            </div>
          ) : (
            <Empty message={words('empty.sprint')} action={<TrackerAction toilProject={toilProject.name} sync={sync} />} />
          )}
        </Metric>
        <Metric id="throughput" label={pw('Throughput', 'Finished')} value={String(round1(mean))} unit="a week" spark={<Sparkline kind="bars" values={t.weeks.map((w) => w.items.length)} />} title={pw('Throughput', 'Finished a week')}>
          <Throughput />
        </Metric>
        <Metric
          id="cycle"
          label={pw('Cycle time', 'Time to finish')}
          value={p.p85 ? `${round1(p.p85.days)}` : String(cycles.length)}
          unit={p.p85 ? 'days, 85% within' : cycles.length === 1 ? 'item timed' : 'items timed'}
          spark={<Sparkline values={cycles.map((c) => c.days)} mark={p.p85?.days ?? null} />}
          title={pw('Cycle time', 'Time to finish')}
        >
          <CycleTime />
        </Metric>
        <Metric id="aging" label={pw('Aging WIP', 'Work getting old')} value={String(ages.length)} unit={ages.length ? `in progress, oldest ${round1(ages[0]!.days)} d` : 'in progress'} spark={<Sparkline kind="bars" values={ages.map((a) => a.days)} mark={p.p85?.days ?? null} />} title={pw('Aging work in progress', 'Work getting old')}>
          <p className="note">{words('aging.note')}</p>
          <Aging />
        </Metric>
        <Metric id="pr-wait" label={pw('PR wait', 'Review wait')} value={queue.length ? String(round1(longest)) : '0'} unit={queue.length ? `working days, ${queue.length} open` : 'open'} spark={<Sparkline kind="bars" values={waits} />} title={pw('Pull requests waiting', 'Code reviews waiting')}>
          {queue.length ? (
            <ul className="rows">
              {queue.map((r) => (
                <li key={r.change.id}>
                  <PrLink change={r.change} withTitle />
                  <p className="evidence">
                    Waits on {WAITING_LABEL[r.wait.on].toLowerCase()}
                    {r.wait.days !== null ? ` for ${daysText(r.wait.days)}` : ''}: {r.wait.why}.
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p>No pull request is open, apart from drafts.</p>
          )}
          <p>
            <a href={prsHref(toilProject.name)}>{pw('The Pull requests tab', 'The Code reviews tab')}</a> has the whole queue, its flags and its flow.
          </p>
        </Metric>
      </ul>
    </section>
  );
}
