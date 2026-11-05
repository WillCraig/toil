/**
 * Harvest's skins (#208): a 16-bit farm. A board card is a crop that grows a
 * stage with each column it moves along (a seed in To do, a growing plant in
 * In progress, a basket once Done), the sprint panel carries a calendar page,
 * and the agent answers in a dialogue box with a portrait. All of it is
 * pixel art drawn for this theme, hidden from screen readers: the words
 * beside it already say what it shows.
 * Crops grow only as fast as the status column allows, per the planting policy.
 */

import { useContext, type ReactNode } from 'react';
import { DataContext, useDerived } from '../data.ts';
import type { Skins } from '../skins.tsx';
import { useTerm } from '../theme-context.ts';
import type { StatusCategory } from '../toil.ts';

const art = (file: string) => new URL(`../../themes/harvest/assets/${file}`, import.meta.url).href;

/** The crop for each column: it grows a stage as the item moves along. */
export const CROP: Record<StatusCategory, string> = {
  TODO: art('crop-seed.svg'),
  IN_PROGRESS: art('crop-grown.svg'),
  DONE: art('crop-harvested.svg'),
  UNKNOWN: art('crop-sprout.svg'),
};

function Sprite({ src, size = 32, className }: { src: string; size?: number; className?: string }) {
  return <img className={className} src={src} alt="" width={size} height={size} loading="lazy" decoding="async" />;
}

/** A calendar page for the sprint: one square per working day, the days gone crossed off. */
function Calendar() {
  const { health: h } = useDerived();
  if (!h) return null;
  return (
    <div className="harvest-calendar" aria-hidden="true">
      <span className="harvest-calendar-day">Day {h.days.gone}</span>
      <span className="harvest-calendar-grid">
        {Array.from({ length: h.days.total }, (_, i) => (
          <i key={i} className={i + 1 < h.days.gone ? 'gone' : i + 1 === h.days.gone ? 'today' : undefined} />
        ))}
      </span>
    </div>
  );
}

function Panel({ id, children }: { id: string; children: ReactNode }) {
  // A panel can sit outside a toil project (none do yet), so the calendar only asks for the sprint inside one.
  const inToilProject = useContext(DataContext) !== null;
  return (
    <>
      {id === 'sprint' && inToilProject && <Calendar />}
      {children}
    </>
  );
}

function Dialogue({ children }: { children: ReactNode }) {
  const term = useTerm();
  return (
    <div className="bubble bubble--agent harvest-dialogue">
      <Sprite src={art('portrait.svg')} size={48} className="harvest-portrait" />
      <div className="harvest-dialogue-text">
        <p className="harvest-name">{term('agent', 'Agent')}</p>
        {children}
      </div>
    </div>
  );
}

export const harvestSkins: Partial<Skins> = {
  Card: ({ item, children }) => (
    <>
      {children}
      <Sprite src={CROP[item.statusCategory]} className={`harvest-crop harvest-crop--${item.statusCategory.toLowerCase()}`} />
    </>
  ),
  Panel,
  ChatMessage: ({ from, children }) => (from === 'agent' ? <Dialogue>{children}</Dialogue> : <div className="bubble bubble--you">{children}</div>),
  EmptyState: ({ message, children }) => (
    <div className="skin-empty skin-empty--art harvest-empty">
      <img src={art('empty-field.svg')} alt="" width={192} height={96} loading="lazy" decoding="async" />
      <p>{message}</p>
      {children}
    </div>
  ),
  Loading: ({ message }) => (
    <div className="skin-loading skin-empty--art harvest-loading" role="status">
      <Sprite src={art('watering-can.svg')} size={64} className="harvest-can" />
      <p>{message}</p>
    </div>
  ),
};
