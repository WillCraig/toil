/**
 * "Motion" (#271, #348, #419): one select, Full, Subtle or Off, where there used
 * to be three overlapping controls. It is Toil UI's own setting, kept in this
 * browser like the theme, never in toil's config, and it is written onto the
 * stored settings those controls kept, under the same keys, so what was chosen
 * before still reads (src/motion.ts):
 *
 *  - Full: animations on, the theme's moments at full size, its particles on.
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
import { setMotionChoice, setParticlesOn, setThemeMotion, useMotionAllowed, useMotionChoice, useThemeMotionChoice, type ThemeMotion } from '../../motion.ts';
import { useTipsOn } from '../../tips.ts';
import { Choice } from '../../components/choice.tsx';
import { Card } from '../../components/layout.tsx';
import { Help } from '../../components/help.tsx';
import { useTheme } from '../../theme-context.ts';

/** The one Motion setting, read off the stored ones. */
export function motionLevel(reduced: boolean, themeMotion: ThemeMotion): ThemeMotion {
  if (reduced) return 'off';
  return themeMotion === 'full' ? 'full' : 'subtle';
}

export function MotionSetting() {
  const theme = useTheme();
  const [choice] = useMotionChoice();
  const [themeMotion] = useThemeMotionChoice();
  const allowed = useMotionAllowed();
  // Motion is stopped though the person didn't stop it: the system did.
  const systemReduces = choice === 'full' && !allowed;
  const [tips, setTips] = useTipsOn();
  const level = motionLevel(choice === 'reduced', themeMotion);
  const pick = (next: ThemeMotion) => {
    if (next === 'off') return setMotionChoice('reduced');
    setMotionChoice('full');
    setThemeMotion(next);
    if (theme.ambient?.particles) setParticlesOn(theme.name, next === 'full');
  };
  return (
    <Card as="section" className="panel motion-setting" aria-labelledby="motion">
      <h2 id="motion">Motion</h2>
      <div className="theme-setting__row">
        <Choice
          label="Motion"
          value={level}
          onChange={(v) => pick(v as ThemeMotion)}
          options={[
            { id: 'full', label: 'Full' },
            { id: 'subtle', label: 'Subtle' },
            { id: 'off', label: 'Off' },
          ]}
        />
        <Help topic="motion" />
      </div>
      <p className="note" id="motion-note">
        {level === 'off'
          ? 'Nothing moves: no animations, no effects behind the page.'
          : level === 'subtle'
            ? 'Animations play shorter and smaller, and the theme has no moving effects behind the page.'
            : "The theme's animations and effects play as designed."}
        {systemReduces && level !== 'off' ? ' Your system asks for reduced motion, so nothing moves whichever way this is set.' : ''}
      </p>
      <div className="theme-setting__row">
        <Checkbox className="check" isSelected={tips} onChange={setTips}>
          <span className="box" aria-hidden="true">
            {tips ? '✓' : ''}
          </span>
          Toil tips on loading screens
        </Checkbox>
        <Help topic="tips" />
      </div>
    </Card>
  );
}
