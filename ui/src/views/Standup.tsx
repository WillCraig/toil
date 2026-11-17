/**
 * The stand-up (#345): the worklog's days, reshaped for a meeting by code
 * (src/model/standup.ts), as tight as a page can be. One row of controls (the
 * days, and the one Copy text button), one source line, one team line, then a
 * block per person, agents included: a small person, the name, and five rows in
 * a fixed order, Done, In progress, Blocked, Next, Comments, each a few chips
 * that link to their item. An empty row is a dash; a person with nothing at all
 * is one line. Comments are the reminder: a person's unanswered questions come
 * first. The same range always gives the same report, and posting it anywhere is
 * a proposal for a person to run. "Write it up" asks the agent for a short
 * narrative of the same facts, labelled as the agent's, and Export writes the
 * Markdown to a file; both sit folded at the bottom. Fifteen minutes, standing,
 * with the minutes already taken.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, Form, Input, Label, TextField } from 'react-aria-components';
import type { Answer } from '../agent.ts';
import { PersonGlyph } from '../components/avatar.tsx';
import { Cited } from '../components/items.tsx';
import { Path } from '../components/layout.tsx';
import { Help } from '../components/help.tsx';
import { ProposalCard } from '../components/proposal.tsx';
import { useData } from '../data.ts';
import { itemHref, sourceLabel, standupHref, worklogHref } from '../format.ts';
import { allLines, BUCKETS, BUCKET_TITLE, chipsOf, commentsReadFor, defaultRange, factsCited, groupTitle, PRESET_LABEL, PRESETS, presetOf, presetRange, rangeProblem, shorten, standupWriteUp, whenText, type Bucket, type Chip, type Preset, type StandupGroup, type StandupLine, type StandupReport } from '../model/standup.ts';
import { health } from '../model/sprint.ts';
import { dayOf, shortDay, timeOf } from '../model/worklog.ts';
import { useTheme, useThemeChoiceContext } from '../skins.tsx';
import { voiceOn } from '../theme-context.ts';
import type { WorklogApi, WorklogExport, WorklogStandup } from '../worklog.ts';
import { Loader } from '../moments/Moments.tsx';
import { HelpIcon } from '../components/icons.tsx';
import './standup.css';

export type Loaded<T> = { ok: true; value: T } | { ok: false; message: string } | null;
const failedWith = (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The chips a row shows before "+N". */
export const ROW_CHIPS = 3;
/** The longest title on a chip, and the longest comment excerpt, in characters. */
const TITLE_CHARS = 34;
const EXCERPT_CHARS = 80;

/** A link that goes to the web as the tracker gave it: anything but http(s) is not followed. */
const httpUrl = (url: string | null): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

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
  const { now } = useData();
  const today = dayOf(now)!;
  const explicit = Boolean(from && to);
  const range = from && to ? { from, to } : defaultRange(today);
  const [loaded, setLoaded] = useStandupReport(api, range);

  if (!api) {
    return (
      <p role="alert" className="failure">
        This Toil UI keeps no worklog, so it has no stand-up to fold from one.
      </p>
    );
  }
  return (
    <div className="standup">
      <div className="standup-bar">
        <DaysControl key={`${range.from}/${range.to}`} range={range} explicit={explicit} today={today} />
        <CopyText value={loaded?.ok ? loaded.value.text : null} />
      </div>
      {ignored && (
        <p role="status" className="note">
          “{ignored}” isn't a day as yyyy-mm-dd, so this is since the last working day instead.
        </p>
      )}
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
  );
}

/** The days: a menu of presets that apply at once, and two dates only for Custom. */
function DaysControl({ range, explicit, today }: { range: { from: string; to: string }; explicit: boolean; today: string }) {
  const { toilProject, now } = useData();
  const sprintStart = useMemo(() => dayOf(health(toilProject.items, [], now)?.sprint.start), [toilProject.items, now]);
  const current = presetOf(range, explicit, today, sprintStart);
  const [custom, setCustom] = useState(current === 'custom');
  const shown: Preset = custom ? 'custom' : current;
  const go = (r: { from: string; to: string } | null) => {
    window.location.hash = r ? standupHref(toilProject.name, r) : standupHref(toilProject.name);
  };
  const pick = (p: Preset) => {
    if (p === 'custom') {
      setCustom(true);
      return;
    }
    setCustom(false);
    if (p === 'default') go(null);
    else {
      const r = presetRange(p, today, sprintStart);
      if (r) go(r);
    }
  };
  return (
    <div className="standup-days">
      <select className="standup-select" aria-label="Days" value={shown} onChange={(e) => pick(e.target.value as Preset)} data-standup-days="">
        {PRESETS.map((p) => (
          <option key={p} value={p} disabled={p === 'sprint' && !presetRange('sprint', today, sprintStart)}>
            {PRESET_LABEL[p]}
          </option>
        ))}
      </select>
      {shown === 'custom' && <CustomDates from={range.from} to={range.to} today={today} go={go} />}
    </div>
  );
}

/** Two dates, applied as soon as both make a range a stand-up can cover. */
function CustomDates({ from, to, today, go }: { from: string; to: string; today: string; go: (r: { from: string; to: string }) => void }) {
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  const problem = a && b ? rangeProblem(a, b, today) : null;
  const set = (x: string, y: string) => {
    setA(x);
    setB(y);
    if (x && y && rangeProblem(x, y, today) === null && (x !== from || y !== to)) go({ from: x, to: y });
  };
  return (
    <>
      <input className="standup-date" type="date" aria-label="From" value={a} max={today} onChange={(e) => set(e.target.value, b)} />
      <span aria-hidden="true">–</span>
      <input className="standup-date" type="date" aria-label="To" value={b} max={today} onChange={(e) => set(a, e.target.value)} />
      {problem && (
        <span role="alert" className="note standup-problem">
          {problem}
        </span>
      )}
    </>
  );
}

/** The one Copy text button: the whole stand-up as short plain text. If the browser refuses, the text is shown to select. */
function CopyText({ value }: { value: string | null }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  useEffect(() => setCopied(null), [value]);
  return (
    <div className="standup-copy">
      <Button className="btn" isDisabled={value === null} onPress={() => void copy()} data-standup-copy="">
        {copied ? 'Copied' : 'Copy text'}
      </Button>
      <span role="status" className="sr-only">
        {copied === null ? '' : copied ? 'Copied the stand-up as text.' : "This browser wouldn't copy; select the text shown instead."}
      </span>
      {copied === false && value !== null && <textarea className="standup-fallback" readOnly rows={6} value={value} aria-label="The stand-up as text" onFocus={(e) => e.currentTarget.select()} />}
    </div>
  );
}

/** A dash for an empty row, which says what it stands for to anything that reads it aloud: "none", or "not read yet" where nothing was read (principle 12). */
export function Dash({ what = 'none' }: { what?: 'none' | 'not read yet' }) {
  return (
    <span className="standup-dash" title={what} data-dash={what === 'none' ? 'none' : 'not-read'}>
      <span aria-hidden="true">–</span>
      <span className="sr-only">{what}</span>
    </span>
  );
}

/** No good sync behind the report: an empty list is unknown, not zero (principle 12), so it says so beside the way to read. */
export function NotRead() {
  const { sync } = useData();
  return (
    <p className="note" data-not-read="">
      <Dash what="not read yet" /> Not read yet: nothing has been read for these days.{' '}
      {sync && (
        <Button className="btn btn--small" onPress={sync} data-sync-now="">
          Sync now
        </Button>
      )}
    </p>
  );
}

/** "Jira, GitHub and pull requests". */
const listOf = (names: string[]) => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** What the comments were read from, in a clause: the trackers that came with their comments, and those that didn't. Pull requests' comments are not read by Toil UI yet, so they are always named. */
export function commentsSource(report: Pick<StandupReport, 'comments'>): string {
  const unread = [...report.comments.notRead.map(sourceLabel), 'pull requests'];
  return report.comments.read.length ? `Comments read for ${listOf(report.comments.read.map(sourceLabel))}, not for ${listOf(unread)}` : `Comments not read for ${listOf(unread)}`;
}

/** Where the report came from, on one line that stays on screen; the rest is behind the (i). */
function SourceLine({ report }: { report: StandupReport }) {
  const asOf = report.asOf;
  const year = report.to.slice(0, 4);
  const when = asOf ? `${shortDay(dayOf(asOf)!).replace(` ${year}`, '')} ${timeOf(asOf)} UTC` : null;
  return (
    <p className="standup-source note" data-standup-source="">
      {asOf ? (
        <>
          From the worklog, as of the sync at <time dateTime={asOf}>{when}</time>
        </>
      ) : (
        'From the worklog. No sync has run yet, so review waits, the sprint and Next are not read yet'
      )}
      {' · '}
      {commentsSource(report)} <Help topic="standup" />
    </p>
  );
}

/** What a chip says when hovered: the full title, what happened and when. */
function chipTitle(report: StandupReport, chip: Chip): string {
  if (chip.comment) return `${chip.label} ${chip.title ?? ''}\n${chip.texts[0] ?? ''}${chip.at ? `\n${whenText(report, chip.lines[0]!)}` : ''}`;
  return [`${chip.label}${chip.title ? ` ${chip.title}` : ''}`, ...chip.texts.map((t, i) => (chip.lines[i]?.at ? `${t} (${whenText(report, chip.lines[i]!)})` : t))].join('\n');
}

/** Where a chip's key goes: its item in this app, a pull request or build where the source has a page, or the worklog day an assignment ran on. */
function SubjectLink({ chip, label }: { chip: Chip; label?: string }) {
  const { byId, toilProject } = useData();
  const text = label ?? chip.label;
  const line = chip.lines[0]!;
  if (byId.has(chip.subject)) return <a className="standup-key" href={itemHref(toilProject.name, chip.subject)}>{text}</a>;
  if (chip.subject.startsWith('run:') && line.day) return <a className="standup-key" href={worklogHref(toilProject.name, line.day)}>{text}</a>;
  const url = httpUrl(chip.url);
  return url ? (
    <a className="standup-key" href={url}>
      {text}
    </a>
  ) : (
    <span className="standup-key">{text}</span>
  );
}

function ChipView({ report, chip, bucket, cited }: { report: StandupReport; chip: Chip; bucket: Bucket; cited: Set<string> }) {
  const isCited = chip.lines.some((l) => cited.has(l.fact));
  const ids = chip.lines.slice(1).map((l) => <span key={l.fact} id={`fact-${l.fact}`} />);
  const c = chip.comment;
  if (c) {
    const url = httpUrl(chip.url);
    const excerpt = `“${shorten(chip.texts[0] ?? '', EXCERPT_CHARS)}”`;
    return (
      <span className="standup-chip standup-chip--comment" data-truncate="" id={`fact-${chip.key}`} data-cited={isCited || undefined} data-outstanding={c.outstanding || undefined} title={chipTitle(report, chip)}>
        {c.outstanding && (
          <span className="standup-q" role="img" aria-label="Unanswered question" title="A question nobody has answered">
            <HelpIcon size={16} />
          </span>
        )}
        <SubjectLink chip={chip} />
        {url ? (
          <a className="standup-excerpt" href={url} target="_blank" rel="noopener noreferrer">
            {excerpt}
          </a>
        ) : (
          <span className="standup-excerpt">{excerpt}</span>
        )}
        {c.outstanding && <span className="standup-wait">{c.ageDays ? `no reply, ${c.ageDays} d` : 'no reply yet'}</span>}
      </span>
    );
  }
  return (
    <span className="standup-chip" data-truncate="" id={`fact-${chip.key}`} data-cited={isCited || undefined} title={chipTitle(report, chip)}>
      <SubjectLink chip={chip} />
      {chip.title && <span className="standup-title">{shorten(chip.title, TITLE_CHARS)}</span>}
      {bucket === 'blocked' && chip.texts[0] && <span className="standup-why">{shorten(chip.texts[0], 40)}</span>}
      {ids}
    </span>
  );
}

/** One row of a person's block, or of the Summary's list: a short label and its chips, folded after three. */
export function BucketRow({ report, group, bucket, lines, cited }: { report: StandupReport; group: StandupGroup; bucket: Bucket; lines: StandupLine[]; cited: Set<string> }) {
  const chips = useMemo(() => chipsOf(lines), [lines]);
  const [all, setAll] = useState(false);
  const hiddenCited = chips.slice(ROW_CHIPS).some((c) => c.lines.some((l) => cited.has(l.fact)));
  const open = all || hiddenCited;
  const shown = open ? chips : chips.slice(0, ROW_CHIPS);
  const unread = report.asOf === null || (bucket === 'comments' && !commentsReadFor(report, group));
  return (
    <div className="standup-row" data-bucket={bucket}>
      <dt>{BUCKET_TITLE[bucket]}</dt>
      <dd>
        {chips.length ? (
          <>
            {shown.map((c) => (
              <ChipView key={c.key} report={report} chip={c} bucket={bucket} cited={cited} />
            ))}
            {chips.length > ROW_CHIPS && (
              <Button className="standup-fold" aria-expanded={open} onPress={() => setAll(!open)}>
                {open ? 'Fewer' : `+${chips.length - ROW_CHIPS}`}
                <span className="sr-only"> {open ? `of ${BUCKET_TITLE[bucket]}` : `more in ${BUCKET_TITLE[bucket]}`}</span>
              </Button>
            )}
          </>
        ) : (
          <Dash what={unread ? 'not read yet' : 'none'} />
        )}
      </dd>
    </div>
  );
}

/** A person: a small person (an agent gets its own shape) and the name; an account the Toil project doesn't map says which it is. */
export function PersonName({ group }: { group: StandupGroup }) {
  const name = groupTitle({ ...group, kind: 'human' });
  return (
    <span className="standup-name" data-kind={group.kind}>
      <PersonGlyph agent={group.kind === 'agent'} />
      <span className="standup-name__text">{name}</span>
      {group.kind === 'agent' && <span className="sr-only"> (agent)</span>}
    </span>
  );
}

function PersonBlock({ report, group, cited }: { report: StandupReport; group: StandupGroup; cited: Set<string> }) {
  const id = `standup-${group.key.replace(/[^A-Za-z0-9-]/g, '-')}`;
  const count = BUCKETS.reduce((n, b) => n + group.lines[b].length, 0);
  if (count === 0) {
    return (
      <li className="standup-person standup-person--empty" id={id}>
        <PersonName group={group} />
        <Dash what={report.asOf === null ? 'not read yet' : 'none'} />
      </li>
    );
  }
  return (
    <li className="standup-person" id={id} {...(!group.mapped && group.key !== 'none' ? { title: "Not in the Toil project's people: an account the People view can map to someone." } : {})}>
      <h2 className="standup-person__head">
        <PersonName group={group} />
      </h2>
      <dl className="standup-rows">
        {BUCKETS.map((b) => (
          <BucketRow key={b} report={report} group={group} bucket={b} lines={group.lines[b]} cited={cited} />
        ))}
      </dl>
    </li>
  );
}

/** The team in one line: the sprint, then what changed for everyone (scope, builds), folded after three. */
function TeamLine({ report, cited }: { report: StandupReport; cited: Set<string> }) {
  const facts = report.team.filter((l) => !l.subject.startsWith('sprint:'));
  const chips = chipsOf(facts);
  const [all, setAll] = useState(false);
  const shown = all ? chips : chips.slice(0, ROW_CHIPS);
  return (
    <div className="standup-team" id="standup-team" data-standup-team="">
      <span className="standup-team__sprint">{report.sprintLine ?? (report.asOf ? 'No current sprint' : 'Sprint not read yet')}</span>
      {shown.map((c) => (
        <span key={c.key} className="standup-chip" data-truncate="" id={`fact-${c.key}`} data-cited={c.lines.some((l) => cited.has(l.fact)) || undefined} title={chipTitle(report, c)}>
          <SubjectLink chip={c} />
          <span className="standup-title">{c.texts[0] ?? ''}</span>
        </span>
      ))}
      {chips.length > ROW_CHIPS && (
        <Button className="standup-fold" aria-expanded={all} onPress={() => setAll(!all)}>
          {all ? 'Fewer' : `+${chips.length - ROW_CHIPS}`}
        </Button>
      )}
    </div>
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
      <SourceLine report={report} />
      <TeamLine report={report} cited={cited} />
      {report.gaps.length > 0 && (
        <details className="standup-gaps">
          <summary>Coverage: {plural(report.gaps.length, 'gap')}</summary>
          <ul>
            {report.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </details>
      )}
      {report.people.length ? (
        <ul className="standup-people">
          {report.people.map((g) => (
            <PersonBlock key={g.key} report={report} group={g} cited={cited} />
          ))}
        </ul>
      ) : (
        <p className="note">
          <Dash /> Nobody is in the Toil project's people, and the worklog recorded nobody on these days.
        </p>
      )}
      <details className="standup-more" data-standup-writeup-section="">
        <summary>Write it up with the agent</summary>
        {moved && (
          <p role="status" className="note">
            A sync landed while the agent wrote, so the report above was built again from what the agent read, and its fact numbers match the write-up.
          </p>
        )}
        <WriteUp report={report} answer={writeUp} onAnswer={(a) => void answered(a)} />
      </details>
      <details className="standup-more" data-standup-export-section="">
        <summary>Export as a Markdown file</summary>
        <Export api={api} data={data} />
      </details>
    </>
  );
}

/** Export writes the Markdown to a new file in a folder the person names, through toil's file service; publishing it is a proposal. */
function Export({ api, data }: { api: WorklogApi; data: WorklogStandup }) {
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
    <div className="standup-export">
      <p className="note">Writes the full report as Markdown to a new file in a folder you name, through toil's own file service. Publishing it to Confluence or GitHub is then a proposal, for you to run through toil's write gate.</p>
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
    <div className="standup-writeup-body">
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
