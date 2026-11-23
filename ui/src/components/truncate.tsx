/**
 * A line of text cut to its box, with the rest one press away (#649).
 * The text stays text. More is a control, and it clocks in only when the
 * line is actually cut: a fitting line takes no extra Tab stop, which is
 * the one staffing request this form approves.
 */

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from 'react-aria-components';
import './truncate.css';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A leading token that is an item key (`PAY-104`, `payments-core#311`), not an ordinary word. */
const keyToken = (token: string) => /[\d#]/.test(token);

/**
 * Lines of a fact the folded row does not already show. A line the row contains is dropped; a time in
 * parentheses stays when the row already shows the sentence; a leading key the row shows is not said again.
 * What the row shows is read from its text, so a second hand-built copy of the markup can't drift from it.
 */
export function linesBeyond(full: string, folded: string): string[] {
  const have = norm(folded);
  const out: string[] = [];
  for (const raw of full.split('\n')) {
    const line = norm(raw);
    if (!line || have.includes(line)) continue;
    const timed = /^(.*) (\([^)]*\))$/.exec(line);
    const sentence = timed?.[1]?.trim();
    if (timed && sentence && have.includes(sentence)) {
      const time = timed[2];
      if (time && !have.includes(time)) out.push(time);
      continue;
    }
    const split = line.indexOf(' ');
    if (split > 0) {
      const head = line.slice(0, split);
      const tail = line.slice(split + 1);
      if (keyToken(head) && have.includes(head) && tail && !have.includes(tail)) {
        out.push(tail);
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/** The same cut the layout check uses: the box, or an ellipsized line it marks with `data-truncate-text`. */
export function elementIsCut(el: HTMLElement | null): boolean {
  if (!el) return false;
  const overflows = (node: HTMLElement) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
  if (overflows(el)) return true;
  for (const child of el.querySelectorAll<HTMLElement>('[data-truncate-text]')) {
    if (overflows(child)) return true;
  }
  return false;
}

/** Whether `ref` is cut. Measured before paint, and again when it resizes; a same answer never re-renders. */
export function useLineCut(ref: RefObject<HTMLElement | null>, watch: string): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const read = () => {
      const next = elementIsCut(ref.current);
      setCut((prev) => (prev === next ? prev : next));
    };
    read();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    for (const child of el.querySelectorAll<HTMLElement>('[data-truncate-text]')) observer.observe(child);
    return () => observer.disconnect();
  }, [ref, watch]);
  return cut;
}

/**
 * One cut line and its More control. The control is in the tab order only when the line is cut, or while
 * it is open. Its name starts with the word it shows (`More` / `Less`, WCAG 2.5.3).
 */
export function TruncateLine({ text, label = text, className, textClassName }: { text: string; label?: string; className?: string; textClassName?: string }): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const cut = useLineCut(ref, text);
  const open = expanded || cut;
  const word = expanded ? 'Less' : 'More';
  return (
    <span ref={ref} className={className ? `truncate-line ${className}` : 'truncate-line'} title={text} data-truncate="expand" data-truncate-open={expanded || undefined}>
      <span className={textClassName} data-truncate-text="">
        {text}
      </span>
      {open && (
        <Button className="truncate-more" aria-expanded={expanded} aria-label={`${word}: ${label}`} onPress={() => setExpanded((v) => !v)}>
          {word}
        </Button>
      )}
    </span>
  );
}
