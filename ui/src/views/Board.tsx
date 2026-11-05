/**
 * The board panel (#252, #347): the toil project's sprint in one column per OWI
 * status category, whatever tracker each item came from, with its source's
 * own status word, its assignee, its estimate and its insights on the card.
 * The whole card is the drag handle (dnd-kit): a mouse or pen after a few
 * pixels of movement, a finger after a short hold, the keyboard with Space or
 * Enter on the focused card. Its context menu (right-click, the Menu key,
 * a long press, or M while it has focus) is the single-pointer way to make
 * the same move, so no card carries a button for it. Either way nothing
 * changes: the move becomes a proposal card naming the toil command that
 * would apply it (src/model/board.ts), and the card stays where its tracker
 * says it is.
 *
 * What a person sees (#393): while a card is dragged, a copy of it follows
 * the pointer (dnd-kit's DragOverlay, in a portal so no scrolling box clips
 * it) and says what a drop there would do; the card itself stays put as a
 * dashed placeholder; the column under the pointer is outlined as a target,
 * or as refused when the card is already in it. After any move, by drag,
 * keyboard or menu, a ghost of the card sits at the top of the target column,
 * marked as a proposal not applied, with Undo and the way to apply it.
 */

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
import { ProposalCard } from '../components/proposal.tsx';
import { AssignModal } from '../assign/views.tsx';
import { useData, useDerived } from '../data.ts';
import { STATUS_CATEGORY_LABEL, estimateText, itemHref, peekHref, personText, shortKey, sourceLabel } from '../format.ts';
import { columns, proposeMove } from '../model/board.ts';
import { flagsAttention, insights, type Prepared } from '../model/insights.ts';
import type { Proposal } from '../proposal.ts';
import { ariaKeys, matches } from '../shortcuts.ts';
import { useSkins, useWords } from '../skins.tsx';
import type { StatusCategory, WorkItem } from '../toil.ts';

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

/** A hold this long picks a card up by touch; moving further than the tolerance first is a scroll. */
const TOUCH_HOLD = { delay: 250, tolerance: 8 };
/** A touch drag that ends nearer than this to where it began was a long press, which opens the menu. */
const PRESS_SLOP = 10;

/**
 * What dropping an item on a column would do: propose a move, or nothing,
 * and why. The same rule as proposeMove: its own column, or Unknown, which
 * no tracker has a status for, proposes nothing.
 */
export function dropVerdict(item: WorkItem, to: StatusCategory | null): { ok: boolean; text: string } {
  if (!to) return { ok: false, text: 'Not over a column' };
  if (to === item.statusCategory) return { ok: false, text: `Already in ${label(to)}: nothing to propose` };
  if (to === 'UNKNOWN') return { ok: false, text: 'Unknown is no status to move to' };
  return { ok: true, text: `Drop to propose: ${label(to)}` };
}

/** A proposed move on the board, with the column it would go to. */
interface Move {
  proposal: Proposal;
  to: StatusCategory;
}

/**
 * The card's face: what it shows, in the column and under the pointer. The
 * copy under the pointer (`ids` unset) is decoration for the eye only: its key
 * is no link and it names nothing, since the announcements speak for it.
 */
/** ` card--attention` on a card that needs attention (#394), for its edge. */
const attentionClass = (item: WorkItem, p: Prepared) => (flagsAttention(insights(item, p)) ? ' card--attention' : '');

function CardFace({ item, ids }: { item: WorkItem; ids?: string }) {
  const { insights: prepared } = useDerived();
  const { Card: Skin } = useSkins();
  const key = shortKey(item);
  const found = insights(item, prepared);
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
        <StatusChip category={item.statusCategory} status={item.status} />
      </div>
      <p id={ids && `${ids}-title`} className="card-title">
        {item.title}
      </p>
      <div className="card-foot">
        <span className="who">
          <Avatar person={item.assignee} /> {personText(item.assignee)}
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
function DragCard({ item }: { item: WorkItem }) {
  const { over } = useDndContext();
  const { insights: prepared } = useDerived();
  const verdict = dropVerdict(item, (over?.id as StatusCategory | undefined) ?? null);
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
function Ghost({ item, move, onUndo, onShow }: { item: WorkItem; move: Move; onUndo: () => void; onShow: () => void }) {
  const key = shortKey(item);
  return (
    <li className="card-ghost" data-proposed-ghost aria-label={`Proposed move, not applied: ${key} ${item.title}`}>
      <p className="card-ghost__kind">Proposed move, not applied</p>
      <p className="card-ghost__title">
        <span className="key">{key}</span> {item.title}
      </p>
      <p className="note">
        From {label(item.statusCategory)}. It stays there until someone applies the move with toil.
      </p>
      <div className="card-ghost__actions">
        <Button className="btn btn--quiet" onPress={onUndo} aria-label={`Undo the proposed move of ${key}`}>
          Undo
        </Button>
        <Button className="btn" onPress={onShow} aria-label={`How to apply the move of ${key} to ${label(move.to)}`}>
          How to apply
        </Button>
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
  (order: StatusCategory[], home: (id: UniqueIdentifier) => StatusCategory | undefined): KeyboardCoordinateGetter =>
  (event, { active, context: { collisionRect, droppableRects, over } }) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.code];
    if (!step || !collisionRect) return undefined;
    event.preventDefault();
    const at = order.indexOf((over?.id as StatusCategory | undefined) ?? home(active)!);
    const next = order[Math.min(order.length - 1, Math.max(0, at + step))];
    const rect = next ? droppableRects.get(next) : undefined;
    if (!rect) return undefined;
    return { x: rect.left + Math.max(0, (rect.width - collisionRect.width) / 2), y: rect.top + 48 };
  };

function Card({ item, others, onMove, menuOpen, setMenuOpen }: { item: WorkItem; others: StatusCategory[]; onMove: (to: StatusCategory) => void; menuOpen: boolean; setMenuOpen: (open: boolean) => void }) {
  const { toilProject, assignments } = useData();
  const { insights: prepared } = useDerived();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: item.id, attributes: { role: 'group', roleDescription: 'draggable card' } });
  const [assigning, setAssigning] = useState(false);
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
    else onMove(k as StatusCategory);
  };

  return (
    // While it's dragged the card stays where it is, as a placeholder; the copy in the DragOverlay is what moves.
    <li ref={setNodeRef} className={`card card--${item.statusCategory.toLowerCase()}${attentionClass(item, prepared)}${isDragging ? ' card--dragging' : ''}`}>
      <div
        ref={gripRef}
        className="card-grip"
        data-item={item.id}
        {...attributes}
        {...listeners}
        aria-labelledby={`${ids}-key ${ids}-title`}
        aria-keyshortcuts={ariaKeys('cardMenu')}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        onClick={onClick}
      >
        <CardFace item={item} ids={ids} />
      </div>
      {/* Outside the card's own element: a portal's events still bubble through React, and a press in the menu must not start a drag. */}
      <Popover triggerRef={grip} isOpen={menuOpen} onOpenChange={closeMenu} placement="bottom start" className="popover">
        <Menu className="menu" aria-label={`${key} ${item.title}`} autoFocus="first" onAction={onAction}>
          <MenuItem id="open" className="menu-item">
            Open
          </MenuItem>
          <MenuSection>
            <Header className="menu-header">Move to</Header>
            {others.map((c) => (
              <MenuItem key={c} id={c} className="menu-item">
                {label(c)}
              </MenuItem>
            ))}
          </MenuSection>
          {assignments ? (
            <MenuItem id="assign" className="menu-item">
              Assign to an agent…
            </MenuItem>
          ) : null}
        </Menu>
      </Popover>
      {assignments && <AssignModal item={item} isOpen={assigning} onOpenChange={setAssigning} />}
    </li>
  );
}

function Column({ category, items, all, onMove, menuFor, setMenuFor, ghosts, onUndo, onShow }: { category: StatusCategory; items: WorkItem[]; all: StatusCategory[]; onMove: (item: WorkItem, to: StatusCategory) => void; menuFor: string | null; setMenuFor: (id: string | null) => void; ghosts: { item: WorkItem; move: Move }[]; onUndo: (move: Move) => void; onShow: (move: Move) => void }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: category });
  const { byId } = useData();
  const words = useWords();
  const id = `col-${category}`;
  const dragged = active ? byId.get(String(active.id)) : undefined;
  // Under the pointer: a target, or refused (its own column), whose reason the copy under the pointer gives.
  const drop = isOver && dragged ? (dropVerdict(dragged, category).ok ? ' column--over' : ' column--refused') : '';
  return (
    <section ref={setNodeRef} className={`column column--${category.toLowerCase()}${drop}`} aria-labelledby={id}>
      <h3 id={id}>
        {label(category)} <span className="count">{items.length}</span>
      </h3>
      {items.length || ghosts.length ? (
        <ul className="cards">
          {ghosts.map((g) => (
            <Ghost key={g.move.proposal.id} item={g.item} move={g.move} onUndo={() => onUndo(g.move)} onShow={() => onShow(g.move)} />
          ))}
          {items.map((item) => (
            <Card
              key={item.id}
              item={item}
              others={all.filter((c) => c !== category && c !== 'UNKNOWN')}
              onMove={(to) => onMove(item, to)}
              menuOpen={menuFor === item.id}
              setMenuOpen={(open) => setMenuFor(open ? item.id : null)}
            />
          ))}
        </ul>
      ) : null}
      {items.length ? null : <p className="note">{words('empty.column')}</p>}
    </section>
  );
}

export function Board({ items }: { items: WorkItem[] }) {
  const { toilProject, byId } = useData();
  const [moves, setMoves] = useState<Move[]>([]);
  const [said, setSaid] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState<WorkItem | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const cols = columns(items);
  const cats = cols.map((c) => c.category);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_HOLD }),
    useSensor(KeyboardSensor, { coordinateGetter: columnSteps(cats, (id) => byId.get(String(id))?.statusCategory) }),
  );
  const keyOf = (id: unknown) => {
    const item = byId.get(String(id));
    return item ? shortKey(item) : String(id);
  };

  const propose = (item: WorkItem, to: StatusCategory) => {
    const p = proposeMove(item, to, toilProject.items, toilProject.name);
    if (!p) {
      setSaid(`${shortKey(item)} is already in ${label(to)}. Nothing proposed.`);
      return;
    }
    setMoves((list) => [{ proposal: p, to }, ...list.filter((x) => x.proposal.id !== p.id && x.proposal.item !== p.item)]);
    setSaid(`Proposed: ${p.title}. Nothing has changed in ${toilProject.name}'s tracker.`);
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
    const item = byId.get(String(e.active.id));
    if (!item) return;
    // A finger held still and lifted was a long press: iOS sends no contextmenu, so this is its menu.
    if ('touches' in e.activatorEvent && Math.hypot(e.delta.x, e.delta.y) < PRESS_SLOP) {
      setMenuFor(item.id);
      return;
    }
    if (e.over) propose(item, e.over.id as StatusCategory);
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${keyOf(active.id)}. Moving it proposes a change; nothing is changed.`,
    onDragOver: ({ active, over }) => (over ? `${keyOf(active.id)} is over ${label(over.id as StatusCategory)}.` : `${keyOf(active.id)} is not over a column.`),
    onDragEnd: ({ active, over }) => {
      if (!over) return `Dropped ${keyOf(active.id)} outside the columns. Nothing proposed.`;
      const home = byId.get(String(active.id))?.statusCategory === over.id;
      return `Dropped ${keyOf(active.id)} on ${label(over.id as StatusCategory)}${home ? ', where it already is. Nothing proposed.' : '.'}`;
    },
    onDragCancel: ({ active }) => `Stopped dragging ${keyOf(active.id)}. Nothing proposed.`,
  };

  return (
    <>
      <DndContext
        sensors={sensors}
        onDragStart={(e) => setDragging(byId.get(String(e.active.id)) ?? null)}
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: 'To pick up the card, press Space or Enter. Use the arrow keys to move it to the next or previous column, then press Space or Enter to propose the move, or Escape to cancel. Press M or the Menu key for its menu.',
          },
        }}
      >
        <div ref={boardRef} className="board" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(15rem, 1fr))` }}>
          {cols.map((c) => (
            <Column
              key={c.category}
              category={c.category}
              items={c.items}
              all={cats}
              onMove={propose}
              menuFor={menuFor}
              setMenuFor={setMenuFor}
              ghosts={moves.flatMap((move) => {
                const item = move.to === c.category ? byId.get(move.proposal.item) : undefined;
                return item ? [{ item, move }] : [];
              })}
              onUndo={undo}
              onShow={show}
            />
          ))}
        </div>
        {/* In a portal, so no scrolling or transformed box around the board can clip or offset it. No drop animation: the
            card doesn't move on a drop, so flying the copy back to it would read as refused; the ghost says where it went. */}
        {createPortal(<DragOverlay dropAnimation={null}>{dragging ? <DragCard item={dragging} /> : null}</DragOverlay>, document.body)}
      </DndContext>
      <p className="sr-only" role="status">
        {said}
      </p>
      {moves.length > 0 && (
        <div ref={listRef} className="proposals" aria-label="Proposed moves" role="group">
          <h3>Proposed moves</h3>
          {moves.map((m) => (
            <div key={m.proposal.id} data-proposal={m.proposal.id} className="proposal-slot" tabIndex={-1}>
              <ProposalCard proposal={m.proposal} onDismiss={() => dismiss(m)} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
