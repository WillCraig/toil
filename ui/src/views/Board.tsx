/**
 * The board panel (#252, #347): the toil project's sprint in one column per OWI
 * status category, whatever tracker each item came from, with its source's
 * own status word, its assignee, its estimate and its insights on the card.
 * The whole card is the drag handle (dnd-kit): a mouse or pen after a few
 * pixels of movement, a finger after a short hold, the keyboard with Space or
 * Enter on the focused card. Its context menu (right-click, the Menu key,
 * a long press, or M while it has focus) is the single-pointer way to make
 * the same move, so no card carries a button for it.
 *
 * A drop is the person's own act, so with "Apply board moves when I drop a
 * card" on (the default, src/board-moves.ts) it makes the move: the card is in
 * its new column at once, quietly marked as moving, and the server asks toil
 * to change the status behind the connection's `writes` (ui/server/board.ts).
 * A move no command could make (a GitHub issue's In progress when the Toil
 * project names no project board, a board toil couldn't read, a closed pull
 * request asked to leave Done) is not a proposal: the card stays, no ghost is left, and
 * one notice says what is wrong and what to do (components/blocked-move.tsx),
 * until it is dismissed. The column that can't take the card in hand says so
 * while it is dragged.
 * It then says so with an Undo, which makes the reverse move the same way; if
 * toil refuses, the card goes back and the refusal stays on screen until
 * dismissed. Where the move can't be made for the person (the setting is off,
 * the sample, a connection with writes off, a status more than one transition
 * leads to, a card the app can't move) nothing changes in the tracker: the
 * move becomes a proposal card naming the toil command that would apply it
 * (src/model/board.ts), with one line saying why, and the card stays where
 * its tracker says it is.
 *
 * What a person sees (#393): while a card is dragged, a copy of it follows
 * the pointer (dnd-kit's DragOverlay, in a portal so no scrolling box clips
 * it) and says what a drop there would do; the card itself stays put as a
 * dashed placeholder; the column under the pointer is outlined as a target,
 * or as refused when the card is already in it. After a move that stays a
 * proposal, by drag, keyboard or menu, a ghost of the card sits at the top of
 * the target column, marked as a proposal not applied, with Undo and the way
 * to apply it.
 */

import { noteApplied } from '../applied.ts';
import { ChevronDownIcon, ChevronRightIcon } from '../components/icons.tsx';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  useDndContext,
  type Announcements,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Header, Menu, MenuItem, MenuSection, Popover } from 'react-aria-components';
import { Avatar, InsightChips, StatusChip } from '../components/bits.tsx';
import { CategoryChip, hasCategory } from '../components/category-chip.tsx';
import { MixBar } from '../components/chartkit/index.ts';
import { BlockedMove } from '../components/blocked-move.tsx';
import { ProposalCard } from '../components/proposal.tsx';
import { ReclassifyDialog } from '../components/reclassify.tsx';
import { useClassify } from '../classify-state.tsx';
import { AssignModal } from '../assign/views.tsx';
import { useData, useDerived } from '../data.ts';
import { STATUS_CATEGORY_LABEL, estimateText, itemHref, peekHref, personText, shortKey, sourceLabel } from '../format.ts';
import { appliesItself, boardBlock, canMove, columns, dropRefusal, proposeMove, type MoveBlock } from '../model/board.ts';
import { isMoveColumn, type AddToBoard, type MoveColumn, type MoveOptions, type NextStep } from '../board-api.ts';
import { useBoardMoves } from '../board-moves.ts';
import { flows } from '../model/flow.ts';
import { asMapped } from '../model/people.ts';
import { boardLanes, mixOfItems, type Lane } from '../model/lanes.ts';
import { useWorkInsights } from '../insights-data.ts';
import { labelOfDimension } from '../model/work-insights.ts';
import './lanes.css';
import { flagsAttention, insights, type Prepared } from '../model/insights.ts';
import type { Proposal } from '../proposal.ts';
import { ariaKeys, matches } from '../shortcuts.ts';
import { useSkins, useWords } from '../skins.tsx';
import type { StatusCategory, WorkItem } from '../toil.ts';
import { ExternalLink } from '../components/external-link.tsx';

const label = (c: StatusCategory) => STATUS_CATEGORY_LABEL[c];

/**
 * The pointer sensor, for a mouse or a pen only. A finger goes to the touch
 * sensor, which waits for a hold, so a swipe across the cards still scrolls
 * the page instead of picking one up. Both would otherwise answer the same
 * touch, and the first to claim it wins.
 */
class MouseSensor extends PointerSensor {
  static override activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (...args: Parameters<(typeof PointerSensor.activators)[number]['handler']>) => args[0].nativeEvent.pointerType !== 'touch' && PointerSensor.activators[0]!.handler(...args),
    },
  ];
}

/** How many cards a column shows before "Show N more": finished work piles up fastest, so it shows the fewest. */
const COLUMN_LIMIT: Record<string, number> = { DONE: 10 };

/**
 * Ids under swimlanes. A card that holds several values (two components) sits in several lanes, so a draggable's id says
 * which lane it was picked up in, and a column's says which lane it is in; ungrouped, both are the plain ids they always were.
 */
const SEP = '';
export const dragId = (lane: string, item: string) => (lane ? `${lane}${SEP}${item}` : item);
export const dropId = (lane: string, category: string) => (lane ? `${lane}${SEP}${category}` : category);
const parseId = (id: UniqueIdentifier): { lane: string; rest: string } => {
  const s = String(id);
  const at = s.indexOf(SEP);
  return at < 0 ? { lane: '', rest: s } : { lane: s.slice(0, at), rest: s.slice(at + 1) };
};

/** A hold this long picks a card up by touch; moving further than the tolerance first is a scroll. */
const TOUCH_HOLD = { delay: 250, tolerance: 8 };
/** A touch drag that ends nearer than this to where it began was a long press, which opens the menu. */
const PRESS_SLOP = 10;

/**
 * What dropping an item on a column would do: make the move (`applies`), propose
 * it, or nothing, and why. The same rule as proposeMove: its own column, or
 * Unknown, which no tracker has a status for, moves and proposes nothing.
 */
export function dropVerdict(item: WorkItem, to: StatusCategory | null, sameLane = true, applies = false, refusal: string | null = null): { ok: boolean; text: string } {
  if (!to) return { ok: false, text: 'Not over a column' };
  if (!sameLane) return { ok: false, text: 'Another lane: a lane is a grouping, nothing to change' };
  if (to === item.statusCategory) return { ok: false, text: `Already in ${label(to)}: nothing to propose` };
  if (to === 'UNKNOWN') return { ok: false, text: 'Unknown is no status to move to' };
  // A column the loaded data already says can't take this card: said before the drop, not only after it.
  if (refusal) return { ok: false, text: refusal };
  return { ok: true, text: `${applies ? 'Drop to move' : 'Drop to propose'}: ${label(to)}` };
}

/** A proposed move on the board, with the column it would go to and why it wasn't applied. */
interface Move {
  proposal: Proposal;
  to: StatusCategory;
  /** The one line: why this is a proposal and not a move. */
  why: string;
  /** What toil said about the moves the workflow offers, when that is why. */
  detail?: string;
  /** Whether a press on Apply can make it (the setting was off, but writes are available); else the reason is the whole story. */
  applicable: boolean;
  /** A card that isn't on its board: the add and the Status the move sets, and whether a press on "Add to the board and move" can do both. */
  add?: AddToBoard;
  /** That board's name and address, when toil could read them: the link to where the card is added by hand. */
  board?: { project: number; title: string | null; url: string | null };
}

/**
 * A card's place while a move is on screen that the data hasn't caught up with: where it was (`base`, the category the
 * loaded data holds) and where it is shown. It stands only while the data still says `base`, so a sync that reads the move
 * back, or one that reads something else, ends it; the tracker has the last word.
 */
interface Shown {
  base: StatusCategory;
  at: StatusCategory;
  pending: boolean;
}

/** Said after a card on a board is moved to Done: GitHub's own project workflow does the closing, not Toil UI. */
const MAY_CLOSE = 'GitHub may close the issue, since its project workflow does.';

/** The line above the board about the last drop that was applied or refused. */
type Notice =
  | { kind: 'moved'; id: string; key: string; from: StatusCategory; to: StatusCategory; transition: string | null; added: boolean; reopened: boolean; mayClose: boolean }
  | { kind: 'failed'; key: string; message: string }
  /** A move no command can make yet: the reason and the next step, until dismissed. */
  | { kind: 'blocked'; key: string; title: string; reason: string; next: NextStep };

/**
 * The card's face: what it shows, in the column and under the pointer. The
 * copy under the pointer (`ids` unset) is decoration for the eye only: its key
 * is no link and it names nothing, since the announcements speak for it.
 */
/** ` card--attention` on a card that needs attention (#394), for its edge. */
const attentionClass = (item: WorkItem, p: Prepared) => (flagsAttention(insights(item, p)) ? ' card--attention' : '');

function CardFace({ item, ids }: { item: WorkItem; ids?: string }) {
  const { insights: prepared } = useDerived();
  const { toilProject } = useData();
  // The assignee as the toil project's people name them: one person, one name and one avatar, whichever account is on the item.
  const who = asMapped(toilProject.people ?? [], item.source.area, item.assignee);
  const { Card: Skin } = useSkins();
  const key = shortKey(item);
  const found = insights(item, prepared);
  const ins = useWorkInsights();
  return (
    <Skin item={item}>
      <div className="card-top">
        {ids ? (
          <a id={`${ids}-key`} href={peekHref(typeof window === 'undefined' ? '#/' : window.location.hash, item.id)} className="item-link card-key" draggable={false}>
            <span className="key">{key}</span>
          </a>
        ) : (
          <span className="card-key">
            <span className="key">{key}</span>
          </span>
        )}
        {/* Needs attention (#394): the flag the board's filter keys on, a shape as well as a colour. */}
        {flagsAttention(found) && (
          <span className="card-flag" title="Needs attention">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path d="M4 14V2.5M4 3h7.5l-1.8 2.8L11.5 8.5H4" />
            </svg>
            <span className="sr-only">Needs attention</span>
          </span>
        )}
        <StatusChip category={item.statusCategory} status={item.status} inColumn />
        {/* The category, display-only and small; an Unsure item shows none, to keep cards quiet. */}
        {hasCategory(ins, item.id) && <CategoryChip ins={ins} itemId={item.id} compact skipTab />}
      </div>
      <p id={ids && `${ids}-title`} className="card-title">
        {item.title}
      </p>
      <div className="card-foot">
        <span className="who">
          <Avatar person={who} /> {personText(who)}
        </span>
        <span className="card-meta">
          <InsightChips insights={found} compact titles={prepared.byId} />
          <span className="field">
            <span className="source">{sourceLabel(item.source.area)}</span> · {estimateText(item)}
          </span>
        </span>
      </div>
    </Skin>
  );
}

/** The copy of the card that follows the pointer, saying what a drop where it is would do. */
function DragCard({ item, applies }: { item: WorkItem; applies: boolean }) {
  const { over, active } = useDndContext();
  const { insights: prepared } = useDerived();
  const { toilProject } = useData();
  const target = over ? parseId(over.id) : null;
  const to = (target?.rest as StatusCategory | undefined) ?? null;
  const verdict = dropVerdict(item, to, !target || !active || target.lane === parseId(active.id).lane, applies, to ? dropRefusal(item, to, toilProject.githubBoards) : null);
  return (
    <div className={`card card--${item.statusCategory.toLowerCase()}${attentionClass(item, prepared)} card--overlay`} data-drag-overlay aria-hidden="true">
      <div className="card-grip">
        <CardFace item={item} />
      </div>
      <p className={`drop-verdict${verdict.ok ? '' : ' drop-verdict--no'}`} data-drop-verdict>
        {verdict.text}
      </p>
    </div>
  );
}

/**
 * The proposal where the person dropped it: a ghost of the card at the top of
 * the column it would move to, plainly not the card itself. Undo takes the
 * proposal back; How to apply goes to its card under the board, which has the
 * command.
 */
function Ghost({ item, move, sample, onUndo, onShow }: { item: WorkItem; move: Move; sample: boolean; onUndo: () => void; onShow: () => void }) {
  const key = shortKey(item);
  return (
    <li className="card-ghost" data-proposed-ghost aria-label={`Proposed move, not applied: ${key} ${item.title}`}>
      <p className="card-ghost__kind">Proposed move, not applied</p>
      <p className="card-ghost__title">
        <span className="key">{key}</span> {item.title}
      </p>
      {/* Why the move was not applied is the proposal's line under the board; the ghost says it once, shortly. */}
      <p className="note" data-ghost-note="">
        {sample ? "Sample data: this move isn't saved." : `From ${label(item.statusCategory)}. Not applied yet.`}
      </p>
      <div className="card-ghost__actions">
        <Button className="btn btn--quiet" onPress={onUndo} aria-label={`Undo the proposed move of ${key}`}>
          Undo
        </Button>
        {!sample && (
          <Button className="btn" onPress={onShow} aria-label={`How to apply the move of ${key} to ${label(move.to)}`}>
            How to apply
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Arrow keys jump a picked-up card a whole column at a time, in board order:
 * Right or Down to the next, Left or Up to the previous, so the same keys
 * work whether the columns sit side by side or stack on a phone. The card
 * lands just under the column's heading, where nothing but that column is.
 */
export const columnSteps =
  (order: StatusCategory[], home: (id: UniqueIdentifier) => StatusCategory | undefined, laneOf: (id: UniqueIdentifier) => string = () => ''): KeyboardCoordinateGetter =>
  (event, { active, context: { collisionRect, droppableRects, over } }) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.code];
    if (!step || !collisionRect) return undefined;
    event.preventDefault();
    // A picked-up card steps through its own lane's columns; the lanes are for looking, not for moving between.
    const lane = laneOf(active);
    const at = order.indexOf(((over ? parseId(over.id).rest : undefined) as StatusCategory | undefined) ?? home(active)!);
    const next = order[Math.min(order.length - 1, Math.max(0, at + step))];
    const rect = next ? droppableRects.get(dropId(lane, next)) : undefined;
    if (!rect) return undefined;
    return { x: rect.left + Math.max(0, (rect.width - collisionRect.width) / 2), y: rect.top + 48 };
  };

function Card({ item, lane, others, onMove, menuOpen, setMenuOpen: setMenu, moving }: { item: WorkItem; lane: string; others: StatusCategory[]; onMove: (to: StatusCategory) => void; menuOpen: boolean; setMenuOpen: (open: boolean) => void; moving: boolean }) {
  // A card whose move is still in flight can't be moved again (the server would answer 409), so its menu stays shut too.
  const setMenuOpen = (open: boolean) => {
    if (!open || !moving) setMenu(open);
  };
  const { toilProject, assignments } = useData();
  const { insights: prepared } = useDerived();
  // Decided up front, by the rule the proposal uses: a card that can't be moved isn't draggable, and says why.
  const can = canMove(item);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: dragId(lane, item.id), disabled: !can.ok || moving, attributes: { role: 'group', ...(can.ok ? { roleDescription: 'draggable card' } : {}) } });
  const [assigning, setAssigning] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const { api: classifyApi } = useClassify();
  const grip = useRef<HTMLDivElement | null>(null);
  const ids = useId();
  const key = shortKey(item);
  const href = itemHref(toilProject.name, item.id);

  // The card is its own activator, so Space or Enter on the key's link inside it follows the link instead of picking the card up.
  const gripRef = (el: HTMLDivElement | null) => {
    grip.current = el;
    setActivatorNodeRef(el);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isDragging && matches('cardMenu', e)) {
      e.preventDefault();
      setMenuOpen(true);
      return;
    }
    listeners?.onKeyDown?.(e);
  };
  // Right-click and the Menu key. On the key's link the browser's own menu stays, so "open in a new tab" still works.
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('a') || isDragging) return;
    e.preventDefault();
    setMenuOpen(true);
  };
  // A click anywhere on the card opens the item, as its link does. After a drag dnd-kit swallows the click, so a drop never navigates.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('a, button')) return;
    window.location.hash = href;
  };
  const closeMenu = (open: boolean) => {
    setMenuOpen(open);
    // A menu dismissed with Escape or a click outside hands focus back to the card it came from.
    if (!open) requestAnimationFrame(() => document.activeElement === document.body && grip.current?.focus());
  };
  // A Popover with no MenuTrigger around it doesn't close on an action by itself.
  const onAction = (k: UniqueIdentifier) => {
    closeMenu(false);
    if (k === 'open') window.location.hash = href;
    else if (k === 'assign') setAssigning(true);
    else if (k === 'category') setReclassifying(true);
    else onMove(k as StatusCategory);
  };

  return (
    // While it's dragged the card stays where it is, as a placeholder; the copy in the DragOverlay is what moves.
    <li ref={setNodeRef} className={`card card--${item.statusCategory.toLowerCase()}${attentionClass(item, prepared)}${isDragging ? ' card--dragging' : ''}${moving ? ' card--moving' : ''}`} aria-busy={moving || undefined}>
      <div
        ref={gripRef}
        className="card-grip"
        data-item={item.id}
        {...attributes}
        {...listeners}
        aria-labelledby={`${ids}-key ${ids}-title`}
        aria-describedby={can.ok ? attributes['aria-describedby'] : `${ids}-why`}
        aria-roledescription={can.ok ? attributes['aria-roledescription'] : undefined}
        aria-keyshortcuts={ariaKeys('cardMenu')}
        data-immovable={can.ok ? undefined : ''}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        onClick={onClick}
      >
        <CardFace item={item} ids={ids} />
        {!can.ok && (
          <p id={`${ids}-why`} className="card-why" data-why-immovable>
            {can.reason}
          </p>
        )}
        {moving && (
          <p className="card-moving" data-moving="">
            Moving…
          </p>
        )}
      </div>
      {/* Outside the card's own element: a portal's events still bubble through React, and a press in the menu must not start a drag. */}
      <Popover triggerRef={grip} isOpen={menuOpen && !moving} onOpenChange={closeMenu} placement="bottom start" className="popover">
        <Menu className="menu" aria-label={`${key} ${item.title}`} autoFocus="first" onAction={onAction} disabledKeys={can.ok ? [] : others}>
          <MenuItem id="open" className="menu-item">
            Open
          </MenuItem>
          <MenuSection>
            <Header className="menu-header">{can.ok ? 'Move to' : can.reason}</Header>
            {others.map((c) => (
              <MenuItem key={c} id={c} className="menu-item">
                {label(c)}
              </MenuItem>
            ))}
          </MenuSection>
          {classifyApi ? (
            <MenuItem id="category" className="menu-item">
              Change its category…
            </MenuItem>
          ) : null}
          {assignments ? (
            <MenuItem id="assign" className="menu-item">
              Give to an AI agent…
            </MenuItem>
          ) : null}
        </Menu>
      </Popover>
      {assignments && <AssignModal item={item} isOpen={assigning} onOpenChange={setAssigning} />}
      {classifyApi && <ReclassifyDialog item={item} isOpen={reclassifying} onOpenChange={setReclassifying} />}
    </li>
  );
}

function Column({ category, lane, items, all, onMove, menuFor, setMenuFor, ghosts, sample, onUndo, onShow, effective, movingIds }: { category: StatusCategory; lane: string; items: WorkItem[]; all: StatusCategory[]; onMove: (item: WorkItem, to: StatusCategory) => void; menuFor: string | null; setMenuFor: (id: string | null) => void; ghosts: { item: WorkItem; move: Move }[]; sample: boolean; onUndo: (move: Move) => void; onShow: (move: Move) => void; effective: (item: WorkItem) => WorkItem; movingIds: ReadonlySet<string> }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: dropId(lane, category) });
  const { byId, toilProject } = useData();
  const words = useWords();
  const ids = useId();
  const id = `col-${ids}`;
  const draggedItem = active ? byId.get(parseId(active.id).rest) : undefined;
  const dragged = draggedItem && effective(draggedItem);
  // A column the loaded data says can't take the card in hand (In progress, for a GitHub issue with no project board): said on the column while it is dragged.
  const refusal = dragged && (!active || parseId(active.id).lane === lane) ? dropRefusal(dragged, category, toilProject.githubBoards) : null;
  // Under the pointer: a target, or refused (its own column, or another lane), whose reason the copy under the pointer gives.
  const drop = isOver && dragged ? (dropVerdict(dragged, category, !active || parseId(active.id).lane === lane, false, refusal).ok ? ' column--over' : ' column--refused') : '';
  // A long column is a wall: the first cards show, the rest are one press away, and the count in the heading stays the whole.
  const [more, setMore] = useState(false);
  const limit = COLUMN_LIMIT[category] ?? 25;
  const hiding = !more && items.length > limit ? items.length - limit : 0;
  const visible = hiding ? items.slice(0, limit) : items;
  return (
    <section ref={setNodeRef} className={`column column--${category.toLowerCase()}${drop}`} aria-labelledby={id}>
      <h3 id={id}>
        {label(category)} <span className="count">{items.length}</span>
      </h3>
      {refusal && (
        <p className="column__hint" data-drop-hint="">
          {refusal}
        </p>
      )}
      {items.length || ghosts.length ? (
        <ul className="cards">
          {ghosts.map((g) => (
            <Ghost key={g.move.proposal.id} item={g.item} move={g.move} sample={sample} onUndo={() => onUndo(g.move)} onShow={() => onShow(g.move)} />
          ))}
          {visible.map((item) => (
            <Card
              key={item.id}
              item={item}
              lane={lane}
              others={all.filter((c) => c !== category && c !== 'UNKNOWN')}
              onMove={(to) => onMove(item, to)}
              menuOpen={menuFor === item.id}
              setMenuOpen={(open) => setMenuFor(open ? item.id : null)}
              moving={movingIds.has(item.id)}
            />
          ))}
        </ul>
      ) : null}
      {hiding > 0 && (
        <Button className="btn btn--small column__more" onPress={() => setMore(true)} data-show-more={category}>
          Show {hiding} more<span className="sr-only"> in {label(category)}</span>
        </Button>
      )}
      {items.length ? null : <p className="note">{words('empty.column')}</p>}
    </section>
  );
}

/** The lane's header: its name and count as the button that folds it, and, when the grouping isn't by category, the mix of what is in it. */
function LaneHead({ lane, open, onToggle, mix, id }: { lane: Lane; open: boolean; onToggle: () => void; mix: ReturnType<typeof mixOfItems>; id: string }) {
  const ins = useWorkInsights();
  return (
    <div className="lane__head">
      <h3 id={id}>
        <button type="button" className="lane__toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle} data-lane-toggle={lane.key}>
          <span className="lane__chevron" aria-hidden="true">
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <span className="lane__name">{lane.label}</span>{' '}
          <span className="count" data-lane-count="">
            {lane.items.length}
          </span>
        </button>
      </h3>
      {mix && (
        <span className="lane__mix">
          <span className="lane__mixlabel" aria-hidden="true">
            Mix by category
          </span>
          <MixBar result={mix} scheme={{ categories: ins.scheme.categories }} label={`${lane.label}: mix by category`} />
        </span>
      )}
    </div>
  );
}

/**
 * The Board. Grouped (`group` names a dimension), it is one lane per value over the same status columns: each lane keeps
 * its own "Show N more" limits, folds away, and takes a drag only within itself, because a lane is a grouping and not a
 * status. Ungrouped it is the single board it has always been, with no lane around it.
 */
export function Board({ items, group = null }: { items: WorkItem[]; group?: string | null }) {
  const { toilProject, byId } = useData();
  const ins = useWorkInsights();
  const { api: classifyApi } = useClassify();
  const [applyDrops] = useBoardMoves();
  const [moves, setMoves] = useState<Move[]>([]);
  const [shown, setShown] = useState<ReadonlyMap<string, Shown>>(new Map());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [said, setSaid] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState<WorkItem | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [allLanes, setAllLanes] = useState(false);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const laneSet = group ? boardLanes(ins, items, group, allLanes) : null;
  const cols = columns(items);
  const cats = cols.map((c) => c.category);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_HOLD }),
    useSensor(KeyboardSensor, { coordinateGetter: columnSteps(cats, (id) => { const it = byId.get(parseId(id).rest); return it && effective(it).statusCategory; }, (id) => parseId(id).lane) }),
  );
  const keyOf = (id: unknown) => {
    const item = byId.get(parseId(id as UniqueIdentifier).rest);
    return item ? shortKey(item) : String(id);
  };

  // What the page shows for a card now: the move it has made and the tracker hasn't been read back for, else the data's own word.
  // The status word is the tracker's, which this page hasn't read since, so it is left off until the next sync says it.
  const effective = (item: WorkItem): WorkItem => {
    const s = shown.get(item.id);
    return s && s.base === item.statusCategory && s.at !== item.statusCategory ? { ...item, statusCategory: s.at, status: null } : item;
  };
  const movingIds = new Set([...shown].filter(([, s]) => s.pending).map(([id]) => id));
  // Whether a drop makes the move, before it is tried: the person's setting, and a view that has a server to ask and isn't the sample.
  const canApply = Boolean(classifyApi?.moveItem) && !classifyApi?.movesDisabled;
  const applies = applyDrops && canApply;

  /** The proposal for a move that wasn't made, with the one line saying why. */
  const propose = (item: WorkItem, to: StatusCategory, why = 'Applying board moves is off in Settings, General, so this move is a proposal.', extra: { detail?: string; applicable?: boolean; add?: AddToBoard; board?: Move['board'] } = {}) => {
    const p = proposeMove(item, to, toilProject.items, toilProject.name, toilProject.githubBoards, extra.add);
    if (!p) {
      setSaid(`${shortKey(item)} is already in ${label(to)}. Nothing proposed.`);
      return;
    }
    setMoves((list) => [{ proposal: p, to, why, ...(extra.detail ? { detail: extra.detail } : {}), applicable: extra.applicable ?? false, ...(extra.add ? { add: extra.add } : {}), ...(extra.board ? { board: extra.board } : {}) }, ...list.filter((x) => x.proposal.id !== p.id && x.proposal.item !== p.item)]);
    setSaid(`Proposed: ${p.title}. Nothing has changed in ${toilProject.name}'s tracker. ${why}`);
  };

  const unshow = (id: string) =>
    setShown((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });

  /** A move no command can make yet: the card stays where it is, and one notice says why and what to do, until it is dismissed. */
  const block = (item: WorkItem, to: StatusCategory, b: Pick<MoveBlock, 'reason' | 'next'>) => {
    const key = shortKey(item);
    setMoves((list) => list.filter((x) => x.proposal.item !== item.id));
    setNotice({ kind: 'blocked', key, title: `${key} wasn't moved to ${label(to)}.`, reason: b.reason, next: b.next });
    setSaid(`${key} was not moved to ${label(to)}. ${b.reason} ${b.next.text}`);
  };

  /**
   * Makes the move through the server and toil: the card is in its new column at once, and goes back if toil refuses. What the
   * server leaves as a proposal comes back as one, with its reason; what fails is said in toil's own words and stays until dismissed.
   */
  const apply = async (item: WorkItem, to: StatusCategory, base: StatusCategory = item.statusCategory, how: MoveOptions = {}) => {
    if (!isMoveColumn(to) || !classifyApi?.moveItem) return;
    const key = shortKey(item);
    const before = shown.get(item.id);
    // This try's own marker. A refusal puts the card back only while that marker is still what it shows (a move that settled meanwhile stands),
    // and never brings back a "moving" marker, whose move is over one way or the other.
    const mine: Shown = { base, at: to, pending: true };
    const restore = () =>
      setShown((m) => {
        if (m.get(item.id) !== mine) return m;
        const next = new Map(m);
        if (before && !before.pending) next.set(item.id, before);
        else next.delete(item.id);
        return next;
      });
    setMoves((list) => list.filter((x) => x.proposal.item !== item.id));
    setNotice(null);
    setShown((m) => new Map(m).set(item.id, mine));
    setSaid(`Moving ${key} to ${label(to)}.`);
    try {
      // The extra argument is sent only for a press on "Add to the board and move": a plain drop never asks to add anything.
      const out = how.addToBoard ? await classifyApi.moveItem(toilProject.name, item.id, to as MoveColumn, { addToBoard: true }) : await classifyApi.moveItem(toilProject.name, item.id, to as MoveColumn);
      if (out.status === 'applied') {
        // The header's line about the data stops saying nothing changed (#657, round 4).
        noteApplied(`move:${item.id}:${to}:${Date.now()}`, new Date().toISOString());
        // Back where the data says it is, the card needs no override; anywhere else it stays where it was put until a sync says.
        if (to === base) unshow(item.id);
        else setShown((m) => new Map(m).set(item.id, { base, at: to, pending: false }));
        setNotice({ kind: 'moved', id: item.id, key, from: item.statusCategory, to, transition: out.transition, added: out.added === true, reopened: out.reopened === true, mayClose: out.mayClose === true });
        setSaid(`${out.added ? `Added ${key} to the board and moved it` : out.reopened ? `Reopened and moved ${key}` : `Moved ${key}`} to ${label(to)}${out.transition ? ` with the transition ${out.transition}` : ''}.${out.mayClose ? ` ${MAY_CLOSE}` : ''}`);
        return;
      }
      restore();
      // Nothing can make this move yet: the card is back where it was, and the notice says what to do first.
      if (out.status === 'blocked') return block(item, to, out);
      // What toil left alone is shown back where it was, with the proposal and the reason.
      propose(item, to, out.reason, { ...(out.detail ? { detail: out.detail } : {}), ...(out.add ? { add: out.add } : {}), ...(out.board ? { board: out.board } : {}) });
    } catch (e) {
      restore();
      const message = e instanceof Error ? e.message : String(e);
      setNotice({ kind: 'failed', key, message: `${key} was not moved to ${label(to)}. ${message}` });
      setSaid(`${key} was not moved. ${message}`);
    }
  };
  /** A drop, or a pick from the menu: made, or proposed with the reason it wasn't. */
  const move = (item: WorkItem, to: StatusCategory) => {
    if (to === item.statusCategory || to === 'UNKNOWN') return propose(item, to);
    // The loaded data already says no command could make this move: no ghost, no round trip, and whatever the settings say.
    const blocked = boardBlock(item, to, toilProject.githubBoards, toilProject.name);
    if (blocked) return block(item, to, blocked);
    const can = canMove(item);
    if (!can.ok) return propose(item, to, can.reason);
    if (!applyDrops) return propose(item, to, undefined, { applicable: canApply && appliesItself(item) });
    if (!classifyApi?.moveItem) return propose(item, to, "This view can't change your tracker, so this move is a proposal.");
    if (classifyApi.movesDisabled) return propose(item, to, 'This is sample data, so a move can\'t be applied. Here is what would run with your own work.');
    if (!appliesItself(item)) return propose(item, to, "Toil UI can't apply this card's move itself (a draft on a project board has no issue to name), so here is its command.");
    void apply(item, to, byId.get(item.id)?.statusCategory ?? item.statusCategory);
  };
  const undoMove = (n: Extract<Notice, { kind: 'moved' }>) => {
    const item = byId.get(n.id);
    if (!item) return;
    void apply(effective(item), n.from, item.statusCategory);
  };
  const dismiss = (move: Move) => setMoves((list) => list.filter((x) => x.proposal.id !== move.proposal.id));
  // Undo hands focus back to the card, which never left its column; looked for on this board only.
  const undo = (move: Move) => {
    dismiss(move);
    setSaid(`Took back the proposed move of ${keyOf(move.proposal.item)}. Nothing proposed.`);
    requestAnimationFrame(() => boardRef.current?.querySelector<HTMLElement>(`.card-grip[data-item="${CSS.escape(move.proposal.item)}"]`)?.focus());
  };
  // How to apply: the proposal's card under this board, which has the command.
  const show = (move: Move) => {
    const slot = listRef.current?.querySelector<HTMLElement>(`[data-proposal="${CSS.escape(move.proposal.id)}"]`);
    slot?.scrollIntoView?.({ block: 'center' });
    slot?.focus({ preventScroll: true });
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const picked = parseId(e.active.id);
    const item = byId.get(picked.rest);
    if (!item) return;
    // A finger held still and lifted was a long press: iOS sends no contextmenu, so this is its menu.
    if ('touches' in e.activatorEvent && Math.hypot(e.delta.x, e.delta.y) < PRESS_SLOP) {
      setMenuFor(item.id);
      return;
    }
    if (!e.over) return;
    const target = parseId(e.over.id);
    if (target.lane !== picked.lane) {
      setSaid(`${shortKey(item)} was dropped in another lane. A lane is a grouping, not a status: nothing was changed and nothing proposed.`);
      return;
    }
    move(effective(item), target.rest as StatusCategory);
  };
  /** Apply on a proposal's card: the same move, by a press, where the drop only proposed it. */
  const applyProposal = (m: Move) => {
    const item = byId.get(m.proposal.item);
    if (item) void apply(effective(item), m.to, item.statusCategory, m.add ? { addToBoard: true } : {});
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => (applies ? `Picked up ${keyOf(active.id)}. Dropping it on another column moves it in the tracker.` : `Picked up ${keyOf(active.id)}. Moving it proposes a change; nothing is changed.`),
    onDragOver: ({ active, over }) => {
      if (!over) return `${keyOf(active.id)} is not over a column.`;
      const dragged = byId.get(parseId(active.id).rest);
      const refusal = dragged ? dropRefusal(effective(dragged), parseId(over.id).rest as StatusCategory, toilProject.githubBoards) : null;
      return `${keyOf(active.id)} is over ${label(parseId(over.id).rest as StatusCategory)}${parseId(over.id).lane === parseId(active.id).lane ? '' : ' in another lane, where a drop changes nothing'}.${refusal ? ` ${refusal}: a drop there says what is missing and changes nothing.` : ''}`;
    },
    onDragEnd: ({ active, over }) => {
      if (!over) return `Dropped ${keyOf(active.id)} outside the columns. Nothing proposed.`;
      if (parseId(over.id).lane !== parseId(active.id).lane) return `Dropped ${keyOf(active.id)} in another lane. Nothing was changed.`;
      const dropped = byId.get(parseId(active.id).rest);
      const home = dropped && effective(dropped).statusCategory === parseId(over.id).rest;
      return `Dropped ${keyOf(active.id)} on ${label(parseId(over.id).rest as StatusCategory)}${home ? ', where it already is. Nothing proposed.' : '.'}`;
    },
    onDragCancel: ({ active }) => `Stopped dragging ${keyOf(active.id)}. Nothing proposed.`,
  };

  const columnsOf = (lane: string, laneItems: WorkItem[]) => {
    const here = new Set(laneItems.map((i) => i.id));
    return (
      <div ref={lane ? undefined : boardRef} className="board" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(15rem, 1fr))` }}>
        {cats.map((category) => (
          <Column
            key={category}
            category={category}
            lane={lane}
            items={laneItems.filter(flows).map(effective).filter((i) => i.statusCategory === category)}
            all={cats}
            onMove={move}
            effective={effective}
            movingIds={movingIds}
            menuFor={menuFor}
            setMenuFor={setMenuFor}
            ghosts={moves.flatMap((move) => {
              const item = move.to === category && here.has(move.proposal.item) ? byId.get(move.proposal.item) : undefined;
              return item ? [{ item, move }] : [];
            })}
            sample={Boolean(classifyApi?.movesDisabled)}
            onUndo={undo}
            onShow={show}
          />
        ))}
      </div>
    );
  };

  return (
    <>
      {notice?.kind === 'blocked' && <BlockedMove toilProject={toilProject.name} title={notice.title} reason={notice.reason} next={notice.next} onDismiss={() => setNotice(null)} />}
      {notice && notice.kind !== 'blocked' && (
        <div className={`board-notice board-notice--${notice.kind}`} role={notice.kind === 'failed' ? 'alert' : 'status'} data-board-notice={notice.kind}>
          {notice.kind === 'moved' ? (
            <p>
              {notice.added ? 'Added ' : notice.reopened ? 'Reopened and moved ' : 'Moved '}
              <strong>{notice.key}</strong>
              {notice.added ? ' to the board and moved it to ' : ' to '}
              {label(notice.to)}
              {notice.transition ? ` with the transition ${notice.transition}` : ''}.{notice.mayClose ? ` ${MAY_CLOSE}` : ''}
            </p>
          ) : (
            <p>{notice.message}</p>
          )}
          {notice.kind === 'moved' && notice.from !== 'UNKNOWN' && (
            <Button className="btn btn--small" onPress={() => undoMove(notice)} aria-label={`Undo the move of ${notice.key}`}>
              Undo
            </Button>
          )}
          <Button className="btn btn--small btn--quiet" onPress={() => setNotice(null)} aria-label="Dismiss this message">
            Dismiss
          </Button>
        </div>
      )}
      <DndContext
        sensors={sensors}
        onDragStart={(e) => setDragging(byId.get(parseId(e.active.id).rest) ?? null)}
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: `To pick up the card, press Space or Enter. Use the arrow keys to move it to the next or previous column, then press Space or Enter to ${applies ? 'drop it and make the move' : 'propose the move'}, or Escape to cancel. Press M or the Menu key for its menu.`,
          },
        }}
      >
        {group && !laneSet && (
          <p className="note" data-lanes-unread="">
            {labelOfDimension(group)} wasn't read for this Toil project, so the board can't be grouped by it yet. It is shown ungrouped.
          </p>
        )}
        {laneSet ? (
          <div ref={boardRef} className="lanes" data-lanes={laneSet.spec}>
            {laneSet.lanes.map((lane) => {
              const open = !folded.has(lane.key);
              const id = `lane-${lane.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
              const mix = laneSet.spec === 'category' ? null : mixOfItems(ins, lane.items.map((i) => i.id), 'category');
              return (
                <section key={lane.key} className="lane" aria-labelledby={id} data-lane={lane.key}>
                  <LaneHead
                    lane={lane}
                    open={open}
                    id={id}
                    mix={mix}
                    onToggle={() =>
                      setFolded((cur) => {
                        const next = new Set(cur);
                        if (next.has(lane.key)) next.delete(lane.key);
                        else next.add(lane.key);
                        return next;
                      })
                    }
                  />
                  {open && (
                    <div id={`${id}-body`} className="lane__body">
                      {columnsOf(lane.key, lane.items)}
                    </div>
                  )}
                </section>
              );
            })}
            {laneSet.foldable > 0 && (
              <Button className="btn btn--small lanes__all" onPress={() => setAllLanes((v) => !v)} data-show-all-lanes="">
                {allLanes ? 'Fold the small lanes into Other' : `Show all lanes (${laneSet.foldable} more)`}
              </Button>
            )}
          </div>
        ) : (
          columnsOf('', items)
        )}
        {/* In a portal, so no scrolling or transformed box around the board can clip or offset it. No drop animation: the
            card doesn't move on a drop, so flying the copy back to it would read as refused; the ghost says where it went. */}
        {createPortal(<DragOverlay dropAnimation={null}>{dragging ? <DragCard item={effective(dragging)} applies={applies} /> : null}</DragOverlay>, document.body)}
      </DndContext>
      <p className="sr-only" role="status">
        {said}
      </p>
      {moves.length > 0 && (
        <div ref={listRef} className="proposals" aria-label="Proposed moves" role="group">
          <h3>Proposed moves</h3>
          {moves.map((m) => (
            <div key={m.proposal.id} data-proposal={m.proposal.id} className="proposal-slot" tabIndex={-1}>
              <ProposalCard
                proposal={m.proposal}
                onDismiss={() => dismiss(m)}
                why={m.why}
                {...(m.detail ? { detail: m.detail } : {})}
                {...(m.add?.canApply
                  ? {
                      actions: (
                        <>
                          <Button className="btn btn--accent" onPress={() => applyProposal(m)} aria-label={`Add to the board and move: ${m.proposal.title}`}>
                            Add to the board and move
                          </Button>
                          {m.board?.url && (
                            <ExternalLink className="btn btn--secondary" href={m.board.url}>
                              Open the project board<span className="sr-only"> on GitHub</span>
                            </ExternalLink>
                          )}
                        </>
                      ),
                    }
                  : m.applicable && !m.add
                    ? {
                        actions: (
                          <Button className="btn btn--accent" onPress={() => applyProposal(m)} aria-label={`Apply: ${m.proposal.title}`}>
                            Apply
                          </Button>
                        ),
                      }
                    : m.board?.url
                      ? {
                          actions: (
                            <ExternalLink className="btn btn--secondary" href={m.board.url}>
                              Open the project board<span className="sr-only"> on GitHub</span>
                            </ExternalLink>
                          ),
                        }
                      : {})}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
