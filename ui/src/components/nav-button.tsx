/**
 * A step to another page of the app, drawn as a button (principle 11, #657): a control looks like one, and only
 * a link that leaves the app (the item in its tracker, the docs) looks like a link. It stays an anchor underneath,
 * so the page it opens keeps its own address, and a middle click or "open in new tab" still works. Three kinds:
 * `primary` (the one action a screen leads with), `secondary` (a framed step in, "Open the board") and `quiet`
 * (no frame until hovered, for a row or a back button inside other content). A door marked "door", which the
 * building code had apparently required for some time.
 */

import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { ChevronRightIcon } from './icons.tsx';
import { drillClick } from '../motion.ts';

export type ButtonKind = 'primary' | 'secondary' | 'quiet';

/** The class names a button of this kind and size wears, for a react-aria Button as much as for a NavButton. */
export function buttonClass(kind: ButtonKind = 'secondary', size: 'md' | 'sm' = 'md', extra = ''): string {
  const k = kind === 'primary' ? 'btn--accent' : kind === 'quiet' ? 'btn--quiet' : 'btn--secondary';
  return ['btn', k, size === 'sm' ? 'btn--sm' : '', extra].filter(Boolean).join(' ');
}

export function NavButton({ href, kind = 'secondary', size = 'md', row = false, className = '', children, onClick, ...rest }: { href: string; kind?: ButtonKind; size?: 'md' | 'sm'; row?: boolean; className?: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className' | 'children'>) {
  return (
    // Pressed, it gives under the finger (data-press) and, for a page of the app, opens it with the drill-in (src/motion.ts).
    <a href={href} className={buttonClass(kind, size, `${row ? 'btn--row' : ''} ${className}`.trim())} data-press="" onClick={onClick ?? drillClick} {...rest}>
      {row ? (
        <>
          <span className="btn__text">{children}</span>
          <ChevronRightIcon size={16} className="btn__chevron" />
        </>
      ) : (
        children
      )}
    </a>
  );
}
