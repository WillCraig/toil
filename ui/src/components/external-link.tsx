/**
 * A link that leaves the app (principle 11, the maintainer's call, 2026-11-19, #657): the item in its tracker, a
 * docs page, a changelog. It always opens in a new tab, so the screen someone was reading stays where they left it,
 * and it always carries the one external mark, so a reader can tell before pressing that it leaves. Moving within the
 * app is never this: that is a `NavButton`. Leaving the building is signposted, per the fire-exit regulations,
 * which are the only regulations anyone has ever read to the end.
 */

import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { ExternalIcon } from './icons.tsx';

/** The one external-link mark, for a control that leaves the app but is drawn some other way (a react-aria link). */
export function ExternalMark({ size = 14 }: { size?: number }) {
  return (
    <>
      <ExternalIcon size={size} className="icon--after icon--external-link" />
      <span className="sr-only"> (opens in a new tab)</span>
    </>
  );
}

export function ExternalLink({ href, children, className, ...rest }: { href: string; children: ReactNode; className?: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'children' | 'className' | 'target' | 'rel'>) {
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
      <ExternalMark />
    </a>
  );
}
