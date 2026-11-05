import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { resetAgentsPanel } from '../src/assign/panel-choice.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureAssignments } from '../src/fixtures/assignments.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { resetPlain, setPlain } from '../src/plain-words.ts';

/**
 * Toil UI for someone new to AI (#552): plain words by default with the switch
 * in Settings and not the header, themed wording off until chosen, and the
 * Agents panel one button until it is opened, and remembered once it is. The
 * pure rules are in plain-words.test.ts and theme-setting.test.tsx; this is
 * the App they decide.
 */

const WIDE = '(min-width: 1200px)';

/** jsdom has no layout; this matchMedia answers the sidebar's width query as asked and every other as false. */
function screenWidth(wide: boolean) {
  window.matchMedia = ((query: string) => ({ matches: query === WIDE ? wide : false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
}
const { matchMedia } = window;

async function open(hash: string) {
  window.location.hash = hash;
  const view = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview assignments={fixtureAssignments({ delay: 1 })} />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  resetPlain();
  resetAgentsPanel();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  window.matchMedia = matchMedia;
  window.history.replaceState(null, '', '/');
});

describe('plain words as the default', () => {
  it('reads in everyday words with nothing chosen, with no switch in the header', async () => {
    await open('#/');
    expect(screen.getByRole('heading', { level: 1, name: 'Toil projects' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Views' })).getAllByRole('link')[0]!.textContent).toBe('Toil projects');
    expect(document.querySelector('header [data-plain-switch]')).toBeNull();
    expect(document.documentElement.dataset.words).toBe('plain');
  });

  it("keeps toil's own terms for someone who opted out, in the address or in this browser", async () => {
    window.history.replaceState(null, '', '/?words=standard');
    await open('#/');
    expect(screen.getByRole('heading', { level: 1, name: 'Toil projects' })).toBeTruthy();
    cleanup();
    resetPlain();
    window.history.replaceState(null, '', '/');
    localStorage.setItem('toil-ui.words', 'standard');
    await open('#/');
    expect(screen.getByRole('heading', { level: 1, name: 'Toil projects' })).toBeTruthy();
  });

  it('turns off and on from Settings, General, with its one-line explanation', async () => {
    await open('#/settings/toil');
    const card = screen.getByRole('region', { name: 'Plain words' });
    const toggle = within(card).getByRole('button', { name: 'Plain words' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(card.querySelectorAll('p.note')).toHaveLength(1);
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem('toil-ui.words')).toBe('standard');
    expect(within(screen.getByRole('navigation', { name: 'Views' })).getAllByRole('link')[0]!.textContent).toBe('Toil projects');
  });

  it('is in the command palette too, named for what pressing it would do', async () => {
    await open('#/');
    await userEvent.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await userEvent.type(within(palette).getByRole('searchbox'), 'plain words');
    await userEvent.click(await within(palette).findByRole('menuitem', { name: /Use toil's own terms/ }));
    await waitFor(() => expect(localStorage.getItem('toil-ui.words')).toBe('standard'));
  });

  it('keeps an item key and the sprint the same in both modes', async () => {
    setPlain(true);
    await open('#/project/card-payments');
    const plain = document.body.textContent ?? '';
    cleanup();
    setPlain(false);
    await open('#/project/card-payments');
    const standard = document.body.textContent ?? '';
    for (const fact of [/PAY-10\d/, /Sprint 42/]) expect(plain.match(fact)?.[0]).toBe(standard.match(fact)?.[0]);
  });
});

describe('the Agents panel', () => {
  it('is one button, labelled in plain words and counting what waits on a person, with nothing beside the view at 1440px', async () => {
    screenWidth(true);
    await open('#/project/card-payments');
    const button = await screen.findByRole('button', { name: /^AI helpers, \d+ waiting on you$/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.agents-side')).toBeNull();
    expect(screen.queryByRole('region', { name: 'AI helpers' })).toBeNull();
  });

  it('counts the inbox, proposals and questions waiting, at least as many as the cards that need you', async () => {
    screenWidth(true);
    await open('#/project/card-payments');
    const button = await screen.findByRole('button', { name: /^AI helpers, \d+ waiting on you$/ });
    const n = Number(/(\d+) waiting/.exec(button.getAttribute('aria-label') ?? button.textContent ?? '')?.[1] ?? /(\d+)/.exec(button.textContent ?? '')?.[1]);
    await userEvent.click(button);
    const panel = await screen.findByRole('region', { name: 'AI helpers' });
    const inbox = within(panel).getAllByRole('button', { name: /^Start/ }).length;
    const needYou = panel.querySelectorAll('.agents-group--needs-you .agent-card').length;
    expect(n).toBeGreaterThanOrEqual(inbox + needYou);
  });

  it('opens beside the view when pressed, is remembered as open, and closes again', async () => {
    screenWidth(true);
    await open('#/project/card-payments');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^AI helpers/ }));
    expect(await screen.findByRole('region', { name: 'AI helpers' })).toBeTruthy();
    expect(document.querySelector('.toil-project-shell')?.hasAttribute('data-side')).toBe(true);
    expect(localStorage.getItem('toil-ui.agents-panel')).toBe('open');
    cleanup();
    resetAgentsPanel();
    await open('#/project/card-payments/board');
    expect(await screen.findByRole('region', { name: 'AI helpers' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^AI helpers/ }));
    expect(screen.queryByRole('region', { name: 'AI helpers' })).toBeNull();
    expect(localStorage.getItem('toil-ui.agents-panel')).toBe('closed');
  });

  it('is a drawer below 1200px, opened by the same button and not remembered', async () => {
    screenWidth(false);
    await open('#/project/card-payments');
    await userEvent.click(await screen.findByRole('button', { name: /^AI helpers/ }));
    expect(await screen.findByRole('region', { name: 'AI helpers' })).toBeTruthy();
    expect(localStorage.getItem('toil-ui.agents-panel')).toBeNull();
    expect(document.querySelector('.agents-side')).toBeNull();
  });

  it('opens from the command palette', async () => {
    screenWidth(true);
    await open('#/project/card-payments');
    await userEvent.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    await userEvent.type(within(palette).getByRole('searchbox'), 'ai helpers');
    await userEvent.click(await within(palette).findByRole('menuitem', { name: /Open the AI helpers panel/ }));
    expect(await screen.findByRole('region', { name: 'AI helpers' })).toBeTruthy();
  });

  it("keeps toil's label with plain words off", async () => {
    screenWidth(true);
    setPlain(false);
    await open('#/project/card-payments');
    expect(await screen.findByRole('button', { name: /^Agents/ })).toBeTruthy();
  });
});
