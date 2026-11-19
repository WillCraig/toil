/**
 * The Agents sidebar (#394), beside every toil project tab, or a drawer on a
 * narrower screen: the tracker's inbox, then the toil project's assignments as
 * small cards in three groups, those that need you, those working and those
 * gone stale, with the finished ones folded under Earlier; then Renew all
 * stale, the limits, and the toil project's recent analyses (#395). It replaced the Agents
 * lane, a panel halfway down the old dashboard, and reads the same
 * assignments the same way (./views.tsx). Same trays, nearer the desk.
 */

import { useState } from 'react';
import { Button } from 'react-aria-components';
import { NavButton } from '../components/nav-button.tsx';
import { Help } from '../components/help.tsx';
import { StaleNote } from '../components/stale.tsx';
import { usePlain } from '../plain-words.ts';
import { useChatScope, type Turn } from '../components/ask.tsx';
import { useData } from '../data.ts';
import { analysesHref, analysisHref, boardHref, dateTime, shortKey } from '../format.ts';
import { pending, renewRefusal, type Assignment } from './model.ts';
import { InboxRow, Limits, RenewAll, StateChip, assignmentHref, useAssignments } from './views.tsx';
import './assign.css';
import { AgentMark } from '../components/agent-mark.tsx';

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

/**
 * One assignment, small (#657): its state, the item's title as the button into the assignment, and one muted line
 * ("SCRUM-32 · 1 question"). Out of date is a chip and a Run again button; what changed is in the chip's tooltip and on
 * the assignment's Run details, never on the card. The adapter, its run time and the mode are on the assignment's page.
 */
function AgentCard({ a, onChanged }: { a: Assignment; onChanged: () => void }) {
  const { byId, assignments: api } = useData();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noun = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const pendingN = a.proposals.filter((p) => p.status === 'pending').length;
  const item = byId.get(a.item);
  const line = [
    // The tracker's key, never toil's own id (`jira:SCRUM-15`): an item this read doesn't hold still shows its key.
    item ? shortKey(item) : a.item.replace(/^[^:]+:/, ''),
    a.state === 'needs-you' && pendingN ? `${pendingN} ${noun(pendingN, 'suggestion', 'suggestions')} to review` : '',
    a.state === 'needs-you' && a.questions.length ? `${a.questions.length} ${noun(a.questions.length, 'question', 'questions')}` : '',
  ].filter(Boolean);
  const canRenew = Boolean(a.stale && api && !api.disabled && !renewRefusal(a));
  return (
    <li className="agent-card" data-card="">
      <p className="agent-card__top">
        <StateChip a={a} />
      </p>
      <NavButton href={assignmentHref(a.toilProject, a.id)} kind="quiet" row className="agent-card__title">
        {a.itemTitle}
      </NavButton>
      <p className="note agent-card__line">{line.join(' · ')}</p>
      {/* A failure is the one thing a card always says in full (principle 4). */}
      {a.state === 'failed' && a.stop && <p className="failure">{a.stop.message}</p>}
      {a.stale && !a.renewedBy && (
        <StaleNote
          stale={a.stale}
          {...(canRenew
            ? {
                action: (
                  <Button
                    className="btn btn--secondary btn--sm"
                    isDisabled={busy}
                    onPress={async () => {
                      if (!api) return;
                      setBusy(true);
                      setProblem(null);
                      try {
                        await api.renew(a.id);
                        onChanged();
                      } catch (e) {
                        setProblem(e instanceof Error ? e.message : String(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                    data-run-again=""
                  >
                    <AgentMark />
                    Run again<span className="sr-only"> on {a.itemTitle}</span>
                  </Button>
                ),
              }
            : {})}
        />
      )}
      {a.renewedBy && (
        <p>
          <NavButton href={assignmentHref(a.toilProject, a.renewedBy)} kind="quiet" size="sm">
            Renewed as a fresh assignment
          </NavButton>
        </p>
      )}
      {problem && (
        <p role="alert" className="failure">
          {problem}
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
              <NavButton href={analysisHref(toilProject.name, a.id)} kind="quiet" row>
                <span className="note">{dateTime(a.at)}</span>
                <span className="sr-only">, </span> <span>{a.recommendation ? plainText(a.recommendation) : 'No recommendation line.'}</span>
              </NavButton>
            </li>
          ))}
        </ul>
      ) : (
        !running && <p className="note">None yet.</p>
      )}
      <NavButton href={analysesHref(toilProject.name)} kind="quiet" size="sm">
        {plain.pw('All analyses', 'All earlier briefings')}
      </NavButton>
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
  const { toilProject, assignments: api } = useData();
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
          Nothing assigned yet.{' '}
          <NavButton href={boardHref(toilProject.name)} size="sm">
            Assign from the board
          </NavButton>
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
                <AgentCard key={a.id} a={a} onChanged={reload} />
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
                <AgentCard key={a.id} a={a} onChanged={reload} />
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
