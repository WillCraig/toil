/**
 * The Summary tab's top (#552): the status sentence as the biggest text on the
 * page, one line on why, a fold that shows the sums, and at most three cards
 * for what needs attention. The sentences and cards are worked out in
 * src/model/summary.ts; this only draws them. A status is a word and a shape,
 * never a colour alone. Every card's one link only opens something, in the drawer or on
 * the item's page as the person chose under Customize; nothing here sends or
 * changes anything. The executive summary, read aloud by the
 * summary itself. Words that name a toil concept are chosen where the sentence
 * is built (src/model/summary.ts), so an item's title is shown exactly as the
 * tracker has it.
 */

import { useBriefingPrefs } from '../briefing-prefs.ts';
import { Help } from './help.tsx';
import { useData } from '../data.ts';
import { itemHref } from '../format.ts';
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

/** The status sentence, its estimate label, the one line on why, and the sums one step in. */
export function AnswerHero({ answer }: { answer: Answer }) {
  return (
    <div className="sum-hero" data-status={answer.status}>
      <h2 className="sum-answer" data-answer="">
        <span className="sum-status">
          <Shape tone={answer.status} />
          <span>{answer.word}</span>
        </span>
        <span aria-hidden="true">: </span>
        <span className="sr-only">. </span>
        {answer.sentence}
      </h2>
      {answer.basis && <p className="sum-basis">{answer.basis}.</p>}
      <p className="sum-why" data-why="">
        {answer.why}
      </p>
      <div className="sum-howrow">
        <details className="sum-how">
          <summary>How was this worked out?</summary>
          <ul>
            {answer.how.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
        <Help topic="status" />
      </div>
    </div>
  );
}

/** Up to three cards, one per row on a phone, side by side on a wide screen. */
export function NeedsAttention({ cards }: { cards: Card[] }) {
  const { toilProject } = useData();
  const { opensIn } = useBriefingPrefs();
  return (
    <section className="sum-needs" aria-labelledby="needs-title">
      <h2 id="needs-title" className="briefing__label">
        Needs attention
      </h2>
      <ul className="sum-cards">
        {cards.map((c) => (
          <li key={c.id} className="sum-card" data-card={c.id} data-tone={c.tone}>
            <p className="sum-kicker">
              <Shape tone={c.tone} />
              <span>{c.kicker}</span>
            </p>
            <h3 className="sum-card__title">
              {c.action ? (
                <a href={c.action.item && opensIn === 'page' ? itemHref(toilProject.name, c.action.item) : c.action.href} data-card-item={c.action.item}>
                  {c.title}
                </a>
              ) : (
                c.title
              )}
              {c.key && <span className="sum-key"> {c.key}</span>}
            </h3>
            <p className="sum-card__why">{c.why}</p>
            {c.named.length > 0 && (
              <ul className="sum-named">
                {c.named.map((n, i) => (
                  <li key={i}>
                    <span className="sum-named__text">{n.text}</span>
                    {(n.meta || n.key) && (
                      <span className="sum-named__sub">
                        {n.meta}
                        {n.meta && n.key ? ' · ' : ''}
                        {n.key && <span className="sum-key">{n.key}</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {c.more && <p className="sum-card__more">{c.more}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
