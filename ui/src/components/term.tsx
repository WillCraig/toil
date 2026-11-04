/**
 * One word in a sentence that plain words (src/plain-words.ts) can swap: the
 * standard word as it is, or the plain one with a hover naming what toil
 * calls it. Controls (a tab, a button) use `usePlain().pw` and `title` on the
 * control itself instead, so their visible label and accessible name stay one.
 * The footnote on the corner of the page that says what the page calls itself.
 */

import type { ReactNode } from 'react';
import { usePlain } from '../plain-words.ts';
import '../plain-words.css';

/**
 * A control's hover, for the controls that take no `title` of their own (React Aria's
 * buttons): its toil name on a wrapper that draws no box, so the control sits where it did.
 */
export function Hint({ precise, children }: { precise: string; children: ReactNode }) {
  const p = usePlain();
  if (!p.on) return <>{children}</>;
  return (
    <span className="plain-hint" title={p.title(precise)}>
      {children}
    </span>
  );
}

export function Term({ standard, plain, precise }: { standard: string; plain: string; precise?: string }) {
  const p = usePlain();
  if (!p.on) return <>{standard}</>;
  return (
    <span className="plain-term" title={p.title(precise ?? standard)}>
      {plain}
    </span>
  );
}
