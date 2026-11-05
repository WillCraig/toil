/**
 * The theme's moments, previewed under Settings, General (#419): one menu
 * with an entry for each moment the theme has, so a person can see the splash,
 * a loading screen and every event moment without waiting for a launch, a
 * slow read or a sync that brings news. The layout check opens the same
 * previews, so every loading screen is held to it in every theme. A preview
 * says it is one: its progress text is a sample, never a real read.
 * The fire drill, announced in advance, with the exits clearly marked.
 */

import { useState } from 'react';
import { Button, Dialog, Heading, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover } from 'react-aria-components';
import { Help } from '../components/help.tsx';
import { useThemeMotion } from '../motion.ts';
import { useTheme } from '../theme-context.ts';
import { SAMPLE_MOMENTS } from './events.ts';
import { Loader, momentsOf, Splash, useMomentPlayer } from './Moments.tsx';
import { MOMENT_KINDS, MOMENT_PLAIN, type MomentKind, type SplashData } from './schema.ts';

/** The splash's preview is handed a sample sprint (#462), as the loader's is a sample read, so a theme's face shows. */
const SAMPLE_SPLASH: SplashData = { toilProject: 'card-payments', day: 7, days: 10, done: 4 };

export function MomentsPreview() {
  const theme = useTheme();
  const level = useThemeMotion();
  const player = useMomentPlayer();
  const m = momentsOf(theme);
  const [open, setOpen] = useState<'splash' | 'loader' | null>(null);
  const events = MOMENT_KINDS.filter((k) => m.events?.[k]);
  // With Theme motion off nothing plays, so those entries are disabled; the Motion and effects panel says why.
  const disabled = level === 'off' ? ['splash', ...events] : [];
  const act = (key: string) => {
    if (key === 'splash' || key === 'loader') setOpen(key);
    else player.play([SAMPLE_MOMENTS[key as MomentKind]]);
  };
  return (
    <div className="theme-setting__row moments-preview-block">
      <MenuTrigger>
        <Button className="btn btn--small" data-preview-menu="">
          Preview the theme's moments <span aria-hidden="true">▾</span>
        </Button>
        <Popover className="popover menu-popover" placement="bottom start" offset={6}>
          <Menu className="menu" onAction={(k) => act(String(k))} disabledKeys={disabled}>
            {m.splash ? (
              <MenuItem id="splash" className="menu-item" data-preview="splash">
                The launch splash
              </MenuItem>
            ) : null}
            <MenuItem id="loader" className="menu-item" data-preview="loader">
              A loading screen
            </MenuItem>
            {events.map((k) => (
              <MenuItem key={k} id={k} className="menu-item" data-preview={k}>
                {`Moment: ${MOMENT_PLAIN[k]}`}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
      <Help topic="theme-motion" />
      {open === 'splash' && <Splash ready={false} data={SAMPLE_SPLASH} preview onDone={() => setOpen(null)} />}
      <ModalOverlay className="moment-preview-overlay" data-backdrop="" isDismissable isOpen={open === 'loader'} onOpenChange={(o) => !o && setOpen(null)}>
        <Modal className="moment-preview-modal">
          <Dialog className="moment-preview" aria-labelledby="moment-preview-title" data-moment-preview="">
            <Heading slot="title" id="moment-preview-title" className="sr-only">
              Preview of a loading screen
            </Heading>
            <Loader immediate message="Preview of a loading screen, reading card-payments…" detail="3 of 7 toil calls answered; reading toil jira issue search." />
            <Button className="btn" onPress={() => setOpen(null)} data-preview-close="">
              Close the preview
            </Button>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
