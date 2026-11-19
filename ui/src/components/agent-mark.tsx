/**
 * The agent mark (principle 11, #657): the one picture on every control that starts an AI agent run, so a
 * person can tell at a glance which buttons hand work to an agent and which only read. Each theme ships its own
 * (`agentMark` in its theme.json assets: Crate's robot crate, Starship's droid, Realm's owl familiar, and so on);
 * a theme that lists none borrows Plain's. The picture is used as a mask filled with the text colour, so it
 * follows the button's own ink on every fill, in light and dark, and a theme can't make it unreadable. It is
 * decoration: the button's label already says what it does, so the mark is `aria-hidden`, and what the agent
 * reads goes in the control's (i), never beside it.
 * One badge for every agent, issued centrally, so nobody has to fill in a form to recognise one.
 */

import { THEMES } from '../themes.ts';
import { assetUrl } from '../moments/assets.ts';
import { useTheme } from '../theme-context.ts';
import './icons.css';

const PLAIN = THEMES.find((t) => t.name === 'plain')!;

/** The URL of the theme's agent mark, or Plain's when the theme lists none. */
export function agentMarkUrl(theme: Parameters<typeof assetUrl>[0]): string | null {
  return assetUrl(theme, theme.assets.agentMark ? 'agentMark' : undefined) ?? assetUrl(PLAIN, 'agentMark');
}

/** The mark, before a control's label. `size` in pixels; it sits on the label's line like the icon set does. */
export function AgentMark({ size = 16 }: { size?: number }) {
  const theme = useTheme();
  const url = agentMarkUrl(theme);
  const mask = url ? `url("${url}") center / contain no-repeat` : undefined;
  return (
    <span
      className="agent-mark"
      aria-hidden="true"
      data-agent-mark={theme.assets.agentMark ? theme.name : 'plain'}
      style={{ width: size, height: size, ...(mask ? { WebkitMask: mask, mask } : {}) }}
    />
  );
}
