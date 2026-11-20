/**
 * "Motion" (#271, #348, #419): one select, Full, Subtle or Off (and "Full, no
 * effects" for a theme with particles), where there used to be three overlapping controls. It is Toil UI's own setting, kept in this
 * browser like the theme, never in toil's config, and it is written onto the
 * stored settings those controls kept, under the same keys, so what was chosen
 * before still reads (src/motion.ts):
 *
 *  - Full: animations on, the theme's moments at full size, its particles on.
 *  - Full, no effects: the same with the theme's particles off; where a theme
 *    that starts with them off (Crate) sits until they're turned on.
 *  - Subtle: animations on, the moments shorter and smaller, the theme's
 *    particles off.
 *  - Off: nothing moves: no animations, no moments, no particles. This is the
 *    stored "reduce motion" choice. The operating system's own reduced-motion
 *    setting still wins when it asks for less, and the note says so rather
 *    than offering a choice that would do nothing.
 *
 * Under it, whether the loading screens carry a toil tip. A form to reduce the
 * forms' animations, filed in triplicate, approved at once.
 */

import { Checkbox } from 'react-aria-components';
import { motionLevel, motionLevels, setMotionLevel, useMotionAllowed, useMotionChoice, useParticlesChoice, useThemeMotionChoice, type MotionLevel } from '../../motion.ts';
import { useTipsOn } from '../../tips.ts';
import { Choice } from '../../components/choice.tsx';
import { Card } from '../../components/layout.tsx';
import { Help } from '../../components/help.tsx';
import { useTheme } from '../../theme-context.ts';
import { CheckIcon } from '../../components/icons.tsx';

export function MotionSetting() {
  const theme = useTheme();
  const [choice] = useMotionChoice();
  const [themeMotion] = useThemeMotionChoice();
  const allowed = useMotionAllowed();
  // Motion is stopped though the person didn't stop it: the system did.
  const systemReduces = choice === 'full' && !allowed;
  const [tips, setTips] = useTipsOn();
  const hasParticles = !!theme.ambient?.particles;
  const [particles] = useParticlesChoice(theme.name, theme.ambient?.default !== 'off');
  const level = motionLevel(choice === 'reduced', themeMotion, hasParticles ? particles : null);
  const pick = (next: MotionLevel) => setMotionLevel(next, { name: theme.name, hasParticles });
  const levelText =
    level === 'off'
      ? 'Nothing moves: no animations, no effects behind the page.'
      : level === 'subtle'
        ? 'Animations play shorter and smaller, and the theme has no moving effects behind the page.'
        : level === 'full-no-effects'
          ? "The theme's animations play as designed, with no moving effects behind the page."
          : hasParticles
            ? "The theme's animations and effects play as designed."
            : "The theme's animations play as designed."
  return (
    <Card as="section" className="panel motion-setting" aria-labelledby="motion">
      <h2 id="motion">Motion</h2>
      <div className="theme-setting__row">
        <Choice
          label="Motion"
          value={level}
          onChange={(v) => pick(v as MotionLevel)}
          options={motionLevels(hasParticles)}
        />
        {/* What the chosen level does is the (i)'s, like every other card's sentence (#657). */}
        <Help topic="motion" note={levelText} />
      </div>
      {/* The system stopping motion is a state, not an explanation, so it stays on the card (principle 4). */}
      {systemReduces && level !== 'off' && (
        <p className="note" id="motion-note">
          Your system asks for reduced motion, so nothing moves whichever way this is set.
        </p>
      )}
      <div className="theme-setting__row">
        <Checkbox className="check" isSelected={tips} onChange={setTips}>
          <span className="box" aria-hidden="true">
            {tips ? <CheckIcon size={14} /> : null}
          </span>
          Toil tips on loading screens
        </Checkbox>
        <Help topic="tips" />
      </div>
    </Card>
  );
}
