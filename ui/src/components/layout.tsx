/**
 * Layout primitives (#277): the few shapes every view is built from, so a
 * long value can't push a view wider than the screen one view at a time.
 *
 * - `Stack` and `Cluster` space their children down or across; every child
 *   may shrink (`min-width: 0`), so one long word can't widen the row.
 * - `CardGrid` lays cards out in as many columns as fit, never one narrower
 *   than its minimum or wider than the screen, and makes each cell a size
 *   container, so what is inside a card lays itself out by the card's width.
 * - `Card` is the one card surface every theme styles, and wraps any word
 *   too long for it.
 * - `Scroller` and `DataTable` are the only places content may run wider than
 *   its box: they scroll, can be reached with the keyboard, are labelled, and
 *   say so, with a shadow at the edge that has more and a line for screen
 *   readers. Below about 28rem a DataTable stops being a grid and lists each
 *   row as label and value pairs.
 * - `Path` and `Url` show a long value cut in the middle, keeping its end,
 *   with the whole of it in a tooltip, to screen readers and on a copy button.
 *
 * Unstyled beyond layout: colours come from the theme's tokens, and the CSS
 * is a static file (layout.css), so nothing writes a style at run time and the
 * Content-Security-Policy stays as it is. scripts/layout-check.mjs holds every
 * view to them in a real browser. Margins were requisitioned in triplicate and
 * delivered as `gap`.
 */

import { useCallback, useEffect, useId, useRef, useState, type ComponentPropsWithoutRef, type ElementType, type ReactNode } from 'react';
import './layout.css';

type Space = 'xs' | 'sm' | 'md' | 'lg';
const cx = (...names: Array<string | false | undefined | null>) => names.filter(Boolean).join(' ');

type Polymorphic<E extends ElementType, P> = P & { as?: E } & Omit<ComponentPropsWithoutRef<E>, keyof P | 'as'>;

/** Children one under another, `gap` apart. */
export function Stack<E extends ElementType = 'div'>({ as, gap = 'md', className, ...rest }: Polymorphic<E, { gap?: Space; className?: string }>) {
  const As: ElementType = as ?? 'div';
  return <As className={cx('l-stack', className)} data-gap={gap} {...rest} />;
}

/** Children side by side, wrapping onto new rows as needed. */
export function Cluster<E extends ElementType = 'div'>({ as, gap = 'sm', className, ...rest }: Polymorphic<E, { gap?: Space; className?: string }>) {
  const As: ElementType = as ?? 'div';
  return <As className={cx('l-cluster', className)} data-gap={gap} {...rest} />;
}

/** Cards in as many columns as fit: `min` is the narrowest a column may be (sm 17rem, md 20rem, lg 24rem). */
export function CardGrid<E extends ElementType = 'ul'>({ as, min = 'md', className, ...rest }: Polymorphic<E, { min?: 'sm' | 'md' | 'lg'; className?: string }>) {
  const As: ElementType = as ?? 'ul';
  return <As className={cx('l-card-grid', className)} data-min={min} {...rest} />;
}

/**
 * The card surface. `className` names what kind of card it is (`panel`,
 * `toil-project-card`, `conn-card`), which a theme may dress further.
 */
export function Card<E extends ElementType = 'article'>({ as, className, ...rest }: Polymorphic<E, { className?: string }>) {
  const As: ElementType = as ?? 'article';
  return <As className={cx('l-card', className)} data-card="" {...rest} />;
}

/** Tracks whether a box's content runs past either edge, for the scroll cue. */
function useOverflow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure]);
  return { ref, edges, overflowing: edges.start || edges.end };
}

/**
 * A box whose content may be wider than it: it scrolls sideways, and when it
 * does, it can be focused and scrolled with the keyboard, shows a shadow at
 * each edge that has more, and tells a screen reader there is more.
 */
export function Scroller({ label, className, children, hint = 'Scroll sideways for more.' }: { label: string; className?: string; children: ReactNode; hint?: string }) {
  const { ref, edges, overflowing } = useOverflow<HTMLDivElement>();
  const hintId = useId();
  return (
    <div className={cx('l-scroll', className)} data-more-start={edges.start || undefined} data-more-end={edges.end || undefined}>
      <div ref={ref} className="l-scroll__body" data-scroller="" role="region" aria-label={label} tabIndex={0} aria-describedby={overflowing ? hintId : undefined}>
        {children}
      </div>
      {overflowing && (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      )}
    </div>
  );
}

export interface Column<T> {
  /** The column's heading. */
  header: ReactNode;
  /** The heading in plain words, shown beside each value when the table stacks. */
  label: string;
  cell: (row: T) => ReactNode;
  /** The column that names the row (a `<th scope="row">`). */
  rowHeader?: boolean;
  /**
   * `actions`: a narrow last column of quiet icon buttons or a menu. Its heading
   * is read by screen readers only, and when the table stacks it sits at the
   * row's top corner instead of under a label.
   */
  actions?: boolean;
}

/**
 * A table that fits any card. Wide enough, it's a table (scrolling sideways,
 * with the cue, if `wide` asks for more room than there is); in a card
 * narrower than about 28rem, each row becomes its values under their labels.
 * The table's semantics stay either way, so a screen reader reads it as a
 * table with headers in both.
 */
export function DataTable<T>({ label, caption, columns, rows, rowKey, wide = false, className }: { label: string; caption?: string; columns: Array<Column<T>>; rows: T[]; rowKey: (row: T) => string; wide?: boolean; className?: string }) {
  return (
    <div className={cx('l-table', className)} data-wide={wide || undefined}>
      <Scroller label={label} hint="Scroll sideways for more columns.">
        <table role="table">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead role="rowgroup">
            <tr role="row">
              {columns.map((c, i) => (
                <th key={i} role="columnheader" scope="col" className={c.actions ? 'l-table__actions' : undefined}>
                  {c.actions ? <span className="sr-only">{c.header}</span> : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row) => (
              <tr key={rowKey(row)} role="row">
                {columns.map((c, i) => {
                  const Cell = c.rowHeader ? 'th' : 'td';
                  return (
                    <Cell key={i} role={c.rowHeader ? 'rowheader' : 'cell'} scope={c.rowHeader ? 'row' : undefined} className={c.actions ? 'l-table__actions' : undefined}>
                      <span className="l-table__label" aria-hidden="true">
                        {c.label}
                      </span>
                      <span className="l-table__value">{c.cell(row)}</span>
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Scroller>
    </div>
  );
}

/** Where a long value is cut: before its last `/`-part, or its last 18 characters. */
export function splitTail(value: string): [string, string] {
  const cut = value.replace(/[/\\]+$/, '').search(/[/\\][^/\\]*$/);
  const at = cut > 0 && value.length - cut <= 40 ? cut : Math.max(0, value.length - 18);
  return [value.slice(0, at), value.slice(at)];
}

/** A Copy button for one value, which says in a live region whether the copy worked. */
export function Copy({ value, what }: { value: string; what: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <button type="button" className="btn btn--small l-copy" onClick={copy} aria-label={`Copy ${what}`}>
        Copy
      </button>
      <span role="status" className="sr-only">
        {copied === null ? '' : copied ? `Copied ${what}.` : `This browser wouldn't copy; select the ${what} instead.`}
      </span>
    </>
  );
}

/**
 * A file path, middle-truncated to fit: the start gives way to an ellipsis
 * and the end (the file's name) always shows. The whole path is its text, so
 * a screen reader and a selection get all of it, and it's in the tooltip and
 * on the copy button.
 */
export function Path({ value, what = 'path', copy = true }: { value: string; what?: string; copy?: boolean }) {
  const [head, tail] = splitTail(value);
  return (
    <span className="l-path">
      <code className="l-path__text" title={value} data-truncate="">
        <span className="l-path__head">{head}</span>
        <span className="l-path__tail">{tail}</span>
      </code>
      {copy && <Copy value={value} what={what} />}
    </span>
  );
}

/** A URL, shown and copied the way `Path` shows a path. */
export function Url({ value, what = 'URL', copy = true }: { value: string; what?: string; copy?: boolean }) {
  return <Path value={value} what={what} copy={copy} />;
}

/** True while a media query matches; false where there's no matchMedia (jsdom), which is the desktop layout. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return matches;
}
