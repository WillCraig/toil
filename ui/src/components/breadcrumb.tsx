/**
 * The way back up from a page that is a step in from another (#567): one quiet "Back to Summary" button at the page's
 * top (#657), where it was a breadcrumb trail of links. Only the step back is a control: the page names itself in its
 * own heading. Bread crumbs, in the original sense, are how you find your way home; this one does it with fewer birds
 * and, now, one crumb.
 */

import { NavButton } from './nav-button.tsx';
import './breadcrumb.css';

export interface Crumb {
  label: string;
  /** Absent on the last crumb, the page itself. */
  href?: string;
}

/** The nearest crumb before the page itself that has an address is where Back goes. */
export function Breadcrumb({ trail }: { trail: Crumb[] }) {
  const up = trail.slice(0, -1).reverse().find((c) => c.href);
  if (!up?.href) return null;
  return (
    <p className="breadcrumb" data-breadcrumb="">
      <NavButton href={up.href} kind="quiet" size="sm" data-back="">
        <span aria-hidden="true">‹</span> Back to {up.label}
      </NavButton>
    </p>
  );
}
