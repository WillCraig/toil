/**
 * Flow panels (#252, #253): the sprint burn-up, throughput per week, cycle
 * time and aging work in progress, all from OWI transitions (src/model/flow.ts
 * and burnup.ts). Each lists what it couldn't compute and why, beside what it
 * could. The sprint in full is here too. The Overview's sparklines open
 * each of them in a dialog (#394).
 */

import { Avatar } from '../components/bits.tsx';
import { BurnupChart, CycleScatter, ThroughputSpark } from '../components/charts.tsx';
import { Cited, ItemLink } from '../components/items.tsx';
import { describe, type Health } from '../model/sprint.ts';
import { useData, useDerived } from '../data.ts';
import { dateTime, day, shortKey, sourceLabel } from '../format.ts';
import { burnup } from '../model/burnup.ts';
import { aging, cycleTimes, throughput, type Unknown } from '../model/flow.ts';
import { AGING_PERCENTILE, MIN_CYCLES } from '../model/insights.ts';
import { useTerm, useWords } from '../skins.tsx';
import { Empty, TrackerAction } from '../components/empty.tsx';

const round1 = (n: number) => Math.round(n * 10) / 10;
const daysText = (n: number) => `${round1(n)} ${round1(n) === 1 ? 'day' : 'days'}`;

function Unknowns({ list, what }: { list: Unknown[]; what: string }) {
  if (!list.length) return null;
  return (
    <div className="unknowns">
      <p className="note">
        {list.length} {list.length === 1 ? 'item has' : 'items have'} no {what} the data can show:
      </p>
      <ul className="plain">
        {list.map((u) => (
          <li key={u.id}>
            <ItemLink id={u.id} /> <span className="field">Unknown: {u.reason}.</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Burnup() {
  const { now, toilProject, sync } = useData();
  const { health: h } = useDerived();
  const words = useWords();
  if (!h) return <Empty message={words('empty.burnup')} action={<TrackerAction toilProject={toilProject.name} sync={sync} />} />;
  return <BurnupChart b={burnup(h, now)} sprint={h.sprint.name} />;
}

export function Throughput() {
  const { toilProject, now } = useData();
  const t = throughput(toilProject.items, now);
  const total = t.weeks.reduce((n, w) => n + w.items.length, 0);
  const full = t.weeks.filter((w) => !w.partial);
  const mean = full.length ? full.reduce((n, w) => n + w.items.length, 0) / full.length : 0;
  return (
    <>
      <p className="big-figure">
        <span className="big-number">{round1(mean)}</span> items a week
        <span className="note"> over the last {full.length} full weeks; {total} finished in {t.weeks.length} weeks.</span>
      </p>
      <ThroughputSpark weeks={t.weeks} />
      <p className="note">Counted in the week of each item's last move into Done, from its history.</p>
      <Unknowns list={t.unknown} what="finish date" />
    </>
  );
}

export function CycleTime() {
  const { toilProject, byId } = useData();
  const { insights } = useDerived();
  const c = cycleTimes(toilProject.items);
  const points = c.known.map((k) => {
    const item = byId.get(k.id)!;
    return { id: k.id, label: `${sourceLabel(item.source.area)} ${shortKey(item)}`, end: k.end, days: k.days };
  });
  return (
    <>
      {points.length ? (
        <>
          <p className="big-figure">
            {insights.p85 ? (
              <>
                <span className="big-number">{round1(insights.p85.days)}</span> days for {AGING_PERCENTILE}% of items
              </>
            ) : (
              <>
                <span className="big-number">{points.length}</span> {points.length === 1 ? 'item' : 'items'} timed
              </>
            )}
            <span className="note"> From the first move into In progress to the last into Done.</span>
          </p>
          <CycleScatter points={points} p85={insights.p85?.days ?? null} />
          {!insights.p85 && <p className="note">Fewer than {MIN_CYCLES} cycle times, so no percentile yet, and nothing is flagged as aging.</p>}
        </>
      ) : (
        <p>No finished item here has a cycle time the data can show.</p>
      )}
      <Unknowns list={c.unknown} what="cycle time" />
    </>
  );
}

export function Aging() {
  const { toilProject, now, byId } = useData();
  const { insights } = useDerived();
  const a = aging(toilProject.items, now);
  const max = Math.max(1, ...a.known.map((k) => k.days), insights.p85?.days ?? 0);
  return (
    <>
      {a.known.length ? (
        <ul className="aging">
          {a.known.map((k) => {
            const item = byId.get(k.id)!;
            const over = insights.p85 !== null && k.days > insights.p85.days;
            return (
              <li key={k.id} className={over ? 'aging--over' : undefined}>
                <div className="aging-row">
                  <ItemLink id={k.id} withTitle />
                  <span className="aging-days">
                    {daysText(k.days)}
                    {over && <span className="flag"> past p{AGING_PERCENTILE}</span>}
                  </span>
                </div>
                <div className="aging-bar" aria-hidden="true">
                  <span style={{ width: `${(100 * k.days) / max}%` }} />
                  {insights.p85 && <i style={{ left: `${(100 * insights.p85.days) / max}%` }} />}
                </div>
                <p className="evidence">
                  <Avatar person={item.assignee} /> {item.status}, in progress since {dateTime(k.since)}. Source: <code>history.transitions</code>
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>Nothing in progress has a recorded start.</p>
      )}
      {insights.p85 && <p className="note">The marker on each bar is p{AGING_PERCENTILE} of this Toil project's cycle times, {daysText(insights.p85.days)}.</p>}
      <Unknowns list={a.unknown} what="start" />
    </>
  );
}

const pts = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`;

/** The sprint in full (#252): its figures, the burn-up, and what is at risk, added and carried over. The Overview's burn-up tile opens it. */
export function SprintDetail({ h }: { h: Health }) {
  const term = useTerm();
  const total = h.done.points + h.remaining.points;
  const listed = (kind: 'added' | 'carried') => h.items.filter((i) => h.entries.get(i.id)?.kind === kind);
  return (
    <>
      <p className="note">
        {day(h.sprint.start!)} to {day(h.sprint.end!)}, working days only.
      </p>
      <ul className="stats" aria-label="Sprint figures">
        <Stat label={term('pointsDone', 'Done')} value={`${h.done.points} of ${total}`} note={`points, ${h.done.count} items`} />
        <Stat label="Planned" value={String(h.planned.points)} note={`points, ${h.planned.count} items`} />
        <Stat label="Added mid-sprint" value={String(h.added.points)} note={`points, ${h.added.count} items`} />
        <Stat label="Carried over" value={String(h.carried.points)} note={`points, ${h.carried.count} items`} />
      </ul>
      <div className="meter" role="img" aria-label={`${h.done.points} of ${total} points done`}>
        <span style={{ width: `${total ? (100 * h.done.points) / total : 0}%` }} />
      </div>
      <Burnup />
      {h.otherUnits.length > 0 && (
        <p className="note">
          Points totals leave out items estimated in other units:{' '}
          {h.otherUnits.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <ItemLink id={id} />
            </span>
          ))}
          .
        </p>
      )}
      <h3>At risk</h3>
      {h.risks.length ? (
        <ul className="rows">
          {h.risks.map((r) => (
            <li key={r.id}>
              <ItemLink id={r.id} withTitle />
              <ul className="reasons">
                {r.reasons.map((reason, i) => (
                  <li key={i}>
                    <Cited text={describe(reason)} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p>Nothing.</p>
      )}
      {(['added', 'carried'] as const).map((kind) => (
        <div key={kind}>
          <h3>{kind === 'added' ? 'Added after the sprint started' : 'Carried over'}</h3>
          {listed(kind).length ? (
            <ul className="rows">
              {listed(kind).map((item) => {
                const e = h.entries.get(item.id)!;
                return (
                  <li key={item.id}>
                    <ItemLink id={item.id} withTitle />
                    <p className="evidence">
                      {e.from ? `From ${e.from}` : 'Added'}
                      {e.at ? ` on ${dateTime(e.at)}` : ''}, {pts(item.estimate?.unit === 'points' ? item.estimate.value : 0)}
                      {item.estimate ? '' : ' (no estimate)'}. Source: <code>{e.evidence}</code>
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>None.</p>
          )}
        </div>
      ))}
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <li className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-note">{note}</span>
    </li>
  );
}
