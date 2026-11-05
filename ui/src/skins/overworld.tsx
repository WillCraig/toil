/**
 * Overworld's skins (#414): a top-down 16-bit adventure. A board card carries
 * its loot by column (a closed chest in To do, a key in hand In progress, an
 * open chest with its gem once Done), the board and the sprint's chart carry
 * a heart meter for the working days still ahead and a gem counter for the
 * points carried home, the agent answers as an old sage in his dialogue box,
 * an empty list is an empty dungeon room, and while a view loads the sage
 * tends his fire (kept as the fallback: a wait shows the moments' map
 * scroll, #439). All of it is pixel art drawn or generated for this theme,
 * hidden from screen readers: the words beside it already say what it shows.
 * Every quest is entered in the log before the sage is consulted.
 */

import { useContext, type ReactNode } from 'react';
import { DataContext, useDerived } from '../data.ts';
import type { Skins } from '../skins.tsx';
import { useTerm } from '../theme-context.ts';
import type { StatusCategory } from '../toil.ts';

const art = (file: string) => new URL(`../../themes/overworld/assets/${file}`, import.meta.url).href;

/** The loot for each column: a chest not yet opened, a key in hand, a chest opened. */
export const LOOT: Record<StatusCategory, { src: string; height: number }> = {
  TODO: { src: art('chest.svg'), height: 20 },
  IN_PROGRESS: { src: art('key.svg'), height: 14 },
  DONE: { src: art('chest-open.svg'), height: 22 },
  UNKNOWN: { src: art('chest.svg'), height: 20 },
};

/** A heart for a working day still ahead, and one for a day spent. */
export const HEART = { full: art('heart.svg'), empty: art('heart-empty.svg') };

/**
 * The heart meter and the gem counter: one heart for each working day of the
 * sprint, full for each day still ahead, and the points done of the points in
 * it. The panel beside it says the same in words.
 */
function Hud() {
  const { health: h } = useDerived();
  if (!h) return null;
  const left = Math.max(0, h.days.total - h.days.gone);
  const scope = h.done.points + h.remaining.points;
  return (
    <p className="ow-hud" aria-hidden="true">
      <span className="ow-hearts">
        {Array.from({ length: h.days.total }, (_, i) => (
          <img key={i} src={i < left ? HEART.full : HEART.empty} alt="" width={14} height={14} />
        ))}
      </span>
      <span className="ow-gems">
        <img src={art('gem.svg')} alt="" width={14} height={12} />
        {h.done.points}/{scope}
      </span>
    </p>
  );
}

function Panel({ id, children }: { id: string; children: ReactNode }) {
  // A panel can sit outside a toil project, so the meter only asks for the sprint inside one.
  const inToilProject = useContext(DataContext) !== null;
  return (
    <>
      {(id === 'sprint' || id === 'board') && inToilProject && <Hud />}
      {children}
    </>
  );
}

function Sage({ children }: { children: ReactNode }) {
  const term = useTerm();
  return (
    <div className="bubble bubble--agent ow-sage">
      <img className="ow-portrait" src={art('sage.webp')} alt="" width={48} height={55} loading="lazy" decoding="async" />
      <div className="ow-sage-text">
        <p className="ow-sage-name">{term('agent', 'Agent')}</p>
        {children}
      </div>
    </div>
  );
}

export const overworldSkins: Partial<Skins> = {
  Card: ({ item, children }) => (
    <>
      {children}
      <img className={`ow-loot ow-loot--${item.statusCategory.toLowerCase()}`} src={LOOT[item.statusCategory].src} alt="" width={24} height={LOOT[item.statusCategory].height} loading="lazy" decoding="async" />
    </>
  ),
  Panel,
  ChatMessage: ({ from, children }) => (from === 'agent' ? <Sage>{children}</Sage> : <div className="bubble bubble--you">{children}</div>),
  EmptyState: ({ message, children }) => (
    <div className="skin-empty skin-empty--art ow-room">
      <img src={art('empty-room.webp')} alt="" width={240} height={183} loading="lazy" decoding="async" />
      <p>{message}</p>
      {children}
    </div>
  ),
  Loading: ({ message }) => (
    <div className="skin-loading skin-empty--art ow-cave" role="status">
      <img src={art('sage-cave.webp')} alt="" width={240} height={196} decoding="async" />
      <p>{message}</p>
    </div>
  ),
};
