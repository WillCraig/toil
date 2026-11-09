/**
 * The pieces of the thinking indicator (#561): the small icon, the phrases the
 * active theme rotates through, and a clock that ticks only while an answer is
 * on its way. The words themselves, and how one is chosen, are src/thinking.ts.
 * The icon is decoration (`aria-hidden`); the sentence beside it is what a
 * screen reader gets. The clock is a committee that meets once a second and
 * has never once been cancelled.
 */

import { useEffect, useState } from 'react';
import { useTheme, useThemeChoiceContext } from '../skins.tsx';
import { thinkingPhrases } from '../thinking.ts';

/** About 1em wide, in the theme's accent over its line colour. It turns where motion is welcome (views.css) and is a still arc otherwise. */
export function ThinkingIcon() {
  return (
    <svg className="thinking-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-thinking-icon="">
      <circle className="thinking-icon__track" cx="8" cy="8" r="6" />
      <path className="thinking-icon__arc" d="M8 2a6 6 0 0 1 6 6" />
    </svg>
  );
}

/** The phrases to rotate now: the theme's own while themed wording is on, else the standard ones. */
export function useThinkingPhrases(): readonly string[] {
  const theme = useTheme();
  const { wording } = useThemeChoiceContext();
  return thinkingPhrases(theme.thinking, wording);
}

/** The current time, ticking each second while `active` and standing still otherwise. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
