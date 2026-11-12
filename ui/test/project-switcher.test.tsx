// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { ProjectSwitcher } from '../src/components/project-switcher.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import type { SyncJob } from '../src/server-client.ts';

/**
 * The project picker in the app header, and the sync card: what the maintainer
 * asked for after using the running app. The picker sits between the brand and the
 * views, names where you are, and keeps the tab; a running sync is a corner card
 * out of the page's flow, so the page never moves.
 */

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const open = (hash: string, props: Partial<React.ComponentProps<typeof App>> = {}) => {
  window.location.hash = hash;
  return render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview {...props} />);
};

describe('the project switcher', () => {
  it('is not drawn with no Toil projects, and is with one: it is the way to the overview', async () => {
    const { unmount } = render(<ProjectSwitcher current={null} toilProjects={[]} tab={null} />);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();
    render(<ProjectSwitcher current="card-payments" toilProjects={['card-payments']} tab={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Switch Toil project, on card-payments' }));
    const items = within(await screen.findByRole('menu')).getAllByRole('menuitem');
    expect(items.map((i) => i.getAttribute('href'))).toEqual(['#/', '#/project/card-payments']);
    expect(items[0]!.textContent).toContain('All Toil projects');
  });

  it('still offers the overview while the list is not read, which is not the same as having none', async () => {
    render(<ProjectSwitcher current={null} toilProjects={[]} tab={null} loaded={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Switch Toil project, on All Toil projects' }));
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((i) => i.getAttribute('href'))).toEqual(['#/']);
  });

  it('reads the current project, checks it in the menu, and keeps the tab', async () => {
    render(<ProjectSwitcher current="card-payments" toilProjects={['card-payments', 'settlement']} tab="prs" />);
    const button = screen.getByRole('button', { name: 'Switch Toil project, on card-payments' });
    expect(button.textContent).toContain('card-payments');
    await userEvent.click(button);
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.getAttribute('href'))).toEqual(['#/', '#/project/card-payments/prs', '#/project/settlement/prs']);
    expect(items.map((i) => i.hasAttribute('data-current'))).toEqual([false, true, false]);
    expect(within(items[1]!).getByText('(current)')).toBeTruthy();
  });

  it('reads "All Toil projects" on a page that belongs to none', () => {
    render(<ProjectSwitcher current={null} toilProjects={['a', 'b']} tab={null} />);
    expect(screen.getByRole('button', { name: 'Switch Toil project, on All Toil projects' }).textContent).toContain('All Toil projects');
  });

  it('sits between the brand and the views in the app header, on a project page and on the home page', async () => {
    for (const [hash, label] of [['#/project/card-payments', 'card-payments'], ['#/', 'All Toil projects']] as const) {
      const { unmount } = open(hash);
      const button = await screen.findByRole('button', { name: new RegExp(`^Switch Toil project, on ${label}`) }, { timeout: 5000 });
      const brand = document.querySelector('.brand')!;
      const views = document.querySelector('header nav[aria-label="Views"]')!;
      expect(brand.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(button.compareDocumentPosition(views) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      unmount();
    }
  }, 20_000);
});

describe('a running sync', () => {
  const job: SyncJob = { running: true, by: null, startedAt: null, finishedAt: null, toilProject: 'card-payments', toilProjectsDone: 1, toilProjectsTotal: 3, fetched: 0, reused: 0, requests: 12, pages: 4, retries: 0, messages: [], error: null };

  it('is a fixed card outside the page, and the page is still there', async () => {
    open('#/project/card-payments', { syncing: job });
    const card = await screen.findByText(/Syncing card-payments: 1 of 3/, {}, { timeout: 5000 });
    const wrapper = card.closest('[data-sync-card]')!;
    expect(wrapper.classList.contains('sync-card')).toBe(true);
    expect(wrapper.getAttribute('aria-live')).toBe('off');
    expect(document.querySelector('main')!.contains(wrapper)).toBe(false);
    expect(document.querySelector('main [data-loading]')).toBeNull();
    await screen.findByRole('region', { name: 'Briefing' });
  }, 20_000);

  it('draws no card when none is running', async () => {
    open('#/project/card-payments', { syncing: { ...job, running: false } });
    await screen.findByRole('region', { name: 'Briefing' });
    expect(document.querySelector('[data-sync-card]')).toBeNull();
  });
});
