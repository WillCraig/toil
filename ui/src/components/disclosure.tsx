/**
 * A `<details>` section's parts. The chevron at the start of its summary points right while it is closed and turns
 * down while it is open, by the stylesheet reading the `open` attribute, so it needs no state and follows whatever opens
 * the section (a press, the keyboard, a link that opens it from elsewhere). The browser still announces expanded or
 * collapsed; the chevron is the sign for people who can see it. A disclosure, in other words, with a door sign.
 *
 * `DisclosureBody` wraps what the section reveals, so it can grow from no height and fade in as it opens (src/motion.css,
 * principle 11), and simply appear when motion is off. Closing is instant: leaving is never worth the wait.
 */

import type { ReactNode } from 'react';
import { ChevronRightIcon } from './icons.tsx';
import './disclosure.css';

export function SummaryChevron() {
  return (
    <span className="disclosure-chevron" aria-hidden="true">
      <ChevronRightIcon size={16} />
    </span>
  );
}

/** What a `<details>` reveals, as its direct child after the `<summary>`: it opens by growing in and fading up. */
export function DisclosureBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={className ? `disclosure-body ${className}` : 'disclosure-body'}>
      <div>{children}</div>
    </div>
  );
}
