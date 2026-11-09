/**
 * A toil project's people (#292): one card per person in the toil project's `people`,
 * agents included, with their work in progress by status and how long each
 * item has sat there, their open pull requests, the reviews waiting on them,
 * what blocks them and what they did lately; a team strip with work in
 * progress against the toil project's limit, the review queue and the sprint's
 * unassigned items; accounts the toil project doesn't map, with matches to
 * approve. Everything comes from src/model/people.ts over the same OWI items
 * and changes the dashboard reads. It shows what is on each plate and never
 * scores or ranks anyone: cards are in name order and no figure sets one
 * person against another. The org chart, minus the boxes nobody updates.
 */

import { useId, useMemo, useState } from 'react';
import { Avatar } from '../components/bits.tsx';
import { ItemLink, PrLink } from '../components/items.tsx';
import { Card, CardGrid, Cluster, Stack } from '../components/layout.tsx';
import { Panel } from '../components/panel.tsx';
import { EditLink, Help } from '../components/help.tsx';
import { useData } from '../data.ts';
import { Empty, EmptyLink } from '../components/empty.tsx';
import { boardHref, dateTime, toilProjectHref, sourceLabel, toilProjectEditHref } from '../format.ts';
import { ACTIVITY_DAYS, people, type Activity, type Card as PersonCard, type Identity, type Suggestion } from '../model/people.ts';
import { daysText, WAITING_LABEL } from '../model/prs.ts';
import { useTerm, useTheme, useThemeChoiceContext } from '../skins.tsx';
import { wordingOn } from '../theme-context.ts';
import { rolled } from '../model/alignment.ts';
import './people.css';
import { AgentAssignments } from '../assign/views.tsx';
import { failedOutcome, OutcomeLine, outcomeOf, type Outcome } from './settings/parts.tsx';
import { MapIdentity, SaveToRepo } from './people-map.tsx';

const round1 = (n: number) => Math.round(n * 10) / 10;
const calendarDays = (n: number) => `${round1(n)} ${round1(n) === 1 ? 'day' : 'days'}`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const identityText = (i: Identity) => `${sourceLabel(i.area)} ${i.name && i.name !== i.id ? `${i.id} (${i.name})` : i.id}`;

export function People() {
  const { toilProject, now } = useData();
  const term = useTerm();
  const alignments = useAlignments();
  const view = useMemo(
    () => people({ toilProject: toilProject.name, entries: toilProject.people ?? [], wipLimit: toilProject.wipLimit ?? null, items: toilProject.items, changes: toilProject.pullRequests ?? [], now }),
    [toilProject, now],
  );
  const calls = [...toilProject.calls.toilProject, ...toilProject.calls.work, ...toilProject.calls.prs];
  const humans = view.people.filter((c) => c.who.kind === 'human').length;
  const agents = view.people.length - humans;

  return (
    <>
      <div className="view-head">
        <p className="eyebrow">
          <a href={toilProjectHref(toilProject.name)}>{toilProject.name}</a>
        </p>
        <h1 tabIndex={-1}>{term('people', 'People')}</h1>
        <p className="lede">
          {view.people.length
            ? `${[humans ? count(humans, 'person', 'people') : '', agents ? count(agents, 'agent') : ''].filter(Boolean).join(' and ')} from the Toil project's people, and ${count(view.unmapped.length, 'account')} it doesn't map.`
            : `This Toil project lists nobody yet, so each account its data names has a card of its own (${view.unmapped.length}).`}{' '}
          Read {dateTime(now)}; work in progress counts work items, not the epics and features that hold them. <Help topic="people" />
        </p>
        {!view.people.length && (
          <p className="note">
            Say who is who across systems in the Toil project's people, in Settings, Toil projects.{' '}
            <EditLink href={toilProjectEditHref(toilProject.name, 'people')} label={`Edit ${toilProject.name}'s people`} />
          </p>
        )}
        {(toilProject.peopleNotes ?? []).map((n, i) => (
          <p key={i} role="note" className="failure">
            {n}
          </p>
        ))}
      </div>

      <Panel id="team" title="Team" calls={calls} alerts={false}>
        <TeamStrip view={view} />
      </Panel>

      {view.people.length > 0 && (
        <section className="people-section" aria-labelledby="people-cards">
          <div className="edit-head">
            <h2 id="people-cards">People and agents</h2>
            <EditLink href={toilProjectEditHref(toilProject.name, 'people')} label={`Edit ${toilProject.name}'s people`} />
            {alignments && <Help topic="alignments" />}
          </div>
          <SaveToRepo />
          <CardGrid min="md" className="people-cards">
            {view.people.map((c) => (
              <li key={c.who.key}>
                <PersonCardView card={c} limit={view.wipLimit} />
              </li>
            ))}
          </CardGrid>
        </section>
      )}

      <AgentAssignments people={toilProject.people ?? []} />

      {(view.suggestions.length > 0 || view.ambiguous.length > 0) && (
        <Panel id="matches" title="Possible matches" calls={toilProject.calls.toilProject} alerts={false}>
          <p className="note">Accounts that share an email with a person, or with an account in another system. Nothing is mapped until you approve it, and an email that fits more than one person suggests nothing.</p>
          {view.suggestions.length > 0 && (
            <ul className="rows">
              {view.suggestions.map((s) => (
                <li key={`${s.name}:${s.input.id.join(',')}`}>
                  <SuggestionRow suggestion={s} />
                </li>
              ))}
            </ul>
          )}
          {view.ambiguous.map((a, i) => (
            <p key={i} className="evidence">
              {a}
            </p>
          ))}
        </Panel>
      )}

      <section className="people-section" aria-labelledby="unmapped-cards">
        <h2 id="unmapped-cards">{view.people.length ? 'Not in the Toil project\'s people' : 'Accounts in this Toil project\'s data'}</h2>
        <p className="note">
          Each account the data names that the Toil project doesn't map to a person, with something on its plate.
          {view.bots.length > 0 && ` ${count(view.bots.length, 'bot account')} (${view.bots.map((b) => b.id).join(', ')}) only wrote bots' pull requests and ${view.bots.length === 1 ? 'is' : 'are'} left out.`}
        </p>
        {view.unnamedAgents.length > 0 && (
          <p className="note">
            {count(view.unnamedAgents.length, 'pull request')} {view.unnamedAgents.length === 1 ? 'was' : 'were'} written with an agent the Toil project's people don't name ({[...new Set(view.unnamedAgents.map((c) => c.authorKindSignal ?? 'an agent account'))].join('; ')}). Press Map on its account below, and choose AI agent, to give it a card.
          </p>
        )}
        {view.unmapped.length ? (
          <CardGrid min="md" className="people-cards">
            {view.unmapped.map((c) => (
              <li key={c.who.key}>
                <PersonCardView card={c} limit={view.wipLimit} />
              </li>
            ))}
          </CardGrid>
        ) : (
          <Empty
            message={view.people.length ? 'Every account with work on its plate is mapped to someone.' : "This Toil project's data names nobody with work on their plate."}
            action={
              <EmptyLink edit href={toilProjectEditHref(toilProject.name, 'people')}>
                Add a person
              </EmptyLink>
            }
          />
        )}
      </section>
    </>
  );
}

function TeamStrip({ view }: { view: ReturnType<typeof people> }) {
  const { wip, reviewQueue, unassigned } = view.team;
  const oldest = reviewQueue[0];
  return (
    <CardGrid as="ul" min="sm" className="team-strip">
      <li>
        <Stack gap="xs" className="team-tile">
          <h3>Work in progress</h3>
          <p className="team-figure">{wip.total}</p>
          <p className="note">
            {wip.limit === null ? (
              // The pencil after the note sets one (#417), so the note no longer spells out the command.
              <>No limit is set in the Toil project.</>
            ) : wip.over.length ? (
              <>
                Limit {wip.limit} per person. Over it: {wip.over.map((o) => `${o.name} (${o.count})`).join(', ')}.
              </>
            ) : (
              <>Limit {wip.limit} per person. Nobody is over it.</>
            )}{' '}
            <EditLink href={toilProjectEditHref(view.toilProject, 'wip')} label={`Edit ${view.toilProject}'s work-in-progress limit`} />
          </p>
        </Stack>
      </li>
      <li>
        <Stack gap="xs" className="team-tile">
          <h3>Review queue</h3>
          <p className="team-figure">{reviewQueue.length}</p>
          <p className="note">
            {oldest ? (
              <>
                Open pull requests waiting on a review. Longest: <PrLink change={oldest.change} />, {oldest.wait.days === null ? 'for an unknown time' : daysText(oldest.wait.days)}.
              </>
            ) : (
              'No open pull request waits on a review.'
            )}
          </p>
        </Stack>
      </li>
      <li>
        <Stack gap="xs" className="team-tile">
          <h3>Unassigned this sprint</h3>
          <p className="team-figure">{unassigned ? unassigned.items.length : '–'}</p>
          {unassigned ? (
            unassigned.items.length ? (
              <ul className="plain cites" aria-label={`Unassigned in ${unassigned.sprint}`}>
                {unassigned.items.map((i) => (
                  <li key={i.id}>
                    <ItemLink id={i.id} withTitle />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="note">Everything in {unassigned.sprint} that isn't done has someone on it.</p>
            )
          ) : (
            <p className="note">No sprint is current in this Toil project's data.</p>
          )}
        </Stack>
      </li>
    </CardGrid>
  );
}

/** The theme's rolled alignments (#415), while its wording is on; Plain and every theme without them have none. */
function useAlignments() {
  const theme = useTheme();
  const choice = useThemeChoiceContext();
  return wordingOn(theme, choice) ? theme.alignments : undefined;
}

function PersonCardView({ card, limit }: { card: PersonCard; limit: number | null }) {
  const { toilProject } = useData();
  const alignments = useAlignments();
  const { who } = card;
  const id = `who-${who.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const seen = who.identities.find((i) => i.name) ?? who.identities[0];
  return (
    <Card className="person-card" aria-labelledby={id}>
      <Stack gap="sm">
        <div className="person-head">
          <Avatar person={{ id: seen?.id ?? who.name, name: who.name, email: who.email }} />
          <h3 id={id}>{who.name}</h3>
          <ul className="person-tags" aria-label={`About ${who.name}`}>
            {who.kind === 'agent' && <li className="person-tag">Agent</li>}
            {!who.mapped && <li className="person-tag">Not mapped</li>}
            {card.overLimit && <li className="person-tag person-tag--warn">Over the limit: {card.wipCount} of {limit}</li>}
            {alignments && (
              <li className="person-tag person-tag--roll">
                {alignments.label}: {rolled(alignments.values, who.key)}
              </li>
            )}
          </ul>
        </div>
        <p className="note any-break">{who.identities.length ? who.identities.map(identityText).join(' · ') : 'No identities in the Toil project yet.'}</p>
        {!who.mapped && who.identities[0] && <MapIdentity account={who.identities[0]} />}
        <p>
          <a href={boardHref(toilProject.name, who.key)}>{who.name}'s items on the board</a>
        </p>

        <h4>
          In progress <span className="field">({card.wipCount}{limit !== null ? ` of ${limit}` : ''})</span>
        </h4>
        {card.wip.length ? (
          card.wip.map((group) => (
            <div key={group.status} className="person-group">
              <p className="person-status">{group.status}</p>
              <ul className="plain">
                {group.items.map((w) => (
                  <li key={w.item.id}>
                    <ItemLink id={w.item.id} withTitle />
                    <span className="field"> {w.days === null ? 'time in this status not recorded' : `for ${calendarDays(w.days)}`}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className="note">Nothing in progress.</p>
        )}

        <h4>Open pull requests</h4>
        {card.prs.length ? (
          <ul className="plain">
            {card.prs.map((p) => (
              <li key={p.change.id}>
                <PrLink change={p.change} withTitle />
                <span className="field">
                  {' '}
                  {WAITING_LABEL[p.wait.on]}, {p.wait.days === null ? 'for an unknown time' : daysText(p.wait.days)}
                  {p.withAgent && `; written with ${p.withAgent}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">None open.</p>
        )}

        <h4>Reviews waiting on them</h4>
        {card.reviews.length ? (
          <ul className="plain">
            {card.reviews.map((r) => (
              <li key={r.change.id}>
                <PrLink change={r.change} withTitle />
                <span className="field"> {r.days === null ? 'opened at an unknown time' : `open ${daysText(r.days)}`}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">None waiting.</p>
        )}

        <h4>Blocked</h4>
        {card.blocked.length ? (
          <ul className="plain">
            {card.blocked.map((b) => (
              <li key={b.item.id}>
                <ItemLink id={b.item.id} withTitle />
                <span className="field"> blocked by </span>
                {b.by.map((x, i) => (
                  <span key={x.id}>
                    {i > 0 && ', '}
                    <ItemLink id={x.id} />
                    {x.item ? <span className="field"> ({x.item.status ?? 'not done'})</span> : <span className="field"> (not in this Toil project, so its status is unknown)</span>}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">Nothing blocked.</p>
        )}

        <h4>
          Recent activity <span className="field">(last {ACTIVITY_DAYS} days)</span>
        </h4>
        {card.activity.length ? (
          <ul className="plain">
            {card.activity.map((a, i) => (
              <li key={i}>
                <ActivityLine a={a} />
              </li>
            ))}
            {card.moreActivity > 0 && <li className="note">and {card.moreActivity} more</li>}
          </ul>
        ) : (
          <p className="note">Nothing recorded.</p>
        )}
      </Stack>
    </Card>
  );
}

function ActivityLine({ a }: { a: Activity }) {
  const when = <span className="field"> {a.at.slice(0, 10)}</span>;
  if (a.kind === 'moved') {
    return (
      <>
        Moved <ItemLink id={a.item.id} /> {a.from ? `from ${a.from} ` : ''}to {a.to}
        {when}
      </>
    );
  }
  if (a.kind === 'merged') {
    return (
      <>
        Their pull request merged: <PrLink change={a.change} />
        {when}
      </>
    );
  }
  const said = a.state === 'APPROVED' ? 'Approved' : a.state === 'CHANGES_REQUESTED' ? 'Asked for changes on' : a.state === 'DISMISSED' ? 'Had a review dismissed on' : 'Commented on';
  return (
    <>
      {said} <PrLink change={a.change} />
      {when}
    </>
  );
}

/** One suggested match: what it rests on, the command that applies it, and a button that runs it only when pressed. */
function SuggestionRow({ suggestion: s }: { suggestion: Suggestion }) {
  const { config, refresh } = useData();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const offId = useId();
  const off = !config ? "This view can't change Toil projects here. Match people across tools in Settings, Toil projects." : config.disabled;
  const apply = async () => {
    if (!config || off) return;
    setBusy(true);
    try {
      const e = await config.run(s.command, s.input);
      setOutcome(outcomeOf(e, `Mapped in ${s.input.toilProject}'s people. Reload the Toil project to see the cards change.`));
    } catch (e) {
      setOutcome(failedOutcome(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="xs">
      <p>
        {s.person ? (
          <>
            <strong>{s.identities.map(identityText).join(', ')}</strong> {s.identities.length === 1 ? 'has' : 'have'} {s.person}'s email ({s.email}): probably {s.person}.
          </>
        ) : (
          <>
            <strong>{s.identities.map(identityText).join(' and ')}</strong> share the email {s.email}: probably one person, {s.name}.
          </>
        )}
      </p>
      <Cluster>
        <button type="button" className="btn btn--accent" onClick={apply} disabled={off !== null || busy || outcome?.ok === true} aria-describedby={off ? offId : undefined}>
          {busy ? 'Running…' : s.person ? `Map to ${s.person}` : `Add ${s.name}`}
        </button>
        {off && (
          <span id={offId} className="note">
            Turned off: {off}
          </span>
        )}
      </Cluster>
      <OutcomeLine outcome={outcome} />
      {outcome?.ok && refresh && (
        <p>
          <button type="button" className="btn" onClick={refresh}>
            Reload the Toil project
          </button>
        </p>
      )}
    </Stack>
  );
}
