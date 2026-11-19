/**
 * An item's category as a small chip (#567, docs/work-classification-proposal.md,
 * "How the category is named"): its plain name, "Keep the lights on", with a badge
 * for how it was decided, and its short form ("KTLO"), its definition and a Read
 * more link one hover away, in the app's own tooltip like every (i). A person
 * reads the name to act; the short form is for someone who already knows it.
 * An item nobody has sorted reads "Not sorted yet", a category of its own on the
 * screen, because an item nobody has decided about should not look like one
 * somebody has; and an unknown says so plainly (principle 12), rather than
 * "Unsure", which read as the app doubting itself (#657). The label shows what the
 * tracker holds as it holds it; this shows what toil made of it.
 *
 * The chip is display-only for now: it is a plain element with a tooltip, not a
 * button. `onPress` is the one seam a later change (reclassify) fills in; with
 * it the chip becomes a real button with the same look and tooltip, and nothing
 * else about it moves. A chip with a title attribute, in an age of tooltips, was
 * a modest thing to be proud of; this one has a stylesheet and a footnote.
 */

import { Button, Focusable, Tooltip, TooltipTrigger } from 'react-aria-components';
import type { ReactNode } from 'react';
import type { Verdict } from '../../../src/core/classify/types.ts';
import { HELP, helpHref } from '../help.ts';
import { NOT_SORTED, type WorkInsights } from '../model/work-insights.ts';
import './items-drawer.css';
import './help.css';
import { ExternalMark } from './external-link.tsx';

/** How a verdict was reached, in the words a person would use. */
export function decidedBy(source: Verdict['source']): string {
  if (source === 'label' || source === 'field') return 'label';
  if (source === 'agent') return 'AI agent';
  if (source === 'person') return 'person';
  if (source === 'unsure') return 'not decided';
  return 'rules';
}

/** What a hover says about a category: "KTLO: Security patches, bug fixes…", or that nobody has decided. */
export function categoryHint(ins: WorkInsights, id: string | null): string {
  if (id === null) return `${NOT_SORTED}: no rule, label or person has decided this one yet.`;
  const c = ins.definitions[id];
  return c ? `${c.short}: ${c.definition}` : id;
}

/** The lines the tooltip shows for a category: its short form and name, its definition, and, for an item, how it was decided. */
export function categoryTip(ins: WorkInsights, id: string | null, verdict?: Pick<Verdict, 'source' | 'reason'> | undefined): { title: string; definition: string; decided: string | null } {
  const c = id === null ? null : ins.definitions[id];
  const title = id === null ? NOT_SORTED : c ? `${c.short} (${c.name})` : id;
  const definition = id === null ? 'No rule, label or person has decided this one yet.' : (c?.definition ?? '');
  const decided = verdict && id !== null ? `Decided by ${decidedBy(verdict.source)}: ${verdict.reason}` : null;
  return { title, definition, decided };
}

/** The tooltip itself: the app's Tooltip, in the (i)'s own look, with the Read more link of the Work mix topic. */
function Tip({ ins, id, verdict }: { ins: WorkInsights; id: string | null; verdict?: Pick<Verdict, 'source' | 'reason'> | undefined }) {
  const t = categoryTip(ins, id, verdict);
  return (
    <Tooltip className="help-tooltip cat-tip" offset={6} data-category-tip="">
      <strong className="cat-tip__title">{t.title}</strong>
      <span className="cat-tip__line">{t.definition}</span>
      {t.decided && <span className="cat-tip__line">{t.decided}</span>}
      <a className="cat-tip__more" href={helpHref(HELP['work-mix'])} target="_blank" rel="noopener noreferrer" data-read-more="">
        Read more<span className="sr-only"> about how the category is worked out</span>
        <ExternalMark />
      </a>
    </Tooltip>
  );
}

/** A category's name where a sentence needs one: its plain name, its short form and definition on hover. */
export function CategoryName({ ins, id }: { ins: WorkInsights; id: string | null }) {
  const c = id === null ? null : ins.definitions[id];
  return (
    <TooltipTrigger delay={300} closeDelay={200}>
      <Focusable>
        <span className="cat-name" role="img" aria-label={c?.name ?? (id === null ? NOT_SORTED : id)}>
          {c?.name ?? (id === null ? NOT_SORTED : id)}
        </span>
      </Focusable>
      <Tip ins={ins} id={id} />
    </TooltipTrigger>
  );
}

export interface CategoryChipProps {
  ins: WorkInsights;
  itemId: string;
  /** A smaller chip with no "decided by" badge, for a board card. */
  compact?: boolean;
  /** Left out of the tab order, for a chip inside a card that is itself the one thing to focus. */
  skipTab?: boolean;
  /** Reclassify: makes the chip a button. Absent, it is display-only. */
  onPress?: () => void;
}

/** The chip's face and tooltip. An item with no verdict reads as Not sorted yet; on a board card, where that is left out to keep cards quiet, use `hasCategory` first. */
export function CategoryChip({ ins, itemId, compact = false, skipTab = false, onPress }: CategoryChipProps) {
  const v = ins.verdicts.get(itemId);
  const id = v?.category ?? null;
  const name = id === null ? NOT_SORTED : (ins.definitions[id]?.name ?? id);
  const how = v ? decidedBy(v.source) : 'not decided';
  const className = `cat-chip${id === null ? ' cat-chip--unsure' : ''}${compact ? ' cat-chip--compact' : ''}`;
  const face: ReactNode = (
    <>
      {name}
      {id !== null && !compact && <span className="cat-chip__how"> · {how}</span>}
    </>
  );
  return (
    <TooltipTrigger delay={300} closeDelay={200}>
      {onPress ? (
        <Button className={`${className} cat-chip--button`} onPress={onPress} data-category={id ?? 'none'}>
          {face}
        </Button>
      ) : (
        <Focusable excludeFromTabOrder={skipTab}>
          <span className={className} role="img" aria-label={id === null ? `Category: ${NOT_SORTED.toLowerCase()}` : `${name}, decided by ${how}`} data-category={id ?? 'none'}>
            {face}
          </span>
        </Focusable>
      )}
      <Tip ins={ins} id={id} verdict={v} />
    </TooltipTrigger>
  );
}

/** Whether an item has a category to show: a board card shows a chip only for one that does. */
export const hasCategory = (ins: WorkInsights, itemId: string): boolean => (ins.verdicts.get(itemId)?.category ?? null) !== null;
