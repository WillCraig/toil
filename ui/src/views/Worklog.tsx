/**
 * A toil project's worklog (#308): a calendar of the days that have a page, and
 * one day's page, folded by code from what the cache holds (src/model/worklog.ts):
 * the work items that moved, the pull requests opened, reviewed, merged or
 * declined, the builds and deployments that failed or recovered, the agent's
 * runs and the notes a person added, each line linked to its source. What the
 * cache can't vouch for is said at the top. Rebuild folds the day again and
 * says whether it came out the same; Export writes the Markdown through toil;
 * publishing it is a proposal for a person to run. The minutes, with the
 * attendance sheet stapled to the front.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Form, Label, Radio, RadioGroup, TextArea, TextField, Input } from 'react-aria-components';
import { ProposalCard } from '../components/proposal.tsx';
import { Cited, ItemLink } from '../components/items.tsx';
import { Path } from '../components/layout.tsx';
import { Panel } from '../components/panel.tsx';
import { Help } from '../components/help.tsx';
import { useData } from '../data.ts';
import { toilProjectHref, standupHref, worklogHref } from '../format.ts';
import {
  addMonths, appliedText, daysOfMonth, longDay, monthName, monthOf, OUTCOME_TEXT, seenText, timeOf,
  type RunLine, type WorklogEvent,
} from '../model/worklog.ts';
import { MAX_NOTE, type ExportWhat, type WorklogApi, type WorklogDay, type WorklogExport, type WorklogMonth } from '../worklog.ts';
import { Loader } from '../moments/Moments.tsx';
import { usePlain } from '../plain-words.ts';

type Loaded<T> = { ok: true; value: T } | { ok: false; message: string } | null;
const failedWith = (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) });
const WEEKDAYS = [['Mon', 'Monday'], ['Tue', 'Tuesday'], ['Wed', 'Wednesday'], ['Thu', 'Thursday'], ['Fri', 'Friday'], ['Sat', 'Saturday'], ['Sun', 'Sunday']] as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function Worklog({ api, day }: { api: WorklogApi | null; day: string | null }) {
  const { toilProject } = useData();
  const plain = usePlain();
  const [month, setMonth] = useState<string | null>(day ? monthOf(day) : null);
  const [calendar, setCalendar] = useState<Loaded<WorklogMonth>>(null);
  const [page, setPage] = useState<Loaded<WorklogDay>>(null);
  const today = calendar?.ok ? calendar.value.today : null;
  const selected = day ?? today;

  useEffect(() => {
    if (!api) return;
    let live = true;
    setCalendar(null);
    api.month(toilProject.name, month ?? undefined).then(
      (value) => live && setCalendar({ ok: true, value }),
      (e: unknown) => live && setCalendar(failedWith(e)),
    );
    return () => {
      live = false;
    };
  }, [api, toilProject.name, month]);

  useEffect(() => {
    if (!api || !selected) return;
    let live = true;
    setPage(null);
    api.day(toilProject.name, selected).then(
      (value) => live && setPage({ ok: true, value }),
      (e: unknown) => live && setPage(failedWith(e)),
    );
    return () => {
      live = false;
    };
  }, [api, toilProject.name, selected]);

  const head = (
    <div className="view-head">
      <p className="eyebrow">
        <a href={toilProjectHref(toilProject.name)}>{toilProject.name}</a>
      </p>
      <h1 tabIndex={-1} title={plain.title('Worklog')}>
        {plain.pw('Worklog', 'What happened')}
      </h1>
      <p className="lede">
        One page a day of what happened, facts only. <Help topic="worklog" />
      </p>
      {api && (
        <p>
          <a className="btn" href={standupHref(toilProject.name)} data-standup-link="">
            Stand-up since the last working day
          </a>
        </p>
      )}
    </div>
  );
  if (!api) {
    return (
      <>
        {head}
        <p role="alert" className="failure">
          This Toil UI keeps no worklog: it has no cache to fold one from.
        </p>
      </>
    );
  }
  return (
    <>
      {head}
      <div className="worklog">
        <Panel id="worklog-calendar" title={calendar?.ok ? monthName(calendar.value.month) : 'Calendar'} calls={[]}>
          {!calendar ? <Loader size="panel" message="Reading the calendar" /> : calendar.ok ? <Calendar data={calendar.value} selected={selected} onMonth={setMonth} /> : <p role="alert" className="failure">{calendar.message}</p>}
        </Panel>
        <Panel id="worklog-day" title={selected ? longDay(selected) : 'The day'} calls={[]}>
          {!page ? (
            <Loader size="panel" message="Folding the page" />
          ) : page.ok ? (
            <DayPage api={api} data={page.value} today={today} onChange={(value) => setPage({ ok: true, value })} />
          ) : (
            <p role="alert" className="failure">
              {page.message}
            </p>
          )}
        </Panel>
      </div>
    </>
  );
}

/** The month's days, Monday first: a link for each day with a page, the rest as plain numbers. */
function Calendar({ data, selected, onMonth }: { data: WorklogMonth; selected: string | null; onMonth: (month: string) => void }) {
  const { toilProject } = useData();
  const pages = new Map(data.days.map((d) => [d.day, d]));
  const days = daysOfMonth(data.month);
  const lead = (new Date(`${days[0]}T00:00:00Z`).getUTCDay() + 6) % 7;
  const cells: Array<string | null> = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  const earliest = data.first ? monthOf(data.first) : data.month;
  const prev = addMonths(data.month, -1);
  const next = addMonths(data.month, 1);
  return (
    <>
      <div className="calendar-nav">
        <Button className="btn btn--small" isDisabled={data.month <= earliest} onPress={() => onMonth(prev)}>
          Previous month
        </Button>
        <Button className="btn btn--small" isDisabled={data.month >= monthOf(data.today)} onPress={() => onMonth(next)}>
          Next month
        </Button>
      </div>
      <table className="calendar">
        <caption className="sr-only">
          {monthName(data.month)}: {plural(data.days.length, 'day')} with a page. Days are UTC.
        </caption>
        <thead>
          <tr>
            {WEEKDAYS.map(([short, long]) => (
              <th key={short} scope="col">
                <abbr title={long}>{short}</abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, w) => (
            <tr key={w}>
              {week.map((d, i) => {
                if (!d) return <td key={i} />;
                const p = pages.get(d);
                const n = Number(d.slice(8));
                if (!p) {
                  return (
                    <td key={d} className={d > data.today ? 'calendar__future' : 'calendar__empty'} data-today={d === data.today || undefined}>
                      <span className="sr-only">{longDay(d)}{d === data.today ? ', today' : ''}: {d > data.today ? 'not yet' : 'no page'}</span>
                      <span aria-hidden="true">{n}</span>
                    </td>
                  );
                }
                return (
                  <td key={d}>
                    <a href={worklogHref(toilProject.name, d)} className="calendar__day" aria-current={d === selected ? 'date' : undefined} data-today={d === data.today || undefined} data-quiet={p.lines === 0 || undefined}>
                      <span className="sr-only">{longDay(d)}{d === data.today ? ', today' : ''}: </span>
                      <span className="calendar__n" aria-hidden="true">
                        {n}
                      </span>
                      <span className="calendar__count">
                        {p.lines}
                        <span className="sr-only"> {p.lines === 1 ? 'line' : 'lines'}{p.gaps ? `, ${plural(p.gaps, 'coverage note')}` : ''}</span>
                        {p.gaps > 0 && <span aria-hidden="true">*</span>}
                      </span>
                    </a>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        A number under a day is how many lines its page has; a star means the page says what the cache can't vouch for. The cache keeps {plural(data.retentionDays, 'day')} after each sync, and so do the pages.
      </p>
    </>
  );
}

/** What a line is about: its item's page, its pull request, or its build or deployment where the source has a page for it. */
function Subject({ e }: { e: WorklogEvent }) {
  const { byId, prById } = useData();
  if (byId.has(e.subject) || prById?.has(e.subject)) return <ItemLink id={e.subject} withTitle />;
  return e.url ? (
    <a href={e.url} className="item-link">
      <span className="key">{e.label}</span>
    </a>
  ) : (
    <span className="item-link">
      <span className="key">{e.label}</span>
    </span>
  );
}

function Line({ e }: { e: WorklogEvent }) {
  const { byId, prById } = useData();
  // An item or pull request the toil project holds carries its title in its link; anything else keeps the title the record has.
  const title = byId.has(e.subject) || prById?.has(e.subject) ? null : e.title;
  return (
    <li className="worklog-line">
      <time dateTime={e.at}>{timeOf(e.at)}</time>{' '}
      <span>
        <Subject e={e} />
        {title && (
          <>
            {' '}
            <Cited text={title} />
          </>
        )}
        : <Cited text={e.text} />
        {e.by && <span className="by">, by {e.by}</span>}
        {e.observed && (
          <span className="note">
            {' '}
            ({seenText(e)})
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * One section of a day. An empty one says "nothing happened" only when a sync read that day; with no read behind it the
 * absence is unknown, not zero (principle 12), so it is a dash, "not read yet", and the way to read.
 */
function Section({ title, events, none, read }: { title: string; events: WorklogEvent[]; none: string; read: boolean }) {
  const { sync } = useData();
  return (
    <section className="worklog-section">
      <h3>{title}</h3>
      {events.length ? (
        <ul className="rows worklog-lines">
          {events.map((e) => (
            <Line key={e.key} e={e} />
          ))}
        </ul>
      ) : read ? (
        <p className="note">{none}</p>
      ) : (
        <p className="note" data-not-read="">
          <span aria-hidden="true">–</span> Not read yet: nothing has been read for this day.{' '}
          {sync && (
            <Button className="btn btn--small" onPress={sync} data-sync-now="">
              Sync now
            </Button>
          )}
        </p>
      )}
    </section>
  );
}

function Run({ line }: { line: RunLine }) {
  const { run } = line;
  return (
    <li className="worklog-line">
      <time dateTime={run.startedAt}>{timeOf(run.startedAt)}</time>{' '}
      <span>
        {run.kind === 'ask' ? 'Asked' : 'Assigned'} {run.by}: “{run.prompt}”, {OUTCOME_TEXT[run.outcome]}
        {run.finishedAt && ` at ${timeOf(run.finishedAt)}`}
        {run.citations.length > 0 && `, citing ${plural(run.citations.length, 'item')}${run.unverified.length ? ` (${run.unverified.length} unverified)` : ''}`}
        {run.error && <span className="failure">: {run.error}</span>}
        {line.proposals.length > 0 && (
          <ul className="plain worklog-proposals">
            {line.proposals.map((p) => (
              <li key={p.proposal.id}>
                Proposal: <Cited text={p.proposal.title} />
                {p.proposal.command && (
                  <>
                    {' '}
                    (<code>toil {p.proposal.command}</code>)
                  </>
                )}
                , <span className={p.applied.state === 'applied' ? undefined : 'note'}>{appliedText(p.applied)}</span>
              </li>
            ))}
          </ul>
        )}
        <details className="worklog-transcript">
          <summary>Transcript, written by the agent</summary>
          {run.answer ? (
            run.answer.split(/\n{2,}/).map((para, i) => (
              <p key={i}>
                <Cited text={para} chips />
              </p>
            ))
          ) : (
            <p className="note">No answer was recorded.</p>
          )}
        </details>
      </span>
    </li>
  );
}

function DayPage({ api, data, today, onChange }: { api: WorklogApi; data: WorklogDay; today: string | null; onChange: (d: WorklogDay) => void }) {
  const { page } = data;
  const [rebuilt, setRebuilt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Today's empty section is a real zero only after a sync has read today. An earlier day is folded from the sources' own history, and its Coverage note says what it can't vouch for.
  const read = page.day !== today || page.sources.some((s) => s.syncs > 0);
  const rebuild = async () => {
    setBusy(true);
    try {
      const r = await api.rebuild(page.toilProject, page.day);
      onChange(r);
      setRebuilt(r.same === null ? 'Rebuilt from the cache. There was no page kept to compare it with.' : r.same ? 'Rebuilt from the cache: the same, line for line, as the page kept.' : 'Rebuilt from the cache: it differs from the page kept, which now matches the cache again.');
    } catch (e) {
      setRebuilt(`The rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="worklog-page">
      <p className="note">
        Built by Toil UI from its cache, facts only{data.file ? ', and kept at ' : '. Sample data keeps no file.'}
        {data.file && <Path value={data.file} what="page's path" />}
      </p>
      {page.gaps.length > 0 && (
        <section className="worklog-gaps" aria-labelledby={`gaps-${page.day}`}>
          <h3 id={`gaps-${page.day}`}>Coverage</h3>
          <ul>
            {page.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </section>
      )}
      <Section title="Work items" events={page.work} read={read} none="No status changes, sprint changes or new blockers recorded." />
      <Section title="Pull requests" events={page.prs} read={read} none="No pull requests opened, reviewed, merged or declined." />
      <Section title="Builds and deployments" events={page.delivery} read={read} none="No builds or deployments failed or recovered." />
      <section className="worklog-section">
        <h3>Agent runs</h3>
        {page.agents.length ? (
          <ul className="rows worklog-lines">
            {page.agents.map((r) => (
              <Run key={r.run.id} line={r} />
            ))}
          </ul>
        ) : (
          <p className="note">No agent runs.</p>
        )}
      </section>
      <Notes api={api} data={data} today={today} onChange={onChange} />
      <section className="worklog-section">
        <h3>Sources</h3>
        {page.sources.length ? (
          <ul className="plain">
            {page.sources.map((s) => (
              <li key={s.area}>
                <code>{s.area}</code>: {s.syncs ? `${plural(s.syncs, 'sync')} this day${s.failed ? `, ${s.failed} failed` : ''}, the last at ${timeOf(s.last!)} UTC` : 'no sync this day'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">No syncs recorded.</p>
        )}
      </section>
      <div className="worklog-actions">
        <Button className="btn" data-worklog-rebuild="" isDisabled={busy} onPress={() => void rebuild()}>
          Rebuild this day
        </Button>
        <a className="btn btn--accent" href={standupHref(page.toilProject, { from: page.day, to: page.day })} data-standup-day="">
          Stand-up for this day
        </a>
        {rebuilt && (
          <p role="status" className="note">
            {rebuilt}
          </p>
        )}
      </div>
      <Export api={api} toilProject={page.toilProject} day={page.day} />
      <details className="worklog-md">
        <summary>The page as Markdown</summary>
        <pre role="region" aria-label="The page as Markdown" tabIndex={0}>
          <code>{data.markdown}</code>
        </pre>
      </details>
    </div>
  );
}

function Notes({ api, data, today, onChange }: { api: WorklogApi; data: WorklogDay; today: string | null; onChange: (d: WorklogDay) => void }) {
  const { page } = data;
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const isToday = page.day === today;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    try {
      onChange(await api.addNote(page.toilProject, text));
      setText('');
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <section className="worklog-section">
      <h3>Notes</h3>
      {page.notes.length ? (
        <ul className="rows worklog-lines">
          {page.notes.map((n) => (
            <li key={n.id} className="worklog-line">
              <time dateTime={n.at}>{timeOf(n.at)}</time> <span><span className="by">{n.by}:</span> {n.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">No notes.</p>
      )}
      {isToday &&
        (api.disabled ? (
          <p className="note">{api.disabled}</p>
        ) : (
          <Form className="worklog-note" onSubmit={(e) => void submit(e)}>
            <TextField className="field-text field-text--area" value={text} onChange={setText} maxLength={MAX_NOTE}>
              <Label>Add a note to today's page</Label>
              <TextArea rows={2} />
            </TextField>
            <Button type="submit" className="btn" isDisabled={!text.trim()}>
              Add the note
            </Button>
            {problem && (
              <p role="alert" className="failure">
                {problem}
              </p>
            )}
          </Form>
        ))}
    </section>
  );
}

function Export({ api, toilProject, day }: { api: WorklogApi; toilProject: string; day: string }) {
  const [folder, setFolder] = useState('');
  const [span, setSpan] = useState<'day' | 'month'>('day');
  const [result, setResult] = useState<{ ok: true; value: WorklogExport } | { ok: false; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const what: ExportWhat = span === 'day' ? { day } : { month: monthOf(day) };
    try {
      setResult({ ok: true, value: await api.exportTo(toilProject, what, folder) });
    } catch (err) {
      setResult(failedWith(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="worklog-section" aria-labelledby="worklog-export">
      <h3 id="worklog-export">Export and publish</h3>
      <p className="note">Export writes the Markdown to a new file in a folder you name, through toil's own file service. Publishing it to Confluence or GitHub is then a proposal, for you to run through toil's write gate.</p>
      {api.disabled ? (
        <p className="note">{api.disabled}</p>
      ) : (
        <Form className="worklog-export" onSubmit={(e) => void submit(e)}>
          <RadioGroup className="shells" orientation="horizontal" value={span} onChange={(v) => setSpan(v as 'day' | 'month')}>
            <Label>Export</Label>
            <Radio value="day" className="shell-choice">
              This day
            </Radio>
            <Radio value="month" className="shell-choice">
              {monthName(monthOf(day))}
            </Radio>
          </RadioGroup>
          <TextField className="field-text" value={folder} onChange={setFolder} isRequired>
            <Label>Folder, as a full path</Label>
            <Input autoComplete="off" spellCheck={false} />
          </TextField>
          <Button type="submit" className="btn" isDisabled={busy || !folder.trim()}>
            Export
          </Button>
        </Form>
      )}
      {result &&
        (result.ok ? (
          <>
            <p role="status">
              toil wrote {plural(result.value.bytes, 'byte')} to <Path value={result.value.path} what="exported file's path" />.
            </p>
            {result.value.proposals.length ? (
              result.value.proposals.map((p) => <ProposalCard key={p.id} proposal={p} />)
            ) : (
              <p className="note">This Toil project names no Confluence space and no GitHub repository, so there is nowhere to propose publishing it.</p>
            )}
          </>
        ) : (
          <p role="alert" className="failure">
            {result.message}
          </p>
        ))}
    </section>
  );
}
