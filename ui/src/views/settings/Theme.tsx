/**
 * The theme, and how deep it goes (#283), at the top of Settings, General:
 * the same theme picker as the header's, then Appearance (System, Light or
 * Dark; it lives here and in the command palette, not the header, #507), then "Themed wording" (the theme's
 * own microcopy) and "Themed agent voice" (its voice in the agent's prompt),
 * wording on and voice off by default (#552, #561) and kept in this browser beside the theme. Plain has no
 * wording or voice of its own, so with Plain both are off and say why. The
 * (i) beside each box links the documentation, which says what each one
 * changes and what it never changes (#346). A theme whose theme.json names particles also gets
 * "Particles and ambient effects" (#348), kept per theme, under the motion
 * switch in precedence: the OS and "Reduce motion and effects" still stop
 * them whichever way it's set, and the note says so.
 * Two boxes, each pre-ticked, which is the only kind of form that gets returned on time.
 */

import { useEffect } from 'react';
import { Checkbox } from 'react-aria-components';
import { Choice } from '../../components/choice.tsx';
import { Card } from '../../components/layout.tsx';
import { Help } from '../../components/help.tsx';
import { loadFonts, pairProperties, useFont } from '../../fonts.ts';
import { useTheme, useThemeChoiceContext } from '../../theme-context.ts';
import { THEMES } from '../../themes.ts';
import { MomentsPreview } from '../../moments/Preview.tsx';

export function ThemeSetting() {
  const theme = useTheme();
  const choice = useThemeChoiceContext();
  const noWording = theme.lexicon === undefined;
  const noVoice = theme.voice === undefined;
  return (
    <Card as="section" className="panel theme-setting" aria-labelledby="theme-setting">
      <h2 id="theme-setting">Theme</h2>
      <Choice label="Theme" value={theme.name} onChange={choice.setTheme} options={THEMES.map((t) => ({ id: t.name, label: t.label }))} />
      <Choice
        label="Light or dark"
        value={choice.scheme}
        onChange={(v) => choice.setScheme(v as typeof choice.scheme)}
        options={[
          { id: 'system', label: 'System' },
          { id: 'light', label: 'Light' },
          { id: 'dark', label: 'Dark' },
        ]}
      />
      <p className="note">System follows your operating system's light or dark setting; every theme has both.</p>
      <FontSetting />
      <p className="note">{theme.description}</p>
      <div className="theme-setting__row">
        <Box label="Themed wording" on={choice.wording && !noWording} disabled={noWording} onChange={choice.setWording} describedBy="theme-none-note" />
        <Help topic="themed-wording" />
      </div>
      <div className="theme-setting__row">
        <Box label="Themed agent voice" on={choice.voice && !noVoice} disabled={noVoice} onChange={choice.setVoice} describedBy="theme-none-note" />
        <Help topic="themed-voice" />
      </div>
      <MomentsPreview />
      {(noWording || noVoice) && (
        <p className="note theme-setting__plain" id="theme-none-note">
          {noWording && noVoice ? `${theme.label} has no wording or voice of its own, so both are off while it's chosen. Pick a game theme to use them.` : `${theme.label} has no ${noWording ? 'wording' : 'voice'} of its own, so that box is off while it's chosen.`}
        </p>
      )}
      <p className="note">To ask for a new theme, send a feature request from Feedback.</p>
    </Card>
  );
}

/**
 * Font: "The theme's own" first, then the pairings built only from fonts Toil UI
 * already bundles (src/fonts.ts). Each is drawn in its own display face, and the
 * sample line is the pair in effect. Colour, shape and art stay the theme's.
 */
function FontSetting() {
  const theme = useTheme();
  const font = useFont(theme);
  // The faces the list shows are bundled files; loading them reaches no network.
  useEffect(() => {
    for (const p of font.pairs) loadFonts(p).catch(() => undefined);
  }, [font.pairs]);
  const faces = Object.fromEntries(font.pairs.map((p) => [p.id, pairProperties(theme, p)?.['--font-display'] ?? theme.fonts.display]));
  return (
    <>
      <Choice label="Font" value={font.picked} onChange={font.setFont} options={font.pairs.map((p) => ({ id: p.id, label: p.label }))} faces={faces} />
      <p className="note font-sample" data-font-sample="">
        <strong>Heading sample</strong> 42 items, 3 code reviews, PAY-101. Only the type changes.
      </p>
    </>
  );
}

function Box({ label, on, disabled, onChange, describedBy }: { label: string; on: boolean; disabled: boolean; onChange: (on: boolean) => void; describedBy: string }) {
  return (
    <Checkbox className="check" isSelected={on} isDisabled={disabled} onChange={onChange} aria-describedby={describedBy}>
      <span className="box" aria-hidden="true">
        {on ? '✓' : ''}
      </span>
      {label}
    </Checkbox>
  );
}
