/**
 * Small pieces the views share: a person's avatar, a status chip in the
 * status category's colour, and an item's insight chips. Colour never carries
 * meaning alone: every chip says its word, and the avatar sits beside the
 * person's name or carries it as its label. Name tags, colour-coded, with no
 * lanyard.
 */

import { groupInsights, INSIGHT_LABEL, type Insight, type InsightCode, type InsightGroup } from '../model/insights.ts';
import { STATUS_CATEGORY_LABEL } from '../format.ts';
import { useSkins, useTerm } from '../skins.tsx';
import type { ChangeRef, StatusCategory } from '../toil.ts';
import type { AvatarProps } from './avatar.tsx';

export { hueOf, initials } from './avatar.tsx';

/** A person's avatar, through the active theme's `Avatar` skin. */
export function Avatar(props: AvatarProps) {
  const { Avatar: Skin } = useSkins();
  return <Skin {...props} />;
}

export function StatusChip({ category, status }: { category: StatusCategory; status: string | null }) {
  const label = STATUS_CATEGORY_LABEL[category];
  return (
    <span className={`chip chip--${category.toLowerCase()}`}>
      {status ?? label}
      {status && status.toLowerCase() !== label.toLowerCase() && <span className="chip-cat"> · {label}</span>}
    </span>
  );
}

/**
 * One stroked glyph per insight, drawn on a 16-unit grid in the chip's own
 * colour, for the board's compact chips. Each path is decoration: the chip's
 * word travels beside it as text, so nothing rests on the drawing alone.
 */
const INSIGHT_ICON: Record<InsightCode, string> = {
  blocked: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM3.8 12.2l8.4-8.4',
  'failing-build': 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM5.5 5.5l5 5m0-5-5 5',
  aging: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM8 4.5V8l2.5 1.5',
  'deployed-not-closed': 'M8 13V3m-4 4 4-4 4 4M3 14h10',
  carried: 'M3 9a5 5 0 0 1 9-3m0-3v3H9M13 7v6H3',
  'pr-no-build': 'M5 3v10M5 3a1.5 1.5 0 1 0 0 .01M11 13V7a2 2 0 0 0-2-2H7m0 0 1.5-1.5M7 5l1.5 1.5',
  stale: 'M4 2h8M4 14h8M5 2c0 4 6 4 6 6s-6 2-6 6M11 2c0 4-6 4-6 6s6 2 6 6',
  blocking: 'M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5ZM5 8h6',
  'built-not-deployed': 'M2.5 5 8 2l5.5 3v6L8 14l-5.5-3ZM2.5 5 8 8l5.5-3M8 8v6',
  unestimated: 'M6 6a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.5V10M8 12.5v.5',
  added: 'M8 3v10M3 8h10',
};

/**
 * An item's insights, most pressing first, up to `max` chips. One chip per
 * insight code: an item blocking two others shows "Blocking 2", not two
 * identical chips (#541), and `max` and "+N more" count chips. `titles` names
 * the items an insight cites, for the tooltip. `compact` draws each as its
 * icon alone, for the board's cards: the word stays in the chip as text for a
 * screen reader and as its tooltip, and shows beside the icon while the card
 * has keyboard focus (views.css), so a sighted keyboard user isn't left
 * decoding pictures.
 */
export function InsightChips({ insights, max = 3, compact = false, titles }: { insights: Insight[]; max?: number; compact?: boolean; titles?: ReadonlyMap<string, { title: string }> }) {
  if (!insights.length) return null;
  const groups = groupInsights(insights);
  const shown = groups.slice(0, max);
  const rest = groups.slice(max);
  return (
    <ul className={`insight-chips${compact ? ' insight-chips--compact' : ''}`} aria-label="Insights">
      {shown.map((g) => {
        const word = wordOf(g);
        return compact ? (
          <li key={g.code} className={`insight insight--icon insight--w${g.weight}`} title={groupTitle(g, word, titles)}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path d={INSIGHT_ICON[g.code]} />
            </svg>
            <span className="insight-word">{word}</span>
          </li>
        ) : (
          <li key={g.code} className={`insight insight--w${g.weight}`}>
            {word}
          </li>
        );
      })}
      {rest.length > 0 && (
        <li className="insight insight--more" {...(compact ? { title: rest.map(wordOf).join(', ') } : {})}>
          +{rest.length} more
        </li>
      )}
    </ul>
  );
}

/** A chip's word: the label, with a count when several insights share the code. */
const wordOf = (g: InsightGroup) => (g.insights.length > 1 ? `${INSIGHT_LABEL[g.code]} ${g.insights.length}` : INSIGHT_LABEL[g.code]);

/** A chip's tooltip: its word alone for one insight, else the word and what each says, cited items by title. */
function groupTitle(g: InsightGroup, word: string, titles?: ReadonlyMap<string, { title: string }>): string {
  if (g.insights.length === 1) return word;
  const said = g.insights.map((i) => i.text.replace(/\[\[(.+?)\]\]/g, (_, id: string) => titles?.get(id)?.title ?? id));
  return `${word}: ${said.join('; ')}`;
}

/**
 * A change's state. A build that passed or failed carries the theme's word for
 * how it ended, beside the real one ("Natural 20 (passed): success" in Realm,
 * #415); the state the source gave is always there, as it was.
 */
export function Outcome({ of }: { of: Pick<ChangeRef, 'state' | 'outcome'> }) {
  const term = useTerm();
  const roll = of.outcome === 'passed' || of.outcome === 'failed' ? term(of.outcome, of.outcome) : null;
  return (
    <span className={`outcome outcome--${of.outcome}`}>
      {roll && roll !== of.outcome && <span className="outcome__roll">{roll}: </span>}
      {of.state}
    </span>
  );
}
