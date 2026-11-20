/**
 * The Summary tab's top (#552): the status sentence as the biggest text on the
 * page, one line on why, a fold that shows the sums, and at most three cards
 * for what needs attention. The sentences and cards are worked out in
 * src/model/summary.ts; this only draws them. A status is a word and a shape,
 * never a colour alone. Each card is one button, a drill-in (#657): the item, in the
 * drawer or on its page as the person chose under Customize, or the page behind the
 * card (what blocks what, code reviews, Tickets). A card says two lines and "and N
 * more"; the rest is the page it opens. Nothing here sends or changes anything, bar
 * the Ticket rules card's Fix with AI agent, which only proposes. The executive summary, read aloud by the
 * summary itself. Words that name a toil concept are chosen where the sentence
 * is built (src/model/summary.ts), so an item's title is shown exactly as the
 * tracker has it.
 */

import type { ReactNode } from 'react';
import { useBriefingPrefs } from '../briefing-prefs.ts';
import { Help } from './help.tsx';
import { useData } from '../data.ts';
import { commandCenterHref, dependenciesHref, itemHref } from '../format.ts';
import { ChevronRightIcon } from './icons.tsx';
import { DisclosureBody } from './disclosure.tsx';
import { drillClick } from '../motion.ts';
import type { Answer, Card } from '../model/summary.ts';
import type { Status } from '../model/status.ts';
import './summary.css';

type Kind = 'ok' | 'warn' | 'danger' | 'info';

const KIND: Record<Status | Card['tone'], Kind> = { 'on-track': 'ok', 'at-risk': 'warn', behind: 'danger', none: 'info', ok: 'ok', warn: 'warn', danger: 'danger' };

/** A check, a triangle, a square or a ring: the status again, for anyone who can't tell the colours apart. */
export function Shape({ tone }: { tone: Status | Card['tone'] }) {
  const kind = KIND[tone];
  return (
    <svg className="sum-shape" data-shape={kind} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {kind === 'ok' && (
        <>
          <circle cx="12" cy="12" r="11" fill="currentColor" />
          <path d="M7 12.5l3.2 3.2L17 8.8" fill="none" stroke="var(--bg)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {kind === 'warn' && (
        <>
          <path d="M12 1.8L23 21H1z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth="1.5" />
          <path d="M12 9v5.4M12 17.4v.2" fill="none" stroke="var(--bg)" strokeWidth="2.6" strokeLinecap="round" />
        </>
      )}
      {kind === 'danger' && (
        <>
          <rect x="1.5" y="1.5" width="21" height="21" rx="4" fill="currentColor" />
          <path d="M8 8l8 8M16 8l-8 8" fill="none" stroke="var(--bg)" strokeWidth="2.6" strokeLinecap="round" />
        </>
      )}
      {kind === 'info' && (
        <>
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2.6" />
          <circle cx="12" cy="12" r="2.6" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/**
 * The status sentence, its estimate label, the one line on why, and the sums one step in. `badge` says who worked it out
 * ("Rules, no AI") right on the headline, with the whole sentence in its tooltip, so the source never leaves the screen
 * (principle 4) and costs one word, not a line.
 */
export function AnswerHero({ answer, badge }: { answer: Answer; badge?: { text: string; title: string } }) {
  return (
    <div className="sum-hero" data-status={answer.status}>
      {badge && (
        <p className="sum-badge-row">
          <span className="sum-badge" title={badge.title} data-briefing-by="code">
            <span aria-hidden="true">{badge.text}</span>
            <span className="sr-only">{badge.title}</span>
          </span>
        </p>
      )}
      <h2 className="sum-answer" data-answer="">
        {answer.bare ? (
          <span className="sum-status">
            <Shape tone={answer.status} />
            <span>{answer.sentence}</span>
          </span>
        ) : (
          <>
            <span className="sum-status">
              <Shape tone={answer.status} />
              <span>{answer.word}</span>
            </span>
            <span aria-hidden="true">: </span>
            <span className="sr-only">. </span>
            {answer.sentence}
          </>
        )}
      </h2>
      <p className="sum-why" data-why="">
        {answer.why}
      </p>
      <div className="sum-howrow">
        <details className="sum-how">
          <summary className="btn btn--secondary btn--sm">How was this worked out?</summary>
          <DisclosureBody>
          <ul>
            {/* Why there is no pace yet is part of how the answer was reached, not a second headline (#657, round 5). */}
            {answer.basis && <li className="sum-basis">{answer.basis}.</li>}
            {answer.how.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          </DisclosureBody>
        </details>
        <Help topic="status" />
      </div>
    </div>
  );
}

/** Where a card's button goes: its item, or the page behind it. Stories that can't start open what blocks what, and stories not ready open Tickets. */
function cardHref(c: Card, toilProject: string, page: boolean): string | null {
  if (!c.action) return null;
  if (c.id === 'blocked') return dependenciesHref(toilProject);
  if (c.id === 'ready') return commandCenterHref(toilProject);
  return c.action.item && page ? itemHref(toilProject, c.action.item) : c.action.href;
}

/**
 * The card's line on why, short enough for about two lines without an ellipsis cutting a phrase (#657): a long one keeps
 * its first sentence, and the whole line is in the tooltip and on the page the card opens. A card that says a read
 * failed keeps every word, since that is a failure to show, never to fold (principle 4).
 */
export function cardWhy(c: Pick<Card, 'id' | 'why' | 'tone'>, max = 110): string {
  if (c.why.length <= max || (c.id === 'clear' && c.tone !== 'ok')) return c.why;
  const first = /^.+?[.!?](?=\s+[A-Z0-9“"‘']|$)/.exec(c.why)?.[0];
  return first && first.length < c.why.length ? first : c.why;
}

/** One card's face: its kicker with the shape, its title, its one line on why, and "and N more". */
function CardFace({ c, more }: { c: Card; more?: string | undefined }) {
  return (
    <>
      <span className="sum-kicker">
        <Shape tone={c.tone} />
        <span>{c.kicker}</span>
      </span>
      <span className="sum-card__title">
        {c.title}
        {c.key && <span className="sum-key"> {c.key}</span>}
      </span>
      <span className="sum-card__why" title={c.why === cardWhy(c) ? undefined : c.why}>
        {cardWhy(c)}
      </span>
      {more && <span className="sum-card__more">{more}</span>}
    </>
  );
}

/**
 * Up to three cards, one per row on a phone, side by side on a wide screen, and the Ticket rules card after them when
 * the team's rules are missed. Each card is one button that opens what it is about.
 */
export function NeedsAttention({ cards, extra }: { cards: Card[]; extra?: ReactNode }) {
  const { toilProject } = useData();
  const { opensIn } = useBriefingPrefs();
  return (
    <section className="sum-needs" aria-labelledby="needs-title">
      <h2 id="needs-title" className="sum-section-head">
        Needs attention
      </h2>
      <ul className="sum-cards">
        {cards.map((c) => {
          const href = cardHref(c, toilProject.name, opensIn === 'page');
          return (
            <li key={c.id} className="sum-card" data-card={c.id} data-tone={c.tone}>
              {href ? (
                <a className="sum-card__hit" href={href} data-card-item={c.action?.item} data-press="" onClick={drillClick}>
                  <CardFace c={c} more={c.more} />
                  <ChevronRightIcon size={16} className="sum-card__chevron" />
                </a>
              ) : (
                <div className="sum-card__body">
                  <CardFace c={c} more={c.more} />
                </div>
              )}
            </li>
          );
        })}
        {extra}
      </ul>
    </section>
  );
}

/** A card that isn't one of the model's (the Ticket rules card): the same face and button, with room for an action beside it. */
export function ExtraCard({ id, tone, kicker, title, why, more, href, action }: { id: string; tone: Card['tone']; kicker: string; title: string; why: string; more?: string; href: string; action?: ReactNode }) {
  const c: Card = { id: 'clear', kicker, title, key: null, why, named: [], action: null, tone };
  return (
    <li className="sum-card" data-card={id} data-tone={tone}>
      <a className="sum-card__hit" href={href} data-press="" onClick={drillClick}>
        <CardFace c={c} more={more} />
        <ChevronRightIcon size={16} className="sum-card__chevron" />
      </a>
      {action && <div className="sum-card__action">{action}</div>}
    </li>
  );
}
