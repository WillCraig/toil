// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { setPrefs } from '../src/briefing-prefs.ts';
import { forgetSyncs } from '../src/components/briefing.tsx';
import type { Agent } from '../src/agent.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureAnalyses } from '../src/fixtures/analyses.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';

/**
 * The briefing as a person tunes it (#494): Customize, kept in this browser
 * only; the toil project's Analyze settings in Settings, with the prompt shown as
 * it will be sent; and Analyze run after a sync, only when asked for.
 */

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const briefing = () => screen.findByRole('region', { name: 'Briefing' });

describe('Customize', () => {
  it('opens the numbers, hides a reason, and says it is hidden', async () => {
    window.location.hash = '#/project/card-payments';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} analyses={fixtureAnalyses()} now={FIXTURE_NOW} preview />);
    const b = await briefing();
    await waitFor(() => expect(b.dataset.recSource).toBe('analysis'));
    expect((b.querySelector('details.briefing__numbers') as HTMLDetailsElement).open).toBe(false);
    act(() => setPrefs({ numbersOpen: true, hidden: ['waiting'] }));
    expect((b.querySelector('details.briefing__numbers') as HTMLDetailsElement).open).toBe(true);
    expect(b.querySelector('details[data-reason="waiting"]')).toBeNull();
    expect(b.textContent).toContain('One reason is hidden under Customize.');
    expect(JSON.parse(localStorage.getItem('toil-ui.briefing')!)).toMatchObject({ numbersOpen: true, hidden: ['waiting'] });
  });

  it("opens an item on its own page instead of the drawer, when that's what the person chose", async () => {
    window.location.hash = '#/project/card-payments';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} analyses={fixtureAnalyses()} now={FIXTURE_NOW} preview />);
    const b = await briefing();
    await waitFor(() => expect(b.dataset.recSource).toBe('analysis'));
    act(() => setPrefs({ opensIn: 'page' }));
    expect(b.querySelector('a[data-row="corp-jira:PAY-101"]')!.getAttribute('href')).toBe('#/project/card-payments/item/corp-jira%3APAY-101');
    // The panel offers the way to the toil project's own Analyze settings: one more path there.
    const panel = b.querySelector('details.customize')!;
    expect(within(panel as HTMLElement).getByRole('link', { name: 'How briefings are made for card-payments' }).getAttribute('href')).toBe('#/settings/projects/card-payments/analyze');
  });
});

describe("the Toil project's Analyze settings", () => {
  it('shows the prompt Analyze will send as you type, and shows no command', async () => {
    window.location.hash = '#/settings/projects/card-payments/analyze';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    const form = (await screen.findByRole('heading', { name: 'How briefings are made for card-payments' })).closest('form')!;
    const goal = within(form).getByRole('textbox', { name: 'Goal of this work' });
    await userEvent.type(goal, 'Ship card payments v2.');
    const preview = form.querySelector('.analyze-preview__text')!;
    await waitFor(() => expect(preview.textContent).toContain('The goal of this work: Ship card payments v2.'));
    expect(preview.textContent).toContain('Answer with one fenced block, ```briefing');
    expect(form.textContent).not.toContain('toil projects analyze set');
  });
});

describe('Analyze after a sync', () => {
  beforeEach(() => forgetSyncs());
  const counting = () => {
    const base = scriptedAgent();
    const asked: string[] = [];
    const agent: Agent = { ...base, stream: (d, p, ...rest) => (asked.push(p), base.stream!(d, p, ...rest)) };
    return { agent, asked };
  };
  // As the local app does: each finished sync remounts the page under a new key (ui/src/local.tsx).
  const page = (agent: Agent, key: number, syncedAt: string) => <App key={key} execute={fixtureExecute().execute} agent={agent} analyses={fixtureAnalyses()} now={FIXTURE_NOW} preview syncedAt={syncedAt} />;

  it('runs once per finished sync when turned on, across the remount, and never on the sync already there', async () => {
    setPrefs({ afterSync: true });
    const { agent, asked } = counting();
    window.location.hash = '#/project/card-payments';
    const view = render(page(agent, 0, '2026-10-13T01:00:00.000Z'));
    await briefing();
    expect(asked).toEqual([]);
    view.rerender(page(agent, 1, '2026-10-13T02:00:00.000Z'));
    await waitFor(() => expect(asked).toEqual(['analyze']));
  });

  it('stays off unless asked for', async () => {
    const { agent, asked } = counting();
    window.location.hash = '#/project/card-payments';
    const view = render(page(agent, 0, '2026-10-13T01:00:00.000Z'));
    await briefing();
    view.rerender(page(agent, 1, '2026-10-13T02:00:00.000Z'));
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual([]);
  });
});
