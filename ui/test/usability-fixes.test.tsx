import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { AnswerHero } from '../src/components/summary.tsx';
import { ChatScope } from '../src/components/ask.tsx';
import { memoryAnalyses } from '../src/analyses.ts';
import { DataContext, type Data } from '../src/data.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import type { ToilProjectData } from '../src/load.ts';
import { SkinProvider, skinsFor } from '../src/skins.tsx';
import { Dashboard } from '../src/views/Dashboard.tsx';
import { ToilProjectShell } from '../src/views/ToilProjectShell.tsx';
import { Graph } from '../src/views/Graph.tsx';
import { loaded } from './harness.ts';

/**
 * What a usability review of the running app asked for: a long Done column
 * that folds, a header that says where Search is, one Edit instead of three
 * pencils, and a quiet dependencies tab
 * when nothing open is blocked.
 */

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function shell(toilProject: ToilProjectData, children: React.ReactNode) {
  const data: Data = { toilProject, byId: new Map(toilProject.items.map((i) => [i.id, i])), prById: new Map(), agent: scriptedAgent(), now: FIXTURE_NOW, analyses: memoryAnalyses() };
  return render(
    <SkinProvider value={skinsFor('plain')}>
      <DataContext value={data}>
        <ChatScope>{children}</ChatScope>
      </DataContext>
    </SkinProvider>,
  );
}

describe('the headline with no sprint', () => {
  it('is the sentence alone, not "No sprint: No sprint is running"', () => {
    render(<AnswerHero answer={{ status: 'none', word: 'No sprint', sentence: 'No sprint is running right now.', why: 'why', how: [], basis: null, bare: true }} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('No sprint is running right now.');
  });
});

describe('the board', () => {
  it('shows ten finished cards and the rest behind "Show N more"', async () => {
    const { data } = await loaded('card-payments');
    const done = data.items.find((i) => i.statusCategory === 'DONE')!;
    const items = Array.from({ length: 13 }, (_, n) => ({ ...done, id: `${done.id}-copy-${n}`, title: `Done story ${n}` }));
    shell({ ...data, items }, <Dashboard tab="board" />);
    const col = screen.getByRole('region', { name: /^Done/ });
    const cards = () => [...col.querySelectorAll('li.card')];
    expect(cards()).toHaveLength(10);
    // The heading still counts the whole column, so the number is not a lie about what is there.
    expect(within(col).getByRole('heading').textContent).toContain('13');
    await userEvent.click(within(col).getByRole('button', { name: /Show 3 more/ }));
    expect(cards()).toHaveLength(13);
    expect(within(col).queryByRole('button', { name: /Show/ })).toBeNull();
  });

  it('does not repeat the column on a card, and has one info icon', async () => {
    const { data } = await loaded('settlement');
    shell(data, <Dashboard tab="board" />);
    expect(document.querySelector('.card .chip-cat')).toBeNull();
    expect(document.querySelectorAll('.board-tools__help [data-help]')).toHaveLength(1);
  });
});

describe('the project header', () => {
  const header = async () => {
    const { data } = await loaded('card-payments');
    return shell(data, <ToilProjectShell tab="overview" heading><p>body</p></ToilProjectShell>);
  };

  it('has no project picker of its own: it lives in the app header', async () => {
    await header();
    expect(screen.queryByRole('button', { name: /Switch Toil project/ })).toBeNull();
  });

  it('has one quiet Edit link at the end of the about row, and no pencils', async () => {
    await header();
    const edit = screen.getByRole('link', { name: /^Edit card-payments/ });
    expect(edit.getAttribute('href')).toBe('#/settings/projects/card-payments/sources');
    expect(edit.hasAttribute('data-edit-project')).toBe(true);
    expect(edit.classList.contains('btn')).toBe(false);
    const about = document.querySelector('.toil-project-bar__about')!;
    expect(about.lastElementChild).toBe(edit);
    expect(document.querySelector('.toil-project-bar__line')!.contains(edit)).toBe(false);
    expect(document.querySelectorAll('[data-edit], .edit-pencil')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Rename|description/ })).toBeNull();
  });
});

describe('the app header', () => {
  it('has a Search button with its shortcut that opens the palette, and no Theme picker on a project page', async () => {
    window.location.hash = '#/project/card-payments';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('region', { name: 'Briefing' });
    const search = document.querySelector<HTMLElement>('.search-open')!;
    expect(search.textContent).toMatch(/^Search\s*(Ctrl\+K|⌘K)$/);
    expect(screen.queryByRole('button', { name: /^Theme/ })).toBeNull();
    await userEvent.click(search);
    await waitFor(() => expect(document.querySelector('[data-palette]')).toBeTruthy());
  });

  it('lists Keyboard shortcuts in the Help menu', async () => {
    window.location.hash = '#/';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1 });
    await userEvent.click(document.querySelector<HTMLElement>('[data-help-link]')!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Keyboard shortcuts' }));
    expect(await screen.findByRole('dialog', { name: /shortcuts/i })).toBeTruthy();
  });
});

describe('what blocks what', () => {
  it('says nothing open is blocked and keeps closed links behind a toggle', async () => {
    const { data } = await loaded('card-payments');
    // Every item finished: whatever the links say, nothing open is held up.
    const items = data.items.map((i) => ({ ...i, statusCategory: 'DONE' as const }));
    shell({ ...data, items }, <Graph />);
    expect(screen.getByText(/Nothing that is still open is blocked/)).toBeTruthy();
    expect(document.querySelector('.graph')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show finished links' }));
    expect(document.querySelector('.graph')).toBeTruthy();
  });
});
