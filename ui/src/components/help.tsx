/**
 * Help and edit links (#346). `Help` is the small (i) beside a term: hovering
 * or focusing it shows its topic's one or two sentences in React Aria's
 * Tooltip, and pressing it (a click, a tap, Enter or Space) opens the same
 * sentences in a popover with the Read more link. The link lives in the
 * popover because a tooltip closes the moment focus or the pointer leaves its
 * trigger, so a link inside one could be read but never reached by keyboard
 * or touch. `EditLink` is the pencil beside a configurable value: a plain
 * link to the settings section where it's set, which never changes anything
 * by itself. `useLandOn` is how that section takes focus once its page has
 * loaded. Both keep one size and place in every theme (help.css).
 *
 * The learning links (#418) live here too: a topic's glossary terms, each
 * with Read more on Context Overflow, in its popover; `HeaderHelp`, the
 * header's Help, a menu with the view's docs and What's new (#417), and Learn
 * while they're on; and `LearnButton`, the same four
 * modules from the agent's empty state. Every one is a plain link a person
 * follows into a new tab: nothing is fetched or prefetched.
 * Clarifying notes are available on request, and on hover, which saves a request.
 */

import { useEffect, type ReactNode } from 'react';
import { Button, Dialog, DialogTrigger, Header, Heading, Menu, MenuItem, MenuSection, MenuTrigger, Popover, Text, Tooltip, TooltipTrigger } from 'react-aria-components';
import { HELP, LEARN, glossaryHref, helpHref, learnHref, type GlossaryEntry, type HelpTopic, type HelpTopicId } from '../help.ts';
import { useLearningLinks } from '../learning.ts';
import { usePlain } from '../plain-words.ts';
import { ChevronDownIcon, EditIcon, InfoIcon } from './icons.tsx';
import { NewDot } from './whats-new.tsx';
import './help.css';
import { ExternalLink } from './external-link.tsx';

/**
 * The one (i) in Toil UI: the info icon from the icon set (icons.tsx) in a
 * 2rem button, the same in every theme. Hovering or focusing it shows `tip`
 * in a tooltip; pressing it (a click, a tap, Enter or Space) opens `children`
 * in a popover, where a link can be reached. Escape or a click outside closes
 * the popover. `triggerProps` carries a data attribute for tests and the layout
 * check. Nothing else in the app draws an (i): a guard test fails on a letter.
 */
export function InfoTip({
  label,
  tip,
  children,
  placement = 'bottom',
  triggerProps,
}: {
  /** The topic's name, which is the button's accessible name ("About …") and the popover's heading. */
  label: string;
  tip: string;
  children: ReactNode;
  placement?: 'bottom' | 'bottom end' | 'bottom start';
  triggerProps?: Record<`data-${string}`, string>;
}) {
  return (
    <DialogTrigger>
      <TooltipTrigger delay={400} closeDelay={200}>
        <Button className="btn info-trigger" aria-label={`About ${label}`} {...triggerProps}>
          <InfoIcon size={20} />
        </Button>
        <Tooltip className="help-tooltip" offset={6}>
          {tip}
        </Tooltip>
      </TooltipTrigger>
      <Popover className="popover help-popover" placement={placement} offset={6}>
        <Dialog className="help-popover__dialog" aria-label={`About ${label}`}>
          <Heading slot="title" className="help-popover__title">
            About {label}
          </Heading>
          {children}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

/** `note` adds a sentence the topic can't hold because it depends on the screen (a limit, a count), after the topic's own text. */
export function Help({ topic, note }: { topic: HelpTopicId; note?: string }) {
  const t: HelpTopic = HELP[topic];
  // One catalogue: plain words swap the jargon in it as it is drawn (src/plain-words.ts), never a second copy of each topic.
  const plain = usePlain();
  const title = plain.text(t.title);
  const text = plain.text(t.text) + (plain.on && t.plainNote ? ` ${t.plainNote}` : '') + (note ? ` ${plain.text(note)}` : '');
  return (
    <InfoTip label={title} tip={text} triggerProps={{ 'data-help': topic }}>
      <p>{text}</p>
      <p>
        <ExternalLink href={helpHref(t)} data-read-more="">
          Read more<span className="sr-only"> about {title} in the docs</span>
        </ExternalLink>
      </p>
      {t.glossary && <Glossary entries={t.glossary} />}
    </InfoTip>
  );
}

/**
 * A topic's AI terms (#418): each one's first sentence from Context
 * Overflow's glossary and a link to the rest there. Nothing while learning
 * links are off.
 */
export function Glossary({ entries }: { entries: readonly GlossaryEntry[] }) {
  const [on] = useLearningLinks();
  if (!on || !entries.length) return null;
  return (
    <ul className="help-glossary" aria-label="Terms, from Context Overflow's glossary" data-glossary="">
      {entries.map((g) => (
        <li key={g.slug}>
          <span>
            <strong>{g.term}</strong>: {g.text}{' '}
          </span>
          <ExternalLink href={glossaryHref(g)} data-learn-link="">
            Read more on Context Overflow<span className="sr-only"> about {g.term}</span>
          </ExternalLink>
        </li>
      ))}
    </ul>
  );
}

/**
 * The header's Help (#346, #418, #417): a menu with the docs for the view in
 * front of you and What's new, then, while learning links are on, Learn,
 * Context Overflow's four modules by task. After an upgrade it carries a dot,
 * and so does What's new, until the list has been opened.
 */
export function HeaderHelp({ href, fresh = false, onWhatsNew, onShortcuts }: { href: string; fresh?: boolean; onWhatsNew?: () => void; onShortcuts?: () => void }) {
  const [on] = useLearningLinks();
  return (
    <MenuTrigger>
      <Button className="btn help-link" data-help-link="">
        Help{fresh && <NewDot />}
        <ChevronDownIcon size={14} className="icon--after" />
      </Button>
      <Popover className="popover menu-popover" placement="bottom end" offset={6}>
        <Menu className="menu help-menu" aria-label="Help" onAction={(key) => (key === 'whats-new' ? onWhatsNew?.() : key === 'shortcuts' ? onShortcuts?.() : undefined)}>
          <MenuItem className="menu-item" href={href} target="_blank" rel="noopener noreferrer" textValue="Help for this view">
            Help for this view<span className="sr-only"> (opens in a new tab)</span>
          </MenuItem>
          {onWhatsNew && (
            <MenuItem id="whats-new" className="menu-item" textValue="What's new" data-whats-new-open="">
              What's new
              {fresh && <NewDot />}
            </MenuItem>
          )}
          {onShortcuts && (
            <MenuItem id="shortcuts" className="menu-item" textValue="Keyboard shortcuts" data-shortcuts-open="">
              Keyboard shortcuts
            </MenuItem>
          )}
          {on && (
            <MenuSection>
              <Header className="menu-header">Learn, on Context Overflow</Header>
              {LEARN.map((m) => (
                <MenuItem key={m.path} id={m.path} className="menu-item help-menu__module" href={learnHref(m)} target="_blank" rel="noopener noreferrer" textValue={m.title} data-learn-link="">
                  <Text slot="label">{m.title}</Text>
                  <Text slot="description" className="note">
                    {m.task}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </Text>
                </MenuItem>
              ))}
            </MenuSection>
          )}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

/** Learn from the agent's empty state (#418): the same four modules, in a popover. Nothing while learning links are off. */
export function LearnButton() {
  const [on] = useLearningLinks();
  if (!on) return null;
  return (
    <DialogTrigger>
      <Button className="btn btn--small learn-button" data-learn="">
        Learn
      </Button>
      <Popover className="popover help-popover" placement="bottom start" offset={6}>
        <Dialog className="help-popover__dialog" aria-labelledby="learn-title">
          <Heading slot="title" id="learn-title" className="help-popover__title">
            Learn, on Context Overflow
          </Heading>
          <ul className="help-learn">
            {LEARN.map((m) => (
              <li key={m.path}>
                <a href={learnHref(m)} target="_blank" rel="noopener noreferrer" data-learn-link="">
                  {m.title}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <span className="note">{m.task}</span>
              </li>
            ))}
          </ul>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

/** The pencil: `label` is its whole accessible name, such as "Edit the corp-jira connection". */
export function EditLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="btn btn--small edit-link" href={href} aria-label={label} title={label} data-edit-link="">
      <EditIcon size={16} />
    </a>
  );
}

/**
 * Once `ready`, moves focus to the element with this id and scrolls it into
 * view: an edit link's target, found after its page has read what it shows.
 * With no such element (a connection since removed), the view's heading
 * takes focus instead, and the page says what it didn't find.
 */
export function useLandOn(id: string | null, ready: boolean) {
  useEffect(() => {
    if (!id || !ready) return;
    const el = document.getElementById(id) ?? document.querySelector<HTMLElement>('main h1');
    if (!el) return;
    if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.scrollIntoView?.({ block: 'start' });
    el.focus();
  }, [id, ready]);
}
