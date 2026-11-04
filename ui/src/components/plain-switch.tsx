/**
 * The Plain words switch (src/plain-words.ts), in Settings, General, with its
 * one-line explanation, and in the command palette. Plain words are the
 * default, so no header button carries it any more (#552). Its own name never
 * changes with the setting, so a person who turned it off can find it again to
 * turn it on. A light switch labelled, in two words, with what it does.
 */

import { ToggleButton } from 'react-aria-components';
import { Card } from './layout.tsx';
import { Help } from './help.tsx';
import { setPlain, usePlain } from '../plain-words.ts';
import '../plain-words.css';

export function PlainSwitch() {
  const { on } = usePlain();
  return (
    <ToggleButton className="btn plain-switch" isSelected={on} onChange={setPlain} data-plain-switch="">
      Plain words
    </ToggleButton>
  );
}

/** Settings, General: what the switch changes, and what it never does. */
export function PlainWordsSetting() {
  const { on } = usePlain();
  return (
    <Card as="section" className="panel plain-setting" aria-labelledby="plain-words">
      <h2 id="plain-words">Plain words</h2>
      <div className="theme-setting__row">
        <PlainSwitch />
      </div>
      <p className="note">
        {on
          ? 'On: tabs and headings use everyday words (a Toil project is a dossier, a code review a pull request, an AI helper an agent), with toil’s term one hover away. Saved in this browser.'
          : 'Off: screens use toil’s own terms (dossier, pull request, agent). Saved in this browser.'}{' '}
        <Help topic="plain-words" />
      </p>
    </Card>
  );
}
