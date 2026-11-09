/**
 * The stand-up (#345): the worklog's days, reshaped for a meeting by code
 * (src/model/standup.ts). Team lines first, then each person, agents
 * included, with what they got done, what is in progress, what is blocked
 * and what is next. Every line links to its item, pull request or run, and
 * the same range always gives the same report. It copies as Markdown or as
 * plain text, exports through toil's file service, and posting it anywhere is
 * a proposal for a person to run. "Write it up" asks the agent for a short
 * narrative of the same facts, labelled as the agent's and naming the fact
 * lines it used. Fifteen minutes, standing, with the minutes already taken.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Form, Input, Label, TextField } from 'react-aria-components';
import type { Answer } from '../agent.ts';
import { Cited, ItemLink } from '../components/items.tsx';
import { Path } from '../components/layout.tsx';
import { Panel } from '../components/panel.tsx';
import { Help } from '../components/help.tsx';
import { ProposalCard } from '../components/proposal.tsx';
import { useData } from '../data.ts';
import { toilProjectHref, standupHref, worklogHref } from '../format.ts';
import { allLines, bucketNone, BUCKETS, BUCKET_TITLE, defaultRange, factsCited, groupTitle, MAX_STANDUP_DAYS, standupLede, standupTitle, standupWriteUp, whenText, type StandupGroup, type StandupLine, type StandupReport } from '../model/standup.ts';
import { dayOf } from '../model/worklog.ts';
import { useTheme, useThemeChoiceContext } from '../skins.tsx';
import { voiceOn } from '../theme-context.ts';
import type { WorklogApi, WorklogExport, WorklogStandup } from '../worklog.ts';
import { Loader } from '../moments/Moments.tsx';

export type Loaded<T> = { ok: true; value: T } | { ok: false; message: string } | null;
const failedWith = (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Loads the stand-up for a range through the worklog API: null while it loads, `ok: false` with the message when it fails. The page and the Summary's card share it. */
export function useStandupReport(api: WorklogApi | null, range: { from: string; to: string }): [Loaded<WorklogStandup>, (v: Loaded<WorklogStandup>) => void] {
  const { toilProject } = useData();
  const [loaded, setLoaded] = useState<Loaded<WorklogStandup>>(null);
  useEffect(() => {
    if (!api) return;
    let live = true;
    setLoaded(null);
    api.standup(toilProject.name, range.from, range.to).then(
      (value) => live && setLoaded({ ok: true, value }),
      (e: unknown) => live && setLoaded(failedWith(e)),
    );
    return () => {
      live = false;
    };
  }, [api, toilProject.name, range.from, range.to]);
  return [loaded, setLoaded];
}

export function Standup({ api, from, to, ignored }: { api: WorklogApi | null; from: string | null; to: string | null; ignored?: string }) {
  const { toilProject, now } = useData();
  const today = dayOf(now)!;
  const range = from && to ? { from, to } : defaultRange(today);
  const [loaded, setLoaded] = useStandupReport(api, range);

  const head = (
    <div className="view-head">
      <p className="eyebrow">
        <a href={toilProjectHref(toilProject.name)}>{toilProject.name}</a> · <a href={worklogHref(toilProject.name)}>Worklog</a>
      </p>
      <h1 tabIndex={-1}>Stand-up</h1>
      <p className="lede">
        The worklog's days, grouped by person into done, in progress, blocked and next, with the team's lines first. <Help topic="standup" />
      </p>
    </div>
  );
  if (!api) {
    return (
      <>
        {head}
        <p role="alert" className="failure">
          This Toil UI keeps no worklog, so it has no stand-up to fold from one.
        </p>
      </>
    );
  }
  return (
    <>
      {head}
      <div className="standup">
        <Panel id="standup-range" title="Days" calls={[]}>
          {ignored && (
            <p role="status" className="note">
              “{ignored}” isn't a day as yyyy-mm-dd, so this is since the last working day instead.
            </p>
          )}
          <RangeForm key={`${range.from}/${range.to}`} from={range.from} to={range.to} today={today} explicit={Boolean(from && to)} />
        </Panel>
        {!loaded ? (
          <Loader size="panel" message="Folding the stand-up" />
        ) : loaded.ok ? (
          <Report api={api} data={loaded.value} onRebuilt={(value) => setLoaded({ ok: true, value })} />
        ) : (
          <p role="alert" className="failure">
            {loaded.message}
          </p>
        )}
      </div>
    </>
  );
}

/** The range: since the last working day by default, or two days a person picks. */
function RangeForm({ from, to, today, explicit }: { from: string; to: string; today: string; explicit: boolean }) {
  const { toilProject } = useData();
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    window.location.hash = standupHref(toilProject.name, { from: a, to: b });
  };
  return (
    <>
      <p className="note">
        {explicit ? 'The days you picked.' : 'Since the last working day, through today.'} At most {MAX_STANDUP_DAYS} days.
        {explicit && (
          <>
            {' '}
            <a href={standupHref(toilProject.name)}>Back to since the last working day</a>.
          </>
        )}
      </p>
      <Form className="standup-range" onSubmit={submit}>
        <TextField className="field-text" value={a} onChange={setA} isRequired>
          <Label>From</Label>
          <Input type="date" max={today} />
        </TextField>
        <TextField className="field-text" value={b} onChange={setB} isRequired>
          <Label>To</Label>
          <Input type="date" max={today} />
        </TextField>
        <Button type="submit" className="btn" isDisabled={!a || !b}>
          Show these days
        </Button>
      </Form>
    </>
  );
}

/** What a line is about: its item or pull request, its build or deployment where the source has a page, or the worklog day an assignment ran on. */
function Subject({ line }: { line: StandupLine }) {
  const { byId, prById, toilProject } = useData();
  if (byId.has(line.subject) || prById?.has(line.subject)) return <ItemLink id={line.subject} withTitle />;
  if (line.subject.startsWith('run:') && line.day) {
    return (
      <a href={worklogHref(toilProject.name, line.day)} className="item-link">
        <span className="key">{line.label}</span>
      </a>
    );
  }
  return line.url ? (
    <a href={line.url} className="item-link">
      <span className="key">{line.label}</span>
    </a>
  ) : (
    <span className="item-link">
      <span className="key">{line.label}</span>
    </span>
  );
}

export function Line({ report, line, highlight }: { report: StandupReport; line: StandupLine; highlight: boolean }) {
  const { byId, prById } = useData();
  const title = byId.has(line.subject) || prById?.has(line.subject) ? null : line.title;
  return (
    <li className="worklog-line standup-line" id={`fact-${line.fact}`} data-cited={highlight || undefined}>
      <span className="standup-fact">{line.fact}</span>
      <span>
        <Subject line={line} />
        {title && (
          <>
            {' '}
            <Cited text={title} />
          </>
        )}
        : <Cited text={line.text} /> <span className="note">({line.at ? <time dateTime={line.at}>{whenText(report, line)}</time> : whenText(report, line)})</span>
      </span>
    </li>
  );
}

/** No good sync behind the report: an empty list is unknown, not zero (principle 12), so it says so beside the way to read. */
export function NotRead() {
  const { sync } = useData();
  return (
    <p className="note" data-not-read="">
      <span aria-hidden="true">–</span> Not read yet: nothing has been read for these days.{' '}
      {sync && (
        <Button className="btn btn--small" onPress={sync} data-sync-now="">
          Sync now
        </Button>
      )}
    </p>
  );
}

function Lines({ report, lines, none, cited }: { report: StandupReport; lines: StandupLine[]; none: string; cited: Set<string> }) {
  return lines.length ? (
    <ul className="rows worklog-lines">
      {lines.map((l) => (
        <Line key={l.fact} report={report} line={l} highlight={cited.has(l.fact)} />
      ))}
    </ul>
  ) : report.asOf === null ? (
    <NotRead />
  ) : (
    <p className="note">{none}</p>
  );
}

function Person({ report, group, cited }: { report: StandupReport; group: StandupGroup; cited: Set<string> }) {
  const id = `standup-${group.key.replace(/[^A-Za-z0-9-]/g, '-')}`;
  const count = BUCKETS.reduce((n, b) => n + group.lines[b].length, 0);
  return (
    <Panel id={id} title={groupTitle(group)} calls={[]}>
      {!group.mapped && group.key !== 'none' && <p className="note">Not in the Toil project's people: an account the People view can map to someone.</p>}
      {count === 0 ? (
        report.asOf === null ? <NotRead /> : <p className="note">Nothing recorded for these days.</p>
      ) : (
        <div className="standup-buckets">
          {BUCKETS.map((b) => (
            <section key={b} className="worklog-section">
              <h3>{BUCKET_TITLE[b]}</h3>
              <Lines report={report} lines={group.lines[b]} none={bucketNone(b, report.sprint)} cited={cited} />
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Report({ api, data, onRebuilt }: { api: WorklogApi; data: WorklogStandup; onRebuilt: (d: WorklogStandup) => void }) {
  const { report } = data;
  const [writeUp, setWriteUp] = useState<Answer | null>(null);
  const [moved, setMoved] = useState(false);
  /**
   * The agent read the report again through its tool, so a sync that landed in between could renumber the facts it names.
   * The page builds it again once the write-up arrives, and says so when it changed, so the numbers it marks are the agent's.
   */
  const answered = async (a: Answer | null) => {
    setWriteUp(a);
    setMoved(false);
    if (!a) return;
    try {
      const again = await api.standup(report.toilProject, report.from, report.to);
      if (again.markdown !== data.markdown) {
        onRebuilt(again);
        setMoved(true);
      }
    } catch {
      // The report on screen stays; the write-up still says which numbers it named.
    }
  };
  const cited = new Set(writeUp ? factsCited(writeUp.parts.map((p) => p.text).join('\n'), report) : []);
  return (
    <>
      <section className="standup-summary" aria-labelledby="standup-title">
        <h2 id="standup-title">{standupTitle(report)}</h2>
        <p className="note">{standupLede(report)}</p>
        {report.gaps.length > 0 && (
          <section className="worklog-gaps" aria-labelledby="standup-gaps">
            <h3 id="standup-gaps">Coverage</h3>
            <ul>
              {report.gaps.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </section>
        )}
      </section>
      <Panel id="standup-team" title="Team" calls={[]}>
        <Lines report={report} lines={report.team} none="No scope changes, or builds and deployments that broke or recovered." cited={cited} />
      </Panel>
      {report.people.length ? (
        report.people.map((g) => <Person key={g.key} report={report} group={g} cited={cited} />)
      ) : (
        <p className="note">Nobody is in the Toil project's people, and nobody did anything the worklog recorded on these days.</p>
      )}
      <Panel id="standup-share" title="Copy, export and publish" calls={[]}>
        <Share api={api} data={data} />
      </Panel>
      <Panel id="standup-writeup" title="Write it up" calls={[]}>
        {moved && (
          <p role="status" className="note">
            A sync landed while the agent wrote, so the report above was built again from what the agent read, and its fact numbers match the write-up.
          </p>
        )}
        <WriteUp report={report} answer={writeUp} onAnswer={(a) => void answered(a)} />
      </Panel>
    </>
  );
}

function CopyButton({ value, label, what }: { value: string; label: string; what: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <Button className="btn" onPress={() => void copy()}>
        {label}
      </Button>
      <span role="status" className="sr-only">
        {copied === null ? '' : copied ? `Copied the stand-up as ${what}.` : `This browser wouldn't copy; select the ${what} below instead.`}
      </span>
      {copied === false && <span className="note">This browser wouldn't copy; select the {what} below instead.</span>}
    </>
  );
}

function Share({ api, data }: { api: WorklogApi; data: WorklogStandup }) {
  const { report } = data;
  const [folder, setFolder] = useState('');
  const [result, setResult] = useState<{ ok: true; value: WorklogExport } | { ok: false; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      setResult({ ok: true, value: await api.exportTo(report.toilProject, { from: report.from, to: report.to }, folder) });
    } catch (err) {
      setResult(failedWith(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="worklog-page">
      <p className="note">Markdown suits Slack, Teams and a wiki page; plain text suits a chat that shows Markdown as it is typed. Both are the report as shown, line for line.</p>
      <div className="worklog-actions">
        <CopyButton value={data.markdown} label="Copy as Markdown" what="Markdown" />
        <CopyButton value={data.text} label="Copy as plain text" what="plain text" />
      </div>
      <section className="worklog-section" aria-labelledby="standup-export">
        <h3 id="standup-export">Export and publish</h3>
        <p className="note">Export writes the Markdown to a new file in a folder you name, through toil's own file service. Publishing it to Confluence or GitHub is then a proposal, for you to run through toil's write gate.</p>
        {api.disabled ? (
          <p className="note">{api.disabled}</p>
        ) : (
          <Form className="worklog-export" onSubmit={(e) => void submit(e)}>
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
      <details className="worklog-md">
        <summary>The stand-up as Markdown</summary>
        <pre role="region" aria-label="The stand-up as Markdown" tabIndex={0}>
          <code>{data.markdown}</code>
        </pre>
      </details>
      <details className="worklog-md">
        <summary>The stand-up as plain text</summary>
        <pre role="region" aria-label="The stand-up as plain text" tabIndex={0}>
          <code>{data.text}</code>
        </pre>
      </details>
    </div>
  );
}

/** "Write it up": the agent retells the same facts in a few sentences, labelled as its own and naming the fact lines it used. */
function WriteUp({ report, answer, onAnswer }: { report: StandupReport; answer: Answer | null; onAnswer: (a: Answer | null) => void }) {
  const { agent, toilProject } = useData();
  const theme = useTheme();
  const choice = useThemeChoiceContext();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const lines = new Map(allLines(report).map((l) => [l.fact, l]));
  const ask = async () => {
    setBusy(true);
    setProblem(null);
    onAnswer(null);
    try {
      const chat = { id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `standup-${Date.now()}`, turn: 1 };
      onAnswer(await agent.ask(toilProject.name, standupWriteUp(report.from, report.to), { theme: theme.name, voice: voiceOn(theme, choice) }, chat));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const used = answer ? factsCited(answer.parts.map((p) => p.text).join('\n'), report) : [];
  return (
    <div className="worklog-page">
      <p className="note">Optional. The agent turns the facts above into a short narrative, in the theme's voice when that is on. It reads the same report, names the fact lines it used, and its usage counts like any chat's. The report above stays the record.</p>
      {agent.notice && <p className="note agent-notice">{agent.notice}</p>}
      <div className="worklog-actions">
        <Button className="btn" data-standup-writeup="" isDisabled={busy} onPress={() => void ask()}>
          {answer ? 'Write it up again' : 'Write it up'}
        </Button>
        {busy && <span role="status">The agent is writing it up.</span>}
      </div>
      {problem && (
        <p role="alert" className="failure">
          {problem}
        </p>
      )}
      {answer && (
        <section className="standup-writeup" aria-labelledby="standup-writeup-by">
          <h3 id="standup-writeup-by">Written by the agent ({answer.by === 'scripted' ? 'a scripted preview, not a model' : answer.by}), not by Toil UI</h3>
          {answer.warnings?.map((w, i) => (
            <p key={i} className="note">
              {w}
            </p>
          ))}
          {answer.parts.map((p, i) => (
            <p key={i}>
              <Cited text={p.text} chips />
            </p>
          ))}
          <p className="note">
            {used.length ? `Rests on ${plural(used.length, 'fact line')} of the report, marked above: ` : 'Names none of the report\'s fact lines, so check it against the report before you use it.'}
            {used.map((f, i) => (
              <span key={f}>
                {i ? ', ' : ''}
                <Button className="btn btn--small" aria-label={`${f}: ${lines.get(f)?.label ?? ''} ${lines.get(f)?.text ?? ''}`} onPress={() => document.getElementById(`fact-${f}`)?.scrollIntoView({ block: 'center' })}>
                  {f}
                </Button>
              </span>
            ))}
            {used.length ? '.' : ''}
            {answer.unverified && answer.unverified.length > 0 ? ` It names ${plural(answer.unverified.length, 'id')} its tools never returned.` : ''}
          </p>
        </section>
      )}
    </div>
  );
}
