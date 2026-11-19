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
 * person against another. Each card is one summary line (the name, in progress N,
 * in review N) that opens to the rest, and the sprint's unassigned items open from
 * their count, so the page is a list to scan before it is anything to read
 * (principle 11). The org chart, minus the boxes nobody updates.
 */

import { NavButton } from '../components/nav-button.tsx';
import { useId, useMemo, useState } from 'react';
import { Avatar } from '../components/bits.tsx';
import { ItemLink, ItemRows, PrLink } from '../components/items.tsx';
import { Card, CardGrid, Cluster, Stack } from '../components/layout.tsx';
import { Panel } from '../components/panel.tsx';
import { EditLink, Help, InfoTip } from '../components/help.tsx';
import { Dash } from './Standup.tsx';
import { DisclosureBody, SummaryChevron } from '../components/disclosure.tsx';
import { useData } from '../data.ts';
import { Empty, EmptyLink } from '../components/empty.tsx';
import { boardHref, dateTime, toilProjectHref, sourceLabel, toilProjectEditHref } from '../format.ts';
import { ACTIVITY_DAYS, people, type Activity, type Card as PersonCard, type Identity, type Suggestion } from '../model/people.ts';
import { daysText, WAITING_LABEL } from '../model/prs.ts';
import { useTheme, useThemeChoiceContext } from '../skins.tsx';
import { wordingOn } from '../theme-context.ts';
import { rolled } from '../model/alignment.ts';
import './people.css';
import { AgentAssignments } from '../assign/views.tsx';
import { failedOutcome, OutcomeLine, outcomeOf, type Outcome } from './settings/parts.tsx';
import { MapIdentity, SaveToRepo } from './people-map.tsx';
import { DimensionPicker } from '../components/dimension-picker.tsx';
import { useAddress, useWorkInsights } from '../insights-data.ts';
import { PERSON_MIX_DIMENSIONS } from '../model/lanes.ts';
import { PersonMix } from './person-mix.tsx';
import './lanes.css';

const round1 = (n: number) => Math.round(n * 10) / 10;
const calendarDays = (n: number) => `${round1(n)} ${round1(n) === 1 ? 'day' : 'days'}`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const identityText = (i: Identity) => `${sourceLabel(i.area)} ${i.name && i.name !== i.id ? `${i.id} (${i.name})` : i.id}`;

export function People() {
  const { toilProject, now } = useData();
  const alignments = useAlignments();
  const view = useMemo(
    () => people({ toilProject: toilProject.name, entries: toilProject.people ?? [], wipLimit: toilProject.wipLimit ?? null, items: toilProject.items, changes: toilProject.pullRequests ?? [], now }),
    [toilProject, now],
  );
  const calls = [...toilProject.calls.toilProject, ...toilProject.calls.work, ...toilProject.calls.prs];
  const unmappedWhy = `Each account the data names that the Toil project doesn't map to a person, with something on its plate.${view.bots.length > 0 ? ` ${count(view.bots.length, 'bot account')} (${view.bots.map((b) => b.id).join(', ')}) only wrote bots' pull requests and ${view.bots.length === 1 ? 'is' : 'are'} left out.` : ''}`;
  const ins = useWorkInsights();
  const { query, go } = useAddress();
  // One menu for every card: what kind of work each person's open work is sorted by. It lives in the address, so a link shows the same bars.
  const asked = query.get('mix');
  const mixBy = PERSON_MIX_DIMENSIONS.find((d) => d === asked) ?? 'category';
  const teams = useMemo(() => peopleByTeam(view.people, toilProject.people ?? []), [view.people, toilProject.people]);
  const humans = view.people.filter((c) => c.who.kind === 'human').length;
  const agents = view.people.length - humans;

  return (
    <>
      <div className="view-head">
        <p className="eyebrow">
          <NavButton href={toilProjectHref(toilProject.name)} kind="quiet" size="sm" className="eyebrow-btn">
            {toilProject.name}
          </NavButton>
        </p>
        <p className="lede">
          {view.people.length
            ? `${[humans ? count(humans, 'person', 'people') : '', agents ? count(agents, 'agent') : ''].filter(Boolean).join(' and ')}, and ${count(view.unmapped.length, 'account')} not mapped.`
            : `Nobody is listed yet, so each account its data names has a card of its own (${view.unmapped.length}).`}{' '}
          Read {dateTime(now)}.{' '}
          <Help topic="people" note="Work in progress counts work items, not the epics and features that hold them." />
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
          <div className="people-tools control-row">
            <span className="control-row__group">
            <DimensionPicker label="Show each person's work by" value={mixBy} options={PERSON_MIX_DIMENSIONS} ins={ins} onChange={(spec) => go((q) => (spec === null || spec === 'category' ? q.delete('mix') : q.set('mix', spec)))} />
            <Help topic="people-mix" />
            </span>
          </div>
          {teams ? (
            teams.map((t) => (
              <section key={t.name} className="people-team" aria-labelledby={`team-${t.id}`} data-team={t.name}>
                <h3 id={`team-${t.id}`} className="people-team__head">
                  {t.name}{' '}
                  <span className="field">
                    {count(t.cards.length, 'person', 'people')}, {t.wip} in progress
                  </span>
                </h3>
                <CardGrid min="md" className="people-cards">
                  {t.cards.map((c) => (
                    <li key={c.who.key}>
                      <PersonCardView card={c} limit={view.wipLimit} mixBy={mixBy} />
                    </li>
                  ))}
                </CardGrid>
              </section>
            ))
          ) : (
            <CardGrid min="md" className="people-cards">
              {view.people.map((c) => (
                <li key={c.who.key}>
                  <PersonCardView card={c} limit={view.wipLimit} mixBy={mixBy} />
                </li>
              ))}
            </CardGrid>
          )}
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
        {/* What the section holds is its heading's (i) (#657); which bots were left out is part of that. */}
        <h2>
          <span id="unmapped-cards">{view.people.length ? "Not in the Toil project's people" : "Accounts in this Toil project's data"}</span>{' '}
          <InfoTip label="accounts not in the people" tip={unmappedWhy}>
            <p>{unmappedWhy}</p>
          </InfoTip>
        </h2>
        {view.unnamedAgents.length > 0 && (
          <p className="note">
            {count(view.unnamedAgents.length, 'pull request')} {view.unnamedAgents.length === 1 ? 'was' : 'were'} written with an agent the Toil project's people don't name ({[...new Set(view.unnamedAgents.map((c) => c.authorKindSignal ?? 'an agent account'))].join('; ')}). Press Map on its account below, and choose AI agent, to give it a card.
          </p>
        )}
        {view.unmapped.length ? (
          <CardGrid min="md" className="people-cards">
            {view.unmapped.map((c) => (
              <li key={c.who.key}>
                <PersonCardView card={c} limit={view.wipLimit} mixBy={mixBy} />
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
              // The rows open from the count, so this tile stands as tall as its neighbours and leaves no hole under them.
              <details className="team-more" data-unassigned-more="">
                <summary>
                  <SummaryChevron />
                  Show {unassigned.items.length === 1 ? 'the item' : `the ${unassigned.items.length} items`}
                </summary>
                <DisclosureBody>
                  <ItemRows ids={unassigned.items.map((i) => i.id)} label={`Unassigned in ${unassigned.sprint}`} />
                </DisclosureBody>
              </details>
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

/**
 * The cards under their team's heading, teams in name order and people in name order inside each, or null when nobody has a
 * team (today's flat layout). Someone with no team goes last, under "No team". A team's line is its headcount and its work
 * in progress, the team strip's own figure, and never a comparison between teams or between people.
 */
export function peopleByTeam(cards: PersonCard[], entries: Array<{ name: string; team?: string }>): Array<{ id: string; name: string; cards: PersonCard[]; wip: number }> | null {
  const teamOf = new Map(entries.map((e) => [e.name, e.team ?? null]));
  const teamed = cards.map((c) => ({ c, team: teamOf.get(c.who.name) ?? null }));
  if (!teamed.some((t) => t.team !== null)) return null;
  const names = [...new Set(teamed.map((t) => t.team))].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  return names.map((team, i) => {
    const mine = teamed.filter((t) => t.team === team).map((t) => t.c).sort((a, b) => a.who.name.localeCompare(b.who.name));
    return { id: String(i), name: team ?? 'No team', cards: mine, wip: mine.reduce((n, c) => n + c.wipCount, 0) };
  });
}

function PersonCardView({ card, limit, mixBy = 'category' }: { card: PersonCard; limit: number | null; mixBy?: string }) {
  const { toilProject } = useData();
  const alignments = useAlignments();
  const { who } = card;
  const id = `who-${who.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const seen = who.identities.find((i) => i.name) ?? who.identities[0];
  const read = readParts(toilProject);
  const { none, unread } = emptyParts(card, read);
  const accounts = who.identities.length ? who.identities.map(identityText).join(' · ') : 'No identities in the Toil project yet.';
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
        {!who.mapped && who.identities[0] && <MapIdentity account={who.identities[0]} />}
        <details className="person-more" data-person-more="">
          {/* The summary is named by its own text, not an aria-label over it, so what a voice user sees and says agree (WCAG 2.5.3). */}
          <summary>
            <SummaryChevron />
            <span className="sr-only">{`${who.name}: ${plateText(card, limit, read)}. Show the details`}</span>
            <PlateLine card={card} limit={limit} read={read} />
          </summary>
          <DisclosureBody>
            <Stack gap="sm">
              {/* A person's accounts are one press in with the rest of the card (#657), not an (i) repeated on every card. */}
              <p className="note any-break" data-person-accounts="">
                Accounts: {accounts}
              </p>
              <p>
                <NavButton href={boardHref(toilProject.name, who.key)} size="sm" aria-label={`${who.name}'s items on the board`}>
                  On the board
                </NavButton>
              </p>
              <PersonMix name={who.name} dimension={mixBy} />

              {card.wip.length > 0 && (
                <>
                  <h4>
                    In progress <span className="field">({card.wipCount}{limit !== null ? ` of ${limit}` : ''})</span>
                  </h4>
                  {card.wip.map((group) => (
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
                  ))}
                </>
              )}

              {card.prs.length > 0 && (
                <>
                  <h4>Open pull requests</h4>
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
                </>
              )}

              {card.reviews.length > 0 && (
                <>
                  <h4>Reviews waiting on them</h4>
                  <ul className="plain">
                    {card.reviews.map((r) => (
                      <li key={r.change.id}>
                        <PrLink change={r.change} withTitle />
                        <span className="field"> {r.days === null ? 'opened at an unknown time' : `open ${daysText(r.days)}`}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {card.blocked.length > 0 && (
                <>
                  <h4>Blocked</h4>
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
                </>
              )}

              {card.activity.length > 0 && <RecentActivity card={card} />}

              <Empties none={none} unread={unread} />
            </Stack>
          </DisclosureBody>
        </details>
      </Stack>
    </Card>
  );
}

/** A figure on the plate line: the count when its part was read, a dash read aloud as "not read yet" when not (principle 12). */
const plateFigure = (n: number, read: boolean) => (read ? String(n) : '–');

/** The plate line in words, for the summary's name: "in progress 2 of 3, in review 1". */
function plateText(card: PersonCard, limit: number | null, read: { work: boolean; prs: boolean }): string {
  const wip = read.work ? `${card.wipCount}${limit !== null ? ` of ${limit}` : ''}` : 'not read yet';
  return `in progress ${wip}, in review ${read.prs ? card.prs.length : 'not read yet'}`;
}

/** A card's one summary line: what is in progress and what is in review (their open code reviews), each a figure or a dash. */
function PlateLine({ card, limit, read }: { card: PersonCard; limit: number | null; read: { work: boolean; prs: boolean } }) {
  return (
    <span className="person-plate" aria-hidden="true">
      <span>
        In progress <b>{plateFigure(card.wipCount, read.work)}</b>
        {read.work && limit !== null && <span className="field"> of {limit}</span>}
      </span>
      <span>
        In review <b>{plateFigure(card.prs.length, read.prs)}</b>
      </span>
    </span>
  );
}

/** How many activity lines a card shows before the rest fold behind "+N". */
const ACTIVITY_SHOWN = 3;

/** The card's recent activity: three lines, then a "+N" that opens the rest, which the model capped itself (what lay beyond that is counted, not listed). */
function RecentActivity({ card }: { card: PersonCard }) {
  const [open, setOpen] = useState(false);
  const shown = open ? card.activity : card.activity.slice(0, ACTIVITY_SHOWN);
  const folded = card.activity.length - shown.length;
  return (
    <>
      <h4>
        Recent activity <span className="field">(last {ACTIVITY_DAYS} days)</span>
      </h4>
      <ul className="plain">
        {shown.map((a, i) => (
          <li key={i}>
            <ActivityLine a={a} />
          </li>
        ))}
        {open && card.moreActivity > 0 && <li className="note">and {card.moreActivity} more</li>}
      </ul>
      {!open && folded + card.moreActivity > 0 && (
        <button type="button" className="btn btn--small btn--quiet" aria-expanded={false} onClick={() => setOpen(true)} data-activity-more="">
          +{folded + card.moreActivity}
          <span className="sr-only"> more activity lines</span>
        </button>
      )}
    </>
  );
}

type Part = 'In progress' | 'Open pull requests' | 'Reviews waiting' | 'Blocked' | 'Recent activity';

/**
 * Which parts of a card were read at all: work items come from the work calls, pull requests from the pull request calls. A
 * failed call, or a Toil project that reads no pull requests at all, is unknown and not none (principle 12).
 */
function readParts(toilProject: { calls: { work: Array<{ ok: boolean }>; prs: Array<{ ok: boolean }> }; readTargets?: Array<{ work: boolean; pullRequests: boolean }> }) {
  const targets = toilProject.readTargets;
  return {
    work: (!targets || targets.some((t) => t.work)) && !toilProject.calls.work.some((c) => !c.ok),
    prs: (!targets || targets.some((t) => t.pullRequests)) && !toilProject.calls.prs.some((c) => !c.ok),
  };
}

/** The parts a card has nothing in, split into those that were read and found empty and those never read. */
export function emptyParts(card: PersonCard, read: { work: boolean; prs: boolean }): { none: Part[]; unread: Part[] } {
  const parts: Array<[Part, boolean, boolean]> = [
    ['In progress', card.wip.length === 0, read.work],
    ['Open pull requests', card.prs.length === 0, read.prs],
    ['Reviews waiting', card.reviews.length === 0, read.prs],
    ['Blocked', card.blocked.length === 0, read.work],
    ['Recent activity', card.activity.length === 0, read.work && read.prs],
  ];
  return { none: parts.filter(([, empty, ok]) => empty && ok).map(([p]) => p), unread: parts.filter(([, empty, ok]) => empty && !ok).map(([p]) => p) };
}

/** The empty parts of a card as one muted line each: a dash, read aloud as "none" or "not read yet", then their names. */
function Empties({ none, unread }: { none: Part[]; unread: Part[] }) {
  return (
    <>
      {none.length > 0 && (
        <p className="note person-empties" data-empties="none">
          <Dash /> {none.join(' · ')}
        </p>
      )}
      {unread.length > 0 && (
        <p className="note person-empties" data-empties="not-read">
          <Dash what="not read yet" /> {unread.join(' · ')}
        </p>
      )}
    </>
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
