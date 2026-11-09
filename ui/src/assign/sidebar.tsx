/**
 * The Agents sidebar (#394), beside every toil project tab, or a drawer on a
 * narrower screen: the tracker's inbox, then the toil project's assignments as
 * small cards in three groups, those that need you, those working and those
 * gone stale, with the finished ones folded under Earlier; then Renew all
 * stale, the limits, and the toil project's recent analyses (#395). It replaced the Agents
 * lane, a panel halfway down the old dashboard, and reads the same
 * assignments the same way (./views.tsx). Same trays, nearer the desk.
 */

import { ItemLink } from '../components/items.tsx';
import { Help } from '../components/help.tsx';
import { StaleNote } from '../components/stale.tsx';
import { usePlain } from '../plain-words.ts';
import { useChatScope, type Turn } from '../components/ask.tsx';
import { useData } from '../data.ts';
import { analysesHref, analysisHref, boardHref, dateTime } from '../format.ts';
import { ADAPTER_NAME, modeInfo, pending, runMs, runText, type Assignment } from './model.ts';
import { InboxRow, Limits, RenewAll, StateChip, assignmentHref, useAssignments } from './views.tsx';
import './assign.css';

type Group = 'needs-you' | 'working' | 'stale' | 'earlier';
const GROUP_LABEL: Record<Group, string> = { 'needs-you': 'Needs you', working: 'Working', stale: 'Stale', earlier: 'Earlier' };
const PLAIN_GROUP_LABEL: Record<Group, string> = { ...GROUP_LABEL, stale: 'Out of date' };

const inInbox = (a: Assignment) => a.state === 'queued' && a.waiting === 'start';

/** Which group an assignment sits in: what it waits on first, then whether it has gone stale, then everything finished. */
export function groupOf(a: Assignment): Group {
  if (a.state === 'needs-you') return 'needs-you';
  if (a.state === 'working' || a.state === 'queued') return 'working';
  if (a.stale && !a.renewedBy) return 'stale';
  return 'earlier';
}

/**
 * What waits on a person, for the Agents button: the tracker's inbox, plus the proposals to approve (a proposal that
 * failed to apply is still waiting) and the questions to answer on assignments that need you, plus each assignment that
 * failed. A failure is counted because the panel starts closed: a button that stays quiet about one is a silent failure
 * (principle 4). A count of things to look at, so the number on the button is the number of things behind it.
 */
export function waitingOnYou(assignments: Assignment[]): number {
  return assignments.reduce((n, a) => n + (inInbox(a) ? 1 : a.state === 'failed' ? 1 : a.state === 'needs-you' ? a.proposals.filter(pending).length + a.questions.length : 0), 0);
}

/** How many things wait on a person, for the button that opens the panel. */
export function useAgentsSummary(): { needsYou: number } {
  const { toilProject } = useData();
  const { list } = useAssignments(toilProject.name);
  return { needsYou: waitingOnYou(list?.assignments ?? []) };
}

/** One assignment, small: its state, the item, what it waits on, and the way in. */
function AgentCard({ a, now }: { a: Assignment; now: string }) {
  const plain = usePlain();
  const noun = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const pending = a.proposals.filter((p) => p.status === 'pending').length;
  const needs = [pending ? `${pending} ${plain.on ? noun(pending, 'suggestion', 'suggestions') : noun(pending, 'proposal', 'proposals')} to review` : '', a.questions.length ? `${a.questions.length} ${a.questions.length === 1 ? 'question' : 'questions'}` : ''].filter(Boolean).join(', ');
  return (
    <li className="agent-card" data-card="">
      <p className="agent-card__top">
        <StateChip a={a} /> <span className="assign-mode">{modeInfo(a.mode, plain.on).label}</span>
      </p>
      <p className="agent-card__item">
        <ItemLink id={a.item} />{' '}
        <a className="agent-card__title" href={assignmentHref(a.toilProject, a.id)}>
          {a.itemTitle}
        </a>
      </p>
      <p className="note">
        {a.state === 'needs-you' && needs ? `${needs}. ` : ''}
        {a.state === 'failed' && a.stop ? `${a.stop.message} ` : ''}
        {a.adapter ? ADAPTER_NAME[a.adapter] : plain.pw('No adapter yet', 'No AI chosen yet')} · {runText(a.ranMs ?? runMs(a, now))}
      </p>
      {a.stale && <StaleNote stale={a.stale} />}
      {a.renewedBy && (
        <p className="note">
          Renewed as <a href={assignmentHref(a.toilProject, a.renewedBy)}>a fresh assignment</a>.
        </p>
      )}
    </li>
  );
}

/** The chat's Analyze answers in this page, newest first. */
export function analysesOf(turns: Turn[]): Turn[] {
  return turns.filter((t) => t.analyze).reverse();
}

/** The three newest analyses the toil project keeps (#395), the same list the Analyses tab shows, and one being written now. */
function RecentAnalyses() {
  const { toilProject } = useData();
  const plain = usePlain();
  const chat = useChatScope();
  const running = analysesOf(chat?.turns ?? []).find((t) => !t.done);
  const list = (chat?.history.list ?? []).slice(0, 3);
  return (
    <section className="agents-side__analyses" aria-labelledby="recent-analyses">
      <h3 id="recent-analyses">{plain.pw('Recent analyses', 'Recent briefings')}</h3>
      {chat?.history.error && <p className="failure">{chat.history.error}</p>}
      {running && <p className="note analysis-line">{plain.pw('Analyze is answering now.', 'A briefing is being written now.')}</p>}
      {list.length ? (
        <ul className="plain">
          {list.map((a) => (
            <li key={a.id} className="analysis-line">
              <a href={analysisHref(toilProject.name, a.id)}>
                <span className="note">{dateTime(a.at)}</span>
                <span className="sr-only">, </span> <span>{a.recommendation ? plainText(a.recommendation) : 'No recommendation line.'}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        !running && <p className="note">None yet.</p>
      )}
      <a href={analysesHref(toilProject.name)}>{plain.pw('All analyses', 'All past briefings')}</a>
    </section>
  );
}

/** Text with its citations as their keys, cut to one sentence: for a line with no room for chips. */
export function plainText(text: string): string {
  const flat = text.replace(/\[\[([^\]]+)\]\]/g, (_, id: string) => id.slice(id.indexOf(':') + 1)).replace(/\s+/g, ' ').trim();
  const first = /^(.{1,140}?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat.slice(0, 140);
  return first.length < flat.length && !/[.!?]$/.test(first) ? `${first}…` : first;
}

/** The sidebar itself, the same inside the drawer and beside the view. */
export function AgentsSidebar() {
  const { toilProject, now, assignments: api } = useData();
  const plain = usePlain();
  const { list, error, reload } = useAssignments(toilProject.name);
  const inbox = list?.assignments.filter(inInbox) ?? [];
  const rest = list?.assignments.filter((a) => !inInbox(a)) ?? [];
  const groups = (['needs-you', 'working', 'stale', 'earlier'] as const).map((g) => ({ g, items: rest.filter((a) => groupOf(a) === g) }));
  return (
    <section className="agents-sidebar" aria-labelledby="agents">
      <div className="edit-head">
        <h2 id="agents" title={plain.title('Agents')}>
          {plain.pw('Agents', 'AI agents')}
        </h2>
        <Help topic="assignments" {...(list ? { note: `${plain.on ? (list.settings.concurrent === 1 ? 'One works at a time' : `${list.settings.concurrent} work at once`) : list.settings.concurrent === 1 ? 'One runs at a time' : `${list.settings.concurrent} run at a time`}, for up to ${list.settings.timeLimitMinutes} minutes each.` } : {})} />
      </div>
      {!api && <p className="note">{plain.text("Assigning work to an agent isn't available here.")}</p>}
      {api?.disabled && <p className="note">{api.disabled}</p>}
      {error && <p className="failure">{error}</p>}
      {list?.settings.problem && <p className="failure">{list.settings.problem}</p>}
      {inbox.length > 0 && (
        <section className="assign-inbox" aria-labelledby="agent-inbox">
          <div className="edit-head">
            <h3 id="agent-inbox" title={plain.title('Agent inbox')}>
              {plain.pw('Agent inbox', 'Asked for AI help')}
            </h3>
            <Help topic="assignments" note="The tracker asks for an agent on these. Nothing runs until you press Start." />
          </div>
          <ul className="rows">
            {inbox.map((a) => (
              <InboxRow key={a.id} a={a} onStarted={reload} />
            ))}
          </ul>
        </section>
      )}
      {list && !rest.length && (
        <p className="note">
          Nothing assigned yet. <a href={boardHref(toilProject.name)}>Assign from the board</a>
        </p>
      )}
      {groups.map(({ g, items }) =>
        items.length === 0 ? null : g === 'earlier' ? (
          <details key={g} className="agents-group agents-group--earlier">
            <summary>
              {(plain.on ? PLAIN_GROUP_LABEL : GROUP_LABEL)[g]} ({items.length})
            </summary>
            <ul className="agent-cards">
              {items.map((a) => (
                <AgentCard key={a.id} a={a} now={now} />
              ))}
            </ul>
          </details>
        ) : (
          <section key={g} className={`agents-group agents-group--${g}`} aria-labelledby={`agents-${g}`}>
            <h3 id={`agents-${g}`}>
              {(plain.on ? PLAIN_GROUP_LABEL : GROUP_LABEL)[g]} <span className="count">{items.length}</span>
            </h3>
            <ul className="agent-cards">
              {items.map((a) => (
                <AgentCard key={a.id} a={a} now={now} />
              ))}
            </ul>
          </section>
        ),
      )}
      {list && <RenewAll list={list} onDone={reload} />}
      {list && <Limits list={list} onSaved={reload} />}
      <RecentAnalyses />
    </section>
  );
}
